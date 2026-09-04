import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  access,
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import {
  issueWorkerLaunchAuthorizationSync,
  workerLaunchAuthorizationPath,
} from '../lib/worker-launch-authorization.mjs'

const workerScript = fileURLToPath(new URL('../scripts/run-video-batch.mjs', import.meta.url))
const GUARDIAN_SCHEMA = 'video-autoworker-worker-launch-guardian/v2'

function ordinaryMarker(pid = process.pid) {
  return {
    pid,
    createdAt: '2026-09-01T00:00:00.000Z',
  }
}

function guardianMarker(pid = process.pid) {
  return {
    schema: GUARDIAN_SCHEMA,
    pid,
    token: randomBytes(32).toString('hex'),
    createdAt: '2026-09-01T00:00:00.000Z',
  }
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 })
}

async function createOccupiedGlobalLock(root) {
  await writeJson(join(root, '.global-video-worker.lock'), {
    pid: process.pid,
    token: randomBytes(16).toString('hex'),
    createdAt: '2026-09-01T00:00:00.000Z',
  })
}

async function createFinalReadiness(root) {
  const pathname = join(root, 'final-readiness.json')
  await writeJson(pathname, {
    schema: 'video-autoworker-test-final-readiness/v1',
    ready: true,
  })
  await chmod(pathname, 0o400)
  return pathname
}

