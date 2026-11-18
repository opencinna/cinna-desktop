import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalAgentDto } from '../../../../../../shared/localAgents'
import type { RuntimeModelCatalog } from '../../../../../../shared/runtimeModelCatalog'
import type { VaultEngineChoiceDto, VaultMoveProgressEvent, VaultStatusDto } from '../../../../../../shared/vault/types'
import { vaultStatusKey } from '../../../../hooks/useVault'
import { useAuthStore } from '../../../../stores/auth.store'
import { useUIStore } from '../../../../stores/ui.store'
import { VaultEnginePanel } from './VaultEnginePanel'

/**
 * What a vault agent runs with, laid out as the host Runs-with panel: Runs on
 * (the vault engines; a set-up engine switches at once, any other and OpenCode
 * open the setup dialog), Model / Work complexity with Advanced and the
 * effort, written into the vault, and the Engine cell. Locked, every control
 * shows the row's last values, disabled, and the one line offers Unlock.
 */

let status: VaultStatusDto
let engines: VaultEngineChoiceDto[]
let progress: ((event: VaultMoveProgressEvent) => void) | null
let catalog: RuntimeModelCatalog
const vault = {
  status: vi.fn(async () => ({ ok: true, data: status })),
  engines: vi.fn(async (): Promise<unknown> => ({ ok: true, data: engines })),
  engineAuth: vi.fn(async (): Promise<unknown> => ({ ok: true, data: { loggedIn: true, method: 'api_key', keyName: 'ANTHROPIC_API_KEY' } })),
  unlock: vi.fn(async (): Promise<unknown> => ({ ok: true, data: { ...status, state: 'unlocked' } })),
  switchEngine: vi.fn(async (): Promise<unknown> => ({ ok: true, data: { moveId: 'm1' } })),
  setRunsWith: vi.fn(async (): Promise<unknown> => ({ ok: true, data: undefined })),
  onMoveProgress: vi.fn((cb: (event: VaultMoveProgressEvent) => void) => {
    progress = cb
    return () => { progress = null }
  })
}
const settings = {
  getAll: vi.fn(async () => ({ localAgentsModelAdvanced: false })),
  set: vi.fn(async () => ({ success: true }))
}
let refreshed: { catalog: RuntimeModelCatalog; error: string | null } | null
const engine = {
  modelCatalog: vi.fn(async () => catalog),
  // The host CLI's on-demand list (`useRuntimeModelCatalogRefresh`): the same catalogue unless a test says otherwise.
  // Main keeps what a refresh learned, so the next read returns it too.
  refreshModelCatalog: vi.fn(async () => {
    if (!refreshed) return { catalog, error: null }
    catalog = refreshed.catalog
    return refreshed
  }),
  claudeBinary: vi.fn(async () => ({ state: 'ready' })),
  codexBinary: vi.fn(async () => ({ state: 'ready' })),
  antigravityBinary: vi.fn(async () => ({ state: 'ready' }))
}
const localTools = {
  claudeAuth: vi.fn(async () => ({ state: 'logged_in' })),
  codexAuth: vi.fn(async () => ({ state: 'logged_in' })),
  antigravityAuth: vi.fn(async () => ({ state: 'logged_in' }))
}

beforeEach(() => {
  status = {
    agentId: 'folder:alpha', vaultId: 'v1', agentName: 'Alpha', engine: 'claude', state: 'unlocked', until: null,
    lockAfterMs: 300_000, sizeBytes: 10 * 1024 ** 3, usedBytes: null, egress: { hosts: ['api.anthropic.com'] },
    createdAt: 0, imageVersion: '1.0.0', error: null, otherBuild: null
  }
  engines = [
    { engine: 'claude', setUp: true, version: '2.1.0' },
    { engine: 'codex', setUp: true, version: '0.1.0' },
    { engine: 'opencode', setUp: false, version: null },
    { engine: 'antigravity', setUp: false, version: null }
  ]
  catalog = {
    engine: 'claude',
    models: [{ id: 'default', name: 'Default' }, { id: 'opus', name: 'Opus' }, { id: 'sonnet', name: 'Sonnet' }],
    effortsByModel: { opus: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], sonnet: [] },
    source: 'session',
    updatedAt: 1
  }
  progress = null
  refreshed = null
  // A refresh lands in the catalogue of the profile it was asked for.
  useAuthStore.setState({ currentUser: { id: 'u1' } } as never)
  ;(window as unknown as { api: unknown }).api = { vault, settings, engine, localTools }
  vi.clearAllMocks()
})
afterEach(() => cleanup())

