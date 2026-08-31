#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, parse, relative } from 'node:path'

const WORKFLOW_PROTOCOL = 'slot-v1-execution-owner-v1'
const N8N_VERSION = '2.31.6'
const N8N_LAUNCH_LABEL = 'com.video-autoworker.n8n'
const RUNTIME_SOURCE_PATHS = Object.freeze([
  'scripts/n8n-start.sh',
  'scripts/n8n-stop.sh',
  'scripts/n8n-status.sh',
  'scripts/n8n-import-workflows.sh',
  'ops/n8n/.env.example',
  'ops/n8n/lib/common.sh',
  'ops/n8n/package.json',
  'ops/n8n/package-lock.json',
  'ops/n8n/workflows/aiworker-task-intake.json',
  'ops/n8n/workflows/aiworker-video-analysis.json',
])
const WORKFLOWS = Object.freeze([
  { id: 'aiworker-task-intake-v1', file: 'aiworker-task-intake.json', callbackCount: 4 },
  { id: 'aiworker-video-analysis-v1', file: 'aiworker-video-analysis.json', callbackCount: 5 },
])

function fail(message) {
  process.stderr.write(`n8n blue-green workflow compatibility failed: ${message}\n`)
  process.exit(1)
}

function parseArguments(argv) {
  const names = [
    '--database', '--repository', '--expected-commit', '--module-root', '--pid', '--port',
  ]
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!names.includes(name) || !value) fail(`expected ${names.join(', ')}`)
    if (Object.hasOwn(values, name)) fail(`duplicate argument ${name}`)
    values[name] = value
  }
  if (Object.keys(values).length !== names.length) fail(`expected ${names.join(', ')}`)
  for (const [name, value] of Object.entries(values)
    .filter(([name]) => !['--expected-commit', '--pid', '--port'].includes(name))) {
    if (!isAbsolute(value) || /[\r\n]/u.test(value)) fail(`${name} must be one absolute path`)
  }
  const expectedCommit = values['--expected-commit']
  if (!/^[a-f0-9]{40}$/u.test(expectedCommit)) fail('--expected-commit must be one full Git commit')
  const pid = Number(values['--pid'])
  if (!Number.isSafeInteger(pid) || pid <= 0) fail('--pid must be one positive process ID')
  const port = Number(values['--port'])
  if (!Number.isSafeInteger(port) || port !== 5678) fail('--port must be 5678')

  let database
  let repository
  let moduleRoot
  try {
    assertNoSymlink(values['--database'], 'n8n database argument')
    database = realpathSync(values['--database'])
    repository = realpathSync(values['--repository'])
    moduleRoot = realpathSync(values['--module-root'])
  } catch {
    fail('one required path is unavailable')
  }
  let resolvedCommit
  try {
    resolvedCommit = execFileSync('/usr/bin/git', [
      '-C', repository, 'rev-parse', '--verify', `${expectedCommit}^{commit}`,
    ], { encoding: 'utf8' }).trim()
  } catch {
    fail('--expected-commit is unavailable in the repository')
  }
  if (resolvedCommit !== expectedCommit) fail('--expected-commit did not resolve exactly')
  return { database, repository, expectedCommit, moduleRoot, pid, port }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]))
  }
  return value
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value))
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function testCommand(name, standardPath) {
  const variable = `AIWORKER_TEST_N8N_${name.toUpperCase()}`
  if (process.env.NODE_ENV === 'test' && process.env.AIWORKER_TEST_N8N_IDENTITY === '1') {
    const override = process.env[variable]
    if (override) {
      if (!isAbsolute(override) || /[\r\n]/u.test(override)) fail(`${variable} is invalid`)
      return override
    }
  }
  return standardPath
}

const COMMANDS = Object.freeze({
  launchctl: testCommand('launchctl', '/bin/launchctl'),
  lsof: testCommand('lsof', '/usr/sbin/lsof'),
  ps: testCommand('ps', '/bin/ps'),
})

