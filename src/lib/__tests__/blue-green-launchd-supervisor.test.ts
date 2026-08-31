import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmod,
  copyFile,
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
const projectRoot = process.cwd()
const installer = resolve(projectRoot, 'scripts/install-blue-green-launch-agents.sh')
const manager = resolve(projectRoot, 'scripts/manage-blue-green-services.sh')
const routerScript = resolve(projectRoot, 'scripts/standalone-router.mjs')
const slotStartScript = resolve(projectRoot, 'scripts/start-standalone-slot.sh')
const routerTemplate = resolve(
  projectRoot,
  'ops/video-autoworker/launchd/com.video-autoworker.blue-green.router.plist.template',
)
const slotTemplate = resolve(
  projectRoot,
  'ops/video-autoworker/launchd/com.video-autoworker.blue-green.slot.plist.template',
)
const roots: string[] = []

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'vaw-blue-green-launchd.')))
  roots.push(root)
  const home = join(root, 'home')
  const runDir = join(root, 'runtime-state')
  const releasesDir = join(root, 'immutable-releases')
  const launchAgentsDir = join(home, 'Library', 'LaunchAgents')
  await mkdir(home, { recursive: true, mode: 0o700 })
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    AIWORKER_BG_RUN_DIR: runDir,
    AIWORKER_BG_RELEASES_DIR: releasesDir,
    AIWORKER_BG_LAUNCH_AGENTS_DIR: launchAgentsDir,
    AIWORKER_BG_NODE_BIN: await realpath(process.execPath),
  }
  return { root, home, runDir, releasesDir, launchAgentsDir, env }
}

async function runInstaller(entry: Awaited<ReturnType<typeof fixture>>, ...args: string[]) {
  return execFileAsync('bash', [installer, ...args], {
    cwd: projectRoot,
    env: entry.env,
    encoding: 'utf8',
  })
}

async function runManager(entry: Awaited<ReturnType<typeof fixture>>, ...args: string[]) {
  return execFileAsync('bash', [manager, ...args], {
    cwd: projectRoot,
    env: entry.env,
    encoding: 'utf8',
  })
}

async function sha256(pathname: string) {
  return createHash('sha256').update(await readFile(pathname)).digest('hex')
}

async function executable(pathname: string, source: string) {
  await writeFile(pathname, source, { mode: 0o755 })
  await chmod(pathname, 0o755)
}

