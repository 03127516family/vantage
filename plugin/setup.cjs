#!/usr/bin/env node
"use strict";
// Vantage —— 一次性 setup（由 /vantage:setup 技能调用，跨平台）。
// 职责：写身份/服务端配置 -> 把 agent 同步到稳定副本 ~/.vantage/agent
//   -> 安装 Codex 扫描触发器（登录时 + 每小时 + 平台补跑，扫 ~/.codex/sessions 增量采集）。
// Claude Code 的采集钩子由插件自带（hooks.json，装插件即受信任，无需手动操作）；
// Codex 不用钩子（省去逐人 /hooks 手动信任的门槛，装了即采），改用后台定时扫会话文件（cc-switch 同款思路）。
// 用法: node setup.cjs <name> [department] [serverUrl] [token]
//   部门通常不用传：脚本按姓名查内置花名册 roster.json 自动填（防手填乱写）。
//   姓名不在册且没传部门 -> 退出码 2 并打印候选名，由 setup 技能引导用户确认。
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const { spawn } = require("node:child_process");
const installers = require("./agent/installers.cjs");

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
// 优先调服务端 roster API(来新人服务端改 roster.json 即全员生效);
// API 不可达时退化到本地 roster.json 兜底(员工断网/服务器挂也能装)。
function resolveDepartment(inputName, inputDept) {
  return (async () => {
    // 1. 优先 API
    const apiResult = await checkRosterApi(serverUrl, token, inputName);
    if (apiResult && apiResult.exists) {
      if (inputDept && inputDept !== apiResult.department) {
        console.log(`· 部门以公司通讯录为准：${apiResult.department}（忽略传入的「${inputDept}」）`);
      }
      return apiResult.department;
    }
    if (apiResult && apiResult.exists === false) {
      // API 明确不在册:取候选 + 决定走手填或退出
      if (inputDept) {
        console.log(`· 「${inputName}」不在通讯录中，按手填部门登记：${inputDept}`);
        return inputDept;
      }
      const nearby = await nearbyRosterApi(serverUrl, token, inputName);
      const cand = (nearby && nearby.candidates) || [];
      console.log(`！「${inputName}」不在公司通讯录中。`);
      if (cand.length) console.log(`  是不是想填：${cand.join(" / ")}`);
      console.log("  请核对姓名后重试；确为新员工时手动指定部门：node setup.cjs <姓名> <部门>");
      process.exit(2);
    }
    // 2. API 不可达 → 本地 roster.json 兜底
    console.log("· 服务端 roster 不可达，退化到本地花名册兜底");
    const roster = loadRoster();
    const hit = roster.find((p) => p.name === inputName);
    if (hit) {
      if (inputDept && inputDept !== hit.department) {
        console.log(`· 部门以公司通讯录为准：${hit.department}（忽略传入的「${inputDept}」）`);
      }
      return hit.department;
    }
    if (inputDept) {
      console.log(`· 「${inputName}」不在本地花名册中，按手填部门登记：${inputDept}`);
      return inputDept;
    }
    // 本地也没有 → 手填兜底(同原逻辑,用本地 roster 给候选)
    const near = roster.filter((p) => editDistance(p.name, inputName) <= 1).map((p) => p.name);
    const sameSurname = roster
      .filter((p) => p.name[0] === inputName[0] && !near.includes(p.name))
      .map((p) => p.name);
    const cand = [...near, ...sameSurname].slice(0, 5);
    console.log(`！「${inputName}」不在本地花名册中。`);
    if (cand.length) console.log(`  是不是想填：${cand.join(" / ")}`);
    console.log("  请核对姓名后重试；确为新员工时手动指定部门：node setup.cjs <姓名> <部门>");
    process.exit(2);
  })();
}

