# Windows Hourly Task Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `VantageCodexHourly` from deleting and recreating itself when Windows exports an hourly schedule as `PT1H` repetition XML.

**Architecture:** Add one pure XML validator to `installers.cjs` and make the Windows trigger installer use it for its keep-or-rebuild decision. The validator accepts both the preferred `ScheduleByHour` representation and Windows' fallback `Repetition/Interval=PT1H` representation while continuing to require catch-up behavior and the expected WScript action.

**Tech Stack:** Node.js CommonJS, built-in `node:fs`/`node:path`, the existing custom Node test runner, Windows Task Scheduler XML.

---

### Task 1: Add failing hourly-task XML regression tests

**Files:**
- Modify: `tests/agent.test.cjs`

- [ ] **Step 1: Add focused tests for the desired validator API**

Add a new section after the existing task XML generation tests:

```javascript
section("3b. Windows 每小时任务 XML 校验:ScheduleByHour / PT1H");
{
  const runVbs = "C:\\Users\\Xin Cheng\\.vantage\\run-reconcile.vbs";
  const preferred = installers.hourlyTaskXml(runVbs);
  ok(
    installers.isValidHourlyTaskXml(preferred, runVbs),
    "首选 ScheduleByHour XML 有效"
  );

  const exported = `<?xml version="1.0" encoding="UTF-16"?>
<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>2026-07-30T18:30:00</StartBoundary>
      <Repetition>
        <Interval>PT1H</Interval>
      </Repetition>
    </CalendarTrigger>
  </Triggers>
  <Settings><StartWhenAvailable>true</StartWhenAvailable></Settings>
  <Actions><Exec><Command>wscript.exe</Command><Arguments>"${runVbs}"</Arguments></Exec></Actions>
</Task>`;
  ok(
    installers.isValidHourlyTaskXml(exported, runVbs),
    "Windows 导出的 PT1H XML 有效"
  );

  const prefixed = exported
    .replaceAll("<Task", "<t:Task")
    .replaceAll("</Task>", "</t:Task>")
    .replaceAll("<Repetition>", "<t:Repetition>")
    .replaceAll("</Repetition>", "</t:Repetition>")
    .replaceAll("<Interval>", "<t:Interval>")
    .replaceAll("</Interval>", "</t:Interval>")
    .replaceAll("<StartWhenAvailable>", "<t:StartWhenAvailable>")
    .replaceAll("</StartWhenAvailable>", "</t:StartWhenAvailable>")
    .replaceAll("<Command>", "<t:Command>")
    .replaceAll("</Command>", "</t:Command>")
    .replaceAll("<Arguments>", "<t:Arguments>")
    .replaceAll("</Arguments>", "</t:Arguments>");
  ok(
    installers.isValidHourlyTaskXml(prefixed, runVbs),
    "命名空间前缀和空白不影响 PT1H 校验"
  );

  ok(
    !installers.isValidHourlyTaskXml(exported.replace("PT1H", "PT30M"), runVbs),
    "拒绝 PT30M"
  );
  ok(
    !installers.isValidHourlyTaskXml(exported.replace("PT1H", "PT2H"), runVbs),
    "拒绝 PT2H"
  );
  ok(
    !installers.isValidHourlyTaskXml(exported.replace("true", "false"), runVbs),
    "拒绝未启用 StartWhenAvailable"
  );
  ok(
    !installers.isValidHourlyTaskXml(exported.replace("wscript.exe", "cscript.exe"), runVbs),
    "拒绝错误执行程序"
  );
  ok(
    !installers.isValidHourlyTaskXml(
      exported.replace("run-reconcile.vbs", "other.vbs"),
      runVbs
    ),
    "拒绝错误 VBS 路径"
  );
}
```

- [ ] **Step 2: Run the suite and verify RED**

Run:

```bash
node tests/agent.test.cjs
```

Expected: the new section fails because `installers.isValidHourlyTaskXml` is not defined. Existing sections should still run without unrelated failures.

- [ ] **Step 3: Commit the failing regression test**

```bash
git add tests/agent.test.cjs
git commit -m "test(plugin): reproduce Windows PT1H task rebuild loop"
```

### Task 2: Implement and integrate the task XML validator

**Files:**
- Modify: `plugin/agent/installers.cjs`
- Test: `tests/agent.test.cjs`

- [ ] **Step 1: Add the minimal pure validator**

Add after `hourlyTaskXml`:

