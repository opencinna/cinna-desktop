vi.mock('../host/desktopFeatures', async () => {
  const { localDevService } = await import('../localdev/localDevService')
  return { desktopFeatures: { authCompleted() {}, reconcileDevelopment: localDevService.reconcile } }
})
vi.mock('../host/runtimeHost', async () => {
  const { createDesktopHost } = await import('../host/desktop/runtimeHost')
  return { runtimeHost: createDesktopHost() }
})
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'

/**
 * The two places `authService` tells the task layer that a profile's link to a
 * remote service is no longer the one it had.
 *
 * **Why this file exists at all.** Both calls are one-liners in a module that
 * had no tests, and the step-9a review found that deleting either of them left
 * the entire suite green — the unit tests drive `resetCursors` and
 * `forgetBindings` directly, so they prove the functions work and nothing
 * proves they are ever called. The hazard they guard is silent by nature (a
 * half-empty profile, a deep link into a server this account cannot see), so a
 * missing call would not announce itself either.
 *
 * The database and `userRepo` are real, because the fact under test is about
 * profile *rows* — that a rebind finds an existing row by email and keeps its
 * id. Only the outside world is mocked: the browser OAuth flow, the token
 * store, activation, and sync. `taskSyncService` is mocked because what is
 * being asserted is the call, not its effect.
 */

const holder = vi.hoisted(() => ({
  current: null as TestDatabase | null,
  /** What the browser flow comes back with. Each test sets the email/server. */
  profileEmail: 'a@b.test',
  currentUserId: null as string | null,
  activated: false
}))

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/cinna-auth-test' } }))
vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../db/client', () => ({
  getDb: () => {
    if (!holder.current) throw new Error('test database not initialised')
    return holder.current.db
  },
  getRawSqlite: () => {
    if (!holder.current) throw new Error('test database not initialised')
    return holder.current.sqlite
  }
}))

const oauth = vi.hoisted(() => ({ flow: vi.fn(), Denied: class extends Error {} }))
vi.mock('../auth/cinna-oauth', () => ({
  CINNA_CLOUD_URL: 'https://cloud.cinna.test',
  startCinnaOAuthFlow: oauth.flow,
  CinnaReauthRequired: class extends Error {},
  CinnaAuthorizationDenied: oauth.Denied
}))
vi.mock('../auth/cinna-tokens', () => ({
  storeCinnaTokens: vi.fn(),
  clearCinnaTokens: vi.fn()
}))
vi.mock('../auth/activation', () => ({
  userActivation: {
    activate: vi.fn(async () => {}),
    deactivate: vi.fn(async () => {}),
    forgetUnlock: vi.fn(),
    clearUnlocks: vi.fn(),
    markUnlocked: vi.fn(),
    credentialsRenewed: vi.fn(),
    isActivated: () => holder.activated
  }
}))
vi.mock('../auth/session', async () => {
  const actual = await vi.importActual<typeof import('../auth/session')>('../auth/session')
  return { ...actual, getCurrentUserId: () => holder.currentUserId }
})
vi.mock('./syncService', () => ({
  syncService: { signOutCleanup: vi.fn(async () => {}), flushBeforeSignOut: vi.fn(async () => {}) }
}))
vi.mock('../host/desktop/connectIntentService', () => ({ connectIntentService: { flush: vi.fn() } }))
vi.mock('../window/focus', () => ({ focusMainWindow: vi.fn() }))
vi.mock('../localdev/localDevService', () => ({ localDevService: { stop: vi.fn(async () => {}), reconcile: vi.fn(async () => {}) } }))

const sync = vi.hoisted(() => ({
  resetCursors: vi.fn(),
  forgetBindings: vi.fn()
}))
vi.mock('./taskSyncService', () => ({ taskSyncService: sync }))

const { authService } = await import('./authService')
const { userRepo } = await import('../db/users')
const { localDevService } = await import('../localdev/localDevService')
const { storeCinnaTokens, clearCinnaTokens } = await import('../auth/cinna-tokens')
const { userActivation } = await import('../auth/activation')
const { syncService } = await import('./syncService')
const { serviceCredentialService } = await import('./serviceCredentials/service')

/** The browser flow, answering for `email` with whatever server it was aimed at. */
function oauthAnswers(email: string): void {
  oauth.flow.mockImplementation(async () => ({
    clientId: 'client-1',
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresIn: 3600,
    profile: { email, displayName: 'A Person', fullName: 'A Person' }
  }))
}

beforeEach(() => {
  holder.current = createTestDatabase()
  holder.currentUserId = null
  holder.activated = false
  vi.mocked(localDevService.reconcile).mockClear()
  vi.mocked(userActivation.credentialsRenewed).mockClear()
  vi.mocked(storeCinnaTokens).mockClear()
  oauth.flow.mockReset()
  sync.resetCursors.mockReset()
  sync.forgetBindings.mockReset()
  oauthAnswers(holder.profileEmail)
})

afterEach(() => {
  holder.current?.close()
  holder.current = null
})

