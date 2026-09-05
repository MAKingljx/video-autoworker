import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  access, chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat,
  symlink, writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

const installerPath = resolve(
  process.cwd(),
  'scripts/install-aiworker-video-command-plugin.sh',
)
const targetSha = 'a'.repeat(40)
const privateFixtureMarker = ['video', 'result', 'private', 'fixture'].join('-')

async function createExecutable(pathname, source) {
  await writeFile(pathname, source, { mode: 0o755 })
  await chmod(pathname, 0o755)
}

async function createVideoInstallerFixture() {
  const root = await mkdtemp(resolve(tmpdir(), 'video-command-installer-'))
  const physicalRoot = await realpath(root)
  const repository = resolve(root, 'repository')
  const bin = resolve(root, 'bin')
  const home = resolve(root, 'home')
  const stateDir = resolve(home, '.openclaw-qwen-current')
  const installedPlugin = resolve(stateDir, 'extensions/aiworker-video-command')
  const runDir = resolve(physicalRoot, 'run')
  const videoBatchRoot = resolve(root, 'video-batches')
  const gateLog = resolve(root, 'gate.ndjson')
  const openclawLog = resolve(root, 'openclaw.ndjson')
  const liveDbPath = resolve(root, 'mission-control.db')
  const n8nDbPath = resolve(root, 'n8n.sqlite')
  await mkdir(resolve(repository, 'scripts/lib'), { recursive: true })
  await mkdir(resolve(repository, 'openclaw-plugins'), { recursive: true })
  await mkdir(bin, { recursive: true, mode: 0o700 })
  await mkdir(installedPlugin, { recursive: true })
  await mkdir(runDir, { recursive: true, mode: 0o700 })
  await mkdir(videoBatchRoot, { recursive: true, mode: 0o700 })
  for (const relative of [
    'scripts/install-aiworker-video-command-plugin.sh',
    'scripts/lib/openclaw-secret-reference.mjs',
    'scripts/lib/shared-deployment-lock.mjs',
    'scripts/lib/shared-deployment-lock.sh',
    'openclaw-plugins/aiworker-video-command',
  ]) {
    const destination = resolve(repository, relative)
    await mkdir(dirname(destination), { recursive: true })
    await cp(resolve(process.cwd(), relative), destination, { recursive: true })
  }
  await writeFile(resolve(repository, 'scripts/verify-shared-runtime-install-gate.mjs'), `
import fs from 'node:fs'
fs.appendFileSync(process.env.AIWORKER_TEST_GATE_LOG, JSON.stringify(process.argv.slice(2)) + '\\n')
if (process.env.AIWORKER_TEST_GATE_FAIL === '1') process.exit(77)
if (process.env.AIWORKER_TEST_GATE_PRODUCTION_REJECT === '1') {
  process.stderr.write('shared_runtime_install_not_ready:rolling_run_directory_not_canonical\\n')
  process.exit(78)
}
process.stdout.write(JSON.stringify({ mode: 'rolling' }) + '\\n')
`, { mode: 0o600 })
  await cp(resolve(repository, 'openclaw-plugins/aiworker-video-command'), installedPlugin, {
    recursive: true,
  })
  for (const name of ['package.json', 'openclaw.plugin.json']) {
    const pathname = resolve(installedPlugin, name)
    const value = JSON.parse(await readFile(pathname, 'utf8'))
    value.version = '0.5.13'
    await writeFile(pathname, JSON.stringify(value, null, 2) + '\n')
  }
  const secretProvider = resolve(bin, 'gateway-token')
  await createExecutable(secretProvider, '#!/bin/sh\nprintf "%064d\\n" 0\n')
  await writeFile(resolve(stateDir, 'openclaw.json'), JSON.stringify({
    gateway: {
      auth: {
        token: { source: 'exec', provider: 'fixture', id: 'gateway-token' },
      },
    },
    secrets: {
      providers: {
        fixture: { source: 'exec', command: secretProvider, args: [] },
      },
    },
    plugins: {
      entries: {
        'aiworker-video-command': {
          llm: { allowAgentIdOverride: true },
          config: {
            releaseReady: true,
            allowedSenderSha256: 'b'.repeat(64),
          },
        },
      },
    },
    agents: {
      list: [{
        id: 'second-original',
        workspace: resolve(root, 'workspace'),
        tools: { alsoAllow: ['aiworker_analyze_video'] },
      }],
    },
    privateFixture: { marker: privateFixtureMarker, body: 'private config body' },
  }, null, 2) + '\n', { mode: 0o600 })

  const live = new Database(liveDbPath)
  live.exec(`
    CREATE TABLE n8n_intake_controls (
      control_id INTEGER PRIMARY KEY, accepting INTEGER NOT NULL, revision INTEGER NOT NULL
    );
    INSERT INTO n8n_intake_controls VALUES (1, 0, 1);
    CREATE TABLE n8n_task_runs (
      id INTEGER PRIMARY KEY, task_id TEXT NOT NULL, source TEXT NOT NULL,
      status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE n8n_director_evidence_outbox (status TEXT NOT NULL);
  `)
  live.close()
  const n8n = new Database(n8nDbPath)
  n8n.exec('CREATE TABLE execution_entity (id INTEGER PRIMARY KEY, status TEXT NOT NULL, "stoppedAt" INTEGER);')
  n8n.close()
  await chmod(liveDbPath, 0o600)
  await chmod(n8nDbPath, 0o600)
  await writeFile(gateLog, '', { mode: 0o600 })
  await writeFile(openclawLog, '', { mode: 0o600 })

  await createExecutable(resolve(bin, 'id'), '#!/bin/sh\nprintf "heisenbergs-1\\n"\n')
  await createExecutable(resolve(bin, 'hostname'), '#!/bin/sh\nprintf "HEISENBERGS-1deMac-Studio.local\\n"\n')
  await createExecutable(resolve(bin, 'lsof'), '#!/bin/sh\nprintf "12345\\n"\n')
  await createExecutable(resolve(bin, 'git'), `#!${process.execPath}
const args = process.argv.slice(2)
const target = process.env.AIWORKER_TEST_TARGET_SHA
if (args.includes('remote') && args.includes('get-url')) console.log('https://github.com/MAKingljx/video-autoworker.git')
else if (args.includes('symbolic-ref')) console.log('main')
else if (args.includes('status') || args.includes('fetch')) {}
else if (args.includes('rev-parse')) console.log(target)
else if (args.includes('ls-remote')) console.log(target + '\\trefs/heads/main')
else process.exit(90)
`)
  await createExecutable(resolve(bin, 'openclaw'), `#!${process.execPath}
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
if (args.length === 1 && args[0] === '--version') {
  console.log('OpenClaw 2026.7.1-2 (fixture)')
  process.exit(0)
}
fs.appendFileSync(process.env.AIWORKER_TEST_OPENCLAW_LOG, JSON.stringify(args) + '\\n')
const state = path.join(process.env.HOME, '.openclaw-qwen-current')
const installed = path.join(state, 'extensions', 'aiworker-video-command')
const command = args.slice(2)
if (command[0] === 'plugins' && command[1] === 'install') {
  if (process.env.AIWORKER_TEST_OPENCLAW_INSTALL_FAIL === '1') process.exit(81)
  fs.rmSync(installed, { recursive: true, force: true })
  fs.cpSync(command.at(-1), installed, { recursive: true })
  console.log('{"installed":true}')
} else if (command[0] === 'plugins' && command[1] === 'inspect') {
  const version = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8')).version
  console.log(JSON.stringify({
    plugin: { id: 'aiworker-video-command', status: 'loaded', version },
    typedHooks: [{ name: 'before_dispatch' }],
    tools: [{ names: ['aiworker_analyze_video'] }],
    diagnostics: [],
  }))
} else if (command[0] === 'gateway' && command[1] === 'call') {
  console.log(JSON.stringify({
    agentId: 'second-original',
    groups: [{ pluginId: 'aiworker-video-command', source: 'plugin', tools: [{
      id: 'aiworker_analyze_video', pluginId: 'aiworker-video-command',
      source: 'plugin', optional: true,
    }] }],
  }))
} else if (command[0] === 'gateway' && ['status', 'restart'].includes(command[1])) {
  console.log('{"ok":true}')
} else process.exit(82)
`)
  const environment = {
    ...process.env,
    HOME: home,
    PATH: [bin, dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter),
    AIWORKER_TEST_TARGET_SHA: targetSha,
    AIWORKER_TEST_GATE_LOG: gateLog,
    AIWORKER_TEST_OPENCLAW_LOG: openclawLog,
    AIWORKER_BG_RUN_DIR: runDir,
    AIWORKER_BG_LIVE_DB_PATH: liveDbPath,
    AIWORKER_BG_N8N_DB_PATH: n8nDbPath,
    AIWORKER_VIDEO_BATCH_DIR: videoBatchRoot,
    AIWORKER_INSTALLER_ISOLATED_TEST_ROOT: physicalRoot,
    NODE_ENV: 'test',
  }
  return {
    root,
    repository,
    installer: resolve(repository, 'scripts/install-aiworker-video-command-plugin.sh'),
    stateDir,
    installedPlugin,
    backupRoot: resolve(home, 'ai-worker/backups/aiworker-video-command'),
    gateLog,
    openclawLog,
    environment,
  }
}