function run(command, args, label) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  } catch {
    fail(`${label} failed`)
  }
}

function assertNoSymlink(pathname, label) {
  if (!isAbsolute(pathname) || /[\r\n]/u.test(pathname)) fail(`${label} path is invalid`)
  const root = parse(pathname).root
  let current = root
  const parts = relative(root, pathname).split('/').filter(Boolean)
  for (const part of parts) {
    current = join(current, part)
    let entry
    try {
      entry = lstatSync(current)
    } catch {
      fail(`${label} path component is unavailable`)
    }
    if (entry.isSymbolicLink()) fail(`${label} path contains a symlink`)
  }
}

function pathIdentity(pathname, label, kind) {
  assertNoSymlink(pathname, label)
  let value
  try {
    value = statSync(pathname, { bigint: true })
  } catch {
    fail(`${label} is unavailable`)
  }
  if (kind === 'file' && !value.isFile()) fail(`${label} is not a regular file`)
  if (kind === 'directory' && !value.isDirectory()) fail(`${label} is not a directory`)
  return {
    path: pathname,
    dev: value.dev.toString(),
    ino: value.ino.toString(),
    size: value.size.toString(),
    mtimeNs: value.mtimeNs.toString(),
    ctimeNs: value.ctimeNs.toString(),
    mode: (value.mode & 0o7777n).toString(8),
    uid: value.uid.toString(),
    nlink: value.nlink.toString(),
  }
}

function secureArgumentPath(pathname, label) {
  if (!isAbsolute(pathname) || /[\s\r\n]/u.test(pathname)) fail(`${label} argv path is invalid`)
  const root = parse(pathname).root
  let current = root
  const components = []
  for (const part of relative(root, pathname).split('/').filter(Boolean)) {
    current = join(current, part)
    let entry
    try {
      entry = lstatSync(current, { bigint: true })
    } catch {
      fail(`${label} argv path component is unavailable`)
    }
    const uid = entry.uid.toString()
    const mode = entry.mode & 0o7777n
    if (![0n, BigInt(process.getuid())].includes(entry.uid)
      || (!entry.isSymbolicLink() && (mode & 0o022n) !== 0n)) {
      fail(`${label} argv path component is not controlled`)
    }
    const component = {
      path: current,
      dev: entry.dev.toString(),
      ino: entry.ino.toString(),
      uid,
      mode: mode.toString(8),
      type: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : 'file',
    }
    // Directory link counts change whenever an unrelated child is created or
    // removed, so they are not a stable process-identity signal. The directory
    // dev/inode pair still detects replacement; retain nlink for files/links.
    if (!entry.isDirectory()) component.nlink = entry.nlink.toString()
    if (entry.isSymbolicLink()) {
      const target = readlinkSync(current)
      if (!target || /[\r\n]/u.test(target)) fail(`${label} argv symlink target is invalid`)
      component.target = target
    }
    components.push(component)
  }
  let resolvedPath
  try {
    resolvedPath = realpathSync.native(pathname)
  } catch {
    fail(`${label} argv path cannot be resolved`)
  }
  return {
    argumentPath: pathname,
    resolvedPath,
    components,
    target: pathIdentity(resolvedPath, `${label} resolved target`, 'file'),
  }
}

function gitSource(repository, expectedCommit, pathname) {
  return run('/usr/bin/git', [
    '-C', repository, 'show', `${expectedCommit}:${pathname}`,
  ], `Git source read for ${pathname}`)
}

