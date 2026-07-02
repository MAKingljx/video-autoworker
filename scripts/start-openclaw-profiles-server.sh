#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

PORT="${PORT:-3017}"
URL="http://127.0.0.1:${PORT}/profiles"
AUTH_URL="http://127.0.0.1:${PORT}/api/auth/me"

export PORT
export MC_DESKTOP_MODE="${MC_DESKTOP_MODE:-1}"
export MC_OPENCLAW_PROFILES_NO_AUTH="${MC_OPENCLAW_PROFILES_NO_AUTH:-1}"
export MC_DISABLE_RATE_LIMIT="${MC_DISABLE_RATE_LIMIT:-1}"
export NEXT_PUBLIC_OPENCLAW_PROFILES_DESKTOP="${NEXT_PUBLIC_OPENCLAW_PROFILES_DESKTOP:-1}"
export NEXT_TELEMETRY_DISABLED="${NEXT_TELEMETRY_DISABLED:-1}"
export MISSION_CONTROL_DATA_DIR="${MISSION_CONTROL_DATA_DIR:-$HOME/.mission-control-openclaw-profiles}"
export MISSION_CONTROL_DB_PATH="${MISSION_CONTROL_DB_PATH:-$MISSION_CONTROL_DATA_DIR/mission-control.db}"
export MISSION_CONTROL_TOKENS_PATH="${MISSION_CONTROL_TOKENS_PATH:-$MISSION_CONTROL_DATA_DIR/mission-control-tokens.json}"

mkdir -p "$MISSION_CONTROL_DATA_DIR"

find_pnpm() {
  if [[ -n "${PNPM_BIN:-}" && -x "${PNPM_BIN:-}" ]]; then
    printf '%s\n' "$PNPM_BIN"
    return 0
  fi

  for candidate in \
    "$HOME/.local/node-v22/bin/pnpm" \
    "$HOME/.local/bin/pnpm" \
    "/opt/homebrew/bin/pnpm" \
    "/usr/local/bin/pnpm"
  do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  command -v pnpm 2>/dev/null || true
}

PNPM_BIN="$(find_pnpm)"

find_node() {
  if [[ -n "${NODE_BIN:-}" && -x "${NODE_BIN:-}" ]]; then
    printf '%s\n' "$NODE_BIN"
    return 0
  fi

  if [[ -n "$PNPM_BIN" && -x "$(dirname "$PNPM_BIN")/node" ]]; then
    printf '%s\n' "$(dirname "$PNPM_BIN")/node"
    return 0
  fi

  for candidate in \
    "$HOME/.local/node-v22/bin/node" \
    "$HOME/.local/bin/node" \
    "/opt/homebrew/bin/node" \
    "/usr/local/bin/node"
  do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  command -v node 2>/dev/null || true
}

NODE_BIN="$(find_node)"

configure_profile_command_target() {
  if [[ -z "${MC_OPENCLAW_PROFILE_TARGET:-}" ]]; then
    if [[ "$(id -un 2>/dev/null || true)" == "heisenbergs-1" && -x "$HOME/ai-worker/bin/openclaw" ]]; then
      export MC_OPENCLAW_PROFILE_TARGET="local"
    else
      export MC_OPENCLAW_PROFILE_TARGET="ssh"
    fi
  fi

  if [[ "${MC_OPENCLAW_PROFILE_TARGET:-}" == "local" ]]; then
    export OPENCLAW_BIN="${OPENCLAW_BIN:-$HOME/ai-worker/bin/openclaw}"
    export MC_OPENCLAW_REMOTE_NODE="${MC_OPENCLAW_REMOTE_NODE:-${NODE_BIN:-node}}"
  fi
}

configure_profile_command_target

run_pnpm() {
  if [[ -n "$PNPM_BIN" ]]; then
    "$PNPM_BIN" "$@"
    return
  fi
  if command -v corepack >/dev/null 2>&1; then
    corepack pnpm "$@"
    return
  fi
  printf 'pnpm was not found. Install pnpm or set PNPM_BIN before running this launcher.\n' >&2
  exit 127
}

