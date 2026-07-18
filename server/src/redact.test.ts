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
