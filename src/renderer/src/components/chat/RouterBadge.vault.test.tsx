import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentData } from '../../../../preload'
import type { VaultStatusDto } from '../../../../shared/vault/types'
import { vaultStatusKey } from '../../hooks/useVault'
import { RouterBadge } from './RouterBadge'

/**
 * The "Local" badge of a vault agent: the safe glyph, a line about the lock in
 * its popover, and — only in the last 15 s — a countdown pill on its corner.
 */

const agent = { id: 'folder:v', name: 'Ledger', source: 'vault', driver: 'acp', protocol: 'acp' } as unknown as AgentData

function status(over: Partial<VaultStatusDto>): VaultStatusDto {
  return {
    agentId: 'folder:v', vaultId: 'v1', agentName: 'Ledger', engine: 'claude', state: 'unlocked', until: null,
    lockAfterMs: 300_000, sizeBytes: 0, usedBytes: null, egress: { hosts: [] }, createdAt: 0, imageVersion: '', error: null,
    ...over
  }
}

function mount(s: VaultStatusDto): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(vaultStatusKey('folder:v'), s)
  render(<QueryClientProvider client={client}><RouterBadge router="direct" connectionAgent={agent} /></QueryClientProvider>)
  return client
}

beforeEach(() => {
  Object.assign(window, { api: { customAgents: { configuration: vi.fn(async () => ({ config: {} })) }, vault: { status: vi.fn() } } })
})
afterEach(() => vi.useRealTimers())

describe('a vault agent’s router badge', () => {
  it('says Local with the safe, and the time to the lock in its popover', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    mount(status({ until: 1_000_000 + 272_000 }))
    const badge = screen.getByRole('status', { name: 'Local agent connection' })
    expect(badge.textContent).toBe('Local')
    expect(badge.querySelector('svg')?.getAttribute('class') ?? '').not.toContain('lucide-square-terminal')
    fireEvent.mouseEnter(badge)
    expect(screen.getByTestId('vault-lock-line').textContent).toBe('Locks in 4:32')
    act(() => { vi.advanceTimersByTime(2_000) })
    expect(screen.getByTestId('vault-lock-line').textContent).toBe('Locks in 4:30')
    // Far from the end, no pill.
    expect(screen.queryByTestId('vault-countdown-pill')).toBeNull()
  })

  it.each([
    [{ until: null }, 'Kept open while the agent works'],
    [{ until: null, lockAfterMs: 0 }, 'Stays unlocked until Cinna quits'],
    [{ state: 'locked' as const }, 'Locked']
  ])('says %o as “%s”', (over, text) => {
    mount(status(over))
    fireEvent.mouseEnter(screen.getByRole('status'))
    expect(screen.getByTestId('vault-lock-line').textContent).toBe(text)
  })

  it('shows the pill only in the last 15 s, and drops it when the timer resets', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const client = mount(status({ until: 1_000_000 + 18_000 }))
    expect(screen.queryByTestId('vault-countdown-pill')).toBeNull()
    act(() => { vi.advanceTimersByTime(3_000) })
    expect(screen.getByTestId('vault-countdown-pill').textContent).toBe('0:15')
    act(() => { vi.advanceTimersByTime(3_000) })
    expect(screen.getByTestId('vault-countdown-pill').textContent).toBe('0:12')
    // A touch (or a turn) restarted the window. (Query notifications go out on a timer.)
    const push = (s: VaultStatusDto): void => act(() => { client.setQueryData(vaultStatusKey('folder:v'), s); vi.advanceTimersByTime(0) })
    push(status({ until: Date.now() + 300_000 }))
    expect(screen.queryByTestId('vault-countdown-pill')).toBeNull()
    push(status({ until: Date.now() + 10_000 }))
    expect(screen.getByTestId('vault-countdown-pill')).toBeTruthy()
    push(status({ state: 'locked' }))
    expect(screen.queryByTestId('vault-countdown-pill')).toBeNull()
  })
})
