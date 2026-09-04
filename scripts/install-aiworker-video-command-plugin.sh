#!/usr/bin/env bash
set -euo pipefail
umask 077

PROFILE="qwen-current"
PLUGIN_ID="aiworker-video-command"
AGENT_ID="second-original"
TOOL_ID="aiworker_analyze_video"
SUPPORTED_PREVIOUS_VERSIONS=("0.5.8" "0.5.9" "0.5.10" "0.5.11" "0.5.12" "0.5.13")
CURRENT_VERSION="0.5.14"
OPENCLAW_VERSION="2026.7.1-2"
EXPECTED_USER="heisenbergs-1"
EXPECTED_HOST="HEISENBERGS-1deMac-Studio.local"

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
PLUGIN_DIR="$REPOSITORY_ROOT/openclaw-plugins/$PLUGIN_ID"
RUNTIME_VALIDATOR="$PLUGIN_DIR/scripts/validate-runtime-inspection.mjs"
SHARED_INSTALL_GATE="$REPOSITORY_ROOT/scripts/verify-shared-runtime-install-gate.mjs"
SHARED_DEPLOYMENT_LOCK_HELPER="$REPOSITORY_ROOT/scripts/lib/shared-deployment-lock.sh"
PROFILE_STATE_DIR="$HOME/.openclaw-qwen-current"
PROFILE_CONFIG="$PROFILE_STATE_DIR/openclaw.json"
INSTALLED_PLUGIN_DIR="$PROFILE_STATE_DIR/extensions/$PLUGIN_ID"
BACKUP_ROOT="$HOME/ai-worker/backups/$PLUGIN_ID"
MODE=""
ORIGINAL_ARGUMENTS=("$@")
TARGET_SHA=""
ROLLBACK_BACKUP=""
ROLLBACK_NOOP=0
ROLLBACK_RESULT_BACKUP=""
ROLLBACK_SOURCE_ORIGINAL=""
ROLLBACK_SOURCE_CLAIM=""
ROLLBACK_SOURCE_CLAIM_ROOT=""
ROLLBACK_SOURCE_ROOT_IDENTITY=""
ROLLBACK_SOURCE_MANIFEST_IDENTITY=""
ROLLBACK_SOURCE_MANIFEST_SHA256=""
RESULT_OUTPUT=""
RESERVATION_SHA256=""
DEFER_GATEWAY_RESTART=0
WORK_ROOT=""
BACKUP_DIR=""
LOCAL_LOCK_DIR="$PROFILE_STATE_DIR/.aiworker-video-command-install.lock"
LOCAL_LOCK_OWNED=0
LOCAL_LOCK_FENCE=""
LOCAL_OWNER_START=""
STALE_RECOVERED=0
BEFORE_CONFIG_SHA=""
BEFORE_LISTENERS=""
BEFORE_MANIFEST_SHA256=""
LEGACY_SENDER_HASH_PRESENT=0
MIGRATED_CONFIG=""
MIGRATED_CONFIG_SHA=""
DEPLOYMENT_RUN_DIR="${AIWORKER_BG_RUN_DIR:-$REPOSITORY_ROOT/.run/blue-green}"
DEPLOYMENT_LOCK_DIR="$DEPLOYMENT_RUN_DIR/.deployment.lock"
MISSION_CONTROL_DB_PATH="${AIWORKER_BG_LIVE_DB_PATH:-}"
N8N_DB_PATH="${AIWORKER_BG_N8N_DB_PATH:-}"
LEGACY_PREINSTALL_ATTEMPT_DIR="${AIWORKER_BG_LEGACY_PREINSTALL_ATTEMPT_DIR:-}"
ISOLATED_TEST_ROOT="${AIWORKER_INSTALLER_ISOLATED_TEST_ROOT:-}"
CANONICAL_VIDEO_BATCH_ROOT="$HOME/ai-worker/state/video-autoworker/video-batches"
VIDEO_BATCH_ROOT="$CANONICAL_VIDEO_BATCH_ROOT"
if [[ "${NODE_ENV:-}" == test && -n "$ISOLATED_TEST_ROOT" \
  && -n "${AIWORKER_VIDEO_BATCH_DIR:-}" ]]; then
  VIDEO_BATCH_ROOT="$AIWORKER_VIDEO_BATCH_DIR"
elif [[ -n "${AIWORKER_VIDEO_BATCH_DIR:-}" \
  && "$AIWORKER_VIDEO_BATCH_DIR" != "$CANONICAL_VIDEO_BATCH_ROOT" ]]; then
  printf 'Production video batch root is fixed at %s; custom overrides are test-only.\n' \
    "$CANONICAL_VIDEO_BATCH_ROOT" >&2
  exit 2
fi
MUTATION_AUTHORIZATION=""
SHARED_GATE_MODE=""

[[ -f "$SHARED_DEPLOYMENT_LOCK_HELPER" && ! -L "$SHARED_DEPLOYMENT_LOCK_HELPER" ]] || {
  printf 'Shared deployment lock helper is unavailable.\n' >&2
  exit 1
}
# shellcheck source=scripts/lib/shared-deployment-lock.sh
. "$SHARED_DEPLOYMENT_LOCK_HELPER"

usage() {
  printf 'Usage: %s (--dry-run|--apply|--rollback) --target-sha <40-lowercase-hex-sha> [--backup <absolute-backup>|--noop] [--result-output <absolute-path>] [--defer-gateway-restart]\n' "$0"
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --dry-run|--apply|--rollback|--probe-current-manifest)
      [[ -z "$MODE" ]] || { usage >&2; exit 2; }
      MODE="${1#--}"
      shift
      ;;
    --target-sha)
      [[ -z "$TARGET_SHA" && "$#" -ge 2 ]] || { usage >&2; exit 2; }
      TARGET_SHA="$2"
      shift 2
      ;;
    --backup)
      [[ -z "$ROLLBACK_BACKUP" && "$#" -ge 2 ]] || { usage >&2; exit 2; }
      ROLLBACK_BACKUP="$2"
      shift 2
      ;;
    --result-output)
      [[ -z "$RESULT_OUTPUT" && "$#" -ge 2 ]] || { usage >&2; exit 2; }
      RESULT_OUTPUT="$2"
      shift 2
      ;;
    --reservation-sha256)
      [[ -z "$RESERVATION_SHA256" && "$#" -ge 2 ]] || { usage >&2; exit 2; }
      RESERVATION_SHA256="$2"
      shift 2
      ;;
    --defer-gateway-restart)
      [[ "$DEFER_GATEWAY_RESTART" == 0 ]] || { usage >&2; exit 2; }
      DEFER_GATEWAY_RESTART=1
      shift
      ;;
    --noop)
      [[ "$ROLLBACK_NOOP" == 0 ]] || { usage >&2; exit 2; }
      ROLLBACK_NOOP=1
      shift
      ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
