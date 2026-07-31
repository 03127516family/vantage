#!/usr/bin/env node
"use strict";
// Vantage Windows 实机端到端验证。
// 真实检查:官方更新 -> installed_plugins.json 生效记录 -> 缓存清单 ->
//          稳定 Agent 激活/哈希 -> VBS 无弹窗 -> 计划任务可完成。
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

let pass = 0;
let fail = 0;
const ok = (condition, name, detail) => {
  condition ? pass++ : fail++;
  console.log(` ${condition ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
};
const info = (message) => console.log(`  · ${message}`);

if (process.platform !== "win32") {
  console.log("此脚本只用于 Windows 实机验证，当前不是 Windows，退出。");
  process.exit(0);
}

function vbsLexCheck(line) {
  let i = 0;
  const strings = [];
  while (i < line.length) {
    if (line[i] !== '"') {
      i++;
      continue;
    }
    let value = "";
    i++;
    for (;;) {
      if (i >= line.length) return { error: "unclosed string at end", strings };
      if (line[i] === '"') {
        if (line[i + 1] === '"') {
          value += '"';
          i += 2;
          continue;
        }
        i++;
        break;
      }
      value += line[i++];
    }
    strings.push(value);
    let j = i;
    while (j < line.length && line[j] === " ") j++;
    if (j < line.length && line[j] !== "," && line[j] !== ")") {
      return { error: `Expected end of statement at char ${j + 1}`, strings };
    }
    i = line[j] === "," ? j + 1 : j;
  }
  return { error: null, strings };
}

function decodeFile(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.slice(2).toString("utf16le");
  }
  return buffer.toString("utf8");
}

function tailText(value, lines = 4) {
  return String(value || "")
    .trim()
    .split(/\r?\n/)
    .slice(-lines)
    .join(" | ");
}

console.log("== Vantage Windows 无感自更新实机验证 ==");
const home = os.homedir();
const pluginId = "vantage@dgcrane";
const bundledManifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, ".claude-plugin", "plugin.json"), "utf8")
);
const expectedVersion = process.env.VANTAGE_EXPECT_VERSION || bundledManifest.version;
const bundledUpdater = require(path.join(__dirname, "agent", "self-update.cjs"));

function versionAtLeast(actual, expected) {
  const a = String(actual).split(".").map(Number);
  const e = String(expected).split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, e.length); i++) {
    if ((a[i] || 0) !== (e[i] || 0)) return (a[i] || 0) > (e[i] || 0);
  }
  return true;
}

// ---- 1. 更新前生效记录 ----
let before = null;
try {
  before = bundledUpdater.resolveInstalledPlugin(home, pluginId);
  ok(true, "更新前 installed_plugins.json 生效记录可解析", `${before.version} — ${before.installPath}`);
} catch (e) {
  ok(false, "更新前 installed_plugins.json 生效记录可解析", String(e.message || e));
}

// ---- 2. 真实执行官方 marketplace update + plugin update ----
info("真实执行: claude plugin marketplace update dgcrane + claude plugin update vantage@dgcrane");
const official = bundledUpdater.runOfficialUpdate({
  marketplace: "dgcrane",
  pluginId,
  platform: "win32",
  timeoutMs: 120000,
});
for (const phase of ["marketplace", "plugin"]) {
  const evidence = official.steps?.find((step) => step.phase === phase);
  ok(
    evidence?.status === 0 && !evidence?.timedOut,
    `官方 ${phase} update 成功`,
    evidence
      ? `status=${evidence.status} timeout=${evidence.timedOut ? 1 : 0} ${evidence.outputTail || ""}`
      : "该阶段未执行"
  );
}
ok(
  official.ok,
  "官方 marketplace update + plugin update 成功",
  official.ok
    ? "两步 exit=0"
    : `phase=${official.phase} status=${official.status} timeout=${official.timedOut ? 1 : 0} ${official.outputTail || ""}`
);

// ---- 3. 更新后重新读取真正生效的缓存，而不是猜最高版本目录 ----
let active = null;
let activeUpdater = null;
let core = null;
let installers = null;
try {
  active = bundledUpdater.resolveInstalledPlugin(home, pluginId);
  activeUpdater = require(path.join(active.agentDir, "self-update.cjs"));
  core = require(path.join(active.agentDir, "core.cjs"));
  installers = require(path.join(active.agentDir, "installers.cjs"));
  ok(true, "更新后安装记录、清单和必要文件一致", `${active.version} — ${active.installPath}`);
  ok(
    versionAtLeast(active.version, expectedVersion),
    `生效版本不低于随验证脚本发布的 ${expectedVersion}`,
    active.version
  );
} catch (e) {
  ok(false, "更新后安装记录、清单和必要文件一致", String(e.message || e));
}

// ---- 4. 使用生产激活逻辑同步稳定副本，并在事务内修复触发器 ----
const stableDir = path.join(home, ".vantage", "agent");
if (active && activeUpdater) {
  const lock = activeUpdater.acquireUpdateLock(home);
  if (!lock) {
    ok(false, "获取更新锁", "另一个后台更新器仍在运行，请稍后重试");
  } else {
    try {
      const activated = activeUpdater.activateInstalledAgent({
        home,
        pluginId,
        stableDir,
        afterActivate() {
          require(path.join(active.agentDir, "trigger.cjs")).ensureCodexTriggers({
            log() {},
          });
        },
      });
      ok(true, "生产激活逻辑完成", `version=${activated.version} changed=${activated.changed ? 1 : 0}`);
      const sourceDigest = activeUpdater.treeDigest(active.agentDir);
      const stableDigest = activeUpdater.treeDigest(stableDir);
      ok(
        sourceDigest === stableDigest,
        "缓存 Agent 与稳定 Agent 完整 SHA-256 摘要一致",
        `cache=${sourceDigest} stable=${stableDigest}`
      );
    } catch (e) {
      ok(false, "生产激活逻辑完成", String(e.message || e));
    } finally {
      activeUpdater.releaseUpdateLock(lock);
    }
  }
}

// ---- 5. 生产 VBS 与磁盘 VBS：词法、内容、真实运行均无弹窗 ----
if (core && installers) {
  const reconcilePath = path.join(stableDir, "reconcile.cjs");
  const expectedBody = installers.vbsBody(process.execPath, reconcilePath);
  const generatedLine = expectedBody.split("\r\n").filter(Boolean).pop() || "";
  ok(!vbsLexCheck(generatedLine).error, "生产 vbsBody 词法正确");

  for (const [label, filePath] of [
    ["每小时任务 run-reconcile.vbs", path.join(home, ".vantage", "run-reconcile.vbs")],
    [
      "登录自启 vantage-codex.vbs",
      path.join(
        process.env.APPDATA || "",
        "Microsoft",
        "Windows",
        "Start Menu",
        "Programs",
        "Startup",
        "vantage-codex.vbs"
      ),
    ],
  ]) {
    if (!fs.existsSync(filePath)) {
      ok(false, `${label} 存在`, filePath);
      continue;
    }
    const body = decodeFile(fs.readFileSync(filePath));
    const line = body.split(/\r?\n/).filter(Boolean).pop() || "";
    ok(!vbsLexCheck(line).error, `${label}: 词法正确`, vbsLexCheck(line).error);
    ok(body === expectedBody, `${label}: 内容由当前代码生成`);
    const execution = spawnSync("wscript.exe", [filePath], {
      windowsHide: true,
      timeout: 10000,
      stdio: "ignore",
    });
    ok(!execution.error, `${label}: wscript 启动未挂起`, execution.error?.message);
  }

  const marker = path.join(os.tmpdir(), `vantage-wscript-ok-${process.pid}.txt`);
  const markerVbs = path.join(os.tmpdir(), `vantage-wscript-ok-${process.pid}.vbs`);
  try {
    fs.unlinkSync(marker);
  } catch {}
  fs.writeFileSync(
    markerVbs,
    installers.vbsBuffer(core.hiddenRunVbs(`echo vantage-wscript-ok> "${marker}"`))
  );
  const markerRun = spawnSync("wscript.exe", [markerVbs], {
    windowsHide: true,
    timeout: 10000,
    stdio: "ignore",
  });
  let markerFound = false;
  for (let i = 0; i < 6 && !markerFound; i++) {
    spawnSync("cmd.exe", ["/d", "/s", "/c", "ping -n 2 127.0.0.1 >nul"], {
      windowsHide: true,
      stdio: "ignore",
    });
    markerFound = fs.existsSync(marker);
  }
  ok(!markerRun.error && markerFound, "wscript 隐藏执行全链路生成标记文件");

  const updateMarker = path.join(os.tmpdir(), `vantage-update-hidden-${process.pid}.txt`);
  try {
    fs.unlinkSync(updateMarker);
  } catch {}
  const updateSpawned = core.spawnNodeHidden(
    path.join(stableDir, "self-update.cjs"),
    ["--probe", updateMarker]
  );
  let updateMarkerFound = false;
  for (let i = 0; i < 8 && !updateMarkerFound; i++) {
    spawnSync("cmd.exe", ["/d", "/s", "/c", "ping -n 2 127.0.0.1 >nul"], {
      windowsHide: true,
      stdio: "ignore",
    });
    updateMarkerFound = fs.existsSync(updateMarker);
  }
  const productionUpdateVbs = path.join(home, ".vantage", "vantage-self-update.vbs");
  let productionVbsError = "文件不存在";
  if (fs.existsSync(productionUpdateVbs)) {
    const productionBody = decodeFile(fs.readFileSync(productionUpdateVbs));
    productionVbsError = vbsLexCheck(
      productionBody.split(/\r?\n/).filter(Boolean).pop() || ""
    ).error;
  }
  ok(
    updateSpawned && updateMarkerFound && !productionVbsError,
    "生产 spawnNodeHidden / vantage-self-update.vbs 无窗执行成功",
    productionVbsError || ""
  );
}

// ---- 6. 真实运行并查询计划任务 ----
const beforeTask = spawnSync(
  "powershell.exe",
  [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "$i=Get-ScheduledTaskInfo -TaskName 'VantageCodexHourly' -ErrorAction Stop; $i.LastRunTime.ToUniversalTime().Ticks",
  ],
  { encoding: "utf8", windowsHide: true, timeout: 15000 }
);
const beforeTicks = String(beforeTask.stdout || "").trim();
ok(
  beforeTask.status === 0 && /^\d+$/.test(beforeTicks),
  "读取计划任务运行前时间",
  tailText(beforeTask.stderr)
);
const taskRun = spawnSync("schtasks.exe", ["/Run", "/TN", "VantageCodexHourly"], {
  encoding: "utf8",
  windowsHide: true,
  timeout: 15000,
});
ok(taskRun.status === 0 && !taskRun.error, "schtasks 成功启动 VantageCodexHourly", tailText(taskRun.stderr));
const taskWaitScript = [
  "$deadline=(Get-Date).AddSeconds(30)",
  `$before=[Int64]::Parse('${beforeTicks || "0"}')`,
  "do {",
  "  $task=Get-ScheduledTask -TaskName 'VantageCodexHourly' -ErrorAction Stop",
  "  $info=Get-ScheduledTaskInfo -TaskName 'VantageCodexHourly' -ErrorAction Stop",
  "  $lastRunAdvanced=$info.LastRunTime.ToUniversalTime().Ticks -gt $before",
  "  if ($lastRunAdvanced -and [int]$task.State -ne 4) {",
  "    @{lastRunAdvanced=$lastRunAdvanced;lastTaskResult=[int]$info.LastTaskResult;lastRunTime=$info.LastRunTime;nextRunTime=$info.NextRunTime} | ConvertTo-Json -Compress",
  "    if ([int]$info.LastTaskResult -eq 0) { exit 0 } else { exit 2 }",
  "  }",
  "  Start-Sleep -Milliseconds 500",
  "} while ((Get-Date) -lt $deadline)",
  "exit 1",
].join("\r\n");
const taskWait = spawnSync(
  "powershell.exe",
  ["-NoProfile", "-NonInteractive", "-Command", taskWaitScript],
  { encoding: "utf8", windowsHide: true, timeout: 40000 }
);
let completedTask = null;
try {
  completedTask = JSON.parse(String(taskWait.stdout || "").trim());
} catch {}
ok(
  taskWait.status === 0 &&
    !taskWait.error &&
    completedTask?.lastRunAdvanced === true &&
    completedTask?.lastTaskResult === 0,
  "观察到本次计划任务启动、结束且 LastTaskResult=0",
  taskWait.error?.message || tailText(taskWait.stdout || taskWait.stderr, 6)
);
if (completedTask) info("计划任务状态: " + JSON.stringify(completedTask));

// ---- 7. 日志尾部 ----
try {
  const logText = decodeFile(fs.readFileSync(path.join(home, ".vantage", "agent.log")));
  info("agent.log 尾部:");
  for (const line of logText.trim().split(/\r?\n/).slice(-12)) info("  " + line);
} catch {
  info("agent.log 不存在");
}

console.log(`\n======== 结果: ${pass} 通过, ${fail} 失败 ========`);
console.log("请把以上全部输出复制或截图发回管理员。");
process.exit(fail ? 1 : 0);
