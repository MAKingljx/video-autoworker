export const DEFAULT_N8N_BASE_URL = 'http://127.0.0.1:5678'

/** Shared trust policy for server-side n8n requests and CSP frame sources. */
export function normalizeN8nBaseUrl(
  raw = process.env.N8N_BASE_URL || DEFAULT_N8N_BASE_URL,
): string {
  const parsed = new URL(String(raw || '').trim() || DEFAULT_N8N_BASE_URL)
  if (parsed.protocol !== 'http:') {
    throw new Error('n8n 只允许本机回环 HTTP 地址')
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1'
  if (!isLoopback) {
    throw new Error('n8n 只允许本机回环 HTTP 地址')
  }

  parsed.username = ''
  parsed.password = ''
  parsed.hash = ''
  parsed.search = ''
  return parsed.toString().replace(/\/$/, '')
}

export function getTrustedN8nOrigin(raw: string | undefined): string | null {
  if (!raw) return null
  try {
    return new URL(normalizeN8nBaseUrl(raw)).origin
  } catch {
    return null
  }
}
