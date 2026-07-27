import { describe, expect, it } from 'vitest'
import { buildMissionControlCsp, buildNonceRequestHeaders } from '@/lib/csp'

describe('buildMissionControlCsp', () => {
  it('includes the request nonce in script and style directives', () => {
    const csp = buildMissionControlCsp({ nonce: 'nonce-123', googleEnabled: false })

    expect(csp).toContain(`script-src 'self' 'nonce-nonce-123' 'strict-dynamic'`)
    expect(csp).toContain("style-src 'self' 'unsafe-inline'")
    expect(csp).toContain("style-src-elem 'self' 'unsafe-inline'")
    expect(csp).toContain("style-src-attr 'unsafe-inline'")
  })

  it('allows only the exact configured n8n editor origin in frames', () => {
    const csp = buildMissionControlCsp({
      nonce: 'nonce-123',
      googleEnabled: false,
      n8nBaseUrl: 'http://127.0.0.1:5678/n8n?ignored=1',
    })

    const frameSrc = csp.split('; ').find(directive => directive.startsWith('frame-src'))
    expect(frameSrc).toBe("frame-src 'self' http://127.0.0.1:5678")
    expect(frameSrc).not.toContain('127.0.0.1:*')
  })

  it('does not place an unsafe n8n value into CSP', () => {
    const csp = buildMissionControlCsp({
      nonce: 'nonce-123',
      googleEnabled: false,
      n8nBaseUrl: "javascript:alert('csp-injection')",
    })

    expect(csp).toContain("frame-src 'self'")
    expect(csp).not.toContain('csp-injection')
  })

  it('does not allow a public n8n origin rejected by the backend policy', () => {
    const previous = process.env.N8N_ALLOW_PRIVATE_REMOTE
    delete process.env.N8N_ALLOW_PRIVATE_REMOTE
    try {
      const csp = buildMissionControlCsp({
        nonce: 'nonce-123',
        googleEnabled: false,
        n8nBaseUrl: 'https://n8n.example.com',
      })

      expect(csp).toContain("frame-src 'self'")
      expect(csp).not.toContain('n8n.example.com')
    } finally {
      if (previous === undefined) delete process.env.N8N_ALLOW_PRIVATE_REMOTE
      else process.env.N8N_ALLOW_PRIVATE_REMOTE = previous
    }
  })
})

describe('buildNonceRequestHeaders', () => {
  it('propagates nonce and CSP into request headers for Next.js rendering', () => {
    const headers = buildNonceRequestHeaders({
      headers: new Headers({ host: 'localhost:3000' }),
      nonce: 'nonce-123',
      googleEnabled: false,
    })

    expect(headers.get('x-nonce')).toBe('nonce-123')
    expect(headers.get('Content-Security-Policy')).toContain("style-src 'self' 'unsafe-inline'")
  })
})
