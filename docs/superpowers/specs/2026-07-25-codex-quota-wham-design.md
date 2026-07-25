# Codex 实时额度采集（wham/usage）设计

## 背景

Codex 会话的额度（5h/7d 用量）之前只能从 rollout 文件的 `rate_limits` 捡漏——实测 16,234 个会话里只有 96 个（0.6%）有数据，且只带 7 天窗。99% 的记录 `quota_*` 是 null。

已确认存在官方（虽非公开）接口：`GET https://chatgpt.com/backend-api/wham/usage`，带 OAuth `access_token` + `chatgpt-account-id`，返回当前账户实时额度。本机 `~/.codex/auth.json` 已有完整凭证。实测 HTTP 200，返回结构稳定。

本设计用 wham 作为额度的**唯一权威源**，替换 rollout 捡漏。

## 目标

1. 每条 Codex 记录带上**实时**账户额度（不再是 99% null）。
2. wham 是额度唯一源——删掉 rollout 读 rate_limits 的代码，避免双源乱序。
3. 只服务 Codex（wham 是 OpenAI 账号额度；Claude Code 另一套账，不沾）。
4. wham 失败不丢数据、不造假——靠服务端粘性合并沿用上次值。
5. 不新增 S3 对象（额度贴在本来就要上传的 Codex 记录上）。

## 非目标

1. 不做 OAuth token 主动刷新（v1 依赖 Codex 自身保持 auth.json 新鲜；token 过期→wham 失败→返回 null→粘性沿用。刷新作为后续）。
2. 不改 Claude Code 采集路径。
3. 不做 S3 批量/gzip（额度贴现有记录，零新增对象）。
4. 不存 wham 的营销字段（upsell/promo）和 PII（email/user_id/account_id）。

## 已确认的 wham 响应（plus 账号实例）

```json
{
  "user_id": "...", "account_id": "...", "email": "...",          // PII，删
  "plan_type": "plus",
  "rate_limit": {
    "limit_reached": true,
    "primary_window": {
      "used_percent": 100,
      "limit_window_seconds": 604800,                              // = 7 天
      "reset_after_seconds": 321648,                               // 倒计时，删
      "reset_at": 1785285347                                       // Unix 秒，转 ISO
    },
    "secondary_window": null
  },
  "rate_limit_reached_type": { "type": "rate_limit_reached", ... },
  "rate_limit_upsell": { ... },                                    // 营销，删
  "promo": null,                                                   // 营销，删
  "credits": { ... }, "spend_control": { ... }                     // 删（只留 7 天额度）
}
```

只暴露一个 7 天窗（plus 账号无 5h 窗）。

## quota 对象结构（贴在 Codex 记录上）

只 5 个字段，扁平，无嵌套窗口：

```json
"quota": {
  "plan_type": "plus",
  "used_percent": 100,
  "limit_reached": true,
  "reset_at": "2026-07-29T00:35:47.000Z",
  "observed_at": "2026-07-25T15:30:00.000Z"
}
```

| 字段 | 含义 | 来源 |
|---|---|---|
| `plan_type` | 套餐 | wham 顶层 `plan_type` |
| `used_percent` | 7 天窗已用 % | `rate_limit.primary_window.used_percent` |
| `limit_reached` | 是否撞墙 | `rate_limit.limit_reached` |
| `reset_at` | 重置真实日期（ISO） | `primary_window.reset_at`（Unix 秒→ISO） |
| `observed_at` | 本次测量时刻 | 调用时间 ISO |

## 获取时机

挂在 **Codex 的 reconcile 路径**（`--only codex` 或扫到 codex 源时），每轮一次，自带 **1 小时节流**（`state.json` 的 `__last_quota_fetch__`）：

- 距上次 < 1h → 沿用上次结果（不调 wham）。
- ≥ 1h → 调 wham，刷新。

实际刷新频率 = Codex reconcile 触发频率：当前 main（登录 + 每天 12:00）≈ 每天 2 次；合并 hourly 分支后每小时。对 7 天窗足够。

**贴给当轮所有 Codex 记录**（账户级快照，每条都带同一个），不挑某一条。看板按人取 `quota.observed_at` 最新的即为当前额度。Claude 记录不贴。

## 组件

### 1. 新增 `plugin/agent/quota.cjs`

```
fetchCodexQuota() -> { plan_type, used_percent, limit_reached, reset_at, observed_at } | null
```
- 读 `~/.codex/auth.json`：`tokens.access_token` + `tokens.account_id`。缺凭证 → null。
- `GET https://chatgpt.com/backend-api/wham/usage`，headers：`Authorization: Bearer <token>`、`chatgpt-account-id: <id>`、`Accept: application/json`、`User-Agent: codex-cli/1.0`。超时 8s。
- 非 200 / 解析失败 / 网络错 → null（不抛）。
- 成功 → 只取 5 字段；`reset_at` 由 Unix 秒转 ISO（`new Date(ms).toISOString()`）。
- **绝不**返回 email/user_id/account_id。
- 用 `core.log` 记结果（成功/失败原因），不打印 token。