function parseKeyValueManifest(source) {
  const result = {}
  for (const line of source.trimEnd().split('\n')) {
    const separator = line.indexOf('=')
    if (separator <= 0) fail('SOURCE_MANIFEST has an invalid line')
    const key = line.slice(0, separator)
    const value = line.slice(separator + 1)
    if (Object.hasOwn(result, key) || !value) fail('SOURCE_MANIFEST has duplicate or empty fields')
    result[key] = value
  }
  const expectedKeys = [
    'built_at', 'n8n_version', 'package_lock_sha256', 'runtime_source_manifest_sha256',
    'source_commit', 'source_origin', 'video_workflow_sha256', 'workflow_sha256',
  ]
  if (canonicalJson(Object.keys(result).sort()) !== canonicalJson(expectedKeys)) {
    fail('SOURCE_MANIFEST fields are incompatible')
  }
  return result
}

function expectedRuntimeSourceManifest(repository, expectedCommit) {
  return `${RUNTIME_SOURCE_PATHS.map(pathname =>
    `${sha256(gitSource(repository, expectedCommit, pathname))}  ${pathname}`).join('\n')}\n`
}

function validateRuntimeFiles(runtimeRoot, repository, expectedCommit) {
  const sourceCommitPath = join(runtimeRoot, 'SOURCE_COMMIT')
  const sourceManifestPath = join(runtimeRoot, 'SOURCE_MANIFEST')
  const runtimeManifestPath = join(runtimeRoot, 'RUNTIME_SOURCE_SHA256SUMS')
  const packagePath = join(runtimeRoot, 'ops/n8n/node_modules/n8n/package.json')
  const files = {
    sourceCommit: pathIdentity(sourceCommitPath, 'SOURCE_COMMIT', 'file'),
    sourceManifest: pathIdentity(sourceManifestPath, 'SOURCE_MANIFEST', 'file'),
    runtimeManifest: pathIdentity(runtimeManifestPath, 'RUNTIME_SOURCE_SHA256SUMS', 'file'),
    n8nPackage: pathIdentity(packagePath, 'n8n package', 'file'),
  }
  const sourceCommit = readFileSync(sourceCommitPath, 'utf8')
  if (sourceCommit !== `${expectedCommit}\n`) fail('n8n release source commit does not match exactly')

  const expectedRuntimeManifest = expectedRuntimeSourceManifest(repository, expectedCommit)
  const actualRuntimeManifest = readFileSync(runtimeManifestPath, 'utf8')
  if (actualRuntimeManifest !== expectedRuntimeManifest) fail('RUNTIME_SOURCE_SHA256SUMS drifted')
  const runtimeSourceFiles = {}
  for (const pathname of RUNTIME_SOURCE_PATHS) {
    const absolute = join(runtimeRoot, pathname)
    runtimeSourceFiles[pathname] = pathIdentity(absolute, `runtime source ${pathname}`, 'file')
    if (sha256(readFileSync(absolute)) !== sha256(gitSource(repository, expectedCommit, pathname))) {
      fail(`runtime source differs from the bound commit: ${pathname}`)
    }
  }

  let packageDefinition
  try {
    packageDefinition = JSON.parse(readFileSync(packagePath, 'utf8'))
  } catch {
    fail('n8n package metadata is invalid')
  }
  if (packageDefinition?.version !== N8N_VERSION) fail(`n8n runtime version is not ${N8N_VERSION}`)

  const manifestSource = readFileSync(sourceManifestPath, 'utf8')
  const manifest = parseKeyValueManifest(manifestSource)
  const expected = {
    source_commit: expectedCommit,
    package_lock_sha256: sha256(gitSource(repository, expectedCommit, 'ops/n8n/package-lock.json')),
    workflow_sha256: sha256(gitSource(repository, expectedCommit, 'ops/n8n/workflows/aiworker-task-intake.json')),
    video_workflow_sha256: sha256(gitSource(repository, expectedCommit, 'ops/n8n/workflows/aiworker-video-analysis.json')),
    runtime_source_manifest_sha256: sha256(expectedRuntimeManifest),
    n8n_version: N8N_VERSION,
  }
  for (const [key, value] of Object.entries(expected)) {
    if (manifest[key] !== value) fail(`SOURCE_MANIFEST ${key} drifted`)
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(manifest.built_at)) {
    fail('SOURCE_MANIFEST built_at is invalid')
  }
  if (!manifest.source_origin || /[\r\n]/u.test(manifest.source_origin)) {
    fail('SOURCE_MANIFEST source_origin is invalid')
  }
  return {
    files,
    runtimeSourceFiles,
    sourceManifestSha256: sha256(manifestSource),
    runtimeManifestSha256: sha256(actualRuntimeManifest),
    n8nVersion: packageDefinition.version,
  }
}

