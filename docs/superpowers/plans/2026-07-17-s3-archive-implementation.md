# S3 Append-Only 归档实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 `docs/superpowers/specs/2026-07-17-s3-storage-design.md` 实现：每次上报归档为 S3 不可变 event，回放合并改按 effective_ts，撞墙历史永不丢。

**Architecture:** 服务端是唯一写入者。/ingest 行为不变（本地 JSONL + 内存索引）先行 ACK，之后异步 PUT 到 S3 `events/dt=<received_at日期>/`；对账器按字节 offset 扫本地 JSONL 幂等补传；合并规则从"无条件后到覆盖"改为"effective_ts 大者胜"。零运行时依赖（SigV4 手写，node 内置模块），未配置 S3 环境变量时行为与现状完全一致。

**Tech Stack:** Node.js + tsx（server，ESM/TS）、CommonJS 零依赖（plugin agent）、node:test（单元测试）、bash E2E（tests/run-tests.sh）。

**关键既有事实（执行者必读）:**
- 采集端**已经在发** `collected_at`(capture.cjs:74、reconcile.cjs:215)，本计划把它更名为 `observed_at`，服务端回退兼容旧字段名。
- 服务端零依赖、`node:http` 手写、`timingSafeEqual` 鉴权；单元测试用 `node --import tsx --test`。
- E2E 套件 `tests/run-tests.sh` 已有 T1-T24，新增 T25/T26/T27；`tests/qserver.cjs` 直接读 JSONL 按行序 last-wins 折叠（与服务端新合并规则不同，涉及合并的断言要走 /stats)。
- spec §7 views v1 不做；bucket/IAM 创建是用户手工步骤，落在 docs/s3-setup.md。
- 每次任务后跑 `cd server && npm test`；改 E2E 的任务后跑 `bash tests/run-tests.sh`（约 1-2 分钟）。

---

### Task 1: ULID 生成器

**Files:**
- Create: `server/src/ulid.ts`
- Test: `server/src/ulid.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// server/src/ulid.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ulid } from "./ulid.ts";

test("ulid: 26 字符、Crockford 字符集", () => {
  const id = ulid();
  assert.equal(id.length, 26);
  assert.match(id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
});

test("ulid: 批量唯一", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 10000; i++) seen.add(ulid());
  assert.equal(seen.size, 10000);
});

test("ulid: 时间戳前缀字典序 = 时间序", () => {
  const a = ulid(Date.parse("2026-01-01T00:00:00Z"));
  const b = ulid(Date.parse("2026-07-17T00:00:00Z"));
  assert.ok(a < b, `${a} 应小于 ${b}`);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && node --import tsx --test src/ulid.test.ts`
Expected: FAIL，`Cannot find module './ulid.ts'`

- [ ] **Step 3: 实现**

```ts
// server/src/ulid.ts
// ULID:48bit 毫秒时间戳(10 字符)+ 80bit 随机(16 字符),Crockford Base32,共 26 字符。
// 用途:S3 event 的 event_id(唯一性 + 文件名安全)。零依赖。
// 注:随机部分按字节取模 32(256 整除 32,无偏),非位打包的标准 ULID,
// 但长度/字符集/字典序/唯一性与之一致,对"唯一 ID"用途等价。
import { randomFillSync } from "node:crypto";

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford(无 I/L/O/U)

export function ulid(now: number = Date.now()): string {
  let id = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    id = ENCODING[t % 32] + id;
    t = Math.floor(t / 32);
  }
  const rand = new Uint8Array(16);
  randomFillSync(rand);
  for (const byte of rand) id += ENCODING[byte % 32];
  return id;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server && node --import tsx --test src/ulid.test.ts`
Expected: PASS 3 tests

- [ ] **Step 5: 配置 npm test 脚本（后续任务往文件列表追加）**

修改 `server/package.json` scripts 加一行：

```json
"test": "node --import tsx --test src/ulid.test.ts",
```

Run: `cd server && npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/src/ulid.ts server/src/ulid.test.ts server/package.json
git commit -m "服务端:新增零依赖 ULID 生成器(event_id 用)"
```

---

### Task 2: 服务端脱敏复查（纵深防御）