### 2. `plugin/agent/reconcile.cjs` 挂载

- `main()` 里、扫 codex 源之前：若 `args.only === "codex"`（或本轮会扫 codex），调 `fetchCodexQuota()`，受 `__last_quota_fetch__` 1h 节流。
- 把结果存到本轮变量 `codexQuota`。
- 构造 Codex record 时（`for src of sources` 且 `src.tool==="codex"`）：`if (codexQuota) record.quota = codexQuota;`。
- Claude record 不加 `quota`。
- 失败（null）→ 记录不带 `quota`，不阻塞采集。

### 3. `plugin/agent/parsers/codex.cjs` 删除 rollout 额度

- 删 `rateLimits` 变量及其赋值（token_count 里 `p.rate_limits`）。
- 删 `usedPct`、`classifyQuota`、`const quota = classifyQuota(...)`。
- 返回对象删 `quota_primary_pct`/`quota_secondary_pct`/`quota_plan`/`quota_reached` 四个字段。
- codex parser 不再产出任何额度字段（额度由 reconcile 的 wham 注入）。

### 4. `plugin/agent/parsers/claude-code.cjs`

- 返回对象删 `quota_primary_pct`/`quota_secondary_pct`/`quota_plan`/`quota_reached` 四个 null 字段（schema 里不再有这些）。

### 5. `server/src/merge.ts` 类型 + 粘性合并 + WallHit

- `UsageRecord`：删 `quota_primary_pct`/`quota_secondary_pct`/`quota_plan`/`quota_reached`，新增：
  ```ts
  quota?: {
    plan_type?: string;
    used_percent?: number;
    limit_reached?: boolean;
    reset_at?: string;
    observed_at?: string;
  };
  ```
- `mergeInto` 粘性：rec 胜出后、`set` 前，若 `rec.quota == null && prev?.quota != null` → `rec.quota = prev.quota`（连同 observed_at，诚实沿用上次测量）。
- WallHit（撞墙历史）：原 `if (rec.quota_reached)` 改为 `if (rec.quota?.limit_reached)`；`type` 用 `"rate_limit_reached"`（单一周窗，不再区分 primary/secondary）。`WallHit` 去重键不变（name+at+type）。

### 6. `server/src/stats.ts` 按人取最新 quota

- 删原 `quota_primary_pct` 等聚合。
- 按人聚合时：取该人 `quota.observed_at` 最大的记录的 `quota`，作为该用户当前额度（plan_type/used_percent/limit_reached/reset_at/observed_at）。无则留空。

### 7. 测试更新

- `merge.test.ts`、`store.test.ts`、`stats.test.ts`、`rebuild.test.ts`：把 `quota_reached: "primary"` 改成 `quota: { limit_reached: true, observed_at: ... }`；`quota_primary_pct: 95` 改成 `quota: { used_percent: 95, observed_at: ... }`。断言相应调整。

## 隐私

- 只取额度数值；email/user_id/account_id 绝不进记录、不上传。
- 删营销字段（upsell/promo）。

## 验证

1. `node -c` 全部新/改文件。
2. `node -e 'require("./plugin/agent/quota.cjs").fetchCodexQuota().then(console.log)'` 实测 wham，看返回 5 字段（reset_at 是 ISO）。
3. 临时 HOME + 真实 codex rollout 跑 `reconcile --only codex`，看 spool 里 Codex 记录带 `quota`、Claude 记录不带。
4. wham 失败模拟（断网/坏 token）→ 记录无 `quota`、采集不中断。
5. 服务端 `npm test` 全过（53→更新后仍全过）。
6. 粘性合并：连续两条记录（带 quota / 不带 quota）mergeInto 后保留前者 quota。

## 风险

1. **wham 是非公开接口**：可能变/被 Cloudflare 挑战。低频（1h）+ 失败回退 + 粘性兜底。
2. **token 过期**：v1 不刷新；依赖 Codex 自身续 token。过期→null→粘性沿用，不阻塞。
3. **WallHit 语义变化**：type 从 primary/secondary 统一为 rate_limit_reached（只有一个周窗）。可接受。
4. **多账号**：每台机器用自己的 token 查自己的额度，天然隔离。

## 决策记录

- **为什么贴全部 Codex 记录而非挑一条**：账户级数据无"唯一归属 session"；贴全部让看板取最新 observed_at 即可，且粘性下更稳。
- **为什么删 rollout rate_limits**：双源会乱序（旧值/空值覆盖新值）；wham 是唯一权威源。
- **为什么只 5 字段、扁平**：用户要求只保留 7 天额度一个；去掉嵌套窗口和无关字段，最小可用。
- **为什么不做 token 刷新**：复杂且有失效风险；Codex 自身保持 auth.json 新鲜，v1 够用。
