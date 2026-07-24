# Codex 定时扫描错过修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Codex 采集从“每天 12:00 单次扫描”升级为“每小时兜底 + macOS WatchPaths 事件触发 + Windows/Linux 错过补跑”，并确保插件升级后触发器自动刷新。

**Architecture:** 在采集端 `plugin/` 内修改触发器安装/自检逻辑（`setup.cjs`、`agent/trigger.cjs`）和扫描入口（`agent/reconcile.cjs`）。reconcile 新增 `--trigger scheduled|event` 参数与对应节流状态，避免每小时/每次写文件都空转扫目录。

**Tech Stack:** Node.js CommonJS, launchd (macOS), systemd user timer (Linux), schtasks/XML (Windows). 无外部依赖。

---

## File Structure

| File | Responsibility |
|---|---|
| `plugin/agent/reconcile.cjs` | 解析 `--trigger`，按 scheduled/event 分别节流，扫描后更新时间戳。 |
| `plugin/setup.cjs` | 安装/刷新跨平台触发器：macOS 双 plist、Linux hourly timer、Windows hourly schtasks + VBS。 |
| `plugin/agent/trigger.cjs` | reconcile 运行时自检自愈：校验触发器定义是否与期望一致，不一致则重写。 |
| `plugin/agent/core.cjs` | 可能复用 `readState/writeState`；本计划不新增辅助函数。 |

---

## Task 1: reconcile.cjs — 解析 `--trigger` 参数

**Files:**
- Modify: `plugin/agent/reconcile.cjs:151-153`

- [ ] **Step 1: Replace `parseOnly` with `parseArgs`**

```javascript
function parseArgs(argv) {
  const out = { only: null, trigger: "scheduled" };
  const onlyIdx = argv.indexOf("--only");
  if (onlyIdx >= 0 && argv[onlyIdx + 1]) out.only = argv[onlyIdx + 1];
  const triggerIdx = argv.indexOf("--trigger");
  if (triggerIdx >= 0 && argv[triggerIdx + 1]) out.trigger = argv[triggerIdx + 1];
  return out;
}
```

- [ ] **Step 2: Replace call site**

```javascript
// OLD:
// const only = parseOnly(process.argv);
// const sources = only ? SOURCES.filter((s) => s.tool === only) : SOURCES;

// NEW:
const args = parseArgs(process.argv);
const sources = args.only ? SOURCES.filter((s) => s.tool === args.only) : SOURCES;
```

- [ ] **Step 3: Commit**

```bash
git add plugin/agent/reconcile.cjs
git commit -m "refactor(reconcile): parse --trigger argument alongside --only"
```

---

## Task 2: reconcile.cjs — Codex-only 节流逻辑

**Files:**
- Modify: `plugin/agent/reconcile.cjs:16-30` (add constants), `plugin/agent/reconcile.cjs:187-198` (throttle block)

- [ ] **Step 1: Add throttle constants**

```javascript
// SessionStart 兜底扫描的节流间隔（保持不变）
const THROTTLE_MS = Number(process.env.VANTAGE_RECONCILE_INTERVAL_MIN || 30) * 60 * 1000;

// Codex 定时触发节流：默认 30 分钟
const CODEX_SCHEDULED_THROTTLE_MS = Number(process.env.VANTAGE_CODEX_SCHEDULED_INTERVAL_MIN || 30) * 60 * 1000;
// Codex 事件触发节流：默认 5 分钟（仅 macOS WatchPaths 使用）
const CODEX_EVENT_THROTTLE_MS = Number(process.env.VANTAGE_CODEX_EVENT_INTERVAL_MIN || 5) * 60 * 1000;
```

- [ ] **Step 2: Insert Codex throttle before full scan**

替换 `if (hookEvent === "SessionStart") { ... }` 块，加入 Codex-only 判断：

```javascript
// 节流：SessionStart 是高频路径，30 分钟内已全量扫过就不再空转。
// 仍触发一次 flush——若 spool 里有断网滞留的记录，网络恢复后开会话即补传，不等下轮扫描。
if (hookEvent === "SessionStart") {
  const last = Number(core.readState().__last_reconcile__ || 0);
  if (Date.now() - last < THROTTLE_MS) {
    core.log(
      `reconcile: throttled (last full scan ${Math.round((Date.now() - last) / 60000)}min ago)`
    );
    core.spawnDetached("flush.cjs");
    return;
  }
}

// Codex-only 路径的独立节流
if (args.only === "codex") {
  const state = core.readState();
  const throttleMs = args.trigger === "event" ? CODEX_EVENT_THROTTLE_MS : CODEX_SCHEDULED_THROTTLE_MS;
  const last = Number(state[`__last_codex_${args.trigger}__`] || 0);
  if (Date.now() - last < throttleMs) {
    core.log(`reconcile: codex throttled (trigger=${args.trigger}, last ${Math.round((Date.now() - last) / 60000)}min ago)`);
    core.spawnDetached("flush.cjs");
    return;
  }
}
```

