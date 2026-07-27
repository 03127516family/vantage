#!/usr/bin/env node
"use strict";
// Vantage plugin/agent/installers.cjs 单元测试
// 重点覆盖跨平台触发器安装/卸载的边界情况。
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert");
const Module = require("node:module");

const ROOT = path.join(__dirname, "..");
const INSTALLERS_PATH = path.join(ROOT, "plugin/agent/installers.cjs");
const CORE_PATH = path.join(ROOT, "plugin/agent/core.cjs");

function tmpHome() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vantage-plugin-test-"));
  return path.join(base, "home with spaces"); // 故意带空格，验证引号
}

function withHomedir(home, fn) {
  const original = os.homedir;
  os.homedir = () => home;
  try {
    return fn();
  } finally {
    os.homedir = original;
  }
}

function withPlatform(platform, fn) {
  const desc = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return fn();
  } finally {
    if (desc) Object.defineProperty(process, "platform", desc);
    else delete process.platform;
  }
}

function withDryRun(fn) {
  const prev = process.env.VANTAGE_TRIGGER_DRYRUN;
  process.env.VANTAGE_TRIGGER_DRYRUN = "1";
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.VANTAGE_TRIGGER_DRYRUN;
    else process.env.VANTAGE_TRIGGER_DRYRUN = prev;
  }
}

function clearInstallersCache() {
  delete require.cache[INSTALLERS_PATH];
}

function clearCoreCache() {
  delete require.cache[CORE_PATH];
}

function interceptBuiltin(requests, fn) {
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (requests[request]) {
      return requests[request];
    }
    return originalLoad.apply(this, arguments);
  };
  try {
    return fn();
  } finally {
    Module._load = originalLoad;
  }
}

// ---------------------------------------------------------------------------
// T1: Linux systemd service 中 ExecStart 路径必须带引号
// ---------------------------------------------------------------------------
function testSystemdExecStartQuotes() {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, ".config", "systemd", "user"), { recursive: true });

  clearInstallersCache();
  process.env.VANTAGE_TRIGGER_DRYRUN = "1"; // 模块加载前设置，让 register() 跳过
  const { installSystemd } = require(INSTALLERS_PATH);
  delete process.env.VANTAGE_TRIGGER_DRYRUN;

  withHomedir(home, () => {
    installSystemd("/path with spaces/node", "/path with spaces/reconcile.cjs");
  });

  const servicePath = path.join(home, ".config", "systemd", "user", "vantage-codex.service");
  const service = fs.readFileSync(servicePath, "utf8");
  const execStartLine = service.split("\n").find((l) => l.startsWith("ExecStart="));

  assert(
    execStartLine === 'ExecStart="/path with spaces/node" "/path with spaces/reconcile.cjs" --only codex --trigger scheduled',
    `systemd ExecStart 未正确引号包裹: ${execStartLine}`
  );

  fs.rmSync(path.dirname(home), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// T2: Windows 安装器在 XML 初次导入失败时，必须通过导出-修改-重建启用 StartWhenAvailable
// ---------------------------------------------------------------------------
function testWindowsFallbackSetsStartWhenAvailable() {
  const calls = [];
  const mockChildProcess = {
    execFileSync: (cmd, args, opts) => {
      calls.push([cmd, args.join(" ")]);
      if (cmd === "schtasks") {
        if (args.includes("/Query")) {
          return `<?xml version="1.0" encoding="UTF-16"?><Task><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy></Settings><Actions><Exec><Command>wscript.exe</Command></Exec></Actions></Task>`;
        }
        if (args.includes("/Create") && args.includes("/XML")) {
          // 第一次 XML 创建失败，触发 fallback
          throw new Error("XML import simulated failure");
        }
        if (args.includes("/Create") && args.includes("/SC HOURLY")) return "";
        if (args.includes("/Delete")) return "";
      }
      return "";
    },
  };

  const home = tmpHome();
  fs.mkdirSync(path.join(home, ".vantage"), { recursive: true });

  clearInstallersCache();
  let installWindowsCodexTrigger;
  interceptBuiltin({ "node:child_process": mockChildProcess, child_process: mockChildProcess }, () => {
    ({ installWindowsCodexTrigger } = require(INSTALLERS_PATH));
  });

  withHomedir(home, () => {
    withPlatform("win32", () => {
      installWindowsCodexTrigger();
    });
  });

  const createCalls = calls.filter((c) => c[0] === "schtasks" && c[1].includes("/Create"));
  const xmlCreateCalls = createCalls.filter((c) => c[1].includes("/XML"));

  assert(xmlCreateCalls.length >= 2, "XML 失败后应至少两次尝试 /Create /XML（初次失败 + 重建）");

  // 最终重建用的 XML 文件内容里必须包含 StartWhenAvailable
  const xmlPath = path.join(home, ".vantage", "vantage-codex-hourly.xml");
  assert(fs.existsSync(xmlPath), `最终 XML 文件应存在: ${xmlPath}`);
  const xmlContent = fs.readFileSync(xmlPath, "utf16le");
  assert(
    xmlContent.includes("<StartWhenAvailable>true</StartWhenAvailable>"),
    `最终 XML 应包含 StartWhenAvailable=true，实际内容: ${xmlContent.slice(0, 200)}`
  );

  fs.rmSync(path.dirname(home), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// T3: 分离式 shell 命令在 Windows 上应使用 cmd.exe /c，而不是 sh -c
// ---------------------------------------------------------------------------
function testSpawnShellDetachedOnWindows() {
  const calls = [];
  const mockChildProcess = {
    spawn: (cmd, args, opts) => {
      calls.push([cmd, args]);
      return { unref: () => {} };
    },
  };

  clearCoreCache();
  let core;
  interceptBuiltin({ "node:child_process": mockChildProcess, child_process: mockChildProcess }, () => {
    core = require(CORE_PATH);
  });

  withPlatform("win32", () => {
    core.spawnShellDetached("echo hello");
  });

  assert(
    calls.length === 1 && calls[0][0] === "cmd.exe" && calls[0][1][0] === "/c",
    `Windows 下 spawnShellDetached 应使用 cmd.exe /c，实际: ${JSON.stringify(calls[0])}`
  );
}

// ---------------------------------------------------------------------------
// 简单 runner
// ---------------------------------------------------------------------------
const tests = [
  ["testSystemdExecStartQuotes", testSystemdExecStartQuotes],
  ["testWindowsFallbackSetsStartWhenAvailable", testWindowsFallbackSetsStartWhenAvailable],
  ["testSpawnShellDetachedOnWindows", testSpawnShellDetachedOnWindows],
];

let passed = 0;
let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  PASS: ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL: ${name}`);
    console.log(`    ${e.message}`);
    failed++;
  }
}
console.log(`\n结果: PASS=${passed} FAIL=${failed}`);
process.exit(failed ? 1 : 0);
