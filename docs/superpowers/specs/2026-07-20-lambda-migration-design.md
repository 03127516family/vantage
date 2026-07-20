# Vantage Lambda 迁移设计(S3-only)

日期:2026-07-20
状态:已与用户逐节对齐,待实现

## 1. 背景与目标

`server/` 是本地测试壳,生产目标是 AWS Lambda(cn-north-1,aws-cn 分区)。本设计把后端迁移到 Lambda,约束(均为用户明确要求):

- **只用 S3,不用 DynamoDB**。S3 是唯一账本(append-only 事件日志);看板读的是账本算出的视图。
- **不设计定时器**。重建(算账)的触发节奏归用户自理(EventBridge 任意频率、手动 invoke、或任何能调 Lambda 的方式),代码提供触发方式无关的重建入口;无定时器时 /stats 在读时自动增量追平,系统自洽。
- 三个核心业务问题不变:(a) 当前 Codex 额度;(b) 今天/本周是否撞墙(窗口刷新后也要记得);(c) token 总数不重复计数。
- 现有 Node 壳保留,继续作为本地开发/测试壳;其 27 个单测 + T1-T32 E2E 是共享逻辑抽取的回归保证。

## 2. 架构总览

```
【落账】员工采集器 → POST <Function URL>/ingest (Bearer)
  → Lambda:校验 token + 复查脱敏 + 盖服务端信封(event_id/received_at)
  → 同步 PUT s3://lrm-s3-store/vantage-prod/events/dt=YYYY-MM-DD/<ts>_<event_id>_<tool>.json
  → 200(失败 502,采集端下轮重传,会话快照语义天然幂等)

【算账】任意触发(用户自配的定时器 / 手动 invoke / 或 /stats 读时)
  → Lambda rebuild:读水位线 → LIST 新事件 → GET 并逐条合并 → buildStats → 写回 state 三文件

【读答案】前端看板 → GET <Function URL>/stats (Bearer)
  → Lambda:先跑一遍增量 rebuild(通常 <1s)→ 读 stats-view.json 原样返回
```

核心概念(已与用户对齐):

- `events/` = 银行流水,终极事实,只增不删;一事件一文件(S3 没有追加操作,小文件即"日志"的标准实现,无锁、并发安全、崩溃安全)。
- `state/` = 算好的答案(存折余额),从 events 推导,**整体删掉也不丢数据**,下次重建自动恢复。
- 水位线(watermark)= 书签,记录上次算到哪个 key;S3 key 字典序即时间序,`LIST StartAfter=水位线` 一次拿到全部新事件,触发器停摆多久都不丢。
- 合并/聚合零新业务代码:全部复用现有 store.ts 合并规则与 buildStats。

AWS 资源:1 个 Lambda(nodejs20.x)+ 1 个 IAM 执行角色(挂 S3 最小权限策略,不用 Access Key)+ 1 个 Function URL。定时触发器用户自配,不在交付清单。无 DynamoDB、无 API Gateway、无 VPC。

## 3. 数据布局(S3 桶 lrm-s3-store,前缀 vantage-prod/)

```
vantage-prod/events/dt=YYYY-MM-DD/<紧凑时间>_<event_id>_<tool>.json   ← 事件,只增不删,格式与现状一致
vantage-prod/state/index.jsonl      ← 合并索引:每个 dedupe_key 一行最新快照(仅 rebuild 读写)
vantage-prod/state/wallhits.json    ← 撞墙历史数组 [{name,at,type}](量小,仅 rebuild 读写)
vantage-prod/state/stats-view.json  ← buildStats 输出 + { watermark, rebuilt_at }(/stats 唯一要读的文件)
```

- /stats 只读 stats-view(小文件,<1MB),与事件总量无关。
- index.jsonl 随时间增长(重度使用一年约几十 MB),只有后台 rebuild 碰它。
- watermark 存于 stats-view.json 内。

## 4. 共享逻辑抽取(Lambda 与 Node 壳共用)

