import { createReadStream } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { NextRequest, NextResponse } from 'next/server'
import { getDatabase } from '@/lib/db'
import { requireN8nRole } from '@/lib/n8n'
import { getN8nVideoResultDetail, n8nTaskIdentitySchema } from '@/lib/n8n-task-runs'
import { getN8nVideoSource } from '@/lib/n8n-video-sources'

export const runtime = 'nodejs'

const MIME_TYPES: Record<string, string> = {
  '.m4v': 'video/x-m4v',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
}

async function serveVideo(request: NextRequest, headOnly: boolean) {
  const auth = requireN8nRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const parsedTaskId = n8nTaskIdentitySchema.safeParse(request.nextUrl.searchParams.get('taskId'))
  if (!parsedTaskId.success) return NextResponse.json({ error: 'taskId 无效' }, { status: 400 })
  const scope = { workspaceId: auth.user.workspace_id, tenantId: auth.user.tenant_id }
  if (!getN8nVideoResultDetail(getDatabase(), parsedTaskId.data, scope)) {
    return NextResponse.json({ error: '未找到视频学习记录' }, { status: 404 })
  }
  const source = await getN8nVideoSource(parsedTaskId.data)
  if (!source) return NextResponse.json({ error: '原片当前不可用' }, { status: 404 })
  const current = await lstat(source.path).catch(() => null)
  if (!current?.isFile() || current.size !== source.bytes) {
    return NextResponse.json({ error: '原片已变化，请刷新资源库' }, { status: 409 })
  }

  const mimeType = MIME_TYPES[source.extension] || 'application/octet-stream'
  const commonHeaders = {
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store',
    'Content-Type': mimeType,
    'Last-Modified': new Date(source.modifiedAt).toUTCString(),
    'X-Content-Type-Options': 'nosniff',
  }
  const range = request.headers.get('range')
  if (range) {
    const parsed = parseRange(range, current.size)
    if (!parsed) {
      return new NextResponse(null, {
        status: 416,
        headers: { ...commonHeaders, 'Content-Range': `bytes */${current.size}` },
      })
    }
    const contentLength = parsed.end - parsed.start + 1
    const body = headOnly
      ? null
      : Readable.toWeb(createReadStream(source.path, { start: parsed.start, end: parsed.end })) as ReadableStream
    return new NextResponse(body, {
      status: 206,
      headers: {
        ...commonHeaders,
        'Content-Length': String(contentLength),
        'Content-Range': `bytes ${parsed.start}-${parsed.end}/${current.size}`,
      },
    })
  }
  const body = headOnly
    ? null
    : Readable.toWeb(createReadStream(source.path)) as ReadableStream
  return new NextResponse(body, {
    headers: { ...commonHeaders, 'Content-Length': String(current.size) },
  })
}

export async function GET(request: NextRequest) {
  return serveVideo(request, false)
}

export async function HEAD(request: NextRequest) {
  return serveVideo(request, true)
}

function parseRange(value: string, totalSize: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim())
  if (!match || (!match[1] && !match[2])) return null
  let start = match[1] ? Number(match[1]) : NaN
  let end = match[2] ? Number(match[2]) : NaN
  if (Number.isNaN(start)) {
    const suffixLength = Number(match[2])
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null
    start = Math.max(0, totalSize - suffixLength)
    end = totalSize - 1
  } else {
    if (!Number.isFinite(start) || start < 0 || start >= totalSize) return null
    end = Number.isFinite(end) ? Math.min(end, totalSize - 1) : totalSize - 1
  }
  return Number.isFinite(end) && end >= start ? { start, end } : null
}
