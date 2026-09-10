import assert from 'node:assert/strict'
import test from 'node:test'

import {
  paginateVideoReport,
  selectFinalVideoReport,
} from '../lib/video-result-page.mjs'

test('final report prefers summary and falls back to combinedText only when needed', () => {
  assert.deepEqual(selectFinalVideoReport({
    summary: '最终学习报告',
    combinedText: '不应作为首选',
  }), {
    source: 'summary',
    text: '最终学习报告',
  })
  assert.deepEqual(selectFinalVideoReport({ combinedText: '逐分钟证据' }), {
    source: 'combinedText',
    text: '逐分钟证据',
  })
})

test('report pages preserve UTF-8 character boundaries and stable offsets', () => {
  const first = paginateVideoReport('A地B', 0, 4)
  assert.deepEqual(first, {
    text: 'A地',
    offset: 0,
    nextOffset: 4,
    totalBytes: 5,
  })
  assert.deepEqual(paginateVideoReport('A地B', first.nextOffset, 4), {
    text: 'B',
    offset: 4,
    nextOffset: null,
    totalBytes: 5,
  })
  assert.throws(() => paginateVideoReport('A地B', 2, 4), /有效边界/u)
})
