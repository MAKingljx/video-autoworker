import { NextRequest, NextResponse } from "next/server"
import { requireRole } from "@/lib/auth"
import { getDatabase } from "@/lib/db"

function ensureGatewaysTable(db: ReturnType<typeof getDatabase>) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gateways (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      host TEXT NOT NULL DEFAULT '127.0.0.1',
      port INTEGER NOT NULL DEFAULT 18789,
      token TEXT NOT NULL DEFAULT '',
      is_primary INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'unknown',
      last_seen INTEGER,
      latency INTEGER,
      sessions_count INTEGER NOT NULL DEFAULT 0,
      agents_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `)
}

interface GatewayEntry {
  id: number
  name: string
  host: string
  port: number
  is_primary: number
  status: string
}

interface HealthResult {
  id: number
  name: string
  status: "online" | "offline" | "error"
  latency: number | null
  agents: string[]
  sessions_count: number
  gateway_version?: string | null
  compatibility_warning?: string
  error?: string
}

function parseGatewayVersion(res: Response): string | null {
  const direct = res.headers.get('x-openclaw-version') || res.headers.get('x-clawdbot-version')
  if (direct) return direct.trim()
  const server = res.headers.get('server') || ''
  const m = server.match(/(\d{4}\.\d+\.\d+)/)
  return m?.[1] || null
}

function hasOpenClaw32ToolsProfileRisk(version: string | null): boolean {
  if (!version) return false
  const m = version.match(/^(\d{4})\.(\d+)\.(\d+)/)
  if (!m) return false
  const year = Number(m[1])
  const major = Number(m[2])
  const minor = Number(m[3])
  if (year > 2026) return true
  if (year < 2026) return false
  if (major > 3) return true
  if (major < 3) return false
  return minor >= 2
}

/** Check whether an IPv4 address falls within a CIDR block. */
function ipv4InCidr(ip: string, cidr: string): boolean {
  const [base, bits] = cidr.split('/')
  const mask = ~((1 << (32 - Number(bits))) - 1) >>> 0
  const ipNum = ipv4ToNum(ip)
  const baseNum = ipv4ToNum(base)
  if (ipNum === null || baseNum === null) return false
  return (ipNum & mask) === (baseNum & mask)
}

function ipv4ToNum(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let num = 0
  for (const p of parts) {
    const n = Number(p)
    if (!Number.isFinite(n) || n < 0 || n > 255) return null
    num = (num << 8) | n
  }
  return num >>> 0
}

const BLOCKED_PRIVATE_CIDRS = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
  '127.0.0.0/8',
]

const BLOCKED_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.internal',
  'instance-data',
])

function isBlockedUrl(urlStr: string, userConfiguredHosts: Set<string>): boolean {
  try {
    const url = new URL(urlStr)
    const hostname = url.hostname

    // Allow user-configured gateway hosts (operators intentionally target their own infra)
    if (userConfiguredHosts.has(hostname)) return false

    // Block well-known cloud metadata hostnames
    if (BLOCKED_HOSTNAMES.has(hostname)) return true

    // Block private/reserved IPv4 ranges
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
      for (const cidr of BLOCKED_PRIVATE_CIDRS) {
        if (ipv4InCidr(hostname, cidr)) return true
      }
    }

    return false
  } catch {
    return true // Block malformed URLs
  }
}

function buildGatewayProbeUrl(host: string, port: number): string | null {
  const rawHost = String(host || '').trim()
  if (!rawHost) return null

  const hasProtocol =
    rawHost.startsWith('ws://') ||
    rawHost.startsWith('wss://') ||
    rawHost.startsWith('http://') ||
    rawHost.startsWith('https://')

  if (hasProtocol) {
    try {
      const parsed = new URL(rawHost)
      if (parsed.protocol === 'ws:') parsed.protocol = 'http:'
      if (parsed.protocol === 'wss:') parsed.protocol = 'https:'
      if (!parsed.port && Number.isFinite(port) && port > 0) {
        parsed.port = String(port)
      }
      parsed.pathname = parsed.pathname.replace(/\/+$/, '') + '/health'
      return parsed.toString()
    } catch {
      return null
    }
  }

  if (!Number.isFinite(port) || port <= 0) return null
  return `http://${rawHost}:${port}/health`
}

function configuredGatewayHosts(gateways: GatewayEntry[]): Set<string> {
  const configuredHosts = new Set<string>()
  for (const gateway of gateways) {
    const host = (gateway.host || '').trim()
    if (!host) continue
    try {
      configuredHosts.add(new URL(host.includes('://') ? host : `http://${host}`).hostname)
    } catch {
      configuredHosts.add(host)
    }
  }
  return configuredHosts
}

