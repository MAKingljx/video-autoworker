#!/usr/bin/env bash

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
RUN_DIR="${AIWORKER_BG_RUN_DIR:-$PROJECT_ROOT/.run/blue-green}"
RELEASES_DIR="${AIWORKER_BG_RELEASES_DIR:-$PROJECT_ROOT/.runtime/releases}"
SUPERVISOR_DIR="${AIWORKER_BG_SUPERVISOR_DIR:-$RUN_DIR/supervisor}"
MARKER_DIR="$SUPERVISOR_DIR/enabled"
INSTALLATION_FILE="$SUPERVISOR_DIR/installation.json"
LAUNCH_AGENTS_DIR="${AIWORKER_BG_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
ROUTER_STATE="${AIWORKER_BG_ROUTER_STATE:-$RUN_DIR/router-state.json}"
ROUTER_PORT="${AIWORKER_BG_ROUTER_PORT:-3017}"
BLUE_PORT="${AIWORKER_BG_BLUE_PORT:-3317}"
GREEN_PORT="${AIWORKER_BG_GREEN_PORT:-3417}"
ROUTER_SCRIPT="$PROJECT_ROOT/scripts/standalone-router.mjs"
START_SCRIPT="$PROJECT_ROOT/scripts/start-standalone-slot.sh"
DOMAIN="gui/$(id -u)"
LOCK_DIR="$SUPERVISOR_DIR/.service-operation.lock"
LOCK_OWNED=0

usage() {
  cat <<'EOF'
Usage:
  manage-blue-green-services.sh start <router|blue|green>
  manage-blue-green-services.sh stop <router|blue|green>
  manage-blue-green-services.sh status [router|blue|green|all]
  manage-blue-green-services.sh preflight all

`stop` removes the service's enabled marker before unloading its exact label,
so launchd cannot revive a retired slot. Probe runtimes are intentionally not
managed by this command.
EOF
}

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

ACTION="${1:-}"
SERVICE="${2:-}"
case "$ACTION" in
  start|stop)
    [[ "$#" -eq 2 ]] || { usage >&2; exit 2; }
    ;;
  status)
    [[ "$#" -le 2 ]] || { usage >&2; exit 2; }
    SERVICE="${SERVICE:-all}"
    ;;
  preflight)
    [[ "$#" -eq 2 && "$SERVICE" == all ]] || { usage >&2; exit 2; }
    ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac
case "$SERVICE" in
  router|blue|green) ;;
  all) [[ "$ACTION" == status || "$ACTION" == preflight ]] || { usage >&2; exit 2; } ;;
  *) usage >&2; exit 2 ;;
esac

for command_name in chmod id kill launchctl lsof mkdir mv node plutil rm rmdir shasum sleep stat; do
  command -v "$command_name" >/dev/null 2>&1 || fail "required command is unavailable: $command_name"
done