async function signInSelfHosted(serverUrl: string): Promise<string> {
  await authService.registerCinna({ hostingType: 'self_hosted', serverUrl })
  const row = userRepo.getByUsername(holder.profileEmail)
  if (!row) throw new Error('profile row missing after sign-in')
  return row.id
}

describe('a profile re-linked to a different account', () => {
  it('forgets the bindings and cursors it was holding', async () => {
    const first = await signInSelfHosted('https://one.cinna.test')

    // Same email, different server: `registerCinna` finds the row by email and
    // rebinds onto it, so the id survives and everything hanging off it does
    // too — including cursors and `remote_*` columns for the previous account.
    const second = await signInSelfHosted('https://two.cinna.test')
    expect(second).toBe(first)

    expect(sync.forgetBindings).toHaveBeenCalledWith(first)
  })

  it('leaves them alone when the same account signs in again', async () => {
    const id = await signInSelfHosted('https://one.cinna.test')
    sync.forgetBindings.mockReset()

    await signInSelfHosted('https://one.cinna.test')

    // Same email on the same server is the same account. Its bindings are
    // valid, and dropping them would cost a re-link for nothing.
    expect(sync.forgetBindings).not.toHaveBeenCalled()
    expect(userRepo.getByUsername(holder.profileEmail)?.id).toBe(id)
  })
})

describe('a profile whose local data is deleted', () => {
  it('forgets its cursors on sign-out', async () => {
    const id = await signInSelfHosted('https://one.cinna.test')

    await authService.deleteAccount({ userId: id, signOut: true, removeDevice: true })

    expect(sync.resetCursors).toHaveBeenCalledWith(id)
  })

  it('forgets its cursors on a full delete', async () => {
    const id = await signInSelfHosted('https://one.cinna.test')

    await authService.deleteAccount({ userId: id })

    expect(sync.resetCursors).toHaveBeenCalledWith(id)
  })
})


describe('reauthentication that outlives its activated profile', () => {
  it.each(['switched', 'switching', 'unchanged'] as const)(
    'refreshes tokens and reconciles only the still-active account: %s', async (transition) => {
      const id = await signInSelfHosted('https://one.cinna.test')
      holder.currentUserId = id
      holder.activated = true
      const tokens = {
        clientId: 'client-1', accessToken: 'fresh-access', refreshToken: 'fresh-refresh', expiresIn: 3600,
        profile: { email: holder.profileEmail, displayName: 'A Person', fullName: 'A Person' }
      }
      let finish!: (value: typeof tokens) => void
      oauth.flow.mockImplementationOnce(() => new Promise<typeof tokens>((resolve) => { finish = resolve }))
      vi.mocked(storeCinnaTokens).mockClear()
      const reauth = authService.reauthCinna(id)
      if (transition === 'switched') holder.currentUserId = 'profile-b'
      // During a queued activation the session can still name A, but the gate
      // is already closed. Checking just the user ID would revive A here.
      if (transition === 'switching') holder.activated = false
      finish(tokens)
      const result = await reauth

      expect(result.user.id).toBe(id)
      expect(storeCinnaTokens).toHaveBeenCalledExactlyOnceWith(id, tokens)
      // Renewal always reaches service credentials: any signed-in account can deliver.
      expect(userActivation.credentialsRenewed).toHaveBeenCalledExactlyOnceWith(id)
      if (transition === 'unchanged') expect(localDevService.reconcile).toHaveBeenCalledExactlyOnceWith(id)
      else expect(localDevService.reconcile).not.toHaveBeenCalled()
    }
  )
})

describe('re-authentication names the expected account', () => {
  it('sends the profile email as the expected account; first sign-in sends none', async () => {
    const id = await signInSelfHosted('https://one.cinna.test')
    expect(oauth.flow).toHaveBeenLastCalledWith('https://one.cinna.test')
    await authService.reauthCinna(id)
    expect(oauth.flow).toHaveBeenLastCalledWith('https://one.cinna.test', { expectedEmail: holder.profileEmail })
  })

  it('refuses another account with a message naming the expected one, and stores nothing', async () => {
    const id = await signInSelfHosted('https://one.cinna.test')
    vi.mocked(storeCinnaTokens).mockClear()
    oauthAnswers('someone-else@cinna.test')
    await expect(authService.reauthCinna(id)).rejects.toMatchObject({
      code: 'identity_mismatch',
      message: `Sign in as ${holder.profileEmail} to reconnect this profile. The browser signed in as someone-else@cinna.test.`
    })
    expect(storeCinnaTokens).not.toHaveBeenCalled()
    expect(userActivation.credentialsRenewed).not.toHaveBeenCalled()
  })

  it('refuses an email that differs only in case: core may hold such a user as a separate account', async () => {
    const id = await signInSelfHosted('https://one.cinna.test')
    vi.mocked(storeCinnaTokens).mockClear()
    oauthAnswers(holder.profileEmail.toUpperCase())
    await expect(authService.reauthCinna(id)).rejects.toMatchObject({ code: 'identity_mismatch' })
    expect(storeCinnaTokens).not.toHaveBeenCalled()
  })

  it('a sign-in declined in the browser names the expected account and stores nothing', async () => {
    const id = await signInSelfHosted('https://one.cinna.test')
    vi.mocked(storeCinnaTokens).mockClear()
    oauth.flow.mockRejectedValueOnce(new oauth.Denied('declined'))
    await expect(authService.reauthCinna(id)).rejects.toMatchObject({
      code: 'access_denied',
      message: `Sign in as ${holder.profileEmail} to reconnect this profile. The sign-in was declined in the browser.`
    })
    expect(storeCinnaTokens).not.toHaveBeenCalled()
  })
})

