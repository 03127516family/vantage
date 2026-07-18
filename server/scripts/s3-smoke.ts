// 真实 S3 冒烟:PUT -> GET 比对 -> LIST 可见。用法:
//   VANTAGE_S3_BUCKET=... VANTAGE_S3_REGION=... AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... npm run smoke:s3
import { s3ConfigFromEnv, putObject, getObject, listKeys } from "../src/s3.ts";
import { ulid } from "../src/ulid.ts";

const cfg = s3ConfigFromEnv();
if (!cfg.enabled) {
  console.error("未配置 S3 环境变量(VANTAGE_S3_BUCKET / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY)");
  process.exit(1);
}
const now = new Date().toISOString();
const key = `events/dt=${now.slice(0, 10)}/smoke_${ulid()}_codex.json`;
const body = JSON.stringify({ smoke: true, at: now });

const put = await putObject(cfg, key, body);
console.log(`PUT ${key} -> ${put.status}`);
if (put.status !== 200) process.exit(1);

const get = await getObject(cfg, key);
console.log(`GET -> ${get.status} 内容一致=${get.body === body}`);
if (get.status !== 200 || get.body !== body) process.exit(1);

const list = await listKeys(cfg, "events/");
console.log(`LIST events/ -> ${list.status} 共 ${list.keys.length} 个 key,包含冒烟 key=${list.keys.includes(key)}`);
process.exit(list.status === 200 && list.keys.includes(key) ? 0 : 1);
