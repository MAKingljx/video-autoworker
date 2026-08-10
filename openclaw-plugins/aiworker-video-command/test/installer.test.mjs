import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const installerPath = resolve(
  process.cwd(),
  'scripts/install-aiworker-video-command-plugin.sh',
)

describe('AI-worker video-command plugin installer contract', () => {
  it('is pinned to qwen-current and uses only the official plugin installer', async () => {
    const script = await readFile(installerPath, 'utf8')
    expect(script).toContain('PROFILE="qwen-current"')
    expect(script).toContain('SOURCE_VERSION="0.3.0"')
    expect(script).toContain('AGENT_ID="second-original"')
    expect(script).toContain('EXPECTED_USER="heisenbergs-1"')
    expect(script).toContain('EXPECTED_HOST="HEISENBERGS-1deMac-Studio.local"')
    expect(script).toContain('run_qwen_openclaw plugins install --force "$PLUGIN_DIR"')
    expect(script).toContain('-u OPENCLAW_STATE_DIR')
    expect(script).toContain('-u OPENCLAW_CONFIG_PATH')
    expect(script).toContain('-u OPENCLAW_HOME')
    expect(script).toContain('-u OPENCLAW_INCLUDE_ROOTS')
    expect(script.match(/openclaw --profile/g)).toHaveLength(1)
    expect(script).not.toContain('plugins validate')
    expect(script).toContain('run_qwen_openclaw plugins inspect "$PLUGIN_ID" --runtime --json')
    expect(script).toContain('plugins doctor')
    expect(script).toContain('validate-runtime-inspection.mjs')
    expect(script).toContain('validate-plugin-doctor.mjs')
    expect(script).toContain('validate-plugin-absence.mjs')
    expect(script).toContain('validate-aiworker-video-command-upgrade.mjs')
    expect(script).toContain('aiworker-video-command-upgrade-policy.mjs')
    expect(script).toContain('node "$UPGRADE_VALIDATOR" telegram-policy "$PROFILE_CONFIG" "$AGENT_ID"')
    expect(script.match(/^verify_telegram_ingress_policy$/gmu)).toHaveLength(3)
    expect(script).toContain('owner-sender-plan "$PROFILE_CONFIG"')
    expect(script).toContain('sender-hash-config')
    expect(script).toContain('plugins.entries.$PLUGIN_ID.config.allowedSenderSha256')
    expect(script).toContain('Fresh 0.3 install must declare the lowercase SHA-256 sender gate.')
    expect(script).toContain('plugins inspect --all --json > "$report_path"')
    expect(script).toContain('Unable to inspect the complete qwen-current plugin registry.')
    expect(script).toContain('manifest?.id !== pluginId')
    expect(script).toContain('packageJson?.version !== sourceVersion')
    expect(script).toContain('Fresh install accepts only hook-only source version')
    expect(script).toContain('JSON.stringify(["hook"])')
    expect(script).toContain('manifest?.contracts !== undefined || manifest?.toolMetadata !== undefined')
    expect(script).toContain('"$PLUGIN_ID" "$SOURCE_VERSION"')
    expect(script).toContain('verify_explicit_allowlist pre-install')
    expect(script).toContain('verify_explicit_allowlist post-install')
    expect(script).toContain('verify_first_install_state')
    expect(script).toContain('assert_plugin_index_absent "$PROFILE_STATE_DB"')
    expect(script).toContain('assert_plugin_index_present "$PROFILE_STATE_DB"')
    expect(script).toContain("WHERE index_key = 'installed-plugin-index'")
    expect(script).toContain('!allow.includes(process.argv[3])')
    expect(script).toContain('[[ ! -d "$INSTALLED_PLUGIN_DIR" ]]')
    for (const moduleName of [
      'before-dispatch.js',
      'dispatch-identity.js',
      'natural-video-request.js',
      'parse-video-command.js',
      'runner.js',
      'short-receipt.js',
      'stable-message-key.js',
      'video-path-policy.js',
      'video-request-router.js',
      'video-task-result.js',
    ]) {
      expect(script).toContain(`"$PLUGIN_DIR/lib/${moduleName}"`)
    }
    expect(script).not.toContain('inbound-claim.js')
    expect(script).not.toMatch(/gateway (?:restart|start|stop)|launchctl|npm\/dist/iu)
  })

  it('proves runtime loading in an isolated state and removes only that exact state', async () => {
    const script = await readFile(installerPath, 'utf8')
    expect(script).toContain('mktemp -d "/tmp/aiworker-plugin-dry-run.XXXXXX"')
    expect(script).toContain('OPENCLAW_HOME="$isolated_home_dir"')
    expect(script).toContain('OPENCLAW_STATE_DIR="$isolated_state_dir"')
    expect(script).toContain('OPENCLAW_CONFIG_PATH="$isolated_config"')
    expect(script).not.toMatch(/(?:^|\s)HOME="\$isolated_home_dir"/u)
    expect(script).toContain('openclaw plugins install --force "$PLUGIN_DIR"')
    expect(script).toContain('assert_plugin_index_present "$isolated_state_dir/state/openclaw.sqlite"')
    expect(script).toContain('prepare_isolated_sqlite_read "$isolated_state_dir/state/openclaw.sqlite"')
    expect(script).toContain('fingerprint_real_path')
    expect(script).toContain('fingerprint_plugin_index')
    expect(script).toContain('exec-approvals.json')
    expect(script).toContain('protected_default_snapshot')
    expect(script).toContain('protected_qwen_snapshot')
    expect(script).toContain('default_snapshot_after')
    expect(script).toContain('qwen_snapshot_after')
    expect(script).toContain('/tmp/aiworker-plugin-dry-run.*|/private/tmp/aiworker-plugin-dry-run.*')
    expect(script).toContain('rm -rf -- "$isolated_root"')
  })

  it('defaults to dry-run and backs up config for a rollback-safe first install', async () => {
    const script = await readFile(installerPath, 'utf8')
    expect(script).toContain('MODE="dry-run"')
    expect(script).toContain('install -d -m 700 "$BACKUP_ROOT"')
    expect(script).toContain('mktemp -d "$BACKUP_ROOT/$stamp.XXXXXX"')
    expect(script).toContain('mkdir "$INSTALL_LOCK_DIR"')
    expect(script).toContain('pre-install-plugins-doctor.txt')
    expect(script).toContain('preflight_profile_before')
    expect(script).toContain('preflight_profile_after')
    expect(script).toContain('pre-install-plugins-all.json')
    expect(script).toContain('verify_first_install_state')
    expect(script).toContain('install -m 600 "$PROFILE_CONFIG" "$backup_dir/openclaw.json"')
    expect(script).toContain('> "$backup_dir/owner-sender-policy.json"')
    expect(script).toContain('chmod 600 "$backup_dir/owner-sender-policy.json"')
    expect(script).toContain('install -m 600 "$backup_dir/openclaw.json" "$PROFILE_CONFIG"')
    expect(script).toContain('plugins uninstall "$PLUGIN_ID" --force')
    expect(script).toContain('cmp -s "$backup_dir/openclaw.json" "$PROFILE_CONFIG"')
    expect(script).toContain('ROLLBACK FAILED')
    expect(script).toContain('verified_backup_count')
    expect(script).toContain('install -m 600 /dev/null "$backup_dir/.verified"')
    expect(script.indexOf('trap restore_failed_install EXIT')).toBeLessThan(
      script.indexOf('verify_explicit_allowlist post-install'),
    )
    expect(script.indexOf('trap restore_failed_install EXIT')).toBeLessThan(
      script.lastIndexOf('verify_telegram_ingress_policy'),
    )
    expect(script.lastIndexOf('run_qwen_openclaw plugins install --force "$PLUGIN_DIR"')).toBeLessThan(
      script.lastIndexOf('verify_telegram_ingress_policy'),
    )
    expect(script).toContain("trap 'exit 143' TERM")
    expect(script.indexOf('verify_explicit_allowlist post-install')).toBeLessThan(
      script.lastIndexOf('run_qwen_openclaw plugins inspect "$PLUGIN_ID" --runtime --json'),
    )
    expect(script.lastIndexOf('run_qwen_openclaw plugins inspect "$PLUGIN_ID" --runtime --json')).toBeLessThan(
      script.lastIndexOf('trap - EXIT HUP INT TERM'),
    )
  })
})
