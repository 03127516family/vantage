#!/usr/bin/env node
"use strict";
// Vantage —— Codex 触发器自检自愈。
// setup 装机与 reconcile 运行都会调用这里，确保触发器内容漂移即重写、升级即生效。
// 设计:登录自启 = 启动文件夹里的 VBS(用户自己目录,零权限);每小时兜底 = 各平台调度器。
// 非 win32 / macOS / Linux 直接返回。
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const installers = require("./installers.cjs");

// Windows: 调用 installers 安装/修复，并清理旧任务名称
function ensureWindowsCodexTrigger(opts = {}) {
  installers.installWindowsCodexTrigger(opts);
}

// macOS: 校验两个 plist（每小时 + WatchPaths）是否存在且包含 --trigger；否则重写
function ensureMacosCodexTrigger({ log = () => {} } = {}) {
  if (process.platform !== "darwin") return;
  const labelBase = "com.dgcrane.vantage.codex";
  const dir = path.join(os.homedir(), "Library", "LaunchAgents");
  const scheduledPlist = path.join(dir, `${labelBase}.scheduled.plist`);
  const watchPlist = path.join(dir, `${labelBase}.watch.plist`);

  // 简单校验：新形态存在且参数正确
  if (fs.existsSync(scheduledPlist) && fs.existsSync(watchPlist)) {
    try {
      const s = fs.readFileSync(scheduledPlist, "utf8");
      const w = fs.readFileSync(watchPlist, "utf8");
      if (s.includes("--trigger scheduled") && w.includes("--trigger event")) return;
    } catch {
      /* 读失败继续修复 */
    }
  }

  try {
    installers.installLaunchd(process.execPath, path.join(os.homedir(), ".vantage", "agent", "reconcile.cjs"));
    log("✓ macOS Codex 触发器已自检修复（每小时 + WatchPaths）");
  } catch (e) {
    log(`! macOS Codex 触发器自检失败：${e.message}`);
  }
}

// Linux: 校验 timer 是否为每小时 + Persistent；否则重写
function ensureLinuxCodexTrigger({ log = () => {} } = {}) {
  if (process.platform !== "linux") return;
  const timerPath = path.join(os.homedir(), ".config", "systemd", "user", "vantage-codex.timer");
  if (fs.existsSync(timerPath)) {
    try {
      const cur = fs.readFileSync(timerPath, "utf8");
      if (cur.includes("OnCalendar=*-*-* *:00:00") && cur.includes("Persistent=true")) return;
    } catch {
      /* 读失败继续修复 */
    }
  }

  try {
    installers.installSystemd(process.execPath, path.join(os.homedir(), ".vantage", "agent", "reconcile.cjs"));
    log("✓ Linux Codex 触发器已自检修复（每小时 + Persistent）");
  } catch (e) {
    log(`! Linux Codex 触发器自检失败：${e.message}`);
  }
}

function ensureCodexTriggers(opts = {}) {
  ensureWindowsCodexTrigger(opts);
  ensureMacosCodexTrigger(opts);
  ensureLinuxCodexTrigger(opts);
}

module.exports = { ensureCodexTriggers, ensureWindowsCodexTrigger };
