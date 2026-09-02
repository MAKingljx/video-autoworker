#!/usr/bin/env bash

# Bash entrypoint for the single Node implementation of the shared deployment
# lock. The Node helper publishes a fully sealed sibling staging directory with
# fsync before it renames it to the canonical path, so Bash never exposes an
# empty canonical lock directory.

DEPLOYMENT_LOCK_OWNED=0
DEPLOYMENT_LOCK_LEASE_JSON=""

shared_deployment_lock_node_bin() {
  if [[ -n "${NODE_BIN:-}" && -x "$NODE_BIN" ]]; then
    printf '%s\n' "$NODE_BIN"
    return 0
  fi
  command -v node
}

shared_deployment_lock_node_helper() {
  local helper_dir
  helper_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)" || return 1
  printf '%s/shared-deployment-lock.mjs\n' "$helper_dir"
}

acquire_shared_deployment_lock() {
  local node_bin node_helper nonce receipt lease
  [[ "$DEPLOYMENT_LOCK_OWNED" == 0 ]] || return 0
  case "${DEPLOYMENT_RUN_DIR:-}:${DEPLOYMENT_LOCK_DIR:-}" in
    /*:/*) ;;
    *) printf 'AIWORKER_BG_RUN_DIR must be absolute for shared runtime installation.\n' >&2; return 1 ;;
  esac
  [[ "$DEPLOYMENT_LOCK_DIR" == "$DEPLOYMENT_RUN_DIR/.deployment.lock" ]] || {
    printf 'Shared deployment lock must be the canonical .deployment.lock path.\n' >&2
    return 1
  }
  node_bin="$(shared_deployment_lock_node_bin)" || {
    printf 'Node.js is required for the shared deployment lock.\n' >&2
    return 1
  }
  node_helper="$(shared_deployment_lock_node_helper)" || return 1
  [[ -f "$node_helper" && ! -L "$node_helper" ]] || {
    printf 'Shared deployment lock helper is unavailable.\n' >&2
    return 1
  }
  nonce="$(LC_ALL=C od -An -N16 -tx1 /dev/urandom | tr -d '[:space:]')" || return 1
  [[ "$nonce" =~ ^[a-f0-9]{32}$ ]] || return 1
  [[ ! -L "$DEPLOYMENT_RUN_DIR" && ( ! -e "$DEPLOYMENT_RUN_DIR" || -d "$DEPLOYMENT_RUN_DIR" ) ]] || {
    printf 'Blue-green run directory must be a regular directory.\n' >&2
    return 1
  }
  receipt="$(mktemp "${TMPDIR:-/tmp}/aiworker-shared-lock-receipt.XXXXXX")" || return 1
  chmod 600 "$receipt" || { rm -f -- "$receipt"; return 1; }
  if ! (umask 077; exec "$node_bin" "$node_helper" acquire-shell "$DEPLOYMENT_RUN_DIR" "$$") \
    > "$receipt"; then
    rm -f -- "$receipt" 2>/dev/null || true
    return 1
  fi
  IFS= read -r lease < "$receipt" || lease=""
  [[ -n "$lease" && "$lease" != *$'\n'* ]] || {
    rm -f -- "$receipt" 2>/dev/null || true
    return 1
  }
  DEPLOYMENT_LOCK_LEASE_JSON="$lease"
  DEPLOYMENT_LOCK_OWNED=1
  rm -f -- "$receipt" 2>/dev/null || true
}

release_shared_deployment_lock() {
  local node_bin node_helper
  [[ "$DEPLOYMENT_LOCK_OWNED" == 1 ]] || return 0
  node_bin="$(shared_deployment_lock_node_bin)" || return 1
  node_helper="$(shared_deployment_lock_node_helper)" || return 1
  if ! printf '%s\n' "$DEPLOYMENT_LOCK_LEASE_JSON" \
    | "$node_bin" "$node_helper" release-shell "$DEPLOYMENT_RUN_DIR" "$$"; then
    printf 'Shared deployment lock ownership changed before release; leaving it in place.\n' >&2
    return 1
  fi
  DEPLOYMENT_LOCK_OWNED=0
  DEPLOYMENT_LOCK_LEASE_JSON=""
}
