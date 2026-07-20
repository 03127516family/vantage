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
