import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalAgentDto } from '../../../../../../shared/localAgents'
import type { VaultEngineChoiceDto, VaultMoveProgressEvent, VaultStatusDto } from '../../../../../../shared/vault/types'
import { VaultEnginePanel } from './VaultEnginePanel'

/**
 * The engine picker of a vault agent: disabled while the vault is locked, a
 * set-up engine switches at once, any other (and OpenCode) opens the setup
 * dialog, which stays open on a failure with Try again.
 */

let status: VaultStatusDto
let engines: VaultEngineChoiceDto[]
let progress: ((event: VaultMoveProgressEvent) => void) | null
const vault = {
  status: vi.fn(async () => ({ ok: true, data: status })),
  engines: vi.fn(async (): Promise<unknown> => ({ ok: true, data: engines })),
  unlock: vi.fn(async (): Promise<unknown> => ({ ok: true, data: { ...status, state: 'unlocked' } })),
  switchEngine: vi.fn(async (): Promise<unknown> => ({ ok: true, data: { moveId: 'm1' } })),
  onMoveProgress: vi.fn((cb: (event: VaultMoveProgressEvent) => void) => {
    progress = cb
    return () => { progress = null }
  })
}

beforeEach(() => {
  status = {
    agentId: 'folder:alpha', vaultId: 'v1', agentName: 'Alpha', engine: 'claude', state: 'unlocked', until: null,
    lockAfterMs: 300_000, sizeBytes: 10 * 1024 ** 3, usedBytes: null, egress: { hosts: ['api.anthropic.com'] },
    createdAt: 0, imageVersion: '1.0.0', error: null
  }
  engines = [
    { engine: 'claude', setUp: true, version: '2.1.0' },
    { engine: 'codex', setUp: true, version: '0.1.0' },
    { engine: 'opencode', setUp: false, version: null },
    { engine: 'antigravity', setUp: false, version: null }
  ]
  progress = null
  ;(window as unknown as { api: unknown }).api = { vault }
  vi.clearAllMocks()
})
afterEach(() => cleanup())

function agent(state: 'locked' | 'unlocked' = 'unlocked', vaultInfo: Record<string, unknown> = {}): LocalAgentDto {
  return { id: 'folder:alpha', name: 'Alpha', path: '', kind: 'kit', vault: { vaultId: 'v1', state, engine: 'claude', model: null, ...vaultInfo } } as LocalAgentDto
}

function renderPanel(a: LocalAgentDto): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(createElement(QueryClientProvider, { client }, createElement(VaultEnginePanel, { agent: a })))
}

const select = (): HTMLSelectElement => screen.getByLabelText('Runs on') as HTMLSelectElement

