import { act, renderHook, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * An agent in a locked Agent Vault: its readiness is `vault_locked`, the
 * composer refuses the send and its notice row offers **Unlock**, which asks
 * main to unlock — the vault helper raises its own prompt there.
 */

const unlock = vi.fn()
;(window as unknown as { api: unknown }).api = { vault: { unlock, onState: () => () => {} } }

const { useComposerReadiness, readinessNoticeItem } = await import('./ComposerReadiness')
const { ComposerNoticePanel } = await import('./ComposerNoticePanel')

const target = {
  id: 'folder:alpha',
  name: 'Alpha',
  capabilities: { cwd: true, auth: 'none', commands: 'catalog' },
  readiness: { state: 'vault_locked', reason: 'Vault locked.' }
} as never

function wrapper({ children }: { children: ReactNode }): React.JSX.Element {
  return createElement(QueryClientProvider, { client: new QueryClient() }, children)
}

beforeEach(() => unlock.mockReset())

describe('composer readiness — vault locked', () => {
  it('refuses the send and offers Unlock, which asks main to unlock this agent', async () => {
    unlock.mockResolvedValue({ ok: true, data: {} })
    const { result } = renderHook(() => useComposerReadiness(target, 'hello'), { wrapper })
    expect(result.current.blocksSend).toBe(true)
    expect(result.current.refusal?.state).toBe('vault_locked')
    expect(result.current.text).toBe('Vault locked.')
    expect(result.current.action?.label).toBe('Unlock')
    act(() => result.current.action!.run())
    await waitFor(() => expect(unlock).toHaveBeenCalledWith('folder:alpha'))
  })

  it('draws one warning row with the Unlock button, and says a cancelled prompt in the row', async () => {
    unlock.mockResolvedValue({ ok: false, code: 'denied', message: 'denied' })
    const { result } = renderHook(() => useComposerReadiness(target, ''), { wrapper })
    const item = readinessNoticeItem(result.current, 'reason')!
    expect(item.tone).toBe('warning')
    const { unmount } = render(createElement(ComposerNoticePanel, { notices: [item] }))
    fireEvent.click(screen.getByRole('button', { name: /Unlock/ }))
    unmount()
    act(() => result.current.action!.run())
    await waitFor(() => expect(result.current.text).toBe('Vault locked. Couldn\'t unlock — cancelled at the prompt.'))
  })
})