function agent(state: 'locked' | 'unlocked' = 'unlocked', vaultInfo: Record<string, unknown> = {}): LocalAgentDto {
  return { id: 'folder:alpha', name: 'Alpha', path: '', kind: 'kit', vault: { vaultId: 'v1', state, engine: 'claude', model: null, ...vaultInfo } } as LocalAgentDto
}

function renderPanel(a: LocalAgentDto): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(createElement(QueryClientProvider, { client }, createElement(VaultEnginePanel, { agent: a })))
  return client
}

const select = (): HTMLSelectElement => screen.getByLabelText('Runs on') as HTMLSelectElement
const complexity = (): HTMLSelectElement => screen.getByRole('combobox', { name: 'Work complexity' }) as HTMLSelectElement
const advanced = (): HTMLInputElement => screen.getByRole('checkbox', { name: 'Advanced' }) as HTMLInputElement
const section = (): HTMLElement => screen.getByRole('region', { name: 'Runs with' })

/** The panel's footprint: the three columns' controls and the one reserved line. */
function footprint(): string {
  const root = section()
  return JSON.stringify({
    columns: root.querySelector('.grid')?.children.length,
    selects: root.querySelector('.grid')!.children[0].querySelectorAll('select').length,
    labelRow: root.querySelector('.h-\\[15px\\]') !== null,
    engineCell: root.querySelector('.h-\\[26px\\]') !== null,
    line: root.querySelectorAll(':scope > .h-4').length
  })
}

