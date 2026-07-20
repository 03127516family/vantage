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
