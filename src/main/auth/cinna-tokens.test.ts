import { beforeEach, expect, it, vi } from 'vitest'
import type { CinnaTokenState } from '../db/users'

const holder = vi.hoisted(() => ({ state: null as CinnaTokenState | null }))
const refresh = vi.hoisted(() => vi.fn())
const clear = vi.hoisted(() => vi.fn(() => { holder.state = null }))
vi.mock('../db/users', () => ({ userRepo: {
  getCinnaTokenState: () => holder.state,
  clearCinnaTokens: clear,
  setCinnaTokens: (_userId: string, input: { clientId: string; accessTokenEnc: Buffer; refreshTokenEnc: Buffer; expiresAt: number }) => {
    holder.state = { serverUrl: 'https://service.test', ...input }
  }
} }))
vi.mock('../security/keystore', () => ({ encryptApiKey: (value: string) => Buffer.from(value), decryptApiKey: (value: Buffer) => value.toString() }))
vi.mock('./cinna-oauth', () => ({ refreshCinnaTokens: refresh, CinnaReauthRequired: class extends Error {} }))
const { storeCinnaTokens, getCinnaAccessToken } = await import('./cinna-tokens')
const { CinnaReauthRequired } = await import('./cinna-oauth')
const { CinnaSessionChanged } = await import('./cinna-session')

const tokens = (value: string, expiresIn = -1) => ({ clientId: 'client', accessToken: value, refreshToken: `refresh-${value}`, expiresIn })
beforeEach(() => { refresh.mockReset(); clear.mockClear(); storeCinnaTokens('u', tokens('old')) })

it('coalesces one session refresh and rotates it without invalidating ordinary callers', async () => {
  refresh.mockResolvedValue({ accessToken: 'rotated', refreshToken: 'next', expiresIn: 3600 })
  expect(await Promise.all([getCinnaAccessToken('u'), getCinnaAccessToken('u')])).toEqual(['rotated', 'rotated'])
  expect(refresh).toHaveBeenCalledTimes(1)
  expect(await getCinnaAccessToken('u')).toBe('rotated')
  expect(holder.state?.refreshTokenEnc?.toString()).toBe('next')
})

it.each(['success', 'revoked'])('does not replace or clear a newly authenticated session after old refresh %s', async (outcome) => {
  let resolve!: (value: unknown) => void
  let reject!: (error: Error) => void
  refresh.mockReturnValue(new Promise((yes, no) => { resolve = yes; reject = no }))
  const old = getCinnaAccessToken('u')
  const rejected = expect(old).rejects.toBeInstanceOf(CinnaSessionChanged)
  await Promise.resolve()
  storeCinnaTokens('u', tokens('new-login', 3600))
  if (outcome === 'success') resolve({ accessToken: 'stale', refreshToken: 'stale-refresh', expiresIn: 3600 })
  else reject(new CinnaReauthRequired('Revoked old session'))
  await rejected
  expect(await getCinnaAccessToken('u')).toBe('new-login')
  expect(holder.state?.refreshTokenEnc?.toString()).toBe('refresh-new-login')
  expect(clear).not.toHaveBeenCalled()
})

it('a replacement session never joins or loses its refresh to the old promise', async () => {
  let finishOld!: (value: unknown) => void
  let finishNew!: (value: unknown) => void
  refresh.mockReturnValueOnce(new Promise((resolve) => { finishOld = resolve }))
    .mockReturnValueOnce(new Promise((resolve) => { finishNew = resolve }))
  const old = getCinnaAccessToken('u')
  const rejected = expect(old).rejects.toBeInstanceOf(CinnaSessionChanged)
  await Promise.resolve()
  storeCinnaTokens('u', tokens('replacement'))
  const current = getCinnaAccessToken('u')
  await Promise.resolve()
  finishOld({ accessToken: 'old-result', refreshToken: 'old-refresh', expiresIn: 3600 })
  await rejected
  const join = getCinnaAccessToken('u')
  finishNew({ accessToken: 'new-result', refreshToken: 'new-refresh', expiresIn: 3600 })
  expect(await Promise.all([current, join])).toEqual(['new-result', 'new-result'])
  expect(refresh).toHaveBeenCalledTimes(2)
})

it('does not begin an old refresh after a synchronous login replacement', async () => {
  const pending = getCinnaAccessToken('u')
  storeCinnaTokens('u', tokens('replacement', 3600))
  await expect(pending).rejects.toBeInstanceOf(CinnaSessionChanged)
  expect(refresh).not.toHaveBeenCalled()
  expect(await getCinnaAccessToken('u')).toBe('replacement')
})
