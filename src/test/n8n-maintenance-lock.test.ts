// @vitest-environment node

import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync,
  unlinkSync, utimesSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const projectRoot = resolve(import.meta.dirname, '../..')
const tool = join(projectRoot, 'scripts/n8n-maintenance-lock.mjs')
const start = join(projectRoot, 'scripts/n8n-start.sh')
const common = join(projectRoot, 'ops/n8n/lib/common.sh')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixtureRoot(name: string) {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), name)))
  chmodSync(root, 0o700)
  roots.push(root)
  return root
}

function lock(command: 'acquire' | 'release', pathname: string, owner: string, pid: number, nonce?: string) {
  return spawnSync(process.execPath, [tool, command, pathname, owner, String(pid), ...(nonce ? [nonce] : [])], {
    encoding: 'utf8',
  })
}

function crashAfterTerminal(
  command: 'acquire' | 'release', pathname: string, owner: string, pid: number, nonce?: string,
) {
  return spawnSync(process.execPath, [tool, command, pathname, owner, String(pid), ...(nonce ? [nonce] : [])], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      AIWORKER_TEST_MAINTENANCE_FAILPOINT: 'after-terminal-claim',
    },
  })
}

describe('n8n shared maintenance lock', () => {
  it('durably orders lock publication, quarantine, unlink, and directory removal', () => {
    const source = readFileSync(tool, 'utf8')
    const body = (name: string, next: string) => source.slice(
      source.indexOf(`function ${name}(`),
      source.indexOf(`function ${next}(`),
    )
    const terminal = body('terminalClaim', 'removeClaimed')
    expect(terminal.indexOf('fchmodSync(descriptor, 0o400)'))
      .toBeLessThan(terminal.indexOf('fsyncSync(descriptor)'))
    expect(terminal.indexOf('fsyncSync(descriptor)'))
      .toBeLessThan(terminal.indexOf('fsyncDirectory(lockPath, expectedEntry)'))

    const removal = body('removeClaimed', 'reapIfStale')
    expect(removal.indexOf('renameSync(lockPath, quarantine)'))
      .toBeLessThan(removal.indexOf('fsyncDirectory(parent)'))
    expect(removal.indexOf('fsyncDirectory(parent)'))
      .toBeLessThan(removal.indexOf('unlinkSync(join(quarantine, name))'))
    expect(removal.indexOf('unlinkSync(join(quarantine, name))'))
      .toBeLessThan(removal.indexOf('fsyncDirectory(quarantine, quarantined)'))
    expect(removal.indexOf('fsyncDirectory(quarantine, quarantined)'))
      .toBeLessThan(removal.indexOf('rmdirSync(quarantine)'))
    expect(removal.indexOf('rmdirSync(quarantine)'))
      .toBeLessThan(removal.lastIndexOf('fsyncDirectory(parent)'))

    const acquisition = body('acquire', 'release')
    expect(acquisition.indexOf('fsyncSync(descriptor)'))
      .toBeLessThan(acquisition.indexOf('fsyncDirectory(parent)'))
    expect(acquisition.indexOf('mkdirSync(lockPath'))
      .toBeLessThan(acquisition.indexOf('fsyncDirectory(lockPath, created)'))
    expect(acquisition.indexOf('renameSync(stagedLease, leasePath)'))
      .toBeLessThan(acquisition.lastIndexOf('fsyncDirectory(lockPath)'))
    expect(acquisition.lastIndexOf('fsyncDirectory(lockPath)'))
      .toBeLessThan(acquisition.lastIndexOf('fsyncDirectory(parent)'))
  })

  it('serializes start against an import holder and requires the exact release capability', () => {
    const root = fixtureRoot('n8n-maintenance-lock-')
    const pathname = join(root, '.n8n-maintenance.lock')
    const acquired = lock('acquire', pathname, 'import', process.pid)
    expect(acquired.status, acquired.stderr).toBe(0)
    const nonce = acquired.stdout.trim()
    const blocked = lock('acquire', pathname, 'start', process.pid)
    expect(blocked.status).not.toBe(0)
    expect(blocked.stderr).toContain('held by import')
    const forged = lock('release', pathname, 'import', process.pid, '0'.repeat(64))
    expect(forged.status).not.toBe(0)
    expect(existsSync(pathname)).toBe(true)
    expect(lock('release', pathname, 'import', process.pid, nonce).status).toBe(0)
    expect(existsSync(pathname)).toBe(false)
  })

  it('reclaims a structurally valid lease after its exact process identity exits', async () => {
    const root = fixtureRoot('n8n-maintenance-stale-')
    const pathname = join(root, '.n8n-maintenance.lock')
    const holder = spawn('/bin/sleep', ['60'])
    const acquired = lock('acquire', pathname, 'restore', holder.pid!)
    expect(acquired.status, acquired.stderr).toBe(0)
    holder.kill('SIGKILL')
    await new Promise<void>(resolvePromise => holder.once('exit', () => resolvePromise()))
    const reclaimed = lock('acquire', pathname, 'start', process.pid)
    expect(reclaimed.status, reclaimed.stderr).toBe(0)
    expect(lock('release', pathname, 'start', process.pid, reclaimed.stdout.trim()).status).toBe(0)
  })

  it('resumes a SIGKILL-interrupted release only for the exact live lease capability', () => {
    const root = fixtureRoot('n8n-maintenance-release-crash-')
    const pathname = join(root, '.n8n-maintenance.lock')
    const acquired = lock('acquire', pathname, 'import', process.pid)
    expect(acquired.status, acquired.stderr).toBe(0)
    const nonce = acquired.stdout.trim()
    const crashed = crashAfterTerminal('release', pathname, 'import', process.pid, nonce)
    expect(crashed.signal).toBe('SIGKILL')
    expect(readdirSync(pathname).sort()).toEqual(['.terminal', 'lease.json'])
    const competing = lock('acquire', pathname, 'start', process.pid)
    expect(competing.status).not.toBe(0)
    expect(competing.stderr).toContain('held by import')
    const forged = lock('release', pathname, 'import', process.pid, '0'.repeat(64))
    expect(forged.status).not.toBe(0)
    expect(lock('release', pathname, 'import', process.pid, nonce).status).toBe(0)
    expect(existsSync(pathname)).toBe(false)
  })

  it('resumes SIGKILL-interrupted stale and empty teardown across new processes', async () => {
    const staleRoot = fixtureRoot('n8n-maintenance-stale-crash-')
    const stalePath = join(staleRoot, '.n8n-maintenance.lock')
    const holder = spawn('/bin/sleep', ['60'])
    const acquired = lock('acquire', stalePath, 'restore', holder.pid!)
    expect(acquired.status, acquired.stderr).toBe(0)
    holder.kill('SIGKILL')
    await new Promise<void>(resolvePromise => holder.once('exit', () => resolvePromise()))
    const staleCrash = crashAfterTerminal('acquire', stalePath, 'start', process.pid)
    expect(staleCrash.signal).toBe('SIGKILL')
    expect(readdirSync(stalePath).sort()).toEqual(['.terminal', 'lease.json'])
    const recovered = lock('acquire', stalePath, 'start', process.pid)
    expect(recovered.status, recovered.stderr).toBe(0)
    expect(lock('release', stalePath, 'start', process.pid, recovered.stdout.trim()).status).toBe(0)

    const emptyRoot = fixtureRoot('n8n-maintenance-empty-crash-')
    const emptyPath = join(emptyRoot, '.n8n-maintenance.lock')
    mkdirSync(emptyPath, { mode: 0o700 })
    const old = new Date(Date.now() - 10_000)
    utimesSync(emptyPath, old, old)
    const emptyCrash = crashAfterTerminal('acquire', emptyPath, 'start', process.pid)
    expect(emptyCrash.signal).toBe('SIGKILL')
    expect(readdirSync(emptyPath)).toEqual(['.terminal'])
    const emptyRecovered = lock('acquire', emptyPath, 'start', process.pid)
    expect(emptyRecovered.status, emptyRecovered.stderr).toBe(0)
    expect(lock('release', emptyPath, 'start', process.pid, emptyRecovered.stdout.trim()).status).toBe(0)
  })

  it('fails closed for forged terminal markers and replaced terminal-bound leases', async () => {
    const forgedRoot = fixtureRoot('n8n-maintenance-forged-terminal-')
    const forgedPath = join(forgedRoot, '.n8n-maintenance.lock')
    mkdirSync(forgedPath, { mode: 0o700 })
    writeFileSync(join(forgedPath, '.terminal'), '{"schema":"forged"}\n', { mode: 0o400 })
    const forged = lock('acquire', forgedPath, 'start', process.pid)
    expect(forged.status).not.toBe(0)
    expect(forged.stderr).toContain('terminal marker')
    expect(existsSync(forgedPath)).toBe(true)

    const replacedRoot = fixtureRoot('n8n-maintenance-replaced-lease-')
    const replacedPath = join(replacedRoot, '.n8n-maintenance.lock')
    const holder = spawn('/bin/sleep', ['60'])
    expect(lock('acquire', replacedPath, 'restore', holder.pid!).status).toBe(0)
    holder.kill('SIGKILL')
    await new Promise<void>(resolvePromise => holder.once('exit', () => resolvePromise()))
    expect(crashAfterTerminal('acquire', replacedPath, 'start', process.pid).signal).toBe('SIGKILL')
    const leasePath = join(replacedPath, 'lease.json')
    const leaseSource = readFileSync(leasePath)
    unlinkSync(leasePath)
    writeFileSync(leasePath, leaseSource, { mode: 0o400 })
    chmodSync(leasePath, 0o400)
    const replaced = lock('acquire', replacedPath, 'start', process.pid)
    expect(replaced.status).not.toBe(0)
    expect(replaced.stderr).toContain('lease binding changed')
    expect(existsSync(replacedPath)).toBe(true)
  })

  it('fails closed for an unknown holder without deleting its evidence', () => {
    const root = fixtureRoot('n8n-maintenance-unknown-')
    const pathname = join(root, '.n8n-maintenance.lock')
    mkdirSync(pathname, { mode: 0o700 })
    writeFileSync(join(pathname, 'unknown'), 'do-not-remove\n', { mode: 0o600 })
    const rejected = lock('acquire', pathname, 'start', process.pid)
    expect(rejected.status).not.toBe(0)
    expect(rejected.stderr).toContain('unknown maintenance lock holder')
    expect(readFileSync(join(pathname, 'unknown'), 'utf8')).toBe('do-not-remove\n')
  })

  it('recovers an abandoned empty initialization lock after the bounded grace period', () => {
    const root = fixtureRoot('n8n-maintenance-empty-')
    const pathname = join(root, '.n8n-maintenance.lock')
    mkdirSync(pathname, { mode: 0o700 })
    const old = new Date(Date.now() - 10_000)
    utimesSync(pathname, old, old)
    const recovered = lock('acquire', pathname, 'start', process.pid)
    expect(recovered.status, recovered.stderr).toBe(0)
    expect(lock('release', pathname, 'start', process.pid, recovered.stdout.trim()).status).toBe(0)
  })

  it('excludes live and legacy runtime locks from state backup members', () => {
    const root = fixtureRoot('n8n-maintenance-archive-')
    const state = join(root, 'state')
    const archive = join(root, 'state.tar.gz')
    mkdirSync(join(state, '.n8n-maintenance.lock'), { recursive: true, mode: 0o700 })
    mkdirSync(join(state, '.managed-workflow-restore.lock'), { mode: 0o700 })
    writeFileSync(join(state, '.n8n-maintenance.lock/lease.json'), '{}\n', { mode: 0o400 })
    writeFileSync(join(state, 'database.sqlite'), 'preserve-me\n', { mode: 0o600 })
    const harness = spawnSync('/bin/bash', ['-c', `source "$1"; n8n_archive_state_without_runtime_locks "$2" "$3"`, '_', common, state, archive], {
      encoding: 'utf8',
    })
    expect(harness.status, harness.stderr).toBe(0)
    const members = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' })
    expect(members.status, members.stderr).toBe(0)
    expect(members.stdout).toContain('state/database.sqlite')
    expect(members.stdout).not.toContain('.n8n-maintenance.lock')
    expect(members.stdout).not.toContain('.managed-workflow-restore.lock')
  })

  it('prevents the real foreground start wrapper from crossing an offline import window', () => {
    const root = fixtureRoot('n8n-maintenance-start-race-')
    const state = join(root, 'state')
    const runtimeRoot = join(root, 'runtime')
    const runtimeDir = join(runtimeRoot, 'current/ops/n8n')
    const cli = join(runtimeDir, 'node_modules/n8n/bin/n8n')
    const marker = join(root, 'cli-started')
    const envFile = join(root, 'n8n.env')
    for (const directory of [state, dirname(cli), join(root, 'run'), join(root, 'logs'), join(root, 'backups')]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      chmodSync(directory, 0o700)
    }
    writeFileSync(cli, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started\\n')\n`, { mode: 0o600 })
    writeFileSync(envFile, [
      `N8N_NODE_BIN=${process.execPath}`,
      'N8N_ENCRYPTION_KEY=fixture-encryption-key-that-is-long-enough',
      `AIWORKER_N8N_RUNTIME_ROOT=${runtimeRoot}`,
      `N8N_USER_FOLDER=${state}`,
      `AIWORKER_N8N_RUN_DIR=${join(root, 'run')}`,
      `AIWORKER_N8N_LOG_DIR=${join(root, 'logs')}`,
      `AIWORKER_N8N_BACKUP_DIR=${join(root, 'backups')}`,
      `AIWORKER_N8N_PID_FILE=${join(root, 'run/n8n.pid')}`,
      `AIWORKER_N8N_LOG_FILE=${join(root, 'logs/n8n.log')}`,
      'N8N_PORT=45991',
      '',
    ].join('\n'), { mode: 0o600 })
    const pathname = join(state, '.n8n-maintenance.lock')
    const held = lock('acquire', pathname, 'import', process.pid)
    expect(held.status, held.stderr).toBe(0)
    const racedStart = spawnSync('/bin/bash', [start, '--foreground'], {
      encoding: 'utf8',
      env: { ...process.env, AIWORKER_N8N_ENV_FILE: envFile },
    })
    expect(racedStart.status).not.toBe(0)
    expect(racedStart.stderr).toContain('held by import')
    expect(existsSync(marker)).toBe(false)
    expect(lock('release', pathname, 'import', process.pid, held.stdout.trim()).status).toBe(0)
    const restoreHeld = lock('acquire', pathname, 'restore', process.pid)
    expect(restoreHeld.status, restoreHeld.stderr).toBe(0)
    const restoreRace = spawnSync('/bin/bash', [start, '--foreground'], {
      encoding: 'utf8',
      env: { ...process.env, AIWORKER_N8N_ENV_FILE: envFile },
    })
    expect(restoreRace.status).not.toBe(0)
    expect(restoreRace.stderr).toContain('held by restore')
    expect(existsSync(marker)).toBe(false)
    expect(lock('release', pathname, 'restore', process.pid, restoreHeld.stdout.trim()).status).toBe(0)
  })
})
