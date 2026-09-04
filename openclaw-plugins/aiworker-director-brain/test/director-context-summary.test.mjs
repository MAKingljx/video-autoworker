import { describe, expect, it } from 'vitest'

import {
  buildDirectorContextSummary,
} from '../lib/director-context-summary.js'

const FORBIDDEN = [
  'credentialReference',
  'apiKey',
  'authorization',
  'connectionString',
  'sessionCookie',
  'privateKey',
  'secretStoreReference',
  'password',
  'sk-local-mock-never-emit-1234567890',
  'Bearer local-mock-authorization-never-emit',
  'task-vaw-canary-20260904-0001',
  '550e8400-e29b-41d4-a716-446655440000',
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  'recSyntheticCanary001',
  'tblSyntheticCanary001',
  'director_run_state_internal_001',
  'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456',
  'AKIAIOSFODNN7EXAMPLE',
  'director@example.test',
  '13800138000',
  'directorSessionCheckpoint20260904',
]

function toolResult(payload) {
  return {
    role: 'toolResult',
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  }
}

function expectSafe(summary) {
  expect(summary).toContain('## Decisions')
  expect(summary).toContain('## Open TODOs')
  expect(summary).toContain('## Constraints/Rules')
  expect(summary).toContain('## Pending user asks')
  expect(summary).toContain('## Exact identifiers\nNone.')
  for (const marker of FORBIDDEN) expect(summary).not.toContain(marker)
}

