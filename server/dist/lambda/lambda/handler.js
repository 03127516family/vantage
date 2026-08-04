// Lambda 入口(处理程序 = lambda/handler.handler):一个函数三条路由,spec §5.1。
// createHandler 依赖注入便于测试;默认 handler 用真 S3(env 配置)。
import { timingSafeEqual } from "node:crypto";
import { s3ConfigFromEnv, getObject, putObject, listKeys } from "../src/s3.js";
import { ingest } from "./ingest.js";
import { install } from "./install.js";
import { rosterCheck, rosterNearby } from "./roster.js";
import { getCollectLevel } from "./config.js";
import { installsView } from "./installs-view.js";
import { runRebuild } from "./rebuild.js";
function jsonResponse(code, body) {
    return { statusCode: code, headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body) };
}
export function createHandler(deps, token) {
    function authorized(headers) {
        const auth = String(headers?.authorization ?? headers?.Authorization ?? "");
        const a = Buffer.from(auth.replace(/^Bearer\s+/i, ""));
        const b = Buffer.from(token);
        return a.length === b.length && timingSafeEqual(a, b);
    }
    async function statsView() {
        try {
            await runRebuild(deps); // 读时增量追平(无新事件≈一次 LIST)
        }
        catch (e) {
            // 重建失败:有旧 view 返回旧数据(rebuilt_at 暴露陈旧),否则 503
            const stale = await deps.get(`${deps.prefix}state/stats-view.json`);
            if (stale.status === 200) {
                return { statusCode: 200, headers: { "content-type": "application/json; charset=utf-8" }, body: stale.body };
            }
            return jsonResponse(503, { ok: false, error: String(e) });
        }
        const view = await deps.get(`${deps.prefix}state/stats-view.json`);
        if (view.status !== 200)
            return jsonResponse(503, { ok: false, error: "stats-view unavailable" });
        return { statusCode: 200, headers: { "content-type": "application/json; charset=utf-8" }, body: view.body };
    }
    return async function handler(event) {
        try {
            // 定时器(EventBridge)/ 手动 invoke 预热入口
            if (event?.source === "aws.events" || event?.action === "rebuild") {
                const r = await runRebuild(deps);
                return jsonResponse(200, { ok: true, ...r });
            }
            // 事件形状双兼容:Function URL / HTTP API(payload 2.0)用 requestContext.http + rawPath;
            // REST API / HTTP API(payload 1.0)用 httpMethod + path。headers/body/isBase64Encoded 两者一致。
            const method = event?.requestContext?.http?.method ?? event?.httpMethod ?? "";
            let path = event?.rawPath ?? event?.path ?? "";
            // 命名阶段(非 $default)的 HTTP API:rawPath 带 "/<stage>" 前缀,剥离后再匹配路由
            const stage = event?.requestContext?.stage ?? "";
            if (stage && stage !== "$default" && path.startsWith(`/${stage}/`)) {
                path = path.slice(stage.length + 1);
            }
            // query 解析: API Gateway 走 queryStringParameters;Function URL 走 rawQueryString;
            // 测试/rawPath 内嵌 "?k=v" 也兼容(剥掉 query 后再匹配路由)。
            let qs = event?.queryStringParameters ?? {};
            if (path.includes("?")) {
                const idx = path.indexOf("?");
                const inline = Object.fromEntries(new URLSearchParams(path.slice(idx + 1)));
                qs = { ...inline, ...qs };
                path = path.slice(0, idx);
            } else if (event?.rawQueryString) {
                qs = { ...Object.fromEntries(new URLSearchParams(event.rawQueryString)), ...qs };
            }
            if (method === "GET" && path === "/health")
                return jsonResponse(200, { ok: true });
            if (method === "POST" && path === "/install") {
                if (!authorized(event?.headers ?? {}))
                    return jsonResponse(401, { ok: false, error: "unauthorized" });
                const raw = event?.isBase64Encoded
                    ? Buffer.from(event?.body ?? "", "base64").toString("utf8")
                    : (event?.body ?? "");
                let body;
                try {
                    body = JSON.parse(raw);
                }
                catch {
                    return jsonResponse(400, { ok: false, error: "invalid json" });
                }
                const r = await install(body, deps);
                return jsonResponse(r.code, r.body);
            }
            if (method === "POST" && path === "/ingest") {
                if (!authorized(event?.headers ?? {}))
                    return jsonResponse(401, { ok: false, error: "unauthorized" });
                const raw = event?.isBase64Encoded
                    ? Buffer.from(event?.body ?? "", "base64").toString("utf8")
                    : (event?.body ?? "");
                let payload;
                try {
                    payload = JSON.parse(raw);
                }
                catch {
                    return jsonResponse(400, { ok: false, error: "invalid json" });
                }
                const r = await ingest(payload, { putter: deps.put, prefix: deps.prefix });
                return jsonResponse(r.code, r.body);
            }
            if (method === "GET" && path === "/stats") {
                if (!authorized(event?.headers ?? {}))
                    return jsonResponse(401, { ok: false, error: "unauthorized" });
                return statsView();
            }
            if (method === "GET" && path === "/roster/check") {
                if (!authorized(event?.headers ?? {}))
                    return jsonResponse(401, { ok: false, error: "unauthorized" });
                const r = await rosterCheck(qs.name ?? "", deps);
                return jsonResponse(r.code, r.body);
            }
            if (method === "GET" && path === "/roster/nearby") {
                if (!authorized(event?.headers ?? {}))
                    return jsonResponse(401, { ok: false, error: "unauthorized" });
                const r = await rosterNearby(qs.name ?? "", deps);
                return jsonResponse(r.code, r.body);
            }
            if (method === "GET" && path === "/config") {
                if (!authorized(event?.headers ?? {}))
                    return jsonResponse(401, { ok: false, error: "unauthorized" });
                const r = await getCollectLevel(qs.name ?? "", deps);
                return jsonResponse(r.code, r.body);
            }
            if (method === "GET" && path === "/installs/view") {
                if (!authorized(event?.headers ?? {}))
                    return jsonResponse(401, { ok: false, error: "unauthorized" });
                const r = await installsView(deps);
                return jsonResponse(r.code, r.body);
            }
            return jsonResponse(404, { ok: false, error: "not found" });
        }
        catch (err) {
            return jsonResponse(500, { ok: false, error: String(err) });
        }
    };
}
// 默认入口:env 配置真 S3。INGEST_TOKEN 与 ingest/stats 共用(同 Node 壳现状)。
const cfg = s3ConfigFromEnv();
export const handler = createHandler({
    get: (key) => getObject(cfg, key),
    put: (key, body) => putObject(cfg, key, body),
    list: (prefix, startAfter) => listKeys(cfg, prefix, startAfter),
    prefix: cfg.prefix,
}, process.env.INGEST_TOKEN ?? "dev-token-change-me");
