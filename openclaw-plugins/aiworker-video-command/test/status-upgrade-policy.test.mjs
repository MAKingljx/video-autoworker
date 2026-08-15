import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  enforceVerifiedBackupRetention,
  fingerprintPluginPayload,
  validateVerifiedBackupRetentionBaseline,
} from '../../../scripts/lib/aiworker-video-command-upgrade-policy.mjs'
import {
  buildBackupMetadata,
  fingerprintConfig,
  fingerprintInstalledPayload,
  validateStatusUpgradeBackup,
  validateStatusUpgradeVersion,
  validateClassifierConfig,
  validateClassifierConfigTransition,
  buildActiveClassifierConfig,
  buildClassifierCandidateConfig,
} from '../../../scripts/validate-aiworker-video-status-upgrade.mjs'

const roots = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function createFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'video-status-upgrade-')))
  roots.push(root)
  const backupRoot = join(root, 'backups')
  const backupDir = join(backupRoot, 'status-upgrade-20260811-010203.abc123')
  const source = join(root, 'repo', 'openclaw-plugins', 'aiworker-video-command')
  const installed = join(root, 'profile', 'extensions', 'aiworker-video-command')
  const previous = join(backupDir, 'previous-plugin')
  const peer = join(root, 'openclaw-peer')
  await mkdir(backupDir, { recursive: true, mode: 0o700 })
  await mkdir(source, { recursive: true })
  await mkdir(installed, { recursive: true })
  await mkdir(previous, { recursive: true })
  await mkdir(peer)
  for (const plugin of [source, installed, previous]) {
    await writeFile(join(plugin, 'index.js'), 'export default {}\n')
    await writeFile(join(plugin, 'openclaw.plugin.json'), '{"id":"aiworker-video-command"}\n')
  }
  await writeFile(join(source, 'package.json'), '{"version":"0.5.0"}\n')
  for (const plugin of [installed, previous]) {
    await writeFile(join(plugin, 'package.json'), '{"version":"0.4.1"}\n')
    await mkdir(join(plugin, 'node_modules'))
    await symlink(peer, join(plugin, 'node_modules', 'openclaw'), 'dir')
  }
  const config = join(backupDir, 'openclaw.json')
  await writeFile(config, JSON.stringify({
    plugins: { allow: ['aiworker-video-command'], entries: {
      'aiworker-video-command': { enabled: true, config: { allowedSenderSha256: 'a'.repeat(64) } },
    } },
    agents: { list: [{ id: 'second-original', tools: { profile: 'standard', allow: ['read'] } }] },
  }), { mode: 0o600 })
  const peerRealPath = await realpath(peer)
  const previousPayload = await fingerprintInstalledPayload(previous)
  const metadata = buildBackupMetadata({
    pluginId: 'aiworker-video-command',
    candidateVersion: '0.5.0',
    targetSha: 'a'.repeat(40),
    canonicalSourcePath: source,
    installedPath: installed,
    sourcePayloadSha256: await fingerprintPluginPayload(source),
    previousPayloadSha256: previousPayload.fingerprint,
    configSha256: await fingerprintConfig(config),
    peerLinkText: peer,
    peerRealPath,
    createdAt: '2026-08-11T01:02:03.000Z',
  })
  await writeFile(join(backupDir, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 })
  await writeFile(join(backupDir, '.verified'), '', { mode: 0o600 })
  return { backupRoot, backupDir, source, installed, config }
}

