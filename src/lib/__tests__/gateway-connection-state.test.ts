import { describe, expect, it } from 'vitest'
import {
  browserWebSocketConnectionPatch,
  connectionPatchFromDescriptor,
  gatewayAllowsPolling,
  managedGatewayHealthPatch,
  parseGatewayConnectResponse,
  parseManagedGatewayHealth,
  selectGatewayConnection,
  type GatewayConnectionStatus,
} from '@/lib/gateway-connection-state'

function connection(overrides: Partial<GatewayConnectionStatus> = {}): GatewayConnectionStatus {
  return {
    mode: 'browser-websocket',
    browserTransportConnected: false,
    serverHealth: 'unknown',
    url: '',
    reconnectAttempts: 0,
    ...overrides,
  }
}

describe('gateway connection state', () => {
  it('parses server-managed metadata without accepting an inconsistent mode flag', () => {
    const descriptor = parseGatewayConnectResponse({
      id: 7,
      ws_url: 'ws://gateway.example:18789',
      connection_mode: 'server-managed',
      server_managed: true,
    })
    expect(descriptor).toEqual({
      gatewayId: 7,
      mode: 'server-managed',
      browserWebSocketUrl: 'ws://gateway.example:18789',
    })
    expect(connectionPatchFromDescriptor(descriptor!)).toMatchObject({
      mode: 'server-managed',
      browserTransportConnected: false,
      serverGatewayId: 7,
      serverHealth: 'checking',
    })
    expect(parseGatewayConnectResponse({
      id: 7,
      ws_url: 'ws://gateway.example:18789',
      connection_mode: 'server-managed',
      server_managed: false,
    })).toBeNull()
  })

  it('derives managed health only from the selected gateway probe row', () => {
    const health = parseManagedGatewayHealth({
      probed_at: 1_000,
      results: [
        { id: 6, status: 'offline', latency: null },
        { id: 7, status: 'online', latency: 12 },
      ],
    }, 7)
    expect(health).toEqual({ gatewayId: 7, state: 'online', checkedAt: 1_000, latency: 12 })
    const status = connection({
      ...connectionPatchFromDescriptor({
        gatewayId: 7,
        mode: 'server-managed',
        browserWebSocketUrl: 'ws://gateway.example:18789',
      }),
      ...managedGatewayHealthPatch(health!),
    })
    expect(selectGatewayConnection(status)).toEqual({
      mode: 'server-managed',
      state: 'online',
      operational: true,
      browserTransportConnected: false,
      latency: 12,
    })
  })

  it('keeps browser transport and managed server health independent', () => {
    expect(selectGatewayConnection(connection({
      mode: 'server-managed',
      serverGatewayId: 7,
      serverHealth: 'checking',
    }))).toMatchObject({ state: 'checking', operational: false, browserTransportConnected: false })
    expect(selectGatewayConnection(connection({
      mode: 'server-managed',
      serverGatewayId: 7,
      serverHealth: 'offline',
      browserTransportConnected: true,
    }))).toMatchObject({ state: 'offline', operational: false, browserTransportConnected: true })
    expect(selectGatewayConnection(connection({
      ...browserWebSocketConnectionPatch('wss://gateway.example/gw'),
      browserTransportConnected: true,
    }))).toMatchObject({
      mode: 'browser-websocket',
      state: 'online',
      operational: true,
      browserTransportConnected: true,
    })
  })

  it('keeps HTTP polling active for a healthy managed gateway without claiming a browser socket', () => {
    const managed = connection({
      mode: 'server-managed',
      serverGatewayId: 7,
      serverHealth: 'online',
      browserTransportConnected: false,
    })
    expect(gatewayAllowsPolling(managed, {
      pauseWhenConnected: true,
      pauseWhenDisconnected: false,
    })).toBe(true)
    expect(gatewayAllowsPolling(managed, {
      pauseWhenConnected: false,
      pauseWhenDisconnected: true,
    })).toBe(true)

    expect(gatewayAllowsPolling(connection({ browserTransportConnected: true }), {
      pauseWhenConnected: true,
      pauseWhenDisconnected: false,
    })).toBe(false)
    expect(gatewayAllowsPolling(connection(), {
      pauseWhenConnected: false,
      pauseWhenDisconnected: true,
    })).toBe(false)
  })

  it('fails closed on missing, malformed, and non-selected health results', () => {
    expect(parseManagedGatewayHealth({ probed_at: 1, results: [] }, 7)).toBeNull()
    expect(parseManagedGatewayHealth({ probed_at: 1, results: [{ id: 7, status: 'unknown' }] }, 7)).toBeNull()
    expect(parseManagedGatewayHealth({ probed_at: 0, results: [{ id: 7, status: 'online' }] }, 7)).toBeNull()
    expect(parseManagedGatewayHealth({ probed_at: 1, results: [{ id: 8, status: 'online' }] }, 7)).toBeNull()
  })
})
