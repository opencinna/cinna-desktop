export type Theme = 'dark' | 'light'
export type ThemePreference = 'system' | Theme

export function readThemePreference(): ThemePreference {
  const saved = localStorage.getItem('cinna-theme')
  return saved === 'system' || saved === 'light' ? saved : 'dark'
}

export function resolveTheme(preference: ThemePreference): Theme {
  return preference === 'system'
    ? window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    : preference
}
