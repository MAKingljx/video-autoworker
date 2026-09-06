// @vitest-environment node

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const repositoryRoot = resolve(process.cwd())
const helper = join(repositoryRoot, 'scripts/n8n-startup-witness.mjs')
const commit = 'a'.repeat(40)
const roots: string[] = []
const children: ChildProcess[] = []
const servers: Server[] = []

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill('SIGKILL')
  }
  for (const server of servers.splice(0)) {
    await new Promise<void>(resolvePromise => server.close(() => resolvePromise()))
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function waitFor(predicate: () => boolean, timeout = 10_000) {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for startup witness fixture')
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20))
  }
}

function writePrivate(pathname: string, value: string) {
  writeFileSync(pathname, value, { mode: 0o600 })
  chmodSync(pathname, 0o600)
}

async function readinessServer() {
  const server = createServer((request, response) => {
    if (request.url === '/healthz/readiness') {
      response.writeHead(200).end('ready')
      return
    }
    response.writeHead(404).end('missing')
  })
  servers.push(server)
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(5678, '127.0.0.1', () => resolvePromise())
  })
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'n8n-startup-witness.')))
  roots.push(root)
  chmodSync(root, 0o700)
  const runtime = join(root, 'services/n8n/releases', commit)
  const current = join(root, 'services/n8n/current')
  const cli = join(runtime, 'ops/n8n/node_modules/n8n/bin/n8n')
  const cliAlias = join(current, 'ops/n8n/node_modules/n8n/bin/n8n')
  const nodeDirectory = join(root, 'node/current/bin')
  const nodeAlias = join(nodeDirectory, 'node')
  const helperAlias = join(root, 'n8n-startup-witness.current.mjs')
  const state = join(root, 'run')
  for (const pathname of [dirname(cli), join(runtime, 'ops/n8n/workflows'), nodeDirectory, state]) {
    mkdirSync(pathname, { recursive: true, mode: 0o700 })
  }
  symlinkSync(runtime, current)
  symlinkSync(process.execPath, nodeAlias)
  symlinkSync(helper, helperAlias)
  writePrivate(join(runtime, 'SOURCE_COMMIT'), `${commit}\n`)
  writeFileSync(join(runtime, 'ops/n8n/node_modules/n8n/package.json'), '{"version":"2.31.6"}\n')
  writePrivate(join(runtime, 'ops/n8n/workflows/aiworker-task-intake.json'),
    '{"id":"aiworker-task-intake-v1"}\n')
  writePrivate(join(runtime, 'ops/n8n/workflows/aiworker-video-analysis.json'),
    '{"id":"aiworker-video-analysis-v1"}\n')
  writeFileSync(cli, `
import readline from 'node:readline'
const lines = readline.createInterface({ input: process.stdin })
lines.on('line', line => {
  if (line === 'activate') {
    console.log('Activated workflow Task Intake (ID: aiworker-task-intake-v1)')
    console.log('Activated workflow Video Analysis (ID: aiworker-video-analysis-v1)')
  }
  if (line === 'complete') {
    console.log('Editor is now accessible via:')
    console.log('http://127.0.0.1:5678')
  }
})
setInterval(() => {}, 1000)
`, { mode: 0o700 })
  chmodSync(cli, 0o700)
  return {
    root,
    runtime,
    cliAlias,
    nodeAlias,
    helperAlias,
    pidFile: join(state, 'n8n.pid'),
    witness: join(state, 'n8n.complete-ready.json'),
  }
}

