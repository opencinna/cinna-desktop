import type { BrandThemeRole } from './roles'

/**
 * Brand role → the desktop's `--color-*` variables (names without the
 * `--color-` prefix). **This is the only place the mapping lives**: the
 * renderer's sheet builder (`utils/brandThemeCss.ts`) reads it, and
 * `roleMap.test.ts` checks it against `main.css` so a new variable cannot slip
 * past the brand.
 */
export const BRAND_ROLE_MAP: Readonly<Record<BrandThemeRole, readonly string[]>> = {
  'surface.base': ['bg'],
  'surface.raised': ['bg-secondary'],
  'surface.tertiary': ['bg-tertiary'],
  'surface.hover': ['bg-hover'],
  'surface.input': ['bg-input'],
  border: ['border'],
  'text.primary': ['text'],
  'text.secondary': ['text-secondary'],
  'text.muted': ['text-muted', 'dashboard-muted'],
  accent: ['accent'],
  'accent.hover': ['accent-hover'],
  'accent.on': ['on-accent'],
  'bubble.user': ['user-bubble'],
  highlight: ['highlight'],
  'status.danger': ['danger', 'severity-error'],
  'status.warning': ['warning', 'severity-warning'],
  'status.success': ['success', 'severity-ok'],
  'status.info': ['severity-info'],
  'status.danger.text': ['severity-error-text'],
  'status.warning.text': ['severity-warning-text'],
  'status.success.text': ['severity-ok-text'],
  'status.info.text': ['severity-info-text'],
  'chart.1': ['chart-1'],
  'chart.2': ['chart-2'],
  'chart.3': ['chart-3'],
  'chart.4': ['chart-4'],
  'chart.5': ['chart-5'],
  'chart.6': ['chart-6'],
  'chart.7': ['chart-7'],
  'chart.8': ['chart-8'],
  'chart.pos': ['chart-pos'],
  'chart.neg': ['chart-neg'],
  'chart.grid': ['chart-grid'],
  'logo.from': ['logo-from'],
  'logo.to': ['logo-to']
}

/**
 * Variables never set from a role. They keep their stock values; those that
 * read a mapped variable (`highlight-tint`, `sidebar-menu-bg`,
 * `severity-unknown*`) follow the brand through their existing `color-mix` /
 * `var()`. The internal effect colours (glows, waves, overlays, the sidebar
 * tab shades) are never roles (README B5).
 */
export const BRAND_DERIVED_VARIABLES: readonly string[] = [
  'ambient-glow',
  'header-wave',
  'overlay-backdrop',
  'overlay-panel',
  'sidebar-menu-bg',
  'sidebar-tab-shadow',
  'sidebar-tab-hover-bg',
  'command-ref-edge',
  'send-queued',
  'html-page',
  'highlight-tint',
  'severity-unknown',
  'severity-unknown-text'
]
