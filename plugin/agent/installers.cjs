"use strict";
// Vantage —— 跨平台 Codex 触发器安装函数。
// 被 setup.cjs 和 agent/trigger.cjs 共用；本文件不含 setup 主流程，require 不会触发安装。
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const TRIGGER_DRYRUN = process.env.VANTAGE_TRIGGER_DRYRUN === "1";

function register(cmd, argv) {
  if (TRIGGER_DRYRUN) return;
  try {
    execFileSync(cmd, argv, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  } catch (e) {
    const detail = String(e.stderr || "").trim() || e.message;
    throw new Error(`${cmd} ${argv.join(" ")}: ${detail}`);
  }
}

// 用 wscript+VBS 隐藏窗口启动:直接跑 node.exe 会每次弹 cmd 黑窗,员工易误判为病毒。
// VBS 字符串内 `"` 要写成 `""`;整行引号必须配平(开1 + 偶数转义 + 合1 = 偶数个)——
// 若 reconcile 前误写 3 个引号(共奇数),字符串提前闭合,wscript 弹 800A0401 编译错误框。
// On Error Resume Next:node 被杀软误删/路径失效时静默退出,绝不弹 wscript 运行时错误框(员工无感铁律)。
function vbsBody(node, reconcile) {
  return (
    "On Error Resume Next\r\n" +
    `CreateObject("WScript.Shell").Run """${node}"" ""${reconcile}"" --only codex --trigger scheduled", 0, False\r\n`
  );
}

// UTF-16/UTF-8 字节序标记。不用 "﻿" 字面量:源码里的隐形字符易被编辑器/格式化工具剥掉。
const BOM = String.fromCharCode(0xfeff);

// WSH 对无 BOM 的 .vbs 按系统 ANSI 代码页读取:若用户名含非 ASCII(如中文名),
// UTF-8 写入的路径会乱码、.Run 直接失败。UTF-16LE + BOM 是 WSH 官方支持的脚本编码,任何用户名都安全。
function vbsBuffer(body) {
  return Buffer.from(BOM + body, "utf16le");
}

// 按字节对比写入,避免每小时自检时因编码不同误判"内容变了"而重复重写
function writeVbsIfChanged(filePath, body) {
  const next = vbsBuffer(body);
  try {
    if (fs.readFileSync(filePath).equals(next)) return false;
  } catch {
    /* 不存在或读失败,走写入 */
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, next);
  return true;
}

// schtasks 等 Windows 命令管道输出常为 UTF-16LE(/Query /XML 尤其如此),
// 直接 String(buf) 按 UTF-8 解码会得到带 NUL 的乱码,includes() 判断全失效。
// 按 BOM / 隔字节 NUL 嗅探解码,三种形态(utf16le+BOM / 裸 utf16le / utf8)都正确。
function decodeConsoleOutput(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), "utf8");
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return b.slice(2).toString("utf16le");
  // 裸 UTF-16LE:ASCII 为主的内容隔字节为 0x00
  const n = Math.min(b.length, 200);
  if (n > 10) {
    let nul = 0;
    for (let i = 1; i < n; i += 2) if (b[i] === 0) nul++;
    if (nul > n / 4) return b.toString("utf16le");
  }
  const s = b.toString("utf8");
  // 中文 Windows 的本地化输出(如 schtasks 错误)是 GBK:UTF-8 解码出替换符时回退 GBK
  if (s.includes("�")) {
    try {
      return new TextDecoder("gbk").decode(b);
    } catch {
      /* 无 ICU 则用原样 */
    }
  }
  return s;
}

