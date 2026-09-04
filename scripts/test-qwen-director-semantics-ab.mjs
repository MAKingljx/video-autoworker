#!/usr/bin/env node

const QWEN38_URL = process.env.QWEN38_CHAT_URL
  || 'http://127.0.0.1:18092/v1/chat/completions'
const QWEN36_URL = process.env.QWEN36_CHAT_URL
  || 'http://127.0.0.1:18091/v1/chat/completions'
const REQUEST_TIMEOUT_MS = Number(process.env.CANARY_AB_TIMEOUT_MS || 600_000)

const SAFE_DIRECTOR_SUMMARY = [
  '这是一段隔离测试使用的虚构导演学习摘要。',
  '素材来源已经人工审核，学习重点是持续追问为什么这样判断。',
  '沉淀链条是：证据到人物与故事，再到判断与叙事、案例和技法。',
  '整条链受导演意图约束，任何复用结论都必须再次经过人工审核。',
].join('\n')

const QUESTION = '导演脑提炼技法的底层逻辑是什么？请用不超过两句、一百六十字的中文回答，并逐字包含：已审核、为什么这样判断、证据、人物、故事、判断、叙事、案例、技法、导演意图、人工审核。'

const REQUIREMENTS = Object.freeze([
  ['reviewed', /已审核/u],
  ['why-judgment', /为什么.*判断|判断.*原因/u],
  ['evidence', /证据/u],
  ['person', /人物/u],
  ['story', /故事/u],
  ['judgment', /判断/u],
  ['narrative', /叙事/u],
  ['case', /案例/u],
  ['technique', /技法/u],
  ['director-intent', /导演意图/u],
  ['human-review', /人工审核/u],
])

const FORBIDDEN_INTERNAL_TERMS = /workflow|workId|record.?id|checkpoint|compaction|API|JSON|内部ID/iu

if (!Number.isSafeInteger(REQUEST_TIMEOUT_MS)
  || REQUEST_TIMEOUT_MS < 10_000
  || REQUEST_TIMEOUT_MS > 900_000) {
  throw new Error('CANARY_AB_TIMEOUT_MS must be between 10000 and 900000')
}

function concise(text) {
  if (typeof text !== 'string' || text.trim().length === 0) return false
  const sentences = text.split(/[。！？!?]+/u).filter(Boolean).length
  return Array.from(text).length <= 160 && sentences <= 2
}

function semantic(text) {
  return typeof text === 'string' && REQUIREMENTS.every(([, pattern]) => pattern.test(text))
}

function missingSemanticMarkers(text) {
  if (typeof text !== 'string') return REQUIREMENTS.map(([label]) => label)
  return REQUIREMENTS.filter(([, pattern]) => !pattern.test(text)).map(([label]) => label)
}

function visibleDelta(parsed) {
  const choice = parsed?.choices?.[0]
  const delta = choice?.delta?.content
  if (typeof delta === 'string') return delta
  if (Array.isArray(delta)) {
    return delta.map(item => typeof item?.text === 'string' ? item.text : '').join('')
  }
  if (typeof choice?.text === 'string') return choice.text
  return ''
}

function finalText(parsed) {
  const choice = parsed?.choices?.[0]
  const content = choice?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(item => typeof item?.text === 'string' ? item.text : '').join('')
  }
  return typeof choice?.text === 'string' ? choice.text : ''
}

function consumeSseFrame(frame) {
  const payloads = frame.split(/\r?\n/u)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trim())
    .filter(value => value && value !== '[DONE]')
  return payloads.map(payload => JSON.parse(payload))
}

async function runOne(label, url, requestBody) {
  const startedAt = performance.now()
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`)

  const contentType = response.headers.get('content-type') || ''
  let answer = ''
  let firstVisibleMs = null
  if (!contentType.includes('text/event-stream')) {
    const parsed = await response.json()
    answer = finalText(parsed)
    if (answer.length > 0) firstVisibleMs = Math.round(performance.now() - startedAt)
  } else {
    const decoder = new TextDecoder()
    const reader = response.body?.getReader()
    if (!reader) throw new Error(`${label} returned no streaming body`)
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const frames = buffer.split(/\r?\n\r?\n/u)
      buffer = frames.pop() || ''
      for (const frame of frames) {
        for (const parsed of consumeSseFrame(frame)) {
          const delta = visibleDelta(parsed)
          if (delta && firstVisibleMs === null) {
            firstVisibleMs = Math.round(performance.now() - startedAt)
          }
          answer += delta
        }
      }
    }
    if (buffer.trim()) {
      for (const parsed of consumeSseFrame(buffer)) {
        const delta = visibleDelta(parsed)
        if (delta && firstVisibleMs === null) {
          firstVisibleMs = Math.round(performance.now() - startedAt)
        }
        answer += delta
      }
    }
  }

  const elapsedMs = Math.round(performance.now() - startedAt)
  return {
    label,
    answerPresent: answer.trim().length > 0,
    answerConcise: concise(answer),
    answerMatchesDirectorSemantics: semantic(answer),
    missingSemanticMarkers: missingSemanticMarkers(answer),
    answerAvoidsInternalTerms: !FORBIDDEN_INTERNAL_TERMS.test(answer),
    firstVisibleMs,
    totalElapsedMs: elapsedMs,
  }
}

const requestBody = Object.freeze({
  model: 'default_model',
  messages: [
    {
      role: 'system',
      content: '只依据给定摘要回答；不要调用工具，不要输出技术标识、过程说明或后续建议。',
    },
    {
      role: 'user',
      content: `${SAFE_DIRECTOR_SUMMARY}\n\n${QUESTION}`,
    },
  ],
  temperature: 0,
  max_tokens: 512,
  stream: true,
  chat_template_kwargs: { enable_thinking: false },
})

const results = []
for (const [label, url] of [
  ['qwen38', QWEN38_URL],
  ['qwen36-tools', QWEN36_URL],
]) {
  results.push(await runOne(label, url, requestBody))
}

const ok = results.every(result => (
  result.answerPresent
  && result.answerConcise
  && result.answerMatchesDirectorSemantics
  && result.answerAvoidsInternalTerms
))

console.log(JSON.stringify({
  ok,
  sameInput: true,
  sequential: true,
  externalSideEffectsDisabled: true,
  results,
}))
if (!ok) process.exitCode = 1