describe('director context persistence summary', () => {
  it('keeps the director semantics and drops complete private subtrees', () => {
    const summary = buildDirectorContextSummary({
      messages: [
        toolResult({
          observations: [{
            person: '小林',
            conflict: '村民质疑水质数据。',
            action: '小林重新采样并与村民共同验证。',
            emotion: '从笃定转为克制和倾听。',
            directorJudgment: '这是人物从自证走向共识的转折。',
            unresolvedQuestions: ['重新检测能否恢复信任？'],
            privateMetadata: {
              credentialReference: FORBIDDEN[0],
              apiKey: FORBIDDEN[8],
              authorization: FORBIDDEN[9],
              internalIdentifiers: FORBIDDEN.slice(10),
            },
          }],
        }),
        { role: 'user', content: [{ type: 'text', text: '这个转折为什么值得放进故事？' }] },
      ],
    })

    expect(summary).toContain('小林')
    expect(summary).toContain('村民质疑水质数据')
    expect(summary).toContain('重新采样')
    expect(summary).toContain('从自证走向共识的转折')
    expect(summary).toContain('重新检测能否恢复信任')
    expect(summary).toContain('这个转折为什么值得放进故事')
    expectSafe(summary)
  })

  it('re-distills prior checkpoints without carrying opaque identifiers forward', () => {
    const summary = buildDirectorContextSummary({
      previousSummary: `## Decisions\n- 人物从抗拒转为倾听。\n- ${FORBIDDEN[10]}\n\n## Open TODOs\n- 对方是否会接受复核？\n\n## Constraints/Rules\n- 受导演意图中“克制”的约束。\n\n## Pending user asks\n- 判断这个镜头的情绪价值。\n\n## Exact identifiers\n${FORBIDDEN[12]}`,
      messages: [],
    })

    expect(summary).toContain('人物从抗拒转为倾听')
    expect(summary).toContain('对方是否会接受复核')
    expect(summary).toContain('受导演意图中“克制”的约束')
    expect(summary).toContain('判断这个镜头的情绪价值')
    expectSafe(summary)
  })

  it('drops user-visible runtime failure cards instead of learning them as director knowledge', () => {
    const summary = buildDirectorContextSummary({
      messages: [
        {
          role: 'assistant',
          content: [{
            type: 'text',
            text: '智能体无法生成响应。上下文内容过多，自动压缩功能无法恢复本轮对话。代理：second-original｜模型：default_model｜服务商：qwen38-local',
          }],
        },
        {
          role: 'user',
          content: [{ type: 'text', text: '导演脑提炼技法的底层逻辑是什么？' }],
        },
      ],
    })

    expect(summary).not.toMatch(/智能体无法生成响应|上下文内容过多|自动压缩|second-original|default_model|qwen38-local/u)
    expect(summary).toContain('导演脑提炼技法的底层逻辑是什么')
    expectSafe(summary)
  })

  it('never traverses an untrusted parent to recover an allowlisted child', () => {
    const summary = buildDirectorContextSummary({
      messages: [toolResult({
        person: '小林',
        privateMetadata: { person: '不得穿透的人物' },
        credential: { conflict: '不得穿透的冲突' },
        internalIdentifiers: { story: '不得穿透的故事' },
      })],
    })

    expect(summary).toContain('小林')
    expect(summary).not.toContain('不得穿')
    expectSafe(summary)
  })

  it('does not split a surrogate pair at the summary boundary', () => {
    const summary = buildDirectorContextSummary({
      messages: [toolResult({
        observations: Array.from({ length: 128 }, (_, index) => ({
          story: `人物选择共同验证${index}🎬`.repeat(20),
        })),
      })],
    })
    const finalCodeUnit = summary.charCodeAt(summary.length - 1)
    expect(finalCodeUnit < 0xD800 || finalCodeUnit > 0xDBFF).toBe(true)
    expect(summary.length).toBeLessThanOrEqual(12_000)
  })

  it('rejects the complete fragment before truncation can hide a secret suffix', () => {
    const longFragment = `人物决定重新验证，${'这是已审核的叙事事实'.repeat(45)} ${FORBIDDEN[16]}`
    const summary = buildDirectorContextSummary({
      messages: [toolResult({ story: longFragment })],
    })

    expect(summary).not.toContain('人物决定重新验证')
    expectSafe(summary)
  })

  it('drops GitHub tokens, AWS keys, emails, phone numbers, and camelCase internal IDs', () => {
    for (const marker of FORBIDDEN.slice(16)) {
      const summary = buildDirectorContextSummary({
        messages: [toolResult({ story: `人物的故事变化与 ${marker} 无关。` })],
      })
      expect(summary).not.toContain('人物的故事变化')
      expectSafe(summary)
    }
  })

  it('does not treat unrelated user or assistant prose as reusable director semantics', () => {
    const summary = buildDirectorContextSummary({
      messages: [
        { role: 'assistant', content: [{ type: 'text', text: '今天天气很好，记得喝水。' }] },
        { role: 'user', content: [{ type: 'text', text: '请问现在几点？' }] },
      ],
    })

    expect(summary).not.toMatch(/天气|喝水|几点/u)
    expectSafe(summary)
  })

  it('prioritizes recent narrative evidence over a full older checkpoint section', () => {
    const oldFacts = Array.from({ length: 40 }, (_, index) => `- 旧故事判断 ${index + 1}。`).join('\n')
    const summary = buildDirectorContextSummary({
      previousSummary: `## Decisions\n${oldFacts}`,
      messages: [toolResult({
        story: '最新故事证据显示小林选择与村民共同验证。',
      })],
    })

    expect(summary).toContain('最新故事证据')
    expect((summary.match(/## Decisions/gu) || [])).toHaveLength(1)
    expect((summary.match(/## Exact identifiers/gu) || [])).toHaveLength(1)
    expect(summary.endsWith('## Exact identifiers\nNone.')).toBe(true)
    expect(summary.length).toBeLessThanOrEqual(12_000)
    expectSafe(summary)
  })

  it.each(Array.from({ length: 48 }, (_, seed) => seed))(
    'is stable across shuffled private-field layouts (seed %i)',
    (seed) => {
      const privateEntries = [
        ['credentialReference', FORBIDDEN[0]],
        ['apiKey', FORBIDDEN[8]],
        ['authorization', FORBIDDEN[9]],
        ['recordId', FORBIDDEN[14]],
      ]
      privateEntries.sort(([left], [right]) => (
        ((left.charCodeAt(seed % left.length) + seed) % 7)
        - ((right.charCodeAt(seed % right.length) + seed) % 7)
      ))
      const summary = buildDirectorContextSummary({
        messages: [toolResult({
          story: `第 ${seed + 1} 次复核依然显示人物选择重新采样。`,
          conflict: '事实与自我判断发生冲突。',
          change: '人物从坚持转为公开验证。',
          privateMetadata: Object.fromEntries(privateEntries),
        })],
      })
      expect(summary).toContain('人物选择重新采样')
      expect(summary).toContain('事实与自我判断发生冲突')
      expect(summary).toContain('从坚持转为公开验证')
      expectSafe(summary)
    },
  )

  it('returns a non-empty fail-closed summary for malformed and cyclic input', async () => {
    const cyclic = { role: 'toolResult', content: [] }
    cyclic.details = cyclic
    const summary = buildDirectorContextSummary({ messages: [null, cyclic, 7] })

    expect(summary.length).toBeGreaterThan(100)
    expectSafe(summary)
  })

  it('fails closed when cumulative traversal exceeds the node budget', async () => {
    const messages = Array.from({ length: 512 }, (_, messageIndex) => ({
      role: 'assistant',
      content: Array.from({ length: 128 }, (_, contentIndex) => ({
        type: 'text',
        text: `人物故事观察 ${messageIndex}-${contentIndex}。`,
      })),
    }))
    const summary = buildDirectorContextSummary({ messages })

    expect(summary).toContain('暂无可安全复用的导演语义')
    expectSafe(summary)
  })

  it('checks cancellation during traversal loops', async () => {
    let checks = 0
    const signal = {
      throwIfAborted() {
        checks += 1
        if (checks > 100) throw new Error('cancelled-during-traversal')
      },
    }
    const messages = Array.from({ length: 200 }, () => ({
      role: 'assistant',
      content: [{ type: 'text', text: '人物故事与冲突发生变化。' }],
    }))

    expect(() => buildDirectorContextSummary({ messages, signal }))
      .toThrow('cancelled-during-traversal')
    expect(checks).toBeGreaterThan(100)
  })

  it('propagates cancellation instead of entering the built-in fallback path', async () => {
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    expect(() => buildDirectorContextSummary({
      messages: [],
      signal: controller.signal,
    })).toThrow('cancelled')
  })
})
