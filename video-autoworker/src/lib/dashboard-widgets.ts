export interface DashboardWidget {
  id: string
  label: string
  description: string
  category: 'health' | 'sessions' | 'tasks' | 'metrics' | 'integrations' | 'events'
  modes: ('local' | 'full')[]
  defaultSize: 'sm' | 'md' | 'lg' | 'full'
  component: string
}

export const WIDGET_CATALOG: DashboardWidget[] = [
  {
    id: 'metric-cards',
    label: '关键指标',
    description: '会话、负载、Token 与成本概览',
    category: 'metrics',
    modes: ['local', 'full'],
    defaultSize: 'full',
    component: 'MetricCardsWidget',
  },
  {
    id: 'runtime-health',
    label: '运行健康',
    description: '本地系统、OpenClaw、千问执行节点与控制中心核心健康',
    category: 'health',
    modes: ['local'],
    defaultSize: 'md',
    component: 'RuntimeHealthWidget',
  },
  {
    id: 'gateway-health',
    label: '网关健康',
    description: '网关关键指标：流量、错误与饱和度',
    category: 'health',
    modes: ['full'],
    defaultSize: 'md',
    component: 'GatewayHealthWidget',
  },
  {
    id: 'session-workbench',
    label: '会话工作台',
    description: '带活动状态的实时会话列表',
    category: 'sessions',
    modes: ['local', 'full'],
    defaultSize: 'md',
    component: 'SessionWorkbenchWidget',
  },
  {
    id: 'event-stream',
    label: '事件流',
    description: '汇总所有来源的日志流',
    category: 'events',
    modes: ['local', 'full'],
    defaultSize: 'md',
    component: 'EventStreamWidget',
  },
  {
    id: 'task-flow',
    label: '任务流',
    description: '任务状态统计：收件箱、已分配、进行中、审核、完成',
    category: 'tasks',
    modes: ['local', 'full'],
    defaultSize: 'sm',
    component: 'TaskFlowWidget',
  },
  {
    id: 'github-signal',
    label: 'GitHub 信号',
    description: 'GitHub 仓库统计：Issue、Stars 与仓库数',
    category: 'integrations',
    modes: ['local'],
    defaultSize: 'sm',
    component: 'GithubSignalWidget',
  },
  {
    id: 'security-audit',
    label: '安全与审计',
    description: '审计事件、登录失败与通知',
    category: 'events',
    modes: ['full'],
    defaultSize: 'sm',
    component: 'SecurityAuditWidget',
  },
  {
    id: 'maintenance',
    label: '维护与备份',
    description: '备份状态与流水线健康',
    category: 'health',
    modes: ['full'],
    defaultSize: 'sm',
    component: 'MaintenanceWidget',
  },
  {
    id: 'quick-actions',
    label: '快捷操作',
    description: '跳转到关键面板的快捷入口',
    category: 'sessions',
    modes: ['local', 'full'],
    defaultSize: 'full',
    component: 'QuickActionsWidget',
  },
]

export const LOCAL_DEFAULT_LAYOUT = [
  'metric-cards',
  'runtime-health',
  'session-workbench',
  'event-stream',
  'task-flow',
  'github-signal',
  'quick-actions',
]

export const GATEWAY_DEFAULT_LAYOUT = [
  'metric-cards',
  'gateway-health',
  'session-workbench',
  'event-stream',
  'task-flow',
  'security-audit',
  'maintenance',
  'quick-actions',
]

export function getDefaultLayout(mode: 'local' | 'full'): string[] {
  return mode === 'local' ? LOCAL_DEFAULT_LAYOUT : GATEWAY_DEFAULT_LAYOUT
}

export function getWidgetById(id: string): DashboardWidget | undefined {
  return WIDGET_CATALOG.find((w) => w.id === id)
}

export function getAvailableWidgets(mode: 'local' | 'full'): DashboardWidget[] {
  return WIDGET_CATALOG.filter((w) => w.modes.includes(mode))
}
