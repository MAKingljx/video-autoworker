#!/bin/sh
set -e

# --- Source .env if present ---
if [ -f /app/.env ]; then
  printf '[entrypoint] Loading .env\n'
  set -a
  . /app/.env
  set +a
fi

if [ -n "${MC_AUTH_MODE:-}" ] && [ "$MC_AUTH_MODE" != "openclaw-loopback" ]; then
  printf '[entrypoint] MC_AUTH_MODE must be openclaw-loopback\n' >&2
  exit 64
fi
if [ -n "${MC_HOSTNAME:-}" ] && [ "$MC_HOSTNAME" != "127.0.0.1" ]; then
  printf '[entrypoint] MC_HOSTNAME must remain 127.0.0.1\n' >&2
  exit 64
fi

export MC_AUTH_MODE="openclaw-loopback"
export MC_DESKTOP_MODE="0"
export MC_OPENCLAW_PROFILES_NO_AUTH="0"
export MC_OPENCLAW_WORKSPACE_ID="${MC_OPENCLAW_WORKSPACE_ID:-1}"
export MC_OPENCLAW_TENANT_ID="${MC_OPENCLAW_TENANT_ID:-1}"
export MC_HOSTNAME="127.0.0.1"
export HOSTNAME="127.0.0.1"
export MISSION_CONTROL_DATA_DIR="${MISSION_CONTROL_DATA_DIR:-/app/data}"
export MISSION_CONTROL_DB_PATH="${MISSION_CONTROL_DB_PATH:-$MISSION_CONTROL_DATA_DIR/mission-control.db}"
export MISSION_CONTROL_TOKENS_PATH="${MISSION_CONTROL_TOKENS_PATH:-$MISSION_CONTROL_DATA_DIR/mission-control-tokens.json}"

for runtime_path in \
  "$MISSION_CONTROL_DATA_DIR" \
  "$MISSION_CONTROL_DB_PATH" \
  "$MISSION_CONTROL_TOKENS_PATH"
do
  case "$runtime_path" in
    /*) ;;
    *)
      printf '[entrypoint] runtime data paths must be absolute\n' >&2
      exit 64
      ;;
  esac
  case "$runtime_path" in
    /app/release|/app/release/*)
      printf '[entrypoint] runtime data must remain outside /app/release\n' >&2
      exit 64
      ;;
  esac
done

AUDITOR="/app/release/scripts/check-standalone-artifact.mjs"
if [ ! -f "$AUDITOR" ]; then
  printf '[entrypoint] standalone artifact auditor is missing\n' >&2
  exit 64
fi
node "$AUDITOR" /app/release >/dev/null

printf '[entrypoint] Starting server\n'
cd /app/release
exec node server.js
