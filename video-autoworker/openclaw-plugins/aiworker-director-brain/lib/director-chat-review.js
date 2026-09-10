import { randomBytes } from 'node:crypto'

const REVIEW_TTL_MS = 10 * 60 * 1000
const MAX_REVIEW_TARGETS = 50
const MAX_PENDING_SESSIONS = 256
const MAX_PREVIEW_BYTES = 8 * 1024
const REVIEW_HANDLER_BUDGET_MS = 9 * 60 * 1000
const REVIEW_TRANSITION_RESERVE_MS = 4 * 60 * 1000
const REVIEW_READ_RESERVE_MS = 90 * 1000
const UNSAFE_PREVIEW_TEXT = /(?:\b(?:WORK|TASK|REC|RUN|EVIDENCE|INTENT|PERSON|NODE|JUDGMENT|NARRATIVE|CASE|SKILL)-[A-Z0-9][A-Z0-9_-]*\b|\b(?:rec|tbl)[A-Za-z0-9]{8,24}\b|\b[0-9a-f]{8}-[0-9a-f-]{27,}\b|\/Users\/|\/home\/|\b(?:token|secret|password|api.?key)\s*[:=])/iu

const TABLE_CONTRACTS = Object.freeze({
  works: { label: '作品', primary: '作品名称', scoped: false, approve: { 草稿: ['生效'] } },
  director_intents: {
    label: '导演意图', primary: '意图名称', scoped: true,
    approve: { 草稿: ['待审核', '生效'], 待审核: ['生效'] },
    reject: { 草稿: ['废弃'], 待审核: ['废弃'] },
  },
  material_evidence: {
    label: '素材证据', primary: '证据名称', scoped: true,
    approve: { 候选: ['已核验'] }, reject: { 候选: ['失效'] },
  },
  people_profiles: {
    label: '人物档案', primary: '人物名称', scoped: true,
    approve: { 候选: ['待审核', '已确认'], 待审核: ['已确认'] },
    reject: { 候选: ['失效'], 待审核: ['失效'] },
  },
  story_nodes: {
    label: '故事节点', primary: '节点名称', scoped: true,
    approve: { 候选: ['待审核', '已确认'], 待审核: ['已确认'] },
    reject: { 候选: ['失效'], 待审核: ['失效'] },
  },
  story_relations: {
    label: '故事关系', primary: '关系名称', scoped: true,
    approve: { 候选: ['待审核', '已确认'], 待审核: ['已确认'] },
    reject: { 候选: ['失效'], 待审核: ['失效'] },
  },
  material_judgments: {
    label: '素材判断', primary: '判断名称', scoped: true,
    approve: { 候选: ['待审核', '已确认'], 待审核: ['已确认'] },
    reject: { 候选: ['失效'], 待审核: ['失效'] },
  },
  narrative_plans: {
    label: '叙事方案', primary: '方案名称', scoped: true,
    approve: { 草稿: ['待审核', '已批准'], 待审核: ['已批准'] },
    reject: { 草稿: ['废弃'], 待审核: ['废弃'] },
  },
  director_cases: {
    label: '导演案例', primary: '案例名称', scoped: true,
    approve: { 待复核: ['已确认'], 有争议: ['已确认'] },
    reject: { 待复核: ['失效'], 有争议: ['失效'] },
  },
  skills_techniques: {
    label: '导演技法', primary: '知识名称', scoped: false,
    approve: { 候选: ['待审核', '已验证'], 待审核: ['已验证'] },
    reject: { 候选: ['废弃'], 待审核: ['废弃'] },
  },
})

function safeText(value, maximum = 256) {
  if (typeof value !== 'string') return null
  const text = value.normalize('NFKC').trim().replace(/[\t ]+/gu, ' ')
  return text && text.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(text) ? text : null
}

function sessionIdentity(context) {
  const session = safeText(context?.sessionId, 160) || safeText(context?.sessionKey, 240)
  const agent = safeText(context?.agentId, 128)
  const sender = safeText(context?.senderId, 160)
    || safeText(context?.requesterSenderId, 160)
    || ''
  return session && agent ? `${agent}\u0000${session}\u0000${sender}` : null
}

