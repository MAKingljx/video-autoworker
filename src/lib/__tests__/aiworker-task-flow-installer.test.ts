import { execFile } from 'node:child_process'
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const repositoryRoot = process.cwd()
const installer = resolve(repositoryRoot, 'scripts/install-aiworker-task-flow-skill.sh')
const rendererUrl = pathToFileURL(resolve(
  repositoryRoot,
  'scripts/lib/render-managed-markdown-section.mjs',
)).href

type InstallerResult = { stdout: string; stderr: string }

function runInstaller(
  workspace: string,
  backupRoot: string,
  extraEnv: Record<string, string> = {},
) {
  return new Promise<InstallerResult>((resolvePromise, rejectPromise) => {
    execFile('bash', [installer], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        AIWORKER_NODE_BIN: process.execPath,
        AIWORKER_QWEN_WORKSPACE: workspace,
        AIWORKER_SKILL_BACKUP_ROOT: backupRoot,
        ...extraEnv,
      },
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      if (error) {
        rejectPromise(Object.assign(error, { stdout, stderr }))
        return
      }
      resolvePromise({ stdout, stderr })
    })
  })
}

async function pathExists(path: string) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function createExistingInstallation(workspace: string) {
  const target = resolve(workspace, 'skills/aiworker-task-flow')
  await mkdir(target, { recursive: true })
  await writeFile(resolve(target, 'original.txt'), 'original skill\n')
  await writeFile(resolve(workspace, 'AGENTS.md'), [
    '# Workspace Rules',
    '',
    'Keep agents prefix.',
    '',
    '## Video Learning Pipeline Rule',
    '',
    'retired rule',
    '',
    '# Preserve Agents Root',
    '',
    'Keep agents suffix.',
    '',
  ].join('\n'))
  await writeFile(resolve(workspace, 'MEMORY.md'), [
    '# Workspace Memory',
    '',
    'Keep memory prefix.',
    '',
    '## Current AI-worker Video Analysis Memory',
    '',
    'stale memory',
    '',
    '## Preserve Memory Peer',
    '',
    'Keep memory suffix.',
    '',
  ].join('\n'))
  await chmod(resolve(workspace, 'AGENTS.md'), 0o640)
  await chmod(resolve(workspace, 'MEMORY.md'), 0o640)
}

