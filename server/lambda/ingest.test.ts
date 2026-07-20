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
