import { test } from "node:test";
import assert from "node:assert/strict";
import { s3ConfigFromEnv } from "./s3.ts";

test("s3ConfigFromEnv: 未配置 bucket 或密钥 -> enabled=false", () => {
  assert.equal(s3ConfigFromEnv({}).enabled, false);
  assert.equal(s3ConfigFromEnv({ VANTAGE_S3_BUCKET: "b" }).enabled, false);
  assert.equal(
    s3ConfigFromEnv({ VANTAGE_S3_BUCKET: "b", AWS_ACCESS_KEY_ID: "AK" }).enabled,
    false
  );
});

test("s3ConfigFromEnv: region 默认 us-east-1,可覆盖(aws-cn 填 cn-north-1 即可)", () => {
  const c = s3ConfigFromEnv({
    VANTAGE_S3_BUCKET: "b",
    AWS_ACCESS_KEY_ID: "AK",
    AWS_SECRET_ACCESS_KEY: "SK",
  });
  assert.equal(c.enabled, true);
  assert.equal(c.region, "us-east-1");
  assert.equal(c.endpoint, ""); // 空 = SDK 自动解析
  const cn = s3ConfigFromEnv({
    VANTAGE_S3_BUCKET: "b",
    VANTAGE_S3_REGION: "cn-north-1",
    AWS_ACCESS_KEY_ID: "AK",
    AWS_SECRET_ACCESS_KEY: "SK",
  });
  assert.equal(cn.region, "cn-north-1");
});

test("s3ConfigFromEnv: 拾取 AWS_SESSION_TOKEN(Lambda 执行角色临时凭证必需)", () => {
  const c = s3ConfigFromEnv({
    VANTAGE_S3_BUCKET: "b",
    AWS_ACCESS_KEY_ID: "ASIAEXAMPLE",
    AWS_SECRET_ACCESS_KEY: "SK",
    AWS_SESSION_TOKEN: "TOKEN",
  });
  assert.equal(c.sessionToken, "TOKEN");
  // 静态密钥(本机冒烟/Node 壳)无 token -> 空串,credentials 不传该字段
  assert.equal(
    s3ConfigFromEnv({ VANTAGE_S3_BUCKET: "b", AWS_ACCESS_KEY_ID: "AK", AWS_SECRET_ACCESS_KEY: "SK" }).sessionToken,
    ""
  );
});

test("s3ConfigFromEnv: VANTAGE_S3_ENDPOINT 仅测试用(如 fake-s3)", () => {
  const c = s3ConfigFromEnv({
    VANTAGE_S3_BUCKET: "b",
    AWS_ACCESS_KEY_ID: "AK",
    AWS_SECRET_ACCESS_KEY: "SK",
    VANTAGE_S3_ENDPOINT: "http://localhost:4999",
  });
  assert.equal(c.endpoint, "http://localhost:4999");
});

test("s3ConfigFromEnv: VANTAGE_S3_PREFIX 归一化为带尾斜杠前缀(默认空=桶根)", () => {
  const base = { VANTAGE_S3_BUCKET: "b", AWS_ACCESS_KEY_ID: "AK", AWS_SECRET_ACCESS_KEY: "SK" };
  assert.equal(s3ConfigFromEnv(base).prefix, ""); // 默认空前缀 -> 事件在桶根 events/
  assert.equal(s3ConfigFromEnv({ ...base, VANTAGE_S3_PREFIX: "vantage-prod" }).prefix, "vantage-prod/");
  assert.equal(s3ConfigFromEnv({ ...base, VANTAGE_S3_PREFIX: "/vantage-prod/" }).prefix, "vantage-prod/");
  assert.equal(s3ConfigFromEnv({ ...base, VANTAGE_S3_PREFIX: "team/vantage" }).prefix, "team/vantage/");
});
