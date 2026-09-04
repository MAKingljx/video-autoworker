#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"

BRANCH="${BRANCH:-$(git -C "$PROJECT_ROOT" branch --show-current)}"
PORT="${PORT:-3000}"
if [[ -n "${MC_HOSTNAME:-}" && "$MC_HOSTNAME" != "127.0.0.1" ]]; then
  printf 'MC_HOSTNAME must remain 127.0.0.1 for OpenClaw loopback mode\n' >&2
  exit 1
fi
LISTEN_HOST="127.0.0.1"
export MC_AUTH_MODE="openclaw-loopback"
export MC_DESKTOP_MODE="0"
export MC_OPENCLAW_WORKSPACE_ID="${MC_OPENCLAW_WORKSPACE_ID:-1}"
export MC_OPENCLAW_TENANT_ID="${MC_OPENCLAW_TENANT_ID:-1}"
LOG_PATH="${LOG_PATH:-/tmp/mc.log}"
VERIFY_HOST="${VERIFY_HOST:-127.0.0.1}"
SOURCE_DATA_DIR="$PROJECT_ROOT/.data"
SOURCE_RUN_DIR="$PROJECT_ROOT/.run"
BUILD_DATA_DIR="$PROJECT_ROOT/.next/build-runtime"
NODE_VERSION_FILE="$PROJECT_ROOT/.nvmrc"
new_pid=""
deployment_verified=0
old_server_was_running=0
recovery_restored=0
RECOVERY_READY=0
RECOVERY_WORK_ROOT=""
RECOVERY_LAUNCHER=""
RECOVERY_AUDITOR=""
RECOVERY_STANDALONE_ROOT=""
RECOVERY_SERVER_SHA256=""
RECOVERY_BUILD_ID_SHA256=""
RECOVERY_DATA_DIR=""
RECOVERY_DB_PATH=""
RECOVERY_TOKENS_PATH=""

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
  local physical_standalone_root

  if [[ "$candidate" != /* ]]; then
    printf '%s must be an absolute path: %s\n' "$label" "$candidate" >&2
    exit 1
  fi

  physical_candidate="$(resolve_physical_path "$candidate")" || {
    printf 'unable to resolve physical %s: %s\n' "$label" "$candidate" >&2
    exit 1
  }
  physical_standalone_root="$(resolve_physical_path "$PROJECT_ROOT/.next/standalone")" || {
    printf 'unable to resolve physical standalone root\n' >&2
    exit 1
  }

  case "$physical_candidate" in
    "$physical_standalone_root"|"$physical_standalone_root"/*)
      printf '%s must be outside the physical standalone root: %s -> %s\n' \
        "$label" "$candidate" "$physical_candidate" >&2
      exit 1
      ;;
  esac
}

configure_runtime_paths() {
  export MISSION_CONTROL_DATA_DIR="${MISSION_CONTROL_DATA_DIR:-$SOURCE_DATA_DIR}"
  export MISSION_CONTROL_DB_PATH="${MISSION_CONTROL_DB_PATH:-$MISSION_CONTROL_DATA_DIR/mission-control.db}"
  export MISSION_CONTROL_TOKENS_PATH="${MISSION_CONTROL_TOKENS_PATH:-$MISSION_CONTROL_DATA_DIR/mission-control-tokens.json}"
  export AIWORKER_RUN_DIR="${AIWORKER_RUN_DIR:-$SOURCE_RUN_DIR}"
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

  assert_runtime_path_outside_standalone "MISSION_CONTROL_DATA_DIR" "$MISSION_CONTROL_DATA_DIR"
  assert_runtime_path_outside_standalone "MISSION_CONTROL_DB_PATH" "$MISSION_CONTROL_DB_PATH"
  assert_runtime_path_outside_standalone "MISSION_CONTROL_TOKENS_PATH" "$MISSION_CONTROL_TOKENS_PATH"
  assert_runtime_path_outside_standalone "PID_FILE" "$PID_FILE"
}

use_project_node() {
  if [[ ! -f "$NODE_VERSION_FILE" ]]; then
    return
  fi

  if [[ -z "${NVM_DIR:-}" ]]; then
    export NVM_DIR="$HOME/.nvm"
  fi

  if [[ -s "$NVM_DIR/nvm.sh" ]]; then
    # shellcheck disable=SC1090
    source "$NVM_DIR/nvm.sh"
    nvm use >/dev/null
  fi
}

list_listener_pids() {
  local combined=""

  if command -v lsof >/dev/null 2>&1; then
    combined+="$(
      lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true
    )"$'\n'
  fi

  if command -v ss >/dev/null 2>&1; then
    combined+="$(
      ss -ltnp 2>/dev/null | awk -v port=":$PORT" '
        index($4, port) || index($5, port) {
          if (match($0, /pid=[0-9]+/)) {
            print substr($0, RSTART + 4, RLENGTH - 4)
          }
        }
      '
    )"$'\n'
  fi

  printf '%s\n' "$combined" | awk -v port="$PORT" '
    /^[0-9]+$/ {
      seen[$0] = 1
    }
    END {
      for (pid in seen) {
        print pid
      }
    }
  ' | sort -u
}

stop_pid() {
  local pid="$1"
  local label="$2"

  if [[ ! "$pid" =~ ^[1-9][0-9]*$ ]] || ! kill -0 -- "$pid" 2>/dev/null; then
    return
  fi

  echo "==> stopping $label (pid=$pid)"
  kill -- "$pid" 2>/dev/null || true

  for _ in $(seq 1 10); do
    if ! kill -0 -- "$pid" 2>/dev/null; then
      return
    fi
    sleep 1
  done

  echo "==> force stopping $label (pid=$pid)"
  kill -9 -- "$pid" 2>/dev/null || true
}

cleanup_failed_new_server() {
  local exit_status=$?
  local recorded_pid=""
  trap - EXIT

  if [[ "$deployment_verified" != 1 && -n "$new_pid" ]]; then
    stop_pid "$new_pid" "failed standalone candidate"
    if [[ -f "$PID_FILE" ]]; then
      recorded_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
      if [[ "$recorded_pid" == "$new_pid" ]]; then
        rm -f "$PID_FILE" || true
      fi
    fi
  fi
  if [[ "$deployment_verified" != 1 \
    && "$old_server_was_running" == 1 \
    && "$recovery_restored" != 1 ]]; then
    if ! restart_old_server_after_migration_failure; then
      exit_status=70
    fi
  fi
  if [[ "$old_server_was_running" != 1 ]]; then
    cleanup_recovery_bundle
  elif [[ -n "$RECOVERY_WORK_ROOT" ]]; then
    echo "==> preserved recovery release at $RECOVERY_WORK_ROOT"
  fi
  exit "$exit_status"
}

valid_pid() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]]
}

process_environment_value() {
  local pid="$1"
  local key="$2"

  "${NODE_BIN:-node}" - "$pid" "$key" <<'NODE'
const fs = require('node:fs')
const { execFileSync } = require('node:child_process')

const pid = process.argv[2]
const key = process.argv[3]
let value
try {
  const entries = fs.readFileSync(`/proc/${pid}/environ`).toString('utf8').split('\0')
  const entry = entries.find((candidate) => candidate.startsWith(`${key}=`))
  if (entry !== undefined) value = entry.slice(key.length + 1)
} catch {
  const command = execFileSync('ps', ['eww', '-p', pid, '-o', 'command='], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  const marker = ` ${key}=`
  const markerIndex = command.lastIndexOf(marker)
  if (markerIndex >= 0) {
    const remainder = command.slice(markerIndex + marker.length)
    const nextEntry = remainder.search(/ [A-Za-z_][A-Za-z0-9_]*=/u)
    value = (nextEntry >= 0 ? remainder.slice(0, nextEntry) : remainder).replace(/\n+$/u, '')
  }
}
if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) process.exit(1)
process.stdout.write(value)
NODE
}

process_environment_value_is() {
  local pid="$1"
  local key="$2"
  local expected="$3"
  local actual=""
  actual="$(process_environment_value "$pid" "$key")" || return 1
  [[ "$actual" == "$expected" ]]
}

original_release_matches_recovery() {
  local original_root="$PROJECT_ROOT/.next/standalone"
  [[ "$RECOVERY_READY" == 1 \
    && -f "$original_root/server.js" \
    && -f "$original_root/.next/BUILD_ID" ]] || return 1
  [[ "$(file_sha256 "$original_root/server.js")" == "$RECOVERY_SERVER_SHA256" \
    && "$(file_sha256 "$original_root/.next/BUILD_ID")" == "$RECOVERY_BUILD_ID_SHA256" ]] \
    || return 1
  "${NODE_BIN:-node}" "$RECOVERY_AUDITOR" "$original_root" >/dev/null
}

process_is_expected_old_server() {
  local pid="$1"
  local process_uid=""
  local process_command=""

  valid_pid "$pid" || return 1
  kill -0 -- "$pid" 2>/dev/null || return 1
  process_uid="$(ps -o uid= -p "$pid" 2>/dev/null | awk 'NR == 1 { gsub(/[[:space:]]/, ""); print }')"
  [[ -n "$process_uid" && "$process_uid" == "$(id -u)" ]] || return 1
  process_command="$(ps -o command= -p "$pid" 2>/dev/null)"
  case "${process_command##* }" in
    server.js|"$PROJECT_ROOT/.next/standalone/server.js") ;;
    *) return 1 ;;
  esac
  process_executable_is_node "$pid" || return 1
  if process_cwd_is "$pid" "$PROJECT_ROOT/.next/standalone"; then
    original_release_matches_recovery
  elif process_cwd_is "$pid" "$RECOVERY_STANDALONE_ROOT"; then
    verify_recovery_release_identity
  else
    return 1
  fi
}

pid_is_listener() {
  local expected_pid="$1"
  list_listener_pids | grep -Fxq "$expected_pid"
}

capture_old_runtime_bindings() {
  local pid="$1"
  local captured_data_dir=""
  local captured_db_path=""
  local captured_tokens_path=""

  captured_data_dir="$(process_environment_value "$pid" MISSION_CONTROL_DATA_DIR)" || return 1
  captured_db_path="$(process_environment_value "$pid" MISSION_CONTROL_DB_PATH)" || return 1
  captured_tokens_path="$(process_environment_value "$pid" MISSION_CONTROL_TOKENS_PATH)" || return 1
  [[ "$captured_data_dir" == /* \
    && "$captured_db_path" == /* \
    && "$captured_tokens_path" == /* ]] || return 1
  assert_runtime_path_outside_standalone "running MISSION_CONTROL_DATA_DIR" "$captured_data_dir"
  assert_runtime_path_outside_standalone "running MISSION_CONTROL_DB_PATH" "$captured_db_path"
  assert_runtime_path_outside_standalone "running MISSION_CONTROL_TOKENS_PATH" "$captured_tokens_path"
  process_has_open_path "$pid" "$captured_db_path" || return 1

  RECOVERY_DATA_DIR="$captured_data_dir"
  RECOVERY_DB_PATH="$captured_db_path"
  RECOVERY_TOKENS_PATH="$captured_tokens_path"
}

stop_existing_server() {
  local -a candidate_pids=()
  local verified_listener_pid=""

  if [[ -f "$PID_FILE" ]]; then
    candidate_pids+=("$(cat "$PID_FILE" 2>/dev/null || true)")
  fi

  while IFS= read -r pid; do
    candidate_pids+=("$pid")
  done < <(list_listener_pids)

  if command -v pgrep >/dev/null 2>&1; then
    while IFS= read -r pid; do
      candidate_pids+=("$pid")
    done < <(pgrep -f "$PROJECT_ROOT/.next/standalone/server.js" || true)
  fi

  if [[ ${#candidate_pids[@]} -eq 0 ]]; then
    return
  fi

  for pid in "${candidate_pids[@]}"; do
    if process_is_expected_old_server "$pid" && pid_is_listener "$pid"; then
      if [[ "$old_server_was_running" == 1 ]]; then
        [[ "$pid" == "$verified_listener_pid" ]] && continue
        echo "error: refusing to deploy with multiple verified listeners on port $PORT" >&2
        exit 1
      fi
      if ! capture_old_runtime_bindings "$pid"; then
        echo "error: unable to verify the existing server runtime data bindings" >&2
        exit 1
      fi
      old_server_was_running=1
      verified_listener_pid="$pid"
    fi
  done
  if [[ "$old_server_was_running" == 1 && "$RECOVERY_READY" != 1 ]]; then
    echo "error: refusing to stop the existing server without a verified recovery release" >&2
    exit 1
  fi

  local seen_pids=""
  for pid in "${candidate_pids[@]}"; do
    [[ -z "$pid" ]] && continue
    case " $seen_pids " in
      *" $pid "*) continue ;;
    esac
    seen_pids="$seen_pids $pid"
    process_is_expected_old_server "$pid" || continue
    stop_pid "$pid" "standalone server"
  done

  for _ in $(seq 1 10); do
    if [[ -z "$(list_listener_pids | head -n1)" ]]; then
      rm -f "$PID_FILE"
      return
    fi
    sleep 1
  done

  echo "error: port $PORT is still in use after stopping existing server" >&2
  exit 1
}

write_server_pid() {
  local pid="$1"
  local pid_tmp="$PID_FILE.tmp.$$"
  printf '%s\n' "$pid" > "$pid_tmp" || return 1
  chmod 600 "$pid_tmp" || { rm -f -- "$pid_tmp" || true; return 1; }
  mv "$pid_tmp" "$PID_FILE" || { rm -f -- "$pid_tmp" || true; return 1; }
}

file_sha256() {
  shasum -a 256 "$1" | awk '{print $1}'
}

auditor_closure_is_safe() {
  local root="$1"
  [[ -d "$root" && ! -L "$root" \
    && -d "$root/lib" && ! -L "$root/lib" \
    && -f "$root/check-standalone-artifact.mjs" \
    && ! -L "$root/check-standalone-artifact.mjs" \
    && -f "$root/check-sensitive-content.mjs" \
    && ! -L "$root/check-sensitive-content.mjs" \
    && -f "$root/lib/sensitive-value-scanner.mjs" \
    && ! -L "$root/lib/sensitive-value-scanner.mjs" \
    && -f "$root/lib/director-extraction-release-provenance.mjs" \
    && ! -L "$root/lib/director-extraction-release-provenance.mjs" ]]
}

cleanup_recovery_bundle() {
  local physical_run_dir=""
  if [[ -n "$RECOVERY_WORK_ROOT" ]]; then
    physical_run_dir="$(resolve_physical_path "$AIWORKER_RUN_DIR")" || return 1
    case "$RECOVERY_WORK_ROOT" in
      "$physical_run_dir"/.deploy-recovery.*)
        rm -rf -- "$RECOVERY_WORK_ROOT" || return 1
        ;;
      *) return 1 ;;
    esac
  fi
  RECOVERY_READY=0
  RECOVERY_WORK_ROOT=""
  RECOVERY_LAUNCHER=""
  RECOVERY_AUDITOR=""
  RECOVERY_STANDALONE_ROOT=""
  RECOVERY_SERVER_SHA256=""
  RECOVERY_BUILD_ID_SHA256=""
  RECOVERY_DATA_DIR=""
  RECOVERY_DB_PATH=""
  RECOVERY_TOKENS_PATH=""
}

verify_recovery_release_identity() {
  [[ "$RECOVERY_READY" == 1 ]] || return 1
  [[ -f "$RECOVERY_STANDALONE_ROOT/server.js" \
    && -f "$RECOVERY_STANDALONE_ROOT/.next/BUILD_ID" \
    && -x "$RECOVERY_LAUNCHER" ]] || return 1
  auditor_closure_is_safe "$RECOVERY_WORK_ROOT" || return 1
  [[ "$(file_sha256 "$RECOVERY_STANDALONE_ROOT/server.js")" == "$RECOVERY_SERVER_SHA256" \
    && "$(file_sha256 "$RECOVERY_STANDALONE_ROOT/.next/BUILD_ID")" == "$RECOVERY_BUILD_ID_SHA256" ]] \
    || return 1
  "${NODE_BIN:-node}" "$RECOVERY_AUDITOR" "$RECOVERY_STANDALONE_ROOT" >/dev/null
}

adopt_running_recovery_bundle() {
  local pid=""
  local running_cwd=""
  local physical_run_dir=""
  local candidate_root=""
  local candidate_launcher=""
  local candidate_auditor=""
  local candidate_server_sha256=""
  local candidate_build_id_sha256=""

  [[ -f "$PID_FILE" ]] || return 1
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  valid_pid "$pid" || return 1
  kill -0 -- "$pid" 2>/dev/null || return 1
  physical_run_dir="$(resolve_physical_path "$AIWORKER_RUN_DIR")" || return 1
  running_cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | sed -n '1p')"
  case "$running_cwd" in
    "$physical_run_dir"/.deploy-recovery.*/standalone) ;;
    *) return 1 ;;
  esac

  candidate_root="$(dirname "$running_cwd")"
  candidate_launcher="$candidate_root/start-preserved-release.sh"
  candidate_auditor="$candidate_root/check-standalone-artifact.mjs"
  [[ -f "$running_cwd/server.js" \
    && -f "$running_cwd/.next/BUILD_ID" \
    && -x "$candidate_launcher" ]] || return 1
  auditor_closure_is_safe "$candidate_root" || return 1
  candidate_server_sha256="$(file_sha256 "$running_cwd/server.js")" || return 1
  candidate_build_id_sha256="$(file_sha256 "$running_cwd/.next/BUILD_ID")" || return 1
  "${NODE_BIN:-node}" "$candidate_auditor" "$running_cwd" >/dev/null || return 1

  RECOVERY_STANDALONE_ROOT="$running_cwd"
  RECOVERY_WORK_ROOT="$candidate_root"
  RECOVERY_LAUNCHER="$candidate_launcher"
  RECOVERY_AUDITOR="$candidate_auditor"
  RECOVERY_SERVER_SHA256="$candidate_server_sha256"
  RECOVERY_BUILD_ID_SHA256="$candidate_build_id_sha256"
  RECOVERY_READY=1
  return 0
}

