#!/usr/bin/env bash
# 把 plugin/roster.json 上传到 S3 作为服务端花名册。
# 用法: ./scripts/upload-roster.sh [bucket] [prefix]
# 或设置环境变量 VANTAGE_S3_BUCKET / VANTAGE_S3_PREFIX
set -euo pipefail

BUCKET="${1:-${VANTAGE_S3_BUCKET:-}}"
PREFIX="${2:-${VANTAGE_S3_PREFIX:-}}"
if [[ -z "$BUCKET" ]]; then
  echo "用法: $0 <bucket> [prefix]" >&2
  echo "或设置环境变量 VANTAGE_S3_BUCKET / VANTAGE_S3_PREFIX" >&2
  exit 1
fi
PREFIX="${PREFIX#/}"; PREFIX="${PREFIX%/}"; [[ -n "$PREFIX" ]] && PREFIX="${PREFIX}/"

SRC="$(cd "$(dirname "$0")/.." && pwd)/plugin/roster.json"
DST="s3://${BUCKET}/${PREFIX}roster.json"
echo "上传 $SRC → $DST"
aws s3 cp "$SRC" "$DST" --content-type "application/json; charset=utf-8"
echo "✓ 完成"
