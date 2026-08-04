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

// POST JSON 到任意 URL。返回 HTTP 状态码（网络/超时返回 0）。不抛。
function postJsonUrl(url, token, body, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(url);
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
          authorization: `Bearer ${token}`,
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
      log(`postJsonUrl: timeout ${u.host}${u.pathname}`);
      resolve(0);
    });
    req.on("error", (e) => {
      log(`postJsonUrl: ${u.host}${u.pathname} ${e && e.code ? e.code : ""} ${e && e.message ? e.message : e}`);
      resolve(0);
    });
    req.write(data);
    req.end();
  });
}

// POST 记录到 /ingest。返回 HTTP 状态码（网络/超时返回 0）。不抛。
function postJson(cfg, body, timeoutMs = 8000) {
  // 不能用 new URL("/ingest", base):绝对路径会吃掉 base 自带的路径段
  // (如 API Gateway 阶段名 /default),改为字符串拼接保留完整路径。
  const url = `${String(cfg.server_url).replace(/\/+$/, "")}/ingest`;
  return postJsonUrl(url, cfg.token, body, timeoutMs);
}

// GET JSON。返回解析后的对象,网络/超时/非 2xx/解析失败返回 null。不抛。
function getJson(cfg, path, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let u;
    try {
      // 与 postJson 同理:字符串拼接保留 base 路径段
      u = new URL(`${String(cfg.server_url).replace(/\/+$/, "")}${path}`);
    } catch {
      return resolve(null);
    }
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(
      u,
      {
        method: "GET",
        headers: { authorization: `Bearer ${cfg.token}` },
        timeout: timeoutMs,
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) return resolve(null);
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      log(`getJson: timeout ${u.host}${path}`);
      resolve(null);
    });
    req.on("error", (e) => {
      log(`getJson: ${u.host}${path} ${e && e.code ? e.code : ""}`);
      resolve(null);
    });
    req.end();
  });
}

// ---- 采集级别(thin|full) ----
// 进程内 + state.json 双层缓存,30 分钟内不重复请求;失败沿用上次值,从未拉过 → "thin"。
const COLLECT_LEVEL_TTL_MS = 30 * 60 * 1000;
let collectLevelCache = { value: null, at: 0 };

