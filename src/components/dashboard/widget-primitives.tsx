'use client'

import { Button } from '@/components/ui/button'

export interface DbStats {
  tasks: { total: number; byStatus: Record<string, number> }
  agents: { total: number; byStatus: Record<string, number> }
  audit: { day: number; week: number; loginFailures: number }
  activities: { day: number }
  notifications: { unread: number }
  pipelines: { active: number; recentDay: number }
  backup: { name: string; size: number; age_hours: number } | null
  dbSizeBytes: number
  webhookCount: number
}

export interface ClaudeStats {
  total_sessions: number
  active_sessions: number
  total_input_tokens: number
  total_output_tokens: number
  total_estimated_cost: number
  unique_projects: number
}

export type LogLike = {
  id: string
  timestamp: number
  level: 'info' | 'warn' | 'error' | 'debug'
  source: string
  message: string
}

export interface DashboardData {
  isLocal: boolean
  systemStats: any
  dbStats: DbStats | null
  claudeStats: ClaudeStats | null
  githubStats: any
  loading: { system: boolean; sessions: boolean; claude: boolean; github: boolean }
  sessions: any[]
  logs: any[]
  agents: any[]
  tasks: any[]
  connection: { isConnected: boolean; url: string; reconnectAttempts: number; latency?: number; sseConnected?: boolean }
  subscription: { type: string; provider?: string; rateLimitTier?: string } | null
  navigateToPanel: (tab: string) => void
  openSession: (session: any) => void
  // Pre-computed values
  memPct: number | null
  diskPct: number
  systemLoad: number
  activeSessions: number
  errorCount: number
  onlineAgents: number
  claudeActive: number
  codexActive: number
  hermesActive: number
  claudeLocalSessions: any[]
  codexLocalSessions: any[]
  hermesLocalSessions: any[]
  runningTasks: number
  inboxCount: number
  assignedCount: number
  reviewCount: number
  doneCount: number
  backlogCount: number
  mergedRecentLogs: LogLike[]
  recentErrorLogs: number
  // Health statuses
  localOsStatus: { value: string; status: 'good' | 'warn' | 'bad' }
  claudeHealth: { value: string; status: 'good' | 'warn' | 'bad' }
  codexHealth: { value: string; status: 'good' | 'warn' | 'bad' }
  hermesHealth: { value: string; status: 'good' | 'warn' | 'bad' }
  mcHealth: { value: string; status: 'good' | 'warn' | 'bad' }
  gatewayHealthStatus: 'good' | 'bad'
  // Loading states
  isSystemLoading: boolean
  isSessionsLoading: boolean
  isClaudeLoading: boolean
  isGithubLoading: boolean
  hermesCronJobCount: number
  // Subscription display
  subscriptionLabel: string | null
  subscriptionPrice: number | null
}

// --- Sub-components ---

export function MetricCard({ label, value, total, subtitle, icon, tone = 'neutral' }: {
  label: string
  value: number | string
  total?: number
  subtitle?: string
  icon: React.ReactNode
  tone?: 'neutral' | 'primary' | 'success' | 'warning' | 'danger'
}) {
  const toneMap = {
    neutral: { frame: 'border-border bg-card', accent: 'text-foreground' },
    primary: { frame: 'border-primary/25 bg-card', accent: 'text-primary' },
    success: { frame: 'border-success/25 bg-card', accent: 'text-success' },
    warning: { frame: 'border-warning/25 bg-card', accent: 'text-warning' },
    danger: { frame: 'border-destructive/25 bg-card', accent: 'text-destructive' },
  }
  const style = toneMap[tone]

  return (
    <div className={`rounded-lg border p-3.5 ${style.frame}`}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <div className={`w-5 h-5 opacity-75 ${style.accent}`}>{icon}</div>
      </div>
      <div className="flex items-baseline gap-1">
        <span className={`text-2xl font-bold font-mono-tight ${style.accent}`}>{value}</span>
        {total != null && <span className="text-xs text-muted-foreground font-mono-tight">/ {total}</span>}
      </div>
      {subtitle && <div className="text-2xs text-muted-foreground font-mono-tight mt-0.5">{subtitle}</div>}
    </div>
  )
}

