#!/usr/bin/env node
"use strict";
// Vantage —— 一次性 setup（由 /vantage:setup 技能调用，跨平台）。
// 职责：写身份/服务端配置 -> 把 agent 同步到稳定副本 ~/.vantage/agent
//   -> 安装 Codex 扫描触发器（登录时 + 每天正午跑 reconcile --only codex，扫 ~/.codex/sessions 增量采集）。
// Claude Code 的采集钩子由插件自带（hooks.json，装插件即受信任，无需手动操作）；
// Codex 不用钩子（省去逐人 /hooks 手动信任的门槛，装了即采），改用后台定时扫会话文件（cc-switch 同款思路）。
// 用法: node setup.cjs <name> [department] [serverUrl] [token]
//   部门通常不用传：脚本按姓名查内置花名册 roster.json 自动填（防手填乱写）。
//   姓名不在册且没传部门 -> 退出码 2 并打印候选名，由 setup 技能引导用户确认。
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");

const BASE_DIR = path.join(os.homedir(), ".vantage");
const AGENT_SRC = path.join(__dirname, "agent");
const AGENT_DST = path.join(BASE_DIR, "agent");

// 测试用：写出触发器定义文件但不执行注册命令（launchctl/systemctl/schtasks），
// 让测试能断言生成内容而不污染真实系统调度器。
const TRIGGER_DRYRUN = process.env.VANTAGE_TRIGGER_DRYRUN === "1";
function register(cmd, argv) {
  if (TRIGGER_DRYRUN) return;
  try {
    execFileSync(cmd, argv, { stdio: ["ignore", "ignore", "pipe"] });
  } catch (e) {
    // 透出 stderr 里的真实原因(如 schtasks 的"拒绝访问"),不再只报含糊的 Command failed
    const detail = String(e.stderr || "").trim() || e.message;
    throw new Error(`${cmd} ${argv.join(" ")}: ${detail}`);
  }
}

// 管理员在发布插件前把后端地址/密钥填进 vantage.defaults.json，员工便只需填身份。
function loadDefaults() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "vantage.defaults.json"), "utf8"));
  } catch {
    return {};
  }
}
const defaults = loadDefaults();

const [name = "", deptArg = ""] = process.argv.slice(2);
// 优先级：命令行参数 > 环境变量 > 插件内置默认 > 兜底
const serverUrl =
  process.argv[4] || process.env.VANTAGE_SERVER || defaults.server_url || "http://localhost:3000";
const token =
  process.argv[5] || process.env.VANTAGE_TOKEN || defaults.token || "dev-token-change-me";

// 公司花名册（由通讯录生成）：姓名 -> 部门。缺文件时退化为纯手填模式。
function loadRoster() {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(__dirname, "roster.json"), "utf8"));
    return Array.isArray(r.people) ? r.people : [];
  } catch {
    return [];
  }
}

// 编辑距离（花名册重名纠错用；中文名短，距离≤1 即视为疑似笔误）
function editDistance(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
  return d[m][n];
}

// 按姓名定部门：在册 -> 以花名册为准（手填部门无效，防乱写）；
// 不在册 -> 必须显式传部门（新员工路径），否则退出码 2 并给出候选名。
function resolveDepartment(inputName, inputDept) {
  const roster = loadRoster();
  const hit = roster.find((p) => p.name === inputName);
  if (hit) {
    if (inputDept && inputDept !== hit.department) {
      console.log(`· 部门以公司通讯录为准：${hit.department}（忽略传入的「${inputDept}」）`);
    }
    return hit.department;
  }
  if (inputDept) {
    console.log(`· 「${inputName}」不在通讯录中，按手填部门登记：${inputDept}`);
    return inputDept;
  }
  // 候选：疑似笔误（编辑距离≤1）优先，其次同姓，最多 5 个
  const near = roster.filter((p) => editDistance(p.name, inputName) <= 1).map((p) => p.name);
  const sameSurname = roster
    .filter((p) => p.name[0] === inputName[0] && !near.includes(p.name))
    .map((p) => p.name);
  const cand = [...near, ...sameSurname].slice(0, 5);
  console.log(`！「${inputName}」不在公司通讯录中。`);
  if (cand.length) console.log(`  是不是想填：${cand.join(" / ")}`);
  console.log("  请核对姓名后重试；确为新员工时手动指定部门：node setup.cjs <姓名> <部门>");
  process.exit(2);
}

