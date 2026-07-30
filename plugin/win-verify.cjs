#!/usr/bin/env node
"use strict";
// Vantage —— Windows 实机验证脚本。
// 用途:在员工 Windows 机器上真实验证「定时触发器 VBS」和「自更新无窗链路」,
//       而不是只在开发机上做静态推断。只做验证 + 一次真实的 marketplace 刷新,不删任何东西。
// 用法:员工在终端(PowerShell / Windows Terminal / cmd)里运行:
//   node win-verify.cjs
// (文件可由管理员从微信发来放到任意目录;插件升到 1.4.13 后缓存里也自带:
//   %USERPROFILE%\.claude\plugins\cache\dgcrane\vantage\1.4.13\win-verify.cjs)
// 跑完把全部输出复制/截图发回管理员。
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

let pass = 0, fail = 0;
const ok = (c, name, detail) => {
  c ? pass++ : fail++;
  console.log(` ${c ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
};
const info = (msg) => console.log(`  · ${msg}`);

if (process.platform !== "win32") {
  console.log("此脚本只用于 Windows 实机验证,当前不是 Windows,退出。");
  process.exit(0);
}

// VBScript 词法检查(与 tests/agent.test.cjs 同款):专检 800A0401 Expected end of statement 那类错。
function vbsLexCheck(line) {
  let i = 0;
  const strings = [];
  while (i < line.length) {
    const c = line[i];
    if (c === '"') {
      let s = "";
      i++;
      for (;;) {
        if (i >= line.length) return { error: "unclosed string at end", strings };
        if (line[i] === '"') {
          if (line[i + 1] === '"') { s += '"'; i += 2; continue; }
          i++;
          break;
        }
        s += line[i];
        i++;
      }
      strings.push(s);
      let j = i;
      while (j < line.length && line[j] === " ") j++;
      if (j < line.length && line[j] !== "," && line[j] !== ")") {
        return { error: `Expected end of statement at char ${j + 1}`, strings };
      }
      i = j;
      if (line[i] === ",") i++;
    } else {
      i++;
    }
  }
  return { error: null, strings };
}

function decodeFile(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.slice(2).toString("utf16le");
  return buf.toString("utf8");
}

const CACHE_ROOT = path.join(os.homedir(), ".claude", "plugins", "cache", "dgcrane", "vantage");
function listVersions() {
  try {
    const cmp = (a, b) => {
      const x = a.split(".").map(Number), y = b.split(".").map(Number);
      for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
      return 0;
    };
    return fs.readdirSync(CACHE_ROOT).filter((d) => /^\d+\.\d+\.\d+$/.test(d)).sort(cmp);
  } catch {
    return [];
  }
}

console.log("== Vantage Windows 实机验证 ==");

// ---- 1. 插件版本 ----
const versions = listVersions();
ok(versions.length > 0, "插件缓存存在", versions.join(", ") || `${CACHE_ROOT} 不存在`);
if (!versions.length) {
  console.log("\n插件未安装,无法继续。请先装插件再跑本脚本。");
  process.exit(1);
}
const pluginDir = path.join(CACHE_ROOT, versions[versions.length - 1]);
info(`当前最新版本目录: ${pluginDir}`);
const core = require(path.join(pluginDir, "agent", "core.cjs"));
const installers = require(path.join(pluginDir, "agent", "installers.cjs"));

// ---- 2. 生产函数生成的 VBS 词法(定时弹窗那类错) ----
const recPath = path.join(os.homedir(), ".vantage", "agent", "reconcile.cjs");
if (typeof installers.vbsBody === "function") {
  const body = installers.vbsBody(process.execPath, recPath);
  const runLine = body.split("\r\n").filter(Boolean)[1] || "";
  const { error } = vbsLexCheck(runLine);
  ok(!error, "触发器 VBS(vbsBody)词法", error || "通过");
} else {
  ok(false, "触发器 VBS(vbsBody)词法", "插件版本过旧(无 vbsBody 导出),请先升级插件");
}

// ---- 3. 磁盘上的触发器文件现状(老文件残留会按小时弹窗) ----
const bodyNow = typeof installers.vbsBody === "function" ? installers.vbsBody(process.execPath, recPath) : null;
for (const [label, p] of [
  ["每小时任务 run-reconcile.vbs", path.join(os.homedir(), ".vantage", "run-reconcile.vbs")],
  ["登录自启 vantage-codex.vbs", path.join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "vantage-codex.vbs")],
]) {
  if (!fs.existsSync(p)) {
    info(`${label}: 不存在(${p})`);
    continue;
  }
  const text = decodeFile(fs.readFileSync(p));
  const runLine = text.split(/\r?\n/).filter(Boolean).pop();
  const { error } = vbsLexCheck(runLine);
  ok(!error, `${label}: 词法`, error || "通过");
  if (bodyNow) {
    ok(
      text === bodyNow,
      `${label}: 内容与当前代码生成的一致`,
      text === bodyNow ? "" : "不一致 = 老版本残留(升级插件并打开一次 claude 后会自愈)"
    );
  }
}

// ---- 4. wscript 真实执行(证明:生成的 VBS 在这台机器上无编译弹窗、无窗口) ----
if (typeof core.hiddenRunVbs === "function") {
  const marker = path.join(os.tmpdir(), "vantage-wscript-ok.txt");
  try { fs.unlinkSync(marker); } catch { /* 不存在 */ }
  const vbsPath = path.join(os.tmpdir(), "vantage-verify-run.vbs");
  const vbs = core.hiddenRunVbs(`echo vantage-wscript-ok> "${marker}"`);
  fs.writeFileSync(vbsPath, installers.vbsBuffer(vbs));
  const r = spawnSync("wscript.exe", [vbsPath], { windowsHide: true, timeout: 20000 });
  ok(!r.error, "wscript 执行未挂起(挂起≈有模态弹窗)", r.error ? String(r.error.message || r.error) : "");
  let found = false;
  for (let i = 0; i < 5 && !found; i++) {
    spawnSync("cmd", ["/c", "ping", "-n", "2", "127.0.0.1"], { stdio: "ignore", windowsHide: true });
    found = fs.existsSync(marker);
  }
  ok(found, "wscript 真实执行生成标记文件(VBS 编译/引用/转义全链路正确)");
} else {
  info("跳过 wscript 实机执行:当前插件无 hiddenRunVbs(需 1.4.12+,先升级再验证)");
}

// ---- 5. 自更新链路真实跑(带 SSH BatchMode 守卫;这步本身就在刷新 marketplace) ----
info("真实执行: claude plugin marketplace update dgcrane(最多 90 秒)…");
const upd = spawnSync(
  "cmd",
  ["/c", 'set "GIT_SSH_COMMAND=ssh -o BatchMode=yes -o ConnectTimeout=10" && claude plugin marketplace update dgcrane'],
  { encoding: "utf8", timeout: 90000, windowsHide: true }
);
ok(upd.status === 0 && !upd.error, "marketplace update 成功(SSH 无人值守可用)",
  upd.error ? `超时/错误: ${upd.error.message}` : `exit=${upd.status}`);
const updOut = `${upd.stdout || ""}\n${upd.stderr || ""}`.trim();
if (updOut) info("输出尾部: " + updOut.split("\n").slice(-3).join(" | "));
const versionsAfter = listVersions();
info(`刷新后缓存版本: ${versionsAfter.join(", ")}`);

// ---- 6. agent.log 尾部(自更新/触发器自检痕迹) ----
try {
  const logText = decodeFile(fs.readFileSync(path.join(os.homedir(), ".vantage", "agent.log")));
  const tail = logText.trim().split("\n").slice(-8);
  info("agent.log 尾部:");
  for (const l of tail) info("  " + l);
} catch {
  info("agent.log 不存在(还没跑过 reconcile)");
}

console.log(`\n======== 结果: ${pass} 通过, ${fail} 失败 ========`);
console.log("请把以上全部输出复制或截图发回管理员。");
process.exit(0);
