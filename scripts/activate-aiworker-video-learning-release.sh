#!/usr/bin/env bash
set -euo pipefail
umask 077

PROFILE="qwen-current"
PLUGIN_ID="aiworker-video-command"
AGENT_ID="second-original"
TARGET_VERSION="0.5.0"
OPENCLAW_VERSION="2026.7.1-2"
EXPECTED_USER="${AIWORKER_EXPECTED_USER:-heisenbergs-1}"
EXPECTED_HOST="${AIWORKER_EXPECTED_HOST:-HEISENBERGS-1deMac-Studio.local}"

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
PLUGIN_DIR="$REPOSITORY_ROOT/openclaw-plugins/$PLUGIN_ID"
STATUS_VALIDATOR="$REPOSITORY_ROOT/scripts/validate-aiworker-video-status-upgrade.mjs"
PLUGIN_VALIDATOR="$REPOSITORY_ROOT/scripts/validate-aiworker-video-command-upgrade.mjs"
LANE_INSTALLER="$REPOSITORY_ROOT/scripts/install-aiworker-video-lane-supervisor.sh"
PROFILE_CONFIG="$HOME/.openclaw-qwen-current/openclaw.json"

MODE=""
TARGET_SHA=""
WORK_ROOT=""
CONFIG_CHANGED=0
RECOVERY_FAILED=0

usage() {
  printf 'Usage: %s (--dry-run|--apply) --target-sha <40-lowercase-hex>\n' "$0"
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --dry-run|--apply)
      [[ -z "$MODE" ]] || { usage >&2; exit 2; }
      MODE="${1#--}"
      shift
      ;;
    --target-sha)
      [[ -z "$TARGET_SHA" && "$#" -ge 2 ]] || { usage >&2; exit 2; }
      TARGET_SHA="$2"
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

[[ -n "$MODE" && "$TARGET_SHA" =~ ^[a-f0-9]{40}$ ]] || { usage >&2; exit 2; }

for command_name in awk chmod cmp env git hostname id install lsof mkdir mktemp node openclaw rm shasum; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf 'Required command is unavailable: %s\n' "$command_name" >&2
    exit 1
  }
done

run_clean_openclaw() {
  env -u OPENCLAW_PROFILE -u OPENCLAW_STATE_DIR -u OPENCLAW_CONFIG_PATH \
    -u OPENCLAW_HOME -u OPENCLAW_INCLUDE_ROOTS openclaw "$@"
}

run_qwen_openclaw() {
  run_clean_openclaw --profile "$PROFILE" "$@"
}

listener_snapshot() {
  local port pids
  for port in 3017 5678 5679 18091 18789 18989; do
    pids="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t | LC_ALL=C sort -u | tr '\n' ',')" || return 1
    [[ -n "$pids" ]] || {
      printf 'Protected listener %s is missing.\n' "$port" >&2
      return 1
    }
    printf '%s=%s\n' "$port" "$pids"
  done
}

validate_git_target() {
  local remote_url branch head origin_main live_record
  remote_url="$(git -C "$REPOSITORY_ROOT" remote get-url origin)" || return 1
  case "$remote_url" in
    https://github.com/MAKingljx/video-autoworker|https://github.com/MAKingljx/video-autoworker.git|git@github.com:MAKingljx/video-autoworker.git) ;;
    *) printf 'Canonical Git remote mismatch.\n' >&2; return 1 ;;
  esac
  branch="$(git -C "$REPOSITORY_ROOT" symbolic-ref --short -q HEAD)" || return 1
  [[ "$branch" == "main" ]] || { printf 'Canonical checkout must be on main.\n' >&2; return 1; }
  [[ -z "$(git -C "$REPOSITORY_ROOT" status --porcelain --untracked-files=normal)" ]] || {
    printf 'Canonical checkout must be clean.\n' >&2
    return 1
  }
  head="$(git -C "$REPOSITORY_ROOT" rev-parse --verify 'HEAD^{commit}')" || return 1
  origin_main="$(git -C "$REPOSITORY_ROOT" rev-parse --verify 'refs/remotes/origin/main^{commit}')" || return 1
  live_record="$(git -C "$REPOSITORY_ROOT" ls-remote --exit-code origin refs/heads/main)" || return 1
  [[ "$live_record" =~ ^([a-f0-9]{40})[[:space:]]+refs/heads/main$ ]] || {
    printf 'GitHub main evidence is malformed or ambiguous.\n' >&2
    return 1
  }
  [[ "$head" == "$TARGET_SHA" && "$origin_main" == "$TARGET_SHA" && "${BASH_REMATCH[1]}" == "$TARGET_SHA" ]] || {
    printf 'HEAD, local origin/main, live GitHub main, and target SHA must match.\n' >&2
    return 1
  }
}

