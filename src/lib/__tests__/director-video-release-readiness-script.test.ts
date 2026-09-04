import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmod, cp, mkdir, mkdtemp, readdir, realpath, rm, writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { directorEvidenceProjectionContractDigest } from '@/lib/director-evidence-outbox'
import { runMigrations } from '@/lib/migrations'
import {
  directorEvidenceDigest,
  directorEvidenceSourceIdentityDigest,
} from '@/lib/director-evidence-delivery-core'

// The production verifier is a Node ESM script and opens SQLite read-only through the app dependency.
import {
  assertDirectorEvidenceOutboxReleaseReady,
  assertDirectorExtractionReleaseReady,
  assertRepositoryRelease,
  inspectDirectorEvidenceOutboxCompatibility,
  inspectDirectorExtractionIntegrity,
  verifyDirectorExtractionReleaseProvenance,
  verifyInstalledReleasePayloads,
} from '../../../scripts/verify-director-video-release-readiness.mjs'
import {
  buildStandaloneArtifactContentBinding,
  createStandaloneBuildSourceAnchor,
  DIRECTOR_EXTRACTION_SOURCE_ROOTS,
  sourceClosure,
  sourceClosureForGitCommit,
  STANDALONE_ARTIFACT_CONTENT_SCHEMA,
  writeDirectorExtractionProvenance,
} from '../../../scripts/lib/director-extraction-release-provenance.mjs'

const repositoryRoot = resolve(process.cwd())

async function writeProvenanceOnlyManifest(artifactRoot: string) {
  const artifactContent = buildStandaloneArtifactContentBinding({
    schema: STANDALONE_ARTIFACT_CONTENT_SCHEMA,
    algorithm: 'sha256',
    directories: [],
    files: [],
    symlinks: [],
  })
  const path = 'release-provenance.json'
  const contents = readFileSync(join(artifactRoot, path))
  await writeFile(join(artifactRoot, 'release-manifest.json'), JSON.stringify({
    schemaVersion: 2,
    algorithm: 'sha256',
    artifactContent,
    directories: [],
    files: [{
      path,
      bytes: contents.byteLength,
      sha256: createHash('sha256').update(contents).digest('hex'),
    }],
    symlinks: [],
  }))
}

function writeProvenanceOnly(
  artifactRoot: string,
  gitRoot: string,
  anchored: boolean | 'allow-dirty' = true,
) {
  const artifactContent = buildStandaloneArtifactContentBinding({
    schema: STANDALONE_ARTIFACT_CONTENT_SCHEMA,
    algorithm: 'sha256',
    directories: [],
    files: [],
    symlinks: [],
  })
  const anchor = anchored
    ? createStandaloneBuildSourceAnchor(gitRoot, { allowDirty: anchored === 'allow-dirty' })
    : null
  return writeDirectorExtractionProvenance(gitRoot, artifactRoot, artifactContent, anchor)
}

async function copyPrivateTree(source: string, target: string) {
  await cp(source, target, { recursive: true })
  const visit = async (directory: string) => {
    await chmod(directory, 0o700)
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const pathname = join(directory, entry.name)
      if (entry.isDirectory()) await visit(pathname)
      else await chmod(pathname, 0o600)
    }
  }
  await visit(target)
}

async function installVideoCommand(profileRoot: string) {
  const source = join(repositoryRoot, 'openclaw-plugins', 'aiworker-video-command')
  const target = join(profileRoot, 'extensions', 'aiworker-video-command')
  await mkdir(target, { recursive: true, mode: 0o700 })
  for (const member of ['index.js', 'openclaw.plugin.json', 'package.json']) {
    await cp(join(source, member), join(target, member))
  }
  for (const member of ['lib', 'scripts']) {
    await copyPrivateTree(join(source, member), join(target, member))
  }
  await Promise.all(['index.js', 'openclaw.plugin.json', 'package.json']
    .map(member => chmod(join(target, member), 0o600)))
}

