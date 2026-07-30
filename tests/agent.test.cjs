#!/usr/bin/env node
"use strict";
// Vantage 端到端测试套件。全部在沙箱 HOME 里跑,不碰真实 ~/.vantage、不注册真实 OS 触发器。
// 运行: node tests/agent.test.cjs        失败即非零退出。
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn, spawnSync, execFileSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..", "plugin");
const AGENT = path.join(ROOT, "agent");
const installers = require(path.join(AGENT, "installers.cjs"));

let passed = 0;
let failed = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    failures.push(name + (detail ? ` — ${detail}` : ""));
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function section(title) {
  console.log(`\n== ${title} ==`);
}
function mkhome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vantage-test-home-"));
}
// 沙箱环境里跑某个脚本,返回 {status, stdout, stderr}
function runSandbox(script, args, home, extraEnv = {}, input = "") {
  return spawnSync(process.execPath, [script, ...args], {
    input,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      VANTAGE_TRIGGER_DRYRUN: "1",
      VANTAGE_DISABLE_SELF_UPDATE: "1",
      ...extraEnv,
    },
  });
}
// 异步版:stub 服务器跑在本进程时,被测子进程要连本进程的服务器——
// spawnSync 会阻塞本进程事件循环,服务器永远无法响应(子进程 8s 超时)。
// 凡涉及本进程 HTTP 服务器的用例必须用异步版。
function runSandboxA(script, args, home, extraEnv = {}, input = "") {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: {
        ...process.env,
        HOME: home,
        VANTAGE_TRIGGER_DRYRUN: "1",
        VANTAGE_DISABLE_SELF_UPDATE: "1",
        ...extraEnv,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", (e) => resolve({ status: -1, stdout, stderr: String(e) }));
    child.on("close", (code) => resolve({ status: code, stdout, stderr }));
    child.stdin.end(input);
  });
}
// reconcile 末尾会派生 detached flush(持 flush.lock)。前台 flush 须等其释放,否则拿不到锁直接跳过。
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
async function waitLockReleased(home, timeoutMs = 15000) {
  await sleep(800); // 等 detached flush 启动(可能还没创建锁)
  const lock = path.join(home, ".vantage", "flush.lock");
  const t0 = Date.now();
  while (fs.existsSync(lock)) {
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(150);
  }
  return true;
}

