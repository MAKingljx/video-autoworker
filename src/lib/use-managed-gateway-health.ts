'use client'

import { useCallback } from 'react'
import {
  managedGatewayHealthPatch,
  parseManagedGatewayHealth,
} from '@/lib/gateway-connection-state'
import { useSmartPoll } from '@/lib/use-smart-poll'
import { useMissionControl } from '@/store'

const MANAGED_GATEWAY_HEALTH_INTERVAL_MS = 30_000

export function useManagedGatewayHealth() {
  const mode = useMissionControl(state => state.connection.mode)
  const gatewayId = useMissionControl(state => state.connection.serverGatewayId)
  const setConnection = useMissionControl(state => state.setConnection)

  const probe = useCallback(async () => {
    if (mode !== 'server-managed' || !gatewayId) return
    try {
      const response = await fetch(`/api/gateways/health?id=${encodeURIComponent(String(gatewayId))}`, {
        cache: 'no-store',
        credentials: 'same-origin',
      })
      const payload: unknown = response.ok ? await response.json() : null
      const health = parseManagedGatewayHealth(payload, gatewayId)
      const current = useMissionControl.getState().connection
      if (current.mode !== 'server-managed' || current.serverGatewayId !== gatewayId) return
      setConnection(health
        ? managedGatewayHealthPatch(health)
        : {
            serverHealth: 'offline',
            serverHealthCheckedAt: Date.now(),
            serverLatency: undefined,
          })
    } catch {
      const current = useMissionControl.getState().connection
      if (current.mode !== 'server-managed' || current.serverGatewayId !== gatewayId) return
      setConnection({
        serverHealth: 'offline',
        serverHealthCheckedAt: Date.now(),
        serverLatency: undefined,
      })
    }
  }, [gatewayId, mode, setConnection])

  useSmartPoll(probe, MANAGED_GATEWAY_HEALTH_INTERVAL_MS, {
    enabled: mode === 'server-managed' && Boolean(gatewayId),
  })
}
