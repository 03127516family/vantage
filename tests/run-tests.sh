#!/usr/bin/env bash
# Vantage —— 端到端自测套件（自包含）。
# 自启隔离后端 + 沙箱 HOME + 合成会话样本；采集脚本从插件目录运行（镜像插件钩子）。
# 跑完自动清理，不污染真实环境。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
FIX="$SCRIPT_DIR/fixtures"
AGENT="$REPO/plugin/agent"          # 采集脚本（钩子运行的就是这份）

WORK="$(mktemp -d)"
SB="$WORK/home"                     # 沙箱 HOME
SPOOL="$SB/.vantage/spool"
DEAD="$SB/.vantage/dead"
LOG="$SB/.vantage/agent.log"
CONFIG="$SB/.vantage/config.json"
DATA_DIR="$WORK/serverdata"
DATA="$DATA_DIR/usage.jsonl"
PORT=3999
LIVE="http://localhost:$PORT"
DEAD_URL="http://localhost:59999"
TOKEN="test-token"
Q="node $SCRIPT_DIR/qserver.cjs $DATA"
# 测试里 SessionStart 会被密集触发，关掉 reconcile 节流（T24 单独验证节流行为）
export VANTAGE_RECONCILE_INTERVAL_MIN=0
# 测试绝不能真去跑 claude CLI 更新插件（T33 单独用替身命令验证自更新行为）
export VANTAGE_DISABLE_SELF_UPDATE=1

S1="11111111-1111-1111-1111-111111111111"
S2="22222222-2222-2222-2222-222222222222"
S3="33333333-3333-3333-3333-333333333333"   # codex