prepare_existing_server_recovery() {
  local standalone_root="$PROJECT_ROOT/.next/standalone"
  local current_auditor="$PROJECT_ROOT/scripts/check-standalone-artifact.mjs"
  local current_sensitive_scanner="$PROJECT_ROOT/scripts/check-sensitive-content.mjs"
  local current_value_scanner="$PROJECT_ROOT/scripts/lib/sensitive-value-scanner.mjs"
  local current_provenance="$PROJECT_ROOT/scripts/lib/director-extraction-release-provenance.mjs"
  local created_recovery_root=""

  if command -v lsof >/dev/null 2>&1 && adopt_running_recovery_bundle; then
    return 0
  fi

  if [[ ! -f "$standalone_root/server.js" \
    || ! -f "$standalone_root/.next/BUILD_ID" ]]; then
    return 0
  fi
  auditor_closure_is_safe "$PROJECT_ROOT/scripts" || return 1

  created_recovery_root="$(mktemp -d "$AIWORKER_RUN_DIR/.deploy-recovery.XXXXXX")" || return 1
  RECOVERY_WORK_ROOT="$(cd "$created_recovery_root" && pwd -P)" \
    || { rm -rf -- "$created_recovery_root" || true; return 1; }
  chmod 700 "$RECOVERY_WORK_ROOT" || { cleanup_recovery_bundle; return 1; }
  RECOVERY_LAUNCHER="$RECOVERY_WORK_ROOT/start-preserved-release.sh"
  RECOVERY_AUDITOR="$RECOVERY_WORK_ROOT/check-standalone-artifact.mjs"
  RECOVERY_STANDALONE_ROOT="$RECOVERY_WORK_ROOT/standalone"
  cp -pR "$standalone_root" "$RECOVERY_STANDALONE_ROOT" \
    || { cleanup_recovery_bundle; return 1; }
  mkdir -m 700 "$RECOVERY_WORK_ROOT/lib" \
    || { cleanup_recovery_bundle; return 1; }
  install -m 600 "$current_auditor" "$RECOVERY_AUDITOR" \
    || { cleanup_recovery_bundle; return 1; }
  install -m 600 "$current_sensitive_scanner" "$RECOVERY_WORK_ROOT/check-sensitive-content.mjs" \
    || { cleanup_recovery_bundle; return 1; }
  install -m 600 "$current_value_scanner" "$RECOVERY_WORK_ROOT/lib/sensitive-value-scanner.mjs" \
    || { cleanup_recovery_bundle; return 1; }
  install -m 600 "$current_provenance" "$RECOVERY_WORK_ROOT/lib/director-extraction-release-provenance.mjs" \
    || { cleanup_recovery_bundle; return 1; }
  if ! printf '%s\n' \
    '#!/usr/bin/env bash' \
    'set -euo pipefail' \
    'release_root="$1"' \
    'auditor="$2"' \
    'node_bin="$3"' \
    '"$node_bin" "$auditor" "$release_root" >/dev/null' \
    'cd "$release_root"' \
    'exec "$node_bin" server.js' > "$RECOVERY_LAUNCHER"; then
    cleanup_recovery_bundle
    return 1
  fi
  chmod 700 "$RECOVERY_LAUNCHER" || { cleanup_recovery_bundle; return 1; }
  RECOVERY_SERVER_SHA256="$(file_sha256 "$RECOVERY_STANDALONE_ROOT/server.js")" \
    || { cleanup_recovery_bundle; return 1; }
  RECOVERY_BUILD_ID_SHA256="$(file_sha256 "$RECOVERY_STANDALONE_ROOT/.next/BUILD_ID")" \
    || { cleanup_recovery_bundle; return 1; }
  RECOVERY_READY=1
  if ! verify_recovery_release_identity; then
    cleanup_recovery_bundle
    return 1
  fi
}