export function createDirectorReviewSessionStore({
  now = () => Date.now(),
  createCode = () => randomBytes(3).toString('hex').toUpperCase(),
} = {}) {
  const pending = new Map()
  const prune = () => {
    const current = now()
    for (const [key, value] of pending) {
      if (value.expiresAt <= current) pending.delete(key)
    }
    while (pending.size >= MAX_PENDING_SESSIONS) pending.delete(pending.keys().next().value)
  }
  const read = context => {
    const key = sessionIdentity(context)
    if (!key) return null
    const value = pending.get(key)
    if (!value) return null
    if (value.expiresAt <= now()) {
      pending.delete(key)
      return null
    }
    return value
  }
  return {
    rememberProposal(context, targets) {
      const key = sessionIdentity(context)
      if (!key || !Array.isArray(targets) || targets.length !== 1) return false
      prune()
      pending.set(key, { kind: 'proposal', targets: structuredClone(targets), expiresAt: now() + REVIEW_TTL_MS })
      return true
    },
    prepare(context, decision, targets) {
      const key = sessionIdentity(context)
      if (!key || !['approve', 'reject'].includes(decision)
        || !Array.isArray(targets) || targets.length < 1 || targets.length > MAX_REVIEW_TARGETS) return false
      prune()
      const code = safeText(createCode(), 12)
      if (!code || !/^[A-Z0-9]{6,12}$/u.test(code)) return false
      const receipt = {
        kind: 'review', decision, code, targets: structuredClone(targets), expiresAt: now() + REVIEW_TTL_MS,
      }
      pending.set(key, receipt)
      return receipt
    },
    get: read,
    consume(context) {
      const key = sessionIdentity(context)
      const value = read(context)
      if (key && value) pending.delete(key)
      return value
    },
    clear(context) {
      const key = sessionIdentity(context)
      if (key) pending.delete(key)
    },
  }
}

function targetFromRecord(table, record, workName = '') {
  const contract = TABLE_CONTRACTS[table]
  if (!contract) return null
  const rawName = safeText(record?.fields?.[contract.primary], 240)
  const version = safeText(record?.fields?.['版本'], 32)
  const stableId = safeText(record?.stableId, 160)
  const state = safeText(record?.state, 32)
  const workId = safeText(record?.fields?.['作品 ID'], 160)
  const name = rawName && workId && rawName.startsWith(workId)
    ? safeText(rawName.slice(workId.length).replace(/^[\s:：\-—]+/u, ''), 240) || rawName
    : rawName
  const start = safeText(record?.fields?.['起始时间码'], 32) || ''
  const end = safeText(record?.fields?.['结束时间码'], 32) || ''
  const summaryFields = [
    '证据摘要', '节点内容', '判断理由', '使用理由', '结构说明', '核心主题',
    '身份', '适用条件', '为什么有效', '作品类型',
  ]
  const summary = summaryFields
    .map(field => safeText(record?.fields?.[field], 500))
    .find(Boolean) || ''
  return name && version && stableId && state
    ? {
        table, stableId, workId: contract.scoped ? workId : null, workName,
        name, state, version, start, end, summary,
      }
    : null
}

function targetLabel(target) {
  const contract = TABLE_CONTRACTS[target.table]
  const displayTimecode = value => {
    const match = /^(\d{2}:\d{2}:\d{2})(?:\.\d{1,3})?$/u.exec(value)
    return match ? match[1] : value
  }
  const timecode = target.start && target.end
    ? ` ${displayTimecode(target.start)}-${displayTimecode(target.end)}`
    : ''
  const summary = target.summary
    ? `；摘要：${Array.from(target.summary).slice(0, 32).join('')}`
    : ''
  return `${contract.label}“${target.name}”(${target.state})${timecode}${summary}`
}

function workScope(targets) {
  const names = [...new Set(targets.map(target => target.workName).filter(Boolean))]
  return names.length === 1 ? `《${Array.from(names[0]).slice(0, 16).join('')}》` : ''
}

function previewAnswer(decision, targets, code) {
  const verb = decision === 'approve' ? '批准' : '驳回'
  const summaries = targets.map((target, index) => `${index + 1}. ${targetLabel(target)}`).join('\n')
  const answer = `待${verb}${workScope(targets)}共${targets.length}条：\n${summaries}\n请回复“确认${verb}批次 ${code} 共${targets.length}条”；撤回请回复“取消审核批次 ${code}”。其他回复不会更改状态。`
  return Buffer.byteLength(answer, 'utf8') <= MAX_PREVIEW_BYTES
    && !UNSAFE_PREVIEW_TEXT.test(answer)
    ? answer
    : null
}

function noMatchAnswer(decision) {
  return decision === 'approve'
    ? '没有找到可批准的匹配候选。请补充准确的作品名、记录类型和候选名称。'
    : '没有找到可驳回的匹配候选。请补充准确的作品名、记录类型和候选名称。'
}

