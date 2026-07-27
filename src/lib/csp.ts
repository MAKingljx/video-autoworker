import { getTrustedN8nOrigin } from '@/lib/n8n-base-url'

export function buildMissionControlCsp(input: {
  nonce: string
  googleEnabled: boolean
  n8nBaseUrl?: string
}): string {
  const { nonce, googleEnabled, n8nBaseUrl } = input
  const n8nEditorOrigin = getTrustedN8nOrigin(n8nBaseUrl)

  return [
    `default-src 'self'`,
    `base-uri 'self'`,
    `object-src 'none'`,
    `frame-ancestors 'none'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' blob:${googleEnabled ? ' https://accounts.google.com' : ''}`,
    `style-src 'self' 'unsafe-inline'`,
    `style-src-elem 'self' 'unsafe-inline'`,
    `style-src-attr 'unsafe-inline'`,
    `connect-src 'self' ws: wss: http://127.0.0.1:* http://localhost:* https://cdn.jsdelivr.net`,
    `img-src 'self' data: blob:${googleEnabled ? ' https://*.googleusercontent.com https://lh3.googleusercontent.com' : ''}`,
    `font-src 'self' data:`,
    `frame-src 'self'${googleEnabled ? ' https://accounts.google.com' : ''}${n8nEditorOrigin ? ` ${n8nEditorOrigin}` : ''}`,
    `worker-src 'self' blob:`,
  ].join('; ')
}

export function buildNonceRequestHeaders(input: {
  headers: Headers
  nonce: string
  googleEnabled: boolean
  n8nBaseUrl?: string
}): Headers {
  const requestHeaders = new Headers(input.headers)
  const csp = buildMissionControlCsp({
    nonce: input.nonce,
    googleEnabled: input.googleEnabled,
    n8nBaseUrl: input.n8nBaseUrl,
  })

  requestHeaders.set('x-nonce', input.nonce)
  requestHeaders.set('Content-Security-Policy', csp)

  return requestHeaders
}
