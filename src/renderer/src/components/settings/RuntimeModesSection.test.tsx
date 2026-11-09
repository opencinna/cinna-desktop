import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatModesSection } from './ChatModesSection'
import { runtimeModeChip } from './RuntimeModesSection'
import type { ChatModeData } from '../../constants/chatModeColors'
import type { RuntimeModeAvailability } from '../../../../shared/chatModeRuntime'
import { useUIStore } from '../../stores/ui.store'

/** Settings → Chats: the Runtime modes group above the saved modes. */

vi.mock('../../hooks/useEngine', () => ({
  useDefaultRuntime: () => ({ data: { engine: 'claude' } }),
  useClaudeBinary: () => ({ data: { state: 'unresolved' } }),
  useCodexBinary: () => ({ data: { state: 'failed', error: 'no network' } }),
  useAntigravityBinary: () => ({ data: { state: 'ready', path: '/x', source: 'managed', version: '1' } })
}))
vi.mock('../../hooks/useAppSettings', () => ({ useAppSettings: () => ({ data: {} }) }))
vi.mock('../../hooks/useProviders', () => ({ useProviders: () => ({ data: [] }) }))
vi.mock('../../hooks/useModels', () => ({ useModels: () => ({ data: [] }) }))
vi.mock('../../hooks/useMcp', () => ({ useMcpProviders: () => ({ data: [] }) }))
vi.mock('../../hooks/useRuntimeModelCatalog', () => ({ useRuntimeModelCatalog: () => ({ data: undefined }) }))
vi.mock('../../hooks/useLocalAgents', () => ({ AGENT_CREDENTIAL_BINDINGS_KEY: ['bindings'] }))
vi.mock('../../hooks/useLocalTools', () => ({
  ANTIGRAVITY_AUTH_KEY: ['antigravity-auth'], CLAUDE_AUTH_KEY: ['claude-auth'], CODEX_AUTH_KEY: ['codex-auth'],
  ENGINE_LOGIN_RUNNING_KEY: ['engine-login-running']
}))

const NAMES = { claude: 'Claude Agent', codex: 'Codex', antigravity: 'Antigravity', opencode: 'OpenCode' } as const

function runtimeMode(engine: keyof typeof NAMES, availability: RuntimeModeAvailability, extra: Partial<ChatModeData> = {}): ChatModeData {
  return {
    id: `rt-${engine}`, name: NAMES[engine], engine, builtinEngine: engine, runtime: { engine, availability },
    systemPrompt: '', toolPolicy: 'connectors', complexity: 'medium', providerId: null, modelId: null, mcpProviderIds: [],
    colorPreset: 'orange', isDefault: false, managed: false, adminManaged: false, enabled: true, createdAt: new Date(), ...extra
  }
}
const saved: ChatModeData = {
  id: 'saved', name: 'Writing', engine: null, builtinEngine: null, systemPrompt: '', toolPolicy: 'connectors', complexity: null,
  providerId: null, modelId: null, mcpProviderIds: [], colorPreset: 'indigo', isDefault: true,
  managed: false, adminManaged: false, enabled: true, createdAt: new Date()
}

const api = vi.hoisted(() => ({
  modes: [] as ChatModeData[],
  upsert: vi.fn(),
  reset: vi.fn(),
  runtimeSetup: vi.fn(),
  probes: vi.fn()
}))

function cleanupAndMount(): void {
  cleanup()
  mount()
}

function mount(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(<QueryClientProvider client={client}><ChatModesSection /></QueryClientProvider>)
}

