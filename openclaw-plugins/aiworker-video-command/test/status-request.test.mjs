import { describe, expect, it } from 'vitest'

import { parseStatusRequest } from '../lib/status-request.js'

const TASK_ID = `video-natural-${'a'.repeat(64)}`
const OTHER_TASK_ID = `video-command-${'b'.repeat(64)}`

describe('parseStatusRequest', () => {
  it.each([
    '查进度',
    '查一下进度',
    '现在查询一下任务进度',
    '查看状态',
    '查一下结果',
    '查一下刚才的视频',
    '查询上次提交的视频',
    '这个视频结果出来了吗',
    '刚才的视频分析完了吗',
    '上次的视频好了没',
  ])('recognizes a bounded recent-task query: %s', content => {
    expect(parseStatusRequest(content)).toEqual({ kind: 'match', taskId: null })
  })

  it.each([
    `查询任务${TASK_ID}状态`,
    `查询任务 ${TASK_ID} 的状态`,
    `查一下 ${TASK_ID} 的进度`,
    `查一下 ${TASK_ID} 的结果`,
    `任务 ${TASK_ID} 状态查询`,
  ])('extracts one complete plugin-issued task id: %s', content => {
    expect(parseStatusRequest(content)).toEqual({ kind: 'match', taskId: TASK_ID })
  })

  it.each([
    '查询任务video-natural-abc状态',
    `查询 ${TASK_ID}x 状态`,
    `查询 x${TASK_ID} 状态`,
    `查询 ${TASK_ID} 和 ${OTHER_TASK_ID} 的状态`,
  ])('fails closed when the task id is incomplete or ambiguous: %s', content => {
    expect(parseStatusRequest(content)).toEqual({ kind: 'needs_task_id' })
  })

  it.each([
    '查\n进度',
    '查询任务\0video-natural-abc状态',
    `查询任务${TASK_ID}\u007f状态`,
  ])('rejects control characters instead of normalizing and executing: %s', content => {
    expect(parseStatusRequest(content)).toEqual({ kind: 'invalid' })
  })

  it.each([
    '你好',
    '这个任务编号是什么意思',
    TASK_ID,
    '分析视频编码原理',
    '查询订单进度',
  ])('does not claim unrelated text: %s', content => {
    expect(parseStatusRequest(content)).toEqual({ kind: 'unmatched' })
  })
})
