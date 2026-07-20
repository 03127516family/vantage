// Lambda 入口(handler = index.handler):一个函数三条路由,spec §5.1。
// createHandler 依赖注入便于测试;默认 handler 用真 S3(env 配置)。
import { timingSafeEqual } from "node:crypto";
import { s3ConfigFromEnv, getObject, putObject, listKeys } from "../src/s3.ts";
import { ingest } from "./ingest.ts";
import { runRebuild, type RebuildDeps } from "./rebuild.ts";

type HeaderMap = Record<string, string | undefined>;

interface LambdaResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

function jsonResponse(code: number, body: unknown): LambdaResponse {
  return { statusCode: code, headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body) };
}

export function createHandler(deps: RebuildDeps, token: string) {
  function authorized(headers: HeaderMap): boolean {
    const auth = String(headers?.authorization ?? headers?.Authorization ?? "");
    const a = Buffer.from(auth.replace(/^Bearer\s+/i, ""));
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async function statsView(): Promise<LambdaResponse> {
    try {
      await runRebuild(deps); // 读时增量追平(无新事件≈一次 LIST)
    } catch (e) {
      // 重建失败:有旧 view 返回旧数据(rebuilt_at 暴露陈旧),否则 503
      const stale = await deps.get(`${deps.prefix}state/stats-view.json`);
      if (stale.status === 200) {
        return { statusCode: 200, headers: { "content-type": "application/json; charset=utf-8" }, body: stale.body };
      }
      return jsonResponse(503, { ok: false, error: String(e) });
    }
    const view = await deps.get(`${deps.prefix}state/stats-view.json`);
    if (view.status !== 200) return jsonResponse(503, { ok: false, error: "stats-view unavailable" });
    return { statusCode: 200, headers: { "content-type": "application/json; charset=utf-8" }, body: view.body };
  }

  return async function handler(event: any): Promise<LambdaResponse> {
    try {
      // 定时器(EventBridge)/ 手动 invoke 预热入口
      if (event?.source === "aws.events" || event?.action === "rebuild") {
        const r = await runRebuild(deps);
        return jsonResponse(200, { ok: true, ...r });
      }
      const method: string = event?.requestContext?.http?.method ?? "";
      const path: string = event?.rawPath ?? "";
      if (method === "GET" && path === "/health") return jsonResponse(200, { ok: true });

      if (method === "POST" && path === "/ingest") {
        if (!authorized(event?.headers ?? {})) return jsonResponse(401, { ok: false, error: "unauthorized" });
        const raw = event?.isBase64Encoded
          ? Buffer.from(event?.body ?? "", "base64").toString("utf8")
          : (event?.body ?? "");
        let payload: unknown;
        try {
          payload = JSON.parse(raw);
        } catch {
          return jsonResponse(400, { ok: false, error: "invalid json" });
        }
        const r = await ingest(payload, { putter: deps.put, prefix: deps.prefix });
        return jsonResponse(r.code, r.body);
      }

      if (method === "GET" && path === "/stats") {
        if (!authorized(event?.headers ?? {})) return jsonResponse(401, { ok: false, error: "unauthorized" });
        return statsView();
      }

      return jsonResponse(404, { ok: false, error: "not found" });
    } catch (err) {
      return jsonResponse(500, { ok: false, error: String(err) });
    }
  };
}

// 默认入口:env 配置真 S3。INGEST_TOKEN 与 ingest/stats 共用(同 Node 壳现状)。
const cfg = s3ConfigFromEnv();
export const handler = createHandler(
  {
    get: (key) => getObject(cfg, key),
    put: (key, body) => putObject(cfg, key, body),
    list: (prefix, startAfter) => listKeys(cfg, prefix, startAfter),
    prefix: cfg.prefix,
  },
  process.env.INGEST_TOKEN ?? "dev-token-change-me"
);
