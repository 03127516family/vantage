import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { ulid } from "./ulid.ts";
import {
  createMergeState,
  mergeInto,
  dayKeyLocal,
  effectiveTs,
  type StoredRecord,
  type UsageRecord,
  type WallHit,
} from "./merge.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
// 默认存到 server/data;可用 VANTAGE_DATA_DIR 覆盖(测试用独立目录,避免污染真实数据)
const dataDir = process.env.VANTAGE_DATA_DIR ?? join(__dirname, "..", "data");
mkdirSync(dataDir, { recursive: true });
const jsonlPath = join(dataDir, "usage.jsonl");

// 合并状态(每会话最新快照 + 撞墙历史)。合并规则全部在 merge.ts,这里只做持久化与回放。
const state = createMergeState();

// 启动时回放 JSONL 重建索引(与 upsert 同一套合并规则)
function replay() {
  if (!existsSync(jsonlPath)) return;
  const lines = readFileSync(jsonlPath, "utf8").split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      mergeInto(state, JSON.parse(line) as StoredRecord);
    } catch {
      // 跳过损坏行
    }
  }
}
replay();

/**
 * 追加写日志 + 盖服务端信封 + 按 effective_ts 合并进索引。
 * 信封(event_id/received_at)一律以服务端为准,客户端传入的同名字段被覆盖。
 */
export function upsert(rec: UsageRecord): StoredRecord {
  const stored: StoredRecord = {
    ...rec,
    event_id: ulid(),
    received_at: new Date().toISOString(),
  };
  appendFileSync(jsonlPath, JSON.stringify(stored) + "\n");
  mergeInto(state, stored);
  return stored;
}

/** 当前所有会话(每个 session 只保留 effective_ts 最大的快照) */
export function allSessions(): StoredRecord[] {
  return [...state.index.values()];
}

/** 全部撞墙历史(用于回答"今天/本周是否撞过墙",spec §6.3) */
export function allWallHits(): readonly WallHit[] {
  return state.wallHits;
}

export { dayKeyLocal, effectiveTs, jsonlPath };
export type { StoredRecord, UsageRecord, WallHit };
export type { ModelUsage } from "./merge.ts";