| 新共享模块 | 内容 | 来源 |
|---|---|---|
| `server/src/merge.ts` | `MergeState{index,wallHits,wallHitKeys}` / `createMergeState()` / `mergeInto(state,rec)` / `effectiveTs` / `keyOf` / `dayKeyLocal` | 从 `store.ts` 抽出;`store.ts` 改为持有模块级 MergeState 并委托,对外接口(`upsert/allSessions/allWallHits/dayKeyLocal/effectiveTs/jsonlPath`)不变 |
| `server/src/stats.ts` | `buildStats(sessions, wallHits, now?)` 纯函数 | 从 `index.ts` 抽出;`index.ts` 改为调用它,行为不变 |
| `eventKey` | 移入 `merge.ts`;`archive.ts` 转引并 re-export,现有 `archive.test.ts` 不动 | 从 `archive.ts` 抽出 |

抽取完成后,现有 27 单测 + T1-T32 必须全部照绿(回归保证)。

撞墙去重:`mergeInto` 内对 wallHits 按 `(name,at,type)` 经 `wallHitKeys: Set<string>` 去重。原因:Lambda 侧水位线回退/并发重建会让同一事件被重复处理,不去重 wallhits.json 会缓慢膨胀;对 hit_wall_today/7d/last_wall_hit 语义无影响(布尔与 max)。Node 壳行为不受影响。

## 5. Lambda 函数设计

代码放 `server/lambda/`,与 `src/` 并列,直接 import 共享模块。esbuild 打包成单文件 `dist/lambda/index.js`(含 @aws-sdk/client-s3,不依赖运行时内置版本),zip 上传,handler 为 `index.handler`。npm script:`build:lambda`。

### 5.1 路由(lambda/handler.ts)

- `event.source === "aws.events"` 或 `event.action === "rebuild"` → `runRebuild()`,返回 200 + 处理统计(供定时器/手动预热)。
- Function URL 事件(payload v2.0),按 `requestContext.http.method` + `rawPath`:
  - `GET /health` → `{ok:true}`(不鉴权)
  - `POST /ingest` → 鉴权 → 见 5.2
  - `GET /stats` → 鉴权 → `runRebuild()`(增量)→ GET stats-view.json → 200 原样返回
- 响应为 Function URL 格式 `{statusCode, headers, body}`。

### 5.2 ingest(lambda/ingest.ts)

1. Bearer 校验(常量时间比较,同现状;token 取 `INGEST_TOKEN`)。
2. 解析 body(单条或数组,上限 5MB),非法 JSON → 400。
3. 逐条:`redactRecord` 复查脱敏 → 盖服务端信封(`event_id=ulid()`,`received_at=now`,覆盖客户端同名字段)→ `putObject(eventKey(rec,prefix), line)`,并发上限 10。
4. 全成 → 200 `{ok:true, accepted:n}`;任一败 → 502 `{ok:false, failed:n}`。重试会产生重复事件文件(新 event_id、同 dedupe_key),合并按 dedupe_key 折叠,无害(同现状)。

### 5.3 rebuild(lambda/rebuild.ts)——水位线增量

```
1. 并行 GET state/stats-view.json、state/index.jsonl、state/wallhits.json(404 视为空)
2. watermark = stats-view.watermark ?? ""
3. index.jsonl 逐行 mergeInto(同现有 replay);wallhits 读入 state
4. LIST <prefix>events/ StartAfter=watermark(翻页)→ 新 key 集合
5. 并发 50 GET 新事件;任何 GET 失败 → 中止,不写任何文件,水位线不动(下轮重试,不丢)
6. 逐行 mergeInto(顺序无关);JSON 损坏行跳过并计数(同现有 replay)
7. 有新事件或 stats-view 缺失:
   a. buildStats(index.values(), wallHits) → view
   b. 按序 PUT:index.jsonl(全量重写)→ wallhits.json → stats-view.json(含新 watermark + rebuilt_at)
8. 无新事件且 stats-view 存在 → 不写任何文件(本次成本≈一次 LIST)
```

关键性质:

- **水位线而非时间窗口**:触发器延迟/停摆不丢事件,恢复后自动补齐。
- **写入顺序保证 watermark 最后生效**:崩溃于三步 PUT 之间,最坏是水位线未前进 → 下轮重复处理;合并与撞墙去重均幂等,无害。
- 并发 rebuild(定时器与 /stats 撞车):结果幂等,水位线可能短暂回退 → 重复处理若干条,无害。
- 全量重放(冷启动):函数超时 900s,20 万事件量级约 2 分钟内。
- /stats 调用 rebuild 失败时:若存在旧 stats-view 则返回旧数据(rebuilt_at 使陈旧可见),否则 503。