process_has_open_path() {
  local pid="$1"
  local expected_path="$2"
  local physical_expected
  physical_expected="$(resolve_physical_path "$expected_path")" || return 1
  lsof -a -p "$pid" -Fn 2>/dev/null | sed -n 's/^n//p' | grep -Fxq "$physical_expected"
}

process_cwd_is() {
  local pid="$1"
  local expected_path="$2"
  local physical_expected
  physical_expected="$(resolve_physical_path "$expected_path")" || return 1
  lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | grep -Fxq "$physical_expected"
}

process_executable_is_node() {
  local pid="$1"
  local expected_node=""
  local physical_expected=""
  expected_node="$(command -v "${NODE_BIN:-node}")" || return 1
  physical_expected="$(resolve_physical_path "$expected_node")" || return 1
  lsof -a -p "$pid" -d txt -Fn 2>/dev/null | sed -n 's/^n//p' | grep -Fxq "$physical_expected"
}

restart_old_server_after_migration_failure() {
  if [[ "$old_server_was_running" != 1 ]]; then
    return 0
  fi
  if ! command -v lsof >/dev/null 2>&1; then
    echo "error: lsof is required to verify recovery runtime identity" >&2
    return 1
  fi
  if ! verify_recovery_release_identity; then
    echo "error: the preserved standalone release failed its pre-deploy identity or auditor check" >&2
    return 1
  fi
  if [[ -z "$RECOVERY_DATA_DIR" \
    || -z "$RECOVERY_DB_PATH" \
    || -z "$RECOVERY_TOKENS_PATH" ]]; then
    echo "error: the previous standalone runtime data bindings were not captured" >&2
    return 1
  fi

  echo "==> restarting previous standalone release with its verified runtime data bindings"
  nohup env \
    MISSION_CONTROL_DATA_DIR="$RECOVERY_DATA_DIR" \
    MISSION_CONTROL_DB_PATH="$RECOVERY_DB_PATH" \
    MISSION_CONTROL_TOKENS_PATH="$RECOVERY_TOKENS_PATH" \
    AIWORKER_RUN_DIR="$SOURCE_RUN_DIR" \
    MC_AUTH_MODE="openclaw-loopback" MC_DESKTOP_MODE="0" \
    MC_OPENCLAW_WORKSPACE_ID="$MC_OPENCLAW_WORKSPACE_ID" \
    MC_OPENCLAW_TENANT_ID="$MC_OPENCLAW_TENANT_ID" \
    PORT="$PORT" HOSTNAME="$LISTEN_HOST" \
    "$RECOVERY_LAUNCHER" "$RECOVERY_STANDALONE_ROOT" "$RECOVERY_AUDITOR" "${NODE_BIN:-node}" \
    >"$LOG_PATH" 2>&1 &
  local restored_pid=$!
  write_server_pid "$restored_pid"

  for _ in $(seq 1 20); do
    if ! kill -0 -- "$restored_pid" 2>/dev/null; then
      break
    fi
    local listener_pid=""
    listener_pid="$(list_listener_pids)"
    if curl -fsSL "http://$VERIFY_HOST:$PORT/login" >/dev/null 2>&1 \
      && [[ "$listener_pid" == "$restored_pid" ]] \
      && verify_recovery_release_identity \
      && process_executable_is_node "$restored_pid" \
      && process_cwd_is "$restored_pid" "$RECOVERY_STANDALONE_ROOT" \
      && process_environment_value_is "$restored_pid" MISSION_CONTROL_DATA_DIR "$RECOVERY_DATA_DIR" \
      && process_environment_value_is "$restored_pid" MISSION_CONTROL_DB_PATH "$RECOVERY_DB_PATH" \
      && process_environment_value_is "$restored_pid" MISSION_CONTROL_TOKENS_PATH "$RECOVERY_TOKENS_PATH" \
      && process_has_open_path "$restored_pid" "$RECOVERY_DB_PATH"; then
      echo "==> previous standalone release restored (pid=$restored_pid)"
      recovery_restored=1
      return 0
    fi
    sleep 1
  done

  stop_pid "$restored_pid" "unverified recovery server"
  rm -f "$PID_FILE" || true
  echo "error: migration failed and the previous standalone release did not become healthy; source data and release were preserved" >&2
  return 1
}

