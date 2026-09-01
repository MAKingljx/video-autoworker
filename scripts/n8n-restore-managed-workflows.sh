#!/bin/bash

set -euo pipefail
umask 077

fail() {
  printf 'n8n managed workflow restore failed: %s\n' "$1" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: n8n-restore-managed-workflows.sh \
  --database /absolute/path/database.sqlite \
  --package /absolute/path/recovery-package \
  --confirmation-receipt /absolute/path/confirmation.json \
  --runtime-release /absolute/path/releases/<40-character-commit>

The private immutable 0400 receipt must be either a legacy-bootstrap normal or
disaster recovery receipt, or the one-way transition rollback authorization
created by n8n-workflow-transition-anchor.mjs after an import mutation began.
Handwritten receipts are rejected. Every mode binds the original package,
database inode, target runtime/tooling and a durable one-time restore journal.
EOF
}

DATABASE=""
PACKAGE=""
RECEIPT=""
RUNTIME_RELEASE=""
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --database) [[ "$#" -ge 2 ]] || fail '--database requires a value'; DATABASE="$2"; shift 2 ;;
    --package) [[ "$#" -ge 2 ]] || fail '--package requires a value'; PACKAGE="$2"; shift 2 ;;
    --confirmation-receipt) [[ "$#" -ge 2 ]] || fail '--confirmation-receipt requires a value'; RECEIPT="$2"; shift 2 ;;
    --runtime-release) [[ "$#" -ge 2 ]] || fail '--runtime-release requires a value'; RUNTIME_RELEASE="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown argument: $1" ;;
  esac
done

[[ -n "$DATABASE" && -n "$PACKAGE" && -n "$RECEIPT" && -n "$RUNTIME_RELEASE" ]] \
  || { usage >&2; exit 2; }