// HTTP GET (15s 超时)。返回解析后的 JSON,失败 → null。绝不抛。
function getJson(url, token, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return resolve(null);
    }
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(
      u,
      { method: "GET", headers: { authorization: `Bearer ${token}` }, timeout: timeoutMs },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) return resolve(null);
          try { resolve(JSON.parse(body)); } catch { resolve(null); }
        });
      }
    );
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
    req.end();
  });
}

// HTTP POST (15s 超时,后台 detached 用,不阻塞主流程)。只发,不等响应。
function postJsonAsync(url, token, body, timeoutMs = 15000) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return;
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
    (res) => res.resume()
  );
  req.on("timeout", () => req.destroy());
  req.on("error", () => {});
  req.write(data);
  req.end();
}

// 通过 API 查 name 是否在册 + 部门;失败 → null(由调用方退化本地兜底)。
async function checkRosterApi(serverUrl, token, name) {
  const base = String(serverUrl).replace(/\/+$/, "");
  return getJson(`${base}/roster/check?name=${encodeURIComponent(name)}`, token);
}

// 通过 API 拿笔误候选;失败 → null。
async function nearbyRosterApi(serverUrl, token, name) {
  const base = String(serverUrl).replace(/\/+$/, "");
  return getJson(`${base}/roster/nearby?name=${encodeURIComponent(name)}`, token);
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

// 安装 Codex 扫描触发器：登录时 + 每小时跑 reconcile --only codex，增量扫 ~/.codex/sessions。
// 节奏依据：消费端是周一晨会看上周，数据当天到即可；每小时兜底 + 平台补跑留足失败容错。
// 指向稳定路径 ~/.vantage/agent（插件升级换目录也不失效）。分平台用 launchd/systemd/schtasks。
function installTrigger() {
  if (process.env.VANTAGE_SKIP_TRIGGER === "1") {
    console.log("· 跳过 Codex 定时扫描安装（VANTAGE_SKIP_TRIGGER=1）");
    return;
  }
  const node = process.execPath;
  const reconcile = path.join(AGENT_DST, "reconcile.cjs");
  try {
    if (process.platform === "darwin") installers.installLaunchd(node, reconcile);
    else if (process.platform === "linux") installers.installSystemd(node, reconcile);
    else if (process.platform === "win32") installers.installWindowsCodexTrigger({ log: console.log });
    else console.log(`· 未知平台 ${process.platform}，跳过 Codex 定时扫描（Claude 仍正常）`);
  } catch (e) {
    console.log(`！Codex 定时扫描安装失败（Claude 采集不受影响）：${e.message}`);
  }
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

(async () => {
  const department = await resolveDepartment(name, deptArg);
  writeConfig(department);
  syncAgent();
  installTrigger();

  // 后台异步上报 /install(不阻塞 setup 完成,失败仅写日志,后续 reconcile 会补报)。
  // 故意不 await: 请求已发出,进程立即往下走;响应由 Node 事件循环自然处理。
  try {
    const base = String(serverUrl).replace(/\/+$/, "");
    postJsonAsync(`${base}/install`, token, { name });
    console.log("· 已上报安装记录(后台异步)");
  } catch (e) {
    console.log(`！安装记录上报失败（不影响后续采集）：${e.message}`);
  }

  // 写完身份立刻后台跑一次对账（除非显式跳过 setup 期副作用，如测试）：
  // 把历史会话（含 setup 前以空身份采的）按新身份重传，服务端 upsert 覆盖，
  // 看板马上能看到正确归属，不必等下次开会话 / 下个触发点。
  if (process.env.VANTAGE_SKIP_TRIGGER !== "1" && process.env.VANTAGE_TRIGGER_DRYRUN !== "1") {
    try {
      const child = spawn(process.execPath, [path.join(AGENT_DST, "reconcile.cjs")], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
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
  console.log("  Codex：登录时及每小时自动扫描会话并采集，无需任何操作（无需在 /hooks 里信任）。");
})().catch((e) => {
  console.error("setup 异常:", e);
  process.exit(1);
});
