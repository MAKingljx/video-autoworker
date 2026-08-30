#!/usr/bin/env node

import {
  executeDirectorBrainOperation as operate,
  loadDirectorBrainSchema,
  projectDirectorBrainEvidence,
  reviewDirectorBrainRecord,
} from './lib/feishu-director-brain.mjs'
import {
  buildDirectorBrainEvidenceProjection,
  DIRECTOR_EVIDENCE_PROJECT_ID,
  DIRECTOR_EVIDENCE_SOURCE_AUTHORITY,
} from '../openclaw-skills/aiworker-task-flow/lib/director-brain-evidence.mjs'

const REVIEWER = 'director-brain-test-fixture'
const REVIEW_REASON = '导演脑 v2 六层真实 API 闭环验收'

async function advance(table, stableId, workId, record, states) {
  let current = record
  while (current.state !== states.at(-1)) {
    const index = states.indexOf(current.state)
    if (index < 0 || index + 1 >= states.length) {
      throw new Error(`test_fixture_unexpected_state:${table}:${current.state}`)
    }
    const reviewed = await reviewDirectorBrainRecord({
      table,
      stableId,
      ...(workId ? { workId } : {}),
      expectedVersion: current.fields['版本'],
      targetStatus: states[index + 1],
      reviewer: REVIEWER,
      reason: REVIEW_REASON,
    })
    current = reviewed.record
  }
  return current
}

async function propose(table, workId, fields, references) {
  return operate({
    action: 'propose',
    table,
    ...(workId ? { workId } : {}),
    fields,
    ...(references ? { references } : {}),
  })
}