- [ ] **Step 3: Update Codex scan timestamp after sweep**

```javascript
// 只有真正执行了扫描才更新对应触发源的时间戳（节流路径已 return）
if (args.only === "codex") {
  const state = core.readState();
  state[`__last_codex_${args.trigger}__`] = Date.now();
  core.writeState(state);
}

// 全量扫描的 __last_reconcile__ 仅在非 --only 时更新（保持现有逻辑）
if (!args.only) {
  const state = core.readState();
  state.__last_reconcile__ = Date.now();
  core.writeState(state);
}
```

- [ ] **Step 4: Commit**

```bash
git add plugin/agent/reconcile.cjs
git commit -m "feat(reconcile): throttle codex scheduled/event scans independently"
```

---

## Task 3: setup.cjs — macOS 双 plist 安装

**Files:**
- Modify: `plugin/setup.cjs:159-190`

- [ ] **Step 1: Rewrite `installLaunchd`**

```javascript
function writeIfChanged(filePath, body) {
  const cur = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  if (cur === body) return false;
  fs.writeFileSync(filePath, body);
  return true;
}

function installLaunchd(node, reconcile) {
  const labelBase = "com.dgcrane.vantage.codex";
  const dir = path.join(os.homedir(), "Library", "LaunchAgents");
  fs.mkdirSync(dir, { recursive: true });

  // 清理旧单 job plist
  const oldPlist = path.join(dir, `${labelBase}.plist`);
  try {
    fs.unlinkSync(oldPlist);
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

  const changed = writeIfChanged(scheduledPlist, scheduledBody) || writeIfChanged(watchPlist, watchBody);
  const domain = `gui/${process.getuid()}`;
  for (const label of [`${labelBase}.scheduled`, `${labelBase}.watch`]) {
    try {
      register("launchctl", ["bootout", `${domain}/${label}`]);
    } catch {}
    register("launchctl", ["bootstrap", domain, path.join(dir, `${label}.plist`)]);
  }
  console.log("✓ 已安装 Codex 扫描触发器（LaunchAgent：每小时 + WatchPaths，升级安全）");
}
```

- [ ] **Step 2: Commit**

```bash
git add plugin/setup.cjs
git commit -m "feat(setup): install hourly + WatchPaths launchd agents for codex"
```

---

## Task 4: setup.cjs — Linux hourly timer

**Files:**
- Modify: `plugin/setup.cjs:192-220`

- [ ] **Step 1: Rewrite `installSystemd`**

```javascript
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
  console.log("✓ 已安装 Codex 扫描触发器（systemd timer：开机 + 每小时，升级安全）");
}
```

- [ ] **Step 2: Commit**

```bash
git add plugin/setup.cjs
git commit -m "feat(setup): switch linux codex timer to hourly with Persistent=true"
```

---

## Task 5: setup.cjs — Windows hourly schtasks with StartWhenAvailable

**Files:**
- Modify: `plugin/setup.cjs:222-228` and `plugin/agent/trigger.cjs`

> Note: Windows implementation is split with `agent/trigger.cjs` because setup and reconcile share the same trigger logic.

- [ ] **Step 1: Update `installSchtasks` in setup.cjs to delegate to trigger.cjs**

```javascript
function installSchtasks() {
  // Windows 触发器逻辑收在 agent/trigger.cjs——与 reconcile 自检自愈共用同一来源
  require("./agent/trigger.cjs").ensureWindowsCodexTrigger({ log: console.log });
  console.log("✓ Codex 扫描触发器：每小时 + 错过补跑（用户级计划任务），无需管理员");
}
```

- [ ] **Step 2: Commit setup change**

```bash
git add plugin/setup.cjs
git commit -m "refactor(setup): delegate windows trigger to shared trigger.cjs"
```

---

## Task 6: trigger.cjs — Windows hourly + StartWhenAvailable

**Files:**
- Modify: `plugin/agent/trigger.cjs`

- [ ] **Step 1: Update VBS body to pass `--trigger scheduled`**