function parseLsofRecords(source) {
  const records = []
  let record = null
  for (const line of source.split('\n')) {
    if (!line) continue
    const field = line[0]
    const value = line.slice(1)
    if (field === 'f') {
      record = { descriptor: value }
      records.push(record)
    } else if (record && field === 'D') record.dev = BigInt(value).toString()
    else if (record && field === 'i') record.ino = BigInt(value).toString()
    else if (record && field === 'n') record.path = value
  }
  return records
}

function assertRecordIdentity(records, descriptor, identity, label) {
  const record = records.find(item =>
    (descriptor === null || item.descriptor === descriptor) && item.path === identity.path)
  if (!record || record.dev !== identity.dev || record.ino !== identity.ino) {
    fail(`${label} open file identity does not match its path identity`)
  }
}

function captureVerifierDatabaseHandle(databaseIdentity) {
  const records = parseLsofRecords(run(COMMANDS.lsof, [
    '-a', '-p', String(process.pid), '-FfDin',
  ], 'workflow verifier database handle query'))
  const handles = records.filter(item => /^\d+[A-Za-z]*$/u.test(item.descriptor || '')
    && item.dev !== undefined && item.ino !== undefined)
  const matches = handles.filter(item =>
    item.dev === databaseIdentity.dev && item.ino === databaseIdentity.ino)
  if (matches.length !== 1) {
    fail('workflow verifier SQLite handle does not match the preflight n8n database identity')
  }
  return {
    descriptor: matches[0].descriptor,
    dev: matches[0].dev,
    ino: matches[0].ino,
  }
}

