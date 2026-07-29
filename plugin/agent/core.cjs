"use strict";
// Vantage Agent —— 共享核心：路径、配置、原子写、state 状态机、脱敏、HTTP、进程助手。
// 零依赖，CommonJS。运行在员工机器上，被 capture / reconcile / flush 复用。
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const { spawn } = require("node:child_process");

const BASE_DIR = path.join(os.homedir(), ".vantage");
const CONFIG_PATH = path.join(BASE_DIR, "config.json");
const SPOOL_DIR = path.join(BASE_DIR, "spool");
const DEAD_DIR = path.join(BASE_DIR, "dead"); // 死信：永久失败/超龄，不再重试
const STATE_PATH = path.join(BASE_DIR, "state.json");
const LOG_PATH = path.join(BASE_DIR, "agent.log");
const LOG_MAX_BYTES = 1024 * 1024; // 1MB 触发滚动
// 字节序标记。不用 "﻿" 字面量:源码里的隐形字符易被编辑器/格式化工具剥掉。
const BOM = String.fromCharCode(0xfeff);

function ensureDirs() {
  fs.mkdirSync(SPOOL_DIR, { recursive: true });
  fs.mkdirSync(DEAD_DIR, { recursive: true });
}

/** 原子写：先写临时文件再 rename（同盘 rename 原子），避免读者读到半截内容。 */
function writeFileAtomic(filePath, data, mode) {
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, data, mode !== undefined ? { mode } : undefined);
  fs.renameSync(tmp, filePath);
}

// 读身份/服务端配置（安装时写入）。缺失时给出安全默认，绝不抛错。
function loadConfig() {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    cfg = {};
  }
  return {
    name: cfg.name || "",
    email: cfg.email || "",
    department: cfg.department || "",
    machine: cfg.machine || os.hostname(),
    server_url: cfg.server_url || "http://localhost:3000",
    token: cfg.token || "dev-token-change-me",
    installed_at: cfg.installed_at || "", // 安装时刻，用于只采装后会话
  };
}

// 低调日志：只写本地文件，绝不打印到 stdout（避免干扰 Claude Code）。超限滚动一次。
// Windows 下新日志文件带 UTF-8 BOM，让 PowerShell / 记事本默认不乱码。
function log(msg) {
  try {
    if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > LOG_MAX_BYTES) {
      try {
        fs.renameSync(LOG_PATH, LOG_PATH + ".1");
      } catch {}
    }
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    const isWin = process.platform === "win32";
    const needsBom = isWin && !fs.existsSync(LOG_PATH);
    if (needsBom) {
      fs.writeFileSync(LOG_PATH, BOM + line, "utf8");
    } else {
      fs.appendFileSync(LOG_PATH, line, "utf8");
    }
  } catch {
    /* ignore */
  }
}

// ---- state.json 状态机：记录每个会话文件"上次处理时的 size+mtime" ----
function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeState(state) {
  try {
    ensureDirs();
    writeFileAtomic(STATE_PATH, JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

function markProcessed(transcriptPath, size, mtimeMs) {
  const state = readState();
  state[transcriptPath] = { size, mtime: mtimeMs, at: new Date().toISOString() };
  writeState(state);
}

function hasChanged(transcriptPath, size, mtimeMs) {
  const prev = readState()[transcriptPath];
  if (!prev) return true;
  return prev.size !== size || prev.mtime !== mtimeMs;
}

/** 删除 state 中早于 cutoff（毫秒时间戳）的条目，防止无限增长。 */
function pruneState(cutoffMs) {
  const state = readState();
  let changed = false;
  for (const [key, v] of Object.entries(state)) {
    if (v && typeof v.mtime === "number" && v.mtime < cutoffMs) {
      delete state[key];
      changed = true;
    }
  }
  if (changed) writeState(state);
}

// 脱敏：邮箱、常见密钥前缀、JWT、URL 里的凭据、长 token 串。用于摘要与首句提问（纵深防御，非保证）。
function redact(text) {
  if (!text || typeof text !== "string") return text;
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    .replace(/\b(sk|pk|ghp|gho|github_pat|xox[baprs]|AKIA)[-_][A-Za-z0-9]{6,}\b/gi, "[secret]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[jwt]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1[cred]@")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[token]");
}

function truncate(text, n = 300) {
  if (!text || typeof text !== "string") return text;
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

// 写入 spool：一个会话一个文件，重复触发自然覆盖（原子写，避免上传器读到半截）。
function writeSpool(record) {
  ensureDirs();
  const key = (record.dedupe_key || `${record.tool}:${record.session_id}`).replace(
    /[^A-Za-z0-9_.-]/g,
    "_"
  );
  const file = path.join(SPOOL_DIR, key + ".json");
  writeFileAtomic(file, JSON.stringify(record));
  return file;
}

// POST 记录。返回 HTTP 状态码（网络/超时返回 0）。不抛。
function postJson(cfg, body, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let u;
    try {
      // 不能用 new URL("/ingest", base):绝对路径会吃掉 base 自带的路径段
      // (如 API Gateway 阶段名 /default),改为字符串拼接保留完整路径。
      u = new URL(`${String(cfg.server_url).replace(/\/+$/, "")}/ingest`);
    } catch {
      return resolve(0);
    }
    const data = Buffer.from(JSON.stringify(body), "utf8");
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(
      u,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": data.length,
          authorization: `Bearer ${cfg.token}`,
        },
        timeout: timeoutMs,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode || 0);
      }
    );
    req.on("timeout", () => {
      req.destroy();
      log(`postJson: timeout ${u.host}`);
      resolve(0);
    });
    req.on("error", (e) => {
      log(`postJson: ${u.host} ${e && e.code ? e.code : ""} ${e && e.message ? e.message : e}`);
      resolve(0);
    });
    req.write(data);
    req.end();
  });
}

/** 读取 stdin（钩子通过管道传 JSON）。非管道（手动运行）立即返回空串。带超时兜底。 */
function readStdin(timeoutMs = 1500) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let data = "";
    const timer = setTimeout(() => resolve(data), timeoutMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => {
      clearTimeout(timer);
      resolve(data);
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

/** 分离式启动另一个 Node 脚本（绝对路径或相对 __dirname）。不等待、不阻塞。
 *  windowsHide: 父进程无控制台时(如 Windows 桌面端钩子)子进程也不会闪黑窗。 */
function spawnDetached(scriptNameOrPath) {
  try {
    const scriptPath = path.isAbsolute(scriptNameOrPath)
      ? scriptNameOrPath
      : path.join(__dirname, scriptNameOrPath);
    const child = spawn(process.execPath, [scriptPath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  } catch {
    /* ignore */
  }
}

/** 分离式跑一段 shell 命令串：不等待、不阻塞钩子，输出由命令串自行重定向。 */
function spawnShellDetached(command) {
  try {
    const isWin = process.platform === "win32";
    const shell = isWin ? "cmd.exe" : "sh";
    const arg = isWin ? "/c" : "-c";
    const child = spawn(shell, [arg, command], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  } catch {
    /* ignore */
  }
}

module.exports = {
  BASE_DIR,
  CONFIG_PATH,
  SPOOL_DIR,
  DEAD_DIR,
  STATE_PATH,
  LOG_PATH,
  ensureDirs,
  writeFileAtomic,
  loadConfig,
  log,
  readState,
  writeState,
  markProcessed,
  hasChanged,
  pruneState,
  redact,
  truncate,
  writeSpool,
  postJson,
  readStdin,
  spawnDetached,
  spawnShellDetached,
};
