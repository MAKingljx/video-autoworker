import { describe, expect, it } from 'vitest'
import {
  DOCTOR_DISMISS_WINDOW_MS,
  countVisibleSystemNotices,
  getSystemNoticeVisibility,
} from '@/lib/system-notifications'

const NOW = 2_000_000_000_000

function createInput() {
  return {
    capabilitiesChecked: true,
    dashboardMode: 'local' as const,
    localModeDismissed: false,
    missionControlVersion: '2.1.0',
    missionControlDismissedVersion: null,
    openClawVersion: '2026.8.1',
    openClawDismissedVersion: null,
    doctor: { healthy: false },
    doctorDismissedAt: null,
    now: NOW,
  }
}

describe('system notification visibility', () => {
  it('counts local mode, two updates, and doctor warnings together', () => {
    const visibility = getSystemNoticeVisibility(createInput())

    expect(visibility).toEqual({
      localMode: true,
      missionControlUpdate: true,
      openClawUpdate: true,
      doctor: true,
    })
    expect(countVisibleSystemNotices(visibility)).toBe(4)
  })

  it('hides dismissed versions without hiding a newer release', () => {
    const current = getSystemNoticeVisibility({
      ...createInput(),
      missionControlDismissedVersion: '2.1.0',
      openClawDismissedVersion: '2026.8.1',
    })
    const newer = getSystemNoticeVisibility({
      ...createInput(),
      missionControlDismissedVersion: '2.0.9',
      openClawDismissedVersion: '2026.7.1',
    })

    expect(current.missionControlUpdate).toBe(false)
    expect(current.openClawUpdate).toBe(false)
    expect(newer.missionControlUpdate).toBe(true)
    expect(newer.openClawUpdate).toBe(true)
  })

  it('respects the doctor 24 hour dismissal window', () => {
    const withinWindow = getSystemNoticeVisibility({
      ...createInput(),
      doctorDismissedAt: NOW - DOCTOR_DISMISS_WINDOW_MS + 1,
    })
    const expired = getSystemNoticeVisibility({
      ...createInput(),
      doctorDismissedAt: NOW - DOCTOR_DISMISS_WINDOW_MS,
    })

    expect(withinWindow.doctor).toBe(false)
    expect(expired.doctor).toBe(true)
  })

  it('does not show local mode before capability detection or after dismissal', () => {
    expect(getSystemNoticeVisibility({ ...createInput(), capabilitiesChecked: false }).localMode).toBe(false)
    expect(getSystemNoticeVisibility({ ...createInput(), localModeDismissed: true }).localMode).toBe(false)
    expect(getSystemNoticeVisibility({ ...createInput(), dashboardMode: 'full' }).localMode).toBe(false)
  })
})