// ---- VBScript 词法模拟:字符串内 "" 是转义,单 " 闭合;闭合后只能是 , ) 或行尾 ----
function vbsLexCheck(line) {
  let i = 0;
  const strings = [];
  while (i < line.length) {
    const c = line[i];
    if (c === '"') {
      // 开字符串
      let s = "";
      i++;
      for (;;) {
        if (i >= line.length) return { error: `unclosed string at end`, strings };
        if (line[i] === '"') {
          if (line[i + 1] === '"') {
            s += '"';
            i += 2;
            continue;
          }
          i++;
          break; // 闭合
        }
        s += line[i];
        i++;
      }
      strings.push(s);
      // 闭合后:跳过空格,下一字符必须是 , ) 或行尾
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

// ============================================================
section("1. VBS 内容:引号配平 / 命令行重建 / 错误兜底");
{
  const cases = [
    ["标准路径", "C:\\Program Files\\nodejs\\node.exe", "C:\\Users\\Xin Cheng\\.vantage\\agent\\reconcile.cjs"],
    ["中文用户名", "C:\\Program Files\\nodejs\\node.exe", "C:\\Users\\张明\\.vantage\\agent\\reconcile.cjs"],
    ["nvm 路径+空格", "C:\\Users\\Xin Cheng\\AppData\\Roaming\\nvm\\v22.1.0\\node.exe", "C:\\Users\\Xin Cheng\\.vantage\\agent\\reconcile.cjs"],
  ];
  for (const [label, node, rec] of cases) {
    const body = installers.vbsBody(node, rec);
    const lines = body.split("\r\n").filter(Boolean);
    ok(lines[0] === "On Error Resume Next", `${label}: 首行 On Error Resume Next(运行时错误不弹框)`);
    ok(lines.length === 2, `${label}: 恰好两行`);
    const run = lines[1];
    const quoteCount = (run.match(/"/g) || []).length;
    ok(quoteCount % 2 === 0, `${label}: Run 行引号数为偶数(${quoteCount})`);
    const { error, strings } = vbsLexCheck(run);
    ok(!error, `${label}: VBScript 词法无错误`, error);
    ok(strings.length === 2, `${label}: 恰好 2 个字符串字面量`, JSON.stringify(strings));
    ok(
      strings[1] === `"${node}" "${rec}" --only codex --trigger scheduled`,
      `${label}: Run 命令行重建正确`,
      strings[1]
    );
  }
  // 回归:旧的错误模板(3+2+3+2+1=11 引号)必须被词法检查拦下 —— 证明测试本身有效
  const buggy = `CreateObject("WScript.Shell").Run """C:\\A\\node.exe"" """C:\\B\\reconcile.cjs"" --only codex --trigger scheduled", 0, False`;
  const bad = vbsLexCheck(buggy);
  ok(!!bad.error, "词法检查能检出旧的奇数引号 bug", bad.error || "未检出");
}

// ============================================================
section("2. VBS 文件编码:UTF-16LE + BOM(中文用户名不乱码)");
{
  const body = installers.vbsBody("C:\\P\\node.exe", "C:\\Users\\张明\\.vantage\\agent\\reconcile.cjs");
  const buf = installers.vbsBuffer(body);
  ok(buf[0] === 0xff && buf[1] === 0xfe, "文件以 FF FE(UTF-16LE BOM)开头");
  ok(buf.slice(2).toString("utf16le") === body, "UTF-16LE 解码往返一致");
  const tmp = path.join(mkhome(), "run-reconcile.vbs");
  ok(installers.writeVbsIfChanged(tmp, body) === true, "首次写入返回 true");
  ok(installers.writeVbsIfChanged(tmp, body) === false, "内容相同不再重写(每小时自检不抖动)");
  ok(installers.writeVbsIfChanged(tmp, body + "x") === true, "内容漂移即重写(自愈)");
}

// ============================================================
section("3. 计划任务 XML:well-formed + 编码声明一致");
{
  const xml = installers.hourlyTaskXml("C:\\Users\\Xin Cheng\\.vantage\\run-reconcile.vbs");
  ok(xml.includes('encoding="UTF-16"'), "XML 声明 UTF-16(与实际落盘编码一致)");
  for (const frag of ["<ScheduleByHour>", "<StartWhenAvailable>true</StartWhenAvailable>", "<Hidden>true</Hidden>", "wscript.exe", "&quot;" ]) {
    // 路径引号应为字面双引号(XML 属性外合法);只检查关键片段
    if (frag === "&quot;") continue;
    ok(xml.includes(frag), `XML 含 ${frag}`);
  }
  const tmp = path.join(mkhome(), "task.xml");
  fs.writeFileSync(tmp, Buffer.from(String.fromCharCode(0xfeff) + xml, "utf16le"));
  let parsed = false;
  let err = "";
  try {
    execFileSync("python3", ["-c", "import xml.dom.minidom,sys; xml.dom.minidom.parse(sys.argv[1])", tmp]);
    parsed = true;
  } catch (e) {
    err = String(e.stderr || e.message).slice(0, 200);
  }
  ok(parsed, "python3 xml.dom 能解析 UTF-16 计划任务 XML", err);
}

// ============================================================
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

// ============================================================
section("4. schtasks 输出解码:UTF-16LE(带/不带 BOM)/ UTF-8 / GBK");
{
  const s = "<Task><ScheduleByHour><HoursInterval>1</HoursInterval></ScheduleByHour><StartWhenAvailable>true</StartWhenAvailable>";
  const withBom = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, "utf16le")]);
  ok(installers.decodeConsoleOutput(withBom).includes("<ScheduleByHour>"), "UTF-16LE+BOM 正确解码");
  ok(installers.decodeConsoleOutput(Buffer.from(s, "utf16le")).includes("<ScheduleByHour>"), "裸 UTF-16LE 嗅探解码");
  ok(installers.decodeConsoleOutput(Buffer.from(s, "utf8")).includes("<ScheduleByHour>"), "UTF-8 原样");
  ok(installers.decodeConsoleOutput(Buffer.from("中文内容,无替换符", "utf8")) === "中文内容,无替换符", "UTF-8 中文不受影响");
  // GBK 编码的中文错误(中文 Windows 本地化输出)
  let gbk;
  try {
    gbk = Buffer.from("系统找不到指定的文件", "utf8"); // 构造 GBK 字节:用 iconv 不可用,直接手工 GBK 字节
  } catch {}
  const gbkBytes = Buffer.from([0xcf, 0xb5, 0xcd, 0xb3, 0xd5, 0xd2, 0xb2, 0xbb, 0xb5, 0xbd, 0xd6, 0xb8, 0xb6, 0xa8, 0xb5, 0xc4, 0xce, 0xc4, 0xbc, 0xfe]); // "系统找不到指定的文件" GBK
  const dec = installers.decodeConsoleOutput(gbkBytes);
  ok(dec === "系统找不到指定的文件", "GBK 中文错误消息正确解码", dec);
  void gbk;
}

// ============================================================
section("5. macOS launchd plist:生成 + plutil -lint");
{
  const home = mkhome();
  const r = runSandbox("-e", [], home); // 占位,确认 spawn 封装可用
  void r;
  const script = `
    const i = require(${JSON.stringify(path.join(AGENT, "installers.cjs"))});
    i.installLaunchd(${JSON.stringify(process.execPath)}, ${JSON.stringify(path.join(home, ".vantage", "agent", "reconcile.cjs"))});
  `;
  const res = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, VANTAGE_TRIGGER_DRYRUN: "1" },
  });
  ok(res.status === 0, "installLaunchd 执行成功", res.stderr);
  for (const suffix of ["scheduled", "watch"]) {
    const p = path.join(home, "Library", "LaunchAgents", `com.dgcrane.vantage.codex.${suffix}.plist`);
    ok(fs.existsSync(p), `${suffix}.plist 已生成`);
    const lint = spawnSync("plutil", ["-lint", p], { encoding: "utf8" });
    ok(lint.status === 0 && lint.stdout.includes("OK"), `${suffix}.plist plutil -lint OK`, lint.stderr);
  }
  const sched = fs.readFileSync(path.join(home, "Library", "LaunchAgents", "com.dgcrane.vantage.codex.scheduled.plist"), "utf8");
  ok(sched.includes("<key>RunAtLoad</key><true/>"), "scheduled: RunAtLoad=true(登录即跑)");
  ok(sched.includes("<string>--trigger</string>") && sched.includes("<string>scheduled</string>"), "scheduled: --trigger scheduled 参数");
  const watch = fs.readFileSync(path.join(home, "Library", "LaunchAgents", "com.dgcrane.vantage.codex.watch.plist"), "utf8");
  ok(watch.includes("<key>WatchPaths</key>"), "watch: WatchPaths 监听");
  ok(watch.includes("<string>--trigger</string>") && watch.includes("<string>event</string>"), "watch: --trigger event 参数");

  // 回归:trigger.cjs 自检对"已是新形态"的 plist 必须静默(不再每次 reconcile 重装两个 job)
  const script2 = `
    const t = require(${JSON.stringify(path.join(AGENT, "trigger.cjs"))});
    let repaired = false;
    t.ensureCodexTriggers({ log: (m) => { if (/自检修复|自检失败/.test(m)) repaired = true; } });
    console.log(repaired ? "REPAIRED" : "QUIET");
  `;
  const res2 = spawnSync(process.execPath, ["-e", script2], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, VANTAGE_TRIGGER_DRYRUN: "1" },
  });
  ok(res2.status === 0 && res2.stdout.trim() === "QUIET", "macOS 触发器自检:正确 plist 不重装(回归)", res2.stdout + res2.stderr);
}