function captureRuntimeIdentity({ database, expectedCommit, pid, port, repository }) {
  try {
    process.kill(pid, 0)
  } catch {
    fail('evidenced n8n PID is not running')
  }
  const launchTarget = `gui/${process.getuid()}/${N8N_LAUNCH_LABEL}`
  const launchOutput = run(COMMANDS.launchctl, ['print', launchTarget], 'n8n LaunchAgent query')
  const launchPidMatches = [...launchOutput.matchAll(/^\s*pid = ([1-9][0-9]*)\s*$/gmu)]
  if (launchPidMatches.length !== 1 || !/^\s*state = running\s*$/mu.test(launchOutput)) {
    fail('n8n LaunchAgent is not one running job with one PID')
  }
  const launchPid = Number(launchPidMatches[0][1])
  try {
    process.kill(launchPid, 0)
  } catch {
    fail('n8n LaunchAgent job PID is not running')
  }

  const lsofOutput = run(COMMANDS.lsof, ['-a', '-p', String(pid), '-FfDin'], 'n8n open-file query')
  const records = parseLsofRecords(lsofOutput)
  const cwdRecord = records.find(item => item.descriptor === 'cwd')
  if (!cwdRecord?.path || cwdRecord.dev === undefined || cwdRecord.ino === undefined) {
    fail('n8n cwd identity is unavailable')
  }
  const cwd = cwdRecord.path
  const runtimeRoot = dirname(dirname(cwd))
  if (basename(cwd) !== 'n8n' || basename(dirname(cwd)) !== 'ops') {
    fail('n8n cwd is not an immutable managed release')
  }
  if (basename(runtimeRoot) !== expectedCommit) {
    fail('n8n runtime release directory is not the full source commit')
  }
  const runtime = pathIdentity(runtimeRoot, 'n8n runtime root', 'directory')
  const cwdIdentity = pathIdentity(cwd, 'n8n cwd', 'directory')
  assertRecordIdentity(records, 'cwd', cwdIdentity, 'n8n cwd')

  const databaseIdentity = pathIdentity(database, 'n8n database', 'file')
  assertRecordIdentity(records, null, databaseIdentity, 'n8n database')

  const cliPath = join(cwd, 'node_modules/n8n/bin/n8n')
  const cliIdentity = pathIdentity(cliPath, 'n8n CLI', 'file')
  const processOutput = run(COMMANDS.ps, [
    '-ww', '-p', String(pid), '-o', 'ppid=', '-o', 'command=',
  ], 'n8n process query').trim()
  const processMatch = processOutput.match(/^([1-9][0-9]*)\s+(\S+) (\S+) start$/u)
  if (!processMatch || Number(processMatch[1]) !== launchPid) {
    fail('n8n PID is not the direct child of the LaunchAgent job')
  }
  const nodeArgument = processMatch[2]
  const cliArgument = processMatch[3]
  const nodeIdentity = secureArgumentPath(nodeArgument, 'n8n Node executable')
  const cliArgumentIdentity = secureArgumentPath(cliArgument, 'n8n CLI')
  const serviceRoot = dirname(dirname(runtimeRoot))
  const managedCurrentCli = join(serviceRoot, 'current/ops/n8n/node_modules/n8n/bin/n8n')
  if (![cliPath, managedCurrentCli].includes(cliArgument)) {
    fail('n8n CLI argv path is outside the managed runtime boundary')
  }
  if (cliArgumentIdentity.resolvedPath !== cliPath
    || cliArgumentIdentity.target.dev !== cliIdentity.dev
    || cliArgumentIdentity.target.ino !== cliIdentity.ino) {
    fail('n8n CLI argv target does not match the physical release CLI')
  }
  assertRecordIdentity(records, 'txt', nodeIdentity.target, 'n8n executable')

  const listeners = run(COMMANDS.lsof, [
    '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t',
  ], `port ${port} listener query`).trim().split(/\s+/u).filter(Boolean)
  if (listeners.length !== 1 || listeners[0] !== String(pid)) {
    fail(`port ${port} listener does not match the evidenced n8n PID`)
  }

  const runtimeFiles = validateRuntimeFiles(runtimeRoot, repository, expectedCommit)
  return {
    pid,
    parentPid: launchPid,
    launchTarget,
    port,
    argv: `${nodeArgument} ${cliArgument} start`,
    cwd: cwdIdentity,
    database: databaseIdentity,
    runtime,
    cli: { physical: cliIdentity, argument: cliArgumentIdentity },
    node: nodeIdentity,
    runtimeFiles,
  }
}

function parseStoredJson(value, label) {
  if (typeof value !== 'string') fail(`${label} is not stored JSON text`)
  try {
    return JSON.parse(value)
  } catch {
    fail(`${label} is invalid JSON`)
  }
}

