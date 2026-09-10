export const DOCTOR_DISMISS_WINDOW_MS = 24 * 60 * 60 * 1000

export interface DoctorNoticeStatus {
  healthy: boolean
}

export interface SystemNoticeVisibilityInput {
  capabilitiesChecked: boolean
  dashboardMode: 'full' | 'local'
  localModeDismissed: boolean
  missionControlVersion: string | null
  missionControlDismissedVersion: string | null
  openClawVersion: string | null
  openClawDismissedVersion: string | null
  doctor: DoctorNoticeStatus | null
  doctorDismissedAt: number | null
  now?: number
}

export interface SystemNoticeVisibility {
  localMode: boolean
  missionControlUpdate: boolean
  openClawUpdate: boolean
  doctor: boolean
}

export function getSystemNoticeVisibility({
  capabilitiesChecked,
  dashboardMode,
  localModeDismissed,
  missionControlVersion,
  missionControlDismissedVersion,
  openClawVersion,
  openClawDismissedVersion,
  doctor,
  doctorDismissedAt,
  now = Date.now(),
}: SystemNoticeVisibilityInput): SystemNoticeVisibility {
  const doctorDismissed =
    doctorDismissedAt != null && now - doctorDismissedAt < DOCTOR_DISMISS_WINDOW_MS

  return {
    localMode: capabilitiesChecked && dashboardMode === 'local' && !localModeDismissed,
    missionControlUpdate:
      missionControlVersion != null && missionControlDismissedVersion !== missionControlVersion,
    openClawUpdate: openClawVersion != null && openClawDismissedVersion !== openClawVersion,
    doctor: doctor != null && !doctor.healthy && !doctorDismissed,
  }
}

export function countVisibleSystemNotices(visibility: SystemNoticeVisibility): number {
  return Object.values(visibility).filter(Boolean).length
}
