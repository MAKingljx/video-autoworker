export interface TaskRunTiming {
  status: string
  createdAt: number
  acceptedAt: number | null
  startedAt: number | null
  completedAt: number | null
  updatedAt: number
}

const ACTIVE_STATUSES = new Set(['queued', 'accepted', 'running'])

function finiteTimestamp(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null
}

export function taskRunDurationSeconds(
  run: TaskRunTiming,
  nowSeconds = Math.floor(Date.now() / 1_000),
): number | null {
  const start = finiteTimestamp(run.startedAt)
    ?? finiteTimestamp(run.acceptedAt)
    ?? finiteTimestamp(run.createdAt)
  if (start === null) return null

  const end = finiteTimestamp(run.completedAt)
    ?? (ACTIVE_STATUSES.has(run.status)
      ? finiteTimestamp(nowSeconds)
      : finiteTimestamp(run.updatedAt))
  if (end === null) return null
  return Math.max(0, end - start)
}

export function formatTaskRunDuration(
  run: TaskRunTiming,
  nowSeconds = Math.floor(Date.now() / 1_000),
): string {
  const seconds = taskRunDurationSeconds(run, nowSeconds)
  if (seconds === null) return '—'
  if (seconds < 1) return '< 1 秒'
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return `${hours} 小时 ${remainingMinutes} 分`
}

export function taskRunDurationBasis(run: TaskRunTiming): string {
  const suffix = ACTIVE_STATUSES.has(run.status) && !run.completedAt ? '至今' : '到结束'
  if (run.startedAt) return `执行开始${suffix}`
  if (run.acceptedAt) return `任务接收${suffix}（顶层任务未单独记录开始时间）`
  return `任务创建${suffix}（缺少接收与开始时间）`
}

export interface TaskRunFailureInsight {
  stage: string
  title: string
  detail: string
  suggestion: string
}

const STAGE_LABELS: Record<string, string> = {
  prepare: '素材准备',
  audio: '语音分析',
  vision: '画面分析',
  finalize: '结果合并',
}

export function taskRunFailureInsight(error: string | null): TaskRunFailureInsight | null {
  const value = String(error || '').trim()
  if (!value) return null
  const match = /^(prepare|audio|vision|finalize):\s*(.*)$/i.exec(value)
  const stageKey = match?.[1]?.toLowerCase() || ''
  const detail = (match?.[2] || value).trim()
  const stage = STAGE_LABELS[stageKey] || '任务执行'
  const normalized = detail.toLowerCase()

  if (normalized.includes('enoent') || normalized.includes('no such file') || normalized.includes('realpath')) {
    return {
      stage,
      title: '源视频不可访问',
      detail,
      suggestion: '源文件已移动、删除或路径失效；再次分析前先确认原片仍在原位置。',
    }
  }
  if (normalized.includes('尚未成功完成')) {
    const dependency = detail.includes('音频') ? '语音分析' : detail.includes('画面') ? '画面分析' : '前置节点'
    return {
      stage,
      title: `${dependency}未完成`,
      detail,
      suggestion: '最终合并已被安全阻止；先确认前置节点的真实终态和错误，再决定是否重新执行。',
    }
  }
  if (normalized.includes('fetch failed')) {
    const title = stageKey === 'vision'
      ? '画面分析请求中断'
      : stageKey === 'audio'
        ? '语音分析请求中断'
        : stageKey === 'finalize'
          ? '最终汇总请求中断'
          : '节点请求中断'
    return {
      stage,
      title,
      detail,
      suggestion: '检查对应模型服务、网络和超时记录；已有成功前置结果时应优先复用，避免整片重复计算。',
    }
  }
  return {
    stage,
    title: '任务执行失败',
    detail,
    suggestion: '查看失败阶段与原始错误，确认输入和依赖状态后再决定处理方式。',
  }
}
