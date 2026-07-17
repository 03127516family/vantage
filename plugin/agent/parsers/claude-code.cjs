"use strict";
// 解析 Claude Code 的 transcript JSONL。极度容错：任何字段缺失/格式变化都不崩，
// 拿不到就留空。官方声明该格式为内部实现、可能变动，所以这里全部防御式取值。
const fs = require("node:fs");
const { redact, truncate } = require("../core.cjs");

// 从 message.content 里提取纯文本（content 可能是字符串或内容块数组）
function extractText(message) {
  if (!message) return "";
  const c = message.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}

// 判断一条 user 行是否为"真人提问"（排除工具结果回填）
function isHumanPrompt(o) {
  if (!o.message || o.message.role !== "user") return false;
  const c = o.message.content;
  if (typeof c === "string") return c.trim().length > 0;
  if (Array.isArray(c)) {
    // 含 tool_result 的是工具回填，不是真人提问
    if (c.some((b) => b && b.type === "tool_result")) return false;
    return c.some((b) => b && b.type === "text" && b.text && b.text.trim());
  }
  return false;
}

function countToolUses(message) {
  if (!message || !Array.isArray(message.content)) return 0;
  return message.content.filter((b) => b && b.type === "tool_use").length;
}

/**
 * @param {string} transcriptPath
 * @returns {object|null} UsageRecord（不含身份，由 collector 合并）
 */
function parseClaudeTranscript(transcriptPath) {
  let content;
  try {
    content = fs.readFileSync(transcriptPath, "utf8");
  } catch {
    return null;
  }
  const lines = content.split("\n");

  let sessionId = "";
  let cwd = "";
  let firstPrompt = "";
  let aiTitle = "";
  let lastPrompt = "";
  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0; // 命中缓存的输入 token
  let cacheCreationTokens = 0; // 写入缓存的输入 token(总数,老格式只有它)
  // 缓存写入分档明细:5 分钟档按 input 单价 1.25 倍计费,1 小时档按 2 倍。
  // usage.cache_creation 里有拆分(ephemeral_5m/1h_input_tokens);只取总数会让
  // 服务端算成本时只能猜倍率(最多低估 60%)。老 transcript 无此字段则两项为 0,
  // 服务端可用 总数-(5m+1h) 识别出"未知档"部分做估算。
  let cache5mTokens = 0;
  let cache1hTokens = 0;
  let model = "";
  let firstTs = "";
  let lastTs = "";
  // 分模型明细：一个会话可能同时用多个模型（主模型 + 子任务/标题用的小模型），
  // 聚合成单一 model 会丢掉模型维度，这里按模型分开累计（请求数 + 各类 token）。
  const byModel = {};
  const accModel = (m, u) => {
    const k = m || "unknown";
    const b =
      byModel[k] ||
      (byModel[k] = {
        requests: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        cache_creation_5m_tokens: 0,
        cache_creation_1h_tokens: 0,
        reasoning_tokens: 0,
      });
    b.requests += 1;
    b.input_tokens += Number(u.input_tokens || 0);
    b.output_tokens += Number(u.output_tokens || 0);
    b.cache_read_tokens += Number(u.cache_read_input_tokens || 0);
    b.cache_creation_tokens += Number(u.cache_creation_input_tokens || 0);
    const cc = u.cache_creation || {};
    b.cache_creation_5m_tokens += Number(cc.ephemeral_5m_input_tokens || 0);
    b.cache_creation_1h_tokens += Number(cc.ephemeral_1h_input_tokens || 0);
  };

  for (const line of lines) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }

    if (o.sessionId && !sessionId) sessionId = o.sessionId;
    if (o.cwd && !cwd) cwd = o.cwd;
    if (o.timestamp) {
      if (!firstTs) firstTs = o.timestamp;
      lastTs = o.timestamp;
    }
    if (o.type === "ai-title" && o.aiTitle) aiTitle = String(o.aiTitle);
    if (o.type === "last-prompt" && o.lastPrompt) lastPrompt = String(o.lastPrompt);

    if (o.type === "user" && isHumanPrompt(o)) {
      userMessages += 1;
      if (!firstPrompt) firstPrompt = extractText(o.message);
    }

    if (o.type === "assistant" && o.message) {
      assistantMessages += 1;
      toolCalls += countToolUses(o.message);
      if (o.message.model) model = String(o.message.model); // 记录使用的模型（取最后一次）
      // 逐轮累加非缓存输入 + 输出 = 本次会话的 token 消耗量。
      // 与 Codex 的 total_token_usage（其内部也是逐轮累加）口径一致，便于横向比较。
      const u = o.message.usage;
      if (u) {
        inputTokens += Number(u.input_tokens || 0);
        outputTokens += Number(u.output_tokens || 0);
        cacheReadTokens += Number(u.cache_read_input_tokens || 0);
        cacheCreationTokens += Number(u.cache_creation_input_tokens || 0);
        const cc = u.cache_creation || {};
        cache5mTokens += Number(cc.ephemeral_5m_input_tokens || 0);
        cache1hTokens += Number(cc.ephemeral_1h_input_tokens || 0);
        accModel(o.message.model, u); // 按“本条消息自己的模型”分摊，不用会话末模型
      }
    }
  }

  // 摘要优先级：AI 标题 > 首句提问 > 最后提问
  const summarySource = aiTitle || firstPrompt || lastPrompt || "";
  const summary = truncate(redact(summarySource), 120);

  let durationMs = null;
  if (firstTs && lastTs) {
    const d = Date.parse(lastTs) - Date.parse(firstTs);
    if (!Number.isNaN(d) && d >= 0) durationMs = d;
  }

  return {
    tool: "claude-code",
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
    total_tokens: inputTokens + outputTokens,
    cache_read_tokens: cacheReadTokens,
    cache_creation_tokens: cacheCreationTokens,
    cache_creation_5m_tokens: cache5mTokens, // 1.25 倍档
    cache_creation_1h_tokens: cache1hTokens, // 2 倍档
    reasoning_tokens: 0, // Claude 的 usage 不单列推理 token
    by_model: byModel, // 分模型明细：{ [model]: {requests,input,output,cache_read,cache_creation,reasoning} }
    // Claude Code 的会话文件不含额度信息，当前用量类字段留空
    quota_primary_pct: null,
    quota_secondary_pct: null,
    quota_plan: null,
    quota_reached: null,
    first_prompt: truncate(redact(firstPrompt), 300),
    summary,
  };
}

module.exports = { parseClaudeTranscript };