verify_new_runtime_identity() {
  local pid="$1"
  local listeners=""

  listeners="$(list_listener_pids)" || return 1
  [[ "$listeners" == "$pid" ]] || return 1
  process_executable_is_node "$pid" || return 1
  process_cwd_is "$pid" "$PROJECT_ROOT/.next/standalone" || return 1
  "${NODE_BIN:-node}" "$PROJECT_ROOT/scripts/check-standalone-artifact.mjs" \
    "$PROJECT_ROOT/.next/standalone" >/dev/null || return 1
  process_environment_value_is "$pid" MISSION_CONTROL_DATA_DIR "$MISSION_CONTROL_DATA_DIR" \
    || return 1
  process_environment_value_is "$pid" MISSION_CONTROL_DB_PATH "$MISSION_CONTROL_DB_PATH" \
    || return 1
  process_environment_value_is "$pid" MISSION_CONTROL_TOKENS_PATH "$MISSION_CONTROL_TOKENS_PATH" \
    || return 1
  process_has_open_path "$pid" "$MISSION_CONTROL_DB_PATH"
}

load_env() {
  set -a
  if [[ -f .env ]]; then
    # shellcheck disable=SC1091
    source .env
  fi
  if [[ -f .env.local ]]; then
    # shellcheck disable=SC1091
    source .env.local
  fi
  set +a
}

