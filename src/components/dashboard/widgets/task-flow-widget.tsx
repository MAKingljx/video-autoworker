'use client'

import { StatRow, type DashboardData } from '../widget-primitives'

export function TaskFlowWidget({ data }: { data: DashboardData }) {
  const { inboxCount, assignedCount, runningTasks, reviewCount, doneCount, backlogCount } = data

  return (
    <div className="panel">
      <div className="panel-header"><h3 className="text-sm font-semibold">任务流</h3></div>
      <div className="panel-body grid grid-cols-2 gap-3">
        <StatRow label="收件箱" value={inboxCount} />
        <StatRow label="已分配" value={assignedCount} />
        <StatRow label="进行中" value={runningTasks} />
        <StatRow label="待审核" value={reviewCount} />
        <StatRow label="已完成" value={doneCount} />
        <StatRow label="积压" value={backlogCount} alert={backlogCount > 12} />
      </div>
    </div>
  )
}
