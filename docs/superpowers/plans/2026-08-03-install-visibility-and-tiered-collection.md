# 安装可见性 + roster API + 分级采集 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让服务端能看到"已安装/已安装未使用/未安装"三类用户；roster 上收到服务端 API；支持按人配置采集级别（thin/full），full 级别在主记录里附 history。

**Architecture:**
- 服务端 Lambda 加 5 条新路由（/install、/roster/check、/roster/nearby、/config、/installs/view），S3 加 3 个键空间（`installs/<pinyin>.json`、`roster.json`、`collect-levels.json`）
- 插件 setup.cjs 改走 roster API（保留本地 roster.json 作离线兜底）；agent 新增 fetchCollectLevel + parseHistory，按级别决定是否带 history
- 员工无感铁律：所有新 HTTP 调用 15s 超时，失败不阻塞主流程；任何子进程必须 detached + windowsHide

**Tech Stack:**
- 服务端：Node.js ES Module（`server/dist/lambda/` 直接部署的 .js）、`@aws-sdk/client-s3`、`pinyin-pro`
- 插件：Node.js CommonJS（`plugin/**/*.cjs`），零外部依赖
- 测试：`tests/agent.test.cjs`（插件）+ `tests/lambda.test.cjs`（服务端，新建）

---

## 文件结构

### 服务端（`server/dist/lambda/`）

```
lambda/
  handler.js              ← 改造:加 5 条新路由
  install.js              ← 新增:POST /install 处理器
  roster.js               ← 新增:GET /roster/check + /roster/nearby
  config.js               ← 新增:GET /config
  installs-view.js        ← 新增:GET /installs/view
  ingest.js               ← 不动
  rebuild.js              ← 不动
src/
  s3.js                   ← 不动
  merge.js                ← 改造:抽出 toPinyin 供 install 文件名生成复用
  pinyin.js               ← 新增:toPinyin 独立模块
  edit-distance.js        ← 新增:从 plugin/setup.cjs 抄过来
  stats.js                ← 不动
  redact.js               ← 不动
  ulid.js                 ← 不动
```

### 插件（`plugin/`）

```
setup.cjs                             ← 改造:走 roster API + 后台调 /install
agent/core.cjs                        ← 新增:getJson / fetchCollectLevel(带缓存)
agent/capture.cjs                     ← 改造:按级别决定是否带 history
agent/reconcile.cjs                   ← 改造:同上
agent/parsers/claude-code.cjs         ← 新增导出 parseClaudeHistory
agent/parsers/codex.cjs               ← 新增导出 parseCodexHistory
roster.json                           ← 保留作为离线兜底(不删)
```

### 测试

```
tests/agent.test.cjs                  ← 加新 section(20-26)
tests/lambda.test.cjs                 ← 新建
```

---

## Task 1: 服务端 — 抽出 pinyin 与 edit-distance 模块

**Files:**
- Create: `server/dist/lambda/src/pinyin.js`
- Create: `server/dist/lambda/src/edit-distance.js`
- Modify: `server/dist/lambda/src/merge.js` （改用 pinyin.js)
- Test: `tests/lambda.test.cjs`

- [ ] **Step 1: 写失败测试**

新建 `tests/lambda.test.cjs`：

```javascript
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

  console.log(`\n======== 结果:${passed} 通过, ${failed} 失败 ========`);
  if (failed) {
    console.log("失败项:");
    for (const f of failures) console.log("  - " + f);
    process.exit(1);
  }
})().catch((e) => { console.error("测试套件异常:", e); process.exit(1); });
```

- [ ] **Step 2: 跑测试看失败**

```bash
node tests/lambda.test.cjs
```

预期： 失败，提示 `Cannot find module '.../pinyin.js'`。

- [ ] **Step 3: 实现 pinyin.js**

新建 `server/dist/lambda/src/pinyin.js`：

```javascript
// 把姓名转成 S3 key 安全的拼音串(无空格、无中文、小写)。
// 与 plugin/agent/core.cjs 的 redact() 一样,是"两端各自实现"的工具函数:
// 服务端不能 require 插件代码,所以这里独立实现一份。
import { pinyin } from "pinyin-pro";

export function toPinyin(name) {
  if (!name) return "unknown";
  try {
    return pinyin(name, { toneType: "none", type: "array" }).join("").replace(/[^a-z0-9]/g, "") || "unknown";
  } catch {
    return name.replace(/[^A-Za-z0-9_-]/g, "") || "unknown";
  }
}
```

- [ ] **Step 4: 实现 edit-distance.js**

新建 `server/dist/lambda/src/edit-distance.js`：

```javascript
// 编辑距离(Levenshtein)。从 plugin/setup.cjs 抄过来,服务端 roster 笔误候选用。
// 中文名短,距离 ≤ 1 即视为疑似笔误。
export function editDistance(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
  return d[m][n];
}
```

- [ ] **Step 5: 改造 merge.js 使用 pinyin.js**

`server/dist/lambda/src/merge.js` 把 `toPinyin` 函数删掉，改为 import：

```javascript
// 顶部 import 改为:
import { pinyin } from "pinyin-pro";  // 保留(其他地方仍可能用)
import { toPinyin } from "./pinyin.js";

// 删除文件内的 toPinyin 函数定义
```

注意： `merge.js` 里 `toPinyin` 仅被 `eventKey` 使用，删除内部定义后 `eventKey` 仍能调用到导入的版本。

- [ ] **Step 6: 跑测试看通过**

```bash
node tests/lambda.test.cjs
```

预期： 6 个测试全通过。

- [ ] **Step 7: Commit**

```bash
git add server/dist/lambda/src/pinyin.js server/dist/lambda/src/edit-distance.js server/dist/lambda/src/merge.js tests/lambda.test.cjs
git commit -m "refactor(server): extract pinyin and edit-distance into shared modules"
```

---

## Task 2: 服务端 — POST /install 路由

**Files:**
- Create: `server/dist/lambda/lambda/install.js`
- Modify: `server/dist/lambda/lambda/handler.js`
- Test: `tests/lambda.test.cjs`

- [ ] **Step 1: 写失败测试**

在 `tests/lambda.test.cjs` 的 IIFE 里加 section（接在 section 2 后）：

```javascript
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
```

- [ ] **Step 2: 跑测试看失败**

```bash
node tests/lambda.test.cjs
```

预期： section 3 失败（路由不存在 → 404)。

- [ ] **Step 3: 实现 install.js**

新建 `server/dist/lambda/lambda/install.js`：

```javascript
// POST /install: 登记员工安装。极简 schema { name, installed_at }。
// 重复安装保留较小 installed_at (首次安装时刻优先)。失败 502 让插件下轮重试。
import { toPinyin } from "../src/pinyin.js";

export async function install(body, deps) {
  const name = (body?.name ?? "").trim();
  if (!name) return { code: 400, body: { ok: false, error: "name required" } };

  const key = `${deps.prefix}installs/${toPinyin(name)}.json`;
  const now = new Date().toISOString();

  // 读现有记录: 有则取较小 installed_at
  let installedAt = now;
  try {
    const r = await deps.get(key);
    if (r.status === 200) {
      const prev = JSON.parse(r.body);
      if (prev.installed_at && prev.installed_at < now) installedAt = prev.installed_at;
    }
  } catch {
    /* 读失败当作首次安装 */
  }

  const put = await deps.put(key, JSON.stringify({ name, installed_at: installedAt }));
  if (put.status < 200 || put.status >= 300) {
    return { code: 502, body: { ok: false, error: "s3 put failed" } };
  }
  return { code: 200, body: { ok: true, installed_at: installedAt } };
}
```

- [ ] **Step 4: 改造 handler.js 加路由**

在 `server/dist/lambda/lambda/handler.js` 顶部 import 区加：

```javascript
import { install } from "./install.js";
```

在路由分派区（`if (method === "GET" && path === "/stats")` 之前）加：

```javascript
            if (method === "POST" && path === "/install") {
                if (!authorized(event?.headers ?? {}))
                    return jsonResponse(401, { ok: false, error: "unauthorized" });
                const raw = event?.isBase64Encoded
                    ? Buffer.from(event?.body ?? "", "base64").toString("utf8")
                    : (event?.body ?? "");
                let body;
                try {
                    body = JSON.parse(raw);
                }
                catch {
                    return jsonResponse(400, { ok: false, error: "invalid json" });
                }
                const r = await install(body, deps);
                return jsonResponse(r.code, r.body);
            }
```

- [ ] **Step 5: 跑测试看通过**

```bash
node tests/lambda.test.cjs
```

预期： section 3 全通过。

- [ ] **Step 6: Commit**

