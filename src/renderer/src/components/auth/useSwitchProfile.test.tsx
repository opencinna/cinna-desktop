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
