#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  lstatSync, readFileSync, readdirSync, realpathSync,
} from 'node:fs'
import { homedir } from 'node:os'
import {
  dirname, isAbsolute, join, posix, relative, resolve,
} from 'node:path'
import { fileURLToPath } from 'node:url'

import { auditStandaloneArtifact } from './check-standalone-artifact.mjs'

const MODULE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHA256 = /^[a-f0-9]{64}$/u
const GIT_COMMIT = /^[a-f0-9]{40}$/u
const RELEASE_ID = /^([a-f0-9]{7,40})(?:-runtime)?$/u
const EXPECTED_APP_VERSION = '2.0.1'
const EXPECTED_VIDEO_COMMAND_VERSION = '0.5.14'
const EXPECTED_DIRECTOR_BRAIN_VERSION = '0.3.1'
const OUTBOX_CLOSURE_CONSTANTS = Object.freeze({
  DIRECTOR_BRAIN_CLI_SHA256: 'scripts/feishu-director-brain.mjs',
  DIRECTOR_BRAIN_SERVICE_SHA256: 'scripts/lib/feishu-director-brain.mjs',
  DIRECTOR_BRAIN_SCHEMA_SHA256: 'ops/feishu-director-brain/schema.json',
  DIRECTOR_EVIDENCE_TRANSFORMER_SHA256:
    'openclaw-skills/aiworker-task-flow/scripts/project-director-evidence.mjs',
  DIRECTOR_EVIDENCE_LIBRARY_SHA256:
    'openclaw-skills/aiworker-task-flow/lib/director-brain-evidence.mjs',
  DIRECTOR_EVIDENCE_APP_PROJECTION_SEMANTICS_SHA256:
    'src/lib/director-evidence-projection-semantics.ts',
  DIRECTOR_EVIDENCE_DELIVERY_CORE_SHA256:
    'src/lib/director-evidence-delivery-core.ts',
})