describe('managed AI-worker workspace section renderer', () => {
  it.each([
    ['H1', '# Preserve Root'],
    ['H2', '## Preserve Peer'],
  ])('migrates one legacy section without consuming the following %s', async (_kind, boundary) => {
    const { renderManagedMarkdownSection } = await import(/* @vite-ignore */ rendererUrl) as {
      renderManagedMarkdownSection: (input: {
        current: string
        template: string
        sectionId: string
        legacyHeadings: string[]
      }) => string
    }
    const current = [
      '# Workspace',
      '',
      'prefix',
      '',
      '## Current AI-worker Video Analysis Memory',
      '',
      'old body',
      '',
      boundary,
      '',
      'suffix',
      '',
    ].join('\n')
    const template = '## Current AI-worker Video Analysis Memory\n\nnew body\n'
    const options = {
      current,
      template,
      sectionId: 'video-memory',
      legacyHeadings: ['## Current AI-worker Video Analysis Memory'],
    }

    const first = renderManagedMarkdownSection(options)
    const second = renderManagedMarkdownSection({ ...options, current: first })

    expect(first).toContain(`${boundary}\n\nsuffix`)
    expect(first).not.toContain('old body')
    expect(first.match(/<!-- aiworker-task-flow:video-memory:start -->/gu)).toHaveLength(1)
    expect(first.match(/^## Current AI-worker Video Analysis Memory$/gmu)).toHaveLength(1)
    expect(second).toBe(first)
  })

  it('fails closed for duplicate legacy headings or malformed managed markers', async () => {
    const { renderManagedMarkdownSection } = await import(/* @vite-ignore */ rendererUrl) as {
      renderManagedMarkdownSection: (input: {
        current: string
        template: string
        sectionId: string
        legacyHeadings: string[]
      }) => string
    }
    const base = {
      template: '## Video Analysis Task Flow Rule\n\nnew body\n',
      sectionId: 'video-rules',
      legacyHeadings: [
        '## Video Learning Pipeline Rule',
        '## Video Analysis Task Flow Rule',
      ],
    }

    expect(() => renderManagedMarkdownSection({
      ...base,
      current: '## Video Learning Pipeline Rule\nold\n## Video Analysis Task Flow Rule\nother\n',
    })).toThrow(/at most once/u)
    expect(() => renderManagedMarkdownSection({
      ...base,
      current: '<!-- aiworker-task-flow:video-rules:start -->\nunterminated\n',
    })).toThrow(/exactly once/u)
  })
})

describe('transactional AI-worker task-flow installer', () => {
  it('backs up and installs all three objects, then performs a true content no-op', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'aiworker-task-flow-transaction-test-'))
    const workspace = resolve(root, 'workspace')
    const backupRoot = resolve(root, 'backups')
    try {
      await mkdir(workspace)
      await createExistingInstallation(workspace)

      const first = await runInstaller(workspace, backupRoot)
      const firstBackups = await readdir(backupRoot)
      const agentsAfterFirst = await readFile(resolve(workspace, 'AGENTS.md'), 'utf8')
      const memoryAfterFirst = await readFile(resolve(workspace, 'MEMORY.md'), 'utf8')

      expect(first.stdout).toContain('Installed AI-worker task-flow skill and workspace sections')
      expect(firstBackups).toHaveLength(1)
      expect(agentsAfterFirst).toContain('# Preserve Agents Root\n\nKeep agents suffix.')
      expect(memoryAfterFirst).toContain('## Preserve Memory Peer\n\nKeep memory suffix.')
      expect(agentsAfterFirst.match(/<!-- aiworker-task-flow:video-rules:start -->/gu)).toHaveLength(1)
      expect(memoryAfterFirst.match(/<!-- aiworker-task-flow:video-memory:start -->/gu)).toHaveLength(1)
      expect(await pathExists(resolve(
        workspace,
        'skills/aiworker-task-flow/lib/video-command.mjs',
      ))).toBe(true)
      expect((await stat(resolve(workspace, 'AGENTS.md'))).mode & 0o777).toBe(0o600)
      expect((await stat(resolve(workspace, 'MEMORY.md'))).mode & 0o777).toBe(0o600)

      const backup = resolve(backupRoot, firstBackups[0])
      expect((await stat(backup)).mode & 0o777).toBe(0o700)
      expect(await readFile(resolve(backup, 'AGENTS.md'), 'utf8')).toContain('retired rule')
      expect(await readFile(resolve(backup, 'MEMORY.md'), 'utf8')).toContain('stale memory')
      expect(await readFile(resolve(backup, 'STATE'), 'utf8')).toBe(
        'version=1\nskill_present=1\nagents_present=1\nmemory_present=1\n',
      )
      const backupManifest = await readFile(resolve(backup, 'MANIFEST.sha256'), 'utf8')
      expect(backupManifest).toMatch(/^\.\tdirectory\t700\t-/mu)
      expect(backupManifest).toMatch(/^\.\/AGENTS\.md\tfile\t640\t[a-f0-9]{64}$/mu)
      expect(backupManifest).toMatch(/^\.\/MEMORY\.md\tfile\t640\t[a-f0-9]{64}$/mu)

      const second = await runInstaller(workspace, backupRoot)
      expect(second.stdout).toContain('already current')
      expect(await readdir(backupRoot)).toEqual(firstBackups)
      expect(await readFile(resolve(workspace, 'AGENTS.md'), 'utf8')).toBe(agentsAfterFirst)
      expect(await readFile(resolve(workspace, 'MEMORY.md'), 'utf8')).toBe(memoryAfterFirst)
      expect((await readdir(workspace)).filter(name => name.includes('.aiworker-task-flow'))).toEqual([])

      const installedSkill = resolve(workspace, 'skills/aiworker-task-flow/SKILL.md')
      await chmod(installedSkill, 0o777)
      const modeRepair = await runInstaller(workspace, backupRoot)
      expect(modeRepair.stdout).toContain('Installed AI-worker task-flow skill and workspace sections')
      expect((await readdir(backupRoot))).toHaveLength(2)
      expect((await stat(installedSkill)).mode & 0o777).toBe(0o600)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails closed before a third changed install when two verified backups already exist', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'aiworker-task-flow-retention-test-'))
    const workspace = resolve(root, 'workspace')
    const backupRoot = resolve(root, 'backups')
    const legacyBackup = resolve(backupRoot, '20200101-000002.OLD001')
    const malformedBackup = resolve(backupRoot, '20200101-000000.BAD001')
    const linkedBackup = resolve(backupRoot, '20200101-000001.BAD002')
    try {
      await mkdir(workspace)
      await createExistingInstallation(workspace)
      await mkdir(legacyBackup, { recursive: true })
      await writeFile(resolve(legacyBackup, 'sentinel.txt'), 'legacy backup\n')
      await mkdir(malformedBackup)
      await chmod(malformedBackup, 0o700)
      await writeFile(
        resolve(malformedBackup, 'MANIFEST.sha256'),
        '.\tdirectory\t700\t-\n',
        { mode: 0o600 },
      )
      await symlink(legacyBackup, linkedBackup, 'dir')
      const preexistingBackups = new Set(await readdir(backupRoot))
      const generatedBackups = async () => (await readdir(backupRoot))
        .filter(name => !preexistingBackups.has(name))
        .sort()

      await runInstaller(workspace, backupRoot)
      expect(await generatedBackups()).toHaveLength(1)

      const installedSkill = resolve(workspace, 'skills/aiworker-task-flow/SKILL.md')
      await writeFile(installedSkill, 'second distinct installed skill state\n')
      await runInstaller(workspace, backupRoot)
      expect(await generatedBackups()).toHaveLength(2)

      await writeFile(installedSkill, 'third distinct installed skill state\n')
      const skillBeforeThird = await readFile(installedSkill, 'utf8')
      const agentsBeforeThird = await readFile(resolve(workspace, 'AGENTS.md'), 'utf8')
      const memoryBeforeThird = await readFile(resolve(workspace, 'MEMORY.md'), 'utf8')
      const backupsBeforeThird = (await readdir(backupRoot)).sort()

      await expect(runInstaller(workspace, backupRoot)).rejects.toMatchObject({
        stderr: expect.stringContaining('archive one explicitly'),
      })

      expect(await readFile(installedSkill, 'utf8')).toBe(skillBeforeThird)
      expect(await readFile(resolve(workspace, 'AGENTS.md'), 'utf8')).toBe(agentsBeforeThird)
      expect(await readFile(resolve(workspace, 'MEMORY.md'), 'utf8')).toBe(memoryBeforeThird)
      expect(await generatedBackups()).toHaveLength(2)
      expect((await readdir(backupRoot)).sort()).toEqual(backupsBeforeThird)
      expect(await readFile(resolve(legacyBackup, 'sentinel.txt'), 'utf8')).toBe('legacy backup\n')
      expect(await readFile(resolve(malformedBackup, 'MANIFEST.sha256'), 'utf8')).toBe(
        '.\tdirectory\t700\t-\n',
      )
      expect((await lstat(linkedBackup)).isSymbolicLink()).toBe(true)
      expect((await readdir(workspace)).filter(name => name.includes('.aiworker-task-flow'))).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    'after-skill-original',
    'after-skill',
    'after-agents-original',
    'after-agents',
    'after-memory-original',
    'after-memory',
  ])(
    'restores all existing objects after the %s failpoint',
    async (failpoint) => {
      const root = await mkdtemp(resolve(tmpdir(), 'aiworker-task-flow-rollback-test-'))
      const workspace = resolve(root, 'workspace')
      const backupRoot = resolve(root, 'backups')
      try {
        await mkdir(workspace)
        await createExistingInstallation(workspace)
        const originalSkill = await readFile(resolve(
          workspace,
          'skills/aiworker-task-flow/original.txt',
        ), 'utf8')
        const originalAgents = await readFile(resolve(workspace, 'AGENTS.md'), 'utf8')
        const originalMemory = await readFile(resolve(workspace, 'MEMORY.md'), 'utf8')
        const originalAgentsMode = (await stat(resolve(workspace, 'AGENTS.md'))).mode & 0o777
        const originalMemoryMode = (await stat(resolve(workspace, 'MEMORY.md'))).mode & 0o777

        await expect(runInstaller(workspace, backupRoot, {
          AIWORKER_TASK_FLOW_INSTALL_TESTING: '1',
          AIWORKER_TASK_FLOW_INSTALL_TEST_FAILPOINT: failpoint,
        })).rejects.toThrow()

        expect(await readFile(resolve(
          workspace,
          'skills/aiworker-task-flow/original.txt',
        ), 'utf8')).toBe(originalSkill)
        expect(await readFile(resolve(workspace, 'AGENTS.md'), 'utf8')).toBe(originalAgents)
        expect(await readFile(resolve(workspace, 'MEMORY.md'), 'utf8')).toBe(originalMemory)
        expect((await stat(resolve(workspace, 'AGENTS.md'))).mode & 0o777).toBe(originalAgentsMode)
        expect((await stat(resolve(workspace, 'MEMORY.md'))).mode & 0o777).toBe(originalMemoryMode)
        expect((await readdir(workspace)).filter(name => name.includes('.aiworker-task-flow'))).toEqual([])
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  it('removes only transaction-created objects when an initially empty workspace rolls back', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'aiworker-task-flow-absent-rollback-test-'))
    const workspace = resolve(root, 'workspace')
    const backupRoot = resolve(root, 'backups')
    try {
      await mkdir(workspace)
      await expect(runInstaller(workspace, backupRoot, {
        AIWORKER_TASK_FLOW_INSTALL_TESTING: '1',
        AIWORKER_TASK_FLOW_INSTALL_TEST_FAILPOINT: 'after-memory',
      })).rejects.toThrow()

      expect(await pathExists(resolve(workspace, 'skills'))).toBe(false)
      expect(await pathExists(resolve(workspace, 'AGENTS.md'))).toBe(false)
      expect(await pathExists(resolve(workspace, 'MEMORY.md'))).toBe(false)
      expect((await readdir(workspace)).filter(name => name.includes('.aiworker-task-flow'))).toEqual([])
      const backup = resolve(backupRoot, (await readdir(backupRoot))[0])
      expect(await readFile(resolve(backup, 'STATE'), 'utf8')).toBe(
        'version=1\nskill_present=0\nagents_present=0\nmemory_present=0\n',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails before mutation when the lock or managed-section preflight is invalid', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'aiworker-task-flow-preflight-test-'))
    const lockedWorkspace = resolve(root, 'locked-workspace')
    const malformedWorkspace = resolve(root, 'malformed-workspace')
    try {
      await mkdir(resolve(lockedWorkspace, '.aiworker-task-flow-install.lock'), { recursive: true })
      await writeFile(resolve(lockedWorkspace, 'AGENTS.md'), 'locked sentinel\n')
      await expect(runInstaller(lockedWorkspace, resolve(root, 'locked-backups'))).rejects.toThrow()
      expect(await readFile(resolve(lockedWorkspace, 'AGENTS.md'), 'utf8')).toBe('locked sentinel\n')
      expect(await pathExists(resolve(root, 'locked-backups'))).toBe(false)

      await mkdir(malformedWorkspace)
      await writeFile(resolve(malformedWorkspace, 'AGENTS.md'), [
        '## Video Learning Pipeline Rule',
        'old one',
        '## Video Analysis Task Flow Rule',
        'old two',
        '',
      ].join('\n'))
      const malformedAgents = await readFile(resolve(malformedWorkspace, 'AGENTS.md'), 'utf8')
      await expect(runInstaller(malformedWorkspace, resolve(root, 'malformed-backups'))).rejects.toThrow()
      expect(await readFile(resolve(malformedWorkspace, 'AGENTS.md'), 'utf8')).toBe(malformedAgents)
      expect(await pathExists(resolve(root, 'malformed-backups'))).toBe(false)
      expect((await readdir(malformedWorkspace)).filter(name => name.includes('.aiworker-task-flow'))).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('requires the installed parser module and rejects unguarded failure injection', async () => {
    const script = await readFile(installer, 'utf8')
    expect(script).toContain('"$SOURCE_DIR/lib/video-command.mjs"')

    const root = await mkdtemp(resolve(tmpdir(), 'aiworker-task-flow-failpoint-guard-test-'))
    const workspace = resolve(root, 'workspace')
    try {
      await mkdir(workspace)
      await expect(runInstaller(workspace, resolve(root, 'backups'), {
        AIWORKER_TASK_FLOW_INSTALL_TEST_FAILPOINT: 'after-skill',
      })).rejects.toThrow()
      expect(await readdir(workspace)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
