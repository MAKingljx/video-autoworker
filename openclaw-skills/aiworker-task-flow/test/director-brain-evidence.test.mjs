import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  buildDirectorBrainEvidenceProjection,
  buildDirectorBrainEvidenceProjectionFromTaskRun,
  DIRECTOR_EVIDENCE_PROJECT_ID,
  DIRECTOR_EVIDENCE_SOURCE_AUTHORITY,
  stableDirectorEvidenceId,
} from '../lib/director-brain-evidence.mjs'

const script = fileURLToPath(new URL('../scripts/project-director-evidence.mjs', import.meta.url))

function envelope(overrides = {}) {
  return {
    schemaVersion: 1,
    projectId: DIRECTOR_EVIDENCE_PROJECT_ID,
    workId: 'WORK-ICE-001',
    taskId: `video-command-${'a'.repeat(64)}`,
    materialId: `video-${'b'.repeat(64)}.mp4`,
    mediaDurationSeconds: 125,
    analysisVersion: 'video-analysis-v1',
    status: 'succeeded',
    taskType: 'video-analysis',
    sourceAuthority: DIRECTOR_EVIDENCE_SOURCE_AUTHORITY,
    output: {
      summary: '人物在发现冰面裂缝后停下，并与同行者共同选择绕行。',
      combinedText: '不应覆盖正式 summary。',
      timeline: [
        {
          index: 1,
          timeRange: '00:00:00-00:01:00',
          transcript: '前方可能有裂缝。',
          visualAnalysis: '向导停下并观察冰面。',
          confidence: 0.91,
        },
        {
          index: 2,
          timeRange: '00:01:00.000-00:02:05.000',
          transcript: '我们从右边绕过去。',
          visualAnalysis: '众人改变行进方向。',
          confidence: 0.88,
        },
      ],
    },
    ...overrides,
  }
}

test('projects one full-duration summary and time-scoped visual evidence deterministically', () => {
  const input = envelope()
  const first = buildDirectorBrainEvidenceProjection(input)
  const replay = buildDirectorBrainEvidenceProjection(structuredClone(input))

  assert.deepEqual(replay, first)
  assert.equal(first.workId, 'WORK-ICE-001')
  assert.equal(first.items.length, 3)
  assert.deepEqual(first.items[0], {
    '证据名称': 'WORK-ICE-001 全片摘要',
    '任务 ID': input.taskId,
    '素材 ID': input.materialId,
    '场景 ID': first.items[0]['场景 ID'],
    '镜头 ID': first.items[0]['镜头 ID'],
    '起始时间码': '00:00:00.000',
    '结束时间码': '00:02:05.000',
    '时间信息': 'global:summary',
    '证据摘要': '人物在发现冰面裂缝后停下，并与同行者共同选择绕行。',
    '分析版本': 'video-analysis-v1',
    '置信度': 0.88,
    '校验摘要': first.items[0]['校验摘要'],
  })
  assert.deepEqual(first.items[1], {
    '证据名称': 'WORK-ICE-001 时间片段 1',
    '任务 ID': input.taskId,
    '素材 ID': input.materialId,
    '场景 ID': first.items[1]['场景 ID'],
    '镜头 ID': first.items[1]['镜头 ID'],
    '起始时间码': '00:00:00.000',
    '结束时间码': '00:01:00.000',
    '时间信息': 'timeline:1',
    '画面信息': '向导停下并观察冰面。',
    '证据摘要': '向导停下并观察冰面。',
    '分析版本': 'video-analysis-v1',
    '置信度': 0.91,
    '校验摘要': first.items[1]['校验摘要'],
  })
  assert.equal(first.items[2]['起始时间码'], '00:01:00.000')
  assert.equal(first.items[2]['结束时间码'], '00:02:05.000')
  assert.equal(first.items[2]['画面信息'], '众人改变行进方向。')
  assert.equal(first.items[2]['证据摘要'], '众人改变行进方向。')
  assert.equal(first.items[2]['置信度'], 0.88)
  assert.equal(first.items.filter(item => item['证据摘要'] === input.output.summary).length, 1)
  assert.equal(first.items.slice(1).every(item => item['证据摘要'] !== input.output.summary), true)
  assert.match(first.items[0]['场景 ID'], /^DB-SCENE-[a-f0-9]{64}$/u)
  assert.match(first.items[0]['镜头 ID'], /^DB-SHOT-[a-f0-9]{64}$/u)
  assert.match(first.items[0]['校验摘要'], /^[a-f0-9]{64}$/u)
  assert.match(stableDirectorEvidenceId(first.workId, first.items[0]), /^DB-EVIDENCE-[a-f0-9]{64}$/u)
  assert.equal(
    stableDirectorEvidenceId(first.workId, first.items[0]),
    stableDirectorEvidenceId(replay.workId, replay.items[0]),
  )
  assert.deepEqual(
    first.items.map(item => stableDirectorEvidenceId(first.workId, item)),
    replay.items.map(item => stableDirectorEvidenceId(replay.workId, item)),
  )
})