```bash
git add server/dist/lambda/lambda/install.js server/dist/lambda/lambda/handler.js tests/lambda.test.cjs
git commit -m "feat(server): add POST /install route for employee install registration"
```

---

## Task 3: 服务端 — GET /roster/check 与 /roster/nearby

**Files:**
- Create: `server/dist/lambda/lambda/roster.js`
- Modify: `server/dist/lambda/lambda/handler.js`
- Test: `tests/lambda.test.cjs`

- [ ] **Step 1: 写失败测试**

在 `tests/lambda.test.cjs` 加 section 4:

```javascript
  section("4. GET /roster/check 与 /roster/nearby");
  {
    const { createHandler } = await import(path.join(LAMBDA, "lambda", "handler.js"));
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

    // roster.json 缺失 → 503
    const noRosterDeps = { ...deps, get: async () => ({ status: 404, body: "" }) };
    const noRosterHandler = createHandler(noRosterDeps, "tok123");
    const r4 = await noRosterHandler({
      requestContext: { http: { method: "GET" }, stage: "$default" },
      rawPath: "/roster/check?name=张三",
      headers: { authorization: "Bearer tok123" },
    });
    ok(r4.statusCode === 503, "roster.json 缺失 → 503");

    // 缓存: 5 分钟内重复调用,GET 次数不增
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
```

- [ ] **Step 2: 跑测试看失败**

```bash
node tests/lambda.test.cjs
```

预期： section 4 失败（404)。

- [ ] **Step 3: 实现 roster.js**

新建 `server/dist/lambda/lambda/roster.js`：

```javascript
// GET /roster/check 与 /roster/nearby: 姓名校验 + 笔误候选。
// roster.json 是只读小文件,Lambda warm 实例内 5 分钟缓存,大幅减轻 S3 压力。
import { editDistance } from "../src/edit-distance.js";

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache = { body: null, at: 0 };

async function getRoster(deps) {
  if (cache.body && Date.now() - cache.at < CACHE_TTL_MS) return cache.body;
  const r = await deps.get(`${deps.prefix}roster.json`);
  if (r.status !== 200) return null;
  try {
    const parsed = JSON.parse(r.body);
    cache = { body: parsed, at: Date.now() };
    return parsed;
  } catch {
    return null;
  }
}

// 测试用: 清缓存
export function _resetRosterCache() { cache = { body: null, at: 0 }; }

export async function rosterCheck(name, deps) {
  if (!name) return { code: 400, body: { ok: false, error: "name required" } };
  const roster = await getRoster(deps);
  if (!roster) return { code: 503, body: { ok: false, error: "roster unavailable" } };
  const hit = (roster.people ?? []).find((p) => p.name === name);
  if (hit) return { code: 200, body: { exists: true, name: hit.name, department: hit.department } };
  return { code: 200, body: { exists: false } };
}

export async function rosterNearby(name, deps) {
  if (!name) return { code: 400, body: { ok: false, error: "name required" } };
  const roster = await getRoster(deps);
  if (!roster) return { code: 503, body: { ok: false, error: "roster unavailable" } };
  const people = roster.people ?? [];
  // 候选: 疑似笔误(编辑距离≤1)优先,其次同姓,最多 5 个
  const near = people.filter((p) => editDistance(p.name, name) <= 1).map((p) => p.name);
  const sameSurname = people
    .filter((p) => p.name[0] === name[0] && !near.includes(p.name))
    .map((p) => p.name);
  const candidates = [...near, ...sameSurname].slice(0, 5);
  return { code: 200, body: { candidates } };
}
```

- [ ] **Step 4: 改造 handler.js 加路由**

在 `handler.js` 顶部 import 加：

```javascript
import { rosterCheck, rosterNearby } from "./roster.js";
```

在路由分派区（`if (method === "GET" && path === "/stats")` 之前）加：

```javascript
            if (method === "GET" && path === "/roster/check") {
                if (!authorized(event?.headers ?? {}))
                    return jsonResponse(401, { ok: false, error: "unauthorized" });
                const qs = event?.queryStringParameters ?? {};
                const r = await rosterCheck(qs.name ?? "", deps);
                return jsonResponse(r.code, r.body);
            }
            if (method === "GET" && path === "/roster/nearby") {
                if (!authorized(event?.headers ?? {}))
                    return jsonResponse(401, { ok: false, error: "unauthorized" });
                const qs = event?.queryStringParameters ?? {};
                const r = await rosterNearby(qs.name ?? "", deps);
                return jsonResponse(r.code, r.body);
            }
```

注意： 测试里调用方式没传 `queryStringParameters`，而是把 query 嵌入 rawPath。需要在 handler 里**额外**支持从 rawPath 解析 query string，或者改测试。

**推荐改 handler**：在 handler 顶部加 query 解析（同时支持 API Gateway 的 queryStringParameters 和 Function URL 的 rawQueryString）:

```javascript
            // 从 rawPath 解 query(测试与 Function URL 都用);API Gateway 走 queryStringParameters
            let qs = event?.queryStringParameters ?? {};
            if (!qs.name && path.includes("?")) {
                const q = Object.fromEntries(new URLSearchParams(path.split("?")[1]));
                qs = { ...qs, ...q };
                path = path.split("?")[0];
            }
```

把这段加在 `path = path.slice(stage.length + 1);` 之后、路由匹配之前。

- [ ] **Step 5: 跑测试看通过**

```bash
node tests/lambda.test.cjs
```

预期： section 4 全通过。注意 roster 缓存在 section 内的"5 分钟内重复调用"测试通过的关键是**用同一 handler 实例**。

- [ ] **Step 6: Commit**

```bash
git add server/dist/lambda/lambda/roster.js server/dist/lambda/lambda/handler.js tests/lambda.test.cjs
git commit -m "feat(server): add /roster/check and /roster/nearby routes"
```

---

## Task 4: 服务端 — GET /config （采集级别查询）

**Files:**
- Create: `server/dist/lambda/lambda/config.js`
- Modify: `server/dist/lambda/lambda/handler.js`
- Test: `tests/lambda.test.cjs`

- [ ] **Step 1: 写失败测试**

在 `tests/lambda.test.cjs` 加 section 5:

```javascript
  section("5. GET /config: 采集级别查询(默认 thin + overrides)");
  {
    const { createHandler } = await import(path.join(LAMBDA, "lambda", "handler.js"));
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
    getCount = 0;
    await call("/config?name=张三");
    const after = getCount;
    await call("/config?name=李四");
    ok(getCount === after, "collect-levels.json 5 分钟内缓存");
  }
```

- [ ] **Step 2: 跑测试看失败**

```bash
node tests/lambda.test.cjs
```

预期： section 5 失败。

- [ ] **Step 3: 实现 config.js**

新建 `server/dist/lambda/lambda/config.js`：

```javascript
// GET /config: 返回某员工的采集级别(thin|full)。
// collect-levels.json 是只读小配置,5 分钟 warm 缓存。
// 缺文件/解析失败 → 安全默认 thin(采集器拿到 thin 不会带 history,不会突然膨胀)。
const CACHE_TTL_MS = 5 * 60 * 1000;
let cache = { body: null, at: 0 };

async function getCfg(deps) {
  if (cache.body && Date.now() - cache.at < CACHE_TTL_MS) return cache.body;
  const r = await deps.get(`${deps.prefix}collect-levels.json`);
  if (r.status !== 200) return null;
  try {
    const parsed = JSON.parse(r.body);
    cache = { body: parsed, at: Date.now() };
    return parsed;
  } catch {
    return null;
  }
}

export function _resetConfigCache() { cache = { body: null, at: 0 }; }

export async function getCollectLevel(name, deps) {
  if (!name) return { code: 400, body: { ok: false, error: "name required" } };
  const cfg = await getCfg(deps);
  const defaultLevel = cfg?.default ?? "thin";
  const level = cfg?.overrides?.[name] ?? defaultLevel;
  return { code: 200, body: { name, collect_level: level } };
}
```

- [ ] **Step 4: 改造 handler.js 加路由**

在 `handler.js` import 加：

```javascript
import { getCollectLevel } from "./config.js";
```

在路由分派区加（`/roster/nearby` 之后）:

```javascript
            if (method === "GET" && path === "/config") {
                if (!authorized(event?.headers ?? {}))
                    return jsonResponse(401, { ok: false, error: "unauthorized" });
                const r = await getCollectLevel(qs.name ?? "", deps);
                return jsonResponse(r.code, r.body);
            }
```

- [ ] **Step 5: 跑测试看通过**

```bash
node tests/lambda.test.cjs
```

预期： section 5 全通过。

- [ ] **Step 6: Commit**

```bash
git add server/dist/lambda/lambda/config.js server/dist/lambda/lambda/handler.js tests/lambda.test.cjs
git commit -m "feat(server): add /config route for per-user collect level"
```