function startupDir() {
  const roaming = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  return path.join(roaming, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
}

// 透出 stderr 真实原因(如"拒绝访问"),不再只报含糊的 Command failed
function schtasks(argv) {
  if (TRIGGER_DRYRUN) return "";
  try {
    const out = execFileSync("schtasks", argv, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    return decodeConsoleOutput(out);
  } catch (e) {
    const detail = decodeConsoleOutput(e.stderr || Buffer.alloc(0)).trim() || e.message;
    throw new Error(`schtasks ${argv.join(" ")}: ${detail}`);
  }
}

function writeIfChanged(filePath, body) {
  const cur = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  if (cur === body) return false;
  fs.writeFileSync(filePath, body);
  return true;
}

// macOS: 登录自启 + 每小时定时 + WatchPaths 监听 ~/.codex/sessions
function installLaunchd(node, reconcile) {
  const labelBase = "com.dgcrane.vantage.codex";
  const dir = path.join(os.homedir(), "Library", "LaunchAgents");
  const domain = `gui/${process.getuid()}`;
  fs.mkdirSync(dir, { recursive: true });

  // 清理旧单 job plist 并 unload（如果旧任务正加载，只删文件不会停止）
  const oldPlist = path.join(dir, `${labelBase}.plist`);
  try {
    fs.unlinkSync(oldPlist);
  } catch {}
  try {
    register("launchctl", ["bootout", `${domain}/${labelBase}`]);
  } catch {}

  const scheduledPlist = path.join(dir, `${labelBase}.scheduled.plist`);
  const watchPlist = path.join(dir, `${labelBase}.watch.plist`);

  const scheduledBody = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${labelBase}.scheduled</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${reconcile}</string>
    <string>--only</string><string>codex</string>
    <string>--trigger</string><string>scheduled</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StartCalendarInterval</key>
  <dict><key>Minute</key><integer>0</integer></dict>
</dict></plist>
`;

  const watchBody = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${labelBase}.watch</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${reconcile}</string>
    <string>--only</string><string>codex</string>
    <string>--trigger</string><string>event</string>
  </array>
  <key>WatchPaths</key>
  <array><string>${path.join(os.homedir(), ".codex", "sessions")}</string></array>
  <key>ThrottleInterval</key><integer>300</integer>
</dict></plist>
`;

  writeIfChanged(scheduledPlist, scheduledBody);
  writeIfChanged(watchPlist, watchBody);

  for (const label of [`${labelBase}.scheduled`, `${labelBase}.watch`]) {
    try {
      register("launchctl", ["bootout", `${domain}/${label}`]);
    } catch {}
    register("launchctl", ["bootstrap", domain, path.join(dir, `${label}.plist`)]);
  }
}

// Linux: systemd user timer，开机 + 每小时，Persistent=true 错过补跑
function installSystemd(node, reconcile) {
  const dir = path.join(os.homedir(), ".config", "systemd", "user");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "vantage-codex.service"),
    `[Unit]
Description=Vantage - Codex 会话扫描采集
[Service]
Type=oneshot
ExecStart="${node}" "${reconcile}" --only codex --trigger scheduled
`
  );
  fs.writeFileSync(
    path.join(dir, "vantage-codex.timer"),
    `[Unit]
Description=Vantage - 开机及每小时扫描 Codex 会话
[Timer]
OnBootSec=2min
OnCalendar=*-*-* *:00:00
Persistent=true
[Install]
WantedBy=timers.target
`
  );
  register("systemctl", ["--user", "daemon-reload"]);
  register("systemctl", ["--user", "enable", "--now", "vantage-codex.timer"]);
}

