import { describe, expect, it } from 'vitest'
import {
  DIRECTOR_EXTRACTION_CONTRACT,
  DIRECTOR_EXTRACTION_DEFAULT_MODEL_IDENTITY,
  DIRECTOR_EXTRACTION_OUTPUT_FIELDS_BY_KIND,
  DIRECTOR_EXTRACTION_PHASE_INSTRUCTIONS,
  DIRECTOR_EXTRACTION_PROJECTION_FIELDS_BY_KIND,
  DIRECTOR_EXTRACTION_PROJECT_ID,
  DIRECTOR_EXTRACTION_REVIEW_PHASE_BY_STATUS,
  DIRECTOR_EXTRACTION_REVIEW_STATUS_BY_PHASE,
  DIRECTOR_EXTRACTION_SEMANTIC_FIELDS_BY_KIND,
  DIRECTOR_EXTRACTION_SOURCE_TABLE_BY_KIND,
  DIRECTOR_EXTRACTION_TABLE_BY_KIND,
  DIRECTOR_EXTRACTION_WAITING_STATUSES,
  buildDirectorPerceptionCheckpointInput,
  buildDirectorExtractionOutputContract,
  directorExtractionContractDigest,
  directorExtractionContractManifest,
  directorExtractionProjectionReceiptSchema,
  directorExtractionPhases,
  isDirectorExtractionAcceptedStatus,
  isDirectorExtractionTerminalStatus,
  parseDirectorExtractionOutput,
  reviewedDirectorReferencesSchema,
  type DirectorExtractionCandidate,
  type DirectorExtractionIdentity,
  type DirectorExtractionPhase,
} from '@/lib/director-extraction-state'

const evidenceRefs = [{
  materialId: 'MAT-001',
  startSeconds: 0,
  endSeconds: 1,
}]

function candidate(
  kind: string,
  fields: Record<string, unknown>,
  sourceCandidateKeys: string[] = [],
  sourceStableIds?: string[],
  directionalNodes: Partial<Pick<DirectorExtractionCandidate, 'sourceNode' | 'targetNode'>> = {},
): DirectorExtractionCandidate {
  const semanticFields = DIRECTOR_EXTRACTION_SEMANTIC_FIELDS_BY_KIND[
    kind as keyof typeof DIRECTOR_EXTRACTION_SEMANTIC_FIELDS_BY_KIND
  ]
  const semanticValue = (field: 'title' | 'summary' | 'rationale', fallback: string) => {
    const fieldName = semanticFields?.[field]
    const value = fieldName ? fields[fieldName] : undefined
    return typeof value === 'string' && value.trim() ? value.trim() : fallback
  }
  const title = semanticValue('title', `${kind} candidate`)
  const summary = semanticValue('summary', '只包含可核验摘要。')
  const rationale = semanticFields?.rationale === semanticFields?.summary
    ? summary
    : semanticValue('rationale', '只根据已核验证据判断。')
  const semanticFieldsPayload = { ...fields }
  if (semanticFields) {
    semanticFieldsPayload[semanticFields.title] ??= title
    semanticFieldsPayload[semanticFields.summary] ??= summary
    semanticFieldsPayload[semanticFields.rationale] ??= rationale
  }
  return {
    candidateKey: `candidate-${kind}`,
    kind,
    title,
    summary,
    rationale,
    confidence: 0.8,
    evidenceRefs,
    sourceCandidateKeys,
    ...(sourceStableIds ? { sourceStableIds } : {}),
    ...directionalNodes,
    fields: semanticFieldsPayload,
  }
}

function output(phase: DirectorExtractionPhase, candidates: DirectorExtractionCandidate[]) {
  return { schemaVersion: 1 as const, phase, candidates }
}

function extractionIdentity(
  overrides: Partial<DirectorExtractionIdentity> = {},
): DirectorExtractionIdentity {
  return {
    sourceTaskId: 'TASK-001',
    sourceBindingId: 7,
    tenantId: 3,
    workspaceId: 2,
    workId: 'WORK-001',
    workQueryDigest: 'a'.repeat(64),
    materialId: 'MAT-001',
    sourceResultSha256: 'b'.repeat(64),
    extractionContractDigest: directorExtractionContractDigest(),
    ...overrides,
  }
}

