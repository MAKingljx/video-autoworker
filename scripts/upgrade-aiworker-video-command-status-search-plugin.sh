#!/usr/bin/env bash
set -euo pipefail
umask 077

PROFILE="qwen-current"
PLUGIN_ID="aiworker-video-command"
PREVIOUS_VERSION="0.5.0"
CANDIDATE_VERSION="0.5.1"
OPENCLAW_VERSION="2026.7.1-2"
EXPECTED_USER="heisenbergs-1"
EXPECTED_HOST="HEISENBERGS-1deMac-Studio.local"

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
PLUGIN_DIR="$REPOSITORY_ROOT/openclaw-plugins/$PLUGIN_ID"
RUNTIME_VALIDATOR="$REPOSITORY_ROOT/scripts/validate-aiworker-video-command-upgrade.mjs"
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
  printf 'Usage: %s (--dry-run|--apply|--rollback) --target-sha <40-lowercase-hex-sha> [--backup <absolute-status-search-upgrade-backup>]\n' "$0"
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
if [[ "$MODE" == "rollback" && -z "$ROLLBACK_BACKUP" ]]; then
  printf 'Rollback requires --backup.\n' >&2
  exit 2
fi

for command_name in awk chmod cmp cp date env git hostname id install lsof mkdir mktemp node openclaw rm shasum sort tr; do
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
      /tmp/aiworker-video-status-search-upgrade.*|/private/tmp/aiworker-video-status-search-upgrade.*)
        rm -rf -- "$WORK_ROOT"
        ;;
      *) printf 'Refusing unexpected temporary cleanup path.\n' >&2; status=70 ;;
    esac
  fi
  exit "$status"
}

WORK_ROOT="$(mktemp -d /tmp/aiworker-video-status-search-upgrade.XXXXXX)"
chmod 700 "$WORK_ROOT"
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

fingerprint_tree() {
  node - "$1" <<'NODE'
const { createHash } = require('node:crypto')
const { lstatSync, readFileSync, readlinkSync, readdirSync } = require('node:fs')
const { join } = require('node:path')
const root = process.argv[2]
const hash = createHash('sha256')
function visit(pathname, relative) {
  const stat = lstatSync(pathname)
  hash.update(`${relative}\0${stat.mode & 0o7777}\0${stat.size}\0`)
  if (stat.isSymbolicLink()) {
    hash.update(`link\0${readlinkSync(pathname)}\0`)
  } else if (stat.isFile()) {
    hash.update('file\0').update(readFileSync(pathname)).update('\0')
  } else if (stat.isDirectory()) {
    hash.update('dir\0')
    for (const name of readdirSync(pathname).sort()) visit(join(pathname, name), relative === '.' ? name : `${relative}/${name}`)
  } else throw new Error(`unsupported filesystem object: ${relative}`)
}
visit(root, '.')
process.stdout.write(`${hash.digest('hex')}\n`)
NODE
}

read_version() {
  node -e 'process.stdout.write(require(process.argv[1]).version || "")' "$1"
}

listener_snapshot() {
  local port pids
  for port in 3017 5678 5679 18091 18789 18989; do
    pids="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t | LC_ALL=C sort -u | tr '\n' ',')"
    [[ -n "$pids" ]] || { printf 'Protected listener %s is missing.\n' "$port" >&2; return 1; }
    printf '%s=%s\n' "$port" "$pids"
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
    printf 'HEAD, local origin/main, live GitHub main, and target SHA must match.\n' >&2
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
  [[ -f "$PROFILE_CONFIG" && ! -L "$PROFILE_CONFIG" ]] || { printf 'qwen-current config is unsafe.\n' >&2; return 1; }
  [[ -d "$PLUGIN_DIR" && ! -L "$PLUGIN_DIR" ]] || { printf 'Canonical plugin source is unsafe.\n' >&2; return 1; }
  [[ "$(read_version "$PLUGIN_DIR/package.json")" == "$CANDIDATE_VERSION" ]] || return 1
  [[ "$(read_version "$PLUGIN_DIR/openclaw.plugin.json")" == "$CANDIDATE_VERSION" ]] || return 1
  node - "$PROFILE_CONFIG" <<'NODE'
const fs = require('node:fs')
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const entry = config?.plugins?.entries?.['aiworker-video-command']
if (!entry || entry.config?.releaseReady !== true || entry.llm?.allowAgentIdOverride !== true) process.exit(1)
NODE
}

validate_installed_version() {
  local expected="$1"
  [[ -d "$INSTALLED_PLUGIN_DIR" && ! -L "$INSTALLED_PLUGIN_DIR" ]] || return 1
  [[ "$(read_version "$INSTALLED_PLUGIN_DIR/package.json")" == "$expected" ]] || return 1
}

validate_runtime() {
  local expected="$1" report="$2"
  run_qwen_openclaw plugins inspect "$PLUGIN_ID" --runtime --json > "$report"
  node "$RUNTIME_VALIDATOR" runtime-hook-only "$report" "$PLUGIN_ID" "$expected" aiworker_analyze_video >/dev/null
}