function expectedWorkflow(repository, expectedCommit, descriptor) {
  let source
  let value
  try {
    source = gitSource(repository, expectedCommit, `ops/n8n/workflows/${descriptor.file}`)
    value = JSON.parse(source)
  } catch {
    fail(`expected workflow ${descriptor.file} is unavailable in the bound commit`)
  }
  if (
    !value || typeof value !== 'object' || Array.isArray(value) || value.id !== descriptor.id
    || typeof value.name !== 'string' || !Array.isArray(value.nodes)
    || !value.connections || typeof value.connections !== 'object' || Array.isArray(value.connections)
    || !value.settings || typeof value.settings !== 'object' || Array.isArray(value.settings)
    || typeof value.versionId !== 'string' || !/^[A-Za-z0-9-]{8,64}$/u.test(value.versionId)
  ) fail(`expected workflow ${descriptor.file} has an invalid contract`)

  const callbackNodes = value.nodes.filter(node => typeof node?.parameters?.url === 'string'
    && /body\.routing\.(?:claim|node|media)CallbackUrl/u.test(node.parameters.url))
  if (callbackNodes.length !== descriptor.callbackCount) {
    fail(`expected workflow ${descriptor.file} has an unexpected callback topology`)
  }
  if (!callbackNodes.some(node => node.parameters.url.includes('body.routing.claimCallbackUrl'))) {
    fail(`expected workflow ${descriptor.file} lacks the claim callback`)
  }
  for (const node of callbackNodes) {
    if (typeof node?.parameters?.body !== 'string' || !node.parameters.body.includes(
      "executionOwner: 'n8n-execution:' + $workflow.id + ':' + $execution.id",
    )) fail(`expected workflow ${descriptor.file} callback ${String(node?.name)} lacks execution ownership`)
  }
  return {
    sourceVersionId: value.versionId,
    sourceSha256: sha256(source),
    content: {
      id: value.id,
      name: value.name,
      nodes: value.nodes,
      connections: value.connections,
      settings: value.settings,
      nodeGroups: Array.isArray(value.nodeGroups) ? value.nodeGroups : [],
    },
  }
}

function requireColumns(db, table, names) {
  const columns = new Set(db.pragma(`table_info(${table})`).map(row => row.name))
  if (!names.every(name => columns.has(name))) fail(`${table} schema is incompatible`)
}

const argumentsValue = parseArguments(process.argv.slice(2))
const { database, repository, expectedCommit, moduleRoot } = argumentsValue
const identityBefore = captureRuntimeIdentity(argumentsValue)
let Database
try {
  const scopedRequire = createRequire(import.meta.url)
  Database = scopedRequire(scopedRequire.resolve('better-sqlite3', { paths: [moduleRoot] }))
} catch {
  fail('better-sqlite3 is unavailable')
}

