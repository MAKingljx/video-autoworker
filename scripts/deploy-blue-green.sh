#!/usr/bin/env bash

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
RUN_DIR="${AIWORKER_BG_RUN_DIR:-$PROJECT_ROOT/.run/blue-green}"
RELEASES_DIR="${AIWORKER_BG_RELEASES_DIR:-$PROJECT_ROOT/.runtime/releases}"
STATE_FILE="${AIWORKER_BG_ROUTER_STATE:-$RUN_DIR/router-state.json}"
LOCK_DIR="$RUN_DIR/.deployment.lock"
AUDITOR="$PROJECT_ROOT/scripts/check-standalone-artifact.mjs"
DIRECTOR_VIDEO_READINESS="$PROJECT_ROOT/scripts/verify-director-video-release-readiness.mjs"
SHARED_DEPLOYMENT_LOCK_SHELL="$PROJECT_ROOT/scripts/lib/shared-deployment-lock.sh"
NODE_BIN="${NODE_BIN:-node}"
ROUTER_HOST="${AIWORKER_BG_ROUTER_HOST:-127.0.0.1}"
ROUTER_PORT="${AIWORKER_BG_ROUTER_PORT:-3017}"
BLUE_PORT="${AIWORKER_BG_BLUE_PORT:-3317}"
GREEN_PORT="${AIWORKER_BG_GREEN_PORT:-3417}"
PROBE_PATH="${AIWORKER_BG_PROBE_PATH:-/login}"
READINESS_PATH="${AIWORKER_BG_READINESS_PATH:-/api/n8n/release-readiness}"
DRAIN_PATH="${AIWORKER_BG_DRAIN_PATH:-/api/n8n/drain-status}"
SCHEDULER_PATH="${AIWORKER_BG_SCHEDULER_PATH:-/api/scheduler}"
LIVE_DB_PATH="${AIWORKER_BG_LIVE_DB_PATH:-}"
N8N_DB_PATH="${AIWORKER_BG_N8N_DB_PATH:-}"
CONTROL_TOKEN_FILE="${AIWORKER_BG_CONTROL_TOKEN_FILE:-}"
CONTROL_TOKEN="${AIWORKER_BG_CONTROL_TOKEN:-${API_KEY:-}}"
HTTP_TIMEOUT_MS="${AIWORKER_BG_HTTP_TIMEOUT_MS:-8000}"
BOOTSTRAP_EVIDENCE_MAX_AGE="${AIWORKER_BG_BOOTSTRAP_EVIDENCE_MAX_AGE:-300}"
LEADER_TIMEOUT_SECONDS="${AIWORKER_BG_LEADER_TIMEOUT_SECONDS:-90}"
RETIRE_QUIESCE_WAIT_SECONDS="${AIWORKER_BG_RETIRE_QUIESCE_WAIT_SECONDS:-900}"
STAGING_WORK_ROOT=""
BOOTSTRAP_MAINTENANCE=0
DEPLOYMENT_SOURCE_GATE_COMPLETE=0

cleanup_operation() {
  if [[ -n "$STAGING_WORK_ROOT" ]]; then
    local physical_releases=""
    physical_releases="$(physical_path "$RELEASES_DIR" 2>/dev/null || true)"
    case "$STAGING_WORK_ROOT" in
      "$physical_releases"/.staging-*) rm -rf -- "$STAGING_WORK_ROOT" ;;
    esac
  fi
  if [[ "${DEPLOYMENT_LOCK_OWNED:-0}" == 1 ]]; then
    release_shared_deployment_lock \
      || printf 'error: unable to release the shared deployment lock safely\n' >&2
  fi
  if (( BOOTSTRAP_MAINTENANCE == 1 )); then
    printf 'error: bootstrap remains in externally frozen maintenance mode; do not reopen ingress\n' >&2
  fi
}

usage() {
  cat <<'EOF'
Usage:
  deploy-blue-green.sh init [blue|green]
  deploy-blue-green.sh bootstrap <blue|green> <baseline-release-id> <absolute-standalone-root> <absolute-evidence-json> <absolute-rollback-proof-json> <absolute-confirmed-attempt-dir>
  deploy-blue-green.sh stage <release-id> <absolute-source-standalone-root>
  deploy-blue-green.sh bind <blue|green> <release-id> <absolute-standalone-root>
  deploy-blue-green.sh probe <blue|green>
  deploy-blue-green.sh retire <blue|green>
  deploy-blue-green.sh switch <blue|green>
  deploy-blue-green.sh rollback
  deploy-blue-green.sh status
  deploy-blue-green.sh attest-current

The router remains on port 3017. Backends default to blue=3317 and green=3417.
`stage` copies an already built and audited standalone artifact into a new,
non-overwritable release directory, regenerates its manifest, re-audits it, and
atomically publishes it under .runtime/releases.
`retire` records a one-use retirement proof only after the previous active
release reports that its release-owned callbacks are drained. Rebinding a slot
that has carried production traffic requires that proof and a stopped old PID.
`switch` and `rollback` require AIWORKER_BG_LIVE_DB_PATH, an `active` runtime
attestation for the same canonical SQLite database, and a paused intake gate.
They verify the selected release through port 3017 and automatically roll back
if the routed read-only checks fail. Ordinary switch and explicit rollback are
contract-preserving only; a different director projection contract is rejected
even at zero work. They do not stop either backend or mutate application data.
Set AIWORKER_BG_CONTROL_TOKEN_FILE to a mode-0600 file that
contains the viewer/admin API token (or inject AIWORKER_BG_CONTROL_TOKEN).
`bootstrap` is the only supported migration from a legacy single-process 3017.
It accepts only mode-0600 managed v3 evidence produced while the managed
legacy freeze guard holds a real BEGIN IMMEDIATE reservation on the authoritative
Mission Control and n8n databases in that fixed order; hand-written JSON is rejected. Two stable zero-work
samples and an integrity-checked rollback proof are required. The evidence
binds the target slot/release/manifest, persistent queue digest, live
Mission Control and n8n SQLite files, and exact process identities. The two
fixed n8n workflows must already be active, published from the workflow files
in this Git HEAD, and implement the slot-v1 execution-owner callback protocol.
Bootstrap verifies that contract and both databases read-only before and after
stopping only the evidenced 3017 PID, then writes the permanent gate-aware
baseline; it never imports workflows, restarts n8n, or restarts the legacy PID.
EOF
}

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

verify_deployment_source_gate() {
  (( DEPLOYMENT_SOURCE_GATE_COMPLETE == 0 )) || return 0
  local invoked_path expected_path git_root head relative absolute worktree_blob head_blob status
  local -a critical_paths=(
    scripts/deploy-blue-green.sh
    scripts/lib/shared-deployment-lock.sh
    scripts/lib/shared-deployment-lock.mjs
    scripts/check-standalone-artifact.mjs
    scripts/check-sensitive-content.mjs
    scripts/lib/sensitive-value-scanner.mjs
    scripts/verify-director-video-release-readiness.mjs
    scripts/lib/director-extraction-release-provenance.mjs
    scripts/lib/openclaw-runtime-convergence.mjs
    scripts/manage-blue-green-services.sh
    scripts/install-blue-green-launch-agents.sh
    scripts/start-standalone-slot.sh
    scripts/generate-legacy-freeze-evidence.mjs
    scripts/generate-legacy-bootstrap-rollback-proof.mjs
    scripts/legacy-freeze-guard.mjs
    scripts/legacy-bootstrap-controller.mjs
    scripts/verify-n8n-blue-green-workflows.mjs
    ops/n8n/workflows/aiworker-task-intake.json
    ops/n8n/workflows/aiworker-video-analysis.json
  )
  [[ ! -L "${BASH_SOURCE[0]}" ]] || fail "deploy entrypoint must not be a symbolic link"
  invoked_path="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/$(basename "${BASH_SOURCE[0]}")"
  expected_path="$PROJECT_ROOT/scripts/deploy-blue-green.sh"
  [[ "$invoked_path" == "$expected_path" && -f "$expected_path" && ! -L "$expected_path" ]] \
    || fail "deploy entrypoint path does not match the canonical repository script"
  git_root="$(GIT_OPTIONAL_LOCKS=0 git -C "$PROJECT_ROOT" rev-parse --show-toplevel 2>/dev/null)" \
    || fail "deployment source is not inside a Git worktree"
  git_root="$(cd "$git_root" && pwd -P)"
  [[ "$git_root" == "$PROJECT_ROOT" ]] \
    || fail "deployment source Git root does not match the repository root"
  head="$(GIT_OPTIONAL_LOCKS=0 git -C "$PROJECT_ROOT" rev-parse --verify 'HEAD^{commit}' 2>/dev/null)" \
    || fail "deployment source has no complete Git HEAD"
  [[ "$head" =~ ^[a-f0-9]{40}$ ]] || fail "deployment source Git HEAD is invalid"
  for relative in "${critical_paths[@]}"; do
    absolute="$PROJECT_ROOT/$relative"
    [[ -f "$absolute" && ! -L "$absolute" ]] \
      || fail "critical deployment source is missing or unsafe: $relative"
    GIT_OPTIONAL_LOCKS=0 git -C "$PROJECT_ROOT" ls-files --error-unmatch -- "$relative" >/dev/null 2>&1 \
      || fail "critical deployment source is not tracked: $relative"
    head_blob="$(GIT_OPTIONAL_LOCKS=0 git -C "$PROJECT_ROOT" rev-parse "HEAD:$relative" 2>/dev/null)" \
      || fail "critical deployment source is absent from Git HEAD: $relative"
    worktree_blob="$(GIT_OPTIONAL_LOCKS=0 git -C "$PROJECT_ROOT" hash-object -- "$absolute" 2>/dev/null)" \
      || fail "unable to hash critical deployment source: $relative"
    [[ "$head_blob" =~ ^[a-f0-9]{40}$ && "$worktree_blob" == "$head_blob" ]] \
      || fail "critical deployment source differs from Git HEAD: $relative"
  done
  status="$(GIT_OPTIONAL_LOCKS=0 git -C "$PROJECT_ROOT" status --porcelain=v1 --untracked-files=all 2>/dev/null)" \
    || fail "unable to verify deployment source worktree state"
  [[ -z "$status" ]] \
    || fail "deployment source worktree and index must be clean before any blue-green mutation"
  DEPLOYMENT_SOURCE_GATE_COMPLETE=1
}

verify_director_video_release_chain() {
  local release_id="$1"
  local release_root="$2"
  local repository_release_mode="${3:-head}"
  local report
  [[ "$repository_release_mode" == head || "$repository_release_mode" == ancestor ]] \
    || { printf 'error: invalid director/video repository release mode\n' >&2; return 1; }
  [[ -f "$DIRECTOR_VIDEO_READINESS" && ! -L "$DIRECTOR_VIDEO_READINESS" ]] \
    || { printf 'error: director/video release-readiness verifier is unavailable\n' >&2; return 1; }
  report="$("$NODE_BIN" "$DIRECTOR_VIDEO_READINESS" \
    --repository-root "$PROJECT_ROOT" \
    --releases-root "$RELEASES_DIR" \
    --release-id "$release_id" \
    --release-root "$release_root" \
    --live-db-path "$LIVE_DB_PATH" \
    --repository-release-mode "$repository_release_mode" \
    --verification-phase full)" \
    || { printf 'error: 3017, video-command, task-flow, director-brain, or projection outbox is incompatible\n' >&2; return 1; }
  "$NODE_BIN" - "$report" "$release_id" <<'NODE' \
    || { printf 'error: director/video release-readiness verifier returned an invalid report\n' >&2; return 1; }
const [raw, releaseId] = process.argv.slice(2)
let value
try { value = JSON.parse(raw) } catch { process.exit(2) }
const digest = value?.payloads?.projectionContract?.currentDigest
const commitPrefix = releaseId.replace(/-runtime$/u, '')
if (value?.schema !== 'video-autoworker-director-video-readiness/v1'
  || value?.ok !== true || value?.app?.releaseId !== releaseId
  || typeof value?.commit !== 'string' || !/^[a-f0-9]{40}$/u.test(value.commit)
  || !value.commit.startsWith(commitPrefix)
  || typeof digest !== 'string' || !/^[a-f0-9]{64}$/u.test(digest)
  || value?.projectionOutbox?.currentDigest !== digest
  || value?.projectionOutbox?.incompatiblePending !== 0
  || value?.projectionOutbox?.deliveredWithoutValidReceipt !== 0
  || value?.projectionOutbox?.outOfScopeOutbox !== 0
  || value?.projectionOutbox?.outOfScopeExtraction !== 0
  || value?.extraction?.schema !== 'video-autoworker-director-extraction-readiness/v1'
  || value?.extraction?.expectedProjectionVersion !== 'feishu-candidate-projection-v2'
  || value?.extraction?.activePhases !== 0
  || value?.extraction?.sourcesWithoutPhase !== 0
  || value?.extraction?.invalidPhaseBindings !== 0
  || value?.extraction?.invalidCheckpoints !== 0
  || value?.extraction?.invalidProjectionReceipts !== 0
  || value?.extraction?.invalidReviewReceipts !== 0
  || value?.extraction?.missingPredecessorReviews !== 0
  || value?.extraction?.incompatibleProjectionBoundary !== 0
  || value?.contracts?.directorWork !== true
  || value?.contracts?.outboxClosure !== true
  || value?.contracts?.extractionSourceProvenance !== true
  || value?.contracts?.standaloneArtifactContentBound !== true
  || value?.contracts?.projectionContractCompatible !== true
  || value?.contracts?.extractionLifecycleComplete !== true
  || value?.contracts?.sessionScopedRuntimeConvergence !== true
  || value?.runtimeConvergence?.schema
    !== 'video-autoworker-openclaw-runtime-convergence-proof/v1'
  || value?.provenance?.schema !== 'video-autoworker-standalone-provenance/v2'
  || value?.provenance?.gitCommit !== value.commit
  || !Number.isSafeInteger(value?.provenance?.sourceFiles)
  || value.provenance.sourceFiles < 1
  || typeof value?.provenance?.sha256 !== 'string'
  || !/^[a-f0-9]{64}$/u.test(value.provenance.sha256)
  || value?.provenance?.artifactContent?.schema
    !== 'video-autoworker-standalone-artifact-content/v1'
  || value?.provenance?.artifactContent?.algorithm !== 'sha256'
  || typeof value?.provenance?.artifactContent?.digest !== 'string'
  || !/^[a-f0-9]{64}$/u.test(value.provenance.artifactContent.digest)
  || !Number.isSafeInteger(value?.provenance?.artifactContent?.directories)
  || value.provenance.artifactContent.directories < 0
  || !Number.isSafeInteger(value?.provenance?.artifactContent?.files)
  || value.provenance.artifactContent.files < 1
  || !Number.isSafeInteger(value?.provenance?.artifactContent?.symlinks)
  || value.provenance.artifactContent.symlinks < 0
  || typeof value?.runtimeConvergence?.sessionKeySha256 !== 'string'
  || !/^[a-f0-9]{64}$/u.test(value.runtimeConvergence.sessionKeySha256)) process.exit(3)
process.stdout.write(digest)
NODE
}

verify_director_video_release_preflight() {
  local release_id="$1"
  local release_root="$2"
  local report
  [[ -f "$DIRECTOR_VIDEO_READINESS" && ! -L "$DIRECTOR_VIDEO_READINESS" ]] \
    || { printf 'error: director/video release-readiness verifier is unavailable\n' >&2; return 1; }
  report="$("$NODE_BIN" "$DIRECTOR_VIDEO_READINESS" \
    --repository-root "$PROJECT_ROOT" \
    --releases-root "$RELEASES_DIR" \
    --release-id "$release_id" \
    --release-root "$release_root" \
    --repository-release-mode head \
    --verification-phase pre-bootstrap)" \
    || { printf 'error: immutable release, installed payload, or runtime convergence preflight failed\n' >&2; return 1; }
  "$NODE_BIN" - "$report" "$release_id" <<'NODE' \
    || { printf 'error: director/video pre-bootstrap verifier returned an invalid report\n' >&2; return 1; }
const [raw, releaseId] = process.argv.slice(2)
let value
try { value = JSON.parse(raw) } catch { process.exit(2) }
const digest = value?.payloads?.projectionContract?.currentDigest
const commitPrefix = releaseId.replace(/-runtime$/u, '')
if (value?.schema !== 'video-autoworker-director-video-preflight/v1'
  || value?.phase !== 'pre-bootstrap' || value?.ok !== true
  || value?.app?.releaseId !== releaseId
  || typeof value?.commit !== 'string' || !/^[a-f0-9]{40}$/u.test(value.commit)
  || !value.commit.startsWith(commitPrefix)
  || typeof digest !== 'string' || !/^[a-f0-9]{64}$/u.test(digest)
  || value?.provenance?.schema !== 'video-autoworker-standalone-provenance/v2'
  || value?.provenance?.gitCommit !== value.commit
  || value?.provenance?.artifactContent?.schema
    !== 'video-autoworker-standalone-artifact-content/v1'
  || value?.runtimeConvergence?.schema
    !== 'video-autoworker-openclaw-runtime-convergence-proof/v1'
  || value?.contracts?.directorWork !== true
  || value?.contracts?.outboxClosure !== true
  || value?.contracts?.extractionSourceProvenance !== true
  || value?.contracts?.standaloneArtifactContentBound !== true
  || value?.contracts?.sessionScopedRuntimeConvergence !== true) process.exit(3)
process.stdout.write(digest)
NODE
}