validate_candidate_state() {
  local package_version manifest_version
  [[ "$(id -un)" == "$EXPECTED_USER" && "$(hostname)" == "$EXPECTED_HOST" ]] || {
    printf 'Refusing non-production identity.\n' >&2
    return 1
  }
  case "$(run_clean_openclaw --version)" in
    "OpenClaw $OPENCLAW_VERSION ("*")") ;;
    *) printf 'Unsupported OpenClaw version.\n' >&2; return 1 ;;
  esac
  validate_git_target || return 1
  [[ -f "$PROFILE_CONFIG" && ! -L "$PROFILE_CONFIG" ]] || {
    printf 'qwen-current config is unsafe.\n' >&2
    return 1
  }
  package_version="$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$PLUGIN_DIR/package.json")"
  manifest_version="$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$PLUGIN_DIR/openclaw.plugin.json")"
  [[ "$package_version" == "$TARGET_VERSION" && "$manifest_version" == "$TARGET_VERSION" ]] || {
    printf 'Canonical plugin source is not the expected 0.5.0 release.\n' >&2
    return 1
  }
  node "$STATUS_VALIDATOR" classifier-config "$PROFILE_CONFIG" candidate "$PLUGIN_ID" "$AGENT_ID" >/dev/null || return 1
  run_qwen_openclaw gateway status --deep --require-rpc --json > "$WORK_ROOT/gateway-before.json" || return 1
  run_qwen_openclaw plugins inspect "$PLUGIN_ID" --runtime --json > "$WORK_ROOT/runtime-before.json" || return 1
  node "$PLUGIN_VALIDATOR" runtime-hook-only "$WORK_ROOT/runtime-before.json" \
    "$PLUGIN_ID" "$TARGET_VERSION" aiworker_analyze_video >/dev/null || return 1
  bash "$LANE_INSTALLER" --dry-run >/dev/null || return 1
}

recover_closed_gate() {
  local failed=0
  [[ "$CONFIG_CHANGED" == "1" ]] || return 0
  set +e
  install -m 600 "$WORK_ROOT/candidate-openclaw.json" "$PROFILE_CONFIG" || failed=1
  cmp -s "$WORK_ROOT/candidate-openclaw.json" "$PROFILE_CONFIG" || failed=1
  run_qwen_openclaw gateway restart --wait 60s --json > "$WORK_ROOT/recovery-restart.json" 2>&1 || failed=1
  run_qwen_openclaw gateway status --deep --require-rpc --json > "$WORK_ROOT/recovery-status.json" 2>&1 || failed=1
  node "$STATUS_VALIDATOR" classifier-config "$PROFILE_CONFIG" candidate "$PLUGIN_ID" "$AGENT_ID" \
    > "$WORK_ROOT/recovery-config.json" 2>&1 || failed=1
  if [[ "$failed" -ne 0 ]]; then
    printf 'RECOVERY FAILED: the release gate may require manual inspection.\n' >&2
    RECOVERY_FAILED=1
  else
    printf 'Activation failed; the 0.5 release gate was restored to closed.\n' >&2
  fi
  set -e
  return "$failed"
}

finish() {
  local status=$?
  trap - EXIT HUP INT TERM
  if [[ "$status" -ne 0 ]]; then recover_closed_gate || status=70; fi
  if [[ -n "$WORK_ROOT" && "$RECOVERY_FAILED" == "0" ]]; then
    case "$WORK_ROOT" in
      /tmp/aiworker-video-release-activation.*|/private/tmp/aiworker-video-release-activation.*)
        rm -rf -- "$WORK_ROOT" || status=70
        ;;
      *)
        printf 'Refusing unexpected temporary cleanup path.\n' >&2
        status=70
        ;;
    esac
  fi
  exit "$status"
}

WORK_ROOT="$(mktemp -d /tmp/aiworker-video-release-activation.XXXXXX)"
WORK_ROOT="$(cd "$WORK_ROOT" && pwd -P)"
chmod 700 "$WORK_ROOT"
trap finish EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

protected_before="$(listener_snapshot)"
validate_candidate_state
[[ "$(listener_snapshot)" == "$protected_before" ]] || {
  printf 'Preflight changed a protected listener.\n' >&2
  exit 1
}

if [[ "$MODE" == "dry-run" ]]; then
  printf 'Video-learning release activation dry-run passed at %s.\n' "$TARGET_SHA"
  printf 'The 0.5 release gate remains closed; no profile, lane, queue, media, n8n, or listener changed.\n'
  exit 0
fi

install -m 600 "$PROFILE_CONFIG" "$WORK_ROOT/candidate-openclaw.json"
node "$STATUS_VALIDATOR" classifier-config-active "$WORK_ROOT/candidate-openclaw.json" "$PLUGIN_ID" \
  > "$WORK_ROOT/active-openclaw.json"
chmod 600 "$WORK_ROOT/active-openclaw.json"
run_qwen_openclaw config set "plugins.entries.$PLUGIN_ID.config.releaseReady" true --strict-json \
  > "$WORK_ROOT/config-set-release-ready.txt"
install -m 600 "$WORK_ROOT/active-openclaw.json" "$PROFILE_CONFIG"
cmp -s "$WORK_ROOT/active-openclaw.json" "$PROFILE_CONFIG"
CONFIG_CHANGED=1
run_qwen_openclaw gateway restart --wait 60s --json > "$WORK_ROOT/gateway-restart.json"
run_qwen_openclaw gateway status --deep --require-rpc --json > "$WORK_ROOT/gateway-after.json"
node "$STATUS_VALIDATOR" classifier-config "$PROFILE_CONFIG" active "$PLUGIN_ID" "$AGENT_ID" \
  > "$WORK_ROOT/active-config.json"
run_qwen_openclaw plugins inspect "$PLUGIN_ID" --runtime --json > "$WORK_ROOT/runtime-after.json"
node "$PLUGIN_VALIDATOR" runtime-hook-only "$WORK_ROOT/runtime-after.json" \
  "$PLUGIN_ID" "$TARGET_VERSION" aiworker_analyze_video >/dev/null
bash "$LANE_INSTALLER" --dry-run >/dev/null
[[ "$(listener_snapshot)" == "$protected_before" ]] || {
  printf 'A protected listener changed during activation.\n' >&2
  exit 1
}
CONFIG_CHANGED=0

printf 'Activated the 0.5 video-learning release at approved target %s.\n' "$TARGET_SHA"
printf 'The release gate is open; task-flow, global lane, Qwen runtime, and protected listeners were verified.\n'
printf 'No task, n8n execution, media file, or database record was created by activation.\n'
