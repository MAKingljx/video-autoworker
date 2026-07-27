import { isIP } from 'node:net'

export const DEFAULT_N8N_BASE_URL = 'http://127.0.0.1:5678'

function envFlag(name: string): boolean {
  const raw = process.env[name]
  if (raw === undefined) return false
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase())
}

function isPrivateN8nHost(host: string): boolean {
  if (host.endsWith('.local')) return true
  const ipVersion = isIP(host)
  if (ipVersion === 4) {
    const octets = host.split('.').map(Number)
    return octets[0] === 10
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168)
      || (octets[0] === 169 && octets[1] === 254)
      || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127)
  }
  if (ipVersion === 6) {
    const firstHextet = Number.parseInt(host.split(':')[0] || '0', 16)
    return (firstHextet >= 0xfc00 && firstHextet <= 0xfdff)
      || (firstHextet >= 0xfe80 && firstHextet <= 0xfebf)
  }
  return false
}

/** Shared trust policy for server-side n8n requests and CSP frame sources. */
export function normalizeN8nBaseUrl(
  raw = process.env.N8N_BASE_URL || DEFAULT_N8N_BASE_URL,
): string {
  const parsed = new URL(String(raw || '').trim() || DEFAULT_N8N_BASE_URL)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('n8n 地址只支持 http 或 https')
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1'
  if (!isLoopback) {
    if (!envFlag('N8N_ALLOW_PRIVATE_REMOTE')) {
      throw new Error('n8n 默认只允许本机回环地址；远端私网需显式设置 N8N_ALLOW_PRIVATE_REMOTE=1')
    }
    if (!isPrivateN8nHost(host)) {
      throw new Error('N8N_ALLOW_PRIVATE_REMOTE 只允许 RFC1918、链路本地、Tailscale 或 .local 私网地址')
    }
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