verify_active_director_projection_chain() {
  local active release_id release_root
  active="$(read_state_field active)"
  release_id="$(read_state_slot_release "$active")"
  release_root="$(binding_values "$active" | sed -n '2p')" \
    || { printf 'error: active slot binding is invalid\n' >&2; return 1; }
  [[ "$release_root" == /* ]] \
    || { printf 'error: active slot release root is invalid\n' >&2; return 1; }
  verify_director_video_release_chain "$release_id" "$release_root" ancestor >/dev/null
}

require_slot() {
  case "${1:-}" in
    blue|green) printf '%s\n' "$1" ;;
    *) fail "slot must be blue or green" ;;
  esac
}

slot_port() {
  case "$1" in
    blue) printf '%s\n' "$BLUE_PORT" ;;
    green) printf '%s\n' "$GREEN_PORT" ;;
  esac
}

assert_absolute() {
  [[ "$2" == /* ]] || fail "$1 must be an absolute path: $2"
}

assert_safe_integer() {
  [[ "$2" =~ ^[1-9][0-9]*$ ]] || fail "$1 must be a positive integer"
  (( 10#$2 <= 65535 )) || fail "$1 exceeds 65535"
}

validate_run_configuration() {
  assert_absolute "AIWORKER_BG_RUN_DIR" "$RUN_DIR"
  assert_absolute "AIWORKER_BG_RELEASES_DIR" "$RELEASES_DIR"
  [[ "$PROBE_PATH" == /* && "$PROBE_PATH" != *[$'\r\n ']* ]] \
    || fail "AIWORKER_BG_PROBE_PATH must be one local absolute HTTP path"
  [[ "$READINESS_PATH" == /* && "$READINESS_PATH" != *[$'\r\n ']* ]] \
    || fail "AIWORKER_BG_READINESS_PATH must be one local absolute HTTP path"
  [[ "$DRAIN_PATH" == /* && "$DRAIN_PATH" != *[$'\r\n ']* ]] \
    || fail "AIWORKER_BG_DRAIN_PATH must be one local absolute HTTP path"
  [[ "$SCHEDULER_PATH" == /* && "$SCHEDULER_PATH" != *[$'\r\n ']* ]] \
    || fail "AIWORKER_BG_SCHEDULER_PATH must be one local absolute HTTP path"
  [[ "$HTTP_TIMEOUT_MS" =~ ^[1-9][0-9]*$ ]] && (( 10#$HTTP_TIMEOUT_MS <= 30000 )) \
    || fail "AIWORKER_BG_HTTP_TIMEOUT_MS must be between 1 and 30000"
  [[ "$BOOTSTRAP_EVIDENCE_MAX_AGE" =~ ^[1-9][0-9]*$ ]] \
    && (( 10#$BOOTSTRAP_EVIDENCE_MAX_AGE >= 30 && 10#$BOOTSTRAP_EVIDENCE_MAX_AGE <= 1800 )) \
    || fail "AIWORKER_BG_BOOTSTRAP_EVIDENCE_MAX_AGE must be between 30 and 1800"
  [[ "$LEADER_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] \
    && (( 10#$LEADER_TIMEOUT_SECONDS >= 15 && 10#$LEADER_TIMEOUT_SECONDS <= 300 )) \
    || fail "AIWORKER_BG_LEADER_TIMEOUT_SECONDS must be between 15 and 300"
  [[ "$RETIRE_QUIESCE_WAIT_SECONDS" =~ ^[1-9][0-9]*$ ]] \
    && (( 10#$RETIRE_QUIESCE_WAIT_SECONDS >= 30 && 10#$RETIRE_QUIESCE_WAIT_SECONDS <= 14400 )) \
    || fail "AIWORKER_BG_RETIRE_QUIESCE_WAIT_SECONDS must be between 30 and 14400"
}

prepare_run_dir() {
  validate_run_configuration
  mkdir -p "$RUN_DIR/slots" "$RELEASES_DIR"
  chmod 700 "$RUN_DIR" "$RUN_DIR/slots"
}

assert_existing_run_layout() {
  validate_run_configuration
  [[ -d "$RUN_DIR" && ! -L "$RUN_DIR" ]] || fail "blue-green run directory does not exist"
  [[ -d "$RUN_DIR/slots" && ! -L "$RUN_DIR/slots" ]] || fail "blue-green slots directory does not exist"
  [[ -d "$RELEASES_DIR" && ! -L "$RELEASES_DIR" ]] || fail "blue-green releases directory does not exist"
}

acquire_lock() {
  verify_deployment_source_gate
  # Source only after its exact HEAD blob has passed the fail-closed gate.
  # shellcheck source=scripts/lib/shared-deployment-lock.sh
  source "$SHARED_DEPLOYMENT_LOCK_SHELL"
  DEPLOYMENT_RUN_DIR="$RUN_DIR"
  DEPLOYMENT_LOCK_DIR="$LOCK_DIR"
  export DEPLOYMENT_RUN_DIR DEPLOYMENT_LOCK_DIR
  acquire_shared_deployment_lock \
    || fail "another blue-green operation holds $LOCK_DIR or its stale owner is unsafe"
  trap cleanup_operation EXIT
  prepare_run_dir
}

validate_release_id() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$ ]] \
    || fail "release id must use 1-160 letters, numbers, dot, underscore or dash"
}

physical_path() {
  "$NODE_BIN" -e 'process.stdout.write(require("node:fs").realpathSync.native(process.argv[1]))' "$1"
}

release_manifest_sha() {
  file_sha256 "$1/release-manifest.json"
}

file_sha256() {
  shasum -a 256 "$1" | awk '{print $1}'
}

assert_release() {
  local release_id="$1"
  local standalone_root="$2"
  local physical_releases physical_expected physical_root
  validate_release_id "$release_id"
  assert_absolute "standalone release root" "$standalone_root"
  [[ -d "$standalone_root" && ! -L "$standalone_root" ]] || fail "standalone release root is not a physical directory"
  physical_releases="$(physical_path "$RELEASES_DIR")"
  physical_expected="$physical_releases/$release_id/standalone"
  physical_root="$(physical_path "$standalone_root")"
  [[ "$physical_root" == "$physical_expected" ]] \
    || fail "release root must resolve to $physical_expected"
  [[ -f "$AUDITOR" ]] || fail "standalone artifact auditor is missing"
  "$NODE_BIN" "$AUDITOR" "$physical_root" >/dev/null \
    || fail "standalone release failed artifact verification"
  printf '%s\n' "$physical_root"
}

stage_release() {
  local release_id="${1:-}"
  local source_root="${2:-}"
  local physical_releases physical_source target_root staged_root source_manifest staged_manifest
  [[ -n "$release_id" && -n "$source_root" ]] || { usage >&2; exit 2; }
  acquire_lock
  validate_release_id "$release_id"
  assert_absolute "source standalone root" "$source_root"
  [[ -d "$source_root" && ! -L "$source_root" ]] || fail "source standalone root is not a physical directory"
  physical_releases="$(physical_path "$RELEASES_DIR")"
  physical_source="$(physical_path "$source_root")"
  case "$physical_releases" in
    "$physical_source"|"$physical_source"/*)
      fail "release directory must not be the source artifact or one of its descendants"
      ;;
  esac
  target_root="$physical_releases/$release_id"
  [[ ! -e "$target_root" && ! -L "$target_root" ]] || fail "release already exists: $target_root"
  [[ -f "$AUDITOR" ]] || fail "standalone artifact auditor is missing"
  "$NODE_BIN" "$AUDITOR" "$physical_source" >/dev/null \
    || fail "source standalone artifact failed verification"
  source_manifest="$(release_manifest_sha "$physical_source")"

  STAGING_WORK_ROOT="$(mktemp -d "$physical_releases/.staging-$release_id.XXXXXX")"
  chmod 700 "$STAGING_WORK_ROOT"
  staged_root="$STAGING_WORK_ROOT/standalone"
  mkdir "$staged_root"
  cp -pR "$physical_source/." "$staged_root/"
  "$NODE_BIN" "$AUDITOR" --write-manifest "$staged_root" >/dev/null \
    || fail "unable to regenerate staged release manifest"
  "$NODE_BIN" "$AUDITOR" "$staged_root" >/dev/null \
    || fail "staged standalone artifact failed verification"
  staged_manifest="$(release_manifest_sha "$staged_root")"
  [[ "$staged_manifest" == "$source_manifest" ]] \
    || fail "staged release does not reproduce the audited source manifest"
  [[ ! -e "$target_root" && ! -L "$target_root" ]] || fail "release target appeared during staging"
  mv "$STAGING_WORK_ROOT" "$target_root"
  STAGING_WORK_ROOT=""
  "$NODE_BIN" "$AUDITOR" "$target_root/standalone" >/dev/null \
    || fail "published immutable release failed final verification"
  printf 'Staged immutable release: %s manifest=%s\n' "$release_id" "$staged_manifest"
}

binding_file() {
  printf '%s/slots/%s.json\n' "$RUN_DIR" "$1"
}

runtime_attestation_file() {
  printf '%s/slots/%s.runtime.json\n' "$RUN_DIR" "$1"
}

router_attestation_file() {
  printf '%s/router.runtime.json\n' "$RUN_DIR"
}

retirement_file() {
  printf '%s/slots/%s.retired.json\n' "$RUN_DIR" "$1"
}

callback_freeze_file() {
  printf '%s/slots/%s.callbacks-frozen.json\n' "$RUN_DIR" "$1"
}

baseline_file() {
  printf '%s/baseline.json\n' "$RUN_DIR"
}

bootstrap_pending_file() {
  printf '%s/bootstrap.pending.json\n' "$RUN_DIR"
}

assert_bootstrap_operation_gate() {
  local requested="$1"
  shift || true
  local pending
  pending="$(bootstrap_pending_file)"
  if [[ ! -e "$pending" && ! -L "$pending" ]]; then return; fi
  assert_immutable_private_file "bootstrap pending marker" "$pending"
  case "$requested" in
    status) return ;;
    bootstrap)
      [[ "$#" -eq 6 ]] \
        || fail "bootstrap recovery requires the complete release, evidence, proof, and confirmed-attempt binding"
      return
      ;;
    *) fail "bootstrap recovery hold is active; only status or the fully bound bootstrap recovery may run" ;;
  esac
}

write_json_atomic() {
  local destination="$1"
  local payload="$2"
  "$NODE_BIN" - "$destination" "$payload" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const [destination, payload] = process.argv.slice(2)
const parentPath = path.dirname(destination)
const parentEntry = fs.lstatSync(parentPath, { bigint: true })
if (!path.isAbsolute(destination) || !parentEntry.isDirectory() || parentEntry.isSymbolicLink()
  || parentEntry.uid !== BigInt(process.getuid())
  || fs.realpathSync.native(parentPath) !== parentPath) process.exit(2)
const temporary = path.join(parentPath,
  `.${path.basename(destination)}.${crypto.randomBytes(16).toString('hex')}.tmp`)
let descriptor
try {
  descriptor = fs.openSync(temporary,
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
    0o600)
  const source = Buffer.from(`${payload}\n`)
  let offset = 0
  while (offset < source.length) offset += fs.writeSync(descriptor, source, offset, source.length - offset)
  fs.fsyncSync(descriptor)
  fs.fchmodSync(descriptor, 0o600)
  fs.closeSync(descriptor)
  descriptor = undefined
  fs.renameSync(temporary, destination)
  const published = fs.lstatSync(destination, { bigint: true })
  if (!published.isFile() || published.isSymbolicLink()
    || published.uid !== BigInt(process.getuid()) || (published.mode & 0o7777n) !== 0o600n
    || published.nlink !== 1n) process.exit(3)
  const parent = fs.openSync(parentPath, fs.constants.O_RDONLY)
  try { fs.fsyncSync(parent) } finally { fs.closeSync(parent) }
} catch (error) {
  try { if (descriptor !== undefined) fs.closeSync(descriptor) } catch {}
  try { fs.unlinkSync(temporary) } catch {}
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}
NODE
}

write_router_state_atomic() {
  local payload="$1"
  "$NODE_BIN" --input-type=module -e '
    const { pathToFileURL } = await import("node:url")
    const { writeRouterStateAtomic } = await import(pathToFileURL(process.argv[2]).href)
    writeRouterStateAtomic(process.argv[1], JSON.parse(process.argv[3]))
  ' "$STATE_FILE" "$SCRIPT_DIR/standalone-router.mjs" "$payload"
}

read_state_field() {
  "$NODE_BIN" -e '
    const fs = require("node:fs")
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
    const field = process.argv[2]
    const result = value[field]
    if (typeof result !== "string" && typeof result !== "number" && result !== null) process.exit(2)
    process.stdout.write(result === null ? "" : String(result))
  ' "$STATE_FILE" "$1"
}

read_state_slot_release() {
  "$NODE_BIN" -e '
    const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))
    const slot = process.argv[2]
    if (!value.slots || !value.slots[slot] || typeof value.slots[slot].releaseId !== "string") process.exit(2)
    process.stdout.write(value.slots[slot].releaseId)
  ' "$STATE_FILE" "$1"
}

validate_state() {
  [[ -f "$STATE_FILE" && ! -L "$STATE_FILE" ]] || fail "router state is missing or unsafe: $STATE_FILE"
  "$NODE_BIN" --input-type=module -e '
    const { pathToFileURL } = await import("node:url")
    const { readRouterState } = await import(pathToFileURL(process.argv[2]).href)
    readRouterState(process.argv[1])
  ' "$STATE_FILE" "$SCRIPT_DIR/standalone-router.mjs"
}

assert_secure_file() {
  local label="$1"
  local pathname="$2"
  [[ -f "$pathname" && ! -L "$pathname" && -O "$pathname" ]] || fail "$label is missing or unsafe"
  local mode group_digit other_digit
  mode="$(stat -f '%Lp' "$pathname" 2>/dev/null || stat -c '%a' "$pathname")"
  group_digit="${mode: -2:1}"
  other_digit="${mode: -1}"
  (( (10#$group_digit & 2) == 0 && (10#$other_digit & 2) == 0 )) \
    || fail "$label must not be writable by group or others"
}

assert_private_file() {
  local label="$1"
  local pathname="$2"
  assert_secure_file "$label" "$pathname"
  local mode
  mode="$(stat -f '%Lp' "$pathname" 2>/dev/null || stat -c '%a' "$pathname")"
  [[ "$mode" == 600 ]] || fail "$label must have mode 0600"
}

assert_immutable_private_file() {
  local label="$1"
  local pathname="$2"
  assert_secure_file "$label" "$pathname"
  local mode links
  mode="$(stat -f '%Lp' "$pathname" 2>/dev/null || stat -c '%a' "$pathname")"
  links="$(stat -f '%l' "$pathname" 2>/dev/null || stat -c '%h' "$pathname")"
  [[ "$mode" == 400 && "$links" == 1 ]] \
    || fail "$label must be an immutable mode-0400 single-link file"
}

write_json_immutable() {
  local destination="$1"
  local payload="$2"
  "$NODE_BIN" - "$destination" "$payload" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const [destination, payload] = process.argv.slice(2)
let descriptor
try {
  descriptor = fs.openSync(destination,
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
    0o600)
  const source = Buffer.from(`${payload}\n`)
  let offset = 0
  while (offset < source.length) offset += fs.writeSync(descriptor, source, offset, source.length - offset)
  fs.fsyncSync(descriptor)
  fs.fchmodSync(descriptor, 0o400)
  fs.closeSync(descriptor)
  descriptor = undefined
  const entry = fs.lstatSync(destination, { bigint: true })
  if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== BigInt(process.getuid())
    || (entry.mode & 0o7777n) !== 0o400n || entry.nlink !== 1n) process.exit(3)
  const parent = fs.openSync(path.dirname(destination), fs.constants.O_RDONLY)
  try { fs.fsyncSync(parent) } finally { fs.closeSync(parent) }
} catch (error) {
  try { if (descriptor !== undefined) fs.closeSync(descriptor) } catch {}
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(2)
}
NODE
}

remove_immutable_file_durable() {
  local label="$1"
  local pathname="$2"
  assert_immutable_private_file "$label" "$pathname"
  "$NODE_BIN" - "$pathname" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const pathname = process.argv[2]
const before = fs.lstatSync(pathname, { bigint: true })
const descriptor = fs.openSync(pathname, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
try {
  const opened = fs.fstatSync(descriptor, { bigint: true })
  const current = fs.lstatSync(pathname, { bigint: true })
  if (!opened.isFile() || opened.uid !== BigInt(process.getuid())
    || (opened.mode & 0o7777n) !== 0o400n || opened.nlink !== 1n
    || current.dev !== opened.dev || current.ino !== opened.ino
    || current.size !== opened.size || current.mtimeNs !== opened.mtimeNs
    || current.ctimeNs !== opened.ctimeNs) process.exit(2)
  fs.unlinkSync(pathname)
  const parent = fs.openSync(path.dirname(pathname), fs.constants.O_RDONLY)
  try { fs.fsyncSync(parent) } finally { fs.closeSync(parent) }
} finally { fs.closeSync(descriptor) }
NODE
}

read_control_token() {
  local token
  if [[ -n "$CONTROL_TOKEN_FILE" ]]; then
    assert_absolute "AIWORKER_BG_CONTROL_TOKEN_FILE" "$CONTROL_TOKEN_FILE"
    assert_private_file "blue-green control token file" "$CONTROL_TOKEN_FILE"
    token="$($NODE_BIN -e '
      const raw = require("node:fs").readFileSync(process.argv[1], "utf8")
      const token = raw.trim()
      if (!token || /[\r\n]/u.test(token)) process.exit(2)
      process.stdout.write(token)
    ' "$CONTROL_TOKEN_FILE")" || fail "blue-green control token file is invalid"
  else
    token="$CONTROL_TOKEN"
    [[ -n "$token" && "$token" != *[$'\r\n']* ]] \
      || fail "AIWORKER_BG_CONTROL_TOKEN_FILE or AIWORKER_BG_CONTROL_TOKEN is required"
  fi
  printf '%s' "$token"
}

check_json_endpoint() {
  local mode="$1"
  local url="$2"
  shift 2
  local token=""
  if [[ "$mode" != router && "$mode" != retire-router && "$mode" != health ]]; then
    token="$(read_control_token)"
  fi
  AIWORKER_BG_REQUEST_TOKEN="$token" AIWORKER_BG_REQUEST_TIMEOUT_MS="$HTTP_TIMEOUT_MS" \
    "$NODE_BIN" - "$mode" "$url" "$@" <<'NODE'
const [mode, url, ...expected] = process.argv.slice(2)
const timeoutMs = Number(process.env.AIWORKER_BG_REQUEST_TIMEOUT_MS)
const token = process.env.AIWORKER_BG_REQUEST_TOKEN || ''
const fail = message => {
  process.stderr.write(`blue-green ${mode} verification failed: ${message}\n`)
  process.exit(1)
}

let response
try {
  response = await fetch(url, {
    cache: 'no-store',
    headers: token ? { authorization: `Bearer ${token}`, accept: 'application/json' } : { accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  })
} catch {
  fail('endpoint unavailable')
}
if (!response.ok) fail(`HTTP ${response.status}`)
let payload
try { payload = await response.json() } catch { fail('response is not JSON') }

const nonNegativeInteger = value => Number.isSafeInteger(value) && value >= 0
const validRuntime = (runtime, slot, releaseId, rawPort) => runtime
  && runtime.callbackProtocol === 'slot-v1'
  && runtime.runtimeSlot === slot
  && runtime.runtimeReleaseId === releaseId
  && runtime.port === Number(rawPort)

if (mode === 'router') {
  const [slot, releaseId, rawGeneration] = expected
  if (payload?.schema !== 'video-autoworker-standalone-router-health/v1'
    || payload?.ok !== true || !Number.isSafeInteger(payload?.pid) || payload.pid <= 0
    || payload?.active !== slot || payload?.releaseId !== releaseId
    || payload?.generation !== Number(rawGeneration)) fail('router identity mismatch')
  process.stdout.write(String(payload.pid))
} else if (mode === 'retire-router') {
  const [activeSlot, releaseId, rawGeneration, retiringSlot] = expected
  const counters = payload?.counters?.[retiringSlot]
  if (payload?.schema !== 'video-autoworker-standalone-router-health/v1'
    || payload?.ok !== true || !Number.isSafeInteger(payload?.pid) || payload.pid <= 0
    || payload?.active !== activeSlot || payload?.releaseId !== releaseId
    || payload?.generation !== Number(rawGeneration) || !counters
    || !nonNegativeInteger(counters.activeRequests) || !nonNegativeInteger(counters.upgradedSockets)
    || counters.activeRequests !== 0 || counters.upgradedSockets !== 0) {
    fail('old slot still owns routed HTTP/SSE/WebSocket connections')
  }
  process.stdout.write(`${payload.pid}\n${JSON.stringify({
    routerActiveRequests: counters.activeRequests,
    routerUpgradedSockets: counters.upgradedSockets,
  })}`)
} else if (mode === 'readiness') {
  const [slot, releaseId, rawPort, expectedRevision, expectedEpoch, expectedGeneration,
    expectedProjectionContract] = expected
  const specified = value => value !== undefined && value !== ''
  const readiness = payload?.readiness
  if (!readiness || readiness.schema !== 'video-autoworker-release-readiness/v1'
    || readiness.globalScope !== true || !nonNegativeInteger(readiness.observedAt)) {
    fail('global readiness envelope is invalid')
  }
  const intake = readiness.intake
  if (!intake || intake.schema !== 'video-autoworker-intake-control/v1'
    || intake.accepting !== false || !['draining', 'paused'].includes(intake.mode)
    || !Number.isSafeInteger(intake.revision) || intake.revision < 1
    || (specified(expectedRevision) && intake.revision !== Number(expectedRevision))) {
    fail('global intake is not explicitly paused at the expected revision')
  }
  const intakeCounts = intake.counts
  if (!intakeCounts || !['queued', 'accepted', 'running', 'waiting', 'active']
    .every(key => nonNegativeInteger(intakeCounts[key]))) fail('global intake counts are invalid')
  if (intakeCounts.waiting !== intakeCounts.queued + intakeCounts.accepted
    || intakeCounts.active !== intakeCounts.waiting + intakeCounts.running
    || (intake.mode === 'paused' && intakeCounts.active !== 0)
    || (intake.mode === 'draining' && intakeCounts.active === 0)) fail('global intake mode/counts mismatch')
  if (!validRuntime(readiness.runtime, slot, releaseId, rawPort)) fail('runtime identity mismatch')
  const database = readiness.database
  if (!database || !Number.isSafeInteger(database.schemaEpoch) || database.schemaEpoch < 1
    || typeof database.rollingSafeFrom !== 'string' || !database.rollingSafeFrom
    || typeof database.latestMigration !== 'string' || !database.latestMigration
    || (specified(expectedEpoch) && database.schemaEpoch !== Number(expectedEpoch))) {
    fail('database rolling compatibility is invalid')
  }
  const projection = readiness.projection
  if (!projection
    || projection.schema !== 'video-autoworker-director-evidence-outbox-readiness/v1'
    || typeof projection.contractDigest !== 'string'
    || !/^[a-f0-9]{64}$/u.test(projection.contractDigest)
    || !nonNegativeInteger(projection.pending)
    || !nonNegativeInteger(projection.incompatiblePending)
    || projection.incompatiblePending > projection.pending
    || projection.incompatiblePending !== 0
    || (specified(expectedProjectionContract)
      && projection.contractDigest !== expectedProjectionContract)) {
    fail('director evidence projection contract is incompatible')
  }
  const drain = readiness.retirement
  const counts = drain?.counts
  if (!counts || !['tracked', 'active', 'queued', 'accepted', 'running', 'topLevel',
    'mediaNodes', 'modelNodes', 'childExecutionLeases', 'untrackedCallbacks', 'otherReleaseActive']
    .every(key => nonNegativeInteger(counts[key]))) fail('drain counts are invalid')
  const leadership = readiness.scheduler
  if (!leadership || !['leader', 'follower', 'inactive'].includes(leadership.state)
    || !nonNegativeInteger(leadership.activeJobs) || !nonNegativeInteger(leadership.observedAt)
    || !Number.isSafeInteger(leadership.routerGeneration) || leadership.routerGeneration < 1
    || (specified(expectedGeneration)
      && leadership.routerGeneration !== Number(expectedGeneration))
    || typeof leadership.reason !== 'string' || leadership.reason.length < 1
    || leadership.reason.length > 120 || typeof leadership.leaseExpired !== 'boolean') {
    fail('scheduler readiness is invalid')
  }
  if (leadership.state === 'inactive') {
    if (leadership.leaseExpiresAt !== null || leadership.leaseExpired !== false
      || leadership.activeJobs !== 0) fail('inactive scheduler readiness is inconsistent')
  } else if (!Number.isSafeInteger(leadership.leaseExpiresAt)
    || leadership.leaseExpiresAt < 0
    || (leadership.state === 'leader'
      && (leadership.leaseExpired || leadership.leaseExpiresAt <= readiness.observedAt))) {
    fail('scheduler lease readiness is inconsistent')
  }
  process.stdout.write(`${intake.revision}\n${database.schemaEpoch}\n${projection.contractDigest}\n${projection.pending}\n${projection.incompatiblePending}\n${intakeCounts.active}\n`)
} else if (mode === 'drain') {
  const [slot, releaseId, rawPort] = expected
  const drain = payload?.drain
  if (!drain || drain.schema !== 'video-autoworker-runtime-drain/v1'
    || drain.globalScope !== true || !validRuntime(drain.runtime, slot, releaseId, rawPort)) {
    fail('global drain envelope or runtime identity is invalid')
  }
  const counts = drain.counts
  if (!counts || !['tracked', 'active', 'queued', 'accepted', 'running', 'topLevel',
    'mediaNodes', 'modelNodes', 'childExecutionLeases', 'untrackedCallbacks', 'otherReleaseActive']
    .every(key => nonNegativeInteger(counts[key]))) fail('drain counts are invalid')
  if (drain.safeToRetire !== true || counts.active !== 0 || counts.untrackedCallbacks !== 0
    || counts.otherReleaseActive !== 0 || counts.childExecutionLeases !== 0
    || !nonNegativeInteger(drain.quietSeconds)
    || !nonNegativeInteger(drain.requiredQuietSeconds)
    || drain.quietSeconds < drain.requiredQuietSeconds
    || !nonNegativeInteger(drain.observedAt)
    || (drain.lastActivityAt !== null && !nonNegativeInteger(drain.lastActivityAt))) {
    fail('release is not safe to retire')
  }
  process.stdout.write(JSON.stringify({
    tracked: counts.tracked,
    active: counts.active,
    untrackedCallbacks: counts.untrackedCallbacks,
    otherReleaseActive: counts.otherReleaseActive,
    childExecutionLeases: counts.childExecutionLeases,
    lastActivityAt: drain.lastActivityAt,
    quietSeconds: drain.quietSeconds,
    requiredQuietSeconds: drain.requiredQuietSeconds,
    observedAt: drain.observedAt,
  }))
} else if (mode === 'health') {
  const database = Array.isArray(payload?.checks)
    ? payload.checks.find(check => check?.name === 'Database')
    : null
  if (!['healthy', 'warning', 'degraded'].includes(payload?.status)
    || !database || !['healthy', 'warning'].includes(database.status)
    || typeof payload?.version !== 'string' || !payload.version) fail('application health is not acceptable')
} else if (mode === 'scheduler') {
  const [rawGeneration] = expected
  const leadership = payload?.leadership
  if (!leadership || leadership.state !== 'inactive' || leadership.activeJobs !== 0
    || leadership.leaseExpiresAt !== null || leadership.routerGeneration !== Number(rawGeneration)
    || !nonNegativeInteger(leadership.observedAt)) fail('old scheduler is not fully relinquished')
  process.stdout.write(JSON.stringify({
    schedulerState: leadership.state,
    schedulerObservedAt: leadership.observedAt,
    schedulerRouterGeneration: leadership.routerGeneration,
  }))
} else if (mode === 'leader') {
  const [rawGeneration] = expected
  const leadership = payload?.leadership
  const now = Math.floor(Date.now() / 1000)
  if (!leadership || leadership.state !== 'leader' || leadership.reason !== 'slot_active'
    || leadership.leaseExpired !== false || !Number.isSafeInteger(leadership.leaseExpiresAt)
    || leadership.leaseExpiresAt <= now || !nonNegativeInteger(leadership.activeJobs)
    || !nonNegativeInteger(leadership.observedAt) || leadership.observedAt > now
    || leadership.routerGeneration !== Number(rawGeneration)) {
    fail('new active slot has not acquired valid scheduler leadership')
  }
  process.stdout.write(JSON.stringify({
    schedulerState: leadership.state,
    schedulerObservedAt: leadership.observedAt,
    schedulerRouterGeneration: leadership.routerGeneration,
    leaseExpiresAt: leadership.leaseExpiresAt,
  }))
} else {
  fail('unknown verification mode')
}
NODE
}

check_database_retirement() {
  local db_path="$1" slot="$2" release_id="$3" port="$4"
  local runtime_started_at="$5" required_quiet_seconds="$6"
  "$NODE_BIN" - "$PROJECT_ROOT" "$db_path" "$slot" "$release_id" "$port" \
    "$runtime_started_at" "$required_quiet_seconds" <<'NODE'
const [projectRoot, dbPath, slot, releaseId, rawPort, rawStartedAt, rawRequiredQuiet] = process.argv.slice(2)
const fail = message => { process.stderr.write(`blue-green direct database retirement check failed: ${message}\n`); process.exit(1) }
let Database
try { Database = require(require.resolve('better-sqlite3', { paths: [projectRoot] })) }
catch { fail('better-sqlite3 is unavailable') }
const port = Number(rawPort)
const runtimeStartedAt = Number(rawStartedAt)
const requiredQuietSeconds = Number(rawRequiredQuiet)
if (!['blue', 'green'].includes(slot)
  || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u.test(releaseId)
  || !Number.isInteger(port) || port < 1 || port > 65535
  || !Number.isSafeInteger(runtimeStartedAt) || runtimeStartedAt < 0
  || !Number.isSafeInteger(requiredQuietSeconds)
  || requiredQuietSeconds < 30 || requiredQuietSeconds > 900) fail('arguments are invalid')
let db
try {
  db = new Database(dbPath, { readonly: true, fileMustExist: true })
  db.pragma('query_only = ON')
  const aggregate = db.prepare(`
    SELECT COUNT(*) AS tracked,
      SUM(CASE WHEN status IN ('queued', 'accepted', 'running') THEN 1 ELSE 0 END) AS active,
      MAX(updated_at) AS last_activity_at
    FROM n8n_task_runs
    WHERE json_valid(routing)
      AND json_extract(routing, '$.callbackProtocol') = 'slot-v1'
      AND json_extract(routing, '$.runtimeSlot') = ?
      AND json_extract(routing, '$.runtimeReleaseId') = ?
  `).get(slot, releaseId)
  const urls = pathname => [
    `http://127.0.0.1:${port}${pathname}`,
    `http://localhost:${port}${pathname}`,
    `http://[::1]:${port}${pathname}`,
  ]
  const untracked = db.prepare(`
    SELECT SUM(CASE WHEN status IN ('queued', 'accepted', 'running') THEN 1 ELSE 0 END) AS count,
      MAX(updated_at) AS last_activity_at
    FROM n8n_task_runs
    WHERE json_valid(routing)
      AND (json_extract(routing, '$.claimCallbackUrl') IN (?, ?, ?)
        OR json_extract(routing, '$.mediaCallbackUrl') IN (?, ?, ?)
        OR json_extract(routing, '$.nodeCallbackUrl') IN (?, ?, ?))
      AND NOT (COALESCE(json_extract(routing, '$.callbackProtocol'), '') = 'slot-v1'
        AND COALESCE(json_extract(routing, '$.runtimeSlot'), '') = ?
        AND COALESCE(json_extract(routing, '$.runtimeReleaseId'), '') = ?)
  `).get(...urls('/api/n8n/claim'), ...urls('/api/n8n/media-execute'),
    ...urls('/api/n8n/node-execute'), slot, releaseId)
  const otherRelease = db.prepare(`
    SELECT SUM(CASE WHEN status IN ('queued', 'accepted', 'running') THEN 1 ELSE 0 END) AS count,
      MAX(updated_at) AS last_activity_at
    FROM n8n_task_runs
    WHERE json_valid(routing)
      AND json_extract(routing, '$.callbackProtocol') = 'slot-v1'
      AND json_extract(routing, '$.runtimeSlot') = ?
      AND COALESCE(json_extract(routing, '$.runtimeReleaseId'), '') <> ?
  `).get(slot, releaseId)
  const childExecutionLeases = db.prepare(`
    SELECT COUNT(*) AS count, MAX(lease.updated_at) AS last_activity_at
    FROM n8n_child_execution_leases lease
    JOIN n8n_task_runs run ON run.task_id = lease.task_id
    WHERE json_valid(run.routing)
      AND json_extract(run.routing, '$.callbackProtocol') = 'slot-v1'
      AND json_extract(run.routing, '$.runtimeSlot') = ?
      AND json_extract(run.routing, '$.runtimeReleaseId') = ?
  `).get(slot, releaseId)
  const number = value => Number(value || 0)
  const activity = [aggregate.last_activity_at, untracked.last_activity_at,
    otherRelease.last_activity_at, childExecutionLeases.last_activity_at]
    .filter(value => value !== null)
  const lastActivityAt = activity.length ? Math.max(...activity) : null
  const observedAt = Math.floor(Date.now() / 1000)
  const quietSeconds = Math.max(0, observedAt - Math.max(runtimeStartedAt, lastActivityAt || 0))
  const summary = {
    tracked: number(aggregate.tracked), active: number(aggregate.active),
    untrackedCallbacks: number(untracked.count), otherReleaseActive: number(otherRelease.count),
    childExecutionLeases: number(childExecutionLeases.count),
    lastActivityAt, quietSeconds, requiredQuietSeconds, observedAt,
  }
  if (summary.active !== 0 || summary.untrackedCallbacks !== 0
    || summary.otherReleaseActive !== 0 || summary.childExecutionLeases !== 0
    || quietSeconds < requiredQuietSeconds) {
    fail('release is not quiescent after callback freeze and listener shutdown')
  }
  process.stdout.write(JSON.stringify(summary))
} catch (error) {
  fail(error instanceof Error ? error.message : 'database query failed')
} finally { try { db?.close() } catch {} }
NODE
}

slot_established_connection_count() {
  local pid="$1" port="$2"
  command -v lsof >/dev/null 2>&1 || fail "retirement connection verification requires lsof"
  (lsof -a -p "$pid" -nP -iTCP:"$port" -sTCP:ESTABLISHED -t 2>/dev/null || true) \
    | sort -u | awk 'NF { count += 1 } END { print count + 0 }'
}

# The first online drain check can race with a callback that connected directly
# to the old slot and passed admission just before the freeze marker appeared.
# Once frozen, no new callback can enter its business path. Keep the listener
# alive while boundedly rechecking durable work, direct connections, scheduler
# state, router transports and the quiet window; only then may stop be invoked.
wait_for_frozen_retirement_quiescence() {
  local slot="$1" release_id="$2" host="$3" port="$4" pid="$5" active="$6" generation="$7"
  local deadline drain scheduler router connections
  deadline=$(( $(date +%s) + RETIRE_QUIESCE_WAIT_SECONDS ))
  while (( $(date +%s) <= deadline )); do
    [[ "$(read_state_field active)" == "$active" \
      && "$(read_state_field previous)" == "$slot" \
      && "$(read_state_field generation)" == "$generation" ]] || return 1
    drain="$(check_json_endpoint drain "http://$host:$port$DRAIN_PATH" \
      "$slot" "$release_id" "$port" 2>/dev/null)" || drain=""
    scheduler="$(check_json_endpoint scheduler "http://$host:$port$SCHEDULER_PATH" \
      "$generation" 2>/dev/null)" || scheduler=""
    router="$(assert_router_identity "$active" "$(read_state_slot_release "$active")" \
      "$generation" "$slot" 2>/dev/null)" || router=""
    connections="$(slot_established_connection_count "$pid" "$port")"
    if [[ -n "$drain" && -n "$scheduler" && -n "$router" && "$connections" == 0 ]]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

check_legacy_databases_quiescent() {
  local mission_db="$1" n8n_db="$2"
  "$NODE_BIN" - "$PROJECT_ROOT" "$mission_db" "$n8n_db" <<'NODE'
const [projectRoot, missionPath, n8nPath] = process.argv.slice(2)
const fail = message => {
  process.stderr.write(`blue-green direct legacy database check failed: ${message}\n`)
  process.exit(1)
}
let Database
try { Database = require(require.resolve('better-sqlite3', { paths: [projectRoot] })) }
catch { fail('better-sqlite3 is unavailable') }
const open = pathname => {
  const db = new Database(pathname, { readonly: true, fileMustExist: true })
  db.pragma('query_only = ON')
  const quick = db.pragma('quick_check', { simple: true })
  if (quick !== 'ok') fail('SQLite quick_check did not return ok')
  return db
}
let mission
let n8n
try {
  mission = open(missionPath)
  const missionColumns = new Set(mission.pragma('table_info(n8n_task_runs)').map(row => row.name))
  if (!['source', 'status', 'updated_at'].every(name => missionColumns.has(name))) {
    fail('Mission Control n8n_task_runs schema is unavailable')
  }
  const now = Math.floor(Date.now() / 1000)
  const missionCounts = mission.prepare(`
    SELECT
      SUM(CASE WHEN source = 'n8n-media-node'
        AND status IN ('queued', 'accepted', 'running') THEN 1 ELSE 0 END) AS media_nodes,
      SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
      SUM(CASE WHEN status IN ('queued', 'accepted')
        AND updated_at > ? THEN 1 ELSE 0 END) AS fresh_waiting
    FROM n8n_task_runs
  `).get(now - 86400)
  n8n = open(n8nPath)
  const executionColumns = new Set(n8n.pragma('table_info(execution_entity)').map(row => row.name))
  if (!['status', 'stoppedAt'].every(name => executionColumns.has(name))) {
    fail('n8n execution_entity schema is unavailable')
  }
  const n8nActive = n8n.prepare(`
    SELECT COUNT(*) AS count
    FROM execution_entity
    WHERE status IN ('new', 'running', 'waiting') AND "stoppedAt" IS NULL
  `).get().count
  const summary = {
    mediaNodes: Number(missionCounts.media_nodes || 0),
    running: Number(missionCounts.running || 0),
    freshWaiting: Number(missionCounts.fresh_waiting || 0),
    n8nActiveExecutions: Number(n8nActive || 0),
  }
  if (Object.values(summary).some(value => !Number.isSafeInteger(value) || value !== 0)) {
    fail('active or recently waiting work is still present')
  }
  process.stdout.write(JSON.stringify(summary))
} catch (error) {
  fail(error instanceof Error ? error.message : 'database query failed')
} finally {
  try { mission?.close() } catch {}
  try { n8n?.close() } catch {}
}
NODE
}

resolve_baseline_source_commit() {
  local release_id="$1" candidate resolved head
  candidate="${release_id%-runtime}"
  [[ "$candidate" =~ ^[a-f0-9]{7,40}$ ]] \
    || fail "bootstrap release ID must be a 7-40 character Git commit prefix with optional -runtime suffix"
  resolved="$(git -C "$PROJECT_ROOT" rev-parse --verify "${candidate}^{commit}" 2>/dev/null)" \
    || fail "bootstrap release ID does not resolve to a Git commit"
  head="$(git -C "$PROJECT_ROOT" rev-parse --verify 'HEAD^{commit}' 2>/dev/null)" \
    || fail "bootstrap requires a full Git HEAD"
  [[ "$resolved" == "$head" ]] \
    || fail "bootstrap release ID is not bound to the checked-out Git HEAD"
  printf '%s\n' "$resolved"
}

check_n8n_workflow_compatibility() {
  local n8n_pid="$1" n8n_db="$2" expected_commit="$3" verifier canonical_db relative
  verifier="$PROJECT_ROOT/scripts/verify-n8n-blue-green-workflows.mjs"
  [[ "$n8n_pid" =~ ^[1-9][0-9]*$ ]] || fail "n8n workflow verification PID is invalid"
  [[ "$expected_commit" =~ ^[a-f0-9]{40}$ ]] || fail "n8n workflow verification commit is invalid"
  kill -0 "$n8n_pid" 2>/dev/null || fail "n8n workflow verification requires the evidenced live PID"
  assert_absolute "n8n workflow database" "$n8n_db"
  [[ -f "$n8n_db" && ! -L "$n8n_db" ]] \
    || fail "n8n workflow verification requires the physical n8n SQLite database"
  canonical_db="$(physical_path "$n8n_db")" \
    || fail "unable to resolve n8n workflow database"
  command -v lsof >/dev/null 2>&1 \
    || fail "n8n workflow verification requires lsof for PID/database binding"
  lsof -a -p "$n8n_pid" -Fn 2>/dev/null | sed -n 's/^n//p' | grep -Fxq "$canonical_db" \
    || fail "evidenced n8n PID is not using the workflow database being verified"
  [[ -f "$verifier" && ! -L "$verifier" ]] \
    || fail "n8n workflow compatibility verifier is unavailable"
  for relative in \
    ops/n8n/workflows/aiworker-task-intake.json \
    ops/n8n/workflows/aiworker-video-analysis.json; do
    git -C "$PROJECT_ROOT" ls-files --error-unmatch "$relative" >/dev/null 2>&1 \
      || fail "n8n workflow compatibility source is not tracked: $relative"
    git -C "$PROJECT_ROOT" diff --quiet HEAD -- "$relative" \
      || fail "n8n workflow compatibility source differs from Git HEAD: $relative"
  done
  env -u NODE_ENV \
    -u AIWORKER_TEST_N8N_IDENTITY \
    -u AIWORKER_TEST_N8N_LAUNCHCTL \
    -u AIWORKER_TEST_N8N_LSOF \
    -u AIWORKER_TEST_N8N_PS \
    -u AIWORKER_TEST_N8N_BEFORE_DATABASE_OPEN \
    -u AIWORKER_TEST_N8N_AFTER_DATABASE_OPEN \
    -u AIWORKER_TEST_N8N_AFTER_QUERY \
    "$NODE_BIN" "$verifier" \
    --database "$canonical_db" \
    --repository "$PROJECT_ROOT" \
    --expected-commit "$expected_commit" \
    --module-root "$PROJECT_ROOT" \
    --pid "$n8n_pid" \
    --port 5678
}

assert_router_identity() {
  local active_slot="$1"
  local release_id="$2"
  local generation="$3"
  local retiring_slot="${4:-}"
  local result pid transport_summary="" attestation attested_pid listener canonical_state
  if [[ -n "$retiring_slot" ]]; then
    result="$(check_json_endpoint retire-router "http://$ROUTER_HOST:$ROUTER_PORT/__router/health" \
      "$active_slot" "$release_id" "$generation" "$retiring_slot")" || return 1
    pid="$(printf '%s\n' "$result" | sed -n '1p')"
    transport_summary="$(printf '%s\n' "$result" | sed -n '2p')"
  else
    pid="$(check_json_endpoint router "http://$ROUTER_HOST:$ROUTER_PORT/__router/health" \
      "$active_slot" "$release_id" "$generation")" || return 1
  fi
  attestation="$(router_attestation_file)"
  assert_private_file "standalone router runtime attestation" "$attestation"
  canonical_state="$(physical_path "$STATE_FILE")" || fail "unable to resolve router state path"
  attested_pid="$($NODE_BIN -e '
    const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))
    const [host, rawPort, stateFile] = process.argv.slice(2)
    const keys = ["host", "pid", "port", "schema", "startedAt", "stateFile"]
    if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys)
      || value.schema !== "video-autoworker-standalone-router-runtime/v1"
      || !Number.isSafeInteger(value.pid) || value.pid <= 0 || value.host !== host
      || value.port !== Number(rawPort) || value.stateFile !== stateFile
      || !Number.isSafeInteger(value.startedAt) || value.startedAt <= 0) process.exit(2)
    process.stdout.write(String(value.pid))
  ' "$attestation" "$ROUTER_HOST" "$ROUTER_PORT" "$canonical_state")" \
    || fail "standalone router runtime attestation is invalid"
  [[ "$attested_pid" == "$pid" ]] || fail "router health PID does not match its runtime attestation"
  kill -0 "$pid" 2>/dev/null || fail "attested standalone router PID is not running"
  command -v lsof >/dev/null 2>&1 || fail "router identity verification requires lsof"
  listener="$(lsof -tiTCP:"$ROUTER_PORT" -sTCP:LISTEN 2>/dev/null | sort -u)"
  [[ "$listener" == "$pid" ]] || fail "port $ROUTER_PORT listener does not match the attested router PID"
  [[ -z "$transport_summary" ]] || printf '%s' "$transport_summary"
}

check_routed_readonly_endpoint() {
  local pathname="$1"
  local kind="$2"
  local token
  token="$(read_control_token)"
  AIWORKER_BG_REQUEST_TOKEN="$token" AIWORKER_BG_REQUEST_TIMEOUT_MS="$HTTP_TIMEOUT_MS" \
    "$NODE_BIN" - "$ROUTER_HOST" "$ROUTER_PORT" "$pathname" "$kind" <<'NODE'
const [host, rawPort, pathname, kind] = process.argv.slice(2)
const token = process.env.AIWORKER_BG_REQUEST_TOKEN || ''
const fail = message => {
  process.stderr.write(`blue-green routed ${kind} verification failed for ${pathname}: ${message}\n`)
  process.exit(1)
}
let response
try {
  response = await fetch(`http://${host}:${rawPort}${pathname}`, {
    cache: 'no-store',
    redirect: 'manual',
    headers: { authorization: `Bearer ${token}`, accept: kind === 'api' ? 'application/json' : 'text/html' },
    signal: AbortSignal.timeout(Number(process.env.AIWORKER_BG_REQUEST_TIMEOUT_MS)),
  })
} catch {
  fail('endpoint unavailable')
}
if (response.status < 200 || response.status >= 300) fail(`HTTP ${response.status}`)
const contentType = response.headers.get('content-type') || ''
const body = await response.text()
if (!body) fail('empty response')
if (kind === 'page' && !contentType.toLowerCase().includes('text/html')) fail('response is not HTML')
if (kind === 'api') {
  if (!contentType.toLowerCase().includes('json')) fail('response is not JSON')
  try { JSON.parse(body) } catch { fail('response JSON is invalid') }
}
NODE
}

ensure_bootstrap_intake_paused() {
  local host="$1"
  local port="$2"
  local token
  token="$(read_control_token)"
  AIWORKER_BG_REQUEST_TOKEN="$token" AIWORKER_BG_REQUEST_TIMEOUT_MS="$HTTP_TIMEOUT_MS" \
    "$NODE_BIN" - "$host" "$port" <<'NODE'
const [host, port] = process.argv.slice(2)
const base = `http://${host}:${port}`
const headers = {
  authorization: `Bearer ${process.env.AIWORKER_BG_REQUEST_TOKEN || ''}`,
  accept: 'application/json',
}
const request = async (path, init = {}) => {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers || {}) },
    cache: 'no-store',
    signal: AbortSignal.timeout(Number(process.env.AIWORKER_BG_REQUEST_TIMEOUT_MS)),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) throw new Error(`bootstrap intake HTTP ${response.status}`)
  return payload
}
const first = (await request('/api/n8n/intake-control'))?.control
if (!first || first.schema !== 'video-autoworker-intake-control/v1' || first.globalScope !== true
  || !Number.isSafeInteger(first.revision)) throw new Error('bootstrap intake control is invalid')
let control = first
if (control.accepting) {
  control = (await request('/api/n8n/intake-control', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action: 'drain',
      reason: '首次蓝绿基线引导期间冻结入口',
      expectedRevision: control.revision,
    }),
  }))?.control
}
if (!control || control.accepting !== false || control.mode !== 'paused'
  || control.counts?.active !== 0 || !Number.isSafeInteger(control.revision) || control.revision < 1) {
  throw new Error('bootstrap intake did not reach a zero-work paused state')
}
process.stdout.write(String(control.revision))
NODE
}

init_state() {
  local active
  active="$(require_slot "${1:-blue}")"
  acquire_lock
  assert_safe_integer "router port" "$ROUTER_PORT"
  assert_safe_integer "blue port" "$BLUE_PORT"
  assert_safe_integer "green port" "$GREEN_PORT"
  [[ "$BLUE_PORT" != "$GREEN_PORT" && "$ROUTER_PORT" != "$BLUE_PORT" && "$ROUTER_PORT" != "$GREEN_PORT" ]] \
    || fail "router, blue and green ports must be distinct"
  if [[ -e "$STATE_FILE" || -L "$STATE_FILE" ]]; then
    validate_state
    printf 'Router state already initialized: %s\n' "$STATE_FILE"
    return
  fi
  local payload
  payload="$($NODE_BIN -e '
    const [active, bluePort, greenPort] = process.argv.slice(1)
    process.stdout.write(JSON.stringify({
      schema: "video-autoworker-standalone-router/v1",
      generation: 1,
      active,
      previous: null,
      updatedAt: new Date().toISOString(),
      slots: {
        blue: { host: "127.0.0.1", port: Number(bluePort), releaseId: "unbound-blue" },
        green: { host: "127.0.0.1", port: Number(greenPort), releaseId: "unbound-green" },
      },
    }))
  ' "$active" "$BLUE_PORT" "$GREEN_PORT")"
  write_router_state_atomic "$payload"
  validate_state
  printf 'Initialized router state: active=%s generation=1\n' "$active"
}

assert_baseline() {
  local pathname live_db canonical_router_state values baseline_release baseline_root baseline_manifest
  pathname="$(baseline_file)"
  assert_private_file "blue-green baseline" "$pathname"
  [[ -n "$LIVE_DB_PATH" ]] || fail "AIWORKER_BG_LIVE_DB_PATH is required for blue-green lifecycle operations"
  assert_absolute "AIWORKER_BG_LIVE_DB_PATH" "$LIVE_DB_PATH"
  [[ -f "$LIVE_DB_PATH" ]] || fail "AIWORKER_BG_LIVE_DB_PATH must identify the existing live SQLite database"
  live_db="$(physical_path "$LIVE_DB_PATH")" || fail "unable to resolve AIWORKER_BG_LIVE_DB_PATH"
  canonical_router_state="$(physical_path "$STATE_FILE")" || fail "unable to resolve router state path"
  values="$("$NODE_BIN" - "$pathname" "$live_db" "$canonical_router_state" "$ROUTER_PORT" <<'NODE'
const value = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'))
const [dbPath, routerStatePath, rawPort] = process.argv.slice(3)
const baselineCommitPrefix = value.baselineReleaseId?.endsWith('-runtime')
  ? value.baselineReleaseId.slice(0, -'-runtime'.length)
  : value.baselineReleaseId
  const expectedKeys = ['baselineManifestSha256', 'baselineReleaseId', 'baselineReleaseRoot',
   'baselineSlot', 'baselineSourceCommit', 'completedAt', 'dbPath', 'evidenceSha256', 'legacyPid', 'legacyReleaseId',
   'n8nDbPath', 'n8nPid', 'n8nWorkflowDigest', 'n8nWorkflowProtocol',
   'n8nWorkflowSourceCommit', 'routerPort', 'routerStatePath', 'schema']
if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys)) process.exit(2)
if (value.schema !== 'video-autoworker-blue-green-baseline/v3'
  || !['blue', 'green'].includes(value.baselineSlot)
  || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u.test(value.baselineReleaseId)
  || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u.test(value.legacyReleaseId)
  || !/^[a-f0-9]{40}$/u.test(value.baselineSourceCommit)
  || !/^[a-f0-9]{7,40}$/u.test(baselineCommitPrefix)
  || !value.baselineSourceCommit.startsWith(baselineCommitPrefix)
  || value.baselineReleaseId === value.legacyReleaseId
  || !/^[a-f0-9]{64}$/u.test(value.baselineManifestSha256)
  || !/^[a-f0-9]{64}$/u.test(value.evidenceSha256)
  || !Number.isSafeInteger(value.legacyPid) || value.legacyPid <= 0
  || !Number.isSafeInteger(value.n8nPid) || value.n8nPid <= 0
  || typeof value.n8nDbPath !== 'string' || !value.n8nDbPath.startsWith('/')
  || /[\r\n]/u.test(value.n8nDbPath)
  || value.n8nWorkflowProtocol !== 'slot-v1-execution-owner-v1'
  || value.n8nWorkflowSourceCommit !== value.baselineSourceCommit
  || !/^[a-f0-9]{64}$/u.test(value.n8nWorkflowDigest)
  || !Number.isSafeInteger(value.completedAt) || value.completedAt <= 0
  || value.dbPath !== dbPath || value.routerStatePath !== routerStatePath
  || typeof value.baselineReleaseRoot !== 'string' || !value.baselineReleaseRoot.startsWith('/')
  || /[\r\n]/u.test(value.baselineReleaseRoot) || value.routerPort !== Number(rawPort)) process.exit(3)
process.stdout.write(`${value.legacyReleaseId}\n${value.baselineReleaseId}\n${value.baselineReleaseRoot}\n${value.baselineManifestSha256}\n`)
NODE
  )" || fail "blue-green baseline is invalid"
  baseline_release="$(printf '%s\n' "$values" | sed -n '2p')"
  baseline_root="$(printf '%s\n' "$values" | sed -n '3p')"
  baseline_manifest="$(printf '%s\n' "$values" | sed -n '4p')"
  baseline_root="$(assert_release "$baseline_release" "$baseline_root")"
  [[ "$(release_manifest_sha "$baseline_root")" == "$baseline_manifest" ]] \
    || fail "blue-green baseline release manifest changed"
  printf '%s\n' "$values"
}

assert_bootstrap_pending_identity() {
  local pathname="$1" expected_payload="$2"
  assert_immutable_private_file "bootstrap pending marker" "$pathname"
  "$NODE_BIN" -e '
    const fs = require("node:fs")
    const [pathname, rawExpected] = process.argv.slice(1)
    const actual = JSON.parse(fs.readFileSync(pathname, "utf8"))
    const expected = JSON.parse(rawExpected)
    const keys = (value, names) => value && typeof value === "object" && !Array.isArray(value)
      && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...names].sort())
    const ref = value => keys(value, ["dev", "ino", "path", "sha256", "size"])
      && /^\d+$/.test(value.dev) && /^\d+$/.test(value.ino) && /^[a-f0-9]{64}$/.test(value.sha256)
      && Number.isSafeInteger(value.size) && value.size > 0 && value.path.startsWith("/")
    const fullRef = value => keys(value, ["ctimeNs", "dev", "ino", "mode", "mtimeNs", "nlink",
      "path", "sha256", "size", "uid"])
      && /^\d+$/.test(value.dev) && /^\d+$/.test(value.ino) && /^\d+$/.test(value.ctimeNs)
      && /^\d+$/.test(value.mtimeNs) && /^[0-7]{3,4}$/.test(value.mode)
      && Number.isSafeInteger(value.nlink) && value.nlink === 1
      && Number.isSafeInteger(value.uid) && value.uid >= 0
      && /^[a-f0-9]{64}$/.test(value.sha256) && Number.isSafeInteger(value.size)
      && value.size > 0 && value.path.startsWith("/")
    const identity = value => keys(value, ["dev", "ino", "path"])
      && /^\d+$/.test(value.dev) && /^\d+$/.test(value.ino) && value.path.startsWith("/")
    const fullDirectory = value => keys(value, ["dev", "ino", "mode", "path", "uid"])
      && /^\d+$/.test(value.dev) && /^\d+$/.test(value.ino) && /^[0-7]{3,4}$/.test(value.mode)
      && Number.isSafeInteger(value.uid) && value.uid >= 0 && value.path.startsWith("/")
    const expectedKeys = ["attemptId", "authorization", "baselineSourceCommit", "bootstrapClaim", "createdAt", "databases",
      "evidence", "evidenceObservedAt", "legacyCwd", "legacyPid", "legacyReleaseId", "manifestSha256",
      "n8n", "proof", "releaseId", "releaseRoot", "router", "schema", "slot", "transition"]
    if (!keys(actual, expectedKeys) || actual.schema !== "video-autoworker-blue-green-bootstrap-pending/v4"
      || !["blue", "green"].includes(actual.slot)
      || !/^[a-f0-9-]{36}$/.test(actual.attemptId || "")
      || !/^[a-f0-9]{40}$/u.test(actual.baselineSourceCommit)
      || actual.releaseId !== `${actual.baselineSourceCommit}-runtime`
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u.test(actual.legacyReleaseId)
      || actual.releaseId === actual.legacyReleaseId
      || !/^[a-f0-9]{64}$/u.test(actual.manifestSha256)
      || !ref(actual.evidence) || !ref(actual.proof)
      || !fullRef(actual.bootstrapClaim)
      || !keys(actual.authorization, ["confirm", "prepare", "shutdown"])
      || !Object.values(actual.authorization).every(ref)
      || !keys(actual.databases, ["mission", "n8n"])
      || !identity(actual.databases.mission) || !identity(actual.databases.n8n)
      || !keys(actual.transition, ["anchor", "attestation", "claim", "committedJournalHeadSha256",
        "confirmation", "intent", "journal", "liveCombinedSha256", "upgradeId"])
      || ![actual.transition.anchor, actual.transition.attestation, actual.transition.claim,
        actual.transition.confirmation, actual.transition.intent].every(fullRef)
      || !fullDirectory(actual.transition.journal)
      || actual.bootstrapClaim.path !== actual.transition.claim.path
      || actual.bootstrapClaim.sha256 !== actual.transition.claim.sha256
      || !/^[a-f0-9-]{36}$/u.test(actual.transition.upgradeId || "")
      || !/^[a-f0-9]{64}$/u.test(actual.transition.committedJournalHeadSha256 || "")
      || !/^[a-f0-9]{64}$/u.test(actual.transition.liveCombinedSha256 || "")
      || !keys(actual.router, ["port", "runDirectory", "statePath"])
      || !identity(actual.router.runDirectory) || actual.router.port !== 3017
      || !keys(actual.n8n, ["dbPath", "pid", "workflowDigest", "workflowProtocol", "workflowReport", "workflowSourceCommit"])
      || !ref(actual.n8n.workflowReport)
      || !/^[a-f0-9]{64}$/u.test(actual.n8n.workflowDigest)
      || actual.n8n.workflowDigest !== actual.transition.liveCombinedSha256
      || !Number.isSafeInteger(actual.evidenceObservedAt) || actual.evidenceObservedAt <= 0
      || !Number.isSafeInteger(actual.createdAt) || actual.createdAt <= 0
      || !Number.isSafeInteger(actual.legacyPid) || actual.legacyPid <= 0
      || !Number.isSafeInteger(actual.n8n.pid) || actual.n8n.pid <= 0
      || actual.n8n.workflowProtocol !== "slot-v1-execution-owner-v1"
      || actual.n8n.workflowSourceCommit !== actual.baselineSourceCommit
      || actual.n8n.dbPath !== actual.databases.n8n.path
      || ![actual.legacyCwd, actual.releaseRoot, actual.router.statePath]
        .every(value => typeof value === "string" && value.startsWith("/") && !/[\r\n]/u.test(value))) process.exit(2)
    delete actual.createdAt
    delete expected.createdAt
    if (JSON.stringify(actual) !== JSON.stringify(expected)) process.exit(3)
  ' "$pathname" "$expected_payload" \
    || fail "bootstrap retry does not match its pending runtime identity"
}

bootstrap_pending_probe() {
  local pathname="$1"
  assert_immutable_private_file "bootstrap pending marker" "$pathname"
  "$NODE_BIN" -e '
    const fs = require("node:fs")
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
    if (value.schema !== "video-autoworker-blue-green-bootstrap-pending/v4"
      || !Number.isSafeInteger(value.legacyPid) || value.legacyPid <= 0
      || !/^[a-f0-9]{64}$/u.test(value.evidence?.sha256 || "")) process.exit(2)
    process.stdout.write(`${value.legacyPid}\n${value.evidence.sha256}\n`)
  ' "$pathname" || fail "bootstrap pending marker cannot be safely probed"
}

probe_evidenced_legacy_state() {
  local state
  state="$(env -u NODE_ENV \
    -u AIWORKER_TEST_LEGACY_FREEZE \
    -u AIWORKER_TEST_LEGACY_FREEZE_GUARD_SOCKET \
    -u AIWORKER_TEST_LEGACY_FREEZE_REPOSITORY_ROOT \
    -u AIWORKER_TEST_LEGACY_FREEZE_SAMPLE_DELAY_MS \
    -u AIWORKER_TEST_LEGACY_FREEZE_SNAPSHOT_COMMAND \
    "$NODE_BIN" "$evidence_generator" --probe-legacy-state-fd "$evidence_fd" \
      --router-port "$ROUTER_PORT")" \
    || fail "unable to compare the current process with the evidenced legacy identity"
  [[ "$state" == alive || "$state" == stopped ]] \
    || fail "managed legacy identity probe returned an invalid state"
  printf '%s\n' "$state"
}

bootstrap_baseline() {
  local slot release_id standalone_root evidence_file rollback_proof attempt_dir physical_root manifest live_db canonical_router_state
  local evidence_values legacy_release legacy_pid legacy_cwd n8n_pid n8n_db evidence_observed evidence_sha now
  local pending pending_payload binding_payload state_payload baseline_payload other_slot listeners deadline
  local evidence_max_age evidence_age pending_exists=0 manager installer intake_revision baseline_readiness baseline_epoch
  local workflow_compatibility workflow_compatibility_after workflow_compatibility_final workflow_digest source_commit
  local workflow_report bootstrap_preflight_contract baseline_verified_contract
  local evidence_fd=9 evidence_generator rollback_generator verified_evidence_sha guard_controller guard_socket guard_token
  local evidence_verify_mode=--verify-evidence-fd evidence_static_recovery=0 pending_probe pending_legacy_pid pending_evidence_sha
  local bootstrap_controller bootstrap_authorization proof_sha allow_expired_authorization guard_status guard_mode
  local n8n_listener_pid n8n_runtime_cwd n8n_runtime_release recovery_attempt recovery_parent recovery_guard_pid
  local legacy_state
  local guard_available=0
  slot="$(require_slot "${1:-}")"
  release_id="${2:-}"
  standalone_root="${3:-}"
  evidence_file="${4:-}"
  rollback_proof="${5:-}"
  attempt_dir="${6:-}"
  [[ -n "$release_id" && -n "$standalone_root" && -n "$evidence_file" && -n "$rollback_proof" \
    && -n "$attempt_dir" ]] \
    || { usage >&2; exit 2; }
  acquire_lock
  pending="$(bootstrap_pending_file)"
  if [[ -e "$(baseline_file)" || -L "$(baseline_file)" ]]; then
    validate_state
    local completed_baseline completed_binding
    completed_baseline="$(assert_baseline)"
    local existing_active existing_release existing_generation
    existing_active="$(read_state_field active)"
    existing_release="$(read_state_slot_release "$existing_active")"
    existing_generation="$(read_state_field generation)"
    assert_router_identity "$existing_active" "$existing_release" "$existing_generation" >/dev/null
    [[ -x "$SCRIPT_DIR/manage-blue-green-services.sh" ]] \
      && "$SCRIPT_DIR/manage-blue-green-services.sh" status router >/dev/null \
      && "$SCRIPT_DIR/manage-blue-green-services.sh" status "$existing_active" >/dev/null \
      || fail "completed baseline is not under the expected service manager"
    if [[ -e "$pending" || -L "$pending" ]]; then
      assert_immutable_private_file "bootstrap pending marker" "$pending"
      physical_root="$(assert_release "$release_id" "$standalone_root")"
      manifest="$(release_manifest_sha "$physical_root")"
      completed_binding="$(binding_values "$existing_active")"
      "$NODE_BIN" - "$(baseline_file)" "$pending" "$slot" "$release_id" "$physical_root" \
        "$manifest" "$evidence_file" "$rollback_proof" "$attempt_dir" "$existing_active" \
        "$existing_release" "$existing_generation" "$completed_binding" "$(slot_port "$slot")" <<'NODE' \
        || fail "completed baseline does not exactly match the pending bootstrap operation"
const fs = require('node:fs')
const path = require('node:path')
const [baselinePath, pendingPath, slot, releaseId, releaseRoot, manifestSha256,
  evidencePath, proofPath, attemptDir, active, activeRelease, rawGeneration,
  rawBinding, rawSlotPort] = process.argv.slice(2)
const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'))
const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf8'))
const binding = rawBinding.trimEnd().split('\n')
if (pending.schema !== 'video-autoworker-blue-green-bootstrap-pending/v4'
  || baseline.schema !== 'video-autoworker-blue-green-baseline/v3'
  || Number(rawGeneration) !== 1 || active !== slot || activeRelease !== releaseId
  || pending.slot !== slot || pending.releaseId !== releaseId
  || pending.releaseRoot !== releaseRoot || pending.manifestSha256 !== manifestSha256
  || pending.evidence?.path !== evidencePath || pending.proof?.path !== proofPath
  || path.dirname(pending.authorization?.prepare?.path || '') !== attemptDir
  || baseline.baselineSlot !== pending.slot
  || baseline.baselineReleaseId !== pending.releaseId
  || baseline.baselineReleaseRoot !== pending.releaseRoot
  || baseline.baselineManifestSha256 !== pending.manifestSha256
  || baseline.legacyReleaseId !== pending.legacyReleaseId
  || baseline.legacyPid !== pending.legacyPid
  || baseline.evidenceSha256 !== pending.evidence?.sha256
  || baseline.dbPath !== pending.databases?.mission?.path
  || baseline.routerStatePath !== pending.router?.statePath
  || baseline.routerPort !== pending.router?.port
  || baseline.n8nPid !== pending.n8n?.pid
  || baseline.n8nDbPath !== pending.n8n?.dbPath
  || baseline.baselineSourceCommit !== pending.baselineSourceCommit
  || baseline.n8nWorkflowSourceCommit !== pending.n8n?.workflowSourceCommit
  || baseline.n8nWorkflowProtocol !== pending.n8n?.workflowProtocol
  || baseline.n8nWorkflowDigest !== pending.n8n?.workflowDigest
  || binding.length !== 5 || binding[0] !== releaseId || binding[1] !== releaseRoot
  || binding[2] !== manifestSha256 || binding[3] !== '127.0.0.1'
  || binding[4] !== rawSlotPort) process.exit(2)
NODE
      local completed_runtime completed_n8n_pid completed_n8n_db completed_source_commit
      local completed_workflow_digest completed_mission_db completed_guard_socket completed_guard_token
      completed_runtime="$($NODE_BIN - "$pending" <<'NODE'
const fs = require('node:fs')
const crypto = require('node:crypto')
const pending = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const evidencePath = pending.evidence?.path
const evidenceEntry = fs.lstatSync(evidencePath, { bigint: true })
const evidenceSource = fs.readFileSync(evidencePath)
const evidence = JSON.parse(evidenceSource)
if (!evidenceEntry.isFile() || evidenceEntry.isSymbolicLink()
  || evidenceEntry.uid !== BigInt(process.getuid()) || (evidenceEntry.mode & 0o7777n) !== 0o600n
  || evidenceEntry.nlink !== 1n
  || crypto.createHash('sha256').update(evidenceSource).digest('hex') !== pending.evidence.sha256
  || evidence.schema !== 'video-autoworker-legacy-freeze-evidence/v3'
  || typeof evidence.frozen?.socket?.path !== 'string' || !evidence.frozen.socket.path.startsWith('/')) process.exit(2)
process.stdout.write(`${pending.n8n.pid}\n${pending.n8n.dbPath}\n${pending.baselineSourceCommit}\n`
  + `${pending.n8n.workflowDigest}\n${pending.databases.mission.path}\n${evidence.frozen.socket.path}\n`)
NODE
      )" || fail "completed baseline pending evidence is unavailable or changed"
      completed_n8n_pid="$(printf '%s\n' "$completed_runtime" | sed -n '1p')"
      completed_n8n_db="$(printf '%s\n' "$completed_runtime" | sed -n '2p')"
      completed_source_commit="$(printf '%s\n' "$completed_runtime" | sed -n '3p')"
      completed_workflow_digest="$(printf '%s\n' "$completed_runtime" | sed -n '4p')"
      completed_mission_db="$(printf '%s\n' "$completed_runtime" | sed -n '5p')"
      completed_guard_socket="$(printf '%s\n' "$completed_runtime" | sed -n '6p')"
      completed_guard_token="$(dirname "$completed_guard_socket")/guard.token"
      kill -0 "$completed_n8n_pid" 2>/dev/null \
        || fail "completed baseline n8n PID is no longer running"
      lsof -a -p "$completed_n8n_pid" -Fn 2>/dev/null | sed -n 's/^n//p' \
        | grep -Fxq "$completed_n8n_db" \
        || fail "completed baseline n8n PID no longer owns its authoritative database"
      check_legacy_databases_quiescent "$completed_mission_db" "$completed_n8n_db" >/dev/null \
        || fail "completed baseline databases are no longer quiescent"
      workflow_compatibility="$(check_n8n_workflow_compatibility \
        "$completed_n8n_pid" "$completed_n8n_db" "$completed_source_commit")" \
        || fail "completed baseline n8n workflow identity changed"
      [[ "$($NODE_BIN -e '
        const value = JSON.parse(process.argv[1])
        if (!/^[a-f0-9]{64}$/u.test(value?.combinedSha256 || "")) process.exit(2)
        process.stdout.write(value.combinedSha256)
      ' "$workflow_compatibility")" == "$completed_workflow_digest" ]] \
        || fail "completed baseline n8n workflow digest changed"
      if [[ -e "$completed_guard_socket" || -L "$completed_guard_socket" \
        || -e "$completed_guard_token" || -L "$completed_guard_token" ]]; then
        guard_controller="$PROJECT_ROOT/scripts/legacy-freeze-guard.mjs"
        [[ -S "$completed_guard_socket" && ! -L "$completed_guard_socket" \
          && -f "$completed_guard_token" && ! -L "$completed_guard_token" ]] \
          || fail "completed baseline has partial recovery-hold state"
        if "$NODE_BIN" "$guard_controller" status --socket "$completed_guard_socket" \
          --database "$completed_mission_db" --n8n-database "$completed_n8n_db" >/dev/null 2>&1; then
          "$NODE_BIN" "$guard_controller" revoke --socket "$completed_guard_socket" \
            --token-file "$completed_guard_token" --database "$completed_mission_db" \
            --n8n-database "$completed_n8n_db" >/dev/null \
            || fail "unable to release the completed baseline recovery hold"
        else
          "$NODE_BIN" "$guard_controller" recover-stale --socket "$completed_guard_socket" \
            --token-file "$completed_guard_token" --database "$completed_mission_db" \
            --n8n-database "$completed_n8n_db" >/dev/null \
            || fail "unable to remove stale completed baseline recovery-hold state"
        fi
      fi
      remove_immutable_file_durable "completed bootstrap pending marker" "$pending" \
        || fail "unable to durably finalize the completed bootstrap marker"
      printf 'Finalized previously completed blue-green baseline; legacy shutdown was not repeated\n'
      return
    fi
    printf 'Blue-green baseline already completed; legacy shutdown was not repeated\n'
    return
  fi
  assert_absolute "bootstrap evidence" "$evidence_file"
  assert_private_file "bootstrap evidence" "$evidence_file"
  assert_absolute "bootstrap rollback proof" "$rollback_proof"
  assert_private_file "bootstrap rollback proof" "$rollback_proof"
  assert_absolute "bootstrap confirmed attempt directory" "$attempt_dir"
  [[ -n "$LIVE_DB_PATH" ]] || fail "AIWORKER_BG_LIVE_DB_PATH is required for bootstrap"
  assert_absolute "AIWORKER_BG_LIVE_DB_PATH" "$LIVE_DB_PATH"
  [[ -f "$LIVE_DB_PATH" ]] || fail "AIWORKER_BG_LIVE_DB_PATH must identify the existing live SQLite database"
  live_db="$(physical_path "$LIVE_DB_PATH")" || fail "unable to resolve AIWORKER_BG_LIVE_DB_PATH"
  [[ -n "$N8N_DB_PATH" ]] || fail "AIWORKER_BG_N8N_DB_PATH is required for bootstrap"
  assert_absolute "AIWORKER_BG_N8N_DB_PATH" "$N8N_DB_PATH"
  [[ -f "$N8N_DB_PATH" && ! -L "$N8N_DB_PATH" ]] \
    || fail "AIWORKER_BG_N8N_DB_PATH must identify the existing physical n8n SQLite database"
  n8n_db="$(physical_path "$N8N_DB_PATH")" || fail "unable to resolve AIWORKER_BG_N8N_DB_PATH"
  physical_root="$(assert_release "$release_id" "$standalone_root")"
  manifest="$(release_manifest_sha "$physical_root")"
  source_commit="$(resolve_baseline_source_commit "$release_id")"
  # Phase 1 is intentionally process-independent: the immutable application
  # release, installed OpenClaw payloads, and runtime-convergence proof must all
  # pass before any pending marker is written or the legacy PID can be stopped.
  # The database/extraction half remains a phase-2 check after the new release
  # has run its append-only migrations.
  bootstrap_preflight_contract="$(verify_director_video_release_preflight \
    "$release_id" "$physical_root")" \
    || fail "baseline immutable release preflight failed before legacy shutdown"
  evidence_generator="$PROJECT_ROOT/scripts/generate-legacy-freeze-evidence.mjs"
  [[ -f "$evidence_generator" && ! -L "$evidence_generator" ]] \
    || fail "managed legacy freeze evidence generator is unavailable"
  git -C "$PROJECT_ROOT" ls-files --error-unmatch scripts/generate-legacy-freeze-evidence.mjs >/dev/null 2>&1 \
    || fail "managed legacy freeze evidence generator is not tracked"
  git -C "$PROJECT_ROOT" diff --quiet HEAD -- scripts/generate-legacy-freeze-evidence.mjs \
    || fail "managed legacy freeze evidence generator differs from Git HEAD"
  rollback_generator="$PROJECT_ROOT/scripts/generate-legacy-bootstrap-rollback-proof.mjs"
  [[ -f "$rollback_generator" && ! -L "$rollback_generator" ]] \
    || fail "managed rollback proof generator is unavailable"
  git -C "$PROJECT_ROOT" ls-files --error-unmatch scripts/generate-legacy-bootstrap-rollback-proof.mjs >/dev/null 2>&1 \
    || fail "managed rollback proof generator is not tracked"
  git -C "$PROJECT_ROOT" diff --quiet HEAD -- scripts/generate-legacy-bootstrap-rollback-proof.mjs \
    || fail "managed rollback proof generator differs from Git HEAD"
  guard_controller="$PROJECT_ROOT/scripts/legacy-freeze-guard.mjs"
  [[ -f "$guard_controller" && ! -L "$guard_controller" ]] \
    || fail "managed legacy freeze guard is unavailable"
  git -C "$PROJECT_ROOT" ls-files --error-unmatch scripts/legacy-freeze-guard.mjs >/dev/null 2>&1 \
    || fail "managed legacy freeze guard is not tracked"
  git -C "$PROJECT_ROOT" diff --quiet HEAD -- scripts/legacy-freeze-guard.mjs \
    || fail "managed legacy freeze guard differs from Git HEAD"
  bootstrap_controller="$PROJECT_ROOT/scripts/legacy-bootstrap-controller.mjs"
  [[ -f "$bootstrap_controller" && ! -L "$bootstrap_controller" ]] \
    || fail "managed legacy bootstrap confirmation controller is unavailable"
  git -C "$PROJECT_ROOT" ls-files --error-unmatch scripts/legacy-bootstrap-controller.mjs >/dev/null 2>&1 \
    || fail "managed legacy bootstrap confirmation controller is not tracked"
  git -C "$PROJECT_ROOT" diff --quiet HEAD -- scripts/legacy-bootstrap-controller.mjs \
    || fail "managed legacy bootstrap confirmation controller differs from Git HEAD"
  if ( : <&9 ) 2>/dev/null; then fail "reserved bootstrap evidence FD 9 is already open"; fi
  exec 9<"$evidence_file" || fail "unable to open bootstrap evidence"
  if [[ -e "$pending" || -L "$pending" ]]; then
    pending_exists=1
    pending_probe="$(bootstrap_pending_probe "$pending")"
    pending_legacy_pid="$(printf '%s\n' "$pending_probe" | sed -n '1p')"
    pending_evidence_sha="$(printf '%s\n' "$pending_probe" | sed -n '2p')"
    legacy_state="$(probe_evidenced_legacy_state)"
    if [[ "$legacy_state" == stopped ]]; then
      evidence_verify_mode=--verify-evidence-static-fd
      evidence_static_recovery=1
    fi
  fi
  verified_evidence_sha="$(env -u NODE_ENV \
    -u AIWORKER_TEST_LEGACY_FREEZE \
    -u AIWORKER_TEST_LEGACY_FREEZE_GUARD_SOCKET \
    -u AIWORKER_TEST_LEGACY_FREEZE_REPOSITORY_ROOT \
    -u AIWORKER_TEST_LEGACY_FREEZE_SAMPLE_DELAY_MS \
    -u AIWORKER_TEST_LEGACY_FREEZE_SNAPSHOT_COMMAND \
    "$NODE_BIN" "$evidence_generator" "$evidence_verify_mode" "$evidence_fd" \
      --output "$evidence_file" --slot "$slot" --release-id "$release_id" \
      --standalone-root "$physical_root" --rollback-proof "$rollback_proof")" \
    || fail "managed bootstrap evidence signature or target binding is invalid"
  [[ "$verified_evidence_sha" =~ ^[a-f0-9]{64}$ ]] \
    || fail "managed bootstrap evidence digest is invalid"
  if (( pending_exists == 1 )) && [[ "$verified_evidence_sha" != "$pending_evidence_sha" ]]; then
    fail "bootstrap retry evidence does not match the pending digest"
  fi
  manager="$SCRIPT_DIR/manage-blue-green-services.sh"
  installer="$SCRIPT_DIR/install-blue-green-launch-agents.sh"
  [[ -x "$manager" && -x "$installer" ]] \
    || fail "managed blue-green service scripts are required before legacy shutdown"
  "$installer" --dry-run >/dev/null \
    || fail "blue-green LaunchAgent installation preflight failed before legacy shutdown"
  "$manager" preflight all >/dev/null \
    || fail "installed blue-green service manager is not ready before legacy shutdown"
  now="$(date +%s)"
  evidence_max_age="$BOOTSTRAP_EVIDENCE_MAX_AGE"
  evidence_values="$($NODE_BIN - "$evidence_fd" "$evidence_file" "$ROUTER_PORT" "$now" \
    "$evidence_max_age" "$slot" "$release_id" "$physical_root" "$manifest" "$live_db" \
    "$n8n_db" "$verified_evidence_sha" "$rollback_proof" "$evidence_static_recovery" <<'NODE'
const fs = require('node:fs')
const crypto = require('node:crypto')
const [rawFd, pathname, rawPort, rawNow, rawMaxAge, slot, releaseId, releaseRoot,
  manifestSha256, liveDb, n8nDb, verifiedSha256, rollbackProof, rawStaticRecovery] = process.argv.slice(2)
const staticRecovery = rawStaticRecovery === '1'
const fd = Number(rawFd)
const opened = fs.fstatSync(fd, { bigint: true })
const pathEntry = fs.lstatSync(pathname, { bigint: true })
if (!opened.isFile() || pathEntry.isSymbolicLink() || !pathEntry.isFile()
  || opened.dev !== pathEntry.dev || opened.ino !== pathEntry.ino
  || opened.uid !== BigInt(process.getuid()) || (opened.mode & 0o7777n) !== 0o600n
  || opened.nlink !== 1n) process.exit(2)
const source = Buffer.alloc(Number(opened.size))
if (fs.readSync(fd, source, 0, source.length, 0) !== source.length
  || crypto.createHash('sha256').update(source).digest('hex') !== verifiedSha256) process.exit(3)
const value = JSON.parse(source)
const keys = (object, expected) => object && typeof object === 'object' && !Array.isArray(object)
  && JSON.stringify(Object.keys(object).sort()) === JSON.stringify([...expected].sort())
const fileIdentity = item => keys(item, ['dev', 'ino', 'path'])
  && typeof item.path === 'string' && item.path.startsWith('/') && !/[\r\n]/u.test(item.path)
  && /^\d+$/u.test(item.dev) && /^\d+$/u.test(item.ino)
const processIdentity = (item, extra) => keys(item, [
  'argvSha256', 'cwd', 'database', 'executable', 'pid', 'ppid', 'startTime', 'uid', ...extra,
]) && Number.isSafeInteger(item.pid) && item.pid > 0
  && Number.isSafeInteger(item.ppid) && item.ppid > 0
  && Number.isSafeInteger(item.uid) && item.uid >= 0 && typeof item.startTime === 'string'
  && item.startTime.length > 0 && /^[a-f0-9]{64}$/u.test(item.argvSha256)
  && fileIdentity(item.cwd) && fileIdentity(item.database) && fileIdentity(item.executable)
const expectedKeys = ['counts', 'frozen', 'generatorSha256', 'legacy', 'n8n', 'observedAt',
  'queueDigestSha256', 'rollback', 'schema', 'supervisor', 'target']
const countKeys = ['mediaNodes', 'n8nActiveExecutions', 'queueRunning', 'queueWaiting']
if (!keys(value, expectedKeys) || value.schema !== 'video-autoworker-legacy-freeze-evidence/v3'
  || !/^[a-f0-9]{64}$/u.test(value.generatorSha256)
  || !keys(value.target, ['manifestSha256', 'releaseId', 'releaseRoot', 'slot'])
  || value.target.slot !== slot || value.target.releaseId !== releaseId
  || value.target.releaseRoot !== releaseRoot || value.target.manifestSha256 !== manifestSha256
  || !processIdentity(value.legacy, ['releaseId', 'routerPort'])
  || value.legacy.releaseId === releaseId || value.legacy.routerPort !== Number(rawPort)
  || value.legacy.database.path !== liveDb
  || !processIdentity(value.n8n, ['launchPid', 'port'])
  || !Number.isSafeInteger(value.n8n.launchPid) || value.n8n.launchPid <= 0
  || value.n8n.ppid !== value.n8n.launchPid || value.n8n.port !== 5678
  || value.n8n.database.path !== n8nDb
  || !keys(value.counts, countKeys) || !countKeys.every(key => value.counts[key] === 0)
  || !/^[a-f0-9]{64}$/u.test(value.queueDigestSha256)
  || !keys(value.rollback, ['dev', 'ino', 'path', 'sha256'])
  || value.rollback.path !== rollbackProof || !/^\d+$/u.test(value.rollback.dev)
  || !/^\d+$/u.test(value.rollback.ino) || !/^[a-f0-9]{64}$/u.test(value.rollback.sha256)
  || !keys(value.supervisor, ['disabled', 'loaded', 'lockAbsent', 'workerPids'])
  || value.supervisor.disabled !== true || value.supervisor.loaded !== false
  || value.supervisor.lockAbsent !== true || !Array.isArray(value.supervisor.workerPids)
  || value.supervisor.workerPids.length !== 0
  || !keys(value.frozen, ['argvSha256', 'database', 'expiresAt', 'guardNonceSha256', 'issuedAt',
    'legacyBindingSha256', 'mode', 'n8nDatabase', 'pid', 'ready', 'schema', 'scriptSha256', 'socket', 'startedAt', 'uid'])
  || value.frozen.schema !== 'video-autoworker-legacy-freeze-guard/v1'
  || value.frozen.mode !== 'dual'
  || value.frozen.ready !== true
  || !Number.isSafeInteger(value.frozen.pid) || value.frozen.pid <= 0
  || !Number.isSafeInteger(value.frozen.uid) || value.frozen.uid !== process.getuid()
  || !['argvSha256', 'guardNonceSha256', 'legacyBindingSha256', 'scriptSha256']
    .every(key => /^[a-f0-9]{64}$/u.test(value.frozen[key]))
  || !fileIdentity(value.frozen.database) || !fileIdentity(value.frozen.n8nDatabase)
  || !fileIdentity(value.frozen.socket)
  || value.frozen.database.path !== liveDb || typeof value.frozen.startedAt !== 'string'
  || value.frozen.n8nDatabase.path !== n8nDb
  || !Number.isSafeInteger(value.frozen.issuedAt) || !Number.isSafeInteger(value.frozen.expiresAt)
  || value.frozen.issuedAt > Number(rawNow)
  || (!staticRecovery && value.frozen.expiresAt < Number(rawNow))
  || value.frozen.expiresAt - value.frozen.issuedAt < 30
  || value.frozen.expiresAt - value.frozen.issuedAt > 1800
  || !Number.isSafeInteger(value.observedAt)) process.exit(4)
const age = Number(rawNow) - value.observedAt
// Once immutable pending v4 proves the legacy process has stopped, the old
// evidence is historical identity only. Fresh safety is established by the
// one-use resume snapshot under newly acquired database reservations.
if (age < 0 || (!staticRecovery && age > Number(rawMaxAge))) process.exit(5)
process.stdout.write(`${value.legacy.releaseId}\n${value.legacy.pid}\n${value.legacy.cwd.path}\n`
  + `${value.n8n.pid}\n${value.n8n.database.path}\n${value.observedAt}\n${value.frozen.socket.path}\n`)
NODE
  )" || fail "bootstrap evidence is invalid, stale, not frozen, or not fully zero"
  legacy_release="$(printf '%s\n' "$evidence_values" | sed -n '1p')"
  legacy_pid="$(printf '%s\n' "$evidence_values" | sed -n '2p')"
  if (( pending_exists == 1 )) && [[ "$legacy_pid" != "$pending_legacy_pid" ]]; then
    fail "bootstrap evidence legacy PID does not match the pending marker"
  fi
  legacy_cwd="$(printf '%s\n' "$evidence_values" | sed -n '3p')"
  n8n_pid="$(printf '%s\n' "$evidence_values" | sed -n '4p')"
  legacy_state="$(probe_evidenced_legacy_state)"
  if (( pending_exists == 1 )) && [[ "$legacy_state" == stopped ]]; then
    n8n_listener_pid="$(lsof -tiTCP:5678 -sTCP:LISTEN 2>/dev/null | sort -u)"
    [[ "$n8n_listener_pid" =~ ^[1-9][0-9]*$ ]] \
      || fail "bootstrap disaster recovery requires exactly one managed n8n listener"
    n8n_pid="$n8n_listener_pid"
  fi
  [[ "$(printf '%s\n' "$evidence_values" | sed -n '5p')" == "$n8n_db" ]] \
    || fail "bootstrap evidence does not bind AIWORKER_BG_N8N_DB_PATH"
  evidence_observed="$(printf '%s\n' "$evidence_values" | sed -n '6p')"
  guard_socket="$(printf '%s\n' "$evidence_values" | sed -n '7p')"
  guard_token="$(dirname "$guard_socket")/guard.token"
  evidence_sha="$verified_evidence_sha"
  legacy_cwd="$(physical_path "$legacy_cwd")" || fail "unable to resolve legacy cwd"
  "$NODE_BIN" - "$legacy_cwd" "$legacy_release" <<'NODE' \
    || fail "legacy release ID is not bound to its physical cwd"
const path = require('node:path')
const [cwd, releaseId] = process.argv.slice(2)
const candidate = path.basename(cwd) === 'standalone' ? path.basename(path.dirname(cwd)) : path.basename(cwd)
if (candidate !== releaseId) process.exit(1)
NODE
  BOOTSTRAP_MAINTENANCE=1
  command -v lsof >/dev/null 2>&1 || fail "bootstrap requires lsof for exact process verification"
  kill -0 "$n8n_pid" 2>/dev/null || fail "evidenced n8n PID is not running"
  lsof -a -p "$n8n_pid" -Fn 2>/dev/null | sed -n 's/^n//p' | grep -Fxq "$n8n_db" \
    || fail "evidenced n8n PID is not using AIWORKER_BG_N8N_DB_PATH"
  check_legacy_databases_quiescent "$live_db" "$n8n_db" >/dev/null \
    || fail "legacy databases are not quiescent before workflow verification"
  workflow_compatibility="$(check_n8n_workflow_compatibility "$n8n_pid" "$n8n_db" "$source_commit")" \
    || fail "published n8n workflows are not compatible with slot-v1"
  workflow_digest="$($NODE_BIN -e '
    const value = JSON.parse(process.argv[1])
    const databasePath = process.argv[2]
    const sourceCommit = process.argv[3]
    if (value.schema !== "video-autoworker-n8n-workflow-compatibility/v2"
      || value.protocol !== "slot-v1-execution-owner-v1"
      || value.sourceCommit !== sourceCommit
      || value.databasePath !== databasePath
      || !/^[a-f0-9]{64}$/u.test(value.runtimeIdentitySha256)
      || !/^[a-f0-9]{64}$/u.test(value.combinedSha256)
      || !Array.isArray(value.workflows) || value.workflows.length !== 2) process.exit(2)
    process.stdout.write(value.combinedSha256)
  ' "$workflow_compatibility" "$n8n_db" "$source_commit")" \
    || fail "published n8n workflow compatibility result is invalid"
  bootstrap_authorization="$("$NODE_BIN" "$bootstrap_controller" status --attempt-dir "$attempt_dir")" \
    || fail "legacy bootstrap confirmation and workflow transition chain is invalid"
  workflow_report="$("$NODE_BIN" - "$bootstrap_authorization" <<'NODE'
const fs = require('node:fs')
const value = JSON.parse(process.argv[2])
const transition = value.bindings?.transition
if (!transition || typeof transition.attestation?.path !== 'string'
  || !transition.attestation.path.startsWith('/') || !/^[a-f0-9]{64}$/u.test(transition.attestation.sha256 || '')) process.exit(2)
const attestation = JSON.parse(fs.readFileSync(transition.attestation.path, 'utf8'))
const report = attestation?.deployed?.report
if (!report || typeof report.path !== 'string' || !report.path.startsWith('/')
  || !/^[a-f0-9]{64}$/u.test(report.sha256 || '')) process.exit(3)
process.stdout.write(report.path)
NODE
  )" || fail "workflow transition attestation does not expose its pinned live report"
  assert_immutable_private_file "attested n8n workflow compatibility report" "$workflow_report"
  "$NODE_BIN" - "$workflow_report" "$workflow_compatibility" <<'NODE' \
    || fail "attested n8n workflow compatibility report differs from the current verified runtime"
const fs = require('node:fs')
const [pathname, rawExpected] = process.argv.slice(2)
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
if (JSON.stringify(canonical(JSON.parse(fs.readFileSync(pathname, 'utf8'))))
  !== JSON.stringify(canonical(JSON.parse(rawExpected)))) process.exit(2)
NODE
  legacy_state="$(probe_evidenced_legacy_state)"
  if (( pending_exists == 1 )) && [[ "$legacy_state" == alive ]]; then
    evidence_age=$(( now - evidence_observed ))
    (( evidence_age >= 0 && evidence_age <= BOOTSTRAP_EVIDENCE_MAX_AGE )) \
      || fail "bootstrap retry requires fresh zero-work evidence while the legacy PID is still alive"
  fi
  [[ "$legacy_release" != "$release_id" ]] || fail "baseline release must differ from the legacy release"
  canonical_router_state="$STATE_FILE"
  other_slot="$([[ "$slot" == blue ]] && printf green || printf blue)"
  legacy_state="$(probe_evidenced_legacy_state)"
  if (( pending_exists == 1 )) && [[ "$legacy_state" == stopped ]]; then
    if [[ -S "$guard_socket" && ! -L "$guard_socket" && -f "$guard_token" && ! -L "$guard_token" ]] \
      && "$NODE_BIN" "$guard_controller" status --socket "$guard_socket" \
        --database "$live_db" --n8n-database "$n8n_db" >/dev/null 2>&1; then
      guard_available=1
    elif [[ -e "$guard_socket" || -L "$guard_socket" || -e "$guard_token" || -L "$guard_token" ]]; then
      [[ -S "$guard_socket" && ! -L "$guard_socket" && -f "$guard_token" && ! -L "$guard_token" ]] \
        || fail "partial stale freeze guard state cannot be recovered automatically"
      "$NODE_BIN" "$guard_controller" recover-stale --socket "$guard_socket" \
        --token-file "$guard_token" --database "$live_db" --n8n-database "$n8n_db" >/dev/null \
        || fail "unable to prove and remove stale freeze guard state"
    fi
  fi
  legacy_state="$(probe_evidenced_legacy_state)"
  if (( pending_exists == 1 && guard_available == 0 )) && [[ "$legacy_state" == stopped ]]; then
    n8n_runtime_cwd="$(lsof -a -p "$n8n_pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
    [[ -n "$n8n_runtime_cwd" && "$n8n_runtime_cwd" == */ops/n8n ]] \
      || fail "managed n8n runtime cwd cannot be resolved for bootstrap recovery"
    n8n_runtime_release="$(physical_path "$(dirname "$(dirname "$n8n_runtime_cwd")")")" \
      || fail "managed n8n runtime release cannot be resolved"
    recovery_parent="$attempt_dir/disaster-recovery-attempts"
    recovery_attempt="$($NODE_BIN - "$attempt_dir" "$recovery_parent" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const [attempt, parent] = process.argv.slice(2)
const assertDirectory = (pathname, mode) => {
  const value = fs.lstatSync(pathname, { bigint: true })
  if (!value.isDirectory() || value.isSymbolicLink() || value.uid !== BigInt(process.getuid())
    || (value.mode & 0o7777n) !== BigInt(mode) || fs.realpathSync.native(pathname) !== pathname) process.exit(2)
}
assertDirectory(attempt, 0o700)
if (parent !== path.join(attempt, 'disaster-recovery-attempts')) process.exit(3)
try { fs.mkdirSync(parent, { mode: 0o700 }) } catch (error) { if (error?.code !== 'EEXIST') throw error }
assertDirectory(parent, 0o700)
const branchPath = path.join(attempt, 'recovery-branch.claim.json')
if (fs.existsSync(branchPath)) {
  const branchEntry = fs.lstatSync(branchPath, { bigint: true })
  const branch = JSON.parse(fs.readFileSync(branchPath, 'utf8'))
  if (!branchEntry.isFile() || branchEntry.isSymbolicLink()
    || branchEntry.uid !== BigInt(process.getuid()) || (branchEntry.mode & 0o7777n) !== 0o400n
    || branchEntry.nlink !== 1n
    || branch.schema !== 'video-autoworker-legacy-bootstrap-recovery-branch/v2'
    || branch.branch !== 'resume') process.exit(4)
}
const entries = fs.readdirSync(parent, { withFileTypes: true })
if (entries.length > 1_000 || entries.some(entry => !entry.isDirectory()
  || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(entry.name))) {
  process.exit(5)
}
const resumable = []
for (const entry of entries) {
  const candidate = path.join(parent, entry.name)
  assertDirectory(candidate, 0o700)
  const names = fs.readdirSync(candidate).sort()
  const allowed = new Set(['guard.log', 'resume.consumed.json', 'resume.receipt.json', 'resume.token.json'])
  if (names.some(name => !allowed.has(name))) continue
  const hasReceipt = names.includes('resume.receipt.json')
  const hasToken = names.includes('resume.token.json')
  const consumed = names.includes('resume.consumed.json')
  if (hasReceipt && !hasToken && !consumed) process.exit(6)
  if (consumed) continue
  if (!hasReceipt && !hasToken && !names.includes('guard.log')) {
    resumable.push(candidate)
    continue
  }
  if (hasToken) {
    const tokenPath = path.join(candidate, 'resume.token.json')
    const tokenEntry = fs.lstatSync(tokenPath, { bigint: true })
    let token
    try { token = JSON.parse(fs.readFileSync(tokenPath, 'utf8')) } catch { process.exit(7) }
    if (!tokenEntry.isFile() || tokenEntry.isSymbolicLink()
      || tokenEntry.uid !== BigInt(process.getuid()) || (tokenEntry.mode & 0o7777n) !== 0o600n
      || tokenEntry.nlink !== 1n || token.schema !== 'video-autoworker-legacy-bootstrap-resume-capability/v2'
      || token.recoveryAttemptId !== entry.name || !Number.isSafeInteger(token.expiresAt)) process.exit(8)
    if (token.expiresAt > Math.floor(Date.now() / 1000)) resumable.push(candidate)
  }
}
if (resumable.length > 1) process.exit(9)
if (resumable.length === 1) {
  process.stdout.write(resumable[0])
  process.exit(0)
}
for (let index = 0; index < 8; index += 1) {
  const candidate = path.join(parent, crypto.randomUUID())
  try {
    fs.mkdirSync(candidate, { mode: 0o700 })
    const descriptor = fs.openSync(parent, fs.constants.O_RDONLY)
    try { fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
    process.stdout.write(candidate)
    process.exit(0)
  } catch (error) { if (error?.code !== 'EEXIST') throw error }
}
process.exit(10)
NODE
    )" || fail "unable to create a private bootstrap recovery attempt"
    "$NODE_BIN" "$bootstrap_controller" derive-bootstrap-resume \
      --prepare "$attempt_dir/prepare.receipt.json" \
      --confirm "$attempt_dir/current-confirm.receipt.json" \
      --shutdown "$attempt_dir/shutdown-requested.receipt.json" \
      --pending "$pending" --runtime-release "$n8n_runtime_release" --n8n-pid "$n8n_pid" \
      --recovery-attempt-dir "$recovery_attempt" >/dev/null \
      || fail "fresh bootstrap resume capability could not be derived"
    "$NODE_BIN" "$guard_controller" serve-recovery --database "$live_db" \
      --n8n-database "$n8n_db" --socket "$guard_socket" --token-file "$guard_token" \
      --resume-receipt "$recovery_attempt/resume.receipt.json" \
      --resume-token "$recovery_attempt/resume.token.json" --ttl-seconds 1800 \
      >"$recovery_attempt/guard.log" 2>&1 &
    recovery_guard_pid=$!
    chmod 600 "$recovery_attempt/guard.log"
    deadline=$(( $(date +%s) + 15 ))
    while [[ ! -S "$guard_socket" || ! -f "$guard_token" ]]; do
      kill -0 "$recovery_guard_pid" 2>/dev/null \
        || fail "bootstrap recovery guard exited before becoming ready"
      (( $(date +%s) < deadline )) || fail "bootstrap recovery guard did not become ready"
      sleep 1
    done
  fi
  [[ -S "$guard_socket" && ! -L "$guard_socket" && -f "$guard_token" && ! -L "$guard_token" ]] \
    || fail "verified dual-database freeze guard is unavailable before bootstrap authorization"
  guard_status="$("$NODE_BIN" "$guard_controller" status --socket "$guard_socket" \
    --database "$live_db" --n8n-database "$n8n_db")" \
    || fail "unable to attest the dual-database freeze guard before bootstrap authorization"
  guard_mode="$("$NODE_BIN" -e '
    const value = JSON.parse(process.argv[1])
    if (!value || !["dual", "dual-recovery", "recovery-hold"].includes(value.mode)) process.exit(2)
    process.stdout.write(value.mode)
  ' "$guard_status")" || fail "freeze guard mode is invalid"
  allow_expired_authorization=0
  legacy_state="$(probe_evidenced_legacy_state)"
  if [[ "$legacy_state" == alive ]]; then
    [[ "$guard_mode" == dual ]] || fail "live legacy shutdown requires the full dual-database freeze"
  else
    (( pending_exists == 1 )) || fail "a stopped legacy runtime requires an existing bootstrap pending marker"
    [[ "$guard_mode" == dual || "$guard_mode" == dual-recovery || "$guard_mode" == recovery-hold ]] \
      || fail "stopped legacy recovery requires the managed n8n recovery hold"
    allow_expired_authorization=1
  fi
  bootstrap_authorization="$("$NODE_BIN" "$bootstrap_controller" status --attempt-dir "$attempt_dir")" \
    || fail "legacy bootstrap confirmation chain is invalid"
  proof_sha="$(shasum -a 256 "$rollback_proof" | awk '{print $1}')"
  "$NODE_BIN" - "$bootstrap_authorization" "$allow_expired_authorization" "$source_commit" \
    "$slot" "$release_id" "$physical_root" "$manifest" "$evidence_file" "$evidence_sha" \
    "$rollback_proof" "$proof_sha" "$live_db" "$n8n_db" "$(physical_path "$RUN_DIR")" \
    "$STATE_FILE" "$ROUTER_PORT" <<'NODE' \
    || fail "legacy bootstrap confirmation is expired or bound to another operation"
const value = JSON.parse(process.argv[2])
const [rawAllowExpired, sourceCommit, slot, releaseId, releaseRoot, manifestSha256,
  evidencePath, evidenceSha256, proofPath, proofSha256, missionDb, n8nDb,
  runDirectory, statePath, rawPort] = process.argv.slice(3)
const binding = value.bindings
if (value.phase !== 'SHUTDOWN_REQUESTED' || typeof value.attemptId !== 'string'
  || !Number.isSafeInteger(value.expiresAt) || value.tokenPresent !== false
  || (rawAllowExpired !== '1' && value.expired !== false)
  || !binding || binding.sourceCommit !== sourceCommit
  || binding.target?.slot !== slot || binding.target?.releaseId !== releaseId
  || binding.target?.releaseRoot !== releaseRoot
  || binding.target?.manifest?.sha256 !== manifestSha256
  || binding.evidence?.path !== evidencePath || binding.evidence?.sha256 !== evidenceSha256
  || binding.proof?.path !== proofPath || binding.proof?.sha256 !== proofSha256
  || binding.databases?.mission?.path !== missionDb || binding.databases?.n8n?.path !== n8nDb
  || binding.routing?.runDirectory?.path !== runDirectory
  || binding.routing?.statePath !== statePath || binding.routing?.port !== Number(rawPort)) process.exit(2)
NODE
  pending_payload="$($NODE_BIN - "$bootstrap_authorization" "$attempt_dir" "$slot" "$release_id" \
    "$physical_root" "$manifest" "$legacy_release" "$legacy_pid" "$legacy_cwd" \
    "$evidence_observed" "$source_commit" "$n8n_pid" "$workflow_digest" "$workflow_report" <<'NODE'
const fs = require('node:fs')
const crypto = require('node:crypto')
const path = require('node:path')
const [rawAuthorization, attemptDir, slot, releaseId, releaseRoot, manifestSha256,
  legacyReleaseId, rawLegacyPid, legacyCwd, rawObservedAt, sourceCommit,
  rawN8nPid, n8nWorkflowDigest, workflowReportPath] = process.argv.slice(2)
const status = JSON.parse(rawAuthorization)
const reference = pathname => {
  const before = fs.lstatSync(pathname, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== BigInt(process.getuid())
    || (before.mode & 0o7777n) !== 0o400n || before.nlink !== 1n) process.exit(2)
  const fd = fs.openSync(pathname, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const opened = fs.fstatSync(fd, { bigint: true })
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) process.exit(3)
    const source = fs.readFileSync(fd)
    const after = fs.lstatSync(pathname, { bigint: true })
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) process.exit(4)
    return { path: pathname, dev: opened.dev.toString(), ino: opened.ino.toString(),
      size: Number(opened.size), sha256: crypto.createHash('sha256').update(source).digest('hex') }
  } finally { fs.closeSync(fd) }
}
if (path.resolve(attemptDir) !== attemptDir || status.phase !== 'SHUTDOWN_REQUESTED'
  || !/^[a-f0-9-]{36}$/u.test(status.attemptId || '')) process.exit(5)
