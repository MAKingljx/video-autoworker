import { execFile } from 'node:child_process'
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import Database from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const sourceRepository = process.cwd()
let installerRepository = ''
let installer = resolve(sourceRepository, 'scripts/install-aiworker-director-brain.sh')
let commandFixtureRoot = ''
let fakeCommandBin = ''
let fakeOpenClawCallLog = ''

type FakeOpenClawCall = {
  argv: string[]
  configPath: string
  stateDir: string
  activeConfigPath: string
  staging: boolean
}

type InstallerProfile = {
  agents: {
    list: Array<{
      id?: string
      workspace?: string
    }>
  }
}

async function exists(pathname: string) {
  return access(pathname).then(() => true, () => false)
}

async function waitForPath(pathname: string, attempts = 400) {
  for (let attempt = 0; attempt < attempts && !await exists(pathname); attempt += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 10))
  }
  expect(await exists(pathname)).toBe(true)
}

async function initializeGitRepository(pathname: string) {
  await mkdir(pathname, { recursive: true })
  await execFileAsync('git', ['init', '--quiet', pathname], { encoding: 'utf8' })
}

async function initializeCleanInstallerRepository() {
  installerRepository = await mkdtemp(resolve(tmpdir(), 'director-brain-installer-source-'))
  const sources = [
    'package.json',
    'openclaw-plugins/aiworker-director-brain',
    'openclaw-skills/aiworker-director-brain',
    'ops/feishu-director-brain/schema.json',
    'scripts/install-aiworker-director-brain.sh',
    'scripts/feishu-director-brain.mjs',
    'scripts/verify-shared-runtime-install-gate.mjs',
    'scripts/lib/feishu-director-brain.mjs',
    'scripts/lib/runtime-safe-offline-queue.mjs',
    'scripts/lib/sensitive-value-scanner.mjs',
    'scripts/lib/shared-deployment-lock.mjs',
    'scripts/lib/shared-deployment-lock.sh',
  ]
  for (const relative of sources) {
    const destination = resolve(installerRepository, relative)
    await mkdir(resolve(destination, '..'), { recursive: true })
    await cp(resolve(sourceRepository, relative), destination, { recursive: true })
  }
  await execFileAsync('git', ['init', '--quiet', installerRepository], { encoding: 'utf8' })
  await execFileAsync('git', ['-C', installerRepository, 'add', '.'], { encoding: 'utf8' })
  await execFileAsync('git', [
    '-C', installerRepository,
    '-c', 'user.name=installer-test',
    '-c', 'user.email=installer-test@example.invalid',
    'commit', '--quiet', '-m', 'isolated installer fixture',
  ], { encoding: 'utf8' })
  await writeFile(resolve(installerRepository, '.git/info/exclude'), 'node_modules\n')
  await symlink(resolve(sourceRepository, 'node_modules'), resolve(installerRepository, 'node_modules'))
  installer = resolve(installerRepository, 'scripts/install-aiworker-director-brain.sh')
}

async function initializeFakeOpenClaw() {
  commandFixtureRoot = await mkdtemp(resolve(tmpdir(), 'director-brain-installer-commands-'))
  fakeCommandBin = resolve(commandFixtureRoot, 'bin')
  fakeOpenClawCallLog = resolve(commandFixtureRoot, 'openclaw-calls.ndjson')
  await mkdir(fakeCommandBin, { mode: 0o700 })
  await writeFile(fakeOpenClawCallLog, '', { mode: 0o600 })
  const fakeOpenClaw = resolve(fakeCommandBin, 'openclaw')
  await writeFile(fakeOpenClaw, `#!${process.execPath}
const fs = require('node:fs')
const path = require('node:path')

const argv = process.argv.slice(2)
const callLog = process.env.AIWORKER_TEST_OPENCLAW_CALL_LOG
const configPath = process.env.OPENCLAW_CONFIG_PATH
const stateDir = process.env.OPENCLAW_STATE_DIR
if (argv.length !== 3 || argv[0] !== 'config' || argv[1] !== 'validate' || argv[2] !== '--json') {
  process.exit(91)
}
if (!callLog || !path.isAbsolute(callLog)
  || !configPath || !path.isAbsolute(configPath)
  || !stateDir || !path.isAbsolute(stateDir)
  || !fs.statSync(stateDir).isDirectory()
  || !fs.statSync(configPath).isFile()) {
  process.exit(92)
}
JSON.parse(fs.readFileSync(configPath, 'utf8'))
const activeConfigPath = path.join(stateDir, 'openclaw.json')
const staging = path.resolve(configPath) !== path.resolve(activeConfigPath)
fs.appendFileSync(callLog, JSON.stringify({
  argv,
  configPath,
  stateDir,
  activeConfigPath,
  staging,
}) + '\\n')
if (!staging) process.exit(93)
if (process.env.AIWORKER_TEST_OPENCLAW_VALIDATE_FAIL === '1') process.exit(94)
process.stdout.write('{"valid":true}\\n')
`, { mode: 0o755 })
  await chmod(fakeOpenClaw, 0o755)
}

async function resetFakeOpenClawCalls() {
  await writeFile(fakeOpenClawCallLog, '', { mode: 0o600 })
}

async function readFakeOpenClawCalls(): Promise<FakeOpenClawCall[]> {
  const source = await readFile(fakeOpenClawCallLog, 'utf8')
  return source.trim().length === 0
    ? []
    : source.trim().split('\n').map(line => JSON.parse(line) as FakeOpenClawCall)
}

function expectOfficialStagingValidation(calls: FakeOpenClawCall[], expectedCount: number) {
  expect(calls).toHaveLength(expectedCount)
  for (const call of calls) {
    expect(call.argv).toEqual(['config', 'validate', '--json'])
    expect(call.configPath).not.toBe(call.activeConfigPath)
    expect(call.staging).toBe(true)
  }
}

function installerTestEnvironment(
  environment: Partial<NodeJS.ProcessEnv> = {},
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AIWORKER_TEST_OPENCLAW_CALL_LOG: fakeOpenClawCallLog,
    ...environment,
    PATH: [
      fakeCommandBin,
      dirname(process.execPath),
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    ].join(delimiter),
  }
}

beforeAll(async () => {
  await initializeCleanInstallerRepository()
  await initializeFakeOpenClaw()
})

afterAll(async () => {
  if (installerRepository) await rm(installerRepository, { recursive: true, force: true })
  if (commandFixtureRoot) await rm(commandFixtureRoot, { recursive: true, force: true })
})

