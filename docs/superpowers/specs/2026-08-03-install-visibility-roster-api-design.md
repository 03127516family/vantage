# 安装可见性 + roster API + 分级采集 设计规范

**日期**: 2026-08-03
**版本**: 1.5.0
**关联计划**: `docs/superpowers/plans/2026-08-03-install-visibility-and-tiered-collection.md`

## 问题

Vantage 当前无法区分三类用户——已安装已使用、已安装未使用、未安装。因为插件安装/setup 时不上报,服务端只能看到产生过会话的人。同时:

1. roster 打包在插件里,来新人必须重新发版插件
2. 采集级别不可按人配置,只能全员薄采集
3. 想给某人开"完整上下文采集"必须改代码

## 设计原则

- **极简**: 安装记录只存 `name + installed_at` 两字段,部门等信息生成视图时与 roster join
- **扩展位**: schema 允许 `employee_id` 字段(当前不用),未来切工号解决重名;采集级别用 name 作 key 未来可切
- **员工无感**: 所有新 HTTP 调用 15s 超时,失败不阻塞主流程;不派生额外子进程
- **薄厚分离**: 默认 thin 采集(现有), per-user override 为 full 后主记录多带 `history` 字段

## 数据模型

### S3 键空间

```
现有:
  <prefix>events/dt=YYYY-MM-DD/...json
  <prefix>state/index.jsonl
  <prefix>state/stats-view.json
  <prefix>state/wallhits.json

新增:
  <prefix>installs/<pinyin(name)>.json    ← 每人一条安装记录
  <prefix>roster.json                     ← 公司花名册(管理员维护)
  <prefix>collect-levels.json             ← 采集级别配置(管理员维护)
```

### 文件 schema

**`<prefix>installs/<pinyin>.json`**:
```json
{ "name": "张三", "installed_at": "2026-08-03T09:15:22.131Z" }
```
- 每人一个文件,谁 setup 谁就 PUT 自己那份
- 同姓名重复 setup:服务端 merge 取**较小** `installed_at`

**`<prefix>roster.json`**:
```json
{
  "company": "德工机械",
  "generated_at": "2026-08-03",
  "people": [
    { "name": "李栋", "department": "外贸部" }
  ]
}
```
- 内容与原插件打包的 `roster.json` 一致
- 来新人 → 管理员编辑此文件 PUT 覆盖

**`<prefix>collect-levels.json`**:
```json
{
  "default": "thin",
  "overrides": { "张三": "full" }
}
```
- 缺文件/缺 overrides → 全员 thin

## API 规约

### 新增路由(全部 Bearer 鉴权,与 /ingest 同一 token)

| 路由 | 方法 | 用途 |
|------|------|------|
| `/install` | POST | 员工安装上报 |
| `/roster/check?name=X` | GET | 姓名+部门查询 |
| `/roster/nearby?name=X` | GET | 笔误候选(编辑距离≤1 + 同姓) |
| `/config?name=X` | GET | 员工采集级别(thin/full) |
| `/installs/view` | GET | 安装情况总览(按部门分组) |

### POST /install

请求:
```http
POST /install HTTP/1.1
Authorization: Bearer <token>
Content-Type: application/json

{ "name": "张三" }
```

响应:
```json
{ "ok": true, "installed_at": "2026-08-03T09:15:22.131Z" }
```

行为: 重复安装保留较小 `installed_at`;S3 PUT 失败 → 502。

### GET /roster/check

响应(在册): `{ "exists": true, "name": "张三", "department": "技术部" }`
响应(不在册): `{ "exists": false }`
roster 缺失 → 503

### GET /roster/nearby

响应: `{ "candidates": ["张山", "张小三"] }`(最多 5 个)

### GET /config

响应: `{ "name": "张三", "collect_level": "full" }`
缺文件/缺 override → thin

### GET /installs/view

响应:
```json
{
  "total_roster": 156,
  "total_installed": 89,
  "install_rate": 0.571,
  "by_department": [
    {
      "department": "外贸部",
      "total": 32,
      "installed": 25,
      "active": 18,
      "install_rate": 0.781,
      "not_installed": ["..."]
    }
  ],
  "installed_list": [
    { "name": "张三", "department": "技术部", "installed_at": "...", "active": true }
  ],
  "generated_at": "..."
}
```

## 插件改动

### setup.cjs

- 走 roster API(优先) → 本地 roster.json(兜底) → 手填部门(兜底)
- 写 config 后**后台 detached** 调 POST /install,不阻塞 setup

### core.cjs