migrate_runtime_data_dir() {
  local target_data_dir="$MISSION_CONTROL_DATA_DIR"
  local source_db="$SOURCE_DATA_DIR/mission-control.db"
  local target_db="$MISSION_CONTROL_DB_PATH"
  local source_tokens="$SOURCE_DATA_DIR/mission-control-tokens.json"

  if [[ "$target_data_dir" == "$SOURCE_DATA_DIR" && "$target_db" == "$source_db" ]]; then
    return
  fi

  mkdir -p "$target_data_dir" || return $?

  if [[ -s "$target_db" || ! -s "$source_db" ]]; then
    return
  fi
  if [[ -e "$target_db" || -L "$target_db" ]]; then
    echo "error: refusing to replace an existing empty or unsupported target database" >&2
    return 1
  fi

  echo "==> migrating runtime data to $target_data_dir"
  local target_db_tmp="$target_db.migration.$$"
  local target_tokens_tmp="$MISSION_CONTROL_TOKENS_PATH.migration.$$"
  local target_backups="$target_data_dir/backups"
  local target_backups_tmp="$target_data_dir/.backups.migration.$$"
  local target_db_tmp_identity=""
  local move_status=0
  rm -f -- "$target_db_tmp" "$target_tokens_tmp" || return $?
  rm -rf -- "$target_backups_tmp" || return $?

  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$source_db" ".backup '$target_db_tmp'" \
      || { move_status=$?; rm -f -- "$target_db_tmp" "$target_tokens_tmp" || true; rm -rf -- "$target_backups_tmp" || true; return "$move_status"; }
  else
    if [[ -e "${source_db}-wal" || -e "${source_db}-shm" || -e "${source_db}-journal" ]]; then
      echo "error: sqlite3 is required to migrate an active SQLite database with sidecar files" >&2
      return 1
    fi
    cp -p "$source_db" "$target_db_tmp" \
      || { move_status=$?; rm -f -- "$target_db_tmp" "$target_tokens_tmp" || true; rm -rf -- "$target_backups_tmp" || true; return "$move_status"; }
  fi
  [[ -s "$target_db_tmp" ]] \
    || { rm -f -- "$target_db_tmp" "$target_tokens_tmp" || true; rm -rf -- "$target_backups_tmp" || true; return 1; }
  target_db_tmp_identity="$(stat -f '%d:%i' "$target_db_tmp" 2>/dev/null \
    || stat -c '%d:%i' "$target_db_tmp")" \
    || { rm -f -- "$target_db_tmp" "$target_tokens_tmp" || true; rm -rf -- "$target_backups_tmp" || true; return 1; }

  if [[ -f "$source_tokens" && ! -e "$MISSION_CONTROL_TOKENS_PATH" ]]; then
    cp -p "$source_tokens" "$target_tokens_tmp" \
      || { move_status=$?; rm -f -- "$target_db_tmp" "$target_tokens_tmp" || true; rm -rf -- "$target_backups_tmp" || true; return "$move_status"; }
    mv "$target_tokens_tmp" "$MISSION_CONTROL_TOKENS_PATH" \
      || { move_status=$?; rm -f -- "$target_db_tmp" "$target_tokens_tmp" || true; rm -rf -- "$target_backups_tmp" || true; return "$move_status"; }
  fi
  if [[ -d "$SOURCE_DATA_DIR/backups" && ! -e "$target_backups" ]]; then
    cp -pR "$SOURCE_DATA_DIR/backups" "$target_backups_tmp" \
      || { move_status=$?; rm -f -- "$target_db_tmp" "$target_tokens_tmp" || true; rm -rf -- "$target_backups_tmp" || true; return "$move_status"; }
    mv "$target_backups_tmp" "$target_backups" \
      || { move_status=$?; rm -f -- "$target_db_tmp" "$target_tokens_tmp" || true; rm -rf -- "$target_backups_tmp" || true; return "$move_status"; }
  fi

  mv "$target_db_tmp" "$target_db" || {
    move_status=$?
    if [[ ! -e "$target_db_tmp" && -f "$target_db" \
      && "$(stat -f '%d:%i' "$target_db" 2>/dev/null || stat -c '%d:%i' "$target_db")" == "$target_db_tmp_identity" ]]; then
      rm -f -- "$target_db" || true
    else
      rm -f -- "$target_db_tmp" || true
    fi
    return "$move_status"
  }
  return 0
}

