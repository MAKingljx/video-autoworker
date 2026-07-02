#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

export PORT="${PORT:-3017}"
export MC_DESKTOP_MODE="${MC_DESKTOP_MODE:-1}"
export MC_OPENCLAW_PROFILES_NO_AUTH="${MC_OPENCLAW_PROFILES_NO_AUTH:-1}"
export MC_DISABLE_RATE_LIMIT="${MC_DISABLE_RATE_LIMIT:-1}"
export NEXT_PUBLIC_OPENCLAW_PROFILES_DESKTOP="${NEXT_PUBLIC_OPENCLAW_PROFILES_DESKTOP:-1}"
export NEXT_TELEMETRY_DISABLED="${NEXT_TELEMETRY_DISABLED:-1}"
export MISSION_CONTROL_DATA_DIR="${MISSION_CONTROL_DATA_DIR:-$HOME/.mission-control-openclaw-profiles}"
export MISSION_CONTROL_DB_PATH="${MISSION_CONTROL_DB_PATH:-$MISSION_CONTROL_DATA_DIR/mission-control.db}"
export MISSION_CONTROL_TOKENS_PATH="${MISSION_CONTROL_TOKENS_PATH:-$MISSION_CONTROL_DATA_DIR/mission-control-tokens.json}"
export MC_MISSION_CONTROL_DIR="${MC_MISSION_CONTROL_DIR:-$APP_DIR}"

mkdir -p "$MISSION_CONTROL_DATA_DIR"

if [[ -x "$APP_DIR/src-tauri/target/release/bundle/macos/OpenClaw Control Center.app/Contents/MacOS/OpenClaw Control Center" ]]; then
  open "$APP_DIR/src-tauri/target/release/bundle/macos/OpenClaw Control Center.app"
  exit 0
fi

if [[ -x "$HOME/.local/node-v22/bin/pnpm" ]]; then
  exec "$HOME/.local/node-v22/bin/pnpm" desktop:dev
fi

exec pnpm desktop:dev