export async function prepareDirectorBrainReview({ request, executeOperation, store, context }) {
  const contract = TABLE_CONTRACTS[request.table]
  if (!contract || !['approve', 'reject'].includes(request.decision)) {
    return { outcome: 'invalid', answer: '审核对象不明确。请补充准确的作品名、记录类型和候选名称。' }
  }
  if (contract.scoped && !safeText(request.workQuery, 256)) {
    return { outcome: 'work_required', answer: '请先说明候选所属的完整作品名。' }
  }
  let workId
  let workName = ''
  if (safeText(request.workQuery, 256)) {
    const resolution = await executeOperation({ action: 'resolve_work', query: request.workQuery })
    if (resolution?.ok !== true || resolution.action !== 'resolve_work'
      || resolution.found !== true || !safeText(resolution?.work?.workId, 160)) {
      return { outcome: 'work_not_found', answer: '无法唯一确认作品，请提供更准确的完整作品名。' }
    }
    workId = resolution.work.workId
    workName = safeText(resolution.work.name, 80) || ''
  }
  const transitionMap = contract[request.decision]
  if (!transitionMap) return { outcome: 'unsupported', answer: '该类记录不支持这项审核决定，本次未更改状态。' }
  const matches = []
  let truncated = false
  for (const state of Object.keys(transitionMap)) {
    const result = await executeOperation({
      action: 'search', table: request.table, query: request.query || state, status: state,
      limit: MAX_REVIEW_TARGETS,
      ...(workId ? { workId } : {}),
    })
    if (result?.ok !== true || result.action !== 'search'
      || result.table !== request.table || result.workId !== (workId || null)
      || result.status !== state || result.limit !== MAX_REVIEW_TARGETS
      || !Array.isArray(result.matches)) {
      throw new Error('director_brain_review_preview_invalid')
    }
    for (const record of result.matches) {
      if (record?.table !== request.table || record.state !== state
        || (contract.scoped && record?.fields?.['作品 ID'] !== workId)) {
        throw new Error('director_brain_review_preview_invalid')
      }
      matches.push(record)
    }
    truncated = truncated || result.truncated === true
  }
  const unique = [...new Map(matches.map(record => [record.stableId, record])).values()]
  const targets = unique.map(record => targetFromRecord(request.table, record, workName)).filter(Boolean)
  if (targets.length === 0) return { outcome: 'not_found', answer: noMatchAnswer(request.decision) }
  if (targets.length > 1 && request.batch !== true) {
    const summaries = targets.slice(0, 5).map(targetLabel).join('、')
    return { outcome: 'ambiguous', answer: `匹配到${targets.length}条，仅列前5条：${workScope(targets)}${summaries}。请用完整候选名称指定一条，或明确说“这批”。` }
  }
  if (truncated || targets.length > MAX_REVIEW_TARGETS) {
    return { outcome: 'too_many', answer: '匹配候选超过50条，本次未建立批量审核。请缩小名称范围后重试。' }
  }
  const receipt = store?.prepare(context, request.decision, targets)
  if (!receipt) {
    return { outcome: 'session_unavailable', answer: '当前会话无法安全绑定审核对象，本次未更改状态。' }
  }
  const answer = previewAnswer(request.decision, targets, receipt.code)
  if (!answer) {
    store.clear(context)
    return { outcome: 'preview_too_large', answer: '候选清单超过安全显示上限，本次未建立审核批次。请缩小候选范围。' }
  }
  return { outcome: 'preview', answer }
}

export function rememberProposedDirectorBrainRecord({ result, store, context }) {
  if (result?.ok !== true || result.action !== 'propose' || !result.record) return false
  const target = targetFromRecord(result.table, result.record)
  return target ? store?.rememberProposal(context, [target]) === true : false
}

function parseConfirmation(value) {
  const text = safeText(value, 120)
  if (!text) return null
  const match = /^确认(批准|驳回)批次 ([A-Z0-9]{6,12}) 共([1-9]|[1-4][0-9]|50)条[。.!！]?$/u.exec(text)
  return match ? {
    decision: match[1] === '批准' ? 'approve' : 'reject', code: match[2], count: Number(match[3]),
  } : null
}

function parseCancellation(value) {
  const text = safeText(value, 80)
  const match = text && /^取消审核批次 ([A-Z0-9]{6,12})[。.!！]?$/u.exec(text)
  return match ? { code: match[1] } : null
}

function parseBareDecision(value) {
  const text = safeText(value, 80)
  if (!text) return null
  const match = /^(?:请|请帮我|帮我)?\s*(批准|审核通过|驳回|拒绝)(?:这条|它|这个候选|刚才的候选)?[。.!！]?$/u.exec(text)
  if (!match) return null
  return /批准|通过/u.test(match[1]) ? 'approve' : 'reject'
}

