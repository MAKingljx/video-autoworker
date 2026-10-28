// @vitest-environment node
import { createHash } from 'node:crypto'
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  prepareSchedulerReplacement, validateSchedulerLaunchdReplacement,
} from '../../scripts/manage-scheduler-worker-replacement.mjs'
import { acquireSharedDeploymentLockSync } from '../../scripts/lib/shared-deployment-lock.mjs'

const roots: string[] = []
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const launcher = realpathSync(resolve('scripts/start-scheduler-worker.mjs'))
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'scheduler-replacement-contract-')))
  roots.push(root)
  const beforeRoot = join(root, 'before'), targetRoot = join(root, 'target')
  const stateDir = join(root, 'state'), runDirectory = join(root, 'run')
  for (const directory of [beforeRoot, targetRoot, stateDir, runDirectory]) mkdirSync(directory, { mode: 0o700 })
  const databasePath = join(root, 'mission.db'), envFile = join(root, 'platform.env')
  writeFileSync(databasePath, 'isolated path-binding fixture', { mode: 0o600 })
  writeFileSync(envFile, `MISSION_CONTROL_DB_PATH=${JSON.stringify(databasePath)}\n`, { mode: 0o600 })
  const before = {
    Label: 'com.aiworker.scheduler-worker',
    ProgramArguments: [process.execPath, launcher, '--artifact', beforeRoot, '--state-dir', stateDir, '--env-file', envFile],
    WorkingDirectory: beforeRoot, KeepAlive: true, RunAtLoad: true,
  }
  const target = structuredClone(before)
  target.ProgramArguments[3] = targetRoot
  target.WorkingDirectory = targetRoot
  const plistPath = join(root, 'worker.plist'), targetPlistPath = join(root, 'target.plist')
  const beforeRecoveryPath = join(root, 'existing-recovery.plist')
  for (const [pathname, value] of [[plistPath, before], [targetPlistPath, target], [beforeRecoveryPath, before]] as const) {
    writeFileSync(pathname, JSON.stringify(value), { mode: 0o600 })
  }
  const options = {
    stateDir, runDirectory, databasePath, operationId: 'b'.repeat(64),
    service: {
      kind: 'launchd', label: before.Label, plistPath, targetPlistPath, beforeRecoveryPath,
      beforeSha256: sha(readFileSync(plistPath)), targetSha256: sha(readFileSync(targetPlistPath)),
    },
  }
  // This public validator accepts the already audited artifact roots. These
  // tests exercise its real filesystem/LaunchAgent contract without launching
  // a process or pretending these path fixtures are audited Worker artifacts.
  const artifactRoot = (root: string) => ({
    root,
    get manifest(): never { throw new Error('launchd_validator_must_not_claim_artifact_audit') },
    get database(): never { throw new Error('launchd_validator_must_not_query_database') },
    query(): never { throw new Error('launchd_validator_must_not_query_database') },
  })
  const context = { before: artifactRoot(beforeRoot), target: artifactRoot(targetRoot) }
  const rewriteTarget = (value: typeof target) => {
    writeFileSync(targetPlistPath, JSON.stringify(value))
    options.service.targetSha256 = sha(readFileSync(targetPlistPath))
  }
  return { root, before, target, context, options, envFile, rewriteTarget }
}

