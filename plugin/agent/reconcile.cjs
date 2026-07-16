#!/usr/bin/env node
"use strict";
// Vantage —— 会话扫描/对账（reconcile）。
// Claude：由 SessionStart 钩子调用（开新会话时兜底补采）；
// Codex：由 OS 触发器在登录时/每天正午调用（--only codex），增量扫 ~/.codex/sessions 采集（cc-switch 同款思路，免钩子/免信任）。
// 职责：扫历史会话，把"没采到/断网没传成功"的补上（跳过当前刚开的会话），
// 顺手清理死信/损坏文件、剪枝 state、触发上传。永远 exit 0、不打印 stdout。
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const core = require("./core.cjs");
const { parseClaudeTranscript } = require("./parsers/claude-code.cjs");
const { parseCodexRollout } = require("./parsers/codex.cjs");

// 只回看最近 N 天的会话，避免首次安装时把全部历史一次性灌上去
const RECENT_DAYS = Number(process.env.VANTAGE_RECENT_DAYS || 7);
// 死信/损坏文件保留天数
const RETENTION_DAYS = Number(process.env.VANTAGE_RETENTION_DAYS || 14);

// 要扫描的数据源：目录 + 解析器 + 工具名
const SOURCES = [
  {
    tool: "claude-code",
    dir: path.join(os.homedir(), ".claude", "projects"),
    parse: parseClaudeTranscript,
  },
  {
    tool: "codex",
    dir: path.join(os.homedir(), ".codex", "sessions"),
    parse: parseCodexRollout,
  },
];

// 若本脚本从插件目录运行（Claude 钩子），把 agent 同步到稳定副本 ~/.vantage/agent，
// 供 Codex 定时任务引用——这样插件更新后 Codex 那份也是最新的。
function syncStableCopy() {
  const dst = path.join(os.homedir(), ".vantage", "agent");
  if (path.resolve(__dirname) === path.resolve(dst)) return; // 本就是稳定副本，无需同步
  try {
    // 仅当稳定副本缺失或比插件版旧时才复制，避免每次 SessionStart 无谓 I/O。
    const srcMtime = fs.statSync(path.join(__dirname, "core.cjs")).mtimeMs;
    let dstMtime = -1;
    try {
      dstMtime = fs.statSync(path.join(dst, "core.cjs")).mtimeMs;
    } catch {
      /* 缺失 */
    }
    if (dstMtime >= srcMtime) return;
    fs.mkdirSync(dst, { recursive: true });
    fs.cpSync(__dirname, dst, { recursive: true });
  } catch {
    /* ignore */
  }
}

function listJsonl(dir) {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { recursive: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const name = typeof e === "string" ? e : String(e);
    if (name.endsWith(".jsonl")) out.push(path.join(dir, name));
  }
  return out;
}

// 清理死信目录 + spool 里的 .bad，超过保留期就删
function cleanupOld() {
  const cutoff = Date.now() - RETENTION_DAYS * 86400 * 1000;
  const dirs = [
    { dir: core.DEAD_DIR, match: () => true },
    { dir: core.SPOOL_DIR, match: (f) => f.endsWith(".bad") },
  ];
  for (const { dir, match } of dirs) {
    let files = [];
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!match(f)) continue;
      const full = path.join(dir, f);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
      } catch {
        /* ignore */
      }
    }
  }
}

// 解析 --only <tool>：限定只扫某个数据源（Codex 定时任务用 --only codex）
function parseOnly(argv) {
  const i = argv.indexOf("--only");
  return i >= 0 ? argv[i + 1] : null;
}

