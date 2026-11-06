/**
 * Parse and safety-check a served brand theme (`GET /api/v1/brand-theme`).
 *
 * The server is untrusted input, so this re-checks **safety** only (README
 * B3): the shape, every role in both modes, colour syntax, asset hashes,
 * sniffed types, sizes, raster dimensions read from the bytes, the SVG
 * allowlist, and plain text. It never re-judges contrast or taste — that is
 * core's job on save, and anything core tags *incompatible* passes here.
 * Unknown keys are ignored (forward-compatible within `1.x`).
 *
 * Any failure is one `{ error }`: the caller shows stock Cinna (or keeps the
 * last good theme) and logs the reason. A theme is never applied in part.
 *
 * Pure module: no I/O, no Electron, no database.
 */

import { createHash } from 'node:crypto'
import {
  BRAND_THEME_COLOR_RE,
  BRAND_THEME_MODES,
  BRAND_THEME_ROLES,
  BRAND_THEME_SCHEMA,
  type BrandThemeMode,
  type BrandThemeRoles,
  type ResolvedBrandTheme
} from '../../../shared/brandTheme/roles'
import { checkSvg } from './svgCheck'
import { MIME_SVG, rasterSize, sniffMime, type BrandAssetMime } from './imageFacts'

const KIB = 1024
const MIB = 1024 * KIB

/** README §3.4, as core enforces them (`schema.py`). */
export const BRAND_ASSET_LIMITS = {
  logo: { svg: 256 * KIB, raster: 1 * MIB },
  background: { svg: 512 * KIB, raster: 3 * MIB }
} as const
export const RASTER_MAX_SIDE = 4096
export const COPY_MAX_CHARS = { newChatHeading: 60 } as const

const SHA256_RE = /^[0-9a-f]{64}$/

// Core's `_bad_text_char`: Cc, Cs, Co, Zl, Zp and the bidi controls.
const BAD_TEXT_CHAR_RE = /[\p{Cc}\p{Cs}\p{Co}\p{Zl}\p{Zp}‪-‮⁦-⁩‎‏]/u

export type AssetBlock = 'logo' | 'background'

/** An asset that passed every check: its bytes, and the type sniffed from them. */
export interface CheckedAsset {
  sha256: string
  mime: BrandAssetMime
  bytes: Buffer
}

/** A served theme that passed every safety check; assets still as bytes. */
export interface ParsedBrandTheme {
  revision: number
  name: string
  modes: Record<BrandThemeMode, BrandThemeRoles>
  logo?: Record<BrandThemeMode, CheckedAsset>
  background: Record<BrandThemeMode, CheckedAsset | null>
  copy: { newChatHeading?: string }
}

export type ParseResult = { ok: ParsedBrandTheme } | { error: string }

class Invalid extends Error {}

function fail(message: string): never {
  throw new Invalid(message)
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${where} is not an object`)
  return value as Record<string, unknown>
}

function plainText(value: unknown, where: string): string {
  if (typeof value !== 'string' || !value.trim()) fail(`${where} is not a non-empty string`)
  if (BAD_TEXT_CHAR_RE.test(value)) fail(`${where} contains a control character`)
  return value.trim()
}

function modes(value: unknown): Record<BrandThemeMode, BrandThemeRoles> {
  const block = record(value, 'theme.modes')
  const out = {} as Record<BrandThemeMode, BrandThemeRoles>
  for (const mode of BRAND_THEME_MODES) {
    const roles = record(block[mode], `theme.modes.${mode}`)
    const colors = {} as BrandThemeRoles
    for (const role of BRAND_THEME_ROLES) {
      const color = roles[role]
      if (color === undefined) fail(`theme.modes.${mode} has no ${role}`)
      if (typeof color !== 'string' || !BRAND_THEME_COLOR_RE.test(color)) {
        fail(`theme.modes.${mode}.${role} is not a #rrggbb colour`)
      }
      colors[role] = color
    }
    out[mode] = colors
  }
  return out
}