async function isolatedSupervisor(entry: Awaited<ReturnType<typeof fixture>>) {
  const isolatedRoot = join(entry.root, 'isolated-project')
  const scriptsDir = join(isolatedRoot, 'scripts')
  const templatesDir = join(isolatedRoot, 'ops', 'video-autoworker', 'launchd')
  await mkdir(scriptsDir, { recursive: true, mode: 0o700 })
  await mkdir(templatesDir, { recursive: true, mode: 0o700 })
  const files = {
    installer: join(scriptsDir, 'install-blue-green-launch-agents.sh'),
    manager: join(scriptsDir, 'manage-blue-green-services.sh'),
    routerScript: join(scriptsDir, 'standalone-router.mjs'),
    slotStartScript: join(scriptsDir, 'start-standalone-slot.sh'),
    routerTemplate: join(templatesDir, 'com.video-autoworker.blue-green.router.plist.template'),
    slotTemplate: join(templatesDir, 'com.video-autoworker.blue-green.slot.plist.template'),
  }
  await Promise.all([
    copyFile(installer, files.installer),
    copyFile(manager, files.manager),
    copyFile(routerScript, files.routerScript),
    copyFile(slotStartScript, files.slotStartScript),
    copyFile(routerTemplate, files.routerTemplate),
    copyFile(slotTemplate, files.slotTemplate),
  ])
  await Promise.all([
    chmod(files.installer, 0o755),
    chmod(files.manager, 0o755),
    chmod(files.routerScript, 0o755),
    chmod(files.slotStartScript, 0o755),
    chmod(files.routerTemplate, 0o644),
    chmod(files.slotTemplate, 0o644),
  ])
  return { isolatedRoot: await realpath(isolatedRoot), ...files }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('blue-green macOS LaunchAgent supervisor', () => {
  it('keeps all templates disabled by default and gated by external enabled markers', async () => {
    const router = await readFile(routerTemplate, 'utf8')
    const slot = await readFile(slotTemplate, 'utf8')
    for (const template of [router, slot]) {
      expect(template).toContain('<key>RunAtLoad</key>\n  <false/>')
      expect(template).toContain('<key>PathState</key>')
      expect(template).toContain('<key>__ENABLED_MARKER__</key>')
      expect(template).not.toContain('/Users/')
      expect(template).not.toMatch(/secret|token|password|api[_-]?key/iu)
    }
    expect(router).toContain('__ROUTER_SCRIPT__')
    expect(slot).toContain('__START_SCRIPT__')
    expect(slot).toContain('<string>active</string>')
    expect(slot).not.toContain('<string>probe</string>')
  })

  it('dry-runs without managed writes, then installs three mode-0600 plists without starting them', async () => {
    const entry = await fixture()
    const dryRun = await runInstaller(entry, '--dry-run')
    expect(dryRun.stdout).toContain('No plist, marker, service, listener, or runtime state was changed')
    await expect(stat(entry.runDir)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(entry.launchAgentsDir)).rejects.toMatchObject({ code: 'ENOENT' })

    const applied = await runInstaller(entry)
    expect(applied.stdout).toContain('without starting or stopping any service')
    for (const service of ['router', 'blue', 'green']) {
      const plist = join(
        entry.launchAgentsDir,
        `com.video-autoworker.blue-green.${service}.plist`,
      )
      expect((await stat(plist)).mode & 0o777).toBe(0o600)
      const payload = await readFile(plist, 'utf8')
      expect(payload).toContain(`<string>com.video-autoworker.blue-green.${service}</string>`)
      expect(payload).toContain('<key>RunAtLoad</key>\n  <false/>')
      expect(payload).toContain(`${entry.runDir}/supervisor/enabled/${service}.enabled`)
      await expect(stat(join(entry.runDir, 'supervisor', 'enabled', `${service}.enabled`)))
        .rejects.toMatchObject({ code: 'ENOENT' })
    }
    for (const directory of [
      entry.runDir,
      join(entry.runDir, 'supervisor'),
      join(entry.runDir, 'supervisor', 'enabled'),
      join(entry.runDir, 'supervisor', 'logs'),
      join(entry.runDir, 'supervisor', 'backups'),
    ]) {
      expect((await stat(directory)).mode & 0o777).toBe(0o700)
    }
    const installation = JSON.parse(await readFile(
      join(entry.runDir, 'supervisor', 'installation.json'),
      'utf8',
    ))
    expect(installation).toMatchObject({
      schema: 'video-autoworker-blue-green-launchd/v2',
      projectRoot,
      runDir: entry.runDir,
      releasesDir: entry.releasesDir,
      executables: {
        routerScript: {
          path: routerScript,
          uid: process.getuid?.(),
          mode: 0o755,
          sha256: await sha256(routerScript),
        },
        slotStartScript: {
          path: slotStartScript,
          uid: process.getuid?.(),
          mode: 0o755,
          sha256: await sha256(slotStartScript),
        },
      },
    })
    expect(await readdir(join(entry.runDir, 'supervisor', 'logs'))).toEqual([])

    const firstDigests = await Promise.all(['router', 'blue', 'green'].map(service => sha256(join(
      entry.launchAgentsDir,
      `com.video-autoworker.blue-green.${service}.plist`,
    ))))
    await runInstaller(entry, '--apply')
    expect(await Promise.all(['router', 'blue', 'green'].map(service => sha256(join(
      entry.launchAgentsDir,
      `com.video-autoworker.blue-green.${service}.plist`,
    ))))).toEqual(firstDigests)
    expect(await readdir(join(entry.runDir, 'supervisor', 'backups'))).toHaveLength(2)
  })

  it('restores all prior plists and its manifest after an injected mid-transaction failure', async () => {
    const entry = await fixture()
    await runInstaller(entry)
    const tracked = [
      ...['router', 'blue', 'green'].map(service => join(
        entry.launchAgentsDir,
        `com.video-autoworker.blue-green.${service}.plist`,
      )),
      join(entry.runDir, 'supervisor', 'installation.json'),
    ]
    const before = await Promise.all(tracked.map(sha256))

    await expect(execFileAsync('bash', [installer], {
      cwd: projectRoot,
      env: {
        ...entry.env,
        AIWORKER_BG_TEST_MODE: '1',
        AIWORKER_BG_INSTALL_TEST_FAIL_AFTER: '1',
      },
      encoding: 'utf8',
    })).rejects.toMatchObject({
      stderr: expect.stringContaining('the previous files were restored'),
    })
    expect(await Promise.all(tracked.map(sha256))).toEqual(before)
  })

  it('refuses symlinked managed paths and conflicting service ports', async () => {
    const entry = await fixture()
    const redirected = join(entry.root, 'redirected-launch-agents')
    await mkdir(redirected, { mode: 0o700 })
    await mkdir(dirname(entry.launchAgentsDir), { recursive: true, mode: 0o700 })
    await symlink(redirected, entry.launchAgentsDir)
    await expect(runInstaller(entry)).rejects.toMatchObject({
      stderr: expect.stringContaining('must not traverse symlink'),
    })
    await expect(stat(entry.runDir)).rejects.toMatchObject({ code: 'ENOENT' })

    const ports = await fixture()
    await expect(execFileAsync('bash', [installer, '--dry-run'], {
      cwd: projectRoot,
      env: { ...ports.env, AIWORKER_BG_BLUE_PORT: '3017' },
      encoding: 'utf8',
    })).rejects.toMatchObject({
      stderr: expect.stringContaining('ports must be distinct'),
    })
  })

  it('reports marker-only services as managed until exact stop disables them', async () => {
    const entry = await fixture()
    await runInstaller(entry)
    await expect(runManager(entry, 'status', 'router')).rejects.toMatchObject({
      stderr: expect.stringContaining('not managed'),
    })

    const marker = join(entry.runDir, 'supervisor', 'enabled', 'router.enabled')
    await writeFile(marker, '{"schema":"video-autoworker-launchd-enabled/v1","service":"router"}\n', {
      mode: 0o600,
    })
    await expect(runManager(entry, 'status', 'router')).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining('managed but unhealthy'),
    })

    await expect(runManager(entry, 'status', 'all')).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining('managed but unhealthy'),
    })

    const stopped = await runManager(entry, 'stop', 'router')
    expect(stopped.stdout).toContain('stopped and disabled')
    await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(runManager(entry, 'status', 'router')).rejects.toMatchObject({
      stderr: expect.stringContaining('not managed'),
    })
  })

  it('fails preflight, start, and status closed when either installed executable drifts', async () => {
    for (const executableName of ['routerScript', 'slotStartScript'] as const) {
      const entry = await fixture()
      const isolated = await isolatedSupervisor(entry)
      await execFileAsync('bash', [isolated.installer], {
        cwd: isolated.isolatedRoot,
        env: entry.env,
        encoding: 'utf8',
      })
      await writeFile(isolated[executableName], `${await readFile(isolated[executableName], 'utf8')}\n# drift\n`)
      for (const args of [['preflight', 'all'], ['start', 'router'], ['status', 'router']]) {
        await expect(execFileAsync('bash', [isolated.manager, ...args], {
          cwd: isolated.isolatedRoot,
          env: entry.env,
          encoding: 'utf8',
        })).rejects.toMatchObject({
          stderr: expect.stringContaining('executable digest changed'),
        })
      }
    }
  })

  it('rejects legacy manifests until a transactional reinstall upgrades them to v2', async () => {
    const entry = await fixture()
    await runInstaller(entry)
    const manifestPath = join(entry.runDir, 'supervisor', 'installation.json')
    const legacy = JSON.parse(await readFile(manifestPath, 'utf8'))
    legacy.schema = 'video-autoworker-blue-green-launchd/v1'
    delete legacy.executables
    await writeFile(manifestPath, `${JSON.stringify(legacy)}\n`)

    await expect(runManager(entry, 'status', 'router')).rejects.toMatchObject({
      stderr: expect.stringContaining('legacy schema; rerun install-blue-green-launch-agents.sh --apply'),
    })
    await runInstaller(entry, '--apply')
    expect(JSON.parse(await readFile(manifestPath, 'utf8')).schema)
      .toBe('video-autoworker-blue-green-launchd/v2')
    await expect(runManager(entry, 'status', 'router')).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('not managed'),
    })
  })

  it('preflights the user launchd domain and verifies a managed router label, PID, attestation, and port', async () => {
    const entry = await fixture()
    await runInstaller(entry)
    const bin = join(entry.root, 'bin')
    await mkdir(bin, { mode: 0o700 })
    await executable(join(bin, 'launchctl'), `#!/bin/sh
case "$1:$2" in
  print:gui/*/com.video-autoworker.blue-green.router)
    printf 'com.video-autoworker.blue-green.router = {\\n  pid = ${process.pid}\\n}\\n'
    exit 0
    ;;
  print:gui/*)
    printf 'domain = { }\\n'
    exit 0
    ;;
esac
exit 113
`)
    await executable(join(bin, 'lsof'), `#!/bin/sh
printf '${process.pid}\\n'
`)
    const env = { ...entry.env, PATH: `${bin}:${entry.env.PATH}` }
    const marker = join(entry.runDir, 'supervisor', 'enabled', 'router.enabled')
    const attestation = join(entry.runDir, 'router.runtime.json')
    await writeFile(marker, '{"schema":"video-autoworker-launchd-enabled/v1","service":"router"}\n', {
      mode: 0o600,
    })
    await writeFile(attestation, `${JSON.stringify({
      schema: 'video-autoworker-standalone-router-runtime/v1',
      pid: process.pid,
      host: '127.0.0.1',
      port: 3017,
      stateFile: join(entry.runDir, 'router-state.json'),
      startedAt: 1,
    })}\n`, { mode: 0o600 })

    const preflight = await execFileAsync('bash', [manager, 'preflight', 'all'], {
      cwd: projectRoot,
      env,
      encoding: 'utf8',
    })
    expect(preflight.stdout).toContain('Preflight passed')
    expect(preflight.stdout).toContain('No service, marker, listener, or runtime state was changed')
    const status = await execFileAsync('bash', [manager, 'status', 'router'], {
      cwd: projectRoot,
      env,
      encoding: 'utf8',
    })
    expect(status.stdout).toContain(`managed and healthy label=com.video-autoworker.blue-green.router pid=${process.pid} port=3017`)
  })

  it('exposes a read-only preflight and keeps lifecycle commands scoped away from protected services', async () => {
    const source = await readFile(manager, 'utf8')
    const installSource = await readFile(installer, 'utf8')
    expect(source).toContain('preflight all')
    expect(source).toContain('launchctl print "$DOMAIN"')
    expect(source).toContain('start-standalone-slot.sh')
    expect(source).not.toMatch(/n8n-(?:start|stop)|gateway\s+(?:start|stop|restart)|video-lane/iu)
    expect(installSource).not.toContain('launchctl')
    expect(installSource).not.toMatch(/kill\s|pkill|n8n-(?:start|stop)|gateway\s+(?:start|stop|restart)/iu)
  })
})
