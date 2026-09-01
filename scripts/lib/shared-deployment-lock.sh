#!/usr/bin/env bash

# Shared mkdir(2)-based lock protocol used by every runtime installer. The web
# intake resume path uses the same .deployment.lock directory and therefore
# cannot race a paused-intake verification with a component replacement.

DEPLOYMENT_LOCK_OWNED=0
DEPLOYMENT_LOCK_IDENTITY=""

deployment_lock_identity() {
  stat -f '%d:%i' "$1"
}

acquire_shared_deployment_lock() {
  local physical_run_dir lock_identity
  case "$DEPLOYMENT_RUN_DIR:$DEPLOYMENT_LOCK_DIR" in
    /*:/*) ;;
    *) printf 'AIWORKER_BG_RUN_DIR must be absolute for shared runtime installation.\n' >&2; return 1 ;;
  esac
  if [[ "$DEPLOYMENT_LOCK_DIR" != "$DEPLOYMENT_RUN_DIR/.deployment.lock" ]]; then
    printf 'Shared deployment lock must be the canonical .deployment.lock path.\n' >&2
    return 1
  fi
  if [[ -L "$DEPLOYMENT_RUN_DIR" || ( -e "$DEPLOYMENT_RUN_DIR" && ! -d "$DEPLOYMENT_RUN_DIR" ) ]]; then
    printf 'Blue-green run directory must be a regular directory: %s\n' "$DEPLOYMENT_RUN_DIR" >&2
    return 1
  fi
  install -d -m 700 "$DEPLOYMENT_RUN_DIR"
  physical_run_dir="$(cd "$DEPLOYMENT_RUN_DIR" && pwd -P)" || return 1
  if [[ "$physical_run_dir" != "$DEPLOYMENT_RUN_DIR" \
    || "$(stat -f '%u' "$DEPLOYMENT_RUN_DIR")" != "$(id -u)" \
    || "$(stat -f '%Lp' "$DEPLOYMENT_RUN_DIR")" != "700" ]]; then
    printf 'Blue-green run directory must be a physical owner-private directory.\n' >&2
    return 1
  fi
  if ! mkdir "$DEPLOYMENT_LOCK_DIR" 2>/dev/null; then
    printf 'Another blue-green or shared installation operation holds %s\n' "$DEPLOYMENT_LOCK_DIR" >&2
    return 1
  fi
  chmod 700 "$DEPLOYMENT_LOCK_DIR"
  lock_identity="$(deployment_lock_identity "$DEPLOYMENT_LOCK_DIR")" || {
    rmdir "$DEPLOYMENT_LOCK_DIR" 2>/dev/null || true
    return 1
  }
  if ! printf '%s\n' "$$" > "$DEPLOYMENT_LOCK_DIR/pid" \
    || ! chmod 600 "$DEPLOYMENT_LOCK_DIR/pid"; then
    rm -f -- "$DEPLOYMENT_LOCK_DIR/pid" 2>/dev/null || true
    rmdir "$DEPLOYMENT_LOCK_DIR" 2>/dev/null || true
    return 1
  fi
  DEPLOYMENT_LOCK_IDENTITY="$lock_identity"
  DEPLOYMENT_LOCK_OWNED=1
}

release_shared_deployment_lock() {
  local current_identity="" owner=""
  [[ "$DEPLOYMENT_LOCK_OWNED" == 1 ]] || return 0
  if [[ ! -d "$DEPLOYMENT_LOCK_DIR" || -L "$DEPLOYMENT_LOCK_DIR" \
    || ! -f "$DEPLOYMENT_LOCK_DIR/pid" || -L "$DEPLOYMENT_LOCK_DIR/pid" ]]; then
    printf 'Shared deployment lock changed type before release; leaving it in place.\n' >&2
    return 1
  fi
  current_identity="$(deployment_lock_identity "$DEPLOYMENT_LOCK_DIR")" || return 1
  IFS= read -r owner < "$DEPLOYMENT_LOCK_DIR/pid" || true
  if [[ "$current_identity" != "$DEPLOYMENT_LOCK_IDENTITY" || "$owner" != "$$" ]]; then
    printf 'Shared deployment lock ownership changed before release; leaving it in place.\n' >&2
    return 1
  fi
  rm -f -- "$DEPLOYMENT_LOCK_DIR/pid" || return 1
  rmdir "$DEPLOYMENT_LOCK_DIR" || return 1
  DEPLOYMENT_LOCK_OWNED=0
  DEPLOYMENT_LOCK_IDENTITY=""
}