describe('director extraction state contract', () => {
  it('keeps phase ordering and lifecycle classifications in one canonical contract', () => {
    expect(Object.keys(DIRECTOR_EXTRACTION_REVIEW_STATUS_BY_PHASE))
      .toEqual(directorExtractionPhases)
    for (const phase of directorExtractionPhases) {
      const status = DIRECTOR_EXTRACTION_REVIEW_STATUS_BY_PHASE[phase]
      expect(DIRECTOR_EXTRACTION_REVIEW_PHASE_BY_STATUS[status]).toBe(phase)
      expect(DIRECTOR_EXTRACTION_WAITING_STATUSES).toContain(status)
    }
    expect(DIRECTOR_EXTRACTION_WAITING_STATUSES).toEqual([
      'awaiting_evidence_projection',
      'awaiting_intent_review',
      'awaiting_evidence_review',
      'awaiting_understanding_review',
      'awaiting_judgment_review',
      'awaiting_case_review',
      'awaiting_technique_review',
    ])
    expect(isDirectorExtractionAcceptedStatus('pending')).toBe(true)
    expect(isDirectorExtractionAcceptedStatus('running')).toBe(true)
    expect(isDirectorExtractionAcceptedStatus('completed')).toBe(false)
    expect(isDirectorExtractionTerminalStatus('completed')).toBe(true)
    expect(isDirectorExtractionTerminalStatus('conflict')).toBe(true)
    expect(isDirectorExtractionTerminalStatus('failed')).toBe(false)
  })

  it('accepts only the exact Feishu candidate fields for every generated kind', () => {
    const candidatesByPhase: Record<Exclude<DirectorExtractionPhase, 'perception'>, DirectorExtractionCandidate[]> = {
      understanding: [
        candidate('person_profile', {
          '人物名称': ' 小林 ',
          '人物 ID': 'PERSON-XIAOLIN',
          '观察日期': '2026-09-03T00:00:00.000Z',
          '置信度': 0.8,
        }),
        candidate('story_node', {
          '节点名称': '重新验证',
          '节点类型': '转折',
          '节点内容': '人物开始重新验证原有判断。',
          '置信度': 0.8,
        }),
      ],
      judgment: [
        candidate('story_relation', {
          '关系名称': '质疑促成验证',
          '关系类型': '因果',
          '判断理由': '证据显示质疑在先，重新验证在后。',
          '置信度': 0.8,
        }, [], undefined, {
          sourceNode: { type: 'candidate', candidateKey: 'story-source' },
          targetNode: { type: 'candidate', candidateKey: 'story-target' },
        }),
        candidate('material_judgment', {
          '判断名称': '关系转折',
          '故事价值': 90,
          '人物价值': 85,
          '情绪价值': 80,
          '信息价值': 75,
          '视觉价值': 70,
          '稀缺性': 65,
          '叙事价值': 95,
          '使用理由': '人物判断在现场发生了可核验变化。',
          '置信度': 0.8,
        }),
        candidate('narrative_proposal', {
          '方案名称': '从坚信到共同验证',
          '人物线': '从坚信到重新判断。',
          '事件线': '质疑后展开验证。',
          '时间线': '按事件先后推进。',
          '地点线': '同一现场持续进行。',
          '情绪线': '自信、动摇、重新理解。',
          '主题线': '共同验证比单向说服更有力。',
          '冲突线': '现场经验与专业判断冲突。',
          '结构说明': '建立判断，打破确信，形成共识。',
          '故事脚本': '人物在质疑中重新审视原有判断。',
        }, ['story-source']),
      ],
      case: [candidate('director_case', {
        '案例名称': '用行为变化呈现人物转折',
        '上下文': '人物原有判断遭到现场质疑。',
        '导演动作': '待定',
        '判断原因': '行为改变比口头表态更可核验。',
      }, ['judgment-source'])],
      technique: [candidate('technique', {
        '知识名称': '用重新验证显影人物变化',
        '知识类型': '技法',
        '知识分类': '人物叙事',
        '适用条件': '人物原有判断受到现场挑战。',
        '执行方法': '对照挑战前后的行为和判断。',
        '为什么有效': '变化有明确的外部条件和行为结果。',
        '置信度': 0.8,
      }, ['case-source'])],
    }

    for (const [phase, candidates] of Object.entries(candidatesByPhase)) {
      expect(() => parseDirectorExtractionOutput(
        phase as DirectorExtractionPhase,
        output(phase as DirectorExtractionPhase, candidates),
      )).not.toThrow()
    }

    const parsed = parseDirectorExtractionOutput(
      'understanding',
      output('understanding', candidatesByPhase.understanding),
    )
    expect(parsed.candidates[0].fields['人物名称']).toBe('小林')
    expect(() => parseDirectorExtractionOutput('understanding', output('understanding', [
      candidate('person_profile', {
        '人物名称': '小林',
        '人物 ID': 'PERSON-XIAOLIN',
        '置信度': 0.8,
        '未定义字段': '不允许',
      }),
    ]))).toThrow()
  })

  it('rejects sensitive content before it can become a projection candidate', () => {
    const unsafeValues = [
      '/Users/operator/private/video.mov',
      'https://example.test/private',
      'ｈｔｔｐｓ://example.test/private',
      `sk-${'x'.repeat(24)}`,
      'Bearer bearer_value_12345',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.signature_value_123',
      `ghu_${'U'.repeat(24)}`,
      `ghr_${'R'.repeat(24)}`,
      `github_pat_${'P'.repeat(24)}`,
      ['xoxb', '1234567890', 'abcdefghijklmnop'].join('-'),
      'api_key=assigned-secret-12345',
      'token: assigned-token-12345',
      '这是完整原始转写，不应进入候选。',
      `data:text/plain;base64,${'A'.repeat(180)}`,
      'recAbCdEfGh123456',
    ]
    for (const unsafe of unsafeValues) {
      expect(() => parseDirectorExtractionOutput('understanding', output('understanding', [
        {
          ...candidate('story_node', {
            '节点名称': '人物转折',
            '节点类型': '转折',
            '节点内容': '人物改变原有判断。',
            '置信度': 0.8,
          }),
          summary: unsafe,
        },
      ]))).toThrow(/director_extraction_candidate_sensitive/u)
    }

    expect(() => parseDirectorExtractionOutput('understanding', output('understanding', [
      {
        ...candidate('story_node', {
          '节点名称': '术语讨论',
          '节点类型': '事件',
          '节点内容': '普通叙述可以提到 token 和 key。',
          '变化': '普通叙述可以提到 token 和 key。',
          '置信度': 0.8,
        }),
        summary: '普通叙述可以提到 token 和 key。',
      },
    ]))).not.toThrow()
  })

  it('rejects wrong phases, invalid dates, and duplicate lineage or evidence', () => {
    const profile = candidate('person_profile', {
      '人物名称': '小林',
      '人物 ID': 'PERSON-XIAOLIN',
      '观察日期': '昨天下午',
      '置信度': 0.8,
    })
    expect(() => parseDirectorExtractionOutput(
      'understanding', output('understanding', [profile]),
    )).toThrow()
    expect(() => parseDirectorExtractionOutput(
      'case', output('case', [{ ...profile, fields: { ...profile.fields, '观察日期': 0 } }]),
    )).toThrow(/director_extraction_candidate_kind_invalid/u)

    const relation = candidate('story_relation', {
      '关系名称': '前后变化',
      '关系类型': '时间',
      '判断理由': '两个节点先后发生。',
      '置信度': 0.8,
    }, ['same-node', 'same-node'])
    expect(() => parseDirectorExtractionOutput(
      'judgment', output('judgment', [relation]),
    )).toThrow(/director_extraction_lineage_key_duplicate/u)

    const node = candidate('story_node', {
      '节点名称': '变化',
      '节点类型': '人物变化',
      '节点内容': '人物改变了判断。',
      '置信度': 0.8,
    })
    node.evidenceRefs = [...evidenceRefs, ...evidenceRefs]
    expect(() => parseDirectorExtractionOutput(
      'understanding', output('understanding', [node]),
    )).toThrow(/director_extraction_evidence_duplicate/u)
  })

  it('accepts mixed current and reviewed-history lineage with explicit source tables', () => {
    const mixedRelation = candidate('story_relation', {
      '关系名称': '新节点呼应历史节点',
      '关系类型': '呼应',
      '判断理由': '当前素材节点与已审核历史节点形成呼应。',
      '置信度': 0.8,
    }, [], undefined, {
      sourceNode: { type: 'reviewed', stableId: 'STORY-HISTORY-002' },
      targetNode: { type: 'candidate', candidateKey: 'current-story-node' },
    })
    const relation = parseDirectorExtractionOutput(
      'judgment',
      output('judgment', [mixedRelation]),
    ).candidates[0]
    expect(relation.sourceNode).toEqual({ type: 'reviewed', stableId: 'STORY-HISTORY-002' })
    expect(relation.targetNode).toEqual({ type: 'candidate', candidateKey: 'current-story-node' })

    const historicalProfile = candidate('person_profile', {
      '人物名称': '小林',
      '人物 ID': 'PERSON-XIAOLIN',
      '身份': '历史人物档案的新观察',
      '置信度': 0.8,
    }, [], ['PERSON-HISTORY-001'])
    expect(parseDirectorExtractionOutput(
      'understanding',
      output('understanding', [historicalProfile]),
    ).candidates[0].sourceStableIds).toEqual(['PERSON-HISTORY-001'])

    const legacyNode = candidate('story_node', {
      '节点名称': '新发现',
      '节点类型': '事件',
      '节点内容': '旧 fixture 未提供 sourceStableIds。',
      '置信度': 0.8,
    })
    expect(parseDirectorExtractionOutput(
      'understanding',
      output('understanding', [legacyNode]),
    ).candidates[0].sourceStableIds).toEqual([])

    expect(DIRECTOR_EXTRACTION_SOURCE_TABLE_BY_KIND).toEqual({
      person_profile: 'people_profiles',
      story_node: 'story_nodes',
      story_relation: 'story_nodes',
      material_judgment: 'material_judgments',
      narrative_proposal: 'story_nodes',
      director_case: 'material_judgments',
      technique: 'director_cases',
    })
  })

  it('rejects duplicate, oversized, and wrongly counted stable lineage', () => {
    const relationFields = {
      '关系名称': '前后变化',
      '关系类型': '时间',
      '判断理由': '两个节点先后发生。',
      '置信度': 0.8,
    }
    expect(() => parseDirectorExtractionOutput('judgment', output('judgment', [
      candidate('story_relation', relationFields, [], ['STORY-A', 'STORY-A']),
    ]))).toThrow(/director_extraction_lineage_id_duplicate/u)
    expect(() => parseDirectorExtractionOutput('judgment', output('judgment', [
      candidate(
        'story_relation',
        relationFields,
        [],
        Array.from({ length: 65 }, (_, index) => `STORY-${index + 1}`),
      ),
    ]))).toThrow(/director_extraction_lineage_id_too_many/u)
    expect(() => parseDirectorExtractionOutput('judgment', output('judgment', [
      candidate('story_relation', relationFields, ['STORY-CURRENT']),
    ]))).toThrow(/director_extraction_relation_sources_invalid/u)
    expect(() => parseDirectorExtractionOutput('judgment', output('judgment', [
      candidate('story_relation', relationFields, ['STORY-A', 'STORY-B'], ['STORY-C']),
    ]))).toThrow(/director_extraction_relation_sources_invalid/u)

    const profileFields = {
      '人物名称': '小林',
      '人物 ID': 'PERSON-XIAOLIN',
      '置信度': 0.8,
    }
    expect(() => parseDirectorExtractionOutput('understanding', output('understanding', [
      candidate('person_profile', profileFields, ['CURRENT-PERSON']),
    ]))).toThrow(/director_extraction_candidate_sources_invalid/u)
    expect(() => parseDirectorExtractionOutput('understanding', output('understanding', [
      candidate('person_profile', profileFields, [], ['PERSON-A', 'PERSON-B']),
    ]))).toThrow(/director_extraction_candidate_sources_invalid/u)

    const narrativeFields = {
      '方案名称': '空来源方案',
      '人物线': '人物线',
      '事件线': '事件线',
      '时间线': '时间线',
      '地点线': '地点线',
      '情绪线': '情绪线',
      '主题线': '主题线',
      '冲突线': '冲突线',
      '结构说明': '结构说明',
      '故事脚本': '故事脚本',
    }
    expect(() => parseDirectorExtractionOutput('judgment', output('judgment', [
      candidate('narrative_proposal', narrativeFields),
    ]))).toThrow(/director_extraction_narrative_sources_invalid/u)
    expect(() => parseDirectorExtractionOutput('case', output('case', [candidate('director_case', {
      '案例名称': '错误来源数',
      '上下文': '上下文',
      '导演动作': '待定',
      '判断原因': '判断原因',
    }, ['JUDGMENT-CURRENT'], ['JUDGMENT-HISTORY'])])))
      .toThrow(/director_extraction_case_sources_invalid/u)
    expect(() => parseDirectorExtractionOutput('technique', output('technique', [
      candidate('technique', {
        '知识名称': '空来源技法',
        '知识类型': '技法',
        '知识分类': '人物叙事',
        '适用条件': '适用条件',
        '执行方法': '执行方法',
        '为什么有效': '为什么有效',
        '置信度': 0.8,
      }),
    ]))).toThrow(/director_extraction_technique_sources_invalid/u)
  })

  it('normalizes a receipt and binds every phase, kind, table, and range', () => {
    const receipt = directorExtractionProjectionReceiptSchema.parse({
      schemaVersion: 1,
      phase: 'understanding',
      entries: [
        {
          candidateKey: 'story-z',
          kind: 'story_node',
          table: 'story_nodes',
          stableId: 'DB-STORY-NODES-Z',
        },
        {
          candidateKey: 'person-a',
          kind: 'person_profile',
          table: 'people_profiles',
          stableId: 'DB-PEOPLE-PROFILES-A',
        },
      ],
    })
    expect(receipt.entries.map(entry => entry.candidateKey)).toEqual(['person-a', 'story-z'])
    expect(Object.isFrozen(receipt)).toBe(true)
    expect(Object.isFrozen(receipt.entries)).toBe(true)

    expect(() => directorExtractionProjectionReceiptSchema.parse({
      schemaVersion: 1,
      phase: 'technique',
      entries: [{
        candidateKey: 'technique-a',
        kind: 'technique',
        table: 'skills_techniques',
        stableId: 'DB-SKILLS-TECHNIQUES-A',
      }],
    })).not.toThrow()
    expect(DIRECTOR_EXTRACTION_TABLE_BY_KIND.technique).toBe('skills_techniques')

    for (const entry of [
      { candidateKey: 'bad-a', kind: 'technique', table: 'director_cases', stableId: 'BAD-A' },
      { candidateKey: 'bad-b', kind: 'story_node', table: 'story_nodes', stableId: 'BAD-B' },
      { candidateKey: 'bad-c', kind: 'technique', table: 'techniques', stableId: 'BAD-C' },
    ]) {
      expect(() => directorExtractionProjectionReceiptSchema.parse({
        schemaVersion: 1,
        phase: 'technique',
        entries: [entry],
      })).toThrow()
    }

    expect(() => directorExtractionProjectionReceiptSchema.parse({
      schemaVersion: 1,
      phase: 'perception',
      entries: [{
        candidateKey: 'evidence-a',
        kind: 'material_observation',
        table: 'material_evidence',
        stableId: 'EVIDENCE-A',
      }],
    })).toThrow(/director_extraction_projection_range_required/u)

    expect(() => reviewedDirectorReferencesSchema.parse({
      story_nodes: ['STORY-A', 'STORY-A'],
    })).toThrow(/director_extraction_reference_duplicate/u)
  })

  it('covers prompt text, projection mapping, and model version in the contract digest', () => {
    const manifest = directorExtractionContractManifest()
    expect(manifest).toMatchObject({
      contract: DIRECTOR_EXTRACTION_CONTRACT,
      phaseInstructions: DIRECTOR_EXTRACTION_PHASE_INSTRUCTIONS,
      outputContractsByPhase: {
        technique: buildDirectorExtractionOutputContract('technique'),
      },
      tableByKind: { technique: 'skills_techniques' },
      sourceTableByKind: { technique: 'director_cases' },
      model: DIRECTOR_EXTRACTION_DEFAULT_MODEL_IDENTITY,
    })
    expect(Object.isFrozen(manifest)).toBe(true)
    expect(Object.isFrozen(manifest.phaseInstructions)).toBe(true)
    const relationContract = buildDirectorExtractionOutputContract('judgment')
      .candidates.find(candidate => candidate.kind === 'story_relation')!
    expect(relationContract.sourceNode).toMatchObject({ type: 'candidate|reviewed' })
    expect(relationContract.targetNode).toMatchObject({ type: 'candidate|reviewed' })
    expect(relationContract.sourceLineageRule).toContain('明确方向')
    for (const kind of Object.keys(DIRECTOR_EXTRACTION_OUTPUT_FIELDS_BY_KIND) as Array<
      keyof typeof DIRECTOR_EXTRACTION_OUTPUT_FIELDS_BY_KIND
    >) {
      expect(Object.keys(DIRECTOR_EXTRACTION_OUTPUT_FIELDS_BY_KIND[kind]).sort())
        .toEqual([...DIRECTOR_EXTRACTION_PROJECTION_FIELDS_BY_KIND[kind]].sort())
    }

    const baseline = directorExtractionContractDigest()
    expect(baseline).toMatch(/^[a-f0-9]{64}$/u)
    expect(directorExtractionContractDigest({
      ...DIRECTOR_EXTRACTION_DEFAULT_MODEL_IDENTITY,
      modelVersion: 'qwen-3.6-revision-2',
    })).not.toBe(baseline)
  })

  it('builds a frozen non-sensitive perception checkpoint identity', () => {
    const checkpoint = buildDirectorPerceptionCheckpointInput(extractionIdentity())
    expect(checkpoint).toEqual({
      schemaVersion: 2,
      contract: DIRECTOR_EXTRACTION_CONTRACT,
      extractionContractDigest: directorExtractionContractDigest(),
      promptVersion: 'director-extraction-prompts-v3',
      projectionVersion: 'feishu-candidate-projection-v2',
      phase: 'perception',
      projectId: DIRECTOR_EXTRACTION_PROJECT_ID,
      workId: 'WORK-001',
      workQueryDigest: 'a'.repeat(64),
      sourceTaskId: 'TASK-001',
      sourceBindingId: 7,
      tenantId: 3,
      workspaceId: 2,
      materialId: 'MAT-001',
      sourceResultSha256: 'b'.repeat(64),
    })
    expect(Object.isFrozen(checkpoint)).toBe(true)
    expect(JSON.stringify(checkpoint)).not.toMatch(/(?:path|transcript|token|secret|credential)/iu)
    expect(() => buildDirectorPerceptionCheckpointInput(extractionIdentity({
      workId: null,
      workQueryDigest: null,
    })))
      .toThrow(/director_extraction_work_not_registered/u)
    expect(() => buildDirectorPerceptionCheckpointInput(extractionIdentity({
      extractionContractDigest: 'c'.repeat(64),
    }))).toThrow(/director_extraction_contract_mismatch/u)
  })
})