async function createFixture(root: string) {
  await mkdir(root, { recursive: true })
  const stateDir = resolve(root, 'state')
  const workspace = resolve(root, 'workspace')
  const backupRoot = resolve(root, 'backups')
  const liveDbPath = resolve(root, 'mission-control.db')
  const n8nDbPath = resolve(root, 'n8n.sqlite')
  const deploymentRunDir = resolve(await realpath(root), 'blue-green-run')
  const videoBatchRoot = resolve(root, 'video-batches')
  await mkdir(resolve(stateDir, 'extensions/aiworker-director-brain'), { recursive: true })
  await mkdir(resolve(workspace, 'skills/aiworker-director-brain'), { recursive: true })
  await writeFile(resolve(stateDir, 'extensions/aiworker-director-brain/old.txt'), 'old plugin\n')
  await writeFile(resolve(workspace, 'skills/aiworker-director-brain/old.txt'), 'old skill\n')
  await chmod(resolve(stateDir, 'extensions/aiworker-director-brain/old.txt'), 0o640)
  await chmod(resolve(workspace, 'skills/aiworker-director-brain/old.txt'), 0o644)
  await writeFile(resolve(stateDir, 'openclaw.json'), JSON.stringify({
    plugins: {
      allow: ['memory-core'],
      entries: { 'memory-core': { enabled: true } },
    },
    agents: {
      list: [
        { id: 'dev', workspace },
        { id: 'other' },
      ],
    },
  }, null, 2) + '\n')
  const database = new Database(liveDbPath)
  database.exec(`
    CREATE TABLE n8n_intake_controls (
      control_id INTEGER PRIMARY KEY,
      accepting INTEGER NOT NULL,
      revision INTEGER NOT NULL
    );
    INSERT INTO n8n_intake_controls VALUES (1, 0, 1);
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
  database.close()
  await chmod(liveDbPath, 0o600)
  const n8n = new Database(n8nDbPath)
  n8n.exec(`
    CREATE TABLE execution_entity (
      id INTEGER PRIMARY KEY,
      status TEXT NOT NULL,
      "stoppedAt" INTEGER
    );
  `)
  n8n.close()
  await chmod(n8nDbPath, 0o600)
  await mkdir(videoBatchRoot, { mode: 0o700 })
  return {
    stateDir,
    workspace,
    backupRoot,
    liveDbPath: await realpath(liveDbPath),
    n8nDbPath: await realpath(n8nDbPath),
    deploymentRunDir,
    videoBatchRoot: await realpath(videoBatchRoot),
  }
}

async function runInstaller(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  mode: '--dry-run' | '--apply' | '--rollback',
  extra: string[] = [],
  environment: Partial<NodeJS.ProcessEnv> = {},
) {
  return execFileAsync('bash', [
    installer,
    mode,
    '--profile', 'dev-test',
    '--state-dir', fixture.stateDir,
    '--workspace', fixture.workspace,
    '--agent', 'dev',
    '--backup-root', fixture.backupRoot,
    ...extra,
  ], {
    env: installerTestEnvironment({
      AIWORKER_BG_RUN_DIR: fixture.deploymentRunDir,
      AIWORKER_BG_LIVE_DB_PATH: fixture.liveDbPath,
      AIWORKER_BG_N8N_DB_PATH: fixture.n8nDbPath,
      AIWORKER_VIDEO_BATCH_DIR: fixture.videoBatchRoot,
      ...environment,
    }),
    encoding: 'utf8',
  })
}

describe('transactional director-brain OpenClaw installer', () => {
  it('does not create a backup while the shared deployment lock is held', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'director-brain-deployment-lock-'))
    try {
      const fixture = await createFixture(root)
      const deploymentLockDir = resolve(fixture.deploymentRunDir, '.deployment.lock')
      await mkdir(deploymentLockDir, {
        recursive: true,
        mode: 0o700,
      })
      await writeFile(resolve(deploymentLockDir, 'pid'), `${JSON.stringify({
        schema: 'video-autoworker-shared-deployment-lock-owner/v1',
        pid: process.pid,
        nonce: 'a'.repeat(64),
        createdAt: new Date().toISOString(),
      })}\n`, { mode: 0o600 })
      await chmod(fixture.deploymentRunDir, 0o700)
      await expect(runInstaller(fixture, '--apply')).rejects.toThrow()
      expect(await exists(fixture.backupRoot)).toBe(false)
      expect(await readFile(resolve(fixture.stateDir, 'extensions/aiworker-director-brain/old.txt'), 'utf8'))
        .toBe('old plugin\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it('requires an explicit mode, profile, state directory, and workspace', async () => {
    await expect(execFileAsync('bash', [installer, '--dry-run'], {
      encoding: 'utf8',
      env: installerTestEnvironment(),
    }))
      .rejects.toMatchObject({ code: 2 })
    const script = await readFile(installer, 'utf8')
    expect(script).not.toMatch(/\bssh\b|\bscp\b|gateway restart|launchctl|sqlite3|n8n-import/iu)
    expect(script).not.toContain('test-catalog.json" "$plugin_destination')
  })

  it('rejects a dirty canonical source before creating a rollback point', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'director-brain-installer-dirty-source-'))
    const dirtySource = resolve(installerRepository, 'untracked-installer-input.txt')
    try {
      const fixture = await createFixture(root)
      await writeFile(dirtySource, 'untracked\n')

      await expect(runInstaller(fixture, '--apply'))
        .rejects.toThrow(/source Git worktree is not clean/u)

      expect(await exists(fixture.backupRoot)).toBe(false)
      expect(await readFile(resolve(
        fixture.stateDir,
        'extensions/aiworker-director-brain/old.txt',
      ), 'utf8')).toBe('old plugin\n')
    } finally {
      await rm(dirtySource, { force: true })
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects filesystem root, HOME, and repository root as managed paths', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'director-brain-installer-broad-path-'))
    try {
      const fixture = await createFixture(root)
      const home = process.env.HOME
      expect(home).toBeTruthy()
      const base = [installer, '--dry-run', '--profile', 'dev-test', '--agent', 'dev']
      const attempts = [
        ['--state-dir', '/', '--workspace', fixture.workspace, '--backup-root', fixture.backupRoot],
        ['--state-dir', fixture.stateDir, '--workspace', home!, '--backup-root', fixture.backupRoot],
        ['--state-dir', fixture.stateDir, '--workspace', fixture.workspace, '--backup-root', home!],
        [
          '--state-dir', fixture.stateDir,
          '--workspace', fixture.workspace,
          '--backup-root', installerRepository,
        ],
      ]
      for (const attempt of attempts) {
        await expect(execFileAsync('bash', [...base, ...attempt], {
          encoding: 'utf8',
          env: installerTestEnvironment(),
        }))
          .rejects.toThrow(/overly broad directory/u)
      }
      expect(await exists(fixture.backupRoot)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects state and backup locations inside physical Git worktrees before copying a profile', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'director-brain-installer-git-boundary-'))
    try {
      const stateOuterRepo = resolve(root, 'state-outer-repo')
      const stateNestedRepo = resolve(stateOuterRepo, 'nested-repo')
      await initializeGitRepository(stateOuterRepo)
      await initializeGitRepository(stateNestedRepo)
      const stateFixture = await createFixture(resolve(stateNestedRepo, 'fixture'))
      await expect(runInstaller(stateFixture, '--apply'))
        .rejects.toThrow(/state directory must be outside every Git worktree/u)
      expect(await exists(stateFixture.backupRoot)).toBe(false)

      const backupFixture = await createFixture(resolve(root, 'backup-fixture'))
      const backupRepo = resolve(root, 'backup-repo')
      await initializeGitRepository(backupRepo)
      const backupInRepo = {
        ...backupFixture,
        backupRoot: resolve(backupRepo, 'descendant/backups'),
      }
      await expect(runInstaller(backupInRepo, '--apply'))
        .rejects.toThrow(/Backup root must be outside every Git worktree/u)
      expect(await exists(backupInRepo.backupRoot)).toBe(false)

      const symlinkFixture = await createFixture(resolve(root, 'symlink-fixture'))
      const linkedRepo = resolve(root, 'linked-repo')
      const repoLink = resolve(root, 'repo-link')
      await initializeGitRepository(linkedRepo)
      await symlink(linkedRepo, repoLink)
      const backupThroughSymlink = {
        ...symlinkFixture,
        backupRoot: resolve(repoLink, 'descendant/backups'),
      }
      await expect(runInstaller(backupThroughSymlink, '--apply'))
        .rejects.toThrow(/Backup root must be outside every Git worktree/u)
      expect(await exists(resolve(linkedRepo, 'descendant/backups'))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('clears Git discovery overrides and fails closed on repository probe errors', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'director-brain-installer-git-environment-'))
    try {
      const repository = resolve(root, 'repository')
      const poisonedHome = resolve(root, 'poisoned-home')
      const poisonedXdg = resolve(root, 'poisoned-xdg')
      const poisonedGlobal = resolve(root, 'poisoned-global.gitconfig')
      const poisonedSystem = resolve(root, 'poisoned-system.gitconfig')
      await initializeGitRepository(repository)
      await mkdir(poisonedHome)
      await mkdir(poisonedXdg)
      await writeFile(resolve(poisonedHome, '.gitconfig'), '[core]\n\tbare = true\n')
      await writeFile(poisonedGlobal, '[core]\n\tbare = true\n')
      await writeFile(poisonedSystem, '[core]\n\tbare = true\n')
      const fixture = await createFixture(resolve(repository, 'fixture'))
      await expect(runInstaller(fixture, '--apply', [], {
        GIT_DIR: resolve(root, 'attacker.git'),
        GIT_WORK_TREE: root,
        GIT_CEILING_DIRECTORIES: repository,
        GIT_COMMON_DIR: resolve(root, 'attacker-common.git'),
        GIT_INDEX_FILE: resolve(root, 'attacker.index'),
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.bare',
        GIT_CONFIG_VALUE_0: 'true',
        GIT_CONFIG_PARAMETERS: "'core.bare'='true'",
        GIT_CONFIG_GLOBAL: poisonedGlobal,
        GIT_CONFIG_SYSTEM: poisonedSystem,
        HOME: poisonedHome,
        XDG_CONFIG_HOME: poisonedXdg,
      })).rejects.toThrow(/state directory must be outside every Git worktree/u)
      expect(await exists(fixture.backupRoot)).toBe(false)

      const externalGitDir = resolve(root, 'external.git')
      await execFileAsync('git', ['init', '--bare', '--quiet', externalGitDir], { encoding: 'utf8' })
      const gitfileFixture = await createFixture(resolve(root, 'gitfile-fixture'))
      await writeFile(resolve(gitfileFixture.stateDir, '.git'), `gitdir: ${externalGitDir}\n`)
      await expect(runInstaller(gitfileFixture, '--apply', [], {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.bare',
        GIT_CONFIG_VALUE_0: 'true',
        GIT_CONFIG_GLOBAL: poisonedGlobal,
        GIT_CONFIG_SYSTEM: poisonedSystem,
        HOME: poisonedHome,
        XDG_CONFIG_HOME: poisonedXdg,
      })).rejects.toThrow(/state directory must be outside every Git worktree/u)
      expect(await exists(gitfileFixture.backupRoot)).toBe(false)

      const invalidFixture = await createFixture(resolve(root, 'invalid-git-fixture'))
      await writeFile(resolve(invalidFixture.stateDir, '.git'), 'invalid gitfile\n')
      await expect(runInstaller(invalidFixture, '--apply'))
        .rejects.toThrow(/Unable to verify the Git boundary for OpenClaw state directory/u)
      expect(await exists(invalidFixture.backupRoot)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a missing backup ancestor replaced by a Git-worktree symlink before profile copy', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'director-brain-installer-backup-swap-'))
    try {
      const fixture = await createFixture(resolve(root, 'fixture'))
      const syncDir = resolve(root, 'sync')
      const backupParent = resolve(root, 'backup-parent')
      const missingAncestor = resolve(backupParent, 'missing')
      const gitTarget = resolve(root, 'git-target')
      await mkdir(syncDir)
      await mkdir(backupParent)
      await initializeGitRepository(gitTarget)
      const swappedFixture = {
        ...fixture,
        backupRoot: resolve(missingAncestor, 'backups'),
      }

      const installAttempt = runInstaller(swappedFixture, '--apply', [], {
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TESTING: '1',
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TEST_FAILPOINT: 'backup-root-ancestor-swap',
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TEST_SYNC_DIR: syncDir,
      })
      await waitForPath(resolve(syncDir, 'prelock-ready'), 5_000)
      await writeFile(resolve(syncDir, 'prelock-continue'), 'continue\n')
      await waitForPath(resolve(syncDir, 'backup-root-ready'))
      await symlink(gitTarget, missingAncestor)
      await writeFile(resolve(syncDir, 'backup-root-continue'), 'continue\n')

      await expect(installAttempt).rejects.toThrow(/backup_root_component_invalid/u)
      expect(await exists(resolve(gitTarget, 'backups'))).toBe(false)
      expect(await exists(resolve(gitTarget, 'openclaw.json'))).toBe(false)
      expect(await readFile(resolve(fixture.stateDir, 'openclaw.json'), 'utf8'))
        .not.toContain('aiworker-director-brain')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it('dry-runs without changing the profile, workspace, or backup root', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'director-brain-installer-dry-'))
    try {
      const fixture = await createFixture(root)
      const configBefore = await readFile(resolve(fixture.stateDir, 'openclaw.json'), 'utf8')
      await resetFakeOpenClawCalls()
      const result = await runInstaller(fixture, '--dry-run')

      expect(result.stdout).toContain('installation dry-run passed')
      expectOfficialStagingValidation(await readFakeOpenClawCalls(), 1)
      expect(await readFile(resolve(fixture.stateDir, 'openclaw.json'), 'utf8')).toBe(configBefore)
      expect(await readFile(resolve(fixture.stateDir, 'extensions/aiworker-director-brain/old.txt'), 'utf8'))
        .toBe('old plugin\n')
      expect(await readFile(resolve(fixture.workspace, 'skills/aiworker-director-brain/old.txt'), 'utf8'))
        .toBe('old skill\n')
      expect(await exists(fixture.backupRoot)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    {
      name: 'missing target agent',
      expected: /target_agent_missing/u,
      mutate: (config: InstallerProfile) => {
        config.agents.list = config.agents.list.filter((agent: { id?: string }) => agent.id !== 'dev')
      },
    },
    {
      name: 'ambiguous target agent',
      expected: /target_agent_ambiguous/u,
      mutate: (config: InstallerProfile, workspace: string) => {
        config.agents.list.push({ id: 'dev', workspace })
      },
    },
    {
      name: 'missing target workspace',
      expected: /target_agent_workspace_missing/u,
      mutate: (config: InstallerProfile) => {
        delete config.agents.list[0].workspace
      },
    },
    {
      name: 'mismatched target workspace',
      expected: /target_agent_workspace_mismatch/u,
      mutate: (config: InstallerProfile, workspace: string) => {
        config.agents.list[0].workspace = resolve(workspace, 'different')
      },
    },
  ])('fails closed before mutation when the profile has a $name', async ({ expected, mutate }) => {
    const root = await mkdtemp(resolve(tmpdir(), 'director-brain-installer-workspace-'))
    try {
      const fixture = await createFixture(root)
      const configPath = resolve(fixture.stateDir, 'openclaw.json')
      const config = JSON.parse(await readFile(configPath, 'utf8')) as InstallerProfile
      mutate(config, fixture.workspace)
      if (config.agents.list[0]?.workspace?.endsWith('/different')) {
        await mkdir(config.agents.list[0].workspace)
      }
      await writeFile(configPath, JSON.stringify(config, null, 2) + '\n')
      await chmod(configPath, 0o600)
      const configBefore = await readFile(configPath, 'utf8')

      await expect(runInstaller(fixture, '--apply')).rejects.toThrow(expected)

      expect(await readFile(configPath, 'utf8')).toBe(configBefore)
      expect(await readFile(resolve(
        fixture.stateDir,
        'extensions/aiworker-director-brain/old.txt',
      ), 'utf8')).toBe('old plugin\n')
      expect(await readFile(resolve(
        fixture.workspace,
        'skills/aiworker-director-brain/old.txt',
      ), 'utf8')).toBe('old skill\n')
      expect(await exists(fixture.backupRoot)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('preserves discovery mode when the profile did not already have an allowlist', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'director-brain-installer-trust-'))
    try {
      const fixture = await createFixture(root)
      const configPath = resolve(fixture.stateDir, 'openclaw.json')
      const config = JSON.parse(await readFile(configPath, 'utf8'))
      delete config.plugins.allow
      await writeFile(configPath, JSON.stringify(config, null, 2) + '\n')
      await chmod(configPath, 0o600)

      await runInstaller(fixture, '--apply')
      const installed = JSON.parse(await readFile(configPath, 'utf8'))
      expect(installed.plugins.allow).toBeUndefined()
      expect(installed.plugins.entries['memory-core']).toEqual({ enabled: true })
      expect(installed.plugins.entries['aiworker-director-brain']).toEqual({
        enabled: true,
        hooks: { allowConversationAccess: true },
        config: { releaseReady: true, targetAgentId: 'dev' },
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it('keeps an enabled plugin excluded when an existing allowlist excludes it', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'director-brain-installer-existing-trust-'))
    try {
      const fixture = await createFixture(root)
      const configPath = resolve(fixture.stateDir, 'openclaw.json')
      const config = JSON.parse(await readFile(configPath, 'utf8'))
      config.plugins.entries['excluded-but-enabled'] = { enabled: true }
      await writeFile(configPath, JSON.stringify(config, null, 2) + '\n')
      await chmod(configPath, 0o600)

      await runInstaller(fixture, '--apply')
      const installed = JSON.parse(await readFile(configPath, 'utf8'))
      expect(installed.plugins.allow).toEqual([
        'memory-core',
        'aiworker-director-brain',
      ])
      expect(installed.plugins.entries['excluded-but-enabled']).toEqual({ enabled: true })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it('installs plugin, shared runtime, Skill, and a narrow agent grant, then becomes a no-op', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'director-brain-installer-apply-'))
    try {
      const fixture = await createFixture(root)
      await resetFakeOpenClawCalls()
      const first = await runInstaller(fixture, '--apply')
      const backups = await readdir(fixture.backupRoot)

      expect(first.stdout).toContain('Installed director-brain plugin, private shared runtime, and Skill')
      expect(first.stdout).toContain('Gateway was not restarted')
      expectOfficialStagingValidation(await readFakeOpenClawCalls(), 2)
      expect(backups).toHaveLength(1)
      expect(await exists(resolve(
        fixture.stateDir,
        'extensions/aiworker-director-brain/runtime/scripts/feishu-director-brain.mjs',
      ))).toBe(true)
      expect(await exists(resolve(
        fixture.stateDir,
        'extensions/aiworker-director-brain/runtime/scripts/lib/feishu-director-brain.mjs',
      ))).toBe(true)
      expect(await exists(resolve(
        fixture.stateDir,
        'extensions/aiworker-director-brain/runtime/scripts/lib/sensitive-value-scanner.mjs',
      ))).toBe(true)
      expect(await exists(resolve(
        fixture.stateDir,
        'extensions/aiworker-director-brain/runtime/ops/feishu-director-brain/schema.json',
      ))).toBe(true)
      expect(await readFile(resolve(
        fixture.stateDir,
        'extensions/aiworker-director-brain/lib/director-context-summary.js',
      ), 'utf8')).toContain('buildDirectorContextSummary')
      expect(await readFile(resolve(
        fixture.stateDir,
        'extensions/aiworker-director-brain/lib/sensitive-narrative-text.js',
      ), 'utf8')).toContain('containsSensitiveNarrativeValue')
      expect(await readFile(resolve(
        fixture.stateDir,
        'extensions/aiworker-director-brain/lib/transcript-tool-result-projection.js',
      ), 'utf8')).toContain('projectAiworkerMessageForTargetAgent')
      expect((await readdir(resolve(
        fixture.stateDir,
        'extensions/aiworker-director-brain/lib',
      ))).toSorted()).toEqual([
        'director-brain-tool.js',
        'director-context-summary.js',
        'director-system-question-router.js',
        'sensitive-narrative-text.js',
        'transcript-tool-result-projection.js',
      ])
      expect(await exists(resolve(
        fixture.workspace,
        'skills/aiworker-director-brain/SKILL.md',
      ))).toBe(true)
      expect(await exists(resolve(
        fixture.stateDir,
        'extensions/aiworker-director-brain/test',
      ))).toBe(false)

      const config = JSON.parse(await readFile(resolve(fixture.stateDir, 'openclaw.json'), 'utf8'))
      expect(config.plugins.allow).toEqual(['memory-core', 'aiworker-director-brain'])
      expect(config.plugins.entries['aiworker-director-brain']).toEqual({
        enabled: true,
        hooks: { allowConversationAccess: true },
        config: { releaseReady: true, targetAgentId: 'dev' },
      })
      expect(config.agents.list[0].tools.alsoAllow).toEqual(['aiworker_director_brain'])
      expect(config.agents.list[1].tools).toBeUndefined()
      expect((await stat(resolve(fixture.stateDir, 'openclaw.json'))).mode & 0o777).toBe(0o600)

      const second = await runInstaller(fixture, '--apply')
      expect(second.stdout).toContain('already current')
      expectOfficialStagingValidation(await readFakeOpenClawCalls(), 4)
      expect(await readdir(fixture.backupRoot)).toEqual(backups)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it('preserves an intentionally non-production tool and compaction fixture across install and rollback', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'director-brain-installer-composed-policy-'))
    try {
      const fixture = await createFixture(root)
      const configPath = resolve(fixture.stateDir, 'openclaw.json')
      const config = JSON.parse(await readFile(configPath, 'utf8'))
      // This counterexample proves the plugin installer does not own runtime
      // convergence. It is deliberately different from the production policy.
      config.agents.defaults = {
        compaction: {
          model: 'qwen36-tools-local/default_model',
          mode: 'safeguard',
          timeoutSeconds: 180,
          truncateAfterCompaction: true,
          maxActiveTranscriptBytes: 98304,
          midTurnPrecheck: { enabled: true },
        },
      }
      config.agents.list[0].tools = {
        profile: 'minimal',
        alsoAllow: ['aiworker_analyze_video'],
        deny: ['exec', 'process', 'read', 'write', 'edit', 'apply_patch'],
      }
      await writeFile(configPath, JSON.stringify(config, null, 2) + '\n')
      await chmod(configPath, 0o600)
      const original = await readFile(configPath, 'utf8')

      const applied = await runInstaller(fixture, '--apply')
      const backup = /Verified rollback point: (.+)$/mu.exec(applied.stdout)?.[1]
      expect(backup).toBeTruthy()

      const installed = JSON.parse(await readFile(configPath, 'utf8'))
      expect(installed.agents.defaults.compaction).toEqual(config.agents.defaults.compaction)
      expect(installed.agents.list[0].tools).toEqual({
        profile: 'minimal',
        alsoAllow: ['aiworker_analyze_video', 'aiworker_director_brain'],
        deny: ['exec', 'process', 'read', 'write', 'edit', 'apply_patch'],
      })

      await runInstaller(fixture, '--rollback', ['--backup', backup as string])
      expect(await readFile(configPath, 'utf8')).toBe(original)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it('fails closed when the official OpenClaw validator rejects the staging config', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'director-brain-installer-plugin-entry-'))
    try {
      const fixture = await createFixture(root)
      const configPath = resolve(fixture.stateDir, 'openclaw.json')
      const config = JSON.parse(await readFile(configPath, 'utf8'))
      config.plugins.entries['aiworker-director-brain'] = {
        enabled: false,
        futureTopLevel: { preserve: true },
        hooks: {
          allowConversationAccess: false,
          futureHookPolicy: 'preserve',
        },
        config: {
          releaseReady: false,
          targetAgentId: 'legacy-agent',
          futurePluginOption: 17,
        },
      }
      await writeFile(configPath, JSON.stringify(config, null, 2) + '\n')
      await chmod(configPath, 0o600)
      const original = await readFile(configPath, 'utf8')
      const originalPlugin = await readFile(resolve(
        fixture.stateDir,
        'extensions/aiworker-director-brain/old.txt',
      ), 'utf8')
      const originalSkill = await readFile(resolve(
        fixture.workspace,
        'skills/aiworker-director-brain/old.txt',
      ), 'utf8')
      await resetFakeOpenClawCalls()

      await expect(runInstaller(fixture, '--apply', [], {
        AIWORKER_TEST_OPENCLAW_VALIDATE_FAIL: '1',
      }))
        .rejects.toThrow(/Official OpenClaw staging config validation failed/u)

      expectOfficialStagingValidation(await readFakeOpenClawCalls(), 1)
      expect(await readFile(configPath, 'utf8')).toBe(original)
      expect(await readFile(resolve(
        fixture.stateDir,
        'extensions/aiworker-director-brain/old.txt',
      ), 'utf8')).toBe(originalPlugin)
      expect(await readFile(resolve(
        fixture.workspace,
        'skills/aiworker-director-brain/old.txt',
      ), 'utf8')).toBe(originalSkill)
      expect(await exists(fixture.backupRoot)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it('adds only its optional grant while preserving a complete nested tool policy', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'director-brain-installer-complete-tools-'))
    try {
      const fixture = await createFixture(root)
      const configPath = resolve(fixture.stateDir, 'openclaw.json')
      const config = JSON.parse(await readFile(configPath, 'utf8'))
      config.agents.list[0].tools = {
        profile: 'full',
        alsoAllow: ['aiworker_analyze_video'],
        deny: ['web_search'],
        byProvider: { qwen38: { profile: 'full', allow: ['read', 'exec'] } },
        toolsBySender: { trusted: { allow: ['exec', 'memory_search'] } },
        sandbox: { tools: { allow: ['read', 'write'] } },
        codeMode: true,
        exec: { host: 'gateway' },
        fs: { workspaceOnly: false },
        elevated: { enabled: true },
        loopDetection: { enabled: true, historySize: 24 },
      }
      await writeFile(configPath, JSON.stringify(config, null, 2) + '\n')
      await chmod(configPath, 0o600)
      const original = await readFile(configPath, 'utf8')

      const applied = await runInstaller(fixture, '--apply')
      const backup = /Verified rollback point: (.+)$/mu.exec(applied.stdout)?.[1]
      expect(backup).toBeTruthy()

      const installed = JSON.parse(await readFile(configPath, 'utf8'))
      expect(installed.agents.list[0].tools).toEqual({
        ...config.agents.list[0].tools,
        alsoAllow: [...config.agents.list[0].tools.alsoAllow, 'aiworker_director_brain'],
      })

      await runInstaller(fixture, '--rollback', ['--backup', backup as string])
      expect(await readFile(configPath, 'utf8')).toBe(original)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it('refuses to guess a capability-preserving migration for a legacy explicit allowlist', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'director-brain-installer-profile-expansion-'))
    try {
      const fixture = await createFixture(root)
      const configPath = resolve(fixture.stateDir, 'openclaw.json')
      const config = JSON.parse(await readFile(configPath, 'utf8'))
      config.agents.list[0].tools = {
        profile: 'coding',
        allow: ['read', 'aiworker_director_brain'],
      }
      await writeFile(configPath, JSON.stringify(config, null, 2) + '\n')
      await chmod(configPath, 0o600)
      const original = await readFile(configPath, 'utf8')

      await expect(runInstaller(fixture, '--apply'))
        .rejects.toThrow(/director_brain_explicit_allow_requires_capability_migration/u)
      expect(await readFile(configPath, 'utf8')).toBe(original)
      expect(await exists(fixture.backupRoot)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it('fails closed when the profile config drifts between preflight and lock acquisition', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'director-brain-installer-config-drift-'))
    try {
      const fixture = await createFixture(root)
      const syncDir = resolve(root, 'sync')
      const configPath = resolve(fixture.stateDir, 'openclaw.json')
      await mkdir(syncDir)

      const installAttempt = runInstaller(fixture, '--apply', [], {
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TESTING: '1',
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TEST_SYNC_DIR: syncDir,
      })

      const readyPath = resolve(syncDir, 'prelock-ready')
      for (let attempt = 0; attempt < 200 && !await exists(readyPath); attempt += 1) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 10))
      }
      expect(await exists(readyPath)).toBe(true)

      const concurrentConfig = JSON.parse(await readFile(configPath, 'utf8'))
      concurrentConfig.concurrentWriter = { preserved: true }
      const concurrentContents = JSON.stringify(concurrentConfig, null, 2) + '\n'
      await writeFile(configPath, concurrentContents)
      await chmod(configPath, 0o600)
      await writeFile(resolve(syncDir, 'prelock-continue'), 'continue\n')

      await expect(installAttempt).rejects.toThrow(/changed between preflight and the locked install/u)
      expect(await readFile(configPath, 'utf8')).toBe(concurrentContents)
      expect(await readFile(resolve(
        fixture.stateDir,
        'extensions/aiworker-director-brain/old.txt',
      ), 'utf8')).toBe('old plugin\n')
      expect(await readFile(resolve(
        fixture.workspace,
        'skills/aiworker-director-brain/old.txt',
      ), 'utf8')).toBe('old skill\n')
      expect(await exists(fixture.backupRoot)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it.each(['after-plugin', 'after-skill', 'after-config'])(
    'restores every managed object after the %s failpoint',
    async (failpoint) => {
      const root = await mkdtemp(resolve(tmpdir(), 'director-brain-installer-failure-'))
      try {
        const fixture = await createFixture(root)
        const configBefore = await readFile(resolve(fixture.stateDir, 'openclaw.json'), 'utf8')
        await expect(runInstaller(fixture, '--apply', [], {
          AIWORKER_DIRECTOR_BRAIN_INSTALL_TESTING: '1',
          AIWORKER_DIRECTOR_BRAIN_INSTALL_TEST_FAILPOINT: failpoint,
        })).rejects.toMatchObject({ code: 99 })

        expect(await readFile(resolve(fixture.stateDir, 'openclaw.json'), 'utf8')).toBe(configBefore)
        expect(await readFile(resolve(
          fixture.stateDir,
          'extensions/aiworker-director-brain/old.txt',
        ), 'utf8')).toBe('old plugin\n')
        expect(await readFile(resolve(
          fixture.workspace,
          'skills/aiworker-director-brain/old.txt',
        ), 'utf8')).toBe('old skill\n')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    15_000,
  )

  it.each([
    'plugin-old-move-failed',
    'plugin-new-move-failed',
    'skill-old-move-failed',
    'skill-new-move-failed',
    'config-old-move-failed',
    'config-new-move-failed',
  ])('does not delete the original installation when %s', async (failpoint) => {
    const root = await mkdtemp(resolve(tmpdir(), 'director-brain-installer-move-failure-'))
    try {
      const fixture = await createFixture(root)
      const configPath = resolve(fixture.stateDir, 'openclaw.json')
      const configBefore = await readFile(configPath, 'utf8')

      await expect(runInstaller(fixture, '--apply', [], {
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TESTING: '1',
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TEST_FAILPOINT: failpoint,
      })).rejects.toMatchObject({ code: 99 })

      expect(await readFile(configPath, 'utf8')).toBe(configBefore)
      expect(await readFile(resolve(
        fixture.stateDir,
        'extensions/aiworker-director-brain/old.txt',
      ), 'utf8')).toBe('old plugin\n')
      expect(await readFile(resolve(
        fixture.workspace,
        'skills/aiworker-director-brain/old.txt',
      ), 'utf8')).toBe('old skill\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it.each([
    'signal-after-plugin-old-move',
    'signal-after-plugin-new-move',
    'signal-after-skill-old-move',
    'signal-after-skill-new-move',
    'signal-after-config-old-move',
    'signal-after-config-new-move',
  ])('restores the original installation when TERM arrives at %s', async (failpoint) => {
    const root = await mkdtemp(resolve(tmpdir(), 'director-brain-installer-signal-'))
    try {
      const fixture = await createFixture(root)
      const configPath = resolve(fixture.stateDir, 'openclaw.json')
      const configBefore = await readFile(configPath, 'utf8')

      await expect(runInstaller(fixture, '--apply', [], {
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TESTING: '1',
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TEST_FAILPOINT: failpoint,
      })).rejects.toMatchObject({ code: 143 })

      expect(await readFile(configPath, 'utf8')).toBe(configBefore)
      expect(await readFile(resolve(
        fixture.stateDir,
        'extensions/aiworker-director-brain/old.txt',
      ), 'utf8')).toBe('old plugin\n')
      expect(await readFile(resolve(
        fixture.workspace,
        'skills/aiworker-director-brain/old.txt',
      ), 'utf8')).toBe('old skill\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it.each([
    'plugin-old-move-reported-failed',
    'plugin-new-move-reported-failed',
    'skill-old-move-reported-failed',
    'skill-new-move-reported-failed',
    'config-old-move-reported-failed',
    'config-new-move-reported-failed',
  ])('infers the completed move and restores the original installation when %s', async (failpoint) => {
    const root = await mkdtemp(resolve(tmpdir(), 'director-brain-installer-reported-failure-'))
    try {
      const fixture = await createFixture(root)
      const configPath = resolve(fixture.stateDir, 'openclaw.json')
      const configBefore = await readFile(configPath, 'utf8')

      await expect(runInstaller(fixture, '--apply', [], {
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TESTING: '1',
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TEST_FAILPOINT: failpoint,
      })).rejects.toMatchObject({ code: 99 })

      expect(await readFile(configPath, 'utf8')).toBe(configBefore)
      expect(await readFile(resolve(
        fixture.stateDir,
        'extensions/aiworker-director-brain/old.txt',
      ), 'utf8')).toBe('old plugin\n')
      expect(await readFile(resolve(
        fixture.workspace,
        'skills/aiworker-director-brain/old.txt',
      ), 'utf8')).toBe('old skill\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it('restores the verified backup and preserves a drifted previous config for inspection', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'director-brain-installer-previous-drift-'))
    try {
      const fixture = await createFixture(root)
      const configPath = resolve(fixture.stateDir, 'openclaw.json')
      const configBefore = await readFile(configPath, 'utf8')

      await expect(runInstaller(fixture, '--apply', [], {
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TESTING: '1',
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TEST_FAILPOINT: 'config-previous-drift',
      })).rejects.toThrow(/restoring the verified rollback copy/u)

      expect(await readFile(configPath, 'utf8')).toBe(configBefore)
      expect(await readFile(resolve(
        fixture.stateDir,
        'extensions/aiworker-director-brain/old.txt',
      ), 'utf8')).toBe('old plugin\n')
      expect(await readFile(resolve(
        fixture.workspace,
        'skills/aiworker-director-brain/old.txt',
      ), 'utf8')).toBe('old skill\n')

      const previousConfigs = (await readdir(fixture.stateDir))
        .filter((name) => name.startsWith('.openclaw.json.previous.'))
      expect(previousConfigs).toHaveLength(1)
      expect(await readFile(resolve(fixture.stateDir, previousConfigs[0]), 'utf8'))
        .toBe(`${configBefore}\n`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it('restores an update written through a descriptor opened before the config move', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'director-brain-installer-open-fd-'))
    let configHandle: Awaited<ReturnType<typeof open>> | null = null
    try {
      const fixture = await createFixture(root)
      const syncDir = resolve(root, 'sync')
      const configPath = resolve(fixture.stateDir, 'openclaw.json')
      const concurrentContents = '{"retained_descriptor_update":true}\n'
      await mkdir(syncDir)
      configHandle = await open(configPath, 'r+')

      const installAttempt = runInstaller(fixture, '--apply', [], {
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TESTING: '1',
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TEST_FAILPOINT: 'config-previous-open-fd',
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TEST_SYNC_DIR: syncDir,
      })

      const prelockReady = resolve(syncDir, 'prelock-ready')
      for (let attempt = 0; attempt < 200 && !await exists(prelockReady); attempt += 1) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 10))
      }
      expect(await exists(prelockReady)).toBe(true)
      await writeFile(resolve(syncDir, 'prelock-continue'), 'continue\n')

      const previousReady = resolve(syncDir, 'config-previous-ready')
      for (let attempt = 0; attempt < 400 && !await exists(previousReady); attempt += 1) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 10))
      }
      expect(await exists(previousReady)).toBe(true)
      await configHandle.truncate(0)
      await configHandle.writeFile(concurrentContents)
      await configHandle.sync()
      await writeFile(resolve(syncDir, 'config-previous-continue'), 'continue\n')

      await expect(installAttempt).rejects.toThrow(/retained file descriptor/u)
      expect(await readFile(configPath, 'utf8')).toBe(concurrentContents)
      expect((await readdir(fixture.stateDir)).filter(
        (name) => name.startsWith('.openclaw.json.previous.'),
      )).toEqual([])
      expect(await readFile(resolve(
        fixture.stateDir,
        'extensions/aiworker-director-brain/old.txt',
      ), 'utf8')).toBe('old plugin\n')
      expect(await readFile(resolve(
        fixture.workspace,
        'skills/aiworker-director-brain/old.txt',
      ), 'utf8')).toBe('old skill\n')
    } finally {
      await configHandle?.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it('retains a recoverable old inode when its open descriptor is written after final validation', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'director-brain-installer-postcheck-fd-'))
    let configHandle: Awaited<ReturnType<typeof open>> | null = null
    try {
      const fixture = await createFixture(root)
      const syncDir = resolve(root, 'sync')
      const configPath = resolve(fixture.stateDir, 'openclaw.json')
      const concurrentContents = '{"postcheck_retained_descriptor_update":true}\n'
      await mkdir(syncDir)
      configHandle = await open(configPath, 'r+')

      const installAttempt = runInstaller(fixture, '--apply', [], {
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TESTING: '1',
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TEST_FAILPOINT: 'config-previous-postcheck-open-fd',
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TEST_SYNC_DIR: syncDir,
      })

      const prelockReady = resolve(syncDir, 'prelock-ready')
      for (let attempt = 0; attempt < 200 && !await exists(prelockReady); attempt += 1) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 10))
      }
      expect(await exists(prelockReady)).toBe(true)
      await writeFile(resolve(syncDir, 'prelock-continue'), 'continue\n')

      const postcheckReady = resolve(syncDir, 'config-previous-postcheck-ready')
      for (let attempt = 0; attempt < 400 && !await exists(postcheckReady); attempt += 1) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 10))
      }
      expect(await exists(postcheckReady)).toBe(true)
      await configHandle.truncate(0)
      await configHandle.writeFile(concurrentContents)
      await configHandle.sync()
      await writeFile(resolve(syncDir, 'config-previous-postcheck-continue'), 'continue\n')

      const result = await installAttempt
      expect(result.stdout).toContain('Retained previous config inode for concurrent-writer recovery')
      expect(result.stdout).toContain('remove retired artifacts only after confirming every process')
      expect(result.stdout).toContain('may contain credentials')
      expect(result.stdout).toContain('never commit, archive, or upload them')
      const installedConfig = JSON.parse(await readFile(configPath, 'utf8'))
      expect(installedConfig.plugins.entries['aiworker-director-brain']).toMatchObject({ enabled: true })

      const retiredRoots = (await readdir(fixture.stateDir))
        .filter((name) => name.startsWith('.openclaw.json.retired.'))
      expect(retiredRoots).toHaveLength(1)
      expect(await readFile(resolve(fixture.stateDir, retiredRoots[0], 'openclaw.json'), 'utf8'))
        .toBe(concurrentContents)
      expect((await stat(resolve(fixture.stateDir, retiredRoots[0]))).mode & 0o777).toBe(0o700)
      expect((await stat(resolve(fixture.stateDir, retiredRoots[0], 'openclaw.json'))).mode & 0o777)
        .toBe(0o600)
      const retiredPlugins = (await readdir(resolve(fixture.stateDir, 'extensions')))
        .filter((name) => name.startsWith('.aiworker-director-brain.retired.'))
      const retiredSkills = (await readdir(resolve(fixture.workspace, 'skills')))
        .filter((name) => name.startsWith('.aiworker-director-brain.retired.'))
      expect(retiredPlugins).toHaveLength(1)
      expect(retiredSkills).toHaveLength(1)
      expect(await readFile(resolve(
        fixture.stateDir,
        'extensions',
        retiredPlugins[0],
        'payload/old.txt',
      ), 'utf8')).toBe('old plugin\n')
      expect(await readFile(resolve(
        fixture.workspace,
        'skills',
        retiredSkills[0],
        'payload/old.txt',
      ), 'utf8')).toBe('old skill\n')

      const script = await readFile(installer, 'utf8')
      const finalDigestIndex = script.lastIndexOf('"$(path_sha256 "$CONFIG_PREVIOUS")" != "$LOCKED_CONFIG_SHA256"')
      const barrierIndex = script.indexOf('config-previous-postcheck-ready')
      const retainIndex = script.indexOf('if ! retain_previous_config_inode; then')
      expect(barrierIndex).toBeGreaterThan(finalDigestIndex)
      expect(retainIndex).toBeGreaterThan(barrierIndex)
    } finally {
      await configHandle?.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it('rejects a previous-config symlink swap without chmod-following or losing rollback data', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'director-brain-installer-retain-symlink-'))
    try {
      const fixture = await createFixture(root)
      const syncDir = resolve(root, 'sync')
      const configPath = resolve(fixture.stateDir, 'openclaw.json')
      const configBefore = await readFile(configPath, 'utf8')
      const symlinkTarget = resolve(root, 'symlink-target.json')
      await mkdir(syncDir)
      await writeFile(symlinkTarget, '{"must_not_be_followed":true}\n')
      await chmod(symlinkTarget, 0o644)

      const installAttempt = runInstaller(fixture, '--apply', [], {
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TESTING: '1',
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TEST_FAILPOINT: 'config-retain-path-replace',
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TEST_SYNC_DIR: syncDir,
      })
      const prelockReady = resolve(syncDir, 'prelock-ready')
      for (let attempt = 0; attempt < 200 && !await exists(prelockReady); attempt += 1) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 10))
      }
      expect(await exists(prelockReady)).toBe(true)
      await writeFile(resolve(syncDir, 'prelock-continue'), 'continue\n')

      const retainReady = resolve(syncDir, 'config-retain-ready')
      for (let attempt = 0; attempt < 400 && !await exists(retainReady); attempt += 1) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 10))
      }
      expect(await exists(retainReady)).toBe(true)
      const previousName = (await readdir(fixture.stateDir))
        .find((name) => name.startsWith('.openclaw.json.previous.'))
      expect(previousName).toBeTruthy()
      const previousPath = resolve(fixture.stateDir, previousName!)
      const displacedPath = `${previousPath}.displaced`
      await rename(previousPath, displacedPath)
      await symlink(symlinkTarget, previousPath)
      await writeFile(resolve(syncDir, 'config-retain-continue'), 'continue\n')

      await expect(installAttempt).rejects.toThrow(/Unable to retain the previous profile config inode/u)
      expect(await readFile(configPath, 'utf8')).toBe(configBefore)
      expect((await lstat(previousPath)).isSymbolicLink()).toBe(true)
      expect(await readFile(symlinkTarget, 'utf8')).toBe('{"must_not_be_followed":true}\n')
      expect((await stat(symlinkTarget)).mode & 0o777).toBe(0o644)
      expect(await readFile(displacedPath, 'utf8')).toBe(configBefore)
      expect(await readFile(resolve(
        fixture.stateDir,
        'extensions/aiworker-director-brain/old.txt',
      ), 'utf8')).toBe('old plugin\n')
      expect(await readFile(resolve(
        fixture.workspace,
        'skills/aiworker-director-brain/old.txt',
      ), 'utf8')).toBe('old skill\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it('restores the safety backup when retained config mode verification fails after its move', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'director-brain-installer-retain-mode-drift-'))
    try {
      const fixture = await createFixture(root)
      const configPath = resolve(fixture.stateDir, 'openclaw.json')
      const configBefore = await readFile(configPath, 'utf8')

      await expect(runInstaller(fixture, '--apply', [], {
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TESTING: '1',
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TEST_FAILPOINT: 'config-retain-postmove-mode-drift',
      })).rejects.toThrow(/Unable to retain the previous profile config inode/u)

      expect(await readFile(configPath, 'utf8')).toBe(configBefore)
      expect((await stat(configPath)).mode & 0o777).toBe(0o600)
      const retiredRoots = (await readdir(fixture.stateDir))
        .filter((name) => name.startsWith('.openclaw.json.retired.'))
      expect(retiredRoots).toHaveLength(1)
      const failedArtifact = resolve(fixture.stateDir, retiredRoots[0], 'openclaw.json')
      expect(await readFile(failedArtifact, 'utf8')).toBe(configBefore)
      expect((await stat(failedArtifact)).mode & 0o777).toBe(0o640)
      expect((await stat(configPath)).ino).not.toBe((await stat(failedArtifact)).ino)
      expect(await readFile(resolve(
        fixture.stateDir,
        'extensions/aiworker-director-brain/old.txt',
      ), 'utf8')).toBe('old plugin\n')
      expect(await readFile(resolve(
        fixture.workspace,
        'skills/aiworker-director-brain/old.txt',
      ), 'utf8')).toBe('old skill\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it.each([
    ['signal-during-finalization', 143],
    ['plugin-retain-move-failed', 99],
  ])('rolls back every managed object when %s interrupts retained finalization', async (failpoint, code) => {
    const root = await mkdtemp(resolve(tmpdir(), 'director-brain-installer-finalization-'))
    try {
      const fixture = await createFixture(root)
      const configPath = resolve(fixture.stateDir, 'openclaw.json')
      const configBefore = await readFile(configPath, 'utf8')

      await expect(runInstaller(fixture, '--apply', [], {
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TESTING: '1',
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TEST_FAILPOINT: failpoint,
      })).rejects.toMatchObject({ code })

      expect(await readFile(configPath, 'utf8')).toBe(configBefore)
      expect(await readFile(resolve(
        fixture.stateDir,
        'extensions/aiworker-director-brain/old.txt',
      ), 'utf8')).toBe('old plugin\n')
      expect(await readFile(resolve(
        fixture.workspace,
        'skills/aiworker-director-brain/old.txt',
      ), 'utf8')).toBe('old skill\n')
      expect((await readdir(fixture.stateDir)).some(
        (name) => name.startsWith('.openclaw.json.retired.'),
      )).toBe(false)
      expect((await readdir(resolve(fixture.stateDir, 'extensions'))).some(
        (name) => name.startsWith('.aiworker-director-brain.retired.'),
      )).toBe(false)
      expect((await readdir(resolve(fixture.workspace, 'skills'))).some(
        (name) => name.startsWith('.aiworker-director-brain.retired.'),
      )).toBe(false)

      const script = await readFile(installer, 'utf8')
      expect(script).not.toContain('rm -rf -- "$PLUGIN_PREVIOUS" "$SKILL_PREVIOUS"')
      expect(script.indexOf('COMMIT_COMPLETE=1')).toBeGreaterThan(
        script.indexOf('SKILL_PREVIOUS="$SKILL_RETIRED_ARTIFACT"'),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it.each([
    ['plugin', 'plugin-retain-postcheck-failed'],
    ['skill', 'skill-retain-postcheck-failed'],
  ])('restores from the verified backup when retained %s verification fails after its move', async (
    kind,
    failpoint,
  ) => {
    const root = await mkdtemp(resolve(tmpdir(), `director-brain-installer-${kind}-retain-postcheck-`))
    try {
      const fixture = await createFixture(root)
      const configPath = resolve(fixture.stateDir, 'openclaw.json')
      const configBefore = await readFile(configPath, 'utf8')

      await expect(runInstaller(fixture, '--apply', [], {
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TESTING: '1',
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TEST_FAILPOINT: failpoint,
      })).rejects.toMatchObject({ code: 99 })

      expect(await readFile(configPath, 'utf8')).toBe(configBefore)
      expect(await readFile(resolve(
        fixture.stateDir,
        'extensions/aiworker-director-brain/old.txt',
      ), 'utf8')).toBe('old plugin\n')
      expect(await readFile(resolve(
        fixture.workspace,
        'skills/aiworker-director-brain/old.txt',
      ), 'utf8')).toBe('old skill\n')

      const retainedParent = kind === 'plugin'
        ? resolve(fixture.stateDir, 'extensions')
        : resolve(fixture.workspace, 'skills')
      const retainedTrees = (await readdir(retainedParent))
        .filter((name) => name.startsWith('.aiworker-director-brain.retired.'))
      expect(retainedTrees).toHaveLength(1)
      expect(await readFile(resolve(
        retainedParent,
        retainedTrees[0],
        'payload/old.txt',
      ), 'utf8')).toBe(kind === 'plugin' ? 'old plugin\n' : 'old skill\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it.each([
    ['plugin', 'plugin-active-replacement', 'plugin-active-ready', 'plugin-active-continue'],
    ['skill', 'skill-active-replacement', 'skill-active-ready', 'skill-active-continue'],
  ])('quarantines a concurrent %s replacement before restoring from the verified backup', async (
    kind,
    failpoint,
    readyName,
    continueName,
  ) => {
    const root = await mkdtemp(resolve(tmpdir(), `director-brain-installer-${kind}-replacement-`))
    try {
      const fixture = await createFixture(root)
      const syncDir = resolve(root, 'sync')
      await mkdir(syncDir)
      const target = kind === 'plugin'
        ? resolve(fixture.stateDir, 'extensions/aiworker-director-brain')
        : resolve(fixture.workspace, 'skills/aiworker-director-brain')
      const targetParent = kind === 'plugin'
        ? resolve(fixture.stateDir, 'extensions')
        : resolve(fixture.workspace, 'skills')
      const displaced = `${target}.concurrent-displaced`

      const installAttempt = runInstaller(fixture, '--apply', [], {
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TESTING: '1',
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TEST_FAILPOINT: failpoint,
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TEST_SYNC_DIR: syncDir,
      })
      await waitForPath(resolve(syncDir, 'prelock-ready'), 200)
      await writeFile(resolve(syncDir, 'prelock-continue'), 'continue\n')
      await waitForPath(resolve(syncDir, readyName))

      await rename(target, displaced)
      await mkdir(target)
      await writeFile(resolve(target, 'concurrent.txt'), `${kind} concurrent replacement\n`)
      await writeFile(resolve(syncDir, continueName), 'continue\n')

      await expect(installAttempt).rejects.toMatchObject({ code: 99 })
      expect(await readFile(resolve(target, 'old.txt'), 'utf8'))
        .toBe(kind === 'plugin' ? 'old plugin\n' : 'old skill\n')
      expect(await exists(resolve(
        displaced,
        kind === 'plugin' ? 'index.js' : 'SKILL.md',
      ))).toBe(true)

      const driftRoots = (await readdir(targetParent))
        .filter((name) => name.startsWith('.aiworker-director-brain.drift.'))
      expect(driftRoots).toHaveLength(1)
      expect(await readFile(resolve(targetParent, driftRoots[0], 'payload/concurrent.txt'), 'utf8'))
        .toBe(`${kind} concurrent replacement\n`)

      const script = await readFile(installer, 'utf8')
      expect(script).not.toContain('rm -rf -- "$INSTALLED_PLUGIN"')
      expect(script).not.toContain('rm -rf -- "$INSTALLED_SKILL"')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it('quarantines a concurrent rewrite after config activation before restoring the original', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'director-brain-installer-active-drift-'))
    try {
      const fixture = await createFixture(root)
      const configPath = resolve(fixture.stateDir, 'openclaw.json')
      const configBefore = await readFile(configPath, 'utf8')

      await expect(runInstaller(fixture, '--apply', [], {
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TESTING: '1',
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TEST_FAILPOINT: 'config-active-drift',
      })).rejects.toMatchObject({ code: 99 })

      expect(await readFile(configPath, 'utf8')).toBe(configBefore)
      expect(await readFile(resolve(
        fixture.stateDir,
        'extensions/aiworker-director-brain/old.txt',
      ), 'utf8')).toBe('old plugin\n')
      expect(await readFile(resolve(
        fixture.workspace,
        'skills/aiworker-director-brain/old.txt',
      ), 'utf8')).toBe('old skill\n')

      const driftArtifacts = (await readdir(fixture.stateDir))
        .filter((name) => name.startsWith('.openclaw.json.drift.'))
      expect(driftArtifacts).toHaveLength(1)
      expect(await readFile(resolve(fixture.stateDir, driftArtifacts[0], 'openclaw.json'), 'utf8'))
        .toBe('{"concurrent_writer":true}\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it('preserves a same-content atomic config replacement by inode and keeps later writer output reachable', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'director-brain-installer-config-same-content-replacement-'))
    let replacementHandle: Awaited<ReturnType<typeof open>> | null = null
    try {
      const fixture = await createFixture(root)
      const syncDir = resolve(root, 'sync')
      const configPath = resolve(fixture.stateDir, 'openclaw.json')
      const replacementPath = resolve(fixture.stateDir, '.openclaw.json.concurrent-replacement')
      const configBefore = await readFile(configPath, 'utf8')
      await mkdir(syncDir)

      const installAttempt = runInstaller(fixture, '--apply', [], {
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TESTING: '1',
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TEST_FAILPOINT: 'config-active-replacement',
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TEST_SYNC_DIR: syncDir,
      })
      await waitForPath(resolve(syncDir, 'prelock-ready'), 200)
      await writeFile(resolve(syncDir, 'prelock-continue'), 'continue\n')
      await waitForPath(resolve(syncDir, 'config-active-ready'))

      const activatedContents = await readFile(configPath, 'utf8')
      const activatedIdentity = `${(await stat(configPath)).dev}:${(await stat(configPath)).ino}`
      await writeFile(replacementPath, activatedContents, { mode: 0o600 })
      replacementHandle = await open(replacementPath, 'a')
      const replacementStat = await replacementHandle.stat()
      const replacementIdentity = `${replacementStat.dev}:${replacementStat.ino}`
      expect(replacementIdentity).not.toBe(activatedIdentity)
      await rename(replacementPath, configPath)
      await writeFile(resolve(syncDir, 'config-active-continue'), 'continue\n')

      await expect(installAttempt).rejects.toMatchObject({ code: 99 })
      expect(await readFile(configPath, 'utf8')).toBe(configBefore)

      await replacementHandle.writeFile('post-failure-writer-update\n')
      await replacementHandle.sync()
      await replacementHandle.close()
      replacementHandle = null

      const driftRoots = (await readdir(fixture.stateDir))
        .filter((name) => name.startsWith('.openclaw.json.drift.'))
      expect(driftRoots).toHaveLength(1)
      expect(await readFile(resolve(fixture.stateDir, driftRoots[0], 'openclaw.json'), 'utf8'))
        .toBe(`${activatedContents}post-failure-writer-update\n`)
    } finally {
      await replacementHandle?.close().catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it('fails normal finalization when a same-content config inode replaces the activated file', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'director-brain-installer-config-final-identity-'))
    try {
      const fixture = await createFixture(root)
      const syncDir = resolve(root, 'sync')
      const configPath = resolve(fixture.stateDir, 'openclaw.json')
      const replacementPath = resolve(fixture.stateDir, '.openclaw.json.final-replacement')
      const configBefore = await readFile(configPath, 'utf8')
      await mkdir(syncDir)

      const installAttempt = runInstaller(fixture, '--apply', [], {
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TESTING: '1',
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TEST_FAILPOINT: 'config-final-check-barrier',
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TEST_SYNC_DIR: syncDir,
      })
      await waitForPath(resolve(syncDir, 'prelock-ready'), 200)
      await writeFile(resolve(syncDir, 'prelock-continue'), 'continue\n')
      await waitForPath(resolve(syncDir, 'config-final-ready'))

      const activatedContents = await readFile(configPath, 'utf8')
      const activatedStat = await stat(configPath)
      await writeFile(replacementPath, activatedContents, { mode: 0o600 })
      const replacementStat = await stat(replacementPath)
      expect(`${replacementStat.dev}:${replacementStat.ino}`)
        .not.toBe(`${activatedStat.dev}:${activatedStat.ino}`)
      await rename(replacementPath, configPath)
      await writeFile(resolve(syncDir, 'config-final-continue'), 'continue\n')

      await expect(installAttempt).rejects.toMatchObject({ code: 1 })
      expect(await readFile(configPath, 'utf8')).toBe(configBefore)
      const driftRoots = (await readdir(fixture.stateDir))
        .filter((name) => name.startsWith('.openclaw.json.drift.'))
      expect(driftRoots).toHaveLength(1)
      expect(await readFile(resolve(fixture.stateDir, driftRoots[0], 'openclaw.json'), 'utf8'))
        .toBe(activatedContents)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it('never overwrites a config recreated in the final activation window', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'director-brain-installer-final-window-'))
    try {
      const fixture = await createFixture(root)
      const configPath = resolve(fixture.stateDir, 'openclaw.json')
      const configBefore = await readFile(configPath, 'utf8')

      await expect(runInstaller(fixture, '--apply', [], {
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TESTING: '1',
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TEST_FAILPOINT: 'config-concurrent-before-activation',
      })).rejects.toMatchObject({ code: 70 })

      expect(await readFile(configPath, 'utf8')).toBe('{"concurrent_writer":true}\n')
      const previousConfigs = (await readdir(fixture.stateDir))
        .filter((name) => name.startsWith('.openclaw.json.previous.'))
      expect(previousConfigs).toHaveLength(1)
      expect(await readFile(resolve(fixture.stateDir, previousConfigs[0]), 'utf8'))
        .toBe(configBefore)
      expect(await readFile(resolve(
        fixture.stateDir,
        'extensions/aiworker-director-brain/old.txt',
      ), 'utf8')).toBe('old plugin\n')
      expect(await readFile(resolve(
        fixture.workspace,
        'skills/aiworker-director-brain/old.txt',
      ), 'utf8')).toBe('old skill\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it('aborts before mutation when creating a verified rollback point fails', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'director-brain-installer-backup-failure-'))
    try {
      const fixture = await createFixture(root)
      const configPath = resolve(fixture.stateDir, 'openclaw.json')
      const configBefore = await readFile(configPath, 'utf8')

      await expect(runInstaller(fixture, '--apply', [], {
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TESTING: '1',
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TEST_FAILPOINT: 'backup-plugin-copy-failed',
      })).rejects.toMatchObject({ code: 99 })

      expect(await readFile(configPath, 'utf8')).toBe(configBefore)
      expect(await readFile(resolve(
        fixture.stateDir,
        'extensions/aiworker-director-brain/old.txt',
      ), 'utf8')).toBe('old plugin\n')
      expect(await readFile(resolve(
        fixture.workspace,
        'skills/aiworker-director-brain/old.txt',
      ), 'utf8')).toBe('old skill\n')
      expect(await exists(fixture.backupRoot)).toBe(true)
      expect(await readdir(fixture.backupRoot)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it('restores an explicit verified backup and retains a rescue rollback point', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'director-brain-installer-rollback-'))
    try {
      const fixture = await createFixture(root)
      const originalConfig = await readFile(resolve(fixture.stateDir, 'openclaw.json'), 'utf8')
      await runInstaller(fixture, '--apply')
      const [originalBackup] = await readdir(fixture.backupRoot)

      await writeFile(
        resolve(fixture.workspace, 'skills/aiworker-director-brain/SKILL.md'),
        'changed after install\n',
      )
      const rollback = await runInstaller(fixture, '--rollback', [
        '--backup', resolve(fixture.backupRoot, originalBackup),
      ])

      expect(rollback.stdout).toContain('Rolled back director-brain installation')
      expect(await readFile(resolve(fixture.stateDir, 'openclaw.json'), 'utf8')).toBe(originalConfig)
      expect(await readFile(resolve(
        fixture.stateDir,
        'extensions/aiworker-director-brain/old.txt',
      ), 'utf8')).toBe('old plugin\n')
      expect(await readFile(resolve(
        fixture.workspace,
        'skills/aiworker-director-brain/old.txt',
      ), 'utf8')).toBe('old skill\n')
      expect((await stat(resolve(
        fixture.stateDir,
        'extensions/aiworker-director-brain/old.txt',
      ))).mode & 0o777).toBe(0o640)
      expect((await stat(resolve(
        fixture.workspace,
        'skills/aiworker-director-brain/old.txt',
      ))).mode & 0o777).toBe(0o644)
      expect((await readdir(fixture.backupRoot)).length).toBe(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  it.each([
    {
      name: 'inside the active plugin',
      place: (fixture: Awaited<ReturnType<typeof createFixture>>, backupName: string) => resolve(
        fixture.stateDir,
        'extensions/aiworker-director-brain/rollback-copy',
        backupName,
      ),
      expected: /outside managed plugin and Skill targets|must not overlap managed plugin target/u,
    },
    {
      name: 'inside the active Skill',
      place: (fixture: Awaited<ReturnType<typeof createFixture>>, backupName: string) => resolve(
        fixture.workspace,
        'skills/aiworker-director-brain/rollback-copy',
        backupName,
      ),
      expected: /outside managed plugin and Skill targets|must not overlap managed Skill target/u,
    },
    {
      name: 'directly inside the profile state directory',
      place: (fixture: Awaited<ReturnType<typeof createFixture>>, backupName: string) => resolve(
        fixture.stateDir,
        backupName,
      ),
      expected: /must not equal the OpenClaw state directory or workspace/u,
    },
    {
      name: 'directly inside the workspace',
      place: (fixture: Awaited<ReturnType<typeof createFixture>>, backupName: string) => resolve(
        fixture.workspace,
        backupName,
      ),
      expected: /must not equal the OpenClaw state directory or workspace/u,
    },
  ])('rejects an effective rollback backup $name before creating a rescue copy', async ({
    place,
    expected,
  }) => {
    const root = await mkdtemp(resolve(tmpdir(), 'director-brain-installer-rollback-containment-'))
    try {
      const fixture = await createFixture(root)
      await runInstaller(fixture, '--apply')
      const [backupName] = await readdir(fixture.backupRoot)
      const originalBackup = resolve(fixture.backupRoot, backupName)
      const nestedBackup = place(fixture, backupName)
      await mkdir(resolve(nestedBackup, '..'), { recursive: true })
      await rename(originalBackup, nestedBackup)
      const installedConfig = await readFile(resolve(fixture.stateDir, 'openclaw.json'), 'utf8')

      await expect(runInstaller(fixture, '--rollback', ['--backup', nestedBackup]))
        .rejects.toThrow(expected)

      expect(await readFile(resolve(fixture.stateDir, 'openclaw.json'), 'utf8'))
        .toBe(installedConfig)
      expect(await exists(nestedBackup)).toBe(true)
      expect(await readdir(fixture.backupRoot)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it('resolves an ancestor symlink before rejecting a rollback backup nested in the active plugin', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'director-brain-installer-rollback-physical-alias-'))
    try {
      const fixture = await createFixture(root)
      await runInstaller(fixture, '--apply')
      const [backupName] = await readdir(fixture.backupRoot)
      const pluginTarget = resolve(fixture.stateDir, 'extensions/aiworker-director-brain')
      const physicalParent = resolve(pluginTarget, 'rollback-copy')
      const physicalBackup = resolve(physicalParent, backupName)
      await mkdir(physicalParent)
      await rename(resolve(fixture.backupRoot, backupName), physicalBackup)
      const alias = resolve(root, 'plugin-alias')
      await symlink(pluginTarget, alias)
      const aliasedBackup = resolve(alias, 'rollback-copy', backupName)

      await expect(runInstaller(fixture, '--rollback', ['--backup', aliasedBackup]))
        .rejects.toThrow(/outside managed plugin and Skill targets/u)
      expect(await exists(physicalBackup)).toBe(true)
      expect(await readdir(fixture.backupRoot)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it.each([
    'whole backup replacement',
    'member replacement',
    'member symlink alias',
  ])('binds the rollback source before copy and rejects a concurrent %s', async (caseName) => {
    const root = await mkdtemp(resolve(tmpdir(), 'director-brain-installer-rollback-source-race-'))
    try {
      const fixture = await createFixture(root)
      const syncDir = resolve(root, 'sync')
      await mkdir(syncDir)
      await runInstaller(fixture, '--apply')
      const [backupName] = await readdir(fixture.backupRoot)
      const backup = resolve(fixture.backupRoot, backupName)
      const installedConfig = await readFile(resolve(fixture.stateDir, 'openclaw.json'), 'utf8')
      const displaced = resolve(root, 'verified-source-displaced')
      const replacement = resolve(root, 'unverified-source-replacement')

      if (caseName === 'whole backup replacement') {
        await cp(backup, replacement, { recursive: true, preserveTimestamps: true })
        await writeFile(resolve(replacement, 'plugin/unmanifested.js'), 'unmanifested payload\n')
      } else if (caseName === 'member replacement') {
        await cp(resolve(backup, 'plugin'), replacement, {
          recursive: true,
          preserveTimestamps: true,
        })
        await writeFile(resolve(replacement, 'unmanifested.js'), 'unmanifested payload\n')
      } else {
        await mkdir(replacement)
        await writeFile(resolve(replacement, 'unmanifested.js'), 'symlink payload\n')
      }

      const rollbackAttempt = runInstaller(fixture, '--rollback', ['--backup', backup], {
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TESTING: '1',
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TEST_FAILPOINT: 'rollback-source-before-copy',
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TEST_SYNC_DIR: syncDir,
      })
      await waitForPath(resolve(syncDir, 'rollback-source-ready'))

      if (caseName === 'whole backup replacement') {
        await rename(backup, displaced)
        await rename(replacement, backup)
      } else {
        await rename(resolve(backup, 'plugin'), displaced)
        if (caseName === 'member replacement') {
          await rename(replacement, resolve(backup, 'plugin'))
        } else {
          await symlink(replacement, resolve(backup, 'plugin'))
        }
      }
      await writeFile(resolve(syncDir, 'rollback-source-continue'), 'continue\n')

      await expect(rollbackAttempt).rejects.toMatchObject({ code: 1 })
      expect(await readFile(resolve(fixture.stateDir, 'openclaw.json'), 'utf8'))
        .toBe(installedConfig)
      expect((await readdir(fixture.backupRoot)).sort()).toEqual([backupName])
      if (caseName === 'member symlink alias') {
        expect((await lstat(resolve(backup, 'plugin'))).isSymbolicLink()).toBe(true)
      } else {
        expect(await exists(resolve(backup, 'plugin/unmanifested.js'))).toBe(true)
      }
      expect(await exists(displaced)).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it.each([
    {
      name: 'ordinary file',
      tamper: async (backup: string) => {
        await writeFile(resolve(backup, 'plugin/unlisted.txt'), 'not in manifest\n')
      },
    },
    {
      name: 'ordinary directory',
      tamper: async (backup: string) => {
        await mkdir(resolve(backup, 'skill/unlisted-directory'))
      },
    },
    {
      name: 'missing managed file',
      tamper: async (backup: string) => {
        await rm(resolve(backup, 'plugin/old.txt'))
      },
    },
    {
      name: 'changed managed file digest',
      tamper: async (backup: string) => {
        await writeFile(resolve(backup, 'skill/old.txt'), 'changed after manifest\n')
      },
    },
    {
      name: 'unsupported path name',
      tamper: async (backup: string) => {
        await writeFile(resolve(backup, 'plugin/unsupported name.txt'), 'not canonical\n')
      },
    },
  ])('rejects rollback backup tampering after its manifest: $name', async ({ tamper }) => {
    const root = await mkdtemp(resolve(tmpdir(), 'director-brain-installer-extra-backup-member-'))
    try {
      const fixture = await createFixture(root)
      await runInstaller(fixture, '--apply')
      const [backupName] = await readdir(fixture.backupRoot)
      const backup = resolve(fixture.backupRoot, backupName)
      const installedConfig = await readFile(resolve(fixture.stateDir, 'openclaw.json'), 'utf8')
      await tamper(backup)

      await expect(runInstaller(fixture, '--rollback', ['--backup', backup]))
        .rejects.toThrow(/failed integrity or identity validation/u)

      expect(await readFile(resolve(fixture.stateDir, 'openclaw.json'), 'utf8'))
        .toBe(installedConfig)
      expect((await readdir(fixture.backupRoot)).length).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it('uses the verified rollback point as an uninstall when both targets were initially absent', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'director-brain-installer-uninstall-'))
    try {
      const fixture = await createFixture(root)
      await rm(resolve(fixture.stateDir, 'extensions/aiworker-director-brain'), {
        recursive: true,
        force: true,
      })
      await rm(resolve(fixture.workspace, 'skills/aiworker-director-brain'), {
        recursive: true,
        force: true,
      })
      const originalConfig = await readFile(resolve(fixture.stateDir, 'openclaw.json'), 'utf8')

      await runInstaller(fixture, '--apply')
      const [originalBackup] = await readdir(fixture.backupRoot)
      await runInstaller(fixture, '--rollback', [
        '--backup', resolve(fixture.backupRoot, originalBackup),
      ])

      expect(await exists(resolve(
        fixture.stateDir,
        'extensions/aiworker-director-brain',
      ))).toBe(false)
      expect(await exists(resolve(
        fixture.workspace,
        'skills/aiworker-director-brain',
      ))).toBe(false)
      expect(await readFile(resolve(fixture.stateDir, 'openclaw.json'), 'utf8')).toBe(originalConfig)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it('fails closed on an existing grant to another agent', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'director-brain-installer-grant-'))
    try {
      const fixture = await createFixture(root)
      const configPath = resolve(fixture.stateDir, 'openclaw.json')
      const config = JSON.parse(await readFile(configPath, 'utf8'))
      config.agents.list[1].tools = { alsoAllow: ['aiworker_director_brain'] }
      await writeFile(configPath, JSON.stringify(config, null, 2) + '\n')
      await chmod(configPath, 0o600)

      await expect(runInstaller(fixture, '--dry-run')).rejects.toThrow(/other_agent/u)
      expect(await exists(fixture.backupRoot)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
