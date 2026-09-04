import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'

const repositoryRoot = process.cwd()
const verifierPath = resolve(repositoryRoot, 'scripts/verify-shared-runtime-install-gate.mjs')
const offlineQueueHelperPath = resolve(
  repositoryRoot, 'scripts/lib/runtime-safe-offline-queue.mjs',
)
const expectedSourceCommit = 'a'.repeat(40)
const expectedReleaseId = `${expectedSourceCommit}-runtime`
const digest = 'b'.repeat(64)

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function fileReference(path: string, ino = '10') {
  return { path, dev: '1', ino, size: 1, sha256: digest }
}

function directoryReference(path: string, ino = '20') {
  return { path, dev: '1', ino }
}

async function writeRuntimeBatchArtifacts(batchRoot: string, status = 'succeeded') {
  const markerPath = resolve(batchRoot, '.worker-launch.lock')
  const createdAt = new Date().toISOString()
  const token = 'c'.repeat(64)
  const markerSource = `${JSON.stringify({
    schema: 'video-autoworker-worker-launch-guardian/v2',
    pid: process.pid,
    createdAt,
    token,
  })}\n`
  await writeFile(markerPath, markerSource, { mode: 0o600 })
  const marker = await stat(markerPath, { bigint: true })
  await writeFile(resolve(batchRoot, '.worker-launch.lock.owner'), `${JSON.stringify({
    schema: 'video-autoworker-worker-launch-guardian-owner/v1',
    pid: process.pid,
    createdAt: new Date().toISOString(),
    marker: {
      path: markerPath,
      dev: marker.dev.toString(),
      ino: marker.ino.toString(),
      tokenSha256: sha256(token),
      createdAt,
      sourceSha256: sha256(markerSource),
    },
  })}\n`, { mode: 0o600 })

  const history = resolve(batchRoot, '2026-08-27-retest')
  await mkdir(history, { mode: 0o700 })
  const stateName = `${'d'.repeat(64)}.json`
  const stateSource = `${JSON.stringify({
    schemaVersion: 2,
    batchId: 'terminal-history',
    status,
    items: [{ taskId: 'terminal-task', status }],
  })}\n`
  await writeFile(resolve(history, stateName), stateSource, { mode: 0o600 })
  await writeFile(resolve(history, `${stateName}.bak`), stateSource, { mode: 0o600 })
}

async function createDatabase(root: string) {
  const missionPath = resolve(root, 'mission-control.db')
  const mission = new Database(missionPath)
  mission.exec(`
    CREATE TABLE n8n_intake_controls (
      control_id INTEGER PRIMARY KEY,
      accepting INTEGER NOT NULL,
      revision INTEGER NOT NULL
    );
    INSERT INTO n8n_intake_controls VALUES (1, 0, 7);
    CREATE TABLE n8n_task_runs (
      id INTEGER PRIMARY KEY,
      task_id TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE n8n_director_evidence_outbox (status TEXT NOT NULL);
  `)
  mission.close()
  await chmod(missionPath, 0o600)
  const n8nPath = resolve(root, 'n8n.sqlite')
  const n8n = new Database(n8nPath)
  n8n.exec(`
    CREATE TABLE execution_entity (
      id INTEGER PRIMARY KEY,
      status TEXT NOT NULL,
      "stoppedAt" INTEGER
    );
  `)
  n8n.close()
  await chmod(n8nPath, 0o600)
  const videoBatchRoot = resolve(root, 'video-batches')
  await mkdir(videoBatchRoot, { mode: 0o700 })
  return {
    missionControlDbPath: await realpath(missionPath),
    n8nDbPath: await realpath(n8nPath),
    videoBatchRoot: await realpath(videoBatchRoot),
    expectedSourceCommit,
    expectedReleaseId,
  }
}

async function createN8nDatabase(root: string, name = 'n8n.sqlite') {
  const pathname = resolve(root, name)
  const database = new Database(pathname)
  database.exec(`
    CREATE TABLE execution_entity (
      id INTEGER PRIMARY KEY,
      status TEXT NOT NULL,
      "stoppedAt" INTEGER
    );
  `)
  database.close()
  await chmod(pathname, 0o600)
  return await realpath(pathname)
}

