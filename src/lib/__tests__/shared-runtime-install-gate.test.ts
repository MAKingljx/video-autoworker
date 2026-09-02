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

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex')
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

async function verifier() {
  return await import(/* @vite-ignore */ `${pathToFileURL(verifierPath).href}?t=${Date.now()}`) as {
    validateLegacyBootstrapStatus: (
      status: unknown,
      commit: string,
      releaseId: string,
    ) => Record<string, unknown>
    verifySharedRuntimeInstallGate: (input: {
      missionControlDbPath: string
      n8nDbPath: string
      legacyAttemptDir?: string
      videoBatchRoot: string
      expectedSourceCommit: string
      expectedReleaseId: string
    }, dependencies?: {
      verifyLegacyAttempt: (attempt: string, commit: string, releaseId: string) => {
        sourceCommit: string
        target: { releaseId: string }
        databases: {
          mission: { path: string, dev: string, ino: string }
          n8n: { path: string, dev: string, ino: string }
        }
      }
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
    }
  }
}

function legacyStatus(overrides: Record<string, unknown> = {}) {
  return {
    phase: 'PREPARED',
    expired: false,
    bindings: {
      sourceCommit: expectedSourceCommit,
      target: { releaseId: expectedReleaseId, releaseRoot: '/private/runtime' },
      evidence: { path: '/private/evidence.json' },
      proof: { path: '/private/proof.json' },
      databases: {
        mission: { path: '/private/mission.db', dev: '1', ino: '2' },
        n8n: { path: '/private/n8n.db', dev: '1', ino: '3' },
      },
    },
    ...overrides,
  }
}

describe('shared runtime installation gate', () => {
  it('accepts a fresh fully-bound PREPARED attempt but rejects expiry and another target', async () => {
    const { validateLegacyBootstrapStatus } = await verifier()
    expect(validateLegacyBootstrapStatus(
      legacyStatus(), expectedSourceCommit, expectedReleaseId,
    )).toMatchObject({
      sourceCommit: expectedSourceCommit,
      target: { releaseId: expectedReleaseId },
    })
    expect(() => validateLegacyBootstrapStatus(
      legacyStatus({ expired: true }), expectedSourceCommit, expectedReleaseId,
    )).toThrow(/legacy_attempt_not_current/u)
    expect(() => validateLegacyBootstrapStatus(
      legacyStatus(), 'b'.repeat(40), `${'b'.repeat(40)}-runtime`,
    )).toThrow(/legacy_target_binding_mismatch/u)
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
        .toThrow(/legacy_attempt_required/u)
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
      expect(verifySharedRuntimeInstallGate(
        {
          missionControlDbPath: physical,
          n8nDbPath,
          legacyAttemptDir: attempt,
          videoBatchRoot: physicalVideoBatchRoot,
          expectedSourceCommit,
          expectedReleaseId,
        },
        { verifyLegacyAttempt: () => ({
          sourceCommit: expectedSourceCommit,
          target: { releaseId: expectedReleaseId },
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
        }) },
      )).toEqual({
        schema: 'video-autoworker-shared-runtime-install-gate/v1',
        mode: 'legacy-bootstrap',
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
      })
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
          legacyAttemptDir: resolve(root, 'attempt'),
          videoBatchRoot: physicalVideoBatchRoot,
          expectedSourceCommit,
          expectedReleaseId,
        },
        { verifyLegacyAttempt: () => { throw new Error('must not run') } },
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
      expect(source).toContain('AIWORKER_BG_LEGACY_BOOTSTRAP_ATTEMPT_DIR')
      expect(source).toContain('--expected-source-commit "$EXPECTED_SOURCE_COMMIT"')
      expect(source).toContain('--expected-release-id "$EXPECTED_RELEASE_ID"')
    }
    const evidenceVerifier = await readFile(resolve(
      repositoryRoot, 'scripts/generate-legacy-freeze-evidence.mjs',
    ), 'utf8')
    expect(evidenceVerifier).toContain(
      'freezeGuard(evidence.legacy.database, evidence.n8n.database)',
    )
  })
})
