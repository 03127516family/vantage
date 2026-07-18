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

test("eventKey: 带前缀时拼到 events/ 之前(默认空前缀=桶根)", () => {
  assert.equal(
    eventKey(stored({}), "vantage-prod/"),
    "vantage-prod/events/dt=2026-07-17/20260717T093012.015Z_01J9X7K2M4000000000000AB_codex.json"
  );
  assert.equal(eventKey(stored({}), ""), "events/dt=2026-07-17/20260717T093012.015Z_01J9X7K2M4000000000000AB_codex.json");
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

test("sweep: 从 offset 只补传新增行;重复 sweep 不重复 PUT", async () => {
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
