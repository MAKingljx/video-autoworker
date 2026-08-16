#!/usr/bin/env bash
set -euo pipefail
umask 077

PROFILE="qwen-current"
PLUGIN_ID="aiworker-video-command"
AGENT_ID="second-original"
TOOL_ID="aiworker_analyze_video"
PREVIOUS_VERSION="0.5.2"
CANDIDATE_VERSION="0.5.3"
OPENCLAW_VERSION="2026.7.1-2"
EXPECTED_USER="heisenbergs-1"
EXPECTED_HOST="HEISENBERGS-1deMac-Studio.local"

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
PLUGIN_DIR="$REPOSITORY_ROOT/openclaw-plugins/$PLUGIN_ID"
RUNTIME_VALIDATOR="$PLUGIN_DIR/scripts/validate-runtime-inspection.mjs"
PROFILE_STATE_DIR="$HOME/.openclaw-qwen-current"
PROFILE_CONFIG="$PROFILE_STATE_DIR/openclaw.json"
INSTALLED_PLUGIN_DIR="$PROFILE_STATE_DIR/extensions/$PLUGIN_ID"
BACKUP_ROOT="$HOME/ai-worker/backups/$PLUGIN_ID"
MODE=""
TARGET_SHA=""
ROLLBACK_BACKUP=""
WORK_ROOT=""
BACKUP_DIR=""
BEFORE_CONFIG_SHA=""
BEFORE_LISTENERS=""

usage() {
  printf 'Usage: %s (--dry-run|--apply|--rollback) --target-sha <40-lowercase-hex-sha> [--backup <absolute-backup>]\n' "$0"
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --dry-run|--apply|--rollback)
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
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
[[ -n "$MODE" && "$TARGET_SHA" =~ ^[a-f0-9]{40}$ ]] || { usage >&2; exit 2; }
[[ "$MODE" != "rollback" || -n "$ROLLBACK_BACKUP" ]] || { usage >&2; exit 2; }

for command_name in awk chmod cmp cp date env git hostname id install lsof mkdir mktemp node openclaw rm shasum; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf 'Required command is unavailable: %s\n' "$command_name" >&2
    exit 1
  }
done

run_qwen_openclaw() {
  env -u OPENCLAW_PROFILE -u OPENCLAW_STATE_DIR -u OPENCLAW_CONFIG_PATH \
    -u OPENCLAW_HOME -u OPENCLAW_INCLUDE_ROOTS \
    openclaw --profile "$PROFILE" "$@"
}

cleanup() {
  local status=$?
  trap - EXIT HUP INT TERM
  if [[ -n "$WORK_ROOT" && -d "$WORK_ROOT" ]]; then
    case "$WORK_ROOT" in
      /tmp/aiworker-task-chain-tool-upgrade.*|/private/tmp/aiworker-task-chain-tool-upgrade.*)
        rm -rf -- "$WORK_ROOT"
        ;;
      *) printf 'Refusing unexpected temporary cleanup path.\n' >&2; status=70 ;;
    esac
  fi
  exit "$status"
}

WORK_ROOT="$(mktemp -d /tmp/aiworker-task-chain-tool-upgrade.XXXXXX)"
chmod 700 "$WORK_ROOT"
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

read_version() {
  node -e 'process.stdout.write(require(process.argv[1]).version || "")' "$1"
}

listener_snapshot() {
  local port
  for port in 3017 5678 5679 18091 18789 18889 18989; do
    # qwen-current is intentionally restarted by this upgrade, so its PID is
    # expected to change. The invariant is that every protected port remains
    # bound after the restart, not that a particular process survives it.
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
    "OpenClaw $OPENCLAW_VERSION ("*")" ) ;;
    *) printf 'Unsupported OpenClaw version.\n' >&2; return 1 ;;
  esac
  validate_git_target
  [[ -f "$PROFILE_CONFIG" && ! -L "$PROFILE_CONFIG" ]] || return 1
  [[ -d "$PLUGIN_DIR" && ! -L "$PLUGIN_DIR" ]] || return 1
  [[ "$(read_version "$PLUGIN_DIR/package.json")" == "$CANDIDATE_VERSION" ]] || return 1
  [[ "$(read_version "$PLUGIN_DIR/openclaw.plugin.json")" == "$CANDIDATE_VERSION" ]] || return 1
  node - "$PROFILE_CONFIG" "$PLUGIN_DIR/openclaw.plugin.json" "$PLUGIN_ID" "$TOOL_ID" <<'NODE'