NODE_BIN_INPUT="${AIWORKER_BG_NODE_BIN:-${NODE_BIN:-$(command -v node)}}"
[[ "$NODE_BIN_INPUT" == /* ]] || fail "Node.js executable must be an absolute path"
NODE_BIN="$("$NODE_BIN_INPUT" -e 'process.stdout.write(require("node:fs").realpathSync.native(process.execPath))')" \
  || fail "unable to resolve Node.js executable"

service_label() {
  printf 'com.video-autoworker.blue-green.%s\n' "$1"
}

plist_path() {
  printf '%s/%s.plist\n' "$LAUNCH_AGENTS_DIR" "$(service_label "$1")"
}

marker_path() {
  printf '%s/%s.enabled\n' "$MARKER_DIR" "$1"
}

attestation_path() {
  case "$1" in
    router) printf '%s/router.runtime.json\n' "$RUN_DIR" ;;
    blue|green) printf '%s/slots/%s.runtime.json\n' "$RUN_DIR" "$1" ;;
  esac
}

binding_path() {
  printf '%s/slots/%s.json\n' "$RUN_DIR" "$1"
}

service_port() {
  case "$1" in
    router) printf '%s\n' "$ROUTER_PORT" ;;
    blue) printf '%s\n' "$BLUE_PORT" ;;
    green) printf '%s\n' "$GREEN_PORT" ;;
  esac
}

service_target() {
  printf '%s/%s\n' "$DOMAIN" "$(service_label "$1")"
}

assert_private_file() {
  local pathname="$1"
  local label="$2"
  "$NODE_BIN" - "$pathname" "$label" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const [pathname, label] = process.argv.slice(2)
const fail = message => { process.stderr.write(`${label} ${message}: ${pathname}\n`); process.exit(1) }
if (!pathname || !path.isAbsolute(pathname) || path.resolve(pathname) !== pathname || /[\u0000-\u001f\u007f]/u.test(pathname)) {
  fail('must be a normalized absolute path')
}
const relative = path.relative(path.parse(pathname).root, pathname)
let cursor = path.parse(pathname).root
for (const segment of relative.split(path.sep).filter(Boolean)) {
  cursor = path.join(cursor, segment)
  let entry
  try { entry = fs.lstatSync(cursor) } catch { fail('is missing') }
  if (entry.isSymbolicLink()) fail(`must not traverse symlink ${cursor}`)
}
const entry = fs.lstatSync(pathname)
if (!entry.isFile() || entry.isSymbolicLink()) fail('must be a regular file')
if ((entry.mode & 0o777) !== 0o600) fail('must have mode 0600')
if (typeof process.getuid === 'function' && entry.uid !== process.getuid()) fail('must be owned by the current user')
NODE
}

assert_private_dir() {
  local pathname="$1"
  local label="$2"
  "$NODE_BIN" - "$pathname" "$label" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const [pathname, label] = process.argv.slice(2)
const fail = message => { process.stderr.write(`${label} ${message}: ${pathname}\n`); process.exit(1) }
if (!pathname || !path.isAbsolute(pathname) || path.resolve(pathname) !== pathname || /[\u0000-\u001f\u007f]/u.test(pathname)) {
  fail('must be a normalized absolute path')
}
if (pathname === '/' || pathname === process.env.HOME) fail('is dangerously broad')
const relative = path.relative(path.parse(pathname).root, pathname)
let cursor = path.parse(pathname).root
for (const segment of relative.split(path.sep).filter(Boolean)) {
  cursor = path.join(cursor, segment)
  let entry
  try { entry = fs.lstatSync(cursor) } catch { fail('is missing') }
  if (entry.isSymbolicLink()) fail(`must not traverse symlink ${cursor}`)
}
const entry = fs.lstatSync(pathname)
if (!entry.isDirectory() || entry.isSymbolicLink()) fail('must be a directory')
if ((entry.mode & 0o777) !== 0o700) fail('must have mode 0700')
if (typeof process.getuid === 'function' && entry.uid !== process.getuid()) fail('must be owned by the current user')
NODE
}

validate_installation() {
  [[ -f "$NODE_BIN" && ! -L "$NODE_BIN" && -x "$NODE_BIN" ]] \
    || fail "pinned Node.js executable is unavailable or unsafe"
  assert_private_dir "$RUN_DIR" "runtime state directory"
  assert_private_dir "$SUPERVISOR_DIR" "supervisor state directory"
  assert_private_dir "$MARKER_DIR" "enabled marker directory"
  [[ "$SUPERVISOR_DIR" == "$RUN_DIR/supervisor" && "$MARKER_DIR" == "$SUPERVISOR_DIR/enabled" ]] \
    || fail "supervisor paths are not canonical"
  case "$RUN_DIR" in
    /|"$HOME"|"$PROJECT_ROOT"|"$RELEASES_DIR"|"$RELEASES_DIR"/*) fail "runtime state directory is dangerously broad" ;;
  esac
  assert_private_file "$INSTALLATION_FILE" "LaunchAgent installation manifest"
  "$NODE_BIN" - "$INSTALLATION_FILE" "$PROJECT_ROOT" "$RUN_DIR" "$RELEASES_DIR" \
    "$LAUNCH_AGENTS_DIR" "$NODE_BIN" "$ROUTER_PORT" "$BLUE_PORT" "$GREEN_PORT" \
    "$ROUTER_SCRIPT" "$START_SCRIPT" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const [manifestPath, projectRoot, runDir, releasesDir, launchAgentsDir, nodeBin,
  routerPort, bluePort, greenPort, routerScript, slotStartScript] = process.argv.slice(2)
const fail = message => { process.stderr.write(`LaunchAgent installation manifest ${message}\n`); process.exit(1) }
let manifest
try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) } catch { fail('is not valid JSON') }
if (manifest?.schema !== 'video-autoworker-blue-green-launchd/v2') {
  fail('uses an unsupported or legacy schema; rerun install-blue-green-launch-agents.sh --apply')
}
if (manifest.projectRoot !== projectRoot || manifest.runDir !== runDir
  || manifest.releasesDir !== releasesDir || manifest.launchAgentsDir !== launchAgentsDir
  || manifest.nodeBin !== nodeBin) fail('does not match the requested runtime')
const currentUid = typeof process.getuid === 'function' ? process.getuid() : undefined
const assertExecutable = (name, binding, expectedPath, expectedMode) => {
  if (!path.isAbsolute(expectedPath) || path.resolve(expectedPath) !== expectedPath
    || binding?.path !== expectedPath || binding.uid !== currentUid
    || binding.mode !== expectedMode || !/^[a-f0-9]{64}$/u.test(binding.sha256)) {
    fail(`has an invalid ${name} executable binding`)
  }
  const relative = path.relative(path.parse(expectedPath).root, expectedPath)
  let cursor = path.parse(expectedPath).root
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment)
    let component
    try { component = fs.lstatSync(cursor) } catch { fail(`${name} executable is missing`) }
    if (component.isSymbolicLink()) fail(`${name} executable path traverses a symlink`)
  }
  const entry = fs.lstatSync(expectedPath)
  if (!entry.isFile() || entry.isSymbolicLink() || fs.realpathSync.native(expectedPath) !== expectedPath
    || (entry.mode & 0o777) !== expectedMode || entry.uid !== currentUid) {
    fail(`${name} executable is unsafe`)
  }
  const digest = crypto.createHash('sha256').update(fs.readFileSync(expectedPath)).digest('hex')
  if (digest !== binding.sha256) fail(`${name} executable digest changed`)
}
assertExecutable('router', manifest.executables?.routerScript, routerScript, 0o755)
assertExecutable('slot start', manifest.executables?.slotStartScript, slotStartScript, 0o755)
const expectedPorts = { router: Number(routerPort), blue: Number(bluePort), green: Number(greenPort) }
if (new Set(Object.values(expectedPorts)).size !== 3
  || Object.values(expectedPorts).some(port => !Number.isInteger(port) || port < 1 || port > 65535)) {
  fail('contains invalid or conflicting ports')
}
for (const name of ['router', 'blue', 'green']) {
  const service = manifest.services?.[name]
  const label = `com.video-autoworker.blue-green.${name}`
  const expectedPlist = `${launchAgentsDir}/${label}.plist`
  const expectedMarker = `${runDir}/supervisor/enabled/${name}.enabled`
  if (!service || service.label !== label || service.plist !== expectedPlist
    || service.enabledMarker !== expectedMarker || service.port !== expectedPorts[name]
    || !/^[a-f0-9]{64}$/u.test(service.sha256)) fail(`has an invalid ${name} binding`)
  const entry = fs.lstatSync(expectedPlist)
  if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o777) !== 0o600
    || (typeof process.getuid === 'function' && entry.uid !== process.getuid())
    || fs.realpathSync.native(expectedPlist) !== expectedPlist) fail(`${name} plist is unsafe`)
  const digest = crypto.createHash('sha256').update(fs.readFileSync(expectedPlist)).digest('hex')
  if (digest !== service.sha256) fail(`${name} plist digest changed`)
}
NODE
  for installed_service in router blue green; do
    plutil -lint "$(plist_path "$installed_service")" >/dev/null
  done
}

service_loaded() {
  launchctl print "$(service_target "$1")" >/dev/null 2>&1
}

launchd_pid() {
  launchctl print "$(service_target "$1")" 2>/dev/null | "$NODE_BIN" -e '
    const fs = require("node:fs")
    const report = fs.readFileSync(0, "utf8")
    const match = /(?:^|\n)\s*pid\s*=\s*([1-9][0-9]*)\s*(?:\n|$)/u.exec(report)
    if (!match) process.exit(1)
    process.stdout.write(match[1])
  '
}

verify_attestation() {
  local service="$1"
  local pid="$2"
  local port="$3"
  local pathname
  pathname="$(attestation_path "$service")"
  assert_private_file "$pathname" "$service runtime attestation"
  "$NODE_BIN" - "$pathname" "$service" "$pid" "$port" "$ROUTER_STATE" <<'NODE'
const fs = require('node:fs')
const [pathname, service, rawPid, rawPort, routerState] = process.argv.slice(2)
const value = JSON.parse(fs.readFileSync(pathname, 'utf8'))
const pid = Number(rawPid)
const port = Number(rawPort)
let valid
if (service === 'router') {
  valid = value?.schema === 'video-autoworker-standalone-router-runtime/v1'
    && value.pid === pid && value.host === '127.0.0.1' && value.port === port
    && value.stateFile === routerState
} else {
  valid = value?.schema === 'video-autoworker-standalone-runtime/v1'
    && value.pid === pid && value.slot === service && value.role === 'active'
    && value.host === '127.0.0.1' && value.port === port
    && typeof value.releaseId === 'string' && value.releaseId.length > 0
}
if (!valid) process.exit(1)
NODE
}

verify_listener() {
  local pid="$1"
  local port="$2"
  local listener_pids
  listener_pids="$(lsof -nP -a -p "$pid" -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)"
  [[ "$listener_pids" == "$pid" ]]
}

status_service() {
  local service="$1"
  local quiet="${2:-0}"
  local label target marker port pid
  label="$(service_label "$service")"
  target="$(service_target "$service")"
  marker="$(marker_path "$service")"
  port="$(service_port "$service")"
  local loaded=0 marker_present=0
  launchctl print "$target" >/dev/null 2>&1 && loaded=1
  [[ -e "$marker" || -L "$marker" ]] && marker_present=1
  if (( loaded == 0 && marker_present == 0 )); then
    (( quiet == 1 )) || printf '%s: not managed (marker is disabled and LaunchAgent %s is not loaded)\n' "$service" "$label" >&2
    return 1
  fi
  if (( marker_present == 0 )); then
    (( quiet == 1 )) || printf '%s: managed but stopping (LaunchAgent remains loaded, marker is disabled)\n' "$service" >&2
    return 2
  fi
  if ! assert_private_file "$marker" "$service enabled marker" >/dev/null 2>&1; then
    (( quiet == 1 )) || printf '%s: managed but unsafe (enabled marker failed validation)\n' "$service" >&2
    return 2
  fi
  if (( loaded == 0 )); then
    (( quiet == 1 )) || printf '%s: managed but unhealthy (enabled marker exists, LaunchAgent is not loaded)\n' "$service" >&2
    return 2
  fi
  pid="$(launchd_pid "$service")" || {
    (( quiet == 1 )) || printf '%s: unhealthy (LaunchAgent has no live PID)\n' "$service" >&2
    return 2
  }
  if ! kill -0 "$pid" 2>/dev/null; then
    (( quiet == 1 )) || printf '%s: unhealthy (PID %s is not alive)\n' "$service" "$pid" >&2
    return 2
  fi
  if ! verify_attestation "$service" "$pid" "$port" >/dev/null 2>&1; then
    (( quiet == 1 )) || printf '%s: unhealthy (runtime attestation does not match PID/port)\n' "$service" >&2
    return 2
  fi
  if ! verify_listener "$pid" "$port"; then
    (( quiet == 1 )) || printf '%s: unhealthy (PID %s does not own loopback port %s)\n' "$service" "$pid" "$port" >&2
    return 2
  fi
  (( quiet == 1 )) || printf '%s: managed and healthy label=%s pid=%s port=%s\n' "$service" "$label" "$pid" "$port"
}

port_is_free() {
  local port="$1"
  [[ -z "$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)" ]]
}

write_enabled_marker() {
  local service="$1"
  local destination temporary
  destination="$(marker_path "$service")"
  [[ ! -e "$destination" && ! -L "$destination" ]] || assert_private_file "$destination" "$service enabled marker"
  temporary="$destination.tmp.$$"
  "$NODE_BIN" - "$temporary" "$service" <<'NODE'
const fs = require('node:fs')
const [pathname, service] = process.argv.slice(2)
const descriptor = fs.openSync(pathname, 'wx', 0o600)
try {
  fs.writeFileSync(descriptor, `${JSON.stringify({ schema: 'video-autoworker-launchd-enabled/v1', service })}\n`)
  fs.fsyncSync(descriptor)
} finally { fs.closeSync(descriptor) }
NODE
  chmod 600 "$temporary"
  mv -f "$temporary" "$destination"
}

remove_enabled_marker() {
  local service="$1"
  local destination
  destination="$(marker_path "$service")"
  if [[ -e "$destination" || -L "$destination" ]]; then
    assert_private_file "$destination" "$service enabled marker"
    rm -f -- "$destination"
  fi
}

acquire_lock() {
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    fail "another blue-green service operation holds $LOCK_DIR"
  fi
  chmod 700 "$LOCK_DIR"
  printf '%s\n' "$$" > "$LOCK_DIR/pid"
  chmod 600 "$LOCK_DIR/pid"
  LOCK_OWNED=1
}

cleanup() {
  local exit_code=$?
  trap - EXIT HUP INT TERM
  if (( LOCK_OWNED == 1 )); then
    rm -f -- "$LOCK_DIR/pid" 2>/dev/null || true
    rmdir "$LOCK_DIR" 2>/dev/null || exit_code=1
  fi
  exit "$exit_code"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

validate_installation

if [[ "$ACTION" == preflight ]]; then
  launchctl print "$DOMAIN" >/dev/null 2>&1 \
    || fail "user launchctl domain is unavailable: $DOMAIN"
  printf 'Preflight passed: installation manifest, three LaunchAgents, pinned executables, and %s are available.\n' "$DOMAIN"
  printf 'No service, marker, listener, or runtime state was changed.\n'
  exit 0
fi

if [[ "$ACTION" == status ]]; then
  if [[ "$SERVICE" == all ]]; then
    status_code=0
    for current_service in router blue green; do
      if status_service "$current_service"; then
        :
      else
        current_status=$?
        if (( current_status == 2 )); then
          status_code=2
        elif (( status_code == 0 )); then
          status_code=1
        fi
      fi
    done
    exit "$status_code"
  fi
  if status_service "$SERVICE"; then
    exit 0
  else
    service_status=$?
  fi
  exit "$service_status"
fi

acquire_lock
label="$(service_label "$SERVICE")"
target="$(service_target "$SERVICE")"
plist="$(plist_path "$SERVICE")"
port="$(service_port "$SERVICE")"

if [[ "$ACTION" == start ]]; then
  if service_loaded "$SERVICE"; then
    if status_service "$SERVICE"; then
      printf '%s is already running under its LaunchAgent.\n' "$SERVICE"
      exit 0
    fi
    fail "$SERVICE LaunchAgent is loaded but unhealthy; stop it explicitly before retrying"
  fi
  if ! port_is_free "$port"; then
    fail "port $port is already owned by another process; no process was changed"
  fi
  if [[ "$SERVICE" == router ]]; then
    assert_private_file "$ROUTER_STATE" "router state"
  else
    assert_private_file "$(binding_path "$SERVICE")" "$SERVICE slot binding"
  fi
  write_enabled_marker "$SERVICE"
  start_ok=0
  if launchctl bootstrap "$DOMAIN" "$plist" \
    && launchctl kickstart "$target"; then
    for _attempt in {1..100}; do
      if status_service "$SERVICE" 1; then
        start_ok=1
        break
      fi
      sleep 0.1
    done
  fi
  if (( start_ok == 0 )); then
    remove_enabled_marker "$SERVICE" || true
    launchctl bootout "$target" >/dev/null 2>&1 || true
    fail "$SERVICE failed to become healthy; its marker was removed and exact label unloaded"
  fi
  status_service "$SERVICE"
  exit 0
fi

old_pid=""
if service_loaded "$SERVICE"; then
  old_pid="$(launchd_pid "$SERVICE" || true)"
fi
remove_enabled_marker "$SERVICE"
if service_loaded "$SERVICE"; then
  launchctl bootout "$target" || fail "unable to unload exact LaunchAgent label $label"
fi
if [[ "$old_pid" =~ ^[1-9][0-9]*$ ]]; then
  for _attempt in {1..100}; do
    kill -0 "$old_pid" 2>/dev/null || break
    sleep 0.1
  done
  if kill -0 "$old_pid" 2>/dev/null; then
    fail "$SERVICE marker is disabled, but PID $old_pid did not exit"
  fi
fi
if service_loaded "$SERVICE"; then
  fail "$SERVICE marker is disabled, but LaunchAgent remains loaded"
fi
printf '%s: stopped and disabled; launchd cannot restart this retired service.\n' "$SERVICE"
