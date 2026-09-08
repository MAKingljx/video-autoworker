export type GatewayConnectionMode = 'browser-websocket' | 'server-managed'
export type GatewayHealthState = 'unknown' | 'checking' | 'online' | 'offline'

export interface GatewayConnectionStatus {
  mode: GatewayConnectionMode
  browserTransportConnected: boolean
  serverGatewayId?: number
  serverHealth: GatewayHealthState
  serverHealthCheckedAt?: number
  serverLatency?: number
  url: string
  lastConnected?: Date
  reconnectAttempts: number
  latency?: number
  sseConnected?: boolean
}

export interface GatewayConnectionView {
  mode: GatewayConnectionMode
  state: 'checking' | 'online' | 'offline'
  operational: boolean
  browserTransportConnected: boolean
  latency?: number
}

export interface GatewayConnectDescriptor {
  gatewayId: number
  mode: GatewayConnectionMode
  browserWebSocketUrl: string
}

export interface ManagedGatewayHealth {
  gatewayId: number
  state: 'online' | 'offline'
  checkedAt: number
  latency?: number
}

export interface GatewayPollingPolicy {
  pauseWhenConnected: boolean
  pauseWhenDisconnected: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0
}

export function parseGatewayConnectResponse(value: unknown): GatewayConnectDescriptor | null {
  if (!isRecord(value) || !positiveInteger(value.id)) return null
  if (value.connection_mode !== 'server-managed' && value.connection_mode !== 'browser-websocket') {
    return null
  }
  if (value.server_managed !== (value.connection_mode === 'server-managed')) return null
  if (typeof value.ws_url !== 'string' || !value.ws_url.trim()) return null
  return {
    gatewayId: value.id,
    mode: value.connection_mode,
    browserWebSocketUrl: value.ws_url,
  }
}

export function connectionPatchFromDescriptor(
  descriptor: GatewayConnectDescriptor,
): Partial<GatewayConnectionStatus> {
  return descriptor.mode === 'server-managed'
    ? {
        mode: 'server-managed',
        browserTransportConnected: false,
        serverGatewayId: descriptor.gatewayId,
        serverHealth: 'checking',
        serverHealthCheckedAt: undefined,
        serverLatency: undefined,
        url: descriptor.browserWebSocketUrl,
        reconnectAttempts: 0,
        latency: undefined,
      }
    : browserWebSocketConnectionPatch(descriptor.browserWebSocketUrl)
}

export function browserWebSocketConnectionPatch(url: string): Partial<GatewayConnectionStatus> {
  return {
    mode: 'browser-websocket',
    browserTransportConnected: false,
    serverGatewayId: undefined,
    serverHealth: 'unknown',
    serverHealthCheckedAt: undefined,
    serverLatency: undefined,
    url,
  }
}

export function parseManagedGatewayHealth(
  value: unknown,
  gatewayId: number,
): ManagedGatewayHealth | null {
  if (!positiveInteger(gatewayId) || !isRecord(value) || !Array.isArray(value.results)) return null
  if (!Number.isFinite(value.probed_at) || Number(value.probed_at) <= 0) return null
  const row = value.results.find(entry => isRecord(entry) && entry.id === gatewayId)
  if (!isRecord(row) || !['online', 'offline', 'error'].includes(String(row.status))) return null
  const latency = row.status === 'online' && Number.isFinite(row.latency) && Number(row.latency) >= 0
    ? Number(row.latency)
    : undefined
  return {
    gatewayId,
    state: row.status === 'online' ? 'online' : 'offline',
    checkedAt: Number(value.probed_at),
    ...(latency === undefined ? {} : { latency }),
  }
}

export function managedGatewayHealthPatch(
  health: ManagedGatewayHealth,
): Partial<GatewayConnectionStatus> {
  return {
    serverHealth: health.state,
    serverHealthCheckedAt: health.checkedAt,
    serverLatency: health.latency,
    ...(health.state === 'online' ? { lastConnected: new Date(health.checkedAt) } : {}),
  }
}

export function selectGatewayConnection(
  connection: GatewayConnectionStatus,
): GatewayConnectionView {
  if (connection.mode === 'server-managed') {
    const state = connection.serverHealth === 'online'
      ? 'online'
      : connection.serverHealth === 'offline'
        ? 'offline'
        : 'checking'
    return {
      mode: connection.mode,
      state,
      operational: state === 'online',
      browserTransportConnected: connection.browserTransportConnected,
      latency: connection.serverLatency,
    }
  }
  const state = connection.browserTransportConnected
    ? 'online'
    : connection.reconnectAttempts > 0
      ? 'checking'
      : 'offline'
  return {
    mode: connection.mode,
    state,
    operational: state === 'online',
    browserTransportConnected: connection.browserTransportConnected,
    latency: connection.latency,
  }
}

export function gatewayAllowsPolling(
  connection: GatewayConnectionStatus,
  policy: GatewayPollingPolicy,
): boolean {
  const gateway = selectGatewayConnection(connection)
  if (policy.pauseWhenConnected && gateway.browserTransportConnected) return false
  if (policy.pauseWhenDisconnected && !gateway.operational) return false
  return true
}
