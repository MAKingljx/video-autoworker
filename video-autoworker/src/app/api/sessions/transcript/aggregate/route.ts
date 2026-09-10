import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { getRuntimeProvider } from '@/lib/runtime-provider'
import type { RuntimeSessionMessage as TranscriptMessage, RuntimeSessionMessagePart as MessageContentPart } from '@/lib/runtime/contracts'
import { logger } from '@/lib/logger'

export interface AggregateEvent {
  id: string
  ts: number
  sessionKey: string
  agentName: string
  role: string
  type: string
  content: string
  metadata?: Record<string, any>
}

/**
 * GET /api/sessions/transcript/aggregate?limit=100&since=<unix-ms>
 *
 * Fan out to recent sessions through the selected runtime and merge a single
 * chronological event stream for the agent-feed panel.
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const { searchParams } = new URL(request.url)
  const limit = Math.min(Math.max(parseInt(searchParams.get('limit') || '100', 10), 1), 500)
  const since = parseInt(searchParams.get('since') || '0', 10) || 0

  try {
    const runtimeProvider = getRuntimeProvider()
    const sessions = await runtimeProvider.listSessions({ updatedWithinMs: 60 * 60 * 1000 })
    const allEvents: AggregateEvent[] = []

    // Keep pressure on the selected runtime bounded while reading independent histories.
    for (let offset = 0; offset < sessions.length; offset += 6) {
      const batch = sessions.slice(offset, offset + 6)
      const histories = await Promise.all(
        batch.map((session) => runtimeProvider.getSessionHistory(session.key, { limit: 500 })),
      )
      for (let index = 0; index < batch.length; index += 1) {
        const session = batch[index]
        const messages = histories[index].messages
        let lineIndex = 0

        for (const msg of messages) {
          const ts = msg.timestamp ?? session.updatedAt
          if (since && ts <= since) { lineIndex++; continue }

          for (const part of msg.parts) {
            allEvents.push(partToEvent(part, msg.role, ts, session.key, session.agent, lineIndex))
            lineIndex++
          }
        }
      }
    }

    // Sort chronologically (newest last), take the last `limit` entries
    allEvents.sort((a, b) => a.ts - b.ts)
    const trimmed = allEvents.slice(-limit)

    return NextResponse.json({
      events: trimmed,
      sessionCount: sessions.length,
    })
  } catch (error) {
    logger.warn({ err: error }, 'Runtime session transcript aggregation failed')
    return NextResponse.json({ error: 'Runtime session history unavailable' }, { status: 503 })
  }
}

function partToEvent(
  part: MessageContentPart,
  role: string,
  ts: number,
  sessionKey: string,
  agentName: string,
  lineIndex: number,
): AggregateEvent {
  const id = `tx-${sessionKey}-${lineIndex}`

  switch (part.type) {
    case 'text':
      return { id, ts, sessionKey, agentName, role, type: 'text', content: part.text.slice(0, 500) }
    case 'thinking':
      return { id, ts, sessionKey, agentName, role, type: 'thinking', content: part.thinking.slice(0, 300) }
    case 'tool_use':
      return { id, ts, sessionKey, agentName, role, type: 'tool_use', content: part.name, metadata: { toolId: part.id, input: part.input } }
    case 'tool_result':
      return { id, ts, sessionKey, agentName, role, type: 'tool_result', content: part.content.slice(0, 500), metadata: { toolUseId: part.toolUseId, isError: part.isError } }
  }
}

export const dynamic = 'force-dynamic'
