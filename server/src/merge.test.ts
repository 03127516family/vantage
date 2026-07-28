import { test } from "node:test";
import assert from "node:assert/strict";
import { createMergeState, mergeInto, eventKey, normalizeQuota, type StoredRecord } from "./merge.ts";

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
  const hit = rec({ quota: { limit_reached: true, observed_at: "2026-07-20T10:00:00.000Z" }, observed_at: "2026-07-20T10:00:00.000Z" });
  mergeInto(st, hit);
  mergeInto(st, hit); // Lambda 水位线回退/并发重建会重复处理同一事件
  assert.equal(st.wallHits.length, 1);
  mergeInto(st, rec({ quota: { limit_reached: true, observed_at: "2026-07-20T11:00:00.000Z" }, observed_at: "2026-07-20T11:00:00.000Z" })); // 不同时刻另算
  assert.equal(st.wallHits.length, 2);
  assert.deepEqual(st.wallHits[0], { name: "甲", at: Date.parse("2026-07-20T10:00:00.000Z"), type: "rate_limit_reached" });
});

test("mergeInto: quota 粘性——新记录无 quota 时沿用上次(wham 失败不丢额度)", () => {
  const st = createMergeState();
  mergeInto(st, rec({ quota: { used_percent: 80, limit_reached: false, observed_at: "2026-07-20T10:00:00.000Z" }, observed_at: "2026-07-20T10:00:00.000Z" }));
  // 下一轮 wham 失败：新记录不带 quota，但更新（effective_ts 更大）
  mergeInto(st, rec({ total_tokens: 999, observed_at: "2026-07-20T11:00:00.000Z" }));
  const got = st.index.get("codex:s1");
  assert.equal(got?.total_tokens, 999); // 新值生效
  assert.equal(got?.quota?.used_percent, 80); // quota 沿用上次，未被空值覆盖
});

test("normalizeQuota: 老双窗字段 → 补 quota 对象，旧字段保留（过渡兼容）", () => {
  const r = rec({
    quota_primary_pct: 16,
    quota_secondary_pct: 84,
    quota_plan: "plus",
    quota_reached: "primary",
    observed_at: "2026-07-20T10:00:00.000Z",
  }) as any;
  normalizeQuota(r);
  assert.equal(r.quota_primary_pct, 16); // 旧字段保留（不删，供老消费者）
  assert.equal(r.quota?.used_percent, 84); // 优先 secondary(7d)
  assert.equal(r.quota?.plan_type, "plus");
  assert.equal(r.quota?.limit_reached, true); // quota_reached 非空 → 撞墙
  assert.equal(r.quota?.observed_at, "2026-07-20T10:00:00.000Z");
});

test("normalizeQuota: 已是新形状/无额度 → 不动", () => {
  const neo: any = { quota: { used_percent: 50, limit_reached: false } };
  normalizeQuota(neo);
  assert.equal(neo.quota.used_percent, 50); // 不变
  const bare: any = { total_tokens: 10 };
  normalizeQuota(bare);
  assert.equal(bare.quota, undefined); // 无额度字段，不加 quota
});

test("normalizeQuota: 完整 wham/usage 响应 → 提取 primary_window 为标准 quota", () => {
  const raw: any = {
    quota: {
      plan_type: "plus",
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: {
          used_percent: 14,
          limit_window_seconds: 604800,
          reset_after_seconds: 517450,
          reset_at: 1785716826,
        },
        secondary_window: null,
      },
      observed_at: "2026-07-27T10:00:00.000Z",
    },
  };
  normalizeQuota(raw);
  assert.equal(raw.quota.used_percent, 14);
  assert.equal(raw.quota.plan_type, "plus");
  assert.equal(raw.quota.limit_reached, false);
  assert.equal(raw.quota.reset_at, new Date(1785716826 * 1000).toISOString());
  assert.equal(raw.quota.observed_at, "2026-07-27T10:00:00.000Z");
});

test("eventKey: <prefix>events/dt=<received_at 日期>/<紧凑时间>_<event_id>_<tool>.json", () => {
  const k = eventKey(rec({ event_id: "01J", received_at: "2026-07-20T10:00:15.123Z" }), "vantage-prod/");
  assert.equal(k, "vantage-prod/events/dt=2026-07-20/20260720T100015.123Z_01J_codex.json");
});
