// S3 薄封装:基于官方 @aws-sdk/client-s3(唯一运行时依赖)。
// 只用三个操作:putObject(归档)、getObject(恢复/冒烟)、listKeys(恢复)。
// 网络/SDK 错误一律归一为 {status}(0 = 网络级失败),绝不向归档路径抛异常。
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";

export interface S3Config {
  enabled: boolean;
  bucket: string;
  region: string;
  endpoint: string; // 空串 = SDK 按 region 自动解析(推荐;aws-cn 只改 region 即可)
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string; // 临时凭证的会话令牌;Lambda 运行时自动注入 AWS_SESSION_TOKEN,不传则临时凭证签名必 403
  prefix: string; // 桶内前缀(如 "vantage-prod/"),空串 = 桶根;事件写到 <prefix>events/ 下
}

/** 归一化前缀:去首尾斜杠,非空补尾斜杠;空 -> ""。 */
function normalizePrefix(p: string): string {
  const t = p.replace(/^\/+/, "").replace(/\/+$/, "");
  return t ? `${t}/` : "";
}

export function s3ConfigFromEnv(env: NodeJS.ProcessEnv = process.env): S3Config {
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
let cached: { key: string; client: S3Client } | null = null;
function clientFor(cfg: S3Config): S3Client {
  const key = `${cfg.region}|${cfg.endpoint}|${cfg.accessKeyId}`;
  if (cached?.key === key) return cached.client;
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

function statusOf(e: unknown): number {
  const s = (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  return typeof s === "number" ? s : 0;
}

export async function putObject(cfg: S3Config, key: string, body: string): Promise<{ status: number }> {
  try {
    const res = await clientFor(cfg).send(
      new PutObjectCommand({ Bucket: cfg.bucket, Key: key, Body: body, ContentType: "application/json" })
    );
    return { status: res.$metadata.httpStatusCode ?? 200 };
  } catch (e) {
    return { status: statusOf(e) };
  }
}

export async function getObject(cfg: S3Config, key: string): Promise<{ status: number; body: string }> {
  try {
    const res = await clientFor(cfg).send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
    const body = res.Body ? await res.Body.transformToString("utf-8") : "";
    return { status: res.$metadata.httpStatusCode ?? 200, body };
  } catch (e) {
    return { status: statusOf(e), body: "" };
  }
}

/** ListObjectsV2 全量翻页,返回 prefix 下全部 key;startAfter 传水位线时只返回其后的新 key。 */
export async function listKeys(
  cfg: S3Config,
  prefix: string,
  startAfter?: string
): Promise<{ status: number; keys: string[] }> {
  const keys: string[] = [];
  let token: string | undefined;
  try {
    do {
      const res = await clientFor(cfg).send(
        new ListObjectsV2Command({
          Bucket: cfg.bucket,
          Prefix: prefix,
          ContinuationToken: token,
          ...(startAfter ? { StartAfter: startAfter } : {}),
        })
      );
      for (const o of res.Contents ?? []) if (o.Key) keys.push(o.Key);
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return { status: 200, keys };
  } catch (e) {
    return { status: statusOf(e), keys };
  }
}
