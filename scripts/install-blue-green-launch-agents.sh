#!/usr/bin/env bash

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
RUN_DIR="${AIWORKER_BG_RUN_DIR:-$PROJECT_ROOT/.run/blue-green}"
RELEASES_DIR="${AIWORKER_BG_RELEASES_DIR:-$PROJECT_ROOT/.runtime/releases}"
SUPERVISOR_DIR="${AIWORKER_BG_SUPERVISOR_DIR:-$RUN_DIR/supervisor}"
MARKER_DIR="$SUPERVISOR_DIR/enabled"
LOG_DIR="${AIWORKER_BG_LOG_DIR:-$SUPERVISOR_DIR/logs}"
BACKUP_ROOT="${AIWORKER_BG_LAUNCHD_BACKUP_ROOT:-$SUPERVISOR_DIR/backups}"
INSTALLATION_FILE="$SUPERVISOR_DIR/installation.json"
LAUNCH_AGENTS_DIR="${AIWORKER_BG_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
ROUTER_TEMPLATE="$PROJECT_ROOT/ops/video-autoworker/launchd/com.video-autoworker.blue-green.router.plist.template"
SLOT_TEMPLATE="$PROJECT_ROOT/ops/video-autoworker/launchd/com.video-autoworker.blue-green.slot.plist.template"
ROUTER_SCRIPT="$PROJECT_ROOT/scripts/standalone-router.mjs"
START_SCRIPT="$PROJECT_ROOT/scripts/start-standalone-slot.sh"
ROUTER_STATE="${AIWORKER_BG_ROUTER_STATE:-$RUN_DIR/router-state.json}"
ROUTER_PORT="${AIWORKER_BG_ROUTER_PORT:-3017}"
BLUE_PORT="${AIWORKER_BG_BLUE_PORT:-3317}"
GREEN_PORT="${AIWORKER_BG_GREEN_PORT:-3417}"
MODE="apply"
WORK_ROOT=""
BACKUP_DIR=""
LOCK_DIR="$SUPERVISOR_DIR/.install.lock"
LOCK_OWNED=0
COMMIT_STARTED=0
COMMIT_DONE=0
TMP_BASE="$(cd "${TMPDIR:-/tmp}" && pwd -P)"

usage() {
  cat <<'EOF'
Usage: install-blue-green-launch-agents.sh [--dry-run|--apply]

Renders or upgrades the router, blue, and green user LaunchAgents. Installation
never loads, unloads, starts, stops, or reloads a service. Use
manage-blue-green-services.sh for explicit lifecycle operations.
EOF
}

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

while (( $# > 0 )); do
  case "$1" in
    --dry-run) MODE="dry-run" ;;
    --apply) MODE="apply" ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
  shift
done

for command_name in chmod cp date dirname id mkdir mktemp mv node plutil rm rmdir shasum stat; do
  command -v "$command_name" >/dev/null 2>&1 || fail "required command is unavailable: $command_name"
done