export function SignalPill({ label, value, tone }: {
  label: string
  value: string
  tone: 'neutral' | 'primary' | 'success' | 'warning' | 'danger'
}) {
  const toneMap = {
    neutral: { frame: 'border-border bg-secondary/35', value: 'text-foreground' },
    primary: { frame: 'border-primary/25 bg-secondary/35', value: 'text-primary' },
    success: { frame: 'border-success/25 bg-secondary/35', value: 'text-success' },
    warning: { frame: 'border-warning/25 bg-secondary/35', value: 'text-warning' },
    danger: { frame: 'border-destructive/25 bg-secondary/35', value: 'text-destructive' },
  }
  const style = toneMap[tone]

  return (
    <div className={`rounded-lg border px-2.5 py-2 ${style.frame}`}>
      <div className="text-2xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`text-xs font-semibold font-mono-tight truncate ${style.value}`}>{value}</div>
    </div>
  )
}

export function HealthRow({ label, value, status, bar }: {
  label: string
  value: string
  status: 'good' | 'warn' | 'bad'
  bar?: number
}) {
  const statusColor = status === 'good' ? 'text-green-400' : status === 'warn' ? 'text-amber-400' : 'text-red-400'

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className={`text-xs font-medium font-mono-tight ${statusColor}`}>{value}</span>
      </div>
      {bar != null && (
        <div className="h-1 rounded-full bg-secondary overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${bar > 90 ? 'bg-red-500' : bar > 70 ? 'bg-amber-500' : 'bg-green-500'}`}
            style={{ width: `${Math.min(bar, 100)}%` }}
          />
        </div>
      )}
    </div>
  )
}

export function StatRow({ label, value, alert }: { label: string; value: number | string; alert?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={`text-xs font-medium font-mono-tight ${alert ? 'text-red-400' : 'text-muted-foreground'}`}>
        {value}
      </span>
    </div>
  )
}

