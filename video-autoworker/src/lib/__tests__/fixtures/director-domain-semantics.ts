import type { DirectorExtractionCandidate } from '@/lib/director-extraction-state'

// Anonymized domain counterexamples based on the 4-person/3-story quality audit.
// These are synthetic test facts, not a new judgment about the original video.
export function directorDomainCounterexamples(): DirectorExtractionCandidate[] {
  const person = (
    key: string, title: string, summary: string, rationale: string,
    startSeconds: number, endSeconds: number, fields: Record<string, unknown>,
  ): DirectorExtractionCandidate => ({
    candidateKey: key, kind: 'person_profile', title, summary, rationale, confidence: 0.7,
    evidenceRefs: [{ materialId: 'MAT-DOMAIN-AUDIT', startSeconds, endSeconds }],
    sourceCandidateKeys: [],
    fields: { '人物名称': title, '人物 ID': `PERSON-${key}`, '置信度': 0.7, ...fields },
  })
  const story = (
    key: string, title: string, summary: string, rationale: string,
    startSeconds: number, endSeconds: number, fields: Record<string, unknown>,
  ): DirectorExtractionCandidate => ({
    candidateKey: key, kind: 'story_node', title, summary, rationale, confidence: 0.7,
    evidenceRefs: [{ materialId: 'MAT-DOMAIN-AUDIT', startSeconds, endSeconds }],
    sourceCandidateKeys: [],
    fields: { '节点名称': title, '节点类型': '事件', '置信度': 0.7, ...fields },
  })
  return [
    person('presenter', '主持人', '主持人走访当地家庭并表达帮助意愿。',
      '所引片段支持表达意愿,未覆盖交付或后续效果。', 1500, 1620,
      { '身份': '节目主持人', '目标': '表达提供帮助的意愿', '人物弧光': '证据不足,未知' }),
    person('companion', '开场同行者', '开场资料画面出现的同行者。',
      '开场资料画面不能证明本集全程参与或人物变化。', 0, 60,
      { '身份': '开场资料画面的同行者', '人物弧光': '未观察到' }),
    person('interviewee', '受访居民', '受访者描述家庭处境。',
      '没有证据将资料画面中的女性与此次受访者识别为同一人。', 1620, 1680,
      { '身份': '受访居民;与资料画面人物的身份关系未知', '矛盾': '未知' }),
    person('restaurant-owner', '餐馆经营者', '在餐馆与来访者交流的经营者。',
      '身份按片段内自述记录;友好交谈本身不构成人物成长。', 1980, 2100,
      { '身份': '餐馆经营者', '情绪变化': '未观察到明确的前后变化' }),
    story('reported-risk', '居民陈述生活困难', '居民陈述当地生活处境。',
      '保留节目陈述来源,不能从转述推出医学诊断或确定因果。', 1500, 1560,
      { '节点内容': '受访居民在节目中陈述生活困难。', '变化': '后续状态未知' }),
    story('aid-intent', '表达援助意愿', '主持人表达提供援助的意愿。',
      '此窗口没有设备交付、安装或改善结果的证据。', 1560, 1620,
      { '节点内容': '主持人口头表达帮助意愿。', '变化': '由了解处境到表达意愿;实际结果未知' }),
    story('restaurant', '餐馆日常交往', '沉重探访之后出现餐馆交流。',
      '可作为情绪缓冲的叙事假设;不是原导演意图,也不说明前述问题得到解决。', 1980, 2100,
      { '节点内容': '经营者与来访者交谈。', '变化': '生活问题的解决情况未知' }),
  ]
}
