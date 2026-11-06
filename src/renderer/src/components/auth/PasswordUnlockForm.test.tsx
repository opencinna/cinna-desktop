import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ResolvedBrandTheme } from '../../../../shared/brandTheme/roles'

/**
 * The password lock shows the brand of the server it unlocks while it is up
 * (LoginScreen at startup, LoginPrompt when switching), and closing it puts
 * the active profile's look back.
 */
vi.mock('../../hooks/useAuth', () => ({ useLogin: () => ({ mutateAsync: vi.fn(), isPending: false }) }))
const { PasswordUnlockForm } = await import('./PasswordUnlockForm')
const { applyBrandTheme, useBrandThemeStore } = await import('../../stores/brandTheme.store')

const served = JSON.parse(
  readFileSync(join(process.cwd(), 'src/shared/brandTheme/fixtures/valid/full/served/served.json'), 'utf8')
) as { theme: { modes: ResolvedBrandTheme['modes'] } }

const brand = (origin: string): ResolvedBrandTheme => ({
  origin,
  revision: 3,
  name: 'Acme',
  modes: served.theme.modes,
  background: { dark: null, light: null },
  copy: {}
})
const active = brand('https://active.example')

let getForProfile: ReturnType<typeof vi.fn>
beforeEach(() => {
  getForProfile = vi.fn()
  ;(window as unknown as { api: unknown }).api = { brandTheme: { get: vi.fn(), getForProfile, onChanged: () => () => {} } }
  // The active profile's brand is what the store shows before the lock opens.
  useBrandThemeStore.setState({ active, override: null, theme: active, key: 'https://active.example#3' })
})
afterEach(() => {
  useBrandThemeStore.setState({ active: null, override: null })
  applyBrandTheme(null, { background: true })
})

it('shows the locked profile\'s server brand while mounted and the active one after', async () => {
  getForProfile.mockResolvedValueOnce(brand('https://locked.example'))
  const view = render(<PasswordUnlockForm userId="bob" userName="Bob" onSuccess={() => {}} />)
  await act(async () => { await Promise.resolve() })
  expect(getForProfile).toHaveBeenCalledWith('bob')
  expect(useBrandThemeStore.getState().override?.userId).toBe('bob')
  expect(useBrandThemeStore.getState().theme?.origin).toBe('https://locked.example')
  expect(document.documentElement.hasAttribute('data-brand')).toBe(true)
  view.unmount()
  expect(useBrandThemeStore.getState().override).toBeNull()
  expect(useBrandThemeStore.getState().theme?.origin).toBe('https://active.example')
})

it('a locked profile on a stock server shows stock, not the active brand', async () => {
  getForProfile.mockResolvedValueOnce(null)
  const view = render(<PasswordUnlockForm userId="bob" userName="Bob" onSuccess={() => {}} />)
  await act(async () => { await Promise.resolve() })
  expect(useBrandThemeStore.getState().theme).toBeNull()
  expect(document.documentElement.hasAttribute('data-brand')).toBe(false)
  view.unmount()
  expect(useBrandThemeStore.getState().theme?.origin).toBe('https://active.example')
})
