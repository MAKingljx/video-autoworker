'use client'

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface WorkspaceNavigationItem<Id extends string> {
  id: Id
  label: string
  count?: number
}

export function WorkspaceSplitLayout<Id extends string>({
  title,
  navigationLabel,
  items,
  activeItem,
  onSelect,
  sidebarContent,
  children,
  className,
  contentClassName,
}: {
  title: string
  navigationLabel: string
  items: WorkspaceNavigationItem<Id>[]
  activeItem: Id
  onSelect: (id: Id) => void
  sidebarContent?: ReactNode
  children: ReactNode
  className?: string
  contentClassName?: string
}) {
  return (
    <div className="@container min-h-0" data-workspace-container>
      <div
        data-workspace-layout="split"
        className={cn(
          'grid min-h-0 grid-cols-1 overflow-hidden rounded-lg border border-border bg-card @4xl:grid-cols-[220px_minmax(0,1fr)]',
          className,
        )}
      >
        <aside
          data-workspace-sidebar
          className="min-w-0 border-b border-border bg-card @4xl:min-h-0 @4xl:border-b-0 @4xl:border-r"
        >
          <div className="p-3 @4xl:flex @4xl:h-full @4xl:min-h-0 @4xl:flex-col">
            <h1 className="px-1 text-lg font-semibold text-foreground">{title}</h1>
            <nav
              aria-label={navigationLabel}
              className="mt-3 flex min-w-0 gap-1 overflow-x-auto pb-1 @4xl:flex-none @4xl:flex-col @4xl:overflow-visible @4xl:pb-0"
            >
              {items.map(item => {
                const active = item.id === activeItem
                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-current={active ? 'page' : undefined}
                    onClick={() => onSelect(item.id)}
                    className={cn(
                      'flex min-w-max items-center justify-between gap-3 rounded-md border px-3 py-2 text-left text-sm font-medium transition-colors @4xl:w-full @4xl:min-w-0',
                      active
                        ? 'border-primary/35 bg-primary/10 text-primary'
                        : 'border-transparent text-muted-foreground hover:border-border hover:bg-secondary hover:text-foreground',
                    )}
                  >
                    <span className="truncate">{item.label}</span>
                    {typeof item.count === 'number' && (
                      <span className="flex-none rounded border border-border bg-background/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {item.count}
                      </span>
                    )}
                  </button>
                )
              })}
            </nav>
            {sidebarContent && (
              <div className="mt-3 min-h-0 border-t border-border pt-3 @4xl:flex-1 @4xl:overflow-y-auto">
                {sidebarContent}
              </div>
            )}
          </div>
        </aside>

        <div
          data-workspace-content
          className={cn('min-h-0 min-w-0 bg-background', contentClassName)}
        >
          {children}
        </div>
      </div>
    </div>
  )
}
