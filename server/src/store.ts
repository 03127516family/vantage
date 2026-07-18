import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { ulid } from "./ulid.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
// 默认存到 server/data;可用 VANTAGE_DATA_DIR 覆盖(测试用独立目录,避免污染真实数据)
const dataDir = process.env.VANTAGE_DATA_DIR ?? join(__dirname, "..", "data");
mkdirSync(dataDir, { recursive: true });
const jsonlPath = join(dataDir, "usage.jsonl");

/**
 * 一条使用记录(一次会话的当前完整快照)。
 * 采集器每次上传的是"这个会话到目前为止的全量",服务端按 dedupe_key 合并,
 * 因此重复触发 / 重试 / 扫描兜底都不会造成重复统计。
 */
/** 单个模型在一次会话里的用量明细(请求数 + 各类 token)。 */
export interface ModelUsage {
  requests?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  // 缓存写入分档(算成本用:5 分钟档 1.25 倍 input 单价,1 小时档 2 倍)。
  // 老记录无此字段;总数 - (5m+1h) 的差值视为"未知档"按 1.25 估算。
  cache_creation_5m_tokens?: number;
  cache_creation_1h_tokens?: number;
  reasoning_tokens?: number;
}

export interface UsageRecord {
  // 身份(安装时填写)
  name?: string;
  email?: string;
  department?: string;
  machine?: string;
  // 会话
  tool?: string; // 'claude-code' | 'codex'
  session_id?: string;
  model?: string; // 使用的模型,如 claude-opus-4-8 / gpt-5.5
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
  cache_read_tokens?: number; // 命中缓存的输入 token(成本低)
  cache_creation_tokens?: number; // 写入缓存的输入 token(总数)
  cache_creation_5m_tokens?: number; // 其中 5 分钟档(1.25 倍计价)
  cache_creation_1h_tokens?: number; // 其中 1 小时档(2 倍计价)
  reasoning_tokens?: number; // 推理 token
  // 分模型明细:一个会话可能用多个模型,这里按模型分开记(请求数 + 各类 token)。
  // 保留了模型维度,供服务端还原"按模型统计",不因聚合到会话而丢失。
  by_model?: Record<string, ModelUsage>;
  // 当前用量(额度)——仅 Codex 会话带;used_percent 为"已用百分比"
  quota_primary_pct?: number | null; // 短窗(Codex 约 5 小时)
  quota_secondary_pct?: number | null; // 长窗(Codex 每周)
  quota_plan?: string | null; // 套餐,如 plus
  quota_reached?: string | null; // 撞到额度墙的类型,null=未撞
  // 内容
  first_prompt?: string;
  summary?: string;
  exit_reason?: string;
  // 由采集器生成,用于去重(一般 = tool + ':' + session_id)
  dedupe_key?: string;
  // 采集时刻(快照生成时间)。observed_at 为新字段名;collected_at 为旧采集端字段名,回退兼容。
  observed_at?: string;
  collected_at?: string;
}

export interface StoredRecord extends UsageRecord {
  // 服务端信封:归档与恢复用(spec §4)。老 JSONL 行可能没有 event_id,故标可选。
  event_id?: string;
  received_at: string;
}

// 内存索引:dedupe_key -> effective_ts 最大的记录
const index = new Map<string, StoredRecord>();

function keyOf(r: UsageRecord): string {
  return r.dedupe_key || `${r.tool ?? "unknown"}:${r.session_id ?? "no-session"}`;
}

/**
 * 有效观测时间:判断"哪份快照更新"的依据(spec §6)。
 * 同一 session 的上报只来自一台机器,该比较是同钟比较,不受跨机器时钟误差影响。
 * 全部缺失时按 0 处理(永不覆盖已有正常记录)。
 */
export function effectiveTs(r: UsageRecord): number {
  const s = r.observed_at ?? r.collected_at ?? r.ended_at ?? r.received_at;
  const t = s ? Date.parse(s) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

/**
 * 合并进索引:同 key 取 effective_ts 大者(相等时后到者胜,等价于同毫秒内的后到覆盖)。
 * 注意:这只决定"当前状态";无论胜负,记录都已写进 JSONL/S3(事件不丢)。
 * 与读取顺序无关(order-independent),回放可任意并行。
 */
function mergeIndex(rec: StoredRecord): void {
  const k = keyOf(rec);
  const prev = index.get(k);
  if (!prev || effectiveTs(rec) >= effectiveTs(prev)) index.set(k, rec);
}

// 启动时回放 JSONL 重建索引(与 upsert 同一套合并规则)
function replay() {
  if (!existsSync(jsonlPath)) return;
  const lines = readFileSync(jsonlPath, "utf8").split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      mergeIndex(JSON.parse(line) as StoredRecord);
    } catch {
      // 跳过损坏行
    }
  }
}
replay();

/**
 * 追加写日志 + 盖服务端信封 + 按 effective_ts 合并进索引。
 * 信封(event_id/received_at)一律以服务端为准,客户端传入的同名字段被覆盖。
 */
export function upsert(rec: UsageRecord): StoredRecord {
  const stored: StoredRecord = {
    ...rec,
    event_id: ulid(),
    received_at: new Date().toISOString(),
  };
  appendFileSync(jsonlPath, JSON.stringify(stored) + "\n");
  mergeIndex(stored);
  return stored;
}

/** 当前所有会话(每个 session 只保留 effective_ts 最大的快照) */
export function allSessions(): StoredRecord[] {
  return [...index.values()];
}

export { jsonlPath };