[[ -n "$MODE" && "$TARGET_SHA" =~ ^[a-f0-9]{40}$ ]] || { usage >&2; exit 2; }
[[ "$MODE" == "rollback" || -z "$ROLLBACK_BACKUP" ]] || { usage >&2; exit 2; }
[[ "$MODE" != "rollback" || "$ROLLBACK_NOOP" == 1 || -n "$ROLLBACK_BACKUP" ]] || { usage >&2; exit 2; }
[[ "$ROLLBACK_NOOP" == 0 || ( "$MODE" == rollback && -z "$ROLLBACK_BACKUP" ) ]] || { usage >&2; exit 2; }
[[ -z "$RESULT_OUTPUT" || "$RESULT_OUTPUT" == /* ]] || { usage >&2; exit 2; }
[[ "$MODE" != "dry-run" || -z "$RESULT_OUTPUT" ]] || { usage >&2; exit 2; }
if [[ "$MODE" == "probe-current-manifest" \
  && ( -z "$RESULT_OUTPUT" || ! "$RESERVATION_SHA256" =~ ^[a-f0-9]{64}$ ) ]]; then
  usage >&2
  exit 2
fi
[[ "$MODE" == "probe-current-manifest" || -z "$RESERVATION_SHA256" ]] || { usage >&2; exit 2; }
if [[ -n "$RESULT_OUTPUT" && ( -e "$RESULT_OUTPUT" || -L "$RESULT_OUTPUT" ) ]]; then
  printf 'Result output already exists; refusing to overwrite it: %s\n' "$RESULT_OUTPUT" >&2
  exit 1
fi
[[ "$DEFER_GATEWAY_RESTART" == 0 || "$MODE" != "dry-run" ]] || { usage >&2; exit 2; }
if [[ "$DEFER_GATEWAY_RESTART" == 1 && -z "$LEGACY_PREINSTALL_ATTEMPT_DIR" ]]; then
  printf '%s\n' '--defer-gateway-restart is restricted to a verified legacy preinstall attempt.' >&2
  exit 1
fi
if [[ "$MODE" != "dry-run" && "$MODE" != "probe-current-manifest" && -n "$LEGACY_PREINSTALL_ATTEMPT_DIR" \
  && -z "$RESULT_OUTPUT" ]]; then
  printf 'Legacy preinstall video-command mutations require an immutable raw result output path.\n' >&2
  exit 2
fi
EXPECTED_SOURCE_COMMIT="$TARGET_SHA"
EXPECTED_RELEASE_ID="$TARGET_SHA-runtime"

for command_name in awk chmod cmp cp date env find git hostname id install lsof mkdir mktemp node openclaw readlink rm shasum sort stat tr; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf 'Required command is unavailable: %s\n' "$command_name" >&2
    exit 1
  }
done

TEST_FAILPOINT="${AIWORKER_VIDEO_COMMAND_INSTALL_TEST_FAILPOINT:-}"
TEST_SYNC_DIR="${AIWORKER_VIDEO_COMMAND_INSTALL_TEST_SYNC_DIR:-}"
if [[ -n "$TEST_FAILPOINT$TEST_SYNC_DIR" \
  && "${AIWORKER_VIDEO_COMMAND_INSTALL_TESTING:-0}" != 1 ]]; then
  printf 'Video-command installer test controls require an explicit test environment.\n' >&2
  exit 1
fi
case "$TEST_FAILPOINT" in
  ""|rollback-source-before-claim|sigkill-after-first-mutation) ;;
  *) printf 'Unknown video-command installer test failpoint: %s\n' "$TEST_FAILPOINT" >&2; exit 1 ;;
esac
if [[ -n "$TEST_SYNC_DIR" && ( ! -d "$TEST_SYNC_DIR" || -L "$TEST_SYNC_DIR" ) ]]; then
  printf 'Video-command installer test synchronization directory is unsafe.\n' >&2
  exit 1
fi

wait_for_test_barrier() {
  local ready="$1" proceed="$2" description="$3"
  [[ -n "$TEST_SYNC_DIR" ]] || return 0
  install -m 600 /dev/null "$TEST_SYNC_DIR/$ready"
  local released=0
  for _ in {1..1000}; do
    if [[ -f "$TEST_SYNC_DIR/$proceed" ]]; then released=1; break; fi
    sleep 0.01
  done
  [[ "$released" == 1 ]] || {
    printf 'Timed out waiting for video-command test barrier: %s\n' "$description" >&2
    return 1
  }
}

run_qwen_openclaw() {
  env -u OPENCLAW_PROFILE -u OPENCLAW_STATE_DIR -u OPENCLAW_CONFIG_PATH \
    -u OPENCLAW_HOME -u OPENCLAW_INCLUDE_ROOTS \
    openclaw --profile "$PROFILE" "$@"
}

resolve_gateway_token() {
  node "$REPOSITORY_ROOT/scripts/lib/openclaw-secret-reference.mjs" "$PROFILE_CONFIG"
}

run_qwen_openclaw_gateway_call() {
  local gateway_token status
  gateway_token="$(resolve_gateway_token)" || {
    printf 'Unable to resolve the qwen-current Gateway token through its configured exec SecretRef.\n' >&2
    return 1
  }
  if OPENCLAW_GATEWAY_TOKEN="$gateway_token" \
    env -u OPENCLAW_PROFILE -u OPENCLAW_STATE_DIR -u OPENCLAW_CONFIG_PATH \
      -u OPENCLAW_HOME -u OPENCLAW_INCLUDE_ROOTS \
      openclaw --profile "$PROFILE" gateway call "$@"; then
    status=0
  else
    status=$?
  fi
  unset gateway_token
  return "$status"
}

cleanup() {
  local status=$?
  trap - EXIT HUP INT TERM
  set +e
  if [[ -n "$ROLLBACK_SOURCE_CLAIM" ]] && ! release_rollback_source_claim; then
    printf 'Rollback source claim could not be restored; private evidence was retained: %s\n' \
      "$ROLLBACK_SOURCE_CLAIM" >&2
    status=70
  fi
  if [[ -n "$WORK_ROOT" && -d "$WORK_ROOT" ]]; then
    case "$WORK_ROOT" in
      /tmp/aiworker-video-current-release.*|/private/tmp/aiworker-video-current-release.*)
        rm -rf -- "$WORK_ROOT"
        ;;
      *) printf 'Refusing unexpected temporary cleanup path.\n' >&2; status=70 ;;
    esac
  fi
  if [[ "$LOCAL_LOCK_OWNED" == 1 ]]; then
    rm -f -- "$LOCAL_LOCK_DIR/journal.json" "$LOCAL_LOCK_DIR/owner.json" 2>/dev/null || status=70
    rmdir "$LOCAL_LOCK_DIR" 2>/dev/null || status=70
    LOCAL_LOCK_OWNED=0
  fi
  if [[ "$DEPLOYMENT_LOCK_OWNED" == 1 ]]; then
    if ! release_shared_deployment_lock; then status=70; fi
  fi
  exit "$status"
}

WORK_ROOT="$(mktemp -d /tmp/aiworker-video-current-release.XXXXXX)"
chmod 700 "$WORK_ROOT"
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

read_version() {
  node -e 'process.stdout.write(require(process.argv[1]).version || "")' "$1"
}

is_supported_previous_version() {
  local candidate="$1" supported
  for supported in "${SUPPORTED_PREVIOUS_VERSIONS[@]}"; do
    [[ "$candidate" == "$supported" ]] && return 0
  done
  return 1
}

verify_shared_install_gate() {
  local gate_operation="install" gate_output gate_mode
  [[ "$MODE" != "rollback" ]] || gate_operation="rollback"
  local -a gate_arguments=(
    --mission-control-db-path "$MISSION_CONTROL_DB_PATH"
    --n8n-db-path "$N8N_DB_PATH"
    --video-batch-root "$VIDEO_BATCH_ROOT"
    --expected-source-commit "$EXPECTED_SOURCE_COMMIT"
    --expected-release-id "$EXPECTED_RELEASE_ID"
    --operation "$gate_operation"
    --component "video-command"
    --target-state-sha256 "$RESERVATION_TARGET_STATE_SHA256"
  )
  if [[ "$MUTATION_AUTHORIZATION" == production ]]; then
    gate_arguments+=(--deployment-run-dir "$DEPLOYMENT_RUN_DIR")
  fi
  if [[ -n "$LEGACY_PREINSTALL_ATTEMPT_DIR" ]]; then
    gate_arguments+=(--legacy-preinstall-attempt-dir "$LEGACY_PREINSTALL_ATTEMPT_DIR")
    gate_arguments+=(--raw-result-output "$RESULT_OUTPUT")
  fi
  gate_output="$(node "$SHARED_INSTALL_GATE" "${gate_arguments[@]}")" || {
    printf 'Shared video-command replacement requires paused intake, zero active tasks, and zero pending director outbox rows.\n' >&2
    return 1
  }
  if [[ "$MUTATION_AUTHORIZATION" == production ]]; then
    gate_mode="$(printf '%s' "$gate_output" | node -e '
      const fs = require("node:fs")
      const value = JSON.parse(fs.readFileSync(0, "utf8"))
      if (value?.mode === "legacy-preinstall" && value?.reservation?.path) {
        process.stdout.write("legacy-preinstall")
      } else if (value?.mode === "rolling") {
        process.stdout.write("rolling")
      } else process.exit(1)
    ')" || {
      printf 'Video-command mutations require a recognized shared install gate authorization.\n' >&2
      return 1
    }
    SHARED_GATE_MODE="$gate_mode"
    if [[ "$gate_mode" == legacy-preinstall ]]; then
      [[ -n "$LEGACY_PREINSTALL_ATTEMPT_DIR" ]] || {
        printf 'Video-command legacy mutations require a reserved preinstall attempt.\n' >&2
        return 1
      }
    else
      [[ -z "$LEGACY_PREINSTALL_ATTEMPT_DIR" ]] || {
        printf 'Video-command rolling mutations cannot carry a legacy preinstall attempt.\n' >&2
        return 1
      }
    fi
  fi
}

authorize_mutating_invocation() {
  [[ "$MODE" == "dry-run" ]] && return 0
  if [[ -z "$ISOLATED_TEST_ROOT" || "${NODE_ENV:-}" != test ]]; then
    MUTATION_AUTHORIZATION=production
    return 0
  fi
  node - "$ISOLATED_TEST_ROOT" "$HOME" "$PROFILE_STATE_DIR" "$BACKUP_ROOT" \
    "$DEPLOYMENT_RUN_DIR" "$MISSION_CONTROL_DB_PATH" "$N8N_DB_PATH" \
    "$VIDEO_BATCH_ROOT" "$RESULT_OUTPUT" <<'NODE'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const [rootInput, ...candidates] = process.argv.slice(2)
const root = path.resolve(rootInput)
const temporaryRoot = fs.realpathSync.native(os.tmpdir())
const value = fs.lstatSync(root)
if (rootInput !== root || fs.realpathSync.native(root) !== root || value.isSymbolicLink()
  || !value.isDirectory() || value.uid !== process.getuid() || (value.mode & 0o077) !== 0
  || (root !== temporaryRoot && !root.startsWith(`${temporaryRoot}${path.sep}`))) {
  throw new Error('isolated_test_root_unsafe')
}
for (const input of candidates.filter(Boolean)) {
  let candidate = path.resolve(input)
  if (input !== candidate) throw new Error('isolated_test_path_not_normalized')
  for (const alias of ['/var', '/tmp']) {
    if (process.platform !== 'darwin'
      || (candidate !== alias && !candidate.startsWith(`${alias}${path.sep}`))) continue
    candidate = `${fs.realpathSync.native(alias)}${candidate.slice(alias.length)}`
  }
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error('isolated_test_path_outside_root')
  }
  let cursor = candidate
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor)
    if (parent === cursor) throw new Error('isolated_test_path_unresolvable')
    cursor = parent
  }
  while (cursor !== root) {
    const entry = fs.lstatSync(cursor)
    if (entry.isSymbolicLink()) throw new Error('isolated_test_path_symlink')
    cursor = path.dirname(cursor)
  }
}
NODE
  MUTATION_AUTHORIZATION=isolated-test
}

listener_snapshot() {
  local port
  for port in 3017 5678 5679 18091 18789 18889 18989; do
    lsof -nP -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1 || {
      printf 'Protected listener %s is missing.\n' "$port" >&2
      return 1
    }
    printf '%s=ready\n' "$port"
  done
}

validate_git_target() {
  local remote_url branch head origin_main live_record
  remote_url="$(git -C "$REPOSITORY_ROOT" remote get-url origin)"
  case "$remote_url" in
    https://github.com/MAKingljx/video-autoworker|https://github.com/MAKingljx/video-autoworker.git|git@github.com:MAKingljx/video-autoworker.git) ;;
    *) printf 'Canonical Git remote mismatch.\n' >&2; return 1 ;;
  esac
  branch="$(git -C "$REPOSITORY_ROOT" symbolic-ref --short -q HEAD)"
  [[ "$branch" == "main" ]] || { printf 'Canonical checkout must be on main.\n' >&2; return 1; }
  [[ -z "$(git -C "$REPOSITORY_ROOT" status --porcelain --untracked-files=normal)" ]] || {
    printf 'Canonical checkout must be clean.\n' >&2
    return 1
  }
  git -C "$REPOSITORY_ROOT" fetch --prune origin >/dev/null
  head="$(git -C "$REPOSITORY_ROOT" rev-parse --verify 'HEAD^{commit}')"
  origin_main="$(git -C "$REPOSITORY_ROOT" rev-parse --verify 'refs/remotes/origin/main^{commit}')"
  live_record="$(git -C "$REPOSITORY_ROOT" ls-remote --exit-code origin refs/heads/main)"
  [[ "$head" == "$TARGET_SHA" && "$origin_main" == "$TARGET_SHA" \
    && "$live_record" == "$TARGET_SHA"$'\trefs/heads/main' ]] || {
    printf 'HEAD, origin/main, live GitHub main, and target SHA must match.\n' >&2
    return 1
  }
}

validate_source() {
  [[ "$(id -un)" == "$EXPECTED_USER" && "$(hostname)" == "$EXPECTED_HOST" ]] || {
    printf 'Refusing non-production identity.\n' >&2
    return 1
  }
  case "$(openclaw --version)" in
    "OpenClaw $OPENCLAW_VERSION ("*")") ;;
    *) printf 'Unsupported OpenClaw version.\n' >&2; return 1 ;;
  esac
  validate_git_target
  [[ -f "$PROFILE_CONFIG" && ! -L "$PROFILE_CONFIG" ]] || return 1
  [[ -d "$PLUGIN_DIR" && ! -L "$PLUGIN_DIR" ]] || return 1
  [[ -f "$SHARED_INSTALL_GATE" && ! -L "$SHARED_INSTALL_GATE" ]] || return 1
  [[ -f "$SHARED_DEPLOYMENT_LOCK_HELPER" && ! -L "$SHARED_DEPLOYMENT_LOCK_HELPER" ]] || return 1
  [[ "$(read_version "$PLUGIN_DIR/package.json")" == "$CURRENT_VERSION" ]] || return 1
  [[ "$(read_version "$PLUGIN_DIR/openclaw.plugin.json")" == "$CURRENT_VERSION" ]] || return 1
  node - "$PROFILE_CONFIG" "$PLUGIN_DIR/openclaw.plugin.json" "$PLUGIN_ID" "$AGENT_ID" "$TOOL_ID" <<'NODE'
const fs = require('node:fs')
const [configPath, manifestPath, pluginId, agentId, toolId] = process.argv.slice(2)
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const entry = config?.plugins?.entries?.[pluginId]
if (!entry || entry.config?.releaseReady !== true || entry.llm?.allowAgentIdOverride !== true) {
  throw new Error('plugin release gate or LLM override policy is not ready')
}
if (JSON.stringify(manifest?.activation?.onCapabilities) !== JSON.stringify(['hook', 'tool'])) {
  throw new Error('plugin must expose exactly hook and tool capabilities')
}
if (JSON.stringify(manifest?.contracts?.tools) !== JSON.stringify([toolId])) {
  throw new Error('plugin tool contract mismatch')
}
if (manifest?.toolMetadata?.[toolId]?.optional !== true) {
  throw new Error('plugin tool must remain optional')
}
if (JSON.stringify(manifest?.configSchema) !== JSON.stringify({
  type: 'object',
  additionalProperties: false,
  properties: { releaseReady: { type: 'boolean' } },
})) {
  throw new Error('plugin config schema must contain only the current release gate')
}
const agents = Array.isArray(config?.agents?.list) ? config.agents.list : []
const targets = agents.filter(agent => agent?.id === agentId)
if (targets.length !== 1) throw new Error('target agent must exist exactly once')
const allowGrants = Array.isArray(targets[0]?.tools?.allow)
  ? targets[0].tools.allow.filter(id => id === toolId) : []
const profileExpansionGrants = Array.isArray(targets[0]?.tools?.alsoAllow)
  ? targets[0].tools.alsoAllow.filter(id => id === toolId) : []
const hasExplicitAllow = Array.isArray(targets[0]?.tools?.allow)
if (profileExpansionGrants.length !== 1
  || (hasExplicitAllow ? allowGrants.length !== 1 : allowGrants.length !== 0)) {
  throw new Error('target agent must grant the optional direct tool exactly once through alsoAllow')
}
for (const agent of agents) {
  if (agent?.id === agentId) continue
  for (const key of ['allow', 'alsoAllow']) {
    if (Array.isArray(agent?.tools?.[key]) && agent.tools[key].includes(toolId)) {
      throw new Error('direct tool is granted to another agent')
    }
  }
}
for (const key of ['allow', 'alsoAllow']) {
  if (Array.isArray(config?.tools?.[key]) && config.tools[key].includes(toolId)) {
    throw new Error('direct tool must not be granted globally')
  }
}
NODE
  LEGACY_SENDER_HASH_PRESENT="$(node - "$PROFILE_CONFIG" "$PLUGIN_ID" <<'NODE'
const fs = require('node:fs')
const [configPath, pluginId] = process.argv.slice(2)
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
const pluginConfig = config?.plugins?.entries?.[pluginId]?.config
if (!pluginConfig || typeof pluginConfig !== 'object' || Array.isArray(pluginConfig)) process.exit(1)
if (!Object.prototype.hasOwnProperty.call(pluginConfig, 'allowedSenderSha256')) {
  process.stdout.write('0')
} else if (/^[a-f0-9]{64}$/u.test(pluginConfig.allowedSenderSha256)) {
  process.stdout.write('1')
} else {
  process.exit(1)
}
NODE
  )" || return 1
  while IFS= read -r javascript_file; do
    node --check "$javascript_file"
  done < <(find "$PLUGIN_DIR" -type f \( -name '*.js' -o -name '*.mjs' \) -print | LC_ALL=C sort)
}

validate_config_migration() {
  local before_path="$1" after_path="$2"
  node - "$before_path" "$after_path" "$PLUGIN_ID" <<'NODE'
const fs = require('node:fs')
const [beforePath, afterPath, pluginId] = process.argv.slice(2)
const before = JSON.parse(fs.readFileSync(beforePath, 'utf8'))
const after = JSON.parse(fs.readFileSync(afterPath, 'utf8'))
const expected = structuredClone(before)
const pluginConfig = expected?.plugins?.entries?.[pluginId]?.config
if (!pluginConfig || typeof pluginConfig !== 'object' || Array.isArray(pluginConfig)) process.exit(1)
delete pluginConfig.allowedSenderSha256
if (JSON.stringify(expected) !== JSON.stringify(after)) {
  throw new Error('qwen-current config changed beyond the retired sender hash removal')
}
NODE
}

validate_installed_version() {
  local expected="$1"
  [[ -d "$INSTALLED_PLUGIN_DIR" && ! -L "$INSTALLED_PLUGIN_DIR" ]] || return 1
  [[ "$(read_version "$INSTALLED_PLUGIN_DIR/package.json")" == "$expected" ]]
}

validate_runtime_payload_matches() {
  local source_dir="$1"
  node - "$source_dir" "$INSTALLED_PLUGIN_DIR" <<'NODE'
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const [sourceRoot, installedRoot] = process.argv.slice(2)

function digest(pathname) {
  return createHash('sha256').update(fs.readFileSync(pathname)).digest('hex')
}

function runtimeFiles(root) {
  const files = ['index.js', 'openclaw.plugin.json', 'package.json']
  for (const directory of ['lib', 'scripts']) {
    const base = path.join(root, directory)
    if (!fs.statSync(base, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error('runtime payload directory is missing: ' + directory)
    }
    const visit = (pathname, relative) => {
      for (const entry of fs.readdirSync(pathname, { withFileTypes: true })) {
        const child = path.join(pathname, entry.name)
        const childRelative = path.posix.join(relative, entry.name)
        if (entry.isSymbolicLink()) throw new Error('runtime payload symlink is forbidden')
        if (entry.isDirectory()) visit(child, childRelative)
        else if (entry.isFile()) files.push(childRelative)
        else throw new Error('unsupported runtime payload object')
      }
    }
    visit(base, directory)
  }
  return new Map(files.sort().map(relative => [relative, digest(path.join(root, relative))]))
}

const source = runtimeFiles(sourceRoot)
const installed = runtimeFiles(installedRoot)
if (source.size !== installed.size
  || [...source].some(([relative, value]) => installed.get(relative) !== value)) {
  throw new Error('installed runtime payload differs from the canonical source')
}
NODE
}

validate_runtime() {
  local expected="$1" report="$2" catalog="$3"
  run_qwen_openclaw gateway status --deep --require-rpc --json > "$WORK_ROOT/gateway-status.json" \
    || return 1
  run_qwen_openclaw plugins inspect "$PLUGIN_ID" --runtime --json > "$report" \
    || return 1
  node "$RUNTIME_VALIDATOR" "$report" "$PLUGIN_ID" "$expected" || return 1
  run_qwen_openclaw_gateway_call tools.catalog \
    --params "{\"agentId\":\"$AGENT_ID\",\"includePlugins\":true}" \
    --timeout 20000 --json > "$catalog" || return 1
  node - "$catalog" "$PLUGIN_ID" "$AGENT_ID" "$TOOL_ID" <<'NODE'
const fs = require('node:fs')
const [reportPath, pluginId, agentId, toolId] = process.argv.slice(2)
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
const matches = (report?.groups ?? [])
  .flatMap(group => (group?.tools ?? []).map(tool => ({ group, tool })))
  .filter(({ tool }) => tool?.id === toolId)
if (report?.agentId !== agentId || matches.length !== 1) process.exit(1)
const { group, tool } = matches[0]
if (group?.pluginId !== pluginId || group?.source !== 'plugin'
  || tool?.pluginId !== pluginId || tool?.source !== 'plugin' || tool?.optional !== true) {
  process.exit(1)
}
NODE
}

write_tree_manifest() {
  local tree_root="$1" output_path="$2"
  (
    cd "$tree_root"
    while IFS= read -r path; do
      local_path="${path#./}"
      case "$local_path" in
        MANIFEST.sha256|.verified) continue ;;
      esac
      mode="$(stat -f '%Lp' "$path")"
      if [[ -L "$path" ]]; then
        target="$(readlink "$path")"
        digest="$(printf '%s' "$target" | shasum -a 256 | awk '{print $1}')"
        printf '%s\tsymlink\t%s\t%s\t%s\n' "$local_path" "$mode" "$digest" "$target"
      elif [[ -d "$path" ]]; then
        printf '%s\tdirectory\t%s\t-\t-\n' "$local_path" "$mode"
      elif [[ -f "$path" ]]; then
        digest="$(shasum -a 256 "$path" | awk '{print $1}')"
        printf '%s\tfile\t%s\t%s\t-\n' "$local_path" "$mode" "$digest"
      else
        printf 'Unsupported backup object: %s\n' "$path" >&2
        return 1
      fi
    done < <(LC_ALL=C find . -mindepth 1 -print | LC_ALL=C sort)
  ) > "$output_path"
}

target_manifest_sha256() {
  node - "$INSTALLED_PLUGIN_DIR" "$PROFILE_CONFIG" <<'NODE'
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const [pluginRoot, configPath] = process.argv.slice(2)
const sha256 = value => createHash('sha256').update(value).digest('hex')
const files = ['index.js', 'openclaw.plugin.json', 'package.json']
for (const directory of ['lib', 'scripts']) {
  const base = path.join(pluginRoot, directory)
  if (!fs.statSync(base, { throwIfNoEntry: false })?.isDirectory()) process.exit(1)
  const visit = (pathname, relative) => {
    for (const entry of fs.readdirSync(pathname, { withFileTypes: true })) {
      const child = path.join(pathname, entry.name)
      const childRelative = path.posix.join(relative, entry.name)
      if (entry.isSymbolicLink()) process.exit(1)
      if (entry.isDirectory()) visit(child, childRelative)
      else if (entry.isFile()) files.push(childRelative)
      else process.exit(1)
    }
  }
  visit(base, directory)
}

const configStat = fs.lstatSync(configPath)
if (!configStat.isFile() || configStat.isSymbolicLink()) process.exit(1)
const manifest = {
  config: sha256(fs.readFileSync(configPath)),
  plugin: files.sort().map(relative => [
    relative,
    sha256(fs.readFileSync(path.join(pluginRoot, relative))),
  ]),
}
process.stdout.write(sha256(JSON.stringify(manifest)))
NODE
}

if [[ "$MODE" == "probe-current-manifest" ]]; then
  probe_digest="$(target_manifest_sha256)" || exit 1
  node - "$RESULT_OUTPUT" "$REPOSITORY_ROOT/scripts/install-aiworker-video-command-plugin.sh" \
    "$EXPECTED_SOURCE_COMMIT" "$EXPECTED_RELEASE_ID" "$RESERVATION_SHA256" "$probe_digest" <<'NODE'
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const [output, verifierPath, sourceCommit, targetReleaseId, reservationSha256,
  targetStateSha256] = process.argv.slice(2)
const sha256 = value => createHash('sha256').update(value).digest('hex')
const stat = fs.lstatSync(verifierPath, { bigint: true })
const value = {
  schema: 'video-autoworker-component-target-probe/v1', component: 'video-command', sourceCommit,
  targetReleaseId, reservationSha256, targetStateSha256,
  observedAt: Math.floor(Date.now() / 1000),
  verifier: { path: verifierPath, dev: stat.dev.toString(), ino: stat.ino.toString(),
    size: Number(stat.size), sha256: sha256(fs.readFileSync(verifierPath)) },
}
const fd = fs.openSync(output, fs.constants.O_WRONLY | fs.constants.O_CREAT
  | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
try { fs.writeFileSync(fd, `${JSON.stringify(value)}\n`); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
NODE
  exit 0
fi

write_install_result() {
  local operation="$1" status="$2" before_digest="$3" after_digest="$4"
  local backup_path="$5" backup_manifest_digest="$6" requires_fresh_restart="$7"
  [[ -n "$RESULT_OUTPUT" ]] || return 0
  node - "$RESULT_OUTPUT" "$operation" "$status" "$EXPECTED_SOURCE_COMMIT" \
    "$EXPECTED_RELEASE_ID" "$before_digest" "$after_digest" "$backup_path" \
    "$backup_manifest_digest" "$requires_fresh_restart" <<'NODE'
const fs = require('node:fs')
const [outputPath, operation, status, sourceCommit, targetReleaseId,
  beforeManifestSha256, afterManifestSha256, backupPath,
  backupManifestSha256, requiresFreshRestartSource] = process.argv.slice(2)
const sha256 = /^[a-f0-9]{64}$/u
if (!['apply', 'rollback'].includes(operation)
  || !['applied', 'noop', 'restored'].includes(status)
  || !/^[a-f0-9]{40}$/u.test(sourceCommit)
  || targetReleaseId !== `${sourceCommit}-runtime`
  || !sha256.test(beforeManifestSha256) || !sha256.test(afterManifestSha256)
  || !['0', '1'].includes(requiresFreshRestartSource)
  || ((backupPath === '') !== (backupManifestSha256 === ''))
  || (backupManifestSha256 !== '' && !sha256.test(backupManifestSha256))) {
  throw new Error('invalid installer result evidence')
}
const value = {
  schema: 'video-autoworker-installer-result/v1',
  component: 'video-command',
  operation,
  status,
  sourceCommit,
  targetReleaseId,
  beforeManifestSha256,
  afterManifestSha256,
  backup: backupPath === '' ? null : { path: backupPath, manifestSha256: backupManifestSha256 },
  requiresFreshRestart: requiresFreshRestartSource === '1',
  completedAt: Math.floor(Date.now() / 1000),
}
const handle = fs.openSync(outputPath, fs.constants.O_WRONLY | fs.constants.O_CREAT
  | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
try {
  fs.fchmodSync(handle, 0o600)
  fs.writeFileSync(handle, `${JSON.stringify(value)}\n`, { encoding: 'utf8' })
  fs.fsyncSync(handle)
} finally {
  fs.closeSync(handle)
}
NODE
}

write_backup_manifest() {
  write_tree_manifest "$BACKUP_DIR" "$BACKUP_DIR/MANIFEST.sha256"
  chmod 600 "$BACKUP_DIR/MANIFEST.sha256"
  shasum -a 256 "$BACKUP_DIR/MANIFEST.sha256" | awk '{print $1}' > "$BACKUP_DIR/.verified"
  chmod 600 "$BACKUP_DIR/.verified"
}

verify_backup() {
  local candidate="$1" expected_parent="${2:-$BACKUP_ROOT}"
  local candidate_name actual_manifest expected_digest actual_digest metadata
  [[ "${candidate%/*}" == "$expected_parent" ]] || return 1
  candidate_name="${candidate##*/}"
  [[ "$candidate_name" =~ ^current-release-[0-9]{8}-[0-9]{6}\.[A-Za-z0-9]+$ ]] || return 1
  [[ -d "$candidate" && ! -L "$candidate" && "$(stat -f '%Lp' "$candidate")" == "700" ]] || return 1
  for required in openclaw.json metadata.json MANIFEST.sha256 .verified; do
    [[ -f "$candidate/$required" && ! -L "$candidate/$required" ]] || return 1
  done
  [[ -d "$candidate/previous-plugin" && ! -L "$candidate/previous-plugin" ]] || return 1
  actual_manifest="$WORK_ROOT/verify-${candidate_name}.manifest"
  write_tree_manifest "$candidate" "$actual_manifest"
  cmp -s "$actual_manifest" "$candidate/MANIFEST.sha256" || return 1
  expected_digest="$(tr -d '[:space:]' < "$candidate/.verified")"
  actual_digest="$(shasum -a 256 "$candidate/MANIFEST.sha256" | awk '{print $1}')"
  [[ "$expected_digest" =~ ^[a-f0-9]{64}$ && "$expected_digest" == "$actual_digest" ]] || return 1
  metadata="$(node - "$candidate/metadata.json" "$candidate/previous-plugin/package.json" <<'NODE'
const fs = require('node:fs')
const [metadataPath, packagePath] = process.argv.slice(2)
const value = JSON.parse(fs.readFileSync(metadataPath, 'utf8'))
const previous = JSON.parse(fs.readFileSync(packagePath, 'utf8')).version
if (value?.schemaVersion !== 1 || value?.previousVersion !== previous
  || typeof value?.candidateVersion !== 'string'
  || !/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(value.candidateVersion)
  || !/^[a-f0-9]{40}$/u.test(value.targetSha)
  || !/^[a-f0-9]{64}$/u.test(value.configSha256)) process.exit(1)
process.stdout.write([value.previousVersion, value.candidateVersion, value.configSha256].join('\t'))
NODE
  )" || return 1
  config_sha="$(shasum -a 256 "$candidate/openclaw.json" | awk '{print $1}')"
  [[ "$config_sha" == "$(printf '%s' "$metadata" | awk -F '\t' '{print $3}')" ]] || return 1
  printf '%s\n' "$metadata"
}

