const ACTIONS = new Set([
  'dispatch_single',
  'dispatch_directory',
  'status_task',
  'status_batch',
  'status_search',
  'result_task',
  'result_batch',
  'result_search',
  'respond',
  'pass',
])
const TARGET_AGENT = 'second-original'
const CLASSIFIER_TIMEOUT_MS = 90_000

const SYSTEM_PROMPT = `你是视频学习入口的意图分类器，不是执行器。你没有工具，也不能访问文件。
只输出一行 JSON，不要 Markdown、解释或额外字段：
{"action":"dispatch_single|dispatch_directory|status_task|status_batch|status_search|result_task|result_batch|result_search|respond|pass","value":"原文中的路径、编号、标题或关键词，其他动作为空字符串"}

判定规则：
- 用户现在明确、肯定地要求学习/分析一个视频文件：dispatch_single。
- 用户现在明确、肯定地要求学习/分析一个视频目录或文件夹：dispatch_directory。
- 用户明确按完整任务编号查一次进度/结果：status_task。
- 用户明确按完整批次编号查一次进度：status_batch。
- 用户明确按视频标题、节目名、季集、文件名或其他自然语言关键词查询任务进度、状态、结果或入队情况：status_search；value 必须逐字复制当前消息中的标题、关键词或完整查询句，不得改写。
- 用户明确要求完整、详细或全文学习报告，并携带完整任务编号：result_task；携带完整批次编号：result_batch。
- 用户明确要求完整、详细或全文学习报告，并按视频标题、节目名、季集、文件名或关键词查询：result_search；value 必须逐字复制当前消息中的标题、关键词或完整查询句，不得改写。
- 视频相关但是否定、条件、举例、回顾、方法咨询、缺少必要路径/编号、存在多个候选：respond。
- 与视频学习和视频任务状态无关：pass。
- 不得猜测、补全、改写、正规化、搜索路径或编号；value 必须逐字复制用户原文中的唯一值。`

function parseResult(text) {
  if (typeof text !== 'string') throw new Error('classifier_invalid')
  const trimmed = text.trim()
  if (!trimmed || trimmed.split(/\r?\n/u).length !== 1) throw new Error('classifier_invalid')
  let value
  try {
    value = JSON.parse(trimmed)
  } catch {
    throw new Error('classifier_invalid')
  }
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'action,value'
    || !ACTIONS.has(value.action)
    || typeof value.value !== 'string'
    || value.value.length > 4_096
    || ((value.action === 'respond' || value.action === 'pass') && value.value !== '')
    || (!(value.action === 'respond' || value.action === 'pass') && !value.value)
  ) throw new Error('classifier_invalid')
  return value
}

export function createQwenClassifier({
  complete,
  timeoutMs = CLASSIFIER_TIMEOUT_MS,
} = {}) {
  if (typeof complete !== 'function') throw new TypeError('complete is required')
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 90_000) {
    throw new TypeError('classifier timeout is invalid')
  }

  return async function classify(content) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('classifier_timeout')), timeoutMs)
    timer.unref?.()
    try {
      const result = await complete({
        agentId: TARGET_AGENT,
        systemPrompt: SYSTEM_PROMPT,
        messages: [{ role: 'user', content }],
        purpose: 'aiworker.video-intent-classification',
        maxTokens: 120,
        temperature: 0,
        signal: controller.signal,
      })
      if (result?.agentId !== TARGET_AGENT) throw new Error('classifier_agent_mismatch')
      return parseResult(result?.text)
    } catch {
      throw new Error('classifier_failed')
    } finally {
      clearTimeout(timer)
    }
  }
}

export { parseResult as parseQwenClassifierResult }