describe('0.4.1 to 0.5.0 classifier upgrade policy', () => {
  it('permits only the fixed 0.5.0 release boundary with matching package and manifest versions', () => {
    expect(validateStatusUpgradeVersion('0.5.0', '0.5.0')).toBe('0.5.0')
    expect(() => validateStatusUpgradeVersion('0.5.0', '0.4.1')).toThrow(/versions must match/u)
    for (const value of ['0.4.1', '0.5.1', '1.0.0', 'latest']) {
      expect(() => validateStatusUpgradeVersion(value, value)).toThrow(/exactly 0\.5\.0/u)
    }
  })

  it('validates a complete 0.4.1 payload/config recovery point and rejects later drift', async () => {
    const fixture = await createFixture()
    await expect(validateStatusUpgradeBackup({
      backupRoot: fixture.backupRoot,
      backupDir: fixture.backupDir,
      targetSha: 'a'.repeat(40),
      candidateVersion: '0.5.0',
      canonicalSourcePath: fixture.source,
      installedPath: fixture.installed,
    })).resolves.toMatchObject({ metadata: { previousVersion: '0.4.1', candidateVersion: '0.5.0' } })
    await writeFile(fixture.config, '{"tampered":true}\n', { mode: 0o600 })
    await expect(validateStatusUpgradeBackup({
      backupRoot: fixture.backupRoot,
      backupDir: fixture.backupDir,
      targetSha: 'a'.repeat(40),
      candidateVersion: '0.5.0',
      canonicalSourcePath: fixture.source,
      installedPath: fixture.installed,
    })).rejects.toThrow(/config changed/u)
  })

  it('keeps the release entry limited to explicit SHA, qwen-current, and protected listeners', async () => {
    const script = await readFile(resolve(process.cwd(), 'scripts/upgrade-aiworker-video-command-status-plugin.sh'), 'utf8')
    expect(script).toContain('--target-sha')
    expect(script).toContain('PREVIOUS_VERSION="0.4.1"')
    expect(script).toContain('PREVIOUS_SOURCE_SHA="e615d8dc68d089f11afe1581c1f56c614e01b796"')
    expect(script).toContain('HEAD, local origin/main, live GitHub main, and target SHA must match.')
    expect(script).toContain('gateway restart --wait 60s')
    expect(script).toContain('for port in 3017 5678 5679 18091 18789 18989')
    expect(script).toContain('backup-retention-enforce')
    expect(script).toContain('runtime-hook-only')
    expect(script).toContain('live-hook-only')
    expect(script).toContain('rm -f -- "$backup_dir/.verified"')
    expect(script).toContain('recover_candidate_after_failed_explicit_rollback')
    expect(script).toContain('validate_installed_candidate "$report_dir/installed"')
    expect(script).toContain('validate_live_candidate "$report_dir/live"')
    expect(script).toContain('plugins install --force')
    expect(script).toContain('plugins.entries.%s.config.releaseReady=false')
    expect(script).toContain('The candidate release gate remains closed.')
    expect(script).toContain('install and verify task-flow schema v2 and the lane supervisor')
    expect(script).toContain('Only qwen-current was refreshed; Mission Control 3017 and n8n were untouched.')
    expect(script).not.toContain('restore_v03')
    expect(script).not.toMatch(/launchctl|kickstart|:3017.*restart|:5678.*restart/iu)
  })

  it('allows only the closed release gate and llm additions while preserving sender hash and target tools', async () => {
    const fixture = await createFixture()
    const candidate = join(fixture.backupRoot, 'candidate.json')
    const parsed = JSON.parse(await readFile(fixture.config, 'utf8'))
    parsed.plugins.entries['aiworker-video-command'].llm = { allowAgentIdOverride: true }
    parsed.plugins.entries['aiworker-video-command'].config.releaseReady = false
    await writeFile(candidate, `${JSON.stringify(parsed)}\n`, { mode: 0o600 })
    await expect(validateClassifierConfig({ pathname: fixture.config, mode: 'baseline' }))
      .resolves.toMatchObject({ mode: 'baseline' })
    await expect(validateClassifierConfig({ pathname: candidate, mode: 'candidate' }))
      .resolves.toMatchObject({ mode: 'candidate' })
    await expect(validateClassifierConfigTransition({
      baselinePath: fixture.config, candidatePath: candidate,
    })).resolves.toMatchObject({
      changedPaths: [
        'plugins.entries.aiworker-video-command.llm',
        'plugins.entries.aiworker-video-command.config.releaseReady',
      ],
    })
    parsed.plugins.entries['aiworker-video-command'].llm.allowModelOverride = true
    await writeFile(candidate, `${JSON.stringify(parsed)}\n`, { mode: 0o600 })
    await expect(validateClassifierConfig({ pathname: candidate, mode: 'candidate' }))
      .rejects.toThrow(/exactly allowAgentIdOverride/u)
  })

  it('builds the canonical candidate without mutating the baseline object', async () => {
    const fixture = await createFixture()
    const baseline = JSON.parse(await readFile(fixture.config, 'utf8'))
    const candidate = buildClassifierCandidateConfig(baseline)
    expect(candidate.plugins.entries['aiworker-video-command'].llm)
      .toEqual({ allowAgentIdOverride: true })
    expect(candidate.plugins.entries['aiworker-video-command'].config.releaseReady).toBe(false)
    expect(baseline.plugins.entries['aiworker-video-command']).not.toHaveProperty('llm')
    expect(baseline.plugins.entries['aiworker-video-command'].config).not.toHaveProperty('releaseReady')

    const active = buildActiveClassifierConfig(candidate)
    expect(active.plugins.entries['aiworker-video-command'].config.releaseReady).toBe(true)
    expect(candidate.plugins.entries['aiworker-video-command'].config.releaseReady).toBe(false)
  })

  it('counts status-upgrade recovery points in the shared two-backup family', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'video-status-retention-')))
    roots.push(root)
    const names = [
      'status-upgrade-20260811-010201.aaaaaa',
      'upgrade-20260811-010202.bbbbbb',
      'status-upgrade-20260811-010203.cccccc',
    ]
    for (const name of names) {
      const directory = join(root, name)
      await mkdir(directory, { mode: 0o700 })
      await writeFile(join(directory, '.verified'), '', { mode: 0o600 })
    }
    await expect(validateVerifiedBackupRetentionBaseline(root, 2)).rejects.toThrow(/exceeds/u)
    const currentBackup = join(root, names[2])
    const result = await enforceVerifiedBackupRetention({
      backupRoot: root,
      currentBackup,
      activeSourcePath: null,
      maxBackups: 2,
    })
    expect(result.removed).toEqual([names[0]])
    await expect(validateVerifiedBackupRetentionBaseline(root, 2)).resolves.toMatchObject({ verifiedCount: 2 })
  })
})