test('omits local evidence when no governed segment fact is available', () => {
  const input = envelope({
    output: {
      summary: '这是受治理的全片摘要。',
      chapters: [{
        index: 1,
        startTime: '00:00:00',
        endTime: '00:02:05',
        summary: '未治理的章节摘要不能成为局部证据。',
        confidence: 0.82,
      }],
    },
  })

  const result = buildDirectorBrainEvidenceProjection(input)
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0]['起始时间码'], '00:00:00.000')
  assert.equal(result.items[0]['结束时间码'], '00:02:05.000')
  assert.equal(result.items[0]['证据摘要'], '这是受治理的全片摘要。')
  assert.equal(JSON.stringify(result).includes('未治理的章节摘要不能成为局部证据。'), false)
})

test('validates transcripts but never projects raw speech into evidence items', () => {
  const base = envelope()
  const transcriptText = base.output.timeline.map(segment => segment.transcript).join('\n')
  const input = envelope({
    output: {
      ...base.output,
      combinedText: transcriptText,
    },
  })
  const result = buildDirectorBrainEvidenceProjection(input)
  const serialized = JSON.stringify(result)

  assert.equal(result.items.every(item => !Object.hasOwn(item, '声音信息')), true)
  for (const segment of input.output.timeline) {
    assert.equal(serialized.includes(segment.transcript), false)
  }
  assert.equal(serialized.includes(transcriptText), false)
  assert.throws(
    () => buildDirectorBrainEvidenceProjection(envelope({
      output: {
        ...input.output,
        timeline: [{ ...input.output.timeline[0], transcript: { text: '伪造转写' } }],
      },
    })),
    /director_evidence_timeline_transcript:1_invalid/u,
  )
})

test('fails closed instead of accepting combinedText or chapter summary as the formal report', () => {
  const input = envelope({
    mediaDurationSeconds: 300,
    output: {
      summary: '   ',
      combinedText: '前方可能有裂缝。\n我们从右边绕过去。',
      chapters: [{
        index: 1,
        startTime: '00:00:00',
        endTime: '00:05:00',
        summary: '这条章节摘要不得被当作根报告来源。',
        confidence: 0.82,
      }],
    },
  })

  assert.throws(
    () => buildDirectorBrainEvidenceProjection(input),
    /director_evidence_final_report_missing/u,
  )
})

test('fails closed unless the envelope proves a succeeded video result from the fixed authority', () => {
  assert.throws(
    () => buildDirectorBrainEvidenceProjection(envelope({ status: 'running' })),
    /director_evidence_task_not_succeeded/u,
  )
  assert.throws(
    () => buildDirectorBrainEvidenceProjection(envelope({ taskType: 'general' })),
    /director_evidence_task_type_invalid/u,
  )
  assert.throws(
    () => buildDirectorBrainEvidenceProjection(envelope({ sourceAuthority: 'caller-asserted' })),
    /director_evidence_source_authority_invalid/u,
  )
  assert.throws(
    () => buildDirectorBrainEvidenceProjection(envelope({ projectId: 'PROJ-OTHER' })),
    /director_evidence_project_id_invalid/u,
  )
  assert.throws(
    () => buildDirectorBrainEvidenceProjection({ ...envelope(), routing: { taskType: 'video-analysis' } }),
    /director_evidence_field_unexpected:routing/u,
  )
})

