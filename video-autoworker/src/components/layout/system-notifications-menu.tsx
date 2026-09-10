'use client'

import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { AnchoredPopover } from '@/components/ui/anchored-popover'
import { Button } from '@/components/ui/button'
import { useNavigateToPanel, usePrefetchPanel } from '@/lib/navigation'
import {
  countVisibleSystemNotices,
  getSystemNoticeVisibility,
} from '@/lib/system-notifications'
import { useMissionControl } from '@/store'

interface OpenClawDoctorStatus {
  level: 'healthy' | 'warning' | 'error'
  category: 'config' | 'state' | 'security' | 'general'
  healthy: boolean
  summary: string
  issues: string[]
  canFix: boolean
  raw: string
}

interface OpenClawDoctorFixProgress {
  step: string
  detail: string
}

type MissionControlUpdateState = 'idle' | 'updating' | 'restarting' | 'error'
type OpenClawUpdateState = 'idle' | 'updating' | 'success' | 'error'
type DoctorState = 'idle' | 'fixing' | 'error'
type NoticeTone = 'info' | 'warning' | 'error' | 'success'

export function SystemNotificationsMenu() {
  const tn = useTranslations('systemNotifications')
  const tl = useTranslations('localModeBanner')
  const tm = useTranslations('updateBanner')
  const to = useTranslations('openclawUpdateBanner')
  const td = useTranslations('doctorBanner')
  const tc = useTranslations('common')
  const navigateToPanel = useNavigateToPanel()
  const prefetchPanel = usePrefetchPanel()

  const {
    unreadNotificationCount,
    dashboardMode,
    bannerDismissed,
    capabilitiesChecked,
    dismissBanner,
    updateAvailable,
    updateDismissedVersion,
    dismissUpdate,
    openclawUpdate,
    openclawUpdateDismissedVersion,
    dismissOpenclawUpdate,
    setOpenclawUpdate,
    doctorDismissedAt,
    dismissDoctor,
  } = useMissionControl()

  const [open, setOpen] = useState(false)
  const [doctor, setDoctor] = useState<OpenClawDoctorStatus | null>(null)
  const [missionControlState, setMissionControlState] = useState<MissionControlUpdateState>('idle')
  const [missionControlError, setMissionControlError] = useState<string | null>(null)
  const [openClawState, setOpenClawState] = useState<OpenClawUpdateState>('idle')
  const [openClawError, setOpenClawError] = useState<string | null>(null)
  const [newOpenClawVersion, setNewOpenClawVersion] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [showChangelog, setShowChangelog] = useState(false)
  const [doctorState, setDoctorState] = useState<DoctorState>('idle')
  const [doctorError, setDoctorError] = useState<string | null>(null)
  const [doctorDetailsOpen, setDoctorDetailsOpen] = useState(false)
  const [fixProgress, setFixProgress] = useState('')

  const loadDoctorStatus = useCallback(async () => {
    try {
      const response = await fetch('/api/openclaw/doctor', { cache: 'no-store' })
      if (!response.ok) {
        setDoctor(null)
        return
      }
      setDoctor(await response.json() as OpenClawDoctorStatus)
    } catch {
      setDoctor(null)
    }
  }, [])

  useEffect(() => {
    void loadDoctorStatus()
  }, [loadDoctorStatus])

  const visibility = useMemo(() => getSystemNoticeVisibility({
    capabilitiesChecked,
    dashboardMode,
    localModeDismissed: bannerDismissed,
    missionControlVersion: updateAvailable?.latestVersion ?? null,
    missionControlDismissedVersion: updateDismissedVersion,
    openClawVersion: openclawUpdate?.latest ?? null,
    openClawDismissedVersion: openclawUpdateDismissedVersion,
    doctor,
    doctorDismissedAt,
  }), [
    bannerDismissed,
    capabilitiesChecked,
    dashboardMode,
    doctor,
    doctorDismissedAt,
    openclawUpdate?.latest,
    openclawUpdateDismissedVersion,
    updateAvailable?.latestVersion,
    updateDismissedVersion,
  ])

  const systemNoticeCount = countVisibleSystemNotices(visibility)
  const totalBadgeCount = unreadNotificationCount + systemNoticeCount

  const viewAllNotifications = () => {
    setOpen(false)
    navigateToPanel('notifications')
  }

  async function handleMissionControlUpdate() {
    if (!updateAvailable) return
    setMissionControlState('updating')
    setMissionControlError(null)

    try {
      const response = await fetch('/api/releases/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetVersion: updateAvailable.latestVersion }),
      })
      const data = await response.json()

      if (!response.ok) {
        setMissionControlState('error')
        setMissionControlError(data.error || tm('updateFailed'))
        return
      }

      if (data.restartRequired) {
        setMissionControlState('restarting')
        const poll = window.setInterval(async () => {
          try {
            const check = await fetch('/api/releases/check', { cache: 'no-store' })
            if (check.ok) {
              window.clearInterval(poll)
              window.location.reload()
            }
          } catch {
            // The server is still restarting.
          }
        }, 2000)
        window.setTimeout(() => {
          window.clearInterval(poll)
          setMissionControlState('idle')
          window.location.reload()
        }, 120_000)
      } else {
        window.location.reload()
      }
    } catch {
      setMissionControlState('error')
      setMissionControlError(tm('networkError'))
    }
  }

  function handleCopyOpenClawCommand() {
    if (!openclawUpdate) return
    navigator.clipboard.writeText(openclawUpdate.updateCommand).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    }).catch(() => {})
  }

  async function handleOpenClawUpdate() {
    setOpenClawState('updating')
    setOpenClawError(null)

    try {
      const response = await fetch('/api/openclaw/update', { method: 'POST' })
      const data = await response.json()
      if (!response.ok) {
        setOpenClawState('error')
        setOpenClawError(data.detail || data.error || to('updateFailed'))
        return
      }

      setOpenClawState('success')
      setNewOpenClawVersion(data.newVersion)
      window.setTimeout(() => setOpenclawUpdate(null), 5000)
    } catch {
      setOpenClawState('error')
      setOpenClawError(to('networkError'))
    }
  }

  async function handleDoctorFix() {
    setDoctorState('fixing')
    setDoctorError(null)
    setFixProgress(td('runningFixes'))

    const progressMessages = [
      td('runningFixes'),
      td('cleaningSessionStores'),
      td('archivingOrphanTranscripts'),
      td('recheckingHealth'),
    ]
    let progressIndex = 0
    const progressTimer = window.setInterval(() => {
      progressIndex = (progressIndex + 1) % progressMessages.length
      setFixProgress(progressMessages[progressIndex] ?? progressMessages[0]!)
    }, 1400)

    try {
      const response = await fetch('/api/openclaw/doctor', { method: 'POST' })
      const data = await response.json()
      window.clearInterval(progressTimer)

      if (!response.ok) {
        setDoctorState('error')
        setDoctorError(data.detail || data.error || td('fixFailed'))
        if (data.status) setDoctor(data.status as OpenClawDoctorStatus)
        setFixProgress('')
        return
      }

      setDoctor(data.status as OpenClawDoctorStatus)
      const progress = Array.isArray(data.progress)
        ? data.progress as OpenClawDoctorFixProgress[]
        : []
      setFixProgress(progress.map(item => item.detail).filter(Boolean).join(' '))
      setDoctorState('idle')
      setDoctorDetailsOpen(false)
    } catch {
      window.clearInterval(progressTimer)
      setDoctorState('error')
      setDoctorError(td('networkError'))
      setFixProgress('')
    }
  }

  const trigger = (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={() => setOpen(value => !value)}
      onMouseEnter={() => prefetchPanel('notifications')}
      onFocus={() => prefetchPanel('notifications')}
      className="relative"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls="system-notifications-popover"
      aria-label={`${tn('ariaLabel')}${totalBadgeCount > 0 ? ` (${totalBadgeCount})` : ''}`}
      title={tn('title')}
    >
      <BellIcon />
      {totalBadgeCount > 0 && (
        <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-2xs font-medium text-primary-foreground">
          {totalBadgeCount > 9 ? '9+' : totalBadgeCount}
        </span>
      )}
    </Button>
  )

  return (
    <AnchoredPopover
      open={open}
      onOpenChange={setOpen}
      trigger={trigger}
      ariaLabel={tn('title')}
      panelClassName="fixed right-3 top-[3.25rem] mt-0 flex max-h-[calc(100vh-5rem)] w-[min(28rem,calc(100vw-1.5rem))] flex-col md:absolute md:right-0 md:top-full md:mt-2"
    >
      <div id="system-notifications-popover" className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="text-sm font-semibold text-foreground">{tn('title')}</h2>
          {systemNoticeCount > 0 && (
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-2xs font-medium text-primary">
              {systemNoticeCount}
            </span>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => setOpen(false)}
          aria-label={tc('close')}
        >
          <CloseIcon />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="mb-2 px-1 text-2xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
          {tn('systemSection')}
        </div>
        <div className="space-y-2">
          {visibility.localMode && (
            <NoticeCard
              tone="info"
              title={tl('noGatewayDetected')}
              body={stripLeadingSeparator(tl('runningInLocalMode'))}
              actions={(
                <>
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() => {
                      setOpen(false)
                      navigateToPanel('gateways')
                    }}
                  >
                    {tl('configureGateway')}
                  </Button>
                  <DismissButton label={tc('dismiss')} onClick={dismissBanner} />
                </>
              )}
            />
          )}

          {visibility.missionControlUpdate && updateAvailable && (
            <NoticeCard
              tone={missionControlState === 'error' ? 'error' : missionControlState === 'idle' ? 'info' : 'warning'}
              title={
                missionControlState === 'updating'
                  ? tm('updating')
                  : missionControlState === 'restarting'
                    ? tm('restartingServer')
                    : missionControlState === 'error'
                      ? tm('updateFailed')
                      : tm('updateAvailable', { version: updateAvailable.latestVersion })
              }
              body={missionControlState === 'error' ? missionControlError || tm('updateFailed') : missionControlState === 'idle' ? stripLeadingSeparator(tm('newerVersionAvailable')) : undefined}
              busy={missionControlState === 'updating' || missionControlState === 'restarting'}
              actions={missionControlState === 'updating' || missionControlState === 'restarting' ? undefined : (
                <>
                  <Button size="xs" onClick={handleMissionControlUpdate}>{tc('updateNow')}</Button>
                  {updateAvailable.releaseUrl && (
                    <Button asChild variant="outline" size="xs">
                      <a href={updateAvailable.releaseUrl} target="_blank" rel="noopener noreferrer">{tc('viewRelease')}</a>
                    </Button>
                  )}
                  <DismissButton label={tc('dismiss')} onClick={() => dismissUpdate(updateAvailable.latestVersion)} />
                </>
              )}
            />
          )}

          {visibility.openClawUpdate && openclawUpdate && (
            <NoticeCard
              tone={
                openClawState === 'error'
                  ? 'error'
                  : openClawState === 'success'
                    ? 'success'
                    : openClawState === 'updating'
                      ? 'warning'
                      : 'info'
              }
              title={
                openClawState === 'updating'
                  ? to('updatingOpenClaw')
                  : openClawState === 'success'
                    ? to('openclawUpdated', { version: newOpenClawVersion || openclawUpdate.latest })
                    : openClawState === 'error'
                      ? to('updateFailed')
                      : to('openclawUpdateAvailable', { version: openclawUpdate.latest })
              }
              body={
                openClawState === 'error'
                  ? openClawError || to('updateFailed')
                  : openClawState === 'idle'
                    ? to('installed', { version: openclawUpdate.installed })
                    : undefined
              }
              busy={openClawState === 'updating'}
              actions={openClawState === 'updating' || openClawState === 'success' ? undefined : (
                <>
                  <Button size="xs" onClick={handleOpenClawUpdate}>{tc('updateNow')}</Button>
                  {openclawUpdate.releaseNotes && (
                    <Button variant="outline" size="xs" onClick={() => setShowChangelog(value => !value)}>
                      {to('changelog')} {showChangelog ? '▴' : '▾'}
                    </Button>
                  )}
                  <Button variant="outline" size="xs" onClick={handleCopyOpenClawCommand}>
                    {copied ? to('copied') : to('copyCommand')}
                  </Button>
                  {openclawUpdate.releaseUrl && (
                    <Button asChild variant="outline" size="xs">
                      <a href={openclawUpdate.releaseUrl} target="_blank" rel="noopener noreferrer">{tc('viewRelease')}</a>
                    </Button>
                  )}
                  <DismissButton label={tc('dismiss')} onClick={() => dismissOpenclawUpdate(openclawUpdate.latest)} />
                </>
              )}
            >
              {showChangelog && openclawUpdate.releaseNotes && (
                <div className="mt-2 max-h-40 overflow-y-auto rounded-md border border-border bg-secondary/35 p-2.5 text-2xs leading-relaxed text-muted-foreground whitespace-pre-wrap">
                  {openclawUpdate.releaseNotes}
                </div>
              )}
            </NoticeCard>
          )}

          {visibility.doctor && doctor && (
            <NoticeCard
              tone={doctor.level === 'error' || doctorState === 'error' ? 'error' : 'warning'}
              title={doctorHeadline(doctor, td)}
              body={doctorState === 'error' ? doctorError || doctor.summary : doctor.summary}
              busy={doctorState === 'fixing'}
              actions={(
                <>
                  {doctor.canFix && (
                    <Button size="xs" onClick={handleDoctorFix} disabled={doctorState === 'fixing'}>
                      {doctorState === 'fixing' ? td('runningFix') : td('runDoctorFix')}
                    </Button>
                  )}
                  <Button variant="outline" size="xs" onClick={() => setDoctorDetailsOpen(value => !value)}>
                    {doctorDetailsOpen ? tc('hideDetails') : tc('showDetails')}
                  </Button>
                  <DismissButton label={tc('dismiss')} onClick={dismissDoctor} />
                </>
              )}
            >
              {doctor.issues.length > 0 && !doctorDetailsOpen && (
                <ul className="mt-2 space-y-1 text-2xs text-muted-foreground">
                  {doctor.issues.slice(0, 2).map(issue => <li key={issue}>- {issue}</li>)}
                  {doctor.issues.length > 2 && <li>{tc('moreIssues', { count: doctor.issues.length - 2 })}</li>}
                </ul>
              )}
              {doctorState === 'fixing' && fixProgress && (
                <p className="mt-2 text-2xs text-muted-foreground">{fixProgress}</p>
              )}
              {doctorDetailsOpen && (
                <div className="mt-2 max-h-48 overflow-y-auto rounded-md border border-border bg-secondary/35 p-2.5 text-2xs leading-relaxed text-muted-foreground whitespace-pre-wrap">
                  {doctor.raw || doctor.summary}
                </div>
              )}
            </NoticeCard>
          )}

          {systemNoticeCount === 0 && (
            <div className="rounded-lg border border-dashed border-border px-4 py-7 text-center text-xs text-muted-foreground">
              {tn('empty')}
            </div>
          )}

          {unreadNotificationCount > 0 && (
            <button
              type="button"
              onClick={viewAllNotifications}
              className="flex w-full items-center justify-between rounded-lg border border-border bg-card px-3 py-2.5 text-left text-xs text-foreground transition-colors hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span>{tn('unreadBusiness', { count: unreadNotificationCount })}</span>
              <ArrowRightIcon />
            </button>
          )}
        </div>
      </div>

      <div className="border-t border-border p-2">
        <Button variant="ghost" size="sm" onClick={viewAllNotifications} className="w-full justify-between">
          <span>{tn('viewAll')}</span>
          <ArrowRightIcon />
        </Button>
      </div>
    </AnchoredPopover>
  )
}