NODE_BIN_INPUT="${AIWORKER_BG_NODE_BIN:-${NODE_BIN:-$(command -v node)}}"
[[ "$NODE_BIN_INPUT" == /* ]] || fail "Node.js executable must be an absolute path"
NODE_BIN="$("$NODE_BIN_INPUT" -e 'process.stdout.write(require("node:fs").realpathSync.native(process.execPath))')" \
  || fail "unable to resolve Node.js executable"
[[ -f "$NODE_BIN" && -x "$NODE_BIN" && ! -L "$NODE_BIN" ]] \
  || fail "Node.js executable must resolve to an executable regular file"
NODE_BIN_DIR="$(dirname "$NODE_BIN")"

service_label() {
  printf 'com.video-autoworker.blue-green.%s\n' "$1"
}

plist_path() {
  printf '%s/%s.plist\n' "$LAUNCH_AGENTS_DIR" "$(service_label "$1")"
}

marker_path() {
  printf '%s/%s.enabled\n' "$MARKER_DIR" "$1"
}

service_port() {
  case "$1" in
    router) printf '%s\n' "$ROUTER_PORT" ;;
    blue) printf '%s\n' "$BLUE_PORT" ;;
    green) printf '%s\n' "$GREEN_PORT" ;;
  esac
}

assert_safe_path() {
  local pathname="$1"
  local kind="$2"
  local label="$3"
  local allow_missing="${4:-0}"
  "$NODE_BIN" - "$pathname" "$kind" "$label" "$allow_missing" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const [pathname, kind, label, rawAllowMissing] = process.argv.slice(2)
const fail = message => { process.stderr.write(`${label} ${message}: ${pathname}\n`); process.exit(1) }
if (!pathname || !path.isAbsolute(pathname) || path.resolve(pathname) !== pathname || /[\u0000-\u001f\u007f]/u.test(pathname)) {
  fail('must be a normalized absolute path')
}
const relative = path.relative(path.parse(pathname).root, pathname)
let cursor = path.parse(pathname).root
for (const segment of relative.split(path.sep).filter(Boolean)) {
  cursor = path.join(cursor, segment)
  let entry
  try { entry = fs.lstatSync(cursor) } catch (error) {
    if (error?.code === 'ENOENT' && rawAllowMissing === '1') break
    throw error
  }
  if (entry.isSymbolicLink()) fail(`must not traverse symlink ${cursor}`)
}
let entry
try { entry = fs.lstatSync(pathname) } catch (error) {
  if (error?.code === 'ENOENT' && rawAllowMissing === '1') process.exit(0)
  throw error
}
if (entry.isSymbolicLink()) fail('must not be a symlink')
if (kind === 'file' && !entry.isFile()) fail('must be a regular file')
if (kind === 'directory' && !entry.isDirectory()) fail('must be a directory')
if (typeof process.getuid === 'function' && entry.uid !== process.getuid()) fail('must be owned by the current user')
NODE
}

assert_private_file_if_present() {
  local pathname="$1"
  local label="$2"
  [[ ! -e "$pathname" && ! -L "$pathname" ]] && return 0
  assert_safe_path "$pathname" file "$label"
  local mode
  mode="$(stat -f '%Lp' "$pathname" 2>/dev/null || stat -c '%a' "$pathname")"
  [[ "$mode" == "600" ]] || fail "$label must have mode 0600: $pathname"
}

assert_private_dir_if_present() {
  local pathname="$1"
  local label="$2"
  [[ ! -e "$pathname" && ! -L "$pathname" ]] && return 0
  assert_safe_path "$pathname" directory "$label"
  local mode
  mode="$(stat -f '%Lp' "$pathname" 2>/dev/null || stat -c '%a' "$pathname")"
  [[ "$mode" == "700" ]] || fail "$label must have mode 0700: $pathname"
}

assert_specific_state_path() {
  local pathname="$1"
  local label="$2"
  [[ "$pathname" == /* && "$(dirname "$pathname")" != "/" ]] || fail "$label is dangerously broad"
  case "$pathname" in
    /|"$HOME"|"$PROJECT_ROOT"|"$RELEASES_DIR"|"$LAUNCH_AGENTS_DIR") fail "$label is dangerously broad" ;;
    "$RELEASES_DIR"/*) fail "$label must remain outside immutable releases" ;;
  esac
}

assert_port() {
  [[ "$2" =~ ^[1-9][0-9]*$ ]] && (( 10#$2 <= 65535 )) || fail "$1 must be a TCP port from 1 to 65535"
}

render_plist() {
  local template="$1"
  local destination="$2"
  shift 2
  "$NODE_BIN" - "$template" "$destination" "$@" <<'NODE'
const fs = require('node:fs')
const [template, destination, ...pairs] = process.argv.slice(2)
if (pairs.length % 2 !== 0) throw new Error('render pairs are incomplete')
const escapeXml = value => String(value)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&apos;')
let rendered = fs.readFileSync(template, 'utf8')
for (let index = 0; index < pairs.length; index += 2) {
  const placeholder = pairs[index]
  const value = pairs[index + 1]
  if (!placeholder.startsWith('__') || !placeholder.endsWith('__') || !rendered.includes(placeholder)) {
    throw new Error(`template placeholder is missing: ${placeholder}`)
  }
  rendered = rendered.replaceAll(placeholder, escapeXml(value))
}
if (/__[A-Z0-9_]+__/u.test(rendered)) throw new Error('template contains unresolved placeholders')
const descriptor = fs.openSync(destination, 'wx', 0o600)
try { fs.writeFileSync(descriptor, rendered, 'utf8'); fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
NODE
  chmod 600 "$destination"
  plutil -lint "$destination" >/dev/null
}

render_service() {
  local service="$1"
  local destination="$2"
  local label marker port
  label="$(service_label "$service")"
  marker="$(marker_path "$service")"
  port="$(service_port "$service")"
  if [[ "$service" == router ]]; then
    render_plist "$ROUTER_TEMPLATE" "$destination" \
      __LABEL__ "$label" \
      __NODE_BIN__ "$NODE_BIN" \
      __NODE_BIN_DIR__ "$NODE_BIN_DIR" \
      __ROUTER_SCRIPT__ "$ROUTER_SCRIPT" \
      __ROUTER_STATE__ "$ROUTER_STATE" \
      __PORT__ "$port" \
      __ATTESTATION__ "$RUN_DIR/router.runtime.json" \
      __PROJECT_ROOT__ "$PROJECT_ROOT" \
      __HOME__ "$HOME" \
      __ENABLED_MARKER__ "$marker" \
      __STDOUT_LOG__ "$LOG_DIR/router.log" \
      __STDERR_LOG__ "$LOG_DIR/router.error.log"
  else
    render_plist "$SLOT_TEMPLATE" "$destination" \
      __LABEL__ "$label" \
      __START_SCRIPT__ "$START_SCRIPT" \
      __SLOT__ "$service" \
      __PROJECT_ROOT__ "$PROJECT_ROOT" \
      __HOME__ "$HOME" \
      __NODE_BIN_DIR__ "$NODE_BIN_DIR" \
      __NODE_BIN__ "$NODE_BIN" \
      __RUN_DIR__ "$RUN_DIR" \
      __RELEASES_DIR__ "$RELEASES_DIR" \
      __ROUTER_STATE__ "$ROUTER_STATE" \
      __ROUTER_PORT__ "$ROUTER_PORT" \
      __BLUE_PORT__ "$BLUE_PORT" \
      __GREEN_PORT__ "$GREEN_PORT" \
      __ENABLED_MARKER__ "$marker" \
      __STDOUT_LOG__ "$LOG_DIR/$service.log" \
      __STDERR_LOG__ "$LOG_DIR/$service.error.log"
  fi
}

write_installation_manifest() {
  local destination="$1"
  "$NODE_BIN" - "$destination" "$PROJECT_ROOT" "$RUN_DIR" "$RELEASES_DIR" \
    "$LAUNCH_AGENTS_DIR" "$NODE_BIN" "$WORK_ROOT/router.plist" "$WORK_ROOT/blue.plist" \
    "$WORK_ROOT/green.plist" "$ROUTER_PORT" "$BLUE_PORT" "$GREEN_PORT" \
    "$ROUTER_SCRIPT" "$START_SCRIPT" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const [destination, projectRoot, runDir, releasesDir, launchAgentsDir, nodeBin,
  routerSource, blueSource, greenSource, routerPort, bluePort, greenPort,
  routerScript, slotStartScript] = process.argv.slice(2)
const digest = pathname => crypto.createHash('sha256').update(fs.readFileSync(pathname)).digest('hex')
const executable = (pathname, expectedMode) => {
  const fail = message => { throw new Error(`executable ${message}: ${pathname}`) }
  if (!path.isAbsolute(pathname) || path.resolve(pathname) !== pathname) fail('path is not canonical')
  const entry = fs.lstatSync(pathname)
  if (!entry.isFile() || entry.isSymbolicLink()) fail('is not a regular file')
  if (fs.realpathSync.native(pathname) !== pathname) fail('path traverses a symlink')
  if ((entry.mode & 0o777) !== expectedMode) fail(`must have mode 0${expectedMode.toString(8)}`)
  const uid = typeof process.getuid === 'function' ? process.getuid() : entry.uid
  if (entry.uid !== uid) fail('is not owned by the current user')
  return { path: pathname, uid, mode: expectedMode, sha256: digest(pathname) }
}
const service = (name, source, port) => ({
  label: `com.video-autoworker.blue-green.${name}`,
  plist: `${launchAgentsDir}/com.video-autoworker.blue-green.${name}.plist`,
  enabledMarker: `${runDir}/supervisor/enabled/${name}.enabled`,
  port: Number(port),
  sha256: digest(source),
})
const payload = {
  schema: 'video-autoworker-blue-green-launchd/v2',
  projectRoot,
  runDir,
  releasesDir,
  launchAgentsDir,
  nodeBin,
  executables: {
    routerScript: executable(routerScript, 0o755),
    slotStartScript: executable(slotStartScript, 0o755),
  },
  services: {
    router: service('router', routerSource, routerPort),
    blue: service('blue', blueSource, bluePort),
    green: service('green', greenSource, greenPort),
  },
}
const descriptor = fs.openSync(destination, 'wx', 0o600)
try { fs.writeFileSync(descriptor, `${JSON.stringify(payload)}\n`); fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
NODE
  chmod 600 "$destination"
}

copy_new_file() {
  local source="$1"
  local destination="$2"
  "$NODE_BIN" - "$source" "$destination" <<'NODE'
const fs = require('node:fs')
const [source, destination] = process.argv.slice(2)
const payload = fs.readFileSync(source)
const descriptor = fs.openSync(destination, 'wx', 0o600)
try { fs.writeFileSync(descriptor, payload); fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
NODE
  chmod 600 "$destination"
}

verify_backup() {
  assert_private_dir_if_present "$BACKUP_DIR" "LaunchAgent transaction backup"
  assert_private_file_if_present "$BACKUP_DIR/MANIFEST.sha256" "LaunchAgent transaction backup manifest"
  if [[ -s "$BACKUP_DIR/MANIFEST.sha256" ]]; then
    (cd "$BACKUP_DIR" && shasum -a 256 -c MANIFEST.sha256 >/dev/null) || return 1
  fi
}

restore_backup() {
  local service destination backup_name
  verify_backup || return 1
  for service in router blue green; do
    destination="$(plist_path "$service")"
    backup_name="$BACKUP_DIR/$service.plist"
    if [[ -f "$BACKUP_DIR/$service.present" ]]; then
      copy_new_file "$backup_name" "$destination.restore.$$" || return 1
      mv -f "$destination.restore.$$" "$destination" || return 1
    else
      rm -f -- "$destination" || return 1
    fi
  done
  if [[ -f "$BACKUP_DIR/installation.present" ]]; then
    copy_new_file "$BACKUP_DIR/installation.json" "$INSTALLATION_FILE.restore.$$" || return 1
    mv -f "$INSTALLATION_FILE.restore.$$" "$INSTALLATION_FILE" || return 1
  else
    rm -f -- "$INSTALLATION_FILE" || return 1
  fi
}

cleanup() {
  local exit_code=$?
  trap - EXIT HUP INT TERM
  set +e
  if (( exit_code != 0 && COMMIT_STARTED == 1 && COMMIT_DONE == 0 )) && [[ -n "$BACKUP_DIR" ]]; then
    if restore_backup; then
      printf 'LaunchAgent installation failed; the previous files were restored.\n' >&2
    else
      printf 'ROLLBACK FAILED: inspect the preserved backup at %s\n' "$BACKUP_DIR" >&2
      exit_code=1
    fi
  fi
  if (( LOCK_OWNED == 1 )); then
    rm -f -- "$LOCK_DIR/pid" 2>/dev/null || true
    rmdir "$LOCK_DIR" 2>/dev/null || exit_code=1
  fi
  if [[ -n "$WORK_ROOT" ]]; then
    case "$WORK_ROOT" in
      "$TMP_BASE"/video-autoworker-blue-green-launchd.*)
        rm -rf -- "$WORK_ROOT" || exit_code=1
        ;;
      *) printf 'Refusing unexpected temporary cleanup path: %s\n' "$WORK_ROOT" >&2; exit_code=1 ;;
    esac
  fi
  exit "$exit_code"
}

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

for source_path in "$PROJECT_ROOT" "$ROUTER_TEMPLATE" "$SLOT_TEMPLATE" "$ROUTER_SCRIPT" "$START_SCRIPT"; do
  if [[ -d "$source_path" ]]; then
    assert_safe_path "$source_path" directory "source directory"
  else
    assert_safe_path "$source_path" file "source file"
  fi
done
for executable_path in "$ROUTER_SCRIPT" "$START_SCRIPT"; do
  executable_mode="$(stat -f '%Lp' "$executable_path" 2>/dev/null || stat -c '%a' "$executable_path")"
  [[ "$executable_mode" == "755" ]] || fail "managed executable must have mode 0755: $executable_path"
done

for path_item in "$RUN_DIR" "$RELEASES_DIR" "$SUPERVISOR_DIR" "$MARKER_DIR" "$LOG_DIR" \
  "$BACKUP_ROOT" "$LAUNCH_AGENTS_DIR" "$ROUTER_STATE"; do
  [[ "$path_item" == /* && "$path_item" != *[$'\r\n']* ]] || fail "managed paths must be normalized absolute paths"
done
assert_specific_state_path "$RUN_DIR" "runtime state directory"
assert_specific_state_path "$SUPERVISOR_DIR" "supervisor state directory"
assert_specific_state_path "$LOG_DIR" "supervisor log directory"
[[ "$SUPERVISOR_DIR" == "$RUN_DIR/supervisor" ]] || fail "supervisor state must be the runtime directory's direct supervisor child"
[[ "$MARKER_DIR" == "$SUPERVISOR_DIR/enabled" ]] || fail "enabled marker directory is not canonical"
[[ "$BACKUP_ROOT" == "$SUPERVISOR_DIR/backups" ]] || fail "backup directory is not canonical"
[[ "$LOG_DIR" == "$SUPERVISOR_DIR/logs" ]] || fail "log directory is not canonical"
[[ "$ROUTER_STATE" == "$RUN_DIR/router-state.json" ]] || fail "router state path is not canonical"
assert_port "router port" "$ROUTER_PORT"
assert_port "blue port" "$BLUE_PORT"
assert_port "green port" "$GREEN_PORT"
[[ "$ROUTER_PORT" != "$BLUE_PORT" && "$ROUTER_PORT" != "$GREEN_PORT" && "$BLUE_PORT" != "$GREEN_PORT" ]] \
  || fail "router, blue, and green ports must be distinct"

assert_private_dir_if_present "$RUN_DIR" "runtime state directory"
assert_private_dir_if_present "$SUPERVISOR_DIR" "supervisor state directory"
assert_private_dir_if_present "$MARKER_DIR" "enabled marker directory"
assert_private_dir_if_present "$LOG_DIR" "supervisor log directory"
assert_private_dir_if_present "$BACKUP_ROOT" "LaunchAgent backup directory"
if [[ -e "$LAUNCH_AGENTS_DIR" || -L "$LAUNCH_AGENTS_DIR" ]]; then
  assert_safe_path "$LAUNCH_AGENTS_DIR" directory "LaunchAgents directory"
fi
for service in router blue green; do
  assert_private_file_if_present "$(plist_path "$service")" "$service LaunchAgent"
  assert_private_file_if_present "$(marker_path "$service")" "$service enabled marker"
done
assert_private_file_if_present "$INSTALLATION_FILE" "LaunchAgent installation manifest"

WORK_ROOT="$(mktemp -d "$TMP_BASE/video-autoworker-blue-green-launchd.XXXXXX")"
WORK_ROOT="$(cd "$WORK_ROOT" && pwd -P)"
chmod 700 "$WORK_ROOT"
for service in router blue green; do
  render_service "$service" "$WORK_ROOT/$service.plist"
done
write_installation_manifest "$WORK_ROOT/installation.json"

if [[ "$MODE" == "dry-run" ]]; then
  printf 'Dry run passed: three disabled-by-default LaunchAgents can be installed.\n'
  printf 'No plist, marker, service, listener, or runtime state was changed.\n'
  exit 0
fi

mkdir -p "$RUN_DIR" "$SUPERVISOR_DIR" "$MARKER_DIR" "$LOG_DIR" "$BACKUP_ROOT"
chmod 700 "$RUN_DIR" "$SUPERVISOR_DIR" "$MARKER_DIR" "$LOG_DIR" "$BACKUP_ROOT"
if [[ ! -e "$LAUNCH_AGENTS_DIR" ]]; then
  mkdir -p "$LAUNCH_AGENTS_DIR"
  chmod 700 "$LAUNCH_AGENTS_DIR"
fi
assert_safe_path "$LAUNCH_AGENTS_DIR" directory "LaunchAgents directory"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  fail "another LaunchAgent installation holds $LOCK_DIR"
fi
chmod 700 "$LOCK_DIR"
printf '%s\n' "$$" > "$LOCK_DIR/pid"
chmod 600 "$LOCK_DIR/pid"
LOCK_OWNED=1

backup_stamp="$(date -u '+%Y%m%d-%H%M%S').$$"
BACKUP_DIR="$BACKUP_ROOT/$backup_stamp"
mkdir "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
for service in router blue green; do
  destination="$(plist_path "$service")"
  if [[ -f "$destination" ]]; then
    cp -p "$destination" "$BACKUP_DIR/$service.plist"
    chmod 600 "$BACKUP_DIR/$service.plist"
    : > "$BACKUP_DIR/$service.present"
    chmod 600 "$BACKUP_DIR/$service.present"
  fi
done
if [[ -f "$INSTALLATION_FILE" ]]; then
  cp -p "$INSTALLATION_FILE" "$BACKUP_DIR/installation.json"
  chmod 600 "$BACKUP_DIR/installation.json"
  : > "$BACKUP_DIR/installation.present"
  chmod 600 "$BACKUP_DIR/installation.present"
fi
: > "$BACKUP_DIR/MANIFEST.sha256"
for backup_name in router.plist router.present blue.plist blue.present green.plist green.present \
  installation.json installation.present; do
  if [[ -f "$BACKUP_DIR/$backup_name" ]]; then
    (cd "$BACKUP_DIR" && shasum -a 256 "$backup_name") >> "$BACKUP_DIR/MANIFEST.sha256"
  fi
done
chmod 600 "$BACKUP_DIR/MANIFEST.sha256"

COMMIT_STARTED=1
written=0
for service in router blue green; do
  destination="$(plist_path "$service")"
  copy_new_file "$WORK_ROOT/$service.plist" "$destination.tmp.$$"
  mv -f "$destination.tmp.$$" "$destination"
  written=$((written + 1))
  if [[ "${AIWORKER_BG_TEST_MODE:-0}" == "1" \
    && "${AIWORKER_BG_INSTALL_TEST_FAIL_AFTER:-}" == "$written" ]]; then
    fail "injected installation failure after asset $written"
  fi
done
copy_new_file "$WORK_ROOT/installation.json" "$INSTALLATION_FILE.tmp.$$"
mv -f "$INSTALLATION_FILE.tmp.$$" "$INSTALLATION_FILE"
COMMIT_DONE=1

printf 'Installed three blue-green LaunchAgents without starting or stopping any service.\n'
printf 'Use manage-blue-green-services.sh start <router|blue|green> explicitly.\n'
