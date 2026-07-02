import { NextRequest, NextResponse } from 'next/server'
import { db_helpers } from '@/lib/db'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'
import {
  getRuntimeProvider,
  type RuntimeReasoningLevel,
  type RuntimeSessionConfigPatch,
  type RuntimeSessionSummary,
  type RuntimeThinkingLevel,
  type RuntimeVerboseLevel,
} from '@/lib/runtime-provider'

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const runtimeProvider = getRuntimeProvider()
    const gatewaySessions = await runtimeProvider.listSessions()
    const mappedGatewaySessions = mapGatewaySessions(gatewaySessions)

    if (mappedGatewaySessions.length === 0) {
      return NextResponse.json({ sessions: [] })
    }

    return NextResponse.json({ sessions: dedupeAndSortSessions(mappedGatewaySessions) })
  } catch (error) {
    logger.error({ err: error }, 'Sessions API error')
    return NextResponse.json({ sessions: [] })
  }
}

const VALID_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const satisfies readonly RuntimeThinkingLevel[]
const VALID_VERBOSE_LEVELS = ['off', 'on', 'full'] as const satisfies readonly RuntimeVerboseLevel[]
const VALID_REASONING_LEVELS = ['off', 'on', 'stream'] as const satisfies readonly RuntimeReasoningLevel[]
const SESSION_KEY_RE = /^[a-zA-Z0-9:_.-]+$/

type SessionMutationSpec = {
  validate(body: Record<string, unknown>): { ok: true; patch: RuntimeSessionConfigPatch; logValue: string } | { ok: false; response: NextResponse }
}

const SESSION_MUTATIONS: Record<string, SessionMutationSpec> = {
  'set-thinking': {
    validate(body) {
      const level = body.level
      if (!VALID_THINKING_LEVELS.includes(level as RuntimeThinkingLevel)) {
        return {
          ok: false,
          response: NextResponse.json(
            { error: `Invalid thinking level. Must be: ${VALID_THINKING_LEVELS.join(', ')}` },
            { status: 400 },
          ),
        }
      }
      return { ok: true, patch: { thinking: level as RuntimeThinkingLevel }, logValue: String(level) }
    },
  },
  'set-verbose': {
    validate(body) {
      const level = body.level
      if (!VALID_VERBOSE_LEVELS.includes(level as RuntimeVerboseLevel)) {
        return {
          ok: false,
          response: NextResponse.json(
            { error: `Invalid verbose level. Must be: ${VALID_VERBOSE_LEVELS.join(', ')}` },
            { status: 400 },
          ),
        }
      }
      return { ok: true, patch: { verbose: level as RuntimeVerboseLevel }, logValue: String(level) }
    },
  },
  'set-reasoning': {
    validate(body) {
      const level = body.level
      if (!VALID_REASONING_LEVELS.includes(level as RuntimeReasoningLevel)) {
        return {
          ok: false,
          response: NextResponse.json(
            { error: `Invalid reasoning level. Must be: ${VALID_REASONING_LEVELS.join(', ')}` },
            { status: 400 },
          ),
        }
      }
      return { ok: true, patch: { reasoning: level as RuntimeReasoningLevel }, logValue: String(level) }
    },
  },
  'set-label': {
    validate(body) {
      const label = body.label
      if (typeof label !== 'string' || label.length > 100) {
        return {
          ok: false,
          response: NextResponse.json({ error: 'Label must be a string up to 100 characters' }, { status: 400 }),
        }
      }
      return { ok: true, patch: { label }, logValue: label }
    },
  },
}

