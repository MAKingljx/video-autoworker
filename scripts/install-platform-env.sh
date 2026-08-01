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

find_node() {
  for candidate in \
    "${NODE_BIN:-}" \
    "$HOME/.local/node-v22/bin/node" \
    "$HOME/ai-worker/node/current/bin/node" \
    "/opt/homebrew/bin/node" \
    "/usr/local/bin/node"
  do
    if [[ -n "$candidate" && -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  command -v node 2>/dev/null || true
}

NODE_BIN="$(find_node)"
if [[ -z "$NODE_BIN" ]]; then
  printf '未找到 Node.js，无法生成共享密钥。\n' >&2
  exit 1
fi

umask 077
install -d -m 700 "$(dirname "$PLATFORM_ENV_FILE")"
if [[ -f "$PLATFORM_ENV_FILE" ]]; then
  source_file="$PLATFORM_ENV_FILE"
else
  source_file="$TEMPLATE"
fi

webhook_secret="$($NODE_BIN -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
env_tmp="$(mktemp "${PLATFORM_ENV_FILE}.tmp.XXXXXX")"
cleanup() {
  rm -f "$env_tmp"
}
trap cleanup EXIT

awk -v secret="$webhook_secret" '
  BEGIN { found = 0 }
  /^N8N_WEBHOOK_SECRET=/ {
    found = 1
    value = substr($0, index($0, "=") + 1)
    compact = value
    gsub(/[[:space:]\047\042]/, "", compact)
    if (compact == "") print "N8N_WEBHOOK_SECRET=\042" secret "\042"
    else print $0
    next
  }
  { print }
  END {
    if (!found) print "N8N_WEBHOOK_SECRET=\042" secret "\042"
  }
' "$source_file" > "$env_tmp"

install -m 600 "$env_tmp" "$PLATFORM_ENV_FILE"
printf '平台外部环境已就绪：%s（共享密钥未显示）\n' "$PLATFORM_ENV_FILE"
