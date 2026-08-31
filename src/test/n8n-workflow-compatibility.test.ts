// @vitest-environment node

import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'

interface WorkflowDefinition {
  id: string
  name: string
  nodes: unknown[]
  connections: Record<string, unknown>
  settings: Record<string, unknown>
  versionId: string
  nodeGroups?: unknown[]
}

const cleanup: Array<() => void> = []
const projectRoot = realpathSync(process.cwd())
const workflowDir = resolve(projectRoot, 'ops/n8n/workflows')
const verifier = resolve(projectRoot, 'scripts/verify-n8n-blue-green-workflows.mjs')
const projectCommit = execFileSync('git', [
  '-C', projectRoot, 'rev-parse', '--verify', 'HEAD^{commit}',
], { encoding: 'utf8' }).trim()
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

function currentWorkflows(): WorkflowDefinition[] {
  return ['aiworker-task-intake.json', 'aiworker-video-analysis.json'].map(file =>
    JSON.parse(readFileSync(join(workflowDir, file), 'utf8')) as WorkflowDefinition)
}

function legacyShapedWorkflows(): WorkflowDefinition[] {
  return currentWorkflows().map((workflow, index) => {
    const legacy = JSON.parse(
      JSON.stringify(workflow).replaceAll('executionOwner', 'legacyExecutionOwner'),
    ) as WorkflowDefinition
    if (index === 0) {
      legacy.nodes = (legacy.nodes as Array<Record<string, unknown>>)
        .filter(node => node.name !== 'Claim Task')
    }
    return legacy
  })
}

