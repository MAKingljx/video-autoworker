'use client'

import {
  MetricCard,
  SessionIcon,
  GatewayIcon,
  AgentIcon,
  TaskIcon,
  ActivityIconMini,
  type DashboardData,
} from '../widget-primitives'

export function MetricCardsWidget({ data }: { data: DashboardData }) {
  const {
    isLocal,
    isSessionsLoading,
    isSystemLoading,
    systemLoad,
    memPct,
    diskPct,
    connection,
    activeSessions,
    sessions,
    onlineAgents,
    dbStats,
    agents,
    backlogCount,
    runningTasks,
    errorCount,
  } = data

  if (isLocal) {
    const qwenSessions = sessions.filter((session) => {
      const text = `${session.model || ''} ${session.key || ''} ${session.agent || ''}`.toLowerCase()
      return text.includes('qwen') || text.includes('千问') || text.includes('default_model')
    })
    const qwenActive = qwenSessions.filter((session) => session.active).length

    return (
      <section className="grid grid-cols-2 xl:grid-cols-5 gap-3">
        <MetricCard
          label="OpenClaw"
          value={connection.isConnected ? '在线' : '离线'}
          subtitle="网关连接"
          icon={<GatewayIcon />}
          tone={connection.isConnected ? 'success' : 'danger'}
        />
        <MetricCard label="本地千问" value={isSessionsLoading ? '...' : qwenActive} total={isSessionsLoading ? undefined : qwenSessions.length} subtitle="活跃 / 总数" icon={<SessionIcon />} />
        <MetricCard label="会话" value={activeSessions} total={sessions.length} subtitle="OpenClaw 会话" icon={<SessionIcon />} />
        <MetricCard
          label="系统负载"
          value={isSystemLoading ? '...' : `${systemLoad}%`}
          subtitle={`内存 ${memPct ?? '-'} · 磁盘 ${Number.isFinite(diskPct) ? `${diskPct}%` : '-'}`}
          icon={<ActivityIconMini />}
          tone={systemLoad > 85 ? 'danger' : systemLoad > 70 ? 'warning' : 'neutral'}
        />
        <MetricCard label="队列" value={backlogCount} subtitle={`${runningTasks} 运行中`} icon={<TaskIcon />} tone={backlogCount > 12 || errorCount > 0 ? 'danger' : 'neutral'} />
      </section>
    )
  }

  return (
    <section className="grid grid-cols-2 xl:grid-cols-5 gap-3">
      <MetricCard label="网关" value={connection.isConnected ? '在线' : '离线'} subtitle="传输状态" icon={<GatewayIcon />} tone={connection.isConnected ? 'success' : 'danger'} />
      <MetricCard label="会话" value={activeSessions} total={sessions.length} subtitle="活跃 / 总数" icon={<SessionIcon />} />
      <MetricCard label="智能体容量" value={onlineAgents} subtitle={`${dbStats?.agents.total ?? agents.length} 总数`} icon={<AgentIcon />} />
      <MetricCard label="队列" value={backlogCount} subtitle={`${runningTasks} 运行中`} icon={<TaskIcon />} tone={backlogCount > 12 ? 'danger' : 'neutral'} />
      <MetricCard label="系统负载" value={isSystemLoading ? '...' : `${systemLoad}%`} subtitle={`错误 ${errorCount}`} icon={<ActivityIconMini />} tone={systemLoad > 85 || errorCount > 0 ? 'danger' : systemLoad > 70 ? 'warning' : 'neutral'} />
    </section>
  )
}
