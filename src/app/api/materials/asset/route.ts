import path from 'node:path'
import { NextRequest, NextResponse } from 'next/server'
import { authorizeMaterialsRequest } from '../route'
import { getMaterialsBotLearningRoot } from '@/lib/openclaw-materials'
import { openSafeRootedFile, SafeRootedFileError } from '@/lib/safe-rooted-file'

export const runtime = 'nodejs'

const MIME_TYPES: Record<string, string> = {
  '.avi': 'video/x-msvideo',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.m4v': 'video/x-m4v',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
}

export async function GET(request: NextRequest) {
  const auth = authorizeMaterialsRequest(request, 'viewer')
  if ('response' in auth) return auth.response

  const rawPath = request.nextUrl.searchParams.get('path')
  if (!rawPath) {
    return NextResponse.json({ error: '缺少素材路径' }, { status: 400 })
  }

  const root = path.resolve(getMaterialsBotLearningRoot())
  const resolvedPath = path.resolve(rawPath)
  let file
  try {
    file = await openSafeRootedFile(root, resolvedPath)
  } catch (error) {
    if (error instanceof SafeRootedFileError) {
      if (error.code === 'outside_root' || error.code === 'unsafe_path') {
        return NextResponse.json({ error: '素材路径不在允许范围内' }, { status: 403 })
      }
      if (error.code === 'not_file') {
        return NextResponse.json({ error: '只能读取文件素材' }, { status: 400 })
      }
    }
    return NextResponse.json({ error: '素材文件不存在' }, { status: 404 })
  }

  const mimeType = MIME_TYPES[path.extname(file.path).toLowerCase()] || 'application/octet-stream'
  const range = request.headers.get('range')

  if (range) {
    const parsed = parseRange(range, file.stat.size)
    if (!parsed) {
      await file.close()
      return new NextResponse(null, {
        status: 416,
        headers: {
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes */${file.stat.size}`,
        },
      })
    }

    return new NextResponse(file.createWebStream(parsed), {
      status: 206,
      headers: {
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        'Content-Length': String(parsed.end - parsed.start + 1),
        'Content-Range': `bytes ${parsed.start}-${parsed.end}/${file.stat.size}`,
        'Content-Type': mimeType,
        'Last-Modified': file.stat.mtime.toUTCString(),
      },
    })
  }

  return new NextResponse(file.createWebStream(), {
    headers: {
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'Content-Length': String(file.stat.size),
      'Content-Type': mimeType,
      'Last-Modified': file.stat.mtime.toUTCString(),
    },
  })
}

function parseRange(value: string, totalSize: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim())
  if (!match) return null

  const [, rawStart, rawEnd] = match
  if (!rawStart && !rawEnd) return null

  let start = rawStart ? Number(rawStart) : NaN
  let end = rawEnd ? Number(rawEnd) : NaN

  if (Number.isNaN(start)) {
    const suffixLength = Number(rawEnd)
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null
    start = Math.max(0, totalSize - suffixLength)
    end = totalSize - 1
  } else {
    if (!Number.isFinite(start) || start < 0 || start >= totalSize) return null
    end = Number.isFinite(end) ? Math.min(end, totalSize - 1) : totalSize - 1
  }

  if (!Number.isFinite(end) || end < start) return null
  return { start, end }
}
