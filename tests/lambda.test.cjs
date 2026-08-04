#!/usr/bin/env node
"use strict";
// Vantage Lambda 服务端测试。用内存 fake S3 做依赖注入,不连真 AWS。
// 运行: node tests/lambda.test.cjs
const path = require("node:path");
const LAMBDA = path.join(__dirname, "..", "server", "dist", "lambda");

let passed = 0;
let failed = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failed += 1; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
function section(title) { console.log(`\n== ${title} ==`); }

(async () => {
  section("1. pinyin.js: 中文/英文/特殊字符 → S3 安全串");
  {
    const { toPinyin } = await import(path.join(LAMBDA, "src", "pinyin.js"));
    ok(toPinyin("张三") === "zhangsan", "中文姓名转拼音", toPinyin("张三"));
    ok(toPinyin("John Doe") === "johndoe", "英文+空格", toPinyin("John Doe"));
    ok(toPinyin("") === "unknown", "空字符串 → unknown");
    ok(toPinyin("李 四") === "lisi", "中文名含空格", toPinyin("李 四"));
  }

  section("2. edit-distance.js: 编辑距离计算");
  {
    const { editDistance } = await import(path.join(LAMBDA, "src", "edit-distance.js"));
    ok(editDistance("张三", "张三") === 0, "完全相同距离 0");
    ok(editDistance("张三", "张山") === 1, "差一字距离 1");
    ok(editDistance("张三", "李四") === 2, "完全不同距离 2");
    ok(editDistance("", "abc") === 3, "空串 vs 3 字符");
    ok(editDistance("abc", "") === 3, "3 字符 vs 空串");
  }

  section("3. POST /install: 首次/重复/缺参/鉴权");
  {
    const { createHandler } = await import(path.join(LAMBDA, "lambda", "handler.js"));
    const store = new Map();
    const deps = {
      get: async (key) => store.has(key) ? { status: 200, body: store.get(key) } : { status: 404, body: "" },
      put: async (key, body) => { store.set(key, body); return { status: 200 }; },
      list: async (prefix) => ({ status: 200, keys: [...store.keys()].filter(k => k.startsWith(prefix)) }),
      prefix: "test/",
    };
    const handler = createHandler(deps, "tok123");

    const call = (method, p, body, token = "tok123") => handler({
      requestContext: { http: { method }, stage: "$default" },
      rawPath: p,
      headers: { authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : "",
    });

    // 首次安装
    const r1 = await call("POST", "/install", { name: "张三" });
    ok(r1.statusCode === 200, "首次安装 → 200", JSON.stringify(r1));
    const b1 = JSON.parse(r1.body);
    ok(b1.ok === true && typeof b1.installed_at === "string", "返回 installed_at");
    const stored1 = JSON.parse(store.get("test/installs/zhangsan.json"));
    ok(stored1.name === "张三" && stored1.installed_at === b1.installed_at, "S3 落盘");

    // 重复安装: installed_at 保留较小值
    const earlierAt = "2026-01-01T00:00:00.000Z";
    store.set("test/installs/zhangsan.json", JSON.stringify({ name: "张三", installed_at: earlierAt }));
    const r2 = await call("POST", "/install", { name: "张三" });
    const b2 = JSON.parse(r2.body);
    ok(b2.installed_at === earlierAt, "重复安装保留最早 installed_at", b2.installed_at);

    // 缺 name → 400
    const r3 = await call("POST", "/install", {});
    ok(r3.statusCode === 400, "缺 name → 400");

    // 错误 token → 401
    const r4 = await call("POST", "/install", { name: "李四" }, "wrong");
    ok(r4.statusCode === 401, "错误 token → 401");

    // S3 PUT 失败 → 502
    const failDeps = { ...deps, put: async () => ({ status: 500 }) };
    const failHandler = createHandler(failDeps, "tok123");
    const r5 = await failHandler({
      requestContext: { http: { method: "POST" }, stage: "$default" },
      rawPath: "/install",
      headers: { authorization: "Bearer tok123" },
      body: JSON.stringify({ name: "王五" }),
    });
    ok(r5.statusCode === 502, "S3 PUT 失败 → 502");
  }

  section("4. GET /roster/check 与 /roster/nearby");
  {
    const { createHandler } = await import(path.join(LAMBDA, "lambda", "handler.js"));
    const { _resetRosterCache } = await import(path.join(LAMBDA, "lambda", "roster.js"));
    _resetRosterCache(); // 隔离测试: 避免上一个 section 留下的缓存污染
    const rosterBody = JSON.stringify({
      company: "德工机械",
      generated_at: "2026-08-03",
      people: [
        { name: "李栋", department: "外贸部" },
        { name: "杜同周", department: "外贸部" },
        { name: "张三", department: "技术部" },
        { name: "张山", department: "技术部" },
      ],
    });
    const store = new Map([["test/roster.json", rosterBody]]);
    let getCount = 0;
    const deps = {
      get: async (key) => { getCount++; return store.has(key) ? { status: 200, body: store.get(key) } : { status: 404, body: "" }; },
      put: async (key, body) => { store.set(key, body); return { status: 200 }; },
      list: async (prefix) => ({ status: 200, keys: [...store.keys()].filter(k => k.startsWith(prefix)) }),
      prefix: "test/",
    };
    const handler = createHandler(deps, "tok123");
    const call = (p, token = "tok123") => handler({
      requestContext: { http: { method: "GET" }, stage: "$default" },
      rawPath: p,
      headers: { authorization: `Bearer ${token}` },
    });

    // 在册 → exists:true + department
    const r1 = await call("/roster/check?name=张三");
    ok(r1.statusCode === 200, "/roster/check 在册 → 200");
    const b1 = JSON.parse(r1.body);
    ok(b1.exists === true && b1.department === "技术部", "返回部门", JSON.stringify(b1));

    // 不在册 → exists:false
    const r2 = await call("/roster/check?name=不存在");
    const b2 = JSON.parse(r2.body);
    ok(b2.exists === false, "不在册 → exists:false");

    // 缺 name 参数 → 400
    const r3 = await call("/roster/check");
    ok(r3.statusCode === 400, "缺 name → 400");

    // roster.json 缺失 → 503 (先清缓存,让模块真的去 S3 拉)
    _resetRosterCache();
    const noRosterDeps = { ...deps, get: async () => ({ status: 404, body: "" }) };
    const noRosterHandler = createHandler(noRosterDeps, "tok123");
    const r4 = await noRosterHandler({
      requestContext: { http: { method: "GET" }, stage: "$default" },
      rawPath: "/roster/check?name=张三",
      headers: { authorization: "Bearer tok123" },
    });
    ok(r4.statusCode === 503, "roster.json 缺失 → 503");

    // 缓存: 5 分钟内重复调用,GET 次数不增 (独立清缓存,起新计数)
    _resetRosterCache();
    getCount = 0;
    await call("/roster/check?name=李栋");
    const afterFirst = getCount;
    await call("/roster/check?name=杜同周");
    ok(getCount === afterFirst, "roster.json 5 分钟内缓存");

    // /roster/nearby: 笔误候选
    const r5 = await call("/roster/nearby?name=张四");
    const b5 = JSON.parse(r5.body);
    ok(Array.isArray(b5.candidates), "nearby 返回 candidates 数组");
    ok(b5.candidates.includes("张三") || b5.candidates.includes("张山"), "同姓候选", JSON.stringify(b5.candidates));
    ok(b5.candidates.length <= 5, "候选最多 5 个");

    // 错误 token → 401
    const r6 = await call("/roster/check?name=张三", "wrong");
    ok(r6.statusCode === 401, "错误 token → 401");
  }

  section("5. GET /config: 采集级别查询(默认 thin + overrides)");
  {
    const { createHandler } = await import(path.join(LAMBDA, "lambda", "handler.js"));
    const { _resetConfigCache } = await import(path.join(LAMBDA, "lambda", "config.js"));
    _resetConfigCache();
    const cfgBody = JSON.stringify({
      default: "thin",
      overrides: { "张三": "full", "李四": "thin" },
    });
    const store = new Map([["test/collect-levels.json", cfgBody]]);
    let getCount = 0;
    const deps = {
      get: async (key) => { getCount++; return store.has(key) ? { status: 200, body: store.get(key) } : { status: 404, body: "" }; },
      put: async (key, body) => { store.set(key, body); return { status: 200 }; },
      list: async (prefix) => ({ status: 200, keys: [...store.keys()].filter(k => k.startsWith(prefix)) }),
      prefix: "test/",
    };
    const handler = createHandler(deps, "tok123");
    const call = (p) => handler({
      requestContext: { http: { method: "GET" }, stage: "$default" },
      rawPath: p,
      headers: { authorization: "Bearer tok123" },
    });

    // 在 overrides → 返回该级别
    const r1 = await call("/config?name=张三");
    const b1 = JSON.parse(r1.body);
    ok(b1.collect_level === "full", "张三 → full", JSON.stringify(b1));

    // 不在 overrides → 返回 default
    const r2 = await call("/config?name=王五");
    const b2 = JSON.parse(r2.body);
    ok(b2.collect_level === "thin", "王五 → default thin");

    // collect-levels.json 缺失 → 安全默认 thin
    _resetConfigCache();
    const noCfgDeps = { ...deps, get: async () => ({ status: 404, body: "" }) };
    const noCfgHandler = createHandler(noCfgDeps, "tok123");
    const r3 = await noCfgHandler({
      requestContext: { http: { method: "GET" }, stage: "$default" },
      rawPath: "/config?name=张三",
      headers: { authorization: "Bearer tok123" },
    });
    const b3 = JSON.parse(r3.body);
    ok(b3.collect_level === "thin", "collect-levels.json 缺失 → thin");

    // 缺 name → 400
    const r4 = await call("/config");
    ok(r4.statusCode === 400, "缺 name → 400");

    // 缓存: 5 分钟内重复调用,GET 不重复
    _resetConfigCache();
    getCount = 0;
    await call("/config?name=张三");
    const after = getCount;
    await call("/config?name=李四");
    ok(getCount === after, "collect-levels.json 5 分钟内缓存");
  }

  section("6. GET /installs/view: 已安装/未安装/安装率");
  {
    const { createHandler } = await import(path.join(LAMBDA, "lambda", "handler.js"));
    const roster = JSON.stringify({
      company: "德工机械",
      people: [
        { name: "李栋", department: "外贸部" },
        { name: "杜同周", department: "外贸部" },
        { name: "张三", department: "技术部" },
        { name: "张山", department: "技术部" },
        { name: "王五", department: "技术部" },
      ],
    });
    // index.jsonl 中李栋/张三有过会话(已使用),杜同周/张山/王五没会话
    const indexLines = [
      JSON.stringify({ name: "李栋", dedupe_key: "claude-code:s1", tool: "claude-code" }),
      JSON.stringify({ name: "张三", dedupe_key: "claude-code:s2", tool: "claude-code" }),
    ].join("\n") + "\n";
    const store = new Map([
      ["test/roster.json", roster],
      ["test/state/index.jsonl", indexLines],
      ["test/installs/lidong.json", JSON.stringify({ name: "李栋", installed_at: "2026-07-01T00:00:00Z" })],
      ["test/installs/zhangsan.json", JSON.stringify({ name: "张三", installed_at: "2026-07-02T00:00:00Z" })],
      ["test/installs/dutongzhou.json", JSON.stringify({ name: "杜同周", installed_at: "2026-07-03T00:00:00Z" })],
      // 张山/王五 未安装
    ]);
    const deps = {
      get: async (key) => store.has(key) ? { status: 200, body: store.get(key) } : { status: 404, body: "" },
      put: async (key, body) => { store.set(key, body); return { status: 200 }; },
      list: async (prefix) => ({ status: 200, keys: [...store.keys()].filter(k => k.startsWith(prefix)) }),
      prefix: "test/",
    };
    const handler = createHandler(deps, "tok123");
    const r = await handler({
      requestContext: { http: { method: "GET" }, stage: "$default" },
      rawPath: "/installs/view",
      headers: { authorization: "Bearer tok123" },
    });
    ok(r.statusCode === 200, "/installs/view → 200");
    const v = JSON.parse(r.body);
    ok(v.total_roster === 5, "总名册 5 人", String(v.total_roster));
    ok(v.total_installed === 3, "已安装 3 人", String(v.total_installed));
    ok(Math.abs(v.install_rate - 0.6) < 0.001, "安装率 60%", String(v.install_rate));

    const waibu = v.by_department.find(d => d.department === "外贸部");
    ok(waibu.total === 2 && waibu.installed === 2 && waibu.active === 1, "外贸部 2/2 装 1 活跃");
    ok(waibu.not_installed.length === 0, "外贸部无未安装");

    const jishu = v.by_department.find(d => d.department === "技术部");
    ok(jishu.total === 3 && jishu.installed === 1 && jishu.active === 1, "技术部 3/1 装 1 活跃");
    ok(jishu.not_installed.length === 2, "技术部 2 人未安装");
    ok(jishu.not_installed.includes("张山") && jishu.not_installed.includes("王五"), "未安装名单正确");

    // installed_list 含所有已安装人员
    ok(v.installed_list.length === 3, "installed_list 3 条");
    const lidong = v.installed_list.find(u => u.name === "李栋");
    ok(lidong.department === "外贸部" && lidong.active === true, "李栋已装已用");
    const dutongzhou = v.installed_list.find(u => u.name === "杜同周");
    ok(dutongzhou.active === false, "杜同周已装未用");
  }

  section("7. redact.js: history 字段每条 text 都被复查脱敏");
  {
    const { redactRecord } = await import(path.join(LAMBDA, "src", "redact.js"));
    const rec = {
      first_prompt: "邮箱 a@b.com 怎么用",
      summary: "sk-antabc123456 是密钥",
      history: [
        { role: "user", text: "联系 admin@example.com 询问", timestamp: "t1" },
        { role: "assistant", text: "好的,token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c", timestamp: "t2" },
        { role: "user", text: "无敏感信息", timestamp: "t3" },
      ],
    };
    redactRecord(rec);
    ok(rec.first_prompt.includes("[email]"), "first_prompt 邮箱脱敏", rec.first_prompt);
    ok(rec.summary.includes("[secret]"), "summary 密钥脱敏", rec.summary);
    ok(rec.history[0].text.includes("[email]"), "history[0] 邮箱脱敏", rec.history[0].text);
    ok(rec.history[1].text.includes("[jwt]"), "history[1] JWT 脱敏", rec.history[1].text);
    ok(rec.history[2].text === "无敏感信息", "history[2] 无敏感内容不变");
    // 兼容:无 history 字段不崩
    const rec2 = { first_prompt: "test" };
    redactRecord(rec2);
    ok(rec2.first_prompt === "test", "无 history 字段不崩");
    // 兼容:history 不是数组不崩
    const rec3 = { history: "not-array" };
    redactRecord(rec3);
    ok(rec3.history === "not-array", "history 非数组不崩");
  }

  console.log(`\n======== 结果:${passed} 通过, ${failed} 失败 ========`);
  if (failed) {
    console.log("失败项:");
    for (const f of failures) console.log("  - " + f);
    process.exit(1);
  }
})().catch((e) => { console.error("测试套件异常:", e); process.exit(1); });
