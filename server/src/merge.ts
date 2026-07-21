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

/**
 * 一条使用记录(一次会话的当前完整快照)。
 * 采集器每次上传的是"这个会话到目前为止的全量",按 dedupe_key 合并,
 * 因此重复触发 / 重试 / 扫描兜底都不会造成重复统计。
 */
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

/** 一条撞墙历史:谁、何时(effective_ts)、撞了哪档墙(primary/secondary 等) */
export interface WallHit {
  name: string;
  at: number; // effective_ts(ms)
  type: string; // quota_reached 原值
}

/** 合并状态:每会话最新快照 + 撞墙历史(去重)。纯内存结构,Node 壳与 Lambda 共用。 */
export interface MergeState {
  index: Map<string, StoredRecord>;
  wallHits: WallHit[];
  wallHitKeys: Set<string>; // `${name} ${at} ${type}`,防水位线回退/并发重建导致撞墙重复计数
}

export function createMergeState(): MergeState {
  return { index: new Map(), wallHits: [], wallHitKeys: new Set() };
}

export function keyOf(r: UsageRecord): string {
  return r.dedupe_key || `${r.tool ?? "unknown"}:${r.session_id ?? "no-session"}`;
}

/**
 * 有效观测时间:判断"哪份快照更新"的依据(spec §6)。
 * 同一 session 的上报只来自一台机器,该比较是同钟比较,不受跨机器时钟误差影响。
 * 全部缺失时按 0 处理(永不覆盖已有正常记录)。
 */
export function effectiveTs(r: UsageRecord & { received_at?: string }): number {
  const s = r.observed_at ?? r.collected_at ?? r.ended_at ?? r.received_at;
  const t = s ? Date.parse(s) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

/**
 * 本地日历日(YYYY-MM-DD),用于"今天是否撞过墙"(spec §6.3)。
 * 用服务端本地时区而非 UTC:团队与服务器同时区,本地 0 点才是"今天"的边界——
 * 用 UTC 日会让非 UTC 时区清晨/深夜的撞墙归错天。
 */
export function dayKeyLocal(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * 合并进状态:同 key 取 effective_ts 大者(相等时后到者胜),与读取顺序无关。
 * 注意:这只决定"当前状态";无论胜负,记录都已写进 JSONL/S3(事件不丢)。
 * 与读取顺序无关(order-independent),回放可任意并行。
 * 撞墙是历史事实:即使该快照随后被刷新覆盖也要留痕,按 (name,at,type) 去重——
 * Lambda 侧同一事件可能被重复处理(水位线回退/并发重建),去重保证只记一次。
 */
export function mergeInto(state: MergeState, rec: StoredRecord): void {
  const k = keyOf(rec);
  const prev = state.index.get(k);
  if (!prev || effectiveTs(rec) >= effectiveTs(prev)) state.index.set(k, rec);
  if (rec.quota_reached) {
    const wh: WallHit = {
      name: rec.name || rec.email || rec.machine || "unknown",
      at: effectiveTs(rec),
      type: String(rec.quota_reached),
    };
    const wk = `${wh.name} ${wh.at} ${wh.type}`;
    if (!state.wallHitKeys.has(wk)) {
      state.wallHitKeys.add(wk);
      state.wallHits.push(wh);
    }
  }
}

/** S3 key(spec §3):<prefix>events/dt=<received_at 的 UTC 日期>/<紧凑时间>_<event_id>_<tool>.json */
export function eventKey(rec: StoredRecord, prefix = ""): string {
  const dt = rec.received_at.slice(0, 10);
  const compact = rec.received_at.replace(/[-:]/g, "");
  const tool = (rec.tool ?? "unknown").replace(/[^A-Za-z0-9-]/g, "-");
  return `${prefix}events/dt=${dt}/${compact}_${rec.event_id}_${tool}.json`;
}
