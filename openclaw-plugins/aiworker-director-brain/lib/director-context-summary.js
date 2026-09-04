import { containsSensitiveNarrativeValue } from './sensitive-narrative-text.js'

const MAX_MESSAGES = 512
const MAX_DEPTH = 12
const MAX_FACTS_PER_SECTION = 24
const MAX_FACT_CHARS = 360
const MAX_SUMMARY_CHARS = 12_000
const MAX_TRAVERSED_NODES = 20_000
const MAX_CUMULATIVE_INPUT_BYTES = 8 * 1024 * 1024
const MAX_BUILD_MILLISECONDS = 500

const SECTION_CHAR_BUDGETS = Object.freeze({
  decisions: 5_200,
  todos: 1_800,
  constraints: 1_800,
  pending: 1_800,
  identifiers: 64,
})

const REQUIRED_HEADINGS = Object.freeze([
  '## Decisions',
  '## Open TODOs',
  '## Constraints/Rules',
  '## Pending user asks',
  '## Exact identifiers',
])

const SAFE_FIELD_GROUPS = new Map(Object.entries({
  person: 'decisions',
  persons: 'decisions',
  people: 'decisions',
  character: 'decisions',
  characters: 'decisions',
  subject: 'decisions',
  conflict: 'decisions',
  conflicts: 'decisions',
  action: 'decisions',
  actions: 'decisions',
  emotion: 'decisions',
  emotions: 'decisions',
  change: 'decisions',
  changes: 'decisions',
  turningpoint: 'decisions',
  turningpoints: 'decisions',
  story: 'decisions',
  storyvalue: 'decisions',
  narrative: 'decisions',
  narrativevalue: 'decisions',
  theme: 'decisions',
  themes: 'decisions',
  directorjudgment: 'decisions',
  judgment: 'decisions',
  rationale: 'decisions',
  reason: 'decisions',
  why: 'decisions',
  observation: 'decisions',
  observations: 'decisions',
  summary: 'decisions',
  intent: 'constraints',
  directorintent: 'constraints',
  constraint: 'constraints',
  constraints: 'constraints',
  rule: 'constraints',
  rules: 'constraints',
  unresolvedquestion: 'todos',
  unresolvedquestions: 'todos',
  openquestion: 'todos',
  openquestions: 'todos',
  pending: 'todos',
  todo: 'todos',
  todos: 'todos',
  人物: 'decisions',
  主要人物: 'decisions',
  冲突: 'decisions',
  行为: 'decisions',
  动作: 'decisions',
  情绪: 'decisions',
  变化: 'decisions',
  转折: 'decisions',
  故事: 'decisions',
  叙事: 'decisions',
  主题: 'decisions',
  导演判断: 'decisions',
  判断理由: 'decisions',
  导演意图: 'constraints',
  约束: 'constraints',
  规则: 'constraints',
  未解决问题: 'todos',
  待解决问题: 'todos',
  待办: 'todos',
}))

// Whole fragments are rejected instead of partly redacted. This keeps the
// persisted checkpoint from retaining labels, values, or references that can
// be reconstructed from the remaining text.
const FORBIDDEN_TEXT = /(?:credential|secret|token|password|passwd|authorization|cookie|api[\s_-]*key|private[\s_-]*key|connection[\s_-]*string|keychain|secret[\s_-]*store|access[\s_-]*key|refresh[\s_-]*token|client[\s_-]*secret|凭据|密钥|令牌|鉴权|授权头)/iu
const FORBIDDEN_FIELD = /(?:private|metadata|credential|secret|token|password|passwd|authorization|cookie|api[\s_.:-]*key|private[\s_.:-]*key|connection[\s_.:-]*string|keychain|secret[\s_.:-]*store|access[\s_.:-]*key|refresh[\s_.:-]*token|client[\s_.:-]*secret|internal|identifier|私密|敏感|凭据|密钥|密码|令牌|鉴权|内部标识)/iu
const SECRET_VALUE = /(?:\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\bsk-[A-Za-z0-9_-]{12,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bAKIA[0-9A-Z]{16}\b|-----BEGIN\s+(?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----|(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis):\/\/\S+|\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_+/=-]{8,}|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d))/iu
const OPAQUE_IDENTIFIER = /(?:\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b|\b[0-9a-f]{40,}\b|\b(?:task|run|record|table|work|source|candidate|checkpoint)[-_][A-Za-z0-9_-]{6,}\b|\b(?:task|run|record|table|work|source|candidate|checkpoint|session)[A-Z][A-Za-z0-9]{5,}\b|\b(?=[A-Za-z0-9]*\d{4,}\b)[a-z]+(?:[A-Z][A-Za-z0-9]*){2,}\b|\b(?:rec|tbl)[A-Za-z0-9_-]{8,}\b|\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+){3,}\b|\b(?:id|uuid|hash)\s*[:=]\s*\S+)/iu
const LOCATION_REFERENCE = /(?:https?:\/\/\S+|(?:^|\s)\/(?:Users|private|tmp|var|opt|etc|home|Volumes)\/\S+|(?:^|\s)~\/\S+|\b[A-Za-z0-9_.-]+\.(?:json|jsonl|sqlite|db|pem|key|env|log)\b)/iu
const NON_NARRATIVE_RUNTIME_TEXT = /(?:智能体无法生成响应|上下文内容过多|自动压缩(?:功能)?无法恢复|auto[- ]?compaction|compaction (?:failed|error)|agent (?:failed|error)|tool (?:call|result)|(?:代理|模型|服务商)\s*[：:])/iu
const NARRATIVE_SEMANTIC_TEXT = /(?:导演|素材|镜头|画面|人物|角色|故事|冲突|行为|动作|情绪|变化|转折|叙事|主题|判断|技法|意图|节奏|悬念|因果|审核|证据|疑问|问题|director|material|shot|scene|person|character|story|conflict|action|emotion|change|turning point|narrative|theme|judg(?:e)?ment|technique|intent|rhythm|evidence|review)/iu
const SOURCE_HEADINGS = new Set(REQUIRED_HEADINGS)

