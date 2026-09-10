export interface ThemeMeta {
  id: string
  label: string
  group: 'light' | 'dark'
  swatch: string
  background?: string
}

export const THEMES: ThemeMeta[] = [
  { id: 'github-dark', label: 'GitHub Dark', group: 'dark', swatch: '#58A6FF' },
  { id: 'github-light', label: 'GitHub Light', group: 'light', swatch: '#0969DA' },
]

/** All theme IDs for the next-themes `themes` prop. */
export const THEME_IDS = THEMES.map(t => t.id)

/** Look up whether a theme is dark or light. */
export function isThemeDark(themeId: string): boolean {
  const meta = THEMES.find(t => t.id === themeId)
  return meta ? meta.group === 'dark' : true
}
