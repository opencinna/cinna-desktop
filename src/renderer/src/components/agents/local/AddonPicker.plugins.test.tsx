import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddonDirectoryResult, AgentDirectoryEntry, AddonComponents } from '../../../../../shared/addons/directory'
import type { AgentEngine } from '../../../../../shared/engine'

/**
 * The picker's plugin entries (unified addons U3b): what a plugin adds and
 * needs, which engines take which of its parts (the agent's first), the Add
 * button that carries the runs-code consent, a plugin blocked by a missing
 * Node.js with its link and Check again, one only partly usable here that
 * still adds, and the step a plugin's connector needs right after the add.
 */

window.api = {} as never
const { AddonPicker } = await import('./AddonPicker')
const { SetupStep } = await import('./AddonPickerDetail')

const COMPONENTS: AddonComponents = {
  skills: [{ name: 'ledger-howto', hasScripts: false }],
  commands: ['balance'],
  agents: [],
  hooks: { events: ['PreToolUse', 'Stop'] },
  mcpServers: [{ name: 'ledger', transport: 'stdio', runtime: 'node', auth: 'env', env: [{ name: 'LEDGER_TOKEN', secret: true }] }],
  lspServers: []
}

function plugin(over: Partial<AgentDirectoryEntry> = {}): AgentDirectoryEntry {
  return {
    ref: { source: 'core-marketplace-plugin', id: 'e-ledger' },
    kind: 'plugin',
    name: 'ledger-tools',
    title: 'ledger-tools',
    summary: 'Ledger lookups.',
    description: '',
    category: null,
    tags: [],
    iconUrl: null,
    publisher: null,
    origin: { label: 'Acme Plugins', kind: 'marketplace', repositoryUrl: null, homepage: null },
    version: '1.0.0',
    digest: null,
    components: COMPONENTS,
    requires: { credentials: [] },
    runsCode: true,
    status: 'ready',
    unsupportedReason: null,
    install: null,
    provider: 'cinna-core',
    state: 'addable',
    stateReason: null,
    ...over
  }
}

let answer: Extract<AddonDirectoryResult, { ok: true }>
const directory = vi.fn(async () => answer)
const add = vi.fn()
const upsert = vi.fn()
const pluginStatus = vi.fn()
const recheckRuntimes = vi.fn()
let providers: Array<Record<string, unknown>> = []

function mount(engine: AgentEngine | null = 'claude'): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(AddonPicker, {
        agent: { id: 'folder:a', name: 'Alpha', kit: true, engine },
        onClose: vi.fn(),
        onAttachCreated: vi.fn(async () => {})
      })
    )
  )
}

const dialog = (): HTMLElement => screen.getByRole('dialog', { name: 'Addons for Alpha' })
const detail = (): HTMLElement => dialog().querySelector('[data-addon-detail]') as HTMLElement
const openPlugin = async (): Promise<ReturnType<typeof within>> => {
  fireEvent.click(await within(dialog()).findByRole('button', { name: 'ledger-tools' }))
  return within(detail())
}

beforeEach(() => {
  vi.resetAllMocks()
  answer = { ok: true, entries: [plugin()], sources: [{ id: 'cinna-core', label: 'Cinna' }], policy: { externalDirectories: false, customMcp: false, pluginHooks: true, stdioMcp: true } }
  providers = []
  directory.mockImplementation(async () => answer)
  window.api = {
    addons: { directory, search: vi.fn(), add, remove: vi.fn(), pluginStatus, recheckRuntimes },
    mcp: { list: vi.fn(async () => providers), onStatusChanged: () => () => {}, connect: vi.fn(), upsert },
    system: { openExternal: vi.fn(async () => ({ success: true })) }
  } as never
})