async function startObserved(entry: ReturnType<typeof fixture>, expectedStart?: string) {
  const child = spawn(entry.nodeAlias, [entry.cliAlias, 'start'], {
    cwd: entry.root,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  children.push(child)
  await waitFor(() => child.pid !== undefined)
  writePrivate(entry.pidFile, `${String(child.pid)}\n`)
  const startToken = spawnSync('/bin/ps', ['-p', String(child.pid), '-o', 'lstart='], {
    encoding: 'utf8',
  }).stdout.trim()
  const observer = spawn(process.execPath, [
    entry.helperAlias, 'observe',
    '--pid-file', entry.pidFile,
    '--runtime-root', entry.runtime,
    '--node-bin', entry.nodeAlias,
    '--cli', entry.cliAlias,
    '--witness', entry.witness,
    '--expected-origin', 'http://127.0.0.1:5678',
    '--expected-pid', String(child.pid),
    '--expected-start', expectedStart ?? startToken,
  ], { cwd: repositoryRoot, stdio: ['pipe', 'pipe', 'pipe'] })
  children.push(observer)
  child.stdout?.pipe(observer.stdin!)
  let output = ''
  let error = ''
  observer.stdout?.on('data', chunk => { output += String(chunk) })
  observer.stderr?.on('data', chunk => { error += String(chunk) })
  return { child, observer, startToken, output: () => output, error: () => error }
}

function verify(entry: ReturnType<typeof fixture>) {
  return new Promise<{ status: number | null, stdout: string, stderr: string }>(resolvePromise => {
    const childProcess = spawn(process.execPath, [
      entry.helperAlias, 'verify',
      '--pid-file', entry.pidFile,
      '--runtime-root', entry.runtime,
      '--node-bin', entry.nodeAlias,
      '--cli', entry.cliAlias,
      '--witness', entry.witness,
      '--readiness-url', 'http://127.0.0.1:5678/healthz/readiness',
    ], { cwd: repositoryRoot, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    childProcess.stdout.on('data', chunk => { stdout += String(chunk) })
    childProcess.stderr.on('data', chunk => { stderr += String(chunk) })
    childProcess.once('close', status => resolvePromise({ status, stdout, stderr }))
  })
}

describe('n8n complete startup witness', () => {
  it('requires both managed activations and the completion marker after early HTTP readiness', async () => {
    await readinessServer()
    const entry = fixture()
    const observed = await startObserved(entry)
    expect((await fetch('http://127.0.0.1:5678/healthz/readiness')).status).toBe(200)
    expect((await verify(entry)).status).not.toBe(0)
    expect(existsSync(entry.witness)).toBe(false)

    observed.child.stdin?.write('activate\n')
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
    expect((await verify(entry)).status).not.toBe(0)
    observed.child.stdin?.write('complete\n')
    await waitFor(() => existsSync(entry.witness))

    const verified = await verify(entry)
    expect(verified.status, verified.stderr).toBe(0)
    expect(JSON.parse(verified.stdout)).toMatchObject({
      schema: 'video-autoworker-n8n-complete-startup-witness/v1',
      pid: observed.child.pid,
      sourceCommit: commit,
    })
    expect(observed.output()).toContain('Activated workflow Task Intake')
    expect(observed.output()).toContain('Editor is now accessible via:')

    const wrongClear = spawnSync(process.execPath, [
      entry.helperAlias, 'clear', '--witness', entry.witness,
      '--expected-pid', String(observed.child.pid), '--expected-start', `${observed.startToken} stale`,
    ], { cwd: repositoryRoot, encoding: 'utf8' })
    expect(wrongClear.status).not.toBe(0)
    expect(existsSync(entry.witness)).toBe(true)

    observed.child.kill('SIGKILL')
    await waitFor(() => observed.child.exitCode !== null || observed.child.signalCode !== null)
    expect((await verify(entry)).status).not.toBe(0)
    const cleared = spawnSync(process.execPath, [
      entry.helperAlias, 'clear-stale', '--witness', entry.witness,
    ], { cwd: repositoryRoot, encoding: 'utf8' })
    expect(cleared.status, cleared.stderr).toBe(0)
    expect(existsSync(entry.witness)).toBe(false)
    await waitFor(() => observed.observer.exitCode !== null || observed.observer.signalCode !== null)
  }, 15_000)

  it('rejects a stale expected start token even when the PID and logs are current', async () => {
    const entry = fixture()
    const observed = await startObserved(entry, 'stale process start token')
    observed.child.stdin?.write('activate\ncomplete\n')
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
    expect(existsSync(entry.witness)).toBe(false)
    observed.child.kill('SIGKILL')
    await waitFor(() => observed.child.exitCode !== null || observed.child.signalCode !== null)
    await waitFor(() => observed.observer.exitCode !== null || observed.observer.signalCode !== null)
    expect(observed.observer.exitCode).not.toBe(0)
    expect(observed.error()).toContain('child changed before complete startup')
    expect(existsSync(entry.witness)).toBe(false)
  })
})
