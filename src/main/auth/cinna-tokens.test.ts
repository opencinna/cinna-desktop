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
vi.mock('../security/keystore', () => ({ encryptApiKey: async (value: string) => Buffer.from(value), decryptApiKey: async (value: Buffer) => value.toString() }))
vi.mock('./cinna-oauth', () => ({ refreshCinnaTokens: refresh, CinnaReauthRequired: class extends Error {} }))
const { storeCinnaTokens, getCinnaAccessToken, getStoredCinnaSubject, onCinnaTokensCleared } = await import('./cinna-tokens')
const { CinnaReauthRequired } = await import('./cinna-oauth')
const { CinnaSessionChanged } = await import('./cinna-session')

const tokens = (value: string, expiresIn = -1) => ({ clientId: 'client', accessToken: value, refreshToken: `refresh-${value}`, expiresIn })
beforeEach(async () => { refresh.mockReset(); clear.mockClear(); await storeCinnaTokens('u', tokens('old')) })

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
  await storeCinnaTokens('u', tokens('new-login', 3600))
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
  await storeCinnaTokens('u', tokens('replacement'))
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
  await storeCinnaTokens('u', tokens('replacement', 3600))
  await expect(pending).rejects.toBeInstanceOf(CinnaSessionChanged)
  expect(refresh).not.toHaveBeenCalled()
  expect(await getCinnaAccessToken('u')).toBe('replacement')
})

it('reads the stored subject offline even when the access token is expired', async () => {
  const token = 'header.' + Buffer.from(JSON.stringify({ sub: 'stable-account', exp: 1 })).toString('base64url') + '.signature'
  await storeCinnaTokens('u', tokens(token))
  expect(await getStoredCinnaSubject('u')).toBe('stable-account')
  expect(refresh).not.toHaveBeenCalled()
  expect(clear).not.toHaveBeenCalled()
  holder.state = null
  await expect(getStoredCinnaSubject('u')).rejects.toThrow('No Cinna access token')
})

it('a refused refresh clears the tokens and tells the cleared listeners once, with the profile', async () => {
  const heard: string[] = []
  const stop = onCinnaTokensCleared((id) => heard.push(id))
  try {
    refresh.mockRejectedValue(new CinnaReauthRequired('Client revoked'))
    await expect(getCinnaAccessToken('u')).rejects.toBeInstanceOf(CinnaReauthRequired)
    expect(clear).toHaveBeenCalledWith('u')
    expect(heard).toEqual(['u'])
  } finally { stop() }
})

it('a superseded refresh that is refused clears nothing and tells no one; a throwing listener does not stop the others', async () => {
  const heard: string[] = []
  const stops = [onCinnaTokensCleared(() => { throw new Error('boom') }), onCinnaTokensCleared((id) => heard.push(id))]
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    let reject!: (error: Error) => void
    refresh.mockReturnValueOnce(new Promise((_, no) => { reject = no }))
    const old = getCinnaAccessToken('u')
    const rejected = expect(old).rejects.toBeInstanceOf(CinnaSessionChanged)
    await Promise.resolve()
    await storeCinnaTokens('u', tokens('new-login'))
    reject(new CinnaReauthRequired('Revoked old session'))
    await rejected
    expect(heard).toEqual([])
    refresh.mockRejectedValue(new CinnaReauthRequired('Revoked'))
    await expect(getCinnaAccessToken('u')).rejects.toBeInstanceOf(CinnaReauthRequired)
    expect(heard).toEqual(['u'])
  } finally { stops.forEach((stop) => stop()); quiet.mockRestore() }
})
