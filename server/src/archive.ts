// S3 归档器(spec §8):异步队列 + 定时对账,绝不阻塞 /ingest。
//   enqueue  -> 内存队列 -> worker 单发尝试 -> 失败进死信文件
//   sweep    -> 从字节 offset 扫本地 JSONL 补传(幂等)+ 重试死信(成功剔除)
// 幂等性:S3 key 由事件已落盘的 received_at + event_id 决定,重传 N 次同 key 同内容。
// 未配置 S3 时返回 no-op handle,行为与未接 S3 完全一致。
import {
  appendFileSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { putObject, type S3Config } from "./s3.ts";
import type { StoredRecord } from "./store.ts";

export type Putter = (key: string, body: string) => Promise<{ status: number }>;

export interface ArchiveHandle {
  enqueue(rec: StoredRecord): void;
  drain(): Promise<void>; // 等队列清空(测试/关停用)
  sweep(): Promise<void>; // 手动触发一次对账(测试用)
  stop(): void;
}

interface ArchiveOpts {
  jsonlPath: string;
  cfg: S3Config;
  putter?: Putter; // 测试注入;默认真 S3
  sweepIntervalSec?: number; // 默认 600(10 分钟);环境变量 VANTAGE_S3_SWEEP_INTERVAL_SEC 可覆盖
  log?: (msg: string) => void;
}

/** S3 key(spec §3):events/dt=<received_at 的 UTC 日期>/<紧凑时间>_<event_id>_<tool>.json */
export function eventKey(rec: StoredRecord): string {
  const dt = rec.received_at.slice(0, 10); // 2026-07-17
  const compact = rec.received_at.replace(/[-:]/g, ""); // 20260717T093012.015Z
  const tool = (rec.tool ?? "unknown").replace(/[^A-Za-z0-9-]/g, "-");
  return `events/dt=${dt}/${compact}_${rec.event_id}_${tool}.json`;
}

export function initArchive(opts: ArchiveOpts): ArchiveHandle {
  const log = opts.log ?? ((m: string) => console.log(`[vantage][s3] ${m}`));
  const noop: ArchiveHandle = {
    enqueue() {},
    async drain() {},
    async sweep() {},
    stop() {},
  };
  if (!opts.cfg.enabled) {
    log("未配置 VANTAGE_S3_BUCKET / AWS 密钥,S3 归档停用(仅本地存储)");
    return noop;
  }

  const putter: Putter = opts.putter ?? ((key, body) => putObject(opts.cfg, key, body));
  const dataDir = dirname(opts.jsonlPath);
  const statePath = join(dataDir, "s3-archive.state.json");
  const deadPath = join(dataDir, "s3-archive-dead.jsonl");
  const sweepMs =
    (opts.sweepIntervalSec ?? Number(process.env.VANTAGE_S3_SWEEP_INTERVAL_SEC || 600)) * 1000;

  const queue: StoredRecord[] = [];
  let working = false;
  let idleResolvers: (() => void)[] = [];

  function appendDead(line: string): void {
    try {
      appendFileSync(deadPath, line + "\n");
    } catch (e) {
      log(`死信写入失败:${e}`);
    }
  }

  async function putLine(line: string): Promise<boolean> {
    let rec: StoredRecord;
    try {
      rec = JSON.parse(line);
    } catch {
      return true; // 损坏行不重试,跳过
    }
    if (!rec.event_id || !rec.received_at) return true; // 老行(无信封)不归档,跳过
    const res = await putter(eventKey(rec), line);
    if (res.status >= 200 && res.status < 300) return true;
    log(`PUT 失败 status=${res.status} key=${eventKey(rec)}`);
    return false;
  }

  async function worker(): Promise<void> {
    if (working) return;
    working = true;
    try {
      while (queue.length) {
        const rec = queue.shift()!;
        const ok = await putLine(JSON.stringify(rec));
        if (!ok) appendDead(JSON.stringify(rec));
      }
    } finally {
      working = false;
      const rs = idleResolvers;
      idleResolvers = [];
      rs.forEach((r) => r());
    }
  }

  function readOffset(): number {
    try {
      return Number(JSON.parse(readFileSync(statePath, "utf8")).offset) || 0;
    } catch {
      return 0;
    }
  }

  function writeOffset(offset: number): void {
    const tmp = `${statePath}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ offset }));
    renameSync(tmp, statePath);
  }

  /** 读 jsonlPath 中 [offset, EOF) 的完整行;文件变短(被替换)从头读。 */
  function readNewLines(offset: number): { lines: string[]; nextOffset: number } {
    const size = statSync(opts.jsonlPath).size;
    const start = offset > size ? 0 : offset;
    const fd = openSync(opts.jsonlPath, "r");
    try {
      const len = size - start;
      if (len <= 0) return { lines: [], nextOffset: start };
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, start);
      const text = buf.toString("utf8");
      const parts = text.split("\n");
      const tail = parts.pop() ?? ""; // 最后一段若非空行说明没写完(半行),留给下轮
      const consumed = len - Buffer.byteLength(tail, "utf8");
      return { lines: parts.filter((l) => l.trim()), nextOffset: start + consumed };
    } finally {
      closeSync(fd);
    }
  }

  async function sweep(): Promise<void> {
    // 1) 补传 JSONL 新增行(崩溃恢复 + 兜底;与 worker 重复无害,幂等)
    try {
      const { lines, nextOffset } = readNewLines(readOffset());
      for (const line of lines) {
        if (!(await putLine(line))) appendDead(line); // 失败不阻塞后续行
      }
      writeOffset(nextOffset);
    } catch (e) {
      log(`sweep 扫描失败:${e}`);
    }
    // 2) 重试死信;成功的按行内容从死信文件剔除(重读文件,避免与 worker 并发追加竞态)
    try {
      if (existsSync(deadPath)) {
        const deadLines = readFileSync(deadPath, "utf8").split("\n").filter((l) => l.trim());
        if (deadLines.length) {
          const succeeded = new Set<string>();
          for (const line of deadLines) {
            if (await putLine(line)) succeeded.add(line);
          }
          const remain = readFileSync(deadPath, "utf8")
            .split("\n")
            .filter((l) => l.trim() && !succeeded.has(l));
          writeFileSync(deadPath, remain.length ? remain.join("\n") + "\n" : "");
        }
      }
    } catch (e) {
      log(`死信重试失败:${e}`);
    }
  }

  const timer = setInterval(() => {
    sweep().catch((e) => log(`sweep 异常:${e}`));
  }, sweepMs);
  timer.unref(); // 不阻止进程退出

  log(`S3 归档已启用 bucket=${opts.cfg.bucket} region=${opts.cfg.region} 对账间隔=${sweepMs / 1000}s`);

  return {
    enqueue(rec: StoredRecord) {
      queue.push(rec);
      worker().catch((e) => log(`worker 异常:${e}`));
    },
    drain() {
      if (!working && queue.length === 0) return Promise.resolve();
      return new Promise((r) => idleResolvers.push(r));
    },
    sweep,
    stop() {
      clearInterval(timer);
    },
  };
}