cd "$PROJECT_ROOT"
use_project_node

load_env
configure_runtime_paths
prepare_existing_server_recovery || {
  echo "warning: unable to prepare a verified recovery release" >&2
}
trap cleanup_failed_new_server EXIT

echo "==> fetching branch $BRANCH"
git fetch origin "$BRANCH"
git merge --ff-only FETCH_HEAD

load_env
configure_runtime_paths

echo "==> stopping existing standalone server before data migration and rebuild"
stop_existing_server

if migrate_runtime_data_dir; then
  :
else
  migration_status=$?
  exit "$migration_status"
fi

echo "==> installing dependencies"
# SSH/LaunchAgent deployments have no TTY. Keep caller overrides, but make
# the default non-interactive so pnpm can safely recreate node_modules.
CI="${CI:-true}" pnpm install --frozen-lockfile

echo "==> rebuilding standalone bundle"
rm -rf .next
mkdir -p "$BUILD_DATA_DIR"
MISSION_CONTROL_DATA_DIR="$BUILD_DATA_DIR" \
MISSION_CONTROL_DB_PATH="$BUILD_DATA_DIR/mission-control.db" \
MISSION_CONTROL_TOKENS_PATH="$BUILD_DATA_DIR/mission-control-tokens.json" \
pnpm build

