import { createHash } from 'node:crypto'
import { normalize } from 'node:path'

const VIDEO_COMMAND_PREFIX = '分析视频 '
const NEGATIVE_PHRASES = [
  '先告诉我方法',
  '不要开始',
  '不要执行',
  '不要提交',
  '暂不执行',
  '只分析',
]
const SUPPORTED_VIDEO_PATH = /\.(?:mp4|mov|mkv|webm|m4v)$/i
const MAX_VIDEO_COMMAND_LENGTH = 4_096

export function parseExactVideoCommand(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  if (value.length > MAX_VIDEO_COMMAND_LENGTH) return null
  if (value.trim() !== value || /[\r\n]/.test(value)) return null
  if (NEGATIVE_PHRASES.some(phrase => value.includes(phrase))) return null
  if (!value.startsWith(VIDEO_COMMAND_PREFIX)) return null

  const rawPath = value.slice(VIDEO_COMMAND_PREFIX.length)
  if (!rawPath || /^\s/.test(rawPath)) return null

  let videoFile = rawPath
  const openingQuote = rawPath[0]
  if (openingQuote === '"' || openingQuote === "'") {
    if (rawPath.length < 3 || rawPath.at(-1) !== openingQuote) return null
    videoFile = rawPath.slice(1, -1)
    if (!videoFile || videoFile.includes(openingQuote)) return null
  }

  if (!videoFile.startsWith('/') || videoFile.includes('\0')) return null
  if (!SUPPORTED_VIDEO_PATH.test(videoFile)) return null
  return videoFile
}

export function deriveVideoCommandTaskKey(videoFile) {
  if (typeof videoFile !== 'string' || !videoFile.startsWith('/')) {
    throw new Error('视频命令任务键需要绝对路径')
  }
  const digest = createHash('sha256').update(normalize(videoFile), 'utf8').digest('hex')
  return `video-command-${digest}`
}