async function installTaskFlow(workspaceRoot: string) {
  const source = join(repositoryRoot, 'openclaw-skills', 'aiworker-task-flow')
  const target = join(workspaceRoot, 'skills', 'aiworker-task-flow')
  await mkdir(join(target, 'scripts'), { recursive: true, mode: 0o700 })
  await mkdir(join(target, 'lib'), { recursive: true, mode: 0o700 })
  await cp(join(source, 'SKILL.md'), join(target, 'SKILL.md'))
  for (const directory of ['scripts', 'lib']) {
    for (const entry of await readdir(join(source, directory), { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.mjs')) {
        await cp(join(source, directory, entry.name), join(target, directory, entry.name))
      }
    }
  }
  await copyPrivateTree(target, `${target}.private`)
  await rm(target, { recursive: true })
  await cp(`${target}.private`, target, { recursive: true })
  await rm(`${target}.private`, { recursive: true })
}

async function installDirectorBrain(profileRoot: string, workspaceRoot: string) {
  const source = join(repositoryRoot, 'openclaw-plugins', 'aiworker-director-brain')
  const target = join(profileRoot, 'extensions', 'aiworker-director-brain')
  await mkdir(target, { recursive: true, mode: 0o700 })
  for (const member of ['index.js', 'openclaw.plugin.json', 'package.json']) {
    await cp(join(source, member), join(target, member))
  }
  await copyPrivateTree(join(source, 'lib'), join(target, 'lib'))
  await mkdir(join(target, 'runtime', 'scripts', 'lib'), { recursive: true, mode: 0o700 })
  await mkdir(join(target, 'runtime', 'ops', 'feishu-director-brain'), {
    recursive: true,
    mode: 0o700,
  })
  await cp(
    join(repositoryRoot, 'scripts', 'feishu-director-brain.mjs'),
    join(target, 'runtime', 'scripts', 'feishu-director-brain.mjs'),
  )
  await cp(
    join(repositoryRoot, 'scripts', 'lib', 'feishu-director-brain.mjs'),
    join(target, 'runtime', 'scripts', 'lib', 'feishu-director-brain.mjs'),
  )
  await cp(
    join(repositoryRoot, 'scripts', 'lib', 'sensitive-value-scanner.mjs'),
    join(target, 'runtime', 'scripts', 'lib', 'sensitive-value-scanner.mjs'),
  )
  await cp(
    join(repositoryRoot, 'ops', 'feishu-director-brain', 'schema.json'),
    join(target, 'runtime', 'ops', 'feishu-director-brain', 'schema.json'),
  )
  for (const member of [
    'index.js', 'openclaw.plugin.json', 'package.json',
    'runtime/scripts/feishu-director-brain.mjs',
    'runtime/scripts/lib/feishu-director-brain.mjs',
    'runtime/scripts/lib/sensitive-value-scanner.mjs',
    'runtime/ops/feishu-director-brain/schema.json',
  ]) await chmod(join(target, member), 0o600)
  await copyPrivateTree(
    join(repositoryRoot, 'openclaw-skills', 'aiworker-director-brain'),
    join(workspaceRoot, 'skills', 'aiworker-director-brain'),
  )
}

describe('director video release readiness verifier', () => {
  let root: string
  let profileRoot: string
  let workspaceRoot: string

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'director-release-readiness-')))
    profileRoot = join(root, 'profile')
    workspaceRoot = join(root, 'workspace')
    await mkdir(profileRoot, { mode: 0o700 })
    await mkdir(workspaceRoot, { mode: 0o700 })
    await installVideoCommand(profileRoot)
    await installTaskFlow(workspaceRoot)
    await installDirectorBrain(profileRoot, workspaceRoot)
  })

  afterEach(async () => rm(root, { recursive: true, force: true }))

  it('accepts only the exact compatible plugin, skill, and director-brain payload set', () => {
    const result = verifyInstalledReleasePayloads({
      repositoryRoot,
      profileStateRoot: profileRoot,
      workspaceRoot,
    })
    expect(result.videoCommand).toMatchObject({ version: '0.5.14' })
    expect(result.directorBrain).toMatchObject({ version: '0.4.0' })
    expect(result.taskFlow.files).toBeGreaterThan(3)
    expect(Object.keys(result.closure)).toHaveLength(8)
    expect((result.closure as Record<string, string>)
      .DIRECTOR_BRAIN_SENSITIVE_VALUE_SCANNER_SHA256)
      .toMatch(/^[a-f0-9]{64}$/u)
    expect((result.closure as Record<string, string>).DIRECTOR_EVIDENCE_DELIVERY_CORE_SHA256)
      .toMatch(/^[a-f0-9]{64}$/u)
    expect(result.projectionContract).toMatchObject({
      authority: 'director-evidence-projection-contract-v1',
      schemaVersion: 1,
      currentDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    })
    expect(result.projectionContract.currentDigest)
      .toBe(directorEvidenceProjectionContractDigest())
    expect(readFileSync(join(repositoryRoot, 'src/lib/director-evidence-delivery-core.ts'), 'utf8'))
      .not.toContain('DIRECTOR_EVIDENCE_DELIVERY_CORE_SHA256')
  })

  it('reports incompatible contracts, invalid receipts, and rows outside the director scope', () => {
    const currentDigest = directorEvidenceProjectionContractDigest()
    const databasePath = join(root, 'n8n.sqlite')
    const database = new Database(databasePath)
    try {
      database.exec(`
        CREATE TABLE n8n_task_runs (
          task_id TEXT PRIMARY KEY,
          binding_id INTEGER NOT NULL,
          tenant_id INTEGER NOT NULL,
          workspace_id INTEGER NOT NULL,
          status TEXT NOT NULL,
          source TEXT NOT NULL,
          input TEXT NOT NULL
        );
        CREATE TABLE n8n_director_evidence_outbox (
          task_id TEXT PRIMARY KEY,
          binding_id INTEGER NOT NULL,
          tenant_id INTEGER NOT NULL,
          workspace_id INTEGER NOT NULL,
          work_id TEXT NOT NULL,
          query_digest TEXT NOT NULL,
          projection_contract_digest TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          result_sha256 TEXT NOT NULL,
          status TEXT NOT NULL
        );
        CREATE TABLE n8n_director_evidence_projection_receipts (
          task_id TEXT PRIMARY KEY,
          source_identity_sha256 TEXT NOT NULL,
          projection_contract_digest TEXT NOT NULL,
          receipt_json TEXT NOT NULL,
          receipt_sha256 TEXT NOT NULL,
          origin TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
      `)
      const rows = [
        ['compatible', 3, 2, currentDigest, 'pending', '1'],
        ['incompatible', 3, 2, 'f'.repeat(64), 'pending', '2'],
        ['outside-scope', 33, 22, currentDigest, 'pending', '3'],
        ['delivered-valid', 3, 2, currentDigest, 'delivered', '4'],
        ['delivered-missing', 3, 2, currentDigest, 'delivered', '5'],
        ['delivered-tampered', 3, 2, currentDigest, 'delivered', '6'],
      ] as const
      const insertRoot = database.prepare(`
        INSERT INTO n8n_task_runs (
          task_id, binding_id, tenant_id, workspace_id, status, source, input
        ) VALUES (?, 7, ?, ?, 'succeeded', 'openclaw', ?)
      `)
      const insertOutbox = database.prepare(`
        INSERT INTO n8n_director_evidence_outbox
          (task_id, binding_id, tenant_id, workspace_id, work_id, query_digest,
           projection_contract_digest, idempotency_key, result_sha256, status)
        VALUES (?, 7, ?, ?, 'WORK-001', ?, ?, ?, ?, ?)
      `)
      for (const [taskId, tenantId, workspaceId, digest, status, salt] of rows) {
        insertRoot.run(taskId, tenantId, workspaceId, JSON.stringify({
          directorEvidence: {
            authority: 'director-brain-resolve-work-v1',
            workId: 'WORK-001',
            queryDigest: 'a'.repeat(64),
          },
        }))
        insertOutbox.run(
          taskId, tenantId, workspaceId, 'a'.repeat(64), digest,
          salt.repeat(64), 'b'.repeat(64), status,
        )
      }
      const delivered = {
        taskId: 'delivered-valid',
        bindingId: 7,
        tenantId: 3,
        workspaceId: 2,
        workId: 'WORK-001',
        queryDigest: 'a'.repeat(64),
        projectionContractDigest: currentDigest,
        idempotencyKey: '4'.repeat(64),
        resultSha256: 'b'.repeat(64),
      }
      const sourceIdentitySha256 = directorEvidenceSourceIdentityDigest(delivered)
      const receipt = {
        authority: 'video-autoworker-director-evidence-delivery-v1',
        schemaVersion: 1,
        projectId: 'PROJ-VIDEO-AUTOWORKER',
        workId: 'WORK-001',
        sourceIdentitySha256,
        projectionSha256: 'c'.repeat(64),
        entries: [{ stableId: 'DB-EVIDENCE-VALID', startSeconds: 0, endSeconds: 1 }],
      }
      database.prepare(`
        INSERT INTO n8n_director_evidence_projection_receipts (
          task_id, source_identity_sha256, projection_contract_digest,
          receipt_json, receipt_sha256, origin, created_at
        ) VALUES (?, ?, ?, ?, ?, 'delivery', 1000)
      `).run(
        delivered.taskId,
        sourceIdentitySha256,
        delivered.projectionContractDigest,
        JSON.stringify(receipt),
        directorEvidenceDigest(receipt),
      )
      const tampered = {
        ...receipt,
        sourceIdentitySha256: 'd'.repeat(64),
      }
      database.prepare(`
        INSERT INTO n8n_director_evidence_projection_receipts (
          task_id, source_identity_sha256, projection_contract_digest,
          receipt_json, receipt_sha256, origin, created_at
        ) VALUES ('delivered-tampered', ?, ?, ?, ?, 'delivery', 1000)
      `).run(
        'd'.repeat(64),
        currentDigest,
        JSON.stringify(tampered),
        directorEvidenceDigest(tampered),
      )
      database.prepare(`
        INSERT INTO n8n_task_runs (
          task_id, binding_id, tenant_id, workspace_id, status, source, input
        ) VALUES (
          'extraction-outside-scope', 7, 33, 22, 'succeeded',
          'n8n-node', '{"childKind":"director-extraction","parentTaskId":"outside-source"}'
        )
      `).run()
    } finally {
      database.close()
    }

    expect(inspectDirectorEvidenceOutboxCompatibility({
      repositoryRoot,
      liveDbPath: databasePath,
      currentDigest,
      scope: { tenantId: 3, workspaceId: 2 },
    })).toEqual({
      schema: 'video-autoworker-director-evidence-outbox-readiness/v1',
      currentDigest,
      pending: 3,
      incompatiblePending: 1,
      deliveredWithoutValidReceipt: 2,
      outOfScopeOutbox: 1,
      outOfScopeExtraction: 1,
    })
  })

  it.each([
    ['incompatiblePending', 'projection_contract_incompatible_pending'],
    ['deliveredWithoutValidReceipt', 'projection_receipt_invalid_delivered'],
    ['outOfScopeOutbox', 'projection_outbox_scope_violation'],
    ['outOfScopeExtraction', 'projection_extraction_scope_violation'],
  ] as const)('blocks release readiness when %s is nonzero', (field, error) => {
    const readiness = {
      incompatiblePending: 0,
      deliveredWithoutValidReceipt: 0,
      outOfScopeOutbox: 0,
      outOfScopeExtraction: 0,
      [field]: 1,
    }
    expect(() => assertDirectorEvidenceOutboxReleaseReady(readiness)).toThrow(error)
  })

  it('blocks a succeeded extraction phase without its checkpoint and projection receipt', () => {
    const databasePath = join(root, 'extraction-integrity.sqlite')
    const database = new Database(databasePath)
    try {
      database.pragma('foreign_keys = ON')
      runMigrations(database)
      database.prepare(`
        INSERT INTO n8n_workflow_bindings (
          id, name, webhook_path, task_type, workspace_id, tenant_id
        ) VALUES (7, 'director readiness', 'director-readiness', 'video-analysis', 2, 3)
      `).run()
      database.prepare(`
        INSERT INTO n8n_task_runs (
          task_id, idempotency_key, binding_id, status, source, requested_by,
          routing, input, delivery, output, attempt_count, max_attempts,
          workspace_id, tenant_id, completed_at, updated_at
        ) VALUES (
          'source-integrity', 'source-integrity-idem', 7, 'succeeded',
          'openclaw', 'test', '{"taskType":"video-analysis"}',
          ?, '{"mode":"none"}', '{"taskType":"video-analysis","materialId":"MAT-1"}', 1, 1, 2, 3, 10, 10
        )
      `).run(JSON.stringify({
        directorEvidence: {
          authority: 'director-brain-resolve-work-v1',
          workId: 'WORK-001',
          queryDigest: 'a'.repeat(64),
        },
      }))
      database.prepare(`
        INSERT INTO n8n_task_runs (
          task_id, idempotency_key, binding_id, status, source, requested_by,
          routing, input, delivery, output, attempt_count, max_attempts,
          workspace_id, tenant_id, completed_at, updated_at
        ) VALUES (
          'phase-integrity', 'phase-integrity-idem', 7, 'succeeded',
          'n8n-node', 'test', ?,
          ?, '{"mode":"none"}', '{}', 1, 3, 2, 3, 11, 11
        )
      `).run(
        JSON.stringify({
          taskType: 'video-analysis', childKind: 'director-extraction',
          directorPhase: 'understanding', parentTaskId: 'source-integrity',
        }),
        JSON.stringify({
          taskType: 'video-analysis', childKind: 'director-extraction',
          directorPhase: 'understanding', parentTaskId: 'source-integrity',
        }),
      )
    } finally {
      database.close()
    }
    const report = inspectDirectorExtractionIntegrity({
      repositoryRoot,
      liveDbPath: databasePath,
      scope: { tenantId: 3, workspaceId: 2 },
    })
    expect(report).toMatchObject({
      expectedProjectionVersion: 'feishu-candidate-projection-v2',
      sources: 1,
      phases: 1,
      invalidCheckpoints: 1,
      invalidProjectionReceipts: 1,
    })
    expect(() => assertDirectorExtractionReleaseReady(report))
      .toThrow('extraction_invalidCheckpoints:1')
  })

  it.each([
    'activePhases',
    'sourcesWithoutPhase',
    'invalidPhaseBindings',
    'invalidCheckpoints',
    'invalidProjectionReceipts',
    'invalidReviewReceipts',
    'missingPredecessorReviews',
    'incompatibleProjectionBoundary',
  ])('fails the extraction release gate when %s is nonzero', field => {
    const clean = {
      activePhases: 0,
      sourcesWithoutPhase: 0,
      invalidPhaseBindings: 0,
      invalidCheckpoints: 0,
      invalidProjectionReceipts: 0,
      invalidReviewReceipts: 0,
      missingPredecessorReviews: 0,
      incompatibleProjectionBoundary: 0,
    }
    expect(() => assertDirectorExtractionReleaseReady({ ...clean, [field]: 1 }))
      .toThrow(`extraction_${field}:1`)
  })

  it('fails closed when submit-task directorWork support drifts', async () => {
    await writeFile(
      join(workspaceRoot, 'skills', 'aiworker-task-flow', 'scripts', 'submit-task.mjs'),
      'export {}\n',
    )
    expect(() => verifyInstalledReleasePayloads({
      repositoryRoot,
      profileStateRoot: profileRoot,
      workspaceRoot,
    })).toThrow('task_flow_manifest_mismatch')
  })

  it('fails closed when the installed director CLI is missing', async () => {
    await rm(join(profileRoot, 'extensions', 'aiworker-director-brain',
      'runtime', 'scripts', 'feishu-director-brain.mjs'))
    expect(() => verifyInstalledReleasePayloads({
      repositoryRoot,
      profileStateRoot: profileRoot,
      workspaceRoot,
    })).toThrow('director_brain_manifest_mismatch')
  })

  it('fails closed when the installed transcript projection hook is missing', async () => {
    await rm(join(profileRoot, 'extensions', 'aiworker-director-brain',
      'lib', 'transcript-tool-result-projection.js'))
    expect(() => verifyInstalledReleasePayloads({
      repositoryRoot,
      profileStateRoot: profileRoot,
      workspaceRoot,
    })).toThrow('director_brain_manifest_mismatch')
  })

  it('fails closed when the installed sensitive narrative filter is missing', async () => {
    await rm(join(profileRoot, 'extensions', 'aiworker-director-brain',
      'lib', 'sensitive-narrative-text.js'))
    expect(() => verifyInstalledReleasePayloads({
      repositoryRoot,
      profileStateRoot: profileRoot,
      workspaceRoot,
    })).toThrow('director_brain_manifest_mismatch')
  })

  it('fails closed when the installed sensitive narrative filter digest drifts', async () => {
    await writeFile(
      join(profileRoot, 'extensions', 'aiworker-director-brain',
        'lib', 'sensitive-narrative-text.js'),
      'export const containsSensitiveNarrativeValue = () => false\n',
    )
    expect(() => verifyInstalledReleasePayloads({
      repositoryRoot,
      profileStateRoot: profileRoot,
      workspaceRoot,
    })).toThrow('director_brain_manifest_mismatch')
  })

  it('fails closed when the installed director sensitive-value scanner drifts', async () => {
    await writeFile(
      join(profileRoot, 'extensions', 'aiworker-director-brain',
        'runtime', 'scripts', 'lib', 'sensitive-value-scanner.mjs'),
      'export const containsSensitiveValue = () => false\n',
    )
    expect(() => verifyInstalledReleasePayloads({
      repositoryRoot,
      profileStateRoot: profileRoot,
      workspaceRoot,
    })).toThrow('director_brain_manifest_mismatch')
  })

  it('fails closed when the installed transformer becomes group-writable', async () => {
    await chmod(join(workspaceRoot, 'skills', 'aiworker-task-flow',
      'scripts', 'project-director-evidence.mjs'), 0o620)
    expect(() => verifyInstalledReleasePayloads({
      repositoryRoot,
      profileStateRoot: profileRoot,
      workspaceRoot,
    })).toThrow('payload_writable_by_others')
  })

  it('is a mandatory gate for bootstrap and forward blue-green switch', () => {
    const deploy = readFileSync(join(repositoryRoot, 'scripts', 'deploy-blue-green.sh'), 'utf8')
    expect(deploy).toContain(
      'DIRECTOR_VIDEO_READINESS="$PROJECT_ROOT/scripts/verify-director-video-release-readiness.mjs"',
    )
    expect(deploy).toContain('verify_director_video_release_preflight')
    expect(deploy).toContain('--verification-phase pre-bootstrap')
    expect(deploy).toContain('--verification-phase full')
    expect(deploy).toContain('verify_director_video_release_chain "$release_id" "$physical_root"')
    expect(deploy).toContain('if [[ "$mode" == switch ]]; then')
    expect(deploy).toContain(
      'target_verified_contract="$(verify_director_video_release_chain',
    )
    expect(deploy).toContain(
      '[[ "$target_verified_contract" == "$target_projection_contract" ]]',
    )
    expect(deploy).toContain(
      'verify_captured_transition_release_evidence "$source_evidence"',
    )
    expect(deploy).not.toContain(
      'verify_director_video_release_chain "$source_release"',
    )
    expect(deploy).toContain('--live-db-path "$LIVE_DB_PATH"')
    expect(deploy).toContain('sessionScopedRuntimeConvergence')
    const verifier = readFileSync(
      join(repositoryRoot, 'scripts', 'verify-director-video-release-readiness.mjs'),
      'utf8',
    )
    expect(verifier).toContain('video-autoworker-director-video-preflight/v1')
    expect(verifier).toContain("options.verificationPhase === 'pre-bootstrap'")
  })

  it('returns only an authenticated projection digest from the full verifier report', async () => {
    const digest = 'a'.repeat(64)
    const verifierPath = join(root, 'fake-release-verifier.mjs')
    const harnessPath = join(root, 'release-verifier-report-harness.sh')
    const deploy = readFileSync(join(repositoryRoot, 'scripts', 'deploy-blue-green.sh'), 'utf8')
    const functionPrelude = deploy.slice(0, deploy.indexOf('\ncommand="${1:-}"'))
    const report = {
      schema: 'video-autoworker-director-video-readiness/v1',
      ok: true,
      commit: 'b'.repeat(40),
      app: { releaseId: 'bbbbbbb-runtime' },
      payloads: { projectionContract: { currentDigest: digest } },
      provenance: {
        schema: 'video-autoworker-standalone-provenance/v2',
        gitCommit: 'b'.repeat(40),
        sourceFiles: 23,
        sha256: 'e'.repeat(64),
        artifactContent: {
          schema: 'video-autoworker-standalone-artifact-content/v1',
          algorithm: 'sha256',
          digest: 'f'.repeat(64),
          directories: 12,
          files: 100,
          symlinks: 2,
        },
      },
      runtimeConvergence: {
        schema: 'video-autoworker-openclaw-runtime-convergence-proof/v1',
        sessionKeySha256: 'd'.repeat(64),
      },
      projectionOutbox: {
        currentDigest: digest,
        incompatiblePending: 0,
        deliveredWithoutValidReceipt: 0,
        outOfScopeOutbox: 0,
        outOfScopeExtraction: 0,
      },
      extraction: {
        schema: 'video-autoworker-director-extraction-readiness/v1',
        expectedProjectionVersion: 'feishu-candidate-projection-v2',
        activePhases: 0,
        sourcesWithoutPhase: 0,
        invalidPhaseBindings: 0,
        invalidCheckpoints: 0,
        invalidProjectionReceipts: 0,
        invalidReviewReceipts: 0,
        missingPredecessorReviews: 0,
        incompatibleProjectionBoundary: 0,
      },
      contracts: {
        directorWork: true,
        outboxClosure: true,
        extractionSourceProvenance: true,
        standaloneArtifactContentBound: true,
        projectionContractCompatible: true,
        extractionLifecycleComplete: true,
        sessionScopedRuntimeConvergence: true,
      },
    }
    await writeFile(verifierPath, `process.stdout.write(${JSON.stringify(JSON.stringify(report))})\n`)
    await writeFile(harnessPath, `${functionPrelude}
DIRECTOR_VIDEO_READINESS="$1"
verify_director_video_release_chain bbbbbbb-runtime /private/releases/bbbbbbb-runtime/standalone
`)
    const environment = { ...process.env, NODE_BIN: process.execPath }
    const accepted = spawnSync('bash', [harnessPath, verifierPath], {
      env: environment,
      encoding: 'utf8',
    })
    expect(accepted.status, accepted.stderr).toBe(0)
    expect(accepted.stdout).toBe(digest)

    report.projectionOutbox.currentDigest = 'c'.repeat(64)
    await writeFile(verifierPath, `process.stdout.write(${JSON.stringify(JSON.stringify(report))})\n`)
    const rejected = spawnSync('bash', [harnessPath, verifierPath], {
      env: environment,
      encoding: 'utf8',
    })
    expect(rejected.status).not.toBe(0)
    expect(rejected.stderr).toContain('release-readiness verifier returned an invalid report')

    report.projectionOutbox.currentDigest = digest
    report.projectionOutbox.outOfScopeExtraction = 1
    await writeFile(verifierPath, `process.stdout.write(${JSON.stringify(JSON.stringify(report))})\n`)
    const scopeRejected = spawnSync('bash', [harnessPath, verifierPath], {
      env: environment,
      encoding: 'utf8',
    })
    expect(scopeRejected.status).not.toBe(0)
    expect(scopeRejected.stderr).toContain('release-readiness verifier returned an invalid report')
  })

  it('binds a standalone manifest to the exact clean source commit and extraction closure', async () => {
    const gitRoot = join(root, 'provenance-source')
    const artifactRoot = join(root, 'provenance-artifact')
    await mkdir(gitRoot, { recursive: true, mode: 0o700 })
    await mkdir(artifactRoot, { recursive: true, mode: 0o700 })
    const git = (...args: string[]) => execFileSync('git', ['-C', gitRoot, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    git('init', '-b', 'main')
    git('config', 'user.name', 'Provenance Test')
    git('config', 'user.email', 'provenance-test@example.invalid')
    git('config', 'commit.gpgSign', 'false')
    for (const member of DIRECTOR_EXTRACTION_SOURCE_ROOTS) {
      await mkdir(dirname(join(gitRoot, member)), { recursive: true })
      await writeFile(join(gitRoot, member), `fixture:${member}\n`)
    }
    git('add', '.')
    git('commit', '-m', 'source closure')
    const commit = git('rev-parse', 'HEAD')

    writeProvenanceOnly(artifactRoot, gitRoot)
    await writeProvenanceOnlyManifest(artifactRoot)
    expect(verifyDirectorExtractionReleaseProvenance({
      repositoryRoot: gitRoot,
      releaseRoot: artifactRoot,
      commit,
    })).toMatchObject({
      gitCommit: commit,
      sourceFiles: DIRECTOR_EXTRACTION_SOURCE_ROOTS.length,
      artifactContent: {
        digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    })

    const releaseManifestPath = join(artifactRoot, 'release-manifest.json')
    const releaseManifestSource = readFileSync(releaseManifestPath, 'utf8')
    const releaseManifest = JSON.parse(releaseManifestSource)
    releaseManifest.artifactContent.digest = 'f'.repeat(64)
    await writeFile(releaseManifestPath, JSON.stringify(releaseManifest))
    expect(() => verifyDirectorExtractionReleaseProvenance({
      repositoryRoot: gitRoot,
      releaseRoot: artifactRoot,
      commit,
    })).toThrow('app_release_artifact_content_binding_invalid')
    await writeFile(releaseManifestPath, releaseManifestSource)

    await writeFile(join(gitRoot, 'src/lib/director-extraction-runs.ts'), 'stale drift\n')
    git('add', '.')
    git('commit', '-m', 'new source revision')
    const nextCommit = git('rev-parse', 'HEAD')
    expect(() => verifyDirectorExtractionReleaseProvenance({
      repositoryRoot: gitRoot,
      releaseRoot: artifactRoot,
      commit: nextCommit,
    })).toThrow('app_release_provenance_invalid')
  })

  it('derives the deterministic recursive closure and fails if a real transitive file is removed', async () => {
    const actual = sourceClosure(repositoryRoot)
    const paths = actual.files.map((item: { path: string }) => item.path)
    expect(paths).toEqual([...paths].sort())
    expect(paths).toEqual(expect.arrayContaining([
      'openclaw-plugins/aiworker-director-brain/lib/sensitive-narrative-text.js',
      'src/lib/command.ts',
      'src/lib/operational-errors.ts',
      'src/lib/auth.ts',
      'src/lib/n8n-base-url.ts',
    ]))

    const gitRoot = join(root, 'recursive-closure-source')
    await mkdir(gitRoot, { recursive: true, mode: 0o700 })
    for (const member of paths) {
      await mkdir(dirname(join(gitRoot, member)), { recursive: true })
      await cp(join(repositoryRoot, member), join(gitRoot, member))
    }
    const git = (...args: string[]) => execFileSync('git', ['-C', gitRoot, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    git('init', '-b', 'main')
    git('config', 'user.name', 'Recursive Closure Test')
    git('config', 'user.email', 'recursive-closure@example.invalid')
    git('config', 'commit.gpgSign', 'false')
    git('add', '.')
    git('commit', '-m', 'recursive source closure')
    const commit = git('rev-parse', 'HEAD')
    expect(sourceClosure(gitRoot)).toEqual(actual)
    expect(sourceClosureForGitCommit(gitRoot, commit)).toEqual(actual)

    const artifactRoot = join(root, 'recursive-closure-artifact')
    await mkdir(artifactRoot, { recursive: true, mode: 0o700 })
    writeProvenanceOnly(artifactRoot, gitRoot)
    await writeProvenanceOnlyManifest(artifactRoot)
    await writeFile(
      join(gitRoot, 'openclaw-plugins/aiworker-director-brain/lib/sensitive-narrative-text.js'),
      'export const containsSensitiveNarrativeValue = () => false\n',
    )
    git('add', '.')
    git('commit', '-m', 'drift sensitive narrative filter')
    const driftedCommit = git('rev-parse', 'HEAD')
    expect(() => verifyDirectorExtractionReleaseProvenance({
      repositoryRoot: gitRoot,
      releaseRoot: artifactRoot,
      commit: driftedCommit,
    })).toThrow('app_release_provenance_invalid')

    await rm(join(gitRoot, 'src/lib/n8n-base-url.ts'))
    expect(() => sourceClosure(gitRoot))
      .toThrow(/director_extraction_source_dependency_unresolved/u)
  })

  it('fails closed for unresolved and repository-escaping local imports', async () => {
    const fixtureRoot = join(root, 'invalid-recursive-closure')
    const entryPath = join(fixtureRoot, 'src/entry.ts')
    await mkdir(dirname(entryPath), { recursive: true, mode: 0o700 })
    await writeFile(entryPath, "import './missing'\n")
    expect(() => sourceClosure(fixtureRoot, ['src/entry.ts']))
      .toThrow(/director_extraction_source_dependency_unresolved/u)

    await writeFile(entryPath, "import '../../../outside'\n")
    expect(() => sourceClosure(fixtureRoot, ['src/entry.ts']))
      .toThrow(/director_extraction_source_path_outside_repository/u)
  })

  it('includes static dynamic-import, require, and createRequire dependencies', async () => {
    const fixtureRoot = join(root, 'loader-recursive-closure')
    await mkdir(join(fixtureRoot, 'src'), { recursive: true, mode: 0o700 })
    await writeFile(join(fixtureRoot, 'src/entry.ts'), `
      import { createRequire } from 'node:module'
      import './static'
      void import('./dynamic')
      require('./required')
      const localRequire = createRequire(import.meta.url)
      localRequire('./created')
    `)
    for (const name of ['static', 'dynamic', 'required', 'created']) {
      await writeFile(join(fixtureRoot, `src/${name}.ts`), `export const ${name} = true\n`)
    }
    expect(sourceClosure(fixtureRoot, ['src/entry.ts']).files.map(
      (item: { path: string }) => item.path,
    )).toEqual([
      'src/created.ts',
      'src/dynamic.ts',
      'src/entry.ts',
      'src/required.ts',
      'src/static.ts',
    ])

    await writeFile(join(fixtureRoot, 'src/entry.ts'), 'void import(runtimePath)\n')
    expect(() => sourceClosure(fixtureRoot, ['src/entry.ts']))
      .toThrow(/director_extraction_source_dynamic_dependency_unresolved/u)
  })

  it('marks a dirty local build as permanently ineligible for release readiness', async () => {
    const gitRoot = join(root, 'dirty-provenance-source')
    const artifactRoot = join(root, 'dirty-provenance-artifact')
    await mkdir(gitRoot, { recursive: true, mode: 0o700 })
    await mkdir(artifactRoot, { recursive: true, mode: 0o700 })
    const git = (...args: string[]) => execFileSync('git', ['-C', gitRoot, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    git('init', '-b', 'main')
    git('config', 'user.name', 'Dirty Build Test')
    git('config', 'user.email', 'dirty-build-test@example.invalid')
    git('config', 'commit.gpgSign', 'false')
    for (const member of DIRECTOR_EXTRACTION_SOURCE_ROOTS) {
      await mkdir(dirname(join(gitRoot, member)), { recursive: true })
      await writeFile(join(gitRoot, member), `fixture:${member}\n`)
    }
    git('add', '.')
    git('commit', '-m', 'clean source')
    const commit = git('rev-parse', 'HEAD')
    await writeFile(join(gitRoot, 'src/lib/director-extraction-service.ts'), 'dirty build\n')

    const provenance = writeProvenanceOnly(artifactRoot, gitRoot, 'allow-dirty')
    expect(provenance).toMatchObject({
      gitCommit: commit,
      gitDirty: true,
      buildSourceAnchor: { gitCommit: commit, gitDirty: true },
    })
    await writeProvenanceOnlyManifest(artifactRoot)
    expect(() => verifyDirectorExtractionReleaseProvenance({
      repositoryRoot: gitRoot,
      releaseRoot: artifactRoot,
      commit,
    })).toThrow('app_release_provenance_invalid')

    // Restoring a clean HEAD after a dirty build must not let a later standalone
    // sanitize step manufacture a release-eligible provenance record.
    await rm(join(gitRoot, 'src/lib/director-extraction-service.ts'))
    const postBuildProvenance = writeProvenanceOnly(artifactRoot, gitRoot, false)
    expect(postBuildProvenance).toMatchObject({ gitCommit: null, gitDirty: true })
    await writeProvenanceOnlyManifest(artifactRoot)
    expect(() => verifyDirectorExtractionReleaseProvenance({
      repositoryRoot: gitRoot,
      releaseRoot: artifactRoot,
      commit,
    })).toThrow('app_release_provenance_invalid')
  })

  it('accepts a clean ancestor release only in the delayed-retirement mode', async () => {
    const gitRoot = join(root, 'release-history')
    await mkdir(gitRoot, { mode: 0o700 })
    const git = (...args: string[]) => execFileSync('git', ['-C', gitRoot, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    git('init', '-b', 'main')
    git('config', 'user.name', 'Release Test')
    git('config', 'user.email', 'release-test@example.invalid')
    git('config', 'commit.gpgSign', 'false')
    git('remote', 'add', 'origin', 'https://github.com/MAKingljx/video-autoworker.git')
    await writeFile(join(gitRoot, 'runtime.txt'), 'runtime\n')
    git('add', 'runtime.txt')
    git('commit', '-m', 'runtime release')
    const releaseCommit = git('rev-parse', 'HEAD')
    await writeFile(join(gitRoot, 'operations.md'), 'docs-only audit\n')
    git('add', 'operations.md')
    git('commit', '-m', 'docs-only audit')

    const releaseId = `${releaseCommit.slice(0, 12)}-runtime`
    expect(assertRepositoryRelease(gitRoot, releaseId, 'ancestor')).toBe(releaseCommit)
    expect(() => assertRepositoryRelease(gitRoot, releaseId, 'head'))
      .toThrow('repository_release_mismatch')

    await writeFile(join(gitRoot, 'untracked.txt'), 'dirty\n')
    expect(() => assertRepositoryRelease(gitRoot, releaseId, 'ancestor'))
      .toThrow('repository_release_mismatch')
  })
})
