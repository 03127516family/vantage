import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

// node --test 每个测试文件独立子进程;这里统一用一个临时数据目录。
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
