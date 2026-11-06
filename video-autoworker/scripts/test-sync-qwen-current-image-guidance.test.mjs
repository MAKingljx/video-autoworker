import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  END,
  START,
  applyImageGuidance,
  planImageGuidance,
  replaceImageGuidance,
} from './sync-qwen-current-image-guidance.mjs'

const template = '## 图片任务（H1 统一图片服务）\n\n只使用新的图片工具。'
const legacy = [
  '# Workspace',
  '',
  '## 图片生成（本地 SDXL + diffusers）',
  '',
  'curl old-local-service',
  '',
  '## 记忆目录映射',
  '',
  '保留内容。',
].join('\n')

test('replaces only the legacy image guidance section and preserves neighboring workspace content', () => {
  const result = replaceImageGuidance(legacy, template)
  assert.match(result, /^# Workspace/m)
  assert.match(result, new RegExp(START.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')))
  assert.match(result, /只使用新的图片工具/u)
  assert.match(result, /## 记忆目录映射\n\n保留内容。/u)
  assert.doesNotMatch(result, /curl old-local-service/u)
})

test('updates an existing managed block without changing unrelated workspace text', () => {
  const source = `# Workspace\n\n${START}\nold guidance\n${END}\n\n## Other\nkeep\n`
  const result = replaceImageGuidance(source, template)
  assert.match(result, /# Workspace/u)
  assert.match(result, /## Other\nkeep/u)
  assert.match(result, /只使用新的图片工具/u)
  assert.doesNotMatch(result, /old guidance/u)
})

test('apply creates one recoverable backup and rejects concurrent source drift', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qwen-image-guidance-'))
  const workspace = join(root, 'workspace')
  const backupDir = join(root, 'backups')
  const agents = join(workspace, 'AGENTS.md')
  try {
    await (await import('node:fs/promises')).mkdir(workspace, { recursive: true })
    await writeFile(agents, legacy, { mode: 0o600 })
    const plan = planImageGuidance({ workspace, template })
    assert.equal(plan.changed, true)
    const applied = applyImageGuidance({ workspace, template, backupDir })
    assert.equal(applied.currentState, 'APPLIED')
    assert.ok(applied.backup)
    assert.equal(await readFile(applied.backup, 'utf8'), legacy)
    assert.equal(planImageGuidance({ workspace, template }).changed, false)
    assert.equal(applyImageGuidance({ workspace, template, backupDir }).currentState, 'ALREADY_CURRENT')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('managed template tells qwen-current to use strict typed video-cover actions', async () => {
  const source = await readFile(new URL('../ops/openclaw/qwen-current-image-guidance.md', import.meta.url), 'utf8')
  assert.match(source, /aiworker_video_cover_read_directory/u)
  assert.match(source, /aiworker_video_cover_get_candidates/u)
  assert.match(source, /aiworker_video_cover_submit_protected/u)
  assert.match(source, /aiworker_video_cover_task/u)
  assert.match(source, /tool_search/u)
  assert.match(source, /tool_call/u)
  assert.doesNotMatch(source, /aiworker_video_cover_workflow|aiworker_video_cover_frames|aiworker_submit_protected_cover_from_frame/u)
})
