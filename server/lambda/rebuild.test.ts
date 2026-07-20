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
