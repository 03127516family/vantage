import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { upsert, allSessions, allWallHits, jsonlPath, type UsageRecord } from "./store.ts";
import { buildStats } from "./stats.ts";
import { redactRecord } from "./redact.ts";
import { initArchive } from "./archive.ts";
import { s3ConfigFromEnv } from "./s3.ts";

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

// S3 归档:异步、不阻塞 /ingest;未配置环境变量时为 no-op(spec §8)
const archive = initArchive({ jsonlPath, cfg: s3ConfigFromEnv() });

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
      return json(res, 200, buildStats(allSessions(), allWallHits()));
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
          const stored = upsert(r);
          archive.enqueue(stored); // 异步归档 S3,失败由对账器兜底
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
