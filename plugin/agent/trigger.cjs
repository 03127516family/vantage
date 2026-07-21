#!/usr/bin/env node
"use strict";
// Codex 触发器(Windows)的单一来源:setup 装机与 reconcile 自检自愈共用。
// 设计:登录自启 = "启动"文件夹里的 VBS(用户自己目录,零权限——schtasks 的
// ONLOGON 是系统级触发器、要管理员,已弃用);每日兜底 = schtasks DAILY
// (按时间触发的任务普通账号可建)。全部幂等:缺啥补啥、内容漂移即重写,
// reconcile 每次运行都可安全调用——触发器从此不依赖员工重跑 setup。
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const DRYRUN = process.env.VANTAGE_TRIGGER_DRYRUN === "1"; // 测试:写文件但不执行注册命令
const SKIP = process.env.VANTAGE_SKIP_TRIGGER === "1";

// 透出 stderr 真实原因(如"拒绝访问"),不再只报含糊的 Command failed
function schtasks(argv) {
  if (DRYRUN) return "";
  try {
    return String(execFileSync("schtasks", argv, { stdio: ["ignore", "pipe", "pipe"] }));
  } catch (e) {
    const detail = String(e.stderr || "").trim() || e.message;
    throw new Error(`schtasks ${argv.join(" ")}: ${detail}`);
  }
}

// 用 wscript+VBS 隐藏窗口启动:直接跑 node.exe 会每次弹 cmd 黑窗,员工易误判为病毒。
function vbsBody(node, reconcile) {
  return `CreateObject("WScript.Shell").Run """${node}"" ""${reconcile}"" --only codex", 0, False\r\n`;
}

function startupDir() {
  const roaming = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  return path.join(roaming, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
}

// 确保"登录自启 + 每日兜底"就位。非 win32 / SKIP 直接返回。
function ensureWindowsCodexTrigger({ log = () => {} } = {}) {
  if (process.platform !== "win32" || SKIP) return;
  const baseDir = path.join(os.homedir(), ".vantage");
  const body = vbsBody(process.execPath, path.join(baseDir, "agent", "reconcile.cjs"));

  // 1) 执行体 VBS(每日兜底任务调用它)+ 2) 登录自启 VBS(启动文件夹):内容漂移即重写
  const runVbs = path.join(baseDir, "run-reconcile.vbs");
  const loginVbs = path.join(startupDir(), "vantage-codex.vbs");
  for (const [label, dst] of [
    ["每日兜底执行体", runVbs],
    ["登录自启", loginVbs],
  ]) {
    try {
      const cur = fs.existsSync(dst) ? fs.readFileSync(dst, "utf8") : "";
      if (cur !== body) {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.writeFileSync(dst, body);
        log(`✓ Codex 触发器(${label})已就位:${dst}`);
      }
    } catch (e) {
      log(`! Codex 触发器(${label})写入失败:${e.message}`);
    }
  }

  // 3) 每日正午兜底任务:存在则跳过,缺则注册(普通账号可建)
  try {
    schtasks(["/Query", "/TN", "VantageCodexDaily"]);
  } catch {
    try {
      schtasks([
        "/Create", "/TN", "VantageCodexDaily", "/SC", "DAILY", "/ST", "12:00",
        "/TR", `wscript.exe "${runVbs}"`, "/F",
      ]);
      log("✓ Codex 每日兜底任务已注册(计划任务 12:00)");
    } catch (e) {
      log(`! Codex 每日兜底任务注册失败:${e.message}`);
    }
  }

  // 4) 清理旧形态:ONLOGON(要管理员,已弃)+ 旧版每小时任务;删不掉无害(reconcile 自带节流)
  for (const tn of ["VantageCodexLogon", "VantageCodexReconcile"]) {
    try {
      schtasks(["/Delete", "/TN", tn, "/F"]);
    } catch {
      /* 不存在或无权删,均忽略 */
    }
  }
}

module.exports = { ensureWindowsCodexTrigger };
