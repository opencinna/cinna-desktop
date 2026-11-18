import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useVaultLock, useVaultLocking, useVaultUnlock, useVaultUnlockFailed, useVaultUnlocking } from './useVault'

/**
 * An unlock (or lock) in flight is one fact per agent, whichever surface
 * started it: the sidebar's menu and the Security tab or the composer each
 * hold their own mutation, and each must see the other's as pending.
 */

let resolveUnlock: (value: unknown) => void = () => {}
let resolveLock: (value: unknown) => void = () => {}

beforeEach(() => {
  ;(window as unknown as { api: unknown }).api = {
    vault: {
      unlock: () => new Promise((resolve) => { resolveUnlock = resolve }),
      lock: () => new Promise((resolve) => { resolveLock = resolve })
    }
  }
})

function wrapper(): (props: { children: ReactNode }) => React.JSX.Element {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  return ({ children }) => createElement(QueryClientProvider, { client }, children)
}

const status = (state: string): unknown => ({ ok: true, data: { agentId: 'folder:a', state } })

describe('useVaultUnlocking / useVaultLocking', () => {
  it('sees an unlock another mutation instance started, for that agent only', async () => {
    const { result } = renderHook(() => ({
      menu: useVaultUnlock(),
      tab: useVaultUnlock(),
      a: useVaultUnlocking('folder:a'),
      b: useVaultUnlocking('folder:b'),
      none: useVaultUnlocking(null)
    }), { wrapper: wrapper() })
    expect(result.current.a).toBe(false)
    act(() => result.current.menu.mutate('folder:a'))
    await waitFor(() => expect(result.current.a).toBe(true))
    // The tab's own mutation never ran, yet the agent reads as unlocking.
    expect(result.current.tab.isPending).toBe(false)
    expect(result.current.b).toBe(false)
    expect(result.current.none).toBe(false)
    await act(async () => resolveUnlock(status('unlocked')))
    await waitFor(() => expect(result.current.a).toBe(false))
  })

  it('keeps a lock apart from an unlock', async () => {
    const { result } = renderHook(() => ({
      lock: useVaultLock(),
      locking: useVaultLocking('folder:a'),
      unlocking: useVaultUnlocking('folder:a')
    }), { wrapper: wrapper() })
    act(() => result.current.lock.mutate('folder:a'))
    await waitFor(() => expect(result.current.locking).toBe(true))
    expect(result.current.unlocking).toBe(false)
    await act(async () => resolveLock(status('locked')))
    await waitFor(() => expect(result.current.locking).toBe(false))
  })

  it('tells a surface that joined another surface\'s unlock that it failed, until the next one starts', async () => {
    const { result } = renderHook(() => ({
      menu: useVaultUnlock(),
      failed: useVaultUnlockFailed('folder:a'),
      other: useVaultUnlockFailed('folder:b')
    }), { wrapper: wrapper() })
    act(() => result.current.menu.mutate('folder:a'))
    await waitFor(() => expect(result.current.failed).toBe(false))
    await act(async () => resolveUnlock({ ok: false, code: 'denied', message: 'no' }))
    await waitFor(() => expect(result.current.failed).toBe(true))
    expect(result.current.other).toBe(false)
    act(() => result.current.menu.mutate('folder:a'))
    await waitFor(() => expect(result.current.failed).toBe(false))
    await act(async () => resolveUnlock(status('unlocked')))
  })
})
