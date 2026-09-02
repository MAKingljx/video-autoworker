#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLATFORM_ENV_FILE="${AIWORKER_PLATFORM_ENV_FILE:-$HOME/.config/video-autoworker/platform.env}"
TEMPLATE="$APP_DIR/ops/platform/.env.example"

if [[ ! -f "$TEMPLATE" ]]; then
  printf '未找到平台环境模板：%s\n' "$TEMPLATE" >&2
  exit 1
fi
if [[ -e "$PLATFORM_ENV_FILE" && ( -L "$PLATFORM_ENV_FILE" || ! -f "$PLATFORM_ENV_FILE" || ! -O "$PLATFORM_ENV_FILE" ) ]]; then
  printf '拒绝修改不安全的平台环境文件：%s\n' "$PLATFORM_ENV_FILE" >&2
  exit 1
fi

umask 077
install -d -m 700 "$(dirname "$PLATFORM_ENV_FILE")"
if [[ -f "$PLATFORM_ENV_FILE" ]]; then
  source_file="$PLATFORM_ENV_FILE"
else
  source_file="$TEMPLATE"
fi

env_tmp="$(mktemp "${PLATFORM_ENV_FILE}.tmp.XXXXXX")"
cleanup() {
  rm -f "$env_tmp"
}
trap cleanup EXIT

awk '!/^[[:space:]]*(export[[:space:]]+)?N8N_WEBHOOK_SECRET[[:space:]]*=/' "$source_file" > "$env_tmp"

install -m 600 "$env_tmp" "$PLATFORM_ENV_FILE"
printf '平台外部环境已就绪：%s（内部任务链仅使用本机回环通道）\n' "$PLATFORM_ENV_FILE"
