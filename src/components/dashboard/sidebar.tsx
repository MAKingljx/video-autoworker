'use client'

import Image from 'next/image'
import { useEffect, useState } from 'react'
import { useMissionControl } from '@/store'
import { useNavigateToPanel } from '@/lib/navigation'
import { createClientLogger } from '@/lib/client-logger'
import { Button } from '@/components/ui/button'

const log = createClientLogger('Sidebar')

type SystemStats = {
  memory?: {
    used: number
    total: number
  }
  disk?: {
    usage?: string
  }
  processes?: unknown[]
}

function readSystemStats(value: unknown): SystemStats | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const memory = record.memory && typeof record.memory === 'object' ? record.memory as Record<string, unknown> : null
  const disk = record.disk && typeof record.disk === 'object' ? record.disk as Record<string, unknown> : null

  return {
    memory: memory && typeof memory.used === 'number' && typeof memory.total === 'number'
      ? { used: memory.used, total: memory.total }
      : undefined,
    disk: disk
      ? { usage: typeof disk.usage === 'string' ? disk.usage : undefined }
      : undefined,
    processes: Array.isArray(record.processes) ? record.processes : undefined,
  }
}

interface MenuItem {
  id: string
  label: string
  icon: string
  description?: string
}

const menuItems: MenuItem[] = [
  { id: 'overview', label: '概览', icon: '📊', description: '系统仪表盘' },
  { id: 'tasks', label: '任务看板', icon: '📋', description: '看板式任务管理' },
  { id: 'agents', label: '智能体编队', icon: '🤖', description: '智能体管理与状态' },
  { id: 'activity', label: '活动流', icon: '📣', description: '实时活动流' },
  { id: 'notifications', label: '通知', icon: '🔔', description: '提及与告警' },
  { id: 'standup', label: '每日站会', icon: '📈', description: '生成站会报告' },
  { id: 'spawn', label: '创建智能体', icon: '🚀', description: '启动新的子智能体' },
  { id: 'logs', label: '日志', icon: '📝', description: '实时日志查看器' },
  { id: 'cron', label: 'Cron 任务', icon: '⏰', description: '自动化任务' },
  { id: 'memory', label: '记忆', icon: '🧠', description: '知识浏览器' },
  { id: 'tokens', label: 'Tokens', icon: '💰', description: '用量与成本追踪' },
  { id: 'channels', label: '频道', icon: '📡', description: '消息平台状态' },
  { id: 'nodes', label: '节点', icon: '🖥', description: '已连接实例' },
  { id: 'exec-approvals', label: '审批', icon: '✅', description: '执行审批队列' },
  { id: 'debug', label: '调试', icon: '🐛', description: '系统诊断' },
]

export function Sidebar() {
  const { activeTab, connection, sessions } = useMissionControl()
  const navigateToPanel = useNavigateToPanel()
  const [systemStats, setSystemStats] = useState<SystemStats | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/status?action=overview')
      .then(res => res.json())
      .then(data => { if (!cancelled) setSystemStats(readSystemStats(data)) })
      .catch(err => log.error('Failed to fetch system status:', err))
    return () => { cancelled = true }
  }, [])

  const activeSessions = sessions.filter(s => s.active).length
  const totalSessions = sessions.length

  return (
    <aside className="w-64 bg-card border-r border-border flex flex-col">
      {/* Logo/Brand */}
      <div className="p-6 border-b border-border">
        <div className="flex items-center space-x-2">
          <div className="w-8 h-8 rounded-lg overflow-hidden bg-background border border-border/50 flex items-center justify-center">
            <Image
              src="/brand/mc-logo-128.png"
              alt="Mission Control logo"
              width={32}
              height={32}
              className="w-full h-full object-cover"
            />
          </div>
          <div>
            <h2 className="font-bold text-foreground">Mission Control</h2>
            <p className="text-xs text-muted-foreground">ClawdBot 编排</p>
          </div>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-4 overflow-y-auto">
        <ul className="space-y-2">
          {menuItems.map((item) => (
            <li key={item.id}>
              <Button
                variant={activeTab === item.id ? 'default' : 'ghost'}
                onClick={() => navigateToPanel(item.id)}
                className={`w-full flex items-start space-x-3 px-3 py-3 h-auto rounded-lg text-left justify-start group ${
                  activeTab === item.id
                    ? 'shadow-sm'
                    : ''
                }`}
                title={item.description}
              >
                <span className="text-lg mt-0.5">{item.icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="font-medium">{item.label}</div>
                  <div className={`text-xs mt-0.5 ${
                    activeTab === item.id
                      ? 'text-primary-foreground/80'
                      : 'text-muted-foreground group-hover:text-foreground/70'
                  }`}>
                    {item.description}
                  </div>
                </div>
              </Button>
            </li>
          ))}
        </ul>
      </nav>

      {/* Status Footer */}
      <div className="p-4 border-t border-border space-y-3">
        {/* Connection Status */}
        <div className="bg-secondary rounded-lg p-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-foreground">网关</span>
            <div className="flex items-center space-x-1">
              <div className={`w-2 h-2 rounded-full ${
                connection.isConnected 
                  ? 'bg-green-500 animate-pulse' 
                  : 'bg-red-500'
              }`}></div>
              <span className="text-xs text-muted-foreground">
                {connection.isConnected ? '已连接' : '已断开'}
              </span>
            </div>
          </div>
            <div className="mt-2 space-y-1">
              <div className="text-xs text-muted-foreground">
                {connection.url || 'ws://<gateway-host>:<gateway-port>'}
              </div>
              {connection.latency && (
                <div className="text-xs text-muted-foreground">
                  延迟：{connection.latency}ms
                </div>
            )}
          </div>
        </div>

        {/* Session Stats */}
        <div className="bg-secondary rounded-lg p-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-foreground">会话</span>
            <span className="text-xs text-muted-foreground">
              {activeSessions}/{totalSessions}
            </span>
          </div>
          <div className="mt-2 text-xs text-muted-foreground">
            {activeSessions} 活跃 • {totalSessions - activeSessions} 空闲
          </div>
        </div>

        {/* System Stats */}
        {systemStats && (
          <div className="bg-secondary rounded-lg p-3">
            <div className="text-sm font-medium text-foreground mb-2">系统</div>
            <div className="space-y-1 text-xs text-muted-foreground">
              <div className="flex justify-between">
                <span>内存：</span>
                <span>{systemStats.memory ? Math.round((systemStats.memory.used / systemStats.memory.total) * 100) : 0}%</span>
              </div>
              <div className="flex justify-between">
                <span>磁盘：</span>
                <span>{systemStats.disk?.usage || '无数据'}</span>
              </div>
              <div className="flex justify-between">
                <span>进程：</span>
                <span>{systemStats.processes?.length || 0}</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </aside>
  )
}
