import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { fingerprintPluginPayload } from '../../../scripts/lib/aiworker-video-command-upgrade-policy.mjs'
import {
  validateRollbackBackupProvenance,
  validateTaskFlowRollbackBackup,
} from '../../../scripts/lib/aiworker-video-release-rollback-policy.mjs'

const execFileAsync = promisify(execFile)
const taskFlowInstaller = resolve(process.cwd(), 'scripts/install-aiworker-task-flow-skill.sh')
const roots = []

async function directory(pathname, mode = 0o700) {
  await mkdir(pathname, { recursive: true, mode })
}

async function file(pathname, contents, mode = 0o600) {
  await writeFile(pathname, contents, { mode })
}

async function git(repositoryRoot, ...args) {
  return (await execFileAsync('/usr/bin/git', ['-C', repositoryRoot, ...args])).stdout.trim()
}

async function provenanceFixture() {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'video-release-provenance.')))
  roots.push(temporary)
  const repositoryRoot = join(temporary, 'canonical-repo')
  const pluginSourcePath = join(repositoryRoot, 'openclaw-plugins', 'aiworker-video-command')
  await directory(pluginSourcePath)
  await execFileAsync('/usr/bin/git', ['init', '--quiet', repositoryRoot])
  await git(repositoryRoot, 'config', 'user.name', 'Release rollback test')
  await git(repositoryRoot, 'config', 'user.email', 'release-rollback@example.invalid')
  await file(join(pluginSourcePath, 'package.json'), '{"name":"aiworker-video-command","version":"0.3.0"}\n')
  await git(repositoryRoot, 'add', '--', 'openclaw-plugins')
  await git(repositoryRoot, 'commit', '--quiet', '-m', 'canonical plugin payload')
  const sourceCommit = await git(repositoryRoot, 'rev-parse', 'HEAD')
  const sourcePluginFingerprint = await fingerprintPluginPayload(pluginSourcePath)
  await directory(join(repositoryRoot, 'scripts'))
  await file(join(repositoryRoot, 'scripts', 'validator-only.mjs'), 'export const revision = 2\n')
  await git(repositoryRoot, 'add', '--', 'scripts/validator-only.mjs')
  await git(repositoryRoot, 'commit', '--quiet', '-m', 'validator-only fix')
  const approvedSha = await git(repositoryRoot, 'rev-parse', 'HEAD')
  return { repositoryRoot, pluginSourcePath, sourceCommit, approvedSha, sourcePluginFingerprint }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(pathname => rm(pathname, { recursive: true, force: true })))
})

describe('release rollback external policy regressions', () => {
  it('accepts the byte-ordered manifest from the real task-flow installer and rejects tampering', async () => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), 'video-release-task-backup.')))
    roots.push(temporary)
    const workspace = join(temporary, 'workspace')
    const backupRoot = join(temporary, 'task-backups')
    await directory(join(workspace, 'skills', 'aiworker-task-flow'))
    await file(join(workspace, 'skills', 'aiworker-task-flow', 'SKILL.md'), 'existing task flow\n')
    await file(join(workspace, 'AGENTS.md'), 'existing agents\n')
    await file(join(workspace, 'MEMORY.md'), 'existing memory\n')
    await execFileAsync('/bin/bash', [taskFlowInstaller], {
      env: {
        ...process.env,
        AIWORKER_NODE_BIN: process.execPath,
        AIWORKER_QWEN_WORKSPACE: workspace,
        AIWORKER_SKILL_BACKUP_ROOT: backupRoot,
      },
      maxBuffer: 4 * 1024 * 1024,
    })
    const backupNames = (await readdir(backupRoot))
      .filter(name => /^[0-9]{8}-[0-9]{6}\.[A-Za-z0-9]+$/u.test(name))
    expect(backupNames).toHaveLength(1)
    const backupDir = join(backupRoot, backupNames[0])
    await expect(validateTaskFlowRollbackBackup({ backupRoot, backupDir })).resolves.toMatchObject({
      state: { skill_present: true, agents_present: true, memory_present: true },
    })
    await file(join(backupDir, 'AGENTS.md'), 'tampered after installer verification\n')
    await expect(validateTaskFlowRollbackBackup({ backupRoot, backupDir }))
      .rejects.toThrow(/manifest does not match/u)
  }, 30_000)

  it('accepts a parent source commit when the target changes only validator code', async () => {
    const value = await provenanceFixture()
    await expect(validateRollbackBackupProvenance(value)).resolves.toMatchObject({
      sourceCommit: value.sourceCommit,
      sourceCommitRelation: 'ancestor',
      approvedSha: value.approvedSha,
    })
  })

  it('rejects an existing unrelated source commit and a missing commit object', async () => {
    const value = await provenanceFixture()
    const emptyTree = await git(value.repositoryRoot, 'hash-object', '-t', 'tree', '/dev/null')
    const unrelatedCommit = await git(value.repositoryRoot, 'commit-tree', emptyTree, '-m', 'unrelated root')
    await expect(validateRollbackBackupProvenance({
      ...value,
      sourceCommit: unrelatedCommit,
    })).rejects.toThrow(/not the approved target or its ancestor/u)
    await expect(validateRollbackBackupProvenance({
      ...value,
      sourceCommit: 'f'.repeat(40),
    })).rejects.toThrow(/Backup source commit object is missing/u)
  })

  it('rejects canonical plugin payload drift after a validator-only target commit', async () => {
    const value = await provenanceFixture()
    await file(join(value.pluginSourcePath, 'package.json'), '{"name":"aiworker-video-command","version":"0.3.1"}\n')
    await expect(validateRollbackBackupProvenance(value))
      .rejects.toThrow(/no longer matches the rollback backup payload fingerprint/u)
  })
})