```javascript
function hasXmlElement(xml, name, valuePattern) {
  const tag = `(?:[A-Za-z_][\\w.-]*:)?${name}`;
  return new RegExp(
    `<${tag}\\b[^>]*>\\s*${valuePattern}\\s*</${tag}\\s*>`,
    "i"
  ).test(xml);
}

function isValidHourlyTaskXml(xml, runVbs) {
  const text = String(xml || "");
  const scheduleByHour = /<(?:[A-Za-z_][\w.-]*:)?ScheduleByHour\b/i.test(text);
  const repetition = /<(?:[A-Za-z_][\w.-]*:)?Repetition\b[\s\S]*?<(?:[A-Za-z_][\w.-]*:)?Interval\b[^>]*>\s*PT1H\s*<\/(?:[A-Za-z_][\w.-]*:)?Interval\s*>[\s\S]*?<\/(?:[A-Za-z_][\w.-]*:)?Repetition\s*>/i.test(text);
  const startWhenAvailable = hasXmlElement(text, "StartWhenAvailable", "true");
  const wscript = hasXmlElement(text, "Command", "(?:[^<]*\\\\)?wscript(?:\\.exe)?");
  const expectedVbs = String(runVbs || "").toLowerCase();
  return (
    (scheduleByHour || repetition) &&
    startWhenAvailable &&
    wscript &&
    expectedVbs.length > 0 &&
    text.toLowerCase().includes(expectedVbs)
  );
}
```

- [ ] **Step 2: Replace the brittle inline check**

Change:

```javascript
if (!info.includes("<ScheduleByHour>") || !info.includes("<StartWhenAvailable>true</StartWhenAvailable>")) {
```

to:

```javascript
if (!isValidHourlyTaskXml(info, runVbs)) {
```

- [ ] **Step 3: Export the validator for tests**

Add `isValidHourlyTaskXml` to `module.exports`.

- [ ] **Step 4: Run the suite and verify GREEN**

Run:

```bash
node tests/agent.test.cjs
```

Expected: all tests pass, including both `ScheduleByHour` and `PT1H` cases.

- [ ] **Step 5: Run syntax and whitespace validation**

Run:

```bash
node --check plugin/agent/installers.cjs
node --check tests/agent.test.cjs
git diff --check
```

Expected: every command exits `0` with no output.

- [ ] **Step 6: Commit the implementation**

```bash
git add plugin/agent/installers.cjs
git commit -m "fix(plugin): accept Windows PT1H hourly task XML"
```

### Task 3: Release the fix as a new plugin version

**Files:**
- Modify: `plugin/.claude-plugin/plugin.json`
- Modify: `plugin/win-verify.cjs`

- [ ] **Step 1: Bump the plugin version**

Change the manifest version from `1.4.12` to `1.4.13`. This is required because Claude Code uses the manifest version as the update cache key.

- [ ] **Step 2: Update verifier guidance**

Change verifier text that says `1.4.12+` to `1.4.13+` where it refers to the version containing the completed Windows validation fix.

- [ ] **Step 3: Run release validation**

Run:

```bash
node --check plugin/win-verify.cjs
node tests/agent.test.cjs
git diff --check
git status --short
```

Expected: the full suite passes, syntax checks exit `0`, and only the intended manifest/verifier changes remain uncommitted.

- [ ] **Step 4: Commit the version bump**

```bash
git add plugin/.claude-plugin/plugin.json plugin/win-verify.cjs
git commit -m "chore(plugin): release Windows task validation fix as 1.4.13"
```

### Task 4: Verify the original Windows symptom

**Files:**
- No source changes

- [ ] **Step 1: Run the full local verification again**

Run:

```bash
node tests/agent.test.cjs
git diff --check
git status --short
```

Expected: all tests pass, no whitespace errors, and the worktree is clean.

- [ ] **Step 2: Verify on Windows after updating to 1.4.13**

Run the shipped verifier:

```bat
node "%USERPROFILE%\.claude\plugins\cache\dgcrane\vantage\1.4.13\win-verify.cjs"
```

Then run the task twice:

```bat
schtasks /Run /TN "VantageCodexHourly"
timeout /t 15 /nobreak
schtasks /Run /TN "VantageCodexHourly"
timeout /t 15 /nobreak
schtasks /Query /TN "VantageCodexHourly" /V /FO LIST
```

Expected:

- no Windows Script Host dialog;
- no new console window;
- no new “任务已重建” entry after the first valid task exists;
- `Last Run Time` is current;
- `Last Result` is `0`.