describe('VaultEnginePanel', () => {
  it('is disabled while the vault is locked, and says so on its line', async () => {
    status = { ...status, state: 'locked' }
    renderPanel(agent('locked'))
    expect(await screen.findByText('Unlock the vault to change the engine.')).toBeTruthy()
    expect(select().disabled).toBe(true)
    expect(vault.engines).not.toHaveBeenCalled()
  })

  it('lists the four engines, marking those that need setup, and switches to a set-up one at once', async () => {
    renderPanel(agent())
    await waitFor(() => expect(select().disabled).toBe(false))
    expect([...select().options].map((o) => o.textContent)).toEqual(['Claude Agent', 'Codex', 'OpenCode — needs setup', 'Antigravity — needs setup'])
    expect(screen.getByText('Runs inside the vault on Claude Agent 2.1.0 · the CLI’s default model.')).toBeTruthy()
    fireEvent.change(select(), { target: { value: 'codex' } })
    await waitFor(() => expect(vault.switchEngine).toHaveBeenCalledWith('folder:alpha', { engine: 'codex' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    // The select keeps the current engine, pending, until the switch is done.
    expect(select().value).toBe('claude')
    expect(select().disabled).toBe(true)
    expect(screen.getByText('Switching to Codex…')).toBeTruthy()
    act(() => progress?.({ moveId: 'm1', agentId: 'folder:alpha', step: 'engine', status: 'done', message: 'The agent runs on Codex now.' }))
    await waitFor(() => expect(select().disabled).toBe(false))
  })

  it('says a failed direct switch on its line', async () => {
    renderPanel(agent())
    await waitFor(() => expect(select().disabled).toBe(false))
    fireEvent.change(select(), { target: { value: 'codex' } })
    await waitFor(() => expect(vault.switchEngine).toHaveBeenCalled())
    act(() => progress?.({ moveId: 'm1', agentId: 'folder:alpha', step: 'egress', status: 'failed', message: 'Cancelled at the prompt.' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Cancelled at the prompt.')
  })

  it('opens the setup dialog for an engine that is not set up, and keeps it open on a failure with Try again', async () => {
    renderPanel(agent())
    await waitFor(() => expect(select().disabled).toBe(false))
    fireEvent.change(select(), { target: { value: 'antigravity' } })
    const dialog = await screen.findByRole('dialog', { name: 'Set up Antigravity in the vault' })
    expect(vault.switchEngine).not.toHaveBeenCalled()
    expect(select().value).toBe('claude')
    expect(dialog.textContent).toContain('Downloads the pinned Antigravity runtime into the vault')
    expect(dialog.textContent).toContain('Allows generativelanguage.googleapis.com')
    expect(dialog.textContent).toContain('Stores the key (if given)')
    fireEvent.change(screen.getByLabelText('API key for Antigravity inside the vault'), { target: { value: 'AIza-test-key-0123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Set up' }))
    await waitFor(() => expect(vault.switchEngine).toHaveBeenCalledWith('folder:alpha', { engine: 'antigravity', apiKey: 'AIza-test-key-0123' }))
    act(() => progress?.({ moveId: 'm1', agentId: 'folder:alpha', step: 'runtime', status: 'failed', message: 'Cancelled at the prompt.' }))
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy()
    expect(screen.getByRole('dialog').textContent).toContain('Cancelled at the prompt.')
    expect(screen.getByRole('dialog').querySelector('[data-step="runtime"]')?.getAttribute('data-status')).toBe('failed')
  })

  it('asks OpenCode for its provider and model, prefilled and refilled until edited', async () => {
    renderPanel(agent())
    await waitFor(() => expect(select().disabled).toBe(false))
    fireEvent.change(select(), { target: { value: 'opencode' } })
    await screen.findByRole('dialog', { name: 'Set up OpenCode in the vault' })
    const model = screen.getByLabelText('Model') as HTMLInputElement
    expect(model.value).toBe('gpt-5.6-luna')
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'anthropic' } })
    expect(model.value).toBe('claude-sonnet-5-5')
    fireEvent.change(model, { target: { value: 'claude-haiku-5' } })
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'openai' } })
    expect(model.value).toBe('claude-haiku-5')
    fireEvent.click(screen.getByRole('button', { name: 'Set up' }))
    await waitFor(() => expect(vault.switchEngine).toHaveBeenCalledWith('folder:alpha', { engine: 'opencode', provider: 'openai', model: 'claude-haiku-5' }))
    act(() => progress?.({ moveId: 'm1', agentId: 'folder:alpha', step: 'engine', status: 'done', message: 'The agent runs on OpenCode now.' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('offers Unlock on the locked line, and opens once the vault unlocks', async () => {
    status = { ...status, state: 'locked' }
    renderPanel(agent('locked'))
    fireEvent.click(await screen.findByRole('button', { name: 'Unlock' }))
    await waitFor(() => expect(vault.unlock).toHaveBeenCalledWith('folder:alpha'))
    await waitFor(() => expect(select().disabled).toBe(false))
    expect(screen.queryByRole('button', { name: 'Unlock' })).toBeNull()
  })

  it('keeps Unlock’s slot when unlocked, hidden, so the select is as wide either way; the label is fixed-width', async () => {
    status = { ...status, state: 'locked' }
    renderPanel(agent('locked'))
    const button = await screen.findByRole('button', { name: 'Unlock' })
    // `VaultUnlockLabel`: the fixed-width cell, with the longest label reserved unseen.
    expect(button.querySelector('.min-w-\\[6\\.5rem\\]')).not.toBeNull()
    expect(button.textContent).toContain('Unlocking… 100%')
    const slot = document.querySelector('[data-vault-engine-unlock]') as HTMLElement
    expect(slot.className).not.toContain('invisible')
    cleanup()
    status = { ...status, state: 'unlocked' }
    renderPanel(agent('unlocked'))
    const kept = document.querySelector('[data-vault-engine-unlock]') as HTMLElement
    expect(kept).not.toBeNull()
    expect(kept.className).toContain('invisible')
    expect(screen.queryByRole('button', { name: 'Unlock' })).toBeNull()
  })

  it('says a refused unlock on the same line, Unlock still there', async () => {
    status = { ...status, state: 'locked' }
    vault.unlock.mockResolvedValueOnce({ ok: false, code: 'denied', message: 'no' })
    renderPanel(agent('locked'))
    fireEvent.click(await screen.findByRole('button', { name: 'Unlock' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Unlock was cancelled at the prompt.'))
    expect(screen.getByRole('button', { name: 'Unlock' })).toBeTruthy()
  })

  it('says it could not read the engines, with Refresh', async () => {
    vault.engines.mockResolvedValueOnce({ ok: false, code: 'internal', message: 'boom' })
    renderPanel(agent())
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Couldn’t read the vault’s engines.'))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(await screen.findByText('Runs inside the vault on Claude Agent 2.1.0 · the CLI’s default model.')).toBeTruthy()
  })

  it('changes OpenCode’s model from its line, in the Switch to OpenCode dialog prefilled with the current one', async () => {
    status = { ...status, engine: 'opencode' }
    engines = engines.map((each) => each.engine === 'opencode' ? { ...each, setUp: true, version: '1.2.3' } : each)
    renderPanel(agent('unlocked', { engine: 'opencode', provider: 'anthropic', model: 'claude-haiku-5' }))
    expect(await screen.findByText('Runs inside the vault on OpenCode 1.2.3 · model anthropic/claude-haiku-5.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Change model…' }))
    await screen.findByRole('dialog', { name: 'Switch to OpenCode' })
    expect((screen.getByLabelText('Provider') as HTMLSelectElement).value).toBe('anthropic')
    expect((screen.getByLabelText('Model') as HTMLInputElement).value).toBe('claude-haiku-5')
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'claude-sonnet-5-5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Switch' }))
    await waitFor(() => expect(vault.switchEngine).toHaveBeenCalledWith('folder:alpha', { engine: 'opencode', provider: 'anthropic', model: 'claude-sonnet-5-5' }))
  })
})