find_standalone_server() {
  local standalone_root="$APP_DIR/.next/standalone"

  if [[ -f "$standalone_root/server.js" ]]; then
    printf '%s\n' "$standalone_root/server.js"
    return 0
  fi

  if [[ ! -d "$standalone_root" ]]; then
    return 0
  fi

  find "$standalone_root" \
    -path '*/node_modules/*' -prune -o \
    -type f -name server.js -print -quit 2>/dev/null
}

build_production_bundle_if_needed() {
  if [[ "${MC_OPENCLAW_PROFILES_DEV:-0}" == "1" ]]; then
    return
  fi

  if [[ "${MC_OPENCLAW_PROFILES_REBUILD:-0}" != "1" && -n "$(find_standalone_server)" ]]; then
    return
  fi

  local build_data_dir="$APP_DIR/.next/build-runtime"
  mkdir -p "$build_data_dir"

  printf '正在准备 OpenClaw 配置档生产构建...\n'
  (
    export MISSION_CONTROL_DATA_DIR="$build_data_dir"
    export MISSION_CONTROL_DB_PATH="$build_data_dir/mission-control.db"
    export MISSION_CONTROL_TOKENS_PATH="$build_data_dir/mission-control-tokens.json"
    run_pnpm build
  )
}

ensure_root_better_sqlite3_native() {
  local node_bin="${NODE_BIN:-node}"

  if "$node_bin" -e "const Database = require('better-sqlite3'); const db = new Database(':memory:'); db.close();" >/dev/null 2>&1; then
    return
  fi

  printf '正在为 %s 重建 better-sqlite3...\n' "$("$node_bin" -v 2>/dev/null || printf '当前 Node')"
  PATH="$(dirname "$node_bin"):$PATH" npm_config_build_from_source=true run_pnpm rebuild better-sqlite3
}

sync_better_sqlite3_native() {
  local standalone_server standalone_dir source_native target_pkg

  standalone_server="$(find_standalone_server)"
  if [[ -z "$standalone_server" ]]; then
    return
  fi

  ensure_root_better_sqlite3_native

  source_native="$APP_DIR/node_modules/.pnpm/better-sqlite3@12.6.2/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
  if [[ ! -f "$source_native" ]]; then
    printf '未找到 better-sqlite3 原生绑定：%s\n' "$source_native" >&2
    exit 1
  fi

  standalone_dir="$(cd "$(dirname "$standalone_server")" && pwd)"
  target_pkg="$(find "$standalone_dir/node_modules/.pnpm" -path '*/node_modules/better-sqlite3' -type d -print -quit 2>/dev/null || true)"
  if [[ -z "$target_pkg" ]]; then
    printf '未在 standalone 目录下找到 better-sqlite3 包：%s\n' "$standalone_dir/node_modules/.pnpm" >&2
    exit 1
  fi

  mkdir -p "$target_pkg/build/Release"
  cp "$source_native" "$target_pkg/build/Release/better_sqlite3.node"
}

start_profiles_server() {
  if [[ "${MC_OPENCLAW_PROFILES_DEV:-0}" == "1" ]]; then
    printf '正在以开发模式启动 OpenClaw 配置档控制台：%s\n' "$URL"
    run_pnpm dev
    return
  fi

  build_production_bundle_if_needed
  sync_better_sqlite3_native

  printf '正在启动 OpenClaw 配置档生产服务：%s\n' "$URL"
  NODE_BIN="$NODE_BIN" MC_HOSTNAME="${MC_HOSTNAME:-127.0.0.1}" bash "$APP_DIR/scripts/start-standalone.sh"
}

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  if curl -fsS -H "Referer: ${URL}" "$AUTH_URL" >/dev/null 2>&1; then
    printf 'OpenClaw 配置档服务已在运行：%s\n' "$URL"
    exit 0
  fi

  printf '端口 %s 已被其他非 OpenClaw 配置档桌面模式服务占用。\n' "$PORT" >&2
  exit 1
fi

start_profiles_server &
SERVER_PID=$!

cleanup() {
  if kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup INT TERM EXIT

wait "$SERVER_PID"