const prepare = reference(path.join(attemptDir, 'prepare.receipt.json'))
const confirm = reference(path.join(attemptDir, 'current-confirm.receipt.json'))
const shutdown = reference(path.join(attemptDir, 'shutdown-requested.receipt.json'))
const workflowReport = reference(workflowReportPath)
process.stdout.write(JSON.stringify({
  schema: 'video-autoworker-blue-green-bootstrap-pending/v4',
  createdAt: Math.floor(Date.now() / 1000),
  attemptId: status.attemptId,
  slot,
  releaseId,
  releaseRoot,
  manifestSha256,
  legacyReleaseId,
  legacyPid: Number(rawLegacyPid),
  legacyCwd,
  evidence: status.bindings.evidence,
  evidenceObservedAt: Number(rawObservedAt),
  proof: status.bindings.proof,
  transition: status.bindings.transition,
  bootstrapClaim: status.bindings.transition.claim,
  authorization: { prepare, confirm, shutdown },
  databases: status.bindings.databases,
  router: status.bindings.routing,
  n8n: {
    pid: Number(rawN8nPid),
    dbPath: status.bindings.databases.n8n.path,
    workflowProtocol: 'slot-v1-execution-owner-v1',
    workflowSourceCommit: sourceCommit,
    workflowDigest: n8nWorkflowDigest,
    workflowReport,
  },
  baselineSourceCommit: sourceCommit,
}))
NODE
  )" || fail "unable to build immutable bootstrap pending v4"
  if [[ -e "$pending" || -L "$pending" ]]; then
    if (( evidence_static_recovery == 1 )); then
      assert_bootstrap_pending_identity "$pending" "$(<"$pending")"
    else
      assert_bootstrap_pending_identity "$pending" "$pending_payload"
    fi
  else
    [[ ! -e "$STATE_FILE" && ! -L "$STATE_FILE" ]] \
      || fail "ordinary init cannot be promoted into a legacy bootstrap; use a clean run directory"
    [[ ! -e "$(binding_file blue)" && ! -L "$(binding_file blue)" \
      && ! -e "$(binding_file green)" && ! -L "$(binding_file green)" ]] \
      || fail "legacy bootstrap requires unused slot bindings"
    write_json_immutable "$pending" "$pending_payload" \
      || fail "unable to publish immutable bootstrap pending v4"
    assert_immutable_private_file "bootstrap pending marker" "$pending"
  fi
  legacy_state="$(probe_evidenced_legacy_state)"
  if [[ "$legacy_state" == alive ]]; then
    [[ "$(env -u NODE_ENV \
      -u AIWORKER_TEST_LEGACY_FREEZE \
      -u AIWORKER_TEST_LEGACY_FREEZE_GUARD_SOCKET \
      -u AIWORKER_TEST_LEGACY_FREEZE_REPOSITORY_ROOT \
      -u AIWORKER_TEST_LEGACY_FREEZE_SAMPLE_DELAY_MS \
      -u AIWORKER_TEST_LEGACY_FREEZE_SNAPSHOT_COMMAND \
      "$NODE_BIN" "$evidence_generator" --verify-evidence-fd "$evidence_fd" \
        --output "$evidence_file" --slot "$slot" --release-id "$release_id" \
        --standalone-root "$physical_root" --rollback-proof "$rollback_proof")" == "$evidence_sha" ]] \
      || fail "legacy or n8n full identity changed immediately before SIGTERM"
    kill -TERM "$legacy_pid"
    deadline=$(( $(date +%s) + 30 ))
    while [[ "$(probe_evidenced_legacy_state)" == alive ]] \
      && (( $(date +%s) < deadline )); do sleep 1; done
  fi
  [[ "$(probe_evidenced_legacy_state)" == stopped ]] \
    || fail "legacy PID did not exit after SIGTERM; no force kill was attempted"
  for _ in 1 2 3 4 5; do
    listeners="$(lsof -tiTCP:"$ROUTER_PORT" -sTCP:LISTEN 2>/dev/null | sort -u)"
    [[ -z "$listeners" ]] || fail "router port $ROUTER_PORT was reclaimed after legacy shutdown; supervisor is not quiesced"
    sleep 1
  done
  [[ "$(env -u NODE_ENV \
    -u AIWORKER_TEST_LEGACY_FREEZE \
    -u AIWORKER_TEST_LEGACY_FREEZE_GUARD_SOCKET \
    -u AIWORKER_TEST_LEGACY_FREEZE_REPOSITORY_ROOT \
    -u AIWORKER_TEST_LEGACY_FREEZE_SAMPLE_DELAY_MS \
    -u AIWORKER_TEST_LEGACY_FREEZE_SNAPSHOT_COMMAND \
    "$NODE_BIN" "$evidence_generator" --verify-evidence-static-fd "$evidence_fd" \
      --output "$evidence_file" --slot "$slot" --release-id "$release_id" \
      --standalone-root "$physical_root" --rollback-proof "$rollback_proof")" == "$evidence_sha" ]] \
    || fail "bootstrap evidence or external ingress freeze changed during legacy shutdown"
  kill -0 "$n8n_pid" 2>/dev/null || fail "n8n PID changed or stopped during bootstrap"
  lsof -a -p "$n8n_pid" -Fn 2>/dev/null | sed -n 's/^n//p' | grep -Fxq "$n8n_db" \
    || fail "n8n database identity changed during bootstrap"
  check_legacy_databases_quiescent "$live_db" "$n8n_db" >/dev/null \
    || fail "legacy databases changed after ingress shutdown"
  workflow_compatibility_after="$(check_n8n_workflow_compatibility "$n8n_pid" "$n8n_db" "$source_commit")" \
    || fail "published n8n workflow compatibility changed during legacy shutdown"
  [[ "$workflow_compatibility_after" == "$workflow_compatibility" ]] \
    || fail "published n8n workflow digest changed during legacy shutdown"

  [[ -S "$guard_socket" && ! -L "$guard_socket" && -f "$guard_token" && ! -L "$guard_token" ]] \
    || fail "legacy freeze guard recovery state is incomplete"
  if [[ "$guard_mode" == dual ]]; then
    "$NODE_BIN" "$guard_controller" handoff --socket "$guard_socket" \
      --token-file "$guard_token" --database "$live_db" --n8n-database "$n8n_db" >/dev/null \
      || fail "unable to enter the managed post-shutdown n8n recovery hold"
  fi
  guard_status="$("$NODE_BIN" "$guard_controller" status --socket "$guard_socket" \
    --database "$live_db" --n8n-database "$n8n_db")" \
    || fail "post-shutdown n8n recovery hold is unavailable"
  guard_mode="$("$NODE_BIN" -e '
    const value = JSON.parse(process.argv[1])
    if (value?.mode !== "recovery-hold") process.exit(2)
    process.stdout.write(value.mode)
  ' "$guard_status")" || fail "post-shutdown n8n recovery hold did not become active"
  listeners="$(lsof -tiTCP:"$ROUTER_PORT" -sTCP:LISTEN 2>/dev/null | sort -u)"
  [[ -z "$listeners" ]] || fail "router port was reclaimed before managed baseline startup"

  binding_payload="$($NODE_BIN -e '
    const [slot, releaseId, releaseRoot, manifestSha, port] = process.argv.slice(1)
    process.stdout.write(JSON.stringify({ schema: "video-autoworker-standalone-slot/v1", slot,
      releaseId, releaseRoot, manifestSha256: manifestSha, host: "127.0.0.1", port: Number(port),
      boundAt: new Date().toISOString() }))
  ' "$slot" "$release_id" "$physical_root" "$manifest" "$(slot_port "$slot")")"
  write_json_atomic "$(binding_file "$slot")" "$binding_payload"
  state_payload="$($NODE_BIN -e '
    const [active, other, activePort, otherPort, releaseId] = process.argv.slice(1)
    const slots = {}
    slots[active] = { host: "127.0.0.1", port: Number(activePort), releaseId }
    slots[other] = { host: "127.0.0.1", port: Number(otherPort), releaseId: `unbound-${other}` }
    process.stdout.write(JSON.stringify({ schema: "video-autoworker-standalone-router/v1", generation: 1,
      active, previous: null, updatedAt: new Date().toISOString(), slots }))
  ' "$slot" "$other_slot" "$(slot_port "$slot")" "$(slot_port "$other_slot")" "$release_id")"
  if [[ -e "$STATE_FILE" || -L "$STATE_FILE" ]]; then
    validate_state
    [[ "$(read_state_field generation)" == 1 && "$(read_state_field active)" == "$slot" \
      && "$(read_state_field previous)" == "" && "$(read_state_slot_release "$slot")" == "$release_id" ]] \
      || fail "bootstrap recovery found a non-baseline router state"
  else
    write_router_state_atomic "$state_payload"
    validate_state
  fi
  canonical_router_state="$(physical_path "$STATE_FILE")"
  "$manager" start "$slot" || fail "managed baseline slot failed to start"
  deadline=$(( $(date +%s) + 30 ))
  while ! curl -fsS --max-time 2 "http://127.0.0.1:$(slot_port "$slot")$PROBE_PATH" >/dev/null 2>&1; do
    (( $(date +%s) < deadline )) || fail "managed baseline slot did not become ready"
    sleep 1
  done
  probe_slot "$slot" active
  intake_revision="$(ensure_bootstrap_intake_paused 127.0.0.1 "$(slot_port "$slot")")" \
    || fail "unable to establish the baseline global intake pause"
  "$manager" start router || fail "managed standalone router failed to start"
  deadline=$(( $(date +%s) + 30 ))
  while ! curl -fsS --max-time 2 "http://$ROUTER_HOST:$ROUTER_PORT/__router/health" >/dev/null 2>&1; do
    (( $(date +%s) < deadline )) || fail "managed standalone router did not become ready"
    sleep 1
  done
  assert_router_identity "$slot" "$release_id" 1 >/dev/null
  baseline_readiness="$(check_json_endpoint readiness \
    "http://$ROUTER_HOST:$ROUTER_PORT$READINESS_PATH" "$slot" "$release_id" "$(slot_port "$slot")" \
    "$intake_revision" "" 1)" || fail "baseline release readiness verification failed"
  baseline_epoch="$(printf '%s\n' "$baseline_readiness" | sed -n '2p')"
  verify_routed_release "$slot" "$release_id" 1 "$intake_revision" "$baseline_epoch" \
    || fail "baseline routed health, page, or read-only API verification failed"
  baseline_verified_contract="$(verify_director_video_release_chain "$release_id" "$physical_root")" \
    || fail "baseline director/video release chain is incompatible"
  [[ "$baseline_verified_contract" == "$bootstrap_preflight_contract" ]] \
    || fail "post-migration projection contract differs from the pre-shutdown release preflight"
  "$manager" status "$slot" >/dev/null \
    && "$manager" status router >/dev/null \
    || fail "baseline processes are healthy but not under the expected service manager"
  workflow_compatibility_final="$(check_n8n_workflow_compatibility "$n8n_pid" "$n8n_db" "$source_commit")" \
    || fail "published n8n workflow compatibility changed before baseline commit"
  [[ "$workflow_compatibility_final" == "$workflow_compatibility_after" ]] \
    || fail "published n8n workflow digest changed before baseline commit"
  workflow_digest="$($NODE_BIN -e '
    const value = JSON.parse(process.argv[1])
    if (value.schema !== "video-autoworker-n8n-workflow-compatibility/v2"
      || value.protocol !== "slot-v1-execution-owner-v1"
      || !/^[a-f0-9]{64}$/u.test(value.combinedSha256)) process.exit(2)
    process.stdout.write(value.combinedSha256)
  ' "$workflow_compatibility_final")" \
    || fail "final published n8n workflow compatibility result is invalid"
  baseline_payload="$($NODE_BIN -e '
    const [baselineSlot, baselineReleaseId, baselineReleaseRoot, baselineManifestSha256,
      legacyReleaseId, rawLegacyPid, evidenceSha256, dbPath, routerStatePath, rawRouterPort,
      rawN8nPid, n8nDbPath, sourceCommit, n8nWorkflowDigest] = process.argv.slice(1)
    process.stdout.write(JSON.stringify({ schema: "video-autoworker-blue-green-baseline/v3",
      baselineSlot, baselineReleaseId, baselineReleaseRoot, baselineManifestSha256,
      legacyReleaseId, legacyPid: Number(rawLegacyPid), evidenceSha256, dbPath, routerStatePath,
      n8nPid: Number(rawN8nPid), n8nDbPath,
      baselineSourceCommit: sourceCommit, n8nWorkflowProtocol: "slot-v1-execution-owner-v1",
      n8nWorkflowSourceCommit: sourceCommit, n8nWorkflowDigest,
      routerPort: Number(rawRouterPort), completedAt: Math.floor(Date.now() / 1000) }))
  ' "$slot" "$release_id" "$physical_root" "$manifest" "$legacy_release" "$legacy_pid" \
    "$evidence_sha" "$live_db" "$canonical_router_state" "$ROUTER_PORT" "$n8n_pid" "$n8n_db" \
    "$source_commit" "$workflow_digest")"
  write_json_atomic "$(baseline_file)" "$baseline_payload"
  assert_baseline >/dev/null
  "$NODE_BIN" "$guard_controller" revoke --socket "$guard_socket" \
    --token-file "$guard_token" --database "$live_db" --n8n-database "$n8n_db" >/dev/null \
    || fail "unable to release the post-shutdown n8n recovery hold"
  [[ ! -e "$guard_socket" && ! -L "$guard_socket" && ! -e "$guard_token" && ! -L "$guard_token" ]] \
    || fail "post-shutdown n8n recovery hold did not remove its private socket and token"
  kill -0 "$n8n_pid" 2>/dev/null || fail "n8n stopped while releasing the recovery hold"
  exec 9<&-
  remove_immutable_file_durable "completed bootstrap pending marker" "$pending" \
    || fail "unable to durably finalize the completed bootstrap marker"
  BOOTSTRAP_MAINTENANCE=0
  printf 'Established managed blue-green baseline: slot=%s release=%s; legacy release %s is fenced\n' \
    "$slot" "$release_id" "$legacy_release"
}

