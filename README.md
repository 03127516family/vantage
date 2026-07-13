# Vantage

> 团队 AI 编程助手使用情况的制高点视野 — by dgcrane

自动采集团队 **Claude Code** 与 **Codex** 的使用情况（用量 + 内容摘要），帮助管理者一览「谁在用、用得多不多、够不够用」。

以 **Claude Code 插件**分发：员工装上插件、跑一次 `/vantage:setup` 填身份，之后**全自动、零操作、无感**。

---

## 特性

- **Claude Code 插件形态** —— 员工通过内部 marketplace 一键安装，采集逻辑随 `/plugin update` 自动更新。
- **两个工具，一套管道** —— Claude Code 与 Codex 复用同一套采集/缓冲/上传/去重逻辑，只有会话解析器不同。
- **自动触发，员工无感** —— 钩子只写本地队列、瞬间返回，绝不阻塞员工；任何异常都咽下、永不干扰。
- **可靠同步，不丢不重** —— 本地 spool 队列 + 原子写 + 重试，断网/关机不丢；按 `session_id` 去重（upsert），重复触发/重试/对账都不重复计数。
- **升级安全** —— Codex 触发只依赖自装的登录触发器，不碰 Codex 配置；会话解析全部容错，格式变动只少抓字段、不崩。
- **零常驻、零轮询** —— Claude 靠插件钩子，Codex 靠登录触发，均事件驱动。

---

## 架构与数据流

```
  员工机器                                            dgcrane 后端
  ┌───────────────────────────────────────┐        ┌──────────────────────┐
  │  [Vantage 插件] Claude Code             │        │                      │
  │    ├ SessionEnd 钩子 → capture ─┐       │  POST  │  /ingest (鉴权)       │
  │    └ SessionStart 钩子 → reconcile┤─►采集─┼──────► │   └─ upsert(session)  │
  │  [登录触发器] Codex → reconcile ─┘  ▼    │  重试  │  JSONL 存储           │
  │                          本地 spool 队列 │◄─────┐ │  /stats (鉴权)/health │
  │                          state.json 记账 │      │ └──────────────────────┘
  │                            flush（重试/死信/超龄）┘
  └───────────────────────────────────────┘
```

- **采集**：钩子/对账解析会话 → 生成用量+摘要 → 原子写本地 `spool`，`state.json` 记账。
- **上传**：`flush` 读 `spool` → 带重试 POST → 成功即删；失败留着补传，永久失败/超龄进 `dead`。
- **去重**：后端按 `session_id` 覆盖更新，重复上传无害、绝不重复计数。

---

## 目录结构

```
vantage/
├── .claude-plugin/
│   └── marketplace.json          # 内部 marketplace 清单（列出 vantage 插件）
├── plugin/                       # ← Claude Code 插件本体
│   ├── .claude-plugin/plugin.json
│   ├── hooks/hooks.json          #   自带钩子：SessionEnd→capture、SessionStart→reconcile
│   ├── skills/setup/SKILL.md     #   /vantage:setup 命令
│   ├── setup.cjs                 #   跨平台 setup：写配置 + 同步 agent + 装 Codex 触发器
│   ├── vantage.defaults.json     #   管理员预置后端地址/密钥（员工无需填）
│   └── agent/                    #   采集脚本（零依赖纯 Node）
│       ├── core.cjs              #     共享核心：配置/原子写/spool/state/HTTP/脱敏/进程
│       ├── parsers/{claude-code,codex}.cjs
│       ├── capture.cjs           #     SessionEnd 采当前会话
│       ├── reconcile.cjs         #     SessionStart 兜底对账 / Codex 登录触发
│       └── flush.cjs             #     上传器：重试/死信/超龄/原子并发锁
├── tests/                        # 自包含端到端测试
│   ├── run-tests.sh · qserver.cjs · fixtures/
└── server/                       # dgcrane 自建后端（Node/TS）
    ├── src/{index,store}.ts      #   /ingest /stats /health（均鉴权）+ JSONL upsert
    └── data/                     #   usage.jsonl（运行时生成）
```

---

## 采集了什么

| 类别 | 字段 |
|---|---|
| 身份 | 姓名、邮箱、部门、主机名（setup 时填一次） |
| 会话 | 工具、session_id、项目路径、开始/结束时间、时长 |
| 用量 | 用户消息数、助手消息数、工具调用数、输入/输出/合计 token |
| 内容 | 摘要（Claude 优先取 AI 标题，否则首句提问；Codex 取首句提问）、首句提问（截断） |

**隐私**：只存摘要与首句提问，不存完整对话；均经脱敏（邮箱/密钥/JWT/URL 凭据/长 token 串）与截断。上线前请依据当地法规**告知员工**。

---

## 部署与安装

### 1. 部署后端（dgcrane 一次）

```bash
cd server && npm install
INGEST_TOKEN="<专属密钥>" PORT=3000 npm start
```

