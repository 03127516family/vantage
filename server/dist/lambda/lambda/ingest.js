// Lambda /ingest:复查脱敏 + 盖服务端信封 + 同步 PUT 事件到 S3(无队列,spec §5.2)。
// 失败返回 502 让采集端下轮重传——会话快照语义,重传天然幂等。
import { ulid } from "../src/ulid.js";
import { redactRecord } from "../src/redact.js";
import { eventKey, normalizeQuota } from "../src/merge.js";
const CONCURRENCY = 10;
export async function ingest(payload, deps) {
    const records = (Array.isArray(payload) ? payload : [payload]).filter((r) => Boolean(r) && typeof r === "object");
    const stamped = records.map((r) => {
        redactRecord(r); // 复查脱敏:采集端 redact 之外的兜底(spec §8)
        normalizeQuota(r); // 过渡兼容:老采集器的 quota_* 双窗字段 → quota 对象(单窗)
        return { ...r, event_id: ulid(), received_at: new Date().toISOString() };
    });
    let failed = 0;
    for (let i = 0; i < stamped.length; i += CONCURRENCY) {
        const results = await Promise.all(stamped.slice(i, i + CONCURRENCY).map((rec) => deps.putter(eventKey(rec, deps.prefix), JSON.stringify(rec))));
        for (const res of results)
            if (res.status < 200 || res.status >= 300)
                failed += 1;
    }
    if (failed > 0)
        return { code: 502, body: { ok: false, failed } };
    return { code: 200, body: { ok: true, accepted: stamped.length } };
}