async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== '--apply-test-fixture') {
    throw new Error('usage: director-brain-test-fixture --apply-test-fixture')
  }
  const schema = await loadDirectorBrainSchema()
  if (schema.environment !== 'test') throw new Error('test_fixture_environment_must_be_test')

  const work = await propose('works', null, {
    '作品名称': '导演脑系统验收样片',
    '作品类型': '测试纪录片',
    '别名': '导演脑验收片\nDB验收样片',
  })
  const workId = work.stableId
  await advance('works', workId, null, work.record, ['草稿', '生效'])

  const resolved = await operate({ action: 'resolve_work', query: '导演脑验收片' })
  if (!resolved.found || resolved.work?.workId !== workId) {
    throw new Error('test_fixture_work_resolution_failed')
  }

  const projection = buildDirectorBrainEvidenceProjection({
    schemaVersion: 1,
    projectId: DIRECTOR_EVIDENCE_PROJECT_ID,
    workId,
    taskId: 'video-command-director-brain-acceptance-001',
    materialId: 'director-brain-acceptance-sample-001',
    mediaDurationSeconds: 120,
    analysisVersion: 'director-brain-acceptance-v1',
    status: 'succeeded',
    taskType: 'video-analysis',
    sourceAuthority: DIRECTOR_EVIDENCE_SOURCE_AUTHORITY,
    output: {
      summary: '在河边记录中，小林从独自整理水质样本，到听取村民质疑后重做采样，呈现从自信到犹疑再到承担的变化。',
      timeline: [
        {
          index: 1,
          timeRange: '00:00:00-00:01:00',
          transcript: '这次数据应该没问题。',
          visualAnalysis: '小林独自在河边标记样本，镜头保持中景。',
          confidence: 0.92,
        },
        {
          index: 2,
          timeRange: '00:01:00-00:02:00',
          transcript: '你们上次也这么说，能不能当面重测？',
          visualAnalysis: '村民提出质疑，小林停顿后重新取出采样器。',
          confidence: 0.9,
        },
      ],
    },
  })
  if (projection.items.some(item => Object.hasOwn(item, '作品 ID'))) {
    throw new Error('test_fixture_projection_owned_work_id_leaked')
  }
  const evidence = await projectDirectorBrainEvidence(projection)
  const evidenceIds = []
  for (const result of evidence.results) {
    evidenceIds.push(result.stableId)
    await advance(
      'material_evidence', result.stableId, workId, result.record, ['候选', '已核验'],
    )
  }

  const intent = await propose('director_intents', workId, {
    '意图名称': '面对质疑时的责任成长',
    '核心主题': '专业信念在接受质疑和重新验证时才真正成立。',
    '导演态度': '克制观察，不预设任何一方正确。',
    '情绪风格': '平静中逐步紧张，最后回到开放。',
    '叙事方式': '人物跟随与现场对话交叉。',
    '节奏': '前慢后紧，在停顿和重测动作上留白。',
    '观众体验': '先理解自信，再感受质疑压力，最后期待验证结果。',
  })
  const intentId = intent.stableId
  await advance(
    'director_intents', intentId, workId, intent.record, ['草稿', '待审核', '生效'],
  )

  const person = await propose('people_profiles', workId, {
    '人物名称': '小林',
    '人物 ID': 'PERSON-XIAOLIN',
    '别名': '林工',
    '身份': '负责河道水质采样的年轻技术员',
    '目标': '证明监测流程可信',
    '欲望': '获得村民对专业工作的信任',
    '恐惧': '数据或流程不可靠导致失去公信力',
    '性格': '谨慎但过于依赖既有流程',
    '矛盾': '专业自信与公众不信任冲突',
    '情绪变化': '自信→停顿和防御→接受重测',
    '人物弧光': '从证明自己正确转向为共同验证负责',
    '置信度': 0.9,
  }, { evidenceIds })
  const personId = person.stableId
  await advance(
    'people_profiles', personId, workId, person.record, ['候选', '待审核', '已确认'],
  )

  const nodeA = await propose('story_nodes', workId, {
    '节点名称': '专业自信建立',
    '节点类型': '事件',
    '人物 ID': 'PERSON-XIAOLIN',
    '发生时间': '00:00:00-00:01:00',
    '节点内容': '小林完成样本标记并表示数据应无问题。',
    '变化': '观众建立对他的初步专业印象。',
    '置信度': 0.92,
  }, { evidenceIds: [evidenceIds[0]] })
  const nodeAId = nodeA.stableId
  await advance(
    'story_nodes', nodeAId, workId, nodeA.record, ['候选', '待审核', '已确认'],
  )

  const nodeB = await propose('story_nodes', workId, {
    '节点名称': '质疑促成重新验证',
    '节点类型': '转折',
    '人物 ID': 'PERSON-XIAOLIN',
    '发生时间': '00:01:00-00:02:00',
    '节点内容': '村民要求当面重测，小林停顿后重新取出采样器。',
    '变化': '人物从维护原判断转为接受共同验证。',
    '置信度': 0.9,
  }, { evidenceIds: [evidenceIds[1]] })
  const nodeBId = nodeB.stableId
  await advance(
    'story_nodes', nodeBId, workId, nodeB.record, ['候选', '待审核', '已确认'],
  )

  const relation = await propose('story_relations', workId, {
    '关系名称': '公众质疑推动主动重测',
    '关系类型': '因果',
    '判断理由': '重新取出采样器紧接在明确质疑之后，音画共同支持这一推动关系。',
    '置信度': 0.86,
  }, { sourceNodeId: nodeAId, targetNodeId: nodeBId, evidenceIds })
  const relationId = relation.stableId
  await advance(
    'story_relations', relationId, workId, relation.record, ['候选', '待审核', '已确认'],
  )

  const judgment = await propose('material_judgments', workId, {
    '判断名称': '停顿与重新取器材的人物转折价值',
    '故事价值': 90,
    '人物价值': 95,
    '情绪价值': 84,
    '信息价值': 78,
    '视觉价值': 75,
    '稀缺性': 82,
    '叙事价值': 94,
    '使用理由': '停顿和动作选择把抽象的信任冲突转化为可见的人物变化。',
    '建议位置': '放在第一段末尾，作为进入验证段落的转折。',
    '不同位置效果': '提前会弱化对照；推后会增加悬置，但可能损失现场因果。',
    '置信度': 0.9,
  }, { intentVersionId: intentId, evidenceIds })
  const judgmentId = judgment.stableId
  await advance(
    'material_judgments', judgmentId, workId, judgment.record,
    ['候选', '待审核', '已确认'],
  )

  const narrative = await propose('narrative_plans', workId, {
    '方案名称': '从自信到共同验证',
    '人物线': '小林从依赖专业权威，到用可见行动重建信任。',
    '事件线': '采样完成→村民质疑→决定重测。',
    '时间线': '按现场发生顺序推进，在停顿处保留真实时长。',
    '地点线': '河边采样点是信任协商的公共现场。',
    '情绪线': '平静自信→紧张停顿→谨慎开放。',
    '主题线': '信任来自可被共同验证的过程。',
    '冲突线': '技术流程自信与村民经验性不信任的冲突。',
    '结构说明': '以动作建立人物，用对话打破稳定，以重测动作完成转折。',
    '故事脚本': '清晨，小林在河边为样本编号。他说数据应该没问题。村民追问能否当面重测。小林没有立刻回答，而是再次取出采样器。一次数据检验，也成了一次信任检验。',
  }, { intentVersionId: intentId, nodeIds: [nodeAId, nodeBId], evidenceIds })
  const narrativeId = narrative.stableId
  await advance(
    'narrative_plans', narrativeId, workId, narrative.record, ['草稿', '待审核', '已批准'],
  )

  const directorCase = await propose('director_cases', workId, {
    '案例名称': '用停顿而非解说呈现责任转变',
    '上下文': '人物刚确认数据，随后被公开质疑，现场有连续停顿和取器材动作。',
    '导演动作': '采用',
    '判断原因': '保留真实停顿让观众从行动证据中观察人物决策。',
  }, { judgmentId, evidenceIds })
  const caseId = directorCase.stableId
  await advance(
    'director_cases', caseId, workId, directorCase.record, ['待复核', '已确认'],
  )

  const technique = await propose('skills_techniques', workId, {
    '知识名称': '决策停顿的观察性留白',
    '知识类型': '技法',
    '知识分类': '人物转折',
    '适用条件': '人物在压力下做出可见选择，且现场证据连续完整。',
    '执行方法': '保留质疑后的停顿、视线和第一个决策动作，少用解说。',
    '为什么有效': '真实时间使选择成本可感，观众由行动而非结论识别变化。',
    '例外情况': '设备故障或无关干扰造成的停顿不应误判为人物转折。',
    '置信度': 0.84,
  }, { caseIds: [caseId] })
  const techniqueId = technique.stableId
  await advance(
    'skills_techniques', techniqueId, workId, technique.record, ['候选', '待审核', '已验证'],
  )

  const workflow = await operate({
    action: 'workflow',
    workId,
    objective: '基于已核验素材形成可追溯的六层导演判断',
  })
  if (Object.values(workflow.readiness).some(value => value !== true)
    || workflow.metrics.referenceIntegrity !== true) {
    throw new Error('test_fixture_workflow_not_ready')
  }
  const assembled = await operate({
    action: 'assemble',
    workId,
    references: {
      intentVersionId: intentId,
      evidenceIds,
      peopleProfileIds: [personId],
      storyNodeIds: [nodeAId, nodeBId],
      storyRelationIds: [relationId],
      materialJudgmentIds: [judgmentId],
      narrativePlanIds: [narrativeId],
      directorCaseIds: [caseId],
      skillTechniqueIds: [techniqueId],
    },
  })
  process.stdout.write(JSON.stringify({
    ok: true,
    action: 'director-brain-test-fixture',
    workId,
    aliasResolved: true,
    evidenceCount: evidenceIds.length,
    evidenceCreated: evidence.created,
    evidenceUnchanged: evidence.unchanged,
    readiness: workflow.readiness,
    referenceIntegrity: workflow.metrics.referenceIntegrity,
    referenceIssueCount: workflow.metrics.referenceIssueCount,
    assembledEvidenceCount: assembled.evidenceCount,
    recordIds: {
      intentId,
      personId,
      storyNodeIds: [nodeAId, nodeBId],
      relationId,
      judgmentId,
      narrativeId,
      caseId,
      techniqueId,
    },
  }, null, 2) + '\n')
}

main().catch(error => {
  process.stderr.write(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : 'director_brain_test_fixture_failed',
  }) + '\n')
  process.exitCode = 1
})
