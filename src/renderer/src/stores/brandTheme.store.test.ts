import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrandThemeChangedPayload, ResolvedBrandTheme } from '../../../shared/brandTheme/roles'
import { act, renderHook } from '@testing-library/react'
import {
  BRAND_STYLE_ID,
  applyBrandTheme,
  brandThemeSettled,
  handleBrandThemeChanged,
  initBrandTheme,
  useBrandThemeForProfile,
  useBrandThemeStore
} from './brandTheme.store'

const served = JSON.parse(
  readFileSync(join(process.cwd(), 'src/shared/brandTheme/fixtures/valid/full/served/served.json'), 'utf8')
) as { theme: { name: string; modes: ResolvedBrandTheme['modes'] } }

const theme = (revision: number, origin = 'https://acme.example'): ResolvedBrandTheme => ({
  origin,
  revision,
  name: served.theme.name,
  modes: JSON.parse(JSON.stringify(served.theme.modes)) as ResolvedBrandTheme['modes'],
  background: { dark: null, light: null },
  copy: {}
})

const options = { background: true }
const sheet = (): string | null => document.getElementById(BRAND_STYLE_ID)?.textContent ?? null

let get: ReturnType<typeof vi.fn>
let getForProfile: ReturnType<typeof vi.fn>
let listener: ((payload: BrandThemeChangedPayload) => void) | null

beforeEach(() => {
  get = vi.fn()
  getForProfile = vi.fn()
  listener = null
  ;(window as unknown as { api: unknown }).api = {
    brandTheme: {
      get,
      getForProfile,
      onChanged: (cb: (payload: BrandThemeChangedPayload) => void) => {
        listener = cb
        return () => { listener = null }
      }
    }
  }
})
afterEach(() => {
  useBrandThemeStore.setState({ active: null, override: null })
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

describe('a profile override (sign-in surfaces)', () => {
  const shown = (): string | null => useBrandThemeStore.getState().key
  const flush = async (): Promise<void> => { await act(async () => { await Promise.resolve() }) }

  /** Active: acme rev 1, applied as at startup. */
  async function startBranded(): Promise<void> {
    get.mockResolvedValueOnce(theme(1))
    await initBrandTheme(options)
    expect(shown()).toBe('https://acme.example#1')
  }

  it('a profile on a stock server shows stock over a branded active profile, and unmount restores the active brand', async () => {
    await startBranded()
    getForProfile.mockResolvedValueOnce(null)
    const view = renderHook(() => useBrandThemeForProfile('bob'))
    await flush()
    expect(getForProfile).toHaveBeenCalledWith('bob')
    expect(useBrandThemeStore.getState().override).toEqual({ userId: 'bob', theme: null })
    expect(document.documentElement.hasAttribute('data-brand')).toBe(false)
    expect(shown()).toBeNull()
    view.unmount()
    expect(useBrandThemeStore.getState().override).toBeNull()
    expect(document.documentElement.hasAttribute('data-brand')).toBe(true)
    expect(shown()).toBe('https://acme.example#1')
  })

  it('a branded profile over a stock active one shows its theme', async () => {
    get.mockResolvedValueOnce(null)
    await initBrandTheme(options)
    getForProfile.mockResolvedValueOnce(theme(4, 'https://other.example'))
    const view = renderHook(() => useBrandThemeForProfile('bob'))
    await flush()
    expect(shown()).toBe('https://other.example#4')
    expect(sheet()).toContain('--color-accent:')
    view.unmount()
    expect(shown()).toBeNull()
    expect(sheet()).toBeNull()
  })

  it('changed events while an override shows update the active theme underneath, not the display', async () => {
    await startBranded()
    getForProfile.mockResolvedValueOnce(theme(4, 'https://other.example'))
    const view = renderHook(() => useBrandThemeForProfile('bob'))
    await flush()
    get.mockResolvedValueOnce(theme(2))
    await act(() => handleBrandThemeChanged({ origin: 'https://acme.example', revision: 2 }, options))
    expect(useBrandThemeStore.getState().active?.revision).toBe(2)
    expect(shown()).toBe('https://other.example#4')
    await act(() => handleBrandThemeChanged(null, options))
    expect(useBrandThemeStore.getState().active).toBeNull()
    expect(shown()).toBe('https://other.example#4')
    view.unmount()
    expect(shown()).toBeNull()
  })

  it('unlocking the overridden profile adopts its theme as active without another get', async () => {
    await startBranded()
    getForProfile.mockResolvedValueOnce(theme(4, 'https://other.example'))
    const view = renderHook(() => useBrandThemeForProfile('bob'))
    await flush()
    get.mockClear()
    await act(() => handleBrandThemeChanged({ origin: 'https://other.example', revision: 4 }, options))
    expect(get).not.toHaveBeenCalled()
    view.unmount()
    expect(shown()).toBe('https://other.example#4')
  })

  it('an answer for a previous user id, or after unmount, is ignored', async () => {
    await startBranded()
    let answerAlice: (value: ResolvedBrandTheme | null) => void = () => {}
    getForProfile.mockImplementationOnce(() => new Promise((resolve) => { answerAlice = resolve }))
    getForProfile.mockResolvedValueOnce(null)
    const view = renderHook(({ id }) => useBrandThemeForProfile(id), { initialProps: { id: 'alice' } })
    view.rerender({ id: 'bob' })
    await flush()
    expect(useBrandThemeStore.getState().override).toEqual({ userId: 'bob', theme: null })
    await act(async () => { answerAlice(theme(9, 'https://alice.example')) })
    expect(useBrandThemeStore.getState().override).toEqual({ userId: 'bob', theme: null })
    expect(shown()).toBeNull()

    let late: (value: ResolvedBrandTheme | null) => void = () => {}
    getForProfile.mockImplementationOnce(() => new Promise((resolve) => { late = resolve }))
    view.rerender({ id: 'carol' })
    view.unmount()
    await act(async () => { late(theme(7, 'https://carol.example')) })
    expect(useBrandThemeStore.getState().override).toBeNull()
    expect(shown()).toBe('https://acme.example#1')
  })

  it('a getForProfile that fails shows stock for that profile', async () => {
    await startBranded()
    getForProfile.mockRejectedValueOnce(new Error('no handler'))
    const view = renderHook(() => useBrandThemeForProfile('bob'))
    await flush()
    expect(shown()).toBeNull()
    view.unmount()
    expect(shown()).toBe('https://acme.example#1')
  })
})

describe('brandThemeSettled (profile switch waits for the brand)', () => {
  it('resolves only after the get started by a change is applied, and at once when nothing is pending', async () => {
    let answer: (t: ResolvedBrandTheme | null) => void = () => {}
    get.mockReturnValue(new Promise((resolve) => { answer = resolve }))
    void handleBrandThemeChanged({ origin: 'https://acme.example', revision: 9 }, options)
    let settled = false
    const wait = brandThemeSettled().then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(document.documentElement.hasAttribute('data-brand')).toBe(false)
    answer(theme(9))
    await wait
    expect(settled).toBe(true)
    expect(document.documentElement.hasAttribute('data-brand')).toBe(true)
    await expect(brandThemeSettled()).resolves.toBeUndefined()
  })
})