function nextVersion(value) {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/u.exec(String(value || ''))
  if (!match) return null
  const patch = Number(match[3]) + 1
  return Number.isSafeInteger(patch) ? `v${match[1]}.${match[2]}.${patch}` : null
}

function exactCurrentRecord(current, target, state, version) {
  return current?.ok === true && current.action === 'get' && current.table === target.table
    && current.stableId === target.stableId && current.found === true
    && current.workId === (target.workId || null)
    && current.record?.table === target.table && current.record?.stableId === target.stableId
    && current.record?.state === state && current.record?.fields?.['版本'] === version
    && (!target.workId || current.record?.fields?.['作品 ID'] === target.workId)
}

async function preflightTargets(targets, executeOperation, deadline) {
  for (const target of targets) {
    if (Date.now() + REVIEW_READ_RESERVE_MS > deadline) return 'budget'
    const current = await executeOperation({
      action: 'get', table: target.table, stableId: target.stableId,
      ...(target.workId ? { workId: target.workId } : {}),
    })
    if (!exactCurrentRecord(current, target, target.state, target.version)) return 'stale'
  }
  return 'ready'
}

async function applyTargets(receipt, { executeOperation, reviewRecord }, deadline) {
  const preflight = await preflightTargets(receipt.targets, executeOperation, deadline)
  if (preflight !== 'ready') {
    return { outcome: preflight, completed: 0, remaining: receipt.targets.length }
  }
  let completed = 0
  for (const target of receipt.targets) {
    let expectedVersion = target.version
    const transitions = TABLE_CONTRACTS[target.table]?.[receipt.decision]?.[target.state]
    if (!Array.isArray(transitions) || transitions.length === 0) {
      return {
        outcome: 'failed', completed, remaining: receipt.targets.length - completed,
        currentMayHaveChanged: false,
      }
    }
    let completedTransitions = 0
    for (const targetStatus of transitions) {
      if (Date.now() + REVIEW_TRANSITION_RESERVE_MS > deadline) {
        return {
          outcome: 'budget', completed, remaining: receipt.targets.length - completed,
          currentMayHaveChanged: completedTransitions > 0,
        }
      }
      const previousVersion = expectedVersion
      const expectedNextVersion = nextVersion(previousVersion)
      if (!expectedNextVersion) {
        return {
          outcome: 'failed', completed, remaining: receipt.targets.length - completed,
          currentMayHaveChanged: false,
        }
      }
      try {
        const result = await reviewRecord({
          table: target.table, stableId: target.stableId,
          ...(target.workId ? { workId: target.workId } : {}),
          expectedVersion, targetStatus,
          reviewer: 'OpenClaw 聊天用户',
          reason: `用户在当前聊天中明确确认${receipt.decision === 'approve' ? '批准' : '驳回'}批次 ${receipt.code}`,
        })
        expectedVersion = safeText(result?.version, 32)
        const expectedReviewed = receipt.decision === 'approve'
          && targetStatus === transitions.at(-1)
        if (result?.ok !== true || result.action !== 'review'
          || result.table !== target.table || result.stableId !== target.stableId
          || result.previousStatus !== (completedTransitions === 0 ? target.state : transitions[completedTransitions - 1])
          || result.targetStatus !== targetStatus || result.previousVersion !== previousVersion
          || expectedVersion !== expectedNextVersion || result.record?.table !== target.table
          || result.record?.stableId !== target.stableId || result.record?.state !== targetStatus
          || result.record?.fields?.['版本'] !== expectedVersion
          || (target.workId && (result.workId !== target.workId
            || result.record?.fields?.['作品 ID'] !== target.workId))
          || result.record?.reviewed !== expectedReviewed) {
          throw new Error('director_brain_review_result_invalid')
        }
        completedTransitions += 1
      } catch {
        let recovered = null
        try {
          recovered = await executeOperation({
            action: 'get', table: target.table, stableId: target.stableId,
            ...(target.workId ? { workId: target.workId } : {}),
          })
        } catch {
          // The outcome of the attempted transition is unknown until a later query.
        }
        const recoveredReviewStateValid = recovered?.record?.reviewed
          === (receipt.decision === 'approve' && targetStatus === transitions.at(-1))
        if (exactCurrentRecord(recovered, target, targetStatus, expectedNextVersion)
          && recoveredReviewStateValid) {
          expectedVersion = expectedNextVersion
          completedTransitions += 1
          continue
        }
        return {
          outcome: 'failed', completed, remaining: receipt.targets.length - completed,
          currentMayHaveChanged: completedTransitions > 0
            || !exactCurrentRecord(recovered, target, target.state, target.version),
        }
      }
    }
    completed += 1
  }
  return { outcome: 'completed', completed, remaining: 0 }
}