// ============================================================
section("6. Linux systemd unit:内容正确");
{
  const home = mkhome();
  const script = `
    const i = require(${JSON.stringify(path.join(AGENT, "installers.cjs"))});
    i.installSystemd(${JSON.stringify(process.execPath)}, ${JSON.stringify(path.join(home, ".vantage", "agent", "reconcile.cjs"))});
  `;
  const res = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, VANTAGE_TRIGGER_DRYRUN: "1" },
  });
  ok(res.status === 0, "installSystemd 执行成功", res.stderr);
  const dir = path.join(home, ".config", "systemd", "user");
  const svc = fs.existsSync(path.join(dir, "vantage-codex.service")) ? fs.readFileSync(path.join(dir, "vantage-codex.service"), "utf8") : "";
  const tmr = fs.existsSync(path.join(dir, "vantage-codex.timer")) ? fs.readFileSync(path.join(dir, "vantage-codex.timer"), "utf8") : "";
  ok(svc.includes("--only codex --trigger scheduled"), "service: 参数正确");
  ok(svc.startsWith("[Unit]"), "service: [Unit] 段");
  ok(tmr.includes("OnCalendar=*-*-* *:00:00"), "timer: 每小时");
  ok(tmr.includes("Persistent=true"), "timer: 错过补跑");
}

