import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, openSync,
  readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { join } from 'node:path'
import { schedulerWorkerSocket, SCHEDULER_WORKER_SCHEMA, WORKER_IPC_MAX_BYTES } from '../lib/scheduler-worker-ipc'
import type { ServerEvent } from '../lib/event-bus'

const digest = (value: string) => createHash('sha256').update(value).digest('hex')

function readPrivateJson(pathname: string) {
  const fd = openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.size > WORKER_IPC_MAX_BYTES || (info.mode & 0o077)
      || (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
      throw new Error('scheduler_worker_private_file_unsafe')
    }
    return JSON.parse(readFileSync(fd, 'utf8'))
  } finally { closeSync(fd) }
}

export async function startSchedulerWorker() {
  if (process.env.NODE_ENV !== 'production' || process.env.AIWORKER_SCHEDULER_MODE !== 'worker'
    || !/^[a-f0-9]{64}$/.test(process.env.AIWORKER_WORKER_CONTENT_SHA256 || '')
    || process.env.AIWORKER_SLOT || process.env.AIWORKER_RELEASE_ID
    || process.env.AIWORKER_RUNTIME_ROLE || process.env.MISSION_CONTROL_TEST_MODE === '1') {
    throw new Error('scheduler_worker_identity_invalid')
  }
  const socketPath = schedulerWorkerSocket()
  const stateDir = process.env.AIWORKER_SCHEDULER_STATE_DIR!
  const configuredDb = process.env.MISSION_CONTROL_DB_PATH
  if (!configuredDb) throw new Error('scheduler_worker_database_unconfigured')
  const dbPath = realpathSync(configuredDb)
  const dbStat = lstatSync(configuredDb)
  if (!dbStat.isFile() || dbStat.isSymbolicLink() || (dbStat.mode & 0o077)
    || (typeof process.getuid === 'function' && dbStat.uid !== process.getuid())) {
    throw new Error('scheduler_worker_database_unsafe')
  }
  const database = { dev: String(dbStat.dev), ino: String(dbStat.ino), pathSha256: digest(dbPath) }
  // The deployment controller writes this only after observing the old web
  // scheduler stopped. It is a migration receipt, not a second task authority.
  const handoff = readPrivateJson(join(stateDir, 'handoff.json'))
  if (handoff.schema !== 'video-autoworker-scheduler-handoff/v1'
    || (handoff.migrationPending !== true && handoff.oldSchedulerStopped !== true
      && handoff.oldSchedulerReleased !== true)
    || !Number.isSafeInteger(handoff.verifiedAt) || handoff.verifiedAt > Date.now()
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(handoff.operationId || '')
    || (handoff.migrationPending === true && handoff.targetWorkerContentSha256 !== undefined
      && handoff.targetWorkerContentSha256 !== process.env.AIWORKER_WORKER_CONTENT_SHA256)
    || (handoff.targetApplicationCommit !== undefined && !/^[a-f0-9]{40}$/.test(handoff.targetApplicationCommit))
    || ['dev', 'ino', 'pathSha256'].some(key => handoff.database?.[key] !== database[key as keyof typeof database])) {
    throw new Error('scheduler_worker_handoff_invalid')
  }
  if (existsSync(socketPath)) {
    const info = lstatSync(socketPath)
    if (!info.isSocket() || (info.mode & 0o077)
      || (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
      throw new Error('scheduler_worker_socket_unsafe')
    }
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(socketPath)
      socket.once('connect', () => { socket.destroy(); reject(new Error('scheduler_worker_already_running')) })
      socket.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ECONNREFUSED') { reject(error); return }
        const current = lstatSync(socketPath)
        if (current.dev !== info.dev || current.ino !== info.ino) {
          reject(new Error('scheduler_worker_socket_changed')); return
        }
        unlinkSync(socketPath)
        resolve()
      })
    })
  }
  // All environment and migration guards precede importing application code.
  const { getDatabase, closeDatabase } = await import('../lib/db')
  const scheduler = await import('../lib/scheduler')
  const { eventBus } = await import('../lib/event-bus')
  const { initWebhookListener } = await import('../lib/webhooks')
  const db = getDatabase()
  const openedPath = lstatSync(configuredDb)
  if (String(openedPath.dev) !== database.dev || String(openedPath.ino) !== database.ino
    || openedPath.isSymbolicLink()) {
    closeDatabase()
    throw new Error('scheduler_worker_database_changed_during_open')
  }
  if (handoff.migrationPending === true) {
    const previous = handoff.previous
    if (!Number.isSafeInteger(previous?.pid) || previous.pid < 1
      || !['blue', 'green'].includes(previous?.slot)
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(previous?.releaseId || '')
      || !Number.isSafeInteger(previous?.routerGeneration) || previous.routerGeneration < 1
      || !/^[a-f0-9]{32}$/.test(previous?.leaseHolderId || '')
      || !Number.isSafeInteger(previous?.leaseRevision) || previous.leaseRevision < 1) {
      throw new Error('scheduler_worker_pending_handoff_invalid')
    }
    try { process.kill(previous.pid, 0) }
    catch { throw new Error('scheduler_worker_previous_process_unavailable') }
    const lease = db.prepare(`SELECT holder_id, revision, lease_expires_at
      FROM scheduler_leader_leases WHERE lease_name = 'builtin_scheduler'`).get() as
      { holder_id: string; revision: number; lease_expires_at: number } | undefined
    if (!lease || lease.holder_id !== previous.leaseHolderId || lease.revision < previous.leaseRevision
      || lease.lease_expires_at <= Math.floor(Date.now() / 1000)) {
      throw new Error('scheduler_worker_previous_lease_changed')
    }
  }
  const startedAt = Date.now()
  let stopping = false
  let closed = false
  const clients = new Set<http.ServerResponse>()
  const state = () => {
    let liveHandoff = handoff
    let handoffMatches = true
    try {
      const latest = readPrivateJson(join(stateDir, 'handoff.json'))
      handoffMatches = latest.schema === handoff.schema && latest.operationId === handoff.operationId
        && latest.targetApplicationCommit === handoff.targetApplicationCommit
        && latest.targetWorkerContentSha256 === handoff.targetWorkerContentSha256
        && ['dev', 'ino', 'pathSha256'].every(key => latest.database?.[key] === database[key as keyof typeof database])
        && (latest.migrationPending === true || latest.oldSchedulerReleased === true || latest.oldSchedulerStopped === true)
      if (handoffMatches) liveHandoff = latest
    } catch { handoffMatches = false }
    let databaseMatches = false
    try {
      const currentDb = lstatSync(configuredDb)
      databaseMatches = String(currentDb.dev) === database.dev
        && String(currentDb.ino) === database.ino && !currentDb.isSymbolicLink()
    } catch { /* A vanished database is an unhealthy identity, never a replacement file. */ }
    const leadership = scheduler.getSchedulerLeadershipStatus()
    let leaseVerified = false
    try { leaseVerified = leadership.state === 'leader' && scheduler.schedulerOwnsCurrentLease() }
    catch { /* A failed lease read cannot authorize work. */ }
    const healthy = databaseMatches && handoffMatches && leaseVerified && !stopping
    return { schema: SCHEDULER_WORKER_SCHEMA, executionMode: 'external-worker',
      currentState: stopping ? 'draining' : healthy ? 'ready' : 'waiting',
      errorCode: !databaseMatches ? 'scheduler_worker_database_changed'
        : !handoffMatches ? 'scheduler_worker_handoff_changed'
        : !leaseVerified ? 'scheduler_worker_lease_not_owned' : null,
      nextAction: stopping ? 'wait_for_owned_jobs' : healthy ? null : 'inspect_worker_lease',
      observedAt: Date.now(), healthy, leaseVerified, leadership,
      handoff: { operationId: liveHandoff.operationId, migrationPending: liveHandoff.migrationPending === true,
        targetApplicationCommit: liveHandoff.targetApplicationCommit || null,
        previous: liveHandoff.migrationPending === true ? { pid: liveHandoff.previous.pid, slot: liveHandoff.previous.slot,
          releaseId: liveHandoff.previous.releaseId, routerGeneration: liveHandoff.previous.routerGeneration } : null },
      worker: { pid: process.pid, startedAt, contentSha256: process.env.AIWORKER_WORKER_CONTENT_SHA256,
        database, observedAt: Date.now() },
      tasks: scheduler.getSchedulerStatus() }
  }
  const publishReceipt = () => {
    const value = state()
    if (value.errorCode === 'scheduler_worker_database_changed' || value.errorCode === 'scheduler_worker_handoff_changed') {
      stopping = true
      scheduler.stopScheduler()
    }
    const temporary = join(stateDir, `.worker-status-${process.pid}-${randomUUID()}.tmp`)
    const { tasks: _tasks, ...receipt } = value
    writeFileSync(temporary, JSON.stringify(receipt), { mode: 0o600, flag: 'wx' })
    renameSync(temporary, join(stateDir, 'worker-status.json'))
  }
  const forwardEvent = (event: ServerEvent) => {
    const line = `${JSON.stringify(event)}\n`
    if (Buffer.byteLength(line) > WORKER_IPC_MAX_BYTES) return
    for (const client of clients) {
      // Slow subscribers reconnect and refresh authoritative API state.
      if (!client.write(line)) { clients.delete(client); client.destroy() }
    }
  }
  const reply = (response: http.ServerResponse, code: number, value: unknown) => {
    response.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    response.end(JSON.stringify(value))
  }
  const server = http.createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/status') {
      reply(response, 200, state()); return
    }
    if (request.method === 'GET' && request.url === '/events') {
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' })
      response.write('\n')
      clients.add(response)
      response.on('close', () => clients.delete(response))
      return
    }
    if (request.method !== 'POST' || !['/trigger', '/drain', '/event'].includes(request.url || '')) {
      reply(response, 404, { error: 'scheduler_worker_route_not_found' }); return
    }
    let size = 0
    const chunks: Buffer[] = []
    try {
      for await (const chunk of request) {
        size += chunk.length
        if (size > WORKER_IPC_MAX_BYTES) throw new Error('scheduler_worker_request_too_large')
        chunks.push(chunk)
      }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      if (request.url === '/drain') {
        stopping = true
        scheduler.stopScheduler()
        publishReceipt()
        reply(response, 200, state())
      } else if (request.url === '/event') {
        if (!state().healthy) { reply(response, 503, { error: 'scheduler_worker_not_ready' }); return }
        if (typeof value.type !== 'string' || !/^[a-z][a-z0-9_.]{1,80}$/.test(value.type)
          || typeof value.eventId !== 'string' || typeof value.sourceId !== 'string'
          || !Number.isSafeInteger(value.timestamp)) throw new Error('scheduler_worker_event_invalid')
        eventBus.acceptRemote(value)
        reply(response, 200, { ok: true })
      } else {
        const allowed = scheduler.getSchedulerStatus().map(task => task.id)
        if (stopping || !allowed.includes(value.task_id)) throw new Error('scheduler_worker_task_invalid')
        reply(response, 200, await scheduler.triggerTask(value.task_id))
      }
    } catch {
      if (!response.headersSent) reply(response, 400, { error: 'scheduler_worker_request_invalid' })
    }
  })
  server.requestTimeout = 0 // The scheduler owns cancellation and long task lifetimes.
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => { chmodSync(socketPath, 0o600); resolve() })
  })
  initWebhookListener()
  eventBus.on('server-event', forwardEvent)
  scheduler.initScheduler()
  publishReceipt()
  const receiptTimer = setInterval(publishReceipt, 5_000)
  const close = async () => {
    if (closed) return
    closed = true
    clearInterval(receiptTimer)
    eventBus.off('server-event', forwardEvent)
    for (const client of clients) client.end()
    await new Promise<void>(resolve => server.close(() => resolve()))
    closeDatabase()
  }
  const stop = async () => {
    stopping = true
    scheduler.stopScheduler()
    publishReceipt()
    while (!scheduler.isSchedulerStopped()) {
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    await close()
  }
  process.once('SIGTERM', () => { void stop().then(() => process.exit(0)) })
  process.once('SIGINT', () => { void stop().then(() => process.exit(0)) })
  return { state, stop, server }
}
