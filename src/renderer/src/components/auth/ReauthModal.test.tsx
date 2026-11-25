import { act, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The global re-auth modal has two variants: "Cinna session expired" when a call failed for lack
 * of a session, and "Sign in to Cinna" when the user switched into a profile they signed out of on
 * purpose (`promptSignIn`). A failing call afterwards keeps the sign-in variant and its account.
 */

const reauth = vi.hoisted(() => vi.fn())
vi.mock('../../hooks/useAuth', () => ({ useCinnaReauth: () => ({ mutateAsync: reauth, isPending: false }) }))
;(window as unknown as { api: unknown }).api = { auth: { onReauthRequired: () => () => {} } }

const { ReauthModal } = await import('./ReauthModal')
const { useReauthStore } = await import('../../stores/reauth.store')
const { useAuthStore } = await import('../../stores/auth.store')

function show(): void {
  render(<QueryClientProvider client={new QueryClient()}><ReauthModal /></QueryClientProvider>)
}

beforeEach(() => {
  reauth.mockReset().mockResolvedValue({ success: true })
  useReauthStore.setState({ reauthRequired: false, info: null, dismissed: false, signIn: false })
  useAuthStore.setState({ currentUser: { id: 'carol', type: 'cinna_user', username: 'carol@corp.test', displayName: 'carol', hasPassword: false } })
})

describe('the sign-in variant', () => {
  it('asks to sign in to the signed-out account, and a later failing call does not turn it into an expiry', async () => {
    act(() => useReauthStore.getState().promptSignIn({ account: 'Carol', serverUrl: 'https://core.corp.test', source: null }))
    act(() => useReauthStore.getState().requireReauth({ account: 'Someone', serverUrl: null, source: 'agent status' }))
    show()
    expect(screen.getByText('Sign in to Cinna')).toBeTruthy()
    expect(screen.queryByText('Cinna session expired')).toBeNull()
    expect(document.body.textContent).toContain('Carol on core.corp.test is signed out on this device. Sign in again to use this account\'s agents and credentials.')
    expect(screen.getByRole('button', { name: 'Not now' })).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Sign in' })) })
    expect(reauth).toHaveBeenCalledTimes(1)
    expect(useReauthStore.getState()).toMatchObject({ reauthRequired: false, signIn: false, info: null })
  })

  it('goes back to the expiry wording once dismissed', () => {
    act(() => useReauthStore.getState().promptSignIn({ account: 'Carol', serverUrl: null, source: null }))
    act(() => useReauthStore.getState().dismiss())
    expect(useReauthStore.getState().signIn).toBe(false)
    act(() => useReauthStore.setState({ dismissed: false }))
    act(() => useReauthStore.getState().requireReauth({ account: 'Carol', serverUrl: null, source: 'agent status' }))
    show()
    expect(screen.getByText('Cinna session expired')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Re-authenticate' })).toBeTruthy()
  })
})
