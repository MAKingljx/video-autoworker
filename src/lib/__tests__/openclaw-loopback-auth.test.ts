import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  checkOpenClawN8nCallbackRequest,
  getOpenClawLoopbackScope,
  isLoopbackHttpRequest,
  isOpenClawN8nGlobalReleaseRequest,
  isOpenClawN8nOperatorRequest,
} from '@/lib/openclaw-loopback-auth'

describe('OpenClaw loopback authentication boundary', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env = { ...originalEnv, MC_AUTH_MODE: 'openclaw-loopback' }
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('accepts only HTTP loopback and rejects a conflicting Host header', () => {
    expect(isLoopbackHttpRequest(new Request('http://127.0.0.1:3017/api/status'))).toBe(true)
    expect(isLoopbackHttpRequest(new Request('https://127.0.0.1:3017/api/status'))).toBe(false)
    expect(isLoopbackHttpRequest(new Request('http://app.example.test/api/status'))).toBe(false)
    expect(isLoopbackHttpRequest(new Request('http://127.0.0.1:3017/api/status', {
      headers: { host: 'app.example.test' },
    }))).toBe(false)
    expect(isLoopbackHttpRequest(new Request('http://127.0.0.1:3017/api/status', {
      headers: { 'x-forwarded-host': 'public.example.test' },
    }))).toBe(false)
    expect(isLoopbackHttpRequest(new Request('http://127.0.0.1:3017/api/status', {
      headers: { 'x-forwarded-for': '203.0.113.10' },
    }))).toBe(false)
    expect(isLoopbackHttpRequest(new Request('http://127.0.0.1:3017/api/status', {
      headers: { forwarded: 'for=203.0.113.10;host=127.0.0.1' },
    }))).toBe(false)
  })

  it('uses explicit fixed scope values and fails invalid values to one', () => {
    process.env.MC_OPENCLAW_WORKSPACE_ID = '7'
    process.env.MC_OPENCLAW_TENANT_ID = '-4'
    expect(getOpenClawLoopbackScope()).toEqual({ workspaceId: 7, tenantId: 1 })
  })

  it('grants operator authority only to exact task ingress/callback paths', () => {
    expect(isOpenClawN8nOperatorRequest(new Request(
      'http://127.0.0.1:3017/api/n8n/trigger', { method: 'POST' },
    ))).toBe(true)
    expect(isOpenClawN8nOperatorRequest(new Request(
      'http://127.0.0.1:3017/api/n8n/workflows', { method: 'POST' },
    ))).toBe(false)
  })

  it('admits callbacks only on their exact POST loopback endpoint', () => {
    expect(checkOpenClawN8nCallbackRequest(new Request(
      'http://127.0.0.1:3017/api/n8n/claim', { method: 'POST' },
    ), '/api/n8n/claim')).toEqual({ allowed: true })
    expect(checkOpenClawN8nCallbackRequest(new Request(
      'http://127.0.0.1:3017/api/n8n/node-execute', { method: 'POST' },
    ), '/api/n8n/claim')).toMatchObject({ allowed: false, status: 403 })
    expect(checkOpenClawN8nCallbackRequest(new Request(
      'http://127.0.0.1:3017/api/n8n/claim', { method: 'GET' },
    ), '/api/n8n/claim')).toMatchObject({ allowed: false, status: 403 })
  })

  it('limits global release authority to the three release-control endpoints', () => {
    expect(isOpenClawN8nGlobalReleaseRequest(new Request(
      'http://127.0.0.1:3017/api/n8n/intake-control',
    ))).toBe(true)
    expect(isOpenClawN8nGlobalReleaseRequest(new Request(
      'http://127.0.0.1:3017/api/n8n/runs',
    ))).toBe(false)
  })
})
