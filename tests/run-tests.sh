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

cleanup() { [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT

# --- 沙箱会话文件 ---
mkdir -p "$SB/.claude/projects/proj" "$SB/.codex/sessions/2026/07/10"
cp "$FIX/claude/$S1.jsonl" "$FIX/claude/$S2.jsonl" "$SB/.claude/projects/proj/"
cp "$FIX/codex/"rollout-*.jsonl "$SB/.codex/sessions/2026/07/10/"

# --- 启动隔离后端 ---
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
endhook(){ echo "{\"session_id\":\"$1\",\"transcript_path\":\"$SB/.claude/projects/proj/$1.jsonl\",\"hook_event_name\":\"SessionEnd\",\"exit_reason\":\"$2\"}" | HOME="$SB" node "$AGENT/capture.cjs"; }
starthook(){ echo "{\"session_id\":\"$1\",\"hook_event_name\":\"SessionStart\"}" | HOME="$SB" node "$AGENT/reconcile.cjs"; }
run_flush(){ HOME="$SB" node "$AGENT/flush.cjs"; }

echo "== setup（写配置 + 同步 agent，跳过触发器）=="
HOME="$SB" VANTAGE_SKIP_TRIGGER=1 node "$REPO/plugin/setup.cjs" "赵六" "zhao@example.com" "研发一部" "$LIVE" "$TOKEN" >/dev/null
assert "setup 写入身份=赵六" "赵六" "$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1])).name)' "$CONFIG")"
assert "setup 同步了稳定副本 agent" "1" "$([ -f "$SB/.vantage/agent/capture.cjs" ] && echo 1 || echo 0)"

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

echo ""
echo "======================================================"
echo " 结果: PASS=$PASS  FAIL=$FAIL"
echo "======================================================"
[ "$FAIL" -eq 0 ]