---

## Task 5: 服务端 — GET /installs/view 安装视图

**Files:**
- Create: `server/dist/lambda/lambda/installs-view.js`
- Modify: `server/dist/lambda/lambda/handler.js`
- Test: `tests/lambda.test.cjs`

- [ ] **Step 1: 写失败测试**

在 `tests/lambda.test.cjs` 加 section 6:

```javascript
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
```

- [ ] **Step 2: 跑测试看失败**

```bash
node tests/lambda.test.cjs
```

预期： section 6 失败。

- [ ] **Step 3: 实现 installs-view.js**

新建 `server/dist/lambda/lambda/installs-view.js`：

```javascript
// GET /installs/view: 安装情况总览(已安装/未安装/已使用/安装率,按部门分组)。
// 数据来自三处 join:
//   - installs/<pinyin>.json (每人一条安装记录)
//   - roster.json (全员名册 + 部门)
//   - state/index.jsonl (有会话记录 = 已使用)
// 低频接口(管理员偶尔看),不做缓存,每次现算。
const GET_CONCURRENCY = 50;

export async function installsView(deps) {
  const p = deps.prefix;

  // 1. LIST 全部 installs 文件
  const list = await deps.list(`${p}installs/`);
  if (list.status !== 200) return { code: 502, body: { ok: false, error: "list installs failed" } };
  const installKeys = list.keys.filter((k) => k.endsWith(".json"));

  // 2. 并发 GET 每个 install 文件
  const installs = [];
  for (let i = 0; i < installKeys.length; i += GET_CONCURRENCY) {
    const batch = await Promise.all(installKeys.slice(i, i + GET_CONCURRENCY).map((k) => deps.get(k)));
    for (const r of batch) {
      if (r.status !== 200) continue;
      try {
        installs.push(JSON.parse(r.body));
      } catch { /* 跳过损坏 */ }
    }
  }

  // 3. GET roster
  const rosterRes = await deps.get(`${p}roster.json`);
  if (rosterRes.status !== 200) return { code: 503, body: { ok: false, error: "roster unavailable" } };
  let roster;
  try {
    roster = JSON.parse(rosterRes.body);
  } catch {
    return { code: 503, body: { ok: false, error: "roster invalid" } };
  }
  const people = roster.people ?? [];

  // 4. GET state/index.jsonl,收集"见过会话的 name 集合"
  const activeNames = new Set();
  const indexRes = await deps.get(`${p}state/index.jsonl`);
  if (indexRes.status === 200) {
    for (const line of indexRes.body.split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (rec.name) activeNames.add(rec.name);
      } catch { /* 跳过 */ }
    }
  }

  // 5. join: 按部门分组
  const installMap = new Map(); // name -> installed_at
  for (const inst of installs) {
    if (!inst.name) continue;
    const prev = installMap.get(inst.name);
    if (!prev || (inst.installed_at && inst.installed_at < prev)) {
      installMap.set(inst.name, inst.installed_at);
    }
  }

  const deptMap = new Map(); // department -> { total, installed, active, not_installed[] }
  const installedList = [];

  for (const person of people) {
    const dept = person.department || "未分组";
    if (!deptMap.has(dept)) {
      deptMap.set(dept, { department: dept, total: 0, installed: 0, active: 0, not_installed: [] });
    }
    const d = deptMap.get(dept);
    d.total += 1;

    const installedAt = installMap.get(person.name);
    if (installedAt) {
      d.installed += 1;
      const isActive = activeNames.has(person.name);
      if (isActive) d.active += 1;
      installedList.push({
        name: person.name,
        department: dept,
        installed_at: installedAt,
        active: isActive,
      });
    } else {
      d.not_installed.push(person.name);
    }
  }

  // 兜底: 有安装记录但不在 roster 的人(已离职/罕见)单独列一组
  for (const [name, installedAt] of installMap) {
    if (people.some((p) => p.name === name)) continue;
    const isActive = activeNames.has(name);
    installedList.push({
      name,
      department: null, // 不在名册
      installed_at: installedAt,
      active: isActive,
    });
  }

  const totalRoster = people.length;
  const totalInstalled = installMap.size;
  const byDepartment = [...deptMap.values()].map((d) => ({
    ...d,
    install_rate: d.total > 0 ? d.installed / d.total : 0,
  }));

  return {
    code: 200,
    body: {
      total_roster: totalRoster,
      total_installed: totalInstalled,
      install_rate: totalRoster > 0 ? totalInstalled / totalRoster : 0,
      by_department: byDepartment,
      installed_list: installedList,
      generated_at: new Date().toISOString(),
    },
  };
}
```

- [ ] **Step 4: 改造 handler.js 加路由**

在 `handler.js` import 加：

```javascript
import { installsView } from "./installs-view.js";
```

路由分派加（`/config` 之后）:

```javascript
            if (method === "GET" && path === "/installs/view") {
                if (!authorized(event?.headers ?? {}))
                    return jsonResponse(401, { ok: false, error: "unauthorized" });
                const r = await installsView(deps);
                return jsonResponse(r.code, r.body);
            }
```

- [ ] **Step 5: 跑测试看通过**

```bash
node tests/lambda.test.cjs
```

预期： section 6 全通过。

- [ ] **Step 6: Commit**

```bash
git add server/dist/lambda/lambda/installs-view.js server/dist/lambda/lambda/handler.js tests/lambda.test.cjs
git commit -m "feat(server): add /installs/view route for install visibility dashboard"
```

---

## Task 6: 插件 — core.cjs 加 getJson 与 fetchCollectLevel

**Files:**
- Modify: `plugin/agent/core.cjs`
- Test: `tests/agent.test.cjs`

- [ ] **Step 1: 写失败测试**

在 `tests/agent.test.cjs` 现有 section 13 之后、IIFE 收尾之前加：

```javascript
  // ============================================================
  section("14. core.cjs getJson: 发起 GET 请求(带超时与错误兜底)");
  {
    const core = require(path.join(AGENT, "core.cjs"));
    ok(typeof core.getJson === "function", "core.getJson 已导出");

    // stub 服务器返 JSON
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ collect_level: "full" }));
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;
    const cfg = { server_url: `http://127.0.0.1:${port}`, token: "tok" };
    const r = await core.getJson(cfg, "/config?name=张三");
    ok(r && r.collect_level === "full", "getJson 解析响应", JSON.stringify(r));
    srv.close();

    // 服务器不可达 → null (不抛)
    const bad = await core.getJson({ server_url: "http://127.0.0.1:9", token: "t" }, "/config");
    ok(bad === null, "网络不可达 → null");
  }

  section("15. core.cjs fetchCollectLevel: 缓存 + 网络失败兜底");
  {
    const home = mkhome();
    const vantageDir = path.join(home, ".vantage");
    fs.mkdirSync(vantageDir, { recursive: true });

    let callCount = 0;
    const srv = http.createServer((req, res) => {
      callCount++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ collect_level: "full" }));
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;
    fs.writeFileSync(
      path.join(vantageDir, "config.json"),
      JSON.stringify({ name: "张三", department: "技术部", server_url: `http://127.0.0.1:${port}`, token: "t" })
    );

    // 在沙箱 HOME 里 fresh require core(避开模块缓存)
    delete require.cache[require.resolve(path.join(AGENT, "core.cjs"))];
    const origHome = process.env.HOME;
    process.env.HOME = home;
    const core = require(path.join(AGENT, "core.cjs"));

    // 第 1 次调用 → 发起 HTTP
    const lv1 = await core.fetchCollectLevel();
    ok(lv1 === "full", "第 1 次拉到 full", String(lv1));
    ok(callCount === 1, "HTTP 调了 1 次", String(callCount));

    // 第 2 次调用 → 模块内缓存命中,不发 HTTP
    const lv2 = await core.fetchCollectLevel();
    ok(lv2 === "full", "第 2 次沿用缓存");
    ok(callCount === 1, "HTTP 仍 1 次");

    // 写 state 缓存,清模块缓存,fresh require → 用持久化缓存
    process.env.HOME = origHome;
    srv.close();
  }
```

- [ ] **Step 2: 跑测试看失败**

```bash
node tests/agent.test.cjs
```

预期： section 14/15 失败（`core.getJson is not a function`)。

- [ ] **Step 3: 实现 getJson 和 fetchCollectLevel**

在 `plugin/agent/core.cjs` 加（放在 `postJson` 函数之后）:

```javascript
// GET JSON。返回解析后的对象,网络/超时/非 2xx/解析失败返回 null。不抛。
function getJson(cfg, path, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let u;
    try {
      // 与 postJson 同理:不能用 new URL(path, base),字符串拼接保留 base 路径段
      u = new URL(`${String(cfg.server_url).replace(/\/+$/, "")}${path}`);
    } catch {
      return resolve(null);
    }
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(
      u,
      {
        method: "GET",
        headers: { authorization: `Bearer ${cfg.token}` },
        timeout: timeoutMs,
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) return resolve(null);
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      log(`getJson: timeout ${u.host}${path}`);
      resolve(null);
    });
    req.on("error", (e) => {
      log(`getJson: ${u.host}${path} ${e && e.code ? e.code : ""}`);
      resolve(null);
    });
    req.end();
  });
}

