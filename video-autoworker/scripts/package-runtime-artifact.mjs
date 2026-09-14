#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, lstat, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, relative, resolve, join, sep } from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { auditStandaloneArtifact, verifyStandaloneVerificationBundle } from './check-standalone-artifact.mjs'

const SCHEMA = 'video-autoworker-runtime-package/v1'
const SHA = /^[a-f0-9]{64}$/u
const REPOSITORY = 'MAKingljx/video-autoworker'
const WORKFLOW = 'Quality Gate'
/** @param {string} sourceCommit @param {Record<string, string | undefined>} [env] */
export function packageCiSource(sourceCommit, env = process.env) {
  const fields = ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_REPOSITORY', 'GITHUB_SHA']
  if (env.GITHUB_ACTIONS !== 'true' && !fields.some(key => env[key])) return null
  const value = { repository: env.GITHUB_REPOSITORY, runId: env.GITHUB_RUN_ID,
    attempt: Number(env.GITHUB_RUN_ATTEMPT), headSha: env.GITHUB_SHA, workflow: WORKFLOW }
  validateCiSource(value, sourceCommit)
  return value
}
function validateCiSource(ci, sourceCommit) {
  if (!ci || ci.repository !== REPOSITORY || !/^[1-9][0-9]*$/u.test(ci.runId || '')
    || !Number.isSafeInteger(ci.attempt) || ci.attempt < 1
    || ci.headSha !== sourceCommit || ci.workflow !== WORKFLOW) {
    throw new Error('runtime_package_ci_source_invalid')
  }
}

/** @param {any} receipt @param {{runCommand?: (command: string, args: string[], options: any) => string | Buffer}} [options] */
export function verifyPackageCiSuccess(receipt, { runCommand = execFileSync } = {}) {
  if (!receipt.ci) throw new Error('runtime_package_ci_required')
  validateCiSource(receipt.ci, receipt.sourceCommit)
  const ci = receipt.ci
  let run
  try {
    run = JSON.parse(String(runCommand('gh', ['run', 'view', ci.runId, '--repo', ci.repository,
      '--attempt', String(ci.attempt), '--json', 'databaseId,attempt,headSha,status,conclusion,workflowName,url'], {
      encoding: 'utf8', timeout: 30_000, maxBuffer: 512 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    })))
  } catch (error) {
    throw new Error(error?.code === 'ENOENT' ? 'runtime_package_gh_unavailable' : 'runtime_package_ci_query_failed')
  }
  const expectedUrl = `https://github.com/${ci.repository}/actions/runs/${ci.runId}`
  if (String(run.databaseId) !== ci.runId || run.attempt !== ci.attempt || run.headSha !== receipt.sourceCommit
    || run.workflowName !== WORKFLOW || String(run.url).toLowerCase() !== expectedUrl.toLowerCase()) {
    throw new Error('runtime_package_ci_run_identity_mismatch')
  }
  if (run.status !== 'completed' || run.conclusion !== 'success') throw new Error('runtime_package_ci_not_successful')
  return { status: 'verified', repository: ci.repository, runId: ci.runId,
    attempt: ci.attempt, headSha: ci.headSha, workflow: WORKFLOW, checkedAt: new Date().toISOString() }
}
export const currentPackageRuntime = () => ({ platform: process.platform, arch: process.arch,
  nodeMajor: Number(process.versions.node.split('.')[0]), nodeAbi: process.versions.modules })
const hash = value => createHash('sha256').update(value).digest('hex')
async function fileHash(pathname) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(pathname)) digest.update(chunk)
  return digest.digest('hex')
}