async function createLegacyFixture(root: string) {
  const missionPath = resolve(root, 'mission-control.db')
  const mission = new Database(missionPath)
  mission.exec(`
    CREATE TABLE n8n_task_runs (
      id INTEGER PRIMARY KEY,
      task_id TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
  mission.close()
  await chmod(missionPath, 0o600)
  const missionControlDbPath = await realpath(missionPath)
  const missionIdentity = await stat(missionControlDbPath, { bigint: true })
  const n8nDbPath = await createN8nDatabase(root)
  const n8nIdentity = await stat(n8nDbPath, { bigint: true })
  const videoBatchRoot = resolve(root, 'video-batches')
  await mkdir(videoBatchRoot, { mode: 0o700 })
  return {
    input: {
      missionControlDbPath,
      n8nDbPath,
      legacyPreinstallAttemptDir: resolve(root, 'attempt'),
      videoBatchRoot: await realpath(videoBatchRoot),
      expectedSourceCommit,
      expectedReleaseId,
    },
    status: legacyStatus({
      bindings: {
        databases: {
          mission: {
            path: missionControlDbPath,
            dev: missionIdentity.dev.toString(),
            ino: missionIdentity.ino.toString(),
          },
          n8n: {
            path: n8nDbPath,
            dev: n8nIdentity.dev.toString(),
            ino: n8nIdentity.ino.toString(),
          },
        },
      },
    }),
  }
}

async function verifier() {
  return await import(/* @vite-ignore */ `${pathToFileURL(verifierPath).href}?t=${Date.now()}`) as {
    validateLegacyPreinstallStatus: (
      status: unknown,
      commit: string,
      releaseId: string,
      operation?: 'install' | 'rollback',
      component?: 'task-flow' | 'video-command' | 'director-brain' | '',
    ) => {
      bindings: Record<string, unknown>
      operation: 'install' | 'rollback'
      component: 'task-flow' | 'video-command' | 'director-brain'
      identity: string
    }
    verifySharedRuntimeInstallGate: (input: {
      missionControlDbPath: string
      n8nDbPath: string
      deploymentRunDir?: string
      legacyPreinstallAttemptDir?: string
      videoBatchRoot: string
      expectedSourceCommit: string
      expectedReleaseId: string
      operation?: 'install' | 'rollback'
      component?: 'task-flow' | 'video-command' | 'director-brain' | ''
      rawResultOutput?: string
      targetStateSha256?: string
      phase?: 'component' | 'final'
    }, dependencies?: {
      verifyLegacyPreinstall?: (
        attempt: string,
        commit: string,
        releaseId: string,
        operation: 'install' | 'rollback',
      ) => Record<string, unknown>
      reserveLegacyPreinstall?: (...args: any[]) => Record<string, unknown>
      verifyRollingRuntimeBinding?: (input: Record<string, unknown>) => Record<string, unknown>
    }) => {
      schema: string
      mode: string
      sourceCommit: string
      targetReleaseId: string
      intakeRevision: number | null
      activeTasks: number
      activeMediaNodes: number
      activeN8nExecutions: number
      waiting: number
      running: number
      attentionStale: number
      pendingOutbox: number
      reservation?: Record<string, unknown>
      runtimeBinding?: Record<string, unknown>
    }
    verifyRollingRuntimeBinding: (input: {
      deploymentRunDir: string
      missionIdentity: { path: string, dev: string, ino: string }
      n8nIdentity: { path: string, dev: string, ino: string }
      videoBatchRoot: string
      sourceRepositoryRoot: string
    }, dependencies: {
      canonicalHome: string
      lsof: string
      listenerPids: (port: number) => number[]
      openPaths: (pid: number, descriptor?: string) => string[]
      processAlive: (pid: number) => boolean
    }) => Record<string, unknown>
  }
}

async function createRollingRuntimeFixture(root: string) {
  const physicalRoot = await realpath(root)
  await mkdir(resolve(physicalRoot, 'repository'), { mode: 0o700 })
  const sourceRepositoryRoot = await realpath(resolve(physicalRoot, 'repository'))
  const deploymentRunDir = resolve(sourceRepositoryRoot, '.run/blue-green')
  const slots = resolve(deploymentRunDir, 'slots')
  const canonicalHome = resolve(physicalRoot, 'home')
  const videoBatchRoot = resolve(canonicalHome, 'ai-worker/state/video-autoworker/video-batches')
  const releaseRoot = resolve(sourceRepositoryRoot, '.runtime/releases/active-release/standalone')
  await mkdir(slots, { recursive: true, mode: 0o700 })
  await chmod(deploymentRunDir, 0o700)
  await mkdir(videoBatchRoot, { recursive: true, mode: 0o700 })
  await mkdir(releaseRoot, { recursive: true, mode: 0o700 })
  await mkdir(resolve(sourceRepositoryRoot, 'scripts'), { mode: 0o700 })
  await writeFile(resolve(sourceRepositoryRoot, 'scripts/check-standalone-artifact.mjs'), '', {
    mode: 0o600,
  })
  const missionPath = resolve(physicalRoot, 'mission-control.db')
  const n8nPath = resolve(physicalRoot, 'n8n.sqlite')
  await writeFile(missionPath, 'mission\n', { mode: 0o600 })
  await writeFile(n8nPath, 'n8n\n', { mode: 0o600 })
  const mission = await stat(missionPath, { bigint: true })
  const n8n = await stat(n8nPath, { bigint: true })
  const missionIdentity = {
    path: await realpath(missionPath), dev: mission.dev.toString(), ino: mission.ino.toString(),
  }
  const n8nIdentity = {
    path: await realpath(n8nPath), dev: n8n.dev.toString(), ino: n8n.ino.toString(),
  }
  const statePath = resolve(deploymentRunDir, 'router-state.json')
  const manifestSource = '{"fixture":true}\n'
  await writeFile(resolve(releaseRoot, 'release-manifest.json'), manifestSource, { mode: 0o600 })
  const manifestSha256 = sha256(manifestSource)
  const releaseId = 'active-release'
  await writeFile(statePath, `${JSON.stringify({
    schema: 'video-autoworker-standalone-router/v1',
    generation: 4,
    active: 'blue',
    previous: null,
    updatedAt: new Date().toISOString(),
    slots: {
      blue: { host: '127.0.0.1', port: 3317, releaseId },
      green: { host: '127.0.0.1', port: 3417, releaseId: 'unbound-green' },
    },
  })}\n`, { mode: 0o600 })
  await writeFile(resolve(deploymentRunDir, 'router.runtime.json'), `${JSON.stringify({
    schema: 'video-autoworker-standalone-router-runtime/v1',
    pid: 101,
    host: '127.0.0.1',
    port: 3017,
    stateFile: statePath,
    startedAt: 1,
  })}\n`, { mode: 0o600 })
  await writeFile(resolve(slots, 'blue.json'), `${JSON.stringify({
    schema: 'video-autoworker-standalone-slot/v1',
    slot: 'blue', releaseId, releaseRoot, manifestSha256,
    host: '127.0.0.1', port: 3317,
  })}\n`, { mode: 0o600 })
  await writeFile(resolve(slots, 'blue.runtime.json'), `${JSON.stringify({
    schema: 'video-autoworker-standalone-runtime/v1',
    pid: 102, slot: 'blue', role: 'active', releaseId, manifestSha256,
    host: '127.0.0.1', port: 3317, dbPath: missionIdentity.path,
    routerStatePath: statePath, createdAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 })
  await writeFile(resolve(slots, 'blue.pid'), '102\n', { mode: 0o600 })
  const listeners = new Map([[3017, [101]], [3317, [102]], [3417, []], [5678, [103]]])
  const alive = new Set([101, 102, 103])
  const processPaths = new Map([
    ['101:cwd', [sourceRepositoryRoot]],
    ['102:cwd', [releaseRoot]],
    ['102:', [missionIdentity.path]],
    ['103:', [n8nIdentity.path]],
  ])
  const openPaths = (pid: number, descriptor = '') => processPaths.get(`${pid}:${descriptor}`) || []
  return {
    input: {
      deploymentRunDir,
      missionIdentity,
      n8nIdentity,
      videoBatchRoot,
      sourceRepositoryRoot,
    },
    dependencies: {
      canonicalHome,
      lsof: '/usr/sbin/lsof',
      listenerPids: (port: number) => listeners.get(port) || [],
      openPaths,
      processAlive: (pid: number) => alive.has(pid),
    },
    listeners,
    alive,
    missionIdentity,
    n8nIdentity,
    videoBatchRoot,
    deploymentRunDir,
    statePath,
    slots,
    processPaths,
    manifestSha256,
  }
}

function legacyStatus(overrides: Record<string, unknown> = {}) {
  const base = {
    phase: 'INSTALL_PREPARED',
    expired: false,
    terminal: null,
    finalize: null,
    verification: null,
    reservation: null,
    prepared: fileReference('/private/prepared.json', '30'),
    installAttemptId: '33333333-3333-4333-8333-333333333333',
    revision: 1,
    components: {
      installed: [],
      rolledBack: [],
      journalHead: null,
    },
    bindings: {
      sourceCommit: expectedSourceCommit,
      target: {
        slot: 'green',
        releaseId: expectedReleaseId,
        releaseRoot: '/private/runtime',
        manifestSha256: digest,
      },
      evidence: fileReference('/private/evidence.json', '31'),
      proof: fileReference('/private/proof.json', '32'),
      evidenceObservedAt: 1,
      guard: {
        expiresAt: 2,
        guardNonceSha256: digest,
        legacyBindingSha256: digest,
        sha256: digest,
      },
      runtimeSnapshotSha256: digest,
      transition: {
        anchor: fileReference('/private/anchor.mjs', '33'),
        intent: fileReference('/private/intent.json', '34'),
        confirmation: fileReference('/private/confirmation.json', '35'),
        journal: directoryReference('/private/journal', '36'),
        attestation: fileReference('/private/attestation.json', '37'),
        upgradeId: 'upgrade-1',
        committedJournalHeadSha256: digest,
        liveCombinedSha256: digest,
      },
      databases: {
        mission: { path: '/private/mission.db', dev: '1', ino: '2' },
        n8n: { path: '/private/n8n.db', dev: '1', ino: '3' },
      },
    },
  }
  const bindingOverrides = (overrides.bindings || {}) as Record<string, unknown>
  const componentOverrides = (overrides.components || {}) as Record<string, unknown>
  return {
    ...base,
    ...overrides,
    components: { ...base.components, ...componentOverrides },
    bindings: {
      ...base.bindings,
      ...bindingOverrides,
      target: {
        ...base.bindings.target,
        ...((bindingOverrides.target || {}) as Record<string, unknown>),
      },
      databases: {
        ...base.bindings.databases,
        ...((bindingOverrides.databases || {}) as Record<string, unknown>),
      },
      transition: {
        ...base.bindings.transition,
        ...((bindingOverrides.transition || {}) as Record<string, unknown>),
      },
    },
  }
}

describe('shared runtime installation gate', () => {
  it('binds a reservation to the invoking installer shell rather than its orchestrator', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'shared-runtime-owner-binding-'))
    try {
      const wrapper = resolve(root, 'installer-wrapper.sh')
      await writeFile(wrapper, `#!/bin/bash\ninstaller_pid=$$\ngate_parent="$($1 -p 'String(process.ppid)')"\nprintf '%s\\t%s\\n' "$installer_pid" "$gate_parent"\n`, { mode: 0o700 })
      await chmod(wrapper, 0o700)
      const observed = spawnSync('/bin/bash', [wrapper, process.execPath], { encoding: 'utf8' })
      expect(observed.status, observed.stderr).toBe(0)
      const [installerPid, gateParentPid] = observed.stdout.trim().split('\t')
      expect(gateParentPid).toBe(installerPid)
      expect(installerPid).not.toBe(String(process.pid))
      const source = await readFile(verifierPath, 'utf8')
      expect(source).toContain('const installerPid = process.ppid')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('accepts a fresh fully-bound PREPARED attempt but rejects expiry and another target', async () => {
    const { validateLegacyPreinstallStatus } = await verifier()
    expect(validateLegacyPreinstallStatus(
      legacyStatus(), expectedSourceCommit, expectedReleaseId,
    )).toMatchObject({
      operation: 'install',
      component: 'task-flow',
      bindings: {
        sourceCommit: expectedSourceCommit,
        target: { releaseId: expectedReleaseId },
      },
    })
    expect(() => validateLegacyPreinstallStatus(
      legacyStatus({ expired: true }), expectedSourceCommit, expectedReleaseId,
    )).toThrow(/legacy_preinstall_lease_not_current/u)
    expect(() => validateLegacyPreinstallStatus(
      legacyStatus(), 'b'.repeat(40), `${'b'.repeat(40)}-runtime`,
    )).toThrow(/legacy_preinstall_target_binding_mismatch/u)
  })

  it('authorizes only the next install component in a fresh PREPARED journal', async () => {
    const { validateLegacyPreinstallStatus } = await verifier()
    const afterTaskFlow = legacyStatus({
      components: {
        installed: ['task-flow'],
        journalHead: fileReference('/private/component-1.json', '40'),
      },
    })
    expect(validateLegacyPreinstallStatus(
      afterTaskFlow, expectedSourceCommit, expectedReleaseId, 'install', 'video-command',
    )).toMatchObject({ operation: 'install', component: 'video-command' })
    expect(() => validateLegacyPreinstallStatus(
      afterTaskFlow, expectedSourceCommit, expectedReleaseId, 'install', 'director-brain',
    )).toThrow(/legacy_preinstall_component_order_invalid/u)
  })

  it.each([
    [['task-flow'], 'task-flow'],
    [['task-flow', 'video-command'], 'video-command'],
    [['task-flow', 'video-command', 'director-brain'], 'director-brain'],
  ])('authorizes pre-verify compensation for %s from its last installed component', async (
    installed,
    expectedComponent,
  ) => {
    const { validateLegacyPreinstallStatus } = await verifier()
    const prepared = legacyStatus({
      phase: 'INSTALL_PREPARED',
      expired: true,
      components: {
        installed,
        rolledBack: [],
        journalHead: fileReference('/private/preverify-component.json', '46'),
      },
    })
    expect(validateLegacyPreinstallStatus(
      prepared,
      expectedSourceCommit,
      expectedReleaseId,
      'rollback',
      expectedComponent as 'task-flow' | 'video-command' | 'director-brain',
    )).toMatchObject({ operation: 'rollback', component: expectedComponent })
  })

  it('rejects an empty or out-of-order pre-verify compensation journal', async () => {
    const { validateLegacyPreinstallStatus } = await verifier()
    expect(() => validateLegacyPreinstallStatus(
      legacyStatus({ expired: true }),
      expectedSourceCommit,
      expectedReleaseId,
      'rollback',
      'task-flow',
    )).toThrow(/legacy_preinstall_rollback_not_authorized/u)

    const twoInstalled = legacyStatus({
      expired: true,
      components: {
        installed: ['task-flow', 'video-command'],
        journalHead: fileReference('/private/preverify-component.json', '46'),
      },
    })
    expect(() => validateLegacyPreinstallStatus(
      twoInstalled,
      expectedSourceCommit,
      expectedReleaseId,
      'rollback',
      'task-flow',
    )).toThrow(/legacy_preinstall_component_order_invalid/u)
    expect(() => validateLegacyPreinstallStatus(
      twoInstalled,
      expectedSourceCommit,
      expectedReleaseId,
      'rollback',
      'director-brain',
    )).toThrow(/legacy_preinstall_component_order_invalid/u)
  })

  it('keeps expired rollback compensation open in strict reverse component order', async () => {
    const { validateLegacyPreinstallStatus } = await verifier()
    const installed = ['task-flow', 'video-command', 'director-brain']
    const verified = legacyStatus({
      phase: 'INSTALL_VERIFIED',
      expired: true,
      verification: fileReference('/private/verified.json', '41'),
      components: {
        installed,
        journalHead: fileReference('/private/component-3.json', '42'),
      },
    })
    expect(validateLegacyPreinstallStatus(
      verified, expectedSourceCommit, expectedReleaseId, 'rollback', 'director-brain',
    )).toMatchObject({ operation: 'rollback', component: 'director-brain' })
    expect(() => validateLegacyPreinstallStatus(
      verified, expectedSourceCommit, expectedReleaseId, 'rollback', 'video-command',
    )).toThrow(/legacy_preinstall_component_order_invalid/u)

    const firstCompensated = legacyStatus({
      phase: 'INSTALL_ROLLBACK_PENDING',
      expired: true,
      verification: fileReference('/private/verified.json', '41'),
      finalize: fileReference('/private/finalize.json', '43'),
      components: {
        installed,
        rolledBack: ['director-brain'],
        journalHead: fileReference('/private/component-4.json', '44'),
      },
    })
    expect(validateLegacyPreinstallStatus(
      firstCompensated, expectedSourceCommit, expectedReleaseId, 'rollback', 'video-command',
    )).toMatchObject({ component: 'video-command' })
  })

  it.each([
    ['handoff', 'BOOTSTRAP_HANDOFF'],
    ['abandoned', 'INSTALL_ABANDONED'],
  ])('rejects a terminal %s attempt', async (_name, phase) => {
    const { validateLegacyPreinstallStatus } = await verifier()
    expect(() => validateLegacyPreinstallStatus(
      legacyStatus({
        phase,
        expired: true,
        terminal: fileReference('/private/terminal.json', '45'),
        verification: fileReference('/private/verified.json', '41'),
        finalize: fileReference('/private/finalize.json', '43'),
        components: {
          installed: ['task-flow', 'video-command', 'director-brain'],
          journalHead: fileReference('/private/component-3.json', '42'),
        },
      }),
      expectedSourceCommit,
      expectedReleaseId,
      'rollback',
      'director-brain',
    )).toThrow(/legacy_preinstall_attempt_not_authorizable/u)
  })

  it('loads from a standalone closure that contains no legacy controller', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'shared-runtime-install-gate-standalone-'))
    try {
      const standaloneScripts = resolve(root, 'standalone/scripts')
      const standaloneLib = resolve(standaloneScripts, 'lib')
      await mkdir(standaloneLib, { recursive: true })
      const copiedGate = resolve(standaloneScripts, 'verify-shared-runtime-install-gate.mjs')
      const copiedHelper = resolve(standaloneLib, 'runtime-safe-offline-queue.mjs')
      await Promise.all([
        copyFile(verifierPath, copiedGate),
        copyFile(offlineQueueHelperPath, copiedHelper),
      ])

      const gateSource = await readFile(copiedGate, 'utf8')
      const helperSource = await readFile(copiedHelper, 'utf8')
      expect(gateSource).not.toMatch(
        /(?:from\s+|import\s*\()[^\n]*legacy-bootstrap-controller\.mjs/u,
      )
      expect(helperSource).not.toMatch(
        /legacy-bootstrap-controller|generate-legacy-freeze-evidence|n8n-workflow-transition-anchor|verify-n8n-blue-green-workflows|\/Users\/|\/home\//u,
      )
      const imported = spawnSync(process.execPath, [
        '--input-type=module',
        '--eval',
        `const loaded = await import(${JSON.stringify(pathToFileURL(copiedGate).href)});`
          + `if (typeof loaded.verifySharedRuntimeInstallGate !== 'function') process.exit(2)`,
      ], { encoding: 'utf8' })
      expect(imported.status, imported.stderr).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('accepts only a paused, idle Mission Control database with an empty director outbox', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'shared-runtime-install-gate-'))
    try {
      const fixture = await createDatabase(root)
      const { verifySharedRuntimeInstallGate } = await verifier()
      expect(verifySharedRuntimeInstallGate(fixture)).toEqual({
        schema: 'video-autoworker-shared-runtime-install-gate/v1',
        mode: 'rolling',
        sourceCommit: expectedSourceCommit,
        targetReleaseId: expectedReleaseId,
        intakeRevision: 7,
        activeTasks: 0,
        activeMediaNodes: 0,
        activeN8nExecutions: 0,
        waiting: 0,
        running: 0,
        attentionStale: 0,
        pendingOutbox: 0,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('ignores a verified runtime guardian pair and paired terminal history but rejects an active primary', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'shared-runtime-install-gate-runtime-root-'))
    try {
      const fixture = await createDatabase(root)
      await writeRuntimeBatchArtifacts(fixture.videoBatchRoot)
      const { verifySharedRuntimeInstallGate } = await verifier()
      expect(verifySharedRuntimeInstallGate(fixture)).toMatchObject({
        mode: 'rolling',
        activeTasks: 0,
        waiting: 0,
        running: 0,
      })

      const history = resolve(fixture.videoBatchRoot, '2026-08-27-retest')
      const stateName = `${'d'.repeat(64)}.json`
      const activeSource = `${JSON.stringify({
        schemaVersion: 2,
        batchId: 'terminal-history',
        status: 'running',
        items: [{ taskId: 'terminal-task', status: 'running' }],
      })}\n`
      await writeFile(resolve(history, stateName), activeSource)
      expect(() => verifySharedRuntimeInstallGate(fixture)).toThrow(/video_batch_root_unsafe/u)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('requires a live managed legacy attempt when the rolling tables do not exist', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'shared-runtime-install-gate-legacy-required-'))
    try {
      const liveDbPath = resolve(root, 'mission-control.db')
      const database = new Database(liveDbPath)
      database.exec(`
        CREATE TABLE n8n_task_runs (
          id INTEGER PRIMARY KEY,
          task_id TEXT NOT NULL,
          source TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO n8n_task_runs VALUES (1, 'stale-task', 'openclaw', 'accepted', 1, 1);
      `)
      database.close()
      await chmod(liveDbPath, 0o600)
      const physical = await realpath(liveDbPath)
      const n8nDbPath = await createN8nDatabase(root)
      const videoBatchRoot = resolve(root, 'video-batches')
      await mkdir(videoBatchRoot, { mode: 0o700 })
      const physicalVideoBatchRoot = await realpath(videoBatchRoot)
      const { verifySharedRuntimeInstallGate } = await verifier()
      expect(() => verifySharedRuntimeInstallGate({
        missionControlDbPath: physical,
        n8nDbPath,
        videoBatchRoot: physicalVideoBatchRoot,
        expectedSourceCommit,
        expectedReleaseId,
      }))
        .toThrow(/legacy_preinstall_attempt_required/u)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('projects an old row without durable state to attention in rolling mode', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'shared-runtime-install-gate-stale-'))
    try {
      const fixture = await createDatabase(root)
      const database = new Database(fixture.missionControlDbPath)
      database.exec("INSERT INTO n8n_task_runs VALUES (1, 'stale-task', 'openclaw', 'accepted', 1, 1)")
      database.close()
      const { verifySharedRuntimeInstallGate } = await verifier()
      expect(verifySharedRuntimeInstallGate(fixture)).toMatchObject({
        mode: 'rolling',
        activeTasks: 0,
        waiting: 0,
        running: 0,
        attentionStale: 1,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps an old row active when a durable batch still owns it', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'shared-runtime-install-gate-durable-'))
    try {
      const fixture = await createDatabase(root)
      const database = new Database(fixture.missionControlDbPath)
      database.exec("INSERT INTO n8n_task_runs VALUES (1, 'durable-task', 'openclaw', 'accepted', 1, 1)")
      database.close()
      const statePath = resolve(fixture.videoBatchRoot, `${'a'.repeat(64)}.json`)
      await writeFile(statePath, `${JSON.stringify({
        schemaVersion: 1,
        batchId: 'durable-batch',
        status: 'running',
        items: [{ taskId: 'durable-task', status: 'accepted' }],
      })}\n`, { mode: 0o600 })
      const { verifySharedRuntimeInstallGate } = await verifier()
      expect(() => verifySharedRuntimeInstallGate(fixture))
        .toThrow(/active_tasks_present/u)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('accepts a legacy stale row only through a database-bound managed attempt verifier', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'shared-runtime-install-gate-legacy-'))
    try {
      const liveDbPath = resolve(root, 'mission-control.db')
      const database = new Database(liveDbPath)
      database.exec(`
        CREATE TABLE n8n_task_runs (
          id INTEGER PRIMARY KEY,
          task_id TEXT NOT NULL,
          source TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO n8n_task_runs VALUES (1, 'stale-task', 'openclaw', 'accepted', 1, 1);
      `)
      database.close()
      await chmod(liveDbPath, 0o600)
      const physical = await realpath(liveDbPath)
      const identity = await stat(physical, { bigint: true })
      const n8nDbPath = await createN8nDatabase(root)
      const n8nIdentity = await stat(n8nDbPath, { bigint: true })
      const attempt = resolve(root, 'bootstrap-attempt')
      const videoBatchRoot = resolve(root, 'video-batches')
      await mkdir(videoBatchRoot, { mode: 0o700 })
      const physicalVideoBatchRoot = await realpath(videoBatchRoot)
      const { verifySharedRuntimeInstallGate } = await verifier()
      const status = legacyStatus({
        bindings: {
          databases: {
            mission: {
              path: physical,
              dev: identity.dev.toString(),
              ino: identity.ino.toString(),
            },
            n8n: {
              path: n8nDbPath,
              dev: n8nIdentity.dev.toString(),
              ino: n8nIdentity.ino.toString(),
            },
          },
        },
      })
      expect(verifySharedRuntimeInstallGate(
        {
          missionControlDbPath: physical,
          n8nDbPath,
          legacyPreinstallAttemptDir: attempt,
          videoBatchRoot: physicalVideoBatchRoot,
          expectedSourceCommit,
          expectedReleaseId,
          rawResultOutput: resolve(root, 'task-flow.apply.raw.json'),
        },
        {
          verifyLegacyPreinstall: () => status,
          reserveLegacyPreinstall: () => fileReference('/private/component-reservation.json', '99'),
        },
      )).toEqual({
        schema: 'video-autoworker-shared-runtime-install-gate/v1',
        mode: 'legacy-preinstall',
        sourceCommit: expectedSourceCommit,
        targetReleaseId: expectedReleaseId,
        intakeRevision: null,
        activeTasks: 0,
        activeMediaNodes: 0,
        activeN8nExecutions: 0,
        waiting: 0,
        running: 0,
        attentionStale: 1,
        pendingOutbox: 0,
        reservation: fileReference('/private/component-reservation.json', '99'),
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('creates one component reservation only after two stable status and idle reads', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'shared-runtime-install-reservation-'))
    try {
      const fixture = await createLegacyFixture(root)
      const rawResultOutput = resolve(root, 'task-flow.apply.raw.json')
      const targetStateSha256 = 'a'.repeat(64)
      let reads = 0
      let reserves = 0
      const reservation = fileReference('/private/component-reservation.json', '101')
      const { verifySharedRuntimeInstallGate } = await verifier()
      const result = verifySharedRuntimeInstallGate({
        ...fixture.input, rawResultOutput, targetStateSha256, component: 'task-flow',
      }, {
        verifyLegacyPreinstall: () => { reads += 1; return fixture.status },
        reserveLegacyPreinstall: (attempt, authorization, output, targetStateSha256, snapshot) => {
          reserves += 1
          expect(attempt).toBe(fixture.input.legacyPreinstallAttemptDir)
          expect(authorization.component).toBe('task-flow')
          expect(output).toBe(rawResultOutput)
          expect(targetStateSha256).toBe('a'.repeat(64))
          expect(snapshot).toMatchObject({ mediaActive: 0, n8nActive: 0 })
          return reservation
        },
      })
      expect(reads).toBe(2)
      expect(reserves).toBe(1)
      expect(result.reservation).toEqual(reservation)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('issues a final-gate receipt only for a fresh verified idle binding', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'shared-runtime-final-gate-'))
    try {
      const fixture = await createLegacyFixture(root)
      const verifiedStatus = legacyStatus({
        ...fixture.status,
        phase: 'INSTALL_VERIFIED',
        verification: fileReference('/private/verified.json', '102'),
        components: {
          installed: ['task-flow', 'video-command', 'director-brain'],
          rolledBack: [],
          journalHead: fileReference('/private/component-event.json', '103'),
        },
      })
      let reads = 0
      const { verifySharedRuntimeInstallGate } = await verifier()
      const result = verifySharedRuntimeInstallGate({
        ...fixture.input, phase: 'final',
      }, { verifyLegacyPreinstall: () => { reads += 1; return verifiedStatus } })
      expect(reads).toBe(2)
      expect(result).toMatchObject({
        schema: 'video-autoworker-shared-runtime-final-gate/v1',
        mode: 'legacy-preinstall', sourceCommit: expectedSourceCommit,
        targetReleaseId: expectedReleaseId,
      })
      expect((result as any).activity).toMatchObject({
        activeTasks: 0, activeMediaNodes: 0, activeN8nExecutions: 0,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects owner or transition identity drift across the authorization read', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'shared-runtime-install-gate-drift-'))
    try {
      const fixture = await createLegacyFixture(root)
      const rollbackStatus = legacyStatus({
        ...fixture.status,
        expired: true,
        components: {
          installed: ['task-flow'],
          journalHead: fileReference('/private/preverify-component.json', '46'),
        },
      })
      const rollbackInput = {
        ...fixture.input,
        operation: 'rollback' as const,
        component: 'task-flow' as const,
      }
      const originalBindings = rollbackStatus.bindings as Record<string, unknown>
      const originalTransition = originalBindings.transition as Record<string, unknown>
      const changed = legacyStatus({
        ...rollbackStatus,
        bindings: {
          ...originalBindings,
          transition: {
            ...originalTransition,
            liveCombinedSha256: 'c'.repeat(64),
          },
        },
      })
      let reads = 0
      const { verifySharedRuntimeInstallGate } = await verifier()
      expect(() => verifySharedRuntimeInstallGate(rollbackInput, {
        verifyLegacyPreinstall: () => (reads++ === 0 ? rollbackStatus : changed),
      })).toThrow(/legacy_preinstall_status_changed/u)
      expect(reads).toBe(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rechecks zero activity after reading the managed preinstall status', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'shared-runtime-install-gate-concurrent-'))
    try {
      const fixture = await createLegacyFixture(root)
      const rollbackStatus = legacyStatus({
        ...fixture.status,
        expired: true,
        components: {
          installed: ['task-flow'],
          journalHead: fileReference('/private/preverify-component.json', '46'),
        },
      })
      let reads = 0
      const { verifySharedRuntimeInstallGate } = await verifier()
      expect(() => verifySharedRuntimeInstallGate({
        ...fixture.input,
        operation: 'rollback',
        component: 'task-flow',
      }, {
        verifyLegacyPreinstall: () => {
          reads += 1
          if (reads === 2) {
            const mission = new Database(fixture.input.missionControlDbPath)
            mission.exec(`
              INSERT INTO n8n_task_runs
              VALUES (
                1, 'concurrent-task', 'openclaw', 'running',
                strftime('%s', 'now'), strftime('%s', 'now')
              )
            `)
            mission.close()
          }
          return rollbackStatus
        },
      })).toThrow(/active_tasks_present/u)
      expect(reads).toBe(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('never treats a partial rolling schema as a legacy installation', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'shared-runtime-install-gate-partial-'))
    try {
      const liveDbPath = resolve(root, 'mission-control.db')
      const database = new Database(liveDbPath)
      database.exec(`
        CREATE TABLE n8n_task_runs (
          id INTEGER PRIMARY KEY,
          task_id TEXT NOT NULL,
          source TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE n8n_intake_controls (
          control_id INTEGER PRIMARY KEY,
          accepting INTEGER NOT NULL,
          revision INTEGER NOT NULL
        );
      `)
      database.close()
      await chmod(liveDbPath, 0o600)
      const physical = await realpath(liveDbPath)
      const n8nDbPath = await createN8nDatabase(root)
      const videoBatchRoot = resolve(root, 'video-batches')
      await mkdir(videoBatchRoot, { mode: 0o700 })
      const physicalVideoBatchRoot = await realpath(videoBatchRoot)
      const { verifySharedRuntimeInstallGate } = await verifier()
      expect(() => verifySharedRuntimeInstallGate(
        {
          missionControlDbPath: physical,
          n8nDbPath,
          legacyPreinstallAttemptDir: resolve(root, 'attempt'),
          videoBatchRoot: physicalVideoBatchRoot,
          expectedSourceCommit,
          expectedReleaseId,
        },
        { verifyLegacyPreinstall: () => { throw new Error('must not run') } },
      )).toThrow(/rolling_schema_partial/u)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('requires the durable batch root to exist as a physical owner-private directory', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'shared-runtime-install-gate-batch-root-'))
    try {
      const fixture = await createDatabase(root)
      await rm(fixture.videoBatchRoot, { recursive: true })
      const { verifySharedRuntimeInstallGate } = await verifier()
      expect(() => verifySharedRuntimeInstallGate(fixture))
        .toThrow(/video_batch_root_unsafe/u)

      await mkdir(fixture.videoBatchRoot, { mode: 0o755 })
      await chmod(fixture.videoBatchRoot, 0o755)
      expect(() => verifySharedRuntimeInstallGate(fixture))
        .toThrow(/video_batch_root_unsafe/u)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('blocks an old media node even when general queue projection marks it attention', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'shared-runtime-install-gate-media-'))
    try {
      const fixture = await createDatabase(root)
      const mission = new Database(fixture.missionControlDbPath)
      mission.exec(`
        INSERT INTO n8n_task_runs
        VALUES (1, 'old-media', 'n8n-media-node', 'accepted', 1, 1)
      `)
      mission.close()
      const { verifySharedRuntimeInstallGate } = await verifier()
      expect(() => verifySharedRuntimeInstallGate(fixture))
        .toThrow(/active_media_nodes_present/u)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('blocks active executions from the separately bound authoritative n8n database', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'shared-runtime-install-gate-n8n-'))
    try {
      const fixture = await createDatabase(root)
      const n8n = new Database(fixture.n8nDbPath)
      n8n.prepare('INSERT INTO execution_entity VALUES (?, ?, NULL)').run(1, 'running')
      n8n.close()
      const { verifySharedRuntimeInstallGate } = await verifier()
      expect(() => verifySharedRuntimeInstallGate(fixture))
        .toThrow(/active_n8n_executions_present/u)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    ['resumed intake', "UPDATE n8n_intake_controls SET accepting = 1", /intake_not_paused/u],
    [
      'active task',
      "INSERT INTO n8n_task_runs VALUES (1, 'task-active', 'openclaw', 'running', strftime('%s','now'), strftime('%s','now'))",
      /active_tasks_present/u,
    ],
    ['pending director outbox', "INSERT INTO n8n_director_evidence_outbox VALUES ('pending')", /director_outbox_pending/u],
  ])('fails closed for %s', async (_name, mutation, expected) => {
    const root = await mkdtemp(resolve(tmpdir(), 'shared-runtime-install-gate-failure-'))
    try {
      const fixture = await createDatabase(root)
      const database = new Database(fixture.missionControlDbPath)
      database.exec(mutation)
      database.close()
      const { verifySharedRuntimeInstallGate } = await verifier()
      expect(() => verifySharedRuntimeInstallGate(fixture)).toThrow(expected)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('binds rolling authorization to the attested 3017 router, active slot, and 5678 database owner', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'shared-runtime-rolling-binding-'))
    try {
      const fixture = await createRollingRuntimeFixture(root)
      const { verifyRollingRuntimeBinding } = await verifier()
      expect(verifyRollingRuntimeBinding(fixture.input, fixture.dependencies)).toMatchObject({
        schema: 'video-autoworker-rolling-runtime-binding/v1',
        runDirectory: fixture.deploymentRunDir,
        activeSlot: 'blue',
        previousSlot: null,
        generation: 4,
        routerPid: 101,
        slotPids: { blue: 102 },
        n8nPid: 103,
        mission: fixture.missionIdentity,
        n8n: fixture.n8nIdentity,
        videoBatchRoot: fixture.videoBatchRoot,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('includes the centralized runtime receipt whenever a production run directory is supplied', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'shared-runtime-rolling-receipt-'))
    try {
      const fixture = await createDatabase(root)
      const receipt = { schema: 'video-autoworker-rolling-runtime-binding/v1', routerPid: 101 }
      let calls = 0
      const { verifySharedRuntimeInstallGate } = await verifier()
      expect(verifySharedRuntimeInstallGate({
        ...fixture,
        deploymentRunDir: resolve(root, '.run/blue-green'),
      }, {
        verifyRollingRuntimeBinding: () => { calls += 1; return receipt },
      })).toMatchObject({ mode: 'rolling', runtimeBinding: receipt })
      expect(calls).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps rolling maintenance available while the immediately previous slot is still draining', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'shared-runtime-rolling-two-slots-'))
    try {
      const fixture = await createRollingRuntimeFixture(root)
      const state = JSON.parse(await readFile(fixture.statePath, 'utf8'))
      const greenReleaseRoot = resolve(fixture.input.sourceRepositoryRoot,
        '.runtime/releases/green-release/standalone')
      await mkdir(greenReleaseRoot, { recursive: true, mode: 0o700 })
      await writeFile(resolve(greenReleaseRoot, 'release-manifest.json'),
        '{"fixture":true}\n', { mode: 0o600 })
      state.active = 'green'
      state.previous = 'blue'
      state.generation += 1
      state.slots.green.releaseId = 'green-release'
      await writeFile(fixture.statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 })
      await writeFile(resolve(fixture.slots, 'green.json'), `${JSON.stringify({
        schema: 'video-autoworker-standalone-slot/v1', slot: 'green',
        releaseId: 'green-release', releaseRoot: greenReleaseRoot,
        manifestSha256: fixture.manifestSha256, host: '127.0.0.1', port: 3417,
      })}\n`, { mode: 0o600 })
      await writeFile(resolve(fixture.slots, 'green.runtime.json'), `${JSON.stringify({
        schema: 'video-autoworker-standalone-runtime/v1', pid: 104,
        slot: 'green', role: 'active', releaseId: 'green-release',
        manifestSha256: fixture.manifestSha256, host: '127.0.0.1', port: 3417,
        dbPath: fixture.missionIdentity.path, routerStatePath: fixture.statePath,
        createdAt: new Date().toISOString(),
      })}\n`, { mode: 0o600 })
      await writeFile(resolve(fixture.slots, 'green.pid'), '104\n', { mode: 0o600 })
      fixture.listeners.set(3417, [104])
      fixture.alive.add(104)
      fixture.processPaths.set('104:cwd', [greenReleaseRoot])
      fixture.processPaths.set('104:', [fixture.missionIdentity.path])
      const { verifyRollingRuntimeBinding } = await verifier()
      expect(verifyRollingRuntimeBinding(fixture.input, fixture.dependencies)).toMatchObject({
        activeSlot: 'green', previousSlot: 'blue',
        slotPids: { blue: 102, green: 104 },
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects fake run, database, batch, and listener bindings in rolling mode', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'shared-runtime-rolling-adversarial-'))
    try {
      const fixture = await createRollingRuntimeFixture(root)
      const { verifyRollingRuntimeBinding } = await verifier()
      expect(() => verifyRollingRuntimeBinding({
        ...fixture.input,
        deploymentRunDir: resolve(root, 'fake-run'),
      }, fixture.dependencies)).toThrow(/rolling_run_directory_not_canonical/u)
      expect(() => verifyRollingRuntimeBinding({
        ...fixture.input,
        videoBatchRoot: resolve(root, 'fake-batches'),
      }, fixture.dependencies)).toThrow(/rolling_batch_root_not_canonical/u)
      expect(() => verifyRollingRuntimeBinding({
        ...fixture.input,
        missionIdentity: { ...fixture.missionIdentity, path: fixture.n8nIdentity.path },
      }, fixture.dependencies)).toThrow(/rolling_blue_runtime_binding_mismatch/u)
      fixture.listeners.set(3017, [999])
      expect(() => verifyRollingRuntimeBinding(
        fixture.input, fixture.dependencies,
      )).toThrow(/rolling_router_listener_mismatch/u)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('binds database owners by physical inode and audits the canonical immutable release', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'shared-runtime-rolling-physical-binding-'))
    try {
      const fixture = await createRollingRuntimeFixture(root)
      const { verifyRollingRuntimeBinding } = await verifier()
      fixture.processPaths.set('102:', [fixture.n8nIdentity.path])
      expect(() => verifyRollingRuntimeBinding(
        fixture.input, fixture.dependencies,
      )).toThrow(/rolling_blue_process_binding_mismatch/u)
      fixture.processPaths.set('102:', [fixture.missionIdentity.path])

      const bindingPath = resolve(fixture.slots, 'blue.json')
      const binding = JSON.parse(await readFile(bindingPath, 'utf8'))
      binding.releaseRoot = resolve(await realpath(root), 'mutable-release')
      await mkdir(binding.releaseRoot, { mode: 0o700 })
      await writeFile(bindingPath, `${JSON.stringify(binding)}\n`, { mode: 0o600 })
      expect(() => verifyRollingRuntimeBinding(
        fixture.input, fixture.dependencies,
      )).toThrow(/rolling_blue_runtime_binding_mismatch/u)

      binding.releaseRoot = resolve(fixture.input.sourceRepositoryRoot,
        '.runtime/releases/active-release/standalone')
      await writeFile(bindingPath, `${JSON.stringify(binding)}\n`, { mode: 0o600 })
      await writeFile(resolve(binding.releaseRoot, 'release-manifest.json'),
        '{"changed":true}\n', { mode: 0o600 })
      expect(() => verifyRollingRuntimeBinding(
        fixture.input, fixture.dependencies,
      )).toThrow(/rolling_release_manifest_mismatch/u)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('blocks a listenerless live previous process and accepts only a certified stopped retirement', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'shared-runtime-rolling-retired-slot-'))
    try {
      const fixture = await createRollingRuntimeFixture(root)
      const state = JSON.parse(await readFile(fixture.statePath, 'utf8'))
      const greenReleaseRoot = resolve(fixture.input.sourceRepositoryRoot,
        '.runtime/releases/green-release/standalone')
      await mkdir(greenReleaseRoot, { recursive: true, mode: 0o700 })
      await writeFile(resolve(greenReleaseRoot, 'release-manifest.json'),
        '{"fixture":true}\n', { mode: 0o600 })
      state.active = 'green'
      state.previous = 'blue'
      state.generation += 1
      state.updatedAt = new Date().toISOString()
      state.slots.green.releaseId = 'green-release'
      await writeFile(fixture.statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 })
      await writeFile(resolve(fixture.slots, 'green.json'), `${JSON.stringify({
        schema: 'video-autoworker-standalone-slot/v1', slot: 'green',
        releaseId: 'green-release', releaseRoot: greenReleaseRoot,
        manifestSha256: fixture.manifestSha256, host: '127.0.0.1', port: 3417,
      })}\n`, { mode: 0o600 })
      await writeFile(resolve(fixture.slots, 'green.runtime.json'), `${JSON.stringify({
        schema: 'video-autoworker-standalone-runtime/v1', pid: 104,
        slot: 'green', role: 'active', releaseId: 'green-release',
        manifestSha256: fixture.manifestSha256, host: '127.0.0.1', port: 3417,
        dbPath: fixture.missionIdentity.path, routerStatePath: fixture.statePath,
        createdAt: new Date().toISOString(),
      })}\n`, { mode: 0o600 })
      await writeFile(resolve(fixture.slots, 'green.pid'), '104\n', { mode: 0o600 })
      fixture.listeners.set(3317, [])
      fixture.listeners.set(3417, [104])
      fixture.alive.add(104)
      fixture.processPaths.set('104:cwd', [greenReleaseRoot])
      fixture.processPaths.set('104:', [fixture.missionIdentity.path])

      const { verifyRollingRuntimeBinding } = await verifier()
      expect(() => verifyRollingRuntimeBinding(
        fixture.input, fixture.dependencies,
      )).toThrow(/rolling_blue_process_still_alive/u)

      fixture.alive.delete(102)
      const observedAt = Math.floor(Date.now() / 1_000)
      const freeze = {
        schema: 'video-autoworker-callback-freeze/v1', slot: 'blue',
        releaseId: 'active-release', manifestSha256: fixture.manifestSha256,
        pid: 102, dbPath: fixture.missionIdentity.path, routerStatePath: fixture.statePath,
        routerGeneration: state.generation, activeSlot: 'green', freezeId: 'd'.repeat(64),
        frozenAt: observedAt, quiesceId: 'e'.repeat(64), quiescedAt: observedAt,
      }
      await writeFile(resolve(fixture.slots, 'blue.callbacks-frozen.json'),
        `${JSON.stringify(freeze)}\n`, { mode: 0o600 })
      await writeFile(resolve(fixture.slots, 'blue.retired.json'), `${JSON.stringify({
        schema: 'video-autoworker-retirement-proof/v2', slot: 'blue',
        releaseId: 'active-release', manifestSha256: fixture.manifestSha256,
        pid: 102, dbPath: fixture.missionIdentity.path, routerStatePath: fixture.statePath,
        routerGeneration: state.generation, activeSlot: 'green', observedAt,
        freeze: {
          freezeId: freeze.freezeId, frozenAt: freeze.frozenAt,
          quiesceId: freeze.quiesceId, quiescedAt: freeze.quiescedAt,
        },
        drain: {
          active: 0, childExecutionLeases: 0, untrackedCallbacks: 0,
          otherReleaseActive: 0, routerActiveRequests: 0, routerUpgradedSockets: 0,
          schedulerState: 'inactive', schedulerRouterGeneration: state.generation,
          quietSeconds: 30, requiredQuietSeconds: 30,
        },
      })}\n`, { mode: 0o600 })
      expect(verifyRollingRuntimeBinding(fixture.input, fixture.dependencies)).toMatchObject({
        activeSlot: 'green', previousSlot: 'blue', slotPids: { green: 104 },
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('uses the exact blue-green deployment lock in every shared runtime installer', async () => {
    const deploy = await readFile(resolve(repositoryRoot, 'scripts/deploy-blue-green.sh'), 'utf8')
    const installers = await Promise.all([
      'scripts/install-aiworker-video-command-plugin.sh',
      'scripts/install-aiworker-task-flow-skill.sh',
      'scripts/install-aiworker-director-brain.sh',
    ].map(pathname => readFile(resolve(repositoryRoot, pathname), 'utf8')))

    expect(deploy).toContain('LOCK_DIR="$RUN_DIR/.deployment.lock"')
    for (const source of installers) {
      expect(source).toContain('DEPLOYMENT_RUN_DIR="${AIWORKER_BG_RUN_DIR:-$REPOSITORY_ROOT/.run/blue-green}"')
      expect(source).toContain('DEPLOYMENT_LOCK_DIR="$DEPLOYMENT_RUN_DIR/.deployment.lock"')
      expect(source).toContain('scripts/lib/shared-deployment-lock.sh')
      expect(source).toContain('acquire_shared_deployment_lock')
      expect(source).toContain('release_shared_deployment_lock')
      expect(source).toContain('verify-shared-runtime-install-gate.mjs')
      expect(source).toContain('AIWORKER_BG_N8N_DB_PATH')
      expect(source).toContain('AIWORKER_BG_LEGACY_PREINSTALL_ATTEMPT_DIR')
      expect(source).toContain('--deployment-run-dir "$DEPLOYMENT_RUN_DIR"')
      expect(source).toContain('if [[ "$SHARED_GATE_MODE" == rolling ]]')
      expect(source).toContain('--expected-source-commit "$EXPECTED_SOURCE_COMMIT"')
      expect(source).toContain('--expected-release-id "$EXPECTED_RELEASE_ID"')
      expect(source).toContain('custom overrides are test-only')
    }
    const [video, task, director] = installers
    expect(task).toContain('assert_canonical_clean_source_repository')
    expect(task).toContain('diff-index --quiet HEAD --')
    expect(task).toContain('status --porcelain=v1 --untracked-files=all')
    for (const source of [video, director]) {
      const sharedLock = source.indexOf('acquire_shared_deployment_lock',
        source.indexOf('verify_shared_install_gate'))
      const rollingRegate = source.indexOf('verify_shared_install_gate', sharedLock)
      const noopResult = source.indexOf('write_install_result rollback restored', rollingRegate)
      expect(sharedLock).toBeGreaterThan(-1)
      expect(rollingRegate).toBeGreaterThan(sharedLock)
      expect(noopResult).toBeGreaterThan(rollingRegate)
    }
    const evidenceVerifier = await readFile(resolve(
      repositoryRoot, 'scripts/generate-legacy-freeze-evidence.mjs',
    ), 'utf8')
    expect(evidenceVerifier).toContain(
      'freezeGuard(evidence.legacy.database, evidence.n8n.database)',
    )
  })
})