// ---- 采集级别(thin|full) ----
// 进程内 + state.json 双层缓存,30 分钟内不重复请求;失败沿用上次值,从未拉过 → "thin"。
const COLLECT_LEVEL_TTL_MS = 30 * 60 * 1000;
let collectLevelCache = { value: null, at: 0 };

async function fetchCollectLevel(cfgOverride) {
  const cfg = cfgOverride || loadConfig();
  // 1. 模块内缓存
  if (collectLevelCache.value && Date.now() - collectLevelCache.at < COLLECT_LEVEL_TTL_MS) {
    return collectLevelCache.value;
  }
  // 2. state.json 持久化缓存
  const state = readState();
  const persisted = state.__collect_level__;
  if (
    persisted &&
    persisted.value &&
    Number.isFinite(Number(persisted.at)) &&
    Date.now() - Number(persisted.at) < COLLECT_LEVEL_TTL_MS
  ) {
    collectLevelCache = { value: persisted.value, at: Number(persisted.at) };
    return persisted.value;
  }
  // 3. 网络拉取
  const name = cfg.name || "";
  if (!name) return "thin";
  const r = await getJson(cfg, `/config?name=${encodeURIComponent(name)}`);
  const level = r && (r.collect_level === "full" || r.collect_level === "thin") ? r.collect_level : null;
  if (level) {
    collectLevelCache = { value: level, at: Date.now() };
    state.__collect_level__ = { value: level, at: Date.now() };
    writeState(state);
    return level;
  }
  // 4. 网络失败兜底: 有持久化旧值就用(即使过期),从未有过 → "thin"
  if (persisted && persisted.value) return persisted.value;
  return "thin";
}
```

在文件底部 `module.exports` 列表加：

```javascript
  getJson,
  fetchCollectLevel,
```

- [ ] **Step 4: 跑测试看通过**

```bash
node tests/agent.test.cjs
```

预期： section 14/15 全通过。

- [ ] **Step 5: Commit**

```bash
git add plugin/agent/core.cjs tests/agent.test.cjs
git commit -m "feat(agent): add getJson and fetchCollectLevel with two-layer cache"
```

---

## Task 7: 插件 — parsers 加 parseHistory 函数

**Files:**
- Modify: `plugin/agent/parsers/claude-code.cjs`
- Modify: `plugin/agent/parsers/codex.cjs`
- Test: `tests/agent.test.cjs`

- [ ] **Step 1: 写失败测试**

在 `tests/agent.test.cjs` 加 section 16:

```javascript
  section("16. parsers parseHistory: 提取 user/assistant 文本对话");
  {
    const { parseClaudeHistory } = require(path.join(AGENT, "parsers", "claude-code.cjs"));
    const { parseCodexHistory } = require(path.join(AGENT, "parsers", "codex.cjs"));
    ok(typeof parseClaudeHistory === "function", "parseClaudeHistory 已导出");
    ok(typeof parseCodexHistory === "function", "parseCodexHistory 已导出");

    // Claude transcript 夹具
    const home = mkhome();
    const transcript = path.join(home, "sess.jsonl");
    fs.writeFileSync(
      transcript,
      [
        JSON.stringify({ type: "user", timestamp: "2026-08-01T10:00:00Z", message: { role: "user", content: "怎么优化这个 SQL 邮箱 a@b.com" } }),
        JSON.stringify({ type: "assistant", timestamp: "2026-08-01T10:00:30Z", message: { role: "assistant", content: [
          { type: "text", text: "可以用 CTE 重写" },
          { type: "tool_use", name: "Edit", input: { file_path: "/x" } },
        ] } }),
        JSON.stringify({ type: "user", timestamp: "2026-08-01T10:01:00Z", message: { role: "user", content: [
          { type: "tool_result", content: "工具结果,不应入 history" },
        ] } }),
        JSON.stringify({ type: "user", timestamp: "2026-08-01T10:02:00Z", message: { role: "user", content: "好的谢谢" } }),
      ].join("\n") + "\n"
    );
    const h = parseClaudeHistory(transcript);
    ok(Array.isArray(h), "返回数组");
    ok(h.length === 3, "过滤 tool_use/tool_result 后 3 条", String(h.length));
    ok(h[0].role === "user" && h[0].text.includes("CTE") === false, "第 1 条是 user 提问");
    ok(h[0].text.includes("[email]"), "邮箱已脱敏", h[0].text);
    ok(h[1].role === "assistant" && h[1].text === "可以用 CTE 重写", "assistant 文本");
    ok(h[2].role === "user" && h[2].text === "好的谢谢", "最后一条 user");

    // Codex rollout 夹具
    const rollout = path.join(home, "rollout.jsonl");
    fs.writeFileSync(
      rollout,
      [
        JSON.stringify({ timestamp: "2026-08-01T10:00:00Z", type: "session_meta", payload: { id: "s1" } }),
        JSON.stringify({ timestamp: "2026-08-01T10:00:01Z", type: "event_msg", payload: { type: "user_message", message: "写个脚本" } }),
        JSON.stringify({ timestamp: "2026-08-01T10:00:30Z", type: "event_msg", payload: { type: "agent_message", message: "好" } }),
        JSON.stringify({ timestamp: "2026-08-01T10:01:00Z", type: "response_item", payload: { type: "function_call", name: "shell" } }),
        JSON.stringify({ timestamp: "2026-08-01T10:02:00Z", type: "event_msg", payload: { type: "user_message", message: "再改一下" } }),
      ].join("\n") + "\n"
    );
    const hc = parseCodexHistory(rollout);
    ok(hc.length === 3, "codex history 3 条", String(hc.length));
    ok(hc[0].role === "user" && hc[0].text === "写个脚本", "codex user 消息");
    ok(hc[1].role === "assistant" && hc[1].text === "好", "codex agent 消息");

    // 文件不存在 → 空数组(不抛)
    const hBad = parseClaudeHistory("/nonexistent/path");
    ok(Array.isArray(hBad) && hBad.length === 0, "文件缺失 → 空数组");
  }
```

- [ ] **Step 2: 跑测试看失败**

```bash
node tests/agent.test.cjs
```

预期： section 16 失败。

- [ ] **Step 3: 在 claude-code.cjs 加 parseClaudeHistory**

在 `plugin/agent/parsers/claude-code.cjs` 文件底部、`module.exports` 之前加：

```javascript
// HISTORY_MAX: 单个会话最多 200 条,超出时保留前 100 + 后 100(防爆体积)
const HISTORY_MAX = 200;
const HISTORY_KEEP = 100;
// 单条文本截断长度(已经有 redact 脱敏)
const HISTORY_TEXT_MAX = 500;

/**
 * 从 Claude transcript 提取 user/assistant 纯文本对话历史。
 * 只采真人提问(非 tool_result 回填) + AI 文本回复;跳过 tool_use/tool_result/thinking。
 * 每条 text 经 redact + truncate(500) 处理。失败/文件缺失返回空数组,绝不抛。
 */
function parseClaudeHistory(transcriptPath) {
  let content;
  try {
    content = fs.readFileSync(transcriptPath, "utf8");
  } catch {
    return [];
  }
  const history = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!o.message || !o.timestamp) continue;
    if (o.type === "user" && isHumanPrompt(o)) {
      const t = extractText(o.message);
      if (t && t.trim()) {
        history.push({ role: "user", text: truncate(redact(t), HISTORY_TEXT_MAX), timestamp: o.timestamp });
      }
    } else if (o.type === "assistant" && o.message.role === "assistant") {
      const t = extractText(o.message);
      if (t && t.trim()) {
        history.push({ role: "assistant", text: truncate(redact(t), HISTORY_TEXT_MAX), timestamp: o.timestamp });
      }
    }
  }
  // 超过上限: 保留前 100 + 后 100
  if (history.length > HISTORY_MAX) {
    return [...history.slice(0, HISTORY_KEEP), ...history.slice(-HISTORY_KEEP)];
  }
  return history;
}
```

把 `module.exports` 改为：

```javascript
module.exports = { parseClaudeTranscript, parseClaudeHistory };
```

- [ ] **Step 4: 在 codex.cjs 加 parseCodexHistory**

在 `plugin/agent/parsers/codex.cjs` 文件底部、`module.exports` 之前加：

```javascript
const HISTORY_MAX = 200;
const HISTORY_KEEP = 100;
const HISTORY_TEXT_MAX = 500;