function fail(message) {
  throw new Error(`director_video_release_not_ready:${message}`)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`
  }
  const encoded = JSON.stringify(value)
  return encoded === undefined ? 'null' : encoded
}

function fileSha256(pathname) {
  return sha256(readFileSync(pathname))
}

function assertPhysicalDirectory(pathname, label) {
  if (typeof pathname !== 'string' || !isAbsolute(pathname)) fail(`${label}_path_invalid`)
  let entry
  let physical
  try {
    entry = lstatSync(pathname)
    physical = realpathSync.native(pathname)
  } catch {
    fail(`${label}_missing`)
  }
  if (!entry.isDirectory() || entry.isSymbolicLink() || physical !== resolve(pathname)) {
    fail(`${label}_unsafe`)
  }
  if ((entry.mode & 0o0022) !== 0) fail(`${label}_writable_by_others`)
  return physical
}

function safeFile(pathname, label) {
  let entry
  try {
    entry = lstatSync(pathname)
  } catch {
    fail(`${label}_missing`)
  }
  if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o6022) !== 0) {
    fail(`${label}_unsafe`)
  }
  return entry
}

function walkTree(root) {
  const directories = []
  const files = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const pathname = join(directory, entry.name)
      const member = relative(root, pathname).split('\\').join('/')
      const stats = lstatSync(pathname)
      if (entry.isSymbolicLink() || stats.isSymbolicLink()) fail(`payload_symlink:${member}`)
      if ((stats.mode & 0o0022) !== 0) fail(`payload_writable_by_others:${member}`)
      if (entry.isDirectory()) {
        directories.push(member)
        visit(pathname)
      } else if (entry.isFile()) {
        if ((stats.mode & 0o6000) !== 0) fail(`payload_setid_file:${member}`)
        files.push({ path: member, sha256: fileSha256(pathname) })
      } else {
        fail(`payload_unsupported_member:${member}`)
      }
    }
  }
  visit(root)
  directories.sort()
  files.sort((left, right) => left.path.localeCompare(right.path))
  return { directories, files }
}

function manifestDigest(manifest) {
  return sha256(JSON.stringify(manifest))
}

function selectedSourceManifest(repositoryRoot, members) {
  const files = members.map(member => {
    const pathname = join(repositoryRoot, member.source)
    safeFile(pathname, `source_${member.source.replaceAll('/', '_')}`)
    return { path: member.target, sha256: fileSha256(pathname) }
  }).sort((left, right) => left.path.localeCompare(right.path))
  const directorySet = new Set()
  for (const file of files) {
    let cursor = posix.dirname(file.path)
    while (cursor !== '.') {
      directorySet.add(cursor)
      cursor = posix.dirname(cursor)
    }
  }
  return { directories: [...directorySet].sort(), files }
}

function recursiveSourceMembers(repositoryRoot, sourceRelative, targetPrefix = '') {
  const sourceRoot = assertPhysicalDirectory(join(repositoryRoot, sourceRelative), 'source_tree')
  return walkTree(sourceRoot).files.map(file => ({
    source: posix.join(sourceRelative, file.path),
    target: targetPrefix ? posix.join(targetPrefix, file.path) : file.path,
  }))
}

function videoCommandMembers(repositoryRoot) {
  const base = 'openclaw-plugins/aiworker-video-command'
  return [
    'index.js', 'openclaw.plugin.json', 'package.json',
    ...walkTree(join(repositoryRoot, base, 'lib')).files.map(file => `lib/${file.path}`),
    ...walkTree(join(repositoryRoot, base, 'scripts')).files.map(file => `scripts/${file.path}`),
  ].map(member => ({ source: `${base}/${member}`, target: member }))
}

function taskFlowMembers(repositoryRoot) {
  const base = 'openclaw-skills/aiworker-task-flow'
  const members = [{ source: `${base}/SKILL.md`, target: 'SKILL.md' }]
  for (const directory of ['scripts', 'lib']) {
    const root = assertPhysicalDirectory(join(repositoryRoot, base, directory), `task_flow_${directory}`)
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.mjs')) {
        members.push({ source: `${base}/${directory}/${entry.name}`, target: `${directory}/${entry.name}` })
      }
    }
  }
  return members
}

function directorBrainPluginMembers(repositoryRoot) {
  const base = 'openclaw-plugins/aiworker-director-brain'
  return [
    { source: `${base}/index.js`, target: 'index.js' },
    { source: `${base}/openclaw.plugin.json`, target: 'openclaw.plugin.json' },
    { source: `${base}/package.json`, target: 'package.json' },
    ...recursiveSourceMembers(repositoryRoot, `${base}/lib`, 'lib'),
    {
      source: 'scripts/feishu-director-brain.mjs',
      target: 'runtime/scripts/feishu-director-brain.mjs',
    },
    {
      source: 'scripts/lib/feishu-director-brain.mjs',
      target: 'runtime/scripts/lib/feishu-director-brain.mjs',
    },
    {
      source: 'ops/feishu-director-brain/schema.json',
      target: 'runtime/ops/feishu-director-brain/schema.json',
    },
  ]
}

function assertManifestMatches(repositoryRoot, installedRoot, members, label) {
  const physicalRoot = assertPhysicalDirectory(installedRoot, label)
  const expected = selectedSourceManifest(repositoryRoot, members)
  const actual = walkTree(physicalRoot)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${label}_manifest_mismatch`)
  return {
    root: physicalRoot,
    manifestSha256: manifestDigest(actual),
    files: actual.files.length,
  }
}

function readVersion(pathname, label) {
  safeFile(pathname, label)
  let value
  try {
    value = JSON.parse(readFileSync(pathname, 'utf8'))?.version
  } catch {
    fail(`${label}_invalid`)
  }
  if (typeof value !== 'string' || !value) fail(`${label}_invalid`)
  return value
}

function assertVersionPair(root, expected, label) {
  const packageVersion = readVersion(join(root, 'package.json'), `${label}_package`)
  const manifestVersion = readVersion(join(root, 'openclaw.plugin.json'), `${label}_manifest`)
  if (packageVersion !== expected || manifestVersion !== expected) fail(`${label}_version_mismatch`)
  return packageVersion
}

function parseOutboxClosure(repositoryRoot) {
  const sourcePath = join(repositoryRoot, 'src/lib/director-evidence-outbox.ts')
  safeFile(sourcePath, 'outbox_source')
  const source = readFileSync(sourcePath, 'utf8')
  const result = {}
  for (const [constant, member] of Object.entries(OUTBOX_CLOSURE_CONSTANTS)) {
    const match = source.match(new RegExp(`const ${constant} = '([a-f0-9]{64})'`, 'u'))
    const actual = fileSha256(join(repositoryRoot, member))
    if (!match || match[1] !== actual) fail(`outbox_closure_mismatch:${constant}`)
    result[constant] = actual
  }
  return result
}

