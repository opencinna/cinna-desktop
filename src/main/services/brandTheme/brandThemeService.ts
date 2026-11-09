/**
 * Brand themes: the look a Cinna server publishes for every desktop signed
 * in to it (plans README B1–B12).
 *
 * **Keyed by server origin, not by profile** (B1): two profiles on one server
 * share one cached theme. The active profile's theme is the cached one for
 * its `cinnaServerUrl` origin; a guest, local or non-Cinna profile has none.
 *
 * **The last good theme is kept** (B9) in `db/brandThemes.ts`, so a profile
 * switch or a restart with the server unreachable applies it at once. A
 * refresh that fails in any way — network, 429, 5xx, a response that does not
 * pass `parse.ts` — keeps it; only a 204 or 404 (no theme, or a core without
 * the feature) forgets it.
 *
 * **Notification carries no theme.** `brandTheme:changed` goes to every
 * window with `{ origin, revision } | null`; a window then asks `get()` for
 * the resolved theme (assets as `data:` URLs) unless it already shows that
 * revision. A multi-megabyte background never rides an event.
 *
 * **Branding can be off** (`serverBranding`, Settings → Features → Interface →
 * Branding: Cinna Original). Then every answer here is stock — `get`,
 * `resolveForProfile`, activation's announcement, a refresh's — and the
 * default mode adopts nothing; refreshes still fetch and cache, so turning
 * it back on (`brandingChanged`) applies the cached theme at once.
 *
 * Core: no Electron. HTTP goes through the host's client.
 */

import { runtimeHost } from '../../host/runtimeHost'
import { publishEvent } from '../../host/events'
import { userRepo } from '../../db/users'
import { appSettingsRepo } from '../../db/appSettings'
import { chatModeService } from '../chatModeService'
import { brandThemeRepo, type BrandThemeAssetRow } from '../../db/brandThemes'
import { getProfileScopeUserId } from '../../auth/scope'
import { getLastUserId } from '../../auth/session'
import { createLogger } from '../../logger/logger'
import { DEFAULT_USER_ID } from '../../../shared/userIds'
import {
  BRAND_THEME_CHANGED_CHANNEL,
  type BrandThemeChangedPayload,
  type ResolvedBrandTheme
} from '../../../shared/brandTheme/roles'
import { servedAssetShas } from '../../../shared/brandTheme/servedAssets'
import { REFRESH_INTERVAL_MS } from '../libraryService'
import { BRAND_ASSET_LIMITS, parseBrandTheme, toResolvedBrandTheme, type CheckedAsset } from './parse'

const logger = createLogger('brand-theme')

export const BRAND_THEME_PATH = '/api/v1/brand-theme'
const ASSET_PATH = '/api/v1/brand-theme/assets/'
/** The served document is small JSON; anything near this is not a theme. */
const DOCUMENT_MAX_BYTES = 1024 * 1024
/** A server that accepts and never answers (or trickles) must not hold the per-origin refresh forever. */
const FETCH_TIMEOUT_MS = 60_000
const ASSET_MAX_BYTES = Math.max(BRAND_ASSET_LIMITS.background.raster, BRAND_ASSET_LIMITS.background.svg)

/** A profile's Cinna server: the origin the cache is keyed by and the base `/api/v1` calls go to. */
export interface BrandServer {
  origin: string
  base: string
}

export interface BrandThemeDeps {
  /** Before any activation: the profile the app is starting into (`auth:get-startup`'s pick). */
  startupProfileId(): string
  /** After activation: the active profile. */
  activeProfileId(): string
  serverOf(userId: string): BrandServer | null
  fetch(url: string, init: RequestInit): Promise<Response>
  publish(payload: BrandThemeChangedPayload): void
  /** The profile has a brand: its default chat mode may now take the theme's colour. */
  themeAvailable(userId: string): void
  /** False: the user chose Cinna Original, and every answer is stock. */
  brandingEnabled(): boolean
  intervalMs: number
}