let db
let reports
let databaseHandleBefore
try {
  if (
    process.env.NODE_ENV === 'test'
    && process.env.AIWORKER_TEST_N8N_IDENTITY === '1'
    && process.env.AIWORKER_TEST_N8N_BEFORE_DATABASE_OPEN
  ) run(process.env.AIWORKER_TEST_N8N_BEFORE_DATABASE_OPEN, [], 'test pre-database-open hook')
  db = new Database(database, { readonly: true, fileMustExist: true })
  if (
    process.env.NODE_ENV === 'test'
    && process.env.AIWORKER_TEST_N8N_IDENTITY === '1'
    && process.env.AIWORKER_TEST_N8N_AFTER_DATABASE_OPEN
  ) run(process.env.AIWORKER_TEST_N8N_AFTER_DATABASE_OPEN, [], 'test post-database-open hook')
  databaseHandleBefore = captureVerifierDatabaseHandle(identityBefore.database)
  db.pragma('query_only = ON')
  if (db.pragma('quick_check', { simple: true }) !== 'ok') fail('SQLite quick_check did not return ok')
  requireColumns(db, 'workflow_entity', [
    'id', 'name', 'active', 'isArchived', 'settings', 'versionId', 'activeVersionId',
  ])
  requireColumns(db, 'workflow_history', [
    'versionId', 'workflowId', 'name', 'nodes', 'connections', 'nodeGroups',
  ])

  const statement = db.prepare(`
    SELECT workflow.id, workflow.name, workflow.active,
      workflow.isArchived AS is_archived, workflow.settings,
      workflow.versionId AS current_version_id, workflow.activeVersionId AS active_version_id,
      history.versionId AS published_version_id, history.workflowId AS history_workflow_id,
      history.name AS published_name, history.nodes AS published_nodes,
      history.connections AS published_connections, history.nodeGroups AS published_node_groups
    FROM workflow_entity workflow
    LEFT JOIN workflow_history history
      ON history.workflowId = workflow.id AND history.versionId = workflow.activeVersionId
    WHERE workflow.id = ?
  `)

  reports = []
  for (const descriptor of WORKFLOWS) {
    const expected = expectedWorkflow(repository, expectedCommit, descriptor)
    const row = statement.get(descriptor.id)
    if (!row) fail(`fixed workflow ${descriptor.id} is missing`)
    if (row.active !== 1 || row.is_archived !== 0 || !row.active_version_id) {
      fail(`fixed workflow ${descriptor.id} is not active and published`)
    }
    if (
      typeof row.current_version_id !== 'string'
      || !/^[A-Za-z0-9-]{8,64}$/u.test(row.current_version_id)
      || row.active_version_id !== row.current_version_id
      || row.published_version_id !== row.current_version_id
      || row.history_workflow_id !== descriptor.id
    ) fail(`fixed workflow ${descriptor.id} did not publish its current imported version`)
    if (row.published_name !== null && row.published_name !== expected.content.name) {
      fail(`fixed workflow ${descriptor.id} published name drifted`)
    }

    const actual = {
      id: row.id,
      name: row.name,
      nodes: parseStoredJson(row.published_nodes, `${descriptor.id}.nodes`),
      connections: parseStoredJson(row.published_connections, `${descriptor.id}.connections`),
      settings: parseStoredJson(row.settings, `${descriptor.id}.settings`),
      nodeGroups: parseStoredJson(row.published_node_groups, `${descriptor.id}.nodeGroups`),
    }
    const expectedCanonical = canonicalJson(expected.content)
    const actualCanonical = canonicalJson(actual)
    const expectedSha256 = sha256(expectedCanonical)
    if (sha256(actualCanonical) !== expectedSha256 || actualCanonical !== expectedCanonical) {
      fail(`fixed workflow ${descriptor.id} published content digest drifted`)
    }
    reports.push({
      id: descriptor.id,
      sourceVersionId: expected.sourceVersionId,
      sourceSha256: expected.sourceSha256,
      publishedVersionId: row.published_version_id,
      sha256: expectedSha256,
    })
  }
  const databaseHandleAfter = captureVerifierDatabaseHandle(identityBefore.database)
  if (canonicalJson(databaseHandleAfter) !== canonicalJson(databaseHandleBefore)) {
    fail('workflow verifier SQLite handle drifted during database queries')
  }
} catch (error) {
  fail(error instanceof Error ? error.message : 'workflow database verification failed')
} finally {
  try { db?.close() } catch {}
}

if (
  process.env.NODE_ENV === 'test'
  && process.env.AIWORKER_TEST_N8N_IDENTITY === '1'
  && process.env.AIWORKER_TEST_N8N_AFTER_QUERY
) run(process.env.AIWORKER_TEST_N8N_AFTER_QUERY, [], 'test post-query hook')

const identityAfter = captureRuntimeIdentity(argumentsValue)
if (canonicalJson(identityAfter) !== canonicalJson(identityBefore)) {
  const driftedFields = Object.keys(identityBefore)
    .filter(key => canonicalJson(identityAfter[key]) !== canonicalJson(identityBefore[key]))
  fail(`n8n runtime identity drifted during workflow verification: ${driftedFields.join(', ')}`)
}
const runtimeIdentitySha256 = sha256(canonicalJson(identityBefore))
process.stdout.write(JSON.stringify({
  schema: 'video-autoworker-n8n-workflow-compatibility/v2',
  protocol: WORKFLOW_PROTOCOL,
  sourceCommit: expectedCommit,
  databasePath: database,
  runtimeIdentitySha256,
  workflows: reports,
  combinedSha256: sha256([
    expectedCommit,
    runtimeIdentitySha256,
    ...reports.map(item => [
      item.id, item.sourceVersionId, item.sourceSha256, item.publishedVersionId, item.sha256,
    ].join(':')),
  ].join('\n')),
}))