echo "==> starting standalone server"
load_env
configure_runtime_paths

MC_AUTH_MODE="openclaw-loopback" MC_DESKTOP_MODE="0" \
MC_OPENCLAW_WORKSPACE_ID="$MC_OPENCLAW_WORKSPACE_ID" \
MC_OPENCLAW_TENANT_ID="$MC_OPENCLAW_TENANT_ID" \
PORT="$PORT" HOSTNAME="$LISTEN_HOST" nohup bash "$PROJECT_ROOT/scripts/start-standalone.sh" >"$LOG_PATH" 2>&1 &
new_pid=$!
write_server_pid "$new_pid"

echo "==> verifying process and static assets"
for _ in $(seq 1 20); do
  if curl -fsSL "http://$VERIFY_HOST:$PORT/login" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

login_html="$(curl -fsSL "http://$VERIFY_HOST:$PORT/login")"
css_path="$(printf '%s\n' "$login_html" | sed -n 's|.*\(/_next/static/chunks/[^"]*\.css\).*|\1|p' | sed -n '1p')"
if [[ -z "${css_path:-}" ]]; then
  echo "error: no css asset found in rendered login HTML" >&2
  exit 1
fi

# The managed task-flow uses loopback-only API calls. A 401 here means the
# standalone process was started without the repository runtime environment,
# which would strand queued video tasks even though the web page is healthy.
n8n_probe_code="$(curl -sS -o /dev/null -w "%{http_code}" "http://$VERIFY_HOST:$PORT/api/n8n/workflows" || true)"
if [[ "$n8n_probe_code" != 2?? ]]; then
  echo "error: loopback task-flow API probe returned HTTP $n8n_probe_code; check MC_AUTH_MODE and listen host" >&2
  exit 1
