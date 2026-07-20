import { dayKeyLocal, effectiveTs, type StoredRecord, type WallHit } from "./merge.ts";

/**
 * 从合并后的会话快照 + 撞墙历史算出看板报表。纯函数:同输入同输出,now 可注入(测试/重放用)。
 * 三个业务问题:(a) 当前额度=按 effective_ts 最新的快照;(b) 撞墙历史=扫全部撞墙事件,窗口刷新抹不掉;
 * (c) token 总数=按会话求和(输入已按 dedupe_key 合并,故不重复计数)。
 */
export function buildStats(sessions: StoredRecord[], wallHits: readonly WallHit[], now: number = Date.now()) {
  const byEmail = new Map<string, any>();
  const byModel = new Map<string, any>();
  const accModelStat = (model: string, u: any) => {
    const m =
      byModel.get(model) ?? {
        model,
        requests: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        reasoning_tokens: 0,
        total_tokens: 0,
      };
    m.requests += u.requests ?? 0;
    m.input_tokens += u.input_tokens ?? 0;
    m.output_tokens += u.output_tokens ?? 0;
    m.cache_read_tokens += u.cache_read_tokens ?? 0;
    m.cache_creation_tokens += u.cache_creation_tokens ?? 0;
    m.reasoning_tokens += u.reasoning_tokens ?? 0;
    m.total_tokens = m.input_tokens + m.output_tokens;
    byModel.set(model, m);
  };
  for (const s of sessions) {
    if (s.by_model && typeof s.by_model === "object") {
      for (const [model, u] of Object.entries(s.by_model)) accModelStat(model, u);
    } else if (s.model) {
      accModelStat(s.model, {
        requests: 1,
        input_tokens: s.input_tokens,
        output_tokens: s.output_tokens,
        cache_read_tokens: s.cache_read_tokens,
        cache_creation_tokens: s.cache_creation_tokens,
        reasoning_tokens: s.reasoning_tokens,
      });
    }
    const k = s.name || s.email || s.machine || "unknown";
    const agg = byEmail.get(k) ?? {
      name: s.name,
      email: s.email,
      department: s.department,
      sessions: 0,
      total_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      tools: new Set<string>(),
      models: new Set<string>(),
      last_used: "",
      quota_primary_pct: null as number | null,
      quota_secondary_pct: null as number | null,
      quota_plan: null as string | null,
      quota_reached: null as string | null,
      quota_at: 0,
      hit_wall_today: false,
      hit_wall_7d: false,
      last_wall_hit: "",
    };
    agg.sessions += 1;
    agg.total_tokens += s.total_tokens ?? 0;
    agg.cache_read_tokens += s.cache_read_tokens ?? 0;
    agg.cache_creation_tokens += s.cache_creation_tokens ?? 0;
    if (s.tool) agg.tools.add(s.tool);
    if (s.model) agg.models.add(s.model);
    const t = s.ended_at || s.received_at || "";
    if (t >= agg.last_used) {
      agg.last_used = t;
      agg.name = s.name;
      agg.email = s.email;
      agg.department = s.department;
    }
    if (s.quota_primary_pct != null || s.quota_secondary_pct != null) {
      const qt = effectiveTs(s);
      if (qt >= agg.quota_at) {
        agg.quota_at = qt;
        agg.quota_primary_pct = s.quota_primary_pct ?? null;
        agg.quota_secondary_pct = s.quota_secondary_pct ?? null;
        agg.quota_plan = s.quota_plan ?? null;
        agg.quota_reached = s.quota_reached ?? null;
      }
    }
    byEmail.set(k, agg);
  }
  const todayLocal = dayKeyLocal(now);
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
  for (const wh of wallHits) {
    const agg = byEmail.get(wh.name);
    if (!agg) continue;
    if (dayKeyLocal(wh.at) === todayLocal) agg.hit_wall_today = true;
    if (wh.at >= now - SEVEN_DAYS) agg.hit_wall_7d = true;
    if (!agg.last_wall_hit || wh.at > Date.parse(agg.last_wall_hit)) {
      agg.last_wall_hit = new Date(wh.at).toISOString();
    }
  }
  return {
    total_sessions: sessions.length,
    users: [...byEmail.values()].map(({ tools, models, quota_at, ...u }) => ({
      ...u,
      tools: [...tools],
      models: [...models],
    })),
    model_stats: [...byModel.values()].sort((a, b) => b.total_tokens - a.total_tokens),
  };
}