```javascript
function vbsBody(node, reconcile) {
  return `CreateObject("WScript.Shell").Run """${node}"" """${reconcile}"" --only codex --trigger scheduled", 0, False\r\n`;
}
```

- [ ] **Step 2: Change task name and schedule to hourly**

```javascript
const TASK_NAME = "VantageCodexHourly";
```

Replace the daily create block with XML-based hourly task creation:

```javascript
  try {
    schtasks(["/Query", "/TN", TASK_NAME]);
  } catch {
    const xmlPath = path.join(baseDir, "vantage-codex-hourly.xml");
    const xml = `<?xml version="1.0" encoding="UTF-16"?>
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
      // XML 创建失败时回退到命令行创建（StartWhenAvailable 可能不生效，但至少每小时会跑）
      schtasks([
        "/Create", "/TN", TASK_NAME, "/SC", "HOURLY", "/TR",
        `wscript.exe "${runVbs}"`, "/F",
      ]);
      log("! Codex XML 任务创建失败，已回退到每小时命令行任务：" + e.message);
    }
  }
```

- [ ] **Step 3: Clean up old daily task name**

```javascript
  // 清理旧形态：daily 任务、旧版每小时任务、ONLOGON 任务
  for (const tn of ["VantageCodexDaily", "VantageCodexLogon", "VantageCodexReconcile"]) {
    try {
      schtasks(["/Delete", "/TN", tn, "/F"]);
    } catch {
      /* 不存在或无权删，均忽略 */
    }
  }
```

- [ ] **Step 4: Commit**

```bash
git add plugin/agent/trigger.cjs
git commit -m "feat(trigger): windows codex trigger runs hourly with StartWhenAvailable"
```

---

## Task 7: trigger.cjs — macOS self-healing

**Files:**
- Modify: `plugin/agent/trigger.cjs`

- [ ] **Step 1: Add macOS trigger self-healing function**

```javascript
function ensureMacosCodexTrigger({ log = () => {} } = {}) {
  if (process.platform !== "darwin") return;
  const baseDir = path.join(os.homedir(), ".vantage");
  const reconcile = path.join(baseDir, "agent", "reconcile.cjs");
  const labelBase = "com.dgcrane.vantage.codex";
  const dir = path.join(os.homedir(), "Library", "LaunchAgents");

  const scheduledPlist = path.join(dir, `${labelBase}.scheduled.plist`);
  const watchPlist = path.join(dir, `${labelBase}.watch.plist`);

  // 如果新形态已存在且内容正确，跳过
  if (
    fs.existsSync(scheduledPlist) &&
    fs.existsSync(watchPlist)
  ) {
    // 简单校验：包含 --trigger scheduled/event
    const s = fs.readFileSync(scheduledPlist, "utf8");
    const w = fs.readFileSync(watchPlist, "utf8");
    if (s.includes("--trigger scheduled") && w.includes("--trigger event")) return;
  }

  try {
    require("../setup.cjs"); // setup.cjs 的 installLaunchd 已无法单独导出，此处需要重构
  } catch (e) {
    log(`! macOS Codex 触发器自检失败：${e.message}`);
  }
}
```

> ⚠️ 上述代码依赖 `setup.cjs` 导出 `installLaunchd`。需要 Task 8 先重构 setup.cjs 导出安装函数。

---

## Task 8: setup.cjs — export reusable install functions

**Files:**
- Modify: `plugin/setup.cjs`

- [ ] **Step 1: Export install functions**

在 `setup.cjs` 底部添加：

```javascript
module.exports = {
  installLaunchd,
  installSystemd,
  installSchtasks,
};
```

- [ ] **Step 2: Update trigger.cjs macOS self-healing to call exported function**

```javascript
const setup = require("../setup.cjs");

function ensureMacosCodexTrigger({ log = () => {} } = {}) {
  if (process.platform !== "darwin") return;
  const baseDir = path.join(os.homedir(), ".vantage");
  const reconcile = path.join(baseDir, "agent", "reconcile.cjs");
  const labelBase = "com.dgcrane.vantage.codex";
  const dir = path.join(os.homedir(), "Library", "LaunchAgents");

  const scheduledPlist = path.join(dir, `${labelBase}.scheduled.plist`);
  const watchPlist = path.join(dir, `${labelBase}.watch.plist`);

  if (fs.existsSync(scheduledPlist) && fs.existsSync(watchPlist)) {
    const s = fs.readFileSync(scheduledPlist, "utf8");
    const w = fs.readFileSync(watchPlist, "utf8");
    if (s.includes("--trigger scheduled") && w.includes("--trigger event")) return;
  }

  try {
    setup.installLaunchd(process.execPath, reconcile);
    log("✓ macOS Codex 触发器已自检修复");
  } catch (e) {
    log(`! macOS Codex 触发器自检失败：${e.message}`);
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add plugin/setup.cjs plugin/agent/trigger.cjs
git commit -m "refactor(setup,trigger): export install functions for self-healing"
```

---

## Task 9: trigger.cjs — Linux self-healing

**Files:**
- Modify: `plugin/agent/trigger.cjs`

- [ ] **Step 1: Add Linux self-healing**

```javascript
function ensureLinuxCodexTrigger({ log = () => {} } = {}) {
  if (process.platform !== "linux") return;
  const timerPath = path.join(os.homedir(), ".config", "systemd", "user", "vantage-codex.timer");
  if (fs.existsSync(timerPath)) {
    const cur = fs.readFileSync(timerPath, "utf8");
    if (cur.includes("OnCalendar=*-*-* *:00:00") && cur.includes("Persistent=true")) return;
  }
  try {
    const setup = require("../setup.cjs");
    setup.installSystemd(process.execPath, path.join(os.homedir(), ".vantage", "agent", "reconcile.cjs"));
    log("✓ Linux Codex 触发器已自检修复");
  } catch (e) {
    log(`! Linux Codex 触发器自检失败：${e.message}`);
  }
}
```

- [ ] **Step 2: Wire all platform self-healing into `ensureCodexTriggers`**

```javascript
function ensureCodexTriggers(opts = {}) {
  ensureWindowsCodexTrigger(opts);
  ensureMacosCodexTrigger(opts);
  ensureLinuxCodexTrigger(opts);
}

module.exports = { ensureCodexTriggers, ensureWindowsCodexTrigger };
```

- [ ] **Step 3: Update reconcile.cjs to call new entry point**

```javascript
// OLD:
// require("./trigger.cjs").ensureWindowsCodexTrigger({ log: core.log });

// NEW:
require("./trigger.cjs").ensureCodexTriggers({ log: core.log });
```

- [ ] **Step 4: Commit**

```bash
git add plugin/agent/trigger.cjs plugin/agent/reconcile.cjs
git commit -m "feat(trigger): add macos/linux self-healing for codex triggers"
```

---

## Task 10: 手动测试

**Files:** None (manual verification)

- [ ] **Step 1: macOS**

```bash
# 1. 安装/刷新触发器
node plugin/setup.cjs "测试名" "测试部"

# 2. 检查两个 plist
ls ~/Library/LaunchAgents/com.dgcrane.vantage.codex.*.plist

# 3. 检查旧 plist 已删除
test ! -f ~/Library/LaunchAgents/com.dgcrane.vantage.codex.plist

# 4. 手动触发 reconcile 并观察日志
node ~/.vantage/agent/reconcile.cjs --only codex --trigger scheduled
tail -5 ~/.vantage/agent.log
```

- [ ] **Step 2: macOS 节流测试**

```bash
node ~/.vantage/agent/reconcile.cjs --only codex --trigger scheduled
tail -3 ~/.vantage/agent.log
# 应该看到 "reconcile: found ... spooled ..."

node ~/.vantage/agent/reconcile.cjs --only codex --trigger scheduled
tail -3 ~/.vantage/agent.log
# 应该看到 "reconcile: codex throttled (trigger=scheduled ...)"
```

- [ ] **Step 3: macOS WatchPaths 测试**

```bash
# 复制一个真实或测试用的 rollout 文件到 ~/.codex/sessions/年/月/日/
mkdir -p ~/.codex/sessions/2026/07/24
cp /path/to/test-rollout.jsonl ~/.codex/sessions/2026/07/24/rollout-test.jsonl

# 5 分钟内应该触发事件 reconcile
tail -20 ~/.vantage/agent.log
```

- [ ] **Step 4: Windows**

在 Windows PowerShell：

```powershell
node plugin/setup.cjs "测试名" "测试部"
schtasks /Query /TN VantageCodexHourly /XML | Select-String "StartWhenAvailable"
# 应看到 <StartWhenAvailable>true</StartWhenAvailable>
schtasks /Query /TN VantageCodexDaily
# 应报错“任务不存在”
```

- [ ] **Step 5: Linux**

```bash
node plugin/setup.cjs "测试名" "测试部"
systemctl --user cat vantage-codex.timer | grep -E "OnCalendar|Persistent"
# 应看到 OnCalendar=*-*-* *:00:00 和 Persistent=true
```

---

## Self-Review Checklist

- [x] Spec coverage: 每小时兜底、macOS WatchPaths、Windows StartWhenAvailable、Linux Persistent、reconcile 节流、setup + 自检自愈均已覆盖。
- [x] Placeholder scan: 无 TBD/TODO，所有步骤含具体代码或命令。
- [x] Type consistency: 状态字段统一使用 `__last_codex_scheduled__` 和 `__last_codex_event__`；`parseArgs` 返回 `{ only, trigger }`。
- [x] Backwards compatibility: 无 `--trigger` 参数时默认 `scheduled`；旧单 plist 会被清理。

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-24-codex-missed-trigger-implementation.md`. Two execution options:

1. **Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach do you want?
