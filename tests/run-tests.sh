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

S1="11111111-1111-1111-1111-111111111111"
S2="22222222-2222-2222-2222-222222222222"
S3="33333333-3333-3333-3333-333333333333"   # codex

# npm start 会派生 tsx 子进程，kill 父进程杀不到子进程 -> 端口会残留占用，拖垮后续运行。
# 因此按端口兜底清理。
kill_port() { lsof -ti tcp:"$PORT" 2>/dev/null | xargs kill -9 2>/dev/null; }
cleanup() { [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null; kill_port; rm -rf "$WORK"; }
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

echo "== setup（写配置 + 同步 agent，跳过触发器）=="
HOME="$SB" VANTAGE_SKIP_TRIGGER=1 node "$REPO/plugin/setup.cjs" "赵六" "zhao@example.com" "研发一部" "$LIVE" "$TOKEN" >/dev/null
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
HOME="$SB3" VANTAGE_SKIP_TRIGGER=1 node "$REPO/plugin/setup.cjs" "钱七" "q@example.com" "研发部" "$LIVE" "$TOKEN" >/dev/null
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
node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1],JSON.stringify({name:"孙八",email:"sun@example.com",department:"研发部",server_url:"http://localhost:59999",token:"x",installed_at:new Date().toISOString()}))' "$SB4/.vantage/config.json"
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
node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1],JSON.stringify({name:"孙八",email:"sun@example.com",department:"研发部",server_url:"http://localhost:59999",token:"x",installed_at:new Date().toISOString()}))' "$SB5/.vantage/config.json"
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
node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1],JSON.stringify({name:"孙八",email:"sun@example.com",department:"研发部",server_url:"http://localhost:59999",token:"x",installed_at:new Date().toISOString()}))' "$SB6/.vantage/config.json"
# 3) 模拟 launchd RunAtLoad：--only codex 先跑
HOME="$SB6" node "$AGENT/reconcile.cjs" --only codex >/dev/null 2>&1; sleep 0.4
# 4) 随后 setup 后台触发的全量对账才跑
echo "{\"hook_event_name\":\"SessionStart\"}" | HOME="$SB6" node "$AGENT/reconcile.cjs"; sleep 0.6
assert "T21 --only 先跑后旧会话仍重打身份=孙八" "孙八" "$(spool_name6)"

echo ""
echo "== T22: 触发器为每天登录时+正午兜底,不再每小时（贴合周会消费节奏）=="
# DRYRUN 写出定义文件但不注册进系统调度器；仅断言当前平台的产物。
SB7="$WORK/home7"; mkdir -p "$SB7/.vantage"
HOME="$SB7" VANTAGE_TRIGGER_DRYRUN=1 node "$REPO/plugin/setup.cjs" "周九" "zhou@example.com" "研发部" "http://localhost:59999" "x" >/dev/null 2>&1
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
echo "======================================================"
echo " 结果: PASS=$PASS  FAIL=$FAIL"
echo "======================================================"
[ "$FAIL" -eq 0 ]
