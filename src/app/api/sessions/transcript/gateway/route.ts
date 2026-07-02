import { NextRequest, NextResponse } from 'next/server'
import { existsSync, readFileSync } from 'node:fs'
import { requireRole } from '@/lib/auth'
import { getGatewaySessionByKey, getGatewayTranscriptPath } from '@/lib/openclaw-session-source'
import { logger } from '@/lib/logger'
import { parseGatewayHistoryTranscript, parseJsonlTranscript } from '@/lib/transcript-parser'
import { callOpenClawGateway } from '@/lib/openclaw-gateway'

/**
 * GET /api/sessions/transcript/gateway?key=<session-key>&limit=50
 *
 * Reads the JSONL transcript file for a gateway session directly from disk.
 * OpenClaw stores session transcripts at:
 *   {OPENCLAW_STATE_DIR}/agents/{agent}/sessions/{sessionId}.jsonl
 *
 * The session key (e.g. "agent:jarv:cron:task-name") is resolved through the
 * OpenClaw session source boundary, then the JSONL file is read.
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const { searchParams } = new URL(request.url)
  const sessionKey = searchParams.get('key') || ''
  const limit = Math.min(parseInt(searchParams.get('limit') || '50', 10), 200)

  if (!sessionKey) {
    return NextResponse.json({ error: 'key is required' }, { status: 400 })
  }

  try {
    try {
      const history = await callOpenClawGateway<{ messages?: unknown[] }>(
        'chat.history',
        { sessionKey, limit },
        15000,
      )
      const liveMessages = parseGatewayHistoryTranscript(Array.isArray(history?.messages) ? history.messages : [], limit)
      if (liveMessages.length > 0) {
        return NextResponse.json({ messages: liveMessages, source: 'gateway-rpc' })
      }
    } catch (rpcErr) {
      logger.warn({ err: rpcErr, sessionKey }, 'Gateway chat.history failed, falling back to disk transcript')
    }

    const session = getGatewaySessionByKey(sessionKey)
    if (!session) {
      return NextResponse.json({ messages: [], source: 'gateway', error: 'Session not found in sessions.json' })
    }

    const jsonlPath = getGatewayTranscriptPath(session)
    if (!jsonlPath) {
      return NextResponse.json({ messages: [], source: 'gateway', error: 'OPENCLAW_STATE_DIR not configured' })
    }

    if (!existsSync(jsonlPath)) {
      return NextResponse.json({ messages: [], source: 'gateway', error: 'Session JSONL file not found' })
    }

    const raw = readFileSync(jsonlPath, 'utf-8')
    const messages = parseJsonlTranscript(raw, limit)

    return NextResponse.json({ messages, source: 'gateway' })
  } catch (err: any) {
    logger.warn({ err, sessionKey }, 'Gateway session transcript read failed')
    return NextResponse.json({ messages: [], source: 'gateway', error: 'Failed to read session transcript' })
  }
}

export const dynamic = 'force-dynamic'