/** Resolve from the already audited artifact manifest, never from the caller's node_modules. */
export async function resolveArtifactSqlitePackage(artifactRoot, manifest) {
  const root = await realpath(resolve(artifactRoot))
  if (manifest?.schemaVersion !== 2 || manifest.algorithm !== 'sha256' || !Array.isArray(manifest.files)) {
    throw new Error('runtime_package_sqlite_manifest_invalid')
  }
  const members = new Map()
  for (const member of manifest.files) {
    if (typeof member.path !== 'string' || isAbsolute(member.path) || member.path.includes('\\')
      || member.path.split('/').some(part => ['', '.', '..'].includes(part))
      || !SHA.test(member.sha256 || '') || members.has(member.path)) throw new Error('runtime_package_sqlite_manifest_invalid')
    members.set(member.path, member)
  }
  const relativeMember = pathname => {
    const value = relative(root, pathname)
    if (!value || value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value)) {
      throw new Error('runtime_package_sqlite_outside_artifact')
    }
    return value.split(sep).join('/')
  }
  const declaredFile = async pathname => {
    const physical = await realpath(pathname)
    const member = relativeMember(physical)
    const expected = members.get(member)
    const entry = await lstat(physical)
    if (!expected || !entry.isFile() || entry.isSymbolicLink() || entry.size !== expected.bytes
      || (entry.mode & 0o7777).toString(8).padStart(4, '0') !== expected.mode
      || await fileHash(physical) !== expected.sha256) throw new Error('runtime_package_sqlite_member_changed')
    return { path: physical, member, expected }
  }
  const top = await declaredFile(join(root, 'node_modules/better-sqlite3/package.json'))
  const topMetadata = JSON.parse(await readFile(top.path, 'utf8'))
  const mainOf = value => typeof value.main === 'string' ? value.main : 'index.js'
  if (topMetadata.name !== 'better-sqlite3' || typeof topMetadata.version !== 'string' || !topMetadata.version) {
    throw new Error('runtime_package_sqlite_metadata_invalid')
  }
  const candidates = new Map()
  for (const member of members.keys()) {
    if (!/(?:^|\/)node_modules\/better-sqlite3\/package\.json$/u.test(member)) continue
    const metadataFile = await declaredFile(resolve(root, member))
    const metadata = JSON.parse(await readFile(metadataFile.path, 'utf8'))
    if (metadataFile.expected.sha256 !== top.expected.sha256
      && (metadata.name !== topMetadata.name || metadata.version !== topMetadata.version
        || mainOf(metadata) !== mainOf(topMetadata))) continue
    const packageRoot = dirname(metadataFile.path)
    const entryPath = resolve(packageRoot, mainOf(metadata))
    if (isAbsolute(mainOf(metadata)) || !entryPath.startsWith(`${packageRoot}${sep}`)) {
      throw new Error('runtime_package_sqlite_entry_outside_package')
    }
    // A top-level metadata-only stub is valid. A declared but missing main file is corruption.
    const entryStat = await lstat(entryPath).catch(error => {
      if (error.code === 'ENOENT' && !members.has(relativeMember(entryPath))) return null
      throw error
    })
    if (!entryStat) continue
    const entry = await declaredFile(entryPath)
    const packageMember = relativeMember(packageRoot)
    const nativeMembers = [...members.keys()].filter(pathname => pathname.startsWith(`${packageMember}/`)
      && pathname.endsWith('/better_sqlite3.node'))
    if (nativeMembers.length !== 1) throw new Error('runtime_package_sqlite_native_ambiguous_or_missing')
    const native = await declaredFile(resolve(root, nativeMembers[0]))
    candidates.set(entry.path, { entrypoint: entry.path, nativeBinding: native.path,
      packageJsonSha256: metadataFile.expected.sha256, name: metadata.name, version: metadata.version })
  }
  if (candidates.size !== 1) throw new Error('runtime_package_sqlite_package_ambiguous_or_missing')
  return [...candidates.values()][0]
}

