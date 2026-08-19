import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const CONTRACT_PATHS = [
  'openclaw-skills/aiworker-task-flow/SKILL.md',
  'openclaw-skills/aiworker-task-flow/WORKSPACE_VIDEO_RULES.md',
  'openclaw-skills/aiworker-task-flow/WORKSPACE_VIDEO_MEMORY.md',
]

describe('short natural-language result defaults', () => {
  it.each(CONTRACT_PATHS)('%s keeps the same read-only lookup contract', async path => {
    const text = await readFile(resolve(path), 'utf8')
    const compact = text.replace(/\s+/gu, ' ')

    expect(text).toContain('查 S03E03 分析')
    expect(text).toContain('result')
    expect(compact).toMatch(/(?:最小|smallest)/u)
    expect(compact).toMatch(/(?:标题|title|季集|season\/episode)/u)
    expect(compact).toMatch(/(?:completedAt|完成时间|completion)/u)
    expect(compact).toMatch(/(?:最新|latest|newest)/u)
    expect(compact).toMatch(/(?:taskId|task ID|任务 ID|任务编号)/u)
    expect(compact).toMatch(/(?:中文|Chinese)/u)
    expect(compact).toMatch(/(?:一句|一句话|one-sentence)/u)
  })
})
