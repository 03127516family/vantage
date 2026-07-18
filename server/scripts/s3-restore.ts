// 从 S3 events/ 全量恢复本地 usage.jsonl(灾难恢复用,spec §9)。
// 用法:npm run restore:s3 -- <输出路径,默认 data/usage-restored.jsonl>
// 恢复后:停服 -> 用输出文件替换 data/usage.jsonl -> 重启(replay 自动按 effective_ts 合并)。
import { writeFileSync } from "node:fs";
import { s3ConfigFromEnv, getObject, listKeys } from "../src/s3.ts";

const cfg = s3ConfigFromEnv();
if (!cfg.enabled) { console.error("未配置 S3 环境变量"); process.exit(1); }
const out = process.argv[2] ?? "data/usage-restored.jsonl";

console.log(`LIST ${cfg.prefix}events/ ...`);
const list = await listKeys(cfg, `${cfg.prefix}events/`);
if (list.status !== 200) { console.error(`LIST 失败 status=${list.status}`); process.exit(1); }
console.log(`共 ${list.keys.length} 个 event,开始下载...`);

const lines: string[] = [];
let done = 0;
const CONCURRENCY = 50;
for (let i = 0; i < list.keys.length; i += CONCURRENCY) {
  const batch = await Promise.all(list.keys.slice(i, i + CONCURRENCY).map((k) => getObject(cfg, k)));
  for (const r of batch) if (r.status === 200 && r.body.trim()) lines.push(r.body);
  done += batch.length;
  if (done % 5000 < CONCURRENCY) console.log(`  ${done}/${list.keys.length}`);
}
// 按 received_at 排序(便于人工查看;合并规则与顺序无关,非必须)
lines.sort((a, b) => {
  try { return String(JSON.parse(a).received_at).localeCompare(String(JSON.parse(b).received_at)); }
  catch { return 0; }
});
writeFileSync(out, lines.join("\n") + "\n");
console.log(`已写出 ${lines.length} 行 -> ${out}`);
console.log("下一步:停服,用它替换 server/data/usage.jsonl,重启。");
