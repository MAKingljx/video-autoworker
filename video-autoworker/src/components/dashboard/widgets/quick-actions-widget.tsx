'use client'

import {
  QuickAction,
  SpawnActionIcon,
  LogActionIcon,
  TaskActionIcon,
  MemoryActionIcon,
  SessionIcon,
  PipelineActionIcon,
  type DashboardData,
} from '../widget-primitives'

export function QuickActionsWidget({ data }: { data: DashboardData }) {
  const { isLocal, navigateToPanel } = data

  return (
    <section className="grid grid-cols-2 lg:grid-cols-5 gap-2">
      {!isLocal && <QuickAction label="创建智能体" desc="启动子智能体" tab="spawn" icon={<SpawnActionIcon />} onNavigate={navigateToPanel} />}
      <QuickAction label="查看日志" desc="实时查看器" tab="logs" icon={<LogActionIcon />} onNavigate={navigateToPanel} />
      <QuickAction label="任务看板" desc="流程与队列控制" tab="tasks" icon={<TaskActionIcon />} onNavigate={navigateToPanel} />
      <QuickAction label="记忆" desc="知识与召回" tab="memory" icon={<MemoryActionIcon />} onNavigate={navigateToPanel} />
      {isLocal
        ? <QuickAction label="OpenClaw 配置" desc="三套 profile 状态" tab="profiles" icon={<SessionIcon />} onNavigate={navigateToPanel} />
        : <QuickAction label="编排" desc="工作流与流水线" tab="agents" icon={<PipelineActionIcon />} onNavigate={navigateToPanel} />}
    </section>
  )
}