function parseProjectionContract(repositoryRoot, closure) {
  const source = readFileSync(join(repositoryRoot, 'src/lib/director-evidence-outbox.ts'), 'utf8')
  const authority = source.match(
    /export const DIRECTOR_EVIDENCE_PROJECTION_CONTRACT_AUTHORITY\s*=\s*'([^']+)'/u,
  )?.[1]
  const schemaVersion = Number(source.match(
    /export const DIRECTOR_EVIDENCE_PROJECTION_SCHEMA_VERSION\s*=\s*(\d+)/u,
  )?.[1])
  if (authority !== 'director-evidence-projection-contract-v1'
    || !Number.isSafeInteger(schemaVersion) || schemaVersion < 1) {
    fail('projection_contract_source_invalid')
  }
  const contract = {
    authority,
    schemaVersion,
    directorBrainCliSha256: closure.DIRECTOR_BRAIN_CLI_SHA256,
    directorBrainServiceSha256: closure.DIRECTOR_BRAIN_SERVICE_SHA256,
    directorBrainSchemaSha256: closure.DIRECTOR_BRAIN_SCHEMA_SHA256,
    evidenceTransformerSha256: closure.DIRECTOR_EVIDENCE_TRANSFORMER_SHA256,
    evidenceLibrarySha256: closure.DIRECTOR_EVIDENCE_LIBRARY_SHA256,
    appProjectionSemanticsSha256:
      closure.DIRECTOR_EVIDENCE_APP_PROJECTION_SEMANTICS_SHA256,
    deliveryCoreSha256: closure.DIRECTOR_EVIDENCE_DELIVERY_CORE_SHA256,
  }
  return {
    authority,
    schemaVersion,
    currentDigest: sha256(canonicalJson(contract)),
  }
}

function physicalDatabaseFile(pathname) {
  if (typeof pathname !== 'string' || !isAbsolute(pathname)) fail('live_database_path_invalid')
  safeFile(pathname, 'live_database')
  let physical
  try {
    physical = realpathSync.native(pathname)
  } catch {
    fail('live_database_missing')
  }
  if (physical !== resolve(pathname)) fail('live_database_unsafe')
  return physical
}

