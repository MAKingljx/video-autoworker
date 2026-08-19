/**
 * Design tokens for the restrained Mission Control palette.
 * Server-safe — no 'use client' directive needed.
 *
 * Use the `hsl()` helper when you need inline styles (ReactFlow nodes, recharts),
 * and reference CSS variables via Tailwind classes everywhere else.
 */

// ---------------------------------------------------------------------------
// HSL triplet type
// ---------------------------------------------------------------------------
export interface HSL {
  h: number
  s: number
  l: number
}

// ---------------------------------------------------------------------------
// Product palette
// ---------------------------------------------------------------------------
export const voidPalette = {
  background: { h: 216, s: 28, l: 7 },
  card:       { h: 215, s: 21, l: 11 },
  primary:    { h: 212, s: 100, l: 67 },
  secondary:  { h: 215, s: 15, l: 15 },
  muted:      { h: 215, s: 15, l: 15 },
  border:     { h: 212, s: 12, l: 21 },
  ring:       { h: 212, s: 100, l: 67 },
} as const satisfies Record<string, HSL>

export const voidAccents = {
  cyan:    { h: 212, s: 100, l: 67 },
  mint:    { h: 128, s: 49, l: 49 },
  amber:   { h: 41,  s: 72, l: 48 },
  violet:  { h: 212, s: 100, l: 67 },
  crimson: { h: 3,   s: 93, l: 63 },
} as const satisfies Record<string, HSL>

export const statusColors = {
  success: { h: 128, s: 49, l: 49 },
  warning: { h: 41,  s: 72, l: 48 },
  error:   { h: 3,   s: 93, l: 63 },
  info:    { h: 212, s: 100, l: 67 },
} as const satisfies Record<string, HSL>

export const surfaces = {
  0: { h: 216, s: 28, l: 7 },
  1: { h: 215, s: 21, l: 11 },
  2: { h: 215, s: 15, l: 15 },
  3: { h: 212, s: 12, l: 21 },
} as const

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert an HSL triplet to a CSS `hsl(...)` string. */
export function hsl(color: HSL, alpha?: number): string {
  if (alpha !== undefined) {
    return `hsl(${color.h} ${color.s}% ${color.l}% / ${alpha})`
  }
  return `hsl(${color.h} ${color.s}% ${color.l}%)`
}

/** Return the raw HSL string for a CSS variable value (no `hsl()` wrapper). */
export function hslRaw(color: HSL): string {
  return `${color.h} ${color.s}% ${color.l}%`
}

// ---------------------------------------------------------------------------
// Spacing, radius & typography constants
// ---------------------------------------------------------------------------
export const spacing = {
  unit: 4,          // base grid unit in px
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  '2xl': 48,
} as const

export const radius = {
  xs: 6,
  sm: 8,
  md: 10,
  lg: 12,
  xl: 16,
  full: 9999,
} as const

export const fonts = {
  sans: 'var(--font-sans)',
  mono: 'var(--font-mono)',
} as const
