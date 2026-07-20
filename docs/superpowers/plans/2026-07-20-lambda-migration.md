# Lambda 迁移实现计划(S3-only)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 vantage 后端从本地 Node 壳迁移到 AWS Lambda(cn-north-1),S3 为唯一存储:events/ 事件账本 + state/ 物化视图,/stats 读时水位线增量追平。

**Architecture:** 抽取共享核心(merge.ts 合并规则 / stats.ts buildStats)→ Lambda 三模块(ingest 写事件 / rebuild 增量算账 / handler 路由)→ esbuild 单文件打包。Node 壳保留为开发测试壳,抽取后现有 27 单测 + T1-T32 必须照绿。

**Tech Stack:** TypeScript(tsx 跑测试)、node:test、@aws-sdk/client-s3、esbuild(打包)、bash E2E(tests/run-tests.sh + fake-s3.cjs)。

**Spec:** `docs/superpowers/specs/2026-07-20-lambda-migration-design.md`(权威依据,计划与之矛盾时以 spec 为准并报备)。

---

## 文件结构总览

| 文件 | 责任 | 动作 |
|---|---|---|
| `server/src/merge.ts` | 合并规则核心:MergeState/mergeInto/effectiveTs/keyOf/dayKeyLocal/eventKey + 全部记录类型,纯逻辑无 IO | 新建 |
| `server/src/merge.test.ts` | mergeInto 合并与撞墙去重单测 | 新建 |
| `server/src/store.ts` | Node 壳存储:JSONL 追加 + replay,委托 merge.ts,对外接口不变 | 重写 |
| `server/src/archive.ts` | eventKey 改为从 merge.ts 转引(re-export,archive.test.ts 不动) | 改 2 处 |
| `server/src/stats.ts` | buildStats(sessions, wallHits, now) 纯函数 | 新建 |
| `server/src/stats.test.ts` | buildStats 单测(任何时区可跑) | 新建 |
| `server/src/index.ts` | 删本地 buildStats,改调 stats.ts | 改 3 处 |
| `server/src/s3.ts` | listKeys 加可选 startAfter 参数 | 改 1 处 |
| `server/lambda/ingest.ts` + `.test.ts` | 脱敏+信封+逐条 PUT 事件 | 新建 |
| `server/lambda/rebuild.ts` + `.test.ts` | 水位线增量重建 state 三文件 | 新建 |
| `server/lambda/handler.ts` + `.test.ts` | 路由(createHandler 依赖注入,可测) | 新建 |
| `server/package.json` | test 脚本加新测试文件;加 build:lambda;devDep esbuild | 改 |
| `tests/fake-s3.cjs` | LIST 排序 + start-after + 可选读日志(第 3 参数) | 改 |
| `tests/lambda-driver.mjs` | E2E 用:把事件 JSON 文件喂给 handler | 新建 |
| `tests/run-tests.sh` | T33/T34/T35 | 追加 |
| `docs/lambda-deploy.md` | 控制台部署步骤 | 新建 |
| `README.md` | 已知边界补三条 | 追加 |

---

## Task 1: 抽取 merge.ts 共享核心(含撞墙去重)

**Files:**
- Create: `server/src/merge.ts`
- Create: `server/src/merge.test.ts`
- Rewrite: `server/src/store.ts`
- Modify: `server/src/archive.ts`(删 eventKey 定义,转引 merge.ts)

- [ ] **Step 1: 写失败测试 `server/src/merge.test.ts`**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMergeState, mergeInto, eventKey, type StoredRecord } from "./merge.ts";

function rec(over: object): StoredRecord {
  return {
    dedupe_key: "codex:s1",
    session_id: "s1",
    tool: "codex",
    name: "甲",
    event_id: "e1",
    received_at: "2026-07-20T10:00:00.000Z",
    ...over,
  } as StoredRecord;
}

test("mergeInto: 同 key 取 effective_ts 大者,与顺序无关", () => {
  const st = createMergeState();
  mergeInto(st, rec({ total_tokens: 100, observed_at: "2026-07-20T10:00:00.000Z" }));
  mergeInto(st, rec({ total_tokens: 50, observed_at: "2026-07-20T09:00:00.000Z" })); // 更旧
  assert.equal(st.index.get("codex:s1")?.total_tokens, 100);
});

test("mergeInto: 撞墙按 (name,at,type) 去重——同一事件重复处理不膨胀", () => {
  const st = createMergeState();
  const hit = rec({ quota_reached: "primary", observed_at: "2026-07-20T10:00:00.000Z" });
  mergeInto(st, hit);
  mergeInto(st, hit); // Lambda 水位线回退/并发重建会重复处理同一事件
  assert.equal(st.wallHits.length, 1);
  mergeInto(st, rec({ quota_reached: "primary", observed_at: "2026-07-20T11:00:00.000Z" })); // 不同时刻另算
  assert.equal(st.wallHits.length, 2);
  assert.deepEqual(st.wallHits[0], { name: "甲", at: Date.parse("2026-07-20T10:00:00.000Z"), type: "primary" });
});

