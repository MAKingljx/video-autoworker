import { constants, closeSync, fstatSync, openSync, readFileSync, lstatSync } from 'node:fs'
import http from 'node:http'
import { isAbsolute, join } from 'node:path'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'

export const SCHEDULER_WORKER_SCHEMA = 'video-autoworker-scheduler-worker/v1'
export const WORKER_IPC_MAX_BYTES = 65_536

/** The socket is a same-user local channel, never a second user-auth boundary. */
export function schedulerWorkerSocket(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.AIWORKER_SCHEDULER_STATE_DIR
  if (!root || !isAbsolute(root)) throw new Error('scheduler_worker_state_unconfigured')
  const info = lstatSync(root)
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)
    || (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
    throw new Error('scheduler_worker_state_unsafe')
  }
  const socket = join(root, 'worker.sock')
  if (Buffer.byteLength(socket) > 100) throw new Error('scheduler_worker_socket_path_too_long')
  return socket
}

export function assertWorkerSocket(pathname: string): void {
  const info = lstatSync(pathname)
  if (!info.isSocket() || (info.mode & 0o077)
    || (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
    throw new Error('scheduler_worker_socket_unsafe')
  }
}

export function readSchedulerWorkerReceipt(env: NodeJS.ProcessEnv = process.env) {
  const pathname = join(env.AIWORKER_SCHEDULER_STATE_DIR || '', 'worker-status.json')
  schedulerWorkerSocket(env)
  const descriptor = openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = fstatSync(descriptor)
    if (!info.isFile() || info.size > WORKER_IPC_MAX_BYTES || (info.mode & 0o077)
      || (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
      throw new Error('scheduler_worker_receipt_unsafe')
    }
    const receipt = JSON.parse(readFileSync(descriptor, 'utf8'))
    if (receipt.schema !== SCHEDULER_WORKER_SCHEMA
      || !Number.isSafeInteger(receipt.observedAt)
      || Math.abs(Date.now() - receipt.observedAt) > 15_000) {
      throw new Error('scheduler_worker_receipt_stale')
    }
    return receipt
  } finally { closeSync(descriptor) }
}

export function requestSchedulerWorker<T = any>(
  pathname: '/status' | '/trigger' | '/drain' | '/event',
  body?: unknown,
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<T> {
  return new Promise((resolve, reject) => {
    let socketPath: string
    try {
      socketPath = schedulerWorkerSocket(options.env)
      assertWorkerSocket(socketPath)
    } catch (error) { reject(error); return }
    const payload = body === undefined ? undefined : JSON.stringify(body)
    if (payload && Buffer.byteLength(payload) > WORKER_IPC_MAX_BYTES) {
      reject(new Error('scheduler_worker_request_too_large')); return
    }
    const request = http.request({ socketPath, path: pathname,
      method: body === undefined ? 'GET' : 'POST',
      headers: payload ? { 'Content-Type': 'application/json' } : {},
    }, response => {
      const chunks: Buffer[] = []
      let bytes = 0
      response.on('data', chunk => {
        bytes += chunk.length
        if (bytes > WORKER_IPC_MAX_BYTES) response.destroy(new Error('scheduler_worker_response_too_large'))
        else chunks.push(chunk)
      })
      response.on('error', reject)
      response.on('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (response.statusCode !== 200) throw new Error(value.error || 'scheduler_worker_request_failed')
          resolve(value)
        } catch (error) { reject(error) }
      })
    })
    request.on('error', reject)
    request.setTimeout(options.timeoutMs ?? 5_000,
      () => request.destroy(new Error('scheduler_worker_request_timeout')))
    request.end(payload)
  })
}

/** Live same-user socket read, additionally bound to the caller's database. */
export async function getExternalSchedulerStatus(options: { databasePath?: string } = {}) {
  const status = await requestSchedulerWorker('/status')
  const databasePath = options.databasePath || process.env.MISSION_CONTROL_DB_PATH
  if (!databasePath) throw new Error('scheduler_worker_database_unconfigured')
  const info = lstatSync(databasePath)
  const identity = status?.worker?.database
  const pathSha256 = createHash('sha256').update(realpathSync(databasePath)).digest('hex')
  if (status.schema !== SCHEDULER_WORKER_SCHEMA || status.executionMode !== 'external-worker'
    || !Number.isSafeInteger(status.observedAt) || Math.abs(Date.now() - status.observedAt) > 15_000
    || !Number.isSafeInteger(status.worker?.pid) || status.worker.pid < 1
    || !/^[a-f0-9]{64}$/.test(status.worker?.contentSha256 || '')
    || String(info.dev) !== identity?.dev || String(info.ino) !== identity?.ino
    || pathSha256 !== identity?.pathSha256 || !info.isFile() || info.isSymbolicLink()) {
    throw new Error('scheduler_worker_status_identity_invalid')
  }
  return status
}
