import { BRAND_ROLE_MAP } from '../../../shared/brandTheme/roleMap'
import {
  BRAND_THEME_COLOR_RE,
  BRAND_THEME_MODES,
  BRAND_THEME_ROLES,
  type BrandThemeMode,
  type ResolvedBrandTheme
} from '../../../shared/brandTheme/roles'

/**
 * The one stylesheet a brand theme becomes (`<style id="brand-theme">`).
 *
 * Every rule sits in `@layer brand`, which `main.css` orders after `base`
 * (where the stock `--color-*` and the stock mesh live) and before
 * `components` / `utilities`, so a brand beats the stock values while a
 * Tailwind utility still beats both. Both modes are in the sheet, keyed on
 * `data-theme`, so the Dark/Light toggle needs nothing from here.
 *
 * Main already refused anything that is not lowercase `#rrggbb`; the builder
 * checks again and refuses the whole sheet rather than write a value it did
 * not expect. A background is a `data:` URL of base64, which holds no
 * character that could close the `url("…")`.
 *
 * Pure: builds a string, touches no DOM.
 */

const DATA_URL_RE = /^data:image\/(?:png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/

function modeSelector(mode: BrandThemeMode): string {
  return `[data-brand][data-theme="${mode}"]`
}

/** The custom properties of one mode, or null when a value is not `#rrggbb`. */
function modeVariables(theme: ResolvedBrandTheme, mode: BrandThemeMode): string[] | null {
  const roles = theme.modes?.[mode]
  if (!roles) return null
  const lines: string[] = []
  for (const role of BRAND_THEME_ROLES) {
    const value = roles[role]
    if (typeof value !== 'string' || !BRAND_THEME_COLOR_RE.test(value)) return null
    for (const name of BRAND_ROLE_MAP[role]) lines.push(`--color-${name}: ${value};`)
  }
  return lines
}

/**
 * The body background per mode: the brand's image, or `none` — a flat
 * `surface.base`, never the stock mesh (README B12). Kept in one function so
 * it can move to `document.body.style` if one big `<style>` turns out slow.
 * Null when an image is not a data URL this builder accepts.
 */
export function brandBackgroundRules(background: ResolvedBrandTheme['background'] | undefined): string[] | null {
  const rules: string[] = []
  for (const mode of BRAND_THEME_MODES) {
    const url = background?.[mode] ?? null
    if (url !== null && (typeof url !== 'string' || !DATA_URL_RE.test(url))) return null
    const image = url === null ? 'none' : `url("${url}")`
    rules.push(`  ${modeSelector(mode)} body { background-image: ${image}; }`)
  }
  return rules
}

export interface BrandSheetOptions {
  /** The body background. Off for the tray popup, which has no mesh and stays transparent. */
  background: boolean
}

/** The brand sheet, or null when anything in the theme is not what the builder accepts. */
export function buildBrandThemeCss(theme: ResolvedBrandTheme, options: BrandSheetOptions = { background: true }): string | null {
  const blocks: string[] = []
  for (const mode of BRAND_THEME_MODES) {
    const variables = modeVariables(theme, mode)
    if (!variables) return null
    blocks.push(`  ${modeSelector(mode)} {\n${variables.map((line) => `    ${line}`).join('\n')}\n  }`)
  }
  if (options.background) {
    const background = brandBackgroundRules(theme.background)
    if (!background) return null
    blocks.push(...background)
  }
  return `@layer brand {\n${blocks.join('\n')}\n}\n`
}
