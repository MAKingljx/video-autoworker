import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { watch } from 'node:fs'
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
  rm as removeFileSystemPath,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import Database from 'better-sqlite3'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const sourceRepository = process.cwd()
let installerRepository = ''
let installer = resolve(sourceRepository, 'scripts/install-aiworker-director-brain.sh')
const treeManifestHelper = resolve(sourceRepository, 'scripts/lib/runtime-tree-manifest.mjs')
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

type InstallerResult = {
  stdout: string
  stderr: string
}

type InstallerOutcome =
  | { status: 'fulfilled'; value: InstallerResult }
  | { status: 'rejected'; reason: unknown }

type InstallerExecution = {
  child: ChildProcess
  fixtureRoot?: string
  result: Promise<InstallerResult>
  settled: Promise<InstallerOutcome>
  syncDir?: string
}

type RawInstallerResult = {
  schema: 'video-autoworker-installer-result/v1'
  component: 'director-brain'
  operation: 'apply' | 'rollback'
  status: 'applied' | 'noop' | 'restored'
  sourceCommit: string
  targetReleaseId: string
  beforeManifestSha256: string
  afterManifestSha256: string
  backup: null | { path: string; manifestSha256: string }
  requiresFreshRestart: boolean
  completedAt: number
}

async function readInstallerResult(pathname: string) {
  return JSON.parse(await readFile(pathname, 'utf8')) as RawInstallerResult
}