path_identity() {
  stat -f '%d:%i' "$1"
}

capture_rollback_source_identities() {
  local source="$1"
  verify_backup "$source" >/dev/null || return 1
  ROLLBACK_SOURCE_ROOT_IDENTITY="$(path_identity "$source")" || return 1
  ROLLBACK_SOURCE_MANIFEST_IDENTITY="$(path_identity "$source/MANIFEST.sha256")" || return 1
  ROLLBACK_SOURCE_MANIFEST_SHA256="$(shasum -a 256 "$source/MANIFEST.sha256" | awk '{print $1}')" \
    || return 1
}

claim_rollback_source() {
  local original="$1" claim_name claim_path
  ROLLBACK_SOURCE_CLAIM_ROOT="$(mktemp -d "$BACKUP_ROOT/.rollback-source-claim.XXXXXX")" \
    || return 1
  chmod 700 "$ROLLBACK_SOURCE_CLAIM_ROOT" || return 1
  claim_name="${original##*/}"
  claim_path="$ROLLBACK_SOURCE_CLAIM_ROOT/$claim_name"
  mv "$original" "$claim_path" || return 1
  ROLLBACK_SOURCE_ORIGINAL="$original"
  ROLLBACK_RESULT_BACKUP="$original"
  ROLLBACK_SOURCE_CLAIM="$claim_path"
  ROLLBACK_BACKUP="$claim_path"
  [[ "$(path_identity "$ROLLBACK_BACKUP")" == "$ROLLBACK_SOURCE_ROOT_IDENTITY" \
    && "$(path_identity "$ROLLBACK_BACKUP/MANIFEST.sha256")" \
      == "$ROLLBACK_SOURCE_MANIFEST_IDENTITY" \
    && "$(shasum -a 256 "$ROLLBACK_BACKUP/MANIFEST.sha256" | awk '{print $1}')" \
      == "$ROLLBACK_SOURCE_MANIFEST_SHA256" ]] \
    && verify_backup "$ROLLBACK_BACKUP" "$ROLLBACK_SOURCE_CLAIM_ROOT" >/dev/null
}

