#!/usr/bin/env bash

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
RUN_DIR="${AIWORKER_BG_RUN_DIR:-$PROJECT_ROOT/.run/blue-green}"
RELEASES_DIR="${AIWORKER_BG_RELEASES_DIR:-$PROJECT_ROOT/.runtime/releases}"
ROUTER_STATE_FILE="${AIWORKER_BG_ROUTER_STATE:-$RUN_DIR/router-state.json}"
PLATFORM_ENV_FILE="${AIWORKER_PLATFORM_ENV_FILE:-$HOME/.config/video-autoworker/platform.env}"
NODE_BIN="${NODE_BIN:-node}"
AUDITOR="$PROJECT_ROOT/scripts/check-standalone-artifact.mjs"
SLOT="${1:-}"
ROLE="${2:-probe}"

case "$SLOT" in
  blue) EXPECTED_PORT="${AIWORKER_BG_BLUE_PORT:-3317}" ;;
  green) EXPECTED_PORT="${AIWORKER_BG_GREEN_PORT:-3417}" ;;
  *) printf 'slot must be blue or green\n' >&2; exit 2 ;;
esac
case "$ROLE" in
  active|probe|drain) ;;
  *) printf 'role must be active, probe or drain\n' >&2; exit 2 ;;
esac

load_env_file() {
  local pathname="$1"
  [[ -e "$pathname" || -L "$pathname" ]] || return 0
  [[ -f "$pathname" && ! -L "$pathname" && -O "$pathname" ]] || {
    printf 'refusing unsafe environment file: %s\n' "$pathname" >&2
    exit 1
  }
  local mode
  mode="$(stat -f '%Lp' "$pathname" 2>/dev/null || stat -c '%a' "$pathname")"
  if [[ "$mode" != 600 ]]; then
    printf 'environment file must have mode 0600: %s\n' "$pathname" >&2
    exit 1
  fi
  set -a
  # shellcheck disable=SC1090
  source "$pathname"
  set +a
}

load_env_file "$PROJECT_ROOT/.env"
load_env_file "$PROJECT_ROOT/.env.local"
load_env_file "$PLATFORM_ENV_FILE"

# A production slot runs on the same host as the managed OpenClaw workspace.
# Keep explicit environment settings available for isolated or remote probes.
export MC_OPENCLAW_PROFILE_TARGET="${MC_OPENCLAW_PROFILE_TARGET:-local}"
export MC_MATERIALS_REMOTE_PYTHON="${MC_MATERIALS_REMOTE_PYTHON:-/usr/bin/python3}"

if [[ -n "${MC_HOSTNAME:-}" && "$MC_HOSTNAME" != "127.0.0.1" ]]; then
  printf 'MC_HOSTNAME must remain 127.0.0.1 for OpenClaw loopback mode\n' >&2
  exit 1
fi
if [[ -n "${MC_AUTH_MODE:-}" && "$MC_AUTH_MODE" != "openclaw-loopback" ]]; then
  printf 'MC_AUTH_MODE must be openclaw-loopback for standalone slots\n' >&2
  exit 1
fi
export MC_AUTH_MODE="openclaw-loopback"
export MC_DESKTOP_MODE="0"
export MC_OPENCLAW_WORKSPACE_ID="${MC_OPENCLAW_WORKSPACE_ID:-1}"
export MC_OPENCLAW_TENANT_ID="${MC_OPENCLAW_TENANT_ID:-1}"

BINDING_FILE="$RUN_DIR/slots/$SLOT.json"
[[ -f "$BINDING_FILE" && ! -L "$BINDING_FILE" ]] || {
  printf 'slot binding is missing or unsafe: %s\n' "$BINDING_FILE" >&2
  exit 1
}

PID_FILE="$RUN_DIR/slots/$SLOT.pid"
ATTESTATION_FILE="$RUN_DIR/slots/$SLOT.runtime.json"
START_LOCK_DIR="$RUN_DIR/slots/.$SLOT.start.lock"
if ! mkdir "$START_LOCK_DIR" 2>/dev/null; then
  printf 'another %s slot startup is already in progress\n' "$SLOT" >&2
  exit 1
