"use strict";
// 解析 Codex（桌面版）的 rollout JSONL。极度容错，字段缺失/变动不崩。
// 每行结构：{ timestamp, type, payload }
//   type=session_meta   payload.{session_id, cwd, cli_version, ...}
//   type=event_msg      payload.type ∈ {user_message, agent_message, token_count, ...}
//   type=response_item  payload.type ∈ {function_call, custom_tool_call, message, ...}
const fs = require("node:fs");
const { redact, truncate } = require("../core.cjs");

function parseCodexRollout(rolloutPath) {
  let content;
  try {
    content = fs.readFileSync(rolloutPath, "utf8");
  } catch {
    return null;
  }
  const lines = content.split("\n");

  let sessionId = "";
  let cwd = "";
  let firstPrompt = "";
  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let model = "";
  let firstTs = "";
  let lastTs = "";

  for (const line of lines) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.timestamp) {
      if (!firstTs) firstTs = o.timestamp;
      lastTs = o.timestamp;
    }
    const p = o.payload || {};
    const pt = p.type;

    if (o.type === "session_meta") {
      if (p.session_id && !sessionId) sessionId = p.session_id;
      if (p.cwd && !cwd) cwd = p.cwd;
      continue;
    }

    if (o.type === "turn_context" && p.model) {
      model = String(p.model); // 记录使用的模型（取最后一次）
      continue;
    }

    if (o.type === "event_msg") {
      if (pt === "user_message") {
        userMessages += 1;
        if (!firstPrompt && typeof p.message === "string") firstPrompt = p.message;
      } else if (pt === "agent_message") {
        assistantMessages += 1;
      } else if (pt === "token_count") {
        // 累计用量：取最后一个 token_count 的 total_token_usage
        const u = p.info && p.info.total_token_usage;
        if (u) {
          inputTokens = Number(u.input_tokens || 0);
          outputTokens = Number(u.output_tokens || 0);
          totalTokens = Number(u.total_tokens || inputTokens + outputTokens);
        }
      }
      continue;
    }

    if (o.type === "response_item") {
      if (pt === "function_call" || pt === "custom_tool_call") toolCalls += 1;
      continue;
    }
  }

  // 兜底 session_id：从文件名 rollout-...-<uuid>.jsonl 提取
  if (!sessionId) {
    const m = rolloutPath.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    if (m) sessionId = m[1];
  }

  let durationMs = null;
  if (firstTs && lastTs) {
    const d = Date.parse(lastTs) - Date.parse(firstTs);
    if (!Number.isNaN(d) && d >= 0) durationMs = d;
  }

  return {
    tool: "codex",
    session_id: sessionId,
    model,
    project: cwd,
    started_at: firstTs || null,
    ended_at: lastTs || null,
    duration_ms: durationMs,
    user_messages: userMessages,
    assistant_messages: assistantMessages,
    tool_calls: toolCalls,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    first_prompt: truncate(redact(firstPrompt), 300),
    summary: truncate(redact(firstPrompt), 120), // Codex 无 AI 标题，用首句提问
  };
}

module.exports = { parseCodexRollout };
