import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalAgentDto } from '../../../../../../shared/localAgents'
import type { VaultStatusDto, VaultTerminalEvent } from '../../../../../../shared/vault/types'
import { VaultOnPanel } from './VaultOnPanel'

/** Security → Terminal: gated on an unlocked vault, a dialog that streams the shell both ways, Close ends it. */

const term = vi.hoisted(() => ({ writes: [] as (string | Uint8Array)[], onData: null as null | ((d: string) => void), disposed: 0 }))
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown> = {}
    cols = 80
    loadAddon(): void {}
    open(): void {}
    focus(): void {}
    reset(): void { term.writes = [] }
    write(data: string | Uint8Array): void { term.writes.push(data) }
    onData(fn: (d: string) => void): { dispose(): void } { term.onData = fn; return { dispose: () => { term.onData = null } } }
    dispose(): void { term.disposed++ }
  }
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit(): void {} } }))

let status: VaultStatusDto
let emit: ((event: VaultTerminalEvent) => void) | null = null
const handle = { write: vi.fn(), close: vi.fn() }
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
    agentId: 'folder:alpha', vaultId: 'v1', agentName: 'Alpha', engine: 'claude', state: 'unlocked', until: Date.now() + 60_000,
    sizeBytes: 10 * 1024 ** 3, usedBytes: null, egress: { hosts: [] }, createdAt: 0, imageVersion: '', error: null
  }
  emit = null
  term.writes = []
  ;(window as unknown as { api: unknown }).api = { vault }
  vi.clearAllMocks()
})
afterEach(() => cleanup())

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
