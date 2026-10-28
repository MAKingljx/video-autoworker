import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, closeSync, constants, fsyncSync, lstatSync, openSync,
  readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import { schedulerWorkerMaintenance as core } from '../manage-scheduler-worker.mjs'

// H1 launchd operations only. Replacement ownership and its state machine stay
// in the coordinator; this module never creates operation or handoff receipts.
export const SCHEDULER_WORKER_LAUNCHD_LABEL = 'com.aiworker.scheduler-worker'
const LABEL = SCHEDULER_WORKER_LAUNCHD_LABEL
const SHA = /^[a-f0-9]{64}$/u
const sha = value => createHash('sha256').update(value).digest('hex')
const digest = value => sha(JSON.stringify(value))
const fail = code => { throw new Error(code) }
const launcher = fileURLToPath(new URL('../start-scheduler-worker.mjs', import.meta.url))
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sorted(item)])) : value
const same = (a, b) => digest(sorted(a)) === digest(sorted(b))

function serviceFile(pathname) {
  const entry = lstatSync(pathname)
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.uid !== process.getuid()
    || entry.mode & 0o022 || realpathSync(pathname) !== pathname || entry.size > 1024 * 1024) fail('worker_replacement_plist_unsafe')
  const bytes = readFileSync(pathname)
  const value = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', pathname], { encoding: 'utf8' }))
  return { bytes, value, sha256: sha(bytes), mode: entry.mode & 0o777 }
}
export function validateSchedulerLaunchdReplacement(options, ctx) {
  const service = options.service
  if (service?.kind !== 'launchd' || service.label !== LABEL || !isAbsolute(service.plistPath || '')
    || !isAbsolute(service.targetPlistPath || '') || !SHA.test(service.beforeSha256 || '') || !SHA.test(service.targetSha256 || '')) fail('worker_replacement_service_invalid')
  const before = serviceFile(service.plistPath), target = serviceFile(service.targetPlistPath)
  if (before.sha256 !== service.beforeSha256 || target.sha256 !== service.targetSha256
    || before.value.Label !== LABEL || target.value.Label !== LABEL) fail('worker_replacement_plist_changed')
  const args = before.value.ProgramArguments
  if (!Array.isArray(args) || args.length !== 8 || realpathSync(args[0]) !== realpathSync(process.execPath)
    || args[2] !== '--artifact' || args[3] !== ctx.before.root || args[4] !== '--state-dir'
    || args[5] !== options.stateDir || args[6] !== '--env-file' || !isAbsolute(args[7] || '')) fail('worker_replacement_service_arguments_invalid')
  const expected = structuredClone(before.value)
  expected.ProgramArguments[1] = launcher
  expected.ProgramArguments[3] = ctx.target.root
  if (expected.WorkingDirectory === ctx.before.root) expected.WorkingDirectory = ctx.target.root
  if (!same(expected, target.value)) fail('worker_replacement_unscoped_service_change')
  const environment = core.privateFile(args[7], { parseJson: false, maxBytes: 1024 * 1024 })
  if (realpathSync(parseEnv(environment.bytes.toString('utf8')).MISSION_CONTROL_DB_PATH || '') !== options.databasePath) fail('worker_replacement_environment_database_changed')
  // Reuse an already inventoried recovery object. This tool never adds an
  // uncounted third plist copy in a separate operation directory.
  if (!isAbsolute(service.beforeRecoveryPath || '')) fail('worker_replacement_existing_plist_recovery_required')
  const recovery = serviceFile(service.beforeRecoveryPath), recoveryInfo = lstatSync(service.beforeRecoveryPath)
  if (recovery.sha256 !== before.sha256) fail('worker_replacement_plist_recovery_mismatch')
  return { kind: 'launchd', label: LABEL, plistPath: service.plistPath, targetPlistPath: service.targetPlistPath,
    beforeSha256: before.sha256, targetSha256: target.sha256, beforeMode: before.mode,
    envFilePath: args[7], envFileSha256: environment.sha256, oldLauncher: args[1], oldLauncherSha256: sha(readFileSync(args[1])),
    targetLauncherSha256: sha(readFileSync(launcher)), beforeRecoveryPath: service.beforeRecoveryPath,
    beforeRecoveryIdentity: { dev: recoveryInfo.dev, ino: recoveryInfo.ino, size: recoveryInfo.size,
      mtimeMs: recoveryInfo.mtimeMs, ctimeMs: recoveryInfo.ctimeMs } }
}
function launchctlStatus(binding, expectedRoot, expectedPid = null) {
  const source = execFileSync('/bin/launchctl', ['print', `gui/${process.getuid()}/${LABEL}`], { encoding: 'utf8' })
  const pid = Number(/\n\s*pid = (\d+)/u.exec(source)?.[1])
  if (!Number.isSafeInteger(pid) || pid < 1 || expectedPid !== null && pid !== expectedPid
    || !source.includes(expectedRoot) || !source.includes('start-scheduler-worker.mjs')) fail('worker_replacement_launchd_identity_changed')
  return pid
}
function replaceServiceFile(binding, bytes, expectedSha256, mode) {
  if (serviceFile(binding.plistPath).sha256 !== expectedSha256) fail('worker_replacement_plist_changed')
  const temporary = join(dirname(binding.plistPath), `.scheduler-replacement-${randomUUID()}.tmp`)
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
  chmodSync(temporary, mode)
  if (serviceFile(binding.plistPath).sha256 !== expectedSha256) { unlinkSync(temporary); fail('worker_replacement_plist_changed') }
  renameSync(temporary, binding.plistPath)
  const directory = openSync(dirname(binding.plistPath), constants.O_RDONLY)
  try { fsyncSync(directory) } finally { closeSync(directory) }
  if (serviceFile(binding.plistPath).sha256 !== sha(bytes)) fail('worker_replacement_plist_readback_failed')
}
export function createSchedulerLaunchdAdapter(options, loaded, ctx) {
  const binding = loaded.record.binding.service
  if (binding.kind !== 'launchd' || !options.deploymentLease) fail('worker_replacement_cli_requires_delegated_launchd')
  const service = `gui/${process.getuid()}/${LABEL}`
  return {
    stop: async (side, pid) => {
      const root = side === 'before' ? ctx.before.root : ctx.target.root
      const expected = side === 'before' ? binding.beforeSha256 : binding.targetSha256
      if (serviceFile(binding.plistPath).sha256 !== expected) fail('worker_replacement_plist_changed')
      launchctlStatus(binding, root, pid)
      core.stopOwnedWorker({ ...options, expectedPid: pid }, side === 'before' ? ctx.before : ctx.target)
    },
    start: async side => {
      const desired = side === 'target' ? binding.targetSha256 : binding.beforeSha256
      const current = serviceFile(binding.plistPath).sha256
      if (current !== desired) {
        const bytes = side === 'target' ? serviceFile(binding.targetPlistPath).bytes : serviceFile(binding.beforeRecoveryPath).bytes
        if (side === 'before') {
          const info = lstatSync(binding.beforeRecoveryPath)
          if (!same(binding.beforeRecoveryIdentity, { dev: info.dev, ino: info.ino, size: info.size,
            mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs })) fail('worker_replacement_recovery_identity_changed')
        }
        if (sha(bytes) !== desired) fail('worker_replacement_service_recovery_changed')
        replaceServiceFile(binding, bytes, side === 'target' ? binding.beforeSha256 : binding.targetSha256, binding.beforeMode)
      }
      const launcherPath = side === 'target' ? launcher : binding.oldLauncher
      if (sha(readFileSync(launcherPath)) !== (side === 'target' ? binding.targetLauncherSha256 : binding.oldLauncherSha256)) fail('worker_replacement_launcher_changed')
      if (core.privateFile(binding.envFilePath, { parseJson: false, maxBytes: 1024 * 1024 }).sha256 !== binding.envFileSha256) fail('worker_replacement_environment_changed')
      try { execFileSync('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, binding.plistPath], { stdio: ['ignore', 'pipe', 'pipe'] }) }
      catch { /* A lost bootstrap response requires exact managed readback below. */ }
      return launchctlStatus(binding, side === 'target' ? ctx.target.root : ctx.before.root)
    },
  }
}


export function assertSchedulerLaunchdProcess(binding, expectedRoot, expectedPid = null) {
  return launchctlStatus(binding, expectedRoot, expectedPid)
}

export function assertSchedulerLaunchdReadiness(service, expectedRoot, expectedPid) {
  if (serviceFile(service.plistPath).sha256 !== service.targetSha256
    || core.privateFile(service.envFilePath, { parseJson: false, maxBytes: 1024 * 1024 }).sha256 !== service.envFileSha256) fail('worker_replacement_service_binding_changed')
  launchctlStatus(service, expectedRoot, expectedPid)
}

export function assertSchedulerLaunchdOriginalService(service) {
  if (serviceFile(service.plistPath).sha256 !== service.beforeSha256) fail('worker_replacement_plist_changed')
}