validate_config_unchanged() {
  [[ "$(shasum -a 256 "$PROFILE_CONFIG" | awk '{print $1}')" == "$BEFORE_CONFIG_SHA" ]] || {
    printf 'qwen-current config changed outside the approved payload refresh.\n' >&2
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
  set -e
  if [[ "$failed" -ne 0 ]]; then
    printf 'Automatic rollback failed; inspect the protected qwen-current profile.\n' >&2
    return 1
  fi
  printf 'Candidate failed; exact %s plugin/config restored.\n' "$PREVIOUS_VERSION" >&2
}

enforce_retention() {
  node - "$BACKUP_ROOT" <<'NODE'
const { readdirSync, rmSync, statSync } = require('node:fs')
const { join } = require('node:path')
const root = process.argv[2]
const entries = readdirSync(root)
  .filter(name => /^status-search-upgrade-[0-9]{8}-[0-9]{6}\.[A-Za-z0-9]+$/u.test(name))
  .map(name => ({ name, path: join(root, name), time: statSync(join(root, name)).mtimeMs }))
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
fi
BEFORE_CONFIG_SHA="$(shasum -a 256 "$PROFILE_CONFIG" | awk '{print $1}')"
BEFORE_LISTENERS="$(listener_snapshot)"

if [[ "$MODE" == "dry-run" ]]; then
  validate_runtime "$PREVIOUS_VERSION" "$WORK_ROOT/runtime-before.json"
  printf 'Video status-search upgrade dry-run passed for %s -> %s at %s.\n' "$PREVIOUS_VERSION" "$CANDIDATE_VERSION" "$TARGET_SHA"
  printf 'No plugin, config, gateway, queue, n8n, media, or database state changed.\n'
  exit 0
fi

if [[ "$MODE" == "rollback" ]]; then
  case "$ROLLBACK_BACKUP" in
    "$BACKUP_ROOT"/status-search-upgrade-*) ;;
    *) printf 'Rollback backup is outside the approved status-search family.\n' >&2; exit 1 ;;
  esac
  [[ -d "$ROLLBACK_BACKUP/previous-plugin" && -f "$ROLLBACK_BACKUP/openclaw.json" ]] || {
    printf 'Rollback backup is incomplete.\n' >&2
    exit 1
  }
  BACKUP_DIR="$ROLLBACK_BACKUP"
  run_qwen_openclaw plugins install --force "$BACKUP_DIR/previous-plugin" > "$WORK_ROOT/rollback-install.txt"
  install -m 600 "$BACKUP_DIR/openclaw.json" "$PROFILE_CONFIG"
  run_qwen_openclaw gateway restart --wait 60s --json > "$WORK_ROOT/rollback-restart.json"
  validate_installed_version "$PREVIOUS_VERSION"
  validate_runtime "$PREVIOUS_VERSION" "$WORK_ROOT/runtime-rollback.json"
  [[ "$(listener_snapshot)" == "$BEFORE_LISTENERS" ]] || { printf 'Protected listener drifted during rollback.\n' >&2; exit 1; }
  printf 'Rolled back qwen-current from %s to exact %s.\n' "$CANDIDATE_VERSION" "$PREVIOUS_VERSION"
  exit 0
fi

mkdir -p "$BACKUP_ROOT"
chmod 700 "$BACKUP_ROOT"
BACKUP_DIR="$(mktemp -d "$BACKUP_ROOT/status-search-upgrade-$(date +%Y%m%d-%H%M%S).XXXXXX")"
chmod 700 "$BACKUP_DIR"
install -m 600 "$PROFILE_CONFIG" "$BACKUP_DIR/openclaw.json"
cp -R -p "$INSTALLED_PLUGIN_DIR" "$BACKUP_DIR/previous-plugin"
printf '{"schemaVersion":1,"previousVersion":"%s","candidateVersion":"%s","targetSha":"%s","sourceFingerprint":"%s","previousFingerprint":"%s","configSha256":"%s"}\n' \
  "$PREVIOUS_VERSION" "$CANDIDATE_VERSION" "$TARGET_SHA" \
  "$(fingerprint_tree "$PLUGIN_DIR")" "$(fingerprint_tree "$INSTALLED_PLUGIN_DIR")" "$BEFORE_CONFIG_SHA" \
  > "$BACKUP_DIR/metadata.json"
chmod 600 "$BACKUP_DIR/metadata.json"

if ! run_qwen_openclaw plugins install --force "$PLUGIN_DIR" > "$BACKUP_DIR/install-candidate.txt" 2>&1; then
  restore_previous
  exit 1
fi
install -m 600 "$BACKUP_DIR/openclaw.json" "$PROFILE_CONFIG"
run_qwen_openclaw gateway restart --wait 60s --json > "$BACKUP_DIR/gateway-restart.json"
if ! validate_installed_version "$CANDIDATE_VERSION" \
  || ! validate_runtime "$CANDIDATE_VERSION" "$BACKUP_DIR/runtime-candidate.json" \
  || ! validate_config_unchanged \
  || [[ "$(listener_snapshot)" != "$BEFORE_LISTENERS" ]]; then
  restore_previous
  exit 1
fi
install -m 600 /dev/null "$BACKUP_DIR/.verified"
enforce_retention
printf 'Upgraded qwen-current %s -> %s with status-search support at %s.\n' "$PREVIOUS_VERSION" "$CANDIDATE_VERSION" "$TARGET_SHA"
printf 'Only the qwen-current plugin payload and its gateway were refreshed; config, queue, n8n, media, and database state were preserved.\n'