describe('managed Scheduler Worker replacement admission contracts', () => {
  it('accepts only the artifact and working-directory replacement with the original private environment and recovery copy', () => {
    const f = fixture(), before = readFileSync(f.options.service.plistPath)
    const result = validateSchedulerLaunchdReplacement(f.options, f.context)
    expect(result).toMatchObject({
      kind: 'launchd', label: f.before.Label,
      beforeSha256: sha(before), targetSha256: f.options.service.targetSha256,
      envFilePath: f.envFile, envFileSha256: sha(readFileSync(f.envFile)),
      beforeRecoveryPath: f.options.service.beforeRecoveryPath,
      targetLauncherSha256: sha(readFileSync(launcher)),
    })
    expect(readFileSync(f.options.service.plistPath)).toEqual(before)
    expect(existsSync(join(f.options.stateDir, 'replacements'))).toBe(false)
  })

  it.each(['keep-alive', 'environment', 'arguments'])(
    'rejects an additional %s change even with a matching target file digest', fault => {
      const f = fixture(), target = structuredClone(f.target)
      if (fault === 'keep-alive') target.KeepAlive = false
      else if (fault === 'environment') Object.assign(target, { EnvironmentVariables: { EXTRA_AUTHORITY: 'forbidden' } })
      else target.ProgramArguments.push('--unscoped-option')
      f.rewriteTarget(target)
      expect(() => validateSchedulerLaunchdReplacement(f.options, f.context)).toThrow('worker_replacement_unscoped_service_change')
      expect(existsSync(join(f.options.stateDir, 'handoff.lock'))).toBe(false)
    },
  )

  it.each(['before', 'target'])('rejects %s plist digest drift', side => {
    const f = fixture()
    const pathname = side === 'before' ? f.options.service.plistPath : f.options.service.targetPlistPath
    writeFileSync(pathname, `${readFileSync(pathname, 'utf8')}\n`)
    expect(() => validateSchedulerLaunchdReplacement(f.options, f.context)).toThrow('worker_replacement_plist_changed')
  })

  it('requires an existing exact recovery copy and does not create an extra backup', () => {
    const f = fixture(), members = readdirSync(f.root).sort()
    expect(() => validateSchedulerLaunchdReplacement({ ...f.options, service: {
      ...f.options.service, beforeRecoveryPath: null,
    } }, f.context)).toThrow('worker_replacement_existing_plist_recovery_required')
    writeFileSync(f.options.service.beforeRecoveryPath, JSON.stringify({ ...f.before, KeepAlive: false }))
    expect(() => validateSchedulerLaunchdReplacement(f.options, f.context)).toThrow('worker_replacement_plist_recovery_mismatch')
    expect(readdirSync(f.root).sort()).toEqual(members)
  })

  it('rejects a private environment redirected to another database', () => {
    const f = fixture(), foreign = join(f.root, 'foreign.db')
    writeFileSync(foreign, 'foreign database fixture', { mode: 0o600 })
    writeFileSync(f.envFile, `MISSION_CONTROL_DB_PATH=${JSON.stringify(foreign)}\n`)
    expect(() => validateSchedulerLaunchdReplacement(f.options, f.context)).toThrow('worker_replacement_environment_database_changed')
    expect(readFileSync(f.options.databasePath, 'utf8')).toBe('isolated path-binding fixture')
  })

  it.each(['symlink', 'writable'])('rejects an unsafe %s service file', fault => {
    const f = fixture()
    if (fault === 'symlink') {
      const link = join(f.root, 'target-link.plist')
      symlinkSync(f.options.service.targetPlistPath, link)
      f.options.service.targetPlistPath = link
    } else chmodSync(f.options.service.targetPlistPath, 0o666)
    expect(() => validateSchedulerLaunchdReplacement(f.options, f.context)).toThrow('worker_replacement_plist_unsafe')
  })

  it('rejects a launchd operation without the controller lock delegation before creating any maintenance state', async () => {
    const f = fixture(), original = readFileSync(f.options.service.plistPath)
    await expect(prepareSchedulerReplacement(f.options)).rejects.toThrow('worker_replacement_deployment_delegation_required')
    expect(readFileSync(f.options.service.plistPath)).toEqual(original)
    expect(readdirSync(f.options.stateDir)).toEqual([])
    expect(readdirSync(f.options.runDirectory)).toEqual([])
  })

  it('preserves an existing shared deployment owner rather than claiming or deleting its lock', async () => {
    const f = fixture(), lease = acquireSharedDeploymentLockSync({ runDirectory: f.options.runDirectory })
    if (!lease) throw new Error('fixture_deployment_lock_not_acquired')
    try {
      const owner = readFileSync(lease.descriptor.ownerPath)
      const options = { ...f.options, service: undefined }
      await expect(prepareSchedulerReplacement(options)).rejects.toThrow('another shared deployment operation is active')
      expect(readFileSync(lease.descriptor.ownerPath)).toEqual(owner)
      expect(readdirSync(f.options.stateDir)).toEqual([])
    } finally { lease.release() }
  })
})