test("eventKey: <prefix>events/dt=<received_at 日期>/<紧凑时间>_<event_id>_<tool>.json", () => {
  const k = eventKey(rec({ event_id: "01J", received_at: "2026-07-20T10:00:15.123Z" }), "vantage-prod/");
  assert.equal(k, "vantage-prod/events/dt=2026-07-20/20260720T100015.123Z_01J_codex.json");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/vue/Desktop/CodeFile/vantage/server && node --import tsx --test src/merge.test.ts`
Expected: FAIL(找不到 ./merge.ts)

- [ ] **Step 3: 创建 `server/src/merge.ts`**

内容 = 从 store.ts 抽出的类型与纯函数 + 撞墙去重 + 从 archive.ts 移入的 eventKey。**纯逻辑,禁止 import fs/path/process**:

```ts
import { ulid } from "./ulid.ts"; // 仅类型注释提及,实际不需要可删——若 eventKey 不用 ulid 则无 import

/** 单个模型在一次会话里的用量明细(请求数 + 各类 token)。 */
export interface ModelUsage {
  requests?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  cache_creation_5m_tokens?: number;
  cache_creation_1h_tokens?: number;
  reasoning_tokens?: number;
}

/**
 * 一条使用记录(一次会话的当前完整快照)。
 * 采集器每次上传的是"这个会话到目前为止的全量",按 dedupe_key 合并,
 * 因此重复触发 / 重试 / 扫描兜底都不会造成重复统计。
 */
export interface UsageRecord {
  name?: string;
  email?: string;
  department?: string;
  machine?: string;
  tool?: string;
  session_id?: string;
  model?: string;
  project?: string;
  started_at?: string;
  ended_at?: string;
  duration_ms?: number;
  user_messages?: number;
  assistant_messages?: number;
  tool_calls?: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  cache_creation_5m_tokens?: number;
  cache_creation_1h_tokens?: number;
  reasoning_tokens?: number;
  by_model?: Record<string, ModelUsage>;
  quota_primary_pct?: number | null;
  quota_secondary_pct?: number | null;
  quota_plan?: string | null;
  quota_reached?: string | null;
  first_prompt?: string;
  summary?: string;
  exit_reason?: string;
  dedupe_key?: string;
  observed_at?: string;
  collected_at?: string;
}

export interface StoredRecord extends UsageRecord {
  event_id?: string;
  received_at: string;
}

/** 一条撞墙历史:谁、何时(effective_ts)、撞了哪档墙(primary/secondary 等) */
export interface WallHit {
  name: string;
  at: number;
  type: string;
}

/** 合并状态:每会话最新快照 + 撞墙历史(去重)。纯内存结构,Node 壳与 Lambda 共用。 */
export interface MergeState {
  index: Map<string, StoredRecord>;
  wallHits: WallHit[];
  wallHitKeys: Set<string>; // `${name} ${at} ${type}`,防水位线回退/并发重建导致撞墙重复计数
}

export function createMergeState(): MergeState {
  return { index: new Map(), wallHits: [], wallHitKeys: new Set() };
}

export function keyOf(r: UsageRecord): string {
  return r.dedupe_key || `${r.tool ?? "unknown"}:${r.session_id ?? "no-session"}`;
}

/**
 * 有效观测时间:判断"哪份快照更新"的依据(spec §6)。
 * 同一 session 的上报只来自一台机器,该比较是同钟比较,不受跨机器时钟误差影响。
 * 全部缺失时按 0 处理(永不覆盖已有正常记录)。
 */
export function effectiveTs(r: UsageRecord): number {
  const s = r.observed_at ?? r.collected_at ?? r.ended_at ?? r.received_at;
  const t = s ? Date.parse(s) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

/**
 * 本地日历日(YYYY-MM-DD),用于"今天是否撞过墙"(spec §6.3)。
 * 用服务端本地时区而非 UTC:团队与服务器同时区,本地 0 点才是"今天"的边界。
 */
export function dayKeyLocal(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * 合并进状态:同 key 取 effective_ts 大者(相等时后到者胜),与读取顺序无关。
 * 撞墙是历史事实:即使该快照随后被刷新覆盖也要留痕,按 (name,at,type) 去重——
 * Lambda 侧同一事件可能被重复处理(水位线回退/并发重建),去重保证只记一次。
 */
export function mergeInto(state: MergeState, rec: StoredRecord): void {
  const k = keyOf(rec);
  const prev = state.index.get(k);
  if (!prev || effectiveTs(rec) >= effectiveTs(prev)) state.index.set(k, rec);
  if (rec.quota_reached) {
    const wh: WallHit = {
      name: rec.name || rec.email || rec.machine || "unknown",
      at: effectiveTs(rec),
      type: String(rec.quota_reached),
    };
    const wk = `${wh.name} ${wh.at} ${wh.type}`;
    if (!state.wallHitKeys.has(wk)) {
      state.wallHitKeys.add(wk);
      state.wallHits.push(wh);
    }
  }
}

/** S3 key(spec §3):<prefix>events/dt=<received_at 的 UTC 日期>/<紧凑时间>_<event_id>_<tool>.json */
export function eventKey(rec: StoredRecord, prefix = ""): string {
  const dt = rec.received_at.slice(0, 10);
  const compact = rec.received_at.replace(/[-:]/g, "");
  const tool = (rec.tool ?? "unknown").replace(/[^A-Za-z0-9-]/g, "-");
  return `${prefix}events/dt=${dt}/${compact}_${rec.event_id}_${tool}.json`;
}
```

注意:原 store.ts 里 `mergeIndex` 的注释一并迁移;`ulid` 此处用不到就不要 import(保持纯逻辑零依赖)。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/vue/Desktop/CodeFile/vantage/server && node --import tsx --test src/merge.test.ts`
Expected: 3 pass

- [ ] **Step 5: 重写 `server/src/store.ts` 为委托层(对外接口不变)**

```ts
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { ulid } from "./ulid.ts";
import {
  createMergeState,
  mergeInto,
  dayKeyLocal,
  effectiveTs,
  type StoredRecord,
  type UsageRecord,
  type WallHit,
} from "./merge.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
// 默认存到 server/data;可用 VANTAGE_DATA_DIR 覆盖(测试用独立目录,避免污染真实数据)
const dataDir = process.env.VANTAGE_DATA_DIR ?? join(__dirname, "..", "data");
mkdirSync(dataDir, { recursive: true });
const jsonlPath = join(dataDir, "usage.jsonl");

// 合并状态(每会话最新快照 + 撞墙历史)。合并规则全部在 merge.ts,这里只做持久化与回放。
const state = createMergeState();

// 启动时回放 JSONL 重建索引(与 upsert 同一套合并规则)
function replay() {
  if (!existsSync(jsonlPath)) return;
  const lines = readFileSync(jsonlPath, "utf8").split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      mergeInto(state, JSON.parse(line) as StoredRecord);
    } catch {
      // 跳过损坏行
    }
  }
}
replay();

/**
 * 追加写日志 + 盖服务端信封 + 按 effective_ts 合并进索引。
 * 信封(event_id/received_at)一律以服务端为准,客户端传入的同名字段被覆盖。
 */
export function upsert(rec: UsageRecord): StoredRecord {
  const stored: StoredRecord = {
    ...rec,
    event_id: ulid(),
    received_at: new Date().toISOString(),
  };
  appendFileSync(jsonlPath, JSON.stringify(stored) + "\n");
  mergeInto(state, stored);
  return stored;
}

/** 当前所有会话(每个 session 只保留 effective_ts 最大的快照) */
export function allSessions(): StoredRecord[] {
  return [...state.index.values()];
}

/** 全部撞墙历史(用于回答"今天/本周是否撞过墙",spec §6.3) */
export function allWallHits(): readonly WallHit[] {
  return state.wallHits;
}

export { dayKeyLocal, effectiveTs, jsonlPath };
export type { StoredRecord, UsageRecord, WallHit };
export type { ModelUsage } from "./merge.ts";
```

- [ ] **Step 6: `server/src/archive.ts` 转引 eventKey**

删去 archive.ts 中的 `eventKey` 函数定义(含其上方注释),在文件头部 import 区加:

```ts
import { eventKey } from "./merge.ts";
export { eventKey }; // 兼容既有调用方与 archive.test.ts
```

archive.ts 里 `putLine` 等使用 `eventKey(...)` 的地方不动。

- [ ] **Step 7: 全量单测回归(27 旧 + 3 新必须全绿)**

Run: `cd /Users/vue/Desktop/CodeFile/vantage/server && node --import tsx --test src/ulid.test.ts src/redact.test.ts src/store.test.ts src/s3.test.ts src/archive.test.ts src/merge.test.ts`
Expected: 全 pass(30 个左右,0 fail)

- [ ] **Step 8: Commit**

```bash
cd /Users/vue/Desktop/CodeFile/vantage
git add server/src/merge.ts server/src/merge.test.ts server/src/store.ts server/src/archive.ts
git commit -m "服务端:抽 merge.ts 共享合并核心(Node 壳/Lambda 复用),撞墙按 (name,at,type) 去重"
```

---

## Task 2: 抽取 stats.ts(buildStats 纯函数)

**Files:**
- Create: `server/src/stats.ts`
- Create: `server/src/stats.test.ts`
- Modify: `server/src/index.ts`(删本地 buildStats,改调 stats.ts)

- [ ] **Step 1: 写失败测试 `server/src/stats.test.ts`**

时区稳健写法:`now` 取当前时刻,撞墙时间由 `now` 减固定偏移构造(任意时区都落在同一本地日/7 天窗外)。

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStats } from "./stats.ts";
import type { StoredRecord, WallHit } from "./merge.ts";

const iso = (t: number) => new Date(t).toISOString();

test("buildStats: 撞墙三字段(today/7d/last)+ 7 天外不算 7d", () => {
  const now = Date.now();
  const sameDay = new Date(now);
  sameDay.setHours(0, 0, 0, 0); // 本地今天 0 点,必与 now 同本地日
  const sessions: StoredRecord[] = [
    {
      dedupe_key: "codex:a",
      session_id: "a",
      tool: "codex",
      name: "甲",
      total_tokens: 100,
      received_at: iso(now - 3600e3),
    },
  ];
  const hits: WallHit[] = [
    { name: "甲", at: sameDay.getTime(), type: "primary" }, // 今天
    { name: "甲", at: now - 8 * 86400e3, type: "secondary" }, // 8 天前
  ];
  const u = buildStats(sessions, hits, now).users.find((x: any) => x.name === "甲")!;
  assert.equal(u.hit_wall_today, true);
  assert.equal(u.hit_wall_7d, true); // 今天那次在 7 天内
  assert.equal(Date.parse(u.last_wall_hit), sameDay.getTime());
  // 只留 8 天前那次:today/7d 都应为 false,但 last_wall_hit 仍是它
  const u2 = buildStats(sessions, [hits[1]], now).users.find((x: any) => x.name === "甲")!;
  assert.equal(u2.hit_wall_today, false);
  assert.equal(u2.hit_wall_7d, false);
  assert.equal(Date.parse(u2.last_wall_hit), now - 8 * 86400e3);
});

test("buildStats: 额度取 effective_ts 最大者(迟到的旧快照不顶回)", () => {
  const now = Date.now();
  const older: StoredRecord = {
    dedupe_key: "codex:b1",
    session_id: "b1",
    tool: "codex",
    name: "乙",
    quota_primary_pct: 95,
    observed_at: iso(now - 7200e3),
    received_at: iso(now - 1000), // 后到,但观测时间旧
  };
  const newer: StoredRecord = {
    ...older,
    dedupe_key: "codex:b2",
    session_id: "b2",
    quota_primary_pct: 30,
    observed_at: iso(now - 3600e3),
    received_at: iso(now - 2000),
  };
  const s = buildStats([older, newer], [], now);
  assert.equal(s.users.length, 1);
  assert.equal(s.users[0].quota_primary_pct, 30);
});

test("buildStats: 按模型汇总(by_model 优先,老记录退回 model)", () => {
  const now = Date.now();
  const s = buildStats(
    [
      {
        dedupe_key: "codex:m1",
        session_id: "m1",
        tool: "codex",
        name: "丙",
        received_at: iso(now),
        by_model: { "gpt-5.5": { requests: 2, input_tokens: 100, output_tokens: 50, cache_read_tokens: 10 } },
      },
      {
        dedupe_key: "claude-code:m2",
        session_id: "m2",
        tool: "claude-code",
        name: "丙",
        model: "claude-opus-4-8",
        input_tokens: 200,
        output_tokens: 80,
        received_at: iso(now),
      },
    ],
    [],
    now
  );
  const gpt = s.model_stats.find((m: any) => m.model === "gpt-5.5")!;
  assert.equal(gpt.requests, 2);
  assert.equal(gpt.total_tokens, 150);
  const opus = s.model_stats.find((m: any) => m.model === "claude-opus-4-8")!;
  assert.equal(opus.requests, 1);
  assert.equal(opus.total_tokens, 280);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/vue/Desktop/CodeFile/vantage/server && node --import tsx --test src/stats.test.ts`
Expected: FAIL(找不到 ./stats.ts)

- [ ] **Step 3: 创建 `server/src/stats.ts`**

把 index.ts 里的 buildStats 原样搬入,改为纯函数(数据由参数给,`now` 可注入):

```ts
import { dayKeyLocal, effectiveTs, type StoredRecord, type WallHit } from "./merge.ts";

/**
 * 从合并后的会话快照 + 撞墙历史算出看板报表。纯函数:同输入同输出,now 可注入(测试/重放用)。
 * 三个业务问题:(a) 当前额度=按 effective_ts 最新的快照;(b) 撞墙历史=扫全部撞墙事件,窗口刷新抹不掉;
 * (c) token 总数=按会话求和(输入已按 dedupe_key 合并,故不重复计数)。
 */
export function buildStats(sessions: StoredRecord[], wallHits: readonly WallHit[], now: number = Date.now()) {
  const byEmail = new Map<string, any>();
  const byModel = new Map<string, any>();
  const accModelStat = (model: string, u: any) => {
    const m =
      byModel.get(model) ?? {
        model,
        requests: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        reasoning_tokens: 0,
        total_tokens: 0,
      };
    m.requests += u.requests ?? 0;
    m.input_tokens += u.input_tokens ?? 0;
    m.output_tokens += u.output_tokens ?? 0;
    m.cache_read_tokens += u.cache_read_tokens ?? 0;
    m.cache_creation_tokens += u.cache_creation_tokens ?? 0;
    m.reasoning_tokens += u.reasoning_tokens ?? 0;
    m.total_tokens = m.input_tokens + m.output_tokens;
    byModel.set(model, m);
  };
  for (const s of sessions) {
    if (s.by_model && typeof s.by_model === "object") {
      for (const [model, u] of Object.entries(s.by_model)) accModelStat(model, u);
    } else if (s.model) {
      accModelStat(s.model, {
        requests: 1,
        input_tokens: s.input_tokens,
        output_tokens: s.output_tokens,
        cache_read_tokens: s.cache_read_tokens,
        cache_creation_tokens: s.cache_creation_tokens,
        reasoning_tokens: s.reasoning_tokens,
      });
    }
    const k = s.name || s.email || s.machine || "unknown";
    const agg = byEmail.get(k) ?? {
      name: s.name,
      email: s.email,
      department: s.department,
      sessions: 0,
      total_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      tools: new Set<string>(),
      models: new Set<string>(),
      last_used: "",
      quota_primary_pct: null as number | null,
      quota_secondary_pct: null as number | null,
      quota_plan: null as string | null,
      quota_reached: null as string | null,
      quota_at: 0,
      hit_wall_today: false,
      hit_wall_7d: false,
      last_wall_hit: "",
    };
    agg.sessions += 1;
    agg.total_tokens += s.total_tokens ?? 0;
    agg.cache_read_tokens += s.cache_read_tokens ?? 0;
    agg.cache_creation_tokens += s.cache_creation_tokens ?? 0;
    if (s.tool) agg.tools.add(s.tool);
    if (s.model) agg.models.add(s.model);
    const t = s.ended_at || s.received_at || "";
    if (t >= agg.last_used) {
      agg.last_used = t;
      agg.name = s.name;
      agg.email = s.email;
      agg.department = s.department;
    }
    if (s.quota_primary_pct != null || s.quota_secondary_pct != null) {
      const qt = effectiveTs(s);
      if (qt >= agg.quota_at) {
        agg.quota_at = qt;
        agg.quota_primary_pct = s.quota_primary_pct ?? null;
        agg.quota_secondary_pct = s.quota_secondary_pct ?? null;
        agg.quota_plan = s.quota_plan ?? null;
        agg.quota_reached = s.quota_reached ?? null;
      }
    }
    byEmail.set(k, agg);
  }
  const todayLocal = dayKeyLocal(now);
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
  for (const wh of wallHits) {
    const agg = byEmail.get(wh.name);
    if (!agg) continue;
    if (dayKeyLocal(wh.at) === todayLocal) agg.hit_wall_today = true;
    if (wh.at >= now - SEVEN_DAYS) agg.hit_wall_7d = true;
    if (!agg.last_wall_hit || wh.at > Date.parse(agg.last_wall_hit)) {
      agg.last_wall_hit = new Date(wh.at).toISOString();
    }
  }
  return {
    total_sessions: sessions.length,
    users: [...byEmail.values()].map(({ tools, models, quota_at, ...u }) => ({
      ...u,
      tools: [...tools],
      models: [...models],
    })),
    model_stats: [...byModel.values()].sort((a, b) => b.total_tokens - a.total_tokens),
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/vue/Desktop/CodeFile/vantage/server && node --import tsx --test src/stats.test.ts`
Expected: 3 pass

- [ ] **Step 5: `server/src/index.ts` 改为调用 stats.ts(3 处编辑)**

1) 第 3 行 import 替换:

```ts
// 旧
import { upsert, allSessions, allWallHits, dayKeyLocal, effectiveTs, jsonlPath, type UsageRecord } from "./store.ts";
// 新
import { upsert, allSessions, allWallHits, jsonlPath, type UsageRecord } from "./store.ts";
import { buildStats } from "./stats.ts";
```

2) 删除本地 buildStats 定义:从 `// 简单聚合，供快速自查（正式看板以后再做）` 一行起,到 `/stats` 路由之前的整个 `function buildStats() { ... }`(含尾部空行)整体删除。

3) `/stats` 路由里的调用:

```ts
// 旧
return json(res, 200, buildStats());
// 新
return json(res, 200, buildStats(allSessions(), allWallHits()));
```

- [ ] **Step 6: 全量单测 + E2E 回归**

Run: `cd /Users/vue/Desktop/CodeFile/vantage/server && node --import tsx --test src/ulid.test.ts src/redact.test.ts src/store.test.ts src/s3.test.ts src/archive.test.ts src/merge.test.ts src/stats.test.ts`
Expected: 全 pass
Run: `cd /Users/vue/Desktop/CodeFile/vantage && bash tests/run-tests.sh`
Expected: T1-T32 全 PASS,FAIL=0(断言总数与之前一致,86)

- [ ] **Step 7: Commit**

```bash
cd /Users/vue/Desktop/CodeFile/vantage
git add server/src/stats.ts server/src/stats.test.ts server/src/index.ts
git commit -m "服务端:buildStats 抽成纯函数 stats.ts(now 可注入),Node 壳/Lambda 共用"
```

---

## Task 3: lambda/ingest.ts(脱敏+信封+逐条 PUT)

**Files:**
- Create: `server/lambda/ingest.ts`
- Create: `server/lambda/ingest.test.ts`

- [ ] **Step 1: 写失败测试 `server/lambda/ingest.test.ts`**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ingest } from "./ingest.ts";

function fakePutter(ok = true) {
  const calls: { key: string; body: string }[] = [];
  return {
    calls,
    putter: async (key: string, body: string) => {
      calls.push({ key, body });
      return { status: ok ? 200 : 500 };
    },
  };
}

test("ingest: 单条——脱敏+盖服务端信封+按 eventKey 写,返回 accepted=1", async () => {
  const { calls, putter } = fakePutter();
  const r = await ingest(
    {
      tool: "codex",
      session_id: "s1",
      dedupe_key: "codex:s1",
      name: "甲",
      first_prompt: "联系我 a@b.com",
      event_id: "fake-id",
      received_at: "1999-01-01T00:00:00.000Z",
    },
    { putter, prefix: "vantage-prod/" }
  );
  assert.equal(r.code, 200);
  assert.equal((r.body as any).accepted, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0].key, /^vantage-prod\/events\/dt=\d{4}-\d{2}-\d{2}\/.+_codex\.json$/);
  const saved = JSON.parse(calls[0].body);
  assert.notEqual(saved.event_id, "fake-id"); // 客户端伪造被覆盖
  assert.match(saved.event_id, /^[0-9A-HJKMNP-TV-Z]{26}$/); // ULID
  assert.notEqual(saved.received_at, "1999-01-01T00:00:00.000Z");
  assert.equal(saved.first_prompt.includes("a@b.com"), false); // 服务端复查脱敏生效
});

test("ingest: 批量——数组逐条写,非对象项被过滤", async () => {
  const { calls, putter } = fakePutter();
  const r = await ingest(
    [
      { tool: "codex", session_id: "a", dedupe_key: "codex:a" },
      null,
      5,
      { tool: "claude-code", session_id: "b", dedupe_key: "claude-code:b" },
    ],
    { putter, prefix: "" }
  );
  assert.equal(r.code, 200);
  assert.equal((r.body as any).accepted, 2);
  assert.equal(calls.length, 2);
});

test("ingest: 任一 PUT 失败 → 502", async () => {
  const { putter } = fakePutter(false);
  const r = await ingest({ tool: "codex", session_id: "s1", dedupe_key: "codex:s1" }, { putter, prefix: "" });
  assert.equal(r.code, 502);
  assert.equal((r.body as any).ok, false);
});

test("ingest: 无有效记录 → 200 accepted=0(与 Node 壳行为一致)", async () => {
  const { putter } = fakePutter();
  const r = await ingest([null, "x"], { putter, prefix: "" });
  assert.deepEqual(r.body, { ok: true, accepted: 0 });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/vue/Desktop/CodeFile/vantage/server && node --import tsx --test lambda/ingest.test.ts`
Expected: FAIL(找不到 ./ingest.ts)

- [ ] **Step 3: 创建 `server/lambda/ingest.ts`**

```ts
// Lambda /ingest:复查脱敏 + 盖服务端信封 + 同步 PUT 事件到 S3(无队列,spec §5.2)。
// 失败返回 502 让采集端下轮重传——会话快照语义,重传天然幂等。
import { ulid } from "../src/ulid.ts";
import { redactRecord } from "../src/redact.ts";
import { eventKey, type StoredRecord, type UsageRecord } from "../src/merge.ts";

export interface IngestDeps {
  putter: (key: string, body: string) => Promise<{ status: number }>;
  prefix: string; // 桶内前缀(已归一化,带尾斜杠;空串=桶根)
}

export interface IngestResult {
  code: number;
  body: unknown;
}

const CONCURRENCY = 10;

export async function ingest(payload: unknown, deps: IngestDeps): Promise<IngestResult> {
  const records = (Array.isArray(payload) ? payload : [payload]).filter(
    (r): r is UsageRecord => Boolean(r) && typeof r === "object"
  );
  const stamped: StoredRecord[] = records.map((r) => {
    redactRecord(r); // 复查脱敏:采集端 redact 之外的兜底(spec §8)
    return { ...r, event_id: ulid(), received_at: new Date().toISOString() };
  });
  let failed = 0;
  for (let i = 0; i < stamped.length; i += CONCURRENCY) {
    const results = await Promise.all(
      stamped.slice(i, i + CONCURRENCY).map((rec) => deps.putter(eventKey(rec, deps.prefix), JSON.stringify(rec)))
    );
    for (const res of results) if (res.status < 200 || res.status >= 300) failed += 1;
  }
  if (failed > 0) return { code: 502, body: { ok: false, failed } };
  return { code: 200, body: { ok: true, accepted: stamped.length } };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/vue/Desktop/CodeFile/vantage/server && node --import tsx --test lambda/ingest.test.ts`
Expected: 4 pass

- [ ] **Step 5: Commit**

```bash
cd /Users/vue/Desktop/CodeFile/vantage
git add server/lambda/ingest.ts server/lambda/ingest.test.ts
git commit -m "Lambda:ingest 模块(脱敏+服务端信封+逐条 PUT S3,并发 10,失败 502)"
```

---

## Task 4: lambda/rebuild.ts(水位线增量重建)

**Files:**
- Modify: `server/src/s3.ts`(listKeys 加可选 startAfter)
- Create: `server/lambda/rebuild.ts`
- Create: `server/lambda/rebuild.test.ts`

- [ ] **Step 1: `server/src/s3.ts` 的 listKeys 支持 startAfter**

把 listKeys 整个函数替换为:

```ts
/** ListObjectsV2 全量翻页,返回 prefix 下全部 key;startAfter 传水位线时只返回其后的新 key。 */
export async function listKeys(
  cfg: S3Config,
  prefix: string,
  startAfter?: string
): Promise<{ status: number; keys: string[] }> {
  const keys: string[] = [];
  let token: string | undefined;
  try {
    do {
      const res = await clientFor(cfg).send(
        new ListObjectsV2Command({
          Bucket: cfg.bucket,
          Prefix: prefix,
          ContinuationToken: token,
          ...(startAfter ? { StartAfter: startAfter } : {}),
        })
      );
      for (const o of res.Contents ?? []) if (o.Key) keys.push(o.Key);
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return { status: 200, keys };
  } catch (e) {
    return { status: statusOf(e), keys };
  }
}
```

调用方兼容检查:`server/scripts/s3-restore.ts` 与 `server/scripts/s3-smoke.ts` 仍按两参调用,行为不变。跑 `node --import tsx --test src/s3.test.ts src/archive.test.ts` 确认全 pass。

- [ ] **Step 2: 写失败测试 `server/lambda/rebuild.test.ts`**

内存假 S3(Map 当对象库,记录 get/put/list 调用)。注意:`now` 用固定值,撞墙事件的 `observed_at` 由 `now` 减偏移构造,任意时区下都与 now 同本地日(now=16:00Z,全球各时区本地时刻都在 04:00 之后,减 1-3 小时不跨日)。

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { runRebuild, type RebuildDeps } from "./rebuild.ts";

const NOW = Date.parse("2026-07-20T16:00:00.000Z");
const iso = (t: number) => new Date(t).toISOString();

function fakeS3(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed));
  const calls = { get: [] as string[], put: [] as string[], list: [] as { prefix: string; startAfter?: string }[] };
  const get = async (key: string) => {
    calls.get.push(key);
    return store.has(key) ? { status: 200, body: store.get(key)! } : { status: 404, body: "" };
  };
  const put = async (key: string, body: string) => {
    store.set(key, body);
    calls.put.push(key);
    return { status: 200 };
  };
  const list = async (prefix: string, startAfter?: string) => {
    calls.list.push({ prefix, startAfter });
    const keys = [...store.keys()]
      .filter((k) => k.startsWith(prefix) && (!startAfter || k > startAfter))
      .sort(); // ListObjectsV2 按字典序返回
    return { status: 200, keys };
  };
  return { store, calls, get, put, list };
}

function depsOf(s3: ReturnType<typeof fakeS3>): RebuildDeps {
  return { get: s3.get, put: s3.put, list: s3.list, prefix: "p/", now: NOW };
}

function ev(rec: object): string {
  return JSON.stringify({ event_id: "e", received_at: iso(NOW - 3600e3), ...rec });
}

test("rebuild: 冷启动全量重放——三事件合并+撞墙,写回三文件(顺序 index→wallhits→view)", async () => {
  const s3 = fakeS3({
    "p/events/dt=2026-07-20/a.json": ev({ dedupe_key: "codex:x", tool: "codex", name: "甲", total_tokens: 100, observed_at: iso(NOW - 3 * 3600e3) }),
    "p/events/dt=2026-07-20/b.json": ev({ dedupe_key: "codex:x", tool: "codex", name: "甲", total_tokens: 150, quota_reached: "primary", observed_at: iso(NOW - 2 * 3600e3) }),
    "p/events/dt=2026-07-20/c.json": ev({ dedupe_key: "claude-code:y", tool: "claude-code", name: "乙", total_tokens: 200, observed_at: iso(NOW - 3600e3) }),
  });
  const r = await runRebuild(depsOf(s3));
  assert.equal(r.rebuilt, true);
  assert.equal(r.newEvents, 3);
  assert.equal(r.watermark, "p/events/dt=2026-07-20/c.json");
  // 写入顺序:index → wallhits → stats-view(watermark 最后生效)
  assert.deepEqual(s3.calls.put.map((k) => k.split("/").pop()), ["index.jsonl", "wallhits.json", "stats-view.json"]);
  const view = JSON.parse(s3.store.get("p/state/stats-view.json")!);
  assert.equal(view.total_sessions, 2); // codex:x 两快照已合并
  const jia = view.users.find((u: any) => u.name === "甲");
  assert.equal(jia.total_tokens, 150); // effective_ts 大者胜
  assert.equal(jia.hit_wall_today, true);
  assert.equal(jia.hit_wall_7d, true);
  const wh = JSON.parse(s3.store.get("p/state/wallhits.json")!);
  assert.equal(wh.length, 1);
  const idx = s3.store.get("p/state/index.jsonl")!.trim().split("\n");
  assert.equal(idx.length, 2);
});

test("rebuild: 无新事件 → 不写任何文件", async () => {
  const s3 = fakeS3({
    "p/events/dt=2026-07-20/a.json": ev({ dedupe_key: "codex:x", tool: "codex", name: "甲" }),
  });
  const deps = depsOf(s3);
  await runRebuild(deps);
  assert.equal(s3.calls.put.length, 3); // 首轮写了三文件
  const r2 = await runRebuild(deps);
  assert.equal(r2.rebuilt, false);
  assert.equal(r2.newEvents, 0);
  assert.equal(s3.calls.put.length, 3); // 第二轮零写入
});

test("rebuild: 增量——LIST 带水位线,只 GET 新 key", async () => {
  const s3 = fakeS3({
    "p/events/dt=2026-07-20/a.json": ev({ dedupe_key: "codex:x", tool: "codex", name: "甲", total_tokens: 1 }),
    "p/events/dt=2026-07-20/b.json": ev({ dedupe_key: "codex:y", tool: "codex", name: "乙", total_tokens: 2 }),
  });
  const deps = depsOf(s3);
  await runRebuild(deps);
  s3.store.set("p/events/dt=2026-07-20/c.json", ev({ dedupe_key: "codex:z", tool: "codex", name: "丙", total_tokens: 3 }));
  const r2 = await runRebuild(deps);
  assert.equal(r2.newEvents, 1);
  assert.equal(r2.watermark, "p/events/dt=2026-07-20/c.json");
  assert.equal(s3.calls.list[1].startAfter, "p/events/dt=2026-07-20/b.json"); // 第二轮 LIST 带水位线
  assert.ok(!s3.calls.get.includes("p/events/dt=2026-07-20/a.json") || s3.calls.get.filter((k) => k === "p/events/dt=2026-07-20/a.json").length === 1);
  const view = JSON.parse(s3.store.get("p/state/stats-view.json")!);
  assert.equal(view.total_sessions, 3);
});

test("rebuild: 水位线回退重放幂等——撞墙不膨胀", async () => {
  const s3 = fakeS3({
    "p/events/dt=2026-07-20/a.json": ev({ dedupe_key: "codex:x", tool: "codex", name: "甲", quota_reached: "primary", observed_at: iso(NOW - 3600e3) }),
  });
  const deps = depsOf(s3);
  await runRebuild(deps);
  // 模拟并发/崩溃导致的水位线回退:把 stats-view 里的 watermark 改回空
  const view = JSON.parse(s3.store.get("p/state/stats-view.json")!);
  s3.store.set("p/state/stats-view.json", JSON.stringify({ ...view, watermark: "" }));
  await runRebuild(deps); // 同一事件被再处理一次
  const wh = JSON.parse(s3.store.get("p/state/wallhits.json")!);
  assert.equal(wh.length, 1); // 撞墙按 (name,at,type) 去重,不膨胀
});

test("rebuild: GET 失败 → 中止,不写任何文件、水位线不动", async () => {
  const s3 = fakeS3({
    "p/events/dt=2026-07-20/a.json": ev({ dedupe_key: "codex:x", tool: "codex", name: "甲" }),
  });
  const deps = depsOf(s3);
  deps.get = async (key: string) => {
    if (key.includes("/events/")) return { status: 500, body: "" };
    return { status: 404, body: "" }; // state 三文件缺失
  };
  await assert.rejects(runRebuild(deps));
  assert.equal(s3.calls.put.length, 0);
});

test("rebuild: LIST 失败 → 抛错", async () => {
  const s3 = fakeS3({});
  const deps = depsOf(s3);
  deps.list = async () => ({ status: 500, keys: [] });
  await assert.rejects(runRebuild(deps));
  assert.equal(s3.calls.put.length, 0);
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd /Users/vue/Desktop/CodeFile/vantage/server && node --import tsx --test lambda/rebuild.test.ts`
Expected: FAIL(找不到 ./rebuild.ts)

- [ ] **Step 4: 创建 `server/lambda/rebuild.ts`**

```ts
// Lambda 重建(算账):水位线增量把新事件并入合并索引,重算 stats-view,spec §5.3。
// 触发方式无关:定时器/手动 invoke//stats 读时都调这一个函数。
// 写入顺序 index → wallhits → stats-view:watermark 随 view 最后生效,崩溃只导致重复处理(幂等),不丢事件。
import { createMergeState, mergeInto, type StoredRecord, type WallHit } from "../src/merge.ts";
import { buildStats } from "../src/stats.ts";

export interface RebuildDeps {
  get: (key: string) => Promise<{ status: number; body: string }>;
  put: (key: string, body: string) => Promise<{ status: number }>;
  list: (prefix: string, startAfter?: string) => Promise<{ status: number; keys: string[] }>;
  prefix: string; // 桶内前缀(已归一化,带尾斜杠;空串=桶根)
  now?: number; // 注入用(测试),默认 Date.now()
}

export interface RebuildResult {
  rebuilt: boolean; // 本次是否写回了 state
  newEvents: number;
  skipped: number; // 损坏行数
  watermark: string;
}

const GET_CONCURRENCY = 50;

function ok2xx(status: number): boolean {
  return status >= 200 && status < 300;
}

export async function runRebuild(deps: RebuildDeps): Promise<RebuildResult> {
  const p = deps.prefix;
  const now = deps.now ?? Date.now();
  // 1. 读 state 三文件(404 视为空)
  const [viewRes, indexRes, wallRes] = await Promise.all([
    deps.get(`${p}state/stats-view.json`),
    deps.get(`${p}state/index.jsonl`),
    deps.get(`${p}state/wallhits.json`),
  ]);
  const watermark = viewRes.status === 200 ? ((JSON.parse(viewRes.body).watermark as string) ?? "") : "";
  const state = createMergeState();
  if (indexRes.status === 200) {
    for (const line of indexRes.body.split("\n")) {
      if (!line.trim()) continue;
      try {
        mergeInto(state, JSON.parse(line) as StoredRecord);
      } catch {
        // 跳过损坏行
      }
    }
  }
  if (wallRes.status === 200) {
    try {
      for (const wh of JSON.parse(wallRes.body) as WallHit[]) {
        const wk = `${wh.name} ${wh.at} ${wh.type}`;
        if (!state.wallHitKeys.has(wk)) {
          state.wallHitKeys.add(wk);
          state.wallHits.push(wh);
        }
      }
    } catch {
      // wallhits 损坏视同空(撞墙会随事件重放重新留痕)
    }
  }
  // 2. LIST 水位线之后的新事件 key
  const listRes = await deps.list(`${p}events/`, watermark || undefined);
  if (listRes.status !== 200) throw new Error(`LIST events 失败 status=${listRes.status}`);
  const newKeys = listRes.keys;
  // 3. GET 新事件;任一失败 → 中止(不写文件,水位线不动,下轮重试不丢)
  const bodies: string[] = [];
  for (let i = 0; i < newKeys.length; i += GET_CONCURRENCY) {
    const batch = await Promise.all(newKeys.slice(i, i + GET_CONCURRENCY).map((k) => deps.get(k)));
    for (const r of batch) {
      if (r.status !== 200) throw new Error(`GET event 失败 status=${r.status}`);
      bodies.push(r.body);
    }
  }
  let skipped = 0;
  for (const body of bodies) {
    try {
      mergeInto(state, JSON.parse(body) as StoredRecord);
    } catch {
      skipped += 1;
    }
  }
  const newWatermark = newKeys.length ? newKeys[newKeys.length - 1] : watermark;
  // 4. 有新事件或 stats-view 缺失 → 重算并按序写回
  if (newKeys.length > 0 || viewRes.status !== 200) {
    const view = {
      ...buildStats([...state.index.values()], state.wallHits, now),
      watermark: newWatermark,
      rebuilt_at: new Date(now).toISOString(),
    };
    const indexLines = [...state.index.values()].map((r) => JSON.stringify(r));
    const indexBody = indexLines.length ? indexLines.join("\n") + "\n" : "";
    const p1 = await deps.put(`${p}state/index.jsonl`, indexBody);
    if (!ok2xx(p1.status)) throw new Error(`PUT index.jsonl 失败 status=${p1.status}`);
    const p2 = await deps.put(`${p}state/wallhits.json`, JSON.stringify(state.wallHits));
    if (!ok2xx(p2.status)) throw new Error(`PUT wallhits.json 失败 status=${p2.status}`);
    const p3 = await deps.put(`${p}state/stats-view.json`, JSON.stringify(view));
    if (!ok2xx(p3.status)) throw new Error(`PUT stats-view.json 失败 status=${p3.status}`);
    return { rebuilt: true, newEvents: newKeys.length, skipped, watermark: newWatermark };
  }
  return { rebuilt: false, newEvents: 0, skipped, watermark };
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd /Users/vue/Desktop/CodeFile/vantage/server && node --import tsx --test lambda/rebuild.test.ts`
Expected: 6 pass

- [ ] **Step 6: Commit**

```bash
cd /Users/vue/Desktop/CodeFile/vantage
git add server/src/s3.ts server/lambda/rebuild.ts server/lambda/rebuild.test.ts
git commit -m "Lambda:rebuild 水位线增量重建(state 三文件,写序 index→wallhits→view);listKeys 支持 startAfter"
```

---

## Task 5: lambda/handler.ts(路由 + stats 读路径)

**Files:**
- Create: `server/lambda/handler.ts`
- Create: `server/lambda/handler.test.ts`
- Modify: `server/package.json`(test 脚本加新测试文件)

- [ ] **Step 1: 写失败测试 `server/lambda/handler.test.ts`**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "./handler.ts";
import type { RebuildDeps } from "./rebuild.ts";

const TOKEN = "t-123";
const AUTH = { authorization: `Bearer ${TOKEN}` };

function fakeDeps(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed));
  const get = async (key: string) => (store.has(key) ? { status: 200, body: store.get(key)! } : { status: 404, body: "" });
  const put = async (key: string, body: string) => {
    store.set(key, body);
    return { status: 200 };
  };
  const list = async (prefix: string, startAfter?: string) => ({
    status: 200,
    keys: [...store.keys()].filter((k) => k.startsWith(prefix) && (!startAfter || k > startAfter)).sort(),
  });
  const deps: RebuildDeps & { store: Map<string, string> } = { get, put, list, prefix: "", now: Date.now(), store };
  return deps;
}

const postIngest = (body: unknown) => ({
  requestContext: { http: { method: "POST" } },
  rawPath: "/ingest",
  headers: AUTH,
  body: JSON.stringify(body),
});
const getStats = { requestContext: { http: { method: "GET" } }, rawPath: "/stats", headers: AUTH };

test("GET /health 不鉴权", async () => {
  const h = createHandler(fakeDeps(), TOKEN);
  const r = await h({ requestContext: { http: { method: "GET" } }, rawPath: "/health" });
  assert.equal(r.statusCode, 200);
});

test("/ingest 与 /stats 无 token → 401;未知路由 → 404", async () => {
  const h = createHandler(fakeDeps(), TOKEN);
  const r1 = await h({ ...postIngest({ a: 1 }), headers: {} });
  assert.equal(r1.statusCode, 401);
  const r2 = await h({ requestContext: { http: { method: "GET" } }, rawPath: "/stats", headers: {} });
  assert.equal(r2.statusCode, 401);
  const r3 = await h({ requestContext: { http: { method: "GET" } }, rawPath: "/nope", headers: AUTH });
  assert.equal(r3.statusCode, 404);
});

test("全链路:ingest → action:rebuild → /stats 返回报表+watermark+rebuilt_at", async () => {
  const h = createHandler(fakeDeps(), TOKEN);
  const ri = await h(postIngest({ tool: "codex", session_id: "s1", dedupe_key: "codex:s1", name: "甲", total_tokens: 100 }));
  assert.equal(ri.statusCode, 200);
  assert.equal(JSON.parse(ri.body).accepted, 1);
  const rr = await h({ action: "rebuild" });
  assert.equal(rr.statusCode, 200);
  assert.equal(JSON.parse(rr.body).newEvents, 1);
  const rs = await h(getStats);
  assert.equal(rs.statusCode, 200);
  const view = JSON.parse(rs.body);
  assert.equal(view.total_sessions, 1);
  assert.equal(view.users[0].name, "甲");
  assert.ok(view.watermark.includes("events/"));
  assert.ok(view.rebuilt_at);
});

test("/stats 缺 stats-view 时自动全量重建(冷启动)", async () => {
  const deps = fakeDeps();
  const h = createHandler(deps, TOKEN);
  await h(postIngest({ tool: "codex", session_id: "s9", dedupe_key: "codex:s9", name: "乙" }));
  const rs = await h(getStats); // 未显式 rebuild,/stats 内部先增量追平
  assert.equal(rs.statusCode, 200);
  assert.equal(JSON.parse(rs.body).total_sessions, 1);
});

test("/stats:rebuild 失败但有旧 view → 返回旧数据;无旧 view → 503", async () => {
  const deps = fakeDeps();
  const h = createHandler(deps, TOKEN);
  deps.list = async () => ({ status: 500, keys: [] }); // rebuild 必败
  const r1 = await h(getStats);
  assert.equal(r1.statusCode, 503);
  await deps.put("state/stats-view.json", JSON.stringify({ total_sessions: 9, users: [], model_stats: [], watermark: "w", rebuilt_at: "old" }));
  const r2 = await h(getStats);
  assert.equal(r2.statusCode, 200);
  assert.equal(JSON.parse(r2.body).total_sessions, 9); // 旧数据兜底,rebuilt_at 暴露陈旧
});

test("/ingest 支持 base64 body;坏 JSON → 400", async () => {
  const h = createHandler(fakeDeps(), TOKEN);
  const b64 = Buffer.from(JSON.stringify({ tool: "codex", session_id: "b1", dedupe_key: "codex:b1" })).toString("base64");
  const r1 = await h({ requestContext: { http: { method: "POST" } }, rawPath: "/ingest", headers: AUTH, isBase64Encoded: true, body: b64 });
  assert.equal(r1.statusCode, 200);
  const r2 = await h({ requestContext: { http: { method: "POST" } }, rawPath: "/ingest", headers: AUTH, body: "{oops" });
  assert.equal(r2.statusCode, 400);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/vue/Desktop/CodeFile/vantage/server && node --import tsx --test lambda/handler.test.ts`
Expected: FAIL(找不到 ./handler.ts)

- [ ] **Step 3: 创建 `server/lambda/handler.ts`**

```ts
// Lambda 入口(handler = index.handler):一个函数三条路由,spec §5.1。
// createHandler 依赖注入便于测试;默认 handler 用真 S3(env 配置)。
import { timingSafeEqual } from "node:crypto";
import { s3ConfigFromEnv, getObject, putObject, listKeys } from "../src/s3.ts";
import { ingest } from "./ingest.ts";
import { runRebuild, type RebuildDeps } from "./rebuild.ts";

type HeaderMap = Record<string, string | undefined>;

interface LambdaResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

function jsonResponse(code: number, body: unknown): LambdaResponse {
  return { statusCode: code, headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body) };
}

export function createHandler(deps: RebuildDeps, token: string) {
  function authorized(headers: HeaderMap): boolean {
    const auth = String(headers?.authorization ?? headers?.Authorization ?? "");
    const a = Buffer.from(auth.replace(/^Bearer\s+/i, ""));
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async function statsView(): Promise<LambdaResponse> {
    try {
      await runRebuild(deps); // 读时增量追平(无新事件≈一次 LIST)
    } catch (e) {
      // 重建失败:有旧 view 返回旧数据(rebuilt_at 暴露陈旧),否则 503
      const stale = await deps.get(`${deps.prefix}state/stats-view.json`);
      if (stale.status === 200) {
        return { statusCode: 200, headers: { "content-type": "application/json; charset=utf-8" }, body: stale.body };
      }
      return jsonResponse(503, { ok: false, error: String(e) });
    }
    const view = await deps.get(`${deps.prefix}state/stats-view.json`);
    if (view.status !== 200) return jsonResponse(503, { ok: false, error: "stats-view unavailable" });
    return { statusCode: 200, headers: { "content-type": "application/json; charset=utf-8" }, body: view.body };
  }

  return async function handler(event: any): Promise<LambdaResponse> {
    try {
      // 定时器(EventBridge)/ 手动 invoke 预热入口
      if (event?.source === "aws.events" || event?.action === "rebuild") {
        const r = await runRebuild(deps);
        return jsonResponse(200, { ok: true, ...r });
      }
      const method: string = event?.requestContext?.http?.method ?? "";
      const path: string = event?.rawPath ?? "";
      if (method === "GET" && path === "/health") return jsonResponse(200, { ok: true });

      if (method === "POST" && path === "/ingest") {
        if (!authorized(event?.headers ?? {})) return jsonResponse(401, { ok: false, error: "unauthorized" });
        const raw = event?.isBase64Encoded
          ? Buffer.from(event?.body ?? "", "base64").toString("utf8")
          : (event?.body ?? "");
        let payload: unknown;
        try {
          payload = JSON.parse(raw);
        } catch {
          return jsonResponse(400, { ok: false, error: "invalid json" });
        }
        const r = await ingest(payload, { putter: deps.put, prefix: deps.prefix });
        return jsonResponse(r.code, r.body);
      }

      if (method === "GET" && path === "/stats") {
        if (!authorized(event?.headers ?? {})) return jsonResponse(401, { ok: false, error: "unauthorized" });
        return statsView();
      }

      return jsonResponse(404, { ok: false, error: "not found" });
    } catch (err) {
      return jsonResponse(500, { ok: false, error: String(err) });
    }
  };
}

// 默认入口:env 配置真 S3。INGEST_TOKEN 与 ingest/stats 共用(同 Node 壳现状)。
const cfg = s3ConfigFromEnv();
export const handler = createHandler(
  {
    get: (key) => getObject(cfg, key),
    put: (key, body) => putObject(cfg, key, body),
    list: (prefix, startAfter) => listKeys(cfg, prefix, startAfter),
    prefix: cfg.prefix,
  },
  process.env.INGEST_TOKEN ?? "dev-token-change-me"
);
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/vue/Desktop/CodeFile/vantage/server && node --import tsx --test lambda/handler.test.ts`
Expected: 6 pass

- [ ] **Step 5: `server/package.json` test 脚本加入新测试文件**

把 test 脚本整行替换为:

```json
    "test": "node --import tsx --test src/ulid.test.ts src/redact.test.ts src/store.test.ts src/s3.test.ts src/archive.test.ts src/merge.test.ts src/stats.test.ts lambda/ingest.test.ts lambda/rebuild.test.ts lambda/handler.test.ts",
```

Run: `cd /Users/vue/Desktop/CodeFile/vantage/server && npm test`
Expected: 全 pass(27 旧 + 3 merge + 3 stats + 4 ingest + 6 rebuild + 6 handler ≈ 49)

- [ ] **Step 6: Commit**

```bash
cd /Users/vue/Desktop/CodeFile/vantage
git add server/lambda/handler.ts server/lambda/handler.test.ts server/package.json
git commit -m "Lambda:handler 路由(createHandler 依赖注入;ingest/stats/rebuild 三入口;stats 读时增量+旧数据兜底)"
```

---

## Task 6: build:lambda(esbuild 单文件打包)

**Files:**
- Modify: `server/package.json`(scripts.build:lambda + devDependencies.esbuild)
- Modify: `server/.gitignore`(没有则新建)

- [ ] **Step 1: 装 esbuild**

Run: `cd /Users/vue/Desktop/CodeFile/vantage/server && npm i -D esbuild`
Expected: package.json devDependencies 出现 `"esbuild": "^0.x"`

- [ ] **Step 2: package.json 加打包脚本**

在 scripts 里加一行(`restore:s3` 之后):

```json
    "build:lambda": "esbuild lambda/handler.ts --bundle --platform=node --target=node20 --format=esm --outfile=dist/lambda/index.mjs"
```

- [ ] **Step 3: gitignore 忽略产物**

Run:

```bash
cd /Users/vue/Desktop/CodeFile/vantage/server
[ -f .gitignore ] && grep -qx "dist/" .gitignore || echo "dist/" >> .gitignore
cat .gitignore
```

Expected: 输出含 `dist/`

- [ ] **Step 4: 构建并冒烟**

Run: `cd /Users/vue/Desktop/CodeFile/vantage/server && npm run build:lambda && ls -lh dist/lambda/index.mjs`
Expected: 文件存在,体积约 1-3MB(含 @aws-sdk/client-s3)

Run: `cd /Users/vue/Desktop/CodeFile/vantage/server && node -e "import('./dist/lambda/index.mjs').then(m=>console.log(typeof m.handler))"`
Expected: 输出 `function`(bundle 自包含,可直接 import 且不抛错——env 缺失只是 S3 停用,不影响加载)

- [ ] **Step 5: Commit**

```bash
cd /Users/vue/Desktop/CodeFile/vantage
git add server/package.json server/package-lock.json server/.gitignore
git commit -m "Lambda:esbuild 单文件打包(npm run build:lambda -> dist/lambda/index.mjs,自包含 aws-sdk)"
```

---

## Task 7: E2E T33-T35(fake-s3 升级 + lambda-driver + 三个测试)

**Files:**
- Modify: `tests/fake-s3.cjs`(LIST 排序 + start-after + 可选读日志)
- Create: `tests/lambda-driver.mjs`
- Modify: `tests/run-tests.sh`(cleanup 加端口 + 追加 T33/T34/T35)

- [ ] **Step 1: 升级 `tests/fake-s3.cjs`(PUT 日志格式不动,T27/T30 不受影响)**

两处编辑:

1) 第 11 行参数解析改为(加可选第三参数 readLogPath):

```js
const [port, logPath, readLogPath] = process.argv.slice(2);
```

2) GET 分支整块替换为(LIST 排序 + start-after + 读日志):

```js
      if (req.method === "GET") {
        if (readLogPath) fs.appendFileSync(readLogPath, JSON.stringify({ method: "GET", url: req.url }) + "\n");
        const u = new URL(req.url, "http://x");
        const parts = u.pathname.split("/").filter(Boolean); // [bucket] => LIST;[bucket, key...] => GET object
        if (parts.length <= 1) {
          // ListObjectsV2:回放全部 key(解码后,按字典序——真实 S3 即字典序),支持 prefix 与 start-after
          const prefix = u.searchParams.get("prefix") || "";
          const startAfter = u.searchParams.get("start-after") || "";
          let keys = [...objects.keys()]
            .map((p) => p.split("/").slice(2).join("/")) // path-style:/bucket/key... -> 去 "" 与 bucket
            .map((k) => decodeURIComponent(k)) // %3D -> =(真实 key)
            .sort();
          if (prefix) keys = keys.filter((k) => k.startsWith(prefix));
          if (startAfter) keys = keys.filter((k) => k > startAfter);
          const xml =
            '<?xml version="1.0" encoding="UTF-8"?>' +
            '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
            `<KeyCount>${keys.length}</KeyCount><IsTruncated>false</IsTruncated>` +
            keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join("") +
            "</ListBucketResult>";
          res.writeHead(200, { "content-type": "application/xml" });
          res.end(xml);
          return;
        }
        // GET object:raw path 与 PUT 时一致(SDK 同一套编码,= -> %3D)
        const body = objects.get(raw);
        if (body == null) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(body);
        return;
      }
```

- [ ] **Step 2: 创建 `tests/lambda-driver.mjs`**

```js
// E2E 驱动:把一个事件 JSON 文件喂给 Lambda handler,stdout 打印响应 JSON。
// 用法: node --import tsx tests/lambda-driver.mjs <事件JSON文件路径>
// 每次调用都是新进程 = Lambda 冷启动语义(env 由调用方给)。
import { readFileSync } from "node:fs";

const event = JSON.parse(readFileSync(process.argv[2], "utf8"));
const { handler } = await import("../server/lambda/handler.ts");
const res = await handler(event);
process.stdout.write(JSON.stringify(res));
```

- [ ] **Step 3: `tests/run-tests.sh` cleanup 加端口**

把两处 `killp 3971 3972 4971`(注释行除外)出现的 cleanup 行:

```bash
cleanup() { [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null; kill_port; killp 3971 3972 4971; rm -rf "$WORK"; }
```

改为:

```bash
cleanup() { [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null; kill_port; killp 3971 3972 4971 4972; rm -rf "$WORK"; }
```

- [ ] **Step 4: 在 run-tests.sh 末尾(`echo` 总结行之前)追加 T33-T35**

注意:以下辅助函数只被 T33-T35 用,追加在 T32 之后即可。`mkpost/mkget/mkev` 用 node 构造事件文件,避免 bash 嵌套转义。`LD` 每次调用是新进程(冷启动语义),必须 `cd server` 让 tsx 可解析。

```bash
echo ""
echo "== T33-T35: Lambda 路径(ingest→rebuild→stats,fake-s3 往返,水位线增量) =="
LFAKE=4972; LFAKE_LOG="$WORK/lfake-put.jsonl"; LREAD_LOG="$WORK/lfake-read.jsonl"
killp "$LFAKE"
node "$SCRIPT_DIR/fake-s3.cjs" "$LFAKE" "$LFAKE_LOG" "$LREAD_LOG" &
sleep 0.3
# 调一次 Lambda(每次新进程=冷启动;env 指向 fake-s3,前缀 lt/)
LD() { ( cd "$REPO/server" && \
  VANTAGE_S3_BUCKET="test-bucket" VANTAGE_S3_PREFIX="lt" VANTAGE_S3_REGION="us-east-1" \
  VANTAGE_S3_ENDPOINT="http://localhost:$LFAKE" AWS_ACCESS_KEY_ID="x" AWS_SECRET_ACCESS_KEY="y" \
  INGEST_TOKEN="$TOKEN" node --import tsx "$SCRIPT_DIR/lambda-driver.mjs" "$1" 2>>"$WORK/lambda-driver.err" ); }
mkpost(){ node -e 'const fs=require("fs");fs.writeFileSync(process.argv[3],JSON.stringify({requestContext:{http:{method:"POST"}},rawPath:"/ingest",headers:{authorization:"Bearer "+process.argv[1]},body:process.argv[2]}))' "$TOKEN" "$1" "$2"; }
mkget(){ node -e 'const fs=require("fs");fs.writeFileSync(process.argv[2],JSON.stringify({requestContext:{http:{method:"GET"}},rawPath:"/stats",headers:{authorization:"Bearer "+process.argv[1]}}))' "$TOKEN" "$1"; }
mkev(){ node -e 'require("fs").writeFileSync(process.argv[2],process.argv[1])' "$1" "$2"; }
jget(){ node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s)[process.argv[1]])))' "$1"; }         # 顶层字段
jbod(){ node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(JSON.parse(s).body);process.stdout.write(String(v[process.argv[1]]))})' "$1"; } # body 内字段
ulam(){ node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(JSON.parse(s).body);const u=(v.users||[]).find(x=>x.name===process.argv[1]);process.stdout.write(u==null?"MISSING":String(u[process.argv[2]]))})' "$1" "$2"; } # users[姓名].字段

echo "-- T33: 显式 rebuild 全链路(合并+额度) --"
LX="t33-$(date +%s)"
mkpost "{\"tool\":\"codex\",\"session_id\":\"$LX\",\"dedupe_key\":\"codex:$LX\",\"name\":\"λ甲\",\"total_tokens\":100,\"observed_at\":\"$(iso_local 9)\"}" "$WORK/le1.json"
mkpost "{\"tool\":\"codex\",\"session_id\":\"$LX\",\"dedupe_key\":\"codex:$LX\",\"name\":\"λ甲\",\"total_tokens\":150,\"quota_primary_pct\":88,\"observed_at\":\"$(iso_local 10)\"}" "$WORK/le2.json"
mkpost "{\"tool\":\"claude-code\",\"session_id\":\"$LX-c\",\"dedupe_key\":\"claude-code:$LX-c\",\"name\":\"λ乙\",\"total_tokens\":200,\"observed_at\":\"$(iso_local 9 30)\"}" "$WORK/le3.json"
mkev "{\"action\":\"rebuild\"}" "$WORK/lrb.json"
A1="$(LD "$WORK/le1.json")"; A2="$(LD "$WORK/le2.json")"; A3="$(LD "$WORK/le3.json")"
assert "T33 ingest#1 200"        "200" "$(echo "$A1" | jget statusCode)"
assert "T33 ingest#3 200"        "200" "$(echo "$A3" | jget statusCode)"
RB="$(LD "$WORK/lrb.json")"
assert "T33 rebuild newEvents=3" "3"   "$(echo "$RB" | jbod newEvents)"
mkget "$WORK/lst.json"; ST="$(LD "$WORK/lst.json")"
assert "T33 stats 200"           "200" "$(echo "$ST" | jget statusCode)"
assert "T33 会话=2(同会话已合并)" "2"   "$(echo "$ST" | jbod total_sessions)"
assert "T33 甲 token=150(取最新)" "150" "$(echo "$ST" | ulam "λ甲" total_tokens)"
assert "T33 甲 当前额度=88"       "88"  "$(echo "$ST" | ulam "λ甲" quota_primary_pct)"
assert "T33 watermark 非空"       "1"   "$(echo "$ST" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(JSON.parse(s).body).watermark?"1":"0"))')"

echo "-- T34: 撞墙历史(撞墙→窗口刷新→/stats 仍记得;/stats 读时自动追平) --"
LW="t34-$(date +%s)"
mkpost "{\"tool\":\"codex\",\"session_id\":\"$LW\",\"dedupe_key\":\"codex:$LW\",\"name\":\"λ墙\",\"quota_primary_pct\":100,\"quota_reached\":\"primary\",\"quota_plan\":\"plus\",\"observed_at\":\"$(iso_local 10)\"}" "$WORK/lw1.json"
mkpost "{\"tool\":\"codex\",\"session_id\":\"$LW\",\"dedupe_key\":\"codex:$LW\",\"name\":\"λ墙\",\"quota_primary_pct\":30,\"quota_reached\":null,\"quota_plan\":\"plus\",\"observed_at\":\"$(iso_local 15)\"}" "$WORK/lw2.json"
LD "$WORK/lw1.json" >/dev/null; LD "$WORK/lw2.json" >/dev/null
mkget "$WORK/lws.json"; WST="$(LD "$WORK/lws.json")"   # 不显式 rebuild,/stats 内部先增量追平
assert "T34 当前额度=30(窗口已刷新)" "30"   "$(echo "$WST" | ulam "λ墙" quota_primary_pct)"
assert "T34 当前未撞墙"              "null" "$(echo "$WST" | ulam "λ墙" quota_reached)"
assert "T34 仍记得今天撞过墙"        "true" "$(echo "$WST" | ulam "λ墙" hit_wall_today)"
assert "T34 本周撞墙"                "true" "$(echo "$WST" | ulam "λ墙" hit_wall_7d)"

echo "-- T35: 水位线增量(只读新事件;LIST 带 start-after) --"
R1="$(LD "$WORK/lrb.json")"   # T33/T34 已追平,应 0 条新事件
assert "T35 无新事件 newEvents=0" "0" "$(echo "$R1" | jbod newEvents)"
mkpost "{\"tool\":\"codex\",\"session_id\":\"$LX-z\",\"dedupe_key\":\"codex:$LX-z\",\"name\":\"λ丙\",\"total_tokens\":5,\"observed_at\":\"$(iso_local 16)\"}" "$WORK/lz1.json"
LD "$WORK/lz1.json" >/dev/null
R2="$(LD "$WORK/lrb.json")"
assert "T35 第二轮只读 1 条新事件" "1" "$(echo "$R2" | jbod newEvents)"
NSA="$(grep -c 'start-after' "$LREAD_LOG" 2>/dev/null || true)"
[ "${NSA:-0}" -ge 1 ] && ok "T35 增量 LIST 带 start-after" || no "T35 LIST start-after" ">=1" "${NSA:-0}"
mkget "$WORK/lfs.json"; FST="$(LD "$WORK/lfs.json")"
assert "T35 累计会话=4(2+1+1)" "4" "$(echo "$FST" | jbod total_sessions)"
killp "$LFAKE"
```

- [ ] **Step 5: 跑全套 E2E**

Run: `cd /Users/vue/Desktop/CodeFile/vantage && bash tests/run-tests.sh`
Expected: T1-T35 全 PASS,FAIL=0(断言总数 > 86;若 T33-35 失败,先看 `$WORK` 已清理,改在 LD 加 `echo` 或查看 stderr 日志 `lambda-driver.err`——但 WORK 被 trap 删了,调试时先注释 trap,修复后恢复)

- [ ] **Step 6: Commit**

```bash
cd /Users/vue/Desktop/CodeFile/vantage
git add tests/fake-s3.cjs tests/lambda-driver.mjs tests/run-tests.sh
git commit -m "测试:T33-T35 Lambda 路径 E2E(全链路/撞墙/水位线增量)+ fake-s3 支持 start-after 与读日志"
```

---

## Task 8: 部署文档 + README 已知边界

**Files:**
- Create: `docs/lambda-deploy.md`
- Modify: `README.md`(已知边界追加三条)

- [ ] **Step 1: 创建 `docs/lambda-deploy.md`**

```markdown
# Vantage Lambda 部署指南(cn-north-1)

生产架构:员工采集器 → Lambda Function URL → S3(events/ 账本 + state/ 视图)。设计见 `docs/superpowers/specs/2026-07-20-lambda-migration-design.md`。桶:`lrm-s3-store`,前缀 `vantage-prod/`。

## 0. 前置:桶冒烟(必过)

```bash
cd server
VANTAGE_S3_BUCKET=lrm-s3-store VANTAGE_S3_PREFIX=vantage-prod VANTAGE_S3_REGION=cn-north-1 \
AWS_ACCESS_KEY_ID=<lvhongfei 的 AccessKeyId> AWS_SECRET_ACCESS_KEY=<Secret> \
npm run smoke:s3
```

PUT/GET/LIST 三行全绿再继续。

## 1. 建 IAM 执行角色

IAM → 角色 → 创建:信任实体 `lambda.amazonaws.com`。内联策略(与冒烟同一份):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject"],
      "Resource": "arn:aws-cn:s3:::lrm-s3-store/vantage-prod/*"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws-cn:s3:::lrm-s3-store",
      "Condition": { "StringLike": { "s3:prefix": ["vantage-prod/*"] } }
    }
  ]
}
```

另挂托管策略 `AWSLambdaBasicExecutionRole`(写 CloudWatch 日志)。角色名建议 `vantage-lambda-role`。**Lambda 用角色,不用 Access Key。**

## 2. 打包

```bash
cd server
npm install
npm run build:lambda        # -> dist/lambda/index.mjs
cd dist/lambda && zip vantage-lambda.zip index.mjs
```

## 3. 建函数

Lambda 控制台(cn-north-1)→ 创建函数:从头创作,名称 `vantage-backend`,运行时 **Node.js 20.x**,架构 x86_64。创建后:

- 代码:上传 `vantage-lambda.zip`;处理程序填 `index.handler`
- 配置 → 常规:内存 1024 MB,超时 15 分钟(900s,全量重放兜底)
- 配置 → 环境变量:

| 键 | 值 |
|---|---|
| `VANTAGE_S3_BUCKET` | `lrm-s3-store` |
| `VANTAGE_S3_PREFIX` | `vantage-prod` |
| `VANTAGE_S3_REGION` | `cn-north-1` |
| `INGEST_TOKEN` | `<专属密钥,与采集端 config 一致>` |
| `TZ` | `Asia/Shanghai` |

- 配置 → 权限:执行角色选 `vantage-lambda-role`

## 4. 开 Function URL

函数 → 配置 → 函数 URL → 创建,授权类型 **NONE**(应用层 Bearer 校验,与现状一致)。得到 `https://<id>.lambda-url.cn-north-1.on.cn/`。

验证:

```bash
curl -s https://<URL>/health                                   # {"ok":true}
curl -s -X POST https://<URL>/ingest -H "Authorization: Bearer <密钥>" \
  -H "content-type: application/json" \
  -d '{"tool":"codex","session_id":"smoke-1","dedupe_key":"codex:smoke-1","name":"冒烟","total_tokens":1}'
curl -s https://<URL>/stats -H "Authorization: Bearer <密钥>"   # users 里出现 冒烟
```

## 5. (可选,用户自理)定时预热重建

/stats 每次读都会自动增量追平,不配定时器系统也完整可用。若要看板秒开:EventBridge → 规则 → 计划(rate 自定,如 10 分钟)→ 目标 = 本 Lambda 函数。

## 6. 员工切换

采集端 `server_url` 换成函数 URL,token 不变,重跑 setup 即切换。无历史数据需迁移(切换前未上线)。

## 排障

- CloudWatch 日志组 `/aws/lambda/vantage-backend`,错误都带 stack。
- state/ 三文件可整体删除——下次 rebuild 会从 events/ 全量重建,不丢数据。
- ingest 502:S3 策略没生效,回第 1 步核对 arn(aws-cn 前缀!)与角色绑定。
```

- [ ] **Step 2: README.md 已知边界追加**

在 README 的「已知限制/已知边界」一节(现有一条"改名后撞墙历史按旧名归因会丢失")追加:

```markdown
- (Lambda 形态)`state/index.jsonl` 为单文件合并索引,随使用增长;1GB 内存约撑 2 年重度使用,到期需把老会话折叠进 per-user 累计器(另立项)。
- (Lambda 形态)采集端重试会产生重复事件文件(不同 event_id、同 dedupe_key),合并结果正确但多占存储;量小,不处理。
- (Lambda 形态)事件为大量小 JSON 文件(每年约百万级),S3 对此无感;如需可配生命周期转 Glacier 或做月度压缩,不影响热路径。
```

- [ ] **Step 3: Commit**

```bash
cd /Users/vue/Desktop/CodeFile/vantage
git add docs/lambda-deploy.md README.md
git commit -m "文档:Lambda 部署指南(角色/打包/函数/Function URL/冒烟)+ README 补 Lambda 形态已知边界"
```

---

## Task 9: 全量验证收尾

- [ ] **Step 1: 单测全绿**

Run: `cd /Users/vue/Desktop/CodeFile/vantage/server && npm test`
Expected: 全 pass(约 49 个),0 fail

- [ ] **Step 2: E2E 全绿**

Run: `cd /Users/vue/Desktop/CodeFile/vantage && bash tests/run-tests.sh`
Expected: T1-T35 全 PASS,FAIL=0

- [ ] **Step 3: 打包验证**

Run: `cd /Users/vue/Desktop/CodeFile/vantage/server && npm run build:lambda && node -e "import('./dist/lambda/index.mjs').then(m=>console.log(typeof m.handler))"`
Expected: 构建成功 + 输出 `function`

- [ ] **Step 4: 工作区干净确认 + 如需补提交**

Run: `cd /Users/vue/Desktop/CodeFile/vantage && git status --short`
Expected: 干净(除 dist/ 等已忽略产物);若有遗漏文件,审视后补提交。

---

## 自审记录(计划作者)

- Spec 覆盖:§4 抽取 → Task 1/2 ✓;§5.2 ingest → Task 3 ✓;§5.3 rebuild + startAfter → Task 4 ✓;§5.1/5.4 handler+stats → Task 5 ✓;§6 配置 → Task 8 部署文档 ✓;§7 测试(回归/单测/E2E T33-35/fake-s3 start-after)→ Task 1-7 ✓;§8 部署 → Task 8 ✓;§9 边界 → Task 8 README ✓。smoke:s3 为既有脚本,部署文档第 0 步引用 ✓。
- 类型一致性:`RebuildDeps{get,put,list,prefix,now?}` 在 rebuild/handler/两处测试一致;`list(prefix, startAfter?)` 与 s3.ts `listKeys(cfg,prefix,startAfter?)` 对齐;`ingest(payload,{putter,prefix})` 一致;`eventKey(rec,prefix)` 一致;`MergeState{index,wallHits,wallHitKeys}` 一致;`buildStats(sessions,wallHits,now)` 一致。
- 兼容:store.ts 对外接口(upsert/allSessions/allWallHits/dayKeyLocal/effectiveTs/jsonlPath + 类型 re-export)不变,index.ts/archive.ts/测试 import 不动;fake-s3 PUT 日志格式不动(T27/T30 依赖),读日志为可选第三参数。
