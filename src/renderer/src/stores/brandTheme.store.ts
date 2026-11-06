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
 */

export const BRAND_STYLE_ID = 'brand-theme'

interface BrandThemeState {
  theme: ResolvedBrandTheme | null
  /** `<origin>#<revision>` of the theme applied, or null. Dashboard frames re-read their variables when it moves. */
  key: string | null
}

export const useBrandThemeStore = create<BrandThemeState>(() => ({ theme: null, key: null }))

function keyOf(payload: { origin: string; revision: number } | null): string | null {
  return payload ? `${payload.origin}#${payload.revision}` : null
}

function removeBrand(): void {
  document.getElementById(BRAND_STYLE_ID)?.remove()
  document.documentElement.removeAttribute('data-brand')
}

/** Apply `theme` to this document (null: stock). A theme the builder refuses is stock too. */
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

let requested = 0

async function fetchAndApply(options: BrandSheetOptions): Promise<void> {
  const ticket = ++requested
  let theme: ResolvedBrandTheme | null = null
  try {
    theme = await window.api.brandTheme.get()
  } catch {
    theme = null
  }
  // A later change already asked again: its answer wins.
  if (ticket !== requested) return
  applyBrandTheme(theme, options)
}

/** Main moved the brand: drop it, or fetch the theme unless this window already shows that revision. */
export function handleBrandThemeChanged(payload: BrandThemeChangedPayload, options: BrandSheetOptions): Promise<void> {
  if (payload === null) {
    requested += 1
    applyBrandTheme(null, options)
    return Promise.resolve()
  }
  if (keyOf(payload) === useBrandThemeStore.getState().key) {
    // Still invalidate any older request in flight, which would otherwise replace this one.
    requested += 1
    return Promise.resolve()
  }
  return fetchAndApply(options)
}

/**
 * Before React mounts: apply the brand, then follow main's changes. Resolves
 * once the first answer is applied (or stock, if asking failed), so the
 * first frame already has the brand's colours.
 */
export async function initBrandTheme(options: BrandSheetOptions): Promise<() => void> {
  const unsubscribe = window.api.brandTheme.onChanged((payload) => void handleBrandThemeChanged(payload, options))
  await fetchAndApply(options)
  return unsubscribe
}
