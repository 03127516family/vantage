#!/usr/bin/env node
"use strict";
// Vantage —— 一次性 setup（由 /vantage:setup 技能调用，跨平台）。
// 职责：写身份/服务端配置 -> 把 agent 同步到稳定副本 ~/.vantage/agent
//   -> 安装 Codex 定时扫描触发器（每小时跑 reconcile --only codex，扫 ~/.codex/sessions 增量采集）。
// Claude Code 的采集钩子由插件自带（hooks.json，装插件即受信任，无需手动操作）；
// Codex 不用钩子（省去逐人 /hooks 手动信任的门槛，装了即采），改用后台定时扫会话文件（cc-switch 同款思路）。
// 用法: node setup.cjs <name> <email> <department> [serverUrl] [token]
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");

const BASE_DIR = path.join(os.homedir(), ".vantage");
const AGENT_SRC = path.join(__dirname, "agent");
const AGENT_DST = path.join(BASE_DIR, "agent");

// 管理员在发布插件前把后端地址/密钥填进 vantage.defaults.json，员工便只需填身份。
function loadDefaults() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "vantage.defaults.json"), "utf8"));
  } catch {
    return {};
  }
}
const defaults = loadDefaults();

const [name = "", email = "", department = ""] = process.argv.slice(2);
// 优先级：命令行参数 > 环境变量 > 插件内置默认 > 兜底
const serverUrl =
  process.argv[5] || process.env.VANTAGE_SERVER || defaults.server_url || "http://localhost:3000";
const token =
  process.argv[6] || process.env.VANTAGE_TOKEN || defaults.token || "dev-token-change-me";

function writeConfig() {
  fs.mkdirSync(BASE_DIR, { recursive: true });
  const p = path.join(BASE_DIR, "config.json");
  // 保留已有的 installed_at（重装不改初装时刻）；首次安装才写入。
  let installedAt = new Date().toISOString();
  try {
    const prev = JSON.parse(fs.readFileSync(p, "utf8"));
    if (prev.installed_at) installedAt = prev.installed_at;
  } catch {
    /* 首次安装 */
  }
  fs.writeFileSync(
    p,
    JSON.stringify(
      { name, email, department, server_url: serverUrl, token, installed_at: installedAt },
      null,
      2
    ) + "\n",
    { mode: 0o600 }
  );
  try {
    fs.chmodSync(p, 0o600);
  } catch {
    /* Windows 无 POSIX 权限 */
  }
  console.log(`✓ 已写入身份配置 ${p}`);
}

// 把插件内的 agent 复制到稳定副本，供 Codex 触发器引用（插件更新换目录也不失效）
function syncAgent() {
  fs.mkdirSync(AGENT_DST, { recursive: true });
  fs.cpSync(AGENT_SRC, AGENT_DST, { recursive: true });
  console.log(`✓ 已同步 Agent 到稳定副本 ${AGENT_DST}`);
}

// 安装 Codex 定时扫描触发器：每小时跑一次 reconcile --only codex，增量扫 ~/.codex/sessions。
// 指向稳定路径 ~/.vantage/agent（插件升级换目录也不失效）。分平台用 launchd/systemd/schtasks。
function installTrigger() {
  if (process.env.VANTAGE_SKIP_TRIGGER === "1") {
    console.log("· 跳过 Codex 定时扫描安装（VANTAGE_SKIP_TRIGGER=1）");
    return;
  }
  const node = process.execPath;
  const reconcile = path.join(AGENT_DST, "reconcile.cjs");
  try {
    if (process.platform === "darwin") installLaunchd(node, reconcile);
    else if (process.platform === "linux") installSystemd(node, reconcile);
    else if (process.platform === "win32") installSchtasks(node, reconcile);
    else console.log(`· 未知平台 ${process.platform}，跳过 Codex 定时扫描（Claude 仍正常）`);
  } catch (e) {
    console.log(`！Codex 定时扫描安装失败（Claude 采集不受影响）：${e.message}`);
  }
}

function installLaunchd(node, reconcile) {
  const label = "com.dgcrane.vantage.codex";
  const dir = path.join(os.homedir(), "Library", "LaunchAgents");
  fs.mkdirSync(dir, { recursive: true });
  const plist = path.join(dir, `${label}.plist`);
  fs.writeFileSync(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${reconcile}</string>
    <string>--only</string><string>codex</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>3600</integer>
</dict></plist>
`
  );
  const domain = `gui/${process.getuid()}`;
  try {
    execFileSync("launchctl", ["bootout", `${domain}/${label}`], { stdio: "ignore" });
  } catch {
    /* 未加载过，忽略 */
  }
  execFileSync("launchctl", ["bootstrap", domain, plist], { stdio: "ignore" });
  console.log("✓ 已安装 Codex 定时扫描（LaunchAgent，每小时 + 登录时，升级安全）");
}

function installSystemd(node, reconcile) {
  const dir = path.join(os.homedir(), ".config", "systemd", "user");
  fs.mkdirSync(dir, { recursive: true });
  // oneshot 服务负责跑一次扫描；timer 每小时拉起它。
  fs.writeFileSync(
    path.join(dir, "vantage-codex.service"),
    `[Unit]
Description=Vantage - Codex 会话扫描采集
[Service]
Type=oneshot
ExecStart=${node} ${reconcile} --only codex
`
  );
  fs.writeFileSync(
    path.join(dir, "vantage-codex.timer"),
    `[Unit]
Description=Vantage - 每小时扫描 Codex 会话
[Timer]
OnBootSec=2min
OnUnitActiveSec=1h
Persistent=true
[Install]
WantedBy=timers.target
`
  );
  execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
  execFileSync("systemctl", ["--user", "enable", "--now", "vantage-codex.timer"], {
    stdio: "ignore",
  });
  console.log("✓ 已安装 Codex 定时扫描（systemd timer，每小时，升级安全）");
}

function installSchtasks(node, reconcile) {
  execFileSync(
    "schtasks",
    [
      "/Create",
      "/TN",
      "VantageCodexReconcile",
      "/SC",
      "HOURLY",
      "/TR",
      `"${node}" "${reconcile}" --only codex`,
      "/F",
    ],
    { stdio: "ignore" }
  );
  console.log("✓ 已安装 Codex 定时扫描（计划任务，每小时，升级安全）");
}

console.log("== Vantage setup ==");
if (!name || !email || !department) {
  console.log("！缺少身份参数。用法: node setup.cjs <姓名> <邮箱> <部门> [server] [token]");
  process.exit(1);
}
writeConfig();
syncAgent();
installTrigger();

// 写完身份立刻后台跑一次对账（除非显式跳过 setup 期副作用，如测试）：
// 把历史会话（含 setup 前以空身份采的）按新身份重传，服务端 upsert 覆盖，
// 看板马上能看到正确归属，不必等下次开会话 / 每小时定时。
if (process.env.VANTAGE_SKIP_TRIGGER !== "1") {
  try {
    const child = spawn(process.execPath, [path.join(AGENT_DST, "reconcile.cjs")], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    console.log("✓ 已触发首次对账（后台用新身份补采历史会话）");
  } catch (e) {
    console.log(`！首次对账触发失败（不影响后续自动采集）：${e.message}`);
  }
}

console.log("");
console.log("== 完成 ==");
console.log(`  身份: ${name} <${email}> / ${department}`);
console.log(`  上报地址: ${serverUrl}`);
console.log("  Claude Code：开启/结束会话即自动采集，无需任何操作。");
console.log("  Codex：后台每小时自动扫描会话并采集，无需任何操作（无需在 /hooks 里信任）。");
