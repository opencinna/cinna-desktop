import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalAgentDto } from '../../../../../../shared/localAgents'
import type { VaultStatusDto, VaultTerminalEvent } from '../../../../../../shared/vault/types'
import { VaultOnPanel } from './VaultOnPanel'

/** Security → Terminal: gated on an unlocked vault, a dialog that streams the shell both ways, Close ends it. */

const term = vi.hoisted(() => ({
  writes: [] as (string | Uint8Array)[], onData: null as null | ((d: string) => void), disposed: 0,
  /** What the next fit() lays the grid out as (the host's size, in cells). */
  fitTo: { cols: 80, rows: 24 },
  current: null as null | { cols: number; rows: number }
}))
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown> = {}
    cols = 80
    rows = 24
    constructor() { term.current = this }
    loadAddon(): void {}
    open(): void {}
    focus(): void {}
    reset(): void { term.writes = [] }
    write(data: string | Uint8Array): void { term.writes.push(data) }
    onData(fn: (d: string) => void): { dispose(): void } { term.onData = fn; return { dispose: () => { term.onData = null } } }
    dispose(): void { term.disposed++ }
  }
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit(): void { Object.assign(term.current!, term.fitTo) } } }))

/** jsdom has no ResizeObserver: one whose callback the test fires, frames run at once. */
const observers = vi.hoisted(() => [] as (() => void)[])
class FakeResizeObserver {
  constructor(private readonly cb: () => void) {}
  observe(): void { observers.push(this.cb) }
  disconnect(): void { observers.splice(observers.indexOf(this.cb), 1) }
}

let status: VaultStatusDto
let emit: ((event: VaultTerminalEvent) => void) | null = null
const handle = { write: vi.fn(), resize: vi.fn(), close: vi.fn() }
const vault = {
  status: vi.fn(async () => ({ ok: true, data: status })),
  hostCopy: vi.fn(async () => ({ ok: true, data: null })),
  engineAuth: vi.fn(async () => ({ ok: true, data: { loggedIn: true, method: 'api_key' } })),
  secrets: vi.fn(async () => ({ ok: true, data: { names: [] } })),
  runtimes: vi.fn(async () => ({ ok: true, data: [] })),
  listFiles: vi.fn(async () => ({ ok: true, data: [] })),
  onState: vi.fn(() => () => {}),
  onMoveProgress: vi.fn(() => () => {}),
  openTerminal: vi.fn((_agentId: string, onEvent: (event: VaultTerminalEvent) => void) => { emit = onEvent; return handle })
}

beforeEach(() => {
  status = {
    agentId: 'folder:alpha', vaultId: 'v1', agentName: 'Alpha', engine: 'claude', state: 'unlocked', until: Date.now() + 60_000, lockAfterMs: 300_000,
    sizeBytes: 10 * 1024 ** 3, usedBytes: null, egress: { hosts: [] }, createdAt: 0, imageVersion: '', error: null
  }
  emit = null
  term.writes = []
  term.fitTo = { cols: 80, rows: 24 }
  observers.length = 0
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { fn(0); return 0 })
  ;(window as unknown as { api: unknown }).api = { vault }
  vi.clearAllMocks()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderPanel(state: 'locked' | 'unlocked'): void {
  const agent = { id: 'folder:alpha', name: 'Alpha', path: '', kind: 'kit', vault: { vaultId: 'v1', state, engine: 'claude' } } as LocalAgentDto
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(createElement(QueryClientProvider, { client }, createElement(VaultOnPanel, { agent, vault: agent.vault! })))
}

describe('Security → Terminal', () => {
  it('is offered only while the vault is unlocked', async () => {
    status = { ...status, state: 'locked', until: null }
    renderPanel('locked')
    const button = await screen.findByRole('button', { name: /Open terminal/ })
    expect((button as HTMLButtonElement).disabled).toBe(true)
    expect(button.getAttribute('title')).toBe('Unlock the vault first')
  })

  it('opens a terminal that waits for approval, then streams both ways; Close ends the shell', async () => {
    renderPanel('unlocked')
    const button = await screen.findByRole('button', { name: /Open terminal/ })
    await vi.waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(button)
    expect(vault.openTerminal).toHaveBeenCalledWith('folder:alpha', expect.any(Function))
    expect(screen.getByRole('dialog', { name: 'Terminal — Alpha' })).toBeTruthy()
    expect(String(term.writes.join(''))).toContain('Waiting for approval…')
    act(() => emit?.({ type: 'open' }))
    const bytes = new TextEncoder().encode('agent@vault$ ')
    act(() => emit?.({ type: 'data', data: bytes }))
    expect(term.writes).toContain(bytes)
    term.onData?.('ls\r')
    expect(handle.write).toHaveBeenCalledWith('ls\r')
    // Escape belongs to the shell while it runs.
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(handle.close).toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('sends the terminal size before the approval, then again only when the box changes it', async () => {
    renderPanel('unlocked')
    const button = await screen.findByRole('button', { name: /Open terminal/ })
    await vi.waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))
    term.fitTo = { cols: 132, rows: 30 }
    fireEvent.click(button)
    // The shell starts at it.
    expect(handle.resize.mock.calls).toEqual([[132, 30]])
    act(() => emit?.({ type: 'open' }))
    expect(handle.resize).toHaveBeenCalledTimes(1)
    // The user drags the box taller.
    term.fitTo = { cols: 132, rows: 44 }
    act(() => observers.forEach((cb) => cb()))
    expect(handle.resize.mock.calls.at(-1)).toEqual([132, 44])
    // A resize that does not change the grid sends nothing.
    act(() => observers.forEach((cb) => cb()))
    expect(handle.resize).toHaveBeenCalledTimes(2)
    // The box is the user's to resize, within bounds.
    const host = document.querySelector('[data-vault-terminal]')!
    expect(host.className).toContain('resize-y')
    expect(host.className).toContain('min-h-[12rem]')
    expect(host.className).toContain('max-h-[min(70vh,calc(84vh_-_11rem))]')
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(observers).toHaveLength(0)
  })

  it('says a declined prompt and keeps the dialog until closed', async () => {
    renderPanel('unlocked')
    const button = await screen.findByRole('button', { name: /Open terminal/ })
    await vi.waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(button)
    act(() => emit?.({ type: 'error', code: 'denied', message: 'Cancelled.' }))
    expect(screen.getByText('Cancelled at the prompt — nothing was opened.')).toBeTruthy()
    expect(screen.getByRole('dialog')).toBeTruthy()
  })
})
