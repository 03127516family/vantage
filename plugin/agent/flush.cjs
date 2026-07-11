#!/usr/bin/env node
"use strict";
// Vantage —— 上传器（flush）。扫 spool，逐条 POST：成功删，临时失败留着重试，永久失败/超龄进死信。
// 由 capture / reconcile 分离式触发。用原子锁避免多实例并发。永远 exit 0。
const fs = require("node:fs");
const path = require("node:path");
const core = require("./core.cjs");

const LOCK_PATH = path.join(core.BASE_DIR, "flush.lock");
// 锁保活阈值：远大于单次运行时间（每条 POST 8s 超时，且连不上时是秒级失败）。
const LOCK_STALE_MS = 10 * 60 * 1000;
// spool 文件超过这个时长仍未传成功 → 进死信，不再拖累每次上传。
const MAX_AGE_MS = Number(process.env.VANTAGE_SPOOL_MAX_AGE_DAYS || 7) * 86400 * 1000;

let lockHeld = false;

/** 原子获取锁：O_EXCL 独占创建；已存在则判活性，陈旧则接管。 */
function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(LOCK_PATH, "wx"); // wx = O_CREAT|O_EXCL，已存在即抛 EEXIST
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      lockHeld = true;
      return true;
    } catch (e) {
      if (e.code !== "EEXIST") return false;
      let stale = false;
      try {
        stale = Date.now() - fs.statSync(LOCK_PATH).mtimeMs > LOCK_STALE_MS;
      } catch {
        stale = true; // 锁文件读不到，当作可接管
      }
      if (!stale) return false; // 有活跃实例
      try {
        fs.unlinkSync(LOCK_PATH); // 接管陈旧锁后重试一次
      } catch {
        return false;
      }
    }
  }
  return false;
}

function releaseLock() {
  if (!lockHeld) return;
  try {
    fs.unlinkSync(LOCK_PATH);
  } catch {}
  lockHeld = false;
}

function toDead(full, name) {
  try {
    fs.renameSync(full, path.join(core.DEAD_DIR, name));
  } catch {}
}

// 2xx 成功；401/408/429 视为临时（配置/限流，留着重试）；其余 4xx 永久失败；0/5xx 临时。
function classify(status) {
  if (status >= 200 && status < 300) return "ok";
  if (status === 401 || status === 408 || status === 429) return "retry";
  if (status >= 400 && status < 500) return "dead";
  return "retry";
}

async function main() {
  core.ensureDirs();
  const cfg = core.loadConfig();

  if (!acquireLock()) {
    core.log("flush: another instance running, skip.");
    return;
  }

  try {
    let files = [];
    try {
      files = fs.readdirSync(core.SPOOL_DIR).filter((f) => f.endsWith(".json"));
    } catch {
      files = [];
    }
    if (files.length === 0) return;

    let ok = 0;
    let retry = 0;
    let dead = 0;
    for (const f of files) {
      const full = path.join(core.SPOOL_DIR, f);
      let record;
      let stat;
      try {
        stat = fs.statSync(full);
        record = JSON.parse(fs.readFileSync(full, "utf8"));
      } catch {
        toDead(full, f + ".bad"); // 损坏：进死信
        continue;
      }

      const verdict = classify(await core.postJson(cfg, record));
      if (verdict === "ok") {
        try {
          fs.unlinkSync(full);
        } catch {}
        ok += 1;
      } else if (verdict === "dead") {
        toDead(full, f);
        dead += 1;
      } else if (Date.now() - stat.mtimeMs > MAX_AGE_MS) {
        toDead(full, f); // 临时失败但超龄 → 进死信兜底
        dead += 1;
      } else {
        retry += 1; // 临时失败：留着下次补
      }
    }
    core.log(`flush: ok=${ok} retry=${retry} dead=${dead} (server=${cfg.server_url})`);
  } finally {
    releaseLock();
  }
}

main()
  .catch((e) => core.log("flush fatal: " + String(e)))
  .finally(() => process.exit(0));