**Files:**
- Create: `server/src/redact.ts`
- Test: `server/src/redact.test.ts`
- Modify: `server/src/index.ts:175-180`(ingest 循环）
- Test(E2E): `tests/run-tests.sh` 末尾加 T25

spec §8 要求服务端归档前复查脱敏（采集端 redact 之外的兜底）。规则与 plugin/agent/core.cjs:108-116 保持一致。

- [ ] **Step 1: 写失败测试**

```ts
// server/src/redact.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { redact, redactRecord } from "./redact.ts";

test("redact: 邮箱", () => {
  assert.equal(redact("发给 xcheng.orange@outlook.com 谢谢"), "发给 [email] 谢谢");
});
test("redact: 密钥前缀", () => {
  assert.equal(redact("key=AKIA-ABCDEFGHIJK123"), "key=[secret]");
});
test("redact: JWT", () => {
  assert.equal(redact("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefgh"), "[jwt]");
});
test("redact: URL 凭据", () => {
  assert.equal(redact("postgres://user:pass@host/db"), "postgres://[cred]@host/db");
});
test("redact: 长 token", () => {
  assert.equal(redact("token " + "a".repeat(48)), "token [token]");
});
test("redact: 非字符串/空值原样返回", () => {
  assert.equal(redact(""), "");
  assert.equal(redact(undefined as unknown as string), undefined);
});
test("redactRecord: 只处理 first_prompt/summary,不动其他字段", () => {
  const r = { first_prompt: "邮箱 a@b.com", summary: "正常", project: "a@b.com 目录" };
  redactRecord(r);
  assert.equal(r.first_prompt, "邮箱 [email]");
  assert.equal(r.summary, "正常");
  assert.equal(r.project, "a@b.com 目录"); // project 不在复查范围
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && node --import tsx --test src/redact.test.ts`
Expected: FAIL，`Cannot find module`

- [ ] **Step 3: 实现**

```ts
// server/src/redact.ts
// 服务端脱敏复查:规则与 plugin/agent/core.cjs 的 redact() 保持一致(纵深防御的第二道)。
// 只复查内容片段(first_prompt/summary);project 等字段按 spec §4 原样透传。
export function redact(text: string): string {
  if (!text || typeof text !== "string") return text;
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    .replace(/\b(sk|pk|ghp|gho|github_pat|xox[baprs]|AKIA)[-_][A-Za-z0-9]{6,}\b/gi, "[secret]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[jwt]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1[cred]@")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[token]");
}

/** 就地复查一条上报记录的内容字段。 */
export function redactRecord(r: { first_prompt?: string; summary?: string }): void {
  if (r.first_prompt) r.first_prompt = redact(r.first_prompt);
  if (r.summary) r.summary = redact(r.summary);
}
```

- [ ] **Step 4: 接入 ingest**

`server/src/index.ts`：顶部 import 区加：

```ts
import { redactRecord } from "./redact.ts";
```

ingest 循环（现 index.ts:175-180）改为：

```ts
      for (const r of records) {
        if (r && typeof r === "object") {
          redactRecord(r); // 复查脱敏:采集端 redact 之外的兜底(spec §8)
          upsert(r);
          n += 1;
        }
      }
```

- [ ] **Step 5: 跑测试 + 把本文件加进 npm test**

```bash
cd server && node --import tsx --test src/redact.test.ts
```

package.json test 脚本改为：

```json
"test": "node --import tsx --test src/ulid.test.ts src/redact.test.ts",
```

- [ ] **Step 6: E2E T25（加在 tests/run-tests.sh 的 `echo "==...PASS=$PASS"` 汇总之前）**

```bash
echo ""
echo "== T25: 服务端复查脱敏(采集端漏网的,服务端兜底) =="
SID25="t25-$(date +%s)"
curl -s -X POST "$LIVE/ingest" -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d "{\"tool\":\"claude-code\",\"session_id\":\"$SID25\",\"dedupe_key\":\"claude-code:$SID25\",\"name\":\"脱敏测试\",\"first_prompt\":\"联系我 someone@example.com\",\"summary\":\"正常摘要\"}" >/dev/null
sleep 0.3
assert "T25 first_prompt 被服务端脱敏" "联系我 [email]" "$($Q field "$SID25" first_prompt)"
assert "T25 summary 不受影响"        "正常摘要"        "$($Q field "$SID25" summary)"
```

Run: `bash tests/run-tests.sh`
Expected: T1-T25 全 PASS

- [ ] **Step 7: Commit**

```bash
git add server/src/redact.ts server/src/redact.test.ts server/src/index.ts server/package.json tests/run-tests.sh
git commit -m "服务端:ingest 增加脱敏复查(first_prompt/summary),与采集端规则一致"
```

---

### Task 3: 信封字段 + effective_ts 合并规则（核心行为变更）

**Files:**
- Modify: `server/src/store.ts`（全文重写，见下）
- Test: `server/src/store.test.ts`
- Test(E2E): `tests/run-tests.sh` 加 T26

spec §4 信封 + §6 合并规则。要点：JSONL 永远追加（事件不丢），内存索引按 `observed_at ?? collected_at ?? ended_at ?? received_at` 大者胜；修现网"spool 旧快照顶回新快照"。

- [ ] **Step 1: 写失败测试**

```ts
// server/src/store.test.ts
// 每个测试文件独立子进程(node --test 行为),这里统一用一个临时数据目录。
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const dir = mkdtempSync(join(tmpdir(), "vantage-store-test-"));
process.env.VANTAGE_DATA_DIR = dir;

// 动态 import 保证上面的 env 先生效(store.ts 在 import 时读 env 定数据目录)
const store = await import("./store.ts");

function rec(over: object) {
  return {
    tool: "claude-code",
    session_id: "s-1",
    dedupe_key: "claude-code:s-1",
    name: "测试",
    total_tokens: 100,
    ...over,
  };
}

test("upsert: 盖信封(event_id 26 字符 ULID + received_at),客户端伪造无效", () => {
  const s = store.upsert(rec({ event_id: "fake", received_at: "1999-01-01T00:00:00.000Z" }));
  assert.match(s.event_id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.notEqual(s.received_at, "1999-01-01T00:00:00.000Z");
});

test("upsert: 迟到的旧快照不顶回新快照,但两行都进 JSONL", () => {
  const before = readFileSync(store.jsonlPath, "utf8").trim().split("\n").length;
  store.upsert(rec({ total_tokens: 100, observed_at: "2026-07-17T10:00:00.000Z" }));
  store.upsert(rec({ total_tokens: 50, observed_at: "2026-07-17T09:00:00.000Z" })); // 更旧
  const cur = store.allSessions().find((r) => r.dedupe_key === "claude-code:s-1");
  assert.equal(cur?.total_tokens, 100);
  const after = readFileSync(store.jsonlPath, "utf8").trim().split("\n").length;
  assert.equal(after - before, 2); // 事件是事实,照样归档
});

test("upsert: 旧字段 collected_at 作为 observed_at 回退", () => {
  store.upsert(rec({ session_id: "s-2", dedupe_key: "claude-code:s-2", total_tokens: 10, collected_at: "2026-07-17T08:00:00.000Z" }));
  store.upsert(rec({ session_id: "s-2", dedupe_key: "claude-code:s-2", total_tokens: 999, collected_at: "2026-07-17T07:00:00.000Z" }));
  const cur = store.allSessions().find((r) => r.dedupe_key === "claude-code:s-2");
  assert.equal(cur?.total_tokens, 10);
});

test("upsert: 无 observed_at/collected_at 时回退 ended_at/received_at", () => {
  store.upsert(rec({ session_id: "s-3", dedupe_key: "claude-code:s-3", total_tokens: 5, ended_at: "2026-07-17T06:00:00.000Z" }));
  // 既无 observed_at 也无 ended_at -> 用 received_at(现在) > 上一条 -> 应覆盖
  store.upsert(rec({ session_id: "s-3", dedupe_key: "claude-code:s-3", total_tokens: 6 }));
  const cur = store.allSessions().find((r) => r.dedupe_key === "claude-code:s-3");
  assert.equal(cur?.total_tokens, 6);
});

test("replay: 启动回放同样按 effective_ts 合并(子进程验证)", () => {
  // 另开进程,数据目录里预写"新在前、旧在后"的两行,回放后应保留新快照
  const dir2 = mkdtempSync(join(tmpdir(), "vantage-store-replay-"));
  const { writeFileSync, mkdirSync } = require("node:fs") as typeof import("node:fs");
  mkdirSync(dir2, { recursive: true });
  const newer = JSON.stringify(rec({ total_tokens: 100, observed_at: "2026-07-17T10:00:00.000Z", received_at: "2026-07-17T10:00:01.000Z", event_id: "A".repeat(26) }));
  const older = JSON.stringify(rec({ total_tokens: 50, observed_at: "2026-07-17T09:00:00.000Z", received_at: "2026-07-17T10:00:02.000Z", event_id: "B".repeat(26) }));
  writeFileSync(join(dir2, "usage.jsonl"), newer + "\n" + older + "\n");
  const out = execFileSync(
    process.execPath,
    ["--import", "tsx", "-e", `import("./src/store.ts").then(m=>console.log(JSON.stringify(m.allSessions())))`],
    { env: { ...process.env, VANTAGE_DATA_DIR: dir2 }, cwd: join(import.meta.dirname, ".."), encoding: "utf8" }
  );
  const sessions = JSON.parse(out.trim().split("\n").pop()!);
  const s1 = sessions.find((r: any) => r.dedupe_key === "claude-code:s-1");
  assert.equal(s1.total_tokens, 100);
});
```

注意：`require` 在 ESM 不可用——把 replay 测试里的两行 `const { writeFileSync, mkdirSync } = require(...)` 改为顶部 `import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";`（合并到既有 import)。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && node --import tsx --test src/store.test.ts`
Expected: FAIL（信封/合并断言失败：现在 upsert 无条件覆盖且无 event_id)

- [ ] **Step 3: 重写 store.ts**

```ts
// server/src/store.ts(完整替换)
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { ulid } from "./ulid.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
// 默认存到 server/data;可用 VANTAGE_DATA_DIR 覆盖(测试用独立目录,避免污染真实数据)
const dataDir = process.env.VANTAGE_DATA_DIR ?? join(__dirname, "..", "data");
mkdirSync(dataDir, { recursive: true });
const jsonlPath = join(dataDir, "usage.jsonl");

/**
 * 一条使用记录(一次会话的当前完整快照)。
 * 采集器每次上传的是"这个会话到目前为止的全量",服务端按 dedupe_key 合并,
 * 因此重复触发 / 重试 / 扫描兜底都不会造成重复统计。
 */
/** 单个模型在一次会话里的用量明细(请求数 + 各类 token)。 */
export interface ModelUsage {
  requests?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  // 缓存写入分档(算成本用:5 分钟档 1.25 倍 input 单价,1 小时档 2 倍)。
  // 老记录无此字段;总数 - (5m+1h) 的差值视为"未知档"按 1.25 估算。
  cache_creation_5m_tokens?: number;
  cache_creation_1h_tokens?: number;
  reasoning_tokens?: number;
}

export interface UsageRecord {
  // 身份(安装时填写)
  name?: string;
  email?: string;
  department?: string;
  machine?: string;
  // 会话
  tool?: string; // 'claude-code' | 'codex'
  session_id?: string;
  model?: string;
  project?: string;
  started_at?: string;
  ended_at?: string;
  duration_ms?: number;
  // 用量
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
  // 当前用量(额度)——仅 Codex 会话带
  quota_primary_pct?: number | null;
  quota_secondary_pct?: number | null;
  quota_plan?: string | null;
  quota_reached?: string | null;
  // 内容
  first_prompt?: string;
  summary?: string;
  exit_reason?: string;
  // 由采集器生成,用于去重(一般 = tool + ':' + session_id)
  dedupe_key?: string;
  // 采集时刻(快照生成时间)。observed_at 为新字段名;collected_at 为旧采集端字段名,回退兼容。
  observed_at?: string;
  collected_at?: string;
}

