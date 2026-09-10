import type { DirectorExtractionPhaseRunner } from '@/lib/director-extraction-service'
import type {
  DirectorExtractionCandidate,
  DirectorExtractionPhase,
} from '@/lib/director-extraction-state'

export function createDeterministicDirectorExtractionFixtureRunner(): DirectorExtractionPhaseRunner {
  return async (phase, input) => {
    const evidence = input.evidence as Record<string, unknown>
    const materialId = String(evidence.materialId)
    const duration = Number(evidence.mediaDurationSeconds)
    const evidenceRefs = [{
      materialId,
      startSeconds: 0,
      endSeconds: Math.min(1, duration),
    }]
    const candidate = (
      candidateKey: string,
      kind: string,
      fields: Record<string, unknown>,
      sourceCandidateKeys: string[] = [],
      lineage: Partial<Pick<DirectorExtractionCandidate, 'sourceNode' | 'targetNode'>> = {},
    ) => {
      const semanticKeys: Record<string, [string, string, string]> = {
        person_profile: ['人物名称', '人物弧光', '矛盾'],
        story_node: ['节点名称', '节点内容', '变化'],
        story_relation: ['关系名称', '判断理由', '判断理由'],
        material_judgment: ['判断名称', '使用理由', '使用理由'],
        narrative_proposal: ['方案名称', '结构说明', '结构说明'],
        director_case: ['案例名称', '上下文', '判断原因'],
        technique: ['知识名称', '执行方法', '为什么有效'],
      }
      const [titleKey, summaryKey, rationaleKey] = semanticKeys[kind]!
      const normalizedFields = { ...fields }
      const title = String(normalizedFields[titleKey] || `${kind} candidate`)
      const summary = String(normalizedFields[summaryKey] || 'bounded fixture summary')
      const rationale = String(normalizedFields[rationaleKey] || 'bounded fixture rationale')
      normalizedFields[titleKey] = title
      normalizedFields[summaryKey] = summary
      normalizedFields[rationaleKey] = rationale
      return {
        candidateKey,
        kind,
        title,
        summary,
        rationale,
        confidence: 0.8,
        evidenceRefs,
        sourceCandidateKeys,
        ...lineage,
        fields: normalizedFields,
      }
    }
    const candidates: Record<DirectorExtractionPhase, DirectorExtractionCandidate[]> = {
      perception: [],
      understanding: [
        candidate('fixture-person', 'person_profile', {
          '人物名称': '测试人物',
          '人物 ID': 'PERSON-fixture',
          '身份': '记录对象',
          '置信度': 0.8,
        }),
        candidate('fixture-story-a', 'story_node', {
          '节点名称': '进入环境',
          '节点类型': '事件',
          '节点内容': '人物进入新环境。',
          '置信度': 0.8,
        }),
        candidate('fixture-story-b', 'story_node', {
          '节点名称': '改变判断',
          '节点类型': '人物变化',
          '节点内容': '人物改变了原有判断。',
          '置信度': 0.8,
        }),
      ],
      judgment: [
        candidate('fixture-relation', 'story_relation', {
          '关系名称': '前后变化',
          '关系类型': '时间',
          '判断理由': '两个节点先后发生。',
          '置信度': 0.8,
        }, [], {
          sourceNode: { type: 'candidate', candidateKey: 'fixture-story-a' },
          targetNode: { type: 'candidate', candidateKey: 'fixture-story-b' },
        }),
        candidate('fixture-judgment', 'material_judgment', {
          '判断名称': '人物变化判断',
          '故事价值': 80,
          '人物价值': 85,
          '情绪价值': 70,
          '信息价值': 65,
          '视觉价值': 75,
          '稀缺性': 60,
          '叙事价值': 82,
          '使用理由': '可见人物判断发生变化。',
          '置信度': 0.8,
        }),
        candidate('fixture-narrative', 'narrative_proposal', {
          '方案名称': '变化之路',
          '人物线': '人物从坚持到重新判断。',
          '事件线': '进入环境后发生改变。',
          '时间线': '按发生顺序推进。',
          '地点线': '由入口到内部。',
          '情绪线': '从稳定到动摇。',
          '主题线': '环境改变判断。',
          '冲突线': '原目标与现实压力。',
          '结构说明': '以两个节点形成前后对照。',
          '故事脚本': '人物进入环境，在压力中重新判断目标。',
        }, ['fixture-story-a', 'fixture-story-b']),
      ],
      case: [candidate('fixture-case', 'director_case', {
        '案例名称': '人物变化的叙事判断',
        '上下文': '环境压力促成人物变化。',
        '导演动作': '待定',
        '判断原因': '该变化同时具有人物和叙事价值。',
      }, ['fixture-judgment'])],
      technique: [candidate('fixture-technique', 'technique', {
        '知识名称': '环境压力显影人物变化',
        '知识类型': '技法',
        '知识分类': '人物叙事',
        '适用条件': '人物目标受环境阻力影响。',
        '执行方法': '对照压力出现前后的判断。',
        '为什么有效': '变化有明确可核验的外部条件。',
        '例外情况': '无法确认时应保留不确定性。',
        '验证次数': 0,
        '置信度': 0.8,
      }, ['fixture-case'])],
    }
    return { schemaVersion: 1, phase, candidates: candidates[phase] }
  }
}
