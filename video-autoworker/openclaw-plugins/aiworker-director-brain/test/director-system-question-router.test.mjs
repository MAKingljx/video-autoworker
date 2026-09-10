import { describe, expect, it, vi } from 'vitest'

import {
  DIRECTOR_BRAIN_MAINTENANCE_MESSAGE,
  classifyDirectorBrainSystemQuestion,
  createDirectorBrainSystemQuestionHandler,
} from '../lib/director-system-question-router.js'
import { DIRECTOR_BRAIN_UNAVAILABLE_MESSAGE } from '../lib/director-brain-tool.js'

const positiveCases = [
  ['导演脑是什么架构？', 'architecture'],
  ['请介绍一下导演脑的六层结构。', 'architecture'],
  ['导演大脑由什么组成？', 'architecture'],
  ['导演脑的系统结构是什么？', 'architecture'],
  ['导演脑分几层？', 'architecture'],
  ['导演脑提炼技法的底层逻辑是什么？', 'technique_learning'],
  ['导演脑如何学习导演经验？', 'technique_learning'],
  ['导演脑的案例库怎么形成技法？', 'technique_learning'],
  ['导演脑技法沉淀机制是什么？', 'technique_learning'],
  ['导演大脑怎么积累导演经验？', 'technique_learning'],
  ['导演脑最终目标是什么？', 'final_goal'],
  ['导演脑建成后能做什么？', 'final_goal'],
  ['导演脑的最终形态是什么？', 'final_goal'],
  ['导演脑最后能做什么？', 'final_goal'],
  ['导演脑怎么接入现有项目？', 'integration_boundary'],
  ['导演脑是不是独立项目？', 'integration_boundary'],
  ['导演脑和 OpenClaw 的关系是什么？', 'integration_boundary'],
  ['导演脑的集成边界是什么？', 'integration_boundary'],
  ['导演脑为什么要复用单一任务链？', 'integration_boundary'],
  ['导演脑数据存在哪里？', 'data_boundary'],
  ['导演脑保存哪些数据？', 'data_boundary'],
  ['什么数据不会存到导演脑？', 'data_boundary'],
  ['导演脑的数据边界是什么？', 'data_boundary'],
  ['导演脑目前包括哪些功能？', 'current_scope'],
  ['导演脑现在是否包含剪辑执行？', 'current_scope'],
  ['导演脑当前功能边界是什么？', 'current_scope'],
  ['导演脑现阶段暂不开发什么？', 'current_scope'],
]

const negativeCases = [
  '导演脑现在在线吗？',
  '帮我优化导演脑架构。',
  '导演脑为什么报错？',
  '导演脑目前进度百分比是多少？',
  '请测试一下导演脑的技法提炼。',
  '请把导演脑最终目标记录到飞书。',
  '《导演脑》这部片的故事是什么？',
  '导演脑提炼《冰原纪事》的技法是什么？',
  '导演脑分析第三季第三集的技法是什么？',
  '导演脑对这个素材的判断是什么？',
  '导演脑怎么看 sample.mov 的镜头？',
  '请查询导演脑的 task-123 状态。',
  '“导演脑最终目标是什么”只是示例。',
  '如果有人问导演脑数据存哪，你会怎么回答？',
  '不要回答导演脑是什么架构。',
  '我不是在问导演脑的架构。',
  '导演脑架构和数据边界分别是什么？',
  '导演脑是什么架构？另外查一下视频状态。',
  '先说导演脑最终目标，然后帮我部署。',
  '导演脑是什么？',
  '素材感知层是什么？',
  '导演脑提炼技法',
  '导演脑的版本是什么？',
  '导演脑连不上 OpenClaw 是什么原因？',
  '导演脑是不是要切换任务链？',
  '导演脑的架构是什么\n顺便测试一下',
  '`导演脑的数据边界是什么？`',
  '导演脑架构是什么？导演脑数据存哪？',
  '导演脑架构有哪些问题？',
  '导演脑数据存在哪里有泄露风险？',
  '导演脑的最终目标有哪些不合理？',
  '为什么导演脑的六层架构会提取错误？',
  '导演脑怎么接入现有项目会更安全？',
  '导演脑架构是否合理？',
  '请评估导演脑的技法学习机制。',
  '导演脑和普通知识库相比有什么优缺点？',
  '导演脑的数据边界会有什么影响？',
  '导演脑当前范围如何改进？',
]