release_rollback_source_claim() {
  [[ -n "$ROLLBACK_SOURCE_CLAIM" ]] || return 0
  [[ ! -e "$ROLLBACK_SOURCE_ORIGINAL" && ! -L "$ROLLBACK_SOURCE_ORIGINAL" ]] || return 1
  mv "$ROLLBACK_SOURCE_CLAIM" "$ROLLBACK_SOURCE_ORIGINAL" || return 1
  ROLLBACK_BACKUP="$ROLLBACK_SOURCE_ORIGINAL"
  ROLLBACK_SOURCE_CLAIM=""
  rmdir "$ROLLBACK_SOURCE_CLAIM_ROOT" || return 1
  ROLLBACK_SOURCE_CLAIM_ROOT=""
}

process_start_token() {
  /bin/ps -p "$1" -o lstart= 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
}

write_video_lock_owner() {
  LOCAL_OWNER_START="$(process_start_token "$$")"
  LOCAL_LOCK_FENCE="$(node -e "process.stdout.write(require('node:crypto').randomBytes(16).toString('hex'))")"
  [[ -n "$LOCAL_OWNER_START" ]] || return 1
  local stage="$LOCAL_LOCK_DIR.claim.$LOCAL_LOCK_FENCE"
  mkdir -m 700 "$stage" || return 1
  node - "$stage/owner.json" "$$" "$LOCAL_OWNER_START" "$LOCAL_LOCK_FENCE" <<'NODE'
const fs = require('node:fs')
const [pathname, pid, start, fence] = process.argv.slice(2)
const fd = fs.openSync(pathname, fs.constants.O_WRONLY | fs.constants.O_CREAT
  | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
try {
  fs.writeFileSync(fd, `${JSON.stringify({
    schema: 'video-autoworker-installer-owner/v1', component: 'video-command',
    pid: Number(pid), start, fence,
  })}\n`)
  fs.fsyncSync(fd)
} finally { fs.closeSync(fd) }
const dirFd = fs.openSync(require('node:path').dirname(pathname),
  fs.constants.O_RDONLY | fs.constants.O_DIRECTORY)
try { fs.fsyncSync(dirFd) } finally { fs.closeSync(dirFd) }
NODE
  if ! mv "$stage" "$LOCAL_LOCK_DIR" 2>/dev/null; then
    rm -rf -- "$stage"
    return 1
  fi
  LOCAL_LOCK_OWNED=1
}

video_journal_field() {
  node - "$LOCAL_LOCK_DIR/journal.json" "$1" <<'NODE'
const fs = require('node:fs')
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const fields = {
  phase: value.phase, fence: value.fence, before: value.beforeManifestSha256,
  backupPath: value.backup?.path, backupIdentity: value.backup?.identity,
  backupDigest: value.backup?.manifestSha256, defer: value.deferGatewayRestart,
  sourceOriginal: value.rollbackSource?.original || '',
  sourceClaim: value.rollbackSource?.claim || '',
  sourceClaimRoot: value.rollbackSource?.claimRoot || '',
}
if (value?.schema !== 'video-autoworker-installer-journal/v1'
  || value?.component !== 'video-command' || !(process.argv[3] in fields)) process.exit(1)
const result = fields[process.argv[3]]
if (typeof result === 'string' && /[\r\n]/u.test(result)) process.exit(1)
process.stdout.write(String(result))
NODE
}

write_video_journal() {
  local backup="$1" digest="$2" identity
  identity="$(path_identity "$backup")" || return 1
  node - "$LOCAL_LOCK_DIR/journal.json" "$MODE" "$LOCAL_LOCK_FENCE" \
    "$BEFORE_MANIFEST_SHA256" "$backup" "$identity" "$digest" \
    "$DEFER_GATEWAY_RESTART" "$ROLLBACK_SOURCE_ORIGINAL" "$ROLLBACK_SOURCE_CLAIM" \
    "$ROLLBACK_SOURCE_CLAIM_ROOT" "$RESULT_OUTPUT" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const [pathname, operation, fence, beforeManifestSha256, backupPath, identity,
  manifestSha256, defer, sourceOriginal, sourceClaim, sourceClaimRoot,
  resultOutput] = process.argv.slice(2)
const value = {
  schema: 'video-autoworker-installer-journal/v1', component: 'video-command',
  operation, fence, phase: 'prepared', beforeManifestSha256,
  backup: { path: backupPath, identity, manifestSha256 },
  deferGatewayRestart: Number(defer),
  rollbackSource: sourceOriginal ? {
    original: sourceOriginal, claim: sourceClaim, claimRoot: sourceClaimRoot,
  } : null,
  resultOutput: resultOutput || null,
}
const fd = fs.openSync(pathname, fs.constants.O_WRONLY | fs.constants.O_CREAT
  | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
try { fs.writeFileSync(fd, `${JSON.stringify(value)}\n`); fs.fsyncSync(fd) }
finally { fs.closeSync(fd) }
const dirFd = fs.openSync(path.dirname(pathname), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY)
try { fs.fsyncSync(dirFd) } finally { fs.closeSync(dirFd) }
NODE
}

mark_video_journal_complete() {
  local after="$1"
  node - "$LOCAL_LOCK_DIR/journal.json" "$LOCAL_LOCK_FENCE" "$after" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const [pathname, fence, afterManifestSha256] = process.argv.slice(2)
const value = JSON.parse(fs.readFileSync(pathname, 'utf8'))
if (value?.fence !== fence || value?.phase !== 'prepared') process.exit(1)
value.phase = 'complete'
value.afterManifestSha256 = afterManifestSha256
const temporary = `${pathname}.complete.${fence}`
const fd = fs.openSync(temporary, 'wx', 0o600)
try { fs.writeFileSync(fd, `${JSON.stringify(value)}\n`); fs.fsyncSync(fd) }
finally { fs.closeSync(fd) }
fs.renameSync(temporary, pathname)
const dirFd = fs.openSync(path.dirname(pathname), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY)
try { fs.fsyncSync(dirFd) } finally { fs.closeSync(dirFd) }
NODE
}

recover_video_stale_lock() {
  local owner owner_pid owner_start owner_fence actual_start
  owner="$(node - "$LOCAL_LOCK_DIR/owner.json" <<'NODE'
const fs = require('node:fs')
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
if (value?.schema !== 'video-autoworker-installer-owner/v1'
  || value?.component !== 'video-command' || !Number.isSafeInteger(value?.pid)
  || typeof value?.start !== 'string' || !/^[a-f0-9]{32}$/u.test(value?.fence || '')) process.exit(1)
process.stdout.write(`${value.pid}\t${value.start}\t${value.fence}`)
NODE
)" || return 1
  IFS=$'\t' read -r owner_pid owner_start owner_fence <<< "$owner"
  actual_start="$(process_start_token "$owner_pid")"
  if [[ -n "$actual_start" && "$actual_start" == "$owner_start" ]]; then
    printf 'Another video-command installation is already in progress.\n' >&2
    return 1
  fi
  if [[ ! -f "$LOCAL_LOCK_DIR/journal.json" ]]; then
    rm -f -- "$LOCAL_LOCK_DIR/owner.json" && rmdir "$LOCAL_LOCK_DIR"
    return
  fi
  [[ "$(video_journal_field fence)" == "$owner_fence" ]] || return 1
  local phase backup identity digest source_original source_claim source_claim_root
  phase="$(video_journal_field phase)"
  backup="$(video_journal_field backupPath)"
  identity="$(video_journal_field backupIdentity)"
  digest="$(video_journal_field backupDigest)"
  if [[ "$phase" == prepared ]]; then
    [[ "$(path_identity "$backup")" == "$identity" \
      && "$(shasum -a 256 "$backup/MANIFEST.sha256" | awk '{print $1}')" == "$digest" ]] \
      || return 1
    verify_backup "$backup" >/dev/null || return 1
    restore_backup "$backup" "$(video_journal_field defer)" || return 1
    [[ "$(target_manifest_sha256)" == "$(video_journal_field before)" ]] || return 1
    source_original="$(video_journal_field sourceOriginal)"
    source_claim="$(video_journal_field sourceClaim)"
    source_claim_root="$(video_journal_field sourceClaimRoot)"
    if [[ -n "$source_claim" ]]; then
      [[ ! -e "$source_original" && ! -L "$source_original" \
        && -d "$source_claim" && ! -L "$source_claim" ]] || return 1
      mv "$source_claim" "$source_original" || return 1
      rmdir "$source_claim_root" || return 1
    fi
  elif [[ "$phase" != complete ]]; then
    return 1
  fi
  rm -f -- "$LOCAL_LOCK_DIR/journal.json" "$LOCAL_LOCK_DIR/owner.json"
  rmdir "$LOCAL_LOCK_DIR"
}

acquire_video_local_lock() {
  if [[ -e "$LOCAL_LOCK_DIR" || -L "$LOCAL_LOCK_DIR" ]]; then
    recover_video_stale_lock || return 1
    STALE_RECOVERED=1
    return 0
  fi
  write_video_lock_owner
}

restore_backup() {
  local candidate="$1" defer_gateway_restart="${2:-0}" metadata previous_version
  metadata="$(verify_backup "$candidate" "${ROLLBACK_SOURCE_CLAIM_ROOT:-$BACKUP_ROOT}")" || return 1
  previous_version="$(printf '%s' "$metadata" | awk -F '\t' '{print $1}')"
  run_qwen_openclaw plugins install --force "$candidate/previous-plugin" \
    > "$WORK_ROOT/restore-install.txt" 2>&1 || return 1
  if [[ "$TEST_FAILPOINT" == sigkill-after-first-mutation ]]; then
    wait_for_test_barrier sigkill-ready sigkill-continue 'SIGKILL after first rollback mutation'
  fi
  install -m 600 "$candidate/openclaw.json" "$PROFILE_CONFIG" || return 1
  if [[ "$defer_gateway_restart" == 0 ]]; then
    run_qwen_openclaw gateway restart --wait 60s --json \
      > "$WORK_ROOT/restore-restart.json" || return 1
  fi
  validate_installed_version "$previous_version" || return 1
  validate_runtime_payload_matches "$candidate/previous-plugin" || return 1
  if [[ "$defer_gateway_restart" == 0 ]]; then
    validate_runtime "$previous_version" "$WORK_ROOT/runtime-restored.json" \
      "$WORK_ROOT/catalog-restored.json" || return 1
  fi
  [[ "$(shasum -a 256 "$PROFILE_CONFIG" | awk '{print $1}')" \
    == "$(printf '%s' "$metadata" | awk -F '\t' '{print $3}')" ]] || return 1
  [[ "$(listener_snapshot)" == "$BEFORE_LISTENERS" ]] || return 1
}

create_safety_backup() {
  local previous_version="$1" candidate_version="$2"
  BACKUP_DIR="$(mktemp -d "$BACKUP_ROOT/current-release-$(date +%Y%m%d-%H%M%S).XXXXXX")"
  chmod 700 "$BACKUP_DIR"
  install -m 600 "$PROFILE_CONFIG" "$BACKUP_DIR/openclaw.json"
  cp -R -p "$INSTALLED_PLUGIN_DIR" "$BACKUP_DIR/previous-plugin"
  printf '{"schemaVersion":1,"previousVersion":"%s","candidateVersion":"%s","targetSha":"%s","configSha256":"%s"}\n' \
    "$previous_version" "$candidate_version" "$TARGET_SHA" "$BEFORE_CONFIG_SHA" > "$BACKUP_DIR/metadata.json"
  chmod 600 "$BACKUP_DIR/metadata.json"
  write_backup_manifest
  verify_backup "$BACKUP_DIR" >/dev/null
}

enforce_retention() {
  local candidate remove_count=0
  local -a backups=()
  shopt -s nullglob
  for candidate in "$BACKUP_ROOT"/current-release-*; do
    [[ -d "$candidate" && ! -L "$candidate" ]] && backups+=("$candidate")
  done
  shopt -u nullglob
  if [[ "${#backups[@]}" -le 2 ]]; then return; fi
  remove_count=$((${#backups[@]} - 2))
  for candidate in "${backups[@]:0:$remove_count}"; do
    verify_backup "$candidate" >/dev/null || return 1
  done
  for candidate in "${backups[@]:0:$remove_count}"; do
    rm -rf -- "$candidate" || return 1
  done
}

validate_source
[[ -d "$INSTALLED_PLUGIN_DIR" && ! -L "$INSTALLED_PLUGIN_DIR" ]] || {
  printf 'Installed plugin directory is missing or unsafe.\n' >&2
  exit 1
}
installed_version="$(read_version "$INSTALLED_PLUGIN_DIR/package.json")"
BEFORE_CONFIG_SHA="$(shasum -a 256 "$PROFILE_CONFIG" | awk '{print $1}')"
BEFORE_LISTENERS="$(listener_snapshot)"
validate_runtime "$installed_version" "$WORK_ROOT/runtime-before.json" "$WORK_ROOT/catalog-before.json"
BEFORE_MANIFEST_SHA256="$(target_manifest_sha256)" || {
  printf 'Could not capture the pre-install target manifest.\n' >&2
  exit 1
}

if [[ "$MODE" != dry-run ]]; then
  authorize_mutating_invocation
  RESERVATION_TARGET_STATE_SHA256="$(target_manifest_sha256)" || {
    printf 'Could not capture the pre-reservation video-command target state.\n' >&2
    exit 1
  }
  verify_shared_install_gate
  acquire_shared_deployment_lock
  [[ "$(target_manifest_sha256)" == "$RESERVATION_TARGET_STATE_SHA256" ]] || {
    printf 'Video-command target changed between reservation and the locked mutation.\n' >&2
    exit 1
  }
  if [[ "$SHARED_GATE_MODE" == rolling ]]; then
    verify_shared_install_gate
  fi
  if [[ "$MODE" == rollback && "$ROLLBACK_NOOP" == 1 ]]; then
    write_install_result rollback restored "$BEFORE_MANIFEST_SHA256" \
      "$BEFORE_MANIFEST_SHA256" "" "" 0
    printf 'Video-command no-op compensation recorded without changing managed state.\n'
    exit 0
  fi
  if [[ -L "$BACKUP_ROOT" ]]; then
    printf 'Backup root must not be a symlink.\n' >&2
    exit 1
  fi
  if [[ -e "$BACKUP_ROOT" ]]; then
    [[ -d "$BACKUP_ROOT" && "$(stat -f '%Lp' "$BACKUP_ROOT")" == 700 ]] || {
      printf 'Backup root must be a mode-0700 directory.\n' >&2
      exit 1
    }
  else
    install -d -m 700 "$BACKUP_ROOT"
  fi
  acquire_video_local_lock || {
    printf 'Could not acquire or recover the video-command local transaction lock.\n' >&2
    exit 1
  }
  if [[ "$STALE_RECOVERED" == 1 ]]; then
    # A stale journal restores the interrupted transaction's pre-mutation
    # target. Restart this invocation so the restored state receives a fresh
    # target digest and shared-gate authorization; the digest captured from
    # the partial target on entry must never be reused after recovery.
    release_shared_deployment_lock
    trap - EXIT HUP INT TERM
    rm -rf -- "$WORK_ROOT"
    exec bash "$0" "${ORIGINAL_ARGUMENTS[@]}"
  fi
  [[ "$(target_manifest_sha256)" == "$RESERVATION_TARGET_STATE_SHA256" ]] || {
    printf 'Video-command target changed before the locally locked mutation.\n' >&2
    exit 1
  }
fi

if [[ "$MODE" == "rollback" ]]; then
  verify_backup "$ROLLBACK_BACKUP" >/dev/null || {
    printf 'Rollback backup is not a verified current-release recovery point.\n' >&2
    exit 1
  }
  capture_rollback_source_identities "$ROLLBACK_BACKUP" || {
    printf 'Rollback backup identities could not be bound.\n' >&2
    exit 1
  }
  if [[ "$TEST_FAILPOINT" == rollback-source-before-claim ]]; then
    wait_for_test_barrier rollback-source-ready rollback-source-continue \
      'rollback source private claim'
  fi
  claim_rollback_source "$ROLLBACK_BACKUP" || {
    printf 'Rollback backup changed before its private source claim.\n' >&2
    exit 1
  }
  metadata="$(verify_backup "$ROLLBACK_BACKUP" "$ROLLBACK_SOURCE_CLAIM_ROOT")" || {
    printf 'Claimed rollback backup failed bound manifest verification.\n' >&2
    exit 1
  }
  previous_version="$(printf '%s' "$metadata" | awk -F '\t' '{print $1}')"
  candidate_version="$(printf '%s' "$metadata" | awk -F '\t' '{print $2}')"
  rollback_manifest_digest="$ROLLBACK_SOURCE_MANIFEST_SHA256"
  if [[ "$installed_version" == "$previous_version" ]]; then
    validate_runtime_payload_matches "$ROLLBACK_BACKUP/previous-plugin"
    [[ "$(shasum -a 256 "$PROFILE_CONFIG" | awk '{print $1}')" \
      == "$(printf '%s' "$metadata" | awk -F '\t' '{print $3}')" ]] || {
      printf 'Installed rollback version does not match the verified backup state.\n' >&2
      exit 1
    }
    after_manifest_sha256="$(target_manifest_sha256)" || exit 1
    [[ "$after_manifest_sha256" == "$BEFORE_MANIFEST_SHA256" ]] || exit 1
    release_rollback_source_claim || {
      printf 'Rollback backup claim could not be restored.\n' >&2
      exit 1
    }
    verify_backup "$ROLLBACK_RESULT_BACKUP" >/dev/null || exit 1
    write_install_result rollback restored "$BEFORE_MANIFEST_SHA256" \
      "$after_manifest_sha256" "$ROLLBACK_RESULT_BACKUP" "$rollback_manifest_digest" \
      "$DEFER_GATEWAY_RESTART"
    printf 'qwen-current already matches the explicit verified rollback backup.\n'
    exit 0
  fi
  [[ "$installed_version" == "$candidate_version" ]] || {
    printf 'Installed version does not match the rollback backup candidate.\n' >&2
    exit 1
  }
  create_safety_backup "$installed_version" "$previous_version"
  safety_manifest_digest="$(shasum -a 256 "$BACKUP_DIR/MANIFEST.sha256" | awk '{print $1}')"
  write_video_journal "$BACKUP_DIR" "$safety_manifest_digest"
  restore_backup "$ROLLBACK_BACKUP" "$DEFER_GATEWAY_RESTART"
  verify_backup "$ROLLBACK_BACKUP" "$ROLLBACK_SOURCE_CLAIM_ROOT" >/dev/null || {
    printf 'Claimed rollback backup changed after restoration.\n' >&2
    exit 1
  }
  after_manifest_sha256="$(target_manifest_sha256)" || exit 1
  release_rollback_source_claim || {
    printf 'Rollback backup claim could not be restored.\n' >&2
    exit 1
  }
  verify_backup "$ROLLBACK_RESULT_BACKUP" >/dev/null || {
    printf 'Rollback backup changed after releasing its private claim.\n' >&2
    exit 1
  }
  write_install_result rollback restored "$BEFORE_MANIFEST_SHA256" \
    "$after_manifest_sha256" "$ROLLBACK_RESULT_BACKUP" "$rollback_manifest_digest" \
    "$DEFER_GATEWAY_RESTART"
  mark_video_journal_complete "$after_manifest_sha256"
  printf 'Rolled back qwen-current from %s to %s using the explicit verified backup.\n' \
    "$candidate_version" "$(printf '%s' "$metadata" | awk -F '\t' '{print $1}')"
  exit 0
fi

if [[ "$installed_version" == "$CURRENT_VERSION" ]]; then
  [[ "$LEGACY_SENDER_HASH_PRESENT" == "0" ]] || {
    printf 'Current plugin config still contains the retired sender hash.\n' >&2
    exit 1
  }
  validate_runtime_payload_matches "$PLUGIN_DIR"
  after_manifest_sha256="$(target_manifest_sha256)" || exit 1
  [[ "$after_manifest_sha256" == "$BEFORE_MANIFEST_SHA256" ]] || {
    printf 'Current installation changed during no-op validation.\n' >&2
    exit 1
  }
  write_install_result apply noop "$BEFORE_MANIFEST_SHA256" \
    "$after_manifest_sha256" "" "" 0
  printf 'Current plugin %s is already installed and passed runtime validation.\n' "$CURRENT_VERSION"
  printf 'No plugin, config, gateway, queue, n8n, media, database, or scheduler state changed.\n'
  exit 0
fi
is_supported_previous_version "$installed_version" || {
  printf 'Unsupported installed plugin version: %s\n' "$installed_version" >&2
  exit 1
}

if [[ "$MODE" == "dry-run" ]]; then
  printf 'Current plugin release dry-run passed for %s -> %s at %s.\n' \
    "$installed_version" "$CURRENT_VERSION" "$TARGET_SHA"
  printf 'No plugin, config, gateway, queue, n8n, media, database, or scheduler state changed.\n'
  exit 0
fi

create_safety_backup "$installed_version" "$CURRENT_VERSION"

MIGRATED_CONFIG="$WORK_ROOT/openclaw-migrated.json"
migration_failed=0
if ! node - "$BACKUP_DIR/openclaw.json" "$MIGRATED_CONFIG" "$PLUGIN_ID" <<'NODE'
const fs = require('node:fs')
const [beforePath, outputPath, pluginId] = process.argv.slice(2)
const config = JSON.parse(fs.readFileSync(beforePath, 'utf8'))
const pluginConfig = config?.plugins?.entries?.[pluginId]?.config
if (!pluginConfig || typeof pluginConfig !== 'object' || Array.isArray(pluginConfig)) process.exit(1)
delete pluginConfig.allowedSenderSha256
fs.writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
NODE
then
  migration_failed=1
fi
if [[ "$migration_failed" -eq 0 ]]; then
  validate_config_migration "$BACKUP_DIR/openclaw.json" "$MIGRATED_CONFIG" || migration_failed=1
fi
if [[ "$migration_failed" -eq 0 ]]; then
  MIGRATED_CONFIG_SHA="$(shasum -a 256 "$MIGRATED_CONFIG" | awk '{print $1}')" || migration_failed=1
fi
if [[ "$migration_failed" -ne 0 ]]; then
  printf 'Could not build the offline config migration; live plugin, config, and Gateway were not changed.\n' >&2
  exit 1
fi

safety_manifest_digest="$(shasum -a 256 "$BACKUP_DIR/MANIFEST.sha256" | awk '{print $1}')"
write_video_journal "$BACKUP_DIR" "$safety_manifest_digest"
apply_failed=0
install -m 600 "$MIGRATED_CONFIG" "$PROFILE_CONFIG" || apply_failed=1
if [[ "$apply_failed" -eq 0 && "$TEST_FAILPOINT" == sigkill-after-first-mutation ]]; then
  wait_for_test_barrier sigkill-ready sigkill-continue 'SIGKILL after first apply mutation'
fi
if [[ "$apply_failed" -eq 0 ]]; then
  validate_config_migration "$BACKUP_DIR/openclaw.json" "$PROFILE_CONFIG" || apply_failed=1
fi
if [[ "$apply_failed" -eq 0 ]]; then
  run_qwen_openclaw plugins install --force "$PLUGIN_DIR" > "$WORK_ROOT/install-current.txt" 2>&1 || apply_failed=1
fi
if [[ "$apply_failed" -eq 0 ]]; then
  install -m 600 "$MIGRATED_CONFIG" "$PROFILE_CONFIG" || apply_failed=1
fi
if [[ "$apply_failed" -eq 0 && "$DEFER_GATEWAY_RESTART" == 0 ]]; then
  run_qwen_openclaw gateway restart --wait 60s --json > "$WORK_ROOT/gateway-restart.json" || apply_failed=1
fi
if [[ "$apply_failed" -eq 0 ]]; then
  validate_installed_version "$CURRENT_VERSION" || apply_failed=1
  validate_runtime_payload_matches "$PLUGIN_DIR" || apply_failed=1
  if [[ "$DEFER_GATEWAY_RESTART" == 0 ]]; then
    validate_runtime "$CURRENT_VERSION" "$WORK_ROOT/runtime-current.json" "$WORK_ROOT/catalog-current.json" || apply_failed=1
  fi
  [[ "$(shasum -a 256 "$PROFILE_CONFIG" | awk '{print $1}')" == "$MIGRATED_CONFIG_SHA" ]] || apply_failed=1
  validate_config_migration "$BACKUP_DIR/openclaw.json" "$PROFILE_CONFIG" || apply_failed=1
  [[ "$(listener_snapshot)" == "$BEFORE_LISTENERS" ]] || apply_failed=1
fi
if [[ "$apply_failed" -ne 0 ]]; then
  if ! restore_backup "$BACKUP_DIR" "$DEFER_GATEWAY_RESTART"; then
    printf 'ROLLBACK FAILED: qwen-current requires manual inspection. Backup: %s\n' "$BACKUP_DIR" >&2
    exit 70
  fi
  printf 'Current plugin install failed; exact %s plugin and config were restored.\n' "$installed_version" >&2
  exit 1
fi

if ! enforce_retention; then
  if ! restore_backup "$BACKUP_DIR" "$DEFER_GATEWAY_RESTART"; then
    printf 'ROLLBACK FAILED after backup-retention error. Backup: %s\n' "$BACKUP_DIR" >&2
    exit 70
  fi
  printf 'Backup retention failed; exact %s plugin and config were restored.\n' "$installed_version" >&2
  exit 1
fi
verify_backup "$BACKUP_DIR" >/dev/null || {
  printf 'Verified rollback point changed before result finalization.\n' >&2
  exit 1
}
backup_manifest_digest="$(shasum -a 256 "$BACKUP_DIR/MANIFEST.sha256" | awk '{print $1}')"
after_manifest_sha256="$(target_manifest_sha256)" || exit 1
write_install_result apply applied "$BEFORE_MANIFEST_SHA256" \
  "$after_manifest_sha256" "$BACKUP_DIR" "$backup_manifest_digest" \
  "$DEFER_GATEWAY_RESTART"
mark_video_journal_complete "$after_manifest_sha256"
printf 'Installed the single current qwen-current plugin chain: %s -> %s at %s.\n' \
  "$installed_version" "$CURRENT_VERSION" "$TARGET_SHA"
printf 'Only the retired sender hash, plugin payload, and qwen-current Gateway changed; queue, n8n, media, database, and scheduler state were preserved.\n'
printf 'Verified rollback point: %s\n' "$BACKUP_DIR"