fi
chmod 700 "$START_LOCK_DIR"
cleanup_start_lock() {
  rmdir "$START_LOCK_DIR" 2>/dev/null || true
}
trap cleanup_start_lock EXIT

if [[ -L "$PID_FILE" || ( -e "$PID_FILE" && ( ! -f "$PID_FILE" || ! -O "$PID_FILE" ) ) ]]; then
  printf 'slot PID file is unsafe: %s\n' "$PID_FILE" >&2
  exit 1
fi
if [[ -f "$PID_FILE" ]]; then
  EXISTING_PID="$(tr -d '[:space:]' < "$PID_FILE")"
  if [[ "$EXISTING_PID" =~ ^[1-9][0-9]*$ ]] && kill -0 "$EXISTING_PID" 2>/dev/null; then
    printf 'refusing to start %s: recorded PID %s is still alive\n' "$SLOT" "$EXISTING_PID" >&2
    exit 1
  fi
fi

mapfile_values="$($NODE_BIN -e '
  const fs = require("node:fs")
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
  const slot = process.argv[2]
  if (value.schema !== "video-autoworker-standalone-slot/v1" || value.slot !== slot) process.exit(2)
  if (value.host !== "127.0.0.1" || !Number.isInteger(value.port)) process.exit(3)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u.test(value.releaseId)) process.exit(4)
  for (const field of ["releaseId", "releaseRoot", "manifestSha256", "host", "port"]) {
    const item = String(value[field])
    if (!item || item.includes("\n")) process.exit(5)
    process.stdout.write(`${item}\n`)
  }
' "$BINDING_FILE" "$SLOT")" || {
  printf 'slot binding is invalid: %s\n' "$BINDING_FILE" >&2
  exit 1
}

RELEASE_ID="$(printf '%s\n' "$mapfile_values" | sed -n '1p')"
RELEASE_ROOT="$(printf '%s\n' "$mapfile_values" | sed -n '2p')"
EXPECTED_MANIFEST="$(printf '%s\n' "$mapfile_values" | sed -n '3p')"
LISTEN_HOST="$(printf '%s\n' "$mapfile_values" | sed -n '4p')"
PORT="$(printf '%s\n' "$mapfile_values" | sed -n '5p')"
[[ "$PORT" == "$EXPECTED_PORT" ]] || {
  printf 'slot port mismatch: expected %s, binding has %s\n' "$EXPECTED_PORT" "$PORT" >&2
  exit 1
}

