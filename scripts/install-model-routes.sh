#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="$APP_DIR/ops/model-routing/model-routes.example.json"
TARGET="${AIWORKER_MODEL_ROUTES_FILE:-$HOME/.config/video-autoworker/model-routes.json}"
SYNC_RESOURCES=false

if [[ "${1:-}" == "--sync-resources" ]]; then
  SYNC_RESOURCES=true
  shift
fi
if [[ $# -ne 0 ]]; then
  printf '用法：%s [--sync-resources]\n' "$0" >&2
  exit 2
fi

if [[ ! -f "$TEMPLATE" ]]; then
  printf '未找到模型路由模板：%s\n' "$TEMPLATE" >&2
  exit 1
fi
if [[ -e "$TARGET" && ( -L "$TARGET" || ! -f "$TARGET" || ! -O "$TARGET" ) ]]; then
  printf '拒绝修改不安全的模型路由文件：%s\n' "$TARGET" >&2
  exit 1
fi

install -d -m 700 "$(dirname "$TARGET")"
if [[ -f "$TARGET" ]]; then
  if [[ "$SYNC_RESOURCES" == true ]]; then
    node "$APP_DIR/scripts/sync-model-resources.mjs" "$TEMPLATE" "$TARGET"
  else
    printf '保留现有模型路由：%s\n' "$TARGET"
  fi
else
  install -m 600 "$TEMPLATE" "$TARGET"
  printf '已安装模型路由：%s\n' "$TARGET"
fi

node -e 'const fs=require("node:fs"); const p=process.argv[1]; const v=JSON.parse(fs.readFileSync(p,"utf8")); if(v.version!==1||!Array.isArray(v.routes)||(v.resources!==undefined&&!Array.isArray(v.resources))) process.exit(2)' "$TARGET"
