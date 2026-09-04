#!/usr/bin/env bash
set -euo pipefail
umask 077

PROFILE="qwen-current"
OPENCLAW_VERSION="2026.7.1-2"
MODE=""
ROLLBACK_BACKUP=""
TOOL_BASELINE=""
EXISTING_CONVERGENCE_PROOF=""
RUNTIME_SESSION_KEY="${AIWORKER_OPENCLAW_RUNTIME_SESSION_KEY:-}"
RUNTIME_SESSION_KEY_SHA256=""

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
MANIFEST_FILE="$REPOSITORY_ROOT/ops/openclaw/qwen-current-runtime-convergence.manifest.json"
CONVERGENCE_HELPER="$REPOSITORY_ROOT/scripts/lib/openclaw-runtime-convergence.mjs"
SECRET_REFERENCE_HELPER="$REPOSITORY_ROOT/scripts/lib/openclaw-secret-reference.mjs"
PRIVATE_GATEWAY_RPC_HELPER="$REPOSITORY_ROOT/scripts/lib/openclaw-private-gateway-rpc.mjs"
SHARED_DEPLOYMENT_LOCK_HELPER="$REPOSITORY_ROOT/scripts/lib/shared-deployment-lock.sh"
PROFILE_STATE_DIR="${AIWORKER_OPENCLAW_QWEN_STATE_DIR:-$HOME/.openclaw-qwen-current}"
PROFILE_CONFIG="$PROFILE_STATE_DIR/openclaw.json"
BACKUP_ROOT="${AIWORKER_OPENCLAW_RUNTIME_BACKUP_ROOT:-$HOME/ai-worker/backups/openclaw-runtime-convergence}"
OPENCLAW_BIN="${OPENCLAW_BIN:-openclaw}"
NODE_BIN="${AIWORKER_NODE_BIN:-$(command -v node 2>/dev/null || true)}"
DEPLOYMENT_RUN_DIR="${AIWORKER_BG_RUN_DIR:-$REPOSITORY_ROOT/.run/blue-green}"
DEPLOYMENT_LOCK_DIR="$DEPLOYMENT_RUN_DIR/.deployment.lock"
WORK_ROOT=""

usage() {
  printf '%s\n' \
    "Usage:" \
    "  $0 --capture-tool-baseline" \
    "  $0 (--dry-run|--apply) --tool-baseline <absolute-baseline.json> [--runtime-convergence-proof <absolute-proof.json>]" \
    "  $0 --rollback --backup <absolute-openclaw.json-backup>"
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --capture-tool-baseline|--dry-run|--apply|--rollback)
      [[ -z "$MODE" ]] || { usage >&2; exit 2; }
      MODE="${1#--}"
      shift
      ;;
    --backup)
      [[ -z "$ROLLBACK_BACKUP" && "$#" -ge 2 ]] || { usage >&2; exit 2; }
      ROLLBACK_BACKUP="$2"
      shift 2
      ;;
    --tool-baseline)
      [[ -z "$TOOL_BASELINE" && "$#" -ge 2 ]] || { usage >&2; exit 2; }
      TOOL_BASELINE="$2"
      shift 2
      ;;
    --runtime-convergence-proof)
      [[ -z "$EXISTING_CONVERGENCE_PROOF" && "$#" -ge 2 ]] || { usage >&2; exit 2; }
      EXISTING_CONVERGENCE_PROOF="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
done