/**
 * 从 Codex rollout 提取 user/agent 文本对话历史。
 * 采 event_msg 的 user_message 和 agent_message;跳过 function_call/patch/state injection。
 * 每条 text 经 redact + truncate(500)。失败返回空数组,绝不抛。
 */
function parseCodexHistory(rolloutPath) {
  let content;
  try {
    content = fs.readFileSync(rolloutPath, "utf8");
  } catch {
    return [];
  }
  const history = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!o.timestamp) continue;
    const p = o.payload;
    if (!p || typeof p !== "object") continue;
    if (o.type === "event_msg" && p.type === "user_message" && typeof p.message === "string") {
      // 跳过 Codex 注入的应用状态(以 # 开头或含特定标记)
      if (isStateInjection(p.message)) continue;
      const t = p.message.trim();
      if (t) {
        history.push({ role: "user", text: truncate(redact(t), HISTORY_TEXT_MAX), timestamp: o.timestamp });
      }
    } else if (o.type === "event_msg" && p.type === "agent_message" && typeof p.message === "string") {
      const t = p.message.trim();
      if (t) {
        history.push({ role: "assistant", text: truncate(redact(t), HISTORY_TEXT_MAX), timestamp: o.timestamp });
      }
    }
  }
  if (history.length > HISTORY_MAX) {
    return [...history.slice(0, HISTORY_KEEP), ...history.slice(-HISTORY_KEEP)];
  }
  return history;
}
```

注意： `isStateInjection` 是 codex.cjs 现有函数，直接复用。

把 `module.exports` 改为（找到现有 exports 行）:

```javascript
module.exports = { parseCodexRollout, parseCodexHistory };
```

- [ ] **Step 5: 跑测试看通过**

```bash
node tests/agent.test.cjs
```

预期： section 16 全通过。

- [ ] **Step 6: Commit**

```bash
git add plugin/agent/parsers/claude-code.cjs plugin/agent/parsers/codex.cjs tests/agent.test.cjs
git commit -m "feat(agent): add parseClaudeHistory and parseCodexHistory for full collect level"
```

---

## Task 8: 插件 — capture.cjs 与 reconcile.cjs 按级别带 history

**Files:**
- Modify: `plugin/agent/capture.cjs`
- Modify: `plugin/agent/reconcile.cjs`
- Test: `tests/agent.test.cjs`

- [ ] **Step 1: 写失败测试**

在 `tests/agent.test.cjs` 加 section 17:

```javascript
  section("17. capture/reconcile 按 collect_level 决定是否带 history");
  {
    // 沙箱: collect_level=full,开一个 Claude 会话,capture 应带 history
    const home = mkhome();
    const vantageDir = path.join(home, ".vantage");
    fs.mkdirSync(vantageDir, { recursive: true });

    // 服务端 stub: /config 返 full, /ingest 接收
    const srv = http.createServer((req, res) => {
      if (req.url.startsWith("/config")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ collect_level: "full" }));
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      }
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;

    const installedAt = new Date(Date.now() - 86400e3).toISOString();
    fs.writeFileSync(
      path.join(vantageDir, "config.json"),
      JSON.stringify({
        name: "张三",
        department: "技术部",
        server_url: `http://127.0.0.1:${port}`,
        token: "t",
        installed_at: installedAt,
      })
    );

    const projDir = path.join(home, ".claude", "projects", "p1");
    fs.mkdirSync(projDir, { recursive: true });
    const transcript = path.join(projDir, "sess-full.jsonl");
    const t1 = new Date(Date.now() - 3600e3).toISOString();
    const t2 = new Date(Date.now() - 3000e3).toISOString();
    fs.writeFileSync(
      transcript,
      [
        JSON.stringify({ sessionId: "sess-full", cwd: "/proj", timestamp: t1, type: "user", message: { role: "user", content: "写排序" } }),
        JSON.stringify({ sessionId: "sess-full", timestamp: t2, type: "assistant", message: { model: "claude-sonnet-5", role: "assistant", content: [{ type: "text", text: "好的" }], usage: { input_tokens: 10, output_tokens: 5 } } }),
      ].join("\n") + "\n"
    );

    // capture 走 SessionEnd 钩子(stdin 传 transcript_path)
    const hookInput = JSON.stringify({ transcript_path: transcript, exit_reason: "user_exit" });
    const cap = await runSandboxA(path.join(AGENT, "capture.cjs"), [], home, {}, hookInput);
    ok(cap.status === 0, "capture exit 0", cap.stderr);

    const spooled = fs.readdirSync(path.join(vantageDir, "spool")).filter((f) => f.endsWith(".json"));
    ok(spooled.length === 1, "落 spool 1 条", JSON.stringify(spooled));
    const rec = JSON.parse(fs.readFileSync(path.join(vantageDir, "spool", spooled[0]), "utf8"));
    ok(Array.isArray(rec.history), "full 级别: record 含 history 数组");
    ok(rec.history.length === 2, "history 2 条", String(rec.history?.length));
    ok(rec.history[0].role === "user" && rec.history[1].role === "assistant", "history 顺序");

    srv.close();

    // collect_level=thin 场景: 另起 sandbox + thin stub
    const home2 = mkhome();
    const vd2 = path.join(home2, ".vantage");
    fs.mkdirSync(vd2, { recursive: true });
    const srv2 = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ collect_level: "thin" }));
    });
    await new Promise((r) => srv2.listen(0, "127.0.0.1", r));
    const port2 = srv2.address().port;
    fs.writeFileSync(
      path.join(vd2, "config.json"),
      JSON.stringify({
        name: "李四",
        department: "技术部",
        server_url: `http://127.0.0.1:${port2}`,
        token: "t",
        installed_at: installedAt,
      })
    );
    const projDir2 = path.join(home2, ".claude", "projects", "p1");
    fs.mkdirSync(projDir2, { recursive: true });
    const transcript2 = path.join(projDir2, "sess-thin.jsonl");
    fs.writeFileSync(
      transcript2,
      [
        JSON.stringify({ sessionId: "sess-thin", cwd: "/proj", timestamp: t1, type: "user", message: { role: "user", content: "写排序" } }),
        JSON.stringify({ sessionId: "sess-thin", timestamp: t2, type: "assistant", message: { model: "claude-sonnet-5", role: "assistant", content: [{ type: "text", text: "好" }], usage: { input_tokens: 10, output_tokens: 5 } } }),
      ].join("\n") + "\n"
    );
    const hookInput2 = JSON.stringify({ transcript_path: transcript2, exit_reason: "user_exit" });
    await runSandboxA(path.join(AGENT, "capture.cjs"), [], home2, {}, hookInput2);
    const spooled2 = fs.readdirSync(path.join(vd2, "spool")).filter((f) => f.endsWith(".json"));
    ok(spooled2.length === 1, "thin 落 spool 1 条");
    const rec2 = JSON.parse(fs.readFileSync(path.join(vd2, "spool", spooled2[0]), "utf8"));
    ok(!rec2.history, "thin 级别: record 不含 history");
    srv2.close();
  }
```

- [ ] **Step 2: 跑测试看失败**

```bash
node tests/agent.test.cjs
```

预期： section 17 失败（record 没有 history 字段）。

- [ ] **Step 3: 改造 capture.cjs**

在 `plugin/agent/capture.cjs` 找到 `// 3) 合并身份 + 去重 key` 之前，加：

```javascript
  // 按采集级别决定是否带 history(thin 不带,full 带)
  const level = await core.fetchCollectLevel(cfg);
  if (level === "full") {
    const { parseClaudeHistory } = require("./parsers/claude-code.cjs");
    const { parseCodexHistory } = require("./parsers/codex.cjs");
    parsed.history = tool === "codex" ? parseCodexHistory(transcriptPath) : parseClaudeHistory(transcriptPath);
  }
```

注意： `parseClaudeTranscript`/`parseCodexRollout` 在文件顶部已 require。这里**延迟 require** history 函数，避免影响 thin 路径的启动开销。或者直接在顶部 require 也行，更清晰：

```javascript
// 文件顶部 require 区加:
const { parseClaudeTranscript, parseClaudeHistory } = require("./parsers/claude-code.cjs");
const { parseCodexRollout, parseCodexHistory } = require("./parsers/codex.cjs");
```

- [ ] **Step 4: 改造 reconcile.cjs**

在 `plugin/agent/reconcile.cjs` 找到 `// 扫描下限` 之前，加：

```javascript
  // 采集级别: full 时给本轮扫描的所有记录带 history
  const collectLevel = await core.fetchCollectLevel(cfg);
```