export function createDirectorBrainChatReviewHandler({
  releaseReady = true, targetAgentId, store, loadServices, onDiagnostic,
} = {}) {
  return async (event, context) => {
    const handlerDeadline = Date.now() + REVIEW_HANDLER_BUDGET_MS
    if (context?.agentId !== targetAgentId || context?.trigger !== 'user') return undefined
    const confirmation = parseConfirmation(event?.cleanedBody)
    const cancellation = parseCancellation(event?.cleanedBody)
    const bareDecision = parseBareDecision(event?.cleanedBody)
    if (!confirmation && !cancellation && !bareDecision) return undefined
    if (!releaseReady) return { handled: true, reply: { text: '导演脑正在维护，请稍后再试。' }, reason: 'director_brain_maintenance' }
    const pending = store?.get(context)
    if (cancellation) {
      if (pending?.kind !== 'review' || pending.code !== cancellation.code) {
        return { handled: true, reply: { text: '没有匹配的待取消审核预览，本次未更改状态。' }, reason: 'director_brain_review_cancel_mismatch' }
      }
      store.consume(context)
      return { handled: true, reply: { text: `已取消审核批次 ${cancellation.code}，没有更改任何导演脑记录。` }, reason: 'director_brain_review_cancelled' }
    }
    if (bareDecision) {
      if (pending?.kind !== 'proposal') return undefined
      const targets = pending.targets.filter(target => TABLE_CONTRACTS[target.table]?.[bareDecision]?.[target.state])
      const receipt = targets.length === 1 ? store.prepare(context, bareDecision, targets) : null
      if (!receipt) {
        store.clear(context)
        return { handled: true, reply: { text: '这条候选当前不支持该审核决定，本次未更改状态。' }, reason: 'director_brain_review_unsupported' }
      }
      const answer = previewAnswer(bareDecision, targets, receipt.code)
      if (!answer) {
        store.clear(context)
        return { handled: true, reply: { text: '候选清单超过安全显示上限，本次未建立审核批次。' }, reason: 'director_brain_review_preview_too_large' }
      }
      return { handled: true, reply: { text: answer }, reason: 'director_brain_review_preview' }
    }
    const pendingReview = store?.get(context)
    if (pendingReview?.kind !== 'review' || pendingReview.decision !== confirmation.decision
      || pendingReview.code !== confirmation.code
      || pendingReview.targets.length !== confirmation.count) {
      return { handled: true, reply: { text: '没有匹配的待确认审核预览，本次未更改状态。请先重新发起审核。' }, reason: 'director_brain_review_confirmation_mismatch' }
    }
    const receipt = store.consume(context)
    try {
      const services = await loadServices()
      const result = await applyTargets(
        receipt,
        services,
        handlerDeadline,
      )
      if (result.outcome === 'completed') {
        const verb = receipt.decision === 'approve' ? '批准' : '驳回'
        return {
          handled: true,
          reply: { text: `已${verb}${result.completed}条导演脑候选，正式回读均已确认。` },
          reason: 'director_brain_review_applied',
        }
      }
      if (result.outcome === 'stale') {
        return { handled: true, reply: { text: `批次 ${receipt.code} 的对象或版本已变化；已完成0条，${result.remaining}条未处理。请重新预览。` }, reason: 'director_brain_review_stale' }
      }
      if (result.outcome === 'budget') {
        const intermediate = result.currentMayHaveChanged
          ? `，当前第${result.completed + 1}条停在合法中间状态`
          : ''
        return { handled: true, reply: { text: `审核时间预算已到；已完成${result.completed}条${intermediate}，${result.remaining}条未完成。请先查询当前状态再继续剩余记录。` }, reason: 'director_brain_review_budget_exhausted' }
      }
      const uncertain = result.currentMayHaveChanged
        ? `，当前第${result.completed + 1}条可能已进入中间状态`
        : ''
      return { handled: true, reply: { text: `审核在完成${result.completed}条后停止${uncertain}；其余${result.remaining}条未处理。请先查询当前状态，避免重复审核。` }, reason: 'director_brain_review_partial' }
    } catch (error) {
      try { onDiagnostic?.({ schema: 'aiworker-director-diagnostic/v1', action: 'review', code: 'review_failed' }) } catch {}
      return { handled: true, reply: { text: '审核未完成，候选可能已变化。请重新查询后再确认。' }, reason: 'director_brain_review_failed' }
    }
  }
}

export { MAX_REVIEW_TARGETS, TABLE_CONTRACTS }
