import { createHash } from 'node:crypto'

import { schedulerRunner } from './scheduler-runner.js'

const TARGET_CHANNEL = 'feishu'
const TARGET_AGENT = 'second-original'
const MAX_QUERY_LENGTH = 512
const PAGE_SIZE = 20
const MAX_SEGMENTS = 10_000
const TASK_ID_PATTERN = /\b(?:video-command|video-natural)-[a-f0-9]{64}\b/iu
const BATCH_TASK_ID_PATTERN = /\bvideo-batch-[a-f0-9]{64}:video:\d{3}:[a-f0-9]{12}\b/iu
const QUOTED_TITLE_PATTERN = /《[^》]{2,96}》\s*(?:第\s*[零〇一二两三四五六七八九十百0-9]+\s*季)?\s*(?:第\s*[零〇一二两三四五六七八九十百0-9]+\s*集)?/u
const FILE_NAME_PATTERN = /[^\s，。；;！？!?]{2,160}\.(?:m4v|mkv|mov|mp4|webm)/iu
const SEASON_EPISODE_PATTERN = /(?:第\s*[零〇一二两三四五六七八九十百0-9]+\s*季\s*第\s*[零〇一二两三四五六七八九十百0-9]+\s*集|s\s*\d{1,3}\s*e\s*\d{1,4})/iu
const DIRECT_READ_PATTERN = /(?:直读|原文|已保存|不要(?:重新)?(?:总结|生成|改写|合并|处理)|不(?:要|需|用)(?:总结|生成|改写|合并|处理)|逐条|按条|一条一条|每个片段|每条摘要)/u
const DIRECT_OVERRIDE_PATTERN = /(?:直读|原文|不要(?:重新)?(?:总结|生成|改写|合并|处理)|不(?:要|需|用)(?:总结|生成|改写|合并|处理)|逐条|按条|一条一条|每个片段|每条摘要)/u
const PROJECT_SUMMARY_PATTERN = /(?:项目级|项目摘要|汇总|归纳|生成.{0,12}摘要|总结.{0,12}(?:摘要|项目))/u
const READ_SUMMARY_PATTERN = /(?:读取|读|查看|发送|发|给我).{0,40}(?:摘要|片段)/u
const SUMMARY_WORD_PATTERN = /(?:摘要|片段)/u
const ALL_PATTERN = /(?:全部|所有|每个|全量|从头到尾|完整读取)/u
const COUNT_PATTERN = /(?:前\s*)?(\d{1,5}|[零〇一二两三四五六七八九十百]+)\s*(?:个|条|篇|段)/u
const SEGMENT_INDEX_PATTERN = /(?:片段|分段|章节)\s*(\d{1,5})/u
const LATEST_PATTERN = /(?:最近|最新|上一次|最后一次)/u
const CHINESE_DIGITS = Object.freeze({ 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 })

function toPositiveInteger(value) {
  if (!value) return null
  if (/^\d+$/u.test(value)) {
    const number = Number(value)
    return Number.isSafeInteger(number) && number > 0 ? number : null
  }
  let total = 0
  let current = 0
  for (const char of value) {
    if (CHINESE_DIGITS[char] !== undefined) current = CHINESE_DIGITS[char]
    else if (char === '十') {
      total += (current || 1) * 10
      current = 0
    } else if (char === '百') {
      total += (current || 1) * 100
      current = 0
    } else return null
  }
  const number = total + current
  return Number.isSafeInteger(number) && number > 0 ? number : null
}

function cleanQuery(value) {
  const query = String(value || '').replace(/[\r\n\t]+/gu, ' ').trim()
  if (!query || query.length > MAX_QUERY_LENGTH || /[\u0000-\u001f\u007f]/u.test(query)) return null
  return query
}

function extractQuery(text) {
  const batchTask = text.match(BATCH_TASK_ID_PATTERN)?.[0]
  if (batchTask) return batchTask
  const task = text.match(TASK_ID_PATTERN)?.[0]
  if (task) return task
  const quoted = text.match(QUOTED_TITLE_PATTERN)?.[0]
  if (quoted) return cleanQuery(quoted)
  const file = text.match(FILE_NAME_PATTERN)?.[0]
  if (file) return cleanQuery(file)
  const marker = text.match(SEASON_EPISODE_PATTERN)?.[0]
  if (marker) {
    const prefix = text.slice(0, text.indexOf(marker))
      .split(/[，。；;！？!?\n]/u).at(-1)
      ?.replace(/(?:读取|读|查看|发送|发|给我|摘要|片段|原文|已保存|逐条|按条|一条一条)/gu, '')
      .trim()
    return cleanQuery(`${prefix || ''}${marker}`)
  }
  return null
}

