'use client'

interface AgentAvatarProps {
  name: string
  size?: 'xs' | 'sm' | 'md'
  className?: string
}

function getInitials(name: string): string {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)

  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return `${parts[0][0] || ''}${parts[1][0] || ''}`.toUpperCase()
}

const sizeClasses: Record<NonNullable<AgentAvatarProps['size']>, string> = {
  xs: 'w-5 h-5 text-[10px]',
  sm: 'w-6 h-6 text-[10px]',
  md: 'w-8 h-8 text-xs',
}

export function AgentAvatar({ name, size = 'sm', className = '' }: AgentAvatarProps) {
  const initials = getInitials(name)

  return (
    <div
      className={`rounded-full border border-primary/20 bg-primary/10 text-primary flex items-center justify-center font-semibold shrink-0 ${sizeClasses[size]} ${className}`}
      title={name}
      aria-label={name}
    >
      {initials}
    </div>
  )
}
