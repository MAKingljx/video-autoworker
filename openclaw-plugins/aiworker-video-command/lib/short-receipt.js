import { normalizeVideoTaskResult } from './video-task-result.js'

export function formatShortReceipt(result, expectedTaskId) {
  const normalized = normalizeVideoTaskResult(result, expectedTaskId)
  const prefix = normalized.duplicate ? '任务已存在' : '已提交'
  return `${prefix}，任务编号：${normalized.taskId}。结果请稍后查询。`
}