test('requires explicit work, task, material, duration, and analysis identities', () => {
  for (const [field, value, expected] of [
    ['workId', '', /director_evidence_work_id_invalid/u],
    ['taskId', 'task id with spaces', /director_evidence_task_id_invalid/u],
    ['materialId', null, /director_evidence_material_id_invalid/u],
    ['mediaDurationSeconds', 0, /director_evidence_media_duration_seconds_invalid/u],
    ['analysisVersion', '', /director_evidence_analysis_version_invalid/u],
  ]) {
    assert.throws(
      () => buildDirectorBrainEvidenceProjection(envelope({ [field]: value })),
      expected,
    )
  }
  const missing = envelope()
  delete missing.workId
  assert.throws(
    () => buildDirectorBrainEvidenceProjection(missing),
    /director_evidence_field_missing:workId/u,
  )
})

test('rejects malformed, duplicate, out-of-duration, or confidence-free segments', () => {
  const timeline = envelope().output.timeline
  assert.throws(
    () => buildDirectorBrainEvidenceProjection(envelope({
      output: { summary: '报告', timeline: [{ ...timeline[0], timeRange: '0-60' }] },
    })),
    /director_evidence_timeline_time_range:1_invalid/u,
  )
  assert.throws(
    () => buildDirectorBrainEvidenceProjection(envelope({
      mediaDurationSeconds: 59,
      output: { summary: '报告', timeline: [timeline[0]] },
    })),
    /director_evidence_timeline_time_range:1_exceeds_media_duration/u,
  )
  assert.throws(
    () => buildDirectorBrainEvidenceProjection(envelope({
      output: { summary: '报告', timeline: [{ ...timeline[0], confidence: undefined }] },
    })),
    /director_evidence_timeline_confidence:1_invalid/u,
  )
  assert.throws(
    () => buildDirectorBrainEvidenceProjection(envelope({
      output: { summary: '报告', timeline: [timeline[0], { ...timeline[1], index: 1 }] },
    })),
    /director_evidence_segment_indexes_duplicate/u,
  )
})

test('accepts report text only from output.summary', () => {
  const source = envelope().output.timeline[0]
  assert.throws(
    () => buildDirectorBrainEvidenceProjection(envelope({
      output: {
        finalReport: '未经允许的报告字段',
        timeline: [source],
      },
    })),
    /director_evidence_final_report_missing/u,
  )
  assert.throws(
    () => buildDirectorBrainEvidenceProjection(envelope({
      output: {
        summary: { text: '嵌套伪摘要' },
        combinedText: '即使存在后备报告也应对错误 summary 类型失败关闭',
        timeline: [source],
      },
    })),
    /director_evidence_output_summary_invalid/u,
  )
})

test('stdin CLI emits only the work-scoped projection and never calls an external service', () => {
  const result = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    input: JSON.stringify(envelope()),
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
  const output = JSON.parse(result.stdout)
  assert.deepEqual(Object.keys(output).sort(), ['items', 'workId'])
  assert.equal(output.workId, 'WORK-ICE-001')
  assert.equal(output.items.length, 3)
  assert.equal(Object.hasOwn(output.items[0], '作品 ID'), false)

  const rejected = spawnSync(process.execPath, [script, '--task-id', 'forbidden'], {
    encoding: 'utf8',
    input: JSON.stringify(envelope()),
  })
  assert.equal(rejected.status, 1)
  assert.deepEqual(JSON.parse(rejected.stderr), {
    ok: false,
    error: 'director_evidence_arguments_forbidden',
  })
})

test('builds the projection directly from a formal succeeded task run', () => {
  const source = envelope()
  const result = buildDirectorBrainEvidenceProjectionFromTaskRun(source.workId, {
    taskId: source.taskId,
    status: source.status,
    output: {
      ...source.output,
      taskType: source.taskType,
      materialId: source.materialId,
      mediaDurationSeconds: source.mediaDurationSeconds,
      analysisVersion: source.analysisVersion,
    },
  })

  assert.equal(result.workId, source.workId)
  assert.equal(result.items.length, 3)
  assert.equal(result.items[0]['素材 ID'], source.materialId)
  assert.throws(
    () => buildDirectorBrainEvidenceProjectionFromTaskRun(source.workId, {
      taskId: source.taskId,
      status: 'running',
      output: {
        ...source.output,
        taskType: source.taskType,
        materialId: source.materialId,
        mediaDurationSeconds: source.mediaDurationSeconds,
        analysisVersion: source.analysisVersion,
      },
    }),
    /director_evidence_task_not_succeeded/u,
  )
})