export async function probeArtifactSqlite(artifactRoot, manifest) {
  const selected = await resolveArtifactSqlitePackage(artifactRoot, manifest)
  const required = createRequire(selected.entrypoint)
  const Database = required(selected.entrypoint)
  // The explicit audited addon prevents native search paths or caller modules from supplying a different ABI.
  // Native loading is deliberately outside the resolver: ABI failures are fatal, never another lookup attempt.
  const db = new Database(':memory:', { nativeBinding: selected.nativeBinding })
  try {
    if (db.prepare('SELECT 1 AS ok').get()?.ok !== 1) throw new Error('runtime_package_sqlite_probe_failed')
  } finally { db.close() }
  return { ok: true, name: selected.name, version: selected.version, packageJsonSha256: selected.packageJsonSha256 }
}
export function validatePackageReceipt(receipt, runtime = currentPackageRuntime()) {
  if (receipt?.schema !== SCHEMA || !/^[a-f0-9]{40}$/u.test(receipt.sourceCommit || '')
    || !SHA.test(receipt.archiveSha256 || '') || !SHA.test(receipt.manifestSha256 || '')
    || !Number.isSafeInteger(receipt.bytes) || receipt.bytes < 1
    || typeof receipt.archive !== 'string' || basename(receipt.archive) !== receipt.archive
    || !/^runtime-[a-f0-9]{40}-[a-z0-9]+-[a-z0-9]+-node\d+\.tar\.gz$/u.test(receipt.archive)
    || !receipt.runtime || !receipt.artifactContent || receipt.verification !== 'candidate'
    || !Object.hasOwn(receipt, 'ci')) throw new Error('runtime_package_receipt_invalid')
  if (receipt.ci !== null) validateCiSource(receipt.ci, receipt.sourceCommit)
  const promotion = receipt.ci ? 'quality-gate-success' : 'explicit-local-validation-receipt'
  if (receipt.promotionRequirement !== promotion
    || receipt.archive !== `runtime-${receipt.sourceCommit}-${receipt.runtime.platform}-${receipt.runtime.arch}-node${receipt.runtime.nodeAbi}.tar.gz`) {
    throw new Error('runtime_package_receipt_identity_mismatch')
  }
  for (const key of ['platform', 'arch', 'nodeMajor', 'nodeAbi']) {
    if (receipt.runtime[key] !== runtime[key]) throw new Error(`runtime_package_${key}_mismatch`)
  }
  return receipt
}
export async function verifyRuntimePackage(receiptPath, runtime = currentPackageRuntime(), options = {}) {
  const file = resolve(receiptPath)
  const entry = await lstat(file)
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 1024 * 1024) {
    throw new Error('runtime_package_receipt_unsafe')
  }
  const receipt = validatePackageReceipt(JSON.parse(await readFile(file, 'utf8')), runtime)
  const archive = join(resolve(file, '..'), receipt.archive)
  const archiveEntry = await lstat(archive)
  if (!archiveEntry.isFile() || archiveEntry.isSymbolicLink()
    || archiveEntry.size !== receipt.bytes || await fileHash(archive) !== receipt.archiveSha256) {
    throw new Error('runtime_package_archive_changed')
  }
  const ciVerification = options.requireCiSuccess ? verifyPackageCiSuccess(receipt, options) : null
  return { ok: true, receipt, archive, ciVerification }
}
export async function packRuntimeArtifact(artifactRoot, outputDir) {
  const root = resolve(artifactRoot)
  const output = resolve(outputDir)
  if (output === root || output.startsWith(`${root}/`)) throw new Error('runtime_package_output_inside_source')
  const audited = await auditStandaloneArtifact(root)
  const provenance = JSON.parse(await readFile(join(root, 'release-provenance.json'), 'utf8'))
  if (!/^[a-f0-9]{40}$/u.test(provenance.gitCommit || '') || provenance.gitDirty !== false
    || provenance.buildSourceAnchor?.gitDirty !== false) throw new Error('runtime_package_source_not_sealed')
  // Loading an actual SQLite database verifies the package's native ABI on the
  // packaging host; runtime metadata must describe the bytes, not CI labels.
  const manifestSource = await readFile(join(root, 'release-manifest.json'))
  if (hash(manifestSource) !== audited.verificationBundle.identities['release-manifest.json'].sha256) {
    throw new Error('runtime_package_audited_manifest_changed')
  }
  await probeArtifactSqlite(root, JSON.parse(manifestSource.toString('utf8')))
  const runtime = currentPackageRuntime()
  const ci = packageCiSource(provenance.gitCommit)
  const name = `runtime-${provenance.gitCommit}-${runtime.platform}-${runtime.arch}-node${runtime.nodeAbi}`
  const archive = `${name}.tar.gz`
  const receiptPath = join(output, `${name}.json`)
  const manifestSha256 = hash(manifestSource)
  await mkdir(output, { recursive: true, mode: 0o700 })
  if (await lstat(receiptPath).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))) {
    const previous = await verifyRuntimePackage(receiptPath)
    if (previous.receipt.manifestSha256 !== manifestSha256) throw new Error('runtime_package_same_name_different_content')
    if (JSON.stringify(previous.receipt.ci) !== JSON.stringify(ci)) throw new Error('runtime_package_ci_source_changed')
    return { ...previous, reused: true }
  }
  const archivePath = join(output, archive)
  const pending = `${archivePath}.partial`
  if (await lstat(archivePath).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))) {
    throw new Error('runtime_package_uncommitted_archive_exists')
  }
  await writeFile(pending, '', { flag: 'wx', mode: 0o600 })
  try {
    execFileSync('/usr/bin/tar', ['--no-xattrs', '-czf', pending, '-C', root, '.'], {
      env: { ...process.env, COPYFILE_DISABLE: '1' }, stdio: ['ignore', 'ignore', 'pipe'],
    })
    await verifyStandaloneVerificationBundle(root, audited.verificationBundle)
    const receipt = { schema: SCHEMA, sourceCommit: provenance.gitCommit, runtime,
      archive, archiveSha256: await fileHash(pending), bytes: (await lstat(pending)).size,
      manifestSha256, artifactContent: audited.artifactContent,
      ci, verification: 'candidate',
      promotionRequirement: ci ? 'quality-gate-success' : 'explicit-local-validation-receipt' }
    validatePackageReceipt(receipt)
    await rename(pending, archivePath)
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    return { ok: true, receipt, archive: archivePath, receiptPath, reused: false }
  } finally {
    await rm(pending, { force: true })
  }
}
async function main(argv) {
  const [command, ...args] = argv
  const values = new Map()
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i]
    if (!flag?.startsWith('--') || values.has(flag)) throw new Error('runtime_package_arguments_invalid')
    if (flag === '--require-ci-success') { values.set(flag, true); continue }
    if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('runtime_package_arguments_invalid')
    values.set(flag, args[++i])
  }
  let result
  if (command === 'pack' && values.size === 2 && values.has('--artifact') && values.has('--output')) {
    result = await packRuntimeArtifact(values.get('--artifact'), values.get('--output'))
  } else if (command === 'verify' && values.has('--receipt')
    && [...values.keys()].every(key => ['--receipt', '--require-ci-success'].includes(key))) {
    result = await verifyRuntimePackage(values.get('--receipt'), currentPackageRuntime(), {
      requireCiSuccess: values.has('--require-ci-success'),
    })
  } else throw new Error('usage: package-runtime-artifact.mjs pack --artifact ROOT --output DIR | verify --receipt FILE [--require-ci-success]')
  process.stdout.write(`${JSON.stringify(result)}\n`)
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
}