const fs = require('node:fs')
const [configPath, manifestPath, pluginId, toolId] = process.argv.slice(2)
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const entry = config?.plugins?.entries?.[pluginId]
if (!entry || entry.config?.releaseReady !== true || entry.llm?.allowAgentIdOverride !== true) process.exit(1)
if (JSON.stringify(manifest?.activation?.onCapabilities) !== JSON.stringify(['hook', 'tool'])) process.exit(1)
if (JSON.stringify(manifest?.contracts?.tools) !== JSON.stringify([toolId])) process.exit(1)
if (manifest?.toolMetadata?.[toolId]?.optional !== true) process.exit(1)
NODE
}

validate_installed_version() {
  local expected="$1"
  [[ -d "$INSTALLED_PLUGIN_DIR" && ! -L "$INSTALLED_PLUGIN_DIR" ]] || return 1
  [[ "$(read_version "$INSTALLED_PLUGIN_DIR/package.json")" == "$expected" ]]
}

validate_previous_runtime() {
  local report="$1"
  run_qwen_openclaw plugins inspect "$PLUGIN_ID" --runtime --json > "$report"
  node - "$report" "$PLUGIN_ID" "$PREVIOUS_VERSION" <<'NODE'
const fs = require('node:fs')
const [reportPath, pluginId, version] = process.argv.slice(2)
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
const hooks = (report.typedHooks ?? []).map(item => item?.name).filter(Boolean).sort()
const validHooks = JSON.stringify(hooks) === JSON.stringify(['before_dispatch'])
  || JSON.stringify(hooks) === JSON.stringify(['before_agent_run', 'before_dispatch'].sort())
if (report?.plugin?.id !== pluginId || report?.plugin?.status !== 'loaded' || report?.plugin?.version !== version || !validHooks || !Array.isArray(report.tools) || report.tools.length !== 0) process.exit(1)
NODE
}

validate_candidate_runtime() {
  local report="$1" catalog="$2"
  run_qwen_openclaw gateway status --deep --require-rpc --json > "$WORK_ROOT/gateway-status.json"
  run_qwen_openclaw plugins inspect "$PLUGIN_ID" --runtime --json > "$report"
  node "$RUNTIME_VALIDATOR" "$report" "$PLUGIN_ID" "$CANDIDATE_VERSION"
  run_qwen_openclaw gateway call tools.catalog \
    --params "{\"agentId\":\"$AGENT_ID\",\"includePlugins\":true}" \
    --timeout 20000 --json > "$catalog"
  node - "$catalog" "$PLUGIN_ID" "$AGENT_ID" "$TOOL_ID" <<'NODE'
const fs = require('node:fs')
const [reportPath, pluginId, agentId, toolId] = process.argv.slice(2)
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
const tools = (report?.groups ?? []).flatMap(group => (group?.tools ?? []).map(tool => ({ group, tool })))
  .filter(({ tool }) => tool?.id === toolId)
if (report?.agentId !== agentId || tools.length !== 1) process.exit(1)
const { group, tool } = tools[0]
if (group?.pluginId !== pluginId || group?.source !== 'plugin' || tool?.pluginId !== pluginId || tool?.source !== 'plugin' || tool?.optional !== true) process.exit(1)
NODE
}

validate_config_unchanged() {
  [[ "$(shasum -a 256 "$PROFILE_CONFIG" | awk '{print $1}')" == "$BEFORE_CONFIG_SHA" ]] || {
    printf 'qwen-current config changed outside the approved plugin refresh.\n' >&2
    return 1
  }
}

restore_previous() {
  local failed=0
  set +e
  run_qwen_openclaw plugins install --force "$BACKUP_DIR/previous-plugin" > "$WORK_ROOT/restore-install.txt" 2>&1 || failed=1
  install -m 600 "$BACKUP_DIR/openclaw.json" "$PROFILE_CONFIG" || failed=1
  run_qwen_openclaw gateway restart --wait 60s --json > "$WORK_ROOT/restore-restart.json" 2>&1 || failed=1
  validate_installed_version "$PREVIOUS_VERSION" || failed=1
  validate_previous_runtime "$WORK_ROOT/runtime-restored.json" || failed=1
  set -e
  [[ "$failed" -eq 0 ]] || { printf 'Automatic rollback failed; inspect qwen-current.\n' >&2; return 1; }
  printf 'Candidate failed; exact %s plugin/config restored.\n' "$PREVIOUS_VERSION" >&2
}

enforce_retention() {
  node - "$BACKUP_ROOT" <<'NODE'
const { readdirSync, rmSync, statSync } = require('node:fs')
const { join } = require('node:path')
const root = process.argv[2]
const entries = readdirSync(root)
  .filter(name => /^task-chain-tool-upgrade-[0-9]{8}-[0-9]{6}\.[A-Za-z0-9]+$/u.test(name))
  .map(name => ({ path: join(root, name), time: statSync(join(root, name)).mtimeMs }))
  .filter(entry => statSync(entry.path).isDirectory() && statSync(join(entry.path, '.verified')).isFile())
  .sort((left, right) => right.time - left.time)
for (const entry of entries.slice(2)) rmSync(entry.path, { recursive: true, force: true })
NODE
}