export function parseSavedSummaryRequest(value) {
  if (typeof value !== 'string') return null
  const text = value.normalize('NFKC').trim()
  if (!text || !SUMMARY_WORD_PATTERN.test(text)) return null
  const latest = LATEST_PATTERN.test(text)
  if (!READ_SUMMARY_PATTERN.test(text) && !latest) return null
  if (PROJECT_SUMMARY_PATTERN.test(text) && !DIRECT_OVERRIDE_PATTERN.test(text)) return null
  if (!DIRECT_READ_PATTERN.test(text) && !COUNT_PATTERN.test(text) && !ALL_PATTERN.test(text)) return null
  const query = extractQuery(text)
  const latestRequest = !query && latest
  if (!query && !latestRequest) return null
  const segmentIndex = toPositiveInteger(text.match(SEGMENT_INDEX_PATTERN)?.[1])
  const requestedCount = toPositiveInteger(text.match(COUNT_PATTERN)?.[1])
  return {
    query: query || null,
    ...(latestRequest ? { latest: true } : {}),
    ...(segmentIndex === null ? {} : { segmentIndex }),
    count: segmentIndex === null ? (requestedCount || (ALL_PATTERN.test(text) ? null : null)) : 1,
  }
}

async function resolveRequestQuery(request, runner) {
  if (request.query) return request.query
  if (!request.latest) return null
  const search = await runner.taskResult({
    query: '已完成',
    view: 'segments',
    segmentOffset: 0,
    segmentLimit: PAGE_SIZE,
  })
  if (search.kind !== 'matches' || !Array.isArray(search.matches)) return null
  const candidates = search.matches
    .filter(item => item?.status === 'succeeded' && typeof item.taskId === 'string')
    .toSorted((left, right) => String(right.completedAt || right.updatedAt || '')
      .localeCompare(String(left.completedAt || left.updatedAt || '')))
  return candidates[0]?.taskId || null
}

function contextText(ctx) {
  for (const key of ['commandText', 'rawText', 'BodyForCommands', 'CommandBody', 'BodyForAgent', 'Body', 'Prompt']) {
    if (typeof ctx?.[key] === 'string' && ctx[key].trim()) return ctx[key]
  }
  return ''
}

function textHash(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16)
}

function summaryMessage(item, summary) {
  const heading = `片段 ${item.index}（${item.timeRange}）`
  const completeness = item.completeness === 'incomplete'
    ? '\n内容状态：不完整，需要定向修复。'
    : item.completeness === 'unknown'
      ? '\n内容状态：历史摘要完整性未知。'
      : ''
  return `${heading}${completeness}\n${summary}`
}

function counts(dispatcher) {
  try {
    return dispatcher.getQueuedCounts()
  } catch {
    return { tool: 0, block: 0, final: 0 }
  }
}

function isFeishuDirect(event) {
  const ctx = event?.ctx || {}
  const channel = event?.originatingChannel || ctx.OriginatingChannel
  const chatType = event?.originatingChatType || ctx.ChatType
  const sessionKey = event?.sessionKey || ctx.SessionKey || ''
  const agentId = ctx.AgentId || sessionKey.split(':')[1]
  return channel === TARGET_CHANNEL
    && (chatType === undefined || chatType === 'direct')
    && agentId === TARGET_AGENT
    && ctx.InboundAccessAuthorized !== false
}

async function send(dispatcher, text, sendText, sendContext) {
  if (sendText) {
    try {
      await sendText({
        cfg: sendContext.cfg,
        to: sendContext.to,
        text,
        ...(sendContext.accountId === undefined ? {} : { accountId: sendContext.accountId }),
        ...(sendContext.threadId === undefined ? {} : { threadId: sendContext.threadId }),
        ...(sendContext.replyToId === undefined ? {} : { replyToId: sendContext.replyToId }),
        ...(sendContext.gatewayClientScopes === undefined ? {} : {
          gatewayClientScopes: sendContext.gatewayClientScopes,
        }),
      })
      return true
    } catch {
      return false
    }
  }
  if (!dispatcher || typeof dispatcher.sendFinalReply !== 'function') return false
  return dispatcher.sendFinalReply({ text }) === true
}

