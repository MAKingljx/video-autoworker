import { EventEmitter } from 'events'
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import { assertWorkerSocket, requestSchedulerWorker, schedulerWorkerSocket, WORKER_IPC_MAX_BYTES } from './scheduler-worker-ipc'

/**
 * Server-side event bus for broadcasting database mutations to SSE clients.
 * Singleton per Next.js server process.
 */

export interface ServerEvent {
  type: string
  data: any
  timestamp: number
  eventId?: string
  sourceId?: string
  relayed?: boolean
}

// Event types emitted by the bus
export type EventType =
  | 'task.created'
  | 'task.updated'
  | 'task.deleted'
  | 'task.status_changed'
  | 'chat.message'
  | 'chat.message.deleted'
  | 'notification.created'
  | 'notification.read'
  | 'activity.created'
  | 'agent.updated'
  | 'agent.created'
  | 'agent.deleted'
  | 'agent.synced'
  | 'agent.status_changed'
  | 'audit.security'
  | 'security.event'
  | 'connection.created'
  | 'connection.disconnected'
  | 'github.synced'
  | 'run.created'
  | 'run.updated'
  | 'run.completed'
  | 'run.eval_attached'

class ServerEventBus extends EventEmitter {
  private static instance: ServerEventBus | null = null
  private readonly sourceId = randomUUID()
  private remoteRequest: http.ClientRequest | null = null
  private retry: ReturnType<typeof setTimeout> | null = null

  private constructor() {
    super()
    this.setMaxListeners(50)
    this.on('newListener', event => {
      if (event === 'server-event') queueMicrotask(() => this.connectWorker())
    })
    this.on('removeListener', event => {
      if (event === 'server-event' && this.listenerCount(event) === 0) this.disconnectWorker()
    })
  }

  static getInstance(): ServerEventBus {
    if (!ServerEventBus.instance) {
      ServerEventBus.instance = new ServerEventBus()
    }
    return ServerEventBus.instance
  }

  /**
   * Broadcast an event to all SSE listeners
   */
  broadcast(type: EventType, data: any): ServerEvent {
    const event: ServerEvent = { type, data, timestamp: Date.now(),
      eventId: randomUUID(), sourceId: this.sourceId }
    this.emit('server-event', event)
    if (process.env.AIWORKER_SCHEDULER_MODE !== 'worker'
      && process.env.AIWORKER_SCHEDULER_STATE_DIR) {
      // Notification delivery is transient. Business recovery reads SQLite;
      // an unavailable subscriber never rolls back the authoritative mutation.
      void requestSchedulerWorker('/event', event).catch(() => {})
    }
    return event
  }

  acceptRemote(event: ServerEvent): void {
    if (event.sourceId !== this.sourceId) this.emit('server-event', { ...event, relayed: true })
  }

  private disconnectWorker(): void {
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    this.remoteRequest?.destroy()
    this.remoteRequest = null
  }

  private connectWorker(): void {
    if (process.env.AIWORKER_SCHEDULER_MODE === 'worker'
      || !process.env.AIWORKER_SCHEDULER_STATE_DIR
      || this.remoteRequest || this.listenerCount('server-event') === 0) return
    const reconnect = () => {
      this.remoteRequest = null
      if (!this.retry && this.listenerCount('server-event') > 0) {
        this.retry = setTimeout(() => { this.retry = null; this.connectWorker() }, 1_000)
        this.retry.unref()
      }
    }
    try {
      const socketPath = schedulerWorkerSocket()
      assertWorkerSocket(socketPath)
      const request = http.get({ socketPath, path: '/events' }, response => {
        if (response.statusCode !== 200) { response.destroy(); reconnect(); return }
        let pending = ''
        response.setEncoding('utf8')
        response.on('data', chunk => {
          pending += chunk
          if (Buffer.byteLength(pending) > WORKER_IPC_MAX_BYTES) {
            response.destroy(); return
          }
          let index: number
          while ((index = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, index)
            pending = pending.slice(index + 1)
            if (!line) continue
            try { this.acceptRemote(JSON.parse(line)) } catch { response.destroy(); return }
          }
        })
        response.on('close', reconnect)
        response.on('error', () => {})
      })
      this.remoteRequest = request
      request.on('error', reconnect)
    } catch { reconnect() }
  }
}

// Use globalThis to survive HMR in development
const globalBus = globalThis as typeof globalThis & { __eventBus?: ServerEventBus }
export const eventBus = globalBus.__eventBus ?? ServerEventBus.getInstance()
globalBus.__eventBus = eventBus as ServerEventBus