describe('director brain deterministic system question classifier', () => {
  it.each(positiveCases)('classifies %s', (question, topic) => {
    expect(classifyDirectorBrainSystemQuestion(question)).toBe(topic)
  })

  it.each(negativeCases)('leaves %s to the normal agent path', (question) => {
    expect(classifyDirectorBrainSystemQuestion(question)).toBeNull()
  })

  it('rejects diagnostic qualifiers across every static topic', () => {
    const staticQuestions = [
      '导演脑是什么架构',
      '导演脑如何学习导演经验',
      '导演脑最终目标是什么',
      '导演脑怎么接入现有项目',
      '导演脑数据存在哪里',
      '导演脑目前包括哪些功能',
    ]
    const qualifiers = ['有哪些问题', '有什么风险', '是否合理', '如何改进', '会造成什么影响']
    for (const question of staticQuestions) {
      for (const qualifier of qualifiers) {
        expect(classifyDirectorBrainSystemQuestion(`${question}，${qualifier}？`)).toBeNull()
      }
    }
  })
})

describe('director brain before_agent_reply handler', () => {
  const targetContext = {
    agentId: 'second-original',
    sessionKey: 'agent:second-original:feishu:dm:opaque',
    trigger: 'user',
  }

  it('reads one reviewed blueprint and returns a synthetic reply before the model', async () => {
    const answer = '原始素材进入判断案例，再由已确认案例提炼技法；重点学习为什么这样判断。'
    const service = vi.fn().mockResolvedValue({
      ok: true,
      action: 'get',
      table: 'system_blueprint',
      found: true,
      record: { reviewed: true, fields: { 内容: answer } },
    })
    const handler = createDirectorBrainSystemQuestionHandler({
      targetAgentId: 'second-original',
      service,
    })

    await expect(handler(
      { cleanedBody: '导演脑提炼技法的底层逻辑是什么？' },
      targetContext,
    )).resolves.toEqual({
      handled: true,
      reply: { text: answer },
      reason: 'director_brain_system_question',
    })
    expect(service).toHaveBeenCalledTimes(1)
    expect(service).toHaveBeenCalledWith({
      action: 'get', table: 'system_blueprint', stableId: 'DB-LOOP-CASE',
    })
  })

  it('does not claim another agent, a heartbeat, or a work-specific turn', async () => {
    const service = vi.fn()
    const handler = createDirectorBrainSystemQuestionHandler({
      targetAgentId: 'second-original',
      service,
    })

    await expect(handler(
      { cleanedBody: '导演脑是什么架构？' },
      { ...targetContext, agentId: 'other-agent' },
    )).resolves.toBeUndefined()
    await expect(handler(
      { cleanedBody: '导演脑是什么架构？' },
      { ...targetContext, trigger: 'heartbeat' },
    )).resolves.toBeUndefined()
    await expect(handler(
      { cleanedBody: '导演脑分析《冰原纪事》的架构是什么？' },
      targetContext,
    )).resolves.toBeUndefined()
    const malformedContext = new Proxy({}, {
      get() {
        throw new Error('malformed-context')
      },
    })
    await expect(handler(
      { cleanedBody: '导演脑是什么架构？' },
      malformedContext,
    )).resolves.toBeUndefined()
    expect(service).not.toHaveBeenCalled()
  })

  it('fails closed for maintenance, canonical read failure, and an inner timeout', async () => {
    const maintenance = createDirectorBrainSystemQuestionHandler({
      releaseReady: false,
      targetAgentId: 'second-original',
    })
    await expect(maintenance(
      { cleanedBody: '导演脑是什么架构？' },
      targetContext,
    )).resolves.toEqual({
      handled: true,
      reply: { text: DIRECTOR_BRAIN_MAINTENANCE_MESSAGE },
      reason: 'director_brain_maintenance',
    })

    const failing = createDirectorBrainSystemQuestionHandler({
      targetAgentId: 'second-original',
      service: vi.fn().mockRejectedValue(new Error('unavailable')),
    })
    await expect(failing(
      { cleanedBody: '导演脑是什么架构？' },
      targetContext,
    )).resolves.toEqual({
      handled: true,
      reply: { text: DIRECTOR_BRAIN_UNAVAILABLE_MESSAGE },
      reason: 'director_brain_system_read_failed',
    })

    const timingOut = createDirectorBrainSystemQuestionHandler({
      targetAgentId: 'second-original',
      service: () => new Promise(() => {}),
      requestTimeoutMs: 5,
    })
    await expect(timingOut(
      { cleanedBody: '导演脑是什么架构？' },
      targetContext,
    )).resolves.toEqual({
      handled: true,
      reply: { text: DIRECTOR_BRAIN_UNAVAILABLE_MESSAGE },
      reason: 'director_brain_system_read_failed',
    })
  })
})