export function LogRow({ log }: { log: LogLike }) {
  return (
    <div className="px-4 py-2 hover:bg-secondary/30 transition-smooth">
      <div className="flex items-start gap-2">
        <div className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${
          log.level === 'error' ? 'bg-red-500' :
          log.level === 'warn' ? 'bg-amber-500' :
          log.level === 'debug' ? 'bg-gray-500' :
          'bg-primary/50'
        }`} />
        <div className="flex-1 min-w-0">
          <p className="text-xs text-foreground/80 break-words">{log.message.length > 100 ? log.message.slice(0, 100) + '...' : log.message}</p>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className="text-2xs text-muted-foreground font-mono-tight">{log.source}</span>
            <span className="text-2xs text-muted-foreground/40">·</span>
            <span className="text-2xs text-muted-foreground">{new Date(log.timestamp).toLocaleTimeString()}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

export function QuickAction({ label, desc, tab, icon, onNavigate }: {
  label: string
  desc: string
  tab: string
  icon: React.ReactNode
  onNavigate: (tab: string) => void
}) {
  return (
    <Button
      variant="outline"
      onClick={() => onNavigate(tab)}
      className="flex items-center gap-3 p-3 h-auto rounded-lg hover:border-primary/30 hover:bg-primary/5 text-left group justify-start"
    >
      <div className="w-8 h-8 rounded-md bg-secondary flex items-center justify-center shrink-0 group-hover:bg-primary/10 transition-smooth">
        <div className="w-4 h-4 text-muted-foreground group-hover:text-primary transition-smooth">{icon}</div>
      </div>
      <div>
        <div className="text-xs font-medium text-foreground">{label}</div>
        <div className="text-2xs text-muted-foreground">{desc}</div>
      </div>
    </Button>
  )
}

// --- Helper functions ---

export function formatUptime(ms: number): string {
  const hours = Math.floor(ms / (1000 * 60 * 60))
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days} 天 ${hours % 24} 小时`
  return `${hours} 小时`
}

export function formatTokensShort(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`
  return String(n)
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
}

export function getProviderHealth(active: number, total: number): { value: string; status: 'good' | 'warn' | 'bad' } {
  if (total === 0) return { value: '暂无会话', status: 'warn' }
  if (active > 0) return { value: `${active} 个活跃`, status: 'good' }
  return { value: `空闲（${total}）`, status: 'warn' }
}

export function getLocalOsStatus(memPct: number | null, diskPct: number | null): { value: string; status: 'good' | 'warn' | 'bad' } {
  if (memPct == null && diskPct == null) return { value: '未知', status: 'bad' }
  const maxPct = Math.max(memPct ?? 0, diskPct ?? 0)
  if (maxPct >= 95) return { value: '严重', status: 'bad' }
  if (maxPct >= 80) return { value: '降级', status: 'warn' }
  return { value: '正常', status: 'good' }
}

export function getMcHealth(systemStats: any, dbStats: DbStats | null, errorCount: number): { value: string; status: 'good' | 'warn' | 'bad' } {
  if (!systemStats || !dbStats) return { value: '不可用', status: 'bad' }
  if (errorCount > 0) return { value: `${errorCount} 个错误`, status: 'warn' }
  return { value: '正常', status: 'good' }
}

// --- SVG Icons ---

export function SessionIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M2 3h12v9H2zM5 12v2M11 12v2M4 14h8" />
    </svg>
  )
}

export function AgentIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <circle cx="8" cy="5" r="3" />
      <path d="M2 14c0-3.3 2.7-6 6-6s6 2.7 6 6" />
    </svg>
  )
}

export function GatewayIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M2 8h3M11 8h3M5 5l3-3 3 3M5 11l3 3 3-3" />
      <circle cx="8" cy="8" r="2" />
    </svg>
  )
}

export function ActivityIconMini() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M2 9h2l1.4-3.5L8.2 12l2-5H14" />
    </svg>
  )
}

export function TaskIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <rect x="2" y="1" width="12" height="14" rx="1.5" />
      <path d="M5 5h6M5 8h6M5 11h3" />
    </svg>
  )
}

export function SpawnActionIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M8 2v12M8 2l-3 3M8 2l3 3" />
    </svg>
  )
}

export function LogActionIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M3 2h10a1 1 0 011 1v10a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1z" />
      <path d="M5 5h6M5 8h6M5 11h3" />
    </svg>
  )
}

export function TaskActionIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <rect x="2" y="1" width="12" height="14" rx="1.5" />
      <path d="M5 5l2 2 3-3" />
      <path d="M5 10h6" />
    </svg>
  )
}

export function MemoryActionIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <ellipse cx="8" cy="8" rx="6" ry="3" />
      <path d="M2 8v3c0 1.7 2.7 3 6 3s6-1.3 6-3V8" />
    </svg>
  )
}

export function PipelineActionIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <circle cx="3" cy="8" r="2" />
      <circle cx="13" cy="4" r="2" />
      <circle cx="13" cy="12" r="2" />
      <path d="M5 7l6-2M5 9l6 2" />
    </svg>
  )
}

export function TokenIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4v8M5 6h6M5 10h6" />
    </svg>
  )
}

export function CostIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <circle cx="8" cy="8" r="6" />
      <path d="M8 3.5V5M8 11v1.5M10.5 6.5C10.5 5.4 9.4 4.5 8 4.5S5.5 5.4 5.5 6.5c0 1.1 1.1 2 2.5 2s2.5.9 2.5 2c0 1.1-1.1 2-2.5 2s-2.5-.9-2.5-2" />
    </svg>
  )
}
