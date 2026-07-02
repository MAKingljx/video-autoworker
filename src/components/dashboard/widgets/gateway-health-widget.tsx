'use client'

import { HealthRow, type DashboardData } from '../widget-primitives'

export function GatewayHealthWidget({ data }: { data: DashboardData }) {
  const { connection, sessions, errorCount, backlogCount, memPct, systemStats, gatewayHealthStatus } = data

  return (
    <div className="panel">
      <div className="panel-header"><h3 className="text-sm font-semibold">网关健康与关键指标</h3></div>
      <div className="panel-body space-y-3">
        <HealthRow label="网关" value={connection.isConnected ? '已连接' : '已断开'} status={gatewayHealthStatus} />
        <HealthRow label="流量（会话）" value={`${sessions.length}`} status={sessions.length > 0 ? 'good' : 'warn'} />
        <HealthRow label="错误（24 小时）" value={`${errorCount}`} status={errorCount > 0 ? 'warn' : 'good'} />
        <HealthRow label="饱和度（队列）" value={`${backlogCount}`} status={backlogCount > 16 ? 'bad' : backlogCount > 8 ? 'warn' : 'good'} />
        {memPct != null && <HealthRow label="内存" value={`${memPct}%`} status={memPct > 90 ? 'bad' : memPct > 70 ? 'warn' : 'good'} bar={memPct} />}
        {systemStats?.disk && <HealthRow label="磁盘" value={systemStats.disk.usage || '无数据'} status={parseInt(systemStats.disk.usage) > 90 ? 'bad' : 'good'} />}
      </div>
    </div>
  )
}
