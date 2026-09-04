import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * What the user reads when the app fails to start.
 *
 * `useStartup`'s error message is not one element among many — `App.tsx`'s
 * `AuthGate` returns `<StartupError message={state.message} />` *instead of*
 * the application, so this string is the entire window. Every other error
 * surface in the app has surrounding UI to interpret it against; this one has
 * none, which is why it was worth fixing ahead of the ~28 other raw sites.
 *
 * `auth:get-startup` is registered with `ipcHandle` and throws, so the
 * rejection arrives shaped by `ipcMain.handle` + `_wrap.ts`. That is what these
 * tests inject.
 */

const getStartup = vi.hoisted(() => vi.fn())

vi.mock('../stores/auth.store', () => ({
  useAuthStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      setCurrentUser: () => undefined,
      setNeedsPassword: () => undefined,
      setPendingUserId: () => undefined
    })
}))
vi.mock('../stores/reauth.store', () => ({
  useReauthStore: (sel: (s: Record<string, unknown>) => unknown) => sel({})
}))
vi.mock('../stores/chat.store', () => ({
  useChatStore: (sel: (s: Record<string, unknown>) => unknown) => sel({})
}))
vi.mock('./useAgents', () => ({ REMOTE_SYNC_STATUS_KEY: ['remote-sync-status'] }))

const { useStartup } = await import('./useAuth')

const SENTENCE = 'No profile could be opened on this device.'
const WIRE = "Error invoking remote method 'auth:get-startup': AuthError: " + SENTENCE

beforeEach(() => {
  getStartup.mockReset()
  ;(globalThis as unknown as { window: { api: unknown } }).window.api = {
    auth: { getStartup }
  }
})

describe('a startup failure', () => {
  it('puts the reason on screen without the IPC plumbing', async () => {
    // The module caches `startupPromise`, and the catch clears it — so each
    // rejecting test starts from a clean cache without reimporting.
    getStartup.mockRejectedValue(new Error(WIRE))

    const { result } = renderHook(() => useStartup())

    await waitFor(() => expect(result.current.state.status).toBe('error'))
    const message = (result.current.state as { message: string }).message
    expect(message).toBe(SENTENCE)
    // This is the whole screen, so the absence assertions are the point.
    expect(message).not.toContain('invoking remote method')
    expect(message).not.toContain('AuthError')
  })

  it('shows a failure that never crossed IPC unchanged', async () => {
    // The over-correction guard: a startup failure raised renderer-side has no
    // prefix to remove, and there is no other surface to recover it from.
    getStartup.mockRejectedValue(new Error('The database file is locked.'))

    const { result } = renderHook(() => useStartup())

    await waitFor(() => expect(result.current.state.status).toBe('error'))
    expect((result.current.state as { message: string }).message).toBe(
      'The database file is locked.'
    )
  })

  it('leaves a successful startup alone', async () => {
    getStartup.mockResolvedValue({ needsLogin: false, user: null, pendingUser: null })

    const { result } = renderHook(() => useStartup())

    await waitFor(() => expect(result.current.state.status).toBe('ready'))
  })
})
