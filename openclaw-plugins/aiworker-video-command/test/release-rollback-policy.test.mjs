import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertTaskFlowStateMatches,
  fingerprintAuditedPreviousPlugin,
  restoreTaskFlowState,
  snapshotTaskFlowState,
  validatePluginRollbackBackup,
  validateSafeEquivalentIndex,
  validateTaskFlowRollbackBackup,
} from '../../../scripts/lib/aiworker-video-release-rollback-policy.mjs'
import { fingerprintPluginPayload } from '../../../scripts/lib/aiworker-video-command-upgrade-policy.mjs'

const execFileAsync = promisify(execFile)
const taskFlowInstaller = resolve(process.cwd(), 'scripts/install-aiworker-task-flow-skill.sh')
const roots = []

async function directory(pathname, mode = 0o700) {
  await mkdir(pathname, { recursive: true, mode })
}

async function file(pathname, value, mode = 0o600) {
  await writeFile(pathname, typeof value === 'string' ? value : `${JSON.stringify(value)}\n`, { mode })
}

async function git(repositoryRoot, ...args) {
  return (await execFileAsync('git', ['-C', repositoryRoot, ...args])).stdout.trim()
}

async function fixture() {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'video-release-rollback-policy.')))
  roots.push(temporary)
  const pluginRoot = join(temporary, 'plugin-backups')
  const taskRoot = join(temporary, 'task-backups')
  const releaseRoot = join(temporary, 'release-transactions')
  const workspace = join(temporary, 'workspace')
  const installedPlugin = join(temporary, 'installed-plugin')
  const officialOpenClaw = join(temporary, 'official-openclaw')
  const repositoryRoot = join(temporary, 'canonical-repo')
  const pluginSource = join(repositoryRoot, 'openclaw-plugins', 'aiworker-video-command')
  await Promise.all([
    directory(pluginRoot),
    directory(taskRoot),
    directory(releaseRoot),
    directory(join(workspace, 'skills', 'aiworker-task-flow')),
    directory(installedPlugin),
    directory(officialOpenClaw),
    directory(pluginSource),
  ])
  await execFileAsync('git', ['init', '--quiet', repositoryRoot])
  await git(repositoryRoot, 'config', 'user.name', 'Release rollback test')
  await git(repositoryRoot, 'config', 'user.email', 'release-rollback@example.invalid')
  await file(join(pluginSource, 'package.json'), { name: 'aiworker-video-command', version: '0.3.0' })
  await file(join(pluginSource, 'openclaw.plugin.json'), {
    id: 'aiworker-video-command',
    activation: { onCapabilities: ['hook'] },
  })
  await file(join(pluginSource, 'index.js'), 'export default {}\n')
  await git(repositoryRoot, 'add', '--', 'openclaw-plugins')
  await git(repositoryRoot, 'commit', '--quiet', '-m', 'canonical plugin source')
  const sourceCommit = await git(repositoryRoot, 'rev-parse', 'HEAD')
  await directory(join(repositoryRoot, 'scripts'))
  await file(join(repositoryRoot, 'scripts', 'validator-only.mjs'), 'export const policyVersion = 2\n')
  await git(repositoryRoot, 'add', '--', 'scripts/validator-only.mjs')
  await git(repositoryRoot, 'commit', '--quiet', '-m', 'validator-only release fix')
  const targetSha = await git(repositoryRoot, 'rev-parse', 'HEAD')
  await file(join(officialOpenClaw, 'package.json'), { name: 'openclaw', version: '2026.7.1-2' })
  await file(join(workspace, 'skills', 'aiworker-task-flow', 'SKILL.md'), 'version 0.3\n')
  await file(join(workspace, 'AGENTS.md'), 'agents 0.3\n')
  await file(join(workspace, 'MEMORY.md'), 'memory 0.3\n')

  const tx = join(releaseRoot, 'rollback-20260810-010203.abcdef')
  await directory(tx)
  await snapshotTaskFlowState({ workspaceRoot: workspace, destination: join(tx, 'task-current') })
  const taskBackup = join(taskRoot, '20260810-010203.abcdef')
  await rename(join(tx, 'task-current'), taskBackup)
  await rm(tx, { recursive: true })
  await file(join(taskBackup, 'aiworker-task-flow', 'SKILL.md'), 'version 0.2\n')
  // Rebuild a valid 0.2 backup by snapshotting a temporary 0.2 workspace.
  const oldWorkspace = join(temporary, 'old-workspace')
  await directory(join(oldWorkspace, 'skills', 'aiworker-task-flow'))
  await file(join(oldWorkspace, 'skills', 'aiworker-task-flow', 'SKILL.md'), 'version 0.2\n')
  await file(join(oldWorkspace, 'AGENTS.md'), 'agents 0.2\n')
  await file(join(oldWorkspace, 'MEMORY.md'), 'memory 0.2\n')
  const tx2 = join(releaseRoot, 'rollback-20260810-010204.abcdef')
  await directory(tx2)
  await snapshotTaskFlowState({ workspaceRoot: oldWorkspace, destination: join(tx2, 'task-current') })
  await rm(taskBackup, { recursive: true })
  await rename(join(tx2, 'task-current'), taskBackup)
  await rm(tx2, { recursive: true })

  const pluginBackup = join(pluginRoot, 'upgrade-20260810-010203.abcdef')
  const previousPlugin = join(pluginBackup, 'previous-plugin')
  await directory(join(previousPlugin, 'node_modules'))
  await directory(join(installedPlugin, 'node_modules'))
  await symlink(officialOpenClaw, join(previousPlugin, 'node_modules', 'openclaw'))
  await symlink(officialOpenClaw, join(installedPlugin, 'node_modules', 'openclaw'))
  await file(join(previousPlugin, 'package.json'), { name: 'aiworker-video-command', version: '0.2.0' })
  await file(join(previousPlugin, 'openclaw.plugin.json'), {
    id: 'aiworker-video-command',
    activation: { onCapabilities: ['hook', 'tool'] },
    contracts: { tools: ['aiworker_analyze_video'] },
  })
  await file(join(installedPlugin, 'package.json'), { name: 'aiworker-video-command', version: '0.3.0' })
  await file(join(installedPlugin, 'openclaw.plugin.json'), {
    id: 'aiworker-video-command',
    activation: { onCapabilities: ['hook'] },
  })
  const previousPluginFingerprint = (await fingerprintAuditedPreviousPlugin(previousPlugin)).fingerprint
  const sourcePluginFingerprint = await fingerprintPluginPayload(pluginSource)
  for (const [name, value] of [
    ['.verified', ''],
    ['openclaw-current.json', '{}\n'],
    ['pre-0.2-openclaw.json', '{}\n'],
    ['pre-0.2-effective-tools.json', '{}\n'],
    ['current-0.2-effective-tools.json', '{}\n'],
    ['owner-sender-policy.json', '{}\n'],
    ['source-commit.txt', `${sourceCommit}\n`],
    ['source-plugin-payload-sha256.txt', `${sourcePluginFingerprint}\n`],
    ['previous-plugin-payload-sha256.txt', `${previousPluginFingerprint}\n`],
  ]) await file(join(pluginBackup, name), value)
  await file(join(pluginBackup, 'install-index-old.json'), {
    source: 'path',
    sourcePath: pluginSource,
    installPath: installedPlugin,
    version: '0.2.0',
    installedAt: '2026-08-10T01:02:03.000Z',
  })
  return {
    temporary,
    pluginRoot,
    pluginBackup,
    taskRoot,
    taskBackup,
    releaseRoot,
    workspace,
    installedPlugin,
    officialOpenClaw,
    repositoryRoot,
    pluginSource,
    sourceCommit,
    targetSha,
  }
}