validate_source
if [[ "$MODE" == "rollback" ]]; then
  validate_installed_version "$CANDIDATE_VERSION"
else
  validate_installed_version "$PREVIOUS_VERSION"
  validate_previous_runtime "$WORK_ROOT/runtime-before.json"
fi
BEFORE_CONFIG_SHA="$(shasum -a 256 "$PROFILE_CONFIG" | awk '{print $1}')"
BEFORE_LISTENERS="$(listener_snapshot)"

if [[ "$MODE" == "dry-run" ]]; then
  printf 'Task-chain tool upgrade dry-run passed for %s -> %s at %s.\n' "$PREVIOUS_VERSION" "$CANDIDATE_VERSION" "$TARGET_SHA"
  printf 'No plugin, config, gateway, queue, n8n, media, or database state changed.\n'
  exit 0
fi

if [[ "$MODE" == "rollback" ]]; then
  case "$ROLLBACK_BACKUP" in
    "$BACKUP_ROOT"/task-chain-tool-upgrade-*) ;;
    *) printf 'Rollback backup is outside the approved family.\n' >&2; exit 1 ;;
  esac
  [[ -d "$ROLLBACK_BACKUP/previous-plugin" && -f "$ROLLBACK_BACKUP/openclaw.json" ]] || exit 1
  BACKUP_DIR="$ROLLBACK_BACKUP"
  run_qwen_openclaw plugins install --force "$BACKUP_DIR/previous-plugin" > "$WORK_ROOT/rollback-install.txt"
  install -m 600 "$BACKUP_DIR/openclaw.json" "$PROFILE_CONFIG"
  run_qwen_openclaw gateway restart --wait 60s --json > "$WORK_ROOT/rollback-restart.json"
  validate_installed_version "$PREVIOUS_VERSION"
  validate_previous_runtime "$WORK_ROOT/runtime-rollback.json"
  [[ "$(listener_snapshot)" == "$BEFORE_LISTENERS" ]] || exit 1
  printf 'Rolled back qwen-current from %s to exact %s.\n' "$CANDIDATE_VERSION" "$PREVIOUS_VERSION"
  exit 0
fi

mkdir -p "$BACKUP_ROOT"
chmod 700 "$BACKUP_ROOT"
BACKUP_DIR="$(mktemp -d "$BACKUP_ROOT/task-chain-tool-upgrade-$(date +%Y%m%d-%H%M%S).XXXXXX")"
chmod 700 "$BACKUP_DIR"
install -m 600 "$PROFILE_CONFIG" "$BACKUP_DIR/openclaw.json"
cp -R -p "$INSTALLED_PLUGIN_DIR" "$BACKUP_DIR/previous-plugin"
printf '{"schemaVersion":1,"previousVersion":"%s","candidateVersion":"%s","targetSha":"%s","configSha256":"%s"}\n' \
  "$PREVIOUS_VERSION" "$CANDIDATE_VERSION" "$TARGET_SHA" "$BEFORE_CONFIG_SHA" > "$BACKUP_DIR/metadata.json"
chmod 600 "$BACKUP_DIR/metadata.json"

if ! run_qwen_openclaw plugins install --force "$PLUGIN_DIR" > "$BACKUP_DIR/install-candidate.txt" 2>&1; then
  restore_previous
  exit 1
fi
install -m 600 "$BACKUP_DIR/openclaw.json" "$PROFILE_CONFIG"
run_qwen_openclaw gateway restart --wait 60s --json > "$BACKUP_DIR/gateway-restart.json"
if ! validate_installed_version "$CANDIDATE_VERSION" \
  || ! validate_candidate_runtime "$BACKUP_DIR/runtime-candidate.json" "$BACKUP_DIR/tools-catalog.json" \
  || ! validate_config_unchanged \
  || [[ "$(listener_snapshot)" != "$BEFORE_LISTENERS" ]]; then
  restore_previous
  exit 1
fi
install -m 600 /dev/null "$BACKUP_DIR/.verified"
enforce_retention
printf 'Upgraded qwen-current %s -> %s with direct task-chain tool support at %s.\n' "$PREVIOUS_VERSION" "$CANDIDATE_VERSION" "$TARGET_SHA"
printf 'Only the qwen-current plugin payload and its gateway were refreshed; config, queue, n8n, media, and database state were preserved.\n'
