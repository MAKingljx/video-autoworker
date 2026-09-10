#!/bin/bash

# Trust the shared JavaScript layout helper before executing it. This bootstrap
# intentionally knows only the two allowed physical layouts and the helper's
# own fixed product-relative path; all other Git-tree mapping stays in the MJS.
assert_git_source_layout_helper_bootstrap() {
  local product_root="${1:-}" node_bin="${2:-}"
  local physical_product git_root physical_git product_prefix helper tree_path
  local head entry mode type object_id observed_path worktree_object file_mode

  [[ "$product_root" == /* && -d "$product_root" && ! -L "$product_root" ]] || return 1
  physical_product="$(cd "$product_root" 2>/dev/null && pwd -P)" || return 1
  [[ "$physical_product" == "$product_root" ]] || return 1
  [[ "$node_bin" == /* && -x "$node_bin" && ! -L "$node_bin" ]] || return 1

  git_root="$(env -u GIT_DIR -u GIT_WORK_TREE -u GIT_COMMON_DIR -u GIT_INDEX_FILE \
    -u GIT_CONFIG_COUNT -u GIT_CONFIG_PARAMETERS -u GIT_CONFIG_GLOBAL -u GIT_CONFIG_SYSTEM \
    /usr/bin/git -C "$product_root" rev-parse --show-toplevel 2>/dev/null)" || return 1
  [[ "$git_root" == /* && -d "$git_root" && ! -L "$git_root" ]] || return 1
  physical_git="$(cd "$git_root" 2>/dev/null && pwd -P)" || return 1
  [[ "$physical_git" == "$git_root" ]] || return 1

  if [[ "$product_root" == "$git_root" ]]; then
    product_prefix=""
  elif [[ "$product_root" == "$git_root/video-autoworker" ]]; then
    product_prefix="video-autoworker/"
  else
    return 1
  fi

  helper="$product_root/scripts/lib/git-source-layout.mjs"
  tree_path="${product_prefix}scripts/lib/git-source-layout.mjs"
  [[ -f "$helper" && ! -L "$helper" ]] || return 1
  file_mode="$(/usr/bin/stat -f '%Lp' "$helper" 2>/dev/null)" || return 1
  [[ "$file_mode" == 644 || "$file_mode" == 444 ]] || return 1

  head="$(env -u GIT_DIR -u GIT_WORK_TREE -u GIT_COMMON_DIR -u GIT_INDEX_FILE \
    -u GIT_CONFIG_COUNT -u GIT_CONFIG_PARAMETERS -u GIT_CONFIG_GLOBAL -u GIT_CONFIG_SYSTEM \
    /usr/bin/git -C "$git_root" rev-parse --verify 'HEAD^{commit}' 2>/dev/null)" || return 1
  [[ "$head" =~ ^[a-f0-9]{40}$ ]] || return 1
  entry="$(env -u GIT_DIR -u GIT_WORK_TREE -u GIT_COMMON_DIR -u GIT_INDEX_FILE \
    -u GIT_CONFIG_COUNT -u GIT_CONFIG_PARAMETERS -u GIT_CONFIG_GLOBAL -u GIT_CONFIG_SYSTEM \
    /usr/bin/git -C "$git_root" ls-tree "$head" -- "$tree_path" 2>/dev/null)" || return 1
  read -r mode type object_id observed_path <<< "$entry"
  [[ "$mode" == 100644 && "$type" == blob && "$object_id" =~ ^[a-f0-9]{40,64}$ \
    && "$observed_path" == "$tree_path" ]] || return 1
  worktree_object="$(env -u GIT_DIR -u GIT_WORK_TREE -u GIT_COMMON_DIR -u GIT_INDEX_FILE \
    -u GIT_CONFIG_COUNT -u GIT_CONFIG_PARAMETERS -u GIT_CONFIG_GLOBAL -u GIT_CONFIG_SYSTEM \
    /usr/bin/git -C "$git_root" hash-object -- "$helper" 2>/dev/null)" || return 1
  [[ "$worktree_object" == "$object_id" ]] || return 1
  "$node_bin" --check "$helper" >/dev/null 2>&1 || return 1
}
