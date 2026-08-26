import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const installerPath = resolve(
  process.cwd(),
  'scripts/install-aiworker-video-command-plugin.sh',
)

describe('current video-command plugin installer', () => {
  it('owns the only supported current release path', async () => {
    const script = await readFile(installerPath, 'utf8')

    expect(script).toContain('PROFILE="qwen-current"')
    expect(script).toContain('AGENT_ID="second-original"')
    expect(script).toContain('SUPPORTED_PREVIOUS_VERSIONS=("0.5.8" "0.5.9" "0.5.10" "0.5.11")')
    expect(script).toContain('is_supported_previous_version "$installed_version"')
    expect(script).toContain('CURRENT_VERSION="0.5.12"')
    expect(script).toContain('EXPECTED_USER="heisenbergs-1"')
    expect(script).toContain('EXPECTED_HOST="HEISENBERGS-1deMac-Studio.local"')
    expect(script).toContain('validate_git_target')
    expect(script).toContain('HEAD, origin/main, live GitHub main, and target SHA must match.')
    expect(script).toContain('run_qwen_openclaw plugins install --force "$PLUGIN_DIR"')
    expect(script).toContain('run_qwen_openclaw gateway restart --wait 60s --json')
    expect(script).toContain('validate-runtime-inspection.mjs')
    expect(script).toContain('validate_runtime_payload_matches')
    expect(script).toContain('installed runtime payload differs from the canonical source')
    expect(script).toContain('delete pluginConfig.allowedSenderSha256')
    expect(script).toContain('plugin config schema must contain only the current release gate')
    expect(script).toContain('tools.catalog')
    expect(script).toContain('Current plugin %s is already installed and passed runtime validation.')
  })

  it('preserves config and creates a verified explicit rollback point', async () => {
    const script = await readFile(installerPath, 'utf8')

    expect(script).toContain('current-release-')
    expect(script).toContain('write_backup_manifest')
    expect(script).toContain('verify_backup')
    expect(script).toContain('MANIFEST.sha256')
    expect(script).toContain('install -m 600 "$MIGRATED_CONFIG" "$PROFILE_CONFIG"')
    expect(script).toContain('restore_backup "$BACKUP_DIR"')
    expect(script).toContain('validate_config_migration')
    expect(script).toContain('fs.writeFileSync(outputPath')
    expect(script).not.toContain('config unset')
    expect(script).toContain('> "$WORK_ROOT/restore-install.txt" 2>&1 || return 1')
    expect(script.indexOf('install -m 600 "$MIGRATED_CONFIG" "$PROFILE_CONFIG"'))
      .toBeLessThan(script.indexOf('run_qwen_openclaw plugins install --force "$PLUGIN_DIR"'))
    expect(script).toContain('ROLLBACK FAILED')
    expect(script).toContain('[[ "$(listener_snapshot)" == "$BEFORE_LISTENERS" ]]')
    expect(script).toContain('for candidate in "${backups[@]:0:$remove_count}"')
    expect(script).toContain('verify_backup "$candidate" >/dev/null')
  })

  it('does not operate the queue, scheduler, n8n, media, or database', async () => {
    const script = await readFile(installerPath, 'utf8')

    expect(script).not.toMatch(/run-video-batch|launchctl|n8n-import|sqlite3|media-inbox/iu)
    expect(script).not.toContain('upgrade-aiworker-video-command')
    expect(script).not.toContain('validate-aiworker-video-command-upgrade')
    expect(script).not.toContain('direct-tool-access-policy')
    expect(script).toContain(
      'No plugin, config, gateway, queue, n8n, media, database, or scheduler state changed.',
    )
  })
})
