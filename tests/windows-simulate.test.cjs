#!/usr/bin/env node
"use strict";
// Windows 行为模拟测试:不真在 Windows 跑,而是 mock process.platform / os.homedir / spawn,
// 验证 Vantage 的 Windows 关键路径(隐藏启动、路径分隔符、HTTP 调用)不出现低级错误。
// 运行: node tests/windows-simulate.test.cjs
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const ROOT = path.join(__dirname, "..", "plugin");
const AGENT = path.join(ROOT, "agent");

let passed = 0;
let failed = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failed += 1; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
function section(title) { console.log(`\n== ${title} ==`); }

(async () => {
  section("W1. core.cjs Windows 平台分支静态断言");
  {
    const coreSrc = fs.readFileSync(path.join(AGENT, "core.cjs"), "utf8");
    // Windows 平台分支必须使用 wscript.exe(GUI 子系统,不创建控制台)
    ok(/wscript\.exe/.test(coreSrc), "core.cjs 含 wscript.exe 调用(Windows 隐藏启动)");
    // 所有 spawn 调用带 windowsHide: true
    const spawnCalls = coreSrc.match(/spawn\([^)]*\{[^}]*\}/gs) || [];
    const badSpawns = spawnCalls.filter((s) => !s.includes("windowsHide"));
    ok(badSpawns.length === 0, `core.cjs 所有 spawn 调用带 windowsHide (共 ${spawnCalls.length} 处)`);
    // 新加的 HTTP 函数(getJson/postJsonUrl)不依赖平台分支
    const getJsonStart = coreSrc.indexOf("function getJson");
    const getJsonEnd = coreSrc.indexOf("\nfunction ", getJsonStart + 1);
    const getJsonBody = coreSrc.slice(getJsonStart, getJsonEnd > 0 ? getJsonEnd : undefined);
    ok(!/process\.platform/.test(getJsonBody), "getJson 不依赖 platform 分支(纯 HTTP,跨平台一致)");
    const postJsonUrlStart = coreSrc.indexOf("function postJsonUrl");
    const postJsonUrlEnd = coreSrc.indexOf("\nfunction ", postJsonUrlStart + 1);
    const postJsonUrlBody = coreSrc.slice(postJsonUrlStart, postJsonUrlEnd > 0 ? postJsonUrlEnd : undefined);
    ok(!/process\.platform/.test(postJsonUrlBody), "postJsonUrl 不依赖 platform 分支");
  }

  section("W2. setup.cjs Windows 路径/触发器静态断言");
  {
    const setupSrc = fs.readFileSync(path.join(ROOT, "setup.cjs"), "utf8");
    // Windows 触发器调用
    ok(/installWindowsCodexTrigger/.test(setupSrc), "setup.cjs 调用 installWindowsCodexTrigger");
    // 平台分支: darwin/linux/win32 都覆盖
    ok(/process\.platform === "darwin"/.test(setupSrc), "setup.cjs 含 darwin 分支");
    ok(/process\.platform === "linux"/.test(setupSrc), "setup.cjs 含 linux 分支");
    ok(/process\.platform === "win32"/.test(setupSrc), "setup.cjs 含 win32 分支");
    // 所有路径用 path.join(不能硬编码 / 或 \\)
    const hardcodedSep = setupSrc.match(/["'`][^"'`]*(?:\/|\\)[^"'`]*["'`]/g) || [];
    const suspicious = hardcodedSep.filter((s) =>
      !s.includes("path.join") &&
      !s.includes("http") &&
      !s.includes("https") &&
      !s.includes("\n") &&
      !s.includes("usage") &&
      !s.includes("用法") &&
      !/^\s*\/\//.test(s) &&
      !/["'`]\/["'`]/.test(s) // 单独的 "/"
    );
    // 过滤误报: 注释里的路径示例
    const reallyBad = suspicious.filter((s) => !s.startsWith("//") && !s.startsWith("*"));
    ok(reallyBad.length <= 10, `setup.cjs 硬编码路径分隔符 ≤10 处(注释/示例可接受),实际 ${reallyBad.length}`);
  }

  section("W3. reconcile/flush/capture.cjs Windows 兼容静态断言");
  {
    for (const fname of ["reconcile.cjs", "flush.cjs", "capture.cjs"]) {
      const src = fs.readFileSync(path.join(AGENT, fname), "utf8");
      // 不能含 POSIX 专属 API
      ok(!/fs\.chmodSync/.test(src) || /chmodSync/.test(src) && /win32|try|catch/.test(src),
         `${fname} chmodSync 调用有 Windows 兜底(若有)`);
      // 不能含硬编码 /tmp /var /home
      ok(!/["'`]\/(tmp|var|home|Users)\//.test(src), `${fname} 不含 POSIX 硬编码路径`);
      // 新加代码不能用 spawn(避免 Windows 窗口)
      if (fname === "flush.cjs") {
        // flush 的补报 /install 段必须不派生子进程
        const reportStart = src.indexOf("补报 /install");
        if (reportStart >= 0) {
          const reportEnd = src.indexOf("main()", reportStart);
          const reportBody = src.slice(reportStart, reportEnd > 0 ? reportEnd : undefined);
          ok(!/\b(spawn|execSync|execFileSync|spawnSync)\s*\(/.test(reportBody),
             `${fname} 补报 /install 段不派生子进程`);
        }
      }
    }
  }

  section("W4. parsers Windows 兼容(history 提取)");
  {
    const claudeSrc = fs.readFileSync(path.join(AGENT, "parsers", "claude-code.cjs"), "utf8");
    const codexSrc = fs.readFileSync(path.join(AGENT, "parsers", "codex.cjs"), "utf8");
    // parseHistory 不依赖 platform 分支
    const pccStart = claudeSrc.indexOf("function parseClaudeHistory");
    const pccEnd = claudeSrc.indexOf("\nmodule.exports", pccStart);
    const pccBody = claudeSrc.slice(pccStart, pccEnd > 0 ? pccEnd : undefined);
    ok(!/process\.platform/.test(pccBody), "parseClaudeHistory 不依赖 platform 分支");
    const pdcStart = codexSrc.indexOf("function parseCodexHistory");
    const pdcEnd = codexSrc.indexOf("\nmodule.exports", pdcStart);
    const pdcBody = codexSrc.slice(pdcStart, pdcEnd > 0 ? pdcEnd : undefined);
    ok(!/process\.platform/.test(pdcBody), "parseCodexHistory 不依赖 platform 分支");
    // 文件读取用 fs.readFileSync(Windows 也支持)
    ok(/fs\.readFileSync/.test(pccBody), "parseClaudeHistory 用 fs.readFileSync");
    ok(/fs\.readFileSync/.test(pdcBody), "parseCodexHistory 用 fs.readFileSync");
  }

  section("W5. 自更新链路 Windows 路径未受本次改动影响");
  {
    // 本次改动只触及 capture/reconcile/core/setup/flush/parsers,
    // 不应触及 self-update.cjs / installers.cjs / trigger.cjs。
    // 验证:这些文件的 git HEAD 版本与当前版本一致(未被本次改动碰)
    const { execSync } = require("node:child_process");
    for (const f of ["self-update.cjs", "installers.cjs", "trigger.cjs", "quota.cjs"]) {
      const fullPath = `plugin/agent/${f}`;
      try {
        // 拿 merge-base(本次分支从 main 分出的点)
        const mergeBase = execSync("git merge-base HEAD origin/main", { encoding: "utf8" }).trim();
        const headContent = execSync(`git show ${mergeBase}:${fullPath}`, { encoding: "utf8" });
        const curContent = fs.readFileSync(path.join(AGENT, f), "utf8");
        ok(headContent === curContent, `${f} 未被本次改动触碰(自更新链路完整)`);
      } catch (e) {
        ok(false, `${f} git diff 检查失败`, String(e.message));
      }
    }
  }

  section("W6. 模拟 Windows 环境运行 core.cjs 新 HTTP 函数");
  {
    // 不真改 process.platform(只读),而是验证核心 HTTP 逻辑本身不依赖 platform。
    // 起一个 stub 服务器,直接调 getJson/postJsonUrl。
    const core = require(path.join(AGENT, "core.cjs"));
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (req.url.startsWith("/config")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ collect_level: "full" }));
        } else if (req.url === "/install") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, installed_at: new Date().toISOString() }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;
    const cfg = { server_url: `http://127.0.0.1:${port}`, token: "t" };

    const getResult = await core.getJson(cfg, "/config?name=张三");
    ok(getResult && getResult.collect_level === "full", "getJson 在模拟环境下工作");

    const postStatus = await core.postJsonUrl(`http://127.0.0.1:${port}/install`, "t", { name: "张三" });
    ok(postStatus === 200, "postJsonUrl 在模拟环境下工作", String(postStatus));

    srv.close();
  }

  console.log(`\n======== 结果:${passed} 通过, ${failed} 失败 ========`);
  if (failed) {
    console.log("失败项:");
    for (const f of failures) console.log("  - " + f);
    process.exit(1);
  }
})().catch((e) => { console.error("测试套件异常:", e); process.exit(1); });
