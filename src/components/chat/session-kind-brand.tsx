'use client'

type SessionKind = 'claude-code' | 'codex-cli' | 'hermes' | 'gateway'

const SESSION_KIND_META: Record<SessionKind, {
  label: string
  shortLabel: string
  pillClassName: string
}> = {
  'claude-code': {
    label: '本地会话',
    shortLabel: '本地',
    pillClassName: 'bg-secondary text-muted-foreground',
  },
  'codex-cli': {
    label: '本地会话',
    shortLabel: '本地',
    pillClassName: 'bg-secondary text-muted-foreground',
  },
  hermes: {
    label: '本地会话',
    shortLabel: '本地',
    pillClassName: 'bg-secondary text-muted-foreground',
  },
  gateway: {
    label: 'OpenClaw',
    shortLabel: 'OC',
    pillClassName: 'bg-muted text-muted-foreground',
  },
}

function getMeta(kind: string) {
  return SESSION_KIND_META[(kind in SESSION_KIND_META ? kind : 'gateway') as SessionKind]
}

export function getSessionKindLabel(kind: string): string {
  return getMeta(kind).label
}

export function SessionKindAvatar({
  kind,
  fallback,
  sizeClassName = 'w-7 h-7',
}: {
  kind: string
  fallback: string
  sizeClassName?: string
}) {
  const meta = getMeta(kind)

  return (
    <div
      className={`${sizeClassName} rounded-full bg-surface-2 flex items-center justify-center text-[10px] font-bold text-muted-foreground shrink-0`}
      title={meta.label}
      aria-label={meta.label}
    >
      {fallback}
    </div>
  )
}

export function SessionKindPill({ kind }: { kind: string }) {
  const meta = getMeta(kind)

  return (
    <span className={`rounded px-1 py-px text-[9px] font-medium ${meta.pillClassName}`}>
      {meta.shortLabel}
    </span>
  )
}