function serverOf(userId: string): BrandServer | null {
  const user = userRepo.get(userId)
  if (!user || user.type !== 'cinna_user' || !user.cinnaServerUrl) return null
  try {
    return { origin: new URL(user.cinnaServerUrl).origin, base: user.cinnaServerUrl.replace(/\/$/, '') }
  } catch {
    return null
  }
}

/** What `auth:get-startup` opens: the last profile when it still exists, else the guest. */
function startupProfileId(): string {
  const last = getLastUserId()
  return userRepo.get(last) ? last : DEFAULT_USER_ID
}

const defaultDeps: BrandThemeDeps = {
  startupProfileId,
  activeProfileId: getProfileScopeUserId,
  serverOf,
  fetch: (url, init) => runtimeHost.http.fetch(url, init),
  publish: (payload) => publishEvent(BRAND_THEME_CHANGED_CHANNEL, payload, 'all'),
  themeAvailable: (userId) => {
    // The channel `useChatModes` already invalidates `['chat-modes']` on: a mode
    // row changed, and a brand refresh has no sync of its own to announce it.
    if (chatModeService.applyThemeDefaultOnce(userId)) publishEvent('providers:account-config-synced', {})
  },
  brandingEnabled: () => appSettingsRepo.get('serverBranding') !== false,
  intervalMs: REFRESH_INTERVAL_MS
}

/** Read a body, or null once it passes `max` bytes (declared or counted). */
async function readCapped(response: Response, max: number): Promise<Buffer | null> {
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > max) {
    await response.body?.cancel().catch(() => undefined)
    return null
  }
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

function checkedAssets(parsed: { logo?: Record<string, CheckedAsset>; background: Record<string, CheckedAsset | null> }): BrandThemeAssetRow[] {
  const all = [...Object.values(parsed.logo ?? {}), ...Object.values(parsed.background)]
  const out = new Map<string, BrandThemeAssetRow>()
  for (const asset of all) if (asset) out.set(asset.sha256, { sha256: asset.sha256, mime: asset.mime, bytes: asset.bytes })
  return [...out.values()]
}

