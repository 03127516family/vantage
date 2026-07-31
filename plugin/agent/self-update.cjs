#!/usr/bin/env node
"use strict";

// Vantage 无感自更新器。
// 本文件同时提供纯函数给 reconcile / Windows 验证脚本复用。
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const REQUIRED_AGENT_FILES = ["core.cjs", "reconcile.cjs", "installers.cjs"];

function listFiles(root) {
  if (!fs.statSync(root).isDirectory()) throw new Error(`不是目录: ${root}`);
  const files = [];
  const stack = [""];
  while (stack.length) {
    const relativeDir = stack.pop();
    const absoluteDir = path.join(root, relativeDir);
    const entries = fs.readdirSync(absoluteDir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    for (const entry of entries) {
      const relative = path.join(relativeDir, entry.name);
      if (entry.isDirectory()) stack.push(relative);
      else if (entry.isFile()) files.push(relative);
      else throw new Error(`Agent 目录包含不支持的文件类型: ${relative}`);
    }
  }
  return files.sort();
}

/** 根据全部相对路径和文件内容计算确定性目录摘要。 */
function treeDigest(root) {
  const hash = crypto.createHash("sha256");
  for (const relative of listFiles(root)) {
    hash.update("file\0");
    hash.update(relative.split(path.sep).join("/"));
    hash.update("\0");
    hash.update(fs.readFileSync(path.join(root, relative)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** 读取 Claude 当前真正激活的用户级插件记录，并验证缓存完整性。 */
function resolveInstalledPlugin(home = os.homedir(), pluginId = "vantage@dgcrane") {
  const installedPath = path.join(home, ".claude", "plugins", "installed_plugins.json");
  let installed;
  try {
    installed = JSON.parse(fs.readFileSync(installedPath, "utf8"));
  } catch (e) {
    throw new Error(`无法读取安装记录: ${e.message}`);
  }
  const records = Array.isArray(installed?.plugins?.[pluginId])
    ? installed.plugins[pluginId].filter((record) => record && record.scope === "user")
    : [];
  records.sort(
    (a, b) =>
      Date.parse(b.lastUpdated || 0) - Date.parse(a.lastUpdated || 0)
  );
  const active = records[0];
  if (!active) throw new Error(`找不到用户级插件安装记录: ${pluginId}`);
  if (!path.isAbsolute(active.installPath || "") || !fs.existsSync(active.installPath)) {
    throw new Error(`安装路径无效: ${active.installPath || "(空)"}`);
  }

  const manifestPath = path.join(active.installPath, ".claude-plugin", "plugin.json");
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (e) {
    throw new Error(`无法读取插件清单: ${e.message}`);
  }
  if (manifest.name !== "vantage") {
    throw new Error(`插件名称不匹配: ${manifest.name || "(空)"}`);
  }
  if (String(manifest.version) !== String(active.version)) {
    throw new Error(`插件版本不匹配: 安装记录=${active.version}, 清单=${manifest.version}`);
  }
  const agentDir = path.join(active.installPath, "agent");
  for (const file of REQUIRED_AGENT_FILES) {
    if (!fs.existsSync(path.join(agentDir, file))) {
      throw new Error(`插件缓存不完整，缺少 agent/${file}`);
    }
  }
  return { ...active, manifest, agentDir };
}

/**
 * 选择实际派生的自更新器路径。
 * 优先稳定副本(插件被卸载后仍能自更新)；但稳定副本缺少 self-update.cjs
 * (落后到无感自更新功能之前的故障机)时，回退到缓存里的更新器——
 * 否则每小时任务派生稳定副本更新器必然失败，自愈陷入死循环。
 * 全程纯 fs 读取，不产生任何子进程/窗口。无可用更新器时返回 null。
 */
function resolveUpdaterWorker(options = {}) {
  const home = options.home || os.homedir();
  const stableDir = options.stableDir || path.join(home, ".vantage", "agent");
  const stableWorker = path.join(stableDir, "self-update.cjs");
  if (fs.existsSync(stableWorker)) return stableWorker;
  try {
    const active = resolveInstalledPlugin(home, options.pluginId);
    const cacheWorker = path.join(active.agentDir, "self-update.cjs");
    if (fs.existsSync(cacheWorker)) return cacheWorker;
  } catch {
    // 无安装记录或缓存不可读，无法回退；调用方静默跳过。
  }
  return null;
}

function cleanupActivationDebris(stableDir) {
  const parent = path.dirname(stableDir);
  const base = path.basename(stableDir);
  let entries = [];
  try {
    entries = fs.readdirSync(parent);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name.startsWith(`${base}.stage.`) || name.startsWith(`${base}.backup.`)) {
      try {
        fs.rmSync(path.join(parent, name), { recursive: true, force: true });
      } catch {
        // 杀软短暂占用时留给下一次成功激活继续清理。
      }
    }
  }
}

function findRecoveryBackup(stableDir) {
  const parent = path.dirname(stableDir);
  const prefix = `${path.basename(stableDir)}.backup.`;
  let candidates = [];
  try {
    candidates = fs
      .readdirSync(parent)
      .filter((name) => name.startsWith(prefix))
      .map((name) => {
        const full = path.join(parent, name);
        return { full, mtimeMs: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return null;
  }
  for (const candidate of candidates) {
    try {
      treeDigest(candidate.full);
      return candidate.full;
    } catch {
      // 损坏的 backup 不可作为恢复点，继续找下一份。
    }
  }
  return null;
}

/** 将完整 Agent 目录以 staging + backup 方式激活；失败时恢复旧目录。 */
function activateAgentTree(sourceDir, stableDir, options = {}) {
  const source = path.resolve(sourceDir);
  const stable = path.resolve(stableDir);
  if (source === stable) {
    const digest = treeDigest(source);
    if (typeof options.afterActivate === "function") {
      options.afterActivate({ stable, backup: null, digest });
    }
    cleanupActivationDebris(stable);
    return { changed: false, digest };
  }
  const sourceDigest = treeDigest(source);
  let stableDigest = null;
  try {
    stableDigest = treeDigest(stable);
  } catch {
    stableDigest = null;
  }
  if (stableDigest === sourceDigest) {
    if (typeof options.afterActivate === "function") {
      options.afterActivate({ stable, backup: null, digest: sourceDigest });
    }
    cleanupActivationDebris(stable);
    return { changed: false, digest: sourceDigest };
  }

  fs.mkdirSync(path.dirname(stable), { recursive: true });
  const recoveryBackup = !fs.existsSync(stable) ? findRecoveryBackup(stable) : null;
  const nonce = `${process.pid}.${Date.now()}`;
  const stage = `${stable}.stage.${nonce}`;
  const backup = `${stable}.backup.${nonce}`;
  fs.rmSync(stage, { recursive: true, force: true });
  fs.rmSync(backup, { recursive: true, force: true });
  let movedOld = false;
  let activatedNew = false;
  try {
    fs.cpSync(source, stage, { recursive: true, force: true });
    if (treeDigest(stage) !== sourceDigest) {
      throw new Error("Agent 临时副本哈希校验失败");
    }
    if (typeof options.beforeActivate === "function") options.beforeActivate({ stage, stable, backup });
    if (fs.existsSync(stable)) {
      fs.renameSync(stable, backup);
      movedOld = true;
    }
    fs.renameSync(stage, stable);
    activatedNew = true;
    if (treeDigest(stable) !== sourceDigest) {
      throw new Error("Agent 激活后哈希校验失败");
    }
    if (typeof options.afterActivate === "function") {
      options.afterActivate({ stable, backup, digest: sourceDigest });
    }
    fs.rmSync(backup, { recursive: true, force: true });
    cleanupActivationDebris(stable);
    return { changed: true, digest: sourceDigest };
  } catch (e) {
    try {
      fs.rmSync(stage, { recursive: true, force: true });
      if (activatedNew) fs.rmSync(stable, { recursive: true, force: true });
      if (movedOld) {
        fs.renameSync(backup, stable);
      } else if (recoveryBackup && !fs.existsSync(stable)) {
        fs.renameSync(recoveryBackup, stable);
      }
    } catch {
      // 保留原始错误；下次运行会继续清理和恢复。
    }
    throw e;
  }
}

function activateInstalledAgent(options = {}) {
  const home = options.home || os.homedir();
  const pluginId = options.pluginId || "vantage@dgcrane";
  const active = resolveInstalledPlugin(home, pluginId);
  const stableDir = options.stableDir || path.join(home, ".vantage", "agent");
  const result = activateAgentTree(active.agentDir, stableDir, options);
  return {
    ...result,
    version: String(active.version),
    installPath: active.installPath,
    sourceDir: active.agentDir,
    stableDir,
  };
}

function acquireUpdateLock(home = os.homedir(), options = {}) {
  const base = path.join(home, ".vantage");
  const lockPath = path.join(base, "self-update.lock");
  const staleMs = Number(options.staleMs ?? 15 * 60 * 1000);
  fs.mkdirSync(base, { recursive: true });
  try {
    const fd = fs.openSync(lockPath, "wx", 0o600);
    fs.writeFileSync(fd, `${process.pid}\n${new Date().toISOString()}\n`);
    return { fd, path: lockPath };
  } catch (e) {
    if (e.code === "EEXIST") {
      try {
        if (
          !options.recovered &&
          Date.now() - fs.statSync(lockPath).mtimeMs > staleMs
        ) {
          fs.unlinkSync(lockPath);
          return acquireUpdateLock(home, { ...options, recovered: true });
        }
      } catch {
        // 锁在检查期间被其他进程释放；本轮保守跳过。
      }
      return null;
    }
    throw e;
  }
}

function releaseUpdateLock(lock) {
  if (!lock) return;
  try {
    fs.closeSync(lock.fd);
  } catch {}
  try {
    fs.unlinkSync(lock.path);
  } catch {}
}

function shouldCheckForUpdate(options = {}) {
  const elapsedMs = Number(options.elapsedMs ?? 0);
  const pluginIntervalMs = Number(options.pluginIntervalMs ?? 2 * 3600 * 1000);
  const scheduledIntervalMs = Number(options.scheduledIntervalMs ?? 24 * 3600 * 1000);
  if (options.source === "plugin") return elapsedMs >= pluginIntervalMs;
  return (
    options.source === "stable" &&
    options.trigger === "scheduled" &&
    elapsedMs >= scheduledIntervalMs
  );
}

function cliInvocation(args, platform = process.platform) {
  if (platform === "win32") {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", ["claude", ...args].join(" ")],
    };
  }
  return { command: "claude", args };
}

function outputTail(result, maxLength = 4096) {
  const text = `${result?.stdout || ""}\n${result?.stderr || ""}`.trim();
  return text.length > maxLength ? text.slice(-maxLength) : text;
}

/** 依次执行 Claude 官方 marketplace/plugin 更新；任何一步失败立即停止。 */
function runOfficialUpdate(options = {}) {
  const marketplace = options.marketplace || "dgcrane";
  const pluginId = options.pluginId || `vantage@${marketplace}`;
  if (!/^[A-Za-z0-9._-]+$/.test(marketplace)) throw new Error("marketplace 名称不安全");
  if (!/^[A-Za-z0-9@._-]+$/.test(pluginId)) throw new Error("plugin ID 不安全");
  const platform = options.platform || process.platform;
  const timeout = Number(options.timeoutMs || process.env.VANTAGE_SELF_UPDATE_TIMEOUT_MS || 120000);
  const runCli = options.runCli || spawnSync;
  const env = {
    ...process.env,
    ...(options.env || {}),
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=10",
  };
  const steps = [
    { phase: "marketplace", args: ["plugin", "marketplace", "update", marketplace] },
    { phase: "plugin", args: ["plugin", "update", pluginId] },
  ];
  const evidence = [];
  for (const step of steps) {
    const invocation = cliInvocation(step.args, platform);
    let result;
    try {
      result = runCli(invocation.command, invocation.args, {
        encoding: "utf8",
        env,
        timeout,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      result = { status: null, error: e, stdout: "", stderr: String(e.message || e) };
    }
    const stepEvidence = {
      phase: step.phase,
      status: result?.status ?? null,
      timedOut: result?.error?.code === "ETIMEDOUT",
      outputTail: outputTail(result),
    };
    evidence.push(stepEvidence);
    if (result?.status !== 0 || result?.error) {
      return {
        ok: false,
        ...stepEvidence,
        steps: evidence,
      };
    }
  }
  return { ok: true, phase: "complete", status: 0, outputTail: "", steps: evidence };
}

/** 完整闭环：官方更新成功后，激活生效缓存并使用新代码修复触发器。 */
function runUpdateAndActivate(options = {}) {
  const home = options.home || os.homedir();
  const marketplace = options.marketplace || process.env.VANTAGE_MARKETPLACE || "dgcrane";
  const pluginId = options.pluginId || `vantage@${marketplace}`;
  const writeLog = options.log || require("./core.cjs").log;
  const update = options.runOfficialUpdate || runOfficialUpdate;
  const activate = options.activateInstalledAgent || activateInstalledAgent;
  const stableDir = options.stableDir || path.join(home, ".vantage", "agent");
  const repair =
    options.repairTriggers ||
    (() => {
      const trigger = require(path.join(stableDir, "trigger.cjs"));
      trigger.ensureCodexTriggers({ log: writeLog, strict: true });
    });
  const lock = acquireUpdateLock(home);
  if (!lock) {
    writeLog("self-update: skipped (another updater is running)");
    return { ok: true, skipped: true, reason: "locked" };
  }
  try {
    const updated = update({
      marketplace,
      pluginId,
      timeoutMs: options.timeoutMs,
      platform: options.platform,
      runCli: options.runCli,
      env: options.env,
    });
    if (!updated.ok) {
      writeLog(
        `self-update: ${updated.phase} failed status=${updated.status} timeout=${updated.timedOut ? 1 : 0}` +
          (updated.outputTail ? ` output=${updated.outputTail}` : "")
      );
      return updated;
    }
    const activated = activate({
      home,
      pluginId,
      stableDir,
      afterActivate: () => repair(stableDir),
    });
    writeLog(
      `self-update: complete version=${activated.version} changed=${activated.changed ? 1 : 0} digest=${activated.digest}`
    );
    return { ok: true, phase: "complete", ...activated };
  } catch (e) {
    writeLog(`self-update: activate failed ${String(e.message || e)}`);
    return { ok: false, phase: "activate", error: String(e.message || e) };
  } finally {
    releaseUpdateLock(lock);
  }
}

module.exports = {
  treeDigest,
  resolveInstalledPlugin,
  resolveUpdaterWorker,
  activateAgentTree,
  activateInstalledAgent,
  acquireUpdateLock,
  releaseUpdateLock,
  shouldCheckForUpdate,
  runOfficialUpdate,
  runUpdateAndActivate,
};

if (require.main === module) {
  const probeIndex = process.argv.indexOf("--probe");
  if (probeIndex >= 0 && process.argv[probeIndex + 1]) {
    try {
      fs.writeFileSync(process.argv[probeIndex + 1], "vantage-self-update-ok\n");
    } catch {}
  } else if (process.argv.includes("--check")) {
    try {
      runUpdateAndActivate();
    } catch {
      // 后台更新永远静默退出，错误已由 runUpdateAndActivate 写入日志。
    }
  }
}
