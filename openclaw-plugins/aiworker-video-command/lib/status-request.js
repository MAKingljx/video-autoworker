import { isVideoTaskId } from './video-task-id.js'

const COMPLETE_TASK_ID = /(?<![a-z0-9-])video-(?:command|natural)-[a-f0-9]{64}(?=$|[^a-z0-9-])/giu
const TASK_ID_PREFIX = /video-(?:command|natural)-/giu
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u
const QUERY_VERB = /(?:查|查询|查看|看一下)/u
const STATUS_WORD = /(?:进度|状态|结果)/u
const TASK_CONTEXT = /(?:任务|视频)/u
const SHORT_STATUS_INTENT = /^(?:现在)?(?:查|查询|查看|看)(?:一下)?(?:任务|视频)?(?:进度|状态|结果)[？?。！!]?$/u
const RECENT_VIDEO_INTENT = /(?:查(?:询|看)?(?:一下)?|查询|查看|看一下).{0,24}(?:刚才|上次|之前).{0,16}视频/iu
const COMPLETION_QUESTION = /(?:刚才|上次|之前|这个).{0,16}(?:视频|任务).{0,20}(?:(?:结果.{0,6}(?:出来|有)(?:了)?(?:吗|没|没有))|(?:(?:分析)?(?:完成|完了|好了)(?:吗|没|没有)))[？?。！!]?$/iu

function normalizedContent(content, { removeControls = false } = {}) {
  if (typeof content !== 'string') return ''
  const value = removeControls
    ? content.replace(/[\u0000-\u001f\u007f]/gu, '')
    : content
  return value.replace(/\s+/gu, ' ').trim()
}

function hasStatusIntent(text, prefixCount) {
  return SHORT_STATUS_INTENT.test(text)
    || RECENT_VIDEO_INTENT.test(text)
    || COMPLETION_QUESTION.test(text)
    || (
      QUERY_VERB.test(text)
      && STATUS_WORD.test(text)
      && (prefixCount > 0 || TASK_CONTEXT.test(text))
    )
}

export function parseStatusRequest(content) {
  const hasControls = typeof content === 'string' && CONTROL_CHARACTER.test(content)
  const text = normalizedContent(content, { removeControls: hasControls })
  const prefixCount = (text.match(TASK_ID_PREFIX) ?? []).length
  if (!text || !hasStatusIntent(text, prefixCount)) {
    return { kind: 'unmatched' }
  }
  if (hasControls) return { kind: 'invalid' }

  const taskIds = [...new Set(text.match(COMPLETE_TASK_ID) ?? [])]
  if (prefixCount > taskIds.length || taskIds.length > 1) {
    return { kind: 'needs_task_id' }
  }
  if (taskIds.length === 1) {
    const taskId = taskIds[0]
    return isVideoTaskId(taskId)
      ? { kind: 'match', taskId }
      : { kind: 'needs_task_id' }
  }
  return { kind: 'match', taskId: null }
}
