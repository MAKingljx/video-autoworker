import { describe, expect, it, vi } from 'vitest'

import { createDirectorBrainTool } from '../lib/director-brain-tool.js'

const targetContext = { agentId: 'second-original' }
const failClosedAnswer = '导演脑暂时无法读取，请稍后再试。'
const hexAlphabet = '0123456789abcdef'

function deterministicHex(length, seed) {
  return Array.from({ length }, (_, index) => (
    hexAlphabet[(seed * 11 + index * 7) % hexAlphabet.length]
  )).join('')
}

function deterministicAlphaNumeric(length, seed, lowerCaseOnly = false) {
  const alphabet = lowerCaseOnly
    ? 'abcdefghijklmnopqrstuvwxyz'
    : '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
  let serialValue = seed
  const serial = Array.from({ length: 3 }, () => {
    const character = alphabet[serialValue % alphabet.length]
    serialValue = Math.floor(serialValue / alphabet.length)
    return character
  }).reverse().join('')
  return serial + Array.from({ length: length - serial.length }, (_, index) => (
    alphabet[(seed * 17 + index * 13) % alphabet.length]
  )).join('')
}

function unsafeIdentifiers() {
  const cases = []
  for (let length = 7; length <= 64; length += 1) {
    for (let seed = 0; seed < 8; seed += 1) {
      cases.push({ kind: `hex-${length}`, value: deterministicHex(length, seed) })
    }
  }
  for (let seed = 0; seed < 128; seed += 1) {
    const uuidHex = seed.toString(16).padStart(8, '0') + deterministicHex(24, seed)
    cases.push({
      kind: 'uuid',
      value: [uuidHex.slice(0, 8), uuidHex.slice(8, 12), uuidHex.slice(12, 16),
        uuidHex.slice(16, 20), uuidHex.slice(20)].join('-'),
    })
  }
  for (const prefix of ['rec', 'tbl']) {
    for (let seed = 0; seed < 256; seed += 1) {
      const suffixLength = 8 + (seed % 17)
      cases.push({
        kind: `${prefix}-${seed % 2 === 0 ? 'lower' : 'mixed'}`,
        value: prefix + deterministicAlphaNumeric(suffixLength, seed, seed % 2 === 0),
      })
    }
  }
  const snakeCaseKeys = [
    'work_id', 'task_id', 'record_id', 'table_id', 'run_id', 'extraction_id',
    'candidate_id', 'source_task_id', 'workId', 'recordId', 'tableId', 'runId',
  ]
  for (const key of snakeCaseKeys) {
    for (let seed = 0; seed < 24; seed += 1) {
      cases.push({ kind: key, value: `${key}=opaque-${seed}` })
    }
  }
  return cases
}

function safeNaturalAnswers() {
  return [
    ...Array.from({ length: 200 }, (_, index) => `这部作品的背景年份是 ${1900 + index} 年。`),
    ...Array.from({ length: 101 }, (_, score) => `人物表达评分为 ${score} 分。`),
    ...[
      '《冰原纪事》的故事线已经清楚。',
      '《七月》的核心人物已经确认。',
      '《2026：归途》的叙事方向可以继续完善。',
      '人物从犹豫转向行动，转折来自同伴的提醒。',
      '第一句。第二句！第三句？',
      '稳'.repeat(160),
    ],
    ...[
      'story ready', 'intent clear', 'director note', 'scene value', 'people arc',
      'safe reply', 'cut later', 'tone calm', 'year 2026', 'score 95',
      'focus', 'rhythm', 'camera', 'dialogue', 'review', 'draft',
    ],
  ]
}

function resultJson(result) {
  return JSON.parse(result.content[0].text)
}

function responseService(answer) {
  return vi.fn().mockResolvedValue({
    ok: true,
    action: 'search',
    responseContract: {
      mustQuoteUserVisibleAnswerExactly: true,
      userVisibleAnswer: answer,
    },
  })
}