describe('creating a local profile', () => {
  // The renderer shows the new profile as soon as `register` returns; main
  // staying on the previous one showed that profile's data under the new name.
  it('makes the new profile the active one', async () => {
    vi.mocked(userActivation.activate).mockClear()
    const { user } = await authService.register({ username: 'second-local' })
    expect(userActivation.activate).toHaveBeenCalledExactlyOnceWith(user.id)
    expect(userActivation.markUnlocked).not.toHaveBeenCalled()
  })

  it('counts a password set at creation as unlocked', async () => {
    vi.mocked(userActivation.markUnlocked).mockClear()
    const { user } = await authService.register({ username: 'locked-local', password: 'Correct-Horse-9-Battery' })
    expect(userActivation.markUnlocked).toHaveBeenCalledExactlyOnceWith(user.id)
    expect(userActivation.activate).toHaveBeenLastCalledWith(user.id)
  })
})

describe('Sign Out that keeps this device\'s data', () => {
  /** Every step the keep-data sign-out takes, in the order it took them. */
  function recordSteps(): string[] {
    const steps: string[] = []
    vi.mocked(syncService.flushBeforeSignOut).mockReset().mockImplementation(async (id) => { steps.push(`flush:${id}`) })
    vi.mocked(syncService.signOutCleanup).mockClear()
    vi.mocked(userActivation.clearUnlocks).mockReset().mockImplementation(() => { steps.push('clearUnlocks') })
    vi.mocked(userActivation.deactivate).mockReset().mockImplementation(async () => { steps.push('deactivate') })
    vi.mocked(userActivation.activate).mockReset().mockImplementation(async (id) => { steps.push(`activate:${id}`) })
    vi.mocked(clearCinnaTokens).mockReset().mockImplementation((id) => { steps.push(`clearTokens:${id}`) })
    vi.spyOn(serviceCredentialService, 'signOut').mockImplementation((id) => { steps.push(`credentialsSignOut:${id}`) })
    return steps
  }
  afterEach(() => vi.restoreAllMocks())

  it('flushes sync, signs credentials out, clears the tokens and keeps the profile and its data', async () => {
    const id = await signInSelfHosted('https://one.cinna.test')
    holder.currentUserId = id
    const steps = recordSteps()
    const cascade = vi.spyOn(userRepo, 'deleteWithCascade')

    await authService.logout({ userId: id })

    // The flush runs while the UMK is still unlocked, before the session goes.
    expect(steps).toEqual([
      `flush:${id}`, `credentialsSignOut:${id}`, 'clearUnlocks', 'deactivate', `clearTokens:${id}`, 'activate:__default__'
    ])
    expect(userRepo.get(id)).toBeDefined()
    expect(cascade).not.toHaveBeenCalled()
    // The device stays trusted: no cursor/device-key wipe, no cursor reset.
    expect(syncService.signOutCleanup).not.toHaveBeenCalled()
    expect(sync.resetCursors).not.toHaveBeenCalled()
  })

  it('refuses a profile that is not the current one', async () => {
    const id = await signInSelfHosted('https://one.cinna.test')
    holder.currentUserId = 'someone-else'
    const steps = recordSteps()

    await expect(authService.logout({ userId: id })).rejects.toMatchObject({ code: 'not_current' })
    expect(steps).toEqual([])
    expect(clearCinnaTokens).not.toHaveBeenCalled()
  })

  it('refuses a local profile', async () => {
    const { user } = await authService.register({ username: 'plain-local' })
    holder.currentUserId = user.id
    const steps = recordSteps()

    await expect(authService.logout({ userId: user.id })).rejects.toMatchObject({ code: 'invalid_user_type' })
    expect(steps).toEqual([])
    expect(userRepo.get(user.id)).toBeDefined()
  })

  it('leaves the argument-less logout as it was: session only, tokens kept', async () => {
    const id = await signInSelfHosted('https://one.cinna.test')
    holder.currentUserId = id
    const steps = recordSteps()

    await authService.logout()

    expect(steps).toEqual([`credentialsSignOut:${id}`, 'clearUnlocks', 'activate:__default__'])
    expect(clearCinnaTokens).not.toHaveBeenCalled()
    expect(syncService.flushBeforeSignOut).not.toHaveBeenCalled()
  })
})
