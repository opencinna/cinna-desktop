import { useEffect } from 'react'
import { create } from 'zustand'
import type { BrandThemeChangedPayload, ResolvedBrandTheme } from '../../../shared/brandTheme/roles'
import { buildBrandThemeCss, type BrandSheetOptions } from '../utils/brandThemeCss'

/**
 * The brand theme this window shows: the active profile's server theme, or
 * null for stock Cinna. Main owns which theme that is; a window asks for it
 * before first paint (`initBrandTheme`) and again whenever main says another
 * revision is current (`brandTheme:changed`, which carries only
 * `{ origin, revision }`).
 *
 * Applying is two DOM writes: one `<style id="brand-theme">` holding the
 * sheet from `utils/brandThemeCss.ts`, and `data-brand` on `<html>`, which
 * every brand rule keys on. With no theme both go, and the stock CSS shows.
 *
 * A sign-in surface for a profile that is not active yet can put an override
 * on top (`useBrandThemeForProfile`): the document shows the override while
 * it is up, `brandTheme:changed` keeps `active` current underneath, and
 * removing the override shows `active` again.
 */

export const BRAND_STYLE_ID = 'brand-theme'

interface BrandThemeState {
  /** The active profile's theme, as main last said (null: stock). Kept current while an override shows. */
  active: ResolvedBrandTheme | null
  /**
   * A sign-in surface showing another profile (its password lock) shows that
   * profile's server theme instead. Present with a null theme means "that
   * profile's server is stock": the document shows stock even when the active
   * profile is branded.
   */
  override: { userId: string; theme: ResolvedBrandTheme | null } | null
  /** The theme the document shows: `override.theme` while an override is present, else `active`. */
  theme: ResolvedBrandTheme | null
  /** `<origin>#<revision>` of the theme shown, or null. Dashboard frames re-read their variables when it moves. */
  key: string | null
}

export const useBrandThemeStore = create<BrandThemeState>(() => ({ active: null, override: null, theme: null, key: null }))

function keyOf(payload: { origin: string; revision: number } | null): string | null {
  return payload ? `${payload.origin}#${payload.revision}` : null
}

function removeBrand(): void {
  document.getElementById(BRAND_STYLE_ID)?.remove()
  document.documentElement.removeAttribute('data-brand')
}

/** The sheet options this window was started with (the tray popup has no background). */
let sheetOptions: BrandSheetOptions = { background: true }

/**
 * Write `theme` to this document (null: stock) and record it as what is
 * shown. A theme the builder refuses is stock too. Does not touch `active` or
 * `override`: callers decide what to show.
 */
export function applyBrandTheme(theme: ResolvedBrandTheme | null, options: BrandSheetOptions): void {
  const css = theme ? buildBrandThemeCss(theme, options) : null
  if (!theme || css === null) {
    if (theme) console.warn('brand theme refused by the sheet builder; showing stock')
    removeBrand()
    useBrandThemeStore.setState({ theme: null, key: null })
    return
  }
  let style = document.getElementById(BRAND_STYLE_ID) as HTMLStyleElement | null
  if (!style) {
    style = document.createElement('style')
    style.id = BRAND_STYLE_ID
    document.head.appendChild(style)
  }
  style.textContent = css
  document.documentElement.setAttribute('data-brand', '')
  useBrandThemeStore.setState({ theme, key: keyOf(theme) })
}

/** Show what the state says: the override's theme while one is present, else the active one. */
function render(): void {
  const { active, override } = useBrandThemeStore.getState()
  applyBrandTheme(override ? override.theme : active, sheetOptions)
}

/** Main's theme moved: record it, and show it unless an override is up. */
function setActive(theme: ResolvedBrandTheme | null): void {
  useBrandThemeStore.setState({ active: theme })
  if (!useBrandThemeStore.getState().override) render()
}

let requested = 0

async function fetchAndApply(): Promise<void> {
  const ticket = ++requested
  let theme: ResolvedBrandTheme | null = null
  try {
    theme = await window.api.brandTheme.get()
  } catch {
    theme = null
  }
  // A later change already asked again: its answer wins.
  if (ticket !== requested) return
  setActive(theme)
}

/** Main moved the brand: drop it, or fetch the theme unless this window already has that revision. */
export function handleBrandThemeChanged(payload: BrandThemeChangedPayload, options: BrandSheetOptions): Promise<void> {
  sheetOptions = options
  if (payload === null) {
    requested += 1
    setActive(null)
    return Promise.resolve()
  }
  const key = keyOf(payload)
  const { active, override } = useBrandThemeStore.getState()
  if (key === keyOf(active)) {
    // Still invalidate any older request in flight, which would otherwise replace this one.
    requested += 1
    return Promise.resolve()
  }
  if (override?.theme && key === keyOf(override.theme)) {
    // Unlocking the profile the override shows: main now names the theme
    // already on screen, so it becomes the active one without a round trip
    // (and nothing flashes when the lock closes).
    requested += 1
    setActive(override.theme)
    return Promise.resolve()
  }
  return fetchAndApply()
}

/**
 * Before React mounts: apply the brand, then follow main's changes. Resolves
 * once the first answer is applied (or stock, if asking failed), so the
 * first frame already has the brand's colours.
 */
export async function initBrandTheme(options: BrandSheetOptions): Promise<() => void> {
  sheetOptions = options
  const unsubscribe = window.api.brandTheme.onChanged((payload) => void handleBrandThemeChanged(payload, options))
  await fetchAndApply()
  return unsubscribe
}

/** Which mount owns the override; a cleanup clears it only if it is still its own. */
let overrideTicket = 0

/**
 * While the calling component is mounted, show `userId`'s server theme (from
 * main's cache) in place of the active profile's: a password lock looks like
 * the server it unlocks. Unmounting restores the active profile's look; an
 * answer that arrives after the user id moved or the component went is
 * dropped. A falsy `userId` overrides nothing.
 */
export function useBrandThemeForProfile(userId: string | null | undefined): void {
  useEffect(() => {
    if (!userId) return
    const ticket = ++overrideTicket
    void (async () => {
      let theme: ResolvedBrandTheme | null = null
      try {
        theme = await window.api.brandTheme.getForProfile(userId)
      } catch {
        theme = null
      }
      if (ticket !== overrideTicket) return
      useBrandThemeStore.setState({ override: { userId, theme } })
      render()
    })()
    return () => {
      if (ticket !== overrideTicket) return
      // Any answer still in flight for this mount is now stale.
      overrideTicket += 1
      if (!useBrandThemeStore.getState().override) return
      useBrandThemeStore.setState({ override: null })
      render()
    }
  }, [userId])
}
