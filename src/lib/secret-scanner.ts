/**
 * Secret Scanner — detects leaked credentials and sensitive tokens in text.
 *
 * Pure regex-based scanner with shared patterns for common secret formats.
 * Used by hook profiles to gate whether secrets should be scanned/blocked.
 */

import {
  redactSensitiveValues,
  scanSensitiveValues,
} from '../../scripts/lib/sensitive-value-scanner.mjs'

export type SecretSeverity = 'info' | 'warning' | 'critical'

export interface SecretMatch {
  type: string
  severity: SecretSeverity
  redactedPreview: string
  position: number
}

export function scanForSecrets(text: string): SecretMatch[] {
  return (scanSensitiveValues(text) as Array<{
    type: string
    severity: SecretSeverity
    value: string
    position: number
  }>).map(match => {
    const value = match.value
    const preview = value.length > 12
      ? value.slice(0, 6) + '***' + value.slice(-3)
      : value.slice(0, 3) + '***'
    return {
      type: match.type,
      severity: match.severity,
      redactedPreview: preview,
      position: match.position,
    }
  })
}

export function redactSecrets(text: string): string {
  return redactSensitiveValues(text, '***REDACTED***')
}
