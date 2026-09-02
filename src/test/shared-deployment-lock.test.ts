import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  renameSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const repositoryRoot = resolve(__dirname, '../..')
const shellHelper = join(repositoryRoot, 'scripts/lib/shared-deployment-lock.sh')
const nodeHelper = join(repositoryRoot, 'scripts/lib/shared-deployment-lock.mjs')
const roots: string[] = []
const children: ChildProcess[] = []

function quote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'"
}

function fixture(): { root: string; runDirectory: string; lockPath: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'shared-deployment-lock-')))
  roots.push(root)
  chmodSync(root, 0o700)
  const runDirectory = join(root, 'run')
  mkdirSync(runDirectory, { mode: 0o700 })
  return { root, runDirectory, lockPath: join(runDirectory, '.deployment.lock') }
}

function shellScript(runDirectory: string, body: string): string {
  return [
    'set -euo pipefail',
    'source ' + quote(shellHelper),
    'DEPLOYMENT_RUN_DIR=' + quote(runDirectory),
    'DEPLOYMENT_LOCK_DIR=' + quote(join(runDirectory, '.deployment.lock')),
    body,
  ].join('\n')
}

function runShell(runDirectory: string, body: string) {
  return spawnSync('/bin/bash', ['-c', shellScript(runDirectory, body)], { encoding: 'utf8' })
}

function waitForLine(child: ChildProcess): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    let output = ''
    const timer = setTimeout(() => finish(new Error('timed out waiting for lock holder')), 10_000)
    const finish = (error?: Error, line?: string) => {
      clearTimeout(timer)
      child.stdout?.off('data', onData)
      child.off('exit', onExit)
      if (error) rejectPromise(error)
      else resolvePromise(line as string)
    }
    const onData = (chunk: Buffer | string) => {
      output += String(chunk)
      const newline = output.indexOf('\n')
      if (newline >= 0) finish(undefined, output.slice(0, newline))
    }
    const onExit = () => finish(new Error('lock holder exited before readiness'))
    child.stdout?.on('data', onData)
    child.once('exit', onExit)
  })
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise(resolvePromise => child.once('exit', () => resolvePromise()))
}

function collect(child: ChildProcess): Promise<{ code: number | null; stdout: string; stderr: string }> {
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', chunk => { stdout += String(chunk) })
  child.stderr?.on('data', chunk => { stderr += String(chunk) })
  return new Promise(resolvePromise => child.once('exit', code => resolvePromise({ code, stdout, stderr })))
}

