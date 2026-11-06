import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrandThemeChangedPayload, ResolvedBrandTheme } from '../../../shared/brandTheme/roles'
import { BRAND_STYLE_ID, applyBrandTheme, handleBrandThemeChanged, initBrandTheme, useBrandThemeStore } from './brandTheme.store'

const served = JSON.parse(
  readFileSync(join(process.cwd(), 'src/shared/brandTheme/fixtures/valid/full/served/served.json'), 'utf8')
) as { theme: { name: string; modes: ResolvedBrandTheme['modes'] } }

const theme = (revision: number): ResolvedBrandTheme => ({
  origin: 'https://acme.example',
  revision,
  name: served.theme.name,
  modes: JSON.parse(JSON.stringify(served.theme.modes)) as ResolvedBrandTheme['modes'],
  background: { dark: null, light: null },
  copy: {}
})

const options = { background: true }
const sheet = (): string | null => document.getElementById(BRAND_STYLE_ID)?.textContent ?? null

let get: ReturnType<typeof vi.fn>
let listener: ((payload: BrandThemeChangedPayload) => void) | null

beforeEach(() => {
  get = vi.fn()
  listener = null
  ;(window as unknown as { api: unknown }).api = {
    brandTheme: {
      get,
      onChanged: (cb: (payload: BrandThemeChangedPayload) => void) => {
        listener = cb
        return () => { listener = null }
      }
    }
  }
})
afterEach(() => {
  applyBrandTheme(null, options)
})

describe('brand theme store', () => {
  it('applies a theme: one <style> and data-brand; null removes both', () => {
    applyBrandTheme(theme(1), options)
    expect(document.documentElement.hasAttribute('data-brand')).toBe(true)
    expect(document.querySelectorAll(`#${BRAND_STYLE_ID}`)).toHaveLength(1)
    expect(sheet()).toContain('--color-accent: #d97a4a;')
    applyBrandTheme(theme(2), options)
    expect(document.querySelectorAll(`#${BRAND_STYLE_ID}`)).toHaveLength(1)
    expect(useBrandThemeStore.getState().key).toBe('https://acme.example#2')
    applyBrandTheme(null, options)
    expect(document.documentElement.hasAttribute('data-brand')).toBe(false)
    expect(sheet()).toBeNull()
    expect(useBrandThemeStore.getState().key).toBeNull()
  })

  it('a theme the builder refuses shows stock', () => {
    const bad = theme(1)
    bad.modes.dark.accent = 'red'
    applyBrandTheme(bad, options)
    expect(document.documentElement.hasAttribute('data-brand')).toBe(false)
    expect(sheet()).toBeNull()
  })

  it('initBrandTheme applies before resolving, then follows changes; the same revision is not fetched again', async () => {
    get.mockResolvedValueOnce(theme(1))
    await initBrandTheme(options)
    expect(sheet()).toContain('--color-bg: #0f0f0f;')
    expect(get).toHaveBeenCalledTimes(1)

    listener!({ origin: 'https://acme.example', revision: 1 })
    await Promise.resolve()
    expect(get).toHaveBeenCalledTimes(1)

    get.mockResolvedValueOnce(theme(2))
    await handleBrandThemeChanged({ origin: 'https://acme.example', revision: 2 }, options)
    expect(useBrandThemeStore.getState().key).toBe('https://acme.example#2')

    listener!(null)
    expect(sheet()).toBeNull()
  })

  it('a get that fails leaves stock', async () => {
    get.mockRejectedValueOnce(new Error('no handler'))
    await initBrandTheme(options)
    expect(document.documentElement.hasAttribute('data-brand')).toBe(false)
  })

  it('a later change wins over an earlier get still in flight', async () => {
    let finishFirst: (value: ResolvedBrandTheme) => void = () => {}
    get.mockImplementationOnce(() => new Promise<ResolvedBrandTheme>((resolve) => { finishFirst = resolve }))
    const first = handleBrandThemeChanged({ origin: 'https://acme.example', revision: 1 }, options)
    await handleBrandThemeChanged(null, options)
    finishFirst(theme(1))
    await first
    expect(document.documentElement.hasAttribute('data-brand')).toBe(false)
  })
})