fi

listener_pid="$(list_listener_pids | head -n1)"
if [[ -z "${listener_pid:-}" ]]; then
  echo "error: no listener detected on port $PORT after startup" >&2
  exit 1
fi
if [[ "$listener_pid" != "$new_pid" ]]; then
  echo "error: port $PORT is owned by pid=$listener_pid, expected new pid=$new_pid" >&2
  exit 1
fi
if ! verify_new_runtime_identity "$new_pid"; then
  echo "error: new standalone process runtime identity or data binding does not match the deployment target" >&2
  exit 1
fi

css_disk_path="$PROJECT_ROOT/.next/standalone/.next${css_path#/_next}"
if [[ ! -f "$css_disk_path" ]]; then
  echo "error: rendered css asset missing on disk: $css_disk_path" >&2
  exit 1
fi

content_type="$(curl -fsSI "http://$VERIFY_HOST:$PORT$css_path" | awk 'tolower($1) == "content-type:" {print $2}' | tr -d '\r')"
if [[ "${content_type:-}" != text/css* ]]; then
  echo "error: css asset served with unexpected content-type: ${content_type:-missing}" >&2
  exit 1
fi

deployment_verified=1
cleanup_recovery_bundle
trap - EXIT
echo "==> deployed commit $(git rev-parse --short HEAD)"
echo "    pid=$new_pid port=$PORT css=$css_path"
