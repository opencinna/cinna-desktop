import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The one profile switch the profile menu and the composer's account rows share: a passwordless
 * profile switches at once, a password profile is tried without its password and prompts when
 * main asks for it, and a refusal is said rather than dropped.
 */

const login = vi.hoisted(() => vi.fn())
vi.mock('./LoginPrompt', () => ({
  LoginPrompt: ({ userId, onSuccess, onCancel }: { userId: string; onSuccess: () => void; onCancel: () => void }) =>
    <div data-testid="prompt">{userId}<button onClick={onSuccess}>unlock</button><button onClick={onCancel}>cancel</button></div>
}))

;(window as unknown as { api: unknown }).api = {
  auth: { login, listUsers: async () => [{ id: 'alice', displayName: 'Alice', hasPassword: true }] }
}

const { useSwitchProfile } = await import('./useSwitchProfile')
const { useReauthStore } = await import('../../stores/reauth.store')

function wrapper({ children }: { children: ReactNode }): React.JSX.Element {
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
}

beforeEach(() => login.mockReset())

describe('switching profiles', () => {
  it('tries a password profile without its password, and prompts when main asks for it', async () => {
    login.mockResolvedValue({ success: false, error: 'Password required' })
    const { result } = renderHook(() => useSwitchProfile(), { wrapper })
    await act(() => result.current.switchTo('alice', true))
    expect(login).toHaveBeenCalledWith({ userId: 'alice' })
    expect(result.current.prompt).not.toBeNull()
    expect(result.current.error).toBeNull()
    act(() => result.current.cancelPrompt())
    expect(result.current.prompt).toBeNull()
  })

  it('says why a passwordless switch was refused instead of prompting', async () => {
    login.mockResolvedValue({ success: false, error: 'Profile not found' })
    const { result } = renderHook(() => useSwitchProfile(), { wrapper })
    await act(() => result.current.switchTo('bob', false))
    await waitFor(() => expect(result.current.error).toBe('Profile not found'))
    expect(result.current.prompt).toBeNull()
  })

  it('runs the switch’s own onSwitched once the profile is current, by either path, and never on a refusal or cancel', async () => {
    const switched = vi.fn()
    login.mockResolvedValue({ success: true })
    const { result } = renderHook(() => useSwitchProfile(), { wrapper })
    await act(() => result.current.switchTo('bob', false, switched))
    expect(switched).toHaveBeenCalledWith('bob')

    switched.mockClear()
    login.mockResolvedValue({ success: false, error: 'Profile not found' })
    await act(() => result.current.switchTo('bob', false, switched))
    expect(switched).not.toHaveBeenCalled()

    // A password profile: only the prompt's success counts.
    login.mockResolvedValue({ success: false, error: 'Password required' })
    await act(() => result.current.switchTo('alice', true, switched))
    const view = render(<>{result.current.prompt}</>)
    fireEvent.click(screen.getByText('cancel'))
    expect(switched).not.toHaveBeenCalled()
    view.unmount()
    await act(() => result.current.switchTo('alice', true, switched))
    render(<>{result.current.prompt}</>)
    fireEvent.click(screen.getByText('unlock'))
    expect(switched).toHaveBeenCalledWith('alice')
  })
})

describe('switching into a signed-out Cinna profile', () => {
  const carol = { id: 'carol', type: 'cinna_user', username: 'carol@corp.test', displayName: 'carol', cinnaFullName: 'Carol', cinnaServerUrl: 'https://core.corp.test', hasPassword: false, hasCinnaTokens: false }
  beforeEach(() => useReauthStore.setState({ reauthRequired: false, info: null, dismissed: false }))

  it('opens the sign-in prompt for it, even after an earlier "Not now"', async () => {
    useReauthStore.getState().dismiss()
    login.mockResolvedValue({ success: true, user: carol })
    const { result } = renderHook(() => useSwitchProfile(), { wrapper })
    await act(() => result.current.switchTo('carol', false))
    expect(useReauthStore.getState()).toMatchObject({ reauthRequired: true, dismissed: false, info: { account: 'Carol', serverUrl: 'https://core.corp.test', source: null } })
  })

  it('opens it after the password prompt unlocks a signed-out password profile', async () => {
    const dave = { ...carol, id: 'dave', cinnaFullName: 'Dave', hasPassword: true }
    ;(window as unknown as { api: { auth: Record<string, unknown> } }).api.auth.listUsers = async () => [dave]
    login.mockResolvedValue({ success: false, error: 'Password required' })
    const { result } = renderHook(() => useSwitchProfile(), { wrapper })
    await waitFor(() => expect(result.current).toBeTruthy())
    await act(() => result.current.switchTo('dave', true))
    expect(useReauthStore.getState().reauthRequired).toBe(false)
    render(<>{result.current.prompt}</>)
    await waitFor(() => expect(screen.getByTestId('prompt')).toBeTruthy())
    fireEvent.click(screen.getByText('unlock'))
    expect(useReauthStore.getState()).toMatchObject({ reauthRequired: true, signIn: true, info: { account: 'Dave' } })
  })

  it('leaves it closed for a profile that still has its session, or a local one', async () => {
    login.mockResolvedValue({ success: true, user: { ...carol, hasCinnaTokens: true } })
    const { result } = renderHook(() => useSwitchProfile(), { wrapper })
    await act(() => result.current.switchTo('carol', false))
    login.mockResolvedValue({ success: true, user: { id: 'bob', type: 'local_user', username: 'bob', displayName: 'Bob', hasPassword: false } })
    await act(() => result.current.switchTo('bob', false))
    expect(useReauthStore.getState().reauthRequired).toBe(false)
  })
})