async function sha256File(pathname: string) {
  return createHash('sha256').update(await readFile(pathname)).digest('hex')
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

const activeInstallerAttempts = new Set<InstallerExecution>()

async function rm(
  pathname: string,
  options?: Parameters<typeof removeFileSystemPath>[1],
) {
  const removalPath = resolve(pathname)
  const affectedAttempts = [...activeInstallerAttempts].filter((attempt) => {
    if (!attempt.fixtureRoot) return false
    const fixtureFromRemoval = relative(removalPath, resolve(attempt.fixtureRoot))
    return fixtureFromRemoval === ''
      || (fixtureFromRemoval !== '..'
        && !fixtureFromRemoval.startsWith(`..${sep}`)
        && !isAbsolute(fixtureFromRemoval))
  })
  await Promise.all(affectedAttempts.map(attempt => (
    settleInstallerBeforeFixtureRemoval(attempt, attempt.syncDir)
  )))
  return removeFileSystemPath(pathname, options)
}

const installerContinueMarkers = [
  'prelock-continue',
  'backup-root-continue',
  'config-previous-continue',
  'config-previous-postcheck-continue',
  'config-retain-continue',
  'plugin-active-continue',
  'skill-active-continue',
  'config-active-continue',
  'config-final-continue',
  'rollback-source-continue',
]

function observeInstallerResult(result: Promise<InstallerResult>): Promise<InstallerOutcome> {
  return result.then(
    value => ({ status: 'fulfilled', value }),
    reason => ({ status: 'rejected', reason }),
  )
}

function startTrackedProcess(
  command: string,
  args: string[],
  environment?: NodeJS.ProcessEnv,
): InstallerExecution {
  const child = spawn(command, args, {
    detached: true,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdout: string[] = []
  const stderr: string[] = []
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => stdout.push(String(chunk)))
  child.stderr.on('data', chunk => stderr.push(String(chunk)))
  const result = new Promise<InstallerResult>((resolveResult, rejectResult) => {
    let finished = false
    child.once('error', (error) => {
      if (finished) return
      finished = true
      Object.assign(error, { stdout: stdout.join(''), stderr: stderr.join('') })
      rejectResult(error)
    })
    child.once('close', (code, signal) => {
      if (finished) return
      finished = true
      const captured = { stdout: stdout.join(''), stderr: stderr.join('') }
      if (code === 0) {
        resolveResult(captured)
        return
      }
      rejectResult(Object.assign(new Error(
        `Command failed: ${command}\n${captured.stderr}`,
      ), {
        code,
        signal,
        ...captured,
      }))
    })
  })
  return {
    child,
    result,
    settled: observeInstallerResult(result),
  }
}

async function waitForInstallerPath(
  pathname: string,
  settledAttempt: Promise<InstallerOutcome>,
  timeoutMs = 10_000,
) {
  if (await exists(pathname)) return

  await new Promise<void>((resolveWait, rejectWait) => {
    let finished = false
    let checking = false
    const watcher = watch(dirname(pathname), { persistent: false })
    const timeout = setTimeout(() => {
      void exists(pathname).then((present) => {
        if (present) finish()
        else finish(new Error(`Timed out waiting for installer synchronization path: ${pathname}`))
      }, finish)
    }, timeoutMs)
    const fallbackPoll = setInterval(() => void checkPath(), 250)

    const finish = (error?: unknown) => {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      clearInterval(fallbackPoll)
      watcher.close()
      if (error) rejectWait(error)
      else resolveWait()
    }

    const checkPath = async () => {
      if (finished || checking) return
      checking = true
      try {
        if (await exists(pathname)) finish()
      } catch (error) {
        finish(error)
      } finally {
        checking = false
      }
    }

    watcher.on('change', () => void checkPath())
    watcher.on('error', finish)
    void checkPath()
    void settledAttempt.then(async (outcome) => {
      if (finished || await exists(pathname)) {
        finish()
        return
      }
      if (outcome.status === 'rejected') {
        const detail = outcome.reason instanceof Error
          ? outcome.reason.message
          : String(outcome.reason)
        finish(new Error(
          `Installer failed before creating synchronization path ${pathname}: ${detail}`,
          { cause: outcome.reason },
        ))
        return
      }
      finish(new Error(`Installer exited before creating synchronization path: ${pathname}`))
    }).catch(finish)
  })
}

async function waitForInstallerOutcome(
  settledAttempt: Promise<InstallerOutcome>,
  timeoutMs: number,
) {
  let timeout: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      settledAttempt,
      new Promise<'timeout'>((resolveTimeout) => {
        timeout = setTimeout(() => resolveTimeout('timeout'), timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

async function installerProcessTreePids(attempt: InstallerExecution) {
  const rootPid = attempt.child.pid
  if (!rootPid) return []
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' })
  const childPids = new Map<number, number[]>()
  for (const line of stdout.split('\n')) {
    const [pidSource, parentPidSource] = line.trim().split(/\s+/u)
    const pid = Number(pidSource)
    const parentPid = Number(parentPidSource)
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parentPid)) continue
    const siblings = childPids.get(parentPid) ?? []
    siblings.push(pid)
    childPids.set(parentPid, siblings)
  }

  const discovered = [rootPid]
  for (let index = 0; index < discovered.length; index += 1) {
    discovered.push(...(childPids.get(discovered[index]) ?? []))
  }
  return discovered
}

async function signalInstallerProcessTree(
  attempt: InstallerExecution,
  signal: NodeJS.Signals,
  previouslyDiscovered: number[] = [],
) {
  const rootPid = attempt.child.pid
  if (!rootPid) return []
  const discovered = [...new Set([
    ...previouslyDiscovered,
    ...await installerProcessTreePids(attempt),
  ])]
  try {
    process.kill(-rootPid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
  for (const pid of discovered.reverse()) {
    try {
      process.kill(pid, signal)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  return discovered
}

async function settleInstallerBeforeFixtureRemoval(
  attempt: InstallerExecution | null,
  syncDir?: string,
  timeouts: { gracefulMs?: number; termMs?: number } = {},
) {
  if (!attempt) return

  if (syncDir) {
    await Promise.all(installerContinueMarkers.map(marker => (
      writeFile(resolve(syncDir, marker), 'continue\n').catch(() => undefined)
    )))
  }
  const firstOutcome = await waitForInstallerOutcome(
    attempt.settled,
    timeouts.gracefulMs ?? 5_000,
  )
  if (firstOutcome !== 'timeout') {
    activeInstallerAttempts.delete(attempt)
    return
  }

  const processTree = await signalInstallerProcessTree(attempt, 'SIGTERM')
  await waitForInstallerOutcome(
    attempt.settled,
    timeouts.termMs ?? 2_000,
  )
  await signalInstallerProcessTree(attempt, 'SIGKILL', processTree)
  await attempt.settled
  activeInstallerAttempts.delete(attempt)
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
    'scripts/lib/runtime-tree-manifest.mjs',
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
  await Promise.all([...activeInstallerAttempts].map(attempt => (
    settleInstallerBeforeFixtureRemoval(attempt, attempt.syncDir)
  )))
  if (installerRepository) await rm(installerRepository, { recursive: true, force: true })
  if (commandFixtureRoot) await rm(commandFixtureRoot, { recursive: true, force: true })
})

afterEach(async () => {
  await Promise.all([...activeInstallerAttempts].map(attempt => (
    settleInstallerBeforeFixtureRemoval(attempt, attempt.syncDir)
  )))
}, 15_000)

async function createFixture(root: string) {
  await mkdir(root, { recursive: true })
  const isolatedTestRoot = await realpath(root)
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
    root: resolve(root),
    isolatedTestRoot,
    stateDir,
    workspace,
    backupRoot,
    liveDbPath: await realpath(liveDbPath),
    n8nDbPath: await realpath(n8nDbPath),
    deploymentRunDir,
    videoBatchRoot: await realpath(videoBatchRoot),
  }
}

function startInstaller(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  mode: '--dry-run' | '--apply' | '--rollback',
  extra: string[] = [],
  environment: Partial<NodeJS.ProcessEnv> = {},
): InstallerExecution {
  const attempt = startTrackedProcess('bash', [
    installer,
    mode,
    '--profile', 'dev-test',
    '--state-dir', fixture.stateDir,
    '--workspace', fixture.workspace,
    '--agent', 'dev',
    '--backup-root', fixture.backupRoot,
    ...extra,
  ], installerTestEnvironment({
    AIWORKER_INSTALLER_ISOLATED_TEST_ROOT: fixture.isolatedTestRoot,
    NODE_ENV: 'test',
    AIWORKER_BG_RUN_DIR: fixture.deploymentRunDir,
    AIWORKER_BG_LIVE_DB_PATH: fixture.liveDbPath,
    AIWORKER_BG_N8N_DB_PATH: fixture.n8nDbPath,
    AIWORKER_VIDEO_BATCH_DIR: fixture.videoBatchRoot,
    ...environment,
  }))
  attempt.fixtureRoot = fixture.root
  attempt.syncDir = environment.AIWORKER_DIRECTOR_BRAIN_INSTALL_TEST_SYNC_DIR
  activeInstallerAttempts.add(attempt)
  return attempt
}

async function runInstaller(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  mode: '--dry-run' | '--apply' | '--rollback',
  extra: string[] = [],
  environment: Partial<NodeJS.ProcessEnv> = {},
) {
  return startInstaller(fixture, mode, extra, environment).result
}

describe('installer synchronization', () => {
  it('observes a delayed marker through filesystem events', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'director-brain-installer-wait-helper-'))
    const marker = resolve(root, 'ready')
    let resolveInstaller!: (value: InstallerResult) => void
    const result = new Promise<InstallerResult>((resolveResult) => {
      resolveInstaller = resolveResult
    })
    const settled = observeInstallerResult(result)
    const markerWrite = new Promise<void>((resolveWrite, rejectWrite) => {
      setTimeout(() => {
        void writeFile(marker, 'ready\n').then(resolveWrite, rejectWrite)
      }, 30)
    })

    try {
      await waitForInstallerPath(marker, settled, 1_000)
      await markerWrite
      expect(await exists(marker)).toBe(true)
    } finally {
      resolveInstaller({ stdout: '', stderr: '' })
      await settled
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports an installer failure before the marker without waiting for the deadline', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'director-brain-installer-wait-failure-'))
    const marker = resolve(root, 'never-created')
    let rejectInstaller!: (reason: unknown) => void
    const result = new Promise<InstallerResult>((_resolveResult, rejectResult) => {
      rejectInstaller = rejectResult
    })
    const settled = observeInstallerResult(result)
    const failureTimer = setTimeout(() => {
      rejectInstaller(new Error('synthetic installer failure'))
    }, 30)

    try {
      await expect(waitForInstallerPath(marker, settled, 1_000))
        .rejects.toThrow(/synthetic installer failure/u)
    } finally {
      clearTimeout(failureTimer)
      rejectInstaller(new Error('synthetic installer failure'))
      await settled
      await rm(root, { recursive: true, force: true })
    }
  })

  it('kills a recorded descendant after the installer exits on TERM and the marker never appears', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'director-brain-installer-wait-timeout-'))
    const syncDir = resolve(root, 'sync')
    const childPidPath = resolve(root, 'child.pid')
    await mkdir(syncDir)
    const attempt = startTrackedProcess('bash', [
      '-c',
      '(trap "" TERM; exec >/dev/null 2>&1; sleep 60) & child_pid=$!; '
        + 'printf "%s\\n" "$child_pid" > "$1"; wait',
      'installer-cleanup-test',
      childPidPath,
    ])
    const rootProcessId = attempt.child.pid
    let descendantProcessId: number | null = null

    try {
      await waitForInstallerPath(childPidPath, attempt.settled, 1_000)
      descendantProcessId = Number((await readFile(childPidPath, 'utf8')).trim())
      await expect(waitForInstallerPath(
        resolve(syncDir, 'never-created'),
        attempt.settled,
        30,
      )).rejects.toThrow(/Timed out waiting/u)
      await settleInstallerBeforeFixtureRemoval(attempt, syncDir, {
        gracefulMs: 30,
        termMs: 1_000,
      })
      expect(rootProcessId).toBeTruthy()
      expect(Number.isSafeInteger(descendantProcessId)).toBe(true)
      expect(() => process.kill(rootProcessId!, 0)).toThrow()
      expect(() => process.kill(descendantProcessId!, 0)).toThrow()
    } finally {
      if (rootProcessId) {
        try {
          process.kill(-rootProcessId, 'SIGKILL')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
      }
      for (const pid of [descendantProcessId, rootProcessId]) {
        if (!pid) continue
        try {
          process.kill(pid, 'SIGKILL')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
      }
      await attempt.settled
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)
})

describe('transactional director-brain OpenClaw installer', () => {
  it('uses one strict Node manifest process with byte-compatible tree and backup output', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'director-brain-tree-manifest-'))
    try {
      const tree = resolve(root, 'tree')
      const child = resolve(tree, 'dir')
      await mkdir(child, { recursive: true, mode: 0o750 })
      await chmod(tree, 0o700)
      await chmod(child, 0o750)
      await writeFile(resolve(child, 'a.txt'), 'alpha\n', { mode: 0o640 })
      await writeFile(resolve(tree, 'z.txt'), 'zulu\n', { mode: 0o600 })
      await writeFile(resolve(tree, 'MANIFEST.sha256'), 'excluded\n', { mode: 0o600 })

      const nodeLog = resolve(root, 'node.log')
      const forbiddenLog = resolve(root, 'forbidden.log')
      const nodeWrapper = resolve(root, 'node-wrapper')
      await writeFile(nodeWrapper, `#!/bin/sh\nprintf 'node\\n' >> "$MANIFEST_NODE_LOG"\nexec "$MANIFEST_REAL_NODE" "$@"\n`, { mode: 0o700 })
      await chmod(nodeWrapper, 0o700)
      const source = await readFile(installer, 'utf8')
      const treeBody = source.slice(
        source.indexOf('write_tree_manifest() {'),
        source.indexOf('\ntrees_equal()'),
      )
      const backupBody = source.slice(
        source.indexOf('write_backup_tree_manifest() {'),
        source.indexOf('\nwrite_backup_manifest()'),
      )
      const treeOutput = resolve(root, 'tree.manifest')
      const backupOutput = resolve(root, 'backup.manifest')
      await execFileAsync('bash', ['-c', `
stat() { printf 'stat\\n' >> "$MANIFEST_FORBIDDEN_LOG"; return 91; }
shasum() { printf 'shasum\\n' >> "$MANIFEST_FORBIDDEN_LOG"; return 92; }
find() { printf 'find\\n' >> "$MANIFEST_FORBIDDEN_LOG"; return 93; }
${treeBody}
${backupBody}
write_tree_manifest "$1" "$2"
write_backup_tree_manifest "$1" "$3"
`, 'director-manifest', tree, treeOutput, backupOutput], {
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_BIN: nodeWrapper,
          TREE_MANIFEST_HELPER: treeManifestHelper,
          MANIFEST_REAL_NODE: process.execPath,
          MANIFEST_NODE_LOG: nodeLog,
          MANIFEST_FORBIDDEN_LOG: forbiddenLog,
        },
      })

      const mode = async (pathname: string) => ((await stat(pathname)).mode & 0o7777).toString(8)
      const expectedTree = [
        `.\tdirectory\t${await mode(tree)}\t-`,
        `./MANIFEST.sha256\tfile\t${await mode(resolve(tree, 'MANIFEST.sha256'))}\t${sha256('excluded\n')}`,
        `./dir\tdirectory\t${await mode(child)}\t-`,
        `./dir/a.txt\tfile\t${await mode(resolve(child, 'a.txt'))}\t${sha256('alpha\n')}`,
        `./z.txt\tfile\t${await mode(resolve(tree, 'z.txt'))}\t${sha256('zulu\n')}`,
        '',
      ].join('\n')
      expect(await readFile(treeOutput, 'utf8')).toBe(expectedTree)
      expect(await readFile(backupOutput, 'utf8')).toBe(
        expectedTree.replace(/^\.\/MANIFEST\.sha256.*\n/mu, ''),
      )
      expect((await stat(treeOutput)).mode & 0o777).toBe(0o600)
      expect((await stat(backupOutput)).mode & 0o777).toBe(0o600)
      expect(await readFile(nodeLog, 'utf8')).toBe('node\nnode\n')
      expect(await exists(forbiddenLog)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects missing, symlinked, and unsupported director manifest trees', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'director-brain-tree-manifest-strict-'))
    try {
      const missing = resolve(root, 'missing')
      await expect(execFileAsync(process.execPath, [
        treeManifestHelper, 'director-brain', missing,
      ], { encoding: 'utf8' })).rejects.toThrow()

      const physical = resolve(root, 'physical')
      const linked = resolve(root, 'linked')
      await mkdir(physical)
      await symlink(physical, linked)
      await expect(execFileAsync(process.execPath, [
        treeManifestHelper, 'director-brain', linked,
      ], { encoding: 'utf8' })).rejects.toThrow()

      await symlink(resolve(root, 'target'), resolve(physical, 'unsupported-link'))
      await expect(execFileAsync(process.execPath, [
        treeManifestHelper, 'director-brain', physical,
      ], { encoding: 'utf8' })).rejects.toThrow()

      await rm(resolve(physical, 'unsupported-link'), { force: true })
      await symlink(resolve(root, 'target'), resolve(physical, 'MANIFEST.sha256'))
      await expect(execFileAsync(process.execPath, [
        treeManifestHelper, 'director-brain', physical, './MANIFEST.sha256',
      ], { encoding: 'utf8' })).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('settles an unawaited installer before recursively removing its fixture', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'director-brain-installer-unawaited-cleanup-'))
    const syncDir = resolve(root, 'sync')
    let installAttempt: InstallerExecution | null = null
    try {
      const fixture = await createFixture(root)
      await mkdir(syncDir)
      installAttempt = startInstaller(fixture, '--apply', [], {
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TESTING: '1',
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TEST_FAILPOINT: 'after-plugin',
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TEST_SYNC_DIR: syncDir,
      })

      await rm(root, { recursive: true, force: true })

      expect((await installAttempt.settled).status).toBe('rejected')
      expect(activeInstallerAttempts.has(installAttempt)).toBe(false)
      expect(await exists(root)).toBe(false)
    } finally {
      await settleInstallerBeforeFixtureRemoval(installAttempt, syncDir)
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

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

  it('creates no backup, managed root, lock, or raw result when the shared gate rejects', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'director-brain-gate-side-effect-'))
    try {
      const fixture = await createFixture(root)
      const database = new Database(fixture.liveDbPath)
      database.prepare('UPDATE n8n_intake_controls SET accepting = 1').run()
      database.close()
      const configBefore = await readFile(resolve(fixture.stateDir, 'openclaw.json'))
      const pluginBefore = await readFile(resolve(
        fixture.stateDir, 'extensions/aiworker-director-brain/old.txt',
      ))
      const skillBefore = await readFile(resolve(
        fixture.workspace, 'skills/aiworker-director-brain/old.txt',
      ))
      const result = resolve(root, 'gate-rejected-result.json')
      await expect(runInstaller(fixture, '--apply', ['--result-output', result]))
        .rejects.toThrow()
      expect(await readFile(resolve(fixture.stateDir, 'openclaw.json'))).toEqual(configBefore)
      expect(await readFile(resolve(
        fixture.stateDir, 'extensions/aiworker-director-brain/old.txt',
      ))).toEqual(pluginBefore)
      expect(await readFile(resolve(
        fixture.workspace, 'skills/aiworker-director-brain/old.txt',
      ))).toEqual(skillBefore)
      expect(await exists(fixture.backupRoot)).toBe(false)
      expect(await exists(resolve(
        fixture.stateDir, '.aiworker-director-brain-install.lock',
      ))).toBe(false)
      expect(await exists(result)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('recovers a real SIGKILL partial transaction through the fenced stale journal', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'director-brain-sigkill-journal-'))
    let attempt: InstallerExecution | null = null
    try {
      const fixture = await createFixture(root)
      const syncDir = resolve(root, 'sync')
      await mkdir(syncDir)
      attempt = startInstaller(fixture, '--apply', [], {
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TESTING: '1',
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TEST_FAILPOINT: 'sigkill-after-first-mutation',
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TEST_SYNC_DIR: syncDir,
      })
      await waitForInstallerPath(resolve(syncDir, 'prelock-ready'), attempt.settled)
      await writeFile(resolve(syncDir, 'prelock-continue'), 'continue\n')
      await waitForInstallerPath(resolve(syncDir, 'sigkill-ready'), attempt.settled)
      await signalInstallerProcessTree(attempt, 'SIGKILL')
      await attempt.settled
      activeInstallerAttempts.delete(attempt)
      attempt = null
      await runInstaller(fixture, '--apply')
      expect(await readFile(resolve(
        fixture.stateDir, 'extensions/aiworker-director-brain/openclaw.plugin.json',
      ), 'utf8')).toContain('aiworker-director-brain')
      expect(await exists(resolve(
        fixture.stateDir, '.aiworker-director-brain-install.lock',
      ))).toBe(false)
    } finally {
      await settleInstallerBeforeFixtureRemoval(attempt)
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

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
    const syncDir = resolve(root, 'sync')
    let installAttempt: InstallerExecution | null = null
    try {
      const fixture = await createFixture(resolve(root, 'fixture'))
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

      installAttempt = startInstaller(swappedFixture, '--apply', [], {
        AIWORKER_INSTALLER_ISOLATED_TEST_ROOT: await realpath(root),
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TESTING: '1',
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TEST_FAILPOINT: 'backup-root-ancestor-swap',
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TEST_SYNC_DIR: syncDir,
      })
      await waitForInstallerPath(resolve(syncDir, 'prelock-ready'), installAttempt.settled)
      await writeFile(resolve(syncDir, 'prelock-continue'), 'continue\n')
      await waitForInstallerPath(resolve(syncDir, 'backup-root-ready'), installAttempt.settled)
      await symlink(gitTarget, missingAncestor)
      await writeFile(resolve(syncDir, 'backup-root-continue'), 'continue\n')

      await expect(installAttempt.result).rejects.toThrow(/backup_root_component_invalid/u)
      expect(await exists(resolve(gitTarget, 'backups'))).toBe(false)
      expect(await exists(resolve(gitTarget, 'openclaw.json'))).toBe(false)
      expect(await readFile(resolve(fixture.stateDir, 'openclaw.json'), 'utf8'))
        .not.toContain('aiworker-director-brain')
    } finally {
      await settleInstallerBeforeFixtureRemoval(installAttempt, syncDir)
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

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

  it('writes immutable apply, no-op, and rollback machine evidence without profile secrets', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'director-brain-installer-result-'))
    try {
      const fixture = await createFixture(root)
      const configPath = resolve(fixture.stateDir, 'openclaw.json')
      const config = JSON.parse(await readFile(configPath, 'utf8'))
      const secretSentinel = 'fixture-token-must-not-enter-result'
      config.privateFixture = { token: secretSentinel, body: 'private config body' }
      await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
      const applyOutput = resolve(root, 'apply-result.json')
      const noopOutput = resolve(root, 'noop-result.json')
      const rollbackNoopOutput = resolve(root, 'rollback-noop-result.json')
      const rollbackOutput = resolve(root, 'rollback-result.json')

      await runInstaller(fixture, '--apply', ['--result-output', applyOutput])
      const applied = await readInstallerResult(applyOutput)
      expect((await stat(applyOutput)).mode & 0o777).toBe(0o600)
      expect(applied).toMatchObject({
        schema: 'video-autoworker-installer-result/v1',
        component: 'director-brain',
        operation: 'apply',
        status: 'applied',
        requiresFreshRestart: true,
      })
      expect(applied.sourceCommit).toMatch(/^[a-f0-9]{40}$/u)
      expect(applied.targetReleaseId).toBe(`${applied.sourceCommit}-runtime`)
      expect(applied.beforeManifestSha256).toMatch(/^[a-f0-9]{64}$/u)
      expect(applied.afterManifestSha256).toMatch(/^[a-f0-9]{64}$/u)
      expect(applied.beforeManifestSha256).not.toBe(applied.afterManifestSha256)
      expect(applied.backup).not.toBeNull()
      expect(applied.backup?.manifestSha256).toBe(await sha256File(resolve(
        applied.backup!.path,
        'MANIFEST.sha256',
      )))
      const applySource = await readFile(applyOutput, 'utf8')
      expect(applySource).not.toContain(secretSentinel)
      expect(applySource).not.toContain('private config body')

      await runInstaller(fixture, '--rollback', [
        '--noop', '--result-output', rollbackNoopOutput,
      ])
      const rollbackNoop = await readInstallerResult(rollbackNoopOutput)
      expect(rollbackNoop).toMatchObject({
        component: 'director-brain', operation: 'rollback', status: 'restored',
        backup: null, requiresFreshRestart: false,
        beforeManifestSha256: applied.afterManifestSha256,
        afterManifestSha256: applied.afterManifestSha256,
      })

      await runInstaller(fixture, '--apply', ['--result-output', noopOutput])
      const noop = await readInstallerResult(noopOutput)
      expect((await stat(noopOutput)).mode & 0o777).toBe(0o600)
      expect(noop).toMatchObject({
        component: 'director-brain',
        operation: 'apply',
        status: 'noop',
        backup: null,
        requiresFreshRestart: false,
      })
      expect(noop.beforeManifestSha256).toBe(noop.afterManifestSha256)
      expect(noop.beforeManifestSha256).toBe(applied.afterManifestSha256)

      await runInstaller(fixture, '--rollback', [
        '--backup', applied.backup!.path,
        '--result-output', rollbackOutput,
      ])
      const rolledBack = await readInstallerResult(rollbackOutput)
      expect((await stat(rollbackOutput)).mode & 0o777).toBe(0o600)
      expect(rolledBack).toMatchObject({
        component: 'director-brain',
        operation: 'rollback',
        status: 'restored',
        backup: applied.backup,
        requiresFreshRestart: true,
      })
      expect(rolledBack.beforeManifestSha256).toBe(applied.afterManifestSha256)
      expect(rolledBack.afterManifestSha256).toBe(applied.beforeManifestSha256)
      expect(await readFile(configPath, 'utf8')).toContain(secretSentinel)
      expect(await readFile(rollbackOutput, 'utf8')).not.toContain(secretSentinel)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  it('rejects relative, existing, and symlink result outputs before mutation', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'director-brain-installer-result-reject-'))
    try {
      const fixture = await createFixture(root)
      const pluginPath = resolve(
        fixture.stateDir,
        'extensions/aiworker-director-brain/old.txt',
      )
      const existing = resolve(root, 'existing-result.json')
      const target = resolve(root, 'symlink-target.json')
      const linked = resolve(root, 'linked-result.json')
      await writeFile(existing, 'do not overwrite\n', { mode: 0o600 })
      await writeFile(target, 'do not follow\n', { mode: 0o600 })
      await symlink(target, linked)

      for (const output of ['relative-result.json', existing, linked]) {
        await expect(runInstaller(fixture, '--apply', ['--result-output', output]))
          .rejects.toThrow()
        expect(await readFile(pluginPath, 'utf8')).toBe('old plugin\n')
      }
      expect(await readFile(existing, 'utf8')).toBe('do not overwrite\n')
      expect(await readFile(target, 'utf8')).toBe('do not follow\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it('rejects production mutation when fake databases, batch root, and deployment lock are injected', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'director-brain-fake-runtime-'))
    try {
      const fixture = await createFixture(root)
      const pluginPath = resolve(
        fixture.stateDir,
        'extensions/aiworker-director-brain/old.txt',
      )
      const resultOutput = resolve(root, 'fake-runtime-result.json')
      await expect(runInstaller(fixture, '--apply', [
        '--result-output', resultOutput,
      ], {
        AIWORKER_INSTALLER_ISOLATED_TEST_ROOT: '',
        AIWORKER_VIDEO_BATCH_DIR: resolve(
          process.env.HOME!, 'ai-worker/state/video-autoworker/video-batches',
        ),
        NODE_ENV: 'production',
      })).rejects.toMatchObject({
        stderr: expect.stringContaining(
          'shared_runtime_install_not_ready:',
        ),
      })
      expect(await readFile(pluginPath, 'utf8')).toBe('old plugin\n')
      expect(await exists(fixture.backupRoot)).toBe(false)
      expect(await exists(resolve(fixture.stateDir, '.aiworker-director-brain-install.lock')))
        .toBe(false)
      expect(await exists(resultOutput)).toBe(false)
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

  it('fails closed when the target drifts between reservation and the locked mutation', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'director-brain-installer-config-drift-'))
    const syncDir = resolve(root, 'sync')
    let installAttempt: InstallerExecution | null = null
    try {
      const fixture = await createFixture(root)
      const configPath = resolve(fixture.stateDir, 'openclaw.json')
      await mkdir(syncDir)

      installAttempt = startInstaller(fixture, '--apply', [], {
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TESTING: '1',
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TEST_SYNC_DIR: syncDir,
      })

      const readyPath = resolve(syncDir, 'prelock-ready')
      await waitForInstallerPath(readyPath, installAttempt.settled)

      const concurrentConfig = JSON.parse(await readFile(configPath, 'utf8'))
      concurrentConfig.concurrentWriter = { preserved: true }
      const concurrentContents = JSON.stringify(concurrentConfig, null, 2) + '\n'
      await writeFile(configPath, concurrentContents)
      await chmod(configPath, 0o600)
      await writeFile(resolve(syncDir, 'prelock-continue'), 'continue\n')

      await expect(installAttempt.result).rejects
        .toThrow(/Director-brain target changed between reservation and the locked mutation\./u)
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
      await settleInstallerBeforeFixtureRemoval(installAttempt, syncDir)
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

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
    const syncDir = resolve(root, 'sync')
    let configHandle: Awaited<ReturnType<typeof open>> | null = null
    let installAttempt: InstallerExecution | null = null
    try {
      const fixture = await createFixture(root)
      const configPath = resolve(fixture.stateDir, 'openclaw.json')
      const concurrentContents = '{"retained_descriptor_update":true}\n'
      await mkdir(syncDir)
      configHandle = await open(configPath, 'r+')

      installAttempt = startInstaller(fixture, '--apply', [], {
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TESTING: '1',
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TEST_FAILPOINT: 'config-previous-open-fd',
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TEST_SYNC_DIR: syncDir,
      })

      const prelockReady = resolve(syncDir, 'prelock-ready')
      await waitForInstallerPath(prelockReady, installAttempt.settled)
      await writeFile(resolve(syncDir, 'prelock-continue'), 'continue\n')

      const previousReady = resolve(syncDir, 'config-previous-ready')
      await waitForInstallerPath(previousReady, installAttempt.settled)
      await configHandle.truncate(0)
      await configHandle.writeFile(concurrentContents)
      await configHandle.sync()
      await writeFile(resolve(syncDir, 'config-previous-continue'), 'continue\n')

      await expect(installAttempt.result).rejects.toThrow(/retained file descriptor/u)
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
      await settleInstallerBeforeFixtureRemoval(installAttempt, syncDir)
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  it('retains a recoverable old inode when its open descriptor is written after final validation', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'director-brain-installer-postcheck-fd-'))
    const syncDir = resolve(root, 'sync')
    let configHandle: Awaited<ReturnType<typeof open>> | null = null
    let installAttempt: InstallerExecution | null = null
    try {
      const fixture = await createFixture(root)
      const configPath = resolve(fixture.stateDir, 'openclaw.json')
      const concurrentContents = '{"postcheck_retained_descriptor_update":true}\n'
      await mkdir(syncDir)
      configHandle = await open(configPath, 'r+')

      installAttempt = startInstaller(fixture, '--apply', [], {
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TESTING: '1',
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TEST_FAILPOINT: 'config-previous-postcheck-open-fd',
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TEST_SYNC_DIR: syncDir,
      })

      const prelockReady = resolve(syncDir, 'prelock-ready')
      await waitForInstallerPath(prelockReady, installAttempt.settled)
      await writeFile(resolve(syncDir, 'prelock-continue'), 'continue\n')

      const postcheckReady = resolve(syncDir, 'config-previous-postcheck-ready')
      await waitForInstallerPath(postcheckReady, installAttempt.settled)
      await configHandle.truncate(0)
      await configHandle.writeFile(concurrentContents)
      await configHandle.sync()
      await writeFile(resolve(syncDir, 'config-previous-postcheck-continue'), 'continue\n')

      const result = await installAttempt.result
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
      await settleInstallerBeforeFixtureRemoval(installAttempt, syncDir)
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  it('rejects a previous-config symlink swap without chmod-following or losing rollback data', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'director-brain-installer-retain-symlink-'))
    const syncDir = resolve(root, 'sync')
    let installAttempt: InstallerExecution | null = null
    try {
      const fixture = await createFixture(root)
      const configPath = resolve(fixture.stateDir, 'openclaw.json')
      const configBefore = await readFile(configPath, 'utf8')
      const symlinkTarget = resolve(root, 'symlink-target.json')
      await mkdir(syncDir)
      await writeFile(symlinkTarget, '{"must_not_be_followed":true}\n')
      await chmod(symlinkTarget, 0o644)

      installAttempt = startInstaller(fixture, '--apply', [], {
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TESTING: '1',
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TEST_FAILPOINT: 'config-retain-path-replace',
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TEST_SYNC_DIR: syncDir,
      })
      const prelockReady = resolve(syncDir, 'prelock-ready')
      await waitForInstallerPath(prelockReady, installAttempt.settled)
      await writeFile(resolve(syncDir, 'prelock-continue'), 'continue\n')

      const retainReady = resolve(syncDir, 'config-retain-ready')
      await waitForInstallerPath(retainReady, installAttempt.settled)
      const previousName = (await readdir(fixture.stateDir))
        .find((name) => name.startsWith('.openclaw.json.previous.'))
      expect(previousName).toBeTruthy()
      const previousPath = resolve(fixture.stateDir, previousName!)
      const displacedPath = `${previousPath}.displaced`
      await rename(previousPath, displacedPath)
      await symlink(symlinkTarget, previousPath)
      await writeFile(resolve(syncDir, 'config-retain-continue'), 'continue\n')

      await expect(installAttempt.result).rejects
        .toThrow(/Unable to retain the previous profile config inode/u)
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
      await settleInstallerBeforeFixtureRemoval(installAttempt, syncDir)
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

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
    const syncDir = resolve(root, 'sync')
    let installAttempt: InstallerExecution | null = null
    try {
      const fixture = await createFixture(root)
      await mkdir(syncDir)
      const target = kind === 'plugin'
        ? resolve(fixture.stateDir, 'extensions/aiworker-director-brain')
        : resolve(fixture.workspace, 'skills/aiworker-director-brain')
      const targetParent = kind === 'plugin'
        ? resolve(fixture.stateDir, 'extensions')
        : resolve(fixture.workspace, 'skills')
      const displaced = `${target}.concurrent-displaced`

      installAttempt = startInstaller(fixture, '--apply', [], {
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TESTING: '1',
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TEST_FAILPOINT: failpoint,
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TEST_SYNC_DIR: syncDir,
      })
      await waitForInstallerPath(resolve(syncDir, 'prelock-ready'), installAttempt.settled)
      await writeFile(resolve(syncDir, 'prelock-continue'), 'continue\n')
      await waitForInstallerPath(resolve(syncDir, readyName), installAttempt.settled)

      await rename(target, displaced)
      await mkdir(target)
      await writeFile(resolve(target, 'concurrent.txt'), `${kind} concurrent replacement\n`)
      await writeFile(resolve(syncDir, continueName), 'continue\n')

      await expect(installAttempt.result).rejects.toMatchObject({ code: 99 })
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
      await settleInstallerBeforeFixtureRemoval(installAttempt, syncDir)
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

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
    const syncDir = resolve(root, 'sync')
    let replacementHandle: Awaited<ReturnType<typeof open>> | null = null
    let installAttempt: InstallerExecution | null = null
    try {
      const fixture = await createFixture(root)
      const configPath = resolve(fixture.stateDir, 'openclaw.json')
      const replacementPath = resolve(fixture.stateDir, '.openclaw.json.concurrent-replacement')
      const configBefore = await readFile(configPath, 'utf8')
      await mkdir(syncDir)

      installAttempt = startInstaller(fixture, '--apply', [], {
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TESTING: '1',
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TEST_FAILPOINT: 'config-active-replacement',
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TEST_SYNC_DIR: syncDir,
      })
      await waitForInstallerPath(resolve(syncDir, 'prelock-ready'), installAttempt.settled)
      await writeFile(resolve(syncDir, 'prelock-continue'), 'continue\n')
      await waitForInstallerPath(resolve(syncDir, 'config-active-ready'), installAttempt.settled)

      const activatedContents = await readFile(configPath, 'utf8')
      const activatedIdentity = `${(await stat(configPath)).dev}:${(await stat(configPath)).ino}`
      await writeFile(replacementPath, activatedContents, { mode: 0o600 })
      replacementHandle = await open(replacementPath, 'a')
      const replacementStat = await replacementHandle.stat()
      const replacementIdentity = `${replacementStat.dev}:${replacementStat.ino}`
      expect(replacementIdentity).not.toBe(activatedIdentity)
      await rename(replacementPath, configPath)
      await writeFile(resolve(syncDir, 'config-active-continue'), 'continue\n')

      await expect(installAttempt.result).rejects.toMatchObject({ code: 99 })
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
      await settleInstallerBeforeFixtureRemoval(installAttempt, syncDir)
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  it('fails normal finalization when a same-content config inode replaces the activated file', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'director-brain-installer-config-final-identity-'))
    const syncDir = resolve(root, 'sync')
    let installAttempt: InstallerExecution | null = null
    try {
      const fixture = await createFixture(root)
      const configPath = resolve(fixture.stateDir, 'openclaw.json')
      const replacementPath = resolve(fixture.stateDir, '.openclaw.json.final-replacement')
      const configBefore = await readFile(configPath, 'utf8')
      await mkdir(syncDir)

      installAttempt = startInstaller(fixture, '--apply', [], {
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TESTING: '1',
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TEST_FAILPOINT: 'config-final-check-barrier',
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TEST_SYNC_DIR: syncDir,
      })
      await waitForInstallerPath(resolve(syncDir, 'prelock-ready'), installAttempt.settled)
      await writeFile(resolve(syncDir, 'prelock-continue'), 'continue\n')
      await waitForInstallerPath(resolve(syncDir, 'config-final-ready'), installAttempt.settled)

      const activatedContents = await readFile(configPath, 'utf8')
      const activatedStat = await stat(configPath)
      await writeFile(replacementPath, activatedContents, { mode: 0o600 })
      const replacementStat = await stat(replacementPath)
      expect(`${replacementStat.dev}:${replacementStat.ino}`)
        .not.toBe(`${activatedStat.dev}:${activatedStat.ino}`)
      await rename(replacementPath, configPath)
      await writeFile(resolve(syncDir, 'config-final-continue'), 'continue\n')

      await expect(installAttempt.result).rejects.toMatchObject({ code: 1 })
      expect(await readFile(configPath, 'utf8')).toBe(configBefore)
      const driftRoots = (await readdir(fixture.stateDir))
        .filter((name) => name.startsWith('.openclaw.json.drift.'))
      expect(driftRoots).toHaveLength(1)
      expect(await readFile(resolve(fixture.stateDir, driftRoots[0], 'openclaw.json'), 'utf8'))
        .toBe(activatedContents)
    } finally {
      await settleInstallerBeforeFixtureRemoval(installAttempt, syncDir)
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

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
      const resultOutput = resolve(root, 'failed-result.json')

      await expect(runInstaller(fixture, '--apply', ['--result-output', resultOutput], {
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
      expect(await exists(resultOutput)).toBe(false)
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
    const syncDir = resolve(root, 'sync')
    let rollbackAttempt: InstallerExecution | null = null
    try {
      const fixture = await createFixture(root)
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

      rollbackAttempt = startInstaller(fixture, '--rollback', ['--backup', backup], {
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TESTING: '1',
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TEST_FAILPOINT: 'rollback-source-before-copy',
        AIWORKER_DIRECTOR_BRAIN_INSTALL_TEST_SYNC_DIR: syncDir,
      })
      await waitForInstallerPath(resolve(syncDir, 'rollback-source-ready'), rollbackAttempt.settled)

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

      await expect(rollbackAttempt.result).rejects.toMatchObject({ code: 1 })
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
      await settleInstallerBeforeFixtureRemoval(rollbackAttempt, syncDir)
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

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
