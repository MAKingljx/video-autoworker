import { describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

function setNodeEnv(value: string) {
  ;(process.env as Record<string, string | undefined>).NODE_ENV = value
}

describe('proxy host matching', () => {
  it('allows the system hostname implicitly', async () => {
    vi.resetModules()
    vi.doMock('node:os', () => ({
      default: { hostname: () => 'hetzner-jarv' },
      hostname: () => 'hetzner-jarv',
    }))

    const { proxy } = await import('./proxy')
    const request = {
      headers: new Headers({ host: 'hetzner-jarv' }),
      nextUrl: { host: 'hetzner-jarv', hostname: 'hetzner-jarv', pathname: '/login', clone: () => ({ pathname: '/login' }) },
      method: 'GET',
      cookies: { get: () => undefined },
    } as any

    setNodeEnv('production')
    process.env.MC_ALLOWED_HOSTS = 'localhost,127.0.0.1'
    delete process.env.MC_ALLOW_ANY_HOST

    const response = proxy(request)
    expect(response.status).not.toBe(403)
  })

  it('keeps blocking unrelated hosts in production', async () => {
    vi.resetModules()
    vi.doMock('node:os', () => ({
      default: { hostname: () => 'hetzner-jarv' },
      hostname: () => 'hetzner-jarv',
    }))

    const { proxy } = await import('./proxy')
    const request = {
      headers: new Headers({ host: 'evil.example.com' }),
      nextUrl: { host: 'evil.example.com', hostname: 'evil.example.com', pathname: '/login', clone: () => ({ pathname: '/login' }) },
      method: 'GET',
      cookies: { get: () => undefined },
    } as any

    setNodeEnv('production')
    process.env.MC_ALLOWED_HOSTS = 'localhost,127.0.0.1'
    delete process.env.MC_ALLOW_ANY_HOST

    const response = proxy(request)
    expect(response.status).toBe(403)
  })

  it('allows unauthenticated health probe for /api/status?action=health', async () => {
    vi.resetModules()
    vi.doMock('node:os', () => ({
      default: { hostname: () => 'hetzner-jarv' },
      hostname: () => 'hetzner-jarv',
    }))

    const { proxy } = await import('./proxy')
    const request = {
      headers: new Headers({ host: 'localhost:3000' }),
      nextUrl: {
        host: 'localhost:3000',
        hostname: 'localhost',
        pathname: '/api/status',
        searchParams: new URLSearchParams('action=health'),
        clone: () => ({ pathname: '/api/status' }),
      },
      method: 'GET',
      cookies: { get: () => undefined },
    } as any

    setNodeEnv('production')
    process.env.MC_ALLOWED_HOSTS = 'localhost,127.0.0.1'
    delete process.env.MC_ALLOW_ANY_HOST

    const response = proxy(request)
    expect(response.status).not.toBe(401)
  })

  it('still blocks unauthenticated non-health status API calls', async () => {
    vi.resetModules()
    vi.doMock('node:os', () => ({
      default: { hostname: () => 'hetzner-jarv' },
      hostname: () => 'hetzner-jarv',
    }))

    const { proxy } = await import('./proxy')
    const request = {
      headers: new Headers({ host: 'localhost:3000' }),
      nextUrl: {
        host: 'localhost:3000',
        hostname: 'localhost',
        pathname: '/api/status',
        searchParams: new URLSearchParams('action=overview'),
        clone: () => ({ pathname: '/api/status' }),
      },
      method: 'GET',
      cookies: { get: () => undefined },
    } as any

    setNodeEnv('production')
    process.env.MC_ALLOWED_HOSTS = 'localhost,127.0.0.1'
    delete process.env.MC_ALLOW_ANY_HOST

    const response = proxy(request)
    expect(response.status).toBe(401)
  })

  it('allows all loopback desktop-mode routes without redirecting to profiles', async () => {
    vi.resetModules()
    vi.doMock('node:os', () => ({
      default: { hostname: () => 'hetzner-jarv' },
      hostname: () => 'hetzner-jarv',
    }))

    const { proxy } = await import('./proxy')
    setNodeEnv('production')
    process.env.MC_DESKTOP_MODE = '1'
    process.env.MC_ALLOWED_HOSTS = 'localhost,127.0.0.1'
    delete process.env.MC_ALLOW_ANY_HOST

    const pageRequest = {
      headers: new Headers({ host: '127.0.0.1:3017' }),
      nextUrl: {
        host: '127.0.0.1:3017',
        hostname: '127.0.0.1',
        pathname: '/tasks',
        searchParams: new URLSearchParams(),
        clone: () => ({ pathname: '/tasks' }),
      },
      method: 'GET',
      cookies: { get: () => undefined },
    } as any
    const apiRequest = {
      ...pageRequest,
      nextUrl: {
        ...pageRequest.nextUrl,
        pathname: '/api/tasks',
        clone: () => ({ pathname: '/api/tasks' }),
      },
    } as any

    expect(proxy(pageRequest).status).not.toBe(307)
    expect(proxy(apiRequest).status).not.toBe(401)
  })

  it('does not apply desktop-mode no-auth to non-loopback hosts', async () => {
    vi.resetModules()
    vi.doMock('node:os', () => ({
      default: { hostname: () => 'hetzner-jarv' },
      hostname: () => 'hetzner-jarv',
    }))

    const { proxy } = await import('./proxy')
    setNodeEnv('production')
    process.env.MC_DESKTOP_MODE = '1'
    process.env.MC_ALLOWED_HOSTS = 'localhost,127.0.0.1,app.example.com'
    delete process.env.MC_ALLOW_ANY_HOST

    const request = {
      headers: new Headers({ host: 'app.example.com' }),
      nextUrl: {
        host: 'app.example.com',
        hostname: 'app.example.com',
        pathname: '/api/tasks',
        searchParams: new URLSearchParams(),
        clone: () => ({ pathname: '/api/tasks' }),
      },
      method: 'GET',
      cookies: { get: () => undefined },
    } as any

    expect(proxy(request).status).toBe(401)
  })

  it('fails non-loopback closed in OpenClaw-only mode even when other host settings are permissive', async () => {
    vi.resetModules()
    const { proxy } = await import('./proxy')
    process.env.MC_AUTH_MODE = 'openclaw-loopback'
    process.env.MC_ALLOW_ANY_HOST = '1'

    const response = proxy(new NextRequest('http://app.example.test/api/tasks', {
      headers: { 'x-api-key': 'legacy-key' },
    }))
    expect(response.status).toBe(403)
    delete process.env.MC_AUTH_MODE
    delete process.env.MC_ALLOW_ANY_HOST
  })

  it('disables local login endpoints but lets loopback requests reach route-level roles', async () => {
    vi.resetModules()
    const { proxy } = await import('./proxy')
    process.env.MC_AUTH_MODE = 'openclaw-loopback'

    const login = proxy(new NextRequest('http://127.0.0.1:3017/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }))
    expect(login.status).toBe(403)

    const api = proxy(new NextRequest('http://127.0.0.1:3017/api/tasks'))
    expect(api.status).not.toBe(401)
    delete process.env.MC_AUTH_MODE
  })
})
