# Vantage Lambda 部署指南(cn-north-1)

生产架构:员工采集器 → Lambda Function URL → S3(events/ 账本 + state/ 视图)。设计见 `docs/superpowers/specs/2026-07-20-lambda-migration-design.md`。桶:`lrm-s3-store`,前缀 `vantage-prod/`。

## 0. 前置:桶冒烟(必过)

```bash
cd server
VANTAGE_S3_BUCKET=lrm-s3-store VANTAGE_S3_PREFIX=vantage-prod VANTAGE_S3_REGION=cn-north-1 \
AWS_ACCESS_KEY_ID=<lvhongfei 的 AccessKeyId> AWS_SECRET_ACCESS_KEY=<Secret> \
npm run smoke:s3
```

PUT/GET/LIST 三行全绿再继续。

## 1. 建 IAM 执行角色

IAM → 角色 → 创建:信任实体 `lambda.amazonaws.com`。内联策略(与冒烟同一份):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject"],
      "Resource": "arn:aws-cn:s3:::lrm-s3-store/vantage-prod/*"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws-cn:s3:::lrm-s3-store",
      "Condition": { "StringLike": { "s3:prefix": ["vantage-prod/*"] } }
    }
  ]
}
```

另挂托管策略 `AWSLambdaBasicExecutionRole`(写 CloudWatch 日志)。角色名建议 `vantage-lambda-role`。**Lambda 用角色,不用 Access Key。**

## 2. 打包

```bash
cd server
npm install
npm run build:lambda        # -> dist/lambda/index.mjs
cd dist/lambda && zip vantage-lambda.zip index.mjs
```

## 3. 建函数

Lambda 控制台(cn-north-1)→ 创建函数:从头创作,名称 `vantage-backend`,运行时 **Node.js 22.x**(若控制台可选 24.x 更佳;**不要选 20.x**——社区 2026-04 EOL,Lambda 已停止新建;bundle 按 node20 目标打包,22/24 直接兼容无需重打),架构 x86_64。创建后:

- 代码:上传 `vantage-lambda.zip`;处理程序填 `index.handler`
- 配置 → 常规:内存 1024 MB,超时 15 分钟(900s,全量重放兜底)
- 配置 → 环境变量:

| 键 | 值 |
|---|---|
| `VANTAGE_S3_BUCKET` | `lrm-s3-store` |
| `VANTAGE_S3_PREFIX` | `vantage-prod` |
| `VANTAGE_S3_REGION` | `cn-north-1` |
| `INGEST_TOKEN` | `<专属密钥,与采集端 config 一致>` |
| `TZ` | `Asia/Shanghai` |

- 配置 → 权限:执行角色选 `vantage-lambda-role`

## 4. 开 Function URL

函数 → 配置 → 函数 URL → 创建,授权类型 **NONE**(应用层 Bearer 校验,与现状一致)。得到 `https://<id>.lambda-url.cn-north-1.on.cn/`。

验证:

```bash
curl -s https://<URL>/health                                   # {"ok":true}
curl -s -X POST https://<URL>/ingest -H "Authorization: Bearer <密钥>" \
  -H "content-type: application/json" \
  -d '{"tool":"codex","session_id":"smoke-1","dedupe_key":"codex:smoke-1","name":"冒烟","total_tokens":1}'
curl -s https://<URL>/stats -H "Authorization: Bearer <密钥>"   # users 里出现 冒烟
```

## 5. (可选,用户自理)定时预热重建

/stats 每次读都会自动增量追平,不配定时器系统也完整可用。若要看板秒开:EventBridge → 规则 → 计划(rate 自定,如 10 分钟)→ 目标 = 本 Lambda 函数。

## 6. 员工切换

采集端 `server_url` 换成函数 URL,token 不变,重跑 setup 即切换。无历史数据需迁移(切换前未上线)。

## 排障

- CloudWatch 日志组 `/aws/lambda/vantage-backend`,错误都带 stack。
- state/ 三文件可整体删除——下次 rebuild 会从 events/ 全量重建,不丢数据。
- ingest 502:S3 策略没生效,回第 1 步核对 arn(aws-cn 前缀!)与角色绑定。
