#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  chmodSync, closeSync, constants, existsSync, fsyncSync, linkSync, lstatSync, openSync,
  realpathSync, unlinkSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  captureValidatedSnapshot,
  captureOpenFileRecords,
  hashFileStable,
  revalidateDatabaseConnection,
  validateNewDatabaseConnection,
  writeExclusiveAtomic,
} from './generate-legacy-freeze-evidence.mjs'

process.umask(0o077)
const scriptPath = fileURLToPath(import.meta.url)
const repositoryRoot = realpathSync(join(dirname(scriptPath), '..'))
const testMode = process.env.NODE_ENV === 'test' && process.env.AIWORKER_TEST_LEGACY_FREEZE === '1'
const RELEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u

function fail(message) { throw new Error(`legacy rollback proof failed: ${message}`) }
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]))
  }
  return value
}
function canonicalJson(value) { return JSON.stringify(canonicalize(value)) }
function sha256(value) { return createHash('sha256').update(value).digest('hex') }
function absolute(pathname, label) {
  if (typeof pathname !== 'string' || !isAbsolute(pathname) || resolve(pathname) !== pathname
    || /[\u0000-\u001f\u007f]/u.test(pathname)) fail(`${label} must be one normalized absolute path`)
}
function noSymlink(pathname, label) {
  absolute(pathname, label)
  const root = parse(pathname).root
  let current = root
  for (const part of relative(root, pathname).split('/').filter(Boolean)) {
    current = join(current, part)
    let entry
    try { entry = lstatSync(current, { bigint: true }) } catch { fail(`${label} path component is unavailable`) }
    if (entry.isSymbolicLink()) fail(`${label} path contains a symlink`)
  }
}
function safeDirectory(pathname, label) {
  noSymlink(pathname, label)
  const entry = lstatSync(pathname, { bigint: true })
  if (!entry.isDirectory() || entry.uid !== BigInt(process.getuid())
    || Number(entry.mode & 0o7777n) !== 0o700) fail(`${label} must be an owner-private mode-0700 directory`)
}
function pathsOverlap(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}
function parseArguments(argv) {
  const names = ['--output', '--slot', '--release-id', '--standalone-root', '--guard-socket']
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    if (!names.includes(argv[index]) || !argv[index + 1] || Object.hasOwn(values, argv[index])) {
      fail(`expected ${names.join(', ')}`)
    }
    values[argv[index]] = argv[index + 1]
  }
  if (Object.keys(values).length !== names.length || !['blue', 'green'].includes(values['--slot'])
    || !RELEASE_ID.test(values['--release-id'])) fail('arguments are invalid')
  for (const name of ['--output', '--standalone-root', '--guard-socket']) absolute(values[name], name)
  return {
    output: values['--output'], slot: values['--slot'], releaseId: values['--release-id'],
    standaloneRoot: values['--standalone-root'], guardSocket: values['--guard-socket'],
  }
}
function targetIdentity(args) {
  noSymlink(args.standaloneRoot, 'target standalone root')
  const physical = realpathSync(args.standaloneRoot)
  const expected = join(repositoryRoot, '.runtime/releases', args.releaseId, 'standalone')
  const testRoot = testMode ? realpathSync(process.env.AIWORKER_TEST_LEGACY_FREEZE_REPOSITORY_ROOT) : repositoryRoot
  const expectedForMode = join(testRoot, '.runtime/releases', args.releaseId, 'standalone')
  if (physical !== (testMode ? expectedForMode : expected)) fail('target standalone root is not the exact release')
  const manifest = join(physical, 'release-manifest.json')
  noSymlink(manifest, 'target release manifest')
  if (!testMode) execFileSync(process.execPath, [join(repositoryRoot, 'scripts/check-standalone-artifact.mjs'), physical])
  return { slot: args.slot, releaseId: args.releaseId, manifestSha256: hashFileStable(manifest, 'target release manifest') }
}
function fsyncFile(pathname) {
  const fd = openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { fsyncSync(fd) } finally { closeSync(fd) }
}
function publishBackup(temporary, destination) {
  if (existsSync(destination)) fail(`backup already exists: ${basename(destination)}`)
  chmodSync(temporary, 0o600)
  fsyncFile(temporary)
  linkSync(temporary, destination)
  unlinkSync(temporary)
  const entry = lstatSync(destination, { bigint: true })
  if (!entry.isFile() || entry.uid !== BigInt(process.getuid())
    || Number(entry.mode & 0o7777n) !== 0o600 || entry.nlink !== 1n) fail('published backup identity is unsafe')
}
async function onlineBackup(Database, source, destination, label) {
  const temporary = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`)
  if (existsSync(destination) || existsSync(temporary)) fail(`${label} destination already exists`)
  try {
    const before = captureOpenFileRecords(process.pid)
    const db = new Database(source.path, { readonly: true, fileMustExist: true, timeout: 30000 })
    try {
      db.pragma('query_only = ON')
      const descriptor = validateNewDatabaseConnection(
        source, before, captureOpenFileRecords(process.pid), `${label} backup source FD`,
      )
      if (db.pragma('quick_check', { simple: true }) !== 'ok') fail(`${label} source quick_check failed`)
      await db.backup(temporary)
      revalidateDatabaseConnection(
        source, descriptor, captureOpenFileRecords(process.pid), `${label} backup source FD`,
      )
    } finally { db.close() }
    const backup = new Database(temporary, { readonly: true, fileMustExist: true })
    try {
      backup.pragma('query_only = ON')
      if (backup.pragma('quick_check', { simple: true }) !== 'ok') fail(`${label} backup quick_check failed`)
    } finally { backup.close() }
    publishBackup(temporary, destination)
    return { path: destination, sha256: hashFileStable(destination, `${label} backup`) }
  } catch (error) {
    try { unlinkSync(temporary) } catch {}
    throw error
  }
}
async function main() {
  const args = parseArguments(process.argv.slice(2))
  const outputDirectory = dirname(args.output)
  safeDirectory(outputDirectory, 'rollback output directory')
  if (existsSync(args.output)) fail('rollback proof output already exists')
  const target = targetIdentity(args)
  const effectiveRepository = testMode
    ? realpathSync(process.env.AIWORKER_TEST_LEGACY_FREEZE_REPOSITORY_ROOT) : repositoryRoot
  const releaseRoot = dirname(args.standaloneRoot)
  for (const [label, protectedPath] of [
    ['repository', effectiveRepository], ['target standalone', args.standaloneRoot],
    ['target release', releaseRoot],
  ]) {
    if (pathsOverlap(outputDirectory, protectedPath)) {
      fail(`rollback output directory must not overlap the ${label}`)
    }
  }
  const first = await captureValidatedSnapshot(effectiveRepository)
  if (first.frozen.socket.path !== args.guardSocket) fail('rollback proof is not bound to the requested freeze guard')
  for (const source of [first.legacy.database.path, first.n8n.database.path]) {
    const sourceDirectory = dirname(source)
    if (source.startsWith(`${outputDirectory}/`) || outputDirectory === sourceDirectory
      || outputDirectory.startsWith(`${sourceDirectory}/`)) {
      fail('rollback output directory must be independent from both source database directories')
    }
  }
  const scopedRequire = createRequire(import.meta.url)
  const Database = scopedRequire(scopedRequire.resolve('better-sqlite3', { paths: [repositoryRoot] }))
  const mission = await onlineBackup(Database, first.legacy.database,
    join(dirname(args.output), 'mission-control.db'), 'Mission Control')
  const n8n = await onlineBackup(Database, first.n8n.database,
    join(dirname(args.output), 'database.sqlite'), 'n8n')
  const second = await captureValidatedSnapshot(effectiveRepository)
  if (canonicalJson(first) !== canonicalJson(second)) fail('runtime, guard, queue, or source identity changed during backup')
  const digest = value => sha256(Buffer.from(canonicalJson(value)))
  const proof = {
    schema: 'video-autoworker-legacy-bootstrap-rollback-proof/v2',
    generatorSha256: hashFileStable(scriptPath, 'rollback proof generator'),
    createdAt: Math.floor(Date.now() / 1000),
    host: execFileSync('/bin/hostname', { encoding: 'utf8' }).trim(),
    uid: process.getuid(),
    target,
    sources: { mission: second.legacy.database, n8n: second.n8n.database },
    backups: { mission, n8n },
    queueDigestSha256: second.queueDigestSha256,
    guardSha256: digest(second.frozen),
    runtimeIdentitySha256: digest(second),
  }
  writeExclusiveAtomic(args.output, `${canonicalJson(proof)}\n`)
  const parentFd = openSync(dirname(args.output), constants.O_RDONLY)
  try { fsyncSync(parentFd) } finally { closeSync(parentFd) }
  process.stdout.write(`Created managed rollback proof: ${args.output}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1 })
}
