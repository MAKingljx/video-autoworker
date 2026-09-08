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
import { selectGatewayConnection } from '@/lib/gateway-connection-state'

export function MetricCardsWidget({ data }: { data: DashboardData }) {
  const {
    isLocal,
    isSessionsLoading,
    sessionsUnavailable,
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
  const gateway = selectGatewayConnection(connection)
  const gatewayValue = gateway.state === 'online' ? '在线' : gateway.state === 'checking' ? '检查中' : '离线'
  const gatewayTone = gateway.state === 'online' ? 'success' : gateway.state === 'checking' ? 'warning' : 'danger'
  const sessionValue = sessionsUnavailable ? '暂不可用' : activeSessions
  const sessionTotal = sessionsUnavailable ? undefined : sessions.length

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
          value={gatewayValue}
          subtitle="网关服务"
          icon={<GatewayIcon />}
          tone={gatewayTone}
        />
        <MetricCard label="本地千问" value={sessionsUnavailable ? '暂不可用' : isSessionsLoading ? '...' : qwenActive} total={sessionsUnavailable || isSessionsLoading ? undefined : qwenSessions.length} subtitle="当前运行时内" icon={<SessionIcon />} tone={sessionsUnavailable ? 'warning' : 'neutral'} />
        <MetricCard label="会话" value={sessionValue} total={sessionTotal} subtitle={sessionsUnavailable ? '会话读取暂不可用' : '默认运行时会话'} icon={<SessionIcon />} tone={sessionsUnavailable ? 'warning' : 'neutral'} />
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
      <MetricCard label="网关" value={gatewayValue} subtitle="服务状态" icon={<GatewayIcon />} tone={gatewayTone} />
      <MetricCard label="会话" value={sessionValue} total={sessionTotal} subtitle={sessionsUnavailable ? '会话读取暂不可用' : '默认运行时会话'} icon={<SessionIcon />} tone={sessionsUnavailable ? 'warning' : 'neutral'} />
      <MetricCard label="智能体容量" value={onlineAgents} subtitle={`${dbStats?.agents.total ?? agents.length} 总数`} icon={<AgentIcon />} />
      <MetricCard label="队列" value={backlogCount} subtitle={`${runningTasks} 运行中`} icon={<TaskIcon />} tone={backlogCount > 12 ? 'danger' : 'neutral'} />
      <MetricCard label="系统负载" value={isSystemLoading ? '...' : `${systemLoad}%`} subtitle={`错误 ${errorCount}`} icon={<ActivityIconMini />} tone={systemLoad > 85 || errorCount > 0 ? 'danger' : systemLoad > 70 ? 'warning' : 'neutral'} />
    </section>
  )
}
