'use client'

import { LogRow, type DashboardData } from '../widget-primitives'

export function EventStreamWidget({ data }: { data: DashboardData }) {
  const { isLocal, mergedRecentLogs, recentErrorLogs, isSessionsLoading } = data

  return (
    <div className="panel">
      <div className="panel-header">
        <h3 className="text-sm font-semibold">{isLocal ? '本地事件流' : '事件流'}</h3>
        <span className="text-2xs text-muted-foreground font-mono-tight">
          {isLocal ? mergedRecentLogs.length : `${recentErrorLogs} 个错误`}
        </span>
      </div>
      <div className="divide-y divide-border/50 max-h-80 overflow-y-auto">
        {mergedRecentLogs.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <p className="text-xs text-muted-foreground">
              {isSessionsLoading ? '正在加载日志...' : '暂无日志'}
            </p>
            <p className="text-2xs text-muted-foreground/60 mt-1">
              {isLocal ? 'OpenClaw 与本地千问事件会在这里流式显示。' : '网关事件和告警会在这里流式显示。'}
            </p>
          </div>
        ) : (
          mergedRecentLogs.map((log) => <LogRow key={log.id} log={log} />)
        )}
      </div>
    </div>
  )
}
