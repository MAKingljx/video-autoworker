#!/usr/bin/env node

import { createHash } from 'node:crypto'
import {
  lstatSync, readFileSync, realpathSync, statSync,
} from 'node:fs'
import { isAbsolute, join, normalize, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

import { buildRuntimeIdentityDoctor } from './lib/operations-governance.mjs'

const SHA256 = /^[a-f0-9]{64}$/u
const RELEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u

function fail(code) {
  throw new Error(code)
}

function safeFile(pathname, label, mode = null) {
  if (typeof pathname !== 'string' || !isAbsolute(pathname) || normalize(pathname) !== pathname
    || /[\u0000-\u001f\u007f]/u.test(pathname)) fail(`runtime_doctor_${label}_path_invalid`)
  const entry = lstatSync(pathname)
  if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== process.getuid()
    || entry.nlink !== 1 || (mode !== null && (entry.mode & 0o7777) !== mode)) {
    fail(`runtime_doctor_${label}_unsafe`)
  }
  return realpathSync.native(pathname)
}

function jsonFile(pathname, label) {
  const physical = safeFile(pathname, label, 0o600)
  try {
    const value = JSON.parse(readFileSync(physical, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid')
    return value
  } catch {
    fail(`runtime_doctor_${label}_invalid`)
  }
}

function sha256File(pathname) {
  return createHash('sha256').update(readFileSync(pathname)).digest('hex')
}

function configuredDatabasePath(platformEnvPath) {
  const physical = safeFile(platformEnvPath, 'platform_config', 0o600)
  const source = readFileSync(physical, 'utf8')
  const values = []
  for (const line of source.split(/\r?\n/u)) {
    const match = /^\s*(?:export\s+)?MISSION_CONTROL_DB_PATH\s*=\s*(.*?)\s*$/u.exec(line)
    if (!match) continue
    let value = match[1]
    if ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    values.push(value)
  }
  if (values.length !== 1 || !isAbsolute(values[0]) || normalize(values[0]) !== values[0]
    || /[\u0000-\u001f\u007f$`]/u.test(values[0])) {
    fail('runtime_doctor_platform_database_invalid')
  }
  return { configPath: physical, databasePath: values[0] }
}

function processCwd(pid) {
  const result = spawnSync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
    encoding: 'utf8', timeout: 5_000, maxBuffer: 128 * 1024,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C' },
  })
  const values = String(result.stdout || '').split('\n').filter(line => line.startsWith('n'))
    .map(line => line.slice(1))
  if (result.status !== 0 || values.length !== 1 || !isAbsolute(values[0])) {
    fail('runtime_doctor_process_cwd_unavailable')
  }
  return realpathSync.native(values[0])
}

function processHasOpenFile(pid, pathname) {
  const result = spawnSync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-Fn', '--', pathname], {
    encoding: 'utf8', timeout: 5_000, maxBuffer: 128 * 1024,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C' },
  })
  if (result.error || result.signal || ![0, 1].includes(result.status)) {
    fail('runtime_doctor_process_files_unavailable')
  }
  return result.status === 0
}

function databaseIdentity(pathname, label) {
  const physical = safeFile(pathname, label)
  const entry = statSync(physical, { bigint: true })
  if (entry.size <= 0n) fail(`runtime_doctor_${label}_empty`)
  return { path: physical, dev: entry.dev.toString(), ino: entry.ino.toString() }
}

function parsedOptions(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name?.startsWith('--') || value === undefined || value.startsWith('--')
      || values.has(name)) fail('runtime_doctor_arguments_invalid')
    values.set(name, value)
  }
  const allowed = new Set(['--expected-config-sha256', '--platform-env', '--run-dir', '--slot'])
  if ([...values.keys()].some(name => !allowed.has(name)) || values.size !== allowed.size) {
    fail('runtime_doctor_arguments_invalid')
  }
  return {
    runDir: values.get('--run-dir'),
    slot: values.get('--slot'),
    platformEnvPath: values.get('--platform-env'),
    expectedConfigSha256: values.get('--expected-config-sha256'),
  }
}

export function inspectRuntimeIdentityDoctor(options, dependencies = {}) {
  const runDir = realpathSync.native(resolve(options.runDir || ''))
  if (!['blue', 'green'].includes(options.slot) || !SHA256.test(options.expectedConfigSha256 || '')) {
    fail('runtime_doctor_options_invalid')
  }
  const state = jsonFile(join(runDir, 'router-state.json'), 'router_state')
  const binding = jsonFile(join(runDir, 'slots', `${options.slot}.json`), 'slot_binding')
  const runtime = jsonFile(join(runDir, 'slots', `${options.slot}.runtime.json`), 'runtime_attestation')
  if (state.schema !== 'video-autoworker-standalone-router/v1'
    || !['blue', 'green'].includes(state.active) || !Number.isSafeInteger(state.generation)
    || binding.schema !== 'video-autoworker-standalone-slot/v1'
    || binding.slot !== options.slot || !RELEASE_ID.test(binding.releaseId || '')
    || !SHA256.test(binding.manifestSha256 || '')
    || runtime.schema !== 'video-autoworker-standalone-runtime/v1'
    || runtime.slot !== options.slot || !Number.isSafeInteger(runtime.pid) || runtime.pid <= 0
    || !RELEASE_ID.test(runtime.releaseId || '') || !SHA256.test(runtime.manifestSha256 || '')) {
    fail('runtime_doctor_evidence_invalid')
  }
  try { process.kill(runtime.pid, 0) } catch { fail('runtime_doctor_process_unavailable') }
  const configured = configuredDatabasePath(options.platformEnvPath)
  const expectedDatabase = databaseIdentity(configured.databasePath, 'configured_database')
  const observedDatabase = databaseIdentity(runtime.dbPath, 'runtime_database')
  const readProcessCwd = dependencies.processCwd || processCwd
  const hasOpenFile = dependencies.processHasOpenFile || processHasOpenFile
  const observedCwd = readProcessCwd(runtime.pid)
  const databaseOpen = hasOpenFile(runtime.pid, observedDatabase.path)
  const doctor = buildRuntimeIdentityDoctor({
    releaseId: binding.releaseId,
    pid: runtime.pid,
    manifestSha256: binding.manifestSha256,
    configSha256: options.expectedConfigSha256,
    cwd: realpathSync.native(binding.releaseRoot),
    database: expectedDatabase,
  }, {
    releaseId: runtime.releaseId,
    pid: runtime.pid,
    manifestSha256: runtime.manifestSha256,
    configSha256: sha256File(configured.configPath),
    cwd: observedCwd,
    database: observedDatabase,
  }, { observedAt: dependencies.nowSeconds?.() ?? Math.floor(Date.now() / 1_000) })
  const routerReleaseId = state.slots?.[options.slot]?.releaseId
  const routerAligned = routerReleaseId === binding.releaseId
    && (state.active !== options.slot || runtime.role === 'active')
  const safe = doctor.status === 'aligned' && routerAligned && databaseOpen
  return Object.freeze({
    ...doctor,
    status: safe ? 'aligned' : 'drifted',
    router: {
      slot: options.slot,
      active: state.active === options.slot,
      generation: state.generation,
      releaseAligned: routerAligned,
    },
    process: { pid: runtime.pid, alive: true, authoritativeDatabaseOpen: databaseOpen },
  })
}

export function main(argv = process.argv.slice(2)) {
  const result = inspectRuntimeIdentityDoctor(parsedOptions(argv))
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'runtime_doctor_failed'}\n`)
    process.exit(1)
  }
}