async function fetchCollectLevel(cfgOverride) {
  const cfg = cfgOverride || loadConfig();
  // 1. 模块内缓存
  if (collectLevelCache.value && Date.now() - collectLevelCache.at < COLLECT_LEVEL_TTL_MS) {
    return collectLevelCache.value;
  }
  // 2. state.json 持久化缓存
  const state = readState();
  const persisted = state.__collect_level__;
  if (
    persisted &&
    persisted.value &&
    Number.isFinite(Number(persisted.at)) &&
    Date.now() - Number(persisted.at) < COLLECT_LEVEL_TTL_MS
  ) {
    collectLevelCache = { value: persisted.value, at: Number(persisted.at) };
    return persisted.value;
  }
  // 3. 网络拉取
  const name = cfg.name || "";
  if (!name) return "thin";
  const r = await getJson(cfg, `/config?name=${encodeURIComponent(name)}`);
  const level = r && (r.collect_level === "full" || r.collect_level === "thin") ? r.collect_level : null;
  if (level) {
    collectLevelCache = { value: level, at: Date.now() };
    state.__collect_level__ = { value: level, at: Date.now() };
    writeState(state);
    return level;
  }
  // 4. 网络失败兜底: 有持久化旧值就用(即使过期),从未有过 → "thin"
  if (persisted && persisted.value) return persisted.value;
  return "thin";
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

/** 自更新命令串(纯函数,便于单测)。
 *  marketplace 是 SSH 克隆的私有仓库:无人值守时 ssh 可能卡在密码/host key 提示上
 *  (员工机器症状:更新窗口一直挂着、版本永远拉不下来、plugin update 对比旧缓存误报"已是最新")。
 *  BatchMode 禁交互提示、ConnectTimeout 快速失败,失败原因随重定向落进 agent.log 可查。 */
function buildSelfUpdateCmd(marketplace, pluginId, platform = process.platform) {
  const sshGuard = "ssh -o BatchMode=yes -o ConnectTimeout=10";
  return platform === "win32"
    ? `set "GIT_SSH_COMMAND=${sshGuard}" && claude plugin marketplace update ${marketplace} && claude plugin update ${pluginId}`
    : `export GIT_SSH_COMMAND="${sshGuard}"; claude plugin marketplace update ${marketplace} && claude plugin update ${pluginId}`;
}

/** wscript 隐藏运行的 VBS 内容(纯函数,便于单测)。
 *  VBS 字符串内 `"` 写成 `""`,整行引号必须配平(同 installers.vbsBody 的教训);
 *  cmd /c 后故意不加外层引号,避开 cmd /c 的剥引号规则;(...) 成组让整条 && 链都进日志。 */
function hiddenRunVbs(command, logPath = LOG_PATH) {
  return (
    "On Error Resume Next\r\n" +
    `CreateObject("WScript.Shell").Run "cmd /c (${command.replace(/"/g, '""')}) >>""${logPath}"" 2>&1", 0, False\r\n`
  );
}

/** 隐藏启动 Node 脚本的 VBS 内容。参数只接受不含双引号的独立字符串。 */
function hiddenNodeVbs(nodePath, scriptPath, args = []) {
  const values = [nodePath, scriptPath, ...args].map((value) => String(value));
  if (values.some((value) => value.includes('"'))) throw new Error("Node 隐藏启动参数不能包含双引号");
  const command = [
    `"${values[0]}"`,
    `"${values[1]}"`,
    ...values.slice(2).map((value) => (/[\s&|<>^]/.test(value) ? `"${value}"` : value)),
  ].join(" ");
  return (
    "On Error Resume Next\r\n" +
    `CreateObject("WScript.Shell").Run "${command.replace(/"/g, '""')}", 0, False\r\n`
  );
}

/** 后台无窗启动稳定 Node 脚本，不继承终端，也不等待执行完成。 */
function spawnNodeHidden(scriptPath, args = []) {
  try {
    if (process.platform === "win32") {
      const vbsPath = path.join(BASE_DIR, "vantage-self-update.vbs");
      writeFileAtomic(
        vbsPath,
        Buffer.from(BOM + hiddenNodeVbs(process.execPath, scriptPath, args), "utf16le")
      );
      const child = spawn("wscript.exe", [vbsPath], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
      return true;
    }
    const child = spawn(process.execPath, [scriptPath, ...args], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** 彻底无窗地跑一段 shell 命令串，stdout/stderr 追加到 agent.log。
 *  Windows 改走 wscript:Node detached 子进程会新建控制台窗口,windowsHide 的
 *  SW_HIDE 在 "Windows Terminal 设为默认终端" 的机器上可能不被尊重,员工仍看到黑窗。
 *  wscript 是 GUI 子系统进程,自身从不创建控制台(与 Codex 触发器同一条已在员工
 *  机器上验证无窗的路径),窗口样式 0 双保险。非 Windows 维持 shell 后台执行。 */
function spawnShellHidden(command) {
  if (process.platform !== "win32") {
    spawnShellDetached(`(${command}) >>${JSON.stringify(LOG_PATH)} 2>&1`);
    return;
  }
  try {
    const vbsPath = path.join(BASE_DIR, "vantage-self-update.vbs");
    writeFileAtomic(vbsPath, Buffer.from(BOM + hiddenRunVbs(command), "utf16le"));
    const child = spawn("wscript.exe", [vbsPath], {
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
  postJsonUrl,
  getJson,
  fetchCollectLevel,
  readStdin,
  spawnDetached,
  spawnShellDetached,
  spawnShellHidden,
  buildSelfUpdateCmd,
  hiddenRunVbs,
  hiddenNodeVbs,
  spawnNodeHidden,
};