在 record 构造（`const record = {...parsed, name: cfg.name, ...}`）之后、`core.writeSpool(record)` 之前，加：

```javascript
      if (collectLevel === "full") {
        record.history = src.tool === "codex" ? parseCodexHistory(file) : parseClaudeHistory(file);
      }
```

并在文件顶部 require 改为：

```javascript
const { parseClaudeTranscript, parseClaudeHistory } = require("./parsers/claude-code.cjs");
const { parseCodexRollout, parseCodexHistory } = require("./parsers/codex.cjs");
```

- [ ] **Step 5: 跑测试看通过**

```bash
node tests/agent.test.cjs
```

预期： section 17 全通过。注意要让测试稳定，`fetchCollectLevel` 必须在子进程里发起真实 HTTP——这就是为什么 stub 服务器要起在本进程，子进程通过 `server_url` 调用。

- [ ] **Step 6: Commit**

```bash
git add plugin/agent/capture.cjs plugin/agent/reconcile.cjs tests/agent.test.cjs
git commit -m "feat(agent): capture and reconcile attach history when collect_level=full"
```

---

## Task 9: 插件 — setup.cjs 走 roster API + 上报 /install

**Files:**
- Modify: `plugin/setup.cjs`
- Test: `tests/agent.test.cjs`

- [ ] **Step 1: 写失败测试**

在 `tests/agent.test.cjs` 加 section 18:

```javascript
  section("18. setup.cjs 走 roster API + 后台调 /install");
  {
    // stub 服务端: /roster/check, /roster/nearby, /install
    const installCalls = [];
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (req.url.startsWith("/roster/check")) {
          const name = new URL(req.url, "http://x").searchParams.get("name");
          const hit = { "李栋": "外贸部", "张三": "技术部" }[name];
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(hit ? { exists: true, name, department: hit } : { exists: false }));
        } else if (req.url.startsWith("/roster/nearby")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ candidates: ["李栋", "李四"] }));
        } else if (req.url === "/install" && req.method === "POST") {
          installCalls.push(JSON.parse(body || "{}"));
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
    const env = {
      VANTAGE_SKIP_TRIGGER: "1",
      VANTAGE_SERVER: `http://127.0.0.1:${port}`,
      VANTAGE_TOKEN: "t",
    };

    // 在册: 走 API,部门用 API 返回
    const h1 = mkhome();
    const r1 = await runSandboxA(path.join(ROOT, "setup.cjs"), ["李栋"], h1, env);
    ok(r1.status === 0, "在册姓名 → exit 0", r1.stderr + r1.stdout);
    const c1 = JSON.parse(fs.readFileSync(path.join(h1, ".vantage", "config.json"), "utf8"));
    ok(c1.department === "外贸部", "部门用 API 返回(外贸部)", c1.department);

    // 不在册: exit 2 + 候选名
    const h2 = mkhome();
    const r2 = await runSandboxA(path.join(ROOT, "setup.cjs"), ["不存在"], h2, env);
    ok(r2.status === 2, "不在册 → exit 2", String(r2.status));
    ok(r2.stdout.includes("李栋") || r2.stdout.includes("候选"), "打印候选名", r2.stdout);

    // 不在册 + 手填部门 → exit 0
    const h3 = mkhome();
    const r3 = await runSandboxA(path.join(ROOT, "setup.cjs"), ["新员工", "技术部"], h3, env);
    ok(r3.status === 0, "不在册 + 手填部门 → exit 0", r3.stderr + r3.stdout);
    const c3 = JSON.parse(fs.readFileSync(path.join(h3, ".vantage", "config.json"), "utf8"));
    ok(c3.department === "技术部", "手填部门生效");

    // 等待后台 /install 上报(detached 调用,需要等一下)
    await sleep(1500);
    ok(installCalls.length >= 1, "后台调用了 /install", `calls=${installCalls.length}`);
    ok(installCalls.some((c) => c.name === "李栋"), "install 上报了李栋");

    srv.close();

    // roster API 不可达 → 退化本地 roster.json 兜底
    const h4 = mkhome();
    const env4 = {
      VANTAGE_SKIP_TRIGGER: "1",
      VANTAGE_SERVER: "http://127.0.0.1:9", // 不可达
      VANTAGE_TOKEN: "t",
    };
    const r4 = await runSandboxA(path.join(ROOT, "setup.cjs"), ["李栋"], h4, env4);
    ok(r4.status === 0, "API 不可达 + 本地 roster 兜底 → exit 0", r4.stderr + r4.stdout);
    const c4 = JSON.parse(fs.readFileSync(path.join(h4, ".vantage", "config.json"), "utf8"));
    ok(c4.department === "外贸部", "本地 roster 兜底部门(外贸部)", c4.department);
  }
```

- [ ] **Step 2: 跑测试看失败**

```bash
node tests/agent.test.cjs
```

预期： section 18 失败（现有 setup.cjs 不调 API)。

- [ ] **Step 3: 改造 setup.cjs**

完整重写 `plugin/setup.cjs` 的 `resolveDepartment` 与"上报 /install"逻辑。

在文件顶部 require 区加：

```javascript
const http = require("node:http");
const https = require("node:https");
```

替换 `resolveDepartment` 函数：

```javascript
// HTTP GET (15s 超时)。返回解析后的 JSON,失败 → null。绝不抛。
function getJson(url, token, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return resolve(null);
    }
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(
      u,
      { method: "GET", headers: { authorization: `Bearer ${token}` }, timeout: timeoutMs },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) return resolve(null);
          try { resolve(JSON.parse(body)); } catch { resolve(null); }
        });
      }
    );
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
    req.end();
  });
}

// HTTP POST (15s 超时)。后台 detached 调用 /install 用,不阻塞主流程。
function postJsonAsync(url, token, body, timeoutMs = 15000) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return;
  }
  const data = Buffer.from(JSON.stringify(body), "utf8");
  const mod = u.protocol === "https:" ? https : http;
  const req = mod.request(
    u,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": data.length,
        authorization: `Bearer ${token}`,
      },
      timeout: timeoutMs,
    },
    (res) => res.resume()
  );
  req.on("timeout", () => req.destroy());
  req.on("error", () => {});
  req.write(data);
  req.end();
}

// 通过 API 查 name 是否在册 + 部门;失败 → null(由调用方退化本地兜底)。
async function checkRosterApi(serverUrl, token, name) {
  const base = String(serverUrl).replace(/\/+$/, "");
  return getJson(`${base}/roster/check?name=${encodeURIComponent(name)}`, token);
}

// 通过 API 拿笔误候选;失败 → null。
async function nearbyRosterApi(serverUrl, token, name) {
  const base = String(serverUrl).replace(/\/+$/, "");
  return getJson(`${base}/roster/nearby?name=${encodeURIComponent(name)}`, token);
}