PHYSICAL_RELEASES="$($NODE_BIN -e 'process.stdout.write(require("node:fs").realpathSync.native(process.argv[1]))' "$RELEASES_DIR")"
PHYSICAL_ROOT="$($NODE_BIN -e 'process.stdout.write(require("node:fs").realpathSync.native(process.argv[1]))' "$RELEASE_ROOT")"
[[ "$PHYSICAL_ROOT" == "$PHYSICAL_RELEASES/$RELEASE_ID/standalone" ]] || {
  printf 'slot release escaped immutable release root\n' >&2
  exit 1
}
case "$RUN_DIR" in
  "$PHYSICAL_ROOT"|"$PHYSICAL_ROOT"/*)
    printf 'runtime directory must remain outside immutable release\n' >&2
    exit 1
    ;;
esac
[[ -f "$PHYSICAL_ROOT/release-manifest.json" && ! -L "$PHYSICAL_ROOT/release-manifest.json" ]] || {
  printf 'release manifest is missing or unsafe\n' >&2
  exit 1
}
ACTUAL_MANIFEST="$(shasum -a 256 "$PHYSICAL_ROOT/release-manifest.json" | awk '{print $1}')"
[[ "$ACTUAL_MANIFEST" == "$EXPECTED_MANIFEST" ]] || {
  printf 'release manifest digest mismatch\n' >&2
  exit 1
}
"$NODE_BIN" "$AUDITOR" "$PHYSICAL_ROOT" >/dev/null || {
  printf 'standalone artifact integrity verification failed\n' >&2
  exit 1
}

export AIWORKER_SOURCE_APP_DIR="$PROJECT_ROOT"
export AIWORKER_RUNTIME_ROLE="$ROLE"
export AIWORKER_RELEASE_ID="$RELEASE_ID"
export AIWORKER_SLOT="$SLOT"
export PORT HOSTNAME="$LISTEN_HOST"
export AIWORKER_N8N_NODE_CALLBACK_URL="http://$LISTEN_HOST:$PORT/api/n8n/node-execute"
export AIWORKER_N8N_MEDIA_CALLBACK_URL="http://$LISTEN_HOST:$PORT/api/n8n/media-execute"
export AIWORKER_N8N_CLAIM_CALLBACK_URL="http://$LISTEN_HOST:$PORT/api/n8n/claim"

# Probe is only for an isolated online-backup copy. A live-DB candidate must be
# started as `active`; the shared scheduler leader lease keeps it passive until
# leadership transfers. A drain slot keeps callbacks available but may not run
# background dispatch.
if [[ "$ROLE" == probe ]]; then
  PROBE_DATA_DIR="${AIWORKER_BG_PROBE_DATA_DIR:-}"
  [[ "$PROBE_DATA_DIR" == /* ]] || {
    printf 'probe role requires absolute AIWORKER_BG_PROBE_DATA_DIR\n' >&2
    exit 1
  }
  export MISSION_CONTROL_DATA_DIR="$PROBE_DATA_DIR"
  export MISSION_CONTROL_DB_PATH="$PROBE_DATA_DIR/mission-control.db"
  export MISSION_CONTROL_TOKENS_PATH="$PROBE_DATA_DIR/mission-control-tokens.json"
  [[ -s "$MISSION_CONTROL_DB_PATH" && ! -L "$MISSION_CONTROL_DB_PATH" ]] || {
    printf 'probe role requires a non-empty, non-symlink SQLite snapshot\n' >&2
    exit 1
  }
  export MISSION_CONTROL_TEST_MODE=1
elif [[ "$ROLE" == drain ]]; then
  export AIWORKER_DISABLE_SCHEDULER=1
fi

export MISSION_CONTROL_DATA_DIR="${MISSION_CONTROL_DATA_DIR:-$PROJECT_ROOT/.data}"
export MISSION_CONTROL_DB_PATH="${MISSION_CONTROL_DB_PATH:-$MISSION_CONTROL_DATA_DIR/mission-control.db}"
export MISSION_CONTROL_TOKENS_PATH="${MISSION_CONTROL_TOKENS_PATH:-$MISSION_CONTROL_DATA_DIR/mission-control-tokens.json}"
for runtime_path in "$MISSION_CONTROL_DATA_DIR" "$MISSION_CONTROL_DB_PATH" "$MISSION_CONTROL_TOKENS_PATH"; do
  [[ "$runtime_path" == /* && "$runtime_path" != *[$'\r\n']* ]] || {
    printf 'runtime data paths must be absolute: %s\n' "$runtime_path" >&2
    exit 1
  }
  case "$runtime_path" in
    "$PHYSICAL_ROOT"|"$PHYSICAL_ROOT"/*)
      printf 'runtime data must remain outside immutable release: %s\n' "$runtime_path" >&2
      exit 1
      ;;
  esac
done

mkdir -p "$RUN_DIR/slots" "$MISSION_CONTROL_DATA_DIR" "$(dirname "$MISSION_CONTROL_DB_PATH")" \
  "$(dirname "$MISSION_CONTROL_TOKENS_PATH")"
chmod 700 "$RUN_DIR" "$RUN_DIR/slots"
resolve_physical_path() {
  "$NODE_BIN" -e '
    const fs = require("node:fs")
    const path = require("node:path")
    let cursor = path.resolve(process.argv[1])
    const suffix = []
    while (!fs.existsSync(cursor)) {
      const parent = path.dirname(cursor)
      if (parent === cursor) process.exit(2)
      suffix.unshift(path.basename(cursor))
      cursor = parent
    }
    process.stdout.write(path.resolve(fs.realpathSync.native(cursor), ...suffix))
  ' "$1"
}
for runtime_path in "$RUN_DIR" "$MISSION_CONTROL_DATA_DIR" "$MISSION_CONTROL_DB_PATH" "$MISSION_CONTROL_TOKENS_PATH"; do
  physical_runtime_path="$(resolve_physical_path "$runtime_path")" || {
    printf 'unable to resolve runtime path: %s\n' "$runtime_path" >&2
    exit 1
  }
  case "$physical_runtime_path" in
    "$PHYSICAL_ROOT"|"$PHYSICAL_ROOT"/*)
      printf 'physical runtime path enters immutable release: %s\n' "$runtime_path" >&2
      exit 1
      ;;
  esac
done
export AIWORKER_RUN_DIR="$RUN_DIR/slots"
export AIWORKER_N8N_CALLBACK_FREEZE_FILE="$RUN_DIR/slots/$SLOT.callbacks-frozen.json"
PHYSICAL_ROUTER_STATE_PATH="$(resolve_physical_path "$ROUTER_STATE_FILE")" || {
  printf 'unable to resolve router state path: %s\n' "$ROUTER_STATE_FILE" >&2
  exit 1
}
export AIWORKER_BG_ROUTER_STATE="$PHYSICAL_ROUTER_STATE_PATH"
PHYSICAL_DB_PATH="$(resolve_physical_path "$MISSION_CONTROL_DB_PATH")" || {
  printf 'unable to resolve runtime database path: %s\n' "$MISSION_CONTROL_DB_PATH" >&2
  exit 1
}

"$NODE_BIN" - "$ATTESTATION_FILE" "$$" "$SLOT" "$ROLE" "$RELEASE_ID" \
  "$EXPECTED_MANIFEST" "$LISTEN_HOST" "$PORT" "$PHYSICAL_DB_PATH" \
  "$PHYSICAL_ROUTER_STATE_PATH" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const [target, rawPid, slot, role, releaseId, manifestSha256, host, rawPort, dbPath, routerStatePath] = process.argv.slice(2)
const pid = Number(rawPid)
const port = Number(rawPort)
if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('runtime attestation PID is invalid')
if (!['blue', 'green'].includes(slot) || !['active', 'probe', 'drain'].includes(role)) {
  throw new Error('runtime attestation slot role is invalid')
}
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u.test(releaseId)) {
  throw new Error('runtime attestation release is invalid')
}
if (!/^[a-f0-9]{64}$/u.test(manifestSha256) || host !== '127.0.0.1'
  || !Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('runtime attestation binding is invalid')
}
if (!path.isAbsolute(dbPath) || /[\r\n]/u.test(dbPath)) {
  throw new Error('runtime attestation database path is invalid')
}
if (!path.isAbsolute(routerStatePath) || /[\r\n]/u.test(routerStatePath)) {
  throw new Error('runtime attestation router state path is invalid')
}
const payload = {
  schema: 'video-autoworker-standalone-runtime/v1',
  pid,
  slot,
  role,
  releaseId,
  manifestSha256,
  host,
  port,
  dbPath,
  routerStatePath,
  createdAt: new Date().toISOString(),
}
const temporary = `${target}.tmp.${pid}.${Date.now()}`
let descriptor
try {
  descriptor = fs.openSync(temporary, 'wx', 0o600)
  fs.writeFileSync(descriptor, `${JSON.stringify(payload)}\n`, 'utf8')
  fs.fsyncSync(descriptor)
  fs.closeSync(descriptor)
  descriptor = undefined
  fs.renameSync(temporary, target)
  const directoryDescriptor = fs.openSync(path.dirname(target), 'r')
  try { fs.fsyncSync(directoryDescriptor) } finally { fs.closeSync(directoryDescriptor) }
} finally {
  if (descriptor !== undefined) fs.closeSync(descriptor)
  try { fs.unlinkSync(temporary) } catch {}
}
NODE
chmod 600 "$ATTESTATION_FILE"

PID_TEMP="$PID_FILE.tmp.$$"
printf '%s\n' "$$" > "$PID_TEMP"
chmod 600 "$PID_TEMP"
mv -f "$PID_TEMP" "$PID_FILE"

cd "$PHYSICAL_ROOT"
cleanup_start_lock
trap - EXIT
exec "$NODE_BIN" server.js
