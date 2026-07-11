"use strict";
// 测试助手：读取后端 JSONL，按 dedupe_key 折叠（last-wins），回答查询。
// 用法:
//   node qserver.cjs <jsonlPath> count
//   node qserver.cjs <jsonlPath> get   <sessionId>          -> 该会话最新记录(JSON) 或 MISSING
//   node qserver.cjs <jsonlPath> field <sessionId> <field>  -> 该会话某字段 或 MISSING
const fs = require("node:fs");

const [jsonlPath, cmd, arg, field] = process.argv.slice(2);

const index = new Map();
try {
  for (const line of fs.readFileSync(jsonlPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      index.set(o.dedupe_key || `${o.tool}:${o.session_id}`, o);
    } catch {
      /* skip */
    }
  }
} catch {
  /* no file yet */
}

const recordFor = (sid) => index.get("claude-code:" + sid) || index.get("codex:" + sid);

if (cmd === "count") {
  console.log(index.size);
} else if (cmd === "get") {
  const r = recordFor(arg);
  console.log(r ? JSON.stringify(r) : "MISSING");
} else if (cmd === "field") {
  const r = recordFor(arg);
  console.log(r ? r[field] : "MISSING");
}
