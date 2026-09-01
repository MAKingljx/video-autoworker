import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_DIRECTOR_WORK_LENGTH,
  assertOptionalDirectorWork,
  isDirectorWork,
} from '../lib/director-work-policy.mjs'

test('director work policy accepts one canonical work name across task-flow consumers', () => {
  assert.equal(isDirectorWork('导演脑验收片'), true)
  assert.equal(isDirectorWork('作'.repeat(MAX_DIRECTOR_WORK_LENGTH)), true)
  assert.equal(assertOptionalDirectorWork('导演脑验收片'), '导演脑验收片')
  assert.equal(assertOptionalDirectorWork(undefined), undefined)
  assert.equal(assertOptionalDirectorWork(null), null)
})

test('director work policy rejects empty, padded, oversized and control-character values', () => {
  for (const value of ['', ' 导演脑', '导演脑 ', '作'.repeat(MAX_DIRECTOR_WORK_LENGTH + 1), '导演\n脑']) {
    assert.equal(isDirectorWork(value), false)
    assert.throws(() => assertOptionalDirectorWork(value), /director_work_invalid/u)
  }
})
