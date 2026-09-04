import assert from 'node:assert/strict'
import test from 'node:test'

import {
  GENERAL_COMPACTION_ANCHORS,
  GENERAL_COMPACTION_OMNIBUS_PROMPT,
  GENERAL_COMPACTION_TURN_PROMPTS,
  generalCompactionSeedMessages,
  missingGeneralCompactionAnchors,
  validatesGeneralCompactionAnswer,
} from './lib/openclaw-general-compaction-anchors.mjs'

const omnibusAnswer = [
  '导演原理从证据走向人物与故事、判断与叙事、案例与技法；',
  '编程事项是缓存键冲突，以租户前缀修复并保留回归测试；',
  '运维计划在周六零点先备份再灰度，失败回滚；',
  '蓝鲸是哺乳动物并用肺呼吸；',
  '河流治理依次是上游减排、中游监测、下游修复；',
  '任务下一步先做接口契约测试，再更新变更记录。',
].join('')

test('defines six distinct general-compaction anchor classes', () => {
  assert.equal(GENERAL_COMPACTION_ANCHORS.length, 6)
  assert.equal(new Set(GENERAL_COMPACTION_ANCHORS.map(anchor => anchor.id)).size, 6)
  assert.equal(generalCompactionSeedMessages().length, 12)
  assert.equal(GENERAL_COMPACTION_TURN_PROMPTS.length, 8)
  assert.equal(GENERAL_COMPACTION_TURN_PROMPTS[0], GENERAL_COMPACTION_OMNIBUS_PROMPT)
  assert.equal(GENERAL_COMPACTION_TURN_PROMPTS[1], GENERAL_COMPACTION_OMNIBUS_PROMPT)
})

test('requires all six anchors in both two-turn omnibus answers', () => {
  assert.equal(validatesGeneralCompactionAnswer(omnibusAnswer, 0), true)
  assert.equal(validatesGeneralCompactionAnswer(omnibusAnswer, 1), true)
  assert.deepEqual(missingGeneralCompactionAnchors(omnibusAnswer, 0), [])
  assert.deepEqual(
    missingGeneralCompactionAnchors(omnibusAnswer.replace('租户前缀', '隔离前缀'), 0),
    ['ordinary-programming'],
  )
})

test('validates each category independently across turns three through eight', () => {
  GENERAL_COMPACTION_ANCHORS.forEach((anchor, index) => {
    assert.equal(validatesGeneralCompactionAnswer(anchor.assistant, index + 2), true)
    assert.deepEqual(missingGeneralCompactionAnchors(anchor.assistant, index + 2), [])
  })
})
