#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync,
  readdirSync, readlinkSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'

const sha256 = value => createHash('sha256').update(value).digest('hex')

export function auditSchedulerWorkerArtifact(rootValue) {
  const root = realpathSync(rootValue)
  const manifestPath = join(root, 'worker-manifest.json')
  const info = lstatSync(manifestPath)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024) throw new Error('scheduler_worker_manifest_unsafe')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.schema !== 'video-autoworker-scheduler-artifact/v1'
    || !Array.isArray(manifest.sources) || !Array.isArray(manifest.members)
    || manifest.contentSha256 !== sha256(JSON.stringify({
      runtime: manifest.runtime, sources: manifest.sources, members: manifest.members,
    }))) throw new Error('scheduler_worker_manifest_invalid')
  if (manifest.runtime.platform !== process.platform || manifest.runtime.arch !== process.arch
    || manifest.runtime.nodeAbi !== process.versions.modules
    || manifest.runtime.nodeVersion.split('.')[0] !== process.versions.node.split('.')[0]) {
    throw new Error('scheduler_worker_runtime_mismatch')
  }
  const declared = new Map(manifest.members.map(member => [member.path, member]))
  if (declared.size !== manifest.members.length) throw new Error('scheduler_worker_manifest_duplicate')
  const seen = new Set()
  const walk = (directory, prefix = '') => {
    for (const name of readdirSync(directory).sort()) {
      const member = prefix ? `${prefix}/${name}` : name
      if (member === 'worker-manifest.json') continue
      if (/(^|\/)(?:\.PhoenixBrain|need|\.git|private|memory|output|rollback)(\/|$)/u.test(member)
        || /(?:^|\/)\.env(?:\.|$)/u.test(member)) throw new Error('scheduler_worker_private_member')
      const pathname = join(directory, name)
      const entry = lstatSync(pathname)
      if (entry.isDirectory()) { walk(pathname, member); continue }
      const expected = declared.get(member)
      if (!expected || (entry.mode & 0o777) !== expected.mode) throw new Error('scheduler_worker_member_drift')
      if (entry.isSymbolicLink()) {
        if (expected.type !== 'symlink' || readlinkSync(pathname) !== expected.target
          || !realpathSync(pathname).startsWith(`${root}/`)) throw new Error('scheduler_worker_symlink_drift')
      } else if (!entry.isFile() || expected.type !== 'file' || entry.size !== expected.size
        || sha256(readFileSync(pathname)) !== expected.sha256) throw new Error('scheduler_worker_content_drift')
      seen.add(member)
    }
  }
  walk(root)
  if (seen.size !== declared.size) throw new Error('scheduler_worker_member_missing')
  const require = createRequire(join(root, 'worker.cjs'))
  const Database = require('better-sqlite3')
  const probe = new Database(':memory:')
  try { probe.prepare('SELECT 1').get() } finally { probe.close() }
  return { root, manifest }
}

function loadPrivateEnvironment(pathname) {
  const descriptor = openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = fstatSync(descriptor)
    if (!info.isFile() || (info.mode & 0o077) || info.size > 1024 * 1024
      || (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
      throw new Error('scheduler_worker_environment_unsafe')
    }
    return parseEnv(readFileSync(descriptor, 'utf8'))
  } finally { closeSync(descriptor) }
}

async function main(argv) {
  const values = new Map()
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--artifact', '--state-dir', '--env-file'].includes(argv[i]) || !argv[i + 1]
      || values.has(argv[i])) throw new Error('scheduler_worker_arguments_invalid')
    values.set(argv[i], resolve(argv[i + 1]))
  }
  if (values.size !== 3) throw new Error('scheduler_worker_arguments_required')
  const { root, manifest } = auditSchedulerWorkerArtifact(values.get('--artifact'))
  const environment = loadPrivateEnvironment(values.get('--env-file'))
  for (const [key, value] of Object.entries(environment)) process.env[key] = value
  // Web process bindings cannot leak into the independent execution process.
  for (const key of ['AIWORKER_SLOT', 'AIWORKER_RELEASE_ID', 'AIWORKER_RUNTIME_ROLE',
    'AIWORKER_BG_ROUTER_STATE', 'AIWORKER_DISABLE_SCHEDULER', 'MISSION_CONTROL_TEST_MODE', 'NEXT_PHASE']) delete process.env[key]
  process.env.NODE_ENV = 'production'
  process.env.AIWORKER_SCHEDULER_MODE = 'worker'
  process.env.AIWORKER_SCHEDULER_STATE_DIR = values.get('--state-dir')
  process.env.AIWORKER_WORKER_CONTENT_SHA256 = manifest.contentSha256
  process.env.AIWORKER_NODE_BIN = process.execPath
  process.env.PATH = `${dirname(process.execPath)}:${process.env.PATH || ''}`
  process.chdir(root)
  const require = createRequire(join(root, 'worker.cjs'))
  await require('./worker-runtime.cjs').startSchedulerWorker()
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