export interface StoredRecord extends UsageRecord {
  // 服务端信封:归档与恢复用(spec §4)。老 JSONL 行可能没有 event_id,故标可选。
  event_id?: string;
  received_at: string;
}

// 内存索引:dedupe_key -> effective_ts 最大的记录
const index = new Map<string, StoredRecord>();

function keyOf(r: UsageRecord): string {
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
 * 合并进索引:同 key 取 effective_ts 大者(相等时后到者胜,等价于同毫秒内的后到覆盖)。
 * 注意:这只决定"当前状态";无论胜负,记录都已写进 JSONL/S3(事件不丢)。
 * 与读取顺序无关(order-independent),回放可任意并行。
 */
function mergeIndex(rec: StoredRecord): void {
  const k = keyOf(rec);
  const prev = index.get(k);
  if (!prev || effectiveTs(rec) >= effectiveTs(prev)) index.set(k, rec);
}

// 启动时回放 JSONL 重建索引(与 upsert 同一套合并规则)
function replay() {
  if (!existsSync(jsonlPath)) return;
  const lines = readFileSync(jsonlPath, "utf8").split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      mergeIndex(JSON.parse(line) as StoredRecord);
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
  mergeIndex(stored);
  return stored;
}

/** 当前所有会话(每个 session 只保留 effective_ts 最大的快照) */
export function allSessions(): StoredRecord[] {
  return [...index.values()];
}

export { jsonlPath };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server && node --import tsx --test src/store.test.ts`
Expected: PASS 5 tests

package.json test 脚本改为：

```json
"test": "node --import tsx --test src/ulid.test.ts src/redact.test.ts src/store.test.ts",
```

- [ ] **Step 5: E2E T26（合并规则部分；加在 T25 之后）**

```bash
echo ""
echo "== T26: 信封字段 + 迟到旧快照不顶回新快照(effective_ts 合并) =="
SID26="t26-$(date +%s)"
curl -s -X POST "$LIVE/ingest" -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d "{\"tool\":\"claude-code\",\"session_id\":\"$SID26\",\"dedupe_key\":\"claude-code:$SID26\",\"name\":\"T26测试用户\",\"total_tokens\":100,\"observed_at\":\"2026-07-17T10:00:00.000Z\"}" >/dev/null
curl -s -X POST "$LIVE/ingest" -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d "{\"tool\":\"claude-code\",\"session_id\":\"$SID26\",\"dedupe_key\":\"claude-code:$SID26\",\"name\":\"T26测试用户\",\"total_tokens\":50,\"observed_at\":\"2026-07-17T09:00:00.000Z\"}" >/dev/null
sleep 0.3
# 服务端索引(/stats):该用户总量=100(旧快照未顶回);qserver 按行序折叠,不适用此断言
STATS26="$(curl -s -H "Authorization: Bearer $TOKEN" "$LIVE/stats")"
u26(){ echo "$STATS26" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const u=(JSON.parse(s).users||[]).find(x=>x.name==="T26测试用户");process.stdout.write(u?String(u[process.argv[1]]):"MISSING")})' "$1"; }
assert "T26 旧快照未顶回(总量=100)" "100" "$(u26 total_tokens)"
assert "T26 会话数=1(已合并)"      "1"   "$(u26 sessions)"
# 但两个事件都进了 JSONL(事件不丢)
assert "T26 两条事件都归档" "2" "$(grep -c "claude-code:$SID26" "$DATA")"
# 信封:event_id 为 26 字符 ULID、observed_at 透传
EID26="$($Q field "$SID26" event_id)"
[ "${#EID26}" = "26" ] && ok "T26 event_id 为 26 字符 ULID" || no "T26 event_id 长度" "26" "${#EID26}"
assert "T26 observed_at 透传" "2026-07-17T10:00:00.000Z" "$($Q field "$SID26" observed_at)"
```

Run: `bash tests/run-tests.sh`
Expected: T1-T26 全 PASS(T2/T7 仍过：它们的后到记录 observed_at/collected_at 更新，天然大者胜）

- [ ] **Step 6: Commit**

```bash
git add server/src/store.ts server/src/store.test.ts server/package.json tests/run-tests.sh
git commit -m "服务端:盖信封(event_id/received_at)+ 合并规则改 effective_ts 大者胜,修 spool 旧快照顶回新快照"
```

---

### Task 4: 采集端 collected_at 更名 observed_at

**Files:**
- Modify: `plugin/agent/capture.cjs:74`
- Modify: `plugin/agent/reconcile.cjs:215`

两处 `collected_at: new Date().toISOString(),` 改为 `observed_at: new Date().toISOString(),`。服务端已回退兼容旧字段名（Task 3)，老 agent 不受影响。

- [ ] **Step 1: 改 capture.cjs:74**

```js
    observed_at: new Date().toISOString(), // 快照生成时间(服务端据此判断新旧;旧名 collected_at)
```

- [ ] **Step 2: 改 reconcile.cjs:215**

同上（同一行内容，同样替换）。

- [ ] **Step 3: E2E 验证（T26 已断言 observed_at 透传；T1 的记录由新 agent 产生）**

Run: `bash tests/run-tests.sh`
Expected: 全 PASS

- [ ] **Step 4: Commit**

```bash
git add plugin/agent/capture.cjs plugin/agent/reconcile.cjs
git commit -m "采集端:collected_at 更名 observed_at(服务端回退兼容旧名)"
```

---

### Task 5: SigV4 签名（手写，零依赖）

**Files:**
- Create: `server/src/sigv4.ts`
- Test: `server/src/sigv4.test.ts`

S3 约定：canonicalURI 用**原始路径不做二次编码**(AWS SDK 对 S3 设 uriEscapePath=false)；我们的 key 只含 `[A-Za-z0-9/=._-]`，无需编码。签名头集合固定 `host;x-amz-content-sha256;x-amz-date`。

- [ ] **Step 1: 写失败测试（AWS 官方文档测试向量）**

```ts
// server/src/sigv4.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256Hex, deriveSigningKey, signV4 } from "./sigv4.ts";