async function probeGateway(
  gateway: GatewayEntry,
  configuredHosts: Set<string>,
): Promise<{ result: HealthResult; probedAt: number }> {
  const probedAt = Math.floor(Date.now() / 1000)
  const probeUrl = buildGatewayProbeUrl(gateway.host, gateway.port)
  if (!probeUrl) {
    return {
      probedAt,
      result: {
        id: gateway.id,
        name: gateway.name,
        status: 'error',
        latency: null,
        agents: [],
        sessions_count: 0,
        error: 'Invalid gateway address',
      },
    }
  }
  if (isBlockedUrl(probeUrl, configuredHosts)) {
    return {
      probedAt,
      result: {
        id: gateway.id,
        name: gateway.name,
        status: 'error',
        latency: null,
        agents: [],
        sessions_count: 0,
        error: 'Blocked URL',
      },
    }
  }

  const start = Date.now()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)
  try {
    const response = await fetch(probeUrl, { signal: controller.signal })
    const latency = Date.now() - start
    const gatewayVersion = parseGatewayVersion(response)
    const compatibilityWarning = hasOpenClaw32ToolsProfileRisk(gatewayVersion)
      ? 'OpenClaw 2026.3.2+ defaults tools.profile=messaging; Mission Control should enforce coding profile when spawning.'
      : undefined
    const error = response.ok ? undefined : `HTTP ${response.status}`
    return {
      probedAt,
      result: {
        id: gateway.id,
        name: gateway.name,
        status: response.ok ? 'online' : 'error',
        latency,
        agents: [],
        sessions_count: 0,
        gateway_version: gatewayVersion,
        compatibility_warning: compatibilityWarning,
        ...(error ? { error } : {}),
      },
    }
  } catch (error: unknown) {
    const reason = error instanceof Error && error.name === 'AbortError'
      ? 'timeout'
      : error instanceof Error && error.message
        ? error.message
        : 'connection failed'
    return {
      probedAt,
      result: {
        id: gateway.id,
        name: gateway.name,
        status: 'offline',
        latency: null,
        agents: [],
        sessions_count: 0,
        error: reason,
      },
    }
  } finally {
    clearTimeout(timeout)
  }
}

/** Read-only targeted probe used by server-managed browser status polling. */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const id = Number(request.nextUrl.searchParams.get('id'))
  if (!Number.isSafeInteger(id) || id < 1) {
    return NextResponse.json({ error: 'id is required' }, { status: 400 })
  }
  const db = getDatabase()
  const gateway = db.prepare(
    'SELECT id, name, host, port, is_primary, status FROM gateways WHERE id = ?',
  ).get(id) as GatewayEntry | undefined
  if (!gateway) return NextResponse.json({ error: 'Gateway not found' }, { status: 404 })
  const { result } = await probeGateway(gateway, configuredGatewayHosts([gateway]))
  return NextResponse.json({ results: [result], probed_at: Date.now() })
}

/**
 * POST /api/gateways/health - Server-side health probe for all gateways
 * Probes gateways from the server where loopback addresses are reachable.
 */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, "viewer")
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const db = getDatabase()
  ensureGatewaysTable(db)
  const gateways = db.prepare(
    "SELECT id, name, host, port, is_primary, status FROM gateways ORDER BY is_primary DESC, name ASC"
  ).all() as GatewayEntry[]

  // Build set of user-configured gateway hosts so the SSRF filter allows them
  const configuredHosts = configuredGatewayHosts(gateways)

  // Prepare update statements once (avoids N+1)
  const updateOnlineStmt = db.prepare(
    "UPDATE gateways SET status = ?, latency = ?, last_seen = (unixepoch()), updated_at = (unixepoch()) WHERE id = ?"
  )
  const updateOfflineStmt = db.prepare(
    "UPDATE gateways SET status = ?, latency = NULL, updated_at = (unixepoch()) WHERE id = ?"
  )
  const insertLogStmt = db.prepare(
    "INSERT INTO gateway_health_logs (gateway_id, status, latency, probed_at, error) VALUES (?, ?, ?, ?, ?)"
  )

  const results: HealthResult[] = []

  for (const gw of gateways) {
    const { result, probedAt } = await probeGateway(gw, configuredHosts)
    insertLogStmt.run(gw.id, result.status, result.latency, probedAt, result.error || null)
    results.push(result)
  }

  // Persist all probe results in a single transaction
  db.transaction(() => {
    for (const r of results) {
      if (r.status === 'online' || r.status === 'error') {
        updateOnlineStmt.run(r.status, r.latency, r.id)
      } else {
        updateOfflineStmt.run(r.status, r.id)
      }
    }
  })()

  return NextResponse.json({ results, probed_at: Date.now() })
}
