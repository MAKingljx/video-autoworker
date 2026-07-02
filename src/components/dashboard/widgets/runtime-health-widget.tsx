'use client'

import { HealthRow, formatUptime, type DashboardData } from '../widget-primitives'

export function RuntimeHealthWidget({ data }: { data: DashboardData }) {
  const { localOsStatus, connection, sessions, isSessionsLoading, mcHealth, memPct, systemStats } = data
  const qwenSessions = sessions.filter((session) => {
    const text = `${session.model || ''} ${session.key || ''} ${session.agent || ''}`.toLowerCase()
    return text.includes('qwen') || text.includes('千问') || text.includes('default_model')
  })
  const qwenActive = qwenSessions.filter((session) => session.active).length
  const qwenStatus =
    isSessionsLoading
      ? { value: '加载中...', status: 'warn' as const }
      : qwenSessions.length > 0
        ? { value: `${qwenActive}/${qwenSessions.length} 活跃`, status: qwenActive > 0 ? 'good' as const : 'warn' as const }
        : { value: '等待会话', status: 'warn' as const }

  return (
    <div className="panel">
      <div className="panel-header"><h3 className="text-sm font-semibold">本地运行健康</h3></div>
      <div className="panel-body space-y-3">
        <HealthRow label="OpenClaw 网关" value={connection.isConnected ? '在线' : '离线'} status={connection.isConnected ? 'good' : 'bad'} />
        <HealthRow label="本地千问" value={qwenStatus.value} status={qwenStatus.status} />
        <HealthRow label="本地系统" value={localOsStatus.value} status={localOsStatus.status} />
        <HealthRow label="控制中心核心" value={mcHealth.value} status={mcHealth.status} />
        {memPct != null && <HealthRow label="内存" value={`${memPct}%`} status={memPct > 90 ? 'bad' : memPct > 70 ? 'warn' : 'good'} bar={memPct} />}
        {systemStats?.disk && <HealthRow label="磁盘" value={systemStats.disk.usage || '无数据'} status={parseInt(systemStats.disk.usage) > 90 ? 'bad' : 'good'} />}
        {systemStats?.uptime != null && <HealthRow label="运行时间" value={formatUptime(systemStats.uptime)} status="good" />}
      </div>
    </div>
  )
}