新增:
- `getJson(cfg, path, timeoutMs)`: 通用 GET,返 JSON 或 null
- `postJsonUrl(url, token, body, timeoutMs)`: 通用 POST,返 HTTP 状态码
- `fetchCollectLevel(cfgOverride?)`: 双层缓存(进程内 + state.json)30 分钟

### capture.cjs / reconcile.cjs

按 `fetchCollectLevel()` 拿到的级别决定:
- thin: 现状
- full: 给 record 加 `history: [{role, text, timestamp}]` 字段

### parsers

- `parseClaudeHistory(path)`: 提取 user/assistant 纯文本对话
- `parseCodexHistory(path)`: 同上(Codex rollout 格式)

history 限制:
- 单会话最多 200 条,超出保留前 100 + 后 100
- 每条 text 经 `redact()` 脱敏 + `truncate(500)` 截断
- 跳过 tool_use/tool_result/thinking/空文本/state injection

### reconcile.cjs 补报 /install

每次 reconcile 启动检查 `state.__install_reported__`,未置位则补报(成功才置位)。

## 服务端实现

### 文件结构

```
server/dist/lambda/
  lambda/
    handler.js              ← 加 5 条新路由 + query 解析
    install.js              ← 新增
    roster.js               ← 新增 (含 5min 缓存)
    config.js               ← 新增 (含 5min 缓存)
    installs-view.js        ← 新增
    ingest.js / rebuild.js  ← 不动
  src/
    pinyin.js               ← 新增 (从 merge.js 抽出)
    edit-distance.js        ← 新增 (从 setup.cjs 抄来)
    merge.js                ← 改造 (用 pinyin.js)
    其他                     ← 不动
```

### 缓存策略

- `roster.json` / `collect-levels.json`: Lambda warm 实例 5 分钟模块级缓存
- `installs-view`: 不缓存,每次现算

### 错误码约定

- 400: 参数缺失/格式错
- 401: token 错
- 502: S3 PUT 失败(让插件重试)
- 503: 必要的 S3 文件缺失

## 员工无感铁律

- 所有新 HTTP 调用 15s 超时
- 网络失败不阻塞主流程(用缓存/默认值兜底)
- 不派生额外子进程(新加的 HTTP 函数都是纯 HTTP)
- 静态审计扩展: 显式断言新 HTTP 函数体内无 spawn/exec

## 测试

### 服务端: `tests/lambda.test.cjs`(新建)

内存 fake S3 + 依赖注入,测 6 个 section 共 43 条:
- pinyin/edit-distance 工具
- /install 首次/重复/缺参/鉴权/PUT 失败
- /roster/check 在册/不在册/缺参/503/缓存
- /roster/nearby 候选
- /config overrides/default/缺文件/缓存
- /installs/view 分组/安装率/active 标记

### 插件: `tests/agent.test.cjs`(扩展)

新增 section 14-19 + 11 扩展,共 30+ 条:
- getJson/postJsonUrl 基础 HTTP
- fetchCollectLevel 缓存/网络失败兜底
- parseClaudeHistory/parseCodexHistory 提取+脱敏+截断
- capture/reconcile 按级别带 history
- setup.cjs 走 API/兜底/手填三条路径
- reconcile 补报 /install
- 静态审计扩展(新 HTTP 函数无 spawn)

## 部署顺序

1. **先服务端**: 部署新 Lambda,上传 `roster.json` 到 S3。老插件不受影响。
2. **后插件**: 升版本号到 1.5.0,员工 2h 内自更新。

## 回滚

- 服务端: Lambda alias 切回旧版本即可。新加的 S3 文件不删(老 Lambda 不识别)。
- 插件: marketplace 指向旧 commit,员工 2h 内回滚。

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| roster API 挂 → 新员工无法 setup | 本地 roster.json 兜底 + 手填部门路径 |
| collect-levels.json 改坏 | 解析失败 → thin 安全默认 |
| installs/ 文件被误删 | 员工下次 reconcile 补报 |
| 并发 setup 同姓名 | PUT 覆盖写 + 服务端取较小 installed_at,幂等 |
| history 体积爆 | 200 条上限 + truncate(500) |
| roster.json 改坏 | Lambda 解析失败 → 503,插件退化本地兜底 |

## 扩展位预留

- `installs/<pinyin>.json` schema 允许 `employee_id` 字段(当前不写,代码读到不报错)
- `roster.json` `people[]` 元素允许 `employee_id` 字段(当前都为 null)
- 采集级别 `overrides` 用 name 作 key,未来可切 employee_id
- 未来切工号解决重名: 改 `toPinyin(name)` → `employee_id` 作为文件名,改动面只在 install.js 与 installs-view.js 的 join key
