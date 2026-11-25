import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { expect, it, vi } from 'vitest'
import { useAuthStore } from '../stores/auth.store'

/** Sign Out that keeps this device's data goes through `useLogout({ userId })`; a refusal changes nothing here. */

const logout = vi.hoisted(() => vi.fn())
const getCurrent = vi.hoisted(() => vi.fn(async () => ({ id: '__default__', type: 'local_user', username: 'guest', displayName: 'Guest', hasPassword: false })))
vi.hoisted(() => {
  window.api = { app: { setTheme: async () => {} }, auth: { logout, getCurrent } } as never
})

const { useLogout } = await import('./useAuth')

function setup() {
  const client = new QueryClient()
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)
  return renderHook(() => useLogout(), { wrapper })
}

it('passes the profile to main and returns a refusal without resetting the current profile', async () => {
  const alice = { id: 'alice', type: 'cinna_user', username: 'alice@corp.test', displayName: 'alice', hasPassword: false }
  useAuthStore.setState({ currentUser: alice })
  logout.mockResolvedValue({ success: false, error: 'Only the current profile can be signed out' })
  const { result } = setup()
  let answer: unknown
  await act(async () => { answer = await result.current.mutateAsync({ userId: 'alice' }) })
  expect(logout).toHaveBeenCalledWith({ userId: 'alice' })
  expect(answer).toEqual({ success: false, error: 'Only the current profile can be signed out' })
  expect(getCurrent).not.toHaveBeenCalled()
  expect(useAuthStore.getState().currentUser?.id).toBe('alice')
})

it('moves to the profile main made current once it succeeds', async () => {
  logout.mockResolvedValue({ success: true })
  const { result } = setup()
  await act(async () => { await result.current.mutateAsync({ userId: 'alice' }) })
  expect(useAuthStore.getState().currentUser?.id).toBe('__default__')
})