function createWorkflowDatabase(
  pathname: string,
  workflows: WorkflowDefinition[],
  options: { active?: boolean } = {},
): void {
  const db = new Database(pathname)
  try {
    db.exec(`
      CREATE TABLE workflow_entity (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        active INTEGER NOT NULL,
        isArchived INTEGER NOT NULL,
        nodes TEXT NOT NULL,
        connections TEXT NOT NULL,
        settings TEXT NOT NULL,
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
    `)
    const active = options.active !== false
    for (const workflow of workflows) {
      // n8n 2.31.6 import:workflow replaces the source JSON versionId with a
      // fresh UUID, then publish:workflow points activeVersionId at that row.
      const publishedVersionId = randomUUID()
      db.prepare(`
        INSERT INTO workflow_entity (
          id, name, active, isArchived, nodes, connections, settings, versionId, activeVersionId
        ) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)
      `).run(
        workflow.id,
        workflow.name,
        active ? 1 : 0,
        JSON.stringify(workflow.nodes),
        JSON.stringify(workflow.connections),
        JSON.stringify(workflow.settings),
        publishedVersionId,
        active ? publishedVersionId : null,
      )
      db.prepare(`
        INSERT INTO workflow_history (
          versionId, workflowId, name, nodes, connections, nodeGroups
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        publishedVersionId,
        workflow.id,
        workflow.name,
        JSON.stringify(workflow.nodes),
        JSON.stringify(workflow.connections),
        JSON.stringify(workflow.nodeGroups || []),
      )
    }
  } finally {
    db.close()
  }
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function gitSource(pathname: string): Buffer {
  const result = spawnSync('git', ['-C', projectRoot, 'show', `${projectCommit}:${pathname}`], {
    maxBuffer: 4 * 1024 * 1024,
  })
  if (result.status === 0 && result.stdout) return result.stdout
  const candidateOnly = new Set([
    'scripts/n8n-backup-managed-workflows.mjs',
    'scripts/n8n-maintenance-lock.mjs',
    'scripts/n8n-restore-managed-workflows.sh',
    'scripts/n8n-workflow-transition-anchor.mjs',
  ])
  if (!candidateOnly.has(pathname)) throw new Error(`tracked fixture source is unavailable: ${pathname}`)
  return readFileSync(join(projectRoot, pathname))
}

interface IdentityFixture {
  runtimeRoot: string
  runtimeCwd: string
  runtimeCurrent?: string
  nodeCurrent?: string
  physicalNode: string
  cliArgument: string
  nodeArgument: string
  sourceManifest: string
  runtimeManifest: string
  packageDefinition: string
  env: NodeJS.ProcessEnv
}

function createIdentityFixture(
  root: string,
  database: string,
  options: {
    cliArgument?: string
    cwdPath?: string
    listenerPid?: number | null
    nodeArgument?: string
    processPid?: number
    realisticCurrent?: boolean
    verifierDatabaseIdentityPath?: string
  } = {},
): IdentityFixture {
  const runtimeServiceRoot = options.realisticCurrent ? join(root, 'n8n-service') : root
  const runtimeRoot = options.realisticCurrent
    ? join(runtimeServiceRoot, 'releases', projectCommit)
    : join(runtimeServiceRoot, projectCommit)
  const runtimeCwd = join(runtimeRoot, 'ops/n8n')
  for (const pathname of runtimeSourcePaths) {
    const target = join(runtimeRoot, pathname)
    mkdirSync(resolve(target, '..'), { recursive: true })
    writeFileSync(target, gitSource(pathname))
  }
  const cliPath = join(runtimeCwd, 'node_modules/n8n/bin/n8n')
  const packageDefinition = join(runtimeCwd, 'node_modules/n8n/package.json')
  mkdirSync(resolve(cliPath, '..'), { recursive: true })
  writeFileSync(cliPath, '#!/usr/bin/env node\n')
  writeFileSync(packageDefinition, '{"name":"n8n","version":"2.31.6"}\n')
  const runtimeManifest = join(runtimeRoot, 'RUNTIME_SOURCE_SHA256SUMS')
  const runtimeManifestSource = `${runtimeSourcePaths.map(pathname =>
    `${sha256(gitSource(pathname))}  ${pathname}`).join('\n')}\n`
  writeFileSync(runtimeManifest, runtimeManifestSource, { mode: 0o600 })
  writeFileSync(join(runtimeRoot, 'SOURCE_COMMIT'), `${projectCommit}\n`, { mode: 0o600 })
  const sourceManifest = join(runtimeRoot, 'SOURCE_MANIFEST')
  writeFileSync(sourceManifest, [
    'source_origin=https://example.invalid/video-autoworker.git',
    `source_commit=${projectCommit}`,
    `package_lock_sha256=${sha256(gitSource('ops/n8n/package-lock.json'))}`,
    `workflow_sha256=${sha256(gitSource('ops/n8n/workflows/aiworker-task-intake.json'))}`,
    `video_workflow_sha256=${sha256(gitSource('ops/n8n/workflows/aiworker-video-analysis.json'))}`,
    `runtime_source_manifest_sha256=${sha256(runtimeManifestSource)}`,
    'n8n_version=2.31.6',
    'built_at=2026-08-31T00:00:00Z',
    '',
  ].join('\n'), { mode: 0o600 })

  let runtimeCurrent: string | undefined
  let nodeCurrent: string | undefined
  let physicalNode = realpathSync(process.execPath)
  if (options.realisticCurrent) {
    runtimeCurrent = join(runtimeServiceRoot, 'current')
    if (!statSync(runtimeServiceRoot).isDirectory()) throw new Error('runtime service root unavailable')
    try { symlinkSync(runtimeRoot, runtimeCurrent) } catch {}
    const nodeServiceRoot = join(root, 'node-service')
    const nodeRelease = join(nodeServiceRoot, 'releases/node-v22.22.3')
    physicalNode = join(nodeRelease, 'bin/node')
    mkdirSync(resolve(physicalNode, '..'), { recursive: true })
    writeFileSync(physicalNode, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    nodeCurrent = join(nodeServiceRoot, 'current')
    try { symlinkSync(nodeRelease, nodeCurrent) } catch {}
  }

  const processPid = options.processPid ?? process.pid
  const launchPid = process.ppid
  const cwdPath = options.cwdPath ?? runtimeCwd
  const cliArgument = options.cliArgument ?? (runtimeCurrent
    ? join(runtimeCurrent, 'ops/n8n/node_modules/n8n/bin/n8n')
    : join(cwdPath, 'node_modules/n8n/bin/n8n'))
  const nodeArgument = options.nodeArgument ?? (nodeCurrent
    ? join(nodeCurrent, 'bin/node')
    : physicalNode)
  const nodePath = realpathSync(nodeArgument)
  const identity = (pathname: string) => {
    const value = statSync(pathname, { bigint: true })
    return { dev: `0x${value.dev.toString(16)}`, ino: value.ino.toString() }
  }
  const cwdIdentity = identity(runtimeCwd)
  const databaseIdentity = identity(database)
  const verifierDatabaseIdentity = identity(options.verifierDatabaseIdentityPath ?? database)
  const nodeIdentity = identity(nodePath)
  const toolsRoot = join(root, 'identity-tools')
  mkdirSync(toolsRoot, { recursive: true })
  const launchctl = join(toolsRoot, 'launchctl')
  const lsof = join(toolsRoot, 'lsof')
  const ps = join(toolsRoot, 'ps')
  writeFileSync(launchctl, `#!${process.execPath}\nprocess.stdout.write('state = running\\npid = ${launchPid}\\n')\n`)
  writeFileSync(lsof, `#!${process.execPath}
const args = process.argv.slice(2)
if (args.some(value => value.startsWith('-iTCP:'))) {
  process.stdout.write(${JSON.stringify(
    options.listenerPid === null ? '' : `${options.listenerPid ?? processPid}\n`,
  )})
} else if (args[args.indexOf('-p') + 1] === ${JSON.stringify(String(processPid))}) {
  process.stdout.write(${JSON.stringify([
    'fcwd', `D${cwdIdentity.dev}`, `i${cwdIdentity.ino}`, `n${cwdPath}`,
    'f12', `D${databaseIdentity.dev}`, `i${databaseIdentity.ino}`, `n${database}`,
    'ftxt', `D${nodeIdentity.dev}`, `i${nodeIdentity.ino}`, `n${nodePath}`, '',
  ].join('\n'))})
} else {
  process.stdout.write(${JSON.stringify([
    'f17', `D${verifierDatabaseIdentity.dev}`, `i${verifierDatabaseIdentity.ino}`,
    `n${database}`, '',
  ].join('\n'))})
}
`)
  writeFileSync(ps, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(
    `${launchPid} ${nodeArgument} ${cliArgument} start\n`,
  )})\n`)
  for (const command of [launchctl, lsof, ps]) chmodSync(command, 0o700)
  return {
    runtimeRoot,
    runtimeCwd,
    runtimeCurrent,
    nodeCurrent,
    physicalNode,
    cliArgument,
    nodeArgument,
    sourceManifest,
    runtimeManifest,
    packageDefinition,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      AIWORKER_TEST_N8N_IDENTITY: '1',
      AIWORKER_TEST_N8N_LAUNCHCTL: launchctl,
      AIWORKER_TEST_N8N_LSOF: lsof,
      AIWORKER_TEST_N8N_PS: ps,
    },
  }
}

function runVerifier(
  database: string,
  fixture?: IdentityFixture,
  extraEnv: Record<string, string | undefined> = {},
) {
  let activeFixture = fixture
  if (!activeFixture) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'n8n-runtime-identity-')))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    activeFixture = createIdentityFixture(root, database)
  }
  return spawnSync(process.execPath, [
    verifier,
    '--database', database,
    '--repository', projectRoot,
    '--expected-commit', projectCommit,
    '--module-root', projectRoot,
    '--pid', String(process.pid),
    '--port', '5678',
  ], { encoding: 'utf8', env: { ...activeFixture.env, ...extraEnv } })
}

async function waitForLine(child: ChildProcess, expected: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    let output = ''
    const timeout = setTimeout(() => reject(new Error('holder did not become ready')), 5_000)
    child.once('error', reject)
    child.stdout?.on('data', chunk => {
      output += chunk.toString()
      if (output.includes(expected)) {
        clearTimeout(timeout)
        resolvePromise()
      }
    })
  })
}

describe('n8n blue-green published workflow compatibility', () => {
  it('binds the baseline release identifier to the checked-out source commit', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'baseline-release-identity-')))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const deployScript = readFileSync(resolve(projectRoot, 'scripts/deploy-blue-green.sh'), 'utf8')
    const functionPrelude = deployScript.slice(0, deployScript.indexOf('\ncommand="${1:-}"'))
    const harness = join(root, 'release-identity-harness.sh')
    writeFileSync(harness, `${functionPrelude}
PROJECT_ROOT=${JSON.stringify(projectRoot)}
resolve_baseline_source_commit "$1"
`)
    chmodSync(harness, 0o700)

    const passed = spawnSync('bash', [harness, `${projectCommit.slice(0, 12)}-runtime`], {
      env: { ...process.env, NODE_BIN: process.execPath },
      encoding: 'utf8',
    })
    expect(passed.status).toBe(0)
    expect(passed.stdout.trim()).toBe(projectCommit)

    const rejected = spawnSync('bash', [harness, `${'f'.repeat(12)}-runtime`], {
      env: { ...process.env, NODE_BIN: process.execPath },
      encoding: 'utf8',
    })
    expect(rejected.status).not.toBe(0)
    expect(rejected.stderr).toContain('does not resolve to a Git commit')
  })

  it('accepts exactly the two active published slot-v1 workflows', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'n8n-workflow-compatible-')))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const database = join(root, 'database.sqlite')
    createWorkflowDatabase(database, currentWorkflows())

    const result = runVerifier(database)
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      schema: 'video-autoworker-n8n-workflow-compatibility/v2',
      protocol: 'slot-v1-execution-owner-v1',
      sourceCommit: projectCommit,
      databasePath: database,
      workflows: [
        { id: 'aiworker-task-intake-v1' },
        { id: 'aiworker-video-analysis-v1' },
      ],
    })
    expect(JSON.parse(result.stdout).runtimeIdentitySha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(JSON.parse(result.stdout).combinedSha256).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('accepts the real current-symlink argv shape while binding physical Node and release targets', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'n8n-real-current-argv-')))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const database = join(root, 'database.sqlite')
    createWorkflowDatabase(database, currentWorkflows())
    const fixture = createIdentityFixture(root, database, { realisticCurrent: true })
    const result = runVerifier(database, fixture)
    expect(result.status, result.stderr).toBe(0)
    expect(fixture.cliArgument).toContain('/n8n-service/current/')
    expect(fixture.nodeArgument).toContain('/node-service/current/')
    expect(JSON.parse(result.stdout).runtimeIdentitySha256).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('rejects current-symlink target drift and a CLI alias outside the managed service boundary', () => {
    const driftRoot = realpathSync(mkdtempSync(join(tmpdir(), 'n8n-current-target-drift-')))
    cleanup.push(() => rmSync(driftRoot, { recursive: true, force: true }))
    const driftDatabase = join(driftRoot, 'database.sqlite')
    createWorkflowDatabase(driftDatabase, currentWorkflows())
    const driftFixture = createIdentityFixture(driftRoot, driftDatabase, { realisticCurrent: true })
    const foreignRuntime = join(driftRoot, 'foreign-runtime')
    const foreignCli = join(foreignRuntime, 'ops/n8n/node_modules/n8n/bin/n8n')
    mkdirSync(resolve(foreignCli, '..'), { recursive: true })
    writeFileSync(foreignCli, '#!/usr/bin/env node\n')
    rmSync(driftFixture.runtimeCurrent!)
    symlinkSync(foreignRuntime, driftFixture.runtimeCurrent!)
    const drifted = runVerifier(driftDatabase, driftFixture)
    expect(drifted.status).not.toBe(0)
    expect(drifted.stderr).toContain('argv target does not match the physical release CLI')

    const boundaryRoot = realpathSync(mkdtempSync(join(tmpdir(), 'n8n-current-boundary-')))
    cleanup.push(() => rmSync(boundaryRoot, { recursive: true, force: true }))
    const boundaryDatabase = join(boundaryRoot, 'database.sqlite')
    createWorkflowDatabase(boundaryDatabase, currentWorkflows())
    const initialFixture = createIdentityFixture(boundaryRoot, boundaryDatabase, { realisticCurrent: true })
    const outsideAlias = join(boundaryRoot, 'outside-cli')
    symlinkSync(join(initialFixture.runtimeCwd, 'node_modules/n8n/bin/n8n'), outsideAlias)
    const boundaryFixture = createIdentityFixture(boundaryRoot, boundaryDatabase, {
      realisticCurrent: true,
      cliArgument: outsideAlias,
    })
    const escaped = runVerifier(boundaryDatabase, boundaryFixture)
    expect(escaped.status).not.toBe(0)
    expect(escaped.stderr).toContain('argv path is outside the managed runtime boundary')
  })

  it('rejects the real legacy workflow contract plus active and digest drift', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'n8n-workflow-drift-')))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const legacyDatabase = join(root, 'legacy.sqlite')
    const inactiveDatabase = join(root, 'inactive.sqlite')
    const digestDatabase = join(root, 'digest.sqlite')
    createWorkflowDatabase(legacyDatabase, legacyShapedWorkflows())
    createWorkflowDatabase(inactiveDatabase, currentWorkflows(), { active: false })
    createWorkflowDatabase(digestDatabase, currentWorkflows())
    const drift = new Database(digestDatabase)
    try {
      const workflow = currentWorkflows()[0]
      const nodes = structuredClone(workflow.nodes) as Array<Record<string, unknown>>
      nodes[0] = { ...nodes[0], name: 'Drifted Webhook' }
      drift.prepare('UPDATE workflow_history SET nodes = ? WHERE workflowId = ?')
        .run(JSON.stringify(nodes), workflow.id)
    } finally {
      drift.close()
    }

    const legacy = runVerifier(legacyDatabase)
    expect(legacy.status).not.toBe(0)
    expect(legacy.stderr).toContain('published content digest drifted')
    const inactive = runVerifier(inactiveDatabase)
    expect(inactive.status).not.toBe(0)
    expect(inactive.stderr).toContain('is not active and published')
    const digest = runVerifier(digestDatabase)
    expect(digest.status).not.toBe(0)
    expect(digest.stderr).toContain('published content digest drifted')
  })

  it('rejects a generic database-holding Node process even when file and listener output are spoofed', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'n8n-holder-spoof-')))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const database = join(root, 'database.sqlite')
    createWorkflowDatabase(database, currentWorkflows())
    const fixture = createIdentityFixture(root, database)
    const holderScript = join(root, 'hold-database.cjs')
    writeFileSync(holderScript, `
const Database = require(require.resolve('better-sqlite3', { paths: [${JSON.stringify(projectRoot)}] }))
const database = new Database(process.argv[2], { readonly: true, fileMustExist: true })
process.stdout.write('ready\\n')
const timer = setInterval(() => {}, 1000)
const close = () => { clearInterval(timer); database.close(); process.exit(0) }
process.on('SIGTERM', close)
process.on('SIGINT', close)
`)
    const holder = spawn(process.execPath, [holderScript, database], {
      cwd: fixture.runtimeCwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    cleanup.push(() => holder.kill('SIGTERM'))
    await waitForLine(holder, 'ready\n')
    const spoofed = createIdentityFixture(root, database, { processPid: holder.pid })
    const env = { ...spoofed.env }
    delete env.AIWORKER_TEST_N8N_PS
    const result = spawnSync(process.execPath, [
      verifier,
      '--database', database,
      '--repository', projectRoot,
      '--expected-commit', projectCommit,
      '--module-root', projectRoot,
      '--pid', String(holder.pid),
      '--port', '5678',
    ], { encoding: 'utf8', env })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('n8n PID is not the direct child of the LaunchAgent job')
  })

  it('rejects a missing or wrong 5678 listener', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'n8n-listener-identity-')))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const database = join(root, 'database.sqlite')
    createWorkflowDatabase(database, currentWorkflows())
    const fixture = createIdentityFixture(root, database, { listenerPid: process.pid + 1000 })
    const result = runVerifier(database, fixture)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('port 5678 listener does not match')

    const missingFixture = createIdentityFixture(root, database, { listenerPid: null })
    const missing = runVerifier(database, missingFixture)
    expect(missing.status).not.toBe(0)
    expect(missing.stderr).toContain('port 5678 listener does not match')
  })

  it('rejects database atomic replacement during verification', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'n8n-database-replace-')))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const database = join(root, 'database.sqlite')
    const replacement = join(root, 'replacement.sqlite')
    createWorkflowDatabase(database, currentWorkflows())
    createWorkflowDatabase(replacement, currentWorkflows())
    const fixture = createIdentityFixture(root, database)
    const replaceScript = join(root, 'replace-database')
    writeFileSync(replaceScript, `#!${process.execPath}
require('node:fs').renameSync(${JSON.stringify(replacement)}, ${JSON.stringify(database)})
`)
    chmodSync(replaceScript, 0o700)
    const result = runVerifier(database, fixture, {
      AIWORKER_TEST_N8N_AFTER_QUERY: replaceScript,
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('n8n database open file identity does not match')
  })

  it('rejects a database inode swap restored at the path after SQLite opens it', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'n8n-database-open-aba-')))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const database = join(root, 'database.sqlite')
    const replacement = join(root, 'replacement.sqlite')
    const original = join(root, 'original.sqlite')
    const displaced = join(root, 'displaced.sqlite')
    createWorkflowDatabase(database, currentWorkflows())
    createWorkflowDatabase(replacement, currentWorkflows())
    const fixture = createIdentityFixture(root, database, {
      verifierDatabaseIdentityPath: replacement,
    })
    const beforeOpen = join(root, 'swap-before-open')
    const afterOpen = join(root, 'restore-after-open')
    writeFileSync(beforeOpen, `#!${process.execPath}
const fs = require('node:fs')
fs.renameSync(${JSON.stringify(database)}, ${JSON.stringify(original)})
fs.renameSync(${JSON.stringify(replacement)}, ${JSON.stringify(database)})
`)
    writeFileSync(afterOpen, `#!${process.execPath}
const fs = require('node:fs')
fs.renameSync(${JSON.stringify(database)}, ${JSON.stringify(displaced)})
fs.renameSync(${JSON.stringify(original)}, ${JSON.stringify(database)})
`)
    chmodSync(beforeOpen, 0o700)
    chmodSync(afterOpen, 0o700)
    const result = runVerifier(database, fixture, {
      AIWORKER_TEST_N8N_BEFORE_DATABASE_OPEN: beforeOpen,
      AIWORKER_TEST_N8N_AFTER_DATABASE_OPEN: afterOpen,
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain(
      'workflow verifier SQLite handle does not match the preflight n8n database identity',
    )
  })

  it('rejects an otherwise valid runtime identity that drifts on the second capture', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'n8n-second-capture-drift-')))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const database = join(root, 'database.sqlite')
    createWorkflowDatabase(database, currentWorkflows())
    const fixture = createIdentityFixture(root, database)
    const driftScript = join(root, 'drift-runtime')
    writeFileSync(driftScript, `#!${process.execPath}
const fs = require('node:fs')
const value = new Date(Date.now() + 60_000)
fs.utimesSync(${JSON.stringify(fixture.runtimeRoot)}, value, value)
`)
    chmodSync(driftScript, 0o700)
    const result = runVerifier(database, fixture, {
      AIWORKER_TEST_N8N_AFTER_QUERY: driftScript,
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('n8n runtime identity drifted during workflow verification')
  })

  it('rejects source manifest, runtime manifest, package version and source drift', () => {
    const cases = [
      {
        mutate: (fixture: IdentityFixture) => writeFileSync(
          fixture.sourceManifest,
          readFileSync(fixture.sourceManifest, 'utf8').replace('n8n_version=2.31.6', 'n8n_version=2.31.5'),
        ),
        message: 'SOURCE_MANIFEST n8n_version drifted',
      },
      {
        mutate: (fixture: IdentityFixture) => writeFileSync(fixture.runtimeManifest, '0'.repeat(64)),
        message: 'RUNTIME_SOURCE_SHA256SUMS drifted',
      },
      {
        mutate: (fixture: IdentityFixture) => writeFileSync(
          fixture.packageDefinition, '{"name":"n8n","version":"2.31.5"}\n',
        ),
        message: 'n8n runtime version is not 2.31.6',
      },
      {
        mutate: (fixture: IdentityFixture) => writeFileSync(
          join(fixture.runtimeRoot, 'ops/n8n/workflows/aiworker-task-intake.json'), '{}\n',
        ),
        message: 'runtime source differs from the bound commit',
      },
    ]
    for (const [index, testCase] of cases.entries()) {
      const root = realpathSync(mkdtempSync(join(tmpdir(), `n8n-manifest-drift-${index}-`)))
      cleanup.push(() => rmSync(root, { recursive: true, force: true }))
      const database = join(root, 'database.sqlite')
      createWorkflowDatabase(database, currentWorkflows())
      const fixture = createIdentityFixture(root, database)
      testCase.mutate(fixture)
      const result = runVerifier(database, fixture)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain(testCase.message)
    }
  })

  it('rejects a symlink in the runtime ancestry', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'n8n-runtime-symlink-')))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const database = join(root, 'database.sqlite')
    createWorkflowDatabase(database, currentWorkflows())
    const fixture = createIdentityFixture(root, database)
    const linkedRoot = join(root, 'linked-parent')
    symlinkSync(root, linkedRoot)
    const linkedCwd = join(linkedRoot, projectCommit, 'ops/n8n')
    const linkedFixture = createIdentityFixture(root, database, { cwdPath: linkedCwd })
    const result = runVerifier(database, linkedFixture)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('path contains a symlink')
  })

  it('parses only the complete v3 blue-green baseline contract', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'blue-green-baseline-v3-')))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const runDir = join(root, 'run')
    const releasesDir = join(root, 'releases')
    const database = join(root, 'mission-control.db')
    const routerState = join(runDir, 'router-state.json')
    const baselinePath = join(runDir, 'baseline.json')
    const releaseId = `${projectCommit}-runtime`
    const releaseRoot = join(releasesDir, releaseId, 'standalone')
    mkdirSync(releaseRoot, { recursive: true })
    writeFileSync(database, 'db')
    mkdirSync(runDir, { recursive: true })
    writeFileSync(routerState, '{}')
    const manifest = 'a'.repeat(64)
    const baseline = {
      schema: 'video-autoworker-blue-green-baseline/v3',
      baselineSlot: 'blue',
      baselineReleaseId: releaseId,
      baselineReleaseRoot: releaseRoot,
      baselineManifestSha256: manifest,
      legacyReleaseId: 'legacy-runtime',
      legacyPid: 123,
      evidenceSha256: 'b'.repeat(64),
      dbPath: database,
      routerStatePath: routerState,
      n8nPid: 456,
      n8nDbPath: join(root, 'n8n.sqlite'),
      baselineSourceCommit: projectCommit,
      n8nWorkflowProtocol: 'slot-v1-execution-owner-v1',
      n8nWorkflowSourceCommit: projectCommit,
      n8nWorkflowDigest: 'c'.repeat(64),
      routerPort: 3017,
      completedAt: 1_788_105_600,
    }
    writeFileSync(baselinePath, JSON.stringify(baseline), { mode: 0o600 })
    const deployScript = readFileSync(resolve(projectRoot, 'scripts/deploy-blue-green.sh'), 'utf8')
    const functionPrelude = deployScript.slice(0, deployScript.indexOf('\ncommand="${1:-}"'))
    const harness = join(root, 'baseline-harness.sh')
    writeFileSync(harness, `${functionPrelude}
assert_release() { printf '%s\\n' "$2"; }
release_manifest_sha() { printf '${manifest}\\n'; }
assert_baseline
`)
    chmodSync(harness, 0o700)
    const env = {
      ...process.env,
      NODE_BIN: process.execPath,
      AIWORKER_BG_RUN_DIR: runDir,
      AIWORKER_BG_RELEASES_DIR: releasesDir,
      AIWORKER_BG_ROUTER_STATE: routerState,
      AIWORKER_BG_LIVE_DB_PATH: database,
      AIWORKER_BG_ROUTER_PORT: '3017',
    }
    const accepted = spawnSync('bash', [harness], { encoding: 'utf8', env })
    expect(accepted.status).toBe(0)
    expect(accepted.stdout).toContain(releaseId)
    writeFileSync(baselinePath, JSON.stringify({ ...baseline, schema: 'video-autoworker-blue-green-baseline/v2' }), {
      mode: 0o600,
    })
    const rejected = spawnSync('bash', [harness], { encoding: 'utf8', env })
    expect(rejected.status).not.toBe(0)
    expect(rejected.stderr).toContain('blue-green baseline is invalid')
  })

  it('parses an immutable v4 bootstrap pending identity and rejects retry drift', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'blue-green-pending-v4-')))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const markerPath = join(root, 'bootstrap.pending.json')
    const expectedPath = join(root, 'expected.json')
    const fileReference = (name: string, digest: string) => ({
      path: join(root, name),
      dev: '1',
      ino: '2',
      size: 1,
      sha256: digest,
    })
    const fullFileReference = (name: string, digest: string) => ({
      ...fileReference(name, digest),
      mtimeNs: '3',
      ctimeNs: '4',
      uid: process.getuid!(),
      mode: '400',
      nlink: 1,
    })
    const databaseIdentity = (name: string, ino: string) => ({
      path: join(root, name),
      dev: '1',
      ino,
    })
    const transitionClaim = fullFileReference('bootstrap-claim.json', '1'.repeat(64))
    const transition = {
      anchor: fullFileReference('n8n-workflow-transition-anchor.mjs', '2'.repeat(64)),
      intent: fullFileReference('upgrade-intent.json', '3'.repeat(64)),
      confirmation: fullFileReference('current-confirmation.json', '4'.repeat(64)),
      journal: { ...databaseIdentity('transition-journal', '6'), uid: process.getuid!(), mode: '700' },
      attestation: fullFileReference('transition-attestation.json', '5'.repeat(64)),
      claim: transitionClaim,
      upgradeId: '223e4567-e89b-42d3-a456-426614174000',
      committedJournalHeadSha256: '7'.repeat(64),
      liveCombinedSha256: '6'.repeat(64),
    }
    const pending = {
      schema: 'video-autoworker-blue-green-bootstrap-pending/v4',
      createdAt: 1_788_105_601,
      attemptId: '123e4567-e89b-12d3-a456-426614174000',
      slot: 'green',
      releaseId: `${projectCommit}-runtime`,
      releaseRoot: join(root, 'releases', `${projectCommit}-runtime`, 'standalone'),
      manifestSha256: 'a'.repeat(64),
      legacyReleaseId: 'legacy-runtime',
      legacyPid: 123,
      legacyCwd: join(root, 'legacy-runtime'),
      evidence: fileReference('evidence.json', 'b'.repeat(64)),
      evidenceObservedAt: 1_788_105_600,
      proof: fileReference('proof.json', 'c'.repeat(64)),
      transition,
      bootstrapClaim: transitionClaim,
      authorization: {
        prepare: fileReference('prepare.receipt.json', 'd'.repeat(64)),
        confirm: fileReference('current-confirm.receipt.json', 'e'.repeat(64)),
        shutdown: fileReference('shutdown-requested.receipt.json', 'f'.repeat(64)),
      },
      databases: {
        mission: databaseIdentity('mission-control.db', '3'),
        n8n: databaseIdentity('n8n.sqlite', '4'),
      },
      router: {
        port: 3017,
        runDirectory: databaseIdentity('run', '5'),
        statePath: join(root, 'router-state.json'),
      },
      n8n: {
        pid: 456,
        dbPath: join(root, 'n8n.sqlite'),
        workflowProtocol: 'slot-v1-execution-owner-v1',
        workflowSourceCommit: projectCommit,
        workflowDigest: '6'.repeat(64),
        workflowReport: fileReference('workflow-report.json', '8'.repeat(64)),
      },
      baselineSourceCommit: projectCommit,
    }
    writeFileSync(markerPath, JSON.stringify(pending), { mode: 0o400 })
    chmodSync(markerPath, 0o400)
    writeFileSync(expectedPath, JSON.stringify(pending), { mode: 0o600 })
    const deployScript = readFileSync(resolve(projectRoot, 'scripts/deploy-blue-green.sh'), 'utf8')
    const functionPrelude = deployScript.slice(0, deployScript.indexOf('\ncommand="${1:-}"'))
    const harness = join(root, 'pending-harness.sh')
    writeFileSync(harness, `${functionPrelude}
assert_bootstrap_pending_identity "$1" "$(cat "$2")"
`)
    chmodSync(harness, 0o700)
    const env = { ...process.env, NODE_BIN: process.execPath }
    expect(spawnSync('bash', [harness, markerPath, expectedPath], { env }).status).toBe(0)

    const alias = `${markerPath}.alias`
    linkSync(markerPath, alias)
    expect(spawnSync('bash', [harness, markerPath, expectedPath], { env }).status).not.toBe(0)
    rmSync(alias)
    chmodSync(markerPath, 0o600)
    expect(spawnSync('bash', [harness, markerPath, expectedPath], { env }).status).not.toBe(0)
    chmodSync(markerPath, 0o400)

    const refreshed = {
      ...pending,
      evidence: fileReference('evidence.json', '7'.repeat(64)),
      evidenceObservedAt: pending.evidenceObservedAt + 30,
    }
    writeFileSync(expectedPath, JSON.stringify(refreshed), { mode: 0o600 })
    expect(spawnSync('bash', [harness, markerPath, expectedPath], { env }).status).not.toBe(0)

    writeFileSync(expectedPath, JSON.stringify({
      ...pending,
      n8n: { ...pending.n8n, pid: 999 },
    }), { mode: 0o600 })
    const drifted = spawnSync('bash', [harness, markerPath, expectedPath], {
      encoding: 'utf8', env,
    })
    expect(drifted.status).not.toBe(0)
    expect(drifted.stderr).toContain('pending runtime identity')
  })

  it('documents the bootstrap boundary as a read-only workflow gate', () => {
    const deployScript = readFileSync(resolve(projectRoot, 'scripts/deploy-blue-green.sh'), 'utf8')
    expect(deployScript).toContain('must already be active, published from the workflow files')
    expect(deployScript).toContain('it never imports workflows, restarts n8n')
    expect(deployScript).not.toContain('n8n-import-workflows.sh')
    expect(deployScript).not.toContain('n8n-stop.sh')
    expect(deployScript).not.toContain('n8n-start.sh')
  })
})
