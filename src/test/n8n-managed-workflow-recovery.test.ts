// @vitest-environment node

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'

type Workflow = {
  id: string
  name: string
  nodes: Array<Record<string, unknown>>
  connections: Record<string, unknown>
  settings: Record<string, unknown>
  staticData: Record<string, unknown> | null
  pinData: Record<string, unknown> | null
  nodeGroups: unknown[]
  versionId: string
}

type JsonRecord = Record<string, unknown>

function child(value: JsonRecord, key: string): JsonRecord {
  return value[key] as JsonRecord
}

const cleanup: Array<() => void> = []
const projectRoot = realpathSync(process.cwd())
const physicalTmp = realpathSync(tmpdir())
const backupTool = resolve(projectRoot, 'scripts/n8n-backup-managed-workflows.mjs')
const restoreTool = resolve(projectRoot, 'scripts/n8n-restore-managed-workflows.sh')
const transitionAnchor = resolve(projectRoot, 'scripts/n8n-workflow-transition-anchor.mjs')
const workflowVerifier = resolve(projectRoot, 'scripts/verify-n8n-blue-green-workflows.mjs')
const betterSqliteEntry = require.resolve('better-sqlite3')
const betterSqlitePackage = resolve(betterSqliteEntry, '../..')
const commit = 'a'.repeat(40)
const runtimeSourcePaths = [
  'scripts/n8n-start.sh',
  'scripts/n8n-stop.sh',
  'scripts/n8n-status.sh',
  'scripts/n8n-import-workflows.sh',
  'scripts/n8n-maintenance-lock.mjs',
  'scripts/n8n-workflow-transition-anchor.mjs',
  'scripts/n8n-backup-managed-workflows.mjs',
  'scripts/n8n-restore-managed-workflows.sh',
  'ops/n8n/.env.example',
  'ops/n8n/lib/common.sh',
  'ops/n8n/package.json',
  'ops/n8n/package-lock.json',
  'ops/n8n/workflows/aiworker-task-intake.json',
  'ops/n8n/workflows/aiworker-video-analysis.json',
] as const

afterEach(() => {
  while (cleanup.length) cleanup.pop()?.()
})

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [
      key, canonicalize((value as Record<string, unknown>)[key]),
    ]))
  }
  return value
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function containsExactScalar(value: unknown, target: string | number): boolean {
  if (value === target) return true
  if (Array.isArray(value)) return value.some(item => containsExactScalar(item, target))
  if (value && typeof value === 'object') {
    return Object.values(value).some(item => containsExactScalar(item, target))
  }
  return false
}

function expectDurablePublish(tracePath: string, file: string, parent: string): void {
  const lines = readFileSync(tracePath, 'utf8').trim().split('\n')
  const index = lines.indexOf(`file:${file}`)
  expect(index, `missing file fsync for ${file}`).toBeGreaterThanOrEqual(0)
  expect(lines[index + 1]).toBe(`directory:${parent}`)
}

function semanticWorkflow(value: JsonRecord): JsonRecord {
  return {
    id: value.id,
    name: value.name,
    nodes: value.nodes,
    connections: value.connections,
    settings: value.settings,
    staticData: value.staticData ?? null,
    pinData: value.pinData ?? null,
    nodeGroups: Array.isArray(value.nodeGroups) ? value.nodeGroups : [],
  }
}

function removeFixture(root: string): void {
  const packagePath = join(root, 'managed-workflows-backup')
  if (existsSync(packagePath)) chmodSync(packagePath, 0o700)
  const rejectedPackage = join(root, 'rejected-package')
  if (existsSync(rejectedPackage)) chmodSync(rejectedPackage, 0o700)
  rmSync(root, { recursive: true, force: true })
}

function workflow(id: string, marker: string): Workflow {
  return {
    id,
    name: `workflow-${marker}`,
    nodes: [{ id: `node-${marker}`, name: `node-${marker}`, type: 'n8n-nodes-base.noOp', parameters: {} }],
    connections: {},
    settings: { executionOrder: 'v1', marker },
    staticData: { marker },
    pinData: null,
    nodeGroups: [],
    versionId: randomUUID(),
  }
}

