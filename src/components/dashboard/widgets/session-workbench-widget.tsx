'use client'

import type { DashboardData } from '../widget-primitives'

export function SessionWorkbenchWidget({ data }: { data: DashboardData }) {
  const { isLocal, sessions, isSessionsLoading, openSession } = data
  const visibleSessions = sessions.filter((session) => !['claude-code', 'codex-cli', 'hermes'].includes(String(session.kind || '')))

  return (
    <div className="panel">
      <div className="panel-header">
        <h3 className="text-sm font-semibold">{isLocal ? '会话工作台' : '会话路由'}</h3>
        <span className="text-2xs text-muted-foreground font-mono-tight">{visibleSessions.length}</span>
      </div>
      <div className="divide-y divide-border/50 max-h-80 overflow-y-auto">
        {visibleSessions.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <p className="text-xs text-muted-foreground">
              {isSessionsLoading
                ? '正在加载会话...'
                : isLocal
                  ? '暂无活跃会话'
                  : '暂无网关会话'}
            </p>
            <p className="text-2xs text-muted-foreground/60 mt-1">
              {isLocal
                ? 'OpenClaw 或本地千问会话会显示在这里。'
                : '网关智能体连接后，会话会显示在这里。'}
            </p>
          </div>
        ) : (
          visibleSessions.slice(0, 10).map((session) => {
            const sessionText = `${session.model || ''} ${session.key || ''} ${session.agent || ''}`.toLowerCase()
            const runtimeLabel = sessionText.includes('qwen') || sessionText.includes('default_model') ? '本地千问' : 'OpenClaw'
            return (
            <div key={session.id} className="px-4 py-2.5 hover:bg-secondary/20 transition-smooth">
              <button
                type="button"
                onClick={() => openSession(session)}
                className="w-full text-left flex items-center gap-3"
              >
                <div className={`w-2 h-2 rounded-full shrink-0 ${session.active ? 'bg-green-500' : 'bg-muted-foreground/30'}`} />
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium truncate font-mono-tight">{session.key || session.id}</div>
                  <div className="text-2xs text-muted-foreground">
                    {runtimeLabel} · {session.model?.split('/').pop() || '未知'}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-2xs font-mono-tight text-muted-foreground">{session.tokens}</div>
                  <div className="text-2xs text-muted-foreground">{session.age}</div>
                </div>
              </button>
            </div>
          )})
        )}
      </div>
    </div>
  )
}