beforeEach(() => {
  api.modes = [
    // Out of order on purpose: the group keeps the runtime cards' order.
    runtimeMode('opencode', 'needs_credential'),
    saved,
    runtimeMode('codex', 'install_failed'),
    runtimeMode('claude', 'needs_install'),
    runtimeMode('antigravity', 'needs_login')
  ]
  api.upsert.mockReset().mockResolvedValue({ id: 'x', success: true })
  api.reset.mockReset().mockResolvedValue({ success: true })
  api.runtimeSetup.mockReset().mockResolvedValue({ outcome: 'ready' })
  api.probes.mockReset()
  Object.defineProperty(window, 'api', {
    configurable: true, writable: true,
    value: {
      chatModes: { list: async () => api.modes, upsert: api.upsert, reset: api.reset, delete: vi.fn() },
      providers: { onAccountConfigSynced: () => () => {} },
      localTools: {
        runtimeSetupRunning: async () => ({ claude: null, codex: null, antigravity: null }),
        runtimeSetup: api.runtimeSetup,
        runtimeSetupCancel: vi.fn(),
        // A visit must never ask whether a runtime is signed in.
        claudeAuth: api.probes, codexAuth: api.probes, antigravityAuth: api.probes
      }
    }
  })
})

const runtimeGroup = async () => {
  // The composer's group is named the same (`RUNTIMES_GROUP`).
  const heading = await screen.findByRole('heading', { name: 'Runtimes' })
  return heading.closest('section') as HTMLElement
}
const savedGroup = () => screen.getByRole('heading', { name: 'Saved modes' }).closest('section') as HTMLElement

