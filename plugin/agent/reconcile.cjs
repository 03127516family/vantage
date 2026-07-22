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
// SessionStart 兜底扫描的节流间隔：重度用户一天开几十个会话，每次都全量扫目录纯属空转。
// 距上次成功的全量扫描不足 N 分钟就跳过本轮（只影响钩子路径；手动 sync、--only 定时任务、
// setup 后的首次对账都不带 SessionStart 事件，不受节流）。
const THROTTLE_MS = Number(process.env.VANTAGE_RECONCILE_INTERVAL_MIN || 30) * 60 * 1000;
// 死信/损坏文件保留天数
const RETENTION_DAYS = Number(process.env.VANTAGE_RETENTION_DAYS || 14);
// 插件自更新节流：SessionStart 时后台跑官方 CLI 检查更新（marketplace update + plugin update），
// 默认 2h 一次（每次检查只是后台一次 git fetch,成本可忽略;收紧是为让修复当天下达员工)。
// 版本串未 bump 则官方判定"已是最新"、空跑一次无妨;有新版则落盘、下次会话生效。
const SELF_UPDATE_INTERVAL_MS = Number(process.env.VANTAGE_SELF_UPDATE_INTERVAL_H || 2) * 3600 * 1000;
// marketplace 名 / 插件 ID（与 .claude-plugin/marketplace.json 一致）
const MARKETPLACE = process.env.VANTAGE_MARKETPLACE || "dgcrane";
const PLUGIN_ID = `vantage@${MARKETPLACE}`;

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

// 真实路径比较：HOME 或中间目录可能是符号链接（如 macOS 的 /var -> /private/var），
// Node 加载主模块默认 realpath，而 os.homedir() 照抄 $HOME——直接比字符串会漏判。
function realPath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

// 若本脚本从插件目录运行（Claude 钩子），把 agent 同步到稳定副本 ~/.vantage/agent，
// 供 Codex 定时任务引用——这样插件更新后 Codex 那份也是最新的。
function syncStableCopy() {
  const dst = path.join(os.homedir(), ".vantage", "agent");
  if (realPath(__dirname) === realPath(dst)) return; // 本就是稳定副本，无需同步
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

// 插件自更新：后台静默跑官方 CLI 刷新 marketplace 并更新 cache 里的插件，新版本下次会话生效
// （CLAUDE_PLUGIN_ROOT 在会话启动时已固定，本会话拿不到新版）。官方版本串对比：plugin.json 的
// version 未 bump 则"已是最新"跳过。先盖章再派生，并发会话不重复检查；失败咽下，绝不影响采集。
// 只在插件目录运行时做（Claude 钩子路径）；~/.vantage/agent 稳定副本（Codex 触发器）不管这事。
function selfUpdate() {
  if (process.env.VANTAGE_DISABLE_SELF_UPDATE) return; // 测试/运维逃生开关
  const stableCopy = path.join(os.homedir(), ".vantage", "agent");
  if (realPath(__dirname) === realPath(stableCopy)) return;
  try {
    const state = core.readState();
    const last = Number(state.__last_self_update__ || 0);
    if (Date.now() - last < SELF_UPDATE_INTERVAL_MS) return;
    state.__last_self_update__ = Date.now();
    core.writeState(state);
    const check =
      process.env.VANTAGE_SELF_UPDATE_CMD ||
      `claude plugin marketplace update ${MARKETPLACE} && claude plugin update ${PLUGIN_ID}`;
    core.spawnShellDetached(`${check} >>${JSON.stringify(core.LOG_PATH)} 2>&1`);
    core.log("self-update: check spawned");
  } catch {
    /* ignore */
  }
}

// 手写递归列目录：readdirSync 的 recursive 选项要 Node 18.17+，老 Node 会静默忽略、
// 只返回顶层 -> 子目录里的会话（Claude projects/<项目>/、Codex sessions/年/月/日/）
// 一条都扫不到还不报错。withFileTypes 自 Node 10 可用，不踩版本坑。
function listJsonl(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name.endsWith(".jsonl")) out.push(full);
    }
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
  let hookEvent = "";
  const raw = await core.readStdin(1200);
  if (raw && raw.trim()) {
    try {
      const hook = JSON.parse(raw);
      currentSessionId = hook.session_id || "";
      hookEvent = hook.hook_event_name || "";
    } catch {
      /* ignore */
    }
  }

  syncStableCopy(); // 从插件目录运行时，刷新 Codex 用的稳定副本（节流前做，插件更新及时生效）
  selfUpdate(); // 同在节流前：24h 一次后台查插件更新，新版本下次会话生效
  // Windows:Codex 触发器自检自愈——自更新只同步脚本文件,触发器(装没装/机制换没换)
  // 由这里顺带保证,员工永远不需要为触发器重跑 setup。非 win32 内部直接返回。
  try {
    require("./trigger.cjs").ensureWindowsCodexTrigger({ log: core.log });
  } catch (e) {
    core.log(`codex 触发器自检异常(已忽略):${e.message}`);
  }

  // 节流：SessionStart 是高频路径，30 分钟内已全量扫过就不再空转。
  // 仍触发一次 flush——若 spool 里有断网滞留的记录，网络恢复后开会话即补传，不等下轮扫描。
  if (hookEvent === "SessionStart") {
    const last = Number(core.readState().__last_reconcile__ || 0);
    if (Date.now() - last < THROTTLE_MS) {
      core.log(
        `reconcile: throttled (last full scan ${Math.round((Date.now() - last) / 60000)}min ago)`
      );
      core.spawnDetached("flush.cjs");
      return;
    }
  }

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
        if (!k.startsWith("__")) {
          // "__" 开头是元数据（__identity__/__last_reconcile__），不是会话文件标记
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
        observed_at: new Date().toISOString(), // 快照生成时间(服务端据此判断新旧;旧名 collected_at)
      };
      core.writeSpool(record);
      core.markProcessed(file, st.size, st.mtimeMs);
      swept += 1;
    }
  }

  core.log(
    `reconcile: found ${totalFiles} files, spooled ${swept} unsynced (skip=${currentSessionId || "none"})`
  );
  // 只有全量扫描才更新节流时间戳：--only 单源扫没覆盖另一数据源，不能挡住后续的全量扫。
  if (!only) {
    const state = core.readState();
    state.__last_reconcile__ = Date.now();
    core.writeState(state);
  }
  // 无论本轮是否有新增，都触发一次上传：既发新采的，也补之前失败的。
  core.spawnDetached("flush.cjs");
}

main()
  .catch((e) => core.log("reconcile fatal: " + String(e)))
  .finally(() => process.exit(0));
