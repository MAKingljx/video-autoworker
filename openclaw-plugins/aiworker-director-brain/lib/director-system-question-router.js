import {
  DIRECTOR_BRAIN_UNAVAILABLE_MESSAGE,
  readDirectorBrainSystemAnswer,
} from './director-brain-tool.js'

export const DIRECTOR_BRAIN_MAINTENANCE_MESSAGE = '导演脑正在维护，请稍后再试。'

const MAX_SYSTEM_QUESTION_CHARS = 320
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const SAFE_AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u
const QUESTION_SHAPE = /(?:什么|怎么|如何|哪里|哪儿|哪些|哪几|几层|是否|是不是|吗|介绍|说说|讲讲|说明|解释)/u
const MUTATING_OR_RUNTIME_SHAPE = /(?:修改|优化|开发(?!什么|哪些)|添加|删除|创建|启动|停止|暂停|迁移|部署|安装|升级|发版|切换|回滚|记录|保存(?!哪些|什么)|写入|审核|批准|驳回|健康|在线|连接|连不上|进程|PID|端口|版本|报错|失败|超时|额度|卡点|进度\s*(?:%|百分比)|测试一下|跑一下)/iu
const WORK_SPECIFIC_SHAPE = /(?:《[^\n》]{1,80}》|「[^\n」]{1,80}」|『[^\n』]{1,80}』|\.(?:mp4|mov|mkv|m4v|webm)\b|第\s*[一二三四五六七八九十百千0-9]+\s*(?:季|集|期)|(?:这个|这部|该)(?:作品|片子|视频|素材)|\b(?:work|task|run|record)[-_]?[A-Za-z0-9])/iu
const MULTI_INTENT_SHAPE = /(?:以及|并且|同时|还有|顺便|分别|另外|然后|再帮|接着|\b(?:and|plus|then)\b)/iu
const META_OR_CONDITIONAL_SHAPE = /(?:如果|假如|假设|例如|比如|举例|示例|引用|原句|这句话|有人问|别人问|当别人|提示词|测试语料)/u
const NEGATED_QUESTION_SHAPE = /(?:(?:不要|别|无需|不用|不必)\s*(?:回答|解释|介绍|说明|讲|说)|(?:不是|并非)\s*(?:在问|想问|要问)|导演(?:大)?脑[^。！？!?]{0,24}(?:不用|不要|别)\s*(?:回答|解释|介绍|说明|讲|说))/u
const QUOTED_OR_CODE_SHAPE = /[“”‘’"'`]/u
// This fast path is intentionally limited to reviewed, static descriptions.
// Diagnosis, comparison and evaluation need the normal Agent so qualifiers are
// not discarded by a synthetic blueprint answer.
const DIAGNOSTIC_OR_EVALUATIVE_SHAPE = /(?:问题|风险|错误|不合理|安全|隐患|缺陷|漏洞|影响|误判|泄露|准确(?:性|率)?|可靠(?:性)?|优缺点|好不好|是否合理|合理吗|为什么会|为何会|如何改进|怎么改进|怎样改进|如何优化|怎么优化|怎样优化|比较|对比|评估|评价)/u

const TOPIC_MATCHERS = Object.freeze([
  {
    topic: 'architecture',
    matches: text => /(?:架构|六层|分几层|有哪几层|由哪些层|系统结构|怎么组成|由什么组成)/u.test(text),
  },
  {
    topic: 'technique_learning',
    matches: text => /(?:技法|导演经验|案例库)/u.test(text)
      && /(?:学习|提炼|沉淀|形成|积累|底层逻辑|机制|原理|怎么|如何)/u.test(text),
  },
  {
    topic: 'final_goal',
    matches: text => /(?:最终目标|最后目标|建成后|最终形态|最后形态|最终.*能力|最后.*能做什么)/u.test(text),
  },
  {
    topic: 'integration_boundary',
    matches: text => /(?:怎么接入|如何接入|接入方式|集成边界|和现有项目的关系|与现有项目的关系|是不是独立项目|是否是独立项目|与\s*OpenClaw\s*的关系|和\s*OpenClaw\s*的关系|单一任务链)/iu.test(text),
  },
  {
    topic: 'data_boundary',
    matches: text => /(?:数据边界|数据存在哪|数据存哪|存储在哪|保存哪些数据|保存什么数据|哪些数据不保存|不保存哪些数据|什么(?:数据)?不会存)/u.test(text),
  },
  {
    topic: 'current_scope',
    matches: text => /(?:当前范围|目前范围|现阶段范围|当前功能边界|现阶段功能边界|现在包括哪些功能|目前包括哪些功能|暂不包括什么|暂不开发什么|是否包含剪辑执行|是不是包含剪辑执行)/u.test(text),
  },
])

function normalizeQuestion(value) {
  if (typeof value !== 'string') return null
  const text = value.normalize('NFKC').trim().replace(/[\t ]+/gu, ' ')
  if (!text || Array.from(text).length > MAX_SYSTEM_QUESTION_CHARS) return null
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text) || /[\r\n]/u.test(text)) return null
  const normalized = text
    .replace(/^(?:请问|想问一下|麻烦你|请你|帮我看下|帮我看看|给我|你能)?\s*/u, '')
    .replace(/[\s。！？!?]+$/gu, '')
  // More than one sentence is a mixed turn. Let the normal agent handle it
  // instead of partially answering and silently dropping the other intent.
  return /[。！？!?；;]/u.test(normalized) ? null : normalized
}