bind_slot() {
  local slot release_id standalone_root physical_root manifest_sha port payload
  slot="$(require_slot "${1:-}")"
  release_id="${2:-}"
  standalone_root="${3:-}"
  [[ -n "$release_id" && -n "$standalone_root" ]] || { usage >&2; exit 2; }
  acquire_lock
  validate_state
  local active current_release pid_path running_pid proof_required=0 baseline_values legacy_release
  if [[ -e "$(baseline_file)" || -L "$(baseline_file)" ]]; then
    baseline_values="$(assert_baseline)"
    legacy_release="$(printf '%s\n' "$baseline_values" | sed -n '1p')"
    [[ "$release_id" != "$legacy_release" ]] \
      || fail "the pre-baseline legacy release is permanently fenced from blue-green slots"
  fi
  active="$(read_state_field active)"
  current_release="$(read_state_slot_release "$slot")"
  pid_path="$RUN_DIR/slots/$slot.pid"
  if [[ -f "$pid_path" && ! -L "$pid_path" ]]; then
    running_pid="$(tr -d '[:space:]' < "$pid_path")"
    if [[ "$running_pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$running_pid" 2>/dev/null; then
      fail "refusing to rebind a running $slot slot"
    fi
  fi
  if [[ "$active" == "$slot" && "$current_release" != unbound-* ]]; then
    fail "refusing to rebind the active $slot slot"
  fi
  if [[ "$current_release" != unbound-* ]]; then
    proof_required=1
    assert_retirement_proof "$slot" "$current_release"
  elif [[ -e "$(binding_file "$slot")" || -L "$(binding_file "$slot")" ]]; then
    fail "refusing to replace an unactivated $slot binding; no production retirement proof can exist"
  fi
  physical_root="$(assert_release "$release_id" "$standalone_root")"
  manifest_sha="$(release_manifest_sha "$physical_root")"
  port="$(slot_port "$slot")"
  payload="$($NODE_BIN -e '
    const [slot, releaseId, releaseRoot, manifestSha, port] = process.argv.slice(1)
    process.stdout.write(JSON.stringify({
      schema: "video-autoworker-standalone-slot/v1",
      slot,
      releaseId,
      releaseRoot,
      manifestSha256: manifestSha,
      host: "127.0.0.1",
      port: Number(port),
      boundAt: new Date().toISOString(),
    }))
  ' "$slot" "$release_id" "$physical_root" "$manifest_sha" "$port")"
  write_json_atomic "$(binding_file "$slot")" "$payload"
  if [[ "$active" == "$slot" && "$current_release" == unbound-* ]]; then
    payload="$($NODE_BIN -e '
      const fs = require("node:fs")
      const [path, slot, releaseId] = process.argv.slice(1)
      const value = JSON.parse(fs.readFileSync(path, "utf8"))
      value.slots[slot].releaseId = releaseId
      value.updatedAt = new Date().toISOString()
      process.stdout.write(JSON.stringify(value))
    ' "$STATE_FILE" "$slot" "$release_id")"
    write_router_state_atomic "$payload"
    validate_state
  fi
  if (( proof_required == 1 )); then
    rm -f -- "$(retirement_file "$slot")" "$(callback_freeze_file "$slot")"
  fi
  printf 'Bound %s to immutable release %s on port %s\n' "$slot" "$release_id" "$port"
}

binding_values() {
  local slot="$1"
  local pathname
  pathname="$(binding_file "$slot")"
  assert_secure_file "$slot binding" "$pathname"
  "$NODE_BIN" -e '
    const fs = require("node:fs")
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
    const slot = process.argv[2]
    if (value.schema !== "video-autoworker-standalone-slot/v1" || value.slot !== slot) process.exit(2)
    for (const field of ["releaseId", "releaseRoot", "manifestSha256", "host", "port"]) {
      const item = value[field]
      if (item === undefined || String(item).includes("\n")) process.exit(3)
      process.stdout.write(`${item}\n`)
    }
  ' "$pathname" "$slot"
}

runtime_attestation_values() {
  local slot="$1"
  local pathname
  pathname="$(runtime_attestation_file "$slot")"
  assert_private_file "$slot runtime attestation" "$pathname"
  "$NODE_BIN" -e '
    const fs = require("node:fs")
    const path = require("node:path")
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
    const slot = process.argv[2]
    const expectedKeys = [
      "createdAt", "dbPath", "host", "manifestSha256", "pid", "port",
      "releaseId", "role", "routerStatePath", "schema", "slot",
    ]
    if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys)) process.exit(2)
    if (value.schema !== "video-autoworker-standalone-runtime/v1" || value.slot !== slot) process.exit(3)
    if (!Number.isSafeInteger(value.pid) || value.pid <= 0) process.exit(4)
    if (!["active", "probe", "drain"].includes(value.role)) process.exit(5)
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u.test(value.releaseId)) process.exit(6)
    if (!/^[a-f0-9]{64}$/u.test(value.manifestSha256)) process.exit(7)
    if (value.host !== "127.0.0.1" || !Number.isInteger(value.port)) process.exit(8)
    if (typeof value.dbPath !== "string" || !path.isAbsolute(value.dbPath) || /[\r\n]/u.test(value.dbPath)) process.exit(9)
    if (typeof value.routerStatePath !== "string" || !path.isAbsolute(value.routerStatePath)
      || /[\r\n]/u.test(value.routerStatePath)) process.exit(10)
    if (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) process.exit(11)
    for (const field of ["pid", "slot", "role", "releaseId", "manifestSha256", "host", "port", "dbPath", "routerStatePath"]) {
      process.stdout.write(`${value[field]}\n`)
    }
  ' "$pathname" "$slot"
}

