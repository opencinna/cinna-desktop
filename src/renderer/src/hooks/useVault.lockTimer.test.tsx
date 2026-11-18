import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VaultStatusDto } from '../../../shared/vault/types'
import { useVaultCountdown, useVaultTouch, vaultCountdown, vaultStatusKey, VAULT_TOUCH_THROTTLE_MS } from './useVault'

/**
 * The lock timer as the composer sees it: keystrokes touch the vault at most
 * once per 5 s, and the countdown re-renders every second only near its end
 * (or while a popover watches it).
 */

const touch = vi.fn()
const status = vi.fn()

function base(over: Partial<VaultStatusDto> = {}): VaultStatusDto {
  return {
    agentId: 'folder:v', vaultId: 'v1', agentName: 'V', engine: 'claude', state: 'unlocked', until: null,
    lockAfterMs: 300_000, sizeBytes: 0, usedBytes: null, egress: { hosts: [] }, createdAt: 0, imageVersion: '', error: null, otherBuild: null,
    ...over
  }
}

beforeEach(() => {
  touch.mockReset()
  status.mockReset()
  ;(window as unknown as { api: unknown }).api = { vault: { touch, status } }
})
afterEach(() => vi.useRealTimers())

describe('useVaultTouch', () => {
  it('touches at most once per 5 s per agent', () => {
    let now = 1_000
    const { result } = renderHook(() => useVaultTouch(() => now))
    result.current('folder:v')
    result.current('folder:v')
    now += VAULT_TOUCH_THROTTLE_MS - 1
    result.current('folder:v')
    expect(touch).toHaveBeenCalledTimes(1)
    now += 1
    result.current('folder:v')
    expect(touch).toHaveBeenCalledTimes(2)
    // Another agent is its own vault.
    result.current('folder:w')
    expect(touch).toHaveBeenLastCalledWith('folder:w')
  })
})

describe('vaultCountdown', () => {
  it('tells counting, held, no timer and locked apart', () => {
    expect(vaultCountdown(base({ until: 10_000 }), 4_000)).toEqual({ kind: 'counting', remainingMs: 6_000, until: 10_000 })
    expect(vaultCountdown(base({ until: null }), 0)).toEqual({ kind: 'held' })
    expect(vaultCountdown(base({ until: null, lockAfterMs: 0 }), 0)).toEqual({ kind: 'no-timer' })
    expect(vaultCountdown(base({ state: 'locked' }), 0)).toEqual({ kind: 'locked' })
    expect(vaultCountdown(null, 0)).toEqual({ kind: 'none' })
  })
})

describe('useVaultCountdown', () => {
  function mount(s: VaultStatusDto, watch = false): { result: { current: ReturnType<typeof useVaultCountdown> }; renders: () => number } {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    client.setQueryData(vaultStatusKey('folder:v'), s)
    let count = 0
    const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element => createElement(QueryClientProvider, { client }, children)
    const { result } = renderHook(() => { count++; return useVaultCountdown('folder:v', watch) }, { wrapper })
    return { result, renders: () => count }
  }

  it('does not tick while the deadline is far, then ticks each second through the last 20 s', () => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)
    const { result, renders } = mount(base({ until: 100_000 + 60_000 }))
    expect(result.current).toMatchObject({ kind: 'counting', remainingMs: 60_000 })
    const settled = renders()
    // One act per second, so each tick would be its own render.
    for (let i = 0; i < 39; i++) act(() => { vi.advanceTimersByTime(1_000) })
    // Far from the end: no re-render every second.
    expect(renders() - settled).toBeLessThanOrEqual(1)
    act(() => { vi.advanceTimersByTime(1_000) })
    expect(result.current).toMatchObject({ kind: 'counting', remainingMs: 20_000 })
    act(() => { vi.advanceTimersByTime(5_000) })
    expect(result.current).toMatchObject({ kind: 'counting', remainingMs: 15_000 })
  })

  it('ticks every second while watched, however far the deadline', () => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)
    const { result } = mount(base({ until: 100_000 + 272_000 }), true)
    act(() => { vi.advanceTimersByTime(2_000) })
    expect(result.current).toMatchObject({ kind: 'counting', remainingMs: 270_000 })
  })
})