export function classifyDirectorBrainSystemQuestion(value) {
  const text = normalizeQuestion(value)
  if (!text || !/导演(?:大)?脑/u.test(text) || !QUESTION_SHAPE.test(text)) return null
  if (MUTATING_OR_RUNTIME_SHAPE.test(text) || WORK_SPECIFIC_SHAPE.test(text)) return null
  if (META_OR_CONDITIONAL_SHAPE.test(text) || NEGATED_QUESTION_SHAPE.test(text)) return null
  if (DIAGNOSTIC_OR_EVALUATIVE_SHAPE.test(text)) return null
  if (QUOTED_OR_CODE_SHAPE.test(text) || MULTI_INTENT_SHAPE.test(text)) return null
  const topics = TOPIC_MATCHERS.filter(entry => entry.matches(text)).map(entry => entry.topic)
  return topics.length === 1 ? topics[0] : null
}

function ownsTargetAgent(context, targetAgentId) {
  try {
    return SAFE_AGENT_ID.test(targetAgentId) && context?.agentId === targetAgentId
  } catch {
    return false
  }
}

function boundedRequest(operation, timeoutMs) {
  const boundedTimeoutMs = Number.isSafeInteger(timeoutMs) && timeoutMs > 0
    ? Math.min(timeoutMs, DEFAULT_REQUEST_TIMEOUT_MS)
    : DEFAULT_REQUEST_TIMEOUT_MS
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('director_brain_system_read_timeout')), boundedTimeoutMs)
    timer.unref?.()
  })
  return Promise.race([Promise.resolve().then(operation), timeout])
    .finally(() => clearTimeout(timer))
}

export function createDirectorBrainSystemQuestionHandler({
  releaseReady = true,
  targetAgentId,
  service,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
} = {}) {
  return async (event, context) => {
    if (!ownsTargetAgent(context, targetAgentId)) return undefined
    if (context?.trigger !== undefined && context.trigger !== 'user') return undefined
    const topic = classifyDirectorBrainSystemQuestion(event?.cleanedBody)
    if (!topic) return undefined
    if (!releaseReady) {
      return {
        handled: true,
        reply: { text: DIRECTOR_BRAIN_MAINTENANCE_MESSAGE },
        reason: 'director_brain_maintenance',
      }
    }
    try {
      const text = await boundedRequest(
        () => readDirectorBrainSystemAnswer(topic, { service }),
        requestTimeoutMs,
      )
      return {
        handled: true,
        reply: { text },
        reason: 'director_brain_system_question',
      }
    } catch {
      return {
        handled: true,
        reply: { text: DIRECTOR_BRAIN_UNAVAILABLE_MESSAGE },
        reason: 'director_brain_system_read_failed',
      }
    }
  }
}
