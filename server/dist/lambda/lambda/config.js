// GET /config: 返回某员工的采集级别(thin|full)。
// collect-levels.json 是只读小配置,5 分钟 warm 缓存。
// 缺文件/解析失败 → 安全默认 thin(采集器拿到 thin 不会带 history,不会突然膨胀)。
const CACHE_TTL_MS = 5 * 60 * 1000;
let cache = { body: null, at: 0 };

async function getCfg(deps) {
  if (cache.body && Date.now() - cache.at < CACHE_TTL_MS) return cache.body;
  const r = await deps.get(`${deps.prefix}collect-levels.json`);
  if (r.status !== 200) return null;
  try {
    const parsed = JSON.parse(r.body);
    cache = { body: parsed, at: Date.now() };
    return parsed;
  } catch {
    return null;
  }
}

export function _resetConfigCache() { cache = { body: null, at: 0 }; }

export async function getCollectLevel(name, deps) {
  if (!name) return { code: 400, body: { ok: false, error: "name required" } };
  if (name.length > 64) return { code: 400, body: { ok: false, error: "name too long" } };
  const cfg = await getCfg(deps);
  const defaultLevel = cfg?.default ?? "thin";
  const level = cfg?.overrides?.[name] ?? defaultLevel;
  return { code: 200, body: { name, collect_level: level } };
}
