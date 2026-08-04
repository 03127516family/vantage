// GET /roster/check 与 /roster/nearby: 姓名校验 + 笔误候选。
// roster.json 是只读小文件,Lambda warm 实例内 5 分钟缓存,大幅减轻 S3 压力。
import { editDistance } from "../src/edit-distance.js";

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache = { body: null, at: 0 };

async function getRoster(deps) {
  if (cache.body && Date.now() - cache.at < CACHE_TTL_MS) return cache.body;
  const r = await deps.get(`${deps.prefix}roster.json`);
  if (r.status !== 200) return null;
  try {
    const parsed = JSON.parse(r.body);
    cache = { body: parsed, at: Date.now() };
    return parsed;
  } catch {
    return null;
  }
}

// 测试用: 清缓存
export function _resetRosterCache() { cache = { body: null, at: 0 }; }

export async function rosterCheck(name, deps) {
  if (!name) return { code: 400, body: { ok: false, error: "name required" } };
  if (name.length > 64) return { code: 400, body: { ok: false, error: "name too long" } };
  const roster = await getRoster(deps);
  if (!roster) return { code: 503, body: { ok: false, error: "roster unavailable" } };
  const hit = (roster.people ?? []).find((p) => p.name === name);
  if (hit) return { code: 200, body: { exists: true, name: hit.name, department: hit.department } };
  return { code: 200, body: { exists: false } };
}

export async function rosterNearby(name, deps) {
  if (!name) return { code: 400, body: { ok: false, error: "name required" } };
  if (name.length > 64) return { code: 400, body: { ok: false, error: "name too long" } };
  const roster = await getRoster(deps);
  if (!roster) return { code: 503, body: { ok: false, error: "roster unavailable" } };
  const people = roster.people ?? [];
  // 候选: 疑似笔误(编辑距离≤1)优先,其次同姓,最多 5 个
  const near = people.filter((p) => editDistance(p.name, name) <= 1).map((p) => p.name);
  const sameSurname = people
    .filter((p) => p.name[0] === name[0] && !near.includes(p.name))
    .map((p) => p.name);
  const candidates = [...near, ...sameSurname].slice(0, 5);
  return { code: 200, body: { candidates } };
}