read_callback_freeze_values() {
  local slot="$1" release_id="$2" manifest="$3" pid="$4" db="$5" router="$6" generation="$7" active="$8"
  local marker
  marker="$(callback_freeze_file "$slot")"
  assert_private_file "$slot callback freeze marker" "$marker"
  "$NODE_BIN" - "$marker" "$slot" "$release_id" "$manifest" "$pid" "$db" "$router" \
    "$generation" "$active" <<'NODE'
const value = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'))
const [slot, releaseId, manifest, rawPid, db, router, rawGeneration, active] = process.argv.slice(3)
const expectedKeys = ['activeSlot', 'dbPath', 'freezeId', 'frozenAt', 'manifestSha256', 'pid',
  'quiesceId', 'quiescedAt', 'releaseId', 'requiredQuietSeconds', 'routerActiveRequests',
  'routerGeneration', 'routerStatePath', 'routerUpgradedSockets', 'runtimeStartedAt',
  'schedulerObservedAt', 'schema', 'slot']
if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys)
  || value.schema !== 'video-autoworker-callback-freeze/v1' || value.slot !== slot
  || value.releaseId !== releaseId || value.manifestSha256 !== manifest
  || value.pid !== Number(rawPid) || value.dbPath !== db || value.routerStatePath !== router
  || value.routerGeneration !== Number(rawGeneration) || value.activeSlot !== active
  || !/^[a-f0-9]{64}$/u.test(value.freezeId) || !Number.isSafeInteger(value.frozenAt)
  || !Number.isSafeInteger(value.requiredQuietSeconds) || value.requiredQuietSeconds < 30
  || value.requiredQuietSeconds > 900 || !Number.isSafeInteger(value.runtimeStartedAt)
  || !Number.isSafeInteger(value.schedulerObservedAt) || value.schedulerObservedAt < 0
  || value.routerActiveRequests !== 0 || value.routerUpgradedSockets !== 0
  || !((value.quiesceId === null && value.quiescedAt === null)
    || (/^[a-f0-9]{64}$/u.test(value.quiesceId) && Number.isSafeInteger(value.quiescedAt)
      && value.quiescedAt >= value.frozenAt))) process.exit(2)
