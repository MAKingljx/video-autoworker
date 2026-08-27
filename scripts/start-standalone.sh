#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
STANDALONE_ROOT="$PROJECT_ROOT/.next/standalone"
SOURCE_STATIC_DIR="$PROJECT_ROOT/.next/static"
SOURCE_PUBLIC_DIR="$PROJECT_ROOT/public"

# A standalone server can be restarted directly without deploy-standalone.sh.
# Load repository settings first, then the administrator-owned platform
# environment. The latter is the canonical source for shared n8n/model
# credentials and must win over stale checkout-local values when a release is
# started outside the repository root.
load_runtime_env_file() {
  local env_file="$1"
  [[ -f "$env_file" ]] || return 0

  if [[ "$env_file" == "$PLATFORM_ENV_FILE" ]]; then
    if [[ -L "$env_file" || ! -f "$env_file" || ! -O "$env_file" ]]; then
      printf '拒绝加载不安全的平台环境文件：%s\n' "$env_file" >&2
      exit 1
    fi
    local mode group_digit other_digit
    mode="$(stat -f '%Lp' "$env_file" 2>/dev/null || stat -c '%a' "$env_file")"
    group_digit="${mode: -2:1}"
    other_digit="${mode: -1}"
    if (( (10#$group_digit & 2) != 0 || (10#$other_digit & 2) != 0 )); then
      printf '平台环境文件不能允许组或其他用户写入：%s（mode=%s）\n' "$env_file" "$mode" >&2
      exit 1
    fi
  fi

  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  set +a
}

PLATFORM_ENV_FILE="${AIWORKER_PLATFORM_ENV_FILE:-$HOME/.config/video-autoworker/platform.env}"

load_runtime_env() {
  load_runtime_env_file "$PROJECT_ROOT/.env"
  load_runtime_env_file "$PROJECT_ROOT/.env.local"
  load_runtime_env_file "$PLATFORM_ENV_FILE"
}

load_runtime_env

# The production console and all three OpenClaw gateways run on the same
# managed Mac. Default its profile commands to the local binary so a stale
# hostname or SSH route cannot turn a healthy gateway into a dashboard error.
configure_openclaw_profile_target() {
  if [[ -z "${MC_OPENCLAW_PROFILE_TARGET:-}" \
    && "$(id -un 2>/dev/null || true)" == "heisenbergs-1" \
    && -x "$HOME/ai-worker/bin/openclaw" ]]; then
    export MC_OPENCLAW_PROFILE_TARGET="local"
  fi

  if [[ "${MC_OPENCLAW_PROFILE_TARGET:-}" == "local" ]]; then
    export OPENCLAW_BIN="${OPENCLAW_BIN:-$HOME/ai-worker/bin/openclaw}"
  fi
}

configure_openclaw_profile_target

find_standalone_server() {
  if [[ -f "$STANDALONE_ROOT/server.js" ]]; then
    printf '%s\n' "$STANDALONE_ROOT/server.js"
    return 0
  fi

  if [[ ! -d "$STANDALONE_ROOT" ]]; then
    return 0
  fi

  find "$STANDALONE_ROOT" \
    -path '*/node_modules/*' -prune -o \
    -type f -name server.js -print -quit 2>/dev/null
}

STANDALONE_SERVER="$(find_standalone_server)"

if [[ -z "$STANDALONE_SERVER" || ! -f "$STANDALONE_SERVER" ]]; then
  echo "error: standalone server missing under $STANDALONE_ROOT" >&2
  echo "run 'pnpm build' first" >&2
  exit 1
fi

STANDALONE_DIR="$(cd "$(dirname "$STANDALONE_SERVER")" && pwd)"
STANDALONE_NEXT_DIR="$STANDALONE_DIR/.next"
STANDALONE_STATIC_DIR="$STANDALONE_NEXT_DIR/static"
STANDALONE_PUBLIC_DIR="$STANDALONE_DIR/public"

mkdir -p "$STANDALONE_NEXT_DIR"

if [[ -d "$SOURCE_STATIC_DIR" ]]; then
  rm -rf "$STANDALONE_STATIC_DIR"
  cp -R "$SOURCE_STATIC_DIR" "$STANDALONE_STATIC_DIR"
fi

if [[ -d "$SOURCE_PUBLIC_DIR" ]]; then
  rm -rf "$STANDALONE_PUBLIC_DIR"
  cp -R "$SOURCE_PUBLIC_DIR" "$STANDALONE_PUBLIC_DIR"
fi

cd "$STANDALONE_DIR"
# Next.js standalone server reads HOSTNAME to decide bind address.
# Bash auto-populates HOSTNAME with the machine name, so prefer MC_HOSTNAME
# and otherwise fall back to loopback for standalone deployments. The local
# desktop auth boundary intentionally depends on the request remaining local.
machine_hostname="$(hostname 2>/dev/null || true)"
if [[ -n "${MC_HOSTNAME:-}" ]]; then
  export HOSTNAME="$MC_HOSTNAME"
elif [[ -z "${HOSTNAME:-}" || "$HOSTNAME" == "$machine_hostname" ]]; then
  export HOSTNAME="127.0.0.1"
fi
exec "${NODE_BIN:-node}" server.js
