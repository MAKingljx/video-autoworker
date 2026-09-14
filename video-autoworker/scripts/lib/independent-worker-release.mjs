import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import http from 'node:http'
import { isAbsolute, join, resolve } from 'node:path'

const sha = value => createHash('sha256').update(value).digest('hex')
const SHA = /^[a-f0-9]{64}$/u
const SCHEMA = 'video-autoworker-independent-worker-release/v1'

function privateDirectory(pathname) {
  const entry = lstatSync(pathname)
  if (!isAbsolute(pathname) || realpathSync(pathname) !== pathname || !entry.isDirectory()
    || entry.isSymbolicLink() || entry.uid !== process.getuid() || (entry.mode & 0o077)) {
    throw new Error('release_worker_state_unsafe')
  }
}
export async function readIndependentWorkerStatus(stateDir) {
  privateDirectory(stateDir)
  const socketPath = join(stateDir, 'worker.sock')
  const entry = lstatSync(socketPath)
  if (!entry.isSocket() || entry.uid !== process.getuid() || (entry.mode & 0o077)) {
    throw new Error('release_worker_socket_unsafe')
  }
  return new Promise((resolveResult, reject) => {
    const request = http.get({ socketPath, path: '/status' }, response => {
      let source = ''
      response.on('data', chunk => {
        source += chunk.toString()
        if (Buffer.byteLength(source) > 65_536) response.destroy(new Error('release_worker_status_too_large'))
      })
      response.on('error', reject)
      response.on('end', () => {
        try {
          if (response.statusCode !== 200) throw new Error('release_worker_status_unavailable')
          resolveResult(JSON.parse(source))
        } catch (error) { reject(error) }
      })
    })
    request.setTimeout(5000, () => request.destroy(new Error('release_worker_status_timeout')))
    request.on('error', reject)
  })
}

export function workerSourceClosureUnchanged(manifest, productRoot, read = pathname => readFileSync(pathname)) {
  if (manifest?.schema !== 'video-autoworker-scheduler-artifact/v1' || !SHA.test(manifest.contentSha256 || '')
    || !Array.isArray(manifest.sources) || !Array.isArray(manifest.members)
    || sha(JSON.stringify({ runtime: manifest.runtime, sources: manifest.sources, members: manifest.members })) !== manifest.contentSha256) {
    throw new Error('release_worker_manifest_invalid')
  }
  const seen = new Set()
  for (const entry of manifest.sources) {
    if (typeof entry.path !== 'string' || isAbsolute(entry.path) || entry.path.includes('\\')
      || entry.path.split('/').some(part => ['.', '..', ''].includes(part))
      || !SHA.test(entry.sha256 || '') || seen.has(entry.path)) throw new Error('release_worker_source_invalid')
    seen.add(entry.path)
  }
  for (const required of ['src/workers/scheduler-worker.ts', 'package.json', 'pnpm-lock.yaml', '.nvmrc', 'scripts/build-scheduler-worker.mjs']) {
    if (!seen.has(required)) throw new Error('release_worker_source_closure_incomplete')
  }
  return manifest.sources.every(entry => {
    try { return sha(read(resolve(productRoot, entry.path))) === entry.sha256 }
    catch (error) { if (error.code === 'ENOENT') return false; throw error }
  })
}

export function validateWorkerReleaseBinding(binding) {
  if (binding?.schema !== SCHEMA || !isAbsolute(binding.stateDir || '')
    || !isAbsolute(binding.manifestPath || '') || !SHA.test(binding.manifestSha256 || '')
    || !SHA.test(binding.contentSha256 || '') || !SHA.test(binding.database?.pathSha256 || '')
    || !/^\d+$/u.test(binding.database?.dev || '') || !/^\d+$/u.test(binding.database?.ino || '')
    || !Number.isSafeInteger(binding.pid) || binding.pid < 1
    || typeof binding.sourceUnchanged !== 'boolean' || typeof binding.healthy !== 'boolean'
    || (binding.handoffOperationId !== undefined
      && (typeof binding.handoffOperationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(binding.handoffOperationId)
        || !/^[a-f0-9]{40}$/u.test(binding.targetApplicationCommit || '')))) {
    throw new Error('release_worker_binding_invalid')
  }
  return binding
}

/**
 * @param {Record<string, any>} status
 * @param {{ operationId: string, targetApplicationCommit: string } | null} [expected]
 */
export function workerHandoffBinding(status, expected = null) {
  const live = status?.handoff
  const pending = live?.migrationPending === true
  if (!pending && !expected) return {}
  const operationId = live?.operationId
  const targetApplicationCommit = live?.targetApplicationCommit
  if (typeof operationId !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(operationId)
    || !/^[a-f0-9]{40}$/u.test(targetApplicationCommit || '')
    || (expected && (operationId !== expected.operationId
      || targetApplicationCommit !== expected.targetApplicationCommit))) {
    throw new Error('release_worker_handoff_identity_mismatch')
  }
  return { handoffOperationId: operationId, targetApplicationCommit }
}

export async function inspectWorkerRelease({ manifestPath, stateDir, databasePath, productRoot,
  expectedHandoff = null }, readStatus = readIndependentWorkerStatus) {
  if (!isAbsolute(manifestPath) || resolve(manifestPath) !== manifestPath) throw new Error('release_worker_manifest_path_invalid')
  const entry = lstatSync(manifestPath)
  if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== process.getuid()
    || (entry.mode & 0o022) || entry.size > 32 * 1024 * 1024) throw new Error('release_worker_manifest_unsafe')
  const raw = readFileSync(manifestPath)
  const manifest = JSON.parse(raw)
  const sourceUnchanged = workerSourceClosureUnchanged(manifest, productRoot)
  const status = await readStatus(stateDir)
  const database = lstatSync(databasePath)
  const identity = { dev: String(database.dev), ino: String(database.ino), pathSha256: sha(realpathSync(databasePath)) }
  if (status?.schema !== 'video-autoworker-scheduler-worker/v1'
    || status.executionMode !== 'external-worker' || status.worker?.contentSha256 !== manifest.contentSha256
    || !Number.isSafeInteger(status.observedAt) || Math.abs(Date.now() - status.observedAt) > 15_000
    || !database.isFile() || database.isSymbolicLink()
    || Object.keys(identity).some(key => identity[key] !== status.worker?.database?.[key])) {
    throw new Error('release_worker_identity_mismatch')
  }
  return validateWorkerReleaseBinding({ schema: SCHEMA, stateDir, manifestPath,
    manifestSha256: sha(raw), contentSha256: manifest.contentSha256, database: identity,
    pid: status.worker.pid, sourceUnchanged,
    ...workerHandoffBinding(status, expectedHandoff),
    healthy: status.healthy === true && status.leaseVerified === true
      && status.leadership?.state === 'leader' && status.currentState === 'ready' })
}

export function releaseAdmissionPolicy(components, workerBinding) {
  if (!workerBinding) return 'drain-all'
  validateWorkerReleaseBinding(workerBinding)
  const onlyApp = components.app.changed
    && ['taskFlow', 'directorBrain', 'videoCommand', 'control'].every(name => !components[name].changed)
  return onlyApp && workerBinding.sourceUnchanged && workerBinding.healthy ? 'pause-new' : 'drain-all'
}