function createDatabase(pathname: string): { close: () => void } {
  const db = new Database(pathname)
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE workflow_entity (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      active INTEGER NOT NULL,
      isArchived INTEGER NOT NULL,
      nodes TEXT NOT NULL,
      connections TEXT NOT NULL,
      settings TEXT NOT NULL,
      staticData TEXT,
      pinData TEXT,
      nodeGroups TEXT NOT NULL,
      versionId TEXT NOT NULL,
      activeVersionId TEXT
    );
    CREATE TABLE workflow_history (
      versionId TEXT PRIMARY KEY,
      workflowId TEXT NOT NULL,
      name TEXT,
      nodes TEXT NOT NULL,
      connections TEXT NOT NULL,
      nodeGroups TEXT NOT NULL
    );
    CREATE TABLE shared_workflow (workflowId TEXT NOT NULL, projectId TEXT NOT NULL, role TEXT NOT NULL);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, loadOnStartup INTEGER NOT NULL);
    CREATE TABLE execution_entity (id INTEGER PRIMARY KEY, status TEXT NOT NULL, workflowId TEXT NOT NULL, finished INTEGER NOT NULL);
  `)
  const insertEntity = db.prepare(`
    INSERT INTO workflow_entity (
      id, name, active, isArchived, nodes, connections, settings, staticData, pinData,
      nodeGroups, versionId, activeVersionId
    ) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insertHistory = db.prepare(`
    INSERT INTO workflow_history (versionId, workflowId, name, nodes, connections, nodeGroups)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  const values = [
    { value: workflow('aiworker-task-intake-v1', 'intake-original'), active: true },
    { value: workflow('aiworker-video-analysis-v1', 'video-original'), active: false },
    { value: workflow('unrelated-workflow', 'unrelated-sentinel'), active: true },
  ]
  for (const item of values) {
    const value = item.value
    insertEntity.run(
      value.id,
      value.name,
      item.active ? 1 : 0,
      JSON.stringify(value.nodes),
      JSON.stringify(value.connections),
      JSON.stringify(value.settings),
      JSON.stringify(value.staticData),
      JSON.stringify(value.pinData),
      JSON.stringify(value.nodeGroups),
      value.versionId,
      item.active ? value.versionId : null,
    )
    insertHistory.run(
      value.versionId,
      value.id,
      value.name,
      JSON.stringify(value.nodes),
      JSON.stringify(value.connections),
      JSON.stringify(value.nodeGroups),
    )
    db.prepare('INSERT INTO shared_workflow (workflowId, projectId, role) VALUES (?, ?, ?)')
      .run(value.id, 'project-sentinel', 'workflow:owner')
  }
  db.prepare('INSERT INTO settings (key, value, loadOnStartup) VALUES (?, ?, ?)')
    .run('global-sentinel', '{"must":"survive"}', 1)
  db.prepare('INSERT INTO execution_entity (id, status, workflowId, finished) VALUES (?, ?, ?, ?)')
    .run(9001, 'success', 'unrelated-workflow', 1)
  return { close: () => db.close() }
}

function createFakeCli(pathname: string, logPath: string): void {
  const source = `
const fs = require('node:fs')
const crypto = require('node:crypto')
const Database = require(${JSON.stringify(betterSqliteEntry)})
const db = new Database(process.env.N8N_USER_FOLDER + '/database.sqlite')
const args = process.argv.slice(2)
const command = args[0]
const option = name => (args.find(value => value.startsWith(name + '=')) || '').slice(name.length + 1)
const log = value => fs.appendFileSync(${JSON.stringify(logPath)}, value + '\\n', { mode: 0o600 })
const rowValue = row => ({
  id: row.id,
  name: row.name,
  nodes: JSON.parse(row.nodes),
  connections: JSON.parse(row.connections),
  settings: JSON.parse(row.settings),
  staticData: row.staticData ? JSON.parse(row.staticData) : null,
  pinData: row.pinData ? JSON.parse(row.pinData) : null,
  nodeGroups: row.nodeGroups ? JSON.parse(row.nodeGroups) : [],
  versionId: row.versionId,
  active: Boolean(row.active),
})
try {
  if (command === 'list:workflow') {
    const activeOnly = args.includes('--active=true')
    const rows = db.prepare('SELECT id FROM workflow_entity' + (activeOnly ? ' WHERE active = 1' : '') + ' ORDER BY id').all()
    process.stdout.write(rows.map(row => row.id).join('\\n') + (rows.length ? '\\n' : ''))
  } else if (command === 'unpublish:workflow') {
    const id = option('--id')
    log('unpublish:' + id)
    const result = db.prepare('UPDATE workflow_entity SET active = 0, activeVersionId = NULL WHERE id = ?').run(id)
    if (result.changes !== 1) process.exitCode = 1
  } else if (command === 'import:workflow') {
    const input = option('--input')
    const value = JSON.parse(fs.readFileSync(input, 'utf8'))
    const failMarker = process.env.AIWORKER_TEST_N8N_FAIL_MARKER
    if (process.env.AIWORKER_TEST_N8N_FAIL_ON_ID === value.id && failMarker && !fs.existsSync(failMarker)) {
      fs.writeFileSync(failMarker, value.id, { mode: 0o600 })
      process.exitCode = 9
    } else {
    const versionId = crypto.randomUUID()
    log('import:' + value.id)
    db.prepare(\`
      INSERT INTO workflow_entity (
        id, name, active, isArchived, nodes, connections, settings, staticData, pinData,
        nodeGroups, versionId, activeVersionId
      ) VALUES (?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, active=0, isArchived=0, nodes=excluded.nodes,
        connections=excluded.connections, settings=excluded.settings,
        staticData=excluded.staticData, pinData=excluded.pinData,
        nodeGroups=excluded.nodeGroups, versionId=excluded.versionId, activeVersionId=NULL
    \`).run(
      value.id, value.name, JSON.stringify(value.nodes), JSON.stringify(value.connections),
      JSON.stringify(value.settings), JSON.stringify(value.staticData ?? null),
      JSON.stringify(value.pinData ?? null), JSON.stringify(value.nodeGroups ?? []), versionId,
    )
    }
  } else if (command === 'publish:workflow') {
    const id = option('--id')
    log('publish:' + id)
    const row = db.prepare('SELECT * FROM workflow_entity WHERE id = ?').get(id)
    if (!row) process.exitCode = 1
    else {
      db.prepare(\`
        INSERT OR REPLACE INTO workflow_history (
          versionId, workflowId, name, nodes, connections, nodeGroups
        ) VALUES (?, ?, ?, ?, ?, ?)
      \`).run(row.versionId, row.id, row.name, row.nodes, row.connections, row.nodeGroups)
      db.prepare('UPDATE workflow_entity SET active = 1, activeVersionId = versionId WHERE id = ?').run(id)
    }
  } else if (command === 'export:workflow') {
    const id = option('--id')
    const output = option('--output')
    log('export:' + id)
    const row = db.prepare('SELECT * FROM workflow_entity WHERE id = ?').get(id)
    if (!row) process.exitCode = 1
    else fs.writeFileSync(output, JSON.stringify([rowValue(row)]) + '\\n', { mode: 0o600 })
  } else process.exitCode = 2
} finally { db.close() }
`
  writeFileSync(pathname, source, { mode: 0o600 })
}

type RuntimeFixture = {
  release: string
  runtimeDir: string
  log: string
  env: NodeJS.ProcessEnv
}

function createRuntime(root: string): RuntimeFixture {
  const release = join(root, 'runtime', 'releases', commit)
  const runtimeDir = join(release, 'ops/n8n')
  const cli = join(runtimeDir, 'node_modules/n8n/bin/n8n')
  const packageJson = join(runtimeDir, 'node_modules/n8n/package.json')
  mkdirSync(dirname(cli), { recursive: true, mode: 0o700 })
  const log = join(root, 'cli.log')
  createFakeCli(cli, log)
  writeFileSync(packageJson, '{"name":"n8n","version":"2.31.6"}\n', { mode: 0o600 })
  symlinkSync(betterSqlitePackage, join(runtimeDir, 'node_modules/better-sqlite3'))
  writeFileSync(join(release, 'SOURCE_COMMIT'), `${commit}\n`, { mode: 0o600 })
  for (const pathname of runtimeSourcePaths) {
    const target = join(release, pathname)
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
    copyFileSync(join(projectRoot, pathname), target)
    chmodSync(target, pathname.startsWith('scripts/') || pathname.endsWith('/common.sh') ? 0o700 : 0o600)
  }
  const runtimeManifest = runtimeSourcePaths.map(pathname => (
    `${sha256(readFileSync(join(release, pathname)))}  ${pathname}`
  )).join('\n') + '\n'
  writeFileSync(join(release, 'RUNTIME_SOURCE_SHA256SUMS'), runtimeManifest, { mode: 0o600 })
  writeFileSync(join(release, 'SOURCE_MANIFEST'), [
    'source_origin=test',
    `source_commit=${commit}`,
    `package_lock_sha256=${sha256(readFileSync(join(release, 'ops/n8n/package-lock.json')))}`,
    `workflow_sha256=${sha256(readFileSync(join(release, 'ops/n8n/workflows/aiworker-task-intake.json')))}`,
    `video_workflow_sha256=${sha256(readFileSync(join(release, 'ops/n8n/workflows/aiworker-video-analysis.json')))}`,
    `runtime_source_manifest_sha256=${sha256(runtimeManifest)}`,
    'n8n_version=2.31.6',
    'built_at=2026-08-31T00:00:00Z',
    '',
  ].join('\n'), { mode: 0o600 })
  const tools = join(root, 'offline-tools')
  mkdirSync(tools, { mode: 0o700 })
  for (const name of ['lsof', 'launchctl', 'curl']) {
    writeFileSync(join(tools, name), '#!/bin/sh\nexit 1\n', { mode: 0o700 })
  }
  return {
    release,
    runtimeDir,
    log,
    env: {
      ...process.env,
      PATH: `${tools}:${process.env.PATH || ''}`,
      N8N_NODE_BIN: process.execPath,
      N8N_ENCRYPTION_KEY: 'fixture-encryption-key-that-is-long-enough',
      AIWORKER_N8N_PID_FILE: join(root, 'n8n.pid'),
      N8N_PORT: '45678',
    },
  }
}

function backup(database: string, output: string, runtimeDir: string, env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, [
    backupTool,
    'backup',
    '--database', database,
    '--module-root', runtimeDir,
    '--output', output,
    '--source-commit', commit,
    '--n8n-version', '2.31.6',
  ], { encoding: 'utf8', env })
}

function writeBootstrapReceipt(pathname: string, value: Record<string, unknown>) {
  return writeReferencedJson(pathname, value, 0o400)
}

function writeReferencedJson(pathname: string, value: Record<string, unknown>, mode: number) {
  const source = `${JSON.stringify(value)}\n`
  writeFileSync(pathname, source, { mode })
  chmodSync(pathname, mode)
  const entry = statSync(pathname, { bigint: true })
  return {
    path: pathname,
    dev: entry.dev.toString(),
    ino: entry.ino.toString(),
    size: Number(entry.size),
    sha256: sha256(source),
  }
}

function fileReference(pathname: string) {
  const entry = statSync(pathname, { bigint: true })
  return {
    path: pathname,
    dev: entry.dev.toString(),
    ino: entry.ino.toString(),
    size: Number(entry.size),
    sha256: sha256(readFileSync(pathname)),
  }
}

function fullFileReference(pathname: string) {
  const entry = statSync(pathname, { bigint: true })
  return {
    path: pathname,
    dev: entry.dev.toString(),
    ino: entry.ino.toString(),
    size: Number(entry.size),
    mtimeNs: entry.mtimeNs.toString(),
    ctimeNs: entry.ctimeNs.toString(),
    uid: Number(entry.uid),
    mode: Number(entry.mode & BigInt(0o7777)).toString(8),
    nlink: Number(entry.nlink),
    sha256: sha256(readFileSync(pathname)),
  }
}

function directoryReference(pathname: string) {
  const entry = statSync(pathname, { bigint: true })
  return {
    path: pathname,
    dev: entry.dev.toString(),
    ino: entry.ino.toString(),
    uid: Number(entry.uid),
    mode: Number(entry.mode & BigInt(0o7777)).toString(8),
  }
}

function runTransition(...args: string[]) {
  const result = spawnSync(process.execPath, [transitionAnchor, ...args], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`transition fixture failed: ${result.stdout}\n${result.stderr}`)
  return result
}

function overwriteJson(pathname: string, value: Record<string, unknown>, mode = 0o400): void {
  chmodSync(pathname, 0o600)
  writeFileSync(pathname, `${JSON.stringify(value)}\n`, { mode: 0o600 })
  chmodSync(pathname, mode)
}

function createTransitionBinding(options: {
  root: string
  attempt: string
  packagePath: string
  database: string
  runtimeRelease: string
  releaseRoot: string
  releaseId: string
  manifestSha256: string
  workflowReport: string
}) {
  const state = join(options.root, 'workflow-transition')
  if (!existsSync(state)) mkdirSync(state, { mode: 0o700 })
  const intent = join(state, 'upgrade-intent.json')
  const confirmation = join(state, 'current-confirmation.json')
  const capability = join(state, 'import-capability.json')
  const token = join(state, 'operator-token')
  const journal = join(state, 'journal')
  const attestation = join(state, 'transition-attestation.json')
  const claim = join(state, 'bootstrap-claim.json')
  runTransition(
    'prepare-intent', '--upgrade-id', '11111111-1111-4111-8111-111111111111',
    '--database', options.database, '--rollback-package', options.packagePath,
    '--runtime-root', options.runtimeRelease, '--target-commit', commit,
    '--application-release-root', options.releaseRoot, '--slot', 'blue',
    '--release-id', options.releaseId, '--output', intent,
  )
  writeFileSync(token, `${'9'.repeat(64)}\n`, { mode: 0o400 })
  chmodSync(token, 0o400)
  runTransition(
    'current-confirm', '--intent', intent, '--confirmation-token-file', token,
    '--confirmation-receipt-id', '99999999-9999-4999-8999-999999999999',
    '--confirmation-output', confirmation, '--capability-output', capability,
  )
  runTransition(
    'claim-import', '--intent', intent, '--confirmation', confirmation,
    '--confirmation-token-file', token, '--capability', capability, '--journal-dir', journal,
  )
  runTransition('begin-mutation', '--intent', intent, '--confirmation', confirmation, '--journal-dir', journal)
  for (const id of ['aiworker-task-intake-v1', 'aiworker-video-analysis-v1']) {
    runTransition('verify-target', '--intent', intent, '--confirmation', confirmation, '--journal-dir', journal, '--id', id)
    runTransition('record-workflow', '--intent', intent, '--confirmation', confirmation, '--journal-dir', journal, '--id', id)
  }
  runTransition(
    'attest-transition', '--intent', intent, '--confirmation', confirmation,
    '--journal-dir', journal, '--live-report', options.workflowReport,
    '--verifier', workflowVerifier, '--output', attestation,
  )
  const preinstallRoot = join(options.attempt, 'preinstall')
  mkdirSync(preinstallRoot, { recursive: true, mode: 0o700 })
  const installAttemptId = '33333333-3333-4333-8333-333333333333'
  const intentValue = JSON.parse(readFileSync(intent, 'utf8')) as JsonRecord
  const databaseFamily = intentValue.database as JsonRecord[]
  const journalHeadName = readdirSync(journal)
    .filter(name => /^\d{6}-/u.test(name)).sort().at(-1)!
  const liveReportValue = JSON.parse(readFileSync(options.workflowReport, 'utf8')) as JsonRecord
  const preparedPath = join(preinstallRoot, 'install-prepared.r000001.receipt.json')
  const prepared = {
    schema: 'video-autoworker-legacy-preinstall-prepared/v1',
    installAttemptId,
    revision: 1,
    sourceCommit: commit,
    target: {
      slot: 'blue', releaseId: options.releaseId, releaseRoot: options.releaseRoot,
      manifestSha256: options.manifestSha256,
    },
    databases: { n8n: databaseFamily[0] },
    transition: {
      attestation: fileReference(attestation),
      committedJournalHeadSha256: sha256(readFileSync(join(journal, journalHeadName))),
      liveCombinedSha256: liveReportValue.combinedSha256,
    },
  }
  writeReferencedJson(preparedPath, prepared, 0o400)
  const verificationPath = join(preinstallRoot, 'install-verified.r000001.receipt.json')
  const preparedReference = fileReference(preparedPath)
  writeReferencedJson(verificationPath, {
    schema: 'video-autoworker-legacy-preinstall-verified/v1',
    installAttemptId,
    revision: 1,
    prepared: preparedReference,
  }, 0o400)
  const convergenceProof = join(preinstallRoot, 'runtime-convergence-proof.json')
  writeReferencedJson(convergenceProof, {
    schema: 'video-autoworker-openclaw-runtime-convergence-proof/v1',
    observedAt: 1_800_000_000,
  }, 0o600)
  const componentJournalHead = join(preinstallRoot, 'install-component-event.000003.receipt.json')
  writeReferencedJson(componentJournalHead, {
    schema: 'video-autoworker-legacy-preinstall-component-event/v1',
    installAttemptId,
    operation: 'install',
    component: 'director-brain',
  }, 0o400)
  const finalizePath = join(preinstallRoot, 'install-finalize-claim.receipt.json')
  writeReferencedJson(finalizePath, {
    schema: 'video-autoworker-legacy-preinstall-finalize-claim/v1',
    choice: 'bootstrap-handoff',
    installAttemptId,
    revision: 1,
    uid: process.getuid!(),
    claimedAt: 1_800_000_000,
    journalHead: fileReference(componentJournalHead),
  }, 0o400)
  const handoffPath = join(preinstallRoot, 'install-postverify-action.r000001.claim.json')
  const handoffPayload = {
    finalize: fileReference(finalizePath),
    componentJournalHead: fileReference(componentJournalHead),
    verification: fileReference(verificationPath),
    readiness: fileReference(verificationPath),
    runtimeConvergenceProof: fileReference(convergenceProof),
    freshReadinessSha256: 'd'.repeat(64),
    payloads: {
      videoCommandManifestSha256: 'e'.repeat(64),
      taskFlowManifestSha256: 'f'.repeat(64),
      directorBrainManifestSha256: '0'.repeat(64),
    },
    binding: {
      sourceCommit: commit,
      target: prepared.target,
      databases: prepared.databases,
      transition: {
        attestationSha256: fileReference(attestation).sha256,
        committedJournalHeadSha256: prepared.transition.committedJournalHeadSha256,
        liveCombinedSha256: prepared.transition.liveCombinedSha256,
      },
    },
  }
  writeReferencedJson(handoffPath, {
    schema: 'video-autoworker-legacy-preinstall-postverify-action/v1',
    choice: 'bootstrap-handoff',
    installAttemptId,
    revision: 1,
    uid: process.getuid!(),
    claimedAt: 1_800_000_000,
    payload: handoffPayload,
  }, 0o400)
  const preinstallTerminal = join(preinstallRoot, 'install-terminal-claim.receipt.json')
  writeReferencedJson(preinstallTerminal, {
    schema: 'video-autoworker-legacy-preinstall-terminal-claim/v1',
    choice: 'bootstrap-handoff',
    installAttemptId,
    revision: 1,
    uid: process.getuid!(),
    claimedAt: 1_800_000_000,
    prepared: preparedReference,
    verification: fileReference(verificationPath),
    handoff: fileReference(handoffPath),
    handoffPayloadSha256: sha256(canonicalJson(handoffPayload)),
  }, 0o400)
  runTransition(
    'claim-bootstrap', '--intent', intent, '--confirmation', confirmation,
    '--journal-dir', journal, '--attestation', attestation,
    '--prepare-path', join(options.attempt, 'prepare.receipt.json'), '--slot', 'blue',
    '--release-id', options.releaseId, '--release-root', options.releaseRoot,
    '--manifest-sha256', options.manifestSha256,
    '--preinstall-terminal', preinstallTerminal,
    '--preinstall-handoff', handoffPath,
    '--runtime-convergence-proof', convergenceProof,
    '--output', claim,
  )
  const claimValue = JSON.parse(readFileSync(claim, 'utf8')) as JsonRecord
  const transition = child(claimValue, 'transition')
  return {
    anchor: fullFileReference(transitionAnchor),
    intent: fullFileReference(intent),
    confirmation: fullFileReference(confirmation),
    journal: directoryReference(journal),
    attestation: fullFileReference(attestation),
    claim: fullFileReference(claim),
    upgradeId: claimValue.upgradeId,
    committedJournalHeadSha256: transition.committedJournalHeadSha256,
    liveCombinedSha256: transition.liveCombinedSha256,
  }
}

function createTransitionRollbackAuthorization(
  root: string,
  packagePath: string,
  database: string,
  runtimeRelease: string,
): { authorization: string, state: string, journal: string } {
  const state = join(root, 'workflow-transition')
  mkdirSync(state, { mode: 0o700 })
  const releaseId = `${commit}-runtime`
  const releaseRoot = join(root, 'application-releases', releaseId, 'standalone')
  mkdirSync(releaseRoot, { recursive: true, mode: 0o700 })
  const releaseManifest = join(releaseRoot, 'release-manifest.json')
  writeFileSync(releaseManifest, '{"schema":"test-release/v1"}\n', { mode: 0o400 })
  chmodSync(releaseManifest, 0o400)
  const intent = join(state, 'upgrade-intent.json')
  const confirmation = join(state, 'current-confirmation.json')
  const capability = join(state, 'import-capability.json')
  const token = join(state, 'operator-token')
  const journal = join(state, 'journal')
  const authorization = join(state, 'transition-rollback-authorization.receipt.json')
  runTransition(
    'prepare-intent', '--upgrade-id', '88888888-8888-4888-8888-888888888888',
    '--database', database, '--rollback-package', packagePath,
    '--runtime-root', runtimeRelease, '--target-commit', commit,
    '--application-release-root', releaseRoot, '--slot', 'blue',
    '--release-id', releaseId, '--output', intent,
  )
  writeFileSync(token, `${'8'.repeat(64)}\n`, { mode: 0o400 })
  chmodSync(token, 0o400)
  runTransition(
    'current-confirm', '--intent', intent, '--confirmation-token-file', token,
    '--confirmation-receipt-id', '77777777-7777-4777-8777-777777777777',
    '--confirmation-output', confirmation, '--capability-output', capability,
  )
  runTransition(
    'claim-import', '--intent', intent, '--confirmation', confirmation,
    '--confirmation-token-file', token, '--capability', capability, '--journal-dir', journal,
  )
  runTransition(
    'begin-mutation', '--intent', intent, '--confirmation', confirmation, '--journal-dir', journal,
  )
  const db = new Database(database)
  db.prepare(`
    UPDATE workflow_entity SET name = 'partial-target-import', nodes = '[]', active = 0,
      activeVersionId = NULL WHERE id IN ('aiworker-task-intake-v1', 'aiworker-video-analysis-v1')
  `).run()
  db.close()
  runTransition(
    'authorize-transition-rollback', '--intent', intent, '--confirmation', confirmation,
    '--journal-dir', journal, '--output', authorization,
  )
  return { authorization, state, journal }
}

function createReceipt(attempt: string, packagePath: string, database: string, release: string): string {
  mkdirSync(attempt, { mode: 0o700 })
  const databaseEntry = statSync(database, { bigint: true })
  const issuedAt = Math.floor(Date.now() / 1000)
  const attemptId = '11111111-1111-1111-1111-111111111111'
  const controllerSha256 = 'c'.repeat(64)
  const prepare = writeBootstrapReceipt(join(attempt, 'prepare.receipt.json'), {
    schema: 'video-autoworker-legacy-bootstrap-prepare/v1',
    attemptId,
    uid: process.getuid?.() ?? 0,
    sourceCommit: commit,
    prepareToolSha256: controllerSha256,
    databases: {
      n8n: {
        path: database,
        dev: databaseEntry.dev.toString(),
        ino: databaseEntry.ino.toString(),
      },
    },
  })
  const tokenSha256 = 'd'.repeat(64)
  const confirm = writeBootstrapReceipt(join(attempt, 'current-confirm.receipt.json'), {
    schema: 'video-autoworker-legacy-bootstrap-current-confirm/v1',
    attemptId,
    uid: process.getuid?.() ?? 0,
    sourceCommit: commit,
    confirmedAt: issuedAt,
    expiresAt: issuedAt + 120,
    prepare,
    previousReceiptSha256: prepare.sha256,
    tokenSha256,
  })
  const shutdown = writeBootstrapReceipt(join(attempt, 'shutdown-requested.receipt.json'), {
    schema: 'video-autoworker-legacy-bootstrap-shutdown-requested/v1',
    attemptId,
    uid: process.getuid?.() ?? 0,
    sourceCommit: commit,
    requestedAt: issuedAt,
    prepare,
    confirm,
    previousReceiptSha256: confirm.sha256,
    tokenSha256,
  })
  const pathname = join(attempt, 'n8n-restore-confirmation.receipt.json')
  const receipt = {
    schema: 'video-autoworker-n8n-managed-workflow-restore-confirmation/v2',
    action: 'restore-managed-n8n-workflows',
    issuedAt,
    expiresAt: issuedAt + 120,
    uid: process.getuid?.() ?? 0,
    nonce: 'b'.repeat(64),
    packageManifestSha256: sha256(readFileSync(join(packagePath, 'manifest.json'))),
    target: {
      databaseDev: `0x${databaseEntry.dev.toString(16)}`,
      databaseIno: databaseEntry.ino.toString(),
      sourceCommit: commit,
      n8nVersion: '2.31.6',
      runtimeRelease: release,
    },
    authorization: {
      kind: 'legacy-bootstrap-shutdown-requested/v1',
      attemptId,
      prepare,
      confirm,
      shutdown,
      controllerSha256,
    },
  }
  writeFileSync(pathname, `${JSON.stringify(receipt)}\n`, { mode: 0o400 })
  chmodSync(pathname, 0o400)
  return pathname
}

function createDisasterReceipt(
  attempt: string,
  packagePath: string,
  database: string,
  release: string,
  options: {
    evidenceSchema?: string,
    proofSchema?: string,
    workflowCombinedSha256?: string,
  } = {},
): { receipt: string, recoveryDirectory: string, pending: string, mission: string, workflowReport: string } {
  mkdirSync(attempt, { mode: 0o700 })
  const databaseEntry = statSync(database, { bigint: true })
  const controllerSha256 = 'c'.repeat(64)
  const historical = Math.floor(Date.now() / 1000) - 600
  const root = dirname(attempt)
  const mission = join(root, 'mission-control.db')
  writeFileSync(mission, 'mission-control-fixture\n', { mode: 0o600 })
  chmodSync(mission, 0o600)
  const identity = (pathname: string) => {
    const entry = statSync(pathname, { bigint: true })
    return { path: pathname, dev: entry.dev.toString(), ino: entry.ino.toString() }
  }
  const databaseIdentity = identity(database)
  const missionIdentity = identity(mission)
  const routerRunDirectory = join(root, 'blue-green-run')
  mkdirSync(routerRunDirectory, { mode: 0o700 })
  chmodSync(routerRunDirectory, 0o700)
  const releaseId = `${commit}-runtime`
  const releaseRoot = join(root, 'application-releases', releaseId, 'standalone')
  mkdirSync(releaseRoot, { recursive: true, mode: 0o700 })
  const manifestPath = join(releaseRoot, 'release-manifest.json')
  writeFileSync(manifestPath, '{"schema":"test-release/v1"}\n', { mode: 0o400 })
  chmodSync(manifestPath, 0o400)
  const manifest = (() => {
    const entry = statSync(manifestPath, { bigint: true })
    return {
      path: manifestPath, dev: entry.dev.toString(), ino: entry.ino.toString(),
      size: Number(entry.size), sha256: sha256(readFileSync(manifestPath)),
    }
  })()
  const target = { slot: 'blue', releaseId, releaseRoot, manifestSha256: manifest.sha256 }
  const proofPath = join(attempt, 'rollback-proof.json')
  const proof = writeReferencedJson(proofPath, {
    schema: options.proofSchema ?? 'video-autoworker-legacy-bootstrap-rollback-proof/v2',
  }, 0o600)
  const evidencePath = join(attempt, 'freeze-evidence.json')
  const evidence = writeReferencedJson(evidencePath, {
    schema: options.evidenceSchema ?? 'video-autoworker-legacy-freeze-evidence/v3',
    observedAt: historical,
    target,
    legacy: {
      pid: 1200,
      cwd: { path: join(root, 'legacy-runtime'), dev: '1', ino: '2' },
      releaseId: 'legacy-runtime',
      database: missionIdentity,
    },
    n8n: { pid: 1300, database: databaseIdentity },
  }, 0o600)
  const releaseRootIdentity = identity(releaseRoot)
  const routing = {
    port: 3017,
    runDirectory: identity(routerRunDirectory),
    statePath: join(routerRunDirectory, 'router-state.json'),
  }
  const preparePath = join(attempt, 'prepare.receipt.json')
  const workflowReports = [
    ['aiworker-task-intake-v1', 'aiworker-task-intake.json'],
    ['aiworker-video-analysis-v1', 'aiworker-video-analysis.json'],
  ].map(([id, file], index) => {
    const source = readFileSync(join(release, 'ops/n8n/workflows', file), 'utf8')
    const value = JSON.parse(source) as JsonRecord
    return {
      id,
      sourceVersionId: String(value.versionId),
      sourceSha256: sha256(source),
      publishedVersionId: `published-version-${index + 1}`,
      sha256: sha256(canonicalJson(semanticWorkflow(value))),
    }
  })
  const runtimeIdentitySha256 = '5'.repeat(64)
  const calculatedWorkflowDigest = sha256([
    commit,
    runtimeIdentitySha256,
    ...workflowReports.map(workflow => [
      workflow.id, workflow.sourceVersionId, workflow.sourceSha256,
      workflow.publishedVersionId, workflow.sha256,
    ].join(':')),
  ].join('\n'))
  const transitionState = join(root, 'workflow-transition')
  mkdirSync(transitionState, { mode: 0o700 })
  const workflowReportPath = join(transitionState, 'live-report.json')
  const workflowReportValue = {
    schema: 'video-autoworker-n8n-workflow-compatibility/v2',
    protocol: 'slot-v1-execution-owner-v1',
    sourceCommit: commit,
    databasePath: database,
    runtimeIdentitySha256,
    workflows: workflowReports,
    combinedSha256: calculatedWorkflowDigest,
  }
  let workflowReport = writeBootstrapReceipt(workflowReportPath, workflowReportValue)
  const transition = createTransitionBinding({
    root, attempt, packagePath, database, runtimeRelease: release, releaseRoot, releaseId,
    manifestSha256: manifest.sha256, workflowReport: workflowReport.path,
  })
  const workflowDigest = options.workflowCombinedSha256 ?? calculatedWorkflowDigest
  if (options.workflowCombinedSha256) {
    overwriteJson(workflowReportPath, { ...workflowReportValue, combinedSha256: workflowDigest })
    workflowReport = fileReference(workflowReportPath)
  }
  const transitionClaim = JSON.parse(readFileSync(String(child(transition, 'claim').path), 'utf8')) as JsonRecord
  const attemptId = String(child(transitionClaim, 'bootstrap').attemptId)
  const prepareValue = {
    schema: 'video-autoworker-legacy-bootstrap-prepare/v1', attemptId,
    uid: process.getuid?.() ?? 0, sourceCommit: commit, prepareToolSha256: controllerSha256,
    databases: { mission: missionIdentity, n8n: databaseIdentity }, evidence, proof,
    target: {
      slot: target.slot, releaseId: target.releaseId, releaseRoot: target.releaseRoot,
      releaseRootIdentity, manifest,
    },
    routing,
    transition,
  }
  const prepare = writeBootstrapReceipt(preparePath, prepareValue)
  const tokenSha256 = 'd'.repeat(64)
  const confirm = writeBootstrapReceipt(join(attempt, 'current-confirm.receipt.json'), {
    schema: 'video-autoworker-legacy-bootstrap-current-confirm/v1', attemptId,
    uid: process.getuid?.() ?? 0, sourceCommit: commit, confirmedAt: historical,
    expiresAt: historical + 120, prepare, previousReceiptSha256: prepare.sha256, tokenSha256,
  })
  const shutdown = writeBootstrapReceipt(join(attempt, 'shutdown-requested.receipt.json'), {
    schema: 'video-autoworker-legacy-bootstrap-shutdown-requested/v1', attemptId,
    uid: process.getuid?.() ?? 0, sourceCommit: commit, requestedAt: historical,
    prepare, confirm, previousReceiptSha256: confirm.sha256, tokenSha256,
  })
  const pending = writeBootstrapReceipt(join(routerRunDirectory, 'bootstrap.pending.json'), {
    schema: 'video-autoworker-blue-green-bootstrap-pending/v4', attemptId,
    authorization: { prepare, confirm, shutdown }, evidence, proof,
    bootstrapClaim: transition.claim,
    createdAt: historical,
    databases: { mission: missionIdentity, n8n: databaseIdentity },
    router: routing,
    slot: target.slot,
    releaseId: target.releaseId,
    releaseRoot: target.releaseRoot,
    manifestSha256: target.manifestSha256,
    baselineSourceCommit: commit,
    evidenceObservedAt: historical,
    legacyPid: 1200,
    legacyCwd: join(root, 'legacy-runtime'),
    legacyReleaseId: 'legacy-runtime',
    n8n: {
      pid: 1300,
      dbPath: database,
      workflowProtocol: 'slot-v1-execution-owner-v1',
      workflowSourceCommit: commit,
      workflowDigest,
      workflowReport,
    },
    transition,
  })
  const recoveryAttemptId = '123e4567-e89b-42d3-a456-426614174000'
  const recoveryDirectory = join(attempt, 'disaster-recovery-attempts', recoveryAttemptId)
  mkdirSync(recoveryDirectory, { recursive: true, mode: 0o700 })
  const receipt = join(recoveryDirectory, 'n8n-disaster-recovery-confirmation.receipt.json')
  const issuedAt = Math.floor(Date.now() / 1000)
  const branchClaim = writeReferencedJson(join(attempt, 'recovery-branch.claim.json'), {
    schema: 'video-autoworker-legacy-bootstrap-recovery-branch/v2', attemptId,
    branch: 'restore', claimedAt: issuedAt, uid: process.getuid?.() ?? 0,
  }, 0o400)
  writeFileSync(receipt, `${JSON.stringify({
    schema: 'video-autoworker-n8n-managed-workflow-disaster-recovery-confirmation/v1',
    action: 'restore-managed-n8n-workflows', scope: 'n8n-managed-workflow-restore-only',
    recoveryAttemptId, issuedAt, expiresAt: issuedAt + 120, uid: process.getuid?.() ?? 0,
    nonce: 'e'.repeat(64), packageManifestSha256: sha256(readFileSync(join(packagePath, 'manifest.json'))),
    target: {
      databaseDev: `0x${databaseEntry.dev.toString(16)}`, databaseIno: databaseEntry.ino.toString(),
      sourceCommit: commit, n8nVersion: '2.31.6', runtimeRelease: release,
    },
    authorization: {
      kind: 'legacy-bootstrap-disaster-recovery/v1', attemptId, prepare, confirm, shutdown,
      pending, proof, workflowReport, controllerSha256, originalConfirmationExpiresAt: historical + 120,
      branchClaim, transition,
    },
    journal: {
      schema: 'video-autoworker-n8n-disaster-recovery-journal/v1', directory: recoveryDirectory,
      claim: join(recoveryDirectory, 'CLAIMED.receipt.json'),
      events: join(recoveryDirectory, 'events'),
      completed: join(recoveryDirectory, 'COMMITTED.receipt.json'),
    },
  })}\n`, { mode: 0o400 })
  chmodSync(receipt, 0o400)
  return { receipt, recoveryDirectory, pending: pending.path, mission, workflowReport: workflowReport.path }
}

function verifyDisasterReceipt(
  receipt: string,
  packagePath: string,
  database: string,
  release: string,
) {
  return spawnSync(process.execPath, [
    backupTool,
    'verify-disaster-receipt',
    '--database', database,
    '--n8n-version', '2.31.6',
    '--package', packagePath,
    '--receipt', receipt,
    '--runtime-release', release,
    '--source-commit', commit,
  ], { encoding: 'utf8' })
}

function replacePending(
  disaster: { receipt: string, pending: string },
  pending: Record<string, unknown>,
  pendingPath = disaster.pending,
): void {
  if (pendingPath === disaster.pending) overwriteJson(pendingPath, pending)
  else writeReferencedJson(pendingPath, pending, 0o400)
  const receipt = JSON.parse(readFileSync(disaster.receipt, 'utf8')) as Record<string, unknown>
  const authorization = receipt.authorization as Record<string, unknown>
  authorization.pending = fileReference(pendingPath)
  overwriteJson(disaster.receipt, receipt)
}

function unrelatedSnapshot(db: Database.Database): Record<string, unknown> {
  return {
    workflow: db.prepare("SELECT * FROM workflow_entity WHERE id = 'unrelated-workflow'").get(),
    history: db.prepare("SELECT * FROM workflow_history WHERE workflowId = 'unrelated-workflow'").all(),
    shared: db.prepare("SELECT * FROM shared_workflow WHERE workflowId = 'unrelated-workflow'").all(),
    settings: db.prepare('SELECT * FROM settings ORDER BY key').all(),
    executions: db.prepare('SELECT * FROM execution_entity ORDER BY id').all(),
  }
}

describe('managed n8n workflow recovery chain', () => {
  it('installs both recovery tools into current from one clean commit and covers them in the runtime digest', () => {
    const root = mkdtempSync(join(physicalTmp, 'n8n-managed-release-install-'))
    cleanup.push(() => removeFixture(root))
    const source = join(root, 'source')
    for (const pathname of [...runtimeSourcePaths, 'scripts/n8n-install.sh']) {
      const target = join(source, pathname)
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
      writeFileSync(target, readFileSync(join(projectRoot, pathname)), {
        mode: pathname.startsWith('scripts/') || pathname.endsWith('common.sh') ? 0o700 : 0o600,
      })
    }
    execFileSync('/usr/bin/git', ['init', '-q', source])
    execFileSync('/usr/bin/git', ['-C', source, 'add', '.'])
    execFileSync('/usr/bin/git', [
      '-C', source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '-qm', 'fixture',
    ])
    const sourceCommit = execFileSync('/usr/bin/git', [
      '-C', source, 'rev-parse', 'HEAD',
    ], { encoding: 'utf8' }).trim()
    const fakeNpm = join(root, 'fake-npm')
    writeFileSync(fakeNpm, `#!/bin/bash
set -euo pipefail
mkdir -p node_modules/n8n/bin
printf '%s\\n' '{"name":"n8n","version":"2.31.6"}' > node_modules/n8n/package.json
printf '%s\\n' '#!/usr/bin/env node' > node_modules/n8n/bin/n8n
`, { mode: 0o700 })
    const environment = join(root, 'n8n.env')
    writeFileSync(environment, '# isolated test environment\n', { mode: 0o600 })
    const runtimeRoot = join(root, 'runtime')
    const installed = spawnSync('/bin/bash', [join(source, 'scripts/n8n-install.sh')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        N8N_NODE_BIN: process.execPath,
        N8N_NPM_BIN: fakeNpm,
        N8N_ENCRYPTION_KEY: 'fixture-encryption-key-that-is-long-enough',
        AIWORKER_N8N_ENV_FILE: environment,
        AIWORKER_N8N_RUNTIME_ROOT: runtimeRoot,
        N8N_USER_FOLDER: join(root, 'state'),
        AIWORKER_N8N_LOG_DIR: join(root, 'logs'),
        AIWORKER_N8N_RUN_DIR: join(root, 'run'),
        AIWORKER_N8N_BACKUP_DIR: join(root, 'backups'),
        N8N_PORT: '45679',
      },
    })
    expect(installed.status, `${installed.stdout}\n${installed.stderr}`).toBe(0)
    const release = readlinkSync(join(runtimeRoot, 'current'))
    expect(release).toBe(join(runtimeRoot, 'releases', sourceCommit))
    expect(readFileSync(join(release, 'SOURCE_COMMIT'), 'utf8')).toBe(`${sourceCommit}\n`)
    const manifest = readFileSync(join(release, 'RUNTIME_SOURCE_SHA256SUMS'), 'utf8')
    const manifestPaths = manifest.trim().split('\n').map(line => line.slice(66))
    expect(manifestPaths).toEqual(runtimeSourcePaths)
    for (const file of [
      'n8n-maintenance-lock.mjs', 'n8n-workflow-transition-anchor.mjs', 'n8n-backup-managed-workflows.mjs',
      'n8n-restore-managed-workflows.sh',
    ]) {
      const installedTool = join(runtimeRoot, 'current/scripts', file)
      expect(Number(statSync(installedTool).mode & 0o777)).toBe(0o700)
      expect(manifest).toContain(`${sha256(readFileSync(join(source, 'scripts', file)))}  scripts/${file}\n`)
    }
  })

  it('backs up through WAL while online, restores fixed IDs offline, and preserves all sentinels', () => {
    const root = mkdtempSync(join(physicalTmp, 'n8n-managed-recovery-'))
    cleanup.push(() => removeFixture(root))
    const database = join(root, 'database.sqlite')
    const live = createDatabase(database)
    cleanup.push(() => live.close())
    const runtime = createRuntime(root)
    const packagePath = join(root, 'managed-workflows-backup')

    // Keeping this WAL connection open proves the backup path does not require
    // an n8n shutdown; the backup itself remains strictly read-only.
    const backupResult = backup(database, packagePath, runtime.runtimeDir)
    expect(backupResult.status, backupResult.stderr).toBe(0)
    expect(Number(statSync(packagePath).mode & 0o777)).toBe(0o500)
    for (const file of [
      'manifest.json', 'aiworker-task-intake-v1.json', 'aiworker-video-analysis-v1.json',
    ]) expect(Number(statSync(join(packagePath, file)).mode & 0o777)).toBe(0o400)
    const manifest = JSON.parse(readFileSync(join(packagePath, 'manifest.json'), 'utf8'))
    expect(manifest.workflows.map((value: { id: string; active: boolean; origin: string }) => ({
      id: value.id, active: value.active, origin: value.origin,
    }))).toEqual([
      { id: 'aiworker-task-intake-v1', active: true, origin: 'published' },
      { id: 'aiworker-video-analysis-v1', active: false, origin: 'current' },
    ])
    expect(readFileSync(join(packagePath, 'aiworker-task-intake-v1.json'), 'utf8'))
      .not.toContain('credentials')
    const packageValues = [
      'manifest.json', 'aiworker-task-intake-v1.json', 'aiworker-video-analysis-v1.json',
    ].map(file => JSON.parse(readFileSync(join(packagePath, file), 'utf8')) as unknown)
    expect(packageValues.some(value => containsExactScalar(value, 'unrelated-workflow'))).toBe(false)
    expect(packageValues.some(value => containsExactScalar(value, 'global-sentinel'))).toBe(false)
    expect(packageValues.some(value => containsExactScalar(value, 9001))).toBe(false)

    live.close()
    cleanup.pop()
    const db = new Database(database)
    const before = unrelatedSnapshot(db)
    db.prepare(`
      UPDATE workflow_entity SET name = 'drifted', nodes = '[]', active = 0, activeVersionId = NULL
      WHERE id IN ('aiworker-task-intake-v1', 'aiworker-video-analysis-v1')
    `).run()
    db.close()
    const receipt = createReceipt(join(root, 'bootstrap-attempt'), packagePath, database, runtime.release)
    const fsyncTrace = join(root, 'normal-fsync.trace')
    const fsyncEnv: NodeJS.ProcessEnv = {
      ...runtime.env,
      NODE_ENV: 'test',
      AIWORKER_TEST_N8N_FSYNC_TRACE: fsyncTrace,
    }

    const restore = () => spawnSync('/bin/bash', [
      restoreTool,
      '--database', database,
      '--package', packagePath,
      '--confirmation-receipt', receipt,
      '--runtime-release', runtime.release,
    ], { encoding: 'utf8', env: fsyncEnv })
    const first = restore()
    expect(first.status, `${first.stdout}\n${first.stderr}`).toBe(0)
    expect(JSON.parse(first.stdout)).toMatchObject({ unrelatedStatePreserved: true })
    const second = restore()
    expect(second.status).not.toBe(0)
    expect(second.stderr).toContain('completed restore cannot be replayed')

    const restored = new Database(database, { readonly: true })
    try {
      expect(restored.prepare(`
        SELECT id, active FROM workflow_entity
        WHERE id IN ('aiworker-task-intake-v1', 'aiworker-video-analysis-v1') ORDER BY id
      `).all()).toEqual([
        { id: 'aiworker-task-intake-v1', active: 1 },
        { id: 'aiworker-video-analysis-v1', active: 0 },
      ])
      expect(unrelatedSnapshot(restored)).toEqual(before)
    } finally { restored.close() }
    const operations = readFileSync(runtime.log, 'utf8').trim().split('\n')
    expect(operations.length).toBeGreaterThan(0)
    expect(operations.every(line => line.includes('aiworker-task-intake-v1')
      || line.includes('aiworker-video-analysis-v1'))).toBe(true)
    const journalDirectory = join(dirname(receipt), 'n8n-managed-workflow-restore-journal')
    const eventDirectory = join(journalDirectory, 'events')
    const claim = join(dirname(receipt), 'n8n-managed-workflow-restore.CLAIMED.receipt.json')
    expectDurablePublish(fsyncTrace, claim, dirname(receipt))
    for (const name of readdirSync(eventDirectory)) {
      expectDurablePublish(fsyncTrace, join(eventDirectory, name), eventDirectory)
    }
    expectDurablePublish(
      fsyncTrace, join(journalDirectory, 'COMMITTED.receipt.json'), journalDirectory,
    )
  })

  it('rejects an expired unclaimed restore, resumes claimed progress after TTL, and never replays completion', () => {
    const root = mkdtempSync(join(physicalTmp, 'n8n-managed-monotonic-recovery-'))
    cleanup.push(() => removeFixture(root))
    const database = join(root, 'database.sqlite')
    const live = createDatabase(database)
    const runtime = createRuntime(root)
    const packagePath = join(root, 'managed-workflows-backup')
    live.close()
    expect(backup(database, packagePath, runtime.runtimeDir).status).toBe(0)

    const staleReceipt = createReceipt(
      join(root, 'unclaimed-bootstrap-attempt'), packagePath, database, runtime.release,
    )
    const staleValue = JSON.parse(readFileSync(staleReceipt, 'utf8')) as { expiresAt: number }
    const restoreWith = (receipt: string, env: NodeJS.ProcessEnv) => spawnSync('/bin/bash', [
      restoreTool, '--database', database, '--package', packagePath,
      '--confirmation-receipt', receipt, '--runtime-release', runtime.release,
    ], { encoding: 'utf8', env })
    const expiredUnclaimed = restoreWith(staleReceipt, {
      ...runtime.env,
      NODE_ENV: 'test',
      AIWORKER_TEST_N8N_RECOVERY_NOW: String(staleValue.expiresAt + 1),
    })
    expect(expiredUnclaimed.status).not.toBe(0)
    expect(expiredUnclaimed.stderr).toContain('restore claim expired')
    expect(existsSync(runtime.log)).toBe(false)

    const receipt = createReceipt(join(root, 'bootstrap-attempt'), packagePath, database, runtime.release)
    const receiptValue = JSON.parse(readFileSync(receipt, 'utf8')) as { expiresAt: number }
    const db = new Database(database)
    db.prepare(`UPDATE workflow_entity SET name = 'drifted', nodes = '[]', active = 0, activeVersionId = NULL
      WHERE id IN ('aiworker-task-intake-v1', 'aiworker-video-analysis-v1')`).run()
    db.close()
    const crashMarker = join(root, 'crash-once.marker')
    const crashEnv: NodeJS.ProcessEnv = {
      ...runtime.env,
      NODE_ENV: 'test',
      AIWORKER_TEST_N8N_CRASH_AFTER_ID: 'aiworker-task-intake-v1',
      AIWORKER_TEST_N8N_CRASH_MARKER: crashMarker,
    }
    const interrupted = restoreWith(receipt, crashEnv)
    expect(interrupted.status).not.toBe(0)
    const journalDirectory = join(dirname(receipt), 'n8n-managed-workflow-restore-journal')
    const eventDirectory = join(journalDirectory, 'events')
    const firstEvents = readdirSync(eventDirectory).sort()
      .map(name => JSON.parse(readFileSync(join(eventDirectory, name), 'utf8')))
    expect(firstEvents.map(value => value.state)).toEqual(['CLAIMED', 'MUTATING'])
    expect(firstEvents.at(-1)).toMatchObject({
      completedWorkflows: [],
      currentWorkflow: 'aiworker-task-intake-v1',
    })

    const expiredResumeEnv: NodeJS.ProcessEnv = {
      ...crashEnv,
      AIWORKER_TEST_N8N_RECOVERY_NOW: String(receiptValue.expiresAt + 1),
    }
    const resumed = restoreWith(receipt, expiredResumeEnv)
    expect(resumed.status, `${resumed.stdout}\n${resumed.stderr}`).toBe(0)
    const finalEvents = readdirSync(eventDirectory).sort()
      .map(name => JSON.parse(readFileSync(join(eventDirectory, name), 'utf8')))
    expect(finalEvents.map(value => value.state)).toEqual([
      'CLAIMED', 'MUTATING', 'MUTATING', 'MUTATING', 'MUTATING', 'VERIFIED', 'COMMITTED',
    ])
    expect(existsSync(join(journalDirectory, 'COMMITTED.receipt.json'))).toBe(true)
    const operations = readFileSync(runtime.log, 'utf8').trim().split('\n')
    expect(operations.filter(line => line === 'import:aiworker-task-intake-v1')).toHaveLength(1)
    expect(operations.filter(line => line === 'import:aiworker-video-analysis-v1')).toHaveLength(1)

    const replay = restoreWith(receipt, expiredResumeEnv)
    expect(replay.status).not.toBe(0)
    expect(replay.stderr).toContain('completed restore cannot be replayed')
  })

  it('rolls back a pre-bootstrap partial transition through one durable claim and rejects replay', () => {
    const root = mkdtempSync(join(physicalTmp, 'n8n-transition-rollback-recovery-'))
    cleanup.push(() => removeFixture(root))
    const database = join(root, 'database.sqlite')
    const live = createDatabase(database)
    const runtime = createRuntime(root)
    const packagePath = join(root, 'managed-workflows-backup')
    live.close()
    expect(backup(database, packagePath, runtime.runtimeDir).status).toBe(0)
    const bootstrapAttempt = join(root, 'bootstrap-attempt')
    mkdirSync(bootstrapAttempt, { mode: 0o700 })
    const transition = createTransitionRollbackAuthorization(
      root, packagePath, database, runtime.release,
    )
    expect(readdirSync(bootstrapAttempt)).toEqual([])
    expect(dirname(transition.authorization)).toBe(transition.state)

    const restore = (env: NodeJS.ProcessEnv) => spawnSync('/bin/bash', [
      restoreTool, '--database', database, '--package', packagePath,
      '--confirmation-receipt', transition.authorization, '--runtime-release', runtime.release,
    ], { encoding: 'utf8', env })
    const interrupted = restore({
      ...runtime.env,
      NODE_ENV: 'test',
      AIWORKER_TEST_N8N_CRASH_AFTER_RESTORE_CLAIM: '1',
    })
    expect(interrupted.status).not.toBe(0)
    const claimPath = join(transition.state, 'transition-rollback.CLAIMED.receipt.json')
    expect(existsSync(claimPath)).toBe(true)
    expect(readdirSync(bootstrapAttempt)).toEqual([])

    const resumed = restore({
      ...runtime.env,
      NODE_ENV: 'test',
      AIWORKER_TEST_N8N_RECOVERY_NOW: String(Math.floor(Date.now() / 1000) + 86_400),
    })
    expect(resumed.status, `${resumed.stdout}\n${resumed.stderr}`).toBe(0)
    const eventDirectory = join(transition.state, 'transition-rollback-journal', 'events')
    const events = readdirSync(eventDirectory).sort()
      .map(name => JSON.parse(readFileSync(join(eventDirectory, name), 'utf8')))
    expect(events.map(value => value.state)).toEqual([
      'CLAIMED', 'MUTATING', 'MUTATING', 'MUTATING', 'MUTATING', 'VERIFIED', 'COMMITTED',
    ])
    expect(events.every(value => value.schema
      === 'video-autoworker-n8n-workflow-transition-rollback-journal/v1')).toBe(true)
    const restored = new Database(database, { readonly: true })
    try {
      expect(restored.prepare(`
        SELECT id, name, active FROM workflow_entity
        WHERE id IN ('aiworker-task-intake-v1', 'aiworker-video-analysis-v1') ORDER BY id
      `).all()).toEqual([
        { id: 'aiworker-task-intake-v1', name: 'workflow-intake-original', active: 1 },
        { id: 'aiworker-video-analysis-v1', name: 'workflow-video-original', active: 0 },
      ])
    } finally { restored.close() }
    expect(readdirSync(bootstrapAttempt)).toEqual([])

    const replay = restore(runtime.env)
    expect(replay.status).not.toBe(0)
    expect(replay.stderr).toContain('completed restore cannot be replayed')
  })

  it('atomically publishes claim before repairing partial directories and fails closed on unknown members', () => {
    const root = mkdtempSync(join(physicalTmp, 'n8n-managed-atomic-claim-'))
    cleanup.push(() => removeFixture(root))
    const database = join(root, 'database.sqlite')
    const live = createDatabase(database)
    const runtime = createRuntime(root)
    const packagePath = join(root, 'managed-workflows-backup')
    live.close()
    expect(backup(database, packagePath, runtime.runtimeDir).status).toBe(0)
    const restore = (receipt: string, env: NodeJS.ProcessEnv) => spawnSync('/bin/bash', [
      restoreTool, '--database', database, '--package', packagePath,
      '--confirmation-receipt', receipt, '--runtime-release', runtime.release,
    ], { encoding: 'utf8', env })

    const receipt = createReceipt(join(root, 'bootstrap-attempt'), packagePath, database, runtime.release)
    const receiptValue = JSON.parse(readFileSync(receipt, 'utf8')) as { expiresAt: number }
    const journalDirectory = join(dirname(receipt), 'n8n-managed-workflow-restore-journal')
    const eventDirectory = join(journalDirectory, 'events')
    mkdirSync(eventDirectory, { recursive: true, mode: 0o700 })
    chmodSync(journalDirectory, 0o700)
    chmodSync(eventDirectory, 0o700)
    const interrupted = restore(receipt, {
      ...runtime.env,
      NODE_ENV: 'test',
      AIWORKER_TEST_N8N_CRASH_AFTER_RESTORE_CLAIM: '1',
    })
    expect(interrupted.status).not.toBe(0)
    const claim = join(dirname(receipt), 'n8n-managed-workflow-restore.CLAIMED.receipt.json')
    expect(existsSync(claim)).toBe(true)
    expect(readdirSync(eventDirectory)).toEqual([])

    const resumed = restore(receipt, {
      ...runtime.env,
      NODE_ENV: 'test',
      AIWORKER_TEST_N8N_RECOVERY_NOW: String(receiptValue.expiresAt + 1),
    })
    expect(resumed.status, `${resumed.stdout}\n${resumed.stderr}`).toBe(0)
    const events = readdirSync(eventDirectory).sort()
      .map(name => JSON.parse(readFileSync(join(eventDirectory, name), 'utf8')))
    expect(events.at(0)).toMatchObject({ index: 0, state: 'CLAIMED' })
    expect(events.at(-1)).toMatchObject({ state: 'COMMITTED' })

    const unknownReceipt = createReceipt(
      join(root, 'unknown-member-attempt'), packagePath, database, runtime.release,
    )
    const unknownJournal = join(dirname(unknownReceipt), 'n8n-managed-workflow-restore-journal')
    mkdirSync(unknownJournal, { mode: 0o700 })
    writeFileSync(join(unknownJournal, 'foreign.json'), '{}\n', { mode: 0o400 })
    const rejected = restore(unknownReceipt, runtime.env)
    expect(rejected.status).not.toBe(0)
    expect(rejected.stderr).toContain('restore journal contains an unknown member')
    expect(existsSync(join(
      dirname(unknownReceipt), 'n8n-managed-workflow-restore.CLAIMED.receipt.json',
    ))).toBe(false)
  })

  it('resumes from durable VERIFIED after restart and commits without replaying either workflow', () => {
    const root = mkdtempSync(join(physicalTmp, 'n8n-managed-verified-resume-'))
    cleanup.push(() => removeFixture(root))
    const database = join(root, 'database.sqlite')
    const live = createDatabase(database)
    const runtime = createRuntime(root)
    const packagePath = join(root, 'managed-workflows-backup')
    live.close()
    expect(backup(database, packagePath, runtime.runtimeDir).status).toBe(0)
    const receipt = createReceipt(join(root, 'bootstrap-attempt'), packagePath, database, runtime.release)
    const receiptValue = JSON.parse(readFileSync(receipt, 'utf8')) as { expiresAt: number }
    const db = new Database(database)
    db.prepare(`UPDATE workflow_entity SET name = 'drifted', nodes = '[]', active = 0, activeVersionId = NULL
      WHERE id IN ('aiworker-task-intake-v1', 'aiworker-video-analysis-v1')`).run()
    db.close()
    const restore = (env: NodeJS.ProcessEnv) => spawnSync('/bin/bash', [
      restoreTool, '--database', database, '--package', packagePath,
      '--confirmation-receipt', receipt, '--runtime-release', runtime.release,
    ], { encoding: 'utf8', env })
    const crashMarker = join(root, 'verified-crash.marker')
    const interrupted = restore({
      ...runtime.env,
      NODE_ENV: 'test',
      AIWORKER_TEST_N8N_CRASH_AFTER_RESTORE_VERIFIED: '1',
      AIWORKER_TEST_N8N_VERIFIED_CRASH_MARKER: crashMarker,
    })
    expect(interrupted.status).not.toBe(0)
    const journalDirectory = join(dirname(receipt), 'n8n-managed-workflow-restore-journal')
    const eventDirectory = join(journalDirectory, 'events')
    const interruptedEvents = readdirSync(eventDirectory).sort()
      .map(name => JSON.parse(readFileSync(join(eventDirectory, name), 'utf8')))
    expect(interruptedEvents.at(-1)).toMatchObject({
      state: 'VERIFIED',
      completedWorkflows: ['aiworker-task-intake-v1', 'aiworker-video-analysis-v1'],
      currentWorkflow: null,
    })
    expect(existsSync(join(journalDirectory, 'COMMITTED.receipt.json'))).toBe(false)

    const resumed = restore({
      ...runtime.env,
      NODE_ENV: 'test',
      AIWORKER_TEST_N8N_RECOVERY_NOW: String(receiptValue.expiresAt + 1),
    })
    expect(resumed.status, `${resumed.stdout}\n${resumed.stderr}`).toBe(0)
    const finalEvents = readdirSync(eventDirectory).sort()
      .map(name => JSON.parse(readFileSync(join(eventDirectory, name), 'utf8')))
    expect(finalEvents.filter(value => value.state === 'VERIFIED')).toHaveLength(1)
    expect(finalEvents.at(-1)).toMatchObject({ state: 'COMMITTED' })
    const operations = readFileSync(runtime.log, 'utf8').trim().split('\n')
    expect(operations.filter(line => line === 'import:aiworker-task-intake-v1')).toHaveLength(1)
    expect(operations.filter(line => line === 'import:aiworker-video-analysis-v1')).toHaveLength(1)

    const replay = restore(runtime.env)
    expect(replay.status).not.toBe(0)
    expect(replay.stderr).toContain('completed restore cannot be replayed')
  })

  it('claims a disaster receipt once, resumes the same journal after a crash, and rejects committed replay', () => {
    const root = mkdtempSync(join(physicalTmp, 'n8n-managed-disaster-recovery-'))
    cleanup.push(() => removeFixture(root))
    const database = join(root, 'database.sqlite')
    const live = createDatabase(database)
    const runtime = createRuntime(root)
    const packagePath = join(root, 'managed-workflows-backup')
    live.close()
    expect(backup(database, packagePath, runtime.runtimeDir).status).toBe(0)
    const disaster = createDisasterReceipt(join(root, 'bootstrap-attempt'), packagePath, database, runtime.release)
    const db = new Database(database)
    db.prepare(`UPDATE workflow_entity SET name = 'drifted', nodes = '[]', active = 0, activeVersionId = NULL
      WHERE id IN ('aiworker-task-intake-v1', 'aiworker-video-analysis-v1')`).run()
    db.close()
    const failMarker = join(root, 'fail-once.marker')
    const fsyncTrace = join(root, 'disaster-fsync.trace')
    const restore = () => spawnSync('/bin/bash', [
      restoreTool, '--database', database, '--package', packagePath,
      '--confirmation-receipt', disaster.receipt, '--runtime-release', runtime.release,
    ], {
      encoding: 'utf8',
      env: {
        ...runtime.env,
        NODE_ENV: 'test',
        AIWORKER_TEST_N8N_FSYNC_TRACE: fsyncTrace,
        AIWORKER_TEST_N8N_FAIL_ON_ID: 'aiworker-video-analysis-v1',
        AIWORKER_TEST_N8N_FAIL_MARKER: failMarker,
      },
    })
    const interrupted = restore()
    expect(interrupted.status).not.toBe(0)
    const eventDirectory = join(disaster.recoveryDirectory, 'events')
    const firstEvents = readdirSync(eventDirectory).sort()
      .map(name => JSON.parse(readFileSync(join(eventDirectory, name), 'utf8')))
    expect(firstEvents.map(value => value.state)).toEqual(['CLAIMED', 'MUTATING'])
    expect(firstEvents.at(-1).completedWorkflows).toEqual(['aiworker-task-intake-v1'])

    const resumed = restore()
    expect(resumed.status, `${resumed.stdout}\n${resumed.stderr}`).toBe(0)
    const finalEvents = readdirSync(eventDirectory).sort()
      .map(name => JSON.parse(readFileSync(join(eventDirectory, name), 'utf8')))
    expect(finalEvents.map(value => value.state)).toEqual([
      'CLAIMED', 'MUTATING', 'MUTATING', 'VERIFIED', 'COMMITTED',
    ])
    expect(existsSync(join(disaster.recoveryDirectory, 'COMMITTED.receipt.json'))).toBe(true)
    expectDurablePublish(
      fsyncTrace, join(disaster.recoveryDirectory, 'CLAIMED.receipt.json'), disaster.recoveryDirectory,
    )
    for (const name of readdirSync(eventDirectory)) {
      expectDurablePublish(fsyncTrace, join(eventDirectory, name), eventDirectory)
    }
    expectDurablePublish(
      fsyncTrace,
      join(disaster.recoveryDirectory, 'COMMITTED.receipt.json'),
      disaster.recoveryDirectory,
    )
    const replay = restore()
    expect(replay.status).not.toBe(0)
    expect(replay.stderr).toContain('completed disaster recovery cannot be replayed')
  })

  it('resumes disaster recovery from durable VERIFIED and commits without replaying workflows', () => {
    const root = mkdtempSync(join(physicalTmp, 'n8n-managed-disaster-verified-resume-'))
    cleanup.push(() => removeFixture(root))
    const database = join(root, 'database.sqlite')
    const live = createDatabase(database)
    const runtime = createRuntime(root)
    const packagePath = join(root, 'managed-workflows-backup')
    live.close()
    expect(backup(database, packagePath, runtime.runtimeDir).status).toBe(0)
    const disaster = createDisasterReceipt(
      join(root, 'bootstrap-attempt'), packagePath, database, runtime.release,
    )
    const db = new Database(database)
    db.prepare(`UPDATE workflow_entity SET name = 'drifted', nodes = '[]', active = 0, activeVersionId = NULL
      WHERE id IN ('aiworker-task-intake-v1', 'aiworker-video-analysis-v1')`).run()
    db.close()
    const restore = (env: NodeJS.ProcessEnv) => spawnSync('/bin/bash', [
      restoreTool, '--database', database, '--package', packagePath,
      '--confirmation-receipt', disaster.receipt, '--runtime-release', runtime.release,
    ], { encoding: 'utf8', env })
    const interrupted = restore({
      ...runtime.env,
      NODE_ENV: 'test',
      AIWORKER_TEST_N8N_CRASH_AFTER_RESTORE_VERIFIED: '1',
      AIWORKER_TEST_N8N_VERIFIED_CRASH_MARKER: join(root, 'disaster-verified-crash.marker'),
    })
    expect(interrupted.status).not.toBe(0)
    const eventDirectory = join(disaster.recoveryDirectory, 'events')
    const interruptedEvents = readdirSync(eventDirectory).sort()
      .map(name => JSON.parse(readFileSync(join(eventDirectory, name), 'utf8')))
    expect(interruptedEvents.at(-1)).toMatchObject({
      state: 'VERIFIED',
      completedWorkflows: ['aiworker-task-intake-v1', 'aiworker-video-analysis-v1'],
    })
    expect(existsSync(join(disaster.recoveryDirectory, 'COMMITTED.receipt.json'))).toBe(false)

    const resumed = restore(runtime.env)
    expect(resumed.status, `${resumed.stdout}\n${resumed.stderr}`).toBe(0)
    const finalEvents = readdirSync(eventDirectory).sort()
      .map(name => JSON.parse(readFileSync(join(eventDirectory, name), 'utf8')))
    expect(finalEvents.filter(value => value.state === 'VERIFIED')).toHaveLength(1)
    expect(finalEvents.at(-1)).toMatchObject({ state: 'COMMITTED' })
    const operations = readFileSync(runtime.log, 'utf8').trim().split('\n')
    expect(operations.filter(line => line === 'import:aiworker-task-intake-v1')).toHaveLength(1)
    expect(operations.filter(line => line === 'import:aiworker-video-analysis-v1')).toHaveLength(1)

    const replay = restore(runtime.env)
    expect(replay.status).not.toBe(0)
    expect(replay.stderr).toContain('completed disaster recovery cannot be replayed')
  })

  it('independently validates every pending v4 binding and its immutable canonical path', () => {
    const root = mkdtempSync(join(physicalTmp, 'n8n-managed-disaster-pending-'))
    cleanup.push(() => removeFixture(root))
    const database = join(root, 'database.sqlite')
    const live = createDatabase(database)
    const runtime = createRuntime(root)
    const packagePath = join(root, 'managed-workflows-backup')
    live.close()
    expect(backup(database, packagePath, runtime.runtimeDir).status).toBe(0)
    const disaster = createDisasterReceipt(
      join(root, 'bootstrap-attempt'), packagePath, database, runtime.release,
    )
    const valid = verifyDisasterReceipt(disaster.receipt, packagePath, database, runtime.release)
    expect(valid.status, `${valid.stdout}\n${valid.stderr}`).toBe(0)
    expect(dirname(disaster.workflowReport)).toBe(join(root, 'workflow-transition'))
    expect(dirname(disaster.workflowReport)).not.toBe(join(root, 'bootstrap-attempt'))
    const original = JSON.parse(readFileSync(disaster.pending, 'utf8')) as JsonRecord
    const mutations: Array<{ name: string, mutate: (value: JsonRecord) => void }> = [
      { name: 'extra top-level field', mutate: value => { value.extra = true } },
      { name: 'missing top-level field', mutate: value => { delete value.baselineSourceCommit } },
      { name: 'slot', mutate: value => { value.slot = 'green' } },
      { name: 'release ID', mutate: value => { value.releaseId = 'other-runtime' } },
      { name: 'release root', mutate: value => { value.releaseRoot = root } },
      { name: 'manifest digest', mutate: value => { value.manifestSha256 = '8'.repeat(64) } },
      { name: 'createdAt', mutate: value => { value.createdAt = 1 } },
      { name: 'baseline source commit', mutate: value => { value.baselineSourceCommit = 'b'.repeat(40) } },
      { name: 'evidence observedAt', mutate: value => { value.evidenceObservedAt = 1 } },
      { name: 'legacy PID', mutate: value => { value.legacyPid = 1201 } },
      { name: 'legacy cwd', mutate: value => { value.legacyCwd = join(root, 'other-cwd') } },
      { name: 'legacy release', mutate: value => { value.legacyReleaseId = 'other-runtime' } },
      { name: 'mission database inode', mutate: value => { child(child(value, 'databases'), 'mission').ino = '1' } },
      { name: 'n8n database path', mutate: value => { child(value, 'n8n').dbPath = disaster.mission } },
      { name: 'router port', mutate: value => { child(value, 'router').port = 3018 } },
      {
        name: 'router run directory inode',
        mutate: value => { child(child(value, 'router'), 'runDirectory').ino = '1' },
      },
      { name: 'router state path', mutate: value => { child(value, 'router').statePath = join(root, 'router-state.json') } },
      { name: 'n8n PID', mutate: value => { child(value, 'n8n').pid = 1301 } },
      { name: 'workflow protocol', mutate: value => { child(value, 'n8n').workflowProtocol = 'legacy-v1' } },
      { name: 'workflow source commit', mutate: value => { child(value, 'n8n').workflowSourceCommit = 'b'.repeat(40) } },
      { name: 'workflow digest', mutate: value => { child(value, 'n8n').workflowDigest = 'invalid' } },
      {
        name: 'workflow report reference',
        mutate: value => { child(child(value, 'n8n'), 'workflowReport').sha256 = '4'.repeat(64) },
      },
      {
        name: 'prepare authorization reference',
        mutate: value => { child(child(value, 'authorization'), 'prepare').sha256 = '7'.repeat(64) },
      },
      { name: 'evidence reference', mutate: value => { child(value, 'evidence').sha256 = '6'.repeat(64) } },
      { name: 'proof reference', mutate: value => { child(value, 'proof').sha256 = '5'.repeat(64) } },
      {
        name: 'bootstrap transition claim reference',
        mutate: value => { child(value, 'bootstrapClaim').sha256 = '4'.repeat(64) },
      },
      {
        name: 'transition attestation reference',
        mutate: value => { child(child(value, 'transition'), 'attestation').sha256 = '3'.repeat(64) },
      },
      {
        name: 'transition committed journal head',
        mutate: value => { child(value, 'transition').committedJournalHeadSha256 = '2'.repeat(64) },
      },
    ]
    for (const entry of mutations) {
      const candidate = structuredClone(original)
      entry.mutate(candidate)
      replacePending(disaster, candidate)
      const rejected = verifyDisasterReceipt(disaster.receipt, packagePath, database, runtime.release)
      expect(rejected.status, `${entry.name}: ${rejected.stdout}\n${rejected.stderr}`).not.toBe(0)
    }

    const alternateReport = writeBootstrapReceipt(
      join(root, 'workflow-transition', 'alternate-live-report.json'),
      JSON.parse(readFileSync(disaster.workflowReport, 'utf8')),
    )
    const coordinated = structuredClone(original)
    child(child(coordinated, 'n8n'), 'workflowReport').path = alternateReport.path
    child(child(coordinated, 'n8n'), 'workflowReport').dev = alternateReport.dev
    child(child(coordinated, 'n8n'), 'workflowReport').ino = alternateReport.ino
    child(child(coordinated, 'n8n'), 'workflowReport').size = alternateReport.size
    child(child(coordinated, 'n8n'), 'workflowReport').sha256 = alternateReport.sha256
    replacePending(disaster, coordinated)
    const coordinatedReceipt = JSON.parse(readFileSync(disaster.receipt, 'utf8')) as JsonRecord
    child(coordinatedReceipt, 'authorization').workflowReport = alternateReport
    overwriteJson(disaster.receipt, coordinatedReceipt)
    const coordinatedRejected = verifyDisasterReceipt(
      disaster.receipt, packagePath, database, runtime.release,
    )
    expect(coordinatedRejected.status).not.toBe(0)
    expect(coordinatedRejected.stderr).toContain('attested deployed workflow binding changed')

    replacePending(disaster, structuredClone(original))
    const restoredReceipt = JSON.parse(readFileSync(disaster.receipt, 'utf8')) as JsonRecord
    child(restoredReceipt, 'authorization').workflowReport = child(child(original, 'n8n'), 'workflowReport')
    overwriteJson(disaster.receipt, restoredReceipt)
    chmodSync(disaster.pending, 0o600)
    const writable = verifyDisasterReceipt(disaster.receipt, packagePath, database, runtime.release)
    expect(writable.status).not.toBe(0)
    expect(writable.stderr).toContain('bootstrap pending v4')
    chmodSync(disaster.pending, 0o400)

    const handwritten = join(dirname(disaster.pending), 'handwritten.pending.json')
    replacePending(disaster, structuredClone(original), handwritten)
    const nonCanonical = verifyDisasterReceipt(disaster.receipt, packagePath, database, runtime.release)
    expect(nonCanonical.status).not.toBe(0)
    expect(nonCanonical.stderr).toContain('canonical bootstrap chain')
  })

  it('rejects drifted manifests, evidence/proof schemas, and workflow compatibility reports', () => {
    const variants = [
      { name: 'evidence', error: 'pending freeze evidence', options: { evidenceSchema: 'handwritten-evidence/v1' } },
      { name: 'proof', error: 'pending rollback proof', options: { proofSchema: 'handwritten-proof/v1' } },
      {
        name: 'workflow-report',
        error: 'workflow compatibility digest changed',
        options: { workflowCombinedSha256: '7'.repeat(64) },
      },
    ]
    for (const variant of variants) {
      const root = mkdtempSync(join(physicalTmp, `n8n-managed-disaster-${variant.name}-`))
      cleanup.push(() => removeFixture(root))
      const database = join(root, 'database.sqlite')
      const live = createDatabase(database)
      const runtime = createRuntime(root)
      const packagePath = join(root, 'managed-workflows-backup')
      live.close()
      expect(backup(database, packagePath, runtime.runtimeDir).status).toBe(0)
      const disaster = createDisasterReceipt(
        join(root, 'bootstrap-attempt'), packagePath, database, runtime.release, variant.options,
      )
      const rejected = verifyDisasterReceipt(disaster.receipt, packagePath, database, runtime.release)
      expect(rejected.status).not.toBe(0)
      expect(rejected.stderr).toContain(variant.error)
    }

    const root = mkdtempSync(join(physicalTmp, 'n8n-managed-disaster-manifest-'))
    cleanup.push(() => removeFixture(root))
    const database = join(root, 'database.sqlite')
    const live = createDatabase(database)
    const runtime = createRuntime(root)
    const packagePath = join(root, 'managed-workflows-backup')
    live.close()
    expect(backup(database, packagePath, runtime.runtimeDir).status).toBe(0)
    const disaster = createDisasterReceipt(
      join(root, 'bootstrap-attempt'), packagePath, database, runtime.release,
    )
    const pending = JSON.parse(readFileSync(disaster.pending, 'utf8')) as JsonRecord
    const manifestPath = join(String(pending.releaseRoot), 'release-manifest.json')
    chmodSync(manifestPath, 0o600)
    writeFileSync(manifestPath, '{"schema":"drifted-release/v1"}\n', { mode: 0o600 })
    const drifted = verifyDisasterReceipt(disaster.receipt, packagePath, database, runtime.release)
    expect(drifted.status).not.toBe(0)
    expect(drifted.stderr).toContain('workflow transition anchor verification failed')
  })

  it('fails closed before the CLI when the receipt is not immutable or n8n is still running', () => {
    const root = mkdtempSync(join(physicalTmp, 'n8n-managed-recovery-closed-'))
    cleanup.push(() => removeFixture(root))
    const database = join(root, 'database.sqlite')
    const fixture = createDatabase(database)
    fixture.close()
    const runtime = createRuntime(root)
    const packagePath = join(root, 'managed-workflows-backup')
    const backupResult = backup(database, packagePath, runtime.runtimeDir)
    expect(backupResult.status, backupResult.stderr).toBe(0)
    const receipt = createReceipt(join(root, 'bootstrap-attempt'), packagePath, database, runtime.release)
    const validReceipt = readFileSync(receipt)
    chmodSync(receipt, 0o600)
    const invalidReceipt = spawnSync('/bin/bash', [
      restoreTool, '--database', database, '--package', packagePath,
      '--confirmation-receipt', receipt, '--runtime-release', runtime.release,
    ], { encoding: 'utf8', env: runtime.env })
    expect(invalidReceipt.status).not.toBe(0)
    expect(invalidReceipt.stderr).toContain('confirmation receipt')

    writeFileSync(receipt, `${JSON.stringify({
      schema: 'video-autoworker-n8n-managed-workflow-restore-confirmation/v1',
      action: 'restore-managed-n8n-workflows',
    })}\n`, { mode: 0o400 })
    chmodSync(receipt, 0o400)
    const handwrittenV1 = spawnSync('/bin/bash', [
      restoreTool, '--database', database, '--package', packagePath,
      '--confirmation-receipt', receipt, '--runtime-release', runtime.release,
    ], { encoding: 'utf8', env: runtime.env })
    expect(handwrittenV1.status).not.toBe(0)
    expect(handwrittenV1.stderr).toContain('confirmation receipt')

    chmodSync(receipt, 0o600)
    writeFileSync(receipt, validReceipt)
    chmodSync(receipt, 0o400)
    writeFileSync(runtime.env.AIWORKER_N8N_PID_FILE!, `${process.pid}\n`, { mode: 0o600 })
    const running = spawnSync('/bin/bash', [
      restoreTool, '--database', database, '--package', packagePath,
      '--confirmation-receipt', receipt, '--runtime-release', runtime.release,
    ], { encoding: 'utf8', env: runtime.env })
    expect(running.status).not.toBe(0)
    expect(running.stderr).toContain('still identifies a running process')
    expect(() => readFileSync(runtime.log)).toThrow()
  })

  it('refuses to package any managed workflow containing credential references', () => {
    const root = mkdtempSync(join(physicalTmp, 'n8n-managed-recovery-creds-'))
    cleanup.push(() => removeFixture(root))
    const database = join(root, 'database.sqlite')
    const fixture = createDatabase(database)
    fixture.close()
    const runtime = createRuntime(root)
    const db = new Database(database)
    db.prepare(`
      UPDATE workflow_entity SET nodes = ? WHERE id = 'aiworker-video-analysis-v1'
    `).run(JSON.stringify([{ id: 'unsafe', credentials: { api: { id: 'secret-reference' } } }]))
    db.close()
    const result = backup(database, join(root, 'rejected-package'), runtime.runtimeDir)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('credential reference')
  })

  it('rejects an ABA database path replacement instead of trusting the restored pathname', () => {
    const root = mkdtempSync(join(physicalTmp, 'n8n-managed-recovery-aba-'))
    cleanup.push(() => removeFixture(root))
    const database = join(root, 'database.sqlite')
    const original = createDatabase(database)
    original.close()
    const originalIdentity = statSync(database, { bigint: true })
    const replacement = join(root, 'replacement.sqlite')
    const alternate = createDatabase(replacement)
    alternate.close()
    const held = join(root, 'original.sqlite')
    const beforeOpen = join(root, 'before-open.mjs')
    const afterOpen = join(root, 'after-open.mjs')
    writeFileSync(beforeOpen, `#!/usr/bin/env node
import { renameSync } from 'node:fs'
renameSync(${JSON.stringify(database)}, ${JSON.stringify(held)})
renameSync(${JSON.stringify(replacement)}, ${JSON.stringify(database)})
`, { mode: 0o700 })
    writeFileSync(afterOpen, `#!/usr/bin/env node
import { renameSync } from 'node:fs'
renameSync(${JSON.stringify(database)}, ${JSON.stringify(replacement)})
renameSync(${JSON.stringify(held)}, ${JSON.stringify(database)})
`, { mode: 0o700 })
    const runtime = createRuntime(root)
    const result = backup(database, join(root, 'rejected-package'), runtime.runtimeDir, {
      ...process.env,
      NODE_ENV: 'test',
      AIWORKER_TEST_N8N_RECOVERY_IDENTITY: '1',
      AIWORKER_TEST_N8N_RECOVERY_BEFORE_DATABASE_OPEN: beforeOpen,
      AIWORKER_TEST_N8N_RECOVERY_AFTER_DATABASE_OPEN: afterOpen,
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('SQLite handle does not match the preflight database inode')
    const restoredIdentity = statSync(database, { bigint: true })
    expect(restoredIdentity.dev).toBe(originalIdentity.dev)
    expect(restoredIdentity.ino).toBe(originalIdentity.ino)
  })
})