export function createBrandThemeService(deps: BrandThemeDeps = defaultDeps) {
  /** Set once activation applied a profile; until then `get()` answers for the startup profile. */
  let activated = false
  let timer: ReturnType<typeof setInterval> | null = null
  const inFlight = new Map<string, Promise<void>>()
  /** Resolved themes by origin, so a window's `get()` does not re-hash megabytes each time. */
  const resolvedCache = new Map<string, { revision: number; fetchedAt: number; theme: ResolvedBrandTheme | null }>()

  const profileInView = (): string => (activated ? deps.activeProfileId() : deps.startupProfileId())

  const activeOrigin = (): string | null => deps.serverOf(profileInView())?.origin ?? null

  /** The cached theme for an origin as `{ origin, revision }`, or null. */
  const cachedPayload = (origin: string | null): BrandThemeChangedPayload => {
    if (!origin || !deps.brandingEnabled()) return null
    const row = brandThemeRepo.get(origin)
    if (!row) return null
    // A row that no longer resolves is stock: announcing its revision would
    // send windows to `get` (null) while the former look still shows.
    return resolve(origin) ? { origin, revision: row.revision } : null
  }

  const emitIfActive = (origin: string, payload: BrandThemeChangedPayload): void => {
    // Re-checked after every await: the profile may have moved while this fetch ran.
    if (activeOrigin() !== origin) return
    // Cinna Original: windows already show stock, and a new revision changes nothing they show.
    if (!deps.brandingEnabled()) return
    deps.publish(payload)
  }

  const resolve = (origin: string): ResolvedBrandTheme | null => {
    const row = brandThemeRepo.get(origin)
    if (!row) return null
    const known = resolvedCache.get(origin)
    if (known && known.revision === row.revision && known.fetchedAt === row.fetchedAt.getTime()) return known.theme
    const shas = servedAssetShas(row.served)
    const stored = brandThemeRepo.assets(shas)
    const assets = new Map<string, Uint8Array>([...stored].map(([sha, asset]) => [sha, asset.bytes]))
    const parsed = parseBrandTheme(row.served, assets)
    let theme: ResolvedBrandTheme | null = null
    if ('error' in parsed) logger.warn('cached brand theme no longer passes its check; showing stock', { reason: parsed.error })
    else theme = toResolvedBrandTheme(parsed.ok, origin)
    resolvedCache.set(origin, { revision: row.revision, fetchedAt: row.fetchedAt.getTime(), theme })
    return theme
  }

  const refreshOrigin = async (server: BrandServer): Promise<void> => {
    const { origin, base } = server
    const before = brandThemeRepo.get(origin)
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (before?.etag) headers['If-None-Match'] = before.etag
    let response: Response
    try {
      response = await deps.fetch(`${base}${BRAND_THEME_PATH}`, { method: 'GET', headers, cache: 'no-store', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    } catch (err) {
      logger.warn('brand theme refresh failed; keeping the cached theme', { error: err instanceof Error ? err.name : 'error' })
      return
    }
    const status = response.status
    if (status === 304) return
    if (status === 204 || status === 404) {
      await response.body?.cancel().catch(() => undefined)
      if (!before) return
      brandThemeRepo.delete(origin)
      resolvedCache.delete(origin)
      emitIfActive(origin, null)
      return
    }
    if (status !== 200) {
      await response.body?.cancel().catch(() => undefined)
      logger.warn('brand theme refresh failed; keeping the cached theme', { status })
      return
    }
    const etag = response.headers.get('etag')
    let body: Buffer | null
    try {
      body = await readCapped(response, DOCUMENT_MAX_BYTES)
    } catch {
      logger.warn('brand theme refresh failed while reading; keeping the cached theme')
      return
    }
    if (!body) {
      logger.warn('brand theme rejected: the response is too large; keeping the cached theme')
      return
    }
    let doc: unknown
    try {
      doc = JSON.parse(body.toString('utf8'))
    } catch {
      logger.warn('brand theme rejected: the response is not JSON; keeping the cached theme')
      return
    }

    // Assets are content-addressed: fetch only the ones not stored yet, by sha
    // on this server — never from the URL the document names.
    const shas = servedAssetShas(doc)
    const assets = new Map<string, Uint8Array>([...brandThemeRepo.assets(shas)].map(([sha, a]) => [sha, a.bytes]))
    for (const sha of shas.filter((s) => !assets.has(s))) {
      try {
        const res = await deps.fetch(`${base}${ASSET_PATH}${sha}`, { method: 'GET', cache: 'no-store', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
        if (res.status !== 200) {
          await res.body?.cancel().catch(() => undefined)
          logger.warn('brand theme asset fetch failed; keeping the cached theme', { status: res.status })
          return
        }
        const bytes = await readCapped(res, ASSET_MAX_BYTES)
        if (!bytes) {
          logger.warn('brand theme rejected: an asset is too large; keeping the cached theme')
          return
        }
        assets.set(sha, bytes)
      } catch (err) {
        logger.warn('brand theme asset fetch failed; keeping the cached theme', { error: err instanceof Error ? err.name : 'error' })
        return
      }
    }

    const parsed = parseBrandTheme(doc, assets)
    if ('error' in parsed) {
      // A broken publish must not unbrand a working install (desktop.md §3).
      logger.warn('brand theme rejected; keeping the cached theme', { reason: parsed.error })
      return
    }
    // One synchronous transaction: the theme and its assets land together.
    brandThemeRepo.save({ origin, revision: parsed.ok.revision, etag, served: doc, assets: checkedAssets(parsed.ok) })
    resolvedCache.delete(origin)
    if (before && before.revision === parsed.ok.revision) return
    emitIfActive(origin, { origin, revision: parsed.ok.revision })
    if (activeOrigin() === origin) service.adoptDefaultMode(deps.activeProfileId())
  }

  const service = {
    /**
     * The resolved theme for the profile in view, or null (stock Cinna).
     * Before activation that is the profile the app is starting into, even
     * when it is still password-locked: themes are public (B7).
     */
    get(): ResolvedBrandTheme | null {
      if (!deps.brandingEnabled()) return null
      const origin = activeOrigin()
      return origin ? resolve(origin) : null
    },

    /**
     * The cached theme of `userId`'s server, whether or not that profile is
     * active: a sign-in surface (the password lock of a profile being
     * switched to) shows it while it is up. Cache only — never fetches — and
     * null for a profile without a Cinna server.
     */
    resolveForProfile(userId: string): ResolvedBrandTheme | null {
      if (!deps.brandingEnabled()) return null
      const origin = deps.serverOf(userId)?.origin ?? null
      return origin ? resolve(origin) : null
    },

    /**
     * Offer the one-time Theme Default colour to `userId`'s default chat mode,
     * if that profile has a brand (cached is enough). Called when a theme lands
     * and after an account-config sync, which may just have made the default.
     * Never throws: a colour is not worth failing either of those for.
     */
    adoptDefaultMode(userId: string): void {
      try {
        if (service.resolveForProfile(userId)) deps.themeAvailable(userId)
      } catch (err) {
        logger.warn('default chat mode could not adopt the theme colour', { error: err instanceof Error ? err.message : 'error' })
      }
    },

    /**
     * Activation set `userId` as the current profile: apply its server's
     * cached theme now, before anything is awaited, so no window shows the
     * former profile's look over the new profile's data. Null for a profile
     * without a Cinna server.
     */
    applyForProfile(userId: string): void {
      activated = true
      let payload: BrandThemeChangedPayload = null
      try {
        payload = cachedPayload(deps.serverOf(userId)?.origin ?? null)
      } catch (err) {
        // A cache that cannot be read is stock Cinna, never a failed activation.
        logger.warn('brand theme cache could not be read; showing stock', { error: err instanceof Error ? err.message : 'error' })
      }
      deps.publish(payload)
    },

    /**
     * The user moved Branding: announce what the profile in view shows now —
     * null for Cinna Original, else its cached theme's revision, which every
     * window then fetches. Turning branding on also offers the default mode
     * its one-time Theme Default colour, as a theme landing would have.
     * Never throws: the setting is saved either way.
     */
    brandingChanged(): void {
      let payload: BrandThemeChangedPayload = null
      try {
        payload = cachedPayload(activeOrigin())
      } catch (err) {
        logger.warn('brand theme cache could not be read; showing stock', { error: err instanceof Error ? err.message : 'error' })
      }
      deps.publish(payload)
      if (payload && activated) service.adoptDefaultMode(deps.activeProfileId())
    },

    /** Fetch the profile's server theme once. Never throws. */
    async refresh(userId: string): Promise<void> {
      const server = deps.serverOf(userId)
      if (!server) return
      const running = inFlight.get(server.origin)
      if (running) return running
      const run = refreshOrigin(server)
        .catch((err) => {
          logger.warn('brand theme refresh failed', { error: err instanceof Error ? err.message : 'error' })
        })
        .finally(() => inFlight.delete(server.origin))
      inFlight.set(server.origin, run)
      return run
    },

    /** Refresh now and every five minutes (the team library's cadence) while the profile is active. */
    start(userId: string): void {
      service.stop()
      if (!deps.serverOf(userId)) return
      timer = setInterval(() => void service.refresh(userId), deps.intervalMs)
      timer.unref?.()
      void service.refresh(userId)
    },

    stop(): void {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    },

    /** Tests only. */
    _reset(): void {
      service.stop()
      activated = false
      inFlight.clear()
      resolvedCache.clear()
    }
  }
  return service
}

export type BrandThemeService = ReturnType<typeof createBrandThemeService>

export const brandThemeService = createBrandThemeService()
