import { toPinyin } from "./pinyin.js";
export function createMergeState() {
    return { index: new Map(), wallHits: [], wallHitKeys: new Set() };
}
export function keyOf(r) {
    return r.dedupe_key || `${r.tool ?? "unknown"}:${r.session_id ?? "no-session"}`;
}
/**
 * 有效观测时间:判断"哪份快照更新"的依据(spec §6)。
 * 同一 session 的上报只来自一台机器,该比较是同钟比较,不受跨机器时钟误差影响。
 * 全部缺失时按 0 处理(永不覆盖已有正常记录)。
 */
export function effectiveTs(r) {
    const s = r.observed_at ?? r.collected_at ?? r.ended_at ?? r.received_at;
    const t = s ? Date.parse(s) : NaN;
    return Number.isNaN(t) ? 0 : t;
}
/**
 * 本地日历日(YYYY-MM-DD),用于"今天是否撞过墙"(spec §6.3)。
 * 用服务端本地时区而非 UTC:团队与服务器同时区,本地 0 点才是"今天"的边界——
 * 用 UTC 日会让非 UTC 时区清晨/深夜的撞墙归错天。
 */
export function dayKeyLocal(ts) {
    const d = new Date(ts);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}
/**
 * 规范化额度字段（过渡期双向兼容用）。
 * 支持三种输入：
 * 1. 新采集器发完整 wham/usage 响应：{ plan_type, rate_limit: { primary_window: { used_percent } }, observed_at }
 * 2. 新采集器发标准 quota 对象：{ plan_type, used_percent, limit_reached, observed_at }
 * 3. 老采集器发扁平字段：quota_primary_pct/secondary_pct/plan/reached
 *
 * 统一归一化为标准 QuotaSnapshot 后写入 rec.quota；保留老字段不删。
 * stats 以 quota 对象为准；输出时另反推老字段供看板。幂等。
 */
export function normalizeQuota(rec) {
    // 1. 新采集器发完整 wham 响应：从 rate_limit.primary_window 提取
    const rawQuota = rec.quota;
    if (rawQuota && rawQuota.rate_limit?.primary_window?.used_percent != null) {
        const pw = rawQuota.rate_limit.primary_window;
        rec.quota = {
            plan_type: rawQuota.plan_type ?? null,
            used_percent: Number(pw.used_percent),
            limit_reached: !!pw.limit_reached,
            reset_at: pw.reset_at ? new Date(pw.reset_at * 1000).toISOString() : null,
            observed_at: rawQuota.observed_at || rec.observed_at || rec.collected_at,
        };
        return;
    }
    // 2. 已有标准 quota 对象（含 used_percent）
    if (rec.quota && typeof rec.quota.used_percent === "number")
        return;
    // 3. 老采集器发 quota_primary_pct/secondary_pct/plan/reached
    const hasLegacy = rec.quota_primary_pct != null ||
        rec.quota_secondary_pct != null ||
        rec.quota_plan != null ||
        rec.quota_reached != null;
    if (!hasLegacy)
        return;
    const used = rec.quota_secondary_pct != null ? rec.quota_secondary_pct : rec.quota_primary_pct;
    rec.quota = {
        plan_type: rec.quota_plan ?? null,
        used_percent: used != null ? Number(used) : undefined,
        limit_reached: rec.quota_reached != null,
        reset_at: null,
        observed_at: rec.observed_at || rec.collected_at,
    };
}
/**
 * 合并进状态:同 key 取 effective_ts 大者(相等时后到者胜),与读取顺序无关。
 * 注意:这只决定"当前状态";无论胜负,记录都已写进 JSONL/S3(事件不丢)。
 * 与读取顺序无关(order-independent),回放可任意并行。
 * 撞墙是历史事实:即使该快照随后被刷新覆盖也要留痕,按 (name,at,type) 去重——
 * Lambda 侧同一事件可能被重复处理(水位线回退/并发重建),去重保证只记一次。
 */
export function mergeInto(state, rec) {
    const k = keyOf(rec);
    const prev = state.index.get(k);
    // 粘性 quota:本条没拿到额度(wham 失败/非 Codex)但该 session 上次有 → 沿用,避免空值覆盖。
    // 仅当本条确实胜出时才有意义(下面 set 后生效);observed_at 随 quota 一起沿用,诚实标测量时刻。
    if (!rec.quota && prev?.quota)
        rec.quota = prev.quota;
    if (!prev || effectiveTs(rec) >= effectiveTs(prev))
        state.index.set(k, rec);
    // 撞墙:额度耗尽(limit_reached)即留痕。at 用 quota.observed_at(测量时刻),
    // 同一次 wham 观测的多条记录 observed_at 相同 → 自然去重为一条;不同观测时刻才算另一次。
    if (rec.quota?.limit_reached) {
        const qAt = rec.quota.observed_at ? Date.parse(rec.quota.observed_at) : effectiveTs(rec);
        const wh = {
            name: rec.name || rec.email || rec.machine || "unknown",
            at: Number.isNaN(qAt) ? effectiveTs(rec) : qAt,
            type: "rate_limit_reached",
        };
        const wk = `${wh.name} ${wh.at} ${wh.type}`;
        if (!state.wallHitKeys.has(wk)) {
            state.wallHitKeys.add(wk);
            state.wallHits.push(wh);
        }
    }
}
/** S3 key(spec §3):<prefix>events/dt=<received_at 的 UTC 日期>/<紧凑时间>_<event_id>_<who>_<tool>.json */
export function eventKey(rec, prefix = "") {
    const dt = rec.received_at.slice(0, 10);
    const compact = rec.received_at.replace(/[-:]/g, "");
    const tool = (rec.tool ?? "unknown").replace(/[^A-Za-z0-9-]/g, "-");
    const who = toPinyin(rec.name || rec.email || rec.machine || "unknown");
    return `${prefix}events/dt=${dt}/${compact}_${rec.event_id}_${who}_${tool}.json`;
}
