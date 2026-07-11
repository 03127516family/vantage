#!/usr/bin/env node
"use strict";
// Vantage —— 一次性 setup（由 /vantage:setup 技能调用，跨平台）。
// 职责：写身份/服务端配置 -> 把 agent 同步到稳定副本 ~/.vantage/agent -> 安装 Codex 登录触发器。
// Claude Code 的采集钩子由插件自带（hooks.json），此处不涉及。
// 用法: node setup.cjs <name> <email> <department> [serverUrl] [token]
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

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
  fs.writeFileSync(
    p,
    JSON.stringify({ name, email, department, server_url: serverUrl, token }, null, 2) + "\n",
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

function installTrigger() {
  if (process.env.VANTAGE_SKIP_TRIGGER === "1") {
    console.log("· 跳过 Codex 触发器安装（VANTAGE_SKIP_TRIGGER=1）");
    return;
  }
  const node = process.execPath;
  const reconcile = path.join(AGENT_DST, "reconcile.cjs");
  try {
    if (process.platform === "darwin") installLaunchd(node, reconcile);
    else if (process.platform === "linux") installSystemd(node, reconcile);
    else if (process.platform === "win32") installSchtasks(node, reconcile);
    else console.log(`· 未知平台 ${process.platform}，跳过 Codex 触发器（Claude 仍正常）`);
  } catch (e) {
    console.log(`！Codex 触发器安装失败（Claude 采集不受影响）：${e.message}`);
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
  console.log("✓ 已安装 Codex 登录/开机触发器（LaunchAgent，升级安全）");
}

function installSystemd(node, reconcile) {
  const dir = path.join(os.homedir(), ".config", "systemd", "user");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "vantage-codex.service"),
    `[Unit]
Description=Vantage - Codex reconcile at login
[Service]
Type=oneshot
ExecStart=${node} ${reconcile} --only codex
[Install]
WantedBy=default.target
`
  );
  execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
  execFileSync("systemctl", ["--user", "enable", "--now", "vantage-codex.service"], {
    stdio: "ignore",
  });
  console.log("✓ 已安装 Codex 登录触发器（systemd user service，升级安全）");
}

function installSchtasks(node, reconcile) {
  execFileSync(
    "schtasks",
    [
      "/Create",
      "/TN",
      "VantageCodexReconcile",
      "/SC",
      "ONLOGON",
      "/TR",
      `"${node}" "${reconcile}" --only codex`,
      "/F",
    ],
    { stdio: "ignore" }
  );
  console.log("✓ 已安装 Codex 登录触发器（计划任务，升级安全）");
}

console.log("== Vantage setup ==");
if (!name || !email || !department) {
  console.log("！缺少身份参数。用法: node setup.cjs <姓名> <邮箱> <部门> [server] [token]");
  process.exit(1);
}
writeConfig();
syncAgent();
installTrigger();
console.log("");
console.log("== 完成 ==");
console.log(`  身份: ${name} <${email}> / ${department}`);
console.log(`  上报地址: ${serverUrl}`);
console.log("  之后开启/结束 Claude Code、以及登录电脑时会自动采集并上传，无需任何操作。");
