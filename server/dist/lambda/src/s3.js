// S3 薄封装:基于官方 @aws-sdk/client-s3(唯一运行时依赖)。
// 只用三个操作:putObject(归档)、getObject(恢复/冒烟)、listKeys(恢复)。
// 网络/SDK 错误一律归一为 {status}(0 = 网络级失败),绝不向归档路径抛异常。
import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, } from "@aws-sdk/client-s3";
/** 归一化前缀:去首尾斜杠,非空补尾斜杠;空 -> ""。 */
function normalizePrefix(p) {
    const t = p.replace(/^\/+/, "").replace(/\/+$/, "");
    return t ? `${t}/` : "";
}
export function s3ConfigFromEnv(env = process.env) {
    const bucket = env.VANTAGE_S3_BUCKET ?? "";
    const region = env.VANTAGE_S3_REGION ?? "us-east-1";
    const accessKeyId = env.AWS_ACCESS_KEY_ID ?? "";
    const secretAccessKey = env.AWS_SECRET_ACCESS_KEY ?? "";
    return {
        enabled: Boolean(bucket && accessKeyId && secretAccessKey),
        bucket,
        region,
        endpoint: env.VANTAGE_S3_ENDPOINT ?? "",
        accessKeyId,
        secretAccessKey,
        sessionToken: env.AWS_SESSION_TOKEN ?? "",
        prefix: normalizePrefix(env.VANTAGE_S3_PREFIX ?? ""),
    };
}
// 进程内复用一个 client(SDK 内部带连接池);配置变化时重建(测试会换 endpoint)
let cached = null;
function clientFor(cfg) {
    const key = `${cfg.region}|${cfg.endpoint}|${cfg.accessKeyId}`;
    if (cached?.key === key)
        return cached.client;
    const client = new S3Client({
        region: cfg.region,
        credentials: {
            accessKeyId: cfg.accessKeyId,
            secretAccessKey: cfg.secretAccessKey,
            // Lambda 注入的是执行角色临时凭证(ASIA*),缺 sessionToken 签名必 403;静态密钥无 token,不传该字段
            ...(cfg.sessionToken ? { sessionToken: cfg.sessionToken } : {}),
        },
        // 自定义 endpoint(测试 fake-s3)走 path-style -> http://host:port/<bucket>/<key>;
        // 默认(真 AWS)由 SDK 解析虚拟托管式,aws-cn 设 region 即自动用 .amazonaws.com.cn。
        ...(cfg.endpoint ? { endpoint: cfg.endpoint, forcePathStyle: true } : {}),
    });
    cached = { key, client };
    return client;
}
function statusOf(e) {
    const s = e?.$metadata?.httpStatusCode;
    return typeof s === "number" ? s : 0;
}
export async function putObject(cfg, key, body) {
    try {
        const res = await clientFor(cfg).send(new PutObjectCommand({ Bucket: cfg.bucket, Key: key, Body: body, ContentType: "application/json" }));
        return { status: res.$metadata.httpStatusCode ?? 200 };
    }
    catch (e) {
        return { status: statusOf(e) };
    }
}
export async function getObject(cfg, key) {
    try {
        const res = await clientFor(cfg).send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
        const body = res.Body ? await res.Body.transformToString("utf-8") : "";
        return { status: res.$metadata.httpStatusCode ?? 200, body };
    }
    catch (e) {
        return { status: statusOf(e), body: "" };
    }
}
/** ListObjectsV2 全量翻页,返回 prefix 下全部 key;startAfter 传水位线时只返回其后的新 key。 */
export async function listKeys(cfg, prefix, startAfter) {
    const keys = [];
    let token;
    try {
        do {
            const res = await clientFor(cfg).send(new ListObjectsV2Command({
                Bucket: cfg.bucket,
                Prefix: prefix,
                ContinuationToken: token,
                ...(startAfter ? { StartAfter: startAfter } : {}),
            }));
            for (const o of res.Contents ?? [])
                if (o.Key)
                    keys.push(o.Key);
            token = res.IsTruncated ? res.NextContinuationToken : undefined;
        } while (token);
        return { status: 200, keys };
    }
    catch (e) {
        return { status: statusOf(e), keys };
    }
}
