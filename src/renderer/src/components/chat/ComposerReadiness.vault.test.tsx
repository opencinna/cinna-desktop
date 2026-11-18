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
type ProgressListener = (event: { agentId: string; vaultId: string; percent: number | null }) => void
const progressListeners = new Set<ProgressListener>()
const onUnlockProgress = (cb: ProgressListener): (() => void) => {
  progressListeners.add(cb)
  return () => { progressListeners.delete(cb) }
}
;(window as unknown as { api: unknown }).api = { vault: { unlock, onState: () => () => {}, onUnlockProgress } }

const { useComposerReadiness, readinessNoticeItem, lowerSentenceLead } = await import('./ComposerReadiness')
const { useVaultUnlock } = await import('../../hooks/useVault')
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

  it('says the image download in the pending label while the unlock downloads it, then Unlocking… again', async () => {
    let finish: (value: unknown) => void = () => {}
    unlock.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    const { result } = renderHook(() => useComposerReadiness(target, ''), { wrapper })
    act(() => result.current.action!.run())
    await waitFor(() => expect(result.current.action?.pending).toBe(true))
    expect(result.current.action?.pendingLabel).toBe('Unlocking…')
    // Another agent's download is not this row's.
    act(() => progressListeners.forEach((cb) => cb({ agentId: 'folder:beta', vaultId: 'v2', percent: 10 })))
    expect(result.current.action?.pendingLabel).toBe('Unlocking…')
    act(() => progressListeners.forEach((cb) => cb({ agentId: 'folder:alpha', vaultId: 'v1', percent: 40 })))
    expect(result.current.action?.pendingLabel).toBe('Unlocking… 40%')
    act(() => progressListeners.forEach((cb) => cb({ agentId: 'folder:alpha', vaultId: 'v1', percent: null })))
    expect(result.current.action?.pendingLabel).toBe('Unlocking…')
    await act(async () => { finish({ ok: true, data: {} }) })
  })

  it('lowers a "The"/"This" lead of the failure it appends, and nothing else', async () => {
    unlock.mockResolvedValue({ ok: false, code: 'unavailable', message: "The vault system image is missing, so the vault can't start." })
    const { result } = renderHook(() => useComposerReadiness(target, ''), { wrapper })
    act(() => result.current.action!.run())
    await waitFor(() => expect(result.current.text).toBe("Vault locked. Couldn't unlock — the vault system image is missing, so the vault can't start."))
    expect(lowerSentenceLead('This vault was made by a development build.')).toBe('this vault was made by a development build.')
    expect(lowerSentenceLead('Cinna could not reach the helper.')).toBe('Cinna could not reach the helper.')
    expect(lowerSentenceLead('Theodore is busy.')).toBe('Theodore is busy.')
  })

  it('shows an unlock another surface started as pending', async () => {
    let finish: (value: unknown) => void = () => {}
    unlock.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    const { result } = renderHook(() => ({ composer: useComposerReadiness(target, ''), menu: useVaultUnlock() }), { wrapper })
    expect(result.current.composer.action?.pending).toBe(false)
    act(() => result.current.menu.mutate('folder:alpha'))
    await waitFor(() => expect(result.current.composer.action?.pending).toBe(true))
    await act(async () => { finish({ ok: true, data: {} }) })
    await waitFor(() => expect(result.current.composer.action?.pending).toBe(false))
  })
})

describe('composer readiness — vault tampered', () => {
  const tampered = {
    id: 'folder:alpha',
    name: 'Alpha',
    capabilities: { cwd: true, auth: 'none', commands: 'catalog' },
    readiness: { state: 'vault_tampered', reason: "This vault was made by a development build of Cinna. This version can't open it: each build keeps its own vault keys." }
  } as never

  it('refuses the send, says why in the sentence and offers no Unlock', () => {
    const { result } = renderHook(() => useComposerReadiness(tampered, 'hello'), { wrapper })
    expect(result.current.blocksSend).toBe(true)
    expect(result.current.text).toBe("This vault was made by a development build of Cinna. This version can't open it: each build keeps its own vault keys.")
    expect(result.current.action?.label).not.toBe('Unlock')
    expect(result.current.action?.runAsync).toBeUndefined()
    const item = readinessNoticeItem(result.current, 'reason')!
    expect(item.tone).toBe('danger')
    render(createElement(ComposerNoticePanel, { notices: [item] }))
    expect(screen.queryByRole('button', { name: /Unlock/ })).toBeNull()
  })
})
