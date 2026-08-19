import { createHash } from 'node:crypto'
import { isAbsolute, normalize } from 'node:path'

import {
  resolveConsistentString,
  resolveTelegramConversationIdentity,
  TARGET_CHANNEL,
} from './dispatch-identity.js'
import { schedulerRunner } from './scheduler-runner.js'
import { validateVideoPath } from './video-path-policy.js'
import {
  createDuplicateConfirmationStore,
  DUPLICATE_CONFIRMATION_TEXT,
  isDuplicateConfirmationText,
} from './duplicate-confirmation-store.js'

const TARGET_AGENT = 'second-original'
const TASK_ID_PATTERN = /(?:video-command|video-natural)-[a-f0-9]{64}/gu
const BATCH_ID_PATTERN = /video-batch-[a-f0-9]{64}/gu
const QUOTED_PATH_PATTERN = /(["'`“‘])(\/[^\r\n]+?)(["'`”’])/gu
const UNQUOTED_VIDEO_PATH_PATTERN = /(?:^|[\s：])(\/(?:[^\r\n"'`“”‘’])*?\.(?:m4v|mkv|mov|mp4|webm))(?=$|[\s,，。；;])/giu
const VIDEO_SHAPE = /(?:学习|分析|解析|识别|总结|处理|看一下|观看).{0,40}(?:视频|影片|录像|目录|文件夹)|(?:视频|影片|录像|目录|文件夹).{0,40}(?:学习|分析|解析|识别|总结|处理|看一下|观看)/iu
const LEARNING_ACTION = /(?:学习|分析|解析|识别|总结|处理|看一下|观看)/u
const STATUS_SHAPE = /(?:查|查询|进度|状态|结果|报告|完成|怎么样|情况|入队|排队|受理)/u
const FULL_RESULT_SHAPE = /(?:完整|详细|全文|全部|报告|学习结果|分析结果)/u
const NEGATIVE_OR_NONEXECUTING = /(?:不要(?:执行|学习|分析|提交)|别(?:执行|学习|分析|提交)|如果|假如|比如|例如|举例|怎么|如何|能否|可以吗|是什么|之前说|刚才说|回顾)/u
const DIRECTORY_HINT = /(?:目录|文件夹)/u
const STATUS_SEARCH_CONTEXT = /(?:视频|影片|录像|学习|入队|排队|批次|[《「『]|第[零〇一二两三四五六七八九十百0-9]+(?:季|集)|s\d{1,2}\s*e\d{1,3}|\.(?:m4v|mkv|mov|mp4|webm))/iu
const STATUS_SEARCH_NOISE = /(?:帮我|请(?:你)?|查(?:询)?|看(?:看)?|一下|下|视频|影片|录像|任务|学习|进度|状态|结果|报告|完整|详细|全文|情况|正式|是否|已经|已|入队|排队|受理|完成|的|了)/gu
const EXCLUSIVE_ANALYSIS_CLAUSE = /^\s*(?:(?:帮我|请(?:你)?|请帮我|麻烦(?:你)?|麻烦帮我|能不能帮我|可以帮我|现在|马上|立即|给我)\s*)?(?:只|仅)\s*(?:学习|分析|解析|处理|识别|总结)(?:一下|下)?\s*([^，。；;！？!?]{0,80})/iu
const VISUAL_SCOPE = /(?:画面|视觉|图像|镜头)/u
const AUDIO_SCOPE = /(?:音频|声音|语音|对白|台词)/u
const COMBINED_AUDIO_VISUAL_SCOPE = /(?:音画|视听)/u
const OTHER_PARTIAL_SCOPE = /(?:字幕|文字轨|音轨)/u
const MAX_PENDING_OPERATIONS = 256
const OPERATION_TTL_MS = 15 * 60 * 1_000

function handled(text) {
  return { handled: true, text }
}

function sessionOwnsTargetAgent(sessionKey) {
  return typeof sessionKey === 'string'
    && sessionKey.startsWith(`agent:${TARGET_AGENT}:telegram:direct:`)
}

function canonicalPath(value) {
  return typeof value === 'string'
    && value === value.trim()
    && value.length > 0
    && value.length <= 4_096
    && !/[\u0000-\u001f\u007f]/u.test(value)
    && isAbsolute(value)
    && !value.startsWith('//')
    && normalize(value) === value
}

function extractEvidence(content) {
  const paths = new Set()
  const quotedPaths = new Set()
  const taskIds = new Set()
  const batchIds = new Set()
  if (typeof content !== 'string') return { paths: [], taskIds: [], batchIds: [] }
  const pairs = new Map([["'", "'"], ['"', '"'], ['`', '`'], ['“', '”'], ['‘', '’']])
  for (const match of content.matchAll(QUOTED_PATH_PATTERN)) {
    if (pairs.get(match[1]) === match[3] && canonicalPath(match[2])) {
      paths.add(match[2])
      quotedPaths.add(match[2])
    }
  }
  for (const match of content.matchAll(UNQUOTED_VIDEO_PATH_PATTERN)) {
    if (canonicalPath(match[1])) paths.add(match[1])
  }
  for (const match of content.matchAll(TASK_ID_PATTERN)) taskIds.add(match[0])
  for (const match of content.matchAll(BATCH_ID_PATTERN)) batchIds.add(match[0])
  return {
    paths: [...paths],
    quotedPaths: [...quotedPaths],
    taskIds: [...taskIds],
    batchIds: [...batchIds],
  }
}

function hasUnsupportedPartialAnalysis(value) {
  const scope = value.match(EXCLUSIVE_ANALYSIS_CLAUSE)?.[1]
  if (!scope) return false
  const combined = COMBINED_AUDIO_VISUAL_SCOPE.test(scope)
  const visual = combined || VISUAL_SCOPE.test(scope)
  const audio = combined || AUDIO_SCOPE.test(scope)
  return OTHER_PARTIAL_SCOPE.test(scope) || visual !== audio
}

function isSearchQueryText(value) {
  return typeof value === 'string'
    && value === value.trim()
    && value.length > 0
    && value.length <= 512
    && !/[\u0000-\u001f\u007f]/u.test(value)
}

function statusSearchText(content) {
  return content
    .normalize('NFKC')
    .replace(STATUS_SEARCH_NOISE, '')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
}

function isStatusSearchCandidate(content) {
  if (typeof content !== 'string' || !STATUS_SHAPE.test(content)) return false
  if (NEGATIVE_OR_NONEXECUTING.test(content)) return false
  const evidence = extractEvidence(content)
  if (evidence.taskIds.length || evidence.batchIds.length) return false
  return statusSearchText(content).length >= 2
}

function isStrongStatusSearchCandidate(content) {
  return isStatusSearchCandidate(content) && STATUS_SEARCH_CONTEXT.test(content)
}

export function isClassifierCandidate(content) {
  if (typeof content !== 'string' || !content.trim()) return false
  const evidence = extractEvidence(content)
  return evidence.paths.length > 0
    || VIDEO_SHAPE.test(content)
    || (STATUS_SHAPE.test(content) && (evidence.taskIds.length > 0 || evidence.batchIds.length > 0))
    || isStatusSearchCandidate(content)
}

function validateDecision(decision, content) {
  if (NEGATIVE_OR_NONEXECUTING.test(content)
    && (decision.action === 'dispatch_single' || decision.action === 'dispatch_directory')) {
    return { action: 'respond' }
  }
  if (hasUnsupportedPartialAnalysis(content)
    && (decision.action === 'dispatch_single' || decision.action === 'dispatch_directory')) {
    return { action: 'respond' }
  }
  const evidence = extractEvidence(content)
  if (decision.action === 'dispatch_single') {
    if (evidence.paths.length !== 1 || evidence.paths[0] !== decision.value) return null
    const checked = validateVideoPath(decision.value, {
      quoted: evidence.quotedPaths.includes(decision.value),
    })
    if (!checked.ok || DIRECTORY_HINT.test(content)) return null
    return { action: decision.action, videoPath: checked.videoPath }
  }
  if (decision.action === 'dispatch_directory') {
    if (evidence.paths.length !== 1 || evidence.paths[0] !== decision.value) return null
    if (
      !canonicalPath(decision.value)
      || !DIRECTORY_HINT.test(content)
      || (/\s/u.test(decision.value) && !evidence.quotedPaths.includes(decision.value))
    ) return null
    return { action: decision.action, videoDirectory: decision.value }
  }
  if (decision.action === 'status_task') {
    return evidence.taskIds.length === 1
      && evidence.batchIds.length === 0
      && evidence.taskIds[0] === decision.value
      ? { action: decision.action, taskId: decision.value }
      : null
  }
  if (decision.action === 'status_batch') {
    return evidence.batchIds.length === 1
      && evidence.taskIds.length === 0
      && evidence.batchIds[0] === decision.value
      ? { action: decision.action, batchId: decision.value }
      : null
  }
  if (decision.action === 'status_search') {
    if (
      !isStatusSearchCandidate(content)
      || !isSearchQueryText(decision.value)
      || !content.includes(decision.value)
    ) return null
    return { action: decision.action, query: decision.value }
  }
  if (decision.action === 'result_task') {
    return evidence.taskIds.length === 1
      && evidence.batchIds.length === 0
      && evidence.taskIds[0] === decision.value
      ? { action: decision.action, query: decision.value }
      : null
  }
  if (decision.action === 'result_batch') {
    return evidence.batchIds.length === 1
      && evidence.taskIds.length === 0
      && evidence.batchIds[0] === decision.value
      ? { action: decision.action, query: decision.value }
      : null
  }
  if (decision.action === 'result_search') {
    if (
      !isStatusSearchCandidate(content)
      || !FULL_RESULT_SHAPE.test(content)
      || !isSearchQueryText(decision.value)
      || !content.includes(decision.value)
    ) return null
    return { action: decision.action, query: decision.value }
  }
  if (decision.action === 'respond' || decision.action === 'pass') {
    return { action: decision.action }
  }
  return null
}

function requiresHandledVideoDecision(content) {
  const evidence = extractEvidence(content)
  return VIDEO_SHAPE.test(content)
    || (LEARNING_ACTION.test(content) && evidence.paths.length > 0)
    || (STATUS_SHAPE.test(content)
      && (evidence.taskIds.length > 0 || evidence.batchIds.length > 0))
    || isStrongStatusSearchCandidate(content)
}

function encode(value) {
  const text = typeof value === 'string' ? value : Number.isFinite(value) ? String(value) : ''
  return `${Buffer.byteLength(text, 'utf8')}:${text}`
}

function stableOperationId(event, context, kind) {
  const canonical = [
    `aiworker-qwen-hook:${kind}:v1`,
    event.channel,
    context.accountId,
    context.conversationId,
    event.sessionKey,
    event.senderId,
    event.timestamp,
    event.content,
  ].map(encode).join('|')
  const digest = createHash('sha256').update(canonical, 'utf8').digest('hex')
  return kind === 'directory' ? `video-batch-${digest}` : `video-natural-${digest}`
}

function operationKey(event, context) {
  return createHash('sha256').update([
    'aiworker-qwen-hook-operation:v1',
    event.sessionKey,
    context.conversationId,
    event.senderId,
    event.timestamp,
    event.content,
  ].map(encode).join('|'), 'utf8').digest('hex')
}

export function dispatchReceipt(result) {
  if (result.confirmationRequired) {
    const names = result.duplicateNames.map(searchName)
    if (result.kind === 'batch') {
      const suffix = result.truncated ? '等' : ''
      return `这个目录中有 ${result.duplicateCount} 个同名同路径的视频已有分析记录：${names.join('、')}${suffix}。如需整批重新分析，请回复“${DUPLICATE_CONFIRMATION_TEXT}”。`
    }
    return `这个视频已经分析过：${names[0]}。如需重新分析，请回复“${DUPLICATE_CONFIRMATION_TEXT}”。`
  }
  if (result.kind === 'batch') {
    return `${result.duplicate ? '批次已存在' : '已加入学习队列'}，批次编号：${result.id}。进度请稍后按批次编号查询。`
  }
  return `${result.duplicate ? '任务已存在' : '已提交'}，任务编号：${result.id}。结果请稍后查询。`
}

export function statusReceipt(result) {
  if (result.kind === 'batch_item') {
    const completed = (result.counts.succeeded ?? 0) + (result.counts.failed ?? 0)
      + (result.counts.cancelled ?? 0)
    const itemLabels = {
      staging: '准备中',
      queued: '已排队',
      submitted: '已提交',
      accepted: '已受理',
      running: '处理中',
      waiting: '等待中',
      succeeded: '已完成',
      failed: '失败',
      cancelled: '已取消',
    }
    const batchLabels = {
      queued: '已排队',
      running: '处理中',
      recovering: '恢复中',
      paused: '已暂停',
      succeeded: '已完成',
      completed_with_errors: '已完成（含失败项）',
    }
    return `${searchName(result.name)}：${itemLabels[result.status] ?? '状态未知'}；所在批次${batchLabels[result.batchStatus] ?? '状态未知'}，已结束 ${completed}/${result.total}。`
  }
  if (result.kind === 'batch') {
    const completed = (result.counts.succeeded ?? 0) + (result.counts.failed ?? 0)
      + (result.counts.cancelled ?? 0)
    const labels = {
      queued: '已排队',
      running: '处理中',
      recovering: '恢复中',
      paused: '已暂停',
      succeeded: '已完成',
      completed_with_errors: '已完成（含失败项）',
    }
    return `批次${labels[result.status] ?? '状态未知'}；已结束 ${completed}/${result.total}。`
  }
  if (result.status === 'succeeded' && result.summary) return `任务已完成。摘要：${result.summary}`
  const replies = {
    queued: '任务已排队。',
    accepted: '任务已受理。',
    running: '任务正在处理中。',
    succeeded: '任务已完成。',
    failed: '任务处理失败。',
    cancelled: '任务已取消。',
  }
  return replies[result.status] ?? '暂时无法查询任务状态。'
}

function searchStatusLabel(status) {
  const labels = {
    staging: '准备中',
    queued: '已排队',
    submitted: '已提交',
    accepted: '已受理',
    running: '处理中',
    waiting: '等待中',
    succeeded: '已完成',
    failed: '失败',
    cancelled: '已取消',
  }
  return labels[status] ?? '状态未知'
}

function searchName(value) {
  const name = String(value || '')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  if (!name) return '未命名视频'
  return name.length > 96 ? `${name.slice(0, 96)}…` : name
}

function searchCandidatesReceipt(result) {
  const shown = result.matches.slice(0, 5)
    .map(match => `${searchName(match.name)}（${searchStatusLabel(match.status)}）`)
  if (!shown.length) return '未找到匹配的视频任务进度。'
  const prefix = result.truncated ? '匹配结果较多' : `找到 ${result.total} 条匹配任务`
  return `${prefix}：${shown.join('；')}。请补充视频标题或关键词。`
}

function resultCandidatesReceipt(result) {
  const shown = result.matches.slice(0, 5)
    .map((match, offset) => {
      const identifiers = [`任务编号：${match.taskId}`]
      if (match.batchId) identifiers.push(`批次编号：${match.batchId}`, `批次项：${match.index}`)
      if (match.completedAt) identifiers.push(`完成时间：${match.completedAt}`)
      if (match.updatedAt) identifiers.push(`更新时间：${match.updatedAt}`)
      return `${offset + 1}. ${searchName(match.name)}（${searchStatusLabel(match.status)}；${identifiers.join('；')}）`
    })
  if (!shown.length) return '未找到匹配的视频学习结果。'
  const prefix = result.truncated ? '匹配结果较多' : `找到 ${result.total} 条匹配视频`
  return `${prefix}：\n${shown.join('\n')}\n候选按匹配度和更新时间倒序排列；请选择完成时间最新的已完成候选，下一次只使用其任务编号调用 result。禁止继续改写名称、并行搜索或要求用户补充编号。`
}

export function resultReceipt(result) {
  if (result.kind === 'matches') return resultCandidatesReceipt(result)
  if (result.status !== 'succeeded') return statusReceipt({ kind: 'task', status: result.status, summary: null })
  if (!result.report) return '任务已完成，但尚未生成可读取的完整学习报告。'
  const title = result.name ? `${searchName(result.name)}完整学习结果：\n` : '完整学习结果：\n'
  const continuation = result.report.nextOffset === null
    ? ''
    : `\n\n报告较长；继续读取请使用相同查询并传 offset=${result.report.nextOffset}。`
  return `${title}${result.report.text}${continuation}`
}

export async function queryStatusSearch({ runner = schedulerRunner, query } = {}) {
  try {
    const search = await runner.searchStatus({ query })
    if (!search.matches.length || search.total === 0) {
      return '未找到匹配的视频任务进度。'
    }
    if (search.total !== 1 || search.truncated || search.matches.length !== 1) {
      return searchCandidatesReceipt(search)
    }
    const match = search.matches[0]
    const result = match.kind === 'task'
      ? await runner.taskStatus({ taskId: match.taskId })
      : await runner.batchItemStatus({ batchId: match.batchId, index: match.index })
    return statusReceipt(result)
  } catch {
    return '暂时无法查询视频任务，本次未重试。'
  }
}

export function createQwenBeforeDispatchHandler({
  classifier,
  runner = schedulerRunner,
  releaseReady = true,
  now = () => Date.now(),
  duplicateConfirmationStore = createDuplicateConfirmationStore({ now }),
} = {}) {
  if (typeof classifier !== 'function') throw new TypeError('classifier is required')
  const operations = new Map()

  function prune() {
    const cutoff = now() - OPERATION_TTL_MS
    for (const [key, value] of operations) if (value.createdAt < cutoff) operations.delete(key)
    while (operations.size > MAX_PENDING_OPERATIONS) operations.delete(operations.keys().next().value)
  }

  async function classifyAndRun(event, context, scopeKey) {
    const decision = validateDecision(await classifier(event.content), event.content)
    if (!decision) return handled('未执行：暂时无法理解这个视频请求。')
    if (decision.action === 'pass') {
      return requiresHandledVideoDecision(event.content)
        ? handled('未执行：暂时无法理解这个视频请求。')
        : undefined
    }
    if (decision.action === 'respond') {
      return handled('本次未执行。请提供绝对视频路径、视频目录、视频标题/关键词或完整任务编号。')
    }
    if (decision.action === 'dispatch_single') {
      const taskId = stableOperationId(event, context, 'single')
      try {
        const result = await runner.dispatchVideo({
          videoPath: decision.videoPath,
          taskId,
        })
        if (result.confirmationRequired) {
          duplicateConfirmationStore.set(scopeKey, {
            kind: 'task', id: taskId, path: decision.videoPath,
          })
        }
        return handled(dispatchReceipt(result))
      } catch {
        return handled(`提交状态未确认，任务编号：${taskId}。请稍后按编号查询，不要重复提交。`)
      }
    }
    if (decision.action === 'dispatch_directory') {
      const batchId = stableOperationId(event, context, 'directory')
      try {
        const result = await runner.dispatchDirectory({
          videoDirectory: decision.videoDirectory,
          batchId,
        })
        if (result.confirmationRequired) {
          duplicateConfirmationStore.set(scopeKey, {
            kind: 'batch', id: batchId, path: decision.videoDirectory,
          })
        }
        return handled(dispatchReceipt(result))
      } catch {
        return handled(`入队状态未确认，批次编号：${batchId}。请稍后按编号查询，不要重复提交。`)
      }
    }
    if (decision.action === 'status_search') {
      return handled(await queryStatusSearch({ runner, query: decision.query }))
    }
    if (decision.action === 'result_task'
      || decision.action === 'result_batch'
      || decision.action === 'result_search') {
      try {
        return handled(resultReceipt(await runner.taskResult({ query: decision.query, offset: 0 })))
      } catch {
        return handled('暂时无法读取完整学习结果，本次未重试。')
      }
    }
    try {
      const result = decision.action === 'status_task'
        ? await runner.taskStatus({ taskId: decision.taskId })
        : await runner.batchStatus({ batchId: decision.batchId })
      return handled(statusReceipt(result))
    } catch {
      return handled('暂时无法查询该任务，本次未重试。')
    }
  }

  async function confirmAndRun(scopeKey) {
    const pending = duplicateConfirmationStore.take(scopeKey)
    if (!pending) return handled('当前没有等待确认的重复视频任务。')
    try {
      const result = pending.kind === 'batch'
        ? await runner.dispatchDirectory({
          videoDirectory: pending.path,
          batchId: pending.id,
          confirmDuplicate: true,
        })
        : await runner.dispatchVideo({
          videoPath: pending.path,
          taskId: pending.id,
          confirmDuplicate: true,
        })
      if (result.confirmationRequired) duplicateConfirmationStore.set(scopeKey, pending)
      return handled(dispatchReceipt(result))
    } catch {
      const label = pending.kind === 'batch' ? '批次编号' : '任务编号'
      return handled(`提交状态未确认，${label}：${pending.id}。请稍后按编号查询，不要重复提交。`)
    }
  }

  return function beforeDispatch(event, context) {
    const confirmsDuplicate = isDuplicateConfirmationText(event?.content)
    if (!confirmsDuplicate && !isClassifierCandidate(event?.content)) return undefined
    try {
      const channel = resolveConsistentString(event?.channel, context?.channelId)
      if (channel === null) return Promise.resolve(handled('未执行：消息上下文不一致。'))
      if (channel !== TARGET_CHANNEL) return undefined
      if (event?.isGroup !== false) return Promise.resolve(handled('未执行：仅支持 Telegram 私聊。'))
      const sessionKey = resolveConsistentString(event?.sessionKey, context?.sessionKey)
      if (sessionKey === null) return Promise.resolve(handled('未执行：消息上下文不一致。'))
      if (!sessionOwnsTargetAgent(sessionKey)) return undefined
      const identity = resolveTelegramConversationIdentity(event, context)
      if (!identity.ok) return Promise.resolve(handled('未执行：消息上下文不一致。'))
      if (!releaseReady) {
        return Promise.resolve(handled('视频学习服务正在发布维护，请稍后再试。'))
      }
      if (!Number.isFinite(event?.timestamp)) {
        return Promise.resolve(handled('未执行：缺少有效消息时间。'))
      }

      prune()
      const key = operationKey(event, context)
      const existing = operations.get(key)
      if (existing) return existing.promise
      const promise = (confirmsDuplicate
        ? confirmAndRun(identity.scopeKey)
        : classifyAndRun(event, context, identity.scopeKey)).catch(() => (
        handled('未执行：暂时无法理解这个视频请求。')
      ))
      operations.set(key, { promise, createdAt: now() })
      return promise
    } catch {
      return Promise.resolve(handled('未执行：暂时无法理解这个视频请求。'))
    }
  }
}

export { extractEvidence, validateDecision }