// 每小时计划任务的 XML(纯函数,便于单测 well-formed 与编码)。
// 声明 encoding="UTF-16":文件以 UTF-16LE+BOM 落盘,声明与实际一致。
function hourlyTaskXml(runVbs) {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Vantage - Codex 每小时扫描采集</Description></RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>2026-01-01T00:00:00</StartBoundary>
      <ScheduleByHour><HoursInterval>1</HoursInterval></ScheduleByHour>
    </CalendarTrigger>
  </Triggers>
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd></IdleSettings>
    <Hidden>true</Hidden>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>wscript.exe</Command>
      <Arguments>"${runVbs}"</Arguments>
    </Exec>
  </Actions>
</Task>`;
}

// Windows: 登录自启(启动文件夹 VBS) + 每小时计划任务(StartWhenAvailable 错过补跑)
function installWindowsCodexTrigger({ log = () => {} } = {}) {
  if (process.platform !== "win32" || process.env.VANTAGE_SKIP_TRIGGER === "1") return;
  const baseDir = path.join(os.homedir(), ".vantage");
  fs.mkdirSync(baseDir, { recursive: true });
  const body = vbsBody(process.execPath, path.join(baseDir, "agent", "reconcile.cjs"));

  const runVbs = path.join(baseDir, "run-reconcile.vbs");
  const loginVbs = path.join(startupDir(), "vantage-codex.vbs");
  for (const [label, dst] of [
    ["每小时执行体", runVbs],
    ["登录自启", loginVbs],
  ]) {
    try {
      if (writeVbsIfChanged(dst, body)) {
        log(`✓ Codex 触发器(${label})已就位:${dst}`);
      }
    } catch (e) {
      log(`! Codex 触发器(${label})写入失败:${e.message}`);
    }
  }

  const TASK_NAME = "VantageCodexHourly";
  let needsCreate = false;
  try {
    const info = schtasks(["/Query", "/TN", TASK_NAME, "/XML"]);
    // 如果任务已存在但内容不是 hourly + StartWhenAvailable，删除重建
    if (!info.includes("<ScheduleByHour>") || !info.includes("<StartWhenAvailable>true</StartWhenAvailable>")) {
      schtasks(["/Delete", "/TN", TASK_NAME, "/F"]);
      needsCreate = true;
    }
  } catch {
    needsCreate = true;
  }

  if (needsCreate) {
    const xmlPath = path.join(baseDir, "vantage-codex-hourly.xml");
    fs.writeFileSync(xmlPath, Buffer.from(BOM + hourlyTaskXml(runVbs), "utf16le"));
    try {
      schtasks(["/Create", "/TN", TASK_NAME, "/XML", xmlPath, "/F"]);
      log("✓ Codex 每小时兜底任务已注册（计划任务，错过补跑）");
    } catch (e) {
      // UTF-16 仍失败时回退到 CLI；CLI 无法直接设置 StartWhenAvailable，
      // 因此先创建再删除、用导出的 XML 改 Settings 后重建。
      schtasks([
        "/Create", "/TN", TASK_NAME, "/SC", "HOURLY", "/TR",
        `wscript.exe "${runVbs}"`, "/F",
      ]);
      try {
        const exported = schtasks(["/Query", "/TN", TASK_NAME, "/XML"]);
        const patched = exported.replace(
          "<Settings>",
          "<Settings>\n    <StartWhenAvailable>true</StartWhenAvailable>\n    <Hidden>true</Hidden>"
        );
        fs.writeFileSync(xmlPath, Buffer.from(BOM + patched, "utf16le"));
        schtasks(["/Delete", "/TN", TASK_NAME, "/F"]);
        schtasks(["/Create", "/TN", TASK_NAME, "/XML", xmlPath, "/F"]);
        log("✓ Codex CLI 任务已重建为 XML（含 StartWhenAvailable）");
      } catch (e2) {
        log("! Codex XML 任务创建失败，已回退到每小时命令行任务：" + e.message);
        log("! 无法保证 StartWhenAvailable，建议手动检查：" + e2.message);
      }
    }
  }

  // 清理旧形态：daily 任务、旧版每小时任务、ONLOGON 任务
  for (const tn of ["VantageCodexDaily", "VantageCodexLogon", "VantageCodexReconcile"]) {
    try {
      schtasks(["/Delete", "/TN", tn, "/F"]);
    } catch {
      /* 不存在或无权删，均忽略 */
    }
  }
}

module.exports = {
  installLaunchd,
  installSystemd,
  installWindowsCodexTrigger,
  // 纯函数导出,供测试断言(不进生产路径)
  vbsBody,
  vbsBuffer,
  writeVbsIfChanged,
  decodeConsoleOutput,
  hourlyTaskXml,
};
