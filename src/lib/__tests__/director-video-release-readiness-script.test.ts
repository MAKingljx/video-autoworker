import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmod, cp, mkdir, mkdtemp, readdir, realpath, rm, writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { directorEvidenceProjectionContractDigest } from '@/lib/director-evidence-outbox'

// The production verifier is a Node ESM script and opens SQLite read-only through the app dependency.
import {
  assertRepositoryRelease,
  inspectDirectorEvidenceOutboxCompatibility,
  verifyInstalledReleasePayloads,
} from '../../../scripts/verify-director-video-release-readiness.mjs'

const repositoryRoot = resolve(process.cwd())

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
    join(repositoryRoot, 'ops', 'feishu-director-brain', 'schema.json'),
    join(target, 'runtime', 'ops', 'feishu-director-brain', 'schema.json'),
  )
  for (const member of [
    'index.js', 'openclaw.plugin.json', 'package.json',
    'runtime/scripts/feishu-director-brain.mjs',
    'runtime/scripts/lib/feishu-director-brain.mjs',
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
    expect(result.directorBrain).toMatchObject({ version: '0.3.1' })
    expect(result.taskFlow.files).toBeGreaterThan(3)
    expect(Object.keys(result.closure)).toHaveLength(7)
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

  it('reports and distinguishes pending rows from incompatible pending projection contracts', () => {
    const payloads = verifyInstalledReleasePayloads({
      repositoryRoot,
      profileStateRoot: profileRoot,
      workspaceRoot,
    })
    const databasePath = join(root, 'n8n.sqlite')
    const database = new Database(databasePath)
    try {
      database.exec(`
        CREATE TABLE n8n_director_evidence_outbox (
          task_id TEXT PRIMARY KEY,
          projection_contract_digest TEXT NOT NULL,
          status TEXT NOT NULL
        );
      `)
      database.prepare(`
        INSERT INTO n8n_director_evidence_outbox
          (task_id, projection_contract_digest, status)
        VALUES (?, ?, 'pending'), (?, ?, 'pending'), (?, ?, 'delivered')
      `).run(
        'compatible', payloads.projectionContract.currentDigest,
        'incompatible', 'f'.repeat(64),
        'delivered-old', 'e'.repeat(64),
      )
    } finally {
      database.close()
    }

    expect(inspectDirectorEvidenceOutboxCompatibility({
      repositoryRoot,
      liveDbPath: databasePath,
      currentDigest: payloads.projectionContract.currentDigest,
    })).toEqual({
      schema: 'video-autoworker-director-evidence-outbox-readiness/v1',
      currentDigest: payloads.projectionContract.currentDigest,
      pending: 2,
      incompatiblePending: 1,
    })
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
      projectionOutbox: { currentDigest: digest, incompatiblePending: 0 },
      contracts: {
        directorWork: true,
        outboxClosure: true,
        projectionContractCompatible: true,
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
