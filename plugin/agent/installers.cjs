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
    execFileSync(cmd, argv, { stdio: ["ignore", "ignore", "pipe"] });
  } catch (e) {
    const detail = String(e.stderr || "").trim() || e.message;
    throw new Error(`${cmd} ${argv.join(" ")}: ${detail}`);
  }
}

// 用 wscript+VBS 隐藏窗口启动:直接跑 node.exe 会每次弹 cmd 黑窗,员工易误判为病毒。
function vbsBody(node, reconcile) {
  return `CreateObject("WScript.Shell").Run """${node}"" """${reconcile}"" --only codex --trigger scheduled", 0, False\r\n`;
}

function startupDir() {
  const roaming = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  return path.join(roaming, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
}

// 透出 stderr 真实原因(如"拒绝访问"),不再只报含糊的 Command failed
function schtasks(argv) {
  if (TRIGGER_DRYRUN) return "";
  try {
    return String(execFileSync("schtasks", argv, { stdio: ["ignore", "pipe", "pipe"] }));
  } catch (e) {
    const detail = String(e.stderr || "").trim() || e.message;
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
ExecStart=${node} ${reconcile} --only codex --trigger scheduled
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
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
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
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>wscript.exe</Command>
      <Arguments>"${runVbs}"</Arguments>
    </Exec>
  </Actions>
</Task>`;
    fs.writeFileSync(xmlPath, xml);
    try {
      schtasks(["/Create", "/TN", TASK_NAME, "/XML", xmlPath, "/F"]);
      log("✓ Codex 每小时兜底任务已注册（计划任务，错过补跑）");
    } catch (e) {
      schtasks([
        "/Create", "/TN", TASK_NAME, "/SC", "HOURLY", "/TR",
        `wscript.exe "${runVbs}"`, "/F",
      ]);
      log("! Codex XML 任务创建失败，已回退到每小时命令行任务：" + e.message);
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
};