### 5.4 stats 响应

stats-view.json 内容 = buildStats 输出 + `{watermark, rebuilt_at}`;/stats 原样返回,前端可据 rebuilt_at 显示数据年龄。

## 6. 配置与环境变量

| 变量 | 值 | 说明 |
|---|---|---|
| `VANTAGE_S3_BUCKET` | `lrm-s3-store` | |
| `VANTAGE_S3_PREFIX` | `vantage-prod` | |
| `VANTAGE_S3_REGION` | `cn-north-1` | aws-cn,SDK 自动用 .amazonaws.com.cn |
| `INGEST_TOKEN` | 专属密钥 | ingest 与 stats 共用同一 Bearer(同现状) |
| `TZ` | `Asia/Shanghai` | dayKeyLocal 判"今天"依赖本地时区;Lambda 默认 UTC,必须显式设 |

IAM:执行角色 `vantage-lambda-role`(信任 lambda.amazonaws.com),内联现有 S3 最小权限策略(PutObject/GetObject on `arn:aws-cn:s3:::lrm-s3-store/vantage-prod/*`;ListBucket on 桶 with prefix 条件),另挂 `AWSLambdaBasicExecutionRole`(CloudWatch 日志)。**Lambda 不用 Access Key**;lvhongfei 的 key 仅用于本机冒烟。

函数配置:nodejs20.x,内存 1024MB,超时 900s(全量重放兜底;ingest/stats 实际毫秒级)。

## 7. 测试策略

1. **回归**:共享逻辑抽取后,现有 27 单测 + T1-T32 全绿。
2. **Lambda 单测**(`server/lambda/*.test.ts`,假 putter/内存假 S3,不进网络):
   - merge:wallHits 按 (name,at,type) 去重。
   - ingest:401/400/单条/批量/PUT 失败 → 502;信封覆盖客户端伪造字段;脱敏被调用。
   - rebuild:增量水位线(第二轮只读新 key)、重复跑幂等(结果相同且 wallHits 不膨胀)、GET 失败不推进水位线、写入顺序(view 最后)、stats-view 缺失时全量重放。
   - stats 路由:rebuild 失败有旧 view 返回旧 view、无旧 view 503。
3. **E2E(T33+,tests/run-tests.sh,复用 fake-s3.cjs 往返;fake-s3 需支持 start-after)**:进程内构造 Function URL 事件直接调 handler:
   - T33:ingest 3 条 → rebuild → /stats 断言聚合正确。
   - T34:T28 撞墙场景在 Lambda 路径重跑(撞墙 → 刷新 → /stats 仍记得)。
   - T35:两轮 ingest+rebuild,断言第二轮 LIST 带 StartAfter。
4. **本机真实 S3 冒烟**:沿用 `npm run smoke:s3`(lvhongfei key),Lambda 上线前必过。

## 8. 部署步骤(控制台)

1. IAM 建角色 `vantage-lambda-role`,挂 S3 策略 + AWSLambdaBasicExecutionRole。
2. `npm run build:lambda` → `dist/lambda/index.js` → zip。
3. Lambda 控制台建函数(nodejs20.x),传 zip,handler `index.handler`,角色选上步,配内存/超时/环境变量(§6)。
4. 函数 → Configuration → Function URL → 创建,authType = NONE(应用层 Bearer 校验)。
5. (用户自理,可选)配触发器调重建预热:EventBridge 规则 rate 自定,target 为本函数;或任何能 invoke 的方式。
6. 员工采集端 `server_url` 切换为 Function URL,INGEST_TOKEN 不变。无历史数据需迁移(尚未上线)。

## 9. 已知边界(写进 README)

- index.jsonl 单文件随使用增长,1GB 内存约撑 2 年重度使用;到期方案:老会话(如 >14 天)折叠进 per-user 累计器,届时单独立项。
- 重试会产生重复事件文件(不同 event_id、同 dedupe_key),合并正确但占存储;量小,不处理。
- 事件文件数量随时间线性增长(每年约百万级小文件),S3 对此无感;如介意可加生命周期规则转 Glacier 或做月度压缩,均不影响热路径,需要时另议。

## 10. 成本估算

Lambda 调用(每天数千次 ingest + 看板)+ S3 存储(GB 级/年)+ 请求费(PUT 每天数千次),合计每月几块钱人民币,绝大部分落在免费额度内。