async function deliver(request, dispatcher, runner, sendText, sendContext) {
  const query = await resolveRequestQuery(request, runner)
  if (!query) {
    await send(dispatcher, '没有找到唯一的最近已完成任务，请补充作品名称后再读取。', sendText, sendContext)
    return { sent: 0, failed: true }
  }
  let sent = 0
  let offset = 0
  let total = null
  const stopAfter = request.count === null ? Number.POSITIVE_INFINITY : request.count

  if (request.segmentIndex !== undefined) {
    const result = await runner.taskResult({
      query,
      view: 'segment',
      segmentIndex: request.segmentIndex,
    })
    if (result.kind !== 'segment' || result.status !== 'succeeded' || !result.segment) {
      await send(dispatcher, `片段 ${request.segmentIndex} 读取失败，本次未重试其他片段。`, sendText, sendContext)
      return { sent: 0, failed: true }
    }
    if (!await send(dispatcher, summaryMessage(result.segment, result.segment.summary), sendText, sendContext)) {
      return { sent: 0, failed: true }
    }
    return { sent: 1, failed: false }
  }

  while (sent < stopAfter) {
    const page = await runner.taskResult({
      query,
      view: 'segments',
      segmentOffset: offset,
      segmentLimit: PAGE_SIZE,
    })
    if (page.kind === 'matches') {
      await send(dispatcher, '匹配到多个视频结果，请补充明确的作品名称后再读取。', sendText, sendContext)
      return { sent, failed: true }
    }
    if (page.kind !== 'segments' || page.status !== 'succeeded') {
      await send(dispatcher, '当前没有可读取的已保存片段摘要，本次未重新学习。', sendText, sendContext)
      return { sent, failed: true }
    }
    total = page.totalSegments
    if (!Number.isSafeInteger(total) || total < 0 || total > MAX_SEGMENTS) {
      await send(dispatcher, '片段数量超出受控读取范围，本次未发送。', sendText, sendContext)
      return { sent, failed: true }
    }
    if (!page.items.length) break
    for (const item of page.items) {
      if (sent >= stopAfter) break
      const detail = await runner.taskResult({
        query,
        view: 'segment',
        segmentIndex: item.index,
      })
      if (detail.kind !== 'segment' || detail.status !== 'succeeded' || !detail.segment) {
        await send(dispatcher, `片段 ${item.index}（${item.timeRange}）读取失败，已停止后续发送；重试时只重试这一条。`, sendText, sendContext)
        return { sent, failed: true }
      }
      if (!await send(dispatcher, summaryMessage(detail.segment, detail.segment.summary), sendText, sendContext)) {
        return { sent, failed: true }
      }
      sent += 1
    }
    if (sent >= stopAfter || page.nextSegmentOffset === null) break
    if (!Number.isSafeInteger(page.nextSegmentOffset) || page.nextSegmentOffset <= offset) {
      await send(dispatcher, '片段目录分页状态无效，已停止发送。', sendText, sendContext)
      return { sent, failed: true }
    }
    offset = page.nextSegmentOffset
  }
  if (sent === 0) await send(
    dispatcher,
    total === 0 ? '当前任务没有已保存片段摘要。' : '当前没有可读取的已保存片段摘要。',
    sendText,
    sendContext,
  )
  return { sent, failed: false }
}

export function createSavedSummaryDirectReplyHandler({ runner = schedulerRunner, sendText } = {}) {
  const active = new Map()
  return async function savedSummaryDirectReply(event, hookContext) {
    if (!isFeishuDirect(event)) return undefined
    const request = parseSavedSummaryRequest(contextText(event.ctx))
    if (!request) return undefined
    const sessionKey = event.sessionKey || event.ctx?.SessionKey || hookContext?.sessionKey || ''
    const operationKey = `${sessionKey}:${textHash(JSON.stringify(request))}`
    const existing = active.get(operationKey)
    if (existing) return existing
    const operation = (async () => {
      const sendContext = {
        cfg: hookContext?.cfg,
        to: event.originatingTo || event.ctx?.OriginatingTo,
        accountId: event.originatingAccountId,
        threadId: event.originatingThreadId || event.ctx?.TransportThreadId,
        replyToId: event.ctx?.ReplyToId || event.ctx?.MessageSid,
        gatewayClientScopes: event.ctx?.GatewayClientScopes,
      }
      const directSendText = sendText && sendContext.cfg && sendContext.to ? sendText : undefined
      const result = await deliver(
        request,
        hookContext?.dispatcher,
        runner,
        directSendText,
        sendContext,
      )
      const delivered = result.sent > 0
      hookContext?.recordProcessed?.(result.failed ? 'error' : 'completed', {
        reason: result.failed ? 'saved_summary_direct_delivery_failed' : 'saved_summary_direct_delivery',
      })
      hookContext?.markIdle?.('message_completed')
      return {
        handled: true,
        queuedFinal: delivered,
        counts: counts(hookContext?.dispatcher),
      }
    })().catch(async () => {
      await send(
        hookContext?.dispatcher,
        '已保存摘要读取失败，本次未重新学习；重试时只重试当前请求。',
        sendText && hookContext?.cfg && (event.originatingTo || event.ctx?.OriginatingTo)
          ? sendText
          : undefined,
        {
          cfg: hookContext?.cfg,
          to: event.originatingTo || event.ctx?.OriginatingTo,
          accountId: event.originatingAccountId,
          threadId: event.originatingThreadId || event.ctx?.TransportThreadId,
          replyToId: event.ctx?.ReplyToId || event.ctx?.MessageSid,
          gatewayClientScopes: event.ctx?.GatewayClientScopes,
        },
      )
      hookContext?.recordProcessed?.('error', { reason: 'saved_summary_direct_delivery_error' })
      hookContext?.markIdle?.('message_completed')
      return { handled: true, queuedFinal: true, counts: counts(hookContext?.dispatcher) }
    })
    active.set(operationKey, operation)
    try {
      return await operation
    } finally {
      active.delete(operationKey)
    }
  }
}

export { PAGE_SIZE, MAX_SEGMENTS }
