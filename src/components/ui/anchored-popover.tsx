'use client'

import { type ReactNode, useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'

interface AnchoredPopoverProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  trigger: ReactNode
  children: ReactNode
  ariaLabel: string
  className?: string
  panelClassName?: string
}

/**
 * Lightweight anchored popover for header actions and compact menus.
 * The panel is absolutely positioned, so opening it never shifts page layout.
 */
export function AnchoredPopover({
  open,
  onOpenChange,
  trigger,
  children,
  ariaLabel,
  className,
  panelClassName,
}: AnchoredPopoverProps) {
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return

    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        onOpenChange(false)
      }
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onOpenChange(false)
      }
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [onOpenChange, open])

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      {trigger}
      {open && (
        <div
          role="dialog"
          aria-label={ariaLabel}
          className={cn(
            'absolute right-0 top-full z-[70] mt-2 overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl',
            panelClassName,
          )}
        >
          {children}
        </div>
      )}
    </div>
  )
}
