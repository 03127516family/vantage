// Lambda 重建(算账):水位线增量把新事件并入合并索引,重算 stats-view,spec §5.3。
// 触发方式无关:定时器/手动 invoke//stats 读时都调这一个函数。
// 写入顺序 index → wallhits → stats-view:watermark 随 view 最后生效,崩溃只导致重复处理(幂等),不丢事件。
import { createMergeState, mergeInto, type StoredRecord, type WallHit } from "../src/merge.ts";
import { buildStats } from "../src/stats.ts";

export interface RebuildDeps {
  get: (key: string) => Promise<{ status: number; body: string }>;
  put: (key: string, body: string) => Promise<{ status: number }>;
  list: (prefix: string, startAfter?: string) => Promise<{ status: number; keys: string[] }>;
  prefix: string; // 桶内前缀(已归一化,带尾斜杠;空串=桶根)
  now?: number; // 注入用(测试),默认 Date.now()
}

export interface RebuildResult {
  rebuilt: boolean; // 本次是否写回了 state
  newEvents: number;
  skipped: number; // 损坏行数
  watermark: string;
}

const GET_CONCURRENCY = 50;

function ok2xx(status: number): boolean {
  return status >= 200 && status < 300;
}

export async function runRebuild(deps: RebuildDeps): Promise<RebuildResult> {
  const p = deps.prefix;
  const now = deps.now ?? Date.now();
  // 1. 读 state 三文件(404 视为空)
  const [viewRes, indexRes, wallRes] = await Promise.all([
    deps.get(`${p}state/stats-view.json`),
    deps.get(`${p}state/index.jsonl`),
    deps.get(`${p}state/wallhits.json`),
  ]);
  const watermark = viewRes.status === 200 ? ((JSON.parse(viewRes.body).watermark as string) ?? "") : "";
  const state = createMergeState();
  if (indexRes.status === 200) {
    for (const line of indexRes.body.split("\n")) {
      if (!line.trim()) continue;
      try {
        mergeInto(state, JSON.parse(line) as StoredRecord);
      } catch {
        // 跳过损坏行
      }
    }
  }
  if (wallRes.status === 200) {
    try {
      for (const wh of JSON.parse(wallRes.body) as WallHit[]) {
        const wk = `${wh.name} ${wh.at} ${wh.type}`;
        if (!state.wallHitKeys.has(wk)) {
          state.wallHitKeys.add(wk);
          state.wallHits.push(wh);
        }
      }
    } catch {
      // wallhits 损坏视同空(撞墙会随事件重放重新留痕)
    }
  }
  // 2. LIST 水位线之后的新事件 key
  const listRes = await deps.list(`${p}events/`, watermark || undefined);
  if (listRes.status !== 200) throw new Error(`LIST events 失败 status=${listRes.status}`);
  const newKeys = listRes.keys;
  // 3. GET 新事件;任一失败 → 中止(不写文件,水位线不动,下轮重试不丢)
  const bodies: string[] = [];
  for (let i = 0; i < newKeys.length; i += GET_CONCURRENCY) {
    const batch = await Promise.all(newKeys.slice(i, i + GET_CONCURRENCY).map((k) => deps.get(k)));
    for (const r of batch) {
      if (r.status !== 200) throw new Error(`GET event 失败 status=${r.status}`);
      bodies.push(r.body);
    }
  }
  let skipped = 0;
  for (const body of bodies) {
    try {
      mergeInto(state, JSON.parse(body) as StoredRecord);
    } catch {
      skipped += 1;
    }
  }
  const newWatermark = newKeys.length ? newKeys[newKeys.length - 1] : watermark;
  // 4. 有新事件或 stats-view 缺失 → 重算并按序写回
  if (newKeys.length > 0 || viewRes.status !== 200) {
    const view = {
      ...buildStats([...state.index.values()], state.wallHits, now),
      watermark: newWatermark,
      rebuilt_at: new Date(now).toISOString(),
    };
    const indexLines = [...state.index.values()].map((r) => JSON.stringify(r));
    const indexBody = indexLines.length ? indexLines.join("\n") + "\n" : "";
    const p1 = await deps.put(`${p}state/index.jsonl`, indexBody);
    if (!ok2xx(p1.status)) throw new Error(`PUT index.jsonl 失败 status=${p1.status}`);
    const p2 = await deps.put(`${p}state/wallhits.json`, JSON.stringify(state.wallHits));
    if (!ok2xx(p2.status)) throw new Error(`PUT wallhits.json 失败 status=${p2.status}`);
    const p3 = await deps.put(`${p}state/stats-view.json`, JSON.stringify(view));
    if (!ok2xx(p3.status)) throw new Error(`PUT stats-view.json 失败 status=${p3.status}`);
    return { rebuilt: true, newEvents: newKeys.length, skipped, watermark: newWatermark };
  }
  return { rebuilt: false, newEvents: 0, skipped, watermark };
}
