/**
 * The brand theme contract, `cinna.brand-theme/1`, as the desktop reads it.
 *
 * A Cinna server publishes at most one brand theme (`GET /api/v1/brand-theme`,
 * public). Its roles are named, never CSS: each mode lists one literal colour
 * per role, and the desktop maps roles onto its `--color-*` variables in
 * `roleMap.ts`, the only place that mapping lives.
 *
 * The role names are copied from core's `services/brand_theme/schema.py`
 * (`ROLES`), in its order. Every role is required in v1; a role added in a
 * later `1.x` is optional and the desktop derives it when absent.
 *
 * Pure contract: no runtime imports.
 */

export const BRAND_THEME_SCHEMA = 'cinna.brand-theme/1'

export const BRAND_THEME_MODES = ['dark', 'light'] as const
export type BrandThemeMode = (typeof BRAND_THEME_MODES)[number]

/** The 35 required roles, in core's `schema.py` order. */
export const BRAND_THEME_ROLES = [
  'surface.base',
  'surface.raised',
  'surface.tertiary',
  'surface.hover',
  'surface.input',
  'border',
  'text.primary',
  'text.secondary',
  'text.muted',
  'accent',
  'accent.hover',
  'accent.on',
  'bubble.user',
  'highlight',
  'status.danger',
  'status.warning',
  'status.success',
  'status.info',
  'status.danger.text',
  'status.warning.text',
  'status.success.text',
  'status.info.text',
  'chart.1',
  'chart.2',
  'chart.3',
  'chart.4',
  'chart.5',
  'chart.6',
  'chart.7',
  'chart.8',
  'chart.pos',
  'chart.neg',
  'chart.grid',
  'logo.from',
  'logo.to'
] as const
export type BrandThemeRole = (typeof BRAND_THEME_ROLES)[number]

/** One mode's colours: every role, as lowercase `#rrggbb` (core normalises). */
export type BrandThemeRoles = Record<BrandThemeRole, string>

/** The only colour form the desktop accepts; anything else is refused, so nothing else can reach CSS. */
export const BRAND_THEME_COLOR_RE = /^#[0-9a-f]{6}$/

/** An asset as core serves it: a content-hashed, server-relative URL. */
export interface BrandThemeAssetRef {
  url: string
  type: string
  bytes: number
  sha256: string
  /** Rasters only; never trusted — the desktop reads the size from the bytes. */
  width?: number
  height?: number
}

/** `theme` of the served document: `theme.json` with asset paths replaced by asset objects. */
export interface BrandThemeV1 {
  schema: typeof BRAND_THEME_SCHEMA
  name: string
  modes: Record<BrandThemeMode, BrandThemeRoles>
  /** Optional; when present, both modes hold an asset (a `null` mode is a broken theme). */
  logo?: Record<BrandThemeMode, BrandThemeAssetRef | null>
  /** Optional; a `null` mode is a flat `surface.base`. Absent means flat in both modes. */
  background?: Record<BrandThemeMode, BrandThemeAssetRef | null>
  copy?: { newChatHeading?: string }
}

/** What `GET /api/v1/brand-theme` answers with a 200. */
export interface BrandThemeServed {
  schema: typeof BRAND_THEME_SCHEMA
  revision: number
  theme: BrandThemeV1
  assets: Record<string, BrandThemeAssetRef>
}

/**
 * A checked theme, ready to apply, as `brandTheme:get` returns it. Assets are
 * `data:` URLs built from bytes the parser checked, with the MIME type it
 * sniffed from them.
 */
export interface ResolvedBrandTheme {
  /** The server origin the theme belongs to (B1: one theme per server). */
  origin: string
  revision: number
  /** The brand's name, the logo's alt text. */
  name: string
  modes: Record<BrandThemeMode, BrandThemeRoles>
  /** Absent: the Cinna wordmark, tinted by `logo.from` / `logo.to`. */
  logo?: Record<BrandThemeMode, string>
  /** A data URL, or null for a flat `surface.base`. An absent block resolves to both null. */
  background: Record<BrandThemeMode, string | null>
  copy: { newChatHeading?: string }
}

/** Main → every window: the active profile's brand moved. Data only; the window then calls `get`. */
export type BrandThemeChangedPayload = { origin: string; revision: number } | null

export const BRAND_THEME_CHANGED_CHANNEL = 'brandTheme:changed'
export const BRAND_THEME_GET_CHANNEL = 'brandTheme:get'
/**
 * The cached theme of one profile's server, for a sign-in surface showing that
 * profile before it is active. Cache only: never fetches. Null for a guest,
 * local or unknown profile, a server without a cached theme, or any error.
 */
export const BRAND_THEME_GET_FOR_PROFILE_CHANNEL = 'brandTheme:getForProfile'
