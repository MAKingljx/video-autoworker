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
    expect(script).toContain('EXPECTED_USER="heisenbergs-1"')
    expect(script).toContain('EXPECTED_HOST="HEISENBERGS-1deMac-Studio.local"')
    expect(script).toContain('plugins install --force "$PLUGIN_DIR"')
    expect(script).toContain('plugins validate --root "$PLUGIN_DIR" --entry index.js')
    expect(script).toContain('verify_explicit_allowlist pre-install')
    expect(script).toContain('verify_explicit_allowlist post-install')
    expect(script).toContain('!allow.includes(process.argv[3])')
    expect(script).toContain('[[ ! -d "$INSTALLED_PLUGIN_DIR" ]]')
    expect(script).toContain('"$PLUGIN_DIR/lib/before-dispatch.js"')
    expect(script).not.toContain('inbound-claim.js')
    expect(script).not.toMatch(/gateway (?:restart|start|stop)|launchctl|npm\/dist/iu)
  })

  it('defaults to dry-run and backs up config plus any installed extension', async () => {
    const script = await readFile(installerPath, 'utf8')
    expect(script).toContain('MODE="dry-run"')
    expect(script).toContain('install -d -m 700 "$backup_dir"')
    expect(script).toContain('install -m 600 "$PROFILE_CONFIG" "$backup_dir/openclaw.json"')
    expect(script).toContain('cp -R -p "$INSTALLED_PLUGIN_DIR" "$backup_dir/extension"')
    expect(script).toContain('install -m 600 "$backup_dir/openclaw.json" "$PROFILE_CONFIG"')
    expect(script).toContain('mv "$INSTALLED_PLUGIN_DIR" "$backup_dir/failed-installed-extension"')
    expect(script.indexOf('trap restore_failed_install ERR')).toBeLessThan(
      script.indexOf('verify_explicit_allowlist post-install'),
    )
    expect(script.indexOf('verify_explicit_allowlist post-install')).toBeLessThan(
      script.indexOf('trap - ERR'),
    )
  })
})