function normalizeFieldName(value) {
  return String(value).normalize('NFKC').replace(/[\s_.:-]+/gu, '').toLocaleLowerCase('en-US')
}

function normalizeFragment(value) {
  return String(value)
    .normalize('NFKC')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

function truncateUnicodeSafe(value, maxChars) {
  if (value.length <= maxChars) return value
  let end = maxChars
  const last = value.charCodeAt(end - 1)
  if (last >= 0xD800 && last <= 0xDBFF) end -= 1
  return value.slice(0, end)
}

function createTraversalBudget(signal) {
  return {
    signal,
    nodes: 0,
    inputBytes: 0,
    deadline: Date.now() + MAX_BUILD_MILLISECONDS,
  }
}

function chargeTraversalBudget(budget, value = null) {
  budget.signal?.throwIfAborted?.()
  budget.nodes += 1
  if (typeof value === 'string') budget.inputBytes += Buffer.byteLength(value, 'utf8')
  if (budget.nodes > MAX_TRAVERSED_NODES) {
    throw new Error('director context traversal node budget exceeded')
  }
  if (budget.inputBytes > MAX_CUMULATIVE_INPUT_BYTES) {
    throw new Error('director context traversal input budget exceeded')
  }
  if (Date.now() > budget.deadline) {
    throw new Error('director context traversal time budget exceeded')
  }
}

function isSafeFragment(value) {
  const text = normalizeFragment(value)
  return text.length > 0
    && !SOURCE_HEADINGS.has(text)
    && !FORBIDDEN_TEXT.test(text)
    && !containsSensitiveNarrativeValue(text)
    && !SECRET_VALUE.test(text)
    && !OPAQUE_IDENTIFIER.test(text)
    && !LOCATION_REFERENCE.test(text)
    && !NON_NARRATIVE_RUNTIME_TEXT.test(text)
}

function safeFragments(value, budget) {
  chargeTraversalBudget(budget, typeof value === 'string' ? value : String(value))
  const normalized = normalizeFragment(value)
  if (!normalized || containsSensitiveNarrativeValue(normalized)) return []
  return normalized
    .split(/(?<=[。！？!?;；])|\n+/gu)
    .filter(isSafeFragment)
    .map(fragment => truncateUnicodeSafe(normalizeFragment(fragment), MAX_FACT_CHARS))
    .filter(isSafeFragment)
}

function addUnique(target, value, budget) {
  for (const fragment of safeFragments(value, budget)) {
    chargeTraversalBudget(budget)
    if (target.includes(fragment)) continue
    if (target.length >= MAX_FACTS_PER_SECTION) return
    target.push(fragment)
  }
}

function scalarText(value) {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}

function collectAllowlistedFields(value, sections, budget, depth = 0, seen = new WeakSet()) {
  chargeTraversalBudget(budget)
  if (depth > MAX_DEPTH || value === null || value === undefined) return
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 128)) {
      chargeTraversalBudget(budget)
      collectAllowlistedFields(item, sections, budget, depth + 1, seen)
    }
    return
  }
  if (typeof value !== 'object') return
  if (seen.has(value)) return
  seen.add(value)

  for (const [rawKey, child] of Object.entries(value).slice(0, 256)) {
    chargeTraversalBudget(budget, rawKey)
    if (FORBIDDEN_FIELD.test(rawKey)) continue
    const group = SAFE_FIELD_GROUPS.get(normalizeFieldName(rawKey))
    if (group) {
      const direct = scalarText(child)
      if (direct !== null) addUnique(sections[group], direct, budget)
      else if (Array.isArray(child)) {
        for (const item of child.slice(0, 128)) {
          chargeTraversalBudget(budget)
          const scalar = scalarText(item)
          if (scalar !== null) addUnique(sections[group], scalar, budget)
        }
      }
    }
    collectAllowlistedFields(child, sections, budget, depth + 1, seen)
  }
}

function messageRole(message) {
  return typeof message?.role === 'string' ? message.role : ''
}