describe('Runtime modes group', () => {
  it('lists the four runtimes first, in fixed order, and keeps them out of Saved modes', async () => {
    mount()
    const group = await runtimeGroup()
    const names = within(group).getAllByText(/^(Claude Agent|Codex|Antigravity|OpenCode)$/).map((node) => node.textContent)
    expect(names).toEqual(['Claude Agent', 'Codex', 'Antigravity', 'OpenCode'])
    expect(within(savedGroup()).getByText('Writing')).toBeTruthy()
    expect(within(savedGroup()).queryByText('Claude Agent')).toBeNull()
    expect(group.compareDocumentPosition(savedGroup()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('draws each card’s status and chip from main’s availability, without a login probe', async () => {
    mount()
    const group = await runtimeGroup()
    const status = (engine: string) => group.querySelector(`[data-runtime-status="${engine}"]`) as HTMLElement
    await waitFor(() => expect(status('claude')).toBeTruthy())
    expect(within(status('claude')).getByText('Not installed')).toBeTruthy()
    expect(within(status('claude')).getByRole('button', { name: 'Install' })).toBeTruthy()
    expect(within(status('codex')).getByText('Install failed')).toBeTruthy()
    expect(within(status('codex')).getByRole('button', { name: 'Retry' })).toBeTruthy()
    expect(within(status('antigravity')).getByRole('button', { name: 'Log in' })).toBeTruthy()
    expect(within(status('opencode')).getByRole('button', { name: 'Add credential' })).toBeTruthy()
    // No delete on a runtime mode: Reset instead.
    expect(within(group).queryByRole('button', { name: 'Delete chat mode' })).toBeNull()
    expect(within(group).getByRole('button', { name: 'Reset Claude Agent to defaults' })).toBeTruthy()
    expect(api.probes).not.toHaveBeenCalled()
  })

  it('starts the same setup run as the Agents cards from a chip', async () => {
    mount()
    const group = await runtimeGroup()
    await waitFor(() => expect(group.querySelector('[data-runtime-status="claude"]')).toBeTruthy())
    await act(async () => { fireEvent.click(within(group).getByRole('button', { name: 'Install' })) })
    expect(api.runtimeSetup).toHaveBeenCalledWith('claude', { install: true, login: 'auto' })
    await act(async () => { fireEvent.click(within(group).getByRole('button', { name: 'Log in' })) })
    expect(api.runtimeSetup).toHaveBeenCalledWith('antigravity', { install: false, login: 'force' })
    act(() => { fireEvent.click(within(group).getByRole('button', { name: 'Add credential' })) })
    expect(useUIStore.getState().settingsTab).toBe('llm')
  })

  it('shows Ready with no chip, and the star moves the default from a saved mode to a runtime mode', async () => {
    api.modes = [runtimeMode('claude', 'ready'), saved]
    mount()
    const group = await runtimeGroup()
    await waitFor(() => expect(group.querySelector('[data-runtime-status="claude"]')).toBeTruthy())
    expect(within(group).getByText('Ready')).toBeTruthy()
    expect(within(group).queryByRole('button', { name: /^(Install|Retry|Log in|Add credential)$/ })).toBeNull()
    // The saved mode holds the star; the runtime card's star takes it.
    expect(within(savedGroup()).getByTitle('Remove as default')).toBeTruthy()
    await act(async () => { fireEvent.click(within(group).getByTitle('Set as default')) })
    expect(api.upsert).toHaveBeenCalledWith(expect.objectContaining({ id: 'rt-claude', name: 'Claude Agent', engine: 'claude', isDefault: true, complexity: 'medium' }))
  })

  it('edits a runtime mode without Name or Runtime, with Effort and Workspace offered', async () => {
    api.modes = [runtimeMode('codex', 'ready')]
    mount()
    const group = await runtimeGroup()
    fireEvent.click(within(group).getByText('Codex'))
    expect(within(group).queryByText('Name')).toBeNull()
    expect(within(group).queryByLabelText('Runtime')).toBeNull()
    const effort = within(group).getByLabelText('Effort') as HTMLSelectElement
    expect([...effort.options].map((option) => option.text)).toEqual(['Low', 'Medium', 'High'])
    // Codex's workspace policy is verified (`WORKSPACE_POLICY_ENGINES`), so the option is offered.
    const workspace = within(group).getByRole('option', { name: 'Workspace' }) as HTMLOptionElement
    expect(workspace.disabled).toBe(false)
    expect((within(group).getByLabelText('Instructions') as HTMLTextAreaElement).placeholder).toBe('Empty uses the default instructions')
    await act(async () => { fireEvent.change(effort, { target: { value: 'complex' } }) })
    expect(api.upsert).toHaveBeenCalledWith(expect.objectContaining({ id: 'rt-codex', complexity: 'complex', name: 'Codex', engine: 'codex' }))
  })
})

describe('Reset to defaults', () => {
  const resetButton = (group: HTMLElement) => within(group).getByRole('button', { name: 'Reset Claude Agent to defaults' })
  const instructions = (group: HTMLElement) => within(group).getByLabelText('Instructions') as HTMLTextAreaElement

  it('confirms, naming what is lost, and is unavailable on a card already at its defaults', async () => {
    api.modes = [runtimeMode('claude', 'ready', { toolPolicy: 'workspace', colorPreset: 'orange' })]
    mount()
    const group = await runtimeGroup()
    await waitFor(() => expect(resetButton(group).getAttribute('aria-disabled')).toBe('true'))
    fireEvent.click(resetButton(group))
    expect(screen.queryByRole('dialog')).toBeNull()
    api.modes = [runtimeMode('claude', 'ready', { toolPolicy: 'none', colorPreset: 'orange', systemPrompt: 'Mine', modelId: 'opus', mcpProviderIds: ['m1', 'm2'] })]
    cleanupAndMount()
    const next = await runtimeGroup()
    await waitFor(() => expect(resetButton(next).getAttribute('aria-disabled')).toBeNull())
    fireEvent.click(resetButton(next))
    const dialog = screen.getByRole('dialog', { name: 'Reset to defaults' })
    expect(dialog.textContent).toContain('It loses its instructions, its model override and its 2 MCP providers, and sets Tools to Workspace.')
    expect(dialog.textContent).toContain('This cannot be undone.')
    // Nothing is reset before the confirm.
    expect(api.reset).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(api.reset).not.toHaveBeenCalled()
  })

  it.each([
    ['theme', true], ['orange', true], ['theme', false], ['orange', false]
  ])('counts %s as at its defaults with the star %s, so moving the star offers no reset', async (colorPreset, isDefault) => {
    api.modes = [runtimeMode('claude', 'ready', { toolPolicy: 'workspace', colorPreset, isDefault })]
    mount()
    const group = await runtimeGroup()
    await waitFor(() => expect(resetButton(group).getAttribute('aria-disabled')).toBe('true'))
  })

  it('takes a starred mode in a picked colour to Theme Default, losing nothing, and keeps the two sides agreeing', async () => {
    api.modes = [runtimeMode('claude', 'ready', { toolPolicy: 'workspace', colorPreset: 'rose', isDefault: true })]
    mount()
    const group = await runtimeGroup()
    await waitFor(() => expect(resetButton(group).getAttribute('aria-disabled')).toBeNull())
    fireEvent.click(resetButton(group))
    const dialog = screen.getByRole('dialog', { name: 'Reset to defaults' })
    expect(dialog.textContent).toContain('It sets Color to Theme Default.')
    expect(dialog.textContent).toContain('It stays your default mode.')
    // A colour is one click away again; only what a reset clears is gone for good.
    expect(dialog.textContent).not.toContain('This cannot be undone.')
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Reset' })) })
    await waitFor(() => expect(api.reset).toHaveBeenCalledWith('rt-claude'))
    // Shown from the reset's own result: the list has not been refetched.
    fireEvent.click(within(group).getByText('Claude Agent'))
    await waitFor(() => expect(within(group).getByRole('button', { name: 'Theme Default' }).getAttribute('aria-pressed')).toBe('true'))
  })

  it('wins over the Instructions save its click set off, which it waits for', async () => {
    // Mutation: disable Reset while a save is pending and the click that
    // blurred the field lands on a disabled button — nothing is reset.
    api.modes = [runtimeMode('claude', 'ready', { toolPolicy: 'workspace' })]
    let finishSave: (value: unknown) => void = () => {}
    api.upsert.mockImplementation(() => new Promise((resolve) => { finishSave = resolve }))
    mount()
    const group = await runtimeGroup()
    fireEvent.click(within(group).getByText('Claude Agent'))
    const field = instructions(group)
    fireEvent.focus(field)
    fireEvent.change(field, { target: { value: 'Edited' } })
    // Pressing Reset blurs the field first: its save starts, and is still in flight.
    fireEvent.blur(field)
    await waitFor(() => expect(api.upsert).toHaveBeenCalledWith(expect.objectContaining({ systemPrompt: 'Edited' })))
    fireEvent.click(resetButton(group))
    const dialog = screen.getByRole('dialog', { name: 'Reset to defaults' })
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Reset' })) })
    // Queued behind the save on the mode's mutation scope, so it lands last.
    expect(api.reset).not.toHaveBeenCalled()
    await act(async () => { finishSave({ id: 'rt-claude', success: true }) })
    await waitFor(() => expect(api.reset).toHaveBeenCalledWith('rt-claude'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('shows the defaults at once and never saves the old instructions back, even before the list catches up', async () => {
    // Mutation: remount the fields from the card's previous row and the old
    // text is back in the field, to be saved again on its next blur.
    api.modes = [runtimeMode('claude', 'ready', { toolPolicy: 'workspace', systemPrompt: 'Old text' })]
    mount()
    const group = await runtimeGroup()
    fireEvent.click(within(group).getByText('Claude Agent'))
    expect(instructions(group).value).toBe('Old text')
    // The list keeps answering the old row: the refetch has not caught up.
    fireEvent.click(resetButton(group))
    await act(async () => { fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Reset' })) })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(instructions(group).value).toBe('')
    fireEvent.focus(instructions(group))
    fireEvent.blur(instructions(group))
    expect(api.upsert).not.toHaveBeenCalledWith(expect.objectContaining({ systemPrompt: 'Old text' }))
  })
})

describe('runtimeModeChip', () => {
  it('follows a run this window sees, and offers no install for a configured path', () => {
    expect(runtimeModeChip({ availability: 'needs_install', phase: 'installing', binary: undefined, pathSet: false })).toEqual({ kind: 'installing', percent: null })
    expect(runtimeModeChip({ availability: 'needs_login', phase: 'signing_in', binary: undefined, pathSet: false })).toEqual({ kind: 'logging_in' })
    expect(runtimeModeChip({ availability: 'installing', phase: null, binary: { state: 'resolving', received: 50, total: 100 }, pathSet: false })).toEqual({ kind: 'installing', percent: 50 })
    expect(runtimeModeChip({ availability: 'needs_install', phase: null, binary: undefined, pathSet: true })).toBeNull()
    expect(runtimeModeChip({ availability: 'ready', phase: null, binary: undefined, pathSet: false })).toBeNull()
  })
})