describe('AddonPicker — plugins', () => {
  it('shows a plugin as a Plugin tile, with what it adds, what it needs and which engines take which parts, the agent’s first', async () => {
    mount('codex')
    const tile = await within(dialog()).findByRole('button', { name: 'ledger-tools' })
    expect(tile.querySelector('[data-addon-kind="plugin"]')?.textContent).toBe('Plugin')
    const view = await openPlugin()
    // What it adds: the connector with its runtime, the hooks by event.
    expect(view.getByText('1 connector: ledger (Node.js)')).toBeTruthy()
    expect(view.getByText('Hooks on PreToolUse, Stop')).toBeTruthy()
    // Works with: the agent's engine first, then the rest in the matrix's order.
    const lines = [...detail().querySelectorAll('[data-addon-works-with] li')].map((li) => li.textContent)
    expect(lines).toEqual([
      'Codex: skills, connectors and commands only',
      'Claude: everything',
      'OpenCode: skills, connectors and commands only',
      'Antigravity: skills, connectors and commands only'
    ])
    // What it needs: Node.js and the connector's value, by name.
    expect(view.getByText('Node.js on this computer')).toBeTruthy()
    expect(view.getByText('Values for ledger')).toBeTruthy()
    expect(view.getByText('LEDGER_TOKEN')).toBeTruthy()
  })

  it('carries the runs-code consent on the Add button itself', async () => {
    mount()
    const view = await openPlugin()
    expect(view.getByRole('button', { name: 'Add — runs code on this computer' })).toBeTruthy()
    expect(view.queryByRole('button', { name: 'Add to Alpha' })).toBeNull()
  })

  it('reads Add to the agent on a plugin that runs no code', async () => {
    answer = { ...answer, entries: [plugin({ runsCode: false })] }
    mount()
    const view = await openPlugin()
    expect(view.getByRole('button', { name: 'Add to Alpha' })).toBeTruthy()
  })

  it('disables Add on a plugin that needs Node.js, links to nodejs.org, and Check again looks again and re-reads the directory', async () => {
    answer = { ...answer, entries: [plugin({ state: 'blocked', stateReason: 'Needs Node.js — install it from nodejs.org' })] }
    recheckRuntimes.mockImplementation(async () => {
      answer = { ...answer, entries: [plugin()] }
      return { ok: true, node: true, docker: false }
    })
    mount()
    const view = await openPlugin()
    expect((view.getByRole('button', { name: 'Add — runs code on this computer' }) as HTMLButtonElement).disabled).toBe(true)
    expect(view.getByText('Needs Node.js — install it from nodejs.org')).toBeTruthy()
    fireEvent.click(view.getByRole('link', { name: 'nodejs.org' }))
    expect(window.api.system.openExternal).toHaveBeenCalledWith('https://nodejs.org')
    const reads = directory.mock.calls.length
    fireEvent.click(view.getByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(recheckRuntimes).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(directory.mock.calls.length).toBeGreaterThan(reads))
    await waitFor(() => expect((within(detail()).getByRole('button', { name: 'Add — runs code on this computer' }) as HTMLButtonElement).disabled).toBe(false))
    expect(within(detail()).queryByRole('button', { name: 'Check again' })).toBeNull()
  })

  it('disables Add on a core directory connector that needs Docker, links to docker.com, and Check again makes it addable without a restart', async () => {
    const oci = (over: Partial<AgentDirectoryEntry> = {}): AgentDirectoryEntry =>
      plugin({ ref: { source: 'core-mcp-directory', id: 'grafana' }, kind: 'mcp', name: 'grafana', title: 'Grafana', components: undefined, runsCode: true,
        origin: { label: 'Cinna MCP directory', kind: 'directory', repositoryUrl: null, homepage: null }, ...over })
    answer = { ...answer, entries: [oci({ state: 'blocked', stateReason: 'Needs Docker — install it from docker.com' })] }
    recheckRuntimes.mockImplementation(async () => {
      answer = { ...answer, entries: [oci()] }
      return { ok: true, node: false, docker: true }
    })
    mount()
    fireEvent.click(await within(dialog()).findByRole('button', { name: 'Grafana' }))
    const view = within(detail())
    const addButton = (): HTMLButtonElement => within(detail()).getByRole('button', { name: /^Add/ }) as HTMLButtonElement
    expect(addButton().disabled).toBe(true)
    expect(view.getByText('Needs Docker — install it from docker.com')).toBeTruthy()
    fireEvent.click(view.getByRole('link', { name: 'docker.com' }))
    expect(window.api.system.openExternal).toHaveBeenCalledWith('https://www.docker.com')
    const reads = directory.mock.calls.length
    fireEvent.click(view.getByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(recheckRuntimes).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(directory.mock.calls.length).toBeGreaterThan(reads))
    await waitFor(() => expect(addButton().disabled).toBe(false))
    expect(within(detail()).queryByRole('button', { name: 'Check again' })).toBeNull()
    expect(within(detail()).queryByText('Needs Docker — install it from docker.com')).toBeNull()
  })

  it('keeps Add disabled on a plugin still being prepared, saying so', async () => {
    answer = { ...answer, entries: [plugin({ status: 'pending', state: 'preparing', stateReason: 'Being prepared on the server' })] }
    mount()
    const view = await openPlugin()
    expect((view.getByRole('button', { name: 'Add — runs code on this computer' }) as HTMLButtonElement).disabled).toBe(true)
    expect(view.getByText('Being prepared on the server')).toBeTruthy()
    expect(view.queryByRole('button', { name: 'Check again' })).toBeNull()
  })

  it('adds a plugin only partly usable on the agent’s engine, with the sentence beside the button', async () => {
    answer = { ...answer, entries: [plugin({ state: 'partly_compatible', stateReason: 'Skills and connectors only on Codex' })] }
    mount('codex')
    const view = await openPlugin()
    const button = view.getByRole('button', { name: 'Add — runs code on this computer' }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    expect(view.getByText('Skills and connectors only on Codex')).toBeTruthy()
  })

  it('after the add, asks for the value its connector needs in place, then says ready in the next chat', async () => {
    add.mockResolvedValue({ ok: true, next: 'env' })
    providers = [{ id: 'p-ledger', name: 'ledger', transportType: 'stdio', command: 'node', args: ['server.mjs'], env: { LEDGER_TOKEN: '', LEDGER_REGION: '' }, enabled: true, hasAuth: false, authType: 'none', status: 'disconnected', tools: [], managedBy: 'plugin:e-ledger@abc', envSlots: [{ name: 'LEDGER_TOKEN', hasValue: false }, { name: 'LEDGER_REGION', hasValue: true }] }]
    const server = { name: 'ledger', transport: 'stdio', disabled: false, mcpProviderId: 'p-ledger' }
    let filled = false
    pluginStatus.mockImplementation(async () => ({
      ok: true,
      plugins: [
        {
          name: 'ledger-tools', title: 'ledger-tools', entryUuid: 'e-ledger', marketplaceName: 'Acme Plugins', version: '1.0.0', archiveSha256: 'abc',
          availability: 'current', availabilityText: null, cache: 'ready', engine: 'claude', compatibility: { level: 'compatible', reason: null },
          skills: [], commands: [], hasAgents: false, agents: [], hasHooks: false, hookEvents: [], hooksDisabled: false, hooksDelivered: false, hooksBlockedByPolicy: false,
          mcpServers: [filled ? server : { ...server, setup: 'env', missingEnv: ['LEDGER_TOKEN'] }]
        }
      ]
    }))
    upsert.mockImplementation(async () => {
      filled = true
      providers = [{ ...providers[0], status: 'connected' }]
      return { id: 'p-ledger', success: true }
    })
    mount()
    const view = await openPlugin()
    fireEvent.click(view.getByRole('button', { name: 'Add — runs code on this computer' }))
    // One field per name, from the connector's row; a stored value is never shown, and an empty field keeps it.
    const token = (await view.findByLabelText('LEDGER_TOKEN')) as HTMLInputElement
    const region = view.getByLabelText('LEDGER_REGION') as HTMLInputElement
    expect([token.value, region.value]).toEqual(['', ''])
    expect(region.placeholder).toBe('Saved — leave blank to keep it')
    expect(view.queryByRole('textbox', { name: /KEY=VALUE/ })).toBeNull()
    fireEvent.change(token, { target: { value: 'tok-42' } })
    fireEvent.click(view.getByRole('button', { name: 'Save' }))
    await view.findByText('Ready in the next chat')
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ id: 'p-ledger', env: { LEDGER_TOKEN: 'tok-42', LEDGER_REGION: '' }, enabled: true }))
  })

  it('after the add, asks for the access token of a connector with an Authorization header', async () => {
    add.mockResolvedValue({ ok: true, next: 'bearer' })
    providers = [{ id: 'p-remote', name: 'books', transportType: 'streamable-http', url: 'https://books.example.com/mcp', enabled: true, hasAuth: false, authType: 'bearer', status: 'disconnected', tools: [], managedBy: 'plugin:e-ledger@abc' }]
    pluginStatus.mockResolvedValue({
      ok: true,
      plugins: [
        {
          name: 'ledger-tools', title: 'ledger-tools', entryUuid: 'e-ledger', marketplaceName: 'Acme Plugins', version: '1.0.0', archiveSha256: 'abc',
          availability: 'current', availabilityText: null, cache: 'ready', engine: 'claude', compatibility: { level: 'compatible', reason: null },
          skills: [], commands: [], hasAgents: false, agents: [], hasHooks: false, hookEvents: [], hooksDisabled: false, hooksDelivered: false, hooksBlockedByPolicy: false,
          mcpServers: [{ name: 'books', transport: 'http', disabled: false, mcpProviderId: 'p-remote', setup: 'bearer' }]
        }
      ]
    })
    mount()
    const view = await openPlugin()
    fireEvent.click(view.getByRole('button', { name: 'Add — runs code on this computer' }))
    expect(await view.findByLabelText(/Paste the access token for books/)).toBeTruthy()
    // Not "Ready": the plugin is added, its connector is not usable yet.
    expect(view.queryByText('Ready in the next chat')).toBeNull()
  })

  it('reads Starting… in place while the connector its add started comes up, then Ready in the next chat', async () => {
    add.mockResolvedValue({ ok: true, next: null, starting: ['p-ledger'] })
    providers = [{ id: 'p-ledger', name: 'ledger', transportType: 'stdio', enabled: true, hasAuth: false, status: 'disconnected', connecting: true, tools: [], managedBy: 'plugin:e-ledger@abc' }]
    let statusChanged: () => void = () => {}
    ;(window.api as unknown as { mcp: Record<string, unknown> }).mcp.onStatusChanged = (listener: () => void) => {
      statusChanged = listener
      return () => {}
    }
    mount()
    const view = await openPlugin()
    fireEvent.click(view.getByRole('button', { name: 'Add — runs code on this computer' }))
    expect(await view.findByText('Starting… the first start downloads the server')).toBeTruthy()
    expect(view.queryByText('Ready in the next chat')).toBeNull()
    // Done has its own slot at the right edge, not moved by the text beside it.
    const doneSlot = (): string | undefined => view.getByRole('button', { name: 'Done' }).closest('[data-addon-ready-line]')?.className
    expect(doneSlot()).toContain('justify-between')
    providers = [{ ...providers[0], status: 'connected', connecting: undefined }]
    statusChanged()
    await view.findByText('Ready in the next chat')
    expect(view.queryByText('Starting… the first start downloads the server')).toBeNull()
    expect(doneSlot()).toContain('justify-between')
  })

  it('shows the connect step when the connect its add started ended without coming up (cancelled), found by re-reading', async () => {
    add.mockResolvedValue({ ok: true, next: null, starting: ['p-ledger'] })
    providers = [{ id: 'p-ledger', name: 'ledger', transportType: 'stdio', enabled: true, hasAuth: false, status: 'disconnected', connecting: true, tools: [], managedBy: 'plugin:e-ledger@abc' }]
    mount()
    const view = await openPlugin()
    fireEvent.click(view.getByRole('button', { name: 'Add — runs code on this computer' }))
    expect(await view.findByText('Starting… the first start downloads the server')).toBeTruthy()
    // Cancelled: no status event, no connect in flight any more. The step's own re-read finds it.
    providers = [{ ...providers[0], connecting: undefined }]
    expect(await view.findByRole('button', { name: 'Connect' }, { timeout: 4_000 })).toBeTruthy()
    expect(view.getByText('It did not connect.')).toBeTruthy()
    expect(view.queryByText('Starting… the first start downloads the server')).toBeNull()
  })

  it('shows the connect step with its sentence when the connector its add started fails', async () => {
    add.mockResolvedValue({ ok: true, next: null, starting: ['p-ledger'] })
    providers = [{ id: 'p-ledger', name: 'ledger', transportType: 'stdio', enabled: true, hasAuth: false, status: 'error', error: 'fetch failed', tools: [], managedBy: 'plugin:e-ledger@abc' }]
    mount()
    const view = await openPlugin()
    fireEvent.click(view.getByRole('button', { name: 'Add — runs code on this computer' }))
    expect(await view.findByText('It could not reach the server.')).toBeTruthy()
    expect(view.getByRole('button', { name: 'Connect' })).toBeTruthy()
    expect(view.queryByText('Ready in the next chat')).toBeNull()
  })

  it('says in place that Check again still finds no Node.js', async () => {
    answer = { ...answer, entries: [plugin({ state: 'blocked', stateReason: 'Needs Node.js — install it from nodejs.org' })] }
    recheckRuntimes.mockResolvedValue({ ok: true, node: false, docker: false })
    mount()
    const view = await openPlugin()
    fireEvent.click(view.getByRole('button', { name: 'Check again' }))
    expect((await view.findByRole('status')).textContent).toBe('Still no Node.js. If you just installed it, try again in a moment.')
    expect(view.getByRole('button', { name: 'Check again' })).toBeTruthy()
  })

  it('says the missing Node.js once on a blocked plugin, and leaves the runs-code consent to its button', async () => {
    answer = { ...answer, entries: [plugin({ state: 'blocked', stateReason: 'Needs Node.js — install it from nodejs.org' })] }
    mount()
    await openPlugin()
    expect(within(detail()).queryByText('Node.js on this computer')).toBeNull()
    expect(within(detail()).getByText('Values for ledger')).toBeTruthy()
    expect(detail().querySelector('[data-addon-runs-code]')).toBeNull()
  })

  it('shows why the plugin’s status could not be read after its add, with Not now, instead of waiting forever', async () => {
    add.mockResolvedValue({ ok: true, next: 'env' })
    pluginStatus.mockResolvedValue({ ok: false, code: 'not_kit_agent', message: 'This agent has no cinna-agent.json.' })
    mount()
    const view = await openPlugin()
    fireEvent.click(view.getByRole('button', { name: 'Add — runs code on this computer' }))
    expect((await view.findByRole('alert')).textContent).toBe('This agent has no cinna-agent.json.')
    fireEvent.click(view.getByRole('button', { name: 'Not now' }))
    await waitFor(() => expect(within(detail()).queryByText('This agent has no cinna-agent.json.')).toBeNull())
  })

  it('asks a directory connector’s settings by name too, never showing a stored value', async () => {
    // A connector made from a registry entry (not a plugin's): main keeps its values and sends names only.
    providers = [{ id: 'p-dir', name: 'weather', transportType: 'stdio', command: 'uvx', args: ['weather-mcp'], env: { WEATHER_KEY: '' }, enabled: true, hasAuth: false, authType: 'none', status: 'disconnected', tools: [], envSlots: [{ name: 'WEATHER_KEY', hasValue: true }] }]
    upsert.mockResolvedValue({ id: 'p-dir', success: true })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(createElement(QueryClientProvider, { client }, createElement(SetupStep, { title: 'weather', next: 'env', mcpProviderId: 'p-dir', added: true, onDone: vi.fn(), onDirty: vi.fn(), onLater: vi.fn() })))
    const field = (await screen.findByLabelText('WEATHER_KEY')) as HTMLInputElement
    expect(field.value).toBe('')
    expect(field.placeholder).toBe('Saved — leave blank to keep it')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ id: 'p-dir', env: { WEATHER_KEY: '' } })))
  })
})
