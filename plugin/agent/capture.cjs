#!/usr/bin/env node
"use strict";
// Vantage —— 采集入口。由 Claude Code SessionEnd 钩子调用（stdin 收到 JSON），
// 或被兜底扫描/手动调用（--file <path> --tool claude-code|codex）。
// 职责：解析会话 -> 合并身份 -> 写本地 spool -> 分离式触发上传。
// 铁律：永远 exit 0、绝不打印 stdout、任何异常都咽下（保证员工无感）。
const fs = require("node:fs");
const path = require("node:path");
const core = require("./core.cjs");
const { parseClaudeTranscript } = require("./parsers/claude-code.cjs");
const { parseCodexRollout } = require("./parsers/codex.cjs");

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--file") out.file = argv[++i];
    else if (a === "--tool") out.tool = argv[++i];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const cfg = core.loadConfig();

  // 1) 定位 transcript 文件 + 事件信息
  let transcriptPath = args.file;
  let exitReason = null;
  const tool = args.tool || "claude-code";

  if (!transcriptPath) {
    const raw = await core.readStdin();
    if (raw && raw.trim()) {
      try {
        const hook = JSON.parse(raw);
        transcriptPath = hook.transcript_path;
        exitReason = hook.exit_reason || null;
      } catch {
        /* 非 JSON stdin，忽略 */
      }
    }
  }

  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    core.log("no transcript path (arg/stdin). skipped.");
    return;
  }

  // 2) 解析（按工具分派）
  const parsed =
    tool === "codex" ? parseCodexRollout(transcriptPath) : parseClaudeTranscript(transcriptPath);
  if (!parsed || !parsed.session_id) {
    core.log(`parse failed or no session_id: ${transcriptPath}`);
    return;
  }

  // 3) 合并身份 + 去重 key
  const record = {
    ...parsed,
    name: cfg.name,
    email: cfg.email,
    department: cfg.department,
    machine: cfg.machine,
    exit_reason: exitReason,
    dedupe_key: `${parsed.tool}:${parsed.session_id}`,
    collected_at: new Date().toISOString(),
  };

  // 4) 落 spool（同会话覆盖，原子写）
  const file = core.writeSpool(record);
  core.log(`spooled ${record.dedupe_key} tokens=${record.total_tokens} -> ${path.basename(file)}`);

  // 5) 更新 state.json（记下该会话文件已处理到的 size/mtime，兜底扫描据此跳过）
  try {
    const st = fs.statSync(transcriptPath);
    core.markProcessed(transcriptPath, st.size, st.mtimeMs);
  } catch {
    /* ignore */
  }

  // 6) 分离式触发上传（不阻塞钩子）
  core.spawnDetached("flush.cjs");
}

main()
  .catch((e) => core.log("capture fatal: " + String(e)))
  .finally(() => process.exit(0));
