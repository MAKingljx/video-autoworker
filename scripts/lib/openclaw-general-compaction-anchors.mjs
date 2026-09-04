export const GENERAL_COMPACTION_ANCHORS = Object.freeze([
  Object.freeze({
    id: 'director-principle',
    user: '导演脑提炼技法的底层逻辑是什么？',
    assistant: '导演原理：从已审核证据出发，追问为什么这样判断，沿人物与故事、判断与叙事、案例与技法沉淀，并受导演意图和人工审核约束。',
    prompt: '导演脑提炼技法的底层逻辑是什么？只依据此前记录简短回答。',
    patterns: Object.freeze([/证据/u, /人物/u, /故事/u, /判断/u, /叙事/u, /案例/u, /技法/u]),
  }),
  Object.freeze({
    id: 'ordinary-programming',
    user: '普通编程事项的根因和修复方案是什么？',
    assistant: '编程事项：根因是缓存键冲突，修复方案是加入租户前缀，并保留回归测试。',
    prompt: '此前记录的普通编程事项，根因、修复和验证分别是什么？',
    patterns: Object.freeze([/缓存键冲突/u, /租户前缀/u, /回归测试/u]),
  }),
  Object.freeze({
    id: 'operations-plan',
    user: '运维计划的时间、顺序和失败处理是什么？',
    assistant: '运维计划：周六零点维护，先备份，再灰度，失败时回滚。',
    prompt: '此前记录的运维计划，时间、执行顺序和失败处理是什么？',
    patterns: Object.freeze([/周六零点/u, /备份/u, /灰度/u, /回滚/u]),
  }),
  Object.freeze({
    id: 'ordinary-question',
    user: '蓝鲸属于哪类动物，怎样呼吸？',
    assistant: '普通问答：蓝鲸是哺乳动物，用肺呼吸。',
    prompt: '此前关于蓝鲸的普通问答结论是什么？',
    patterns: Object.freeze([/蓝鲸/u, /哺乳动物/u, /肺呼吸/u]),
  }),
  Object.freeze({
    id: 'long-form-summary',
    user: '长文中河流治理的三段主线是什么？',
    assistant: '长文总结：河流治理主线是上游减排、中游监测、下游修复。',
    prompt: '此前河流治理长文的三段主线是什么？',
    patterns: Object.freeze([/上游减排/u, /中游监测/u, /下游修复/u]),
  }),
  Object.freeze({
    id: 'task-continuity',
    user: '这个任务下一步按什么顺序继续？',
    assistant: '任务连续性：下一步先完成接口契约测试，再更新变更记录。',
    prompt: '此前任务连续性记录的下一步顺序是什么？',
    patterns: Object.freeze([/接口契约测试/u, /变更记录/u]),
  }),
])

export const GENERAL_COMPACTION_OMNIBUS_PROMPT = [
  '只用一段中文复述此前记录中的六项既定信息，不要调用工具，不要增加建议。',
  '依次覆盖导演原理、普通编程事项、运维计划、蓝鲸问答、河流治理长文和任务下一步；',
  '当前问题没有给出各项答案，必须只依据此前记录作答。',
].join('')

export const GENERAL_COMPACTION_TURN_PROMPTS = Object.freeze([
  GENERAL_COMPACTION_OMNIBUS_PROMPT,
  GENERAL_COMPACTION_OMNIBUS_PROMPT,
  ...GENERAL_COMPACTION_ANCHORS.map(anchor => anchor.prompt),
])

export function generalCompactionSeedMessages() {
  return GENERAL_COMPACTION_ANCHORS.flatMap(anchor => ([
    { role: 'user', content: [{ type: 'text', text: anchor.user }] },
    { role: 'assistant', content: [{ type: 'text', text: anchor.assistant }] },
  ]))
}

export function missingGeneralCompactionAnchors(text, turnIndex) {
  const targets = turnIndex < 2
    ? GENERAL_COMPACTION_ANCHORS
    : [GENERAL_COMPACTION_ANCHORS[(turnIndex - 2) % GENERAL_COMPACTION_ANCHORS.length]]
  if (typeof text !== 'string') return targets.map(anchor => anchor.id)
  return targets.filter(anchor => anchor.patterns.some(pattern => !pattern.test(text)))
    .map(anchor => anchor.id)
}

export function validatesGeneralCompactionAnswer(text, turnIndex) {
  if (typeof text !== 'string' || text.trim().length === 0) return false
  const maximumCharacters = turnIndex < 2 ? 600 : 180
  const maximumSentences = turnIndex < 2 ? 8 : 2
  const sentenceCount = text.split(/[。！？!?]+/u).filter(Boolean).length
  return Array.from(text).length <= maximumCharacters
    && sentenceCount <= maximumSentences
    && missingGeneralCompactionAnchors(text, turnIndex).length === 0
}
