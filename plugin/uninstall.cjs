#!/usr/bin/env node
"use strict";
// Vantage 卸载:清 OS 触发器(三平台)+ 删 ~/.vantage + 删插件缓存 + detached 延迟卸插件本体。
// 顺序关键:插件本体最后卸(detached,skill 退出后 2 秒再执行),避免「卸载 skill 自己卸自己」中断。
// 用户跑完只需重启一次 Claude 会话让卸载彻底生效。
// 环境变量:VANTAGE_TRIGGER_DRYRUN=1 只打印命令不执行(测试);VANTAGE_UNINSTALL_SKIP_PLUGIN=1 跳过 detached 卸插件(测试)。
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const core = require("./agent/core.cjs");

const DRYRUN = process.env.VANTAGE_TRIGGER_DRYRUN === "1";
const SKIP_PLUGIN = process.env.VANTAGE_UNINSTALL_SKIP_PLUGIN === "1";

// 删文件/目录:总是真做(在沙箱 HOME 里安全)。DRYRUN 只屏蔽系统调度器命令与卸插件,不屏蔽删文件。
function rm(p) {
  if (!p) return;
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
}

function run(cmd, argv, dryLabel) {
  if (DRYRUN) { console.log(`[dryrun] ${dryLabel}`); return; }
  try { execFileSync(cmd, argv, { stdio: "ignore" }); } catch { /* 不存在/未加载,幂等忽略 */ }
}

// --- 三平台触发器卸载(对应 setup/trigger 装的) ---
function uninstallMacTrigger() {
  const label = "com.dgcrane.vantage.codex";
  const plist = path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
  run("launchctl", ["bootout", `gui/${process.getuid()}/${label}`], `launchctl bootout gui/${process.getuid()}/${label}`);
  rm(plist);
}

function uninstallLinuxTrigger() {
  const dir = path.join(os.homedir(), ".config", "systemd", "user");
  run("systemctl", ["--user", "disable", "--now", "vantage-codex.service"], "systemctl --user disable --now vantage-codex.service");
  rm(path.join(dir, "vantage-codex.service"));
  rm(path.join(dir, "vantage-codex.timer"));
  run("systemctl", ["--user", "daemon-reload"], "systemctl --user daemon-reload");
}

function uninstallWindowsTrigger() {
  const roaming = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const startup = path.join(roaming, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
  rm(path.join(startup, "vantage-codex.vbs"));
  rm(path.join(core.BASE_DIR, "run-reconcile.vbs")); // 每日兜底执行体
  run("schtasks", ["/Delete", "/TN", "VantageCodexDaily", "/F"], "schtasks /Delete /TN VantageCodexDaily /F");
  // 清理旧版残留任务(已弃的 ONLOGON + 旧每小时任务),与 trigger.cjs ensure 对称;不存在则幂等忽略
  for (const tn of ["VantageCodexLogon", "VantageCodexReconcile"]) {
    run("schtasks", ["/Delete", "/TN", tn, "/F"], `schtasks /Delete /TN ${tn} /F`);
  }
}

// --- 插件缓存(marketplace 注册 + 下载缓存) ---
function uninstallPluginCache() {
  const root = path.join(os.homedir(), ".claude", "plugins");
  rm(path.join(root, "cache", "dgcrane"));
  rm(path.join(root, "marketplaces", "dgcrane"));
}

function main() {
  console.log("== Vantage 卸载 ==");
  // 1. 卸 OS 触发器(按平台)
  if (process.platform === "darwin") uninstallMacTrigger();
  else if (process.platform === "linux") uninstallLinuxTrigger();
  else if (process.platform === "win32") uninstallWindowsTrigger();
  else console.log(`· 未知平台 ${process.platform},跳过触发器卸载`);
  // 2. 删 ~/.vantage(配置 + 采集脚本 + spool/dead/state/log,全部)
  rm(core.BASE_DIR);
  // 3. 删插件缓存
  uninstallPluginCache();
  // 4. detached 延迟卸插件本体:skill 退出后 2 秒由独立进程执行,绕开自卸载竞态
  const pluginCmd = "sleep 2 && claude plugin uninstall vantage@dgcrane && claude plugin marketplace remove dgcrane";
  if (SKIP_PLUGIN || DRYRUN) {
    console.log(`[dryrun/skip] spawnShellDetached: ${pluginCmd}`);
  } else {
    core.spawnShellDetached(pluginCmd);
  }
  console.log(`✓ 已卸载(触发器 + ~/.vantage + 缓存${!SKIP_PLUGIN && !DRYRUN ? " + 插件本体(2秒后自动)" : ""})`);
  console.log("→ 请重启 Claude 会话(/exit 后重开,或 /reload-plugins)让卸载彻底生效。");
  console.log("→ 若重启后插件仍显示(detached 卸载未生效),手动执行: /plugin uninstall vantage@dgcrane");
}

main();