function writeConfig(department) {
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
      { name, department, server_url: serverUrl, token, installed_at: installedAt },
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

// 安装 Codex 扫描触发器：登录时 + 每天正午跑 reconcile --only codex，增量扫 ~/.codex/sessions。
// 节奏依据：消费端是周一晨会看上周，数据当天到即可；每天两个触发点留足失败容错，
// 比每小时省 20+ 次无谓唤醒，比每周一次多 6 天的补采机会。
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
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>12</integer><key>Minute</key><integer>0</integer></dict>
</dict></plist>
`
  );
  const domain = `gui/${process.getuid()}`;
  try {
    register("launchctl", ["bootout", `${domain}/${label}`]);
  } catch {
    /* 未加载过，忽略 */
  }
  register("launchctl", ["bootstrap", domain, plist]);
  console.log("✓ 已安装 Codex 扫描触发器（LaunchAgent，登录时 + 每天正午，升级安全）");
}

function installSystemd(node, reconcile) {
  const dir = path.join(os.homedir(), ".config", "systemd", "user");
  fs.mkdirSync(dir, { recursive: true });
  // oneshot 服务负责跑一次扫描；timer 在开机后和每天正午拉起它（错过则补跑）。
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
Description=Vantage - 开机及每天正午扫描 Codex 会话
[Timer]
OnBootSec=2min
OnCalendar=*-*-* 12:00:00
Persistent=true
[Install]
WantedBy=timers.target
`
  );
  register("systemctl", ["--user", "daemon-reload"]);
  register("systemctl", ["--user", "enable", "--now", "vantage-codex.timer"]);
  console.log("✓ 已安装 Codex 扫描触发器（systemd timer，开机 + 每天正午，升级安全）");
}

function installSchtasks() {
  // Windows 触发器逻辑收在 agent/trigger.cjs——与 reconcile 自检自愈共用同一来源:
  // 登录自启走"启动"文件夹(用户级,零权限;旧 ONLOGON 计划任务要管理员,已弃),
  // 每日兜底走 schtasks DAILY(普通账号可建)。失败不再中断 setup,各步独立报错。
  require("./agent/trigger.cjs").ensureWindowsCodexTrigger({ log: console.log });
  console.log("✓ Codex 扫描触发器:登录自启(启动文件夹)+ 每天正午(计划任务),无需管理员,隐藏窗口");
}

console.log("== Vantage setup ==");
if (!name) {
  console.log("！缺少姓名。用法: node setup.cjs <姓名> [部门] [server] [token]");
  process.exit(1);
}
if (deptArg.includes("@")) {
  console.log("！第二个参数应是部门（现在不再登记邮箱）。用法: node setup.cjs <姓名> [部门]");
  process.exit(1);
}
const department = resolveDepartment(name, deptArg);
writeConfig(department);
syncAgent();
installTrigger();

// 写完身份立刻后台跑一次对账（除非显式跳过 setup 期副作用，如测试）：
// 把历史会话（含 setup 前以空身份采的）按新身份重传，服务端 upsert 覆盖，
// 看板马上能看到正确归属，不必等下次开会话 / 下个触发点。
if (process.env.VANTAGE_SKIP_TRIGGER !== "1" && !TRIGGER_DRYRUN) {
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
console.log(`  身份: ${name} / ${department}`);
console.log(`  上报地址: ${serverUrl}`);
console.log("  Claude Code：开启/结束会话即自动采集，无需任何操作。");
console.log("  Codex：登录时及每天正午自动扫描会话并采集，无需任何操作（无需在 /hooks 里信任）。");
