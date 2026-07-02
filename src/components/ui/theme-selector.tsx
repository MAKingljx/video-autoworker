'use client'

import { useTheme } from 'next-themes'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'

export function ThemeSelector() {
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  // Keep this local console intentionally limited to two GitHub-style backgrounds.
  useEffect(() => {
    if (mounted && theme !== 'github-dark' && theme !== 'github-light') {
      setTheme('github-dark')
    }
  }, [mounted, theme, setTheme])

  if (!mounted) {
    return <div className="w-8 h-8 rounded-md bg-secondary animate-pulse" />
  }

  const isDark = theme !== 'github-light'

  return (
    <Button
      onClick={() => setTheme(isDark ? 'github-light' : 'github-dark')}
      variant="ghost"
      size="icon-sm"
      title={isDark ? '切换到白色背景' : '切换到 GitHub 黑色背景'}
      aria-label={isDark ? '切换到白色背景' : '切换到 GitHub 黑色背景'}
      className={isDark ? 'text-amber-300 hover:text-amber-200' : 'text-muted-foreground hover:text-foreground'}
    >
      <LightbulbIcon lit={isDark} />
    </Button>
  )
}

function LightbulbIcon({ lit }: { lit: boolean }) {
  return (
    <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5.5 13.5h5" />
      <path d="M6.25 15h3.5" />
      <path d="M8 1.5a4.6 4.6 0 0 0-2.7 8.3c.7.5 1.1 1.2 1.1 2v.2h3.2v-.2c0-.8.4-1.5 1.1-2A4.6 4.6 0 0 0 8 1.5Z" fill={lit ? 'currentColor' : 'none'} fillOpacity={lit ? 0.22 : 0} />
      {lit && (
        <>
          <path d="M8 .5v-.5" />
          <path d="M2.6 3.1 2.1 2.6" />
          <path d="M13.4 3.1 13.9 2.6" />
        </>
      )}
    </svg>
  )
}