function NoticeCard({
  tone,
  title,
  body,
  busy = false,
  actions,
  children,
}: {
  tone: NoticeTone
  title: string
  body?: string
  busy?: boolean
  actions?: ReactNode
  children?: ReactNode
}) {
  const toneClass: Record<NoticeTone, { dot: string; border: string }> = {
    info: { dot: 'bg-primary', border: 'border-border' },
    warning: { dot: 'bg-warning', border: 'border-warning/30' },
    error: { dot: 'bg-destructive', border: 'border-destructive/30' },
    success: { dot: 'bg-success', border: 'border-success/30' },
  }

  return (
    <section className={`rounded-lg border bg-card p-3 ${toneClass[tone].border}`}>
      <div className="flex items-start gap-2.5">
        <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${toneClass[tone].dot}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h3 className="text-xs font-medium leading-5 text-foreground">{title}</h3>
            {busy && <Spinner />}
          </div>
          {body && <p className="mt-0.5 text-2xs leading-relaxed text-muted-foreground">{body}</p>}
          {children}
          {actions && <div className="mt-2.5 flex flex-wrap items-center gap-1.5">{actions}</div>}
        </div>
      </div>
    </section>
  )
}

function DismissButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button variant="ghost" size="icon-xs" onClick={onClick} aria-label={label} title={label}>
      <CloseIcon />
    </Button>
  )
}

function doctorHeadline(
  doctor: OpenClawDoctorStatus,
  t: (key: 'configDrift' | 'stateIntegrity' | 'securityWarning' | 'doctorWarnings') => string,
): string {
  if (doctor.category === 'config') return t('configDrift')
  if (doctor.category === 'state') return t('stateIntegrity')
  if (doctor.category === 'security') return t('securityWarning')
  return t('doctorWarnings')
}

function stripLeadingSeparator(value: string): string {
  return value.replace(/^\s*[—-]\s*/, '')
}

function BellIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 13h4M3.5 10c0-1-1-2-1-4a5.5 5.5 0 0111 0c0 2-1 3-1 4H3.5z" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  )
}

function ArrowRightIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 8h10M9 4l4 4-4 4" />
    </svg>
  )
}

function Spinner() {
  return (
    <svg className="h-3.5 w-3.5 shrink-0 animate-spin text-warning" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v3a5 5 0 00-5 5H4z" />
    </svg>
  )
}