for (const field of ['freezeId', 'frozenAt', 'quiesceId', 'quiescedAt', 'requiredQuietSeconds',
  'runtimeStartedAt', 'schedulerObservedAt', 'routerActiveRequests', 'routerUpgradedSockets']) {
  process.stdout.write(`${value[field] === null ? '' : value[field]}\n`)
}
NODE
}

assert_retirement_proof() {
  local slot="$1" release_id="$2"
  local proof freeze binding attestation manifest pid role attested_release attested_manifest
  local attested_db attested_router pid_file recorded_pid active previous generation state_updated_at
  local live_db canonical_router_state port
  proof="$(retirement_file "$slot")"
  freeze="$(callback_freeze_file "$slot")"
  assert_private_file "$slot retirement proof" "$proof"
  assert_private_file "$slot callback freeze marker" "$freeze"
  active="$(read_state_field active)"
  previous="$(read_state_field previous)"
  generation="$(read_state_field generation)"
  state_updated_at="$(read_state_field updatedAt)"
  [[ "$active" != "$slot" && "$previous" == "$slot" ]] \
    || fail "$slot retirement proof is not for the current previous slot"
  binding="$(binding_values "$slot")" || fail "$slot binding is invalid"
  [[ "$(printf '%s\n' "$binding" | sed -n '1p')" == "$release_id" ]] \
    || fail "$slot binding release changed before rebind"
  manifest="$(printf '%s\n' "$binding" | sed -n '3p')"
  port="$(printf '%s\n' "$binding" | sed -n '5p')"
  attestation="$(runtime_attestation_values "$slot")" || fail "$slot runtime attestation is invalid"
  pid="$(printf '%s\n' "$attestation" | sed -n '1p')"
  role="$(printf '%s\n' "$attestation" | sed -n '3p')"
  attested_release="$(printf '%s\n' "$attestation" | sed -n '4p')"
  attested_manifest="$(printf '%s\n' "$attestation" | sed -n '5p')"
  attested_db="$(printf '%s\n' "$attestation" | sed -n '8p')"
  attested_router="$(printf '%s\n' "$attestation" | sed -n '9p')"
  [[ "$role" == active && "$attested_release" == "$release_id" && "$attested_manifest" == "$manifest" ]] \
    || fail "$slot retirement proof does not belong to an active production runtime"
  [[ -n "$LIVE_DB_PATH" ]] || fail "AIWORKER_BG_LIVE_DB_PATH is required to consume a retirement proof"
  assert_absolute "AIWORKER_BG_LIVE_DB_PATH" "$LIVE_DB_PATH"
  [[ -f "$LIVE_DB_PATH" ]] || fail "AIWORKER_BG_LIVE_DB_PATH must identify the existing live SQLite database"
  live_db="$(physical_path "$LIVE_DB_PATH")" || fail "unable to resolve AIWORKER_BG_LIVE_DB_PATH"
  canonical_router_state="$(physical_path "$STATE_FILE")" || fail "unable to resolve router state path"
  [[ "$attested_db" == "$live_db" && "$attested_router" == "$canonical_router_state" ]] \
    || fail "$slot retirement proof runtime identity changed"
  read_callback_freeze_values "$slot" "$release_id" "$manifest" "$pid" "$live_db" \
    "$canonical_router_state" "$generation" "$active" >/dev/null \
    || fail "$slot callback freeze marker is invalid or stale"
  pid_file="$RUN_DIR/slots/$slot.pid"
  assert_private_file "$slot PID file" "$pid_file"
  recorded_pid="$(tr -d '[:space:]' < "$pid_file")"
  [[ "$recorded_pid" == "$pid" ]] || fail "$slot PID changed after retirement was certified"
  ! kill -0 "$pid" 2>/dev/null || fail "retired $slot PID is still running"
  [[ -z "$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)" ]] \
    || fail "retired $slot port is still listening"
  [[ -x "$SCRIPT_DIR/manage-blue-green-services.sh" ]] \
    || fail "blue-green service manager is required before rebind"
  ! "$SCRIPT_DIR/manage-blue-green-services.sh" status "$slot" >/dev/null 2>&1 \
    || fail "retired $slot is still enabled or loaded in the service manager"
  "$NODE_BIN" - "$proof" "$freeze" "$slot" "$release_id" "$manifest" "$pid" "$live_db" \
    "$canonical_router_state" "$generation" "$active" "$state_updated_at" <<'NODE' \
    || fail "$slot retirement proof is invalid or stale"
const fs = require('node:fs')
const [proofPath, freezePath, slot, releaseId, manifestSha256, rawPid, dbPath, routerStatePath,
  rawGeneration, activeSlot, stateUpdatedAt] = process.argv.slice(2)
const value = JSON.parse(fs.readFileSync(proofPath, 'utf8'))
const marker = JSON.parse(fs.readFileSync(freezePath, 'utf8'))
const expectedKeys = ['activeSlot', 'dbPath', 'drain', 'freeze', 'manifestSha256', 'observedAt',
  'pid', 'releaseId', 'routerGeneration', 'routerStatePath', 'schema', 'slot']
if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys)) process.exit(2)
if (value.schema !== 'video-autoworker-retirement-proof/v2' || value.slot !== slot
  || value.releaseId !== releaseId || value.manifestSha256 !== manifestSha256
  || value.pid !== Number(rawPid) || value.dbPath !== dbPath || value.routerStatePath !== routerStatePath
  || value.routerGeneration !== Number(rawGeneration) || value.activeSlot !== activeSlot
  || !Number.isSafeInteger(value.observedAt)) process.exit(3)
