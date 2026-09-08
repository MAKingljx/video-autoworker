import { test, expect } from '@playwright/test'
import { API_KEY_HEADER } from './helpers'

const EXPECT_GATEWAY = process.env.E2E_GATEWAY_EXPECTED === '1'

test.describe('OpenClaw Offline Harness', () => {
  test('capabilities expose OpenClaw state dir/config in offline test mode', async ({ request }) => {
    const res = await request.get('/api/status?action=capabilities', {
      headers: API_KEY_HEADER,
    })
    expect(res.status()).toBe(200)

    const body = await res.json()
    expect(body.openclawHome).toBe(true)
    expect(Boolean(body.claudeHome)).toBeTruthy()
    expect(Boolean(body.gateway)).toBe(EXPECT_GATEWAY)
  })

  test('sessions API follows the configured runtime mode', async ({ request }) => {
    const res = await request.get('/api/sessions', {
      headers: API_KEY_HEADER,
    })
    const body = await res.json()

    if (!EXPECT_GATEWAY) {
      expect(res.status()).toBe(503)
      expect(body).toEqual({
        available: false,
        error: 'Runtime sessions are unavailable',
      })
      return
    }

    expect(res.status()).toBe(200)
    expect(body.available).toBe(true)
    expect(body.sessions).toHaveLength(2)
    expect(body.sessions.map((session: { key: string }) => session.key)).toEqual([
      'agent:engineering-bot:main',
      'agent:research-bot:main',
    ])
    expect(body.sessions[0]).toMatchObject({
      id: 'sess-eng-main',
      agent: 'engineering-bot',
      model: 'openai/gpt-5',
      active: true,
      source: 'gateway',
    })
    expect(body.sessions[0].tokens).toContain('25k/120k')
  })

  test('cron API reads fixture jobs', async ({ request }) => {
    const res = await request.get('/api/cron?action=list', {
      headers: API_KEY_HEADER,
    })
    expect(res.status()).toBe(200)

    const body = await res.json()
    expect(Array.isArray(body.jobs)).toBe(true)
    expect(body.jobs.length).toBeGreaterThan(0)
    expect(body.jobs[0]).toHaveProperty('name')
    expect(body.jobs[0]).toHaveProperty('schedule')
  })

  test('gateway config API reads fixture config', async ({ request }) => {
    const res = await request.get('/api/gateway-config', {
      headers: API_KEY_HEADER,
    })
    expect(res.status()).toBe(200)

    const body = await res.json()
    expect(typeof body.path).toBe('string')
    expect(body.path.endsWith('openclaw.json')).toBe(true)
    expect(body.config).toHaveProperty('agents')
  })
})
