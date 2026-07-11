import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { upsert, allSessions, type UsageRecord } from "./store.ts";

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
  for (const s of sessions) {
    const k = s.email || s.machine || "unknown";
    const agg = byEmail.get(k) ?? {
      name: s.name,
      email: s.email,
      department: s.department,
      sessions: 0,
      total_tokens: 0,
      tools: new Set<string>(),
      last_used: "",
    };
    agg.sessions += 1;
    agg.total_tokens += s.total_tokens ?? 0;
    if (s.tool) agg.tools.add(s.tool);
    const t = s.ended_at || s.received_at;
    if (t > agg.last_used) agg.last_used = t;
    byEmail.set(k, agg);
  }
  return {
    total_sessions: sessions.length,
    users: [...byEmail.values()].map((u) => ({ ...u, tools: [...u.tools] })),
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