// ============================================================
section("7. 端到端:reconcile 采集 -> spool -> flush 上传到 stub 服务器");
(async () => {
  const home = mkhome();
  // 身份配置:先指向不可达端口,验证 spool 落盘;flush 阶段再改指 stub
  const vantageDir = path.join(home, ".vantage");
  fs.mkdirSync(vantageDir, { recursive: true });
  const installedAt = new Date(Date.now() - 2 * 86400 * 1000).toISOString();
  fs.writeFileSync(
    path.join(vantageDir, "config.json"),
    JSON.stringify({ name: "测试员", department: "技术部", server_url: "http://127.0.0.1:9", token: "t", installed_at: installedAt })
  );
  // Claude 会话夹具
  const claudeDir = path.join(home, ".claude", "projects", "proj1");
  fs.mkdirSync(claudeDir, { recursive: true });
  const t1 = new Date(Date.now() - 3600e3).toISOString();
  const t2 = new Date(Date.now() - 3000e3).toISOString();
  fs.writeFileSync(
    path.join(claudeDir, "sess-aaa.jsonl"),
    [
      JSON.stringify({ sessionId: "sess-aaa", cwd: "/proj", timestamp: t1, type: "user", message: { role: "user", content: "帮我写个排序" } }),
      JSON.stringify({ sessionId: "sess-aaa", timestamp: t2, type: "assistant", message: { model: "claude-sonnet-5", role: "assistant", content: [{ type: "text", text: "好的" }], usage: { input_tokens: 100, output_tokens: 50 } } }),
    ].join("\n") + "\n"
  );
  // Codex 会话夹具
  const codexDir = path.join(home, ".codex", "sessions", "2026", "07", "29");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexDir, "rollout-2026-07-29T10-00-00-bbbbbbbb-1234-1234-1234-bbbbbbbbbbbb.jsonl"),
    [
      JSON.stringify({ timestamp: t1, type: "session_meta", payload: { id: "codex-bbb", cwd: "/proj", cli_version: "1.0" } }),
      JSON.stringify({ timestamp: t1, type: "turn_context", payload: { model: "gpt-5-codex" } }),
      JSON.stringify({ timestamp: t1, type: "event_msg", payload: { type: "user_message", message: "写个脚本" } }),
      JSON.stringify({ timestamp: t2, type: "event_msg", payload: { type: "agent_message", message: "好" } }),
      JSON.stringify({ timestamp: t2, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 200, output_tokens: 80, total_tokens: 280, cached_input_tokens: 10, reasoning_output_tokens: 5 }, last_token_usage: { input_tokens: 200, output_tokens: 80, cached_input_tokens: 10, reasoning_output_tokens: 5 } } } }),
    ].join("\n") + "\n"
  );

  const rec = await runSandboxA(path.join(AGENT, "reconcile.cjs"), [], home);
  ok(rec.status === 0, "reconcile 永远 exit 0(服务器不可达也不崩)", rec.stderr);
  const spoolDir = path.join(vantageDir, "spool");
  const spooled = fs.existsSync(spoolDir) ? fs.readdirSync(spoolDir).filter((f) => f.endsWith(".json")) : [];
  ok(spooled.length === 2, `reconcile 落 spool 2 条(claude+codex)`, JSON.stringify(spooled));
  const claudeRec = JSON.parse(fs.readFileSync(path.join(spoolDir, "claude-code_sess-aaa.json"), "utf8"));
  ok(claudeRec.tool === "claude-code" && claudeRec.total_tokens === 150 && claudeRec.name === "测试员", "claude 记录:工具/token/身份正确");
  ok(claudeRec.dedupe_key === "claude-code:sess-aaa", "claude 记录:dedupe_key 正确");
  const codexRec = JSON.parse(fs.readFileSync(path.join(spoolDir, "codex_codex-bbb.json"), "utf8"));
  ok(codexRec.tool === "codex" && codexRec.total_tokens === 280, "codex 记录:工具/token 正确");

  // 幂等:再跑一遍 reconcile,已采过的不重复落盘(上传前 spool 仍是这 2 条,内容覆盖)
  const rec2 = await runSandboxA(path.join(AGENT, "reconcile.cjs"), [], home);
  ok(rec2.status === 0, "reconcile 二跑 exit 0");

  // stub 服务器 + flush
  const received = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body || "{}") });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const cfg = JSON.parse(fs.readFileSync(path.join(vantageDir, "config.json"), "utf8"));
  cfg.server_url = `http://127.0.0.1:${port}`;
  fs.writeFileSync(path.join(vantageDir, "config.json"), JSON.stringify(cfg));

  // 等 reconcile 派生的 detached flush 释放锁(它对 127.0.0.1:9 秒级失败后退出)
  await waitLockReleased(home);
  // 前台 flush 若仍撞上锁则重试一次
  let fl = await runSandboxA(path.join(AGENT, "flush.cjs"), [], home);
  if (received.length === 0) {
    await waitLockReleased(home);
    fl = await runSandboxA(path.join(AGENT, "flush.cjs"), [], home);
  }
  ok(fl.status === 0, "flush exit 0", fl.stderr);
  ok(received.length === 2, `stub 服务器收到 2 条 POST`, String(received.length));
  ok(received.every((r) => r.url === "/ingest"), "POST 路径 /ingest");
  ok(received.every((r) => r.auth === "Bearer t"), "Authorization 头正确");
  ok(received.some((r) => r.body.tool === "claude-code" && r.body.session_id === "sess-aaa"), "收到 claude 记录");
  ok(received.some((r) => r.body.tool === "codex" && r.body.session_id === "codex-bbb"), "收到 codex 记录");
  const left = fs.readdirSync(spoolDir).filter((f) => f.endsWith(".json"));
  ok(left.length === 0, "上传成功后 spool 清空");
  server.close();

  // flush 失败分类:服务器返 500 -> 记录保留(临时失败);返 400 -> 进死信
  // 注意:测试服务器必须先读完请求体再回响应——直接响应会让客户端 ECONNRESET(状态 0=retry),
  // 测不到真实分类。生产 API Gateway 会先收完整 body 再调 Lambda,无此问题。
  const respond =
    (code) =>
    (q, s) => {
      q.resume();
      q.on("end", () => {
        s.writeHead(code);
        s.end();
      });
    };
  fs.writeFileSync(path.join(spoolDir, "x_retry.json"), JSON.stringify({ tool: "claude-code", session_id: "retry1" }));
  const srv500 = http.createServer(respond(500));
  await new Promise((r) => srv500.listen(0, "127.0.0.1", r));
  cfg.server_url = `http://127.0.0.1:${srv500.address().port}`;
  fs.writeFileSync(path.join(vantageDir, "config.json"), JSON.stringify(cfg));
  await waitLockReleased(home);
  await runSandboxA(path.join(AGENT, "flush.cjs"), [], home);
  ok(fs.existsSync(path.join(spoolDir, "x_retry.json")), "500 -> 记录保留待重试");
  srv500.close();
  const srv400 = http.createServer(respond(400));
  await new Promise((r) => srv400.listen(0, "127.0.0.1", r));
  cfg.server_url = `http://127.0.0.1:${srv400.address().port}`;
  fs.writeFileSync(path.join(vantageDir, "config.json"), JSON.stringify(cfg));
  await waitLockReleased(home);
  await runSandboxA(path.join(AGENT, "flush.cjs"), [], home);
  ok(!fs.existsSync(path.join(spoolDir, "x_retry.json")) && fs.existsSync(path.join(vantageDir, "dead", "x_retry.json")), "400 -> 永久失败进死信");
  srv400.close();

  // ============================================================
  section("8. setup.cjs:在册自动填部门 / 不在册退出码 2 / 兜底手填");
  {
    const h1 = mkhome();
    const r1 = runSandbox(path.join(ROOT, "setup.cjs"), ["李栋"], h1, { VANTAGE_SKIP_TRIGGER: "1" });
    ok(r1.status === 0, "在册姓名(李栋)exit 0", r1.stderr + r1.stdout);
    const c1 = JSON.parse(fs.readFileSync(path.join(h1, ".vantage", "config.json"), "utf8"));
    ok(c1.department === "外贸部", "部门按通讯录自动填(外贸部)", c1.department);
    const mode = fs.statSync(path.join(h1, ".vantage", "config.json")).mode & 0o777;
    ok(mode === 0o600, "config.json 权限 0600", mode.toString(8));
    ok(fs.existsSync(path.join(h1, ".vantage", "agent", "reconcile.cjs")), "agent 已同步到稳定副本");

    const h2 = mkhome();
    const r2 = runSandbox(path.join(ROOT, "setup.cjs"), ["不存在的人"], h2, { VANTAGE_SKIP_TRIGGER: "1" });
    ok(r2.status === 2, "不在册且未填部门 exit 2", String(r2.status));

    const h3 = mkhome();
    const r3 = runSandbox(path.join(ROOT, "setup.cjs"), ["新员工", "技术部"], h3, { VANTAGE_SKIP_TRIGGER: "1" });
    ok(r3.status === 0, "不在册+手填部门 exit 0", r3.stderr + r3.stdout);
    const c3 = JSON.parse(fs.readFileSync(path.join(h3, ".vantage", "config.json"), "utf8"));
    ok(c3.department === "技术部", "手填部门生效", c3.department);

    const h4 = mkhome();
    const r4 = runSandbox(path.join(ROOT, "setup.cjs"), [], h4, { VANTAGE_SKIP_TRIGGER: "1" });
    ok(r4.status === 1, "缺姓名 exit 1", String(r4.status));
  }

  // ============================================================
  section("9. uninstall.cjs:DRYRUN 沙箱清理");
  {
    const h = mkhome();
    fs.mkdirSync(path.join(h, ".vantage", "spool"), { recursive: true });
    fs.writeFileSync(path.join(h, ".vantage", "config.json"), "{}");
    const lad = path.join(h, "Library", "LaunchAgents");
    fs.mkdirSync(lad, { recursive: true });
    fs.writeFileSync(path.join(lad, "com.dgcrane.vantage.codex.scheduled.plist"), "<plist/>");
    fs.writeFileSync(path.join(lad, "com.dgcrane.vantage.codex.watch.plist"), "<plist/>");
    const r = runSandbox(path.join(ROOT, "uninstall.cjs"), [], h, { VANTAGE_UNINSTALL_SKIP_PLUGIN: "1" });
    ok(r.status === 0, "uninstall exit 0", r.stderr);
    ok(!fs.existsSync(path.join(h, ".vantage")), "~/.vantage 已删");
    ok(!fs.existsSync(path.join(lad, "com.dgcrane.vantage.codex.scheduled.plist")), "scheduled plist 已删");
    ok(!fs.existsSync(path.join(lad, "com.dgcrane.vantage.codex.watch.plist")), "watch plist 已删");
  }

  // ============================================================
  section("10. 自更新命令链 + wscript 隐藏 VBS:词法 / 逐字符重建 / 平台分支");
  {
    const core = require(path.join(AGENT, "core.cjs"));
    const cmdWin = core.buildSelfUpdateCmd("dgcrane", "vantage@dgcrane", "win32");
    ok(
      cmdWin.startsWith('set "GIT_SSH_COMMAND=ssh -o BatchMode=yes -o ConnectTimeout=10" &&'),
      "win 命令带 BatchMode 守卫(防无人值守时 ssh 交互挂死)"
    );
    ok(
      cmdWin.includes("&& claude plugin marketplace update dgcrane && claude plugin update vantage@dgcrane"),
      "win 命令含 marketplace update + plugin update 两条官方 CLI"
    );
    const cmdSh = core.buildSelfUpdateCmd("dgcrane", "vantage@dgcrane", "darwin");
    ok(cmdSh.startsWith('export GIT_SSH_COMMAND="ssh -o BatchMode=yes'), "sh 命令带 BatchMode 守卫");

    const logCases = [
      ["标准路径", "C:\\Users\\Xin Cheng\\.vantage\\agent.log"],
      ["中文用户名", "C:\\Users\\张明\\.vantage\\agent.log"],
    ];
    for (const [label, logPath] of logCases) {
      const body = core.hiddenRunVbs(cmdWin, logPath);
      const lines = body.split("\r\n").filter(Boolean);
      ok(lines[0] === "On Error Resume Next", `${label}: 首行 On Error Resume Next(运行时错误不弹框)`);
      ok(lines.length === 2, `${label}: 恰好两行`);
      const run = lines[1];
      const quoteCount = (run.match(/"/g) || []).length;
      ok(quoteCount % 2 === 0, `${label}: Run 行引号数为偶数(${quoteCount})`);
      const { error, strings } = vbsLexCheck(run);
      ok(!error, `${label}: VBScript 词法无错误`, error);
      // 逐字符重建:词法分析器反转义出的 Run 字符串必须与原命令完全一致
      ok(
        strings[1] === `cmd /c (${cmdWin}) >>"${logPath}" 2>&1`,
        `${label}: cmd 命令行重建逐字符一致`,
        strings[1]
      );
    }
    // 回归:`A && B >>log`(旧写法,重定向只绑最后一条)不得再出现
    const reconcileSrc = fs.readFileSync(path.join(AGENT, "reconcile.cjs"), "utf8");
    ok(
      !/&&\s*claude plugin update[^\n]*>>/.test(reconcileSrc),
      "reconcile 不再有 '&& ... >>log' 裸链(重定向必须成组)"
    );
  }

  // ============================================================
  section("11. 黑窗静态审计:所有子进程调用点带 windowsHide");
  {
    const expect = [
      [path.join(AGENT, "core.cjs"), 2],
      [path.join(AGENT, "installers.cjs"), 2],
      [path.join(ROOT, "setup.cjs"), 1],
      [path.join(ROOT, "uninstall.cjs"), 3],
    ];
    for (const [file, min] of expect) {
      const src = fs.readFileSync(file, "utf8");
      const n = (src.match(/windowsHide: true/g) || []).length;
      ok(n >= min, `${path.basename(file)}: windowsHide ${n} 处(>=${min})`);
    }
    // 逆向断言:任何 spawn/execFileSync 调用行后 8 行内必须出现 windowsHide
    for (const [file] of expect) {
      const srcLines = fs.readFileSync(file, "utf8").split("\n");
      for (let idx = 0; idx < srcLines.length; idx++) {
        if (/\b(spawn|execFileSync|spawnSync)\s*\(/.test(srcLines[idx]) && !srcLines[idx].includes("require")) {
          const window = srcLines.slice(idx, idx + 10).join("\n");
          ok(/windowsHide/.test(window), `${path.basename(file)}:${idx + 1} 子进程调用带 windowsHide`);
        }
      }
    }
  }

  // ============================================================
  console.log(`\n======== 结果:${passed} 通过, ${failed} 失败 ========`);
  if (failed) {
    console.log("失败项:");
    for (const f of failures) console.log("  - " + f);
    process.exit(1);
  }
})().catch((e) => {
  console.error("测试套件异常:", e);
  process.exit(1);
});
