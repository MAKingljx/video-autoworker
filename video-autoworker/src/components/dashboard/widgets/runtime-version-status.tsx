'use client'

import { useCallback, useEffect, useState } from 'react'

type RuntimeStatus = {
  currentState: 'ready' | 'drift' | 'uninitialized' | 'unverifiable'
  sourceCommit?: string
  verifiedAt?: string
  route?: { generation: number; active?: string }
  components?: { control?: { sourceCommit?: string } }
}

/** Read the same production receipt as the release command; a Git checkout is not a release. */
export function RuntimeVersionStatus() {
  const [status, setStatus] = useState<RuntimeStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    setFailed(false)
    try {
      const response = await fetch('/api/runtime/current', { cache: 'no-store', signal })
      if (!response.ok) throw new Error('runtime_status_unavailable')
      const next = await response.json()
      if (!signal?.aborted) setStatus(next)
    } catch {
      if (!signal?.aborted) { setFailed(true); setStatus(null) }
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal)
    return () => controller.abort()
  }, [refresh])

  const label = loading ? '正在核对' : failed ? '暂时无法核对'
    : status?.currentState === 'ready' ? '已核对'
      : status?.currentState === 'uninitialized' ? '尚无发布记录'
        : status?.currentState === 'drift' ? '运行信息有变化' : '需要检查'
  return (
    <div className="border-t border-border pt-3 space-y-2" aria-label="生产版本">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="text-muted-foreground">生产版本</span>
        <button type="button" className="text-primary disabled:opacity-50" disabled={loading}
          onClick={() => void refresh()}>重新核对</button>
      </div>
      <div className="flex flex-wrap justify-between gap-2 text-xs" role="status">
        <span className={status?.currentState === 'ready' && !loading ? 'text-success' : 'text-muted-foreground'}>{label}</span>
        {status?.sourceCommit && <span className="font-mono" title={status.sourceCommit}>{status.sourceCommit.slice(0, 8)}</span>}
      </div>
      {status?.verifiedAt && <p className="text-2xs text-muted-foreground break-words">
        发布验收：{new Date(status.verifiedAt).toLocaleString('zh-CN')}
      </p>}
    </div>
  )
}