async function pathExists(path) {
  try {
    await access(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function startWorker(root, { importScript, env = {} } = {}) {
  const nodeOptions = [
    process.env.NODE_OPTIONS,
    importScript ? `--import=${pathToFileURL(importScript).href}` : '',
  ].filter(Boolean).join(' ')
  const child = spawn(process.execPath, [workerScript, '--serve-root', root], {
    env: {
      ...process.env,
      ...env,
      ...(nodeOptions ? { NODE_OPTIONS: nodeOptions } : {}),
      AIWORKER_VIDEO_RECOVERY_BACKOFF_MS: '1000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  return { child, output: () => ({ stdout, stderr }) }
}

async function waitForExit(running, timeoutMs = 5_000) {
  const { child, output } = running
  let timeout
  try {
    const result = await Promise.race([
      new Promise(resolvePromise => {
        child.once('error', error => resolvePromise({ code: null, signal: null, error }))
        child.once('exit', (code, signal) => resolvePromise({ code, signal, error: null }))
      }),
      new Promise(resolvePromise => {
        timeout = setTimeout(() => resolvePromise({ timeout: true }), timeoutMs)
      }),
    ])
    if (result.timeout) {
      child.kill('SIGKILL')
      await new Promise(resolvePromise => child.once('exit', resolvePromise))
      assert.fail(`worker did not exit within ${timeoutMs}ms`)
    }
    if (result.error) throw result.error
    return { ...result, ...output() }
  } finally {
    clearTimeout(timeout)
  }
}

async function waitUntil(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolvePromise => setTimeout(resolvePromise, 10))
  }
  assert.fail(`condition was not met within ${timeoutMs}ms`)
}

async function globalLockBelongsTo(path, pid) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'))
    return value.pid === pid && typeof value.token === 'string' && value.token.length > 0
  } catch {
    return false
  }
}

test('occupied global lock consumes only a strictly formatted ordinary launcher marker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiworker-worker-marker-ordinary-'))
  const marker = join(root, '.worker-launch.lock')
  try {
    await createOccupiedGlobalLock(root)
    await writeJson(marker, ordinaryMarker())

    const result = await waitForExit(startWorker(root))

    assert.equal(result.code, 0)
    assert.equal(result.stderr, '')
    assert.equal(await pathExists(marker), false)
    assert.equal(await pathExists(join(root, '.global-video-worker.lock')), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('occupied global lock never consumes a guardian v2 marker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiworker-worker-marker-guardian-'))
  const marker = join(root, '.worker-launch.lock')
  const guardian = guardianMarker()
  try {
    await createOccupiedGlobalLock(root)
    await writeJson(marker, guardian)

    const result = await waitForExit(startWorker(root))

    assert.equal(result.code, 0)
    assert.equal(result.stderr, '')
    assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), guardian)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('new worker keeps guardian while holding the global lock until exact authorization arrives', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiworker-worker-marker-handoff-'))
  const marker = join(root, '.worker-launch.lock')
  const authorization = workerLaunchAuthorizationPath(root)
  try {
    await writeJson(marker, guardianMarker())
    const finalReadinessPath = await createFinalReadiness(root)
    const running = startWorker(root)
    await waitUntil(() => globalLockBelongsTo(join(root, '.global-video-worker.lock'), running.child.pid))

    await new Promise(resolvePromise => setTimeout(resolvePromise, 150))
    assert.equal(await pathExists(marker), true)
    assert.equal(await pathExists(authorization), false)

    process.kill(running.child.pid, 'SIGSTOP')
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
    const issued = issueWorkerLaunchAuthorizationSync({
      batchRoot: root,
      workerPid: running.child.pid,
      finalReadinessPath,
    })
    const issuedAgain = issueWorkerLaunchAuthorizationSync({
      batchRoot: root,
      workerPid: running.child.pid,
      finalReadinessPath,
    })
    assert.equal(issuedAgain.sha256, issued.sha256)
    assert.equal(issued.value.workerPid, running.child.pid)
    assert.equal(issued.value.marker.path, marker)
    assert.equal(issued.value.globalLock.path, join(root, '.global-video-worker.lock'))
    assert.equal(issued.value.finalReadiness.path, finalReadinessPath)
    process.kill(running.child.pid, 'SIGCONT')
    await waitUntil(async () => !await pathExists(marker) && !await pathExists(authorization))

    const lock = JSON.parse(await readFile(join(root, '.global-video-worker.lock'), 'utf8'))
    assert.equal(lock.pid, running.child.pid)
    assert.doesNotThrow(() => process.kill(running.child.pid, 0))

    running.child.kill('SIGKILL')
    const result = await waitForExit(running)
    assert.equal(result.signal, 'SIGKILL')
    assert.equal(result.stderr, '')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('detached serve-root cannot bypass a guardian without controller authorization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiworker-worker-marker-no-authorization-'))
  const marker = join(root, '.worker-launch.lock')
  const guardian = guardianMarker()
  try {
    await writeJson(marker, guardian)
    const result = await waitForExit(startWorker(root, {
      env: { AIWORKER_VIDEO_WORKER_GUARDIAN_AUTH_TIMEOUT_MS: '250' },
    }))

    assert.equal(result.code, 1)
    assert.match(result.stderr, /等待 guardian 授权超时/u)
    assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), guardian)
    assert.equal(await pathExists(workerLaunchAuthorizationPath(root)), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('authorization fails closed on every bound identity drift before consumption', async t => {
  const fixtures = [
    {
      name: 'global lock token and metadata',
      mutate: async ({ lockPath }) => {
        const lock = JSON.parse(await readFile(lockPath, 'utf8'))
        await writeJson(lockPath, { ...lock, token: '00000000-0000-4000-8000-000000000000' })
      },
    },
    {
      name: 'guardian token and metadata',
      mutate: async ({ marker }) => {
        const guardian = JSON.parse(await readFile(marker, 'utf8'))
        await writeJson(marker, { ...guardian, token: '0'.repeat(64) })
      },
    },
    {
      name: 'final readiness immutable identity',
      mutate: async ({ finalReadinessPath }) => {
        await chmod(finalReadinessPath, 0o600)
        await writeJson(finalReadinessPath, {
          schema: 'video-autoworker-test-final-readiness/v1',
          ready: false,
        })
        await chmod(finalReadinessPath, 0o400)
      },
    },
    {
      name: 'authorized worker PID',
      mutate: async ({ authorization }) => {
        const value = JSON.parse(await readFile(authorization, 'utf8'))
        await writeJson(authorization, { ...value, workerPid: value.workerPid + 1 })
      },
    },
  ]

  for (const fixture of fixtures) {
    await t.test(fixture.name, async () => {
      const root = await mkdtemp(join(tmpdir(), 'aiworker-worker-marker-authorization-drift-'))
      const marker = join(root, '.worker-launch.lock')
      const lockPath = join(root, '.global-video-worker.lock')
      const authorization = workerLaunchAuthorizationPath(root)
      try {
        await writeJson(marker, guardianMarker())
        const finalReadinessPath = await createFinalReadiness(root)
        const running = startWorker(root)
        await waitUntil(() => globalLockBelongsTo(lockPath, running.child.pid))
        process.kill(running.child.pid, 'SIGSTOP')
        await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
        issueWorkerLaunchAuthorizationSync({
          batchRoot: root,
          workerPid: running.child.pid,
          finalReadinessPath,
        })
        await fixture.mutate({ authorization, finalReadinessPath, lockPath, marker })
        process.kill(running.child.pid, 'SIGCONT')

        const result = await waitForExit(running)
        assert.equal(result.code, 1)
        assert.match(result.stderr, /(?:启动授权(?:与 marker、worker、全局锁或 final readiness 不匹配|在消费前发生漂移)|视频队列启动标记在读取(?:前|时)已变化|视频队列锁(?:发布后身份不一致|在读取时已变化))/u)
        assert.equal(await pathExists(marker), true)
        assert.equal(await pathExists(authorization), true)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  }
})

test('unknown and symbolic-link markers fail closed without being removed', async t => {
  await t.test('unknown marker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiworker-worker-marker-unknown-'))
    const marker = join(root, '.worker-launch.lock')
    const unknown = { ...ordinaryMarker(), unexpected: true }
    try {
      await createOccupiedGlobalLock(root)
      await writeJson(marker, unknown)
      const result = await waitForExit(startWorker(root))
      assert.equal(result.code, 1)
      assert.match(result.stderr, /启动标记类型不受支持/u)
      assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), unknown)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  await t.test('symbolic-link marker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiworker-worker-marker-symlink-'))
    const target = join(root, 'marker-target.json')
    const marker = join(root, '.worker-launch.lock')
    try {
      await createOccupiedGlobalLock(root)
      await writeJson(target, ordinaryMarker())
      await symlink(target, marker)
      const result = await waitForExit(startWorker(root))
      assert.equal(result.code, 1)
      assert.match(result.stderr, /启动标记身份无效/u)
      assert.equal((await lstat(marker)).isSymbolicLink(), true)
      assert.equal(await readlink(marker), target)
      assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), ordinaryMarker())
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

test('marker replacement before final identity check fails closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiworker-worker-marker-drift-'))
  const marker = join(root, '.worker-launch.lock')
  const originalCopy = join(root, '.worker-launch.lock.original')
  const preload = join(root, 'replace-marker-before-final-lstat.mjs')
  const replacement = ordinaryMarker(process.pid + 1)
  try {
    await createOccupiedGlobalLock(root)
    await writeJson(marker, ordinaryMarker())
    await writeFile(preload, `
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

const marker = process.env.AIWORKER_TEST_MARKER
const originalCopy = process.env.AIWORKER_TEST_ORIGINAL_MARKER
const replacement = process.env.AIWORKER_TEST_REPLACEMENT
const originalLstat = fs.promises.lstat
let markerStats = 0
fs.promises.lstat = async function driftedLstat(target, ...args) {
  if (String(target) === marker && ++markerStats === 2) {
    await fs.promises.rename(marker, originalCopy)
    await fs.promises.writeFile(marker, replacement, { mode: 0o600 })
  }
  return originalLstat.call(this, target, ...args)
}
syncBuiltinESMExports()
`)

    const result = await waitForExit(startWorker(root, {
      importScript: preload,
      env: {
        AIWORKER_TEST_MARKER: marker,
        AIWORKER_TEST_ORIGINAL_MARKER: originalCopy,
        AIWORKER_TEST_REPLACEMENT: `${JSON.stringify(replacement)}\n`,
      },
    }))

    assert.equal(result.code, 1)
    assert.match(result.stderr, /启动标记在清理前已变化/u)
    assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), replacement)
    assert.deepEqual(JSON.parse(await readFile(originalCopy, 'utf8')), ordinaryMarker())
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('same-inode metadata and content drift before removal fails closed', async t => {
  const cases = [
    {
      name: 'permission drift',
      action: 'chmod',
      verify: async ({ marker }) => {
        assert.equal((await lstat(marker)).mode & 0o777, 0o400)
      },
    },
    {
      name: 'hard-link drift',
      action: 'link',
      verify: async ({ marker, peer }) => {
        assert.equal((await lstat(marker)).nlink, 2)
        assert.deepEqual(JSON.parse(await readFile(peer, 'utf8')), ordinaryMarker(111_111))
      },
    },
    {
      name: 'same-length content rewrite',
      action: 'rewrite',
      verify: async ({ marker, initial }) => {
        const current = await lstat(marker)
        assert.equal(current.ino, initial.ino)
        assert.equal(current.size, initial.size)
        assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), ordinaryMarker(222_222))
      },
    },
  ]

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const root = await mkdtemp(join(tmpdir(), 'aiworker-worker-marker-same-inode-drift-'))
      const marker = join(root, '.worker-launch.lock')
      const peer = join(root, '.worker-launch.lock.peer')
      const preload = join(root, 'mutate-marker-before-final-lstat.mjs')
      try {
        await createOccupiedGlobalLock(root)
        await writeJson(marker, ordinaryMarker(111_111))
        const initial = await lstat(marker)
        const replacement = `${JSON.stringify(ordinaryMarker(222_222))}\n`
        assert.equal(Buffer.byteLength(replacement), initial.size)
        await writeFile(preload, `
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

const marker = process.env.AIWORKER_TEST_MARKER
const action = process.env.AIWORKER_TEST_DRIFT_ACTION
const peer = process.env.AIWORKER_TEST_PEER
const replacement = process.env.AIWORKER_TEST_REPLACEMENT
const originalLstat = fs.promises.lstat
let markerStats = 0
fs.promises.lstat = async function driftedLstat(target, ...args) {
  if (String(target) === marker && ++markerStats === 2) {
    if (action === 'chmod') await fs.promises.chmod(marker, 0o400)
    else if (action === 'link') await fs.promises.link(marker, peer)
    else if (action === 'rewrite') await fs.promises.writeFile(marker, replacement)
    else throw new Error('unknown test drift action')
  }
  return originalLstat.call(this, target, ...args)
}
syncBuiltinESMExports()
`)

        const result = await waitForExit(startWorker(root, {
          importScript: preload,
          env: {
            AIWORKER_TEST_MARKER: marker,
            AIWORKER_TEST_DRIFT_ACTION: fixture.action,
            AIWORKER_TEST_PEER: peer,
            AIWORKER_TEST_REPLACEMENT: replacement,
          },
        }))

        assert.equal(result.code, 1)
        assert.match(result.stderr, /启动标记在清理前已变化/u)
        assert.equal(await pathExists(marker), true)
        await fixture.verify({ marker, peer, initial })
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  }
})