export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const { searchParams } = new URL(request.url)
    const action = searchParams.get('action')
    const body = await request.json()
    const { sessionKey } = body

    if (!sessionKey || !SESSION_KEY_RE.test(sessionKey)) {
      return NextResponse.json({ error: 'Invalid session key' }, { status: 400 })
    }

    const mutation = action ? SESSION_MUTATIONS[action] : undefined
    if (!mutation) {
      return NextResponse.json({ error: 'Invalid action. Must be: set-thinking, set-verbose, set-reasoning, set-label' }, { status: 400 })
    }

    const validated = mutation.validate(body)
    if (!validated.ok) return validated.response

    const runtimeProvider = getRuntimeProvider()
    const result = await runtimeProvider.updateSessionConfig(sessionKey, validated.patch)

    const [field] = Object.keys(validated.patch)
    db_helpers.logActivity(
      'session_control',
      'session',
      0,
      auth.user.username,
      `Set ${field}=${validated.logValue} on ${sessionKey}`,
      { session_key: sessionKey, action }
    )

    return NextResponse.json({ success: true, action, sessionKey, result })
  } catch (error: any) {
    logger.error({ err: error }, 'Session POST error')
    return NextResponse.json({ error: error.message || 'Session action failed' }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const body = await request.json()
    const { sessionKey } = body

    if (!sessionKey || !SESSION_KEY_RE.test(sessionKey)) {
      return NextResponse.json({ error: 'Invalid session key' }, { status: 400 })
    }

    const runtimeProvider = getRuntimeProvider()
    const result = await runtimeProvider.deleteSession(sessionKey)

    db_helpers.logActivity(
      'session_control',
      'session',
      0,
      auth.user.username,
      `Deleted session ${sessionKey}`,
      { session_key: sessionKey, action: 'delete' }
    )

    return NextResponse.json({ success: true, sessionKey, result })
  } catch (error: any) {
    logger.error({ err: error }, 'Session DELETE error')
    return NextResponse.json({ error: error.message || 'Session deletion failed' }, { status: 500 })
  }
}

function mapGatewaySessions(gatewaySessions: RuntimeSessionSummary[]) {
  // Deduplicate by sessionId — OpenClaw tracks cron runs under the same
  // session ID as the parent session, causing duplicate React keys (#80).
  // Keep the most recently updated entry when duplicates exist.
  const sessionMap = new Map<string, (typeof gatewaySessions)[0]>()
  for (const s of gatewaySessions) {
    const id = s.sessionId || `${s.agent}:${s.key}`
    const existing = sessionMap.get(id)
    if (!existing || s.updatedAt > existing.updatedAt) {
      sessionMap.set(id, s)
    }
  }

  return Array.from(sessionMap.values()).map((s) => {
    const total = s.totalTokens || 0
    const context = s.contextTokens || 35000
    const pct = context > 0 ? Math.round((total / context) * 100) : 0
    return {
      id: s.sessionId || `${s.agent}:${s.key}`,
      key: s.key,
      agent: s.agent,
      kind: s.chatType || 'unknown',
      age: formatAge(s.updatedAt),
      model: s.model,
      tokens: `${formatTokens(total)}/${formatTokens(context)} (${pct}%)`,
      channel: s.channel,
      flags: [],
      active: s.active,
      startTime: s.updatedAt,
      lastActivity: s.updatedAt,
      source: 'gateway' as const,
    }
  })
}

function dedupeAndSortSessions(merged: Array<Record<string, any>>) {
  const deduped = new Map<string, Record<string, any>>()

  for (const session of merged) {
    const id = String(session?.id || '')
    const source = String(session?.source || '')
    const key = `${source}:${id}`
    if (!id) continue
    const existing = deduped.get(key)
    const currentActivity = Number(session?.lastActivity || 0)
    const existingActivity = Number(existing?.lastActivity || 0)
    if (!existing || currentActivity > existingActivity) deduped.set(key, session)
  }

  return Array.from(deduped.values())
    .sort((a, b) => Number(b?.lastActivity || 0) - Number(a?.lastActivity || 0))
    .slice(0, 100)
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

function formatAge(timestamp: number): string {
  if (!timestamp) return '-'
  const diff = Date.now() - timestamp
  if (diff <= 0) return 'now'
  const mins = Math.floor(diff / 60000)
  const hours = Math.floor(mins / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}d`
  if (hours > 0) return `${hours}h`
  return `${mins}m`
}

export const dynamic = 'force-dynamic'
