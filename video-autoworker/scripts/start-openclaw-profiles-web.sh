#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export PORT="${PORT:-3017}"
export MC_DESKTOP_MODE="${MC_DESKTOP_MODE:-0}"
export NEXT_PUBLIC_OPENCLAW_PROFILES_DESKTOP="${NEXT_PUBLIC_OPENCLAW_PROFILES_DESKTOP:-0}"
export MC_OPENCLAW_PROFILES_NO_AUTH="${MC_OPENCLAW_PROFILES_NO_AUTH:-1}"
export MC_DISABLE_RATE_LIMIT="${MC_DISABLE_RATE_LIMIT:-1}"
export MC_HOSTNAME="${MC_HOSTNAME:-127.0.0.1}"

exec "$APP_DIR/scripts/start-openclaw-profiles-server.sh"
