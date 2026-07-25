"use strict";
// Vantage —— parser 共享的内容派生逻辑（零依赖，纯函数）。claude-code.cjs / codex.cjs 都 require。
// 只产出有上限、隐私安全的派生字段：枚举意图、有界文件 basename、脱敏截断文本。
// 绝不在此处触碰命令原文/patch 正文/文件内容——上游 parser 只传 basename、计数和已脱敏文本进来。
const path = require("node:path");
const { redact, truncate } = require("../core.cjs");

// 意图关键词（中英双语）。数组顺序即优先级：命中靠前者胜。
// debug 优先于其余，避免“修测试里的 bug”被归到 test；create 优先于 explore，避免“怎么做某功能”落到 explore。
const INTENT_KEYWORDS = [
  ["debug", ["fix", "bug", "error", "crash", "fail", "broken", "报错", "错误", "崩溃", "修复", "失败", "异常", "闪退"]],
  ["test", ["test", "jest", "pytest", "单测", "测试"]],
  ["refactor", ["refactor", "rewrite", "clean", "重构", "重写", "优化", "整理"]],
  ["create", ["create", "write", "generate", "build", "implement", "add", "创建", "新建", "生成", "实现", "添加", "写一个", "做一个"]],
  ["explore", ["explain", "how", "what", "why", "是什么", "怎么", "为什么", "解释", "帮我看"]],
];

// 英文关键词按单词边界匹配（防 fix 命中 prefix）；中文直接 includes。
function matchesKeyword(text, kw) {
  if (/[一-鿿]/.test(kw)) return text.includes(kw);
  return new RegExp(`\\b${kw}\\b`, "i").test(text);
}

/**
 * 由首/末提问推断会话意图；命中优先级靠前的关键词类别。
 * 关键词全没命中时：若有过工具调用（toolCalls>0）说明确实在干活，归 coding；
 * 否则 chat（纯问答/闲聊）。避免“干了 100 次工具操作只因首句没踩中关键词被标成 chat”。
 */
function classifyIntent(firstPrompt, lastPrompt, toolCalls = 0) {
  const text = `${firstPrompt || ""} ${lastPrompt || ""}`.toLowerCase();
  if (text.trim()) {
    for (const [intent, keywords] of INTENT_KEYWORDS) {
      for (const kw of keywords) {
        if (matchesKeyword(text, kw)) return intent;
      }
    }
  }
  return toolCalls > 0 ? "coding" : "chat";
}

/**
 * 文件路径列表 -> { count, sample }。
 * count = 去重后的不同文件数；sample = 出现频次最高的前 8 个 basename（去重）。
 * 只保留 basename（丢目录、丢内容），样本有上限，控制记录体积。
 */
function boundFiles(absPaths) {
  const counts = new Map();
  for (const p of absPaths || []) {
    if (!p || typeof p !== "string") continue;
    const base = path.basename(p).trim();
    if (!base) continue;
    counts.set(base, (counts.get(base) || 0) + 1);
  }
  if (counts.size === 0) return { count: 0, sample: [] };
  const sample = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map((e) => e[0]);
  return { count: counts.size, sample };
}

/** 脱敏 + 截断的薄封装，供新文本字段复用。空串输入返回空串。 */
function redactedTruncated(text, n) {
  if (!text) return "";
  return truncate(redact(text), n);
}

module.exports = { classifyIntent, boundFiles, redactedTruncated };
