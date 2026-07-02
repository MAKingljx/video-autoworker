'use client'

import { StatRow, formatBytes, type DashboardData } from '../widget-primitives'

export function MaintenanceWidget({ data }: { data: DashboardData }) {
  const { dbStats } = data

  return (
    <div className="panel">
      <div className="panel-header"><h3 className="text-sm font-semibold">维护与备份</h3></div>
      <div className="panel-body space-y-3">
        {dbStats?.backup ? (
          <>
            <StatRow label="最近备份" value={dbStats.backup.age_hours < 1 ? '1 小时内' : `${dbStats.backup.age_hours} 小时前`} alert={dbStats.backup.age_hours > 24} />
            <StatRow label="备份大小" value={formatBytes(dbStats.backup.size)} />
          </>
        ) : (
          <StatRow label="最近备份" value="无" alert />
        )}
        <StatRow label="活跃流水线" value={dbStats?.pipelines.active ?? 0} />
        <StatRow label="流水线运行（24 小时）" value={dbStats?.pipelines.recentDay ?? 0} />
      </div>
    </div>
  )
}
