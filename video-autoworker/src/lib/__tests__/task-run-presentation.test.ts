import { describe, expect, it } from 'vitest'
import {
  formatTaskRunDuration,
  formatTaskRunProcessingDuration,
  formatTaskRunQueueDuration,
  taskRunDurationBasis,
  taskRunDurationSeconds,
  taskRunFailureInsight,
  taskRunProcessingDurationSeconds,
  taskRunQueueDurationSeconds,
} from '@/lib/task-run-presentation'

describe('task run presentation', () => {
  it('uses creation time for total duration even when the parent starts at finalization', () => {
    const run = {
      status: 'failed',
      createdAt: 100,
      acceptedAt: 101,
      startedAt: 3_901,
      processingStartedAt: 200,
      completedAt: 3_901,
      updatedAt: 3_901,
    }
    expect(taskRunDurationSeconds(run, 4_000)).toBe(3_801)
    expect(formatTaskRunDuration(run, 4_000)).toBe('1 小时 3 分')
    expect(taskRunDurationBasis(run)).toContain('任务创建')
  })

  it('shows live elapsed time for accepted and running tasks', () => {
    const run = {
      status: 'accepted',
      createdAt: 100,
      acceptedAt: 110,
      startedAt: null,
      processingStartedAt: null,
      completedAt: null,
      updatedAt: 110,
    }
    expect(formatTaskRunDuration(run, 175)).toBe('1 分 15 秒')
    expect(formatTaskRunQueueDuration(run, 175)).toBe('1 分 15 秒')
    expect(formatTaskRunProcessingDuration(run, 175)).toBe('—')
  })

  it('separates queue waiting from actual processing time', () => {
    const run = {
      status: 'succeeded',
      createdAt: 100,
      acceptedAt: 101,
      startedAt: 900,
      processingStartedAt: 220,
      completedAt: 1_000,
      updatedAt: 1_000,
    }
    expect(taskRunQueueDurationSeconds(run, 1_100)).toBe(120)
    expect(taskRunProcessingDurationSeconds(run, 1_100)).toBe(780)
    expect(formatTaskRunQueueDuration(run, 1_100)).toBe('2 分 0 秒')
    expect(formatTaskRunProcessingDuration(run, 1_100)).toBe('13 分 0 秒')
  })

  it('never renders a legitimate sub-second task as zero seconds', () => {
    const run = {
      status: 'failed',
      createdAt: 100,
      acceptedAt: 100,
      startedAt: null,
      processingStartedAt: 100,
      completedAt: 100,
      updatedAt: 100,
    }
    expect(formatTaskRunDuration(run, 100)).toBe('< 1 秒')
  })

  it('classifies missing sources and failed model requests', () => {
    expect(taskRunFailureInsight("prepare: ENOENT: no such file or directory, realpath '[路径]'")).toMatchObject({
      stage: '素材准备',
      title: '源视频不可访问',
    })
    expect(taskRunFailureInsight('vision: fetch failed')).toMatchObject({
      stage: '画面分析',
      title: '画面分析请求中断',
    })
  })

  it('recognizes failed prerequisites without changing task state', () => {
    expect(taskRunFailureInsight('finalize: 音频分析节点尚未成功完成')).toMatchObject({
      stage: '结果合并',
      title: '语音分析未完成',
    })
  })
})