for value in "$DATABASE" "$PACKAGE" "$RECEIPT" "$RUNTIME_RELEASE"; do
  [[ "$value" == /* && "$value" != *$'\n'* && "$value" != *$'\r'* ]] \
    || fail 'all paths must be absolute and single-line'
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
VALIDATOR="$SCRIPT_DIR/n8n-backup-managed-workflows.mjs"
[[ -f "$VALIDATOR" && ! -L "$VALIDATOR" ]] || fail 'managed package validator is unavailable'

[[ -d "$RUNTIME_RELEASE" && ! -L "$RUNTIME_RELEASE" ]] || fail 'runtime release must be one physical directory'
RUNTIME_PHYSICAL="$(cd "$RUNTIME_RELEASE" && pwd -P)"
[[ "$RUNTIME_PHYSICAL" == "$RUNTIME_RELEASE" ]] || fail 'runtime release cannot contain symbolic links'
SOURCE_COMMIT="$(basename "$RUNTIME_RELEASE")"
[[ "$SOURCE_COMMIT" =~ ^[a-f0-9]{40}$ ]] || fail 'runtime release directory must be one full Git commit'
[[ "$(basename "$(dirname "$RUNTIME_RELEASE")")" == 'releases' ]] \
  || fail 'runtime release is outside a managed releases directory'
[[ -f "$RUNTIME_RELEASE/SOURCE_COMMIT" && ! -L "$RUNTIME_RELEASE/SOURCE_COMMIT" ]] \
  || fail 'runtime SOURCE_COMMIT is unavailable'
[[ "$(tr -d '[:space:]' < "$RUNTIME_RELEASE/SOURCE_COMMIT")" == "$SOURCE_COMMIT" ]] \
  || fail 'runtime SOURCE_COMMIT differs from its immutable release directory'
[[ -f "$RUNTIME_RELEASE/RUNTIME_SOURCE_SHA256SUMS" && ! -L "$RUNTIME_RELEASE/RUNTIME_SOURCE_SHA256SUMS" ]] \
  || fail 'runtime source manifest is unavailable'
[[ -f "$RUNTIME_RELEASE/SOURCE_MANIFEST" && ! -L "$RUNTIME_RELEASE/SOURCE_MANIFEST" ]] \
  || fail 'runtime source identity manifest is unavailable'
(cd "$RUNTIME_RELEASE" && shasum -a 256 -c RUNTIME_SOURCE_SHA256SUMS >/dev/null) \
  || fail 'runtime source manifest verification failed'
RUNTIME_MANIFEST_SHA256="$(shasum -a 256 "$RUNTIME_RELEASE/RUNTIME_SOURCE_SHA256SUMS" | awk '{print $1}')"
grep -Fqx "source_commit=$SOURCE_COMMIT" "$RUNTIME_RELEASE/SOURCE_MANIFEST" \
  || fail 'runtime source identity commit differs'
grep -Fqx "runtime_source_manifest_sha256=$RUNTIME_MANIFEST_SHA256" "$RUNTIME_RELEASE/SOURCE_MANIFEST" \
  || fail 'runtime source identity digest differs'

RUNTIME_DIR="$RUNTIME_RELEASE/ops/n8n"
CLI="$RUNTIME_DIR/node_modules/n8n/bin/n8n"
PACKAGE_JSON="$RUNTIME_DIR/node_modules/n8n/package.json"
[[ -f "$CLI" && ! -L "$CLI" && -f "$PACKAGE_JSON" && ! -L "$PACKAGE_JSON" ]] \
  || fail 'official n8n CLI is unavailable in the managed release'
NODE_BIN="${N8N_NODE_BIN:-$(command -v node || true)}"
[[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || fail 'Node executable is unavailable'
"$NODE_BIN" -e '
  const [major, minor] = process.versions.node.split(".").map(Number)
  if (major < 22 || (major === 22 && minor < 22)) process.exit(1)
' || fail 'Node 22.22 or newer is required'
N8N_VERSION="$("$NODE_BIN" -e '
  const fs = require("node:fs")
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
  if (typeof value.version !== "string") process.exit(1)
  process.stdout.write(value.version)
' "$PACKAGE_JSON")" || fail 'n8n package version is invalid'
[[ "$N8N_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([+-][A-Za-z0-9.-]+)?$ ]] \
  || fail 'n8n package version is invalid'
grep -Fqx "n8n_version=$N8N_VERSION" "$RUNTIME_RELEASE/SOURCE_MANIFEST" \
  || fail 'runtime source identity n8n version differs'

[[ -f "$DATABASE" && ! -L "$DATABASE" && "$(basename "$DATABASE")" == 'database.sqlite' ]] \
  || fail 'database must be one physical n8n database.sqlite file'
DATABASE_PARENT="$(cd "$(dirname "$DATABASE")" && pwd -P)"
[[ "$DATABASE_PARENT/database.sqlite" == "$DATABASE" ]] || fail 'database path cannot contain symbolic links'
export N8N_USER_FOLDER="$DATABASE_PARENT"
export N8N_NODE_BIN="$NODE_BIN"
[[ -n "${N8N_ENCRYPTION_KEY:-}" && "${#N8N_ENCRYPTION_KEY}" -ge 32 ]] \
  || fail 'N8N_ENCRYPTION_KEY must be loaded before restore'

MAINTENANCE_TOOL="$SCRIPT_DIR/n8n-maintenance-lock.mjs"
MAINTENANCE_LOCK="$N8N_USER_FOLDER/.n8n-maintenance.lock"
[[ -f "$MAINTENANCE_TOOL" && ! -L "$MAINTENANCE_TOOL" ]] \
  || fail 'n8n maintenance lock tool is unavailable'
MAINTENANCE_NONCE="$("$NODE_BIN" "$MAINTENANCE_TOOL" acquire \
  "$MAINTENANCE_LOCK" restore "$$")" || fail 'unable to acquire the n8n maintenance lock'
[[ "$MAINTENANCE_NONCE" =~ ^[a-f0-9]{64}$ ]] || fail 'n8n maintenance lock capability is invalid'
release_maintenance() {
  if [[ -n "${MAINTENANCE_NONCE:-}" ]]; then
    local nonce="$MAINTENANCE_NONCE"
    MAINTENANCE_NONCE=""
    "$NODE_BIN" "$MAINTENANCE_TOOL" release \
      "$MAINTENANCE_LOCK" restore "$$" "$nonce" >/dev/null 2>&1 || true
  fi
}
trap release_maintenance EXIT

PID_FILE="${AIWORKER_N8N_PID_FILE:-$HOME/ai-worker/run/n8n/n8n.pid}"
N8N_PORT="${N8N_PORT:-5678}"
[[ "$N8N_PORT" =~ ^[0-9]+$ && "$N8N_PORT" -ge 1 && "$N8N_PORT" -le 65535 ]] \
  || fail 'N8N_PORT is invalid'
command -v lsof >/dev/null 2>&1 || fail 'lsof is required to prove n8n is stopped'

assert_n8n_stopped() {
  local pid=""
  if [[ -f "$PID_FILE" ]]; then
    pid="$(tr -d '[:space:]' < "$PID_FILE")"
    if [[ "$pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$pid" 2>/dev/null; then
      fail 'n8n PID file still identifies a running process'
    fi
  fi
  if command -v launchctl >/dev/null 2>&1 \
    && launchctl print "gui/$(id -u)/com.video-autoworker.n8n" >/dev/null 2>&1; then
    fail 'n8n LaunchAgent is still loaded'
  fi
  if lsof -nP -iTCP:"$N8N_PORT" -sTCP:LISTEN -t 2>/dev/null | grep -Eq '^[1-9][0-9]*$'; then
    fail "TCP port $N8N_PORT still has a listener"
  fi
  if lsof -nP -t -- "$DATABASE" 2>/dev/null | grep -Eq '^[1-9][0-9]*$'; then
    fail 'a process still has the n8n database open'
  fi
  if command -v curl >/dev/null 2>&1 \
    && curl --silent --show-error --fail --max-time 2 \
      "${N8N_PROTOCOL:-http}://${N8N_HOST:-127.0.0.1}:$N8N_PORT/healthz" >/dev/null 2>&1; then
    fail 'n8n health endpoint is still available'
  fi
}

assert_n8n_stopped
PACKAGE_SUMMARY="$("$NODE_BIN" "$VALIDATOR" verify-package \
  --package "$PACKAGE" --source-commit "$SOURCE_COMMIT" --n8n-version "$N8N_VERSION")" \
  || fail 'recovery package validation failed'
SENTINEL_BEFORE="$("$NODE_BIN" "$VALIDATOR" database-sentinel \
  --database "$DATABASE" --module-root "$RUNTIME_DIR")" \
  || fail 'pre-restore database sentinel failed'

assert_n8n_stopped

RECEIPT_SCHEMA="$($NODE_BIN -e '
  const fs = require("node:fs")
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
  if (typeof value.schema !== "string") process.exit(1)
  process.stdout.write(value.schema)
' "$RECEIPT")" || fail 'confirmation receipt schema is invalid'
DISASTER_MODE=false
TRANSITION_ROLLBACK_MODE=false
if [[ "$RECEIPT_SCHEMA" == 'video-autoworker-n8n-managed-workflow-disaster-recovery-confirmation/v1' ]]; then
  DISASTER_MODE=true
elif [[ "$RECEIPT_SCHEMA" == 'video-autoworker-n8n-workflow-transition-rollback-authorization/v1' ]]; then
  TRANSITION_ROLLBACK_MODE=true
elif [[ "$RECEIPT_SCHEMA" != 'video-autoworker-n8n-managed-workflow-restore-confirmation/v2' ]]; then
  fail 'confirmation receipt schema is unsupported'
fi

verify_current_receipt() {
  local command=verify-receipt
  [[ "$DISASTER_MODE" == true ]] && command=verify-disaster-receipt
  [[ "$TRANSITION_ROLLBACK_MODE" == true ]] && command=verify-transition-rollback-receipt
  "$NODE_BIN" "$VALIDATOR" "$command" \
    --receipt "$RECEIPT" --package "$PACKAGE" --database "$DATABASE" \
    --runtime-release "$RUNTIME_RELEASE" --source-commit "$SOURCE_COMMIT" \
    --n8n-version "$N8N_VERSION" >/dev/null \
    || fail 'current confirmation receipt validation failed'
}

TEMP_ROOT="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
TEMP_DIR="$(mktemp -d "$TEMP_ROOT/n8n-managed-workflow-restore.XXXXXX")"
cleanup() {
  rm -rf -- "$TEMP_DIR"
  release_maintenance
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

managed_journal() {
  local operation="$1" workflow_id="${2:--}"
  local command=restore-journal
  [[ "$DISASTER_MODE" == true ]] && command=disaster-journal
  [[ "$TRANSITION_ROLLBACK_MODE" == true ]] && command=transition-rollback-journal
  "$NODE_BIN" "$VALIDATOR" "$command" \
    --receipt "$RECEIPT" --package "$PACKAGE" --database "$DATABASE" \
    --runtime-release "$RUNTIME_RELEASE" --source-commit "$SOURCE_COMMIT" \
    --n8n-version "$N8N_VERSION" --operation "$operation" --workflow-id "$workflow_id"
}

JOURNAL_STATUS='{"completedWorkflows":[]}'
assert_n8n_stopped
if [[ "$DISASTER_MODE" == true ]]; then
  verify_current_receipt
fi
JOURNAL_STATUS="$(managed_journal claim)" \
  || fail 'unable to claim or resume the managed workflow restore journal'

workflow_completed() {
  AIWORKER_RESTORE_STATUS="$JOURNAL_STATUS" "$NODE_BIN" -e '
    const value = JSON.parse(process.env.AIWORKER_RESTORE_STATUS)
    process.exit(Array.isArray(value.completedWorkflows) && value.completedWorkflows.includes(process.argv[1]) ? 0 : 1)
  ' "$1"
}

current_workflow() {
  if [[ "$DISASTER_MODE" == true ]]; then
    return
  fi
  AIWORKER_RESTORE_STATUS="$JOURNAL_STATUS" "$NODE_BIN" -e '
    const value = JSON.parse(process.env.AIWORKER_RESTORE_STATUS)
    if (value.currentWorkflow !== null && typeof value.currentWorkflow !== "string") process.exit(1)
    process.stdout.write(value.currentWorkflow || "")
  '
}

MUTATION_STARTED=false
authorize_first_mutation() {
  if [[ "$MUTATION_STARTED" == false ]]; then
    assert_n8n_stopped
    MUTATION_STARTED=true
  fi
}

official_cli() {
  "$NODE_BIN" "$CLI" "$@"
}

workflow_ids() {
  official_cli list:workflow --onlyId
}

active_workflow_ids() {
  official_cli list:workflow --active=true --onlyId
}

desired_active() {
  AIWORKER_N8N_PACKAGE_SUMMARY="$PACKAGE_SUMMARY" "$NODE_BIN" -e '
    const summary = JSON.parse(process.env.AIWORKER_N8N_PACKAGE_SUMMARY)
    const item = summary.workflows.find(value => value.id === process.argv[1])
    if (!item || typeof item.active !== "boolean") process.exit(1)
    process.stdout.write(item.active ? "true" : "false")
  ' "$1"
}

workflow_matches_target() {
  local workflow_id="$1" expected_active="$2" listed active_list exported
  listed="$(workflow_ids)" || return 1
  [[ "$(grep -Fxc "$workflow_id" <<< "$listed" || true)" == '1' ]] || return 1
  active_list="$(active_workflow_ids)" || return 1
  if [[ "$expected_active" == 'true' ]]; then
    [[ "$(grep -Fxc "$workflow_id" <<< "$active_list" || true)" == '1' ]] || return 1
  elif grep -Fqx "$workflow_id" <<< "$active_list"; then
    return 1
  fi
  exported="$TEMP_DIR/resume-$workflow_id.json"
  official_cli export:workflow --id="$workflow_id" --output="$exported" >/dev/null || return 1
  chmod 600 "$exported"
  "$NODE_BIN" "$VALIDATOR" verify-export \
    --package "$PACKAGE" --id "$workflow_id" --export "$exported" >/dev/null 2>&1
}

begin_workflow_mutation() {
  local workflow_id="$1"
  assert_n8n_stopped
  if [[ "$DISASTER_MODE" == false ]]; then
    JOURNAL_STATUS="$(managed_journal start "$workflow_id")" \
      || fail "unable to journal started managed workflow $workflow_id"
  fi
  authorize_first_mutation
}

restore_one() {
  local workflow_id="$1" workflow_file="$2" expected_active listed count active_list exported in_progress
  expected_active="$(desired_active "$workflow_id")" || fail "package active state is unavailable for $workflow_id"
  if workflow_completed "$workflow_id"; then
    return
  fi
  in_progress="$(current_workflow)" || fail 'managed workflow restore journal status is invalid'
  if [[ "$in_progress" == "$workflow_id" ]] && workflow_matches_target "$workflow_id" "$expected_active"; then
    assert_n8n_stopped
    JOURNAL_STATUS="$(managed_journal workflow "$workflow_id")" \
      || fail "unable to journal recovered managed workflow $workflow_id"
    return
  fi
  listed="$(workflow_ids)" || fail 'official n8n workflow listing failed'
  count="$(grep -Fxc "$workflow_id" <<< "$listed" || true)"
  [[ "$count" == '0' || "$count" == '1' ]] || fail "workflow ID $workflow_id is duplicated"
  if [[ "$count" == '1' ]]; then
    begin_workflow_mutation "$workflow_id"
    official_cli unpublish:workflow --id="$workflow_id" >/dev/null \
      || fail "unable to unpublish $workflow_id"
  fi
  assert_n8n_stopped
  begin_workflow_mutation "$workflow_id"
  official_cli import:workflow --input="$PACKAGE/$workflow_file" >/dev/null \
    || fail "unable to import $workflow_id"
  listed="$(workflow_ids)" || fail 'official n8n workflow listing failed after import'
  [[ "$(grep -Fxc "$workflow_id" <<< "$listed" || true)" == '1' ]] \
    || fail "fixed workflow $workflow_id was not imported exactly once"
  assert_n8n_stopped
  if [[ "$expected_active" == 'true' ]]; then
    official_cli publish:workflow --id="$workflow_id" >/dev/null \
      || fail "unable to publish $workflow_id"
  else
    active_list="$(active_workflow_ids)" || fail 'official n8n active workflow listing failed after import'
    if grep -Fqx "$workflow_id" <<< "$active_list"; then
      official_cli unpublish:workflow --id="$workflow_id" >/dev/null \
        || fail "unable to retain inactive state for $workflow_id"
    fi
  fi
  active_list="$(active_workflow_ids)" || fail 'official n8n active workflow listing failed'
  if [[ "$expected_active" == 'true' ]]; then
    [[ "$(grep -Fxc "$workflow_id" <<< "$active_list" || true)" == '1' ]] \
      || fail "workflow $workflow_id did not return to active state"
  elif grep -Fqx "$workflow_id" <<< "$active_list"; then
    fail "workflow $workflow_id unexpectedly became active"
  fi
  exported="$TEMP_DIR/$workflow_id.json"
  official_cli export:workflow --id="$workflow_id" --output="$exported" >/dev/null \
    || fail "unable to export restored workflow $workflow_id"
  chmod 600 "$exported"
  "$NODE_BIN" "$VALIDATOR" verify-export \
    --package "$PACKAGE" --id "$workflow_id" --export "$exported" >/dev/null \
    || fail "semantic verification failed for $workflow_id"
  assert_n8n_stopped
  if [[ "${NODE_ENV:-}" == 'test'
    && "${AIWORKER_TEST_N8N_CRASH_AFTER_ID:-}" == "$workflow_id"
    && -n "${AIWORKER_TEST_N8N_CRASH_MARKER:-}"
    && ! -e "${AIWORKER_TEST_N8N_CRASH_MARKER}" ]]; then
    "$NODE_BIN" -e '
      require("node:fs").writeFileSync(process.argv[1], "crashed\n", { mode: 0o600, flag: "wx" })
    ' "$AIWORKER_TEST_N8N_CRASH_MARKER"
    kill -9 "$$"
  fi
  JOURNAL_STATUS="$(managed_journal workflow "$workflow_id")" \
    || fail "unable to journal completed managed workflow $workflow_id"
}

restore_one 'aiworker-task-intake-v1' 'aiworker-task-intake-v1.json'
restore_one 'aiworker-video-analysis-v1' 'aiworker-video-analysis-v1.json'

SENTINEL_AFTER="$("$NODE_BIN" "$VALIDATOR" database-sentinel \
  --database "$DATABASE" --module-root "$RUNTIME_DIR")" \
  || fail 'post-restore database sentinel failed'
[[ "$SENTINEL_AFTER" == "$SENTINEL_BEFORE" ]] \
  || fail 'unrelated workflow, settings, or execution sentinel changed during restore'
assert_n8n_stopped

managed_journal verified >/dev/null || fail 'unable to verify the managed workflow restore journal'
if [[ "${NODE_ENV:-}" == 'test'
  && "${AIWORKER_TEST_N8N_CRASH_AFTER_RESTORE_VERIFIED:-}" == '1'
  && -n "${AIWORKER_TEST_N8N_VERIFIED_CRASH_MARKER:-}"
  && ! -e "${AIWORKER_TEST_N8N_VERIFIED_CRASH_MARKER}" ]]; then
  "$NODE_BIN" -e '
    require("node:fs").writeFileSync(process.argv[1], "crashed\n", { mode: 0o600, flag: "wx" })
  ' "$AIWORKER_TEST_N8N_VERIFIED_CRASH_MARKER"
  kill -9 "$$"
fi
managed_journal committed >/dev/null || fail 'unable to commit the managed workflow restore journal'

AIWORKER_N8N_PACKAGE_SUMMARY="$PACKAGE_SUMMARY" "$NODE_BIN" -e '
  const summary = JSON.parse(process.env.AIWORKER_N8N_PACKAGE_SUMMARY)
  process.stdout.write(JSON.stringify({
    schema: "video-autoworker-n8n-managed-workflow-restore-result/v1",
    restored: summary.workflows.map(({ id, active, semanticSha256 }) => ({
      id, active, semanticSha256,
    })),
    unrelatedStatePreserved: true,
  }) + "\n")
'
