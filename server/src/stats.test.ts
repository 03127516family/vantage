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
