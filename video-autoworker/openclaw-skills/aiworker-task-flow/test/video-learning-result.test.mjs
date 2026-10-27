import assert from 'node:assert/strict'
import test from 'node:test'
import { buildVideoLearningResult, hasPartialVideoLearning, readVideoLearningResult, videoLearningDisplayState } from '../lib/video-learning-result.mjs'

const issue = { index: 3, timeRange: '00:00:10-00:00:15', stage: 'vision', errorCode: 'N8N_MEDIA_MODEL_OUTPUT_INVALID' }
test('coverage counts failed original indexes once and preserves separate failed phases', () => {
  const result = buildVideoLearningResult(5, [{ ...issue, stage: 'summary' }, issue])
  assert.equal(result.completedSegments, 4)
  assert.equal(result.status, 'partial')
  assert.equal(result.failedSegments.length, 2)
  assert.deepEqual(readVideoLearningResult({ learningResult: result }), result)
  assert.equal(videoLearningDisplayState('succeeded', { learningResult: result }), 'partial')
  assert.equal(videoLearningDisplayState('running', { learningResult: result }), 'running')
})
test('historical outputs keep existing semantics while malformed coverage fails closed', () => {
  assert.equal(readVideoLearningResult({ summary: '历史内容' }), null)
  assert.equal(hasPartialVideoLearning({ summary: '历史内容' }), false)
  assert.equal(readVideoLearningResult({ learningResult: buildVideoLearningResult(3, []) }).status, 'complete')
  for (const value of [null, {}, { ...buildVideoLearningResult(5, [issue]), status: 'complete' },
    { ...buildVideoLearningResult(5, [issue]), completedSegments: 5 },
    { ...buildVideoLearningResult(5, [issue]), unexpected: true }]) {
    assert.throws(() => readVideoLearningResult({ learningResult: value }), /video_learning_result_invalid/u)
    assert.equal(hasPartialVideoLearning({ learningResult: value }), true)
    assert.equal(videoLearningDisplayState('succeeded', { learningResult: value }), 'learning_invalid')
  }
})
test('coverage rejects duplicate phases, out-of-range indexes and unsafe diagnostics', () => {
  for (const rows of [[issue, issue], [{ ...issue, index: 6 }], [{ ...issue, errorCode: 'raw error text' }],
    [{ ...issue, timeRange: 'bad\nrange' }], [{ ...issue, stage: 'finalize' }], [{ ...issue, prompt: 'private' }]]) {
    assert.throws(() => buildVideoLearningResult(5, rows), /video_learning_result_invalid/u)
  }
  assert.throws(() => buildVideoLearningResult(0, []), /video_learning_result_invalid/u)
})
