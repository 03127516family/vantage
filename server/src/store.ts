import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, appendFileSync, readFileSync, existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
// 默认存到 server/data；可用 VANTAGE_DATA_DIR 覆盖（测试用独立目录，避免污染真实数据）
const dataDir = process.env.VANTAGE_DATA_DIR ?? join(__dirname, "..", "data");
mkdirSync(dataDir, { recursive: true });
const jsonlPath = join(dataDir, "usage.jsonl");

/**
 * 一条使用记录（一次会话的当前完整快照）。
 * 采集器每次上传的是"这个会话到目前为止的全量"，服务端按 dedupe_key 覆盖，
 * 因此重复触发 / 重试 / 扫描兜底都不会造成重复统计。
 */
/** 单个模型在一次会话里的用量明细（请求数 + 各类 token）。 */
export interface ModelUsage {
  requests?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  reasoning_tokens?: number;
}

export interface UsageRecord {
  // 身份（安装时填写）
  name?: string;
  email?: string;
  department?: string;
  machine?: string;
  // 会话
  tool?: string; // 'claude-code' | 'codex'
  session_id?: string;
  model?: string; // 使用的模型，如 claude-opus-4-8 / gpt-5.5
  project?: string;
  started_at?: string;
  ended_at?: string;
  duration_ms?: number;
  // 用量
  user_messages?: number;
  assistant_messages?: number;
  tool_calls?: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cache_read_tokens?: number; // 命中缓存的输入 token（成本低）
  cache_creation_tokens?: number; // 写入缓存的输入 token
  reasoning_tokens?: number; // 推理 token
  // 分模型明细：一个会话可能用多个模型，这里按模型分开记（请求数 + 各类 token）。
  // 保留了模型维度，供服务端还原“按模型统计”，不因聚合到会话而丢失。
  by_model?: Record<string, ModelUsage>;
  // 当前用量（额度）——仅 Codex 会话带；used_percent 为“已用百分比”
  quota_primary_pct?: number | null; // 短窗（Codex 约 5 小时）
  quota_secondary_pct?: number | null; // 长窗（Codex 每周）
  quota_plan?: string | null; // 套餐，如 plus
  quota_reached?: string | null; // 撞到额度墙的类型，null=未撞
  // 内容
  first_prompt?: string;
  summary?: string;
  exit_reason?: string;
  // 由采集器生成，用于去重（一般 = tool + ':' + session_id）
  dedupe_key?: string;
}

interface StoredRecord extends UsageRecord {
  received_at: string;
}

// 内存索引：dedupe_key -> 最新记录（last-wins）
const index = new Map<string, StoredRecord>();

function keyOf(r: UsageRecord): string {
  return r.dedupe_key || `${r.tool ?? "unknown"}:${r.session_id ?? "no-session"}`;
}

// 启动时回放 JSONL 重建索引（同 key 后写覆盖先写）
function replay() {
  if (!existsSync(jsonlPath)) return;
  const lines = readFileSync(jsonlPath, "utf8").split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as StoredRecord;
      index.set(keyOf(rec), rec);
    } catch {
      // 跳过损坏行
    }
  }
}
replay();

/** 追加写日志 + 更新内存索引（upsert 语义） */
export function upsert(rec: UsageRecord): StoredRecord {
  const stored: StoredRecord = { ...rec, received_at: new Date().toISOString() };
  appendFileSync(jsonlPath, JSON.stringify(stored) + "\n");
  index.set(keyOf(stored), stored);
  return stored;
}

/** 当前所有会话（每个 session 只保留最新快照） */
export function allSessions(): StoredRecord[] {
  return [...index.values()];
}

export { jsonlPath };