const updatedAt = Math.floor(Date.parse(stateUpdatedAt) / 1000)
if (!Number.isSafeInteger(updatedAt) || value.observedAt < updatedAt) process.exit(4)
const freezeKeys = ['freezeId', 'frozenAt', 'quiesceId', 'quiescedAt']
if (!value.freeze || JSON.stringify(Object.keys(value.freeze).sort()) !== JSON.stringify(freezeKeys)
  || value.freeze.freezeId !== marker.freezeId || value.freeze.frozenAt !== marker.frozenAt
  || value.freeze.quiesceId !== marker.quiesceId || value.freeze.quiescedAt !== marker.quiescedAt
  || !/^[a-f0-9]{64}$/u.test(value.freeze.quiesceId)
  || !Number.isSafeInteger(value.freeze.quiescedAt)) process.exit(5)
const drain = value.drain
const drainKeys = ['active', 'childExecutionLeases', 'lastActivityAt', 'otherReleaseActive', 'quietSeconds',
  'requiredQuietSeconds', 'routerActiveRequests', 'routerUpgradedSockets',
  'schedulerObservedAt', 'schedulerRouterGeneration', 'schedulerState', 'tracked',
  'untrackedCallbacks']
if (!drain || JSON.stringify(Object.keys(drain).sort()) !== JSON.stringify(drainKeys)) process.exit(6)
for (const key of ['tracked', 'active', 'childExecutionLeases', 'untrackedCallbacks', 'otherReleaseActive',
  'quietSeconds', 'requiredQuietSeconds']) {
  if (!Number.isSafeInteger(drain[key]) || drain[key] < 0) process.exit(7)
}
if (drain.active !== 0 || drain.childExecutionLeases !== 0
  || drain.untrackedCallbacks !== 0 || drain.otherReleaseActive !== 0
  || drain.quietSeconds < drain.requiredQuietSeconds || drain.schedulerState !== 'inactive'
  || drain.routerActiveRequests !== 0 || drain.routerUpgradedSockets !== 0
  || !Number.isSafeInteger(drain.schedulerObservedAt) || drain.schedulerObservedAt < 0
  || drain.schedulerRouterGeneration !== Number(rawGeneration)
  || (drain.lastActivityAt !== null
    && (!Number.isSafeInteger(drain.lastActivityAt) || drain.lastActivityAt < 0))) process.exit(8)
NODE
}

retire_slot() {
  local slot active previous generation release_id state_release binding manifest host port manager
  local attestation pid role attested_release attested_manifest attested_db attested_router live_db canonical_router_state
  local drain_summary scheduler_summary router_summary marker_values payload runtime_started_at required_quiet_seconds
  local scheduler_observed_at router_active_requests router_upgraded_sockets freeze_id frozen_at quiesce_id quiesced_at
  local final_db_summary pid_file recorded_pid
  slot="$(require_slot "${1:-}")"
  acquire_lock
  validate_state
  assert_baseline >/dev/null
  active="$(read_state_field active)"
  previous="$(read_state_field previous)"
  generation="$(read_state_field generation)"
  [[ "$active" != "$slot" && "$previous" == "$slot" ]] \
    || fail "only the immediately previous active slot can be retired"
  state_release="$(read_state_slot_release "$slot")"
  [[ "$state_release" != unbound-* ]] || fail "an unbound slot has no production release to retire"
  binding="$(binding_values "$slot")" || fail "$slot binding is invalid"
  release_id="$(printf '%s\n' "$binding" | sed -n '1p')"
  manifest="$(printf '%s\n' "$binding" | sed -n '3p')"
  host="$(printf '%s\n' "$binding" | sed -n '4p')"
  port="$(printf '%s\n' "$binding" | sed -n '5p')"
  [[ "$state_release" == "$release_id" ]] || fail "$slot router release does not match its binding"
  if [[ -e "$(retirement_file "$slot")" || -L "$(retirement_file "$slot")" ]]; then
    assert_retirement_proof "$slot" "$release_id"
    printf 'Retirement already certified: slot=%s release=%s generation=%s\n' "$slot" "$release_id" "$generation"
    return
  fi
  attestation="$(runtime_attestation_values "$slot")" || fail "$slot runtime attestation is invalid"
  pid="$(printf '%s\n' "$attestation" | sed -n '1p')"
  role="$(printf '%s\n' "$attestation" | sed -n '3p')"
  attested_release="$(printf '%s\n' "$attestation" | sed -n '4p')"
  attested_manifest="$(printf '%s\n' "$attestation" | sed -n '5p')"
  attested_db="$(printf '%s\n' "$attestation" | sed -n '8p')"
  attested_router="$(printf '%s\n' "$attestation" | sed -n '9p')"
  [[ "$role" == active && "$attested_release" == "$release_id" && "$attested_manifest" == "$manifest" ]] \
    || fail "probe or drain runtimes cannot issue a production retirement proof"
  live_db="$(physical_path "$LIVE_DB_PATH")" || fail "unable to resolve AIWORKER_BG_LIVE_DB_PATH"
  canonical_router_state="$(physical_path "$STATE_FILE")" || fail "unable to resolve router state path"
  [[ "$attested_db" == "$live_db" && "$attested_router" == "$canonical_router_state" ]] \
    || fail "$slot retirement runtime does not match the live database or router state"
  pid_file="$RUN_DIR/slots/$slot.pid"
  assert_private_file "$slot PID file" "$pid_file"
  recorded_pid="$(tr -d '[:space:]' < "$pid_file")"
  [[ "$recorded_pid" == "$pid" ]] || fail "$slot PID file does not match its runtime attestation"
  manager="$SCRIPT_DIR/manage-blue-green-services.sh"
  [[ -x "$manager" ]] || fail "blue-green service manager is required for retirement"

  if [[ ! -e "$(callback_freeze_file "$slot")" && ! -L "$(callback_freeze_file "$slot")" ]]; then
    probe_slot "$slot" active
    "$manager" status "$slot" >/dev/null || fail "$slot is not controlled by the service manager"
    router_summary="$(assert_router_identity "$active" "$(read_state_slot_release "$active")" \
      "$generation" "$slot")" || fail "router identity changed before retirement freeze"
    drain_summary="$(check_json_endpoint drain "http://$host:$port$DRAIN_PATH" \
      "$slot" "$release_id" "$port")" || fail "$slot is not globally safe to freeze"
    scheduler_summary="$(check_json_endpoint scheduler "http://$host:$port$SCHEDULER_PATH" \
      "$generation")" || fail "$slot scheduler has not fully relinquished leadership"
    [[ "$(read_state_field active)" == "$active" && "$(read_state_field previous)" == "$slot" \
      && "$(read_state_field generation)" == "$generation" ]] \
      || fail "router state changed before callback freeze"
    payload="$($NODE_BIN -e '
      const fs = require("node:fs")
      const crypto = require("node:crypto")
      const [attestationPath, slot, releaseId, manifestSha256, rawPid, dbPath, routerStatePath,
        rawGeneration, activeSlot, rawDrain, rawScheduler, rawRouter] = process.argv.slice(1)
      const runtime = JSON.parse(fs.readFileSync(attestationPath, "utf8"))
      const drain = JSON.parse(rawDrain)
      const scheduler = JSON.parse(rawScheduler)
      const router = JSON.parse(rawRouter)
      const runtimeStartedAt = Math.floor(Date.parse(runtime.createdAt) / 1000)
      if (!Number.isSafeInteger(runtimeStartedAt)) process.exit(2)
      process.stdout.write(JSON.stringify({
        schema: "video-autoworker-callback-freeze/v1", slot, releaseId, manifestSha256,
        pid: Number(rawPid), dbPath, routerStatePath, routerGeneration: Number(rawGeneration),
        activeSlot, requiredQuietSeconds: drain.requiredQuietSeconds, runtimeStartedAt,
        schedulerObservedAt: scheduler.schedulerObservedAt,
        routerActiveRequests: router.routerActiveRequests,
        routerUpgradedSockets: router.routerUpgradedSockets,
        freezeId: crypto.randomBytes(32).toString("hex"), frozenAt: Math.floor(Date.now() / 1000),
        quiesceId: null, quiescedAt: null,
      }))
    ' "$(runtime_attestation_file "$slot")" "$slot" "$release_id" "$manifest" "$pid" \
      "$attested_db" "$attested_router" "$generation" "$active" "$drain_summary" \
      "$scheduler_summary" "$router_summary")"
    write_json_atomic "$(callback_freeze_file "$slot")" "$payload"
  fi

  marker_values="$(read_callback_freeze_values "$slot" "$release_id" "$manifest" "$pid" \
    "$attested_db" "$attested_router" "$generation" "$active")" \
    || fail "$slot callback freeze marker is invalid"
  freeze_id="$(printf '%s\n' "$marker_values" | sed -n '1p')"
  frozen_at="$(printf '%s\n' "$marker_values" | sed -n '2p')"
  quiesce_id="$(printf '%s\n' "$marker_values" | sed -n '3p')"
  quiesced_at="$(printf '%s\n' "$marker_values" | sed -n '4p')"
  required_quiet_seconds="$(printf '%s\n' "$marker_values" | sed -n '5p')"
  runtime_started_at="$(printf '%s\n' "$marker_values" | sed -n '6p')"
  scheduler_observed_at="$(printf '%s\n' "$marker_values" | sed -n '7p')"
  router_active_requests="$(printf '%s\n' "$marker_values" | sed -n '8p')"
  router_upgraded_sockets="$(printf '%s\n' "$marker_values" | sed -n '9p')"

  if ! wait_for_frozen_retirement_quiescence \
    "$slot" "$release_id" "$host" "$port" "$pid" "$active" "$generation"; then
    rm -f -- "$(callback_freeze_file "$slot")"
    kill -0 "$pid" 2>/dev/null \
      || fail "$slot became unavailable while waiting for frozen callback quiescence"
    fail "$slot changed after its initial drain check; callback admission was reopened and the old slot remains running"
  fi
  [[ "$(read_state_field active)" == "$active" && "$(read_state_field previous)" == "$slot" \
    && "$(read_state_field generation)" == "$generation" ]] \
    || fail "$slot router state changed after frozen callback quiescence"

  if ! verify_active_director_projection_chain; then
    rm -f -- "$(callback_freeze_file "$slot")"
    fail "$slot produced an incompatible projection outbox row; callback admission was reopened and the old slot remains running"
  fi

  "$manager" stop "$slot" >/dev/null || fail "$slot callback is frozen, but the managed listener did not stop"
  ! kill -0 "$pid" 2>/dev/null || fail "$slot callback is frozen, but PID $pid is still running"
  [[ -z "$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)" ]] \
    || fail "$slot callback is frozen, but port $port is still listening"
  ! "$manager" status "$slot" >/dev/null 2>&1 \
    || fail "$slot callback is frozen, but the service manager can still restart it"

  if [[ -z "$quiesce_id" || -z "$quiesced_at" ]]; then
    payload="$($NODE_BIN -e '
      const fs = require("node:fs")
      const crypto = require("node:crypto")
      const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
      value.quiesceId = crypto.randomBytes(32).toString("hex")
      value.quiescedAt = Math.floor(Date.now() / 1000)
      process.stdout.write(JSON.stringify(value))
    ' "$(callback_freeze_file "$slot")")"
    write_json_atomic "$(callback_freeze_file "$slot")" "$payload"
    marker_values="$(read_callback_freeze_values "$slot" "$release_id" "$manifest" "$pid" \
      "$attested_db" "$attested_router" "$generation" "$active")"
    quiesce_id="$(printf '%s\n' "$marker_values" | sed -n '3p')"
    quiesced_at="$(printf '%s\n' "$marker_values" | sed -n '4p')"
  fi
  final_db_summary="$(check_database_retirement "$attested_db" "$slot" "$release_id" "$port" \
    "$runtime_started_at" "$required_quiet_seconds")" \
    || fail "$slot remains callback-frozen and stopped; retry retire after the database becomes quiescent"
  [[ "$(read_state_field active)" == "$active" && "$(read_state_field previous)" == "$slot" \
    && "$(read_state_field generation)" == "$generation" ]] \
    || fail "$slot remains callback-frozen and stopped because router state changed before final proof"
  payload="$($NODE_BIN -e '
    const [slot, releaseId, manifestSha256, rawPid, dbPath, routerStatePath, rawGeneration,
      activeSlot, rawSummary, freezeId, rawFrozenAt, quiesceId, rawQuiescedAt,
      rawSchedulerObservedAt, rawRouterActiveRequests, rawRouterUpgradedSockets] = process.argv.slice(1)
    const summary = JSON.parse(rawSummary)
    const observedAt = summary.observedAt
    delete summary.observedAt
    Object.assign(summary, {
      schedulerState: "inactive", schedulerObservedAt: Number(rawSchedulerObservedAt),
      schedulerRouterGeneration: Number(rawGeneration),
      routerActiveRequests: Number(rawRouterActiveRequests),
      routerUpgradedSockets: Number(rawRouterUpgradedSockets),
    })
    process.stdout.write(JSON.stringify({
      schema: "video-autoworker-retirement-proof/v2", slot, releaseId, manifestSha256,
      pid: Number(rawPid), dbPath, routerStatePath, routerGeneration: Number(rawGeneration),
      activeSlot, observedAt, drain: summary,
      freeze: { freezeId, frozenAt: Number(rawFrozenAt), quiesceId, quiescedAt: Number(rawQuiescedAt) },
    }))
  ' "$slot" "$release_id" "$manifest" "$pid" "$attested_db" "$attested_router" \
    "$generation" "$active" "$final_db_summary" "$freeze_id" "$frozen_at" "$quiesce_id" \
    "$quiesced_at" "$scheduler_observed_at" "$router_active_requests" "$router_upgraded_sockets")"
  write_json_atomic "$(retirement_file "$slot")" "$payload"
  assert_retirement_proof "$slot" "$release_id"
  printf 'Certified stopped retirement: slot=%s release=%s generation=%s pid=%s\n' \
    "$slot" "$release_id" "$generation" "$pid"
}

probe_slot() {
  local slot required_role values release_id release_root expected_manifest host port
  local attestation attested_pid attested_slot attested_role attested_release attested_manifest
  local attested_host attested_port attested_db attested_router_state live_db canonical_router_state
  local actual_manifest http_code pid_file pid listener
  slot="$(require_slot "${1:-}")"
  required_role="${2:-any}"
  [[ "$required_role" == any || "$required_role" == active ]] || fail "invalid required runtime role"
  assert_existing_run_layout
  values="$(binding_values "$slot")" || fail "$slot binding is invalid"
  release_id="$(printf '%s\n' "$values" | sed -n '1p')"
  release_root="$(printf '%s\n' "$values" | sed -n '2p')"
  expected_manifest="$(printf '%s\n' "$values" | sed -n '3p')"
  host="$(printf '%s\n' "$values" | sed -n '4p')"
  port="$(printf '%s\n' "$values" | sed -n '5p')"
  [[ "$host" == "127.0.0.1" && "$port" == "$(slot_port "$slot")" ]] || fail "$slot binding endpoint changed"

  attestation="$(runtime_attestation_values "$slot")" || fail "$slot runtime attestation is invalid"
  attested_pid="$(printf '%s\n' "$attestation" | sed -n '1p')"
  attested_slot="$(printf '%s\n' "$attestation" | sed -n '2p')"
  attested_role="$(printf '%s\n' "$attestation" | sed -n '3p')"
  attested_release="$(printf '%s\n' "$attestation" | sed -n '4p')"
  attested_manifest="$(printf '%s\n' "$attestation" | sed -n '5p')"
  attested_host="$(printf '%s\n' "$attestation" | sed -n '6p')"
  attested_port="$(printf '%s\n' "$attestation" | sed -n '7p')"
  attested_db="$(printf '%s\n' "$attestation" | sed -n '8p')"
  attested_router_state="$(printf '%s\n' "$attestation" | sed -n '9p')"
  [[ "$attested_slot" == "$slot" && "$attested_release" == "$release_id" \
    && "$attested_manifest" == "$expected_manifest" && "$attested_host" == "$host" \
    && "$attested_port" == "$port" ]] || fail "$slot runtime attestation does not match its binding"
  canonical_router_state="$(physical_path "$STATE_FILE")" || fail "unable to resolve router state path"
  [[ "$attested_router_state" == "$canonical_router_state" ]] \
    || fail "$slot runtime attestation does not match the router state path"
  if [[ "$required_role" == active ]]; then
    [[ "$attested_role" == active ]] || fail "$slot runtime role is $attested_role; switch and rollback require active"
    [[ -n "$LIVE_DB_PATH" ]] || fail "AIWORKER_BG_LIVE_DB_PATH is required for switch and rollback"
    assert_absolute "AIWORKER_BG_LIVE_DB_PATH" "$LIVE_DB_PATH"
    [[ -f "$LIVE_DB_PATH" ]] || fail "AIWORKER_BG_LIVE_DB_PATH must identify the existing live SQLite database"
    live_db="$(physical_path "$LIVE_DB_PATH")" || fail "unable to resolve AIWORKER_BG_LIVE_DB_PATH"
    [[ "$attested_db" == "$live_db" ]] || fail "$slot runtime database does not match AIWORKER_BG_LIVE_DB_PATH"
  fi

  release_root="$(assert_release "$release_id" "$release_root")"
  actual_manifest="$(release_manifest_sha "$release_root")"
  [[ "$actual_manifest" == "$expected_manifest" ]] || fail "$slot release manifest digest changed"

  pid_file="$RUN_DIR/slots/$slot.pid"
  assert_private_file "$slot PID file" "$pid_file"
  pid="$(tr -d '[:space:]' < "$pid_file")"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$pid" 2>/dev/null || fail "$slot PID is not running"
  [[ "$attested_pid" == "$pid" ]] || fail "$slot runtime attestation PID does not match its PID file"
  if command -v lsof >/dev/null 2>&1; then
    listener="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | sort -u)"
    [[ "$listener" == "$pid" ]] || fail "$slot listener PID does not match $pid"
    lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | grep -Fxq "$release_root" \
      || fail "$slot process cwd does not match its immutable release"
    local expected_node
    expected_node="$(physical_path "$(command -v "$NODE_BIN")")"
    lsof -a -p "$pid" -d txt -Fn 2>/dev/null | sed -n 's/^n//p' | grep -Fxq "$expected_node" \
      || fail "$slot process executable is not the configured Node runtime"
  fi
  http_code="$(curl -sS -o /dev/null -w '%{http_code}' "http://$host:$port$PROBE_PATH" || true)"
  [[ "$http_code" == 2?? || "$http_code" == 3?? ]] || fail "$slot probe returned HTTP $http_code"
  printf 'Probe passed: slot=%s role=%s release=%s pid=%s port=%s\n' \
    "$slot" "$attested_role" "$release_id" "$pid" "$port"
}

assert_existing_candidate_runtime_compatible() {
  local slot="$1" pathname attestation role attested_db live_db
  pathname="$(runtime_attestation_file "$slot")"
  [[ -e "$pathname" || -L "$pathname" ]] || return 0
  attestation="$(runtime_attestation_values "$slot")" || fail "$slot runtime attestation is invalid"
  role="$(printf '%s\n' "$attestation" | sed -n '3p')"
  [[ "$role" == active ]] || fail "$slot runtime role is $role; switch and rollback require active"
  [[ -n "$LIVE_DB_PATH" ]] || fail "AIWORKER_BG_LIVE_DB_PATH is required for switch and rollback"
  assert_absolute "AIWORKER_BG_LIVE_DB_PATH" "$LIVE_DB_PATH"
  [[ -f "$LIVE_DB_PATH" ]] || fail "AIWORKER_BG_LIVE_DB_PATH must identify the existing live SQLite database"
  live_db="$(physical_path "$LIVE_DB_PATH")" || fail "unable to resolve AIWORKER_BG_LIVE_DB_PATH"
  attested_db="$(printf '%s\n' "$attestation" | sed -n '8p')"
  [[ "$attested_db" == "$live_db" ]] \
    || fail "$slot runtime database does not match AIWORKER_BG_LIVE_DB_PATH"
}