async function runFixtureInstaller(fixture, ...args) {
  try {
    return await execFileAsync('bash', [
      ...(process.env.AIWORKER_TEST_INSTALLER_TRACE === '1' ? ['-x'] : []),
      fixture.installer, ...args, '--target-sha', targetSha,
    ], {
      encoding: 'utf8',
      env: fixture.environment,
    })
  } catch (error) {
    const detail = error && typeof error === 'object' && 'stderr' in error
      ? String(error.stderr) : ''
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${detail}`)
  }
}

async function readJson(pathname) {
  return JSON.parse(await readFile(pathname, 'utf8'))
}

async function fileSha256(pathname) {
  return createHash('sha256').update(await readFile(pathname)).digest('hex')
}

async function pathExists(pathname) {
  try { await access(pathname); return true } catch { return false }
}

async function waitForPath(pathname, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await pathExists(pathname)) return
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20))
  }
  throw new Error(`timed out waiting for ${pathname}`)
}

async function openclawCalls(fixture) {
  const source = await readFile(fixture.openclawLog, 'utf8')
  return source.trim() === '' ? [] : source.trim().split('\n').map(line => JSON.parse(line))
}

describe('current video-command plugin installer', () => {
  it('owns the only supported current release path', async () => {
    const script = await readFile(installerPath, 'utf8')

    expect(script).toContain('PROFILE="qwen-current"')
    expect(script).toContain('AGENT_ID="second-original"')
    expect(script).toContain('SUPPORTED_PREVIOUS_VERSIONS=("0.5.8" "0.5.9" "0.5.10" "0.5.11" "0.5.12" "0.5.13")')
    expect(script).toContain('is_supported_previous_version "$installed_version"')
    expect(script).toContain('CURRENT_VERSION="0.5.14"')
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
    expect(script).toContain('run_qwen_openclaw_gateway_call tools.catalog')
    // Provider validation and execution bounds are exercised by the shared
    // adapter's behavior tests; the installer must delegate to that adapter.
    expect(script).toContain('node "$REPOSITORY_ROOT/scripts/lib/openclaw-secret-reference.mjs" "$PROFILE_CONFIG"')
    expect(script).toContain('OPENCLAW_GATEWAY_TOKEN="$gateway_token"')
    expect(script).toContain('Unable to resolve the qwen-current Gateway token through its configured exec SecretRef.')
    expect(script).toContain('optional direct tool exactly once through alsoAllow')
    expect(script).not.toContain('--token "$gateway_token"')
    const ordinaryRunner = script.slice(
      script.indexOf('run_qwen_openclaw() {'),
      script.indexOf('resolve_gateway_token() {'),
    )
    expect(ordinaryRunner).not.toContain('resolve_gateway_token')
    expect(ordinaryRunner).not.toContain('OPENCLAW_GATEWAY_TOKEN')
    expect(script).toContain('Current plugin %s is already installed and passed runtime validation.')
    expect(script).toContain('acquire_shared_deployment_lock')
    expect(script).toContain('release_shared_deployment_lock')
    expect(script).toContain('--mission-control-db-path "$MISSION_CONTROL_DB_PATH"')
    expect(script).toContain('--n8n-db-path "$N8N_DB_PATH"')
    expect(script).toContain('--expected-source-commit "$EXPECTED_SOURCE_COMMIT"')
    expect(script).toContain('--expected-release-id "$EXPECTED_RELEASE_ID"')
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

  it('writes bound apply, no-op, and rollback results while regular apply still restarts', async () => {
    const fixture = await createVideoInstallerFixture()
    try {
      const applyOutput = resolve(fixture.root, 'apply.json')
      const noopOutput = resolve(fixture.root, 'noop.json')
      const rollbackOutput = resolve(fixture.root, 'rollback.json')
      const repeatedRollbackOutput = resolve(fixture.root, 'rollback-repeated.json')
      const noopRollbackOutput = resolve(fixture.root, 'rollback-noop.json')
      await runFixtureInstaller(fixture, '--apply', '--result-output', applyOutput)
      const applied = await readJson(applyOutput)
      expect((await stat(applyOutput)).mode & 0o777).toBe(0o600)
      expect(applied).toMatchObject({
        schema: 'video-autoworker-installer-result/v1',
        component: 'video-command',
        operation: 'apply',
        status: 'applied',
        sourceCommit: targetSha,
        targetReleaseId: `${targetSha}-runtime`,
        requiresFreshRestart: false,
      })
      expect(applied.beforeManifestSha256).toMatch(/^[a-f0-9]{64}$/u)
      expect(applied.afterManifestSha256).toMatch(/^[a-f0-9]{64}$/u)
      expect(applied.beforeManifestSha256).not.toBe(applied.afterManifestSha256)
      expect(applied.backup.manifestSha256).toBe(await fileSha256(resolve(
        applied.backup.path,
        'MANIFEST.sha256',
      )))
      const resultSource = await readFile(applyOutput, 'utf8')
      expect(resultSource).not.toContain(privateFixtureMarker)
      expect(resultSource).not.toContain('private config body')

      await runFixtureInstaller(
        fixture, '--rollback', '--noop', '--result-output', noopRollbackOutput,
      )
      expect(await readJson(noopRollbackOutput)).toMatchObject({
        component: 'video-command', operation: 'rollback', status: 'restored',
        backup: null, requiresFreshRestart: false,
        beforeManifestSha256: applied.afterManifestSha256,
        afterManifestSha256: applied.afterManifestSha256,
      })

      await runFixtureInstaller(fixture, '--apply', '--result-output', noopOutput)
      const noop = await readJson(noopOutput)
      expect(noop).toMatchObject({
        component: 'video-command',
        operation: 'apply',
        status: 'noop',
        backup: null,
        requiresFreshRestart: false,
      })
      expect(noop.beforeManifestSha256).toBe(noop.afterManifestSha256)
      expect(noop.beforeManifestSha256).toBe(applied.afterManifestSha256)

      await runFixtureInstaller(
        fixture,
        '--rollback', '--backup', applied.backup.path,
        '--result-output', rollbackOutput,
      )
      const rolledBack = await readJson(rollbackOutput)
      expect(rolledBack).toMatchObject({
        component: 'video-command',
        operation: 'rollback',
        status: 'restored',
        backup: applied.backup,
        requiresFreshRestart: false,
      })
      expect(rolledBack.beforeManifestSha256).toBe(applied.afterManifestSha256)
      expect(rolledBack.afterManifestSha256).toBe(applied.beforeManifestSha256)

      await runFixtureInstaller(
        fixture,
        '--rollback', '--backup', applied.backup.path,
        '--result-output', repeatedRollbackOutput,
      )
      const repeatedRollback = await readJson(repeatedRollbackOutput)
      expect(repeatedRollback).toMatchObject({
        component: 'video-command',
        operation: 'rollback',
        status: 'restored',
        backup: applied.backup,
        requiresFreshRestart: false,
      })
      expect(repeatedRollback.beforeManifestSha256)
        .toBe(repeatedRollback.afterManifestSha256)

      const calls = await openclawCalls(fixture)
      expect(calls.filter(args => args.slice(2, 4).join(' ') === 'gateway restart')).toHaveLength(2)
      const gates = (await readFile(fixture.gateLog, 'utf8')).trim().split('\n')
        .map(line => JSON.parse(line))
      expect(gates.some(args => args.includes('--operation') && args.includes('install')
        && args.includes('--component') && args.includes('video-command'))).toBe(true)
      expect(gates.some(args => args.includes('--operation') && args.includes('rollback'))).toBe(true)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  }, 30_000)

  it('creates no persistent installer state when the shared gate rejects', async () => {
    const fixture = await createVideoInstallerFixture()
    try {
      const beforeConfig = await fileSha256(resolve(fixture.stateDir, 'openclaw.json'))
      const beforePlugin = await fileSha256(resolve(fixture.installedPlugin, 'package.json'))
      const result = resolve(fixture.root, 'gate-rejected.json')
      fixture.environment.AIWORKER_TEST_GATE_FAIL = '1'
      await expect(runFixtureInstaller(
        fixture, '--apply', '--result-output', result,
      )).rejects.toThrow()
      expect(await fileSha256(resolve(fixture.stateDir, 'openclaw.json'))).toBe(beforeConfig)
      expect(await fileSha256(resolve(fixture.installedPlugin, 'package.json'))).toBe(beforePlugin)
      expect(await pathExists(fixture.backupRoot)).toBe(false)
      expect(await pathExists(resolve(
        fixture.stateDir, '.aiworker-video-command-install.lock',
      ))).toBe(false)
      expect(await pathExists(result)).toBe(false)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects production mutation when fake databases, batch root, and deployment lock are injected', async () => {
    const fixture = await createVideoInstallerFixture()
    try {
      const beforeConfig = await fileSha256(resolve(fixture.stateDir, 'openclaw.json'))
      const beforePlugin = await fileSha256(resolve(fixture.installedPlugin, 'package.json'))
      const result = resolve(fixture.root, 'fake-runtime-result.json')
      const environment = {
        ...fixture.environment,
        AIWORKER_INSTALLER_ISOLATED_TEST_ROOT: '',
        AIWORKER_VIDEO_BATCH_DIR: resolve(
          fixture.environment.HOME, 'ai-worker/state/video-autoworker/video-batches',
        ),
        AIWORKER_TEST_GATE_PRODUCTION_REJECT: '1',
        NODE_ENV: 'production',
      }
      await expect(execFileAsync('bash', [
        fixture.installer, '--apply', '--target-sha', targetSha,
        '--result-output', result,
      ], { encoding: 'utf8', env: environment })).rejects.toMatchObject({
        stderr: expect.stringContaining(
          'shared_runtime_install_not_ready:rolling_run_directory_not_canonical',
        ),
      })
      expect(await fileSha256(resolve(fixture.stateDir, 'openclaw.json'))).toBe(beforeConfig)
      expect(await fileSha256(resolve(fixture.installedPlugin, 'package.json'))).toBe(beforePlugin)
      expect(await pathExists(fixture.backupRoot)).toBe(false)
      expect(await pathExists(resolve(
        fixture.stateDir, '.aiworker-video-command-install.lock',
      ))).toBe(false)
      expect(await pathExists(result)).toBe(false)
      expect((await readFile(fixture.gateLog, 'utf8')).trim()).not.toBe('')
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('recovers a real SIGKILL after the first mutation using the stale journal', async () => {
    const fixture = await createVideoInstallerFixture()
    const syncDir = resolve(fixture.root, 'sync')
    try {
      await mkdir(syncDir)
      const environment = {
        ...fixture.environment,
        AIWORKER_VIDEO_COMMAND_INSTALL_TESTING: '1',
        AIWORKER_VIDEO_COMMAND_INSTALL_TEST_FAILPOINT: 'sigkill-after-first-mutation',
        AIWORKER_VIDEO_COMMAND_INSTALL_TEST_SYNC_DIR: syncDir,
      }
      const attempt = spawn('bash', [fixture.installer, '--apply', '--target-sha', targetSha], {
        env: environment,
        stdio: 'ignore',
      })
      await waitForPath(resolve(syncDir, 'sigkill-ready'))
      attempt.kill('SIGKILL')
      await new Promise(resolvePromise => attempt.once('close', resolvePromise))
      await runFixtureInstaller(fixture, '--apply')
      expect(JSON.parse(await readFile(
        resolve(fixture.installedPlugin, 'package.json'), 'utf8',
      )).version).toBe('0.5.14')
      expect(await pathExists(resolve(
        fixture.stateDir, '.aiworker-video-command-install.lock',
      ))).toBe(false)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  }, 30_000)

  it('rejects rollback source replacement before its private claim', async () => {
    const fixture = await createVideoInstallerFixture()
    const syncDir = resolve(fixture.root, 'sync')
    try {
      await mkdir(syncDir)
      const applyOutput = resolve(fixture.root, 'apply-for-race.json')
      await runFixtureInstaller(fixture, '--apply', '--result-output', applyOutput)
      const backup = (await readJson(applyOutput)).backup.path
      const moved = `${backup}.verified-source`
      const attempt = spawn('bash', [fixture.installer,
        '--rollback', '--backup', backup, '--target-sha', targetSha,
      ], {
        env: {
          ...fixture.environment,
          AIWORKER_VIDEO_COMMAND_INSTALL_TESTING: '1',
          AIWORKER_VIDEO_COMMAND_INSTALL_TEST_FAILPOINT: 'rollback-source-before-claim',
          AIWORKER_VIDEO_COMMAND_INSTALL_TEST_SYNC_DIR: syncDir,
        },
        stdio: 'ignore',
      })
      await waitForPath(resolve(syncDir, 'rollback-source-ready'))
      await rename(backup, moved)
      await mkdir(backup, { mode: 0o700 })
      await writeFile(resolve(backup, 'MANIFEST.sha256'), 'unverified replacement\n')
      await writeFile(resolve(syncDir, 'rollback-source-continue'), 'continue\n')
      const exitCode = await new Promise(resolvePromise => attempt.once('close', resolvePromise))
      expect(exitCode).not.toBe(0)
      expect(JSON.parse(await readFile(
        resolve(fixture.installedPlugin, 'package.json'), 'utf8',
      )).version).toBe('0.5.14')
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  }, 30_000)

  it('defers only the orchestrated apply restart and rejects occupied result outputs', async () => {
    const fixture = await createVideoInstallerFixture()
    try {
      const attemptDir = resolve(fixture.root, 'preinstall-attempt')
      const deferredOutput = resolve(fixture.root, 'deferred.json')
      const deferredRollbackOutput = resolve(fixture.root, 'deferred-rollback.json')
      await mkdir(attemptDir, { mode: 0o700 })
      fixture.environment.AIWORKER_BG_LEGACY_PREINSTALL_ATTEMPT_DIR = attemptDir
      await runFixtureInstaller(
        fixture,
        '--apply', '--defer-gateway-restart', '--result-output', deferredOutput,
      )
      const deferred = await readJson(deferredOutput)
      expect(deferred).toMatchObject({
        operation: 'apply',
        status: 'applied',
        requiresFreshRestart: true,
      })
      expect((await openclawCalls(fixture))
        .filter(args => args.slice(2, 4).join(' ') === 'gateway restart')).toHaveLength(0)
      await runFixtureInstaller(
        fixture,
        '--rollback', '--backup', deferred.backup.path,
        '--defer-gateway-restart', '--result-output', deferredRollbackOutput,
      )
      const deferredRollback = await readJson(deferredRollbackOutput)
      expect(deferredRollback).toMatchObject({
        operation: 'rollback',
        status: 'restored',
        backup: deferred.backup,
        requiresFreshRestart: true,
      })
      expect(deferredRollback.beforeManifestSha256).toBe(deferred.afterManifestSha256)
      expect(deferredRollback.afterManifestSha256).toBe(deferred.beforeManifestSha256)
      expect((await openclawCalls(fixture))
        .filter(args => args.slice(2, 4).join(' ') === 'gateway restart')).toHaveLength(0)

      const occupied = resolve(fixture.root, 'occupied.json')
      const symlinkTarget = resolve(fixture.root, 'symlink-target.json')
      const symlinkOutput = resolve(fixture.root, 'symlink-result.json')
      await writeFile(occupied, 'tampered result\n', { mode: 0o600 })
      await writeFile(symlinkTarget, 'do not follow\n', { mode: 0o600 })
      await symlink(symlinkTarget, symlinkOutput)
      for (const output of [occupied, symlinkOutput]) {
        await expect(runFixtureInstaller(
          fixture,
          '--apply', '--result-output', output,
        )).rejects.toThrow()
      }
      expect(await readFile(occupied, 'utf8')).toBe('tampered result\n')
      expect(await readFile(symlinkTarget, 'utf8')).toBe('do not follow\n')
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  }, 30_000)
})