async function main() {
  core.ensureDirs();
  const cfg = core.loadConfig();

  const only = parseOnly(process.argv);
  const sources = only ? SOURCES.filter((s) => s.tool === only) : SOURCES;

  // 当前刚开的会话：从 SessionStart 的 stdin 拿 session_id，扫描时跳过它
  let currentSessionId = "";
  const raw = await core.readStdin(1200);
  if (raw && raw.trim()) {
    try {
      currentSessionId = JSON.parse(raw).session_id || "";
    } catch {
      /* ignore */
    }
  }

  syncStableCopy(); // 从插件目录运行时，刷新 Codex 用的稳定副本

  // 身份变更检测：setup 改了 name/email/department 后（含"从未配置 -> 首次配置"），
  // 把"已采过"的会话标记清空并记入 restamp 集合，强制本轮用新身份重传——服务端按
  // session_id upsert 覆盖，旧记录自动拿到正确身份。修"先用了再 setup，身份卡死成机器名"。
  // 只在全量扫描时做：--only 单源扫描（如 launchd RunAtLoad 的 --only codex）若消耗了
  // 这个标记，另一数据源里卡空身份的会话就永远等不到重传。
  const restamp = new Set();
  if (!only) {
    const idKey = JSON.stringify([cfg.name || "", cfg.email || "", cfg.department || ""]);
    const state = core.readState();
    const prev = state.__identity__ ?? "";
    if (prev !== idKey) {
      for (const k of Object.keys(state)) {
        if (k !== "__identity__") {
          delete state[k];
          restamp.add(k);
        }
      }
      state.__identity__ = idKey;
      core.writeState(state);
      core.log(`identity changed -> re-stamp ${restamp.size} prior session(s) with new identity`);
    }
  }

  // 扫描下限：取"最近 N 天"和"安装时刻"中更晚的——安装后只采装后的会话，不倒灌历史。
  // 例外：restamp 集合里的文件（确实被采过、身份错了的）放宽到"最近 N 天"，
  // 即使 mtime 早于 installed_at 也重传纠偏；从没采过的装前个人历史仍被闸口挡住。
  const recentCutoff = Date.now() - RECENT_DAYS * 86400 * 1000;
  const installCutoff = cfg.installed_at ? Date.parse(cfg.installed_at) : 0;
  const cutoff = Math.max(recentCutoff, Number.isNaN(installCutoff) ? 0 : installCutoff);
  cleanupOld();
  // 剪 state 只按回看窗口，不掺 installed_at：装前会话的"已采"标记是纠偏的证据，
  // 若被 --only 单源扫描按安装闸口剪掉，后续身份变更就无从知道它该重传。
  core.pruneState(recentCutoff);

  let totalFiles = 0;
  let swept = 0;
  for (const src of sources) {
    const files = listJsonl(src.dir);
    totalFiles += files.length;
    for (const file of files) {
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      const fileCutoff = restamp.has(file) ? recentCutoff : cutoff;
      if (st.mtimeMs < fileCutoff) continue; // 太老，跳过
      if (currentSessionId && file.includes(currentSessionId)) continue; // 跳过当前会话
      if (!core.hasChanged(file, st.size, st.mtimeMs)) continue; // 没变，已同步过

      const parsed = src.parse(file);
      if (!parsed || !parsed.session_id) continue;
      if (currentSessionId && parsed.session_id === currentSessionId) continue;

      const record = {
        ...parsed,
        name: cfg.name,
        email: cfg.email,
        department: cfg.department,
        machine: cfg.machine,
        exit_reason: "reconciled", // 标记：兜底对账补采
        dedupe_key: `${parsed.tool}:${parsed.session_id}`,
        collected_at: new Date().toISOString(),
      };
      core.writeSpool(record);
      core.markProcessed(file, st.size, st.mtimeMs);
      swept += 1;
    }
  }

  core.log(
    `reconcile: found ${totalFiles} files, spooled ${swept} unsynced (skip=${currentSessionId || "none"})`
  );
  // 无论本轮是否有新增，都触发一次上传：既发新采的，也补之前失败的。
  core.spawnDetached("flush.cjs");
}

main()
  .catch((e) => core.log("reconcile fatal: " + String(e)))
  .finally(() => process.exit(0));