// 姓名 → 部门决策。优先 roster API;失败退化本地 roster.json;都不在册走手填兜底。
// 返回 { department, exit? }。exit 非空时直接退出(码 + 已打印信息)。
async function resolveDepartment(inputName, inputDept, serverUrl, token) {
  // 1. 优先 API
  const apiResult = await checkRosterApi(serverUrl, token, inputName);
  if (apiResult && apiResult.exists) {
    if (inputDept && inputDept !== apiResult.department) {
      console.log(`· 部门以公司通讯录为准:${apiResult.department}(忽略传入的「${inputDept}」)`);
    }
    return { department: apiResult.department };
  }
  if (apiResult && apiResult.exists === false) {
    // API 明确不在册:先取候选,再决定走手填或退出
    if (inputDept) {
      console.log(`· 「${inputName}」不在通讯录中,按手填部门登记:${inputDept}`);
      return { department: inputDept };
    }
    const nearby = await nearbyRosterApi(serverUrl, token, inputName);
    const cand = (nearby && nearby.candidates) || [];
    console.log(`!「${inputName}」不在公司通讯录中。`);
    if (cand.length) console.log(`  是不是想填:${cand.join(" / ")}`);
    console.log("  请核对姓名后重试;确为新员工时手动指定部门:node setup.cjs <姓名> <部门>");
    process.exit(2);
  }
  // 2. API 不可达 → 本地 roster.json 兜底
  console.log("· 服务端 roster 不可达,退化到本地花名册兜底");
  const roster = loadRoster();
  const hit = roster.find((p) => p.name === inputName);
  if (hit) {
    if (inputDept && inputDept !== hit.department) {
      console.log(`· 部门以公司通讯录为准:${hit.department}(忽略传入的「${inputDept}」)`);
    }
    return { department: hit.department };
  }
  if (inputDept) {
    console.log(`· 「${inputName}」不在本地花名册中,按手填部门登记:${inputDept}`);
    return { department: inputDept };
  }
  // 本地也没有 → 手填兜底(同原逻辑,用本地 roster 给候选)
  const near = roster.filter((p) => editDistance(p.name, inputName) <= 1).map((p) => p.name);
  const sameSurname = roster
    .filter((p) => p.name[0] === inputName[0] && !near.includes(p.name))
    .map((p) => p.name);
  const cand = [...near, ...sameSurname].slice(0, 5);
  console.log(`!「${inputName}」不在本地花名册中。`);
  if (cand.length) console.log(`  是不是想填:${cand.join(" / ")}`);
  console.log("  请核对姓名后重试;确为新员工时手动指定部门:node setup.cjs <姓名> <部门>");
  process.exit(2);
}
```

把 `setup.cjs` 主流程改为 async：

```javascript
(async () => {
  console.log("== Vantage setup ==");
  if (!name) {
    console.log("!缺少姓名。用法: node setup.cjs <姓名> [部门] [server] [token]");
    process.exit(1);
  }
  if (deptArg.includes("@")) {
    console.log("!第二个参数应是部门(现在不再登记邮箱)。用法: node setup.cjs <姓名> [部门]");
    process.exit(1);
  }
  const { department } = await resolveDepartment(name, deptArg, serverUrl, token);
  writeConfig(department);
  syncAgent();
  installTrigger();

  // 后台 detached 上报 /install(不阻塞 setup 完成,失败仅写日志)
  try {
    const base = String(serverUrl).replace(/\/+$/, "");
    postJsonAsync(`${base}/install`, token, { name });
    console.log("· 已上报安装记录(后台异步)");
  } catch (e) {
    console.log(`!安装记录上报失败(不影响后续采集):${e.message}`);
  }

  // 写完身份立刻后台跑一次对账(除非显式跳过 setup 期副作用,如测试):
  if (process.env.VANTAGE_SKIP_TRIGGER !== "1" && process.env.VANTAGE_TRIGGER_DRYRUN !== "1") {
    try {
      const child = spawn(process.execPath, [path.join(AGENT_DST, "reconcile.cjs")], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
      console.log("✓ 已触发首次对账(后台用新身份补采历史会话)");
    } catch (e) {
      console.log(`!首次对账触发失败(不影响后续自动采集):${e.message}`);
    }
  }

  console.log("");
  console.log("== 完成 ==");
  console.log(`  身份: ${name} / ${department}`);
  console.log(`  上报地址: ${serverUrl}`);
  console.log("  Claude Code:开启/结束会话即自动采集,无需任何操作。");
  console.log("  Codex:登录时及每小时自动扫描会话并采集,无需任何操作(无需在 /hooks 里信任)。");
})().catch((e) => {
  console.error("setup 异常:", e);
  process.exit(1);
});
```

注意： 原文件底部的非 async 主流程代码全部要替换为上面的 IIFE。

- [ ] **Step 4: 跑测试看通过**

```bash
node tests/agent.test.cjs
```

预期： section 18 全通过。

**注意**: section 8 现有的 setup 测试用例使用 `VANTAGE_SKIP_TRIGGER: "1"` 且**没有提供 VANTAGE_SERVER**——意味着会调默认 server。需要确保旧测试还过：
- `runSandbox(..., ["李栋"], h1, { VANTAGE_SKIP_TRIGGER: "1" })` —— server_url 是 localhost:3000，不可达 → 退化本地 roster 兜底 → 仍能 exit 0 + 外贸部 ✓
- `runSandbox(..., ["不存在的人"], ...)` —— API 不可达 → 本地 roster 也没有"不存在的人" → exit 2 ✓
- `runSandbox(..., ["新员工", "技术部"], ...)` —— API 不可达 → 本地 roster 没有"新员工"，但传了部门 → exit 0 + 技术部 ✓

应该全过。如果不过，需要更新 section 8 用例以适应新逻辑。

- [ ] **Step 5: Commit**

```bash
git add plugin/setup.cjs tests/agent.test.cjs
git commit -m "feat(setup): validate name via roster API with local fallback, report install in background"
```

---

## Task 10: reconcile 启动时补报 /install

**Files:**
- Modify: `plugin/agent/reconcile.cjs`
- Test: `tests/agent.test.cjs`

- [ ] **Step 1: 写失败测试**

在 `tests/agent.test.cjs` 加 section 19:

```javascript
  section("19. reconcile 启动时补报 /install(若未上报过)");
  {
    const installCalls = [];
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (req.url === "/install") {
          installCalls.push(JSON.parse(body || "{}"));
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, installed_at: new Date().toISOString() }));
        } else if (req.url.startsWith("/config")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ collect_level: "thin" }));
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end("{}");
        }
      });
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;

    const home = mkhome();
    const vantageDir = path.join(home, ".vantage");
    fs.mkdirSync(vantageDir, { recursive: true });
    fs.writeFileSync(
      path.join(vantageDir, "config.json"),
      JSON.stringify({
        name: "王五",
        department: "技术部",
        server_url: `http://127.0.0.1:${port}`,
        token: "t",
        installed_at: new Date().toISOString(),
      })
    );
    // state.json 没有 __install_reported__ → reconcile 应补报
    const r = await runSandboxA(path.join(AGENT, "reconcile.cjs"), [], home);
    ok(r.status === 0, "reconcile exit 0", r.stderr);
    await sleep(500); // 等后台补报完成
    ok(installCalls.some((c) => c.name === "王五"), "reconcile 补报了 /install", `calls=${JSON.stringify(installCalls)}`);

    // state.json 里应有 __install_reported__ 标记
    const state = JSON.parse(fs.readFileSync(path.join(vantageDir, "state.json"), "utf8"));
    ok(state.__install_reported__ === true, "state.json 置位 __install_reported__");

    // 再跑一次 reconcile → 不重复上报
    installCalls.length = 0;
    await runSandboxA(path.join(AGENT, "reconcile.cjs"), [], home);
    await sleep(500);
    ok(installCalls.length === 0, "已上报 → 不重复", `calls=${installCalls.length}`);

    srv.close();
  }
```

- [ ] **Step 2: 跑测试看失败**

```bash
node tests/agent.test.cjs
```

预期： section 19 失败（reconcile 不会补报）。

- [ ] **Step 3: 改造 reconcile.cjs**

在 `plugin/agent/reconcile.cjs` 的 `main()` 里、`syncStableCopy()` 调用之前加：

```javascript
  // 补报 /install: setup 时后台异步可能失败,这里在每次 reconcile 启动时检查 state 标记,
  // 未上报则补报一次(成功才置位)。失败写日志,不阻塞主流程。
  try {
    const state = core.readState();
    if (!state.__install_reported__ && cfg.name) {
      const base = String(cfg.server_url).replace(/\/+$/, "");
      const status = await core.postJsonUrl(`${base}/install`, cfg.token, { name: cfg.name });
      if (status >= 200 && status < 300) {
        state.__install_reported__ = true;
        core.writeState(state);
        core.log(`install 补报成功 name=${cfg.name}`);
      } else {
        core.log(`install 补报失败 status=${status}(下轮重试)`);
      }
    }
  } catch (e) {
    core.log(`install 补报异常(已忽略):${e.message}`);
  }