describe('VaultEnginePanel', () => {
  it('is disabled while the vault is locked, showing the last values, and offers Unlock before its line', async () => {
    status = { ...status, state: 'locked' }
    renderPanel(agent('locked', { complexity: 'complex' }))
    expect(await screen.findByText('Unlock the vault to change how it runs.')).toBeTruthy()
    expect(select().disabled).toBe(true)
    await waitFor(() => expect(complexity().value).toBe('complex'))
    expect(complexity().disabled).toBe(true)
    expect(advanced().disabled).toBe(true)
    // Unlock is on the line, before the sentence, at the line's scale.
    const unlock = screen.getByRole('button', { name: 'Unlock' })
    expect(unlock.nextElementSibling?.textContent).toBe('Unlock the vault to change how it runs.')
    expect(unlock.className).toContain('h-4')
    expect(screen.getByText('Claude Code')).toBeTruthy()
    expect(vault.engines).not.toHaveBeenCalled()
    expect(vault.engineAuth).not.toHaveBeenCalled()
  })

  it('keeps the same footprint locked, unlocked and switching (rule 1)', async () => {
    status = { ...status, state: 'locked' }
    renderPanel(agent('locked'))
    await screen.findByText('Unlock the vault to change how it runs.')
    await waitFor(() => expect(screen.queryByLabelText('Model choice')).toBeNull())
    const locked = footprint()
    expect(document.querySelector('[data-vault-engine-unlock]')).toBeNull()
    cleanup()
    status = { ...status, state: 'unlocked' }
    renderPanel(agent())
    await waitFor(() => expect(select().disabled).toBe(false))
    expect(footprint()).toBe(locked)
    fireEvent.change(select(), { target: { value: 'codex' } })
    await screen.findByText('Switching to Codex…')
    expect(footprint()).toBe(locked)
    expect(complexity().disabled).toBe(true)
    expect(advanced().disabled).toBe(true)
  })

  it('lists the four engines, marking those that need setup, and switches to a set-up one at once', async () => {
    renderPanel(agent())
    await waitFor(() => expect(select().disabled).toBe(false))
    expect([...select().options].map((o) => o.textContent)).toEqual(['Claude Agent', 'Codex', 'OpenCode — needs setup', 'Antigravity — needs setup'])
    expect(await screen.findByText('Runs inside the vault on Claude Code’s default model.')).toBeTruthy()
    expect(screen.getByText('Claude Code 2.1.0')).toBeTruthy()
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

  it('writes a work complexity into the vault, with the tier labels the host panel uses', async () => {
    renderPanel(agent())
    await waitFor(() => expect(complexity().disabled).toBe(false))
    expect([...complexity().options].map((o) => o.textContent)).toEqual(['Not set — Claude Code default', 'Simple', 'Medium', 'Complex'])
    fireEvent.change(complexity(), { target: { value: 'simple' } })
    await waitFor(() => expect(vault.setRunsWith).toHaveBeenCalledWith('folder:alpha', { model: null, effort: null, complexity: 'simple' }))
  })

  it('names a model in Advanced with its effort from the host catalogue, and writes the effort beside it', async () => {
    renderPanel(agent('unlocked', { model: 'opus' }))
    const model = await screen.findByRole('combobox', { name: 'Model' }) as HTMLSelectElement
    await waitFor(() => expect(model.disabled).toBe(false))
    expect(advanced().checked).toBe(true)
    expect(model.value).toBe('opus')
    expect([...model.options].map((o) => o.textContent)).toEqual(['Not set — Claude Code default', 'Claude Code default', 'Opus', 'Sonnet'])
    const effort = screen.getByRole('combobox', { name: 'Effort' }) as HTMLSelectElement
    expect([...effort.options].map((o) => o.textContent)).toEqual(['Default', 'Low', 'High'])
    expect(await screen.findByText('Runs inside the vault on Opus.')).toBeTruthy()
    fireEvent.change(effort, { target: { value: 'high' } })
    await waitFor(() => expect(vault.setRunsWith).toHaveBeenCalledWith('folder:alpha', { model: 'opus', effort: 'high', complexity: null }))
  })

  it('ticking Advanced converts a tier to the model it runs on, and remembers the picker', async () => {
    renderPanel(agent('unlocked', { complexity: 'medium' }))
    await waitFor(() => expect(advanced().disabled).toBe(false))
    expect(await screen.findByText('Runs inside the vault on Sonnet.')).toBeTruthy()
    fireEvent.click(advanced())
    await waitFor(() => expect(vault.setRunsWith).toHaveBeenCalledWith('folder:alpha', { model: 'sonnet', effort: null, complexity: null }))
    expect(await screen.findByText('Pinned “Sonnet” — what Medium ran on.')).toBeTruthy()
    expect(settings.set).toHaveBeenCalledWith('localAgentsModelAdvanced', true)
  })

  it('says a refused write on its line, and leaves the controls usable', async () => {
    vault.setRunsWith.mockResolvedValueOnce({ ok: false, code: 'busy', message: 'This agent is busy moving, updating or switching its engine. Change it when that ends.' })
    renderPanel(agent())
    await waitFor(() => expect(complexity().disabled).toBe(false))
    fireEvent.change(complexity(), { target: { value: 'complex' } })
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'This agent is busy moving, updating or switching its engine. Change it when that ends.')
    expect(complexity().disabled).toBe(false)
  })

  it('warns on its line when the engine is not signed in inside the vault, with Add key first, which opens the Security tab', async () => {
    vault.engineAuth.mockResolvedValueOnce({ ok: true, data: { loggedIn: false, method: null, keyName: 'ANTHROPIC_API_KEY' } })
    useUIStore.setState({ agentPageTabRequest: null })
    renderPanel(agent())
    // Short enough for 800px; the whole sentence is the title.
    const text = await screen.findByText('Not signed in inside the vault.')
    expect(text.getAttribute('title')).toMatch(/^Not signed in inside the vault — add an Anthropic API key .* on the Security tab\.$/)
    const add = screen.getByRole('button', { name: 'Add key' })
    expect(add.nextElementSibling?.textContent).toBe('Not signed in inside the vault.')
    fireEvent.click(add)
    expect(useUIStore.getState().agentPageTabRequest).toBe('security')
    expect(useUIStore.getState().agentPageMode).toBe('settings')
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
    const dialog = await screen.findByRole('dialog', { name: 'Set up OpenCode in the vault' })
    const model = within(dialog).getByLabelText('Model') as HTMLInputElement
    expect(model.value).toBe('gpt-5.6-luna')
    fireEvent.change(within(dialog).getByLabelText('Provider'), { target: { value: 'anthropic' } })
    expect(model.value).toBe('claude-sonnet-5-5')
    fireEvent.change(model, { target: { value: 'claude-haiku-5' } })
    fireEvent.change(within(dialog).getByLabelText('Provider'), { target: { value: 'openai' } })
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
    expect(await screen.findByText('Runs inside the vault on Claude Code’s default model.')).toBeTruthy()
  })

  it('shows OpenCode’s model read-only and changes it from its line, in the Switch to OpenCode dialog prefilled with the current one', async () => {
    status = { ...status, engine: 'opencode' }
    engines = engines.map((each) => each.engine === 'opencode' ? { ...each, setUp: true, version: '1.2.3' } : each)
    renderPanel(agent('unlocked', { engine: 'opencode', provider: 'anthropic', model: 'claude-haiku-5' }))
    // The model is in its column; the line does not say it again.
    expect(await screen.findByText('Runs inside the vault on the Anthropic API.')).toBeTruthy()
    expect(screen.queryByRole('combobox', { name: 'Model' })).toBeNull()
    const shown = screen.getByRole('button', { name: /^Model: anthropic\/claude-haiku-5/ }) as HTMLButtonElement
    expect(shown.textContent).toBe('anthropic/claude-haiku-5')
    expect(screen.queryByRole('button', { name: 'Change model…' })).toBeNull()
    expect(await screen.findByText('opencode 1.2.3')).toBeTruthy()
    await waitFor(() => expect(shown.disabled).toBe(false))
    fireEvent.click(shown)
    const dialog = await screen.findByRole('dialog', { name: 'Switch to OpenCode' })
    expect((within(dialog).getByLabelText('Provider') as HTMLSelectElement).value).toBe('anthropic')
    expect((within(dialog).getByLabelText('Model') as HTMLInputElement).value).toBe('claude-haiku-5')
    fireEvent.change(within(dialog).getByLabelText('Model'), { target: { value: 'claude-sonnet-5-5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Switch' }))
    await waitFor(() => expect(vault.switchEngine).toHaveBeenCalledWith('folder:alpha', { engine: 'opencode', provider: 'anthropic', model: 'claude-sonnet-5-5' }))
    expect(vault.setRunsWith).not.toHaveBeenCalled()
  })
  it('asks the host CLI for its models when Advanced is shown and none are known, then names them (a fresh install)', async () => {
    // Mutation: drop `useRuntimeModelCatalogRefresh` and the list stays empty, the model shown by its id.
    catalog = { engine: 'claude', models: [], source: 'unavailable', updatedAt: null }
    refreshed = {
      catalog: {
        engine: 'claude',
        models: [{ id: 'default', name: 'Default', description: 'Opus 5.5' }, { id: 'opus', name: 'Opus 5.5' }, { id: 'sonnet', name: 'Sonnet 5' }],
        effortsByModel: { opus: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] },
        source: 'session',
        updatedAt: Date.now()
      },
      error: null
    }
    renderPanel(agent('unlocked', { model: 'opus' }))
    const model = await screen.findByRole('combobox', { name: 'Model' }) as HTMLSelectElement
    await waitFor(() => expect(engine.refreshModelCatalog).toHaveBeenCalledWith('claude'))
    await waitFor(() => expect([...model.options].map((o) => o.textContent)).toEqual(['Not set — Claude Code default', 'Claude Code default (Opus 5.5)', 'Opus 5.5', 'Sonnet 5']))
    expect(model.value).toBe('opus')
    expect(await screen.findByText('Runs inside the vault on Opus 5.5.')).toBeTruthy()
  })

  it('says a failed model list on its line with Refresh after it, which asks again', async () => {
    catalog = { engine: 'claude', models: [], source: 'unavailable', updatedAt: null }
    refreshed = { catalog, error: 'Claude Code is not signed in on this Mac.' }
    renderPanel(agent('unlocked', { model: 'opus' }))
    const text = await screen.findByText('Couldn’t list Claude Code’s models.')
    expect(text.getAttribute('title')).toBe('Claude Code is not signed in on this Mac.')
    const refresh = screen.getByRole('button', { name: 'Refresh' })
    expect(refresh.previousElementSibling?.textContent).toBe('Couldn’t list Claude Code’s models.')
    const calls = engine.refreshModelCatalog.mock.calls.length
    fireEvent.click(refresh)
    await waitFor(() => expect(engine.refreshModelCatalog.mock.calls.length).toBeGreaterThan(calls))
  })

  it('Codex: unticking Advanced waits for the session’s list, then converts once it arrives', async () => {
    status = { ...status, engine: 'codex' }
    // Codex's own cache names models but not the default a session starts on.
    catalog = { engine: 'codex', models: [{ id: 'gpt-5.6', name: 'GPT-5.6' }], source: 'cli-cache', updatedAt: Date.now() }
    refreshed = {
      catalog: {
        engine: 'codex',
        models: [{ id: 'gpt-5.6', name: 'GPT-5.6' }, { id: 'gpt-5.6-mini', name: 'GPT-5.6 mini' }],
        effortsByModel: { 'gpt-5.6': [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }] },
        defaultModelId: 'gpt-5.6',
        source: 'session',
        updatedAt: Date.now()
      },
      error: null
    }
    renderPanel(agent('unlocked', { engine: 'codex', model: 'gpt-5.6', effort: 'high' }))
    await waitFor(() => expect(engine.refreshModelCatalog).toHaveBeenCalledWith('codex'))
    await waitFor(() => expect(advanced().disabled).toBe(false))
    expect((screen.getByRole('combobox', { name: 'Model' }) as HTMLSelectElement).options[0].textContent).toBe('Not set — GPT-5.6 (Codex default)')
    fireEvent.click(advanced())
    await waitFor(() => expect(vault.setRunsWith).toHaveBeenCalledWith('folder:alpha', { model: null, effort: null, complexity: 'complex' }))
  })

  it('Codex: unticking Advanced is not blocked when this Mac cannot list Codex’s models (Codex only inside the vault)', async () => {
    // Mutation: block the untick on `conversionPending` alone and the checkbox stays disabled for good.
    status = { ...status, engine: 'codex' }
    catalog = { engine: 'codex', models: [{ id: 'gpt-5.6', name: 'GPT-5.6' }], source: 'cli-cache', updatedAt: Date.now() }
    refreshed = { catalog, error: 'Codex is not signed in on this Mac.' }
    renderPanel(agent('unlocked', { engine: 'codex', model: 'gpt-5.6', effort: 'high' }))
    expect(await screen.findByText('Couldn’t list Codex’s models.')).toBeTruthy()
    await waitFor(() => expect(advanced().disabled).toBe(false))
    fireEvent.click(advanced())
    await waitFor(() => expect(vault.setRunsWith).toHaveBeenCalledWith('folder:alpha', expect.objectContaining({ model: null, effort: null })))
  })

  it('lists only the efforts its engine takes inside', async () => {
    catalog = { ...catalog, effortsByModel: { opus: [{ id: 'default', name: 'Default' }, { id: 'minimal', name: 'Minimal' }, { id: 'low', name: 'Low' }, { id: 'max', name: 'Max' }] } }
    renderPanel(agent('unlocked', { model: 'opus' }))
    const effort = await screen.findByRole('combobox', { name: 'Effort' }) as HTMLSelectElement
    // `minimal` is Codex's; Claude Code takes low…max.
    await waitFor(() => expect([...effort.options].map((o) => o.textContent)).toEqual(['Default', 'Low', 'Max']))
  })

  it('keeps Unlock one width idle and unlocking, and says the prompt on its line meanwhile (rules 1, 19)', async () => {
    status = { ...status, state: 'locked' }
    let finish: (value: unknown) => void = () => {}
    vault.unlock.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    renderPanel(agent('locked'))
    const button = await screen.findByRole('button', { name: 'Unlock' })
    // A reserved, invisible "Unlocking…" sizes the button from the first frame.
    const reserve = button.querySelector('[aria-hidden="true"].invisible')
    expect(reserve?.textContent).toBe('Unlocking…')
    fireEvent.click(button)
    expect(await screen.findByRole('button', { name: 'Unlocking…' })).toBe(button)
    expect(button.querySelector('[aria-hidden="true"].invisible')?.textContent).toBe('Unlocking…')
    expect(screen.getByText('Unlocking asks for Touch ID or your password.')).toBeTruthy()
    await act(async () => finish({ ok: true, data: { ...status, state: 'unlocked' } }))
  })

  it('a tampered vault says why, with nothing to press', async () => {
    status = { ...status, state: 'tampered', otherBuild: 'release' }
    renderPanel(agent('locked'))
    const text = await screen.findByText('Made by the released app — this version can’t open it.')
    expect(text.getAttribute('title')).toBe('This vault was made by the released Cinna app. This version can\'t open it: each build keeps its own vault keys.')
    expect(screen.queryByRole('button', { name: 'Unlock' })).toBeNull()
    expect(select().disabled).toBe(true)
    cleanup()
    status = { ...status, state: 'tampered', otherBuild: null }
    renderPanel(agent('locked'))
    expect(await screen.findByText('This vault failed its integrity check and can\'t be opened.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Unlock' })).toBeNull()
  })

  it('drops a refused write’s sentence once its cause has gone: a lock and unlock, or a change of engine', async () => {
    vault.setRunsWith.mockResolvedValue({ ok: false, code: 'busy', message: 'This agent is busy moving, updating or switching its engine. Change it when that ends.' })
    const client = renderPanel(agent())
    await waitFor(() => expect(complexity().disabled).toBe(false))
    fireEvent.change(complexity(), { target: { value: 'complex' } })
    expect(await screen.findByRole('alert')).toBeTruthy()
    // Locked, then unlocked again (from anywhere): the refusal belonged to before.
    act(() => client.setQueryData(vaultStatusKey('folder:alpha'), { ...status, state: 'locked' }))
    await screen.findByText('Unlock the vault to change how it runs.')
    act(() => client.setQueryData(vaultStatusKey('folder:alpha'), { ...status, state: 'unlocked' }))
    expect(await screen.findByText('Runs inside the vault on Claude Code’s default model.')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    // A choice of engine clears it too, even one that only opens the setup dialog.
    fireEvent.change(complexity(), { target: { value: 'complex' } })
    expect(await screen.findByRole('alert')).toBeTruthy()
    fireEvent.change(select(), { target: { value: 'antigravity' } })
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    expect(await screen.findByText('Runs inside the vault on Claude Code’s default model.')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    vault.setRunsWith.mockResolvedValue({ ok: true, data: undefined })
  })
})