function contentTexts(value, budget, output = [], depth = 0, seen = new WeakSet()) {
  chargeTraversalBudget(budget)
  if (depth > MAX_DEPTH || value === null || value === undefined) return output
  if (typeof value === 'string') {
    chargeTraversalBudget(budget, value)
    output.push(value)
    return output
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 128)) {
      contentTexts(item, budget, output, depth + 1, seen)
    }
    return output
  }
  if (typeof value !== 'object' || seen.has(value)) return output
  seen.add(value)
  if (typeof value.text === 'string') {
    chargeTraversalBudget(budget, value.text)
    output.push(value.text)
  }
  return output
}

function parseJsonObject(text, budget) {
  chargeTraversalBudget(budget)
  if (typeof text !== 'string' || text.length > 2_000_000) return null
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
}

function collectPreviousSummary(previousSummary, sections, budget) {
  chargeTraversalBudget(budget, typeof previousSummary === 'string' ? previousSummary : null)
  if (typeof previousSummary !== 'string') return
  let group = 'decisions'
  for (const rawLine of previousSummary.split(/\r?\n/u).slice(0, 512)) {
    chargeTraversalBudget(budget)
    const line = normalizeFragment(rawLine.replace(/^[-*]\s*/u, ''))
    if (line === '## Decisions') group = 'decisions'
    else if (line === '## Open TODOs') group = 'todos'
    else if (line === '## Constraints/Rules') group = 'constraints'
    else if (line === '## Pending user asks') group = 'pending'
    else if (line === '## Exact identifiers') group = 'identifiers'
    else if (group !== 'identifiers' && !/^(?:None\.?|No prior history\.?)$/iu.test(line)) {
      addUnique(sections[group], line, budget)
    }
  }
}

function collectMessages(messages, sections, budget) {
  let latestUserText = []
  const boundedMessages = Array.isArray(messages) ? messages.slice(-MAX_MESSAGES).reverse() : []
  for (const message of boundedMessages) {
    chargeTraversalBudget(budget)
    const role = messageRole(message)
    const texts = contentTexts(message?.content, budget)
    if (role === 'toolResult') {
      for (const text of texts) {
        const structured = parseJsonObject(text, budget)
        if (structured !== null) collectAllowlistedFields(structured, sections, budget)
      }
      collectAllowlistedFields(message?.details, sections, budget)
      continue
    }
    if (role !== 'user' && role !== 'assistant') continue
    const safe = texts.flatMap(text => safeFragments(text, budget))
      .filter(text => NARRATIVE_SEMANTIC_TEXT.test(text))
    if (role === 'user' && latestUserText.length === 0 && safe.length > 0) latestUserText = safe
    if (role === 'assistant') safe.forEach(text => addUnique(sections.decisions, text, budget))
  }
  latestUserText.forEach(text => addUnique(sections.pending, text, budget))
}

function renderSection(heading, values, emptyText, maxChars) {
  const retained = []
  let usedChars = 0
  for (const value of values) {
    const line = `- ${value}`
    const nextChars = usedChars + (retained.length > 0 ? 1 : 0) + line.length
    if (nextChars > maxChars) continue
    retained.push(line)
    usedChars = nextChars
  }
  const body = retained.length > 0 ? retained.join('\n') : emptyText
  return `${heading}\n${body}`
}

function renderSummary(sections) {
  const summary = [
    renderSection(
      '## Decisions',
      sections.decisions,
      '暂无可安全复用的导演语义。',
      SECTION_CHAR_BUDGETS.decisions,
    ),
    renderSection(
      '## Open TODOs',
      sections.todos,
      '暂无已确认的未解决问题。',
      SECTION_CHAR_BUDGETS.todos,
    ),
    renderSection(
      '## Constraints/Rules',
      sections.constraints,
      '只保留人物、冲突、变化、导演判断与未解决问题；其他材料已省略。',
      SECTION_CHAR_BUDGETS.constraints,
    ),
    renderSection(
      '## Pending user asks',
      sections.pending,
      '暂无可安全保留的待处理请求。',
      SECTION_CHAR_BUDGETS.pending,
    ),
    renderSection('## Exact identifiers', [], 'None.', SECTION_CHAR_BUDGETS.identifiers),
  ].join('\n\n')
  if (summary.length > MAX_SUMMARY_CHARS) {
    throw new Error('director context summary exceeded the fixed section budgets')
  }
  return summary
}

function emptySections() {
  return {
    decisions: [],
    todos: [],
    constraints: [],
    pending: [],
    identifiers: [],
  }
}

export function buildDirectorContextSummary({ messages, previousSummary, signal } = {}) {
  signal?.throwIfAborted?.()
  try {
    const budget = createTraversalBudget(signal)
    const sections = emptySections()
    collectMessages(messages, sections, budget)
    collectPreviousSummary(previousSummary, sections, budget)
    signal?.throwIfAborted?.()
    return renderSummary(sections)
  } catch {
    signal?.throwIfAborted?.()
    return renderSummary(emptySections())
  }
}