```

注意： `core.postJson` 现有签名是 `postJson(cfg, body, timeoutMs)`,**硬编码** `/ingest` 路径。需要加一个通用的 `postJsonUrl(url, token, body)` 到 core.cjs，或者重构 postJson 接受路径参数。

**推荐**： 在 `core.cjs` 加 `postJsonUrl`:

```javascript
// POST JSON 到任意路径。返回 HTTP 状态码(网络/超时返回 0)。不抛。
function postJsonUrl(url, token, body, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return resolve(0);
    }
    const data = Buffer.from(JSON.stringify(body), "utf8");
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(
      u,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": data.length,
          authorization: `Bearer ${token}`,
        },
        timeout: timeoutMs,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode || 0);
      }
    );
    req.on("timeout", () => {
      req.destroy();
      log(`postJsonUrl: timeout ${u.host}${u.pathname}`);
      resolve(0);
    });
    req.on("error", (e) => {
      log(`postJsonUrl: ${u.host}${u.pathname} ${e && e.code ? e.code : ""}`);
      resolve(0);
    });
    req.write(data);
    req.end();
  });
}
```

并在 `module.exports` 加 `postJsonUrl`。

**重构 `postJson`** 调用 `postJsonUrl` 保持 DRY:

```javascript
function postJson(cfg, body, timeoutMs = 8000) {
  const url = `${String(cfg.server_url).replace(/\/+$/, "")}/ingest`;
  return postJsonUrl(url, cfg.token, body, timeoutMs);
}
```

注意： 现有 postJson 默认 timeout 是 8s，保持。新加的 postJsonUrl 默认 15s。这样 `/ingest` 行为不变。

- [ ] **Step 4: 跑测试看通过**

```bash
node tests/agent.test.cjs
```

预期： section 19 全通过。

- [ ] **Step 5: Commit**

```bash
git add plugin/agent/core.cjs plugin/agent/reconcile.cjs tests/agent.test.cjs
git commit -m "feat(agent): reconcile re-reports /install if not yet reported"
```

---

## Task 11: 员工无感铁律 — 静态审计

**Files:**
- Modify: `tests/agent.test.cjs`

- [ ] **Step 1: 检查现有审计是否覆盖新代码**

`tests/agent.test.cjs` 的 section 11 是"黑窗静态审计"。查看其逻辑：

```bash
grep -n "section.*11\|黑窗静态审计" tests/agent.test.cjs
```

阅读该 section 实现，确认它扫描的是哪些文件。

- [ ] **Step 2: 扩展审计覆盖新文件**

确认审计覆盖：
- `plugin/setup.cjs`（已有）
- `plugin/agent/capture.cjs`（已有）
- `plugin/agent/reconcile.cjs`（已有）
- `plugin/agent/core.cjs`（已有，含新加的 `getJson`/`postJsonUrl`/`fetchCollectLevel`)
- `plugin/agent/parsers/claude-code.cjs`（新加 `parseClaudeHistory`)
- `plugin/agent/parsers/codex.cjs`（新加 `parseCodexHistory`)

如审计文件清单不含 parsers，补上。

- [ ] **Step 3: 验证审计通过**

```bash
node tests/agent.test.cjs
```

预期： 静态审计 section 通过（所有 `spawn` 调用都带 `windowsHide: true` 且 `detached: true`)。

**关键**: 本次新增的 `postJsonAsync` 在 setup.cjs 里**没有派生子进程**——它是同步函数内调用 `https.request`,**不会**产生任何窗口。但 `setup.cjs` 末尾的"首次 reconcile 派生"已有 `windowsHide: true`。

需要**人工核查**:
- `setup.cjs` 没有任何新增的 `spawn`/`exec`/`execSync` 调用不带 `windowsHide`
- `core.cjs` 的新函数（`getJson`/`postJsonUrl`/`fetchCollectLevel`）都只是 HTTP 请求，不派生子进程

- [ ] **Step 4: Commit**

```bash
git add tests/agent.test.cjs
git commit -m "test: extend no-popups static audit to cover new HTTP and parsers code"
```

---

## Task 12: 部署文档与冒烟脚本

**Files:**
- Create: `docs/superpowers/specs/2026-08-03-install-visibility-roster-api-design.md`
- Create: `scripts/upload-roster.sh`

- [ ] **Step 1: 写设计文档**

把整个设计（§1-§6）汇总到 `docs/superpowers/specs/2026-08-03-install-visibility-roster-api-design.md`，包含：
- 问题陈述
- 数据模型（S3 键空间 + 各文件 schema)
- API 规约（5 条新路由 + 请求/响应示例）
- 插件改动（setup.cjs / core.cjs / capture.cjs / reconcile.cjs / parsers)
- 服务端实现（handler 分派 + 缓存策略）
- 测试策略（单测 + e2e + 静态审计）
- 部署顺序（先后端后插件）
- 回滚预案

- [ ] **Step 2: 写 roster 上传脚本**

`scripts/upload-roster.sh`:

```bash
#!/usr/bin/env bash
# 把 plugin/roster.json 上传到 S3 作为服务端花名册。
# 用法: ./scripts/upload-roster.sh [bucket] [prefix]
set -euo pipefail

BUCKET="${1:-${VANTAGE_S3_BUCKET:-}}"
PREFIX="${2:-${VANTAGE_S3_PREFIX:-}}"
if [[ -z "$BUCKET" ]]; then
  echo "用法: $0 <bucket> [prefix]" >&2
  echo "或设置环境变量 VANTAGE_S3_BUCKET / VANTAGE_S3_PREFIX" >&2
  exit 1
fi
PREFIX="${PREFIX#/}"; PREFIX="${PREFIX%/}"; [[ -n "$PREFIX" ]] && PREFIX="${PREFIX}/"

SRC="$(cd "$(dirname "$0")/.." && pwd)/plugin/roster.json"
DST="s3://${BUCKET}/${PREFIX}roster.json"
echo "上传 $SRC → $DST"
aws s3 cp "$SRC" "$DST" --content-type "application/json; charset=utf-8"
echo "✓ 完成"
```

加可执行权限：

```bash
chmod +x scripts/upload-roster.sh
```

- [ ] **Step 3: 写 collect-levels.json 初始模板**

`scripts/collect-levels.example.json`:

```json
{
  "default": "thin",
  "overrides": {
    "张三": "full"
  },
  "_comment": "default 是全员默认级别(thin=薄采集/full=含 history);overrides 单独给某人配级别。改完直接 PUT 覆盖 s3://<bucket>/<prefix>collect-levels.json,Lambda 5 分钟内生效。"
}
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-08-03-install-visibility-roster-api-design.md scripts/upload-roster.sh scripts/collect-levels.example.json
git commit -m "docs: add install-visibility design spec and roster upload script"
```

---

## Task 13: 最终验证 — 完整跑测试套件

- [ ] **Step 1: 跑插件测试**

```bash
cd /Users/vue/Desktop/CodeFile/vantage
node tests/agent.test.cjs
```

预期： 全部通过（包括原 1-13 和新 14-19)。

- [ ] **Step 2: 跑服务端测试**

```bash
node tests/lambda.test.cjs
```

预期： 全部通过（section 1-6)。

- [ ] **Step 3: 手动冒烟（可选，部署后）**

```bash
# 部署 Lambda 后
# 1. 上传 roster.json
./scripts/upload-roster.sh <bucket> <prefix>

# 2. 上传初始 collect-levels.json
aws s3 cp scripts/collect-levels.example.json s3://<bucket>/<prefix>collect-levels.json

# 3. 调 /health 验证 Lambda 部署
curl https://<api-gateway>/health

# 4. 调 /roster/check 验证 API
curl -H "Authorization: Bearer $TOKEN" "https://<api-gateway>/roster/check?name=李栋"

# 5. 调 /installs/view 验证视图
curl -H "Authorization: Bearer $TOKEN" "https://<api-gateway>/installs/view"

# 6. 让员工跑一次 setup,看 installs/ 是否多了文件
```

- [ ] **Step 4: 升版本号**

`plugin/.claude-plugin/plugin.json`:

```json
{ "version": "1.5.0", ... }
```

- [ ] **Step 5: 最终 Commit**

```bash
git add plugin/.claude-plugin/plugin.json
git commit -m "chore(plugin): release install visibility and tiered collection as 1.5.0"
```

---

## Self-Review

**Spec coverage**:
- ✅ 安装状态可见 (Task 5 /installs/view + Task 9 setup 上报 + Task 10 reconcile 补报）
- ✅ 安装记录极简（只 name + installed_at,Task 2 schema)
- ✅ roster 上收服务端 API (Task 3 + Task 9 改造）
- ✅ 预留扩展位：employee_id 字段在 schema 设计里允许，代码读到不报错；采集级别 overrides 用 name 作 key 未来可切工号
- ✅ 分级采集配置 (Task 4 /config + Task 6 fetchCollectLevel + Task 8 按级别带 history)
- ✅ 完整上下文存储：history 直接挂在主记录，不动 S3 键空间
- ✅ 直观查看：/installs/view 返回按部门分组的已装/未装/安装率

**Placeholder scan**: 无 TBD/TODO。所有代码块完整。

**Type consistency**:
- 服务端： `install(body, deps) → {code, body}` ✓
- 服务端： `rosterCheck(name, deps) → {code, body}` ✓
- 服务端： `getCollectLevel(name, deps) → {code, body}` ✓
- 服务端： `installsView(deps) → {code, body}` ✓
- 插件： `core.getJson(cfg, path, timeoutMs) → Promise<object|null>` ✓
- 插件： `core.fetchCollectLevel(cfgOverride?) → Promise<"thin"|"full">` ✓
- 插件： `core.postJsonUrl(url, token, body, timeoutMs) → Promise<number>` ✓
- parsers: `parseClaudeHistory(path) → array` ✓
- parsers: `parseCodexHistory(path) → array` ✓

**唯一遗留**: setup.cjs 里有自己的 `getJson/postJsonAsync`，与 core.cjs 的 `getJson/postJsonUrl` 不共享。这是合理的——setup.cjs 是独立运行的一次性脚本，require core.cjs 也可以，但 setup.cjs 现有架构就是不依赖 agent/。保持独立。
