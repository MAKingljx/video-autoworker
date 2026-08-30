#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
STANDALONE_ROOT="$PROJECT_ROOT/.next/standalone"

find_source_project_root() {
  if [[ -n "${AIWORKER_SOURCE_APP_DIR:-}" ]]; then
    if [[ "$AIWORKER_SOURCE_APP_DIR" != /* || ! -f "$AIWORKER_SOURCE_APP_DIR/package.json" ]]; then
      printf 'AIWORKER_SOURCE_APP_DIR must be an absolute project directory containing package.json: %s\n' \
        "$AIWORKER_SOURCE_APP_DIR" >&2
      return 1
    fi
    (cd "$AIWORKER_SOURCE_APP_DIR" && pwd -P)
    return 0
  fi

  local candidate="$PROJECT_ROOT"
  for _ in 1 2 3 4 5; do
    if [[ -f "$candidate/package.json" && "$candidate" != "$STANDALONE_ROOT" ]]; then
      (cd "$candidate" && pwd -P)
      return 0
    fi
    candidate="$(dirname "$candidate")"
  done

  printf '%s\n' "$PROJECT_ROOT"
}

SOURCE_PROJECT_ROOT="$(find_source_project_root)"

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
  load_runtime_env_file "$SOURCE_PROJECT_ROOT/.env"
  load_runtime_env_file "$SOURCE_PROJECT_ROOT/.env.local"
  load_runtime_env_file "$PLATFORM_ENV_FILE"
}

load_runtime_env

resolve_physical_path() {
  local candidate="$1"

  "${NODE_BIN:-node}" -e '
    const fs = require("node:fs");
    const path = require("node:path");
    let cursor = path.resolve(process.argv[1]);
    const suffix = [];
    while (!fs.existsSync(cursor)) {
      const parent = path.dirname(cursor);
      if (parent === cursor) process.exit(2);
      suffix.unshift(path.basename(cursor));
      cursor = parent;
    }
    process.stdout.write(path.resolve(fs.realpathSync.native(cursor), ...suffix));
  ' "$candidate"
}

assert_runtime_path_outside_standalone() {
  local label="$1"
  local candidate="$2"
  local physical_candidate

  if [[ "$candidate" != /* ]]; then
    printf '%s must be an absolute path: %s\n' "$label" "$candidate" >&2
    exit 1
  fi

  physical_candidate="$(resolve_physical_path "$candidate")" || {
    printf 'unable to resolve physical %s: %s\n' "$label" "$candidate" >&2
    exit 1
  }

  case "$physical_candidate" in
    "$PHYSICAL_STANDALONE_ROOT"|"$PHYSICAL_STANDALONE_ROOT"/*)
      printf '%s must be outside the physical standalone root: %s -> %s\n' \
        "$label" "$candidate" "$physical_candidate" >&2
      exit 1
      ;;
  esac
}

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

STANDALONE_DIR="$(cd "$(dirname "$STANDALONE_SERVER")" && pwd -P)"
PHYSICAL_STANDALONE_ROOT="$(cd "$STANDALONE_ROOT" && pwd -P)"
STANDALONE_NEXT_DIR="$STANDALONE_DIR/.next"
STANDALONE_STATIC_DIR="$STANDALONE_NEXT_DIR/static"
STANDALONE_PUBLIC_DIR="$STANDALONE_DIR/public"

required_files=(
  "$STANDALONE_DIR/server.js"
  "$STANDALONE_NEXT_DIR/BUILD_ID"
  "$STANDALONE_DIR/runtime/schema.sql"
  "$STANDALONE_DIR/package.json"
)
required_directories=(
  "$STANDALONE_STATIC_DIR"
  "$STANDALONE_PUBLIC_DIR"
  "$STANDALONE_DIR/messages"
)

for required_file in "${required_files[@]}"; do
  if [[ ! -f "$required_file" ]]; then
    printf 'error: immutable standalone artifact is missing required file: %s\n' "$required_file" >&2
    exit 1
  fi
done

for required_directory in "${required_directories[@]}"; do
  if [[ ! -d "$required_directory" ]]; then
    printf 'error: immutable standalone artifact is missing required directory: %s\n' \
      "$required_directory" >&2
    exit 1
  fi
done

ARTIFACT_AUDIT_SCRIPT="$PROJECT_ROOT/scripts/check-standalone-artifact.mjs"
if [[ ! -f "$ARTIFACT_AUDIT_SCRIPT" ]]; then
  printf 'error: standalone artifact auditor is missing: %s\n' "$ARTIFACT_AUDIT_SCRIPT" >&2
  exit 1
fi
if ! "${NODE_BIN:-node}" "$ARTIFACT_AUDIT_SCRIPT" "$STANDALONE_DIR" >/dev/null; then
  echo 'error: standalone artifact integrity verification failed' >&2
  exit 1
fi

export MISSION_CONTROL_DATA_DIR="${MISSION_CONTROL_DATA_DIR:-$SOURCE_PROJECT_ROOT/.data}"
export MISSION_CONTROL_DB_PATH="${MISSION_CONTROL_DB_PATH:-$MISSION_CONTROL_DATA_DIR/mission-control.db}"
export MISSION_CONTROL_TOKENS_PATH="${MISSION_CONTROL_TOKENS_PATH:-$MISSION_CONTROL_DATA_DIR/mission-control-tokens.json}"
export AIWORKER_RUN_DIR="${AIWORKER_RUN_DIR:-$SOURCE_PROJECT_ROOT/.run}"
export PID_FILE="${PID_FILE:-$AIWORKER_RUN_DIR/standalone.pid}"

assert_runtime_path_outside_standalone "MISSION_CONTROL_DATA_DIR" "$MISSION_CONTROL_DATA_DIR"
assert_runtime_path_outside_standalone "MISSION_CONTROL_DB_PATH" "$MISSION_CONTROL_DB_PATH"
assert_runtime_path_outside_standalone "MISSION_CONTROL_TOKENS_PATH" "$MISSION_CONTROL_TOKENS_PATH"
assert_runtime_path_outside_standalone "PID_FILE" "$PID_FILE"

mkdir -p \
  "$MISSION_CONTROL_DATA_DIR" \
  "$(dirname "$MISSION_CONTROL_DB_PATH")" \
  "$(dirname "$MISSION_CONTROL_TOKENS_PATH")" \
  "$(dirname "$PID_FILE")"

# Re-resolve after directory creation so an existing symlink can never route a
# runtime write back into the immutable release.
assert_runtime_path_outside_standalone "MISSION_CONTROL_DATA_DIR" "$MISSION_CONTROL_DATA_DIR"
assert_runtime_path_outside_standalone "MISSION_CONTROL_DB_PATH" "$MISSION_CONTROL_DB_PATH"
assert_runtime_path_outside_standalone "MISSION_CONTROL_TOKENS_PATH" "$MISSION_CONTROL_TOKENS_PATH"
assert_runtime_path_outside_standalone "PID_FILE" "$PID_FILE"

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