test("sha256Hex: 空串等于公认值", () => {
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

// AWS 文档《Examples of how to derive a signing key》公开向量
test("deriveSigningKey: AWS 官方文档向量", () => {
  const k = deriveSigningKey("wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "20150830", "us-east-1", "iam");
  assert.equal(k.toString("hex"), "c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9");
});

// AWS 文档《Signature Version 4 signing process》完整示例(GET iam ListUsers)
test("signV4: AWS 官方文档完整签名向量", () => {
  const auth = signV4({
    method: "GET",
    path: "/",
    query: "Action=ListUsers&Version=2010-05-08",
    headers: {
      "content-type": "application/x-www-form-urlencoded; charset=utf-8",
      host: "iam.amazonaws.com",
      "x-amz-date": "20150830T123600Z",
    },
    payloadHash: sha256Hex(""),
    region: "us-east-1",
    service: "iam",
    accessKey: "AKIDEXAMPLE",
    secret: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    amzDate: "20150830T123600Z",
    date8: "20150830",
  });
  assert.equal(
    auth,
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, " +
      "SignedHeaders=content-type;host;x-amz-date, " +
      "Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7"
  );
});

// 我们 PUT S3 的实际形状:签名头固定三个,路径含 = 与 / 不编码
test("signV4: PUT S3 形状(路径不二次编码、签名头固定)", () => {
  const auth = signV4({
    method: "PUT",
    path: "/events/dt=2026-07-17/20260717T093012.015Z_01J9X7K2M4_codex.json",
    query: "",
    headers: {
      host: "vantage-prod.s3.us-east-1.amazonaws.com",
      "x-amz-content-sha256": sha256Hex('{"a":1}'),
      "x-amz-date": "20260717T093012Z",
    },
    payloadHash: sha256Hex('{"a":1}'),
    region: "us-east-1",
    service: "s3",
    accessKey: "AKIDEXAMPLE",
    secret: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    amzDate: "20260717T093012Z",
    date8: "20260717",
  });
  assert.match(auth, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260717\/us-east-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && node --import tsx --test src/sigv4.test.ts`
Expected: FAIL，`Cannot find module`

- [ ] **Step 3: 实现**

```ts
// server/src/sigv4.ts
// AWS Signature Version 4 手写实现(零依赖,仅用 node:crypto)。
// 约束(贴合本用途):canonicalURI 使用原始路径不做二次编码(S3 约定,SDK 对 S3 设 uriEscapePath=false);
// 我们的 key 只含 [A-Za-z0-9/=._-],天然安全。query 由调用方给出"已排序已编码"形式。
import { createHash, createHmac } from "node:crypto";

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/** kSigning = HMAC(HMAC(HMAC(HMAC("AWS4"+secret, date8), region), service), "aws4_request") */
export function deriveSigningKey(secret: string, date8: string, region: string, service: string): Buffer {
  const kDate = hmac("AWS4" + secret, date8);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

export interface SignV4Input {
  method: string; // PUT / GET
  path: string; // 原始路径(含开头的 /),不做 URI 二次编码
  query: string; // 已排序、已百分号编码的查询串(不含 "?"),无查询传 ""
  headers: Record<string, string>; // 参与签名的头;键名内部统一小写、值去首尾空格并压缩连续空格
  payloadHash: string; // sha256Hex(body)
  region: string;
  service: string; // "s3"
  accessKey: string;
  secret: string;
  amzDate: string; // 20260717T093012Z
  date8: string; // 20260717
}

/** 返回完整 Authorization 头值。 */
export function signV4(i: SignV4Input): string {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(i.headers)) {
    lower[k.toLowerCase()] = v.trim().replace(/ +/g, " ");
  }
  const names = Object.keys(lower).sort();
  const canonicalHeaders = names.map((n) => `${n}:${lower[n]}\n`).join("");
  const signedHeaders = names.join(";");

  const canonicalRequest = [
    i.method,
    i.path,
    i.query,
    canonicalHeaders,
    signedHeaders,
    i.payloadHash,
  ].join("\n");

  const scope = `${i.date8}/${i.region}/${i.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", i.amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const signature = createHmac("sha256", deriveSigningKey(i.secret, i.date8, i.region, i.service))
    .update(stringToSign, "utf8")
    .digest("hex");

  return `AWS4-HMAC-SHA256 Credential=${i.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server && node --import tsx --test src/sigv4.test.ts`
Expected: PASS 4 tests

package.json test 脚本追加 `src/sigv4.test.ts`。

- [ ] **Step 5: Commit**

```bash
git add server/src/sigv4.ts server/src/sigv4.test.ts server/package.json
git commit -m "服务端:手写 SigV4 签名(零依赖,含 AWS 官方文档测试向量)"
```

---

### Task 6: S3 客户端（PUT/GET/LIST)

**Files:**
- Create: `server/src/s3.ts`
- Test: `server/src/s3.test.ts`（只测纯函数：endpoint 推导、key 查询串编码；网络路径由 Task 10 的 smoke 脚本与 T27 fake-s3 覆盖）

- [ ] **Step 1: 写失败测试**

```ts
// server/src/s3.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { s3ConfigFromEnv, encodeQuery } from "./s3.ts";

test("s3ConfigFromEnv: 未配置 bucket 或密钥 -> enabled=false", () => {
  assert.equal(s3ConfigFromEnv({}).enabled, false);
  assert.equal(s3ConfigFromEnv({ VANTAGE_S3_BUCKET: "b" }).enabled, false);
});

test("s3ConfigFromEnv: 默认推导虚拟托管式 endpoint", () => {
  const c = s3ConfigFromEnv({
    VANTAGE_S3_BUCKET: "vantage-prod",
    VANTAGE_S3_REGION: "ap-southeast-1",
    AWS_ACCESS_KEY_ID: "AK",
    AWS_SECRET_ACCESS_KEY: "SK",
  });
  assert.equal(c.enabled, true);
  assert.equal(c.endpoint, "https://vantage-prod.s3.ap-southeast-1.amazonaws.com");
});

test("s3ConfigFromEnv: 显式 endpoint 覆盖(测试/aws-cn)", () => {
  const c = s3ConfigFromEnv({
    VANTAGE_S3_BUCKET: "b",
    AWS_ACCESS_KEY_ID: "AK",
    AWS_SECRET_ACCESS_KEY: "SK",
    VANTAGE_S3_ENDPOINT: "http://localhost:4999",
  });
  assert.equal(c.endpoint, "http://localhost:4999");
});

test("encodeQuery: 按名排序 + RFC3986 编码", () => {
  assert.equal(encodeQuery({ prefix: "events/", "list-type": "2" }), "list-type=2&prefix=events%2F");
  assert.equal(encodeQuery({ "continuation-token": "a/b+c d" }), "continuation-token=a%2Fb%2Bc%20d");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && node --import tsx --test src/s3.test.ts`
Expected: FAIL，`Cannot find module`

- [ ] **Step 3: 实现**

```ts
// server/src/s3.ts
// S3 最小客户端(零依赖,node:http/https + 手写 SigV4)。
// 只用三个操作:putObject(归档)、getObject(恢复/冒烟)、listKeys(恢复)。
// 约定:endpoint 为 base URL,key 直接拼接为路径(路径含 = / / 等安全字符,不二次编码)。
// 网络/超时错误一律返回 status 0,绝不抛异常(归档路径不允许把 S3 抖动传回 /ingest)。
import http from "node:http";
import https from "node:https";
import { sha256Hex, signV4 } from "./sigv4.ts";

export interface S3Config {
  enabled: boolean;
  bucket: string;
  region: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export function s3ConfigFromEnv(env: NodeJS.ProcessEnv = process.env): S3Config {
  const bucket = env.VANTAGE_S3_BUCKET ?? "";
  const region = env.VANTAGE_S3_REGION ?? "us-east-1";
  const accessKeyId = env.AWS_ACCESS_KEY_ID ?? "";
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY ?? "";
  const endpoint =
    env.VANTAGE_S3_ENDPOINT ?? (bucket ? `https://${bucket}.s3.${region}.amazonaws.com` : "");
  return {
    enabled: Boolean(bucket && accessKeyId && secretAccessKey),
    bucket,
    region,
    endpoint,
    accessKeyId,
    secretAccessKey,
  };
}

/** RFC3986 编码(query 用;S3 对 ! ' ( ) * 也要求转义) */
function enc(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

/** 参数按名排序后编码拼接(SigV4 canonical query 要求) */
export function encodeQuery(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${enc(k)}=${enc(params[k])}`)
    .join("&");
}

function amzDates(now = new Date()): { amzDate: string; date8: string } {
  const s = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z"); // 20260717T093012Z
  return { amzDate: s, date8: s.slice(0, 8) };
}

interface S3Response {
  status: number; // 0 = 网络/超时错误
  body: string;
}

/** 签名并发送一个请求。永不 reject;网络错误 resolve {status:0}。 */
function request(cfg: S3Config, method: string, key: string, query: string, payload: Buffer): Promise<S3Response> {
  return new Promise((resolve) => {
    let base: URL;
    try {
      base = new URL(cfg.endpoint);
    } catch {
      return resolve({ status: 0, body: "bad endpoint" });
    }
    const { amzDate, date8 } = amzDates();
    const payloadHash = sha256Hex(payload);
    const path = `/${key}`; // S3 约定:不二次编码
    const headers: Record<string, string> = {
      host: base.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    };
    const authorization = signV4({
      method,
      path,
      query,
      headers,
      payloadHash,
      region: cfg.region,
      service: "s3",
      accessKey: cfg.accessKeyId,
      secret: cfg.secretAccessKey,
      amzDate,
      date8,
    });
    const mod = base.protocol === "https:" ? https : http;
    const req = mod.request(
      {
        hostname: base.hostname,
        port: base.port || (base.protocol === "https:" ? 443 : 80),
        method,
        path: query ? `${path}?${query}` : path,
        headers: {
          ...headers,
          authorization,
          "content-type": "application/json",
          "content-length": payload.length,
        },
        timeout: 15000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", () => resolve({ status: 0, body: "" }));
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, body: "timeout" });
    });
    req.on("error", (e) => resolve({ status: 0, body: String(e) }));
    req.write(payload);
    req.end();
  });
}

export async function putObject(cfg: S3Config, key: string, body: string): Promise<S3Response> {
  return request(cfg, "PUT", key, "", Buffer.from(body, "utf8"));
}

export async function getObject(cfg: S3Config, key: string): Promise<S3Response> {
  return request(cfg, "GET", key, "", Buffer.alloc(0));
}

/** ListObjectsV2 全量翻页。注意:返回的 Key 未做 XML 反转义——我们的 key 不含 & < >,无影响。 */
export async function listKeys(cfg: S3Config, prefix: string): Promise<{ status: number; keys: string[] }> {
  const keys: string[] = [];
  let token = "";
  for (;;) {
    const params: Record<string, string> = { "list-type": "2", prefix };
    if (token) params["continuation-token"] = token;
    const res = await request(cfg, "GET", cfg.bucket ? "" : "", encodeQuery(params), Buffer.alloc(0));
    if (res.status < 200 || res.status >= 300) return { status: res.status, keys };
    for (const m of res.body.matchAll(/<Key>([^<]*)<\/Key>/g)) keys.push(m[1]);
    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(res.body);
    const next = res.body.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/);
    if (!truncated || !next) return { status: res.status, keys };
    token = next[1];
  }
}
```

注意：listKeys 的 LIST 请求路径是桶根（虚拟托管式 endpoint 下 path=`/`)。request() 的 key 传 `""` 会得到 path `"/"`,OK。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server && node --import tsx --test src/s3.test.ts`
Expected: PASS 4 tests

package.json test 脚本追加 `src/s3.test.ts`。

- [ ] **Step 5: Commit**

```bash
git add server/src/s3.ts server/src/s3.test.ts server/package.json
git commit -m "服务端:S3 最小客户端(PUT/GET/LIST,虚拟托管式 endpoint 可覆盖)"
```

---

### Task 7: 归档器（异步队列 + 对账扫描 + 死信）

**Files:**
- Create: `server/src/archive.ts`
- Test: `server/src/archive.test.ts`

spec §8：异步 PUT 不阻塞 ACK；对账器按字节 offset 扫本地 JSONL 补传；key 由 `received_at + event_id` 决定所以幂等。

设计要点：
- `enqueue` 只进内存队列；worker 单并发，一次尝试，失败进死信文件 `s3-archive-dead.jsonl`（不阻塞后续事件）。
- 每 `VANTAGE_S3_SWEEP_INTERVAL_SEC`（默认 600s）对账：从 offset 读 JSONL 新增字节逐行 PUT（幂等，允许与 worker 重复）；再重试死信（成功的按 event_id 从死信文件剔除）。
- offset 存 `s3-archive.state.json`；文件变短（被替换）则从头重扫。
- 未配置 S3(env）时 initArchive 返回 no-op handle，行为与现状完全一致。

- [ ] **Step 1: 写失败测试**

```ts
// server/src/archive.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initArchive, eventKey, type Putter } from "./archive.ts";

const cfg = {
  enabled: true, bucket: "b", region: "us-east-1",
  endpoint: "http://fake", accessKeyId: "AK", secretAccessKey: "SK",
};

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "vantage-archive-test-"));
  const jsonlPath = join(dir, "usage.jsonl");
  writeFileSync(jsonlPath, "");
  return { dir, jsonlPath };
}

function stored(over: object) {
  return {
    tool: "codex",
    dedupe_key: "codex:s-1",
    total_tokens: 1,
    event_id: "01J9X7K2M4000000000000AB",
    received_at: "2026-07-17T09:30:12.015Z",
    ...over,
  };
}

test("eventKey: events/dt=<received日期>/<紧凑时间>_<event_id>_<tool>.json", () => {
  assert.equal(
    eventKey(stored({})),
    "events/dt=2026-07-17/20260717T093012.015Z_01J9X7K2M4000000000000AB_codex.json"
  );
});

test("enqueue: worker 异步 PUT,内容=事件 JSON;drain 后已完成", async () => {
  const { jsonlPath } = setup();
  const puts: { key: string; body: string }[] = [];
  const putter: Putter = async (key, body) => { puts.push({ key, body }); return { status: 200 }; };
  const a = initArchive({ jsonlPath, cfg, putter, sweepIntervalSec: 3600 });
  a.enqueue(stored({}));
  await a.drain();
  assert.equal(puts.length, 1);
  assert.equal(JSON.parse(puts[0].body).dedupe_key, "codex:s-1");
  a.stop();
});

test("PUT 失败:进死信、不阻塞后续;下次 sweep 重试成功并从死信剔除", async () => {
  const { dir, jsonlPath } = setup();
  let fail = true;
  const puts: string[] = [];
  const putter: Putter = async (key, body) => { puts.push(key); if (fail) return { status: 0 }; return { status: 200 }; };
  const a = initArchive({ jsonlPath, cfg, putter, sweepIntervalSec: 3600 });
  a.enqueue(stored({}));
  a.enqueue(stored({ event_id: "01J9X7K2M4000000000000CD", received_at: "2026-07-17T09:31:00.000Z" }));
  await a.drain();
  assert.equal(puts.length, 2); // 两条都尝试了,失败不阻塞
  const deadPath = join(dir, "s3-archive-dead.jsonl");
  assert.equal(readFileSync(deadPath, "utf8").trim().split("\n").length, 2);
  fail = false;
  await a.sweep(); // 对账重试死信
  assert.equal(readFileSync(deadPath, "utf8").trim(), "");
  a.stop();
});

test("sweep: 从 offset 只补传新增行;重复 sweep 不重复 PUT;文件重置后从头扫", async () => {
  const { jsonlPath } = setup();
  const puts: string[] = [];
  const putter: Putter = async (key) => { puts.push(key); return { status: 200 }; };
  const a = initArchive({ jsonlPath, cfg, putter, sweepIntervalSec: 3600 });
  appendFileSync(jsonlPath, JSON.stringify(stored({})) + "\n");
  appendFileSync(jsonlPath, JSON.stringify(stored({ event_id: "01J9X7K2M4000000000000CD", received_at: "2026-07-17T09:31:00.000Z" })) + "\n");
  await a.sweep();
  assert.equal(puts.length, 2);
  await a.sweep(); // offset 已推进,无新增
  assert.equal(puts.length, 2);
  a.stop();
});

test("未启用(cfg.enabled=false):enqueue/sweep 全是 no-op,不写任何文件", async () => {
  const { dir, jsonlPath } = setup();
  const puts: string[] = [];
  const a = initArchive({ jsonlPath, cfg: { ...cfg, enabled: false }, putter: async () => ({ status: 200 }), sweepIntervalSec: 3600 });
  a.enqueue(stored({}));
  await a.drain();
  await a.sweep();
  assert.equal(puts.length, 0);
  assert.equal(existsSync(join(dir, "s3-archive.state.json")), false);
  a.stop();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && node --import tsx --test src/archive.test.ts`
Expected: FAIL，`Cannot find module`

- [ ] **Step 3: 实现**

```ts
// server/src/archive.ts
// S3 归档器(spec §8):异步队列 + 定时对账,绝不阻塞 /ingest。
//   enqueue  -> 内存队列 -> worker 单发尝试 -> 失败进死信文件
//   sweep    -> 从字节 offset 扫本地 JSONL 补传(幂等)+ 重试死信(成功剔除)
// 幂等性:S3 key 由事件已落盘的 received_at + event_id 决定,重传 N 次同 key 同内容。
// 未配置 S3 时返回 no-op handle,行为与未接 S3 完全一致。
import { appendFileSync, readFileSync, writeFileSync, renameSync, existsSync, statSync, openSync, readSync, closeSync, fstatSync } from "node:fs";
import { join, dirname } from "node:path";
import { putObject, type S3Config } from "./s3.ts";
import type { StoredRecord } from "./store.ts";

export type Putter = (key: string, body: string) => Promise<{ status: number }>;

export interface ArchiveHandle {
  enqueue(rec: StoredRecord): void;
  drain(): Promise<void>; // 等队列清空(测试/关停用)
  sweep(): Promise<void>; // 手动触发一次对账(测试用)
  stop(): void;
}

interface ArchiveOpts {
  jsonlPath: string;
  cfg: S3Config;
  putter?: Putter; // 测试注入;默认真 S3
  sweepIntervalSec?: number; // 默认 600(10 分钟)
  log?: (msg: string) => void;
}

/** S3 key(spec §3):events/dt=<received_at 的 UTC 日期>/<紧凑时间>_<event_id>_<tool>.json */
export function eventKey(rec: StoredRecord): string {
  const dt = rec.received_at.slice(0, 10); // 2026-07-17
  const compact = rec.received_at.replace(/[-:]/g, "").replace("T", "T"); // 20260717T093012.015Z
  const tool = (rec.tool ?? "unknown").replace(/[^A-Za-z0-9-]/g, "-");
  return `events/dt=${dt}/${compact}_${rec.event_id}_${tool}.json`;
}

export function initArchive(opts: ArchiveOpts): ArchiveHandle {
  const log = opts.log ?? ((m: string) => console.log(`[vantage][s3] ${m}`));
  const noop: ArchiveHandle = { enqueue() {}, async drain() {}, async sweep() {}, stop() {} };
  if (!opts.cfg.enabled) {
    log("未配置 VANTAGE_S3_BUCKET / AWS 密钥,S3 归档停用(仅本地存储)");
    return noop;
  }

  const putter: Putter =
    opts.putter ?? ((key, body) => putObject(opts.cfg, key, body).then((r) => ({ status: r.status })));
  const dataDir = dirname(opts.jsonlPath);
  const statePath = join(dataDir, "s3-archive.state.json");
  const deadPath = join(dataDir, "s3-archive-dead.jsonl");
  const sweepMs = (opts.sweepIntervalSec ?? 600) * 1000;

  const queue: StoredRecord[] = [];
  let working = false;
  let idleResolvers: (() => void)[] = [];

  function appendDead(line: string): void {
    try {
      appendFileSync(deadPath, line + "\n");
    } catch (e) {
      log(`死信写入失败:${e}`);
    }
  }

  async function putLine(line: string): Promise<boolean> {
    let rec: StoredRecord;
    try {
      rec = JSON.parse(line);
    } catch {
      return true; // 损坏行不重试,跳过
    }
    if (!rec.event_id || !rec.received_at) return true; // 老行(无信封)不归档,跳过
    const res = await putter(eventKey(rec), line);
    if (res.status >= 200 && res.status < 300) return true;
    log(`PUT 失败 status=${res.status} key=${eventKey(rec)}`);
    return false;
  }

  async function worker(): Promise<void> {
    if (working) return;
    working = true;
    try {
      while (queue.length) {
        const rec = queue.shift()!;
        const ok = await putLine(JSON.stringify(rec));
        if (!ok) appendDead(JSON.stringify(rec));
      }
    } finally {
      working = false;
      const rs = idleResolvers;
      idleResolvers = [];
      rs.forEach((r) => r());
    }
  }

  function readOffset(): number {
    try {
      return Number(JSON.parse(readFileSync(statePath, "utf8")).offset) || 0;
    } catch {
      return 0;
    }
  }

  function writeOffset(offset: number): void {
    const tmp = `${statePath}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ offset }));
    renameSync(tmp, statePath);
  }

  /** 读 jsonlPath 中 [offset, EOF) 的完整行;返回 { lines, nextOffset }。文件变短(被替换)从头读。 */
  function readNewLines(offset: number): { lines: string[]; nextOffset: number } {
    const size = statSync(opts.jsonlPath).size;
    let start = offset > size ? 0 : offset;
    const fd = openSync(opts.jsonlPath, "r");
    try {
      const len = size - start;
      if (len <= 0) return { lines: [], nextOffset: start };
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, start);
      const text = buf.toString("utf8");
      const parts = text.split("\n");
      const tail = parts.pop() ?? ""; // 最后一段若非空行说明没写完(半行),留给下轮
      const consumed = len - Buffer.byteLength(tail, "utf8");
      return { lines: parts.filter((l) => l.trim()), nextOffset: start + consumed };
    } finally {
      closeSync(fd);
    }
  }

  async function sweep(): Promise<void> {
    // 1) 补传 JSONL 新增行(崩溃恢复 + 兜底;与 worker 重复无害,幂等)
    try {
      const { lines, nextOffset } = readNewLines(readOffset());
      let okAll = true;
      for (const line of lines) {
        if (!(await putLine(line))) {
          appendDead(line);
          okAll = false; // 继续处理后续行,不阻塞
        }
      }
      writeOffset(nextOffset);
      void okAll;
    } catch (e) {
      log(`sweep 扫描失败:${e}`);
    }
    // 2) 重试死信;成功的按行内容从死信文件剔除(重读文件,避免与 worker 并发追加竞态)
    try {
      if (existsSync(deadPath)) {
        const deadLines = readFileSync(deadPath, "utf8").split("\n").filter((l) => l.trim());
        if (deadLines.length) {
          const succeeded = new Set<string>();
          for (const line of deadLines) {
            if (await putLine(line)) succeeded.add(line);
          }
          const remain = readFileSync(deadPath, "utf8")
            .split("\n")
            .filter((l) => l.trim() && !succeeded.has(l));
          writeFileSync(deadPath, remain.length ? remain.join("\n") + "\n" : "");
        }
      }
    } catch (e) {
      log(`死信重试失败:${e}`);
    }
  }

  const timer = setInterval(() => {
    sweep().catch((e) => log(`sweep 异常:${e}`));
  }, sweepMs);
  timer.unref(); // 不阻止进程退出

  log(`S3 归档已启用 bucket=${opts.cfg.bucket} endpoint=${opts.cfg.endpoint} 对账间隔=${sweepMs / 1000}s`);

  return {
    enqueue(rec: StoredRecord) {
      queue.push(rec);
      worker().catch((e) => log(`worker 异常:${e}`));
    },
    drain() {
      if (!working && queue.length === 0) return Promise.resolve();
      return new Promise((r) => idleResolvers.push(r));
    },
    sweep,
    stop() {
      clearInterval(timer);
    },
  };
}
```

注意：`eventKey` 里 `.replace("T", "T")` 是笔误残留，实现时直接去掉——compact 只需 `.replace(/[-:]/g, "")`(`2026-07-17T09:30:12.015Z` → `20260717T093012.015Z`)。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server && node --import tsx --test src/archive.test.ts`
Expected: PASS 5 tests

package.json test 脚本追加 `src/archive.test.ts`，最终：

```json
"test": "node --import tsx --test src/ulid.test.ts src/redact.test.ts src/store.test.ts src/sigv4.test.ts src/s3.test.ts src/archive.test.ts",
```

- [ ] **Step 5: Commit**

```bash
git add server/src/archive.ts server/src/archive.test.ts server/package.json
git commit -m "服务端:S3 归档器(异步队列不阻塞 ACK + offset 对账补传 + 死信重试)"
```

---

### Task 8: 接线 index.ts

**Files:**
- Modify: `server/src/index.ts`

- [ ] **Step 1: 改 import 与 ingest 循环、启动初始化**

顶部 import 加：

```ts
import { initArchive } from "./archive.ts";
import { s3ConfigFromEnv } from "./s3.ts";
```

`createServer` 之前加：

```ts
// S3 归档:异步、不阻塞 /ingest;未配置环境变量时为 no-op(spec §8)
const archive = initArchive({ jsonlPath, cfg: s3ConfigFromEnv() });
```

注意 `jsonlPath` 需要从 store.ts import（已 export):import 行改为
`import { upsert, allSessions, jsonlPath, type UsageRecord } from "./store.ts";`

ingest 循环（Task 2 之后的样子）改为：

```ts
      for (const r of records) {
        if (r && typeof r === "object") {
          redactRecord(r); // 复查脱敏:采集端 redact 之外的兜底(spec §8)
          const stored = upsert(r);
          archive.enqueue(stored); // 异步归档 S3,失败由对账器兜底
          n += 1;
        }
      }
```

- [ ] **Step 2: 验证（单元 + E2E 现有全量；S3 未配置时行为不变）**

```bash
cd server && npm test
bash tests/run-tests.sh
```

Expected: 全 PASS（未配置 S3,E2E 走的是 no-op 路径）

- [ ] **Step 3: Commit**

```bash
git add server/src/index.ts
git commit -m "服务端:ingest 接线 S3 归档(ACK 后异步入队)"
```

---

### Task 9: E2E T27——fake S3 全链路

**Files:**
- Create: `tests/fake-s3.cjs`
- Modify: `tests/run-tests.sh`（末尾加 T27)

fake-s3：收任意 PUT，记录 `{path, authorization, body}` 到 JSONL，恒返 200。覆盖：key 形状、签名头存在、S3 挂了不阻塞 ingest、对账兜底补传。

- [ ] **Step 1: 写 fake-s3.cjs**

```js
#!/usr/bin/env node
"use strict";
// 测试用假 S3:任意 PUT 记录 {path, authorization, body} 到 JSONL 并返 200。
// 用法: node fake-s3.cjs <port> <logPath>
const http = require("node:http");
const fs = require("node:fs");

const [port, logPath] = process.argv.slice(2);
http
  .createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (req.method === "PUT") {
        fs.appendFileSync(
          logPath,
          JSON.stringify({
            path: req.url,
            authorization: req.headers.authorization || "",
            body: Buffer.concat(chunks).toString("utf8"),
          }) + "\n"
        );
      }
      res.writeHead(200, { "content-type": "application/xml" });
      res.end("<Ok/>");
    });
  })
  .listen(Number(port));
```

- [ ] **Step 2: run-tests.sh 加 T27（汇总之前）**

```bash
echo ""
echo "== T27: S3 归档全链路(fake-s3:key 形状/签名头/故障不阻塞/对账兜底) =="
# 重启后端,带上指向 fake-s3 的 S3 配置(同一数据目录)
FAKE_PORT=4999
FAKE_LOG="$WORK/fakes3.jsonl"
node "$SCRIPT_DIR/fake-s3.cjs" "$FAKE_PORT" "$FAKE_LOG" &
FAKE_PID=$!
kill "$SERVER_PID" 2>/dev/null; kill_port; sleep 0.5
( cd "$REPO/server" && VANTAGE_DATA_DIR="$DATA_DIR" INGEST_TOKEN="$TOKEN" PORT="$PORT" \
    VANTAGE_S3_BUCKET="test-bucket" VANTAGE_S3_REGION="us-east-1" \
    VANTAGE_S3_ENDPOINT="http://localhost:$FAKE_PORT" \
    AWS_ACCESS_KEY_ID="AKIDEXAMPLE" AWS_SECRET_ACCESS_KEY="testsecret" \
    VANTAGE_S3_SWEEP_INTERVAL_SEC=5 \
    npm start >"$WORK/server-s3.log" 2>&1 ) &
SERVER_PID=$!
for _ in $(seq 1 30); do curl -sf "$LIVE/health" >/dev/null 2>&1 && break; sleep 0.3; done

# 1) 正常归档:PUT 到达 fake-s3,key 含 event_id,带 SigV4 头
S4="44444444-4444-4444-4444-444444444444"
cp "$FIX/claude/$S1.jsonl" "$SB/.claude/projects/proj/$S4.jsonl"
node -e 'const fs=require("fs");const p=process.argv[1];const l=fs.readFileSync(p,"utf8").split("\n");l[0]=l[0].replace(/11111111-1111-1111-1111-111111111111/g,"44444444-4444-4444-4444-444444444444");fs.writeFileSync(p,l.join("\n"))' "$SB/.claude/projects/proj/$S4.jsonl"
endhook "$S4" "logout"; sleep 1.5
EID27="$($Q field "$S4" event_id)"
fake_has(){ grep -c "$1" "$FAKE_LOG" 2>/dev/null || true; }
[ "$(fake_has "$EID27")" -ge 1 ] && ok "T27 event 已 PUT 到 S3(key 含 event_id)" || no "T27 PUT 归档" "含 $EID27" "$(cat "$FAKE_LOG" 2>/dev/null | head -3)"
grep '"path":"/events/dt=' "$FAKE_LOG" | grep -q "_claude-code.json" \
  && ok "T27 key 形状 events/dt=..._claude-code.json" || no "T27 key 形状" "events/dt=…_claude-code.json" "$(head -1 "$FAKE_LOG")"
grep -q '"authorization":"AWS4-HMAC-SHA256 ' "$FAKE_LOG" \
  && ok "T27 带 SigV4 Authorization 头" || no "T27 签名头" "AWS4-HMAC-SHA256" "无"

# 2) S3 宕机:/ingest 照常成功(异步不阻塞),事件落死信
kill "$FAKE_PID" 2>/dev/null; sleep 0.3
S5="55555555-5555-5555-5555-555555555555"
cp "$SB/.claude/projects/proj/$S4.jsonl" "$SB/.claude/projects/proj/$S5.jsonl"
node -e 'const fs=require("fs");const p=process.argv[1];fs.writeFileSync(p,fs.readFileSync(p,"utf8").replace(/44444444-4444-4444-4444-444444444444/g,"55555555-5555-5555-5555-555555555555"))' "$SB/.claude/projects/proj/$S5.jsonl"
endhook "$S5" "logout"; sleep 1.5
assert "T27 S3 宕机 ingest 照常" "赵六" "$(name_of "$S5")"
DEAD_JSONL="$DATA_DIR/s3-archive-dead.jsonl"
EID27b="$($Q field "$S5" event_id)"
[ -s "$DEAD_JSONL" ] && grep -q "$EID27b" "$DEAD_JSONL" \
  && ok "T27 失败事件落死信" || no "T27 死信" "含 $EID27b" "$(cat "$DEAD_JSONL" 2>/dev/null | head -2)"

# 3) S3 恢复:对账器(VANTAGE_S3_SWEEP_INTERVAL_SEC=5)自动补传死信
node "$SCRIPT_DIR/fake-s3.cjs" "$FAKE_PORT" "$FAKE_LOG" &
FAKE_PID=$!
sleep 7
[ "$(fake_has "$EID27b")" -ge 1 ] && ok "T27 对账器补传死信成功" || no "T27 对账补传" "含 $EID27b" "$(tail -2 "$FAKE_LOG")"
[ -s "$DEAD_JSONL" ] && no "T27 死信应清空" "空" "仍有内容" || ok "T27 死信已清空"
kill "$FAKE_PID" 2>/dev/null
```

注意：`$Q field` 依赖 `$DATA`(run-tests.sh 顶部已设 `$DATA_DIR/usage.jsonl`)，重启后端沿用同目录，无需改动。

- [ ] **Step 3: 跑全量 E2E**

Run: `bash tests/run-tests.sh`
Expected: T1-T27 全 PASS

- [ ] **Step 4: Commit**

```bash
git add tests/fake-s3.cjs tests/run-tests.sh
git commit -m "测试:T27 fake-S3 全链路(归档/签名头/故障不阻塞/对账兜底)"
```

---

### Task 10: 冒烟脚本 + 恢复脚本

**Files:**
- Create: `server/scripts/s3-smoke.ts`
- Create: `server/scripts/s3-restore.ts`
- Modify: `server/package.json`(scripts)

- [ ] **Step 1: 冒烟脚本**

```ts
// server/scripts/s3-smoke.ts
// 真实 S3 冒烟:PUT -> GET 比对 -> LIST 可见。用法:
//   VANTAGE_S3_BUCKET=... VANTAGE_S3_REGION=... AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... npm run smoke:s3
import { s3ConfigFromEnv, putObject, getObject, listKeys } from "../src/s3.ts";
import { ulid } from "../src/ulid.ts";

const cfg = s3ConfigFromEnv();
if (!cfg.enabled) {
  console.error("未配置 S3 环境变量(VANTAGE_S3_BUCKET / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY)");
  process.exit(1);
}
const now = new Date().toISOString();
const key = `events/dt=${now.slice(0, 10)}/smoke_${ulid()}_codex.json`;
const body = JSON.stringify({ smoke: true, at: now });

const put = await putObject(cfg, key, body);
console.log(`PUT ${key} -> ${put.status}`);
if (put.status !== 200) { console.error(put.body); process.exit(1); }

const get = await getObject(cfg, key);
console.log(`GET -> ${get.status} 内容一致=${get.body === body}`);
if (get.status !== 200 || get.body !== body) process.exit(1);

const list = await listKeys(cfg, "events/");
console.log(`LIST events/ -> ${list.status} 共 ${list.keys.length} 个 key,包含冒烟 key=${list.keys.includes(key)}`);
process.exit(list.status === 200 && list.keys.includes(key) ? 0 : 1);
```

- [ ] **Step 2: 恢复脚本（spec §9)**

```ts
// server/scripts/s3-restore.ts
// 从 S3 events/ 全量恢复本地 usage.jsonl(灾难恢复用,spec §9)。
// 用法:npm run restore:s3 -- <输出路径,默认 data/usage-restored.jsonl>
// 恢复后:停服 -> 用输出文件替换 data/usage.jsonl -> 重启(replay 自动按 effective_ts 合并)。
import { writeFileSync } from "node:fs";
import { s3ConfigFromEnv, getObject, listKeys } from "../src/s3.ts";

const cfg = s3ConfigFromEnv();
if (!cfg.enabled) { console.error("未配置 S3 环境变量"); process.exit(1); }
const out = process.argv[2] ?? "data/usage-restored.jsonl";

console.log("LIST events/ ...");
const list = await listKeys(cfg, "events/");
if (list.status !== 200) { console.error(`LIST 失败 status=${list.status}`); process.exit(1); }
console.log(`共 ${list.keys.length} 个 event,开始下载...`);

const lines: string[] = [];
let done = 0;
const CONCURRENCY = 50;
for (let i = 0; i < list.keys.length; i += CONCURRENCY) {
  const batch = await Promise.all(list.keys.slice(i, i + CONCURRENCY).map((k) => getObject(cfg, k)));
  for (const r of batch) if (r.status === 200 && r.body.trim()) lines.push(r.body);
  done += batch.length;
  if (done % 5000 < CONCURRENCY) console.log(`  ${done}/${list.keys.length}`);
}
// 按 received_at 排序(便于人工查看;合并规则与顺序无关,非必须)
lines.sort((a, b) => {
  try { return String(JSON.parse(a).received_at).localeCompare(String(JSON.parse(b).received_at)); }
  catch { return 0; }
});
writeFileSync(out, lines.join("\n") + "\n");
console.log(`已写出 ${lines.length} 行 -> ${out}`);
console.log("下一步:停服,用它替换 server/data/usage.jsonl,重启。");
```

- [ ] **Step 3: package.json scripts 加**

```json
"smoke:s3": "tsx scripts/s3-smoke.ts",
"restore:s3": "tsx scripts/s3-restore.ts",
```

- [ ] **Step 4: 验证（无 S3 环境时的退出路径）+ 全量测试**

```bash
cd server && npm run smoke:s3; echo "exit=$?"   # 期望:打印未配置提示,exit=1
npm test && bash ../tests/run-tests.sh
```

Expected: 单测与 E2E 全 PASS

- [ ] **Step 5: Commit**

```bash
git add server/scripts/s3-smoke.ts server/scripts/s3-restore.ts server/package.json
git commit -m "服务端:S3 冒烟(PUT/GET/LIST)与灾难恢复脚本"
```

---

### Task 11: 部署文档 + README

**Files:**
- Create: `docs/s3-setup.md`
- Modify: `README.md`（架构段加一句）

- [ ] **Step 1: 写 docs/s3-setup.md**

内容要点（完整成文）:
1. 创建桶：名称 `vantage-prod`、选定 region（公司就近，如新加坡 ap-southeast-1；若用中国区域见文末）、Block Public Access 四项全开、默认加密 SSE-S3、**不开版本控制**(append-only 用不到）。
2. 创建 IAM 用户 `vantage-archiver`（只给编程访问/访问密钥），附加内联策略（即 spec §12 的 JSON，全文照抄）。
3. 服务器（192.168.20.15）配置环境变量：`VANTAGE_S3_BUCKET`、`VANTAGE_S3_REGION`、`AWS_ACCESS_KEY_ID`、`AWS_SECRET_ACCESS_KEY`；可选 `VANTAGE_S3_ENDPOINT`（默认按桶+region 推导虚拟托管式）、`VANTAGE_S3_SWEEP_INTERVAL_SEC`（默认 600)。
4. 重启后端，启动日志应见 `[vantage][s3] S3 归档已启用 ...`；未见则检查环境变量。
5. 冒烟：`npm run smoke:s3` 应输出 PUT/GET/LIST 全 200。
6. 灾难恢复：`npm run restore:s3` → 停服 → 替换 `server/data/usage.jsonl` → 重启。
7. 备注：归档自部署之日起生效，历史 usage.jsonl 不回灌（如需回灌另议）；中国区域（aws-cn）需把 `VANTAGE_S3_ENDPOINT` 设为 `https://<bucket>.s3.<region>.amazonaws.com.cn`。

- [ ] **Step 2: README 架构段补一句**

在 README 描述后端存储的位置加一句：上报同时异步归档到 AWS S3（不可变事件，详见 docs/s3-setup.md 与 docs/superpowers/specs/2026-07-17-s3-storage-design.md)，本地 JSONL 仍是热数据。

- [ ] **Step 3: Commit**

```bash
git add docs/s3-setup.md README.md
git commit -m "文档:S3 部署指南(桶/IAM/环境变量/冒烟/恢复)+ README 补归档说明"
```

---

### Task 12: 收尾——全量验证

- [ ] **Step 1: 全量**

```bash
cd server && npm test
cd .. && bash tests/run-tests.sh
```

Expected: 单测 21 个全 PASS;E2E T1-T27 全 PASS

- [ ] **Step 2: 复核 git log 与改动面**

```bash
git log --oneline main ^dbff4e8
git diff --stat dbff4e8..main
```

确认：plugin 只动 2 行（observed_at 更名）；服务端新增 6 文件改 3；测试新增 2 文件改 1；文档 2。

---

## Self-Review 记录（计划作者已核对）

- **spec 覆盖**:§2/§3 key 与分区 → Task 7 eventKey + T27;§4 信封+透传 → Task 3 + Task 4;§5 原理（无需代码）;§6 合并规则 → Task 3 + T26;§7 views v1 不做（spec 明示）;§8 写入流程/失败语义 → Task 2、7、8 + T27;§9 恢复 → Task 10 restore;§10/§11 成本与桶配置 → Task 11 文档（不开版本控制、不转层为控制台操作）;§12 IAM → Task 11 策略 JSON。
- **占位符**：无 TBD/TODO；所有代码完整。
- **类型一致**:`s3ConfigFromEnv/putObject/getObject/listKeys`(s3.ts）被 archive.ts 与 scripts 引用一致；`initArchive` 返回 `{enqueue,drain,sweep,stop}`;`eventKey` 接收 `StoredRecord`;`upsert` 返回 `StoredRecord`（含可选 event_id);`Putter` 签名 `(key, body) => Promise<{status}>`。
- **实施时注意**:Task 3 store.test.ts 的 replay 测试需把 `require` 改为顶部 import（计划已注明）;Task 7 eventKey 去掉 `.replace("T","T")` 笔误（计划已注明）。
