'use client'

import { useTranslations } from 'next-intl'

export function RuntimeUsageNotice({ available }: { available?: boolean }) {
  const t = useTranslations('common')
  if (available !== false) return null
  return (
    <p role="status" className="rounded-lg border border-border bg-secondary/30 px-4 py-3 text-sm text-muted-foreground">
      {t('runtimeUsageUnavailable')}
    </p>
  )
}