export function inspectDirectorEvidenceOutboxCompatibility({
  repositoryRoot,
  liveDbPath,
  currentDigest,
}) {
  const repository = assertPhysicalDirectory(repositoryRoot, 'repository')
  const databasePath = physicalDatabaseFile(liveDbPath)
  if (typeof currentDigest !== 'string' || !SHA256.test(currentDigest)) {
    fail('projection_contract_digest_invalid')
  }
  let Database
  try {
    Database = createRequire(join(repository, 'package.json'))('better-sqlite3')
  } catch {
    fail('sqlite_runtime_unavailable')
  }
  let database
  try {
    database = new Database(databasePath, { readonly: true, fileMustExist: true })
    database.pragma('query_only = ON')
    const table = database.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'table' AND name = 'n8n_director_evidence_outbox'
    `).get()
    if (!table || typeof table.sql !== 'string'
      || !table.sql.includes('projection_contract_digest')) {
      fail('projection_outbox_schema_invalid')
    }
    const row = database.prepare(`
      SELECT COUNT(*) AS pending,
        COALESCE(SUM(CASE WHEN projection_contract_digest <> ? THEN 1 ELSE 0 END), 0)
          AS incompatible_pending
      FROM n8n_director_evidence_outbox
      WHERE status = 'pending'
    `).get(currentDigest)
    const pending = Number(row?.pending)
    const incompatiblePending = Number(row?.incompatible_pending)
    if (!Number.isSafeInteger(pending) || pending < 0
      || !Number.isSafeInteger(incompatiblePending) || incompatiblePending < 0
      || incompatiblePending > pending) fail('projection_outbox_counts_invalid')
    return {
      schema: 'video-autoworker-director-evidence-outbox-readiness/v1',
      currentDigest,
      pending,
      incompatiblePending,
    }
  } catch (error) {
    if (error instanceof Error
      && error.message.startsWith('director_video_release_not_ready:')) throw error
    fail('projection_outbox_inspection_failed')
  } finally {
    try { database?.close() } catch { /* read-only close failure is reported by the process */ }
  }
}

function assertTaskFlowDirectorWork(repositoryRoot, installedTaskFlowRoot) {
  const source = readFileSync(join(repositoryRoot,
    'openclaw-skills/aiworker-task-flow/scripts/submit-task.mjs'), 'utf8')
  const installed = readFileSync(join(installedTaskFlowRoot, 'scripts/submit-task.mjs'), 'utf8')
  for (const contract of [
    "const directorWork = option('--director-work')",
    'assertOptionalDirectorWork(directorWork',
    'directorWork,',
  ]) {
    if (!source.includes(contract) || !installed.includes(contract)) {
      fail('task_flow_director_work_contract_missing')
    }
  }
  return true
}

export function verifyInstalledReleasePayloads({
  repositoryRoot,
  profileStateRoot,
  workspaceRoot,
}) {
  const repository = assertPhysicalDirectory(repositoryRoot, 'repository')
  const profile = assertPhysicalDirectory(profileStateRoot, 'profile_state')
  const workspace = assertPhysicalDirectory(workspaceRoot, 'workspace')
  const videoRoot = join(profile, 'extensions', 'aiworker-video-command')
  const taskFlowRoot = join(workspace, 'skills', 'aiworker-task-flow')
  const directorPluginRoot = join(profile, 'extensions', 'aiworker-director-brain')
  const directorSkillRoot = join(workspace, 'skills', 'aiworker-director-brain')

  const videoCommand = assertManifestMatches(
    repository, videoRoot, videoCommandMembers(repository), 'video_command',
  )
  videoCommand.version = assertVersionPair(
    videoRoot, EXPECTED_VIDEO_COMMAND_VERSION, 'video_command',
  )
  const taskFlow = assertManifestMatches(
    repository, taskFlowRoot, taskFlowMembers(repository), 'task_flow',
  )
  const directorBrain = assertManifestMatches(
    repository, directorPluginRoot, directorBrainPluginMembers(repository), 'director_brain',
  )
  directorBrain.version = assertVersionPair(
    directorPluginRoot, EXPECTED_DIRECTOR_BRAIN_VERSION, 'director_brain',
  )
  const directorSkillMembers = recursiveSourceMembers(
    repository, 'openclaw-skills/aiworker-director-brain', '',
  )
  const directorSkill = assertManifestMatches(
    repository, directorSkillRoot, directorSkillMembers, 'director_brain_skill',
  )
  assertTaskFlowDirectorWork(repository, taskFlowRoot)
  const closure = parseOutboxClosure(repository)
  const projectionContract = parseProjectionContract(repository, closure)
  return { videoCommand, taskFlow, directorBrain, directorSkill, closure, projectionContract }
}

function gitOutput(repositoryRoot, args) {
  try {
    return execFileSync('git', ['-C', repositoryRoot, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    fail('git_identity_invalid')
  }
}

function gitSucceeds(repositoryRoot, args) {
  try {
    execFileSync('git', ['-C', repositoryRoot, ...args], {
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    return true
  } catch {
    return false
  }
}

export function assertRepositoryRelease(repositoryRoot, releaseId, mode = 'head') {
  const match = RELEASE_ID.exec(releaseId)
  if (!match) fail('release_id_invalid')
  if (!['head', 'ancestor'].includes(mode)) fail('repository_release_mode_invalid')
  const head = gitOutput(repositoryRoot, ['rev-parse', '--verify', 'HEAD^{commit}'])
  const resolved = gitOutput(repositoryRoot, ['rev-parse', '--verify', `${match[1]}^{commit}`])
  const branch = gitOutput(repositoryRoot, ['symbolic-ref', '--short', '-q', 'HEAD'])
  const status = gitOutput(repositoryRoot, ['status', '--porcelain', '--untracked-files=normal'])
  const remote = gitOutput(repositoryRoot, ['remote', 'get-url', 'origin'])
  const releaseAccepted = mode === 'head'
    ? resolved === head
    : gitSucceeds(repositoryRoot, ['merge-base', '--is-ancestor', resolved, head])
  if (!GIT_COMMIT.test(head) || !GIT_COMMIT.test(resolved) || !releaseAccepted
    || branch !== 'main' || status) {
    fail('repository_release_mismatch')
  }
  if (![
    'https://github.com/MAKingljx/video-autoworker',
    'https://github.com/MAKingljx/video-autoworker.git',
    'git@github.com:MAKingljx/video-autoworker.git',
  ].includes(remote)) fail('repository_remote_mismatch')
  return resolved
}

function assertReleaseContainsClosure(releaseRoot, closure) {
  const serverRoot = assertPhysicalDirectory(join(releaseRoot, '.next', 'server'), 'app_server')
  const missing = new Set(Object.values(closure))
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const pathname = join(directory, entry.name)
      if (entry.isDirectory()) visit(pathname)
      else if (entry.isFile() && /\.(?:js|mjs|cjs)$/u.test(entry.name)) {
        const contents = readFileSync(pathname, 'utf8')
        for (const digest of missing) if (contents.includes(digest)) missing.delete(digest)
      }
    }
  }
  visit(serverRoot)
  if (missing.size > 0) fail('app_outbox_closure_missing')
}

export async function verifyDirectorVideoReleaseReadiness({
  repositoryRoot,
  releasesRoot,
  releaseRoot,
  releaseId,
  profileStateRoot,
  workspaceRoot,
  liveDbPath,
  repositoryReleaseMode = 'head',
}) {
  const repository = assertPhysicalDirectory(repositoryRoot, 'repository')
  const releases = assertPhysicalDirectory(releasesRoot, 'releases')
  const release = assertPhysicalDirectory(releaseRoot, 'app_release')
  if (release !== join(releases, releaseId, 'standalone')) fail('app_release_boundary_mismatch')
  const commit = assertRepositoryRelease(repository, releaseId, repositoryReleaseMode)
  await auditStandaloneArtifact(release)
  const appVersion = readVersion(join(release, 'package.json'), 'app_package')
  const sourceVersion = readVersion(join(repository, 'package.json'), 'source_package')
  if (appVersion !== EXPECTED_APP_VERSION || sourceVersion !== EXPECTED_APP_VERSION) {
    fail('app_version_mismatch')
  }
  const payloads = verifyInstalledReleasePayloads({
    repositoryRoot: repository,
    profileStateRoot,
    workspaceRoot,
  })
  const projectionOutbox = inspectDirectorEvidenceOutboxCompatibility({
    repositoryRoot: repository,
    liveDbPath,
    currentDigest: payloads.projectionContract.currentDigest,
  })
  if (projectionOutbox.incompatiblePending !== 0) {
    fail(`projection_contract_incompatible_pending:${projectionOutbox.incompatiblePending}`)
  }
  assertReleaseContainsClosure(release, payloads.closure)
  const releaseManifestPath = join(release, 'release-manifest.json')
  safeFile(releaseManifestPath, 'app_release_manifest')
  return {
    schema: 'video-autoworker-director-video-readiness/v1',
    ok: true,
    commit,
    app: {
      releaseId,
      version: appVersion,
      root: release,
      manifestSha256: fileSha256(releaseManifestPath),
    },
    payloads,
    projectionOutbox,
    contracts: {
      directorWork: true,
      outboxClosure: true,
      projectionContractCompatible: true,
    },
  }
}

function parseArguments(argv) {
  const values = new Map()
  const allowed = new Set([
    '--repository-root', '--releases-root', '--release-root', '--release-id',
    '--profile-state-root', '--workspace-root', '--live-db-path', '--repository-release-mode',
  ])
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!allowed.has(key) || value === undefined || value.startsWith('--') || values.has(key)) {
      fail('arguments_invalid')
    }
    values.set(key, value)
  }
  const repositoryRoot = values.get('--repository-root') || MODULE_ROOT
  const releasesRoot = values.get('--releases-root') || join(repositoryRoot, '.runtime', 'releases')
  const releaseId = values.get('--release-id')
  const releaseRoot = values.get('--release-root')
  const profileStateRoot = values.get('--profile-state-root') || join(homedir(), '.openclaw-qwen-current')
  const workspaceRoot = values.get('--workspace-root') || join(homedir(), 'AI-worker-second-original-workspace')
  const liveDbPath = values.get('--live-db-path')
  const repositoryReleaseMode = values.get('--repository-release-mode') || 'head'
  if (!releaseId || !releaseRoot || !liveDbPath) fail('arguments_invalid')
  return {
    repositoryRoot, releasesRoot, releaseRoot, releaseId, profileStateRoot, workspaceRoot,
    liveDbPath, repositoryReleaseMode,
  }
}

const invokedPath = process.argv[1] ? realpathSync.native(process.argv[1]) : null
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const result = await verifyDirectorVideoReleaseReadiness(parseArguments(process.argv.slice(2)))
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'director_video_release_not_ready:unknown'
    process.stderr.write(`${JSON.stringify({ ok: false, error: message })}\n`)
    process.exitCode = 1
  }
}