正式部署放到内网可达地址（如 `https://vantage.dgcrane.com`），设置专属 `INGEST_TOKEN`。

### 2. 管理员预置插件（一次）

编辑 `plugin/vantage.defaults.json`，把后端地址与上传密钥填进去（员工便无需填写）：

```json
{ "server_url": "https://vantage.dgcrane.com", "token": "<专属密钥>" }
```

把仓库推到内部 git（作为 marketplace）。

### 3. 员工安装（跑一次，全在 Claude Code 里）

```
/plugin marketplace add 03127516family/vantage   # 指向源仓库（owner/repo）
/plugin install vantage@dgcrane
/reload-plugins                                  # 刷新斜杠命令索引（v2.1.98+ 装完即可用，老版本重启一次）
/vantage:setup                                   # 按提示填 姓名 / 邮箱 / 部门
```

`/vantage:setup` 会写好配置、同步采集脚本到稳定副本、安装 Codex 登录触发器。之后员工**无需任何操作**。

### 4. 查看数据

```bash
curl -s -H "Authorization: Bearer <密钥>" http://localhost:3000/stats
```

---

## 触发与同步机制

| 工具 | 采集触发 | 兜底 |
|---|---|---|
| **Claude Code** | 插件自带 `SessionEnd` 钩子：会话结束即采当前 | 插件自带 `SessionStart` 钩子：开新会话时对账历史、补没同步的（跳过当前） |
| **Codex** | 登录触发器（LaunchAgent / systemd / 计划任务）：登录时对账 `~/.codex/sessions` | 与 SessionStart 对账共享同一套逻辑 |

- **无感**：钩子只写本地 spool 瞬间返回，上传由分离进程异步完成。
- **不漏**：正常退出即时采；异常关闭由下次「开会话 / 登录」对账补上（`state.json` 按 `size+mtime` 只补变化过的）。
- **不重**：每次上传是该会话的完整快照，后端 upsert 只保留最新。
- **可靠**：spool 是重试队列，传成功才删；断网/维护时留本地，下次触发补传。
- **升级安全**：Claude 钩子跑插件内脚本（随插件更新）；Codex 触发器跑 `~/.vantage/agent/` 稳定副本，`reconcile` 每次会把插件版同步过去——Codex 怎么升级都不失效。

**Codex 为何不用 `notify`**：其 `notify` 单槽位且常被自身占用，改写会破坏、升级会重置。改用自己的登录触发器，完全不碰 Codex 配置。

---

## 配置项

**员工机器** `~/.vantage/config.json`（setup 以 0600 权限生成）

```json
{ "name": "张三", "email": "zhangsan@dgcrane.com", "department": "研发部",
  "server_url": "https://vantage.dgcrane.com", "token": "<密钥>" }
```

**环境变量（调优，均有默认值）**

| 变量 | 默认 | 说明 |
|---|---|---|
| `VANTAGE_RECENT_DAYS` | 7 | 对账只回看最近 N 天，避免首装灌全部历史 |
| `VANTAGE_RETENTION_DAYS` | 14 | 死信/损坏文件保留天数 |
| `VANTAGE_SPOOL_MAX_AGE_DAYS` | 7 | spool 超此时长仍失败则进死信 |
| `VANTAGE_SKIP_TRIGGER` | 0 | setup 时跳过 Codex 触发器（测试用） |

**后端**：`INGEST_TOKEN`、`PORT`、`VANTAGE_DATA_DIR`（数据目录）。

---

## 运维

- **看积压**：`~/.vantage/spool/` 空 = 都传上去了；非空 = 待补传（下次触发自动重试）。
- **日志**：`~/.vantage/agent.log`（自动滚动，超 1MB 留一份 `.log.1`）。
- **死信**：`~/.vantage/dead/`（永久失败/超龄，保留期后自动清）。
- **卸载**：`/plugin uninstall vantage@dgcrane`；卸载 Codex 触发器
  （mac：`launchctl bootout gui/$(id -u)/com.dgcrane.vantage.codex`；
  win：`Unregister-ScheduledTask VantageCodexReconcile`；
  linux：`systemctl --user disable --now vantage-codex.service`）；删 `~/.vantage/`。

---

## 测试

```bash
bash tests/run-tests.sh   # 自包含：临时沙箱 + 隔离后端 + 合成样本，不污染真实环境
```

---

## 已知边界

- **纯 Codex、且从不重启/登录的机器**：会话到下次登录才同步（不丢，只延迟）。
- **会话异常结束后员工再也不开该工具**：该次可能采不到（已确认可接受）。
- **共享 token 信任模型**：所有员工用同一上传密钥，理论上可伪造他人记录；内部可信环境下可接受，如需强隔离应改为按人分发 token 并在服务端绑定身份。
- **会话文件格式**为各工具内部实现，可能随版本变化；解析器容错，变动只影响个别字段的抓取精度，不影响触发与同步。