# npm start 会派生 tsx 子进程，kill 父进程杀不到子进程 -> 端口会残留占用，拖垮后续运行。
# 因此按端口兜底清理。
kill_port() { lsof -ti tcp:"$PORT" 2>/dev/null | xargs kill -9 2>/dev/null; }
# 按端口逐个杀(多个端口不能写成 lsof -ti tcp:a b c,会被当文件名参数;逐个才稳)。
# T30 起的额外服务器/fake-s3 用:npm start 派生 tsx 子进程,kill 父进程杀不掉,必须按端口清。
killp(){ for pp in "$@"; do lsof -ti tcp:"$pp" 2>/dev/null | xargs kill -9 2>/dev/null; done; }
cleanup() { [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null; kill_port; killp 3971 3972 4971 4972; rm -rf "$WORK"; }
trap cleanup EXIT

# --- 沙箱会话文件 ---
mkdir -p "$SB/.claude/projects/proj" "$SB/.codex/sessions/2026/07/10"
cp "$FIX/claude/$S1.jsonl" "$FIX/claude/$S2.jsonl" "$SB/.claude/projects/proj/"
cp "$FIX/codex/"rollout-*.jsonl "$SB/.codex/sessions/2026/07/10/"

# --- 启动隔离后端（先清端口，防上一轮残留的 tsx 子进程占着 3999 影子应答）---
kill_port; sleep 0.3
( cd "$REPO/server" && VANTAGE_DATA_DIR="$DATA_DIR" INGEST_TOKEN="$TOKEN" PORT="$PORT" npm start >"$WORK/server.log" 2>&1 ) &
SERVER_PID=$!
for _ in $(seq 1 30); do curl -sf "$LIVE/health" >/dev/null 2>&1 && break; sleep 0.3; done

# --- 断言工具 ---
PASS=0; FAIL=0
ok(){ echo "  PASS: $1"; PASS=$((PASS+1)); }
no(){ echo "  FAIL: $1 (期望:$2 实际:$3)"; FAIL=$((FAIL+1)); }
assert(){ [ "$2" = "$3" ] && ok "$1" || no "$1" "$2" "$3"; }
spool_n(){ ls "$SPOOL"/*.json 2>/dev/null | wc -l | tr -d ' '; }
dead_n(){ ls "$DEAD" 2>/dev/null | wc -l | tr -d ' '; }
name_of(){ $Q get "$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).name)}catch{process.stdout.write("MISSING")}})'; }
setcfg(){ node -e 'const fs=require("fs");const p=process.argv[2];const c=JSON.parse(fs.readFileSync(p));c.server_url=process.argv[1];fs.writeFileSync(p,JSON.stringify(c))' "$1" "$CONFIG"; }
set_installed(){ node -e 'const fs=require("fs");const p=process.argv[2];const c=JSON.parse(fs.readFileSync(p));c.installed_at=process.argv[1];fs.writeFileSync(p,JSON.stringify(c))' "$1" "$CONFIG"; }
endhook(){ echo "{\"session_id\":\"$1\",\"transcript_path\":\"$SB/.claude/projects/proj/$1.jsonl\",\"hook_event_name\":\"SessionEnd\",\"exit_reason\":\"$2\"}" | HOME="$SB" node "$AGENT/capture.cjs"; }
starthook(){ echo "{\"session_id\":\"$1\",\"hook_event_name\":\"SessionStart\"}" | HOME="$SB" node "$AGENT/reconcile.cjs"; }
run_flush(){ HOME="$SB" node "$AGENT/flush.cjs"; }
# 本地当天 HH[:MM] 的 UTC ISO 表示(与服务端"本地日"判定一致,任何时区跑都稳)
iso_local(){ node -e "const d=new Date();d.setHours($1,${2:-0},0,0);process.stdout.write(d.toISOString())"; }

echo "== setup（写配置 + 同步 agent，跳过触发器）=="
HOME="$SB" VANTAGE_SKIP_TRIGGER=1 node "$REPO/plugin/setup.cjs" "赵六" "研发一部" "$LIVE" "$TOKEN" >/dev/null
assert "setup 写入身份=赵六" "赵六" "$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1])).name)' "$CONFIG")"
assert "setup 同步了稳定副本 agent" "1" "$([ -f "$SB/.vantage/agent/capture.cjs" ] && echo 1 || echo 0)"
# 样本用固定的 2026-07-10 日期，把安装时刻设到更早，让 T1-T12 正常采集
set_installed "2026-01-01T00:00:00.000Z"

echo "== T1: SessionEnd 采当前会话 =="
endhook "$S1" "logout"; sleep 0.6
assert "T1 服务端收到 S1"        "赵六"   "$(name_of "$S1")"
assert "T1 spool 已清空"         "0"      "$(spool_n)"
assert "T1 exit_reason=logout"   "logout" "$($Q field "$S1" exit_reason)"
assert "T1 摘要取到 AI 标题"     "Fix login page error" "$($Q field "$S1" summary)"
assert "T1 记录了模型"           "claude-opus-4-8" "$($Q field "$S1" model)"

echo "== T2: 同会话重复触发 -> 去重 =="
endhook "$S1" "clear"; sleep 0.6
assert "T2 会话数仍为 1"         "1"     "$($Q count)"
assert "T2 exit_reason 被覆盖"   "clear" "$($Q field "$S1" exit_reason)"

echo "== T3: 断网 -> 留在 spool =="
setcfg "$DEAD_URL"; endhook "$S2" "logout"; sleep 0.6
assert "T3 spool 保留 1 条"      "1"       "$(spool_n)"
assert "T3 服务端还没有 S2"      "MISSING" "$($Q get "$S2")"

echo "== T4: 恢复网络 -> 补传成功 =="
setcfg "$LIVE"; run_flush; sleep 0.3
assert "T4 spool 清空"           "0"    "$(spool_n)"
assert "T4 服务端补到 S2"        "赵六" "$(name_of "$S2")"

echo "== T5: SessionStart 跳过当前 =="
starthook "$S1"; sleep 0.6
grep -q "skip=$S1" "$LOG" && ok "T5 日志确认跳过当前会话" || no "T5 跳过日志" "skip=$S1" "无"

echo "== T6: Codex 会话被扫到并上报 =="
starthook "none"; sleep 0.6
assert "T6 服务端收到 codex 会话" "赵六"  "$(name_of "$S3")"
assert "T6 codex 工具标记正确"    "codex" "$($Q field "$S3" tool)"
assert "T6 codex 模型正确"        "gpt-5.5" "$($Q field "$S3" model)"

echo "== T7: 会话变大 -> 重新采（用量更新） =="
BEFORE="$($Q field "$S1" total_tokens)"
cat "$FIX/claude/$S2.jsonl" >> "$SB/.claude/projects/proj/$S1.jsonl"
starthook "none"; sleep 0.6
AFTER="$($Q field "$S1" total_tokens)"
if [ "${AFTER:-}" != "${BEFORE:-}" ]; then ok "T7 用量已更新($BEFORE -> $AFTER)"; else no "T7 用量应变化" "not $BEFORE" "$AFTER"; fi

echo "== T8: 未变的会话不重复上报 =="
starthook "none"; sleep 0.4
grep "reconcile:" "$LOG" | tail -1 | grep -q "spooled 0" \
  && ok "T8 本轮 spooled 0" || no "T8 应 spooled 0" "spooled 0" "$(grep 'reconcile:' "$LOG" | tail -1)"

echo "== T9: 损坏 spool -> 进死信 =="
echo "{ not json" > "$SPOOL/broken.json"; run_flush; sleep 0.3
assert "T9 损坏文件已清走"        "0" "$(spool_n)"
[ "$(dead_n)" -ge 1 ] && ok "T9 进了死信目录" || no "T9 死信" ">=1" "$(dead_n)"

echo "== T10: 并发锁 -> 第二实例跳过 =="
echo $$ > "$SB/.vantage/flush.lock"; run_flush; sleep 0.2
grep -q "another instance" "$LOG" && ok "T10 检测到锁并跳过" || no "T10 并发锁" "another instance" "无"
rm -f "$SB/.vantage/flush.lock"

echo "== T11: 缺配置/坏输入不崩溃 =="
SB2="$WORK/home2"; mkdir -p "$SB2/.vantage"; echo '{"bad":1}' > "$WORK/garbage.jsonl"
HOME="$SB2" node "$AGENT/capture.cjs" --file "$WORK/garbage.jsonl" --tool claude-code; RC=$?
assert "T11 坏输入+无配置 仍 exit 0" "0" "$RC"

echo "== T12: Codex 独立触发器（--only codex）可执行 =="
HOME="$SB" node "$AGENT/reconcile.cjs" --only codex >/dev/null 2>&1; sleep 0.3
grep 'reconcile:' "$LOG" | tail -1 | grep -q "found" && ok "T12 --only codex 正常执行" \
  || no "T12 --only" "found" "$(grep 'reconcile:' "$LOG" | tail -1)"

echo "== T13: 只采安装之后——装前会话被跳过 =="
set_installed "2027-01-01T00:00:00.000Z"   # 安装时刻设到样本之后
rm -f "$SPOOL"/*.json 2>/dev/null
endhook "$S1" "logout"; sleep 0.4          # S1 起始于 2026-07-10，早于安装 → 应跳过
if grep -q "skip pre-install" "$LOG" && [ "$(spool_n)" = "0" ]; then
  ok "T13 装前会话被跳过、未采集"
else
  no "T13 应跳过装前会话" "skip + spool0" "spool=$(spool_n)"
fi
set_installed "2026-01-01T00:00:00.000Z"   # 恢复

echo "== T14: Codex 定时扫描采集会话（capture --file --tool codex）=="
ROLL="$(ls "$SB/.codex/sessions/2026/07/10/"rollout-*.jsonl | head -1)"
rm -f "$SPOOL"/*.json 2>/dev/null
HOME="$SB" node "$AGENT/capture.cjs" --file "$ROLL" --tool codex; sleep 0.6
assert "T14 采到 codex 会话" "gpt-5.5" "$($Q field "$S3" model)"

echo "== T15: setup 不再写 Codex 钩子（改用定时扫描，免手动 /hooks 信任）=="
SB3="$WORK/home3"; mkdir -p "$SB3/.codex"
HOME="$SB3" VANTAGE_SKIP_TRIGGER=1 node "$REPO/plugin/setup.cjs" "钱七" "研发部" "$LIVE" "$TOKEN" >/dev/null
[ ! -f "$SB3/.codex/hooks.json" ] && ok "T15 未写入 ~/.codex/hooks.json" || no "T15 不应再写 hooks.json" "无该文件" "文件存在"
[ -f "$SB3/.vantage/agent/reconcile.cjs" ] && ok "T15 已同步稳定副本供定时任务引用" || no "T15 稳定副本" "reconcile.cjs 存在" "缺失"

echo "== T16: cc-switch 同款 token 明细 + 当前用量(额度) =="
# Codex S3：缓存读/推理 token + 额度快照（primary=5h, secondary=周）
assert "T16 codex 缓存读 token"   "1200" "$($Q field "$S3" cache_read_tokens)"
assert "T16 codex 推理 token"     "50"   "$($Q field "$S3" reasoning_tokens)"
assert "T16 当前用量·5h额度%"      "16"   "$($Q field "$S3" quota_primary_pct)"
assert "T16 当前用量·周额度%"      "84"   "$($Q field "$S3" quota_secondary_pct)"
assert "T16 套餐类型"             "plus" "$($Q field "$S3" quota_plan)"
# Claude S2：缓存读/写 token；Claude 无额度信息 -> 留空
assert "T16 claude 缓存读 token"  "1500" "$($Q field "$S2" cache_read_tokens)"
assert "T16 claude 缓存写 token"  "300"  "$($Q field "$S2" cache_creation_tokens)"
# 缓存写分档（算成本用：5m 档 1.25 倍、1h 档 2 倍计价，拆开才能算准）
assert "T16 claude 缓存写 5m 档"  "100"  "$($Q field "$S2" cache_creation_5m_tokens)"
assert "T16 claude 缓存写 1h 档"  "200"  "$($Q field "$S2" cache_creation_1h_tokens)"
assert "T16 claude 无额度信息"    "null" "$($Q field "$S2" quota_primary_pct)"

echo "== T17: 分模型明细 by_model（一个会话多模型不丢模型维度）=="
# S2 两轮分别用 opus / fable-5：token 各归各的模型，不再全算到末模型
assert "T17 opus 请求数"      "1"    "$($Q field "$S2" by_model.claude-opus-4-8.requests)"
assert "T17 opus 输入 token"  "2000" "$($Q field "$S2" by_model.claude-opus-4-8.input_tokens)"
assert "T17 opus 缓存读"      "1500" "$($Q field "$S2" by_model.claude-opus-4-8.cache_read_tokens)"
assert "T17 fable 输出 token" "250"  "$($Q field "$S2" by_model.claude-fable-5.output_tokens)"
# Codex S3 也有 by_model（模型名 gpt-5.5 带点，点路径会拆错，改读整个对象校验）
codex_bm(){ $Q field "$S3" by_model | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=(JSON.parse(s)||{})["gpt-5.5"]||{};process.stdout.write(String(m[process.argv[1]]))}) ' "$1"; }
assert "T17 codex gpt-5.5 请求数"  "1"    "$(codex_bm requests)"
assert "T17 codex gpt-5.5 缓存读"  "1200" "$(codex_bm cache_read_tokens)"
assert "T17 codex gpt-5.5 推理"    "50"   "$(codex_bm reasoning_tokens)"

echo "== T18: /stats 全局按模型统计 model_stats（还原 cc-switch 模型统计视图）=="
STATS="$(curl -s -H "Authorization: Bearer $TOKEN" "$LIVE/stats")"
mstat(){ echo "$STATS" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);const m=(o.model_stats||[]).find(x=>x.model===process.argv[1]);process.stdout.write(m?String(m[process.argv[2]]):"MISSING")})' "$1" "$2"; }
[ "$(mstat claude-fable-5 output_tokens)" != "MISSING" ] && ok "T18 model_stats 含 fable-5" || no "T18 model_stats fable-5" "存在" "MISSING"
[ "$(mstat claude-opus-4-8 requests)" != "MISSING" ] && ok "T18 model_stats 含 opus" || no "T18 model_stats opus" "存在" "MISSING"

echo ""
echo "== T19: 先用后 setup -> 旧会话自动重打身份（不再卡机器名）=="
# 复现线上 bug：未 setup 就用 -> 会话以空身份采集、被 /stats 当成机器名；
# 之后才 setup，旧会话身份卡死传不出去。修复后 reconcile 检测到身份变更 -> 用新身份重传覆盖。
SB4="$WORK/home4"; SPOOL4="$SB4/.vantage/spool"
mkdir -p "$SB4/.claude/projects/proj" "$SB4/.vantage"
cp "$FIX/claude/$S1.jsonl" "$SB4/.claude/projects/proj/"
spool_name4(){ node -e 'const fs=require("fs");try{process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1])).name||"")}catch{process.stdout.write("NOSPOOL")}' "$SPOOL4/claude-code_$1.json"; }
# 1) 未配置身份（只有死地址，防 flush 把样本传走）-> SessionEnd 采到空身份
echo '{"server_url":"http://localhost:59999","token":"x"}' > "$SB4/.vantage/config.json"
echo "{\"session_id\":\"$S1\",\"transcript_path\":\"$SB4/.claude/projects/proj/$S1.jsonl\",\"hook_event_name\":\"SessionEnd\",\"exit_reason\":\"logout\"}" | HOME="$SB4" node "$AGENT/capture.cjs"; sleep 0.4
assert "T19 setup 前采到空身份" "" "$(spool_name4 "$S1")"
# 2) 之后才 setup：写真实身份，installed_at=现在（会话 mtime 早于安装，复现"装前会话"）
node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1],JSON.stringify({name:"孙八",department:"研发部",server_url:"http://localhost:59999",token:"x",installed_at:new Date().toISOString()}))' "$SB4/.vantage/config.json"
# 3) reconcile 检测身份变更 -> 重扫最近会话 -> 用新身份重写 spool
echo "{\"hook_event_name\":\"SessionStart\"}" | HOME="$SB4" node "$AGENT/reconcile.cjs"; sleep 0.6
assert "T19 setup 后旧会话重打身份=孙八" "孙八" "$(spool_name4 "$S1")"

echo ""
echo "== T20: 身份变更不倒灌装前个人历史（从没采过的不重传）=="
# 纠偏只针对"已采过、身份错了"的会话；装插件前就存在、从未采集过的个人历史，
# 即使身份变更（含首次 setup）也必须继续被 installed_at 闸口挡住。
SB5="$WORK/home5"; SPOOL5="$SB5/.vantage/spool"
mkdir -p "$SB5/.claude/projects/proj" "$SB5/.vantage"
cp "$FIX/claude/$S2.jsonl" "$SB5/.claude/projects/proj/"
sleep 0.2
# 直接首次 setup（installed_at=现在 > 会话 mtime），期间从未采集过 S2
node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1],JSON.stringify({name:"孙八",department:"研发部",server_url:"http://localhost:59999",token:"x",installed_at:new Date().toISOString()}))' "$SB5/.vantage/config.json"
echo "{\"hook_event_name\":\"SessionStart\"}" | HOME="$SB5" node "$AGENT/reconcile.cjs"; sleep 0.6
[ ! -f "$SPOOL5/claude-code_$S2.json" ] && ok "T20 装前历史未被采集" || no "T20 不应采集装前历史" "无 spool" "被采了"

echo ""
echo "== T21: --only codex 不消耗身份标记（launchd RunAtLoad 先跑也不丢纠偏）=="
# setup 里 installTrigger 在 spawn 全量对账之前，launchd RunAtLoad 会立刻跑 --only codex。
# 若这次单源扫描消耗了身份变更标记，另一数据源里卡空身份的会话就永远等不到重传。
SB6="$WORK/home6"; SPOOL6="$SB6/.vantage/spool"
mkdir -p "$SB6/.claude/projects/proj" "$SB6/.vantage"
cp "$FIX/claude/$S1.jsonl" "$SB6/.claude/projects/proj/"
spool_name6(){ node -e 'const fs=require("fs");try{process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1])).name||"")}catch{process.stdout.write("NOSPOOL")}' "$SPOOL6/claude-code_$S1.json"; }
# 1) 空身份下采到 S1（死地址防传走）
echo '{"server_url":"http://localhost:59999","token":"x"}' > "$SB6/.vantage/config.json"
echo "{\"session_id\":\"$S1\",\"transcript_path\":\"$SB6/.claude/projects/proj/$S1.jsonl\",\"hook_event_name\":\"SessionEnd\",\"exit_reason\":\"logout\"}" | HOME="$SB6" node "$AGENT/capture.cjs"; sleep 0.4
# 2) 之后 setup 写真实身份
node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1],JSON.stringify({name:"孙八",department:"研发部",server_url:"http://localhost:59999",token:"x",installed_at:new Date().toISOString()}))' "$SB6/.vantage/config.json"
# 3) 模拟 launchd RunAtLoad：--only codex 先跑
HOME="$SB6" node "$AGENT/reconcile.cjs" --only codex >/dev/null 2>&1; sleep 0.4
# 4) 随后 setup 后台触发的全量对账才跑
echo "{\"hook_event_name\":\"SessionStart\"}" | HOME="$SB6" node "$AGENT/reconcile.cjs"; sleep 0.6
assert "T21 --only 先跑后旧会话仍重打身份=孙八" "孙八" "$(spool_name6)"

echo ""
echo "== T22: 触发器为每天登录时+正午兜底,不再每小时（贴合周会消费节奏）=="
# DRYRUN 写出定义文件但不注册进系统调度器；仅断言当前平台的产物。
SB7="$WORK/home7"; mkdir -p "$SB7/.vantage"
HOME="$SB7" VANTAGE_TRIGGER_DRYRUN=1 node "$REPO/plugin/setup.cjs" "周九" "研发部" "http://localhost:59999" "x" >/dev/null 2>&1
if [ "$(uname)" = "Darwin" ]; then
  PLIST="$SB7/Library/LaunchAgents/com.dgcrane.vantage.codex.plist"
  grep -q "StartCalendarInterval" "$PLIST" 2>/dev/null && ok "T22 plist 含正午日程" || no "T22 正午日程" "StartCalendarInterval" "无"
  grep -q "RunAtLoad" "$PLIST" 2>/dev/null && ok "T22 plist 含登录触发" || no "T22 登录触发" "RunAtLoad" "无"
  ! grep -q "StartInterval" "$PLIST" 2>/dev/null && ok "T22 已移除每小时间隔" || no "T22 每小时应移除" "无 StartInterval" "仍存在"
elif [ "$(uname)" = "Linux" ]; then
  TIMER="$SB7/.config/systemd/user/vantage-codex.timer"
  grep -q "OnCalendar=" "$TIMER" 2>/dev/null && ok "T22 timer 含正午日程" || no "T22 正午日程" "OnCalendar" "无"
  ! grep -q "OnUnitActiveSec" "$TIMER" 2>/dev/null && ok "T22 已移除每小时间隔" || no "T22 每小时应移除" "无 OnUnitActiveSec" "仍存在"
fi

echo ""
echo "== T24: SessionStart 兜底扫描节流（30 分钟内不重复全量扫）=="
SB9="$WORK/home9"; LOG9="$SB9/.vantage/agent.log"
mkdir -p "$SB9/.vantage"
echo '{"server_url":"http://localhost:59999","token":"x"}' > "$SB9/.vantage/config.json"
# 第一次 SessionStart：正常全量扫，记录时间戳
echo '{"hook_event_name":"SessionStart"}' | HOME="$SB9" VANTAGE_RECONCILE_INTERVAL_MIN=30 node "$AGENT/reconcile.cjs"; sleep 0.3
grep -q "reconcile: found" "$LOG9" && ok "T24 首次 SessionStart 正常扫描" || no "T24 首次扫描" "found" "无"
# 第二次 SessionStart（30 分钟内）：应被节流
echo '{"hook_event_name":"SessionStart"}' | HOME="$SB9" VANTAGE_RECONCILE_INTERVAL_MIN=30 node "$AGENT/reconcile.cjs"; sleep 0.3
grep -q "reconcile: throttled" "$LOG9" && ok "T24 第二次被节流" || no "T24 节流" "throttled" "无"
# 手动/定时路径（无 SessionStart 事件）不受节流：--only codex 照常执行
HOME="$SB9" VANTAGE_RECONCILE_INTERVAL_MIN=30 node "$AGENT/reconcile.cjs" --only codex >/dev/null 2>&1; sleep 0.3
grep 'reconcile:' "$LOG9" | tail -1 | grep -q "found" && ok "T24 --only 定时路径不受节流" \
  || no "T24 --only 不节流" "found" "$(grep 'reconcile:' "$LOG9" | tail -1)"

echo ""
echo "== T23: 花名册——姓名自动填部门,不再登记邮箱 =="
SB8="$WORK/home8"; mkdir -p "$SB8"
CFG8="$SB8/.vantage/config.json"
dept8(){ node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1])).department||"")' "$CFG8"; }
# 在册姓名：只给名字，部门按 roster.json 自动填
HOME="$SB8" VANTAGE_SKIP_TRIGGER=1 node "$REPO/plugin/setup.cjs" "李栋" >/dev/null
assert "T23 在册姓名自动填部门" "外贸部" "$(dept8)"
# 在册但乱填部门：以通讯录为准
HOME="$SB8" VANTAGE_SKIP_TRIGGER=1 node "$REPO/plugin/setup.cjs" "王聪" "研发部" >/dev/null
assert "T23 在册者手填部门被通讯录纠正" "财务部" "$(dept8)"
assert "T23 config 不再含邮箱字段" "0" "$(node -e 'process.stdout.write("email" in JSON.parse(require("fs").readFileSync(process.argv[1]))?"1":"0")' "$CFG8")"
# 不在册且没给部门：退出码 2（技能据此引导用户核对姓名/手选部门）
HOME="$SB8" VANTAGE_SKIP_TRIGGER=1 node "$REPO/plugin/setup.cjs" "查无此人" >/dev/null 2>&1; RC23=$?
assert "T23 不在册且无部门 -> 退出码 2" "2" "$RC23"
# 第二参数误传邮箱（旧用法）：明确报错
HOME="$SB8" VANTAGE_SKIP_TRIGGER=1 node "$REPO/plugin/setup.cjs" "李栋" "a@b.com" >/dev/null 2>&1; RC23b=$?
assert "T23 误传邮箱 -> 退出码 1" "1" "$RC23b"

echo ""
echo "== T25: 服务端复查脱敏(采集端漏网的,服务端兜底) =="
SID25="t25-$(date +%s)"
curl -s -X POST "$LIVE/ingest" -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d "{\"tool\":\"claude-code\",\"session_id\":\"$SID25\",\"dedupe_key\":\"claude-code:$SID25\",\"name\":\"脱敏测试\",\"first_prompt\":\"联系我 someone@example.com\",\"summary\":\"正常摘要\"}" >/dev/null
sleep 0.3
assert "T25 first_prompt 被服务端脱敏" "联系我 [email]" "$($Q field "$SID25" first_prompt)"
assert "T25 summary 不受影响"        "正常摘要"        "$($Q field "$SID25" summary)"

echo ""
echo "== T26: 信封字段 + 迟到旧快照不顶回新快照(effective_ts 合并) =="
SID26="t26-$(date +%s)"
curl -s -X POST "$LIVE/ingest" -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d "{\"tool\":\"claude-code\",\"session_id\":\"$SID26\",\"dedupe_key\":\"claude-code:$SID26\",\"name\":\"T26测试用户\",\"total_tokens\":100,\"observed_at\":\"2026-07-17T10:00:00.000Z\"}" >/dev/null
curl -s -X POST "$LIVE/ingest" -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d "{\"tool\":\"claude-code\",\"session_id\":\"$SID26\",\"dedupe_key\":\"claude-code:$SID26\",\"name\":\"T26测试用户\",\"total_tokens\":50,\"observed_at\":\"2026-07-17T09:00:00.000Z\"}" >/dev/null
sleep 0.3
# 服务端索引(/stats):该用户总量=100(旧快照未顶回);qserver 按行序折叠,不适用此断言
STATS26="$(curl -s -H "Authorization: Bearer $TOKEN" "$LIVE/stats")"
u26(){ echo "$STATS26" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const u=(JSON.parse(s).users||[]).find(x=>x.name==="T26测试用户");process.stdout.write(u?String(u[process.argv[1]]):"MISSING")})' "$1"; }
assert "T26 旧快照未顶回(总量=100)" "100" "$(u26 total_tokens)"
assert "T26 会话数=1(已合并)"      "1"   "$(u26 sessions)"
# 但两个事件都进了 JSONL(事件不丢)
assert "T26 两条事件都归档" "2" "$(grep -c "claude-code:$SID26" "$DATA")"
# 信封:event_id 为 26 字符 ULID、observed_at 透传进归档记录
EID26="$($Q field "$SID26" event_id)"
[ "${#EID26}" = "26" ] && ok "T26 event_id 为 26 字符 ULID" || no "T26 event_id 长度" "26" "${#EID26}"
[ "$(grep "claude-code:$SID26" "$DATA" | grep -c '"observed_at":"2026-07-17T10:00:00.000Z"')" = "1" ] \
  && ok "T26 observed_at 透传进归档记录" || no "T26 observed_at 透传" "归档含 10:00 快照" "无"

echo ""
echo "== T27: S3 归档全链路(fake-s3:key 形状/签名头/故障不阻塞/对账兜底) =="
# 重启后端,带上指向 fake-s3 的 S3 配置(同一数据目录)
FAKE_PORT=4999
FAKE_LOG="$WORK/fakes3.jsonl"
node "$SCRIPT_DIR/fake-s3.cjs" "$FAKE_PORT" "$FAKE_LOG" &
FAKE_PID=$!
kill "$SERVER_PID" 2>/dev/null; kill_port; sleep 0.5
( cd "$REPO/server" && VANTAGE_DATA_DIR="$DATA_DIR" INGEST_TOKEN="$TOKEN" PORT="$PORT" \
    VANTAGE_S3_BUCKET="test-bucket" VANTAGE_S3_REGION="us-east-1" \
    VANTAGE_S3_ENDPOINT="http://localhost:$FAKE_PORT" \
    AWS_ACCESS_KEY_ID="AKIDEXAMPLE" AWS_SECRET_ACCESS_KEY="testsecret" \
    VANTAGE_S3_SWEEP_INTERVAL_SEC=5 \
    npm start >"$WORK/server-s3.log" 2>&1 ) &
SERVER_PID=$!
for _ in $(seq 1 30); do curl -sf "$LIVE/health" >/dev/null 2>&1 && break; sleep 0.3; done

# 1) 正常归档:PUT 到达 fake-s3,path 含 event_id(SDK path-style:/<bucket>/<key>),带 SigV4 头
S4="44444444-4444-4444-4444-444444444444"
cp "$FIX/claude/$S1.jsonl" "$SB/.claude/projects/proj/$S4.jsonl"
node -e 'const fs=require("fs");const p=process.argv[1];const l=fs.readFileSync(p,"utf8").replace(/11111111-1111-1111-1111-111111111111/g,"44444444-4444-4444-4444-444444444444");fs.writeFileSync(p,l)' "$SB/.claude/projects/proj/$S4.jsonl"
endhook "$S4" "logout"; sleep 1.5
EID27="$($Q field "$S4" event_id)"
fake_has(){ grep -c "$1" "$FAKE_LOG" 2>/dev/null || true; }
[ "$(fake_has "$EID27")" -ge 1 ] && ok "T27 event 已 PUT 到 S3(path 含 event_id)" || no "T27 PUT 归档" "含 $EID27" "$(head -3 "$FAKE_LOG" 2>/dev/null)"
# 注:SDK 在请求线上会把 = 编码为 %3D,S3 收到后解码——真实 key 仍是 events/dt=...(spec §2)
grep -E '"path":"/test-bucket/events/dt(=|%3D)' "$FAKE_LOG" | grep -q "_claude-code.json" \
  && ok "T27 path 形状 /test-bucket/events/dt=..._claude-code.json" || no "T27 path 形状" "/test-bucket/events/dt=…" "$(head -1 "$FAKE_LOG")"
grep -q '"authorization":"AWS4-HMAC-SHA256 ' "$FAKE_LOG" \
  && ok "T27 带 SigV4 Authorization 头" || no "T27 签名头" "AWS4-HMAC-SHA256" "无"

# 2) S3 宕机:/ingest 照常成功(异步不阻塞),事件落死信
kill "$FAKE_PID" 2>/dev/null; sleep 0.3
S5="55555555-5555-5555-5555-555555555555"
cp "$SB/.claude/projects/proj/$S4.jsonl" "$SB/.claude/projects/proj/$S5.jsonl"
node -e 'const fs=require("fs");const p=process.argv[1];fs.writeFileSync(p,fs.readFileSync(p,"utf8").replace(/44444444-4444-4444-4444-444444444444/g,"55555555-5555-5555-5555-555555555555"))' "$SB/.claude/projects/proj/$S5.jsonl"
endhook "$S5" "logout"; sleep 1.5
assert "T27 S3 宕机 ingest 照常" "赵六" "$(name_of "$S5")"
DEAD_JSONL="$DATA_DIR/s3-archive-dead.jsonl"
EID27b="$($Q field "$S5" event_id)"
[ -s "$DEAD_JSONL" ] && grep -q "$EID27b" "$DEAD_JSONL" \
  && ok "T27 失败事件落死信" || no "T27 死信" "含 $EID27b" "$(head -2 "$DEAD_JSONL" 2>/dev/null)"

# 3) S3 恢复:对账器(VANTAGE_S3_SWEEP_INTERVAL_SEC=5)自动补传死信
node "$SCRIPT_DIR/fake-s3.cjs" "$FAKE_PORT" "$FAKE_LOG" &
FAKE_PID=$!
sleep 7
[ "$(fake_has "$EID27b")" -ge 1 ] && ok "T27 对账器补传死信成功" || no "T27 对账补传" "含 $EID27b" "$(tail -2 "$FAKE_LOG")"
[ -s "$DEAD_JSONL" ] && no "T27 死信应清空" "空" "仍有内容" || ok "T27 死信已清空"
kill "$FAKE_PID" 2>/dev/null

echo ""
echo "== T28: 撞墙历史不丢(窗口刷新后仍记得今天撞过墙) =="
# spec §5/§6.3:同一会话早上撞墙(quota_reached=primary 100%),下午窗口刷新(quota_reached=null 30%)。
# 当前额度应显示 30%(§6.2);但 hit_wall_today 仍为 true——窗口刷新只覆盖当前值,抹不掉历史事实。
# 用本地当天时间,跟服务端"本地日"判定一致(任何时区跑都稳,不随日期/时区漂移)。
SID28="t28-$(date +%s)"
curl -s -X POST "$LIVE/ingest" -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d "{\"tool\":\"codex\",\"session_id\":\"$SID28\",\"dedupe_key\":\"codex:$SID28\",\"name\":\"撞墙测试\",\"quota_primary_pct\":100,\"quota_reached\":\"primary\",\"quota_plan\":\"plus\",\"observed_at\":\"$(iso_local 10)\"}" >/dev/null
curl -s -X POST "$LIVE/ingest" -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d "{\"tool\":\"codex\",\"session_id\":\"$SID28\",\"dedupe_key\":\"codex:$SID28\",\"name\":\"撞墙测试\",\"quota_primary_pct\":30,\"quota_reached\":null,\"quota_plan\":\"plus\",\"observed_at\":\"$(iso_local 15)\"}" >/dev/null
sleep 0.3
STATS28="$(curl -s -H "Authorization: Bearer $TOKEN" "$LIVE/stats")"
u28(){ echo "$STATS28" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const u=(JSON.parse(s).users||[]).find(x=>x.name==="撞墙测试");process.stdout.write(u==null?"MISSING":String(u[process.argv[1]]))})' "$1"; }
assert "T28 当前额度=30%(窗口已刷新)"      "30"   "$(u28 quota_primary_pct)"
assert "T28 当前未撞墙(quota_reached=null)" "null" "$(u28 quota_reached)"
assert "T28 仍记得今天撞过墙"              "true" "$(u28 hit_wall_today)"

echo ""
echo "== T29: 当前额度跨会话取最新(§6.2,同一用户多会话,最新带额度的胜) =="
SID29A="t29a-$(date +%s)"
SID29B="t29b-$(date +%s)"
# 同一用户两个不同会话,各带额度快照;有效时间更晚的(88%)应为当前额度,不是 42% 也不是求和
curl -s -X POST "$LIVE/ingest" -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d "{\"tool\":\"codex\",\"session_id\":\"$SID29A\",\"dedupe_key\":\"codex:$SID29A\",\"name\":\"额度测试\",\"quota_primary_pct\":42,\"quota_plan\":\"plus\",\"observed_at\":\"$(iso_local 10)\"}" >/dev/null
curl -s -X POST "$LIVE/ingest" -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d "{\"tool\":\"codex\",\"session_id\":\"$SID29B\",\"dedupe_key\":\"codex:$SID29B\",\"name\":\"额度测试\",\"quota_primary_pct\":88,\"quota_plan\":\"plus\",\"observed_at\":\"$(iso_local 14)\"}" >/dev/null
sleep 0.3
STATS29="$(curl -s -H "Authorization: Bearer $TOKEN" "$LIVE/stats")"
u29(){ echo "$STATS29" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const u=(JSON.parse(s).users||[]).find(x=>x.name==="额度测试");process.stdout.write(u==null?"MISSING":String(u[process.argv[1]]))})' "$1"; }
assert "T29 当前额度取跨会话最新=88%" "88" "$(u29 quota_primary_pct)"
assert "T29 两会话都计入(sessions=2)"  "2"  "$(u29 sessions)"

echo ""
echo "== T30: restore:s3 回放等价(灾备真能还原等价状态,spec §9) =="
# 自包含:全新数据目录 + 独立 fake-s3,全程开 S3。ingest 几条(含合并 + 撞墙),
# restore 出文件后用第二台服务器(无 S3)replay,/stats 必须与原服务器等价。
RPORT1=3971; RPORT2=3972; RFAKE=4971
RDIR1="$WORK/r1"; RDIR2="$WORK/r2"; mkdir -p "$RDIR1" "$RDIR2"
RFAKE_LOG="$WORK/rfake.jsonl"; RESTORED="$WORK/usage-restored.jsonl"
killp "$RPORT1" "$RPORT2" "$RFAKE"
node "$SCRIPT_DIR/fake-s3.cjs" "$RFAKE" "$RFAKE_LOG" & RPID_FAKE=$!
sleep 0.3
( cd "$REPO/server" && VANTAGE_DATA_DIR="$RDIR1" INGEST_TOKEN="$TOKEN" PORT="$RPORT1" \
    VANTAGE_S3_BUCKET="test-bucket" VANTAGE_S3_REGION="us-east-1" \
    VANTAGE_S3_ENDPOINT="http://localhost:$RFAKE" \
    AWS_ACCESS_KEY_ID="AKIDEXAMPLE" AWS_SECRET_ACCESS_KEY="testsecret" \
    npm start >"$WORK/r1.log" 2>&1 ) & RPID1=$!
for _ in $(seq 1 40); do curl -sf "http://localhost:$RPORT1/health" >/dev/null 2>&1 && break; sleep 0.3; done
TODAY30="$(date -u +%Y-%m-%d)"; RX="t30-$(date +%s)"
# 灾备甲:同会话三快照(100@09:00 -> 撞墙150@10:00 -> 刷新150@11:00),灾备乙:claude 200;时间用本地当天
curl -s -X POST "http://localhost:$RPORT1/ingest" -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d "{\"tool\":\"codex\",\"session_id\":\"$RX\",\"dedupe_key\":\"codex:$RX\",\"name\":\"灾备甲\",\"total_tokens\":100,\"observed_at\":\"$(iso_local 9)\"}" >/dev/null
curl -s -X POST "http://localhost:$RPORT1/ingest" -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d "{\"tool\":\"codex\",\"session_id\":\"$RX\",\"dedupe_key\":\"codex:$RX\",\"name\":\"灾备甲\",\"total_tokens\":150,\"quota_reached\":\"primary\",\"observed_at\":\"$(iso_local 10)\"}" >/dev/null
curl -s -X POST "http://localhost:$RPORT1/ingest" -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d "{\"tool\":\"codex\",\"session_id\":\"$RX\",\"dedupe_key\":\"codex:$RX\",\"name\":\"灾备甲\",\"total_tokens\":150,\"observed_at\":\"$(iso_local 11)\"}" >/dev/null
curl -s -X POST "http://localhost:$RPORT1/ingest" -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d "{\"tool\":\"claude-code\",\"session_id\":\"${RX}-c\",\"dedupe_key\":\"claude-code:${RX}-c\",\"name\":\"灾备乙\",\"total_tokens\":200,\"observed_at\":\"$(iso_local 9 30)\"}" >/dev/null
# 等异步归档:轮询 fake 日志直到 4 条 PUT(或超时)。条件用干净的 wc -l(缺失回退 0)。
for _ in $(seq 1 40); do [ "$(wc -l < "$RFAKE_LOG" 2>/dev/null || echo 0)" -ge 4 ] && break; sleep 0.2; done
[ "$(wc -l < "$RFAKE_LOG" | tr -d ' ')" -ge 4 ] && ok "T30 4 条事件已归档 S3" || no "T30 归档" ">=4 PUT" "$(wc -l < "$RFAKE_LOG" | tr -d ' ')"
STATS_BEFORE="$(curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:$RPORT1/stats")"
# 灾难恢复:从 S3 拉回全部 event
( cd "$REPO/server" && VANTAGE_S3_BUCKET="test-bucket" VANTAGE_S3_REGION="us-east-1" \
    VANTAGE_S3_ENDPOINT="http://localhost:$RFAKE" \
    AWS_ACCESS_KEY_ID="AKIDEXAMPLE" AWS_SECRET_ACCESS_KEY="testsecret" \
    npm run restore:s3 -- "$RESTORED" >"$WORK/restore.log" 2>&1 )
assert "T30 restore 拉回行数 = 原始" "$(wc -l < "$RDIR1/usage.jsonl" | tr -d ' ')" "$(wc -l < "$RESTORED" | tr -d ' ')"
# 第二台服务器:用恢复文件当 usage.jsonl,replay(不开 S3)
cp "$RESTORED" "$RDIR2/usage.jsonl"
( cd "$REPO/server" && VANTAGE_DATA_DIR="$RDIR2" INGEST_TOKEN="$TOKEN" PORT="$RPORT2" npm start >"$WORK/r2.log" 2>&1 ) & RPID2=$!
for _ in $(seq 1 40); do curl -sf "http://localhost:$RPORT2/health" >/dev/null 2>&1 && break; sleep 0.3; done
STATS_AFTER="$(curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:$RPORT2/stats")"
killp "$RPORT1" "$RPORT2" "$RFAKE"   # 按端口杀,连 tsx 子进程一起清(只 kill npm 父进程杀不掉)
printf '%s' "$STATS_BEFORE" > "$WORK/sb.json"; printf '%s' "$STATS_AFTER" > "$WORK/sa.json"
CMP="$(node -e '
  const a=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
  const b=JSON.parse(require("fs").readFileSync(process.argv[2],"utf8"));
  // 规范化后比对:总量/会话数/当前额度/撞墙三字段(today+7d+last)都纳入等价判定
  const norm=(s)=>{const m={};for(const u of (s.users||[]))m[u.name]={t:u.total_tokens,s:u.sessions,q:u.quota_reached,h:u.hit_wall_today,w:u.hit_wall_7d,l:u.last_wall_hit};return{ts:s.total_sessions,u:m};};
  process.stdout.write(JSON.stringify(norm(a))===JSON.stringify(norm(b))?"EQUAL":"DIFF");
' "$WORK/sb.json" "$WORK/sa.json")"
assert "T30 恢复后 /stats 与原始等价(总量/会话数/额度/撞墙)" "EQUAL" "$CMP"

echo ""
echo "== T31: 撞墙判定按本地日(本地深夜=UTC 次日,仍算今天) =="
# 本地今天 23:30 的墙,在负偏移时区(如本机 EDT)对应 UTC 次日。按"本地日"应仍算今天撞墙;
# 若错用 UTC 日,它会落到"明天"、hit_wall_today=false。(UTC 机器上仍是 UTC 当天,新旧逻辑都为 true。)
SID31="t31-$(date +%s)"
curl -s -X POST "$LIVE/ingest" -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d "{\"tool\":\"codex\",\"session_id\":\"$SID31\",\"dedupe_key\":\"codex:$SID31\",\"name\":\"时区测试\",\"quota_reached\":\"primary\",\"observed_at\":\"$(iso_local 23 30)\"}" >/dev/null
sleep 0.3
STATS31="$(curl -s -H "Authorization: Bearer $TOKEN" "$LIVE/stats")"
u31(){ echo "$STATS31" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const u=(JSON.parse(s).users||[]).find(x=>x.name==="时区测试");process.stdout.write(u==null?"MISSING":String(u[process.argv[1]]))})' "$1"; }
assert "T31 本地深夜撞墙按本地日算今天" "true" "$(u31 hit_wall_today)"

echo ""
echo "== T32: 当前额度按 effective_ts 取最新(迟到的旧额度快照不顶回新的,§6.2) =="
# B 先传(30%,快照较新 observed_at=12),A 后传(95%,快照较旧 observed_at=10)。
# A 后到 -> received_at 更晚,但 observed_at 更旧。按 effective_ts 应取 B(30%);
# 若错用 ended_at||received_at 会错取 A(95%)。
SID32B="t32b-$(date +%s)"
SID32A="t32a-$(date +%s)"
curl -s -X POST "$LIVE/ingest" -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d "{\"tool\":\"codex\",\"session_id\":\"$SID32B\",\"dedupe_key\":\"codex:$SID32B\",\"name\":\"额度新旧\",\"quota_primary_pct\":30,\"observed_at\":\"$(iso_local 12)\"}" >/dev/null
curl -s -X POST "$LIVE/ingest" -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d "{\"tool\":\"codex\",\"session_id\":\"$SID32A\",\"dedupe_key\":\"codex:$SID32A\",\"name\":\"额度新旧\",\"quota_primary_pct\":95,\"observed_at\":\"$(iso_local 10)\"}" >/dev/null
sleep 0.3
STATS32="$(curl -s -H "Authorization: Bearer $TOKEN" "$LIVE/stats")"
u32(){ echo "$STATS32" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const u=(JSON.parse(s).users||[]).find(x=>x.name==="额度新旧");process.stdout.write(u==null?"MISSING":String(u[process.argv[1]]))})' "$1"; }
assert "T32 当前额度取 effective_ts 最新=30%" "30" "$(u32 quota_primary_pct)"

echo ""
echo "== T33: 插件自更新——SessionStart 后台检查一次,24h 节流;稳定副本不检查 =="
SB10="$WORK/home10"; LOG10="$SB10/.vantage/agent.log"
mkdir -p "$SB10/.vantage"
echo '{"server_url":"http://localhost:59999","token":"x"}' > "$SB10/.vantage/config.json"
fired_n(){ grep -c "vantage-self-update-fired" "$LOG10" 2>/dev/null; }
# 替身命令代替 claude CLI:输出被 reconcile 重定向进 agent.log,借计数观察触发次数
START33(){ echo '{"hook_event_name":"SessionStart"}' | HOME="$SB10" VANTAGE_DISABLE_SELF_UPDATE= \
  VANTAGE_SELF_UPDATE_CMD='echo vantage-self-update-fired' "$@" node "$AGENT/reconcile.cjs"; sleep 0.6; }
# 1) 首次 SessionStart:触发一次后台检查
START33 env
assert "T33 首次 SessionStart 触发自更新检查" "1" "$(fired_n)"
grep -q "self-update: check spawned" "$LOG10" && ok "T33 日志记录 check spawned" || no "T33 spawned 日志" "check spawned" "无"
# 2) 24h 内第二次:被节流,不再触发
START33 env
assert "T33 24h 内第二次被节流" "1" "$(fired_n)"
# 3) 间隔调 0:每次 SessionStart 都检查(验证节流间隔可调)
START33 env VANTAGE_SELF_UPDATE_INTERVAL_H=0
assert "T33 间隔调 0 后再次触发" "2" "$(fired_n)"
# 4) 稳定副本路径(Codex 触发器跑的那份)不做自更新
mkdir -p "$SB10/.vantage/agent"; cp "$AGENT"/*.cjs "$SB10/.vantage/agent/"; mkdir -p "$SB10/.vantage/agent/parsers"; cp "$AGENT"/parsers/*.cjs "$SB10/.vantage/agent/parsers/"
echo '{"hook_event_name":"SessionStart"}' | HOME="$SB10" VANTAGE_DISABLE_SELF_UPDATE= \
  VANTAGE_SELF_UPDATE_CMD='echo vantage-self-update-fired' VANTAGE_SELF_UPDATE_INTERVAL_H=0 \
  node "$SB10/.vantage/agent/reconcile.cjs"; sleep 0.6
assert "T33 稳定副本路径不自更新" "2" "$(fired_n)"
# 5) 总开关:禁用后即使间隔为 0 也不触发
START33 env VANTAGE_SELF_UPDATE_INTERVAL_H=0 VANTAGE_DISABLE_SELF_UPDATE=1
assert "T33 VANTAGE_DISABLE_SELF_UPDATE=1 禁用" "2" "$(fired_n)"

echo ""
echo "== T34-T36: Lambda 路径(ingest→rebuild→stats,fake-s3 往返,水位线增量) =="
LFAKE=4972; LFAKE_LOG="$WORK/lfake-put.jsonl"; LREAD_LOG="$WORK/lfake-read.jsonl"
killp "$LFAKE"
node "$SCRIPT_DIR/fake-s3.cjs" "$LFAKE" "$LFAKE_LOG" "$LREAD_LOG" &
sleep 0.3
# 调一次 Lambda(每次新进程=冷启动;env 指向 fake-s3,前缀 lt/)
LD() { ( cd "$REPO/server" && \
  VANTAGE_S3_BUCKET="test-bucket" VANTAGE_S3_PREFIX="lt" VANTAGE_S3_REGION="us-east-1" \
  VANTAGE_S3_ENDPOINT="http://localhost:$LFAKE" AWS_ACCESS_KEY_ID="x" AWS_SECRET_ACCESS_KEY="y" \
  INGEST_TOKEN="$TOKEN" node --import tsx "$SCRIPT_DIR/lambda-driver.mjs" "$1" 2>>"$WORK/lambda-driver.err" ); }
mkpost(){ node -e 'const fs=require("fs");fs.writeFileSync(process.argv[3],JSON.stringify({requestContext:{http:{method:"POST"}},rawPath:"/ingest",headers:{authorization:"Bearer "+process.argv[1]},body:process.argv[2]}))' "$TOKEN" "$1" "$2"; }
mkget(){ node -e 'const fs=require("fs");fs.writeFileSync(process.argv[2],JSON.stringify({requestContext:{http:{method:"GET"}},rawPath:"/stats",headers:{authorization:"Bearer "+process.argv[1]}}))' "$TOKEN" "$1"; }
mkev(){ node -e 'require("fs").writeFileSync(process.argv[2],process.argv[1])' "$1" "$2"; }
jget(){ node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s)[process.argv[1]])))' "$1"; }         # 顶层字段
jbod(){ node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(JSON.parse(s).body);process.stdout.write(String(v[process.argv[1]]))})' "$1"; } # body 内字段
ulam(){ node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(JSON.parse(s).body);const u=(v.users||[]).find(x=>x.name===process.argv[1]);process.stdout.write(u==null?"MISSING":String(u[process.argv[2]]))})' "$1" "$2"; } # users[姓名].字段

echo "-- T34: 显式 rebuild 全链路(合并+额度) --"
LX="t34-$(date +%s)"
mkpost "{\"tool\":\"codex\",\"session_id\":\"$LX\",\"dedupe_key\":\"codex:$LX\",\"name\":\"λ甲\",\"total_tokens\":100,\"observed_at\":\"$(iso_local 9)\"}" "$WORK/le1.json"
mkpost "{\"tool\":\"codex\",\"session_id\":\"$LX\",\"dedupe_key\":\"codex:$LX\",\"name\":\"λ甲\",\"total_tokens\":150,\"quota_primary_pct\":88,\"observed_at\":\"$(iso_local 10)\"}" "$WORK/le2.json"
mkpost "{\"tool\":\"claude-code\",\"session_id\":\"$LX-c\",\"dedupe_key\":\"claude-code:$LX-c\",\"name\":\"λ乙\",\"total_tokens\":200,\"observed_at\":\"$(iso_local 9 30)\"}" "$WORK/le3.json"
mkev "{\"action\":\"rebuild\"}" "$WORK/lrb.json"
A1="$(LD "$WORK/le1.json")"; A2="$(LD "$WORK/le2.json")"; A3="$(LD "$WORK/le3.json")"
assert "T34 ingest#1 200"        "200" "$(echo "$A1" | jget statusCode)"
assert "T34 ingest#3 200"        "200" "$(echo "$A3" | jget statusCode)"
RB="$(LD "$WORK/lrb.json")"
assert "T34 rebuild newEvents=3" "3"   "$(echo "$RB" | jbod newEvents)"
mkget "$WORK/lst.json"; ST="$(LD "$WORK/lst.json")"
assert "T34 stats 200"           "200" "$(echo "$ST" | jget statusCode)"
assert "T34 会话=2(同会话已合并)" "2"   "$(echo "$ST" | jbod total_sessions)"
assert "T34 甲 token=150(取最新)" "150" "$(echo "$ST" | ulam "λ甲" total_tokens)"
assert "T34 甲 当前额度=88"       "88"  "$(echo "$ST" | ulam "λ甲" quota_primary_pct)"
assert "T34 watermark 非空"       "1"   "$(echo "$ST" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(JSON.parse(s).body).watermark?"1":"0"))')"

echo "-- T35: 撞墙历史(撞墙→窗口刷新→/stats 仍记得;/stats 读时自动追平) --"
LW="t35-$(date +%s)"
mkpost "{\"tool\":\"codex\",\"session_id\":\"$LW\",\"dedupe_key\":\"codex:$LW\",\"name\":\"λ墙\",\"quota_primary_pct\":100,\"quota_reached\":\"primary\",\"quota_plan\":\"plus\",\"observed_at\":\"$(iso_local 10)\"}" "$WORK/lw1.json"
mkpost "{\"tool\":\"codex\",\"session_id\":\"$LW\",\"dedupe_key\":\"codex:$LW\",\"name\":\"λ墙\",\"quota_primary_pct\":30,\"quota_reached\":null,\"quota_plan\":\"plus\",\"observed_at\":\"$(iso_local 15)\"}" "$WORK/lw2.json"
LD "$WORK/lw1.json" >/dev/null; LD "$WORK/lw2.json" >/dev/null
mkget "$WORK/lws.json"; WST="$(LD "$WORK/lws.json")"   # 不显式 rebuild,/stats 内部先增量追平
assert "T35 当前额度=30(窗口已刷新)" "30"   "$(echo "$WST" | ulam "λ墙" quota_primary_pct)"
assert "T35 当前未撞墙"              "null" "$(echo "$WST" | ulam "λ墙" quota_reached)"
assert "T35 仍记得今天撞过墙"        "true" "$(echo "$WST" | ulam "λ墙" hit_wall_today)"
assert "T35 本周撞墙"                "true" "$(echo "$WST" | ulam "λ墙" hit_wall_7d)"

echo "-- T36: 水位线增量(只读新事件;LIST 带 start-after) --"
R1="$(LD "$WORK/lrb.json")"   # T34/T35 已追平,应 0 条新事件
assert "T36 无新事件 newEvents=0" "0" "$(echo "$R1" | jbod newEvents)"
mkpost "{\"tool\":\"codex\",\"session_id\":\"$LX-z\",\"dedupe_key\":\"codex:$LX-z\",\"name\":\"λ丙\",\"total_tokens\":5,\"observed_at\":\"$(iso_local 16)\"}" "$WORK/lz1.json"
LD "$WORK/lz1.json" >/dev/null
R2="$(LD "$WORK/lrb.json")"
assert "T36 第二轮只读 1 条新事件" "1" "$(echo "$R2" | jbod newEvents)"
NSA="$(grep -c 'start-after' "$LREAD_LOG" 2>/dev/null || true)"
[ "${NSA:-0}" -ge 1 ] && ok "T36 增量 LIST 带 start-after" || no "T36 LIST start-after" ">=1" "${NSA:-0}"
mkget "$WORK/lfs.json"; FST="$(LD "$WORK/lfs.json")"
assert "T36 累计会话=4(2+1+1)" "4" "$(echo "$FST" | jbod total_sessions)"
killp "$LFAKE"

echo ""
echo "== T37: 卸载 skill——删 ~/.vantage + 缓存,触发器/卸插件走 dryrun =="
SB37="$WORK/home37"
mkdir -p "$SB37/.vantage/agent" "$SB37/.claude/plugins/cache/dgcrane/vantage" "$SB37/.claude/plugins/marketplaces/dgcrane" "$SB37/Library/LaunchAgents"
echo '{"name":"x"}' > "$SB37/.vantage/config.json"
touch "$SB37/Library/LaunchAgents/com.dgcrane.vantage.codex.plist"
echo '{}' > "$SB37/.claude/plugins/cache/dgcrane/vantage/i.json"
echo '{}' > "$SB37/.claude/plugins/marketplaces/dgcrane/m.json"
OUT37="$(HOME="$SB37" VANTAGE_TRIGGER_DRYRUN=1 VANTAGE_UNINSTALL_SKIP_PLUGIN=1 node "$REPO/plugin/uninstall.cjs" 2>&1)"
[ ! -e "$SB37/.vantage" ] && ok "T37 删 ~/.vantage" || no "T37 ~/.vantage" "不存在" "存在"
[ ! -e "$SB37/.claude/plugins/cache/dgcrane" ] && ok "T37 删 cache/dgcrane" || no "T37 cache" "不存在" "存在"
[ ! -e "$SB37/.claude/plugins/marketplaces/dgcrane" ] && ok "T37 删 marketplaces/dgcrane" || no "T37 marketplaces" "不存在" "存在"
echo "$OUT37" | grep -qF "[dryrun] launchctl bootout" && ok "T37 触发器卸载命令(mac dryrun)" || no "T37 触发器 dryrun" "有" "无"
echo "$OUT37" | grep -qF "claude plugin uninstall vantage@dgcrane" && ok "T37 detached 卸插件命令" || no "T37 卸插件命令" "有" "无"
echo "$OUT37" | grep -qF "claude plugin marketplace remove dgcrane" && ok "T37 detached 移除市场命令" || no "T37 移除市场命令" "有" "无"

echo ""
echo "======================================================"
echo " 结果: PASS=$PASS  FAIL=$FAIL"
echo "======================================================"
[ "$FAIL" -eq 0 ]
