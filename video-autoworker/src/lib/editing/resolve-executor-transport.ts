import { createHash, randomUUID } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createConnection } from 'node:net'
import type { EditPlan } from './edit-plan'
import {
  type ResolveExecutorOperation, type ResolveExecutorTransport, type ResolveExecutorSnapshot,
  ResolveExecutorRejected,
} from './resolve-executor'
import {
  decodeResolveExecutorResponse, encodeResolveExecutorRequest,
  type ResolveExecutorRequest, type ResolveExecutorResponse,
} from './resolve-executor-protocol'

const MAX_BYTES = 4 * 1024 * 1024

async function validateSocket(path: string): Promise<void> {
  if (resolve(path) !== path || await realpath(dirname(path)) !== dirname(path)) throw new Error('resolve_socket_path_invalid')
  const [parent, socket] = await Promise.all([lstat(dirname(path)), lstat(path)])
  const uid = process.getuid?.()
  if (uid === undefined || !parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o777) !== 0o700
    || !socket.isSocket() || socket.uid !== uid || (socket.mode & 0o777) !== 0o600) {
    throw new Error('resolve_socket_permissions')
  }
}

/** Local AF_UNIX only. No shell command, TCP endpoint or secret is accepted. */
export async function requestResolveExecutor(socketPath: string, request: ResolveExecutorRequest, signal?: AbortSignal): Promise<ResolveExecutorResponse> {
  await validateSocket(socketPath)
  if (signal?.aborted) throw new Error('resolve_request_cancelled')
  const payload = encodeResolveExecutorRequest(request)
  if (Buffer.byteLength(payload) > MAX_BYTES) throw new Error('resolve_request_too_large')
  return new Promise((done, fail) => {
    const socket = createConnection({ path: socketPath })
    let received = Buffer.alloc(0)
    let settled = false
    const settle = (error?: Error, response?: ResolveExecutorResponse) => {
      if (settled) return
      settled = true
      clearTimeout(connectTimer)
      signal?.removeEventListener('abort', abort)
      socket.destroy()
      if (error) fail(error)
      else done(response!)
    }
    const abort = () => settle(new Error('resolve_request_cancelled'))
    // Only the connection is bounded. Resolve work has cancellation/status,
    // not a synthetic total runtime deadline that kills valid long renders.
    const connectTimer = setTimeout(() => settle(new Error('resolve_connection_timeout')), 10_000)
    signal?.addEventListener('abort', abort, { once: true })
    socket.once('connect', () => { clearTimeout(connectTimer); socket.write(payload) })
    socket.on('data', chunk => {
      received = Buffer.concat([received, chunk])
      if (received.byteLength > MAX_BYTES) return settle(new Error('resolve_response_too_large'))
      const newline = received.indexOf(10)
      if (newline < 0) return
      if (newline !== received.length - 1) return settle(new Error('resolve_response_framing_invalid'))
      try {
        const response = decodeResolveExecutorResponse(received.subarray(0, newline).toString('utf8'))
        if (response.requestId !== request.requestId || response.operationId !== request.operationId) {
          return settle(new Error('resolve_response_identity_mismatch'))
        }
        settle(undefined, response)
      } catch { settle(new Error('resolve_response_invalid')) }
    })
    socket.once('error', () => settle(new Error('resolve_transport_unavailable')))
    socket.once('end', () => settle(new Error('resolve_transport_connection_lost')))
  })
}

export function createUnixResolveExecutorTransport(options: { socketPath: string; signal?: AbortSignal }): ResolveExecutorTransport {
  const send = (action: ResolveExecutorRequest['action'], operation?: ResolveExecutorOperation, plan?: EditPlan) => {
    const requestId = randomUUID()
    return requestResolveExecutor(options.socketPath, {
      schemaVersion: 1, requestId,
      operationId: operation?.operationId || 'resolve-operation:' + createHash('sha256').update(requestId).digest('hex'),
      action, ...(plan ? { planJson: JSON.stringify(plan) } : {}),
      payload: operation ? { operation, expectedProcessIdentity: operation.executorProcessIdentity } : {},
    }, options.signal)
  }
  return {
    async inspect() {
      const response = await send('inspect')
      if (response.status !== 'succeeded' || !response.result) throw new Error(response.errorCode || 'resolve_inspect_unavailable')
      const result = response.result
      if (result.connected !== true || typeof result.nodeId !== 'string' || typeof result.processIdentity !== 'string'
        || typeof result.resolveVersion !== 'string' || typeof result.studio !== 'boolean' || !Array.isArray(result.capabilities)) {
        throw new Error('resolve_snapshot_invalid')
      }
      return result as ResolveExecutorSnapshot
    },
    async apply(operation, plan) {
      const response = await send('apply', operation, plan)
      if (response.status === 'failed') throw new ResolveExecutorRejected(response.errorCode || 'resolve_operation_rejected')
      if (!response.result || response.status === 'unknown') throw new Error(response.errorCode || 'resolve_operation_outcome_unknown')
      return { result: response.result, status: response.status === 'accepted' ? 'running' : 'succeeded' }
    },
    async reconcile(operation, plan) {
      const response = await send('status', operation, plan)
      return { operationId: response.operationId, status: response.status === 'accepted' ? 'running' : response.status,
        result: response.result, errorCode: response.errorCode }
    },
    async cancel(operation) {
      const response = await send('cancel', operation)
      if (response.status !== 'cancelled') throw new ResolveExecutorRejected(response.errorCode || 'resolve_cancel_not_confirmed')
    },
  }
}