function makeExisting(
  lockPath: string,
  source: string,
  options: { lockMode?: number; ownerMode?: number; extra?: boolean } = {},
): void {
  mkdirSync(lockPath, { mode: options.lockMode ?? 0o700 })
  chmodSync(lockPath, options.lockMode ?? 0o700)
  writeFileSync(join(lockPath, 'pid'), source, { mode: options.ownerMode ?? 0o600 })
  chmodSync(join(lockPath, 'pid'), options.ownerMode ?? 0o600)
  if (options.extra) writeFileSync(join(lockPath, 'unexpected'), 'x\n', { mode: 0o600 })
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await waitForExit(child)
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('shared deployment lock cross-runtime protocol', () => {
  it('publishes exactly one winner when Bash and Node start concurrently', async () => {
    const value = fixture()
    const startPath = join(value.root, 'start')
    const bash = spawn('/bin/bash', ['-c', shellScript(value.runDirectory, [
      `while [[ ! -e ${quote(startPath)} ]]; do :; done`,
      'acquire_shared_deployment_lock',
      'printf "BASH\\n"',
      'sleep 0.4',
      'release_shared_deployment_lock',
    ].join('\n'))], { stdio: ['ignore', 'pipe', 'pipe'] })
    const moduleUrl = pathToFileURL(nodeHelper).href
    const nodeSource = [
      `import { existsSync } from 'node:fs'`,
      `import { acquireSharedDeploymentLockSync } from ${JSON.stringify(moduleUrl)}`,
      `while (!existsSync(${JSON.stringify(startPath)})) {}`,
      `const lease = acquireSharedDeploymentLockSync({runDirectory:${JSON.stringify(value.runDirectory)}})`,
      `console.log('NODE')`,
      `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400)`,
      `lease.release()`,
    ].join(';')
    const node = spawn(process.execPath, ['--input-type=module', '-e', nodeSource],
      { stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(bash, node)
    const bashResult = collect(bash)
    const nodeResult = collect(node)
    writeFileSync(startPath, 'go\n', { mode: 0o600 })
    const results = await Promise.all([bashResult, nodeResult])
    expect(results.filter(result => result.code === 0)).toHaveLength(1)
    expect(results.filter(result => result.code !== 0)).toHaveLength(1)
    expect(results.map(result => result.stdout.trim()).filter(Boolean)).toHaveLength(1)
    expect(existsSync(value.lockPath)).toBe(false)
  })

  it('lets Node recognize a live Shell owner and recover it only after death', async () => {
    const value = fixture()
    const holder = spawn('/bin/bash', ['-c', shellScript(value.runDirectory, [
      'acquire_shared_deployment_lock',
      'printf "READY\\n"',
      'while :; do sleep 1; done',
    ].join('\n'))], { stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(holder)
    expect(await waitForLine(holder)).toBe('READY')
    const lockModule = await import(pathToFileURL(nodeHelper).href)
    expect(() => lockModule.acquireSharedDeploymentLockSync({ runDirectory: value.runDirectory }))
      .toThrow('another shared deployment operation is active')
    holder.kill('SIGKILL')
    await waitForExit(holder)
    const lock = lockModule.acquireSharedDeploymentLockSync({ runDirectory: value.runDirectory })
    lock.release()
    expect(existsSync(value.lockPath)).toBe(false)
  })

  it('lets Shell recognize a live Node owner and recover it only after death', async () => {
    const value = fixture()
    const moduleUrl = pathToFileURL(nodeHelper).href
    const source = [
      'import { acquireSharedDeploymentLockSync } from ' + JSON.stringify(moduleUrl),
      'acquireSharedDeploymentLockSync({runDirectory:' + JSON.stringify(value.runDirectory) + '})',
      "console.log('READY')",
      'setInterval(() => {}, 1000)',
    ].join(';')
    const holder = spawn(process.execPath, ['--input-type=module', '-e', source],
      { stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(holder)
    expect(await waitForLine(holder)).toBe('READY')
    const active = runShell(value.runDirectory, 'acquire_shared_deployment_lock')
    expect(active.status).not.toBe(0)
    expect(readFileSync(join(value.lockPath, 'pid'), 'utf8')).toContain(String(holder.pid))
    holder.kill('SIGKILL')
    await waitForExit(holder)
    const recovered = runShell(value.runDirectory, [
      'acquire_shared_deployment_lock',
      'cat "$DEPLOYMENT_LOCK_DIR/pid"',
      'release_shared_deployment_lock',
    ].join('\n'))
    expect(recovered.status, recovered.stderr).toBe(0)
    expect(JSON.parse(recovered.stdout)).toMatchObject({
      schema: 'video-autoworker-shared-deployment-lock-owner/v1',
    })
    expect(existsSync(value.lockPath)).toBe(false)
  })

  it('recovers a strictly formed legacy dead-PID owner in either runtime', async () => {
    const shellValue = fixture()
    makeExisting(shellValue.lockPath, '2147483647\n')
    const shell = runShell(shellValue.runDirectory,
      'acquire_shared_deployment_lock\nrelease_shared_deployment_lock')
    expect(shell.status, shell.stderr).toBe(0)
    expect(existsSync(shellValue.lockPath)).toBe(false)

    const nodeValue = fixture()
    makeExisting(nodeValue.lockPath, '2147483647\n')
    const lockModule = await import(pathToFileURL(nodeHelper).href)
    const lock = lockModule.acquireSharedDeploymentLockSync({ runDirectory: nodeValue.runDirectory })
    lock.release()
    expect(existsSync(nodeValue.lockPath)).toBe(false)
  })

  it('recovers historical empty and dead pending-owner locks without exposing a new empty lock', async () => {
    const lockModule = await import(pathToFileURL(nodeHelper).href)
    const empty = fixture()
    mkdirSync(empty.lockPath, { mode: 0o700 })
    const nodeLease = lockModule.acquireSharedDeploymentLockSync({ runDirectory: empty.runDirectory })
    expect(JSON.parse(readFileSync(join(empty.lockPath, 'pid'), 'utf8'))).toMatchObject({
      pid: process.pid,
      schema: 'video-autoworker-shared-deployment-lock-owner/v1',
    })
    nodeLease.release()

    const pending = fixture()
    mkdirSync(pending.lockPath, { mode: 0o700 })
    writeFileSync(join(pending.lockPath, `pid.pending.2147483647.${'a'.repeat(64)}`), '', { mode: 0o600 })
    const shell = runShell(pending.runDirectory,
      'acquire_shared_deployment_lock\nrelease_shared_deployment_lock')
    expect(shell.status, shell.stderr).toBe(0)
    expect(existsSync(pending.lockPath)).toBe(false)
  })

  it('preserves a live pending-owner publication instead of reclaiming it', async () => {
    const value = fixture()
    mkdirSync(value.lockPath, { mode: 0o700 })
    const pendingPath = join(value.lockPath, `pid.pending.${process.pid}.${'b'.repeat(64)}`)
    writeFileSync(pendingPath, '', { mode: 0o600 })
    const lockModule = await import(pathToFileURL(nodeHelper).href)
    expect(() => lockModule.acquireSharedDeploymentLockSync({ runDirectory: value.runDirectory }))
      .toThrow('another shared deployment operation is active')
    expect(runShell(value.runDirectory, 'acquire_shared_deployment_lock').status).not.toBe(0)
    expect(existsSync(pendingPath)).toBe(true)
  })

  it('fails closed for a live legacy owner and damaged or unknown states', async () => {
    const lockModule = await import(pathToFileURL(nodeHelper).href)
    const live = fixture()
    makeExisting(live.lockPath, String(process.pid) + '\n')
    expect(runShell(live.runDirectory, 'acquire_shared_deployment_lock').status).not.toBe(0)
    expect(() => lockModule.acquireSharedDeploymentLockSync({ runDirectory: live.runDirectory }))
      .toThrow('another shared deployment operation is active')
    expect(existsSync(live.lockPath)).toBe(true)

    for (const kind of ['lock-mode', 'owner-mode', 'extra', 'invalid']) {
      const value = fixture()
      makeExisting(
        value.lockPath,
        kind === 'invalid' ? '{"pid":2147483647}\n' : '2147483647\n',
        {
          lockMode: kind === 'lock-mode' ? 0o755 : 0o700,
          ownerMode: kind === 'owner-mode' ? 0o644 : 0o600,
          extra: kind === 'extra',
        },
      )
      const result = runShell(value.runDirectory, 'acquire_shared_deployment_lock')
      expect(result.status, kind).not.toBe(0)
      expect(() => lockModule.acquireSharedDeploymentLockSync({ runDirectory: value.runDirectory }))
        .toThrow()
      expect(existsSync(value.lockPath), kind).toBe(true)
    }
  })

  it('refuses release after same-content owner inode replacement', () => {
    const value = fixture()
    const result = runShell(value.runDirectory, [
      'acquire_shared_deployment_lock',
      'cp "$DEPLOYMENT_LOCK_DIR/pid" "$DEPLOYMENT_LOCK_DIR/replacement"',
      'chmod 600 "$DEPLOYMENT_LOCK_DIR/replacement"',
      'rm "$DEPLOYMENT_LOCK_DIR/pid"',
      'mv "$DEPLOYMENT_LOCK_DIR/replacement" "$DEPLOYMENT_LOCK_DIR/pid"',
      'release_shared_deployment_lock',
    ].join('\n'))
    expect(result.status).not.toBe(0)
    expect(existsSync(value.lockPath)).toBe(true)
  })

  it('never deletes a successor that acquires canonical after the lease directory moves away', async () => {
    const value = fixture()
    const lockModule = await import(pathToFileURL(nodeHelper).href)
    const first = lockModule.acquireSharedDeploymentLockSync({ runDirectory: value.runDirectory })
    const displaced = `${value.lockPath}.displaced`
    renameSync(value.lockPath, displaced)
    const successor = lockModule.acquireSharedDeploymentLockSync({ runDirectory: value.runDirectory })
    const successorSource = readFileSync(join(value.lockPath, 'pid'), 'utf8')
    expect(() => first.release()).toThrow('lock ownership changed before release')
    expect(readFileSync(join(value.lockPath, 'pid'), 'utf8')).toBe(successorSource)
    successor.release()
    rmSync(displaced, { recursive: true, force: true })
  })
})
