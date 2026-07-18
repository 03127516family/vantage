import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { upsert, allSessions, type UsageRecord } from "./store.ts";
import { redactRecord } from "./redact.ts";

const PORT = Number(process.env.PORT ?? 3000);
const DEFAULT_TOKEN = "dev-token-change-me";
// 上传鉴权 token。原型给个默认值；正式部署务必用环境变量覆盖。
const INGEST_TOKEN = process.env.INGEST_TOKEN ?? DEFAULT_TOKEN;

/** 常量时间比较，避免用普通 !== 比较 token 时的时序侧信道 */
function tokenValid(candidate: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(INGEST_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function json(res: ServerResponse, code: number, body: unknown) {
  const s = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(s);
}

function readBody(req: IncomingMessage, limit = 5 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// 简单聚合，供快速自查（正式看板以后再做）
function buildStats() {
  const sessions = allSessions();
  const byEmail = new Map<string, any>();
  // 全局「按模型统计」（cc-switch 模型统计视图）：从每条会话的 by_model 汇总。
  const byModel = new Map<string, any>();
  const accModelStat = (model: string, u: any) => {
    const m =
      byModel.get(model) ??
      {
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
    // 按模型累计：优先用 by_model 明细；老记录没有则退回 model+总量（一条会话算 1 次请求）。
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
    // 聚合键：姓名（setup 已按公司通讯录校验）优先；老记录退回邮箱，再退主机名
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
      // 当前用量（额度）：取“最新一次带额度信息的会话”的快照
      quota_primary_pct: null as number | null,
      quota_secondary_pct: null as number | null,
      quota_plan: null as string | null,
      quota_reached: null as string | null,
      quota_at: "",
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
      // 身份同额度一样取"最新会话的快照"：员工重新 setup 纠正部门后，
      // 看板立刻显示新部门，不被 7 天前未重传的老会话里的旧身份卡住。
      agg.name = s.name;
      agg.email = s.email;
      agg.department = s.department;
    }
    // 额度是“当前快照”不可累加：谁的会话最新就用谁的
    if (s.quota_primary_pct != null || s.quota_secondary_pct != null) {
      const qt = s.ended_at || s.received_at || "";
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
  return {
    total_sessions: sessions.length,
    users: [...byEmail.values()].map(({ tools, models, quota_at, ...u }) => ({
      ...u,
      tools: [...tools],
      models: [...models],
    })),
    // 全局按模型统计（请求数/各类 token），供“模型统计”视图与后续算成本用
    model_stats: [...byModel.values()].sort((a, b) => b.total_tokens - a.total_tokens),
  };
}

/** 从请求头取 Bearer token 并做常量时间校验 */
function authorized(req: IncomingMessage): boolean {
  const auth = req.headers["authorization"] || "";
  return tokenValid(String(auth).replace(/^Bearer\s+/i, ""));
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      return json(res, 200, { ok: true });
    }

    if (req.method === "GET" && req.url === "/stats") {
      // 含姓名/邮箱/部门/摘要等 PII，必须鉴权
      if (!authorized(req)) return json(res, 401, { ok: false, error: "unauthorized" });
      return json(res, 200, buildStats());
    }

    if (req.method === "POST" && req.url === "/ingest") {
      if (!authorized(req)) {
        return json(res, 401, { ok: false, error: "unauthorized" });
      }
      const raw = await readBody(req);
      let payload: UsageRecord | UsageRecord[];
      try {
        payload = JSON.parse(raw);
      } catch {
        return json(res, 400, { ok: false, error: "invalid json" });
      }
      // 支持单条或批量
      const records = Array.isArray(payload) ? payload : [payload];
      let n = 0;
      for (const r of records) {
        if (r && typeof r === "object") {
          redactRecord(r); // 复查脱敏:采集端 redact 之外的兜底(spec §8)
          upsert(r);
          n += 1;
        }
      }
      return json(res, 200, { ok: true, accepted: n });
    }

    return json(res, 404, { ok: false, error: "not found" });
  } catch (err) {
    return json(res, 500, { ok: false, error: String(err) });
  }
});

server.listen(PORT, () => {
  console.log(`[vantage] 后端已启动 http://localhost:${PORT}`);
  console.log(`  POST /ingest   （需 Authorization: Bearer <token>）`);
  console.log(`  GET  /health`);
  console.log(`  GET  /stats`);
  if (INGEST_TOKEN === DEFAULT_TOKEN) {
    console.warn("  ⚠ 正在使用默认 INGEST_TOKEN，生产环境请用环境变量覆盖为专属密钥。");
  }
});