function checkAsset(value: unknown, block: AssetBlock, mode: BrandThemeMode, assets: ReadonlyMap<string, Uint8Array>): CheckedAsset {
  const where = `${block}.${mode}`
  const ref = record(value, where)
  const sha256 = ref.sha256
  if (typeof sha256 !== 'string' || !SHA256_RE.test(sha256)) fail(`${where} has no sha256`)
  const raw = assets.get(sha256)
  if (!raw) fail(`${where} is missing`)
  const bytes = Buffer.from(raw)
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) fail(`${where} does not match its sha256`)
  if (typeof ref.bytes === 'number' && ref.bytes !== bytes.length) fail(`${where} is not the size the server declared`)
  const mime = sniffMime(bytes)
  if (!mime) fail(`${where} is not an SVG, PNG, JPEG or WebP image`)
  if (ref.type !== mime) fail(`${where} is not the type the server declared`)
  const limits = BRAND_ASSET_LIMITS[block]
  if (mime === MIME_SVG) {
    if (bytes.length > limits.svg) fail(`${where} is a larger SVG than allowed`)
    const svg = checkSvg(bytes)
    if (!svg.ok) fail(`${where}: ${svg.reason}`)
  } else {
    if (bytes.length > limits.raster) fail(`${where} is a larger image than allowed`)
    const size = rasterSize(bytes, mime)
    if (!size || size.width <= 0 || size.height <= 0) fail(`${where} has no readable image size`)
    if (size.width > RASTER_MAX_SIDE || size.height > RASTER_MAX_SIDE) {
      fail(`${where} is more than ${RASTER_MAX_SIDE} px a side`)
    }
  }
  return { sha256, mime, bytes }
}

function parse(body: unknown, assets: ReadonlyMap<string, Uint8Array>): ParsedBrandTheme {
  let doc: unknown = body
  if (typeof body === 'string') {
    try {
      doc = JSON.parse(body)
    } catch {
      fail('the response is not JSON')
    }
  }
  const served = record(doc, 'the response')
  if (served.schema !== BRAND_THEME_SCHEMA) fail('the response is not schema cinna.brand-theme/1')
  const revision = served.revision
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) fail('the response has no revision')
  const theme = record(served.theme, 'theme')
  if (theme.schema !== BRAND_THEME_SCHEMA) fail('theme is not schema cinna.brand-theme/1')
  const name = plainText(theme.name, 'theme.name')
  const colors = modes(theme.modes)

  let logo: Record<BrandThemeMode, CheckedAsset> | undefined
  if (theme.logo !== undefined) {
    const block = record(theme.logo, 'theme.logo')
    // A served logo mode is null only when its asset is missing: a broken theme.
    logo = {
      dark: checkAsset(block.dark, 'logo', 'dark', assets),
      light: checkAsset(block.light, 'logo', 'light', assets)
    }
  }

  const background: Record<BrandThemeMode, CheckedAsset | null> = { dark: null, light: null }
  if (theme.background !== undefined) {
    const block = record(theme.background, 'theme.background')
    for (const mode of BRAND_THEME_MODES) {
      // Core serves a missing mode as null too; either way it is flat.
      const ref = block[mode]
      background[mode] = ref === null || ref === undefined ? null : checkAsset(ref, 'background', mode, assets)
    }
  }

  const copy: ParsedBrandTheme['copy'] = {}
  if (theme.copy !== undefined) {
    const block = record(theme.copy, 'theme.copy')
    if (block.newChatHeading !== undefined) {
      const heading = plainText(block.newChatHeading, 'theme.copy.newChatHeading')
      // Python's len(): code points, not UTF-16 units.
      if ([...(block.newChatHeading as string)].length > COPY_MAX_CHARS.newChatHeading) {
        fail('theme.copy.newChatHeading is too long')
      }
      copy.newChatHeading = heading
    }
  }

  return { revision, name, modes: colors, ...(logo ? { logo } : {}), background, copy }
}

/**
 * Check a served brand theme. `body` is the parsed JSON response, or its raw
 * text; `assets` holds bytes by sha256 (fetched or cached). The error is a
 * short reason for the log, never containing a URL.
 */
export function parseBrandTheme(body: unknown, assets: ReadonlyMap<string, Uint8Array>): ParseResult {
  try {
    return { ok: parse(body, assets) }
  } catch (err) {
    if (err instanceof Invalid) return { error: err.message }
    return { error: 'the theme could not be read' }
  }
}

function dataUrl(asset: CheckedAsset): string {
  return `data:${asset.mime};base64,${asset.bytes.toString('base64')}`
}

/** The renderer's form: assets as `data:` URLs with the sniffed MIME type. */
export function toResolvedBrandTheme(parsed: ParsedBrandTheme, origin: string): ResolvedBrandTheme {
  return {
    origin,
    revision: parsed.revision,
    name: parsed.name,
    modes: parsed.modes,
    ...(parsed.logo ? { logo: { dark: dataUrl(parsed.logo.dark), light: dataUrl(parsed.logo.light) } } : {}),
    background: {
      dark: parsed.background.dark ? dataUrl(parsed.background.dark) : null,
      light: parsed.background.light ? dataUrl(parsed.background.light) : null
    },
    copy: { ...parsed.copy }
  }
}