[[ -n "$MODE" ]] || { usage >&2; exit 2; }
[[ "$MODE" == "rollback" || -z "$ROLLBACK_BACKUP" ]] || { usage >&2; exit 2; }
[[ "$MODE" != "rollback" || "$ROLLBACK_BACKUP" == /* ]] || { usage >&2; exit 2; }
[[ "$MODE" == "dry-run" || "$MODE" == "apply" || -z "$TOOL_BASELINE" ]] \
  || { usage >&2; exit 2; }
[[ "$MODE" != "dry-run" && "$MODE" != "apply" || "$TOOL_BASELINE" == /* ]] \
  || { usage >&2; exit 2; }
[[ -z "$EXISTING_CONVERGENCE_PROOF" || ( "$MODE" == "apply" \
  && "$EXISTING_CONVERGENCE_PROOF" == /* ) ]] || { usage >&2; exit 2; }
if [[ "$MODE" != "rollback" ]]; then
  [[ "$-" != *x* ]] || {
    printf 'Disable shell xtrace before using the private runtime session key.\n' >&2
    exit 2
  }
  [[ -n "$RUNTIME_SESSION_KEY" ]] || {
    printf 'AIWORKER_OPENCLAW_RUNTIME_SESSION_KEY must identify one existing real session.\n' >&2
    exit 2
  }
fi

for required in chmod cmp install mktemp rm sleep; do
  command -v "$required" >/dev/null 2>&1 || {
    printf 'Required command is unavailable: %s\n' "$required" >&2
    exit 1
  }
done
LSOF_BIN=/usr/sbin/lsof
if [[ "${AIWORKER_OPENCLAW_RUNTIME_TEST_MODE:-}" == 1 \
  && -n "${AIWORKER_OPENCLAW_RUNTIME_LSOF_BIN:-}" ]]; then
  LSOF_BIN="$AIWORKER_OPENCLAW_RUNTIME_LSOF_BIN"
fi
if [[ "${AIWORKER_OPENCLAW_RUNTIME_TEST_MODE:-}" == 1 \
  && -n "${AIWORKER_OPENCLAW_RUNTIME_RPC_HELPER:-}" ]]; then
  PRIVATE_GATEWAY_RPC_HELPER="$AIWORKER_OPENCLAW_RUNTIME_RPC_HELPER"
fi
[[ "$LSOF_BIN" == /* && -x "$LSOF_BIN" && ! -L "$LSOF_BIN" ]] || {
  printf 'lsof is unavailable.\n' >&2
  exit 1
}
[[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || { printf 'Node.js is required.\n' >&2; exit 1; }
[[ -x "$OPENCLAW_BIN" ]] || command -v "$OPENCLAW_BIN" >/dev/null 2>&1 || {
  printf 'OpenClaw is unavailable.\n' >&2
  exit 1
}
for required_file in "$MANIFEST_FILE" "$CONVERGENCE_HELPER" "$SECRET_REFERENCE_HELPER" \
  "$PRIVATE_GATEWAY_RPC_HELPER" "$SHARED_DEPLOYMENT_LOCK_HELPER"; do
  [[ -f "$required_file" && ! -L "$required_file" ]] || {
    printf 'Required runtime convergence component is unavailable.\n' >&2
    exit 1
  }
done
if [[ "$MODE" != "rollback" ]]; then
  RUNTIME_SESSION_KEY_SHA256="$(
    AIWORKER_OPENCLAW_RUNTIME_SESSION_KEY="$RUNTIME_SESSION_KEY" "$NODE_BIN" - <<'NODE'
const { createHash } = require('node:crypto')
const value = process.env.AIWORKER_OPENCLAW_RUNTIME_SESSION_KEY || ''
if (value.length === 0 || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) process.exit(1)
process.stdout.write(createHash('sha256').update(value).digest('hex'))
NODE
  )" || {
    printf 'AIWORKER_OPENCLAW_RUNTIME_SESSION_KEY is invalid.\n' >&2
    exit 2
  }
  unset AIWORKER_OPENCLAW_RUNTIME_SESSION_KEY
fi
# shellcheck source=scripts/lib/shared-deployment-lock.sh
. "$SHARED_DEPLOYMENT_LOCK_HELPER"

cleanup() {
  local status=$?
  trap - EXIT HUP INT TERM
  if [[ -n "$WORK_ROOT" && -d "$WORK_ROOT" ]]; then
    case "$WORK_ROOT" in
      /tmp/aiworker-openclaw-runtime-convergence.*|/private/tmp/aiworker-openclaw-runtime-convergence.*)
        rm -rf -- "$WORK_ROOT"
        ;;
      *)
        printf 'Refusing unexpected temporary cleanup path.\n' >&2
        status=70
        ;;
    esac
  fi
  if [[ "$DEPLOYMENT_LOCK_OWNED" == 1 ]] && ! release_shared_deployment_lock; then status=70; fi
  exit "$status"
}

WORK_ROOT="$(mktemp -d /tmp/aiworker-openclaw-runtime-convergence.XXXXXX)"
chmod 700 "$WORK_ROOT"
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
WORK_ROOT="$(cd "$WORK_ROOT" && pwd -P)"

run_openclaw() {
  env -u OPENCLAW_PROFILE -u OPENCLAW_STATE_DIR -u OPENCLAW_CONFIG_PATH \
    -u OPENCLAW_HOME -u OPENCLAW_INCLUDE_ROOTS \
    -u OPENCLAW_GATEWAY_TOKEN -u GATEWAY_TOKEN \
    -u OPENCLAW_GATEWAY_PASSWORD -u GATEWAY_PASSWORD \
    "$OPENCLAW_BIN" --profile "$PROFILE" "$@"
}

resolve_gateway_token() {
  env -u OPENCLAW_GATEWAY_TOKEN -u GATEWAY_TOKEN \
    -u OPENCLAW_GATEWAY_PASSWORD -u GATEWAY_PASSWORD \
    "$NODE_BIN" "$SECRET_REFERENCE_HELPER" "$PROFILE_CONFIG" 2>/dev/null
}

run_openclaw_gateway() {
  local gateway_token status
  gateway_token="$(resolve_gateway_token)" || {
    printf 'Unable to resolve the qwen-current Gateway token through its configured exec SecretRef.\n' >&2
    return 1
  }
  if env -u OPENCLAW_PROFILE -u OPENCLAW_STATE_DIR -u OPENCLAW_CONFIG_PATH \
    -u OPENCLAW_HOME -u OPENCLAW_INCLUDE_ROOTS \
    -u OPENCLAW_GATEWAY_TOKEN -u GATEWAY_TOKEN \
    -u OPENCLAW_GATEWAY_PASSWORD -u GATEWAY_PASSWORD \
    OPENCLAW_GATEWAY_TOKEN="$gateway_token" \
    "$OPENCLAW_BIN" --profile "$PROFILE" "$@"; then
    status=0
  else
    status=$?
  fi
  unset gateway_token
  return "$status"
}

run_private_gateway_rpc() {
  local operation="$1" output_path="$2" gateway_token status
  gateway_token="$(resolve_gateway_token)" || {
    printf 'Unable to resolve the qwen-current Gateway token through its configured exec SecretRef.\n' >&2
    return 1
  }
  if env -u OPENCLAW_PROFILE -u OPENCLAW_STATE_DIR -u OPENCLAW_CONFIG_PATH \
    -u OPENCLAW_HOME -u OPENCLAW_INCLUDE_ROOTS \
    -u GATEWAY_TOKEN -u OPENCLAW_GATEWAY_PASSWORD -u GATEWAY_PASSWORD \
    OPENCLAW_BIN="$(command -v "$OPENCLAW_BIN" 2>/dev/null || printf '%s' "$OPENCLAW_BIN")" \
    OPENCLAW_GATEWAY_TOKEN="$gateway_token" \
    AIWORKER_OPENCLAW_RUNTIME_SESSION_KEY="$RUNTIME_SESSION_KEY" \
    "$NODE_BIN" "$PRIVATE_GATEWAY_RPC_HELPER" "$operation" "$output_path"; then
    status=0
  else
    status=$?
  fi
  unset gateway_token
  return "$status"
}

run_config_validate() {
  if ! run_openclaw config validate >/dev/null 2>&1; then
    printf 'qwen-current config validation failed.\n' >&2
    return 1
  fi
}

run_config_patch() {
  local patch_file="$1"
  shift
  if ! run_openclaw config patch --file "$patch_file" "$@" >/dev/null 2>&1; then
    printf 'qwen-current official config patch failed.\n' >&2
    return 1
  fi
}

apply_config_patch_cas() {
  local patch_file="$1" config_get patch_result base_hash
  config_get="$(mktemp "$WORK_ROOT/gateway-config-get.XXXXXXXX")"
  patch_result="$(mktemp "$WORK_ROOT/gateway-config-patch.XXXXXXXX")"
  run_private_gateway_rpc config-get "$config_get" || return 1
  base_hash="$("$NODE_BIN" "$CONVERGENCE_HELPER" read-config-base-hash \
    "$config_get" "$MANIFEST_FILE")" \
    || return 1
  if ! AIWORKER_OPENCLAW_RUNTIME_BASE_HASH="$base_hash" \
    AIWORKER_OPENCLAW_RUNTIME_PATCH_FILE="$patch_file" \
    run_private_gateway_rpc config-patch "$patch_result"; then
    return 1
  fi
  HOT_RELOAD_BASE_HASH="$base_hash"
  HOT_RELOAD_PATCH_RESULT="$patch_result"
}

capture_gateway_log_cursor() {
  local output
  output="$(mktemp "$WORK_ROOT/gateway-log-cursor.XXXXXXXX")"
  run_private_gateway_rpc logs-tail "$output" || return 1
  "$NODE_BIN" "$CONVERGENCE_HELPER" read-log-cursor "$output"
}

verify_compaction_hot_reload() {
  local expected_pid="$1" cursor="$2" attempt health logs post_config_get listener_after
  health="$(mktemp "$WORK_ROOT/gateway-hot-reload-health.XXXXXXXX")"
  logs="$(mktemp "$WORK_ROOT/gateway-hot-reload-logs.XXXXXXXX")"
  post_config_get="$(mktemp "$WORK_ROOT/gateway-post-patch-config-get.XXXXXXXX")"
  for attempt in {1..30}; do
    : > "$health"
    : > "$logs"
    : > "$post_config_get"
    chmod 600 "$health" "$logs" "$post_config_get"
    if run_private_gateway_rpc health "$health" \
      && AIWORKER_OPENCLAW_RUNTIME_LOG_CURSOR="$cursor" \
        run_private_gateway_rpc logs-tail "$logs" \
      && run_private_gateway_rpc config-get "$post_config_get" \
      && listener_after="$(gateway_listener_pid)" \
      && [[ "$listener_after" == "$expected_pid" ]] \
      && "$NODE_BIN" "$CONVERGENCE_HELPER" verify-hot-reload \
        "$health" "$logs" "$HOT_RELOAD_PATCH_RESULT" "$post_config_get" \
        "$MANIFEST_FILE" "$expected_pid" "$HOT_RELOAD_BASE_HASH" "$cursor"; then
      return 0
    fi
    sleep 0.1
  done
  printf 'qwen-current did not prove a clean in-process compaction hot reload.\n' >&2
  return 1
}

persist_runtime_convergence_proof() {
  local runtime_proof="$1" hot_reload_proof="$2" runtime_file hot_file output
  runtime_file="$(mktemp "$WORK_ROOT/runtime-proof.XXXXXXXX")" || return 1
  hot_file="$(mktemp "$WORK_ROOT/hot-reload-proof.XXXXXXXX")" || return 1
  printf '%s\n' "$runtime_proof" > "$runtime_file" || return 1
  printf '%s\n' "$hot_reload_proof" > "$hot_file" || return 1
  chmod 600 "$runtime_file" "$hot_file" || return 1
  "$NODE_BIN" "$CONVERGENCE_HELPER" prepare-backup-root \
    "$BACKUP_ROOT" "$HOME" "$REPOSITORY_ROOT" "$PROFILE_STATE_DIR" || return 1
  output="$(mktemp "$BACKUP_ROOT/qwen-current-runtime-convergence-proof.XXXXXXXX")" \
    || return 1
  "$NODE_BIN" "$CONVERGENCE_HELPER" write-convergence-proof \
    "$runtime_file" "$hot_file" "$MANIFEST_FILE" "$PROFILE_CONFIG" "$output" \
    || return 1
  "$NODE_BIN" "$CONVERGENCE_HELPER" assert-convergence-proof \
    "$output" "$MANIFEST_FILE" "$PROFILE_STATE_DIR" "$PROFILE_CONFIG" >/dev/null \
    || return 1
  printf '%s\n' "$output"
}

gateway_listener_pid() {
  local output
  output="$($LSOF_BIN -nP -iTCP:18889 -sTCP:LISTEN -Fp 2>/dev/null)" || {
    printf 'Unable to resolve the qwen-current Gateway listener.\n' >&2
    return 1
  }
  "$NODE_BIN" - "$output" <<'NODE'
const values = [...new Set(process.argv[2].split(/\r?\n/u)
  .filter(line => /^p[1-9][0-9]*$/u.test(line)).map(line => Number(line.slice(1))))]
if (values.length !== 1) process.exit(1)
process.stdout.write(String(values[0]))
NODE
}

collect_runtime_evidence() {
  local expected_pid="$1" suffix="$2" listener_after
  EVIDENCE_GATEWAY_STATUS="$WORK_ROOT/gateway-status-$suffix.json"
  EVIDENCE_INSPECTION="$WORK_ROOT/director-brain-runtime-$suffix.json"
  EVIDENCE_CATALOG="$(mktemp "$WORK_ROOT/director-brain-catalog-$suffix.XXXXXXXX")"
  EVIDENCE_EFFECTIVE="$(mktemp "$WORK_ROOT/director-brain-effective-$suffix.XXXXXXXX")"
  [[ "$(gateway_listener_pid)" == "$expected_pid" ]] || {
    printf 'qwen-current Gateway listener changed before runtime evidence collection.\n' >&2
    return 1
  }
  run_openclaw_gateway gateway status --deep --require-rpc --json > "$EVIDENCE_GATEWAY_STATUS" 2>/dev/null || {
    printf 'qwen-current Gateway runtime verification failed.\n' >&2
    return 1
  }
  run_openclaw_gateway plugins inspect aiworker-director-brain --runtime --json > "$EVIDENCE_INSPECTION" 2>/dev/null || {
    printf 'Director-brain runtime inspection failed.\n' >&2
    return 1
  }
  run_private_gateway_rpc catalog "$EVIDENCE_CATALOG" || {
    printf 'Director-brain runtime catalog verification failed.\n' >&2
    return 1
  }
  run_private_gateway_rpc effective "$EVIDENCE_EFFECTIVE" || {
    printf 'Effective tool verification failed.\n' >&2
    return 1
  }
  listener_after="$(gateway_listener_pid)" || return 1
  [[ "$listener_after" == "$expected_pid" ]] || {
    printf 'qwen-current Gateway listener changed during runtime evidence collection.\n' >&2
    return 1
  }
  chmod 600 "$EVIDENCE_GATEWAY_STATUS" "$EVIDENCE_INSPECTION" "$EVIDENCE_CATALOG" \
    "$EVIDENCE_EFFECTIVE"
}

collect_tool_baseline_evidence() {
  local expected_pid="$1" suffix="$2" listener_after
  EVIDENCE_CATALOG="$(mktemp "$WORK_ROOT/pre-install-catalog-$suffix.XXXXXXXX")"
  EVIDENCE_EFFECTIVE="$(mktemp "$WORK_ROOT/pre-install-effective-$suffix.XXXXXXXX")"
  [[ "$(gateway_listener_pid)" == "$expected_pid" ]] || {
    printf 'qwen-current Gateway listener changed before baseline collection.\n' >&2
    return 1
  }
  run_private_gateway_rpc catalog "$EVIDENCE_CATALOG" || {
    printf 'Unable to capture the pre-install tool catalog.\n' >&2
    return 1
  }
  run_private_gateway_rpc effective "$EVIDENCE_EFFECTIVE" || {
    printf 'Unable to capture the pre-install effective tools.\n' >&2
    return 1
  }
  listener_after="$(gateway_listener_pid)" || return 1
  [[ "$listener_after" == "$expected_pid" ]] || {
    printf 'qwen-current Gateway listener changed during baseline collection.\n' >&2
    return 1
  }
  chmod 600 "$EVIDENCE_CATALOG" "$EVIDENCE_EFFECTIVE"
}

verify_runtime_hooks() {
  local config_snapshot_source="$1" gateway_pid suffix
  gateway_pid="$(gateway_listener_pid)" || return 1
  suffix="verify-$RANDOM-$RANDOM"
  collect_runtime_evidence "$gateway_pid" "$suffix" || return 1
  "$NODE_BIN" "$CONVERGENCE_HELPER" verify-runtime-hooks \
    "$PROFILE_STATE_DIR" "$MANIFEST_FILE" "$gateway_pid" \
    "$EVIDENCE_GATEWAY_STATUS" "$EVIDENCE_INSPECTION" "$EVIDENCE_CATALOG" \
    "$EVIDENCE_EFFECTIVE" "$PROFILE_CONFIG" "$config_snapshot_source" "$TOOL_BASELINE" \
    "$RUNTIME_SESSION_KEY_SHA256"
}

config_snapshot() {
  "$NODE_BIN" "$CONVERGENCE_HELPER" config-scope-snapshot \
    "$PROFILE_CONFIG" "$MANIFEST_FILE"
}

safe_config_snapshot() {
  config_snapshot 2>/dev/null
}

assert_config_snapshot() {
  "$NODE_BIN" "$CONVERGENCE_HELPER" assert-config-scope-snapshot \
    "$PROFILE_CONFIG" "$1" "$MANIFEST_FILE"
}

semantic_equal() {
  "$NODE_BIN" "$CONVERGENCE_HELPER" semantic-equal "$1" "$2" "$MANIFEST_FILE"
}

wait_for_stable_config() {
  local previous_snapshot="" current_snapshot="" attempt
  for attempt in {1..30}; do
    current_snapshot="$(safe_config_snapshot)" || current_snapshot=""
    if [[ -n "$current_snapshot" && "$current_snapshot" == "$previous_snapshot" ]]; then return 0; fi
    previous_snapshot="$current_snapshot"
    sleep 0.1
  done
  printf 'qwen-current config did not reach a stable state within three seconds.\n' >&2
  return 1
}

replace_config_from_file() {
  "$NODE_BIN" "$CONVERGENCE_HELPER" atomic-replace \
    "$1" "$PROFILE_CONFIG" "$2" "$MANIFEST_FILE"
}

refuse_concurrent_recovery() {
  printf 'MANUAL INSPECTION REQUIRED: qwen-current config changed concurrently; automatic recovery was refused.\n' >&2
  return 70
}

recover_config() {
  local source="$1" operation_snapshot="$2" recovery_snapshot
  assert_config_snapshot "$operation_snapshot" 2>/dev/null \
    || { refuse_concurrent_recovery; return 70; }
  if replace_config_from_file "$source" "$operation_snapshot" \
    && recovery_snapshot="$(safe_config_snapshot)" \
    && run_config_validate \
    && wait_for_stable_config \
    && semantic_equal "$source" "$PROFILE_CONFIG" \
    && assert_config_snapshot "$recovery_snapshot"; then
    return 0
  fi
  printf 'RECOVERY FAILED: qwen-current config requires manual inspection.\n' >&2
  return 70
}

assert_source_contract() {
  case "$(env -u OPENCLAW_GATEWAY_TOKEN -u GATEWAY_TOKEN \
    -u OPENCLAW_GATEWAY_PASSWORD -u GATEWAY_PASSWORD \
    "$OPENCLAW_BIN" --version)" in
    "OpenClaw $OPENCLAW_VERSION ("*")") ;;
    *) printf 'Unsupported OpenClaw version; expected %s.\n' "$OPENCLAW_VERSION" >&2; return 1 ;;
  esac
  [[ -d "$PROFILE_STATE_DIR" && ! -L "$PROFILE_STATE_DIR" ]] || {
    printf 'qwen-current state directory is missing or unsafe.\n' >&2
    return 1
  }
  local active_config
  active_config="$(run_openclaw config file 2>/dev/null)" || {
    printf 'Unable to resolve the qwen-current active config.\n' >&2
    return 1
  }
  "$NODE_BIN" - "$HOME" "$PROFILE_STATE_DIR" "$PROFILE_CONFIG" "$active_config" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const [homePath, statePath, expectedConfigPath, activeConfigSource] = process.argv.slice(2)
if (!path.isAbsolute(homePath) || path.resolve(homePath) !== homePath
  || !path.isAbsolute(statePath) || path.resolve(statePath) !== statePath
  || !path.isAbsolute(expectedConfigPath) || path.resolve(expectedConfigPath) !== expectedConfigPath
  || /[\u0000-\u001f\u007f]/u.test(activeConfigSource)) {
  throw new Error('active config path is invalid')
}
const expectedTildePath = `~/${path.relative(homePath, expectedConfigPath)}`
const activeConfigPath = activeConfigSource.startsWith('~/')
  ? (activeConfigSource === expectedTildePath ? expectedConfigPath : '')
  : activeConfigSource
if (!path.isAbsolute(activeConfigPath) || path.resolve(activeConfigPath) !== activeConfigPath
  || activeConfigPath !== expectedConfigPath) throw new Error('active config path is invalid')
const resolvedHome = fs.realpathSync(homePath)
const resolvedState = fs.realpathSync(statePath)
const resolvedExpected = fs.realpathSync(expectedConfigPath)
if (resolvedState !== path.join(resolvedHome, '.openclaw-qwen-current')
  || fs.realpathSync(path.dirname(activeConfigPath)) !== resolvedState
  || fs.realpathSync(activeConfigPath) !== resolvedExpected
  || path.basename(activeConfigPath) !== 'openclaw.json') {
  throw new Error('active config is outside qwen-current state')
}
NODE
  [[ -f "$PROFILE_CONFIG" && ! -L "$PROFILE_CONFIG" ]] || {
    printf 'qwen-current config is missing or unsafe.\n' >&2
    return 1
  }
  "$NODE_BIN" "$CONVERGENCE_HELPER" validate-manifest "$MANIFEST_FILE"
  "$NODE_BIN" "$CONVERGENCE_HELPER" assert-source \
    "$PROFILE_CONFIG" "$PROFILE_STATE_DIR" "$MANIFEST_FILE" "$MODE"
}

if [[ "$MODE" == "apply" || "$MODE" == "rollback" ]]; then
  acquire_shared_deployment_lock
else
  assert_shared_deployment_lock_available
fi
assert_source_contract
run_config_validate

if [[ "$MODE" == "capture-tool-baseline" ]]; then
  CAPTURE_CONFIG_SNAPSHOT="$(config_snapshot)"
  BASELINE_PID="$(gateway_listener_pid)" || exit 1
  collect_tool_baseline_evidence "$BASELINE_PID" "capture-$RANDOM-$RANDOM"
  assert_config_snapshot "$CAPTURE_CONFIG_SNAPSHOT"
  TOOL_BASELINE_STAGED="$(mktemp "$WORK_ROOT/qwen-current-before-director-install-tools.XXXXXXXX")"
  "$NODE_BIN" "$CONVERGENCE_HELPER" write-tool-baseline \
    "$EVIDENCE_CATALOG" "$EVIDENCE_EFFECTIVE" "$MANIFEST_FILE" "$TOOL_BASELINE_STAGED" \
    "$RUNTIME_SESSION_KEY_SHA256"
  "$NODE_BIN" "$CONVERGENCE_HELPER" prepare-backup-root \
    "$BACKUP_ROOT" "$HOME" "$REPOSITORY_ROOT" "$PROFILE_STATE_DIR"
  TOOL_BASELINE_OUTPUT="$(mktemp "$BACKUP_ROOT/qwen-current-before-director-install-tools.XXXXXXXX")"
  if ! install -m 600 "$TOOL_BASELINE_STAGED" "$TOOL_BASELINE_OUTPUT" \
    || ! cmp -s "$TOOL_BASELINE_STAGED" "$TOOL_BASELINE_OUTPUT" \
    || ! "$NODE_BIN" "$CONVERGENCE_HELPER" assert-backup "$TOOL_BASELINE_OUTPUT" \
    || ! assert_config_snapshot "$CAPTURE_CONFIG_SNAPSHOT"; then
    rm -f -- "$TOOL_BASELINE_OUTPUT"
    printf 'Unable to persist the verified pre-install tool baseline.\n' >&2
    exit 1
  fi
  printf 'Captured pre-install catalog and effective-tool baseline: %s\n' "$TOOL_BASELINE_OUTPUT"
  printf 'No OpenClaw config, plugin, Gateway, queue, task, database, or media state changed.\n'
  exit 0
fi

ACTIVATION_CONFIG_SNAPSHOT="$(config_snapshot)"
if [[ "$MODE" == "apply" ]]; then
  BASELINE_RUNTIME_PROOF="$(verify_runtime_hooks "$ACTIVATION_CONFIG_SNAPSHOT")" || {
    printf 'Runtime convergence requires the installed 0.4.0 persistence hooks on a freshly restarted qwen-current Gateway.\n' >&2
    exit 1
  }
elif [[ "$MODE" == "dry-run" ]]; then
  if BASELINE_RUNTIME_PROOF="$(verify_runtime_hooks "$ACTIVATION_CONFIG_SNAPSHOT")"; then
    printf 'Persistence-hook runtime preflight: current.\n'
  else
    printf 'Persistence-hook runtime preflight failed; dry-run and apply remain blocked.\n' >&2
    exit 1
  fi
fi

BEFORE_CONFIG="$WORK_ROOT/openclaw.before.json"
BEFORE_SNAPSHOT="$(config_snapshot)"
install -m 600 "$PROFILE_CONFIG" "$BEFORE_CONFIG"
assert_config_snapshot "$BEFORE_SNAPSHOT"
semantic_equal "$BEFORE_CONFIG" "$PROFILE_CONFIG"

if [[ "$MODE" == "rollback" ]]; then
  "$NODE_BIN" "$CONVERGENCE_HELPER" assert-config-backup \
    "$ROLLBACK_BACKUP" "$MANIFEST_FILE"
  "$NODE_BIN" "$CONVERGENCE_HELPER" verify-difference \
    "$PROFILE_CONFIG" "$ROLLBACK_BACKUP" "$MANIFEST_FILE" no
  if semantic_equal "$PROFILE_CONFIG" "$ROLLBACK_BACKUP"; then
    printf 'qwen-current already matches the verified runtime convergence backup; no config was changed.\n'
    exit 0
  fi
  if ! assert_config_snapshot "$BEFORE_SNAPSHOT" 2>/dev/null; then
    printf 'qwen-current config changed during rollback preflight; CAS refused.\n' >&2
    exit 1
  fi
  replace_config_from_file "$ROLLBACK_BACKUP" "$BEFORE_SNAPSHOT"
  ROLLBACK_WRITE_SNAPSHOT="$(safe_config_snapshot)" || { refuse_concurrent_recovery; exit 70; }
  if ! run_config_validate \
    || ! wait_for_stable_config \
    || ! "$NODE_BIN" "$CONVERGENCE_HELPER" verify-difference \
      "$BEFORE_CONFIG" "$PROFILE_CONFIG" "$MANIFEST_FILE" no \
    || ! semantic_equal "$ROLLBACK_BACKUP" "$PROFILE_CONFIG" \
    || ! assert_config_snapshot "$ROLLBACK_WRITE_SNAPSHOT"; then
    assert_config_snapshot "$ROLLBACK_WRITE_SNAPSHOT" 2>/dev/null \
      || { refuse_concurrent_recovery; exit 70; }
    printf 'Rollback failed; restoring the exact pre-rollback qwen-current config.\n' >&2
    recover_config "$BEFORE_CONFIG" "$ROLLBACK_WRITE_SNAPSHOT" || exit 70
    exit 1
  fi
  printf 'Rolled back qwen-current runtime convergence from verified backup: %s\n' "$ROLLBACK_BACKUP"
  printf 'Now restore the previous plugin and freshly restart qwen-current before reuse.\n'
  exit 0
fi

PATCH_FILE="$WORK_ROOT/runtime-convergence.patch.json"
EXPECTED_CONFIG="$WORK_ROOT/openclaw.expected.json"
"$NODE_BIN" "$CONVERGENCE_HELPER" render \
  "$PROFILE_CONFIG" "$MANIFEST_FILE" "$PATCH_FILE" "$EXPECTED_CONFIG"
"$NODE_BIN" "$CONVERGENCE_HELPER" verify-difference \
  "$PROFILE_CONFIG" "$EXPECTED_CONFIG" "$MANIFEST_FILE" yes
run_config_patch "$PATCH_FILE" --dry-run
if ! assert_config_snapshot "$BEFORE_SNAPSHOT" 2>/dev/null; then
  printf 'qwen-current config changed during patch preflight; CAS refused.\n' >&2
  exit 1
fi

if [[ "$MODE" == "dry-run" ]]; then
  printf 'qwen-current runtime convergence dry-run passed; no config or backup was changed.\n'
  exit 0
fi

if semantic_equal "$PROFILE_CONFIG" "$EXPECTED_CONFIG"; then
  if [[ -n "$EXISTING_CONVERGENCE_PROOF" ]]; then
    "$NODE_BIN" "$CONVERGENCE_HELPER" assert-convergence-proof \
      "$EXISTING_CONVERGENCE_PROOF" "$MANIFEST_FILE" "$PROFILE_STATE_DIR" \
      "$PROFILE_CONFIG" >/dev/null
    printf 'qwen-current runtime convergence is already current; no backup was needed.\n'
    printf 'Reused verified session-scoped runtime convergence proof: %s\n' \
      "$EXISTING_CONVERGENCE_PROOF"
    exit 0
  fi
  STARTUP_HEALTH="$(mktemp "$WORK_ROOT/gateway-startup-health.XXXXXXXX")"
  run_private_gateway_rpc health "$STARTUP_HEALTH"
  STARTUP_RUNTIME_FILE="$(mktemp "$WORK_ROOT/gateway-startup-runtime.XXXXXXXX")"
  printf '%s\n' "$BASELINE_RUNTIME_PROOF" > "$STARTUP_RUNTIME_FILE"
  chmod 600 "$STARTUP_RUNTIME_FILE"
  STARTUP_LOAD_PROOF="$("$NODE_BIN" "$CONVERGENCE_HELPER" verify-startup-loaded \
    "$STARTUP_RUNTIME_FILE" "$STARTUP_HEALTH" "$MANIFEST_FILE" "$PROFILE_CONFIG")"
  RUNTIME_CONVERGENCE_PROOF="$(persist_runtime_convergence_proof \
    "$BASELINE_RUNTIME_PROOF" "$STARTUP_LOAD_PROOF")"
  printf 'qwen-current runtime convergence is already current; no backup was needed.\n'
  printf 'Verified session-scoped runtime convergence proof: %s\n' \
    "$RUNTIME_CONVERGENCE_PROOF"
  exit 0
fi

if ! CURRENT_RUNTIME_PROOF="$(verify_runtime_hooks "$BEFORE_SNAPSHOT")" \
  || [[ "$CURRENT_RUNTIME_PROOF" != "$BASELINE_RUNTIME_PROOF" ]]; then
  printf 'Runtime hooks, Gateway identity, or tool inventory changed before backup creation; no config or backup was changed.\n' >&2
  exit 1
fi

"$NODE_BIN" "$CONVERGENCE_HELPER" prepare-backup-root \
  "$BACKUP_ROOT" "$HOME" "$REPOSITORY_ROOT" "$PROFILE_STATE_DIR"
BACKUP_FILE="$(mktemp "$BACKUP_ROOT/qwen-current-before-runtime-convergence.XXXXXXXX")"
install -m 600 "$PROFILE_CONFIG" "$BACKUP_FILE"
"$NODE_BIN" "$CONVERGENCE_HELPER" assert-config-backup \
  "$BACKUP_FILE" "$MANIFEST_FILE"
semantic_equal "$BEFORE_CONFIG" "$BACKUP_FILE"
if ! assert_config_snapshot "$BEFORE_SNAPSHOT" 2>/dev/null; then
  printf 'qwen-current config changed before apply; CAS refused.\n' >&2
  exit 1
fi

if ! CURRENT_RUNTIME_PROOF="$(verify_runtime_hooks "$BEFORE_SNAPSHOT")" \
  || [[ "$CURRENT_RUNTIME_PROOF" != "$BASELINE_RUNTIME_PROOF" ]]; then
  printf 'Runtime hooks, Gateway identity, or tool inventory changed immediately before apply; no config was changed.\n' >&2
  exit 1
fi
if ! assert_config_snapshot "$BEFORE_SNAPSHOT" 2>/dev/null; then
  printf 'qwen-current config changed immediately before apply; CAS refused.\n' >&2
  exit 1
fi

APPLY_OK=1
HOT_RELOAD_PID="$(gateway_listener_pid)" || exit 1
HOT_RELOAD_CURSOR="$(capture_gateway_log_cursor)" || exit 1
HOT_RELOAD_PATCH_RESULT=""
HOT_RELOAD_BASE_HASH=""
apply_config_patch_cas "$PATCH_FILE" || APPLY_OK=0
if [[ "$APPLY_OK" == 0 ]]; then
  assert_config_snapshot "$BEFORE_SNAPSHOT" 2>/dev/null \
    || { refuse_concurrent_recovery; exit 70; }
  printf 'Gateway CAS patch was rejected; no config recovery was attempted.\n' >&2
  exit 1
fi
APPLY_WRITE_SNAPSHOT="$(safe_config_snapshot)" || { refuse_concurrent_recovery; exit 70; }
POST_APPLY_RUNTIME_PROOF=""
HOT_RELOAD_PROOF=""
if ! run_config_validate \
  || ! wait_for_stable_config \
  || ! "$NODE_BIN" "$CONVERGENCE_HELPER" verify-difference \
    "$BEFORE_CONFIG" "$PROFILE_CONFIG" "$MANIFEST_FILE" yes \
  || ! assert_config_snapshot "$APPLY_WRITE_SNAPSHOT" \
  || ! POST_APPLY_RUNTIME_PROOF="$(verify_runtime_hooks "$APPLY_WRITE_SNAPSHOT")" \
  || [[ "$POST_APPLY_RUNTIME_PROOF" != "$BASELINE_RUNTIME_PROOF" ]] \
  || ! HOT_RELOAD_PROOF="$(verify_compaction_hot_reload \
    "$HOT_RELOAD_PID" "$HOT_RELOAD_CURSOR")"; then
  assert_config_snapshot "$APPLY_WRITE_SNAPSHOT" 2>/dev/null \
    || { refuse_concurrent_recovery; exit 70; }
  semantic_equal "$EXPECTED_CONFIG" "$PROFILE_CONFIG" 2>/dev/null \
    || { refuse_concurrent_recovery; exit 70; }
  printf 'Apply failed; restoring the exact pre-apply qwen-current config.\n' >&2
  recover_config "$BACKUP_FILE" "$APPLY_WRITE_SNAPSHOT" || exit 70
  exit 1
fi

RUNTIME_CONVERGENCE_PROOF="$(persist_runtime_convergence_proof \
  "$POST_APPLY_RUNTIME_PROOF" "$HOT_RELOAD_PROOF")"
release_shared_deployment_lock || exit 70
"$NODE_BIN" "$CONVERGENCE_HELPER" assert-convergence-proof \
  "$RUNTIME_CONVERGENCE_PROOF" "$MANIFEST_FILE" "$PROFILE_STATE_DIR" \
  "$PROFILE_CONFIG" >/dev/null
printf 'Applied qwen-current bounded transcript convergence with fresh persistence hooks.\n'
printf 'Verified 0600 rollback backup: %s\n' "$BACKUP_FILE"
printf 'The runtime tool IDs, owners, and exposed descriptor surfaces were preserved and reverified immediately before apply; the pinned plugin installation trees were also hashed.\n'
printf 'Verified session-scoped runtime convergence proof: %s\n' \
  "$RUNTIME_CONVERGENCE_PROOF"
