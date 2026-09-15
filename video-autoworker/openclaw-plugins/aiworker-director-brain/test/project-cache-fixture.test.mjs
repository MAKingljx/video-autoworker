import { describe, expect, it } from 'vitest'

import { buildProjectCacheFixture } from '../../../scripts/qwen38/project-cache-fixture.mjs'

describe('project cache freshness fixture', () => {
  it('reads the source on every call with no-store, including unchanged repeats', async () => {
    const fixture = await buildProjectCacheFixture()
    expect(fixture.readCount).toBe(5)
    expect(fixture.noStoreVerified).toBe(true)
    expect(fixture.cases.map(item => item.label)).toEqual([
      'v1', 'v1_repeat', 'v2', 'v2_repeat', 'candidate',
    ])
    expect(fixture.cases[0].toolResult).toEqual(fixture.cases[1].toolResult)
    expect(fixture.cases[2].toolResult).toEqual(fixture.cases[3].toolResult)
  })

  it('returns the updated content and version without changing work or node identity', async () => {
    const { cases } = await buildProjectCacheFixture()
    const initial = cases[0].toolResult.record
    const updated = cases[2].toolResult.record
    expect(initial.fields).toMatchObject({
      '节点内容': '当前主要冲突是信任。', '版本': 'v0.2.0',
    })
    expect(updated.fields).toMatchObject({
      '节点内容': '当前主要冲突是资源分配。', '版本': 'v0.2.1',
    })
    expect(updated.stableId).toBe(initial.stableId)
    expect(updated.fields['作品 ID']).toBe(initial.fields['作品 ID'])
    expect(updated.fields['更新时间']).toBeGreaterThan(initial.fields['更新时间'])
    expect(cases.slice(0, 4).every(item => item.toolResult.record.reviewed)).toBe(true)
    expect(JSON.stringify(cases)).not.toContain('fixture-record-not-returned')
    expect(JSON.stringify(cases)).not.toContain('unused-fixture-token')
  })

  it('keeps a subsequently unreviewed candidate distinguishable from approved facts', async () => {
    const { cases } = await buildProjectCacheFixture()
    const candidate = cases[4]
    expect(candidate.expectedReviewed).toBe(false)
    expect(candidate.toolResult.record).toMatchObject({
      state: '候选', reviewed: false,
      fields: { '节点内容': '当前主要冲突是资源分配。', '版本': 'v0.2.1' },
    })
    expect(cases[3].toolResult.record.reviewed).toBe(true)
  })
})
