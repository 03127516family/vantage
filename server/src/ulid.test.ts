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