function validateFixturePlugin(value, overrides = {}) {
  return validatePluginRollbackBackup({
    backupRoot: value.pluginRoot,
    backupDir: value.pluginBackup,
    approvedSha: value.targetSha,
    installedPluginPath: value.installedPlugin,
    repositoryRoot: value.repositoryRoot,
    pluginSourcePath: value.pluginSource,
    ...overrides,
  })
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(pathname => rm(pathname, { recursive: true, force: true })))
})

describe('release rollback policy', () => {
  it('accepts the byte-ordered manifest emitted by the real task-flow installer and rejects later tampering', async () => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), 'video-release-real-task-backup.')))
    roots.push(temporary)
    const workspace = join(temporary, 'workspace')
    const backupRoot = join(temporary, 'task-backups')
    await directory(workspace)
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
      backupDir,
      state: { skill_present: false, agents_present: true, memory_present: true },
    })

    await writeFile(join(backupDir, 'AGENTS.md'), 'tampered after installer verification\n')
    await expect(validateTaskFlowRollbackBackup({ backupRoot, backupDir }))
      .rejects.toThrow(/manifest does not match/u)
  }, 30_000)

  it('accepts only the explicit verified 0.2 plugin backup and exact task-flow manifest', async () => {
    const value = await fixture()
    const plugin = await validateFixturePlugin(value)
    const task = await validateTaskFlowRollbackBackup({
      backupRoot: value.taskRoot,
      backupDir: value.taskBackup,
    })
    expect(plugin.previousPlugin).toBe(join(value.pluginBackup, 'previous-plugin'))
    expect(plugin).toMatchObject({
      sourceCommit: value.sourceCommit,
      sourceCommitRelation: 'ancestor',
      approvedSha: value.targetSha,
    })
    expect(task.state).toEqual({ skill_present: true, agents_present: true, memory_present: true })
  })

  it('rejects an existing but unrelated backup source commit', async () => {
    const value = await fixture()
    const emptyTree = await git(value.repositoryRoot, 'hash-object', '-t', 'tree', '/dev/null')
    const unrelatedCommit = await git(value.repositoryRoot, 'commit-tree', emptyTree, '-m', 'unrelated root')
    await file(join(value.pluginBackup, 'source-commit.txt'), `${unrelatedCommit}\n`)
    await expect(validateFixturePlugin(value)).rejects.toThrow(/not the approved target or its ancestor/u)
  })

  it('rejects missing source or target commit objects', async () => {
    const value = await fixture()
    await file(join(value.pluginBackup, 'source-commit.txt'), `${'f'.repeat(40)}\n`)
    await expect(validateFixturePlugin(value)).rejects.toThrow(/Backup source commit object is missing/u)
    await file(join(value.pluginBackup, 'source-commit.txt'), `${value.sourceCommit}\n`)
    await expect(validateFixturePlugin(value, {
      approvedSha: 'e'.repeat(40),
    })).rejects.toThrow(/Approved target commit object is missing/u)
  })

  it('rejects canonical plugin source drift after a validator-only target commit', async () => {
    const value = await fixture()
    await file(join(value.pluginSource, 'index.js'), 'export default { drifted: true }\n')
    await expect(validateFixturePlugin(value)).rejects.toThrow(/no longer matches the rollback backup payload fingerprint/u)
  })

  it('allows only the official peer symlink and rejects a changed peer target', async () => {
    const value = await fixture()
    const otherOpenClaw = join(value.temporary, 'other-openclaw')
    await directory(otherOpenClaw)
    await file(join(otherOpenClaw, 'package.json'), { name: 'openclaw', version: '2026.7.1-2' })
    await rm(join(value.pluginBackup, 'previous-plugin', 'node_modules', 'openclaw'))
    await symlink(otherOpenClaw, join(value.pluginBackup, 'previous-plugin', 'node_modules', 'openclaw'))
    await expect(validateFixturePlugin(value)).rejects.toThrow(/OpenClaw peer link (?:text|target) changed/u)
  })

  it('rejects an ordinary previous-plugin file changed after the backup fingerprint', async () => {
    const value = await fixture()
    await file(join(value.pluginBackup, 'previous-plugin', 'index.js'), 'tampered after backup\n')
    await expect(validateFixturePlugin(value)).rejects.toThrow(/changed after its audited backup fingerprint/u)
  })

  it('rejects backup path escape and every task-flow symlink', async () => {
    const value = await fixture()
    await expect(validateFixturePlugin(value, {
      backupDir: value.temporary,
    })).rejects.toThrow(/direct child|mode 700/u)
    await symlink('/tmp', join(value.taskBackup, 'unsafe-link'))
    await expect(validateTaskFlowRollbackBackup({
      backupRoot: value.taskRoot,
      backupDir: value.taskBackup,
    })).rejects.toThrow(/Symlinks are forbidden/u)
  })

  it('restores skill, AGENTS, and MEMORY exactly from one task-flow state', async () => {
    const value = await fixture()
    await restoreTaskFlowState({
      workspaceRoot: value.workspace,
      stateDir: value.taskBackup,
      stagingRoot: join(value.workspace, '.aiworker-release-rollback.stage'),
    })
    await assertTaskFlowStateMatches({ workspaceRoot: value.workspace, stateDir: value.taskBackup })
    expect(await readFile(join(value.workspace, 'skills', 'aiworker-task-flow', 'SKILL.md'), 'utf8')).toBe('version 0.2\n')
    expect(await readFile(join(value.workspace, 'AGENTS.md'), 'utf8')).toBe('agents 0.2\n')
    expect(await readFile(join(value.workspace, 'MEMORY.md'), 'utf8')).toBe('memory 0.2\n')
  })

  it('labels the official active-backup index as safe semantic restoration', () => {
    const installedPluginPath = '/Users/example/.openclaw-qwen-current/extensions/aiworker-video-command'
    const expectedSourcePath = '/Users/example/ai-worker/backups/aiworker-video-command/upgrade-20260810-010203.abcdef/previous-plugin'
    const common = {
      source: 'path',
      installPath: installedPluginPath,
      version: '0.2.0',
      installedAt: '2026-08-10T01:02:03.000Z',
    }
    const result = validateSafeEquivalentIndex({
      oldIndex: { ...common, sourcePath: '/Users/example/repo/openclaw-plugins/aiworker-video-command' },
      currentIndex: { ...common, sourcePath: expectedSourcePath },
      expectedSourcePath,
      installedPluginPath,
    })
    expect(result.kind).toBe('safe-semantic-0.2-index-restoration')
    expect(result.byteIdentical).toBe(false)
  })
})
