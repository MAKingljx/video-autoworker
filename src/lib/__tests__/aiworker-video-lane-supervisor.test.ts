import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const sourceRoot = process.cwd()
const sourceInstaller = resolve(sourceRoot, 'scripts/install-aiworker-video-lane-supervisor.sh')
const sourceValidator = resolve(sourceRoot, 'scripts/validate-aiworker-video-lane-supervisor.mjs')
const sourceTemplate = resolve(
  sourceRoot,
  'ops/video-lane/launchd/ai.aiworker.video-lane-supervisor.plist.template',
)
const sourceSkill = resolve(sourceRoot, 'openclaw-skills/aiworker-task-flow')
const roots: string[] = []

async function executable(pathname: string, source: string) {
  await writeFile(pathname, source, { mode: 0o755 })
  await chmod(pathname, 0o755)
}

async function fixture() {
  // macOS commonly exposes its temporary directory through /var, which is a
  // system symlink to /private/var. Use the physical root so this fixture
  // exercises the installer's user-controlled symlink guard accurately.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aiworker-video-lane-supervisor.')))
  roots.push(root)
  const home = join(root, 'home')
  const bin = join(root, 'bin')
  const repo = join(root, 'repo')
  const workspace = join(home, 'AI-worker-second-original-workspace')
  const installedSkill = join(workspace, 'skills', 'aiworker-task-flow')
  const state = join(home, '.openclaw-qwen-current')
  const launchAgents = join(home, 'Library', 'LaunchAgents')
  const batchRoot = join(home, 'ai-worker', 'state', 'video-autoworker', 'video-batches')
  const logDir = join(home, 'Library', 'Logs', 'aiworker-video-lane')
  const backupRoot = join(home, 'ai-worker', 'backups', 'video-lane-supervisor')
  const installer = join(repo, 'scripts', 'install-aiworker-video-lane-supervisor.sh')
  const validator = join(repo, 'scripts', 'validate-aiworker-video-lane-supervisor.mjs')
  const template = join(repo, 'ops', 'video-lane', 'launchd', 'ai.aiworker.video-lane-supervisor.plist.template')
  const nodeBinary = await realpath(process.execPath)
  const launchState = join(root, 'launch-state.json')
  const listenerState = join(root, 'listeners.json')
  const qwenConfig = join(state, 'openclaw.json')

  await Promise.all([
    mkdir(bin, { recursive: true, mode: 0o700 }),
    mkdir(dirname(installer), { recursive: true, mode: 0o700 }),
    mkdir(dirname(template), { recursive: true, mode: 0o700 }),
    mkdir(join(repo, 'openclaw-skills'), { recursive: true, mode: 0o700 }),
    mkdir(join(workspace, 'skills'), { recursive: true, mode: 0o700 }),
    mkdir(state, { recursive: true, mode: 0o700 }),
    mkdir(launchAgents, { recursive: true, mode: 0o700 }),
  ])
  await Promise.all([
    cp(sourceInstaller, installer),
    cp(sourceValidator, validator),
    cp(sourceTemplate, template),
    cp(sourceSkill, join(repo, 'openclaw-skills', 'aiworker-task-flow'), { recursive: true }),
    cp(sourceSkill, installedSkill, { recursive: true }),
  ])
  // The task-flow installer copies only the executable skill payload. Its two
  // workspace guidance documents are rendered into the workspace separately.
  await Promise.all([
    rm(join(installedSkill, 'WORKSPACE_VIDEO_MEMORY.md')),
    rm(join(installedSkill, 'WORKSPACE_VIDEO_RULES.md')),
  ])
  await chmod(installer, 0o755)
  await chmod(validator, 0o755)
  await chmod(join(installedSkill, 'SKILL.md'), 0o600)
  for (const name of await readdir(join(installedSkill, 'lib'))) {
    await chmod(join(installedSkill, 'lib', name), 0o600)
  }
  for (const name of await readdir(join(installedSkill, 'scripts'))) {
    await chmod(join(installedSkill, 'scripts', name), 0o700)
  }
  await writeFile(qwenConfig, `${JSON.stringify({
    agents: { list: [{ id: 'second-original', workspace }] },
    bindings: [{ agentId: 'second-original', match: { channel: 'telegram' } }],
    plugins: { entries: { 'aiworker-video-command': { enabled: true } } },
  })}\n`, { mode: 0o600 })
  await writeFile(launchState, '{}\n', { mode: 0o600 })
  await writeFile(listenerState, `${JSON.stringify(Object.fromEntries(
    ['3017', '5678', '5679', '18091', '18789', '18889', '18989']
      .map(port => [port, port]),
  ))}\n`, { mode: 0o600 })
  await executable(join(bin, 'id'), `#!/bin/sh
if [ "$1" = "-un" ]; then printf '%s\\n' "${process.env.USER || 'fixture'}"; exit 0; fi
if [ "$1" = "-u" ]; then printf '501\\n'; exit 0; fi
exit 2
`)
  await executable(join(bin, 'hostname'), '#!/bin/sh\nprintf "fixture-host.local\\n"\n')
  await executable(join(bin, 'lsof'), `#!/usr/bin/env node
const { readFileSync } = require('node:fs')
const values = JSON.parse(readFileSync(process.env.FAKE_LISTENERS, 'utf8'))
const match = /-iTCP:(\\d+)/.exec(process.argv.slice(2).join(' '))
if (!match || !values[match[1]]) process.exit(1)
process.stdout.write(values[match[1]] + '\\n')
`)
  await executable(join(bin, 'openclaw'), `#!/usr/bin/env node
let args = process.argv.slice(2)
if (args[0] === '--profile') args = args.slice(2)
if (args[0] === '--version') {
  process.stdout.write('OpenClaw 2026.7.1-2 (fake)\\n')
  process.exit(0)
}
if (args[0] === 'gateway' && args[1] === 'status') {
  process.stdout.write(JSON.stringify({ service: { loaded: true }, rpc: { ok: true } }) + '\\n')
  process.exit(0)
}
process.exit(2)
`)
  await executable(join(bin, 'launchctl'), `#!/usr/bin/env node
const { existsSync, readFileSync, writeFileSync } = require('node:fs')
const args = process.argv.slice(2)
const path = process.env.FAKE_LAUNCH_STATE
const read = () => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
const save = value => writeFileSync(path, JSON.stringify(value) + '\\n')
if (args[0] === 'print') {
  const state = read()
  if (!state.loaded) process.exit(113)
  process.stdout.write('ai.aiworker.video-lane-supervisor = {\\n  pid = ' + state.pid + '\\n}\\n')
  process.exit(0)
}
if (args[0] === 'bootstrap') { save({ loaded: true, pid: 4242 }); process.exit(0) }
if (args[0] === 'enable') process.exit(0)
if (args[0] === 'kickstart') {
  const state = read()
  save({ loaded: true, pid: 4242 })
  const lock = process.env.FAKE_BATCH_ROOT + '/.global-video-worker.lock'
  require('node:fs').mkdirSync(require('node:path').dirname(lock), { recursive: true, mode: 0o700 })
  writeFileSync(lock, JSON.stringify({ pid: 4242, token: 'fixture', createdAt: new Date().toISOString() }) + '\\n', { mode: 0o600 })
  process.exit(0)
}
if (args[0] === 'bootout') {
  const state = read()
  if (!state.loaded) process.exit(113)
  save({})
  try { require('node:fs').unlinkSync(process.env.FAKE_BATCH_ROOT + '/.global-video-worker.lock') } catch {}
  process.exit(0)
}
process.exit(2)
`)

  const env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${process.env.PATH}`,
    AIWORKER_NODE_BIN: nodeBinary,
    AIWORKER_EXPECTED_USER: process.env.USER || 'fixture',
    AIWORKER_EXPECTED_HOST: 'fixture-host.local',
    AIWORKER_QWEN_WORKSPACE: workspace,
    AIWORKER_VIDEO_BATCH_DIR: batchRoot,
    AIWORKER_VIDEO_LANE_LOG_DIR: logDir,
    AIWORKER_LAUNCH_AGENTS_DIR: launchAgents,
    AIWORKER_VIDEO_LANE_BACKUP_ROOT: backupRoot,
    FAKE_BATCH_ROOT: batchRoot,
    FAKE_LAUNCH_STATE: launchState,
    FAKE_LISTENERS: listenerState,
  }
  return {
    root,
    env,
    installer,
    workspace,
    installedSkill,
    launchAgents,
    batchRoot,
    logDir,
    backupRoot,
    plist: join(launchAgents, 'ai.aiworker.video-lane-supervisor.plist'),
    launchState,
  }
}

async function run(entry: Awaited<ReturnType<typeof fixture>>, mode: string) {
  return execFileAsync('bash', [entry.installer, mode], {
    cwd: entry.root,
    env: entry.env,
    encoding: 'utf8',
  })
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('persistent global video-lane supervisor', () => {
  it('renders a KeepAlive LaunchAgent with no production path or unresolved placeholder', async () => {
    const template = await readFile(sourceTemplate, 'utf8')
    expect(template).toContain('<key>KeepAlive</key>\n  <true/>')
    expect(template).toContain('<key>RunAtLoad</key>\n  <true/>')
    expect(template).toContain('<string>--serve-root</string>')
    expect(template).not.toContain('/Users/')
    expect(template.match(/__[A-Z0-9_]+__/gu)?.length).toBeGreaterThan(0)
  })

  it('dry-run is read-only, then apply is idempotent and uninstall preserves queue state', async () => {
    const entry = await fixture()
    const sentinel = join(entry.batchRoot, 'sentinel.json')
    await mkdir(entry.batchRoot, { recursive: true, mode: 0o700 })
    await writeFile(sentinel, '{"taskId":"same-id"}\n', { mode: 0o600 })
    const before = createHash('sha256').update(await readFile(sentinel)).digest('hex')

    const dryRun = await run(entry, '--dry-run')
    expect(dryRun.stdout).toContain('No LaunchAgent, queue state')
    await expect(stat(entry.plist)).rejects.toMatchObject({ code: 'ENOENT' })

    const applied = await run(entry, '--apply')
    expect(applied.stdout).toContain('persistent global video-lane supervisor')
    expect((await stat(entry.plist)).mode & 0o777).toBe(0o600)
    expect((await stat(entry.batchRoot)).mode & 0o777).toBe(0o700)
    expect((await stat(entry.logDir)).mode & 0o777).toBe(0o700)
    expect((await readFile(entry.plist, 'utf8'))).toContain(`<string>${entry.batchRoot}</string>`)
    expect(JSON.parse(await readFile(entry.launchState, 'utf8'))).toMatchObject({ loaded: true, pid: 4242 })
    expect(await readdir(entry.backupRoot)).toHaveLength(1)

    const idempotent = await run(entry, '--apply')
    expect(idempotent.stdout).toContain('already current and healthy')
    expect(await readdir(entry.backupRoot)).toHaveLength(1)

    const uninstalled = await run(entry, '--uninstall')
    expect(uninstalled.stdout).toContain('queue state, task IDs, batch IDs, logs, and backups were preserved')
    await expect(stat(entry.plist)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(createHash('sha256').update(await readFile(sentinel)).digest('hex')).toBe(before)
    expect(await readdir(entry.backupRoot)).toHaveLength(2)
  }, 20_000)

  it('keeps at most two verified backups without deleting unrelated evidence', async () => {
    const entry = await fixture()
    await run(entry, '--apply')
    const unrelated = join(entry.backupRoot, 'operator-note.txt')
    await writeFile(unrelated, 'preserve\n', { mode: 0o600 })
    await run(entry, '--uninstall')
    await run(entry, '--apply')
    const children = await readdir(entry.backupRoot)
    expect(children.filter(name => /^[0-9]{8}-[0-9]{6}\.[A-Za-z0-9]{6}$/u.test(name))).toHaveLength(2)
    expect(await readFile(unrelated, 'utf8')).toBe('preserve\n')
  }, 20_000)

  it('fails closed on installed skill drift before touching LaunchAgent state', async () => {
    const entry = await fixture()
    await writeFile(join(entry.installedSkill, 'scripts', 'run-video-batch.mjs'), 'drift\n', { mode: 0o700 })
    await expect(run(entry, '--apply')).rejects.toMatchObject({
      stderr: expect.stringContaining('does not exactly match the canonical executable payload'),
    })
    await expect(stat(entry.plist)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails closed on a symlinked workspace before touching LaunchAgent state', async () => {
    const entry = await fixture()
    const redirectedWorkspace = join(entry.root, 'redirected-workspace')
    await mkdir(redirectedWorkspace, { recursive: true, mode: 0o700 })
    await rm(entry.workspace, { recursive: true, force: true })
    await symlink(redirectedWorkspace, entry.workspace)

    await expect(run(entry, '--apply')).rejects.toMatchObject({
      stderr: expect.stringContaining('second-original workspace must be an existing absolute regular directory'),
    })
    await expect(stat(entry.plist)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