update_state() {
  local target="$1"
  local mode="$2"
  local binding release_id payload
  binding="$(binding_values "$target")" || fail "$target binding is invalid"
  release_id="$(printf '%s\n' "$binding" | sed -n '1p')"
  payload="$($NODE_BIN -e '
    const fs = require("node:fs")
    const [path, target, releaseId, mode] = process.argv.slice(1)
    const value = JSON.parse(fs.readFileSync(path, "utf8"))
    const oldActive = value.active
    if (mode === "switch" && target === oldActive) process.exit(4)
    if (mode === "rollback" && value.previous !== target) process.exit(5)
    value.generation += 1
    value.active = target
    value.previous = oldActive
    value.updatedAt = new Date().toISOString()
    value.slots[target].releaseId = releaseId
    process.stdout.write(JSON.stringify(value))
  ' "$STATE_FILE" "$target" "$release_id" "$mode")" || fail "$mode transition is not allowed"
  write_router_state_atomic "$payload"
  validate_state
}

wait_for_scheduler_leader() {
  local generation="$1"
  local deadline
  deadline=$(( $(date +%s) + LEADER_TIMEOUT_SECONDS ))
  while (( $(date +%s) < deadline )); do
    if check_json_endpoint leader "http://$ROUTER_HOST:$ROUTER_PORT$SCHEDULER_PATH" \
      "$generation" >/dev/null 2>&1; then
      return 0
    fi
    # The newly active slot may remain a follower while an old slot finishes
    # an already-running local scheduler job and relinquishes its lease.
    sleep 1
  done
  check_json_endpoint leader "http://$ROUTER_HOST:$ROUTER_PORT$SCHEDULER_PATH" \
    "$generation" >/dev/null
}

verify_routed_release() {
  local slot="$1"
  local release_id="$2"
  local generation="$3"
  local expected_revision="${4:-}"
  local expected_epoch="${5:-}"
  local expected_projection_contract="${6:-}"
  local port
  port="$(slot_port "$slot")"
  assert_router_identity "$slot" "$release_id" "$generation" >/dev/null || return 1
  wait_for_scheduler_leader "$generation" || return 1
  check_json_endpoint health "http://$ROUTER_HOST:$ROUTER_PORT/api/status?action=health" \
    >/dev/null || return 1
  check_json_endpoint readiness "http://$ROUTER_HOST:$ROUTER_PORT$READINESS_PATH" \
    "$slot" "$release_id" "$port" "$expected_revision" "$expected_epoch" "$generation" \
    "$expected_projection_contract" \
    >/dev/null || return 1
  check_routed_readonly_endpoint /materials page || return 1
  check_routed_readonly_endpoint /tasks page || return 1
  check_routed_readonly_endpoint /api/materials api || return 1
  check_routed_readonly_endpoint /api/tasks api || return 1
}

capture_transition_release_evidence() {
  local slot="$1"
  local release_id="$2"
  local readiness="$3"
  local routed_slot="$4"
  local routed_release="$5"
  local routed_generation="$6"
  local binding release_root manifest host port physical_root runtime runtime_release runtime_manifest
  local runtime_host runtime_port runtime_db runtime_router live_db canonical_router
  local binding_sha runtime_sha router_sha router_attestation

  [[ "$(read_state_field active)" == "$routed_slot" \
    && "$(read_state_slot_release "$routed_slot")" == "$routed_release" \
    && "$(read_state_field generation)" == "$routed_generation" ]] \
    || fail "router state changed while transition evidence was being captured"
  binding="$(binding_values "$slot")" || fail "$slot binding is invalid"
  [[ "$(printf '%s\n' "$binding" | wc -l | tr -d '[:space:]')" == 5 ]] \
    || fail "$slot binding evidence is incomplete"
  [[ "$(printf '%s\n' "$binding" | sed -n '1p')" == "$release_id" ]] \
    || fail "$slot binding release changed while transition evidence was being captured"
  release_root="$(printf '%s\n' "$binding" | sed -n '2p')"
  manifest="$(printf '%s\n' "$binding" | sed -n '3p')"
  host="$(printf '%s\n' "$binding" | sed -n '4p')"
  port="$(printf '%s\n' "$binding" | sed -n '5p')"
  physical_root="$(assert_release "$release_id" "$release_root")" \
    || fail "$slot release cannot be captured for a safe transition"
  [[ "$physical_root" == "$release_root" && "$(release_manifest_sha "$physical_root")" == "$manifest" ]] \
    || fail "$slot release manifest changed while transition evidence was being captured"

  runtime="$(runtime_attestation_values "$slot")" \
    || fail "$slot runtime attestation cannot be captured"
  runtime_release="$(printf '%s\n' "$runtime" | sed -n '4p')"
  runtime_manifest="$(printf '%s\n' "$runtime" | sed -n '5p')"
  runtime_host="$(printf '%s\n' "$runtime" | sed -n '6p')"
  runtime_port="$(printf '%s\n' "$runtime" | sed -n '7p')"
  runtime_db="$(printf '%s\n' "$runtime" | sed -n '8p')"
  runtime_router="$(printf '%s\n' "$runtime" | sed -n '9p')"
  live_db="$(physical_path "$LIVE_DB_PATH")" || fail "unable to resolve live database path"
  canonical_router="$(physical_path "$STATE_FILE")" || fail "unable to resolve router state path"
  [[ "$runtime_release" == "$release_id" && "$runtime_manifest" == "$manifest" \
    && "$runtime_host" == "$host" && "$runtime_port" == "$port" \
    && "$runtime_db" == "$live_db" && "$runtime_router" == "$canonical_router" ]] \
    || fail "$slot runtime identity changed while transition evidence was being captured"

  router_attestation="$(router_attestation_file)"
  assert_private_file "standalone router runtime attestation" "$router_attestation"
  binding_sha="$(file_sha256 "$(binding_file "$slot")")"
  runtime_sha="$(file_sha256 "$(runtime_attestation_file "$slot")")"
  router_sha="$(file_sha256 "$router_attestation")"
  "$NODE_BIN" - "$slot" "$release_id" "$physical_root" "$manifest" "$binding_sha" \
    "$runtime_sha" "$router_sha" "$readiness" "$routed_slot" "$routed_release" \
    "$routed_generation" <<'NODE'
const crypto = require('node:crypto')
const [slot, releaseId, releaseRoot, manifestSha256, bindingSha256,
  runtimeAttestationSha256, routerAttestationSha256, rawReadiness,
  activeSlot, routedReleaseId, rawGeneration] = process.argv.slice(2)
const lines = rawReadiness.split('\n')
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const integer = (value, minimum = 0) => /^\d+$/u.test(value)
  && Number.isSafeInteger(Number(value)) && Number(value) >= minimum
if (!['blue', 'green'].includes(slot) || !['blue', 'green'].includes(activeSlot)
  || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u.test(releaseId)
  || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u.test(routedReleaseId)
  || !releaseRoot.startsWith('/') || !sha(manifestSha256) || !sha(bindingSha256)
  || !sha(runtimeAttestationSha256) || !sha(routerAttestationSha256)
  || lines.length !== 6 || !integer(lines[0], 1) || !integer(lines[1], 1)
  || !sha(lines[2]) || !integer(lines[3]) || !integer(lines[4])
  || Number(lines[4]) !== 0 || !integer(lines[5]) || !integer(rawGeneration, 1)) process.exit(2)
const payload = {
  slot,
  releaseId,
  releaseRoot,
  manifestSha256,
  bindingSha256,
  runtimeAttestationSha256,
  routerAttestationSha256,
  readiness: {
    revision: Number(lines[0]),
    schemaEpoch: Number(lines[1]),
    contractDigest: lines[2],
    pending: Number(lines[3]),
    incompatiblePending: Number(lines[4]),
    active: Number(lines[5]),
  },
  route: {
    activeSlot,
    releaseId: routedReleaseId,
    generation: Number(rawGeneration),
  },
}
const serialized = JSON.stringify(payload)
process.stdout.write(JSON.stringify({
  schema: 'video-autoworker-transition-release-evidence/v1',
  payload,
  evidenceSha256: crypto.createHash('sha256').update(serialized).digest('hex'),
}))
NODE
}

verify_captured_transition_release_evidence() {
  local evidence="$1"
  local expected_slot="$2"
  local expected_release="$3"
  local expected_generation="$4"
  local expected_generation_delta="$5"
  local values release_root manifest binding_sha runtime_sha router_sha revision epoch contract
  local captured_generation
  local binding physical_root
  values="$("$NODE_BIN" - "$evidence" "$expected_slot" "$expected_release" <<'NODE'
const crypto = require('node:crypto')
const [raw, expectedSlot, expectedRelease] = process.argv.slice(2)
const keys = (value, expected) => value && JSON.stringify(Object.keys(value).sort())
  === JSON.stringify([...expected].sort())
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const integer = value => Number.isSafeInteger(value) && value >= 0
let value
try { value = JSON.parse(raw) } catch { process.exit(2) }
if (!keys(value, ['evidenceSha256', 'payload', 'schema'])
  || value.schema !== 'video-autoworker-transition-release-evidence/v1'
  || !sha(value.evidenceSha256)) process.exit(3)
const payload = value.payload
if (!keys(payload, ['bindingSha256', 'manifestSha256', 'readiness', 'releaseId',
  'releaseRoot', 'route', 'routerAttestationSha256', 'runtimeAttestationSha256', 'slot'])
  || payload.slot !== expectedSlot || payload.releaseId !== expectedRelease
  || typeof payload.releaseRoot !== 'string' || !payload.releaseRoot.startsWith('/')
  || !sha(payload.manifestSha256) || !sha(payload.bindingSha256)
  || !sha(payload.runtimeAttestationSha256) || !sha(payload.routerAttestationSha256)) process.exit(4)
if (crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex')
  !== value.evidenceSha256) process.exit(5)
const readiness = payload.readiness
if (!keys(readiness, ['active', 'contractDigest', 'incompatiblePending', 'pending',
  'revision', 'schemaEpoch']) || !integer(readiness.revision) || readiness.revision < 1
  || !integer(readiness.schemaEpoch) || readiness.schemaEpoch < 1
  || !sha(readiness.contractDigest) || !integer(readiness.pending)
  || readiness.incompatiblePending !== 0 || !integer(readiness.active)) process.exit(6)
const route = payload.route
if (!keys(route, ['activeSlot', 'generation', 'releaseId'])
  || !['blue', 'green'].includes(route.activeSlot)
  || typeof route.releaseId !== 'string' || !route.releaseId
  || !integer(route.generation) || route.generation < 1) process.exit(7)
for (const item of [payload.releaseRoot, payload.manifestSha256, payload.bindingSha256,
  payload.runtimeAttestationSha256, payload.routerAttestationSha256,
  String(readiness.revision), String(readiness.schemaEpoch), readiness.contractDigest,
  String(route.generation)]) {
  process.stdout.write(`${item}\n`)
}
NODE
)" || return 1
  release_root="$(printf '%s\n' "$values" | sed -n '1p')"
  manifest="$(printf '%s\n' "$values" | sed -n '2p')"
  binding_sha="$(printf '%s\n' "$values" | sed -n '3p')"
  runtime_sha="$(printf '%s\n' "$values" | sed -n '4p')"
  router_sha="$(printf '%s\n' "$values" | sed -n '5p')"
  revision="$(printf '%s\n' "$values" | sed -n '6p')"
  epoch="$(printf '%s\n' "$values" | sed -n '7p')"
  contract="$(printf '%s\n' "$values" | sed -n '8p')"
  captured_generation="$(printf '%s\n' "$values" | sed -n '9p')"

  [[ "$expected_generation" =~ ^[1-9][0-9]*$ \
    && "$expected_generation_delta" =~ ^[0-2]$ \
    && $(( 10#$captured_generation + 10#$expected_generation_delta )) -eq 10#$expected_generation ]] \
    || return 1

  assert_private_file "$expected_slot binding" "$(binding_file "$expected_slot")" || return 1
  assert_private_file "$expected_slot runtime attestation" \
    "$(runtime_attestation_file "$expected_slot")" || return 1
  assert_private_file "standalone router runtime attestation" \
    "$(router_attestation_file)" || return 1
  [[ "$(file_sha256 "$(binding_file "$expected_slot")")" == "$binding_sha" \
    && "$(file_sha256 "$(runtime_attestation_file "$expected_slot")")" == "$runtime_sha" \
    && "$(file_sha256 "$(router_attestation_file)")" == "$router_sha" ]] || return 1
  binding="$(binding_values "$expected_slot")" || return 1
  [[ "$(printf '%s\n' "$binding" | sed -n '1p')" == "$expected_release" \
    && "$(printf '%s\n' "$binding" | sed -n '2p')" == "$release_root" \
    && "$(printf '%s\n' "$binding" | sed -n '3p')" == "$manifest" ]] || return 1
  physical_root="$(assert_release "$expected_release" "$release_root")" || return 1
  [[ "$physical_root" == "$release_root" \
    && "$(release_manifest_sha "$physical_root")" == "$manifest" ]] || return 1
  [[ "$(read_state_field active)" == "$expected_slot" \
    && "$(read_state_slot_release "$expected_slot")" == "$expected_release" \
    && "$(read_state_field generation)" == "$expected_generation" ]] || return 1
  probe_slot "$expected_slot" active >/dev/null || return 1
  verify_routed_release "$expected_slot" "$expected_release" "$expected_generation" \
    "$revision" "$epoch" "$contract"
}

preflight_transition() {
  local source="$1"
  local target="$2"
  local generation="$3"
  local source_release source_binding_release source_port baseline_values legacy_release
  [[ "$source" != "$target" ]] || fail "target slot is already active"
  assert_existing_candidate_runtime_compatible "$target"
  baseline_values="$(assert_baseline)"
  legacy_release="$(printf '%s\n' "$baseline_values" | sed -n '1p')"
  [[ -x "$SCRIPT_DIR/manage-blue-green-services.sh" ]] \
    || fail "blue-green service manager is required for switch and rollback"
  "$SCRIPT_DIR/manage-blue-green-services.sh" status router >/dev/null \
    && "$SCRIPT_DIR/manage-blue-green-services.sh" status "$source" >/dev/null \
    || fail "router and source slot must remain under the service manager"
  "$SCRIPT_DIR/manage-blue-green-services.sh" start "$target" >/dev/null \
    || fail "candidate slot could not be started under the service manager"
  probe_slot "$target" active
  source_release="$(read_state_slot_release "$source")"
  [[ "$source_release" != unbound-* ]] \
    || fail "legacy/unbound active runtimes cannot be hot-switched; establish a gate-aware baseline first"
  source_binding_release="$(binding_values "$source" | sed -n '1p')" \
    || fail "$source binding is missing; legacy runtimes cannot enter the hot-switch path"
  [[ "$source_binding_release" == "$source_release" ]] \
    || fail "$source router release does not match its binding"
  [[ "$source_release" != "$legacy_release" \
    && "$(binding_values "$target" | sed -n '1p')" != "$legacy_release" ]] \
    || fail "the pre-baseline legacy release is permanently fenced from switch and rollback"
  source_port="$(slot_port "$source")"
  probe_slot "$source" active
  assert_router_identity "$source" "$source_release" "$generation" >/dev/null \
    || fail "port 3017 is not the attested blue-green router for the current source release"
  check_json_endpoint readiness "http://$ROUTER_HOST:$ROUTER_PORT$READINESS_PATH" \
    "$source" "$source_release" "$source_port" "" "" "$generation" >/dev/null \
    || fail "global intake is not paused or the source runtime lacks the release-readiness protocol"
}

transition_with_verification() {
  local target="$1"
  local mode="$2"
  local source source_release target_release generation switched_generation rollback_generation
  local source_readiness target_readiness intake_revision source_epoch target_revision target_epoch
  local source_projection_contract target_projection_contract
  local source_evidence target_evidence target_verified_contract post_target_verified_contract
  local target_release_root
  source="$(read_state_field active)"
  generation="$(read_state_field generation)"
  if [[ "$mode" == rollback ]]; then
    [[ "$(read_state_field previous)" == "$target" ]] || fail "rollback transition is not allowed"
  fi
  preflight_transition "$source" "$target" "$generation"
  source_release="$(read_state_slot_release "$source")"
  target_release="$(binding_values "$target" | sed -n '1p')" || fail "$target binding is invalid"
  source_readiness="$(check_json_endpoint readiness \
    "http://$ROUTER_HOST:$ROUTER_PORT$READINESS_PATH" "$source" "$source_release" \
    "$(slot_port "$source")" "" "" "$generation")" \
    || fail "global release readiness changed immediately before router commit"
  intake_revision="$(printf '%s\n' "$source_readiness" | sed -n '1p')"
  source_epoch="$(printf '%s\n' "$source_readiness" | sed -n '2p')"
  source_projection_contract="$(printf '%s\n' "$source_readiness" | sed -n '3p')"
  target_readiness="$(check_json_endpoint readiness \
    "http://127.0.0.1:$(slot_port "$target")$READINESS_PATH" "$target" "$target_release" \
    "$(slot_port "$target")" "$intake_revision" "$source_epoch" "$generation")" \
    || fail "target release readiness or database epoch is incompatible immediately before router commit"
  target_revision="$(printf '%s\n' "$target_readiness" | sed -n '1p')"
  target_epoch="$(printf '%s\n' "$target_readiness" | sed -n '2p')"
  target_projection_contract="$(printf '%s\n' "$target_readiness" | sed -n '3p')"
  [[ "$target_revision" == "$intake_revision" && "$target_epoch" == "$source_epoch" ]] \
    || fail "source and target readiness snapshots are not from the same gate revision/database epoch"
  [[ "$source_projection_contract" == "$target_projection_contract" ]] \
    || fail "ordinary switch and rollback cannot cross director projection contracts; use the dedicated bootstrap migration path"
  if [[ "$mode" == switch ]]; then
    target_release_root="$(binding_values "$target" | sed -n '2p')" \
      || fail "$target binding has no release root"
    [[ "$target_release_root" == /* ]] || fail "$target binding release root is invalid"
    target_verified_contract="$(verify_director_video_release_chain \
      "$target_release" "$target_release_root")" \
      || fail "target director/video release chain is incompatible immediately before router commit"
    [[ "$target_verified_contract" == "$target_projection_contract" ]] \
      || fail "target runtime projection contract does not match the HEAD-bound release verifier"
  fi
  source_evidence="$(capture_transition_release_evidence "$source" "$source_release" \
    "$source_readiness" "$source" "$source_release" "$generation")" \
    || fail "unable to capture immutable source transition evidence"
  target_evidence="$(capture_transition_release_evidence "$target" "$target_release" \
    "$target_readiness" "$source" "$source_release" "$generation")" \
    || fail "unable to capture immutable target transition evidence"
  readonly source_evidence target_evidence
  update_state "$target" "$mode"
  switched_generation="$(read_state_field generation)"
  if ( verify_captured_transition_release_evidence "$target_evidence" "$target" \
    "$target_release" "$switched_generation" 1 ); then
    if [[ "$mode" != switch ]]; then
      printf '%s router atomically: active=%s generation=%s\n' \
        'Rolled back' "$target" "$switched_generation"
      return
    fi
    if post_target_verified_contract="$(verify_director_video_release_chain \
      "$target_release" "$target_release_root")" \
      && [[ "$post_target_verified_contract" == "$target_projection_contract" ]]; then
      printf 'Switched router atomically: active=%s generation=%s\n' \
        "$target" "$switched_generation"
      return
    fi
    printf 'error: projection compatibility changed during switch; attempting automatic rollback to %s\n' \
      "$source" >&2
  fi

  printf 'error: post-%s verification failed; attempting automatic rollback to %s\n' "$mode" "$source" >&2
  probe_slot "$source" active
  update_state "$source" rollback
  rollback_generation="$(read_state_field generation)"
  ( verify_captured_transition_release_evidence "$source_evidence" "$source" \
    "$source_release" "$rollback_generation" 2 ) \
    || fail "automatic rollback selected $source but its captured release or routed projection evidence also failed"
  fail "post-$mode verification failed; router automatically returned to $source generation $rollback_generation"
}

switch_slot() {
  local target
  target="$(require_slot "${1:-}")"
  acquire_lock
  validate_state
  transition_with_verification "$target" switch
}

rollback_state() {
  acquire_lock
  validate_state
  local target
  target="$(read_state_field previous)"
  [[ -n "$target" ]] || fail "router state has no rollback target"
  target="$(require_slot "$target")"
  transition_with_verification "$target" rollback
}

show_status() {
  local pending
  pending="$(bootstrap_pending_file)"
  if [[ -e "$pending" || -L "$pending" ]]; then
    assert_immutable_private_file "bootstrap pending marker" "$pending"
    "$NODE_BIN" -e '
      const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))
      if (value.schema !== "video-autoworker-blue-green-bootstrap-pending/v4"
        || !["blue", "green"].includes(value.slot)
        || typeof value.releaseId !== "string" || !Number.isSafeInteger(value.legacyPid)
        || !Number.isSafeInteger(value.n8n?.pid)) process.exit(2)
      process.stdout.write(`bootstrap=recovery-hold slot=${value.slot} release=${value.releaseId} legacyPid=${value.legacyPid} n8nPid=${value.n8n.pid}\n`)
    ' "$pending" || fail "bootstrap recovery pending marker is invalid"
    return
  fi
  assert_existing_run_layout
  validate_state
  local active release_id generation
  active="$(read_state_field active)"
  release_id="$(read_state_slot_release "$active")"
  generation="$(read_state_field generation)"
  [[ "$release_id" != unbound-* ]] || fail "router status is not operational: active slot is unbound"
  assert_router_identity "$active" "$release_id" "$generation" >/dev/null \
    || fail "port 3017 is not the attested standalone router"
  "$NODE_BIN" -e '
    const fs = require("node:fs")
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
    process.stdout.write(`active=${value.active} previous=${value.previous ?? "none"} generation=${value.generation}\n`)
    for (const slot of ["blue", "green"]) {
      const item = value.slots[slot]
      process.stdout.write(`${slot}: ${item.host}:${item.port} release=${item.releaseId}\n`)
    }
  ' "$STATE_FILE"
  curl -fsS "http://$ROUTER_HOST:$ROUTER_PORT/__router/health"
}

attest_current() {
  local active release_id release_root generation port readiness evidence verified_contract
  assert_existing_run_layout
  validate_state
  assert_baseline >/dev/null
  active="$(read_state_field active)"
  release_id="$(read_state_slot_release "$active")"
  generation="$(read_state_field generation)"
  [[ "$release_id" != unbound-* ]] || fail "active slot is not bound to a release"
  release_root="$(binding_values "$active" | sed -n '2p')" \
    || fail "active slot binding is invalid"
  [[ "$release_root" == /* ]] || fail "active slot release root is invalid"
  port="$(slot_port "$active")"
  probe_slot "$active" active >/dev/null
  readiness="$(check_json_endpoint readiness \
    "http://$ROUTER_HOST:$ROUTER_PORT$READINESS_PATH" "$active" "$release_id" \
    "$port" "" "" "$generation")" \
    || fail "active routed release is not final-ready"
  verified_contract="$(verify_director_video_release_chain \
    "$release_id" "$release_root" ancestor)" \
    || fail "active director/video release chain is incompatible"
  [[ "$verified_contract" == "$(printf '%s\n' "$readiness" | sed -n '3p')" ]] \
    || fail "active routed projection contract differs from its release payload"
  evidence="$(capture_transition_release_evidence "$active" "$release_id" \
    "$readiness" "$active" "$release_id" "$generation")" \
    || fail "unable to capture current routed release evidence"
  verify_captured_transition_release_evidence \
    "$evidence" "$active" "$release_id" "$generation" 0 >/dev/null \
    || fail "current routed release evidence changed during capture"
  printf '%s\n' "$evidence"
}

command="${1:-}"
shift || true
case "$command" in
  init|bootstrap|stage|bind|retire|switch|rollback|status|attest-current)
    assert_bootstrap_operation_gate "$command" "$@"
    ;;
esac
case "$command" in
  init) init_state "$@" ;;
  bootstrap) bootstrap_baseline "$@" ;;
  stage) stage_release "$@" ;;
  bind) bind_slot "$@" ;;
  probe) probe_slot "$@" ;;
  retire) retire_slot "$@" ;;
  switch) switch_slot "$@" ;;
  rollback) rollback_state "$@" ;;
  status) show_status "$@" ;;
  attest-current) attest_current "$@" ;;
  -h|--help|help|'') usage ;;
  *) usage >&2; exit 2 ;;
esac
