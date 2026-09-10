import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { getRuntimeProvider } from '@/lib/runtime-provider'

/**
 * GET /api/sessions/transcript/gateway?key=<session-key>&limit=50
 *
 * Reads display-normalized history through the selected runtime provider.
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
    const history = await getRuntimeProvider().getSessionHistory(sessionKey, { limit })
    return NextResponse.json({ messages: history.messages, source: 'runtime' })
  } catch (err: any) {
    logger.warn({ err, sessionKey }, 'Gateway session transcript read failed')
    return NextResponse.json(
      { messages: [], source: 'runtime', error: 'Runtime session history unavailable' },
      { status: 503 },
    )
  }
}

export const dynamic = 'force-dynamic'