describe('director brain user-visible answer fuzz contract', () => {
  it('fails closed for every generated internal identifier mixed into Chinese text', async () => {
    const generated = unsafeIdentifiers()
    expect(generated).toHaveLength(1392)
    expect(new Set(generated.map(item => item.value)).size).toBe(generated.length)

    for (const testCase of generated) {
      const tool = createDirectorBrainTool({
        context: targetContext,
        service: responseService(`导演结论包含内部标识 ${testCase.value}，不得展示。`),
      })
      const result = resultJson(await tool.execute(`unsafe-${testCase.kind}`, {
        action: 'search', workId: 'WORK-HIDDEN', table: 'story_nodes', query: '冲突',
      }))

      expect(result.responseContract.userVisibleAnswer, testCase).toBe(failClosedAnswer)
      expect(result.responseContract, testCase).toMatchObject({
        stopAfterReply: true,
        doNotUseFallbackSources: true,
        doNotExposeInternalIds: true,
      })
      expect(JSON.stringify(result), testCase).not.toContain(testCase.value)
    }
  })

  it('preserves common natural text that merely contains years, scores, titles, or short words', async () => {
    const generated = safeNaturalAnswers()
    expect(generated).toHaveLength(323)

    for (const answer of generated) {
      const tool = createDirectorBrainTool({
        context: targetContext,
        service: responseService(answer),
      })
      const result = resultJson(await tool.execute('safe-natural-answer', {
        action: 'search', workId: 'WORK-HIDDEN', table: 'story_nodes', query: '人物',
      }))

      expect(result.responseContract.userVisibleAnswer).toBe(answer)
      expect(result.responseContract.userVisibleAnswer.length).toBeLessThanOrEqual(160)
    }
  })

  it('enforces at most three sentences and 160 characters', async () => {
    for (const answer of [
      '第一句。第二句。第三句。第四句。',
      '长'.repeat(161),
    ]) {
      const tool = createDirectorBrainTool({
        context: targetContext,
        service: responseService(answer),
      })
      const result = resultJson(await tool.execute('bounded-answer', {
        action: 'search', workId: 'WORK-HIDDEN', table: 'story_nodes', query: '叙事',
      }))
      expect(result.responseContract.userVisibleAnswer).toBe(failClosedAnswer)
    }
  })

  it('returns a no-fallback stop contract for every non-extraction service failure', async () => {
    const requests = [
      { action: 'health' },
      { action: 'resolve_work', query: '冰原纪事' },
      { action: 'get', workId: 'WORK-HIDDEN', table: 'story_nodes', stableId: 'STORY-HIDDEN' },
      { action: 'search', workId: 'WORK-HIDDEN', table: 'story_nodes', query: '冲突' },
      {
        action: 'assemble', workId: 'WORK-HIDDEN',
        references: { intentVersionId: 'INTENT-HIDDEN', evidenceIds: ['EVIDENCE-HIDDEN'] },
      },
      { action: 'workflow', workId: 'WORK-HIDDEN' },
      {
        action: 'propose', workId: 'WORK-HIDDEN', table: 'director_intents',
        fields: { '意图名称': '测试候选' },
      },
    ]

    for (const request of requests) {
      const service = vi.fn().mockRejectedValue(new Error(
        'record_id=recprivatevalue1 table_id=tblprivatevalue1 path=/Users/private token=hidden',
      ))
      const tool = createDirectorBrainTool({ context: targetContext, service })
      const result = resultJson(await tool.execute(`failure-${request.action}`, request))

      expect(service).toHaveBeenCalledTimes(1)
      expect(result).toMatchObject({
        ok: true,
        action: request.action,
        handled: true,
        responseContract: {
          mustQuoteUserVisibleAnswerExactly: true,
          doNotAddFacts: true,
          doNotExposeInternalIds: true,
          handled: true,
          stopAfterReply: true,
          doNotUseFallbackSources: true,
        },
      })
      expect(result.responseContract.userVisibleAnswer.length).toBeLessThanOrEqual(160)
      expect(JSON.stringify(result)).not.toMatch(/recprivate|tblprivate|\/Users\/private|hidden/iu)
    }
  })
})
