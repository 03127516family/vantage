# Vantage S3 归档部署指南

后端在写本地 `usage.jsonl` 的同时，把每次上报异步归档为 S3 不可变事件（append-only，撞墙历史永不丢）。本地 JSONL 仍是热数据，S3 是归档层。设计细节见 `docs/superpowers/specs/2026-07-17-s3-storage-design.md`。

## 1. 准备桶与前缀

两种部署方式二选一：

- **独立桶**（隔离最干净）：AWS 控制台 → S3 → Create bucket，名 `vantage-prod`。
- **已有桶 + 前缀**：直接用你现有的桶，约定一个前缀（如 `vantage-prod/`），事件写到 `<前缀>events/` 下（S3 没有真文件夹，前缀就是"文件夹"）。此时第 3 步 `VANTAGE_S3_BUCKET` 填已有桶名、`VANTAGE_S3_PREFIX` 填 `vantage-prod`。

Region 选公司就近（如新加坡 `ap-southeast-1`；中国区域见文末备注）。无论哪种方式，桶的设置：

- **Block Public Access：四项全部保持开启**（数据含 PII，必须私有）
- 默认加密：SSE-S3（默认，免费）
- **Bucket Versioning：不开**（append-only 用不到）
- 不设生命周期规则、不转存储层（数据量小，全部 Standard 最便宜）

## 2. 创建 IAM 用户

IAM → Users → Create user：名称 `vantage-archiver`，只勾选**编程访问（Access key）**，不勾控制台访问。

附加内联策略（最小权限，不给 DeleteObject）。把 `<BUCKET>` 换成你的桶名；用前缀时保留 `vantage-prod/` 那段并换成你的前缀，独立桶则把两段里的 `vantage-prod/` 去掉：

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject"],
      "Resource": "arn:aws:s3:::<BUCKET>/vantage-prod/events/*"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::<BUCKET>",
      "Condition": { "StringLike": { "s3:prefix": ["vantage-prod/events/*"] } }
    }
  ]
}
```

创建后记下 **Access Key ID** 和 **Secret Access Key**（只显示一次）。密钥只放在后端服务器上，员工机器只有 /ingest 的 Bearer token。

## 3. 服务器配置环境变量

后端服务器（192.168.20.15）上，为运行后端的环境设置：

```bash
VANTAGE_S3_BUCKET=vantage-prod          # 独立桶填 vantage-prod;已有桶填你的已有桶名
VANTAGE_S3_PREFIX=vantage-prod          # 仅"已有桶+前缀"时需要;独立桶留空或不设
VANTAGE_S3_REGION=ap-southeast-1        # 桶所在 region
AWS_ACCESS_KEY_ID=<第 2 步的 Access Key ID>
AWS_SECRET_ACCESS_KEY=<第 2 步的 Secret Access Key>
# 可选:
# VANTAGE_S3_SWEEP_INTERVAL_SEC=600       # 对账补传间隔,默认 600 秒
# VANTAGE_S3_ENDPOINT=...                 # 仅测试用,生产不要设
```

## 4. 启动并验证

```bash
cd server
npm install
npm start
```

启动日志应出现：

```text
[vantage][s3] S3 归档已启用 bucket=vantage-prod region=ap-southeast-1 对账间隔=600s
```

若出现「未配置 VANTAGE_S3_BUCKET / AWS 密钥，S3 归档停用」，检查环境变量是否生效。

冒烟验证（PUT → GET → LIST 全通）：

```bash
npm run smoke:s3
```

## 5. 灾难恢复

本地 `usage.jsonl` 或整盘丢失时：

```bash
npm run restore:s3            # 从 S3 下载全部 event -> data/usage-restored.jsonl
# 停服,用它替换 server/data/usage.jsonl,重启即可(replay 自动按 effective_ts 合并)
```

## 备注

- **归档自部署之日起生效**，历史 usage.jsonl 不回灌（如需回灌历史另议）。
- **中国区域（aws-cn)**：只需把 `VANTAGE_S3_REGION` 设为 `cn-north-1`(SDK 自动使用 `.amazonaws.com.cn` 域名），无需设置 endpoint；IAM 策略里的 `arn:aws:s3:::` 改为 `arn:aws-cn:s3:::`。
- 失败兜底：PUT 失败的事件落到 `data/s3-archive-dead.jsonl`，对账器每 10 分钟自动重试，成功后自动清除；持续失败请查后端日志 `[vantage][s3]`。
