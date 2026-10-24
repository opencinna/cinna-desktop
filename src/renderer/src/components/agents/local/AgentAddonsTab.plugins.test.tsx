import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalAgentDto } from '../../../../../shared/localAgents'
import type { PluginPinStatus } from '../../../../../shared/addons/plugins'
import type { AddonMcpRequirement } from '../../../../../shared/addons/directory'

/**
 * The Addons tab's plugin rows and manifest connectors (unified addons U3b):
 * a plugin is one row that expands to its parts, each with a switch writing
 * its `disabled`; its managed connector is nested in it, never a top-level
 * row, and offers its value form in place; unavailable and Update read as
 * such; a manifest connector that needs setup is a Connector row whose Set up
 * opens the picker straight at that entry's detail.
 */

const MANAGED = {
  id: 'p-ledger', name: 'ledger', transportType: 'stdio', command: 'node', args: ['server.mjs'], env: { LEDGER_TOKEN: '' },
  enabled: true, hasAuth: false, authType: 'none', status: 'disconnected', tools: [], managedBy: 'plugin:e-ledger@abc',
  envSlots: [{ name: 'LEDGER_TOKEN', hasValue: false }]
}
const OWN = { id: 'jira', name: 'Atlassian', transportType: 'streamable-http', url: 'https://jira.example.com/mcp', enabled: true, hasAuth: false, authType: 'oauth', status: 'connected', tools: [] }

function pin(over: Partial<PluginPinStatus> = {}): PluginPinStatus {
  return {
    name: 'ledger-tools',
    title: 'ledger-tools',
    entryUuid: 'e-ledger',
    marketplaceName: 'Acme Plugins',
    version: '1.0.0',
    archiveSha256: 'abc',
    availability: 'current',
    availabilityText: null,
    cache: 'ready',
    engine: 'claude',
    compatibility: { level: 'compatible', reason: null },
    skills: [{ name: 'ledger-howto', disabled: false, delivered: true }],
    commands: ['balance'],
    hasAgents: false,
    agents: [],
    hasHooks: true,
    hookEvents: ['PreToolUse'],
    hooksDisabled: false,
    hooksDelivered: true,
    hooksBlockedByPolicy: false,
    mcpServers: [{ name: 'ledger', transport: 'stdio', disabled: false, mcpProviderId: 'p-ledger', setup: 'env', missingEnv: ['LEDGER_TOKEN'] }],
    ...over
  }
}

let providers: Array<Record<string, unknown>> = []
let attached: string[] = []
let plugins: PluginPinStatus[] = []
let requirements: AddonMcpRequirement[] = []
const pluginStatus = vi.fn(async () => ({ ok: true, plugins }))
const setPluginDisabled = vi.fn(async (_agent: string, name: string) => ({ ok: true, name, archiveSha256: 'abc', next: null }))
const updatePlugin = vi.fn(async (_agent: string, name: string) => ({ ok: true, name, archiveSha256: 'def', next: null }))
const removeAddon = vi.fn(async () => ({ ok: true, next: null }))
const revealPlugin = vi.fn(async () => ({ ok: true }))
const removeRequirement = vi.fn(async () => ({ ok: true }))
const detachMcpProvider = vi.fn(async () => ({ success: true }))
const mcpRequirements = vi.fn(async () => ({ ok: true, items: requirements }))
const upsert = vi.fn()
const directory = vi.fn()

window.api = {} as never
const { AgentAddonsTab, useAddonsBadge } = await import('./AgentAddonsTab')
const { useAuthStore } = await import('../../../stores/auth.store')

function renderTab() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const agent = { id: 'folder:a', name: 'Alpha', kind: 'kit', skills: [], runtime: null } as unknown as LocalAgentDto
  return render(createElement(QueryClientProvider, { client }, createElement(AgentAddonsTab, { agent })))
}

const row = async (): Promise<HTMLElement> => {
  await screen.findByText('ledger-tools')
  return document.querySelector('[data-plugin-row="ledger-tools"]') as HTMLElement
}

beforeEach(() => {
  vi.clearAllMocks()
  providers = [MANAGED, OWN]
  attached = ['p-ledger', 'jira']
  plugins = [pin()]
  requirements = []
  useAuthStore.setState({ currentUser: null })
  directory.mockResolvedValue({ ok: true, entries: [], sources: [], policy: { externalDirectories: false, customMcp: false, pluginHooks: true, stdioMcp: true } })
  window.api = {
    addons: { directory, search: vi.fn(), add: vi.fn(), remove: removeAddon, pluginStatus, setPluginDisabled, updatePlugin, recheckRuntimes: vi.fn(), mcpRequirements, revealPlugin, removeRequirement },
    engine: { defaultRuntime: async () => ({ engine: 'claude' }) },
    system: { openExternal: vi.fn() },
    logger: { log: vi.fn() },
    localAgents: { listMcpProviders: async () => [...attached], attachMcpProvider: vi.fn(), detachMcpProvider, openPath: vi.fn() },
    mcp: { list: async () => providers, onStatusChanged: () => () => {}, upsert, agentsUsing: async () => [], connect: vi.fn() },
    sharing: { statuses: () => Promise.resolve({ success: true, value: [] }) },
    catalogSkills: { update: vi.fn(), remove: vi.fn(), ensure: vi.fn() },
    marketplaceSkills: { update: vi.fn(), remove: vi.fn(), ensure: vi.fn(), status: vi.fn() }
  } as never
})

describe('AgentAddonsTab — plugins', () => {
  it('draws a plugin as one Plugin row with what it carries, its managed connector nested and never a row of its own', async () => {
    renderTab()
    const plugin = await row()
    expect(plugin.getAttribute('data-addon-row')).toBe('plugin')
    expect(within(plugin).getByText('From Acme Plugins')).toBeTruthy()
    expect(within(plugin).getByText('Version 1.0.0')).toBeTruthy()
    expect(plugin.querySelector('[data-plugin-summary]')?.textContent).toBe('1 skill · 1 hook event · 1 connector · 1 command')
    // The connector's need is the plugin's warning line while collapsed.
    expect(within(plugin).getByText('ledger: needs settings filled in')).toBeTruthy()
    // The user's own connector is a top-level row; the plugin's is not.
    await screen.findByRole('button', { name: 'Detach Atlassian from this agent' })
    expect(screen.queryByRole('button', { name: 'Detach ledger from this agent' })).toBeNull()
    expect(document.querySelector('[data-mcp-row="p-ledger"]')).toBeNull()
  })

  it('expands to its parts, each switch writing the pin’s disabled', async () => {
    renderTab()
    const plugin = await row()
    fireEvent.click(within(plugin).getByRole('button', { expanded: false }))
    const parts = within(plugin.querySelector('[data-plugin-parts]') as HTMLElement)
    fireEvent.click(parts.getByRole('switch', { name: 'ledger-howto' }))
    await waitFor(() => expect(setPluginDisabled).toHaveBeenCalledWith('folder:a', 'ledger-tools', { skills: ['ledger-howto'] }))
    fireEvent.click(await parts.findByRole('switch', { name: 'ledger' }))
    await waitFor(() => expect(setPluginDisabled).toHaveBeenCalledWith('folder:a', 'ledger-tools', { mcpServers: ['ledger'] }))
    await waitFor(() => expect((parts.getByRole('switch', { name: 'Hooks' }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(parts.getByRole('switch', { name: 'Hooks' }))
    await waitFor(() => expect(setPluginDisabled).toHaveBeenCalledWith('folder:a', 'ledger-tools', { hooks: true }))
    expect(parts.getByText('/balance')).toBeTruthy()
  })

  it('turns a part back on by dropping it from the list it is in', async () => {
    plugins = [pin({ skills: [{ name: 'ledger-howto', disabled: true, delivered: false }, { name: 'other', disabled: true, delivered: false }] })]
    renderTab()
    const plugin = await row()
    fireEvent.click(within(plugin).getByRole('button', { expanded: false }))
    const sw = within(plugin).getByRole('switch', { name: 'ledger-howto' })
    expect(sw.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(sw)
    await waitFor(() => expect(setPluginDisabled).toHaveBeenCalledWith('folder:a', 'ledger-tools', { skills: ['other'] }))
  })

  it('disables the hooks switch with Blocked by your admin when the admin forbids plugin hooks', async () => {
    // Main's flag decides, not the wording of its sentence.
    plugins = [pin({ hooksDelivered: false, hooksBlockedByPolicy: true, hooksReason: 'Plugin hooks are turned off by policy.' })]
    renderTab()
    const plugin = await row()
    fireEvent.click(within(plugin).getByRole('button', { expanded: false }))
    const hooks = within(plugin).getByRole('switch', { name: 'Hooks' }) as HTMLButtonElement
    expect(hooks.disabled).toBe(true)
    expect(hooks.getAttribute('aria-checked')).toBe('false')
    expect(within(plugin).getByText('Blocked by your admin')).toBeTruthy()
  })

  it('fills the nested connector’s value in place, one field per name, then reads the plugin’s status again', async () => {
    upsert.mockImplementation(async () => {
      providers = [{ ...MANAGED, status: 'connected', envSlots: [{ name: 'LEDGER_TOKEN', hasValue: true }] }, OWN]
      return { id: 'p-ledger', success: true }
    })
    renderTab()
    const plugin = await row()
    fireEvent.click(within(plugin).getByRole('button', { expanded: false }))
    fireEvent.click(within(plugin).getByRole('button', { name: 'Set up ledger' }))
    const field = (await within(plugin).findByLabelText('LEDGER_TOKEN')) as HTMLInputElement
    expect(field.type).toBe('password')
    expect(field.value).toBe('')
    fireEvent.change(field, { target: { value: 'tok-42' } })
    const reads = pluginStatus.mock.calls.length
    fireEvent.click(within(plugin).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ id: 'p-ledger', env: { LEDGER_TOKEN: 'tok-42' }, enabled: true })))
    // Done: the row reads where the plugin stands now, rather than keep saying "Needs settings".
    await waitFor(() => expect(pluginStatus.mock.calls.length).toBeGreaterThan(reads))
  })

  it('keeps what is typed in a nested connector’s form across a collapse', async () => {
    renderTab()
    const plugin = await row()
    const header = within(plugin).getByRole('button', { expanded: false })
    fireEvent.click(header)
    fireEvent.click(within(plugin).getByRole('button', { name: 'Set up ledger' }))
    fireEvent.change(await within(plugin).findByLabelText('LEDGER_TOKEN'), { target: { value: 'half-typed' } })
    const collapse = (plugin.querySelector('[data-plugin-parts]') as HTMLElement).parentElement as HTMLElement
    fireEvent.click(header)
    // The collapse ends: its parts are unmounted.
    fireEvent.transitionEnd(collapse)
    await waitFor(() => expect(plugin.querySelector('[data-plugin-parts]')).toBeNull())
    fireEvent.click(header)
    expect(((await within(plugin).findByLabelText('LEDGER_TOKEN')) as HTMLInputElement).value).toBe('half-typed')
  })

  it('titles the row with the plugin’s title and counts every part it carries', async () => {
    plugins = [pin({ title: 'Ledger Tools', hasAgents: true, agents: ['auditor', 'clerk'], hookEvents: ['PreToolUse', 'Stop', 'SessionStart'] })]
    renderTab()
    await screen.findByText('Ledger Tools')
    const plugin = document.querySelector('[data-plugin-row="ledger-tools"]') as HTMLElement
    expect(plugin.querySelector('[data-plugin-summary]')?.textContent).toBe('1 skill · 2 agents · 3 hook events · 1 connector · 1 command')
    expect(within(plugin).getByRole('button', { name: 'Remove Ledger Tools' })).toBeTruthy()
    // Open, its agents are listed, with no switch of their own.
    fireEvent.click(within(plugin).getByRole('button', { expanded: false }))
    const agents = plugin.querySelector('[data-plugin-agents]') as HTMLElement
    expect(within(agents).getByText('auditor')).toBeTruthy()
    expect(within(agents).getByText('clerk')).toBeTruthy()
    expect(within(agents).getByText('Run by Claude')).toBeTruthy()
    expect(within(agents).queryByRole('switch')).toBeNull()
    // The hooks part lists the events it registers.
    expect(plugin.querySelector('[data-plugin-hook-events]')?.textContent).toBe('PreToolUse, Stop, SessionStart')
  })

  it('says hooks as a word when the hooks file registers no event, never "0 hook events"', async () => {
    plugins = [pin({ hookEvents: [], commands: [] })]
    renderTab()
    const plugin = await row()
    expect(plugin.querySelector('[data-plugin-summary]')?.textContent).toBe('1 skill · hooks · 1 connector')
    fireEvent.click(within(plugin).getByRole('button', { expanded: false }))
    expect(plugin.querySelector('[data-plugin-hook-events]')).toBeNull()
  })

  it('leaves the hooks switch alone when only the sentence mentions an admin', async () => {
    plugins = [pin({ hooksDelivered: false, hooksBlockedByPolicy: false, hooksReason: 'Your admin’s engine does not run hooks.' })]
    renderTab()
    const plugin = await row()
    fireEvent.click(within(plugin).getByRole('button', { expanded: false }))
    await waitFor(() => expect((within(plugin).getByRole('switch', { name: 'Hooks' }) as HTMLButtonElement).disabled).toBe(false))
    expect(within(plugin).queryByText('Blocked by your admin')).toBeNull()
  })

  it('puts the problem lines below the open parts, and a connector’s need only on its own line', async () => {
    plugins = [pin({ availability: 'unavailable', availabilityText: 'No longer available to you' })]
    renderTab()
    const plugin = await row()
    expect(within(plugin).getByText('ledger: needs settings filled in')).toBeTruthy()
    fireEvent.click(within(plugin).getByRole('button', { expanded: false }))
    const parts = plugin.querySelector('[data-plugin-parts]') as HTMLElement
    const issues = plugin.querySelector('[data-plugin-issues]') as HTMLElement
    // Below the switches: a line that goes never moves one.
    expect(parts.compareDocumentPosition(issues) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(issues).getByText('No longer available to you')).toBeTruthy()
    expect(within(plugin).queryByText('ledger: needs settings filled in')).toBeNull()
    expect(within(parts).getByText('Needs settings filled in')).toBeTruthy()
  })

  it('reds the plugin’s glyph and counts it in the badge when its connector failed to connect', async () => {
    providers = [{ ...MANAGED, status: 'error', error: 'spawn node ENOENT', envSlots: [{ name: 'LEDGER_TOKEN', hasValue: true }] }, OWN]
    plugins = [pin({ mcpServers: [{ name: 'ledger', transport: 'stdio', disabled: false, mcpProviderId: 'p-ledger' }] })]
    const seen: Array<ReturnType<typeof useAddonsBadge>> = []
    function Probe(): null {
      seen.push(useAddonsBadge('folder:a', []))
      return null
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(createElement(QueryClientProvider, { client }, createElement(Probe)))
    await waitFor(() => expect(seen[seen.length - 1]).toMatchObject({ count: 2, problems: 1 }))
    renderTab()
    const plugin = await row()
    expect(await within(plugin).findByText('ledger: spawn node ENOENT')).toBeTruthy()
  })

  it('says a partly compatible plugin’s limit as a muted fact, not a warning', async () => {
    plugins = [pin({ mcpServers: [], compatibility: { level: 'partly_compatible', reason: 'Skills and connectors only on Codex' } })]
    renderTab()
    const plugin = await row()
    expect(plugin.querySelector('[data-plugin-fact]')?.textContent).toBe('Skills and connectors only on Codex')
    expect(plugin.querySelector('[data-plugin-issues]')).toBeNull()
    const glyph = within(plugin).getByRole('img', { name: 'Skills and connectors only on Codex' })
    expect(glyph.className).not.toContain('--color-warning')
  })

  it('shows the plugin’s files from the row, and says why not inside its card', async () => {
    renderTab()
    const plugin = await row()
    fireEvent.click(within(plugin).getByRole('button', { name: 'Show the files of ledger-tools' }))
    await waitFor(() => expect(revealPlugin).toHaveBeenCalledWith('folder:a', 'ledger-tools'))
    revealPlugin.mockResolvedValueOnce({ ok: false, code: 'snapshot_missing', message: 'It is not on this computer yet.' } as never)
    fireEvent.click(within(plugin).getByRole('button', { name: 'Show the files of ledger-tools' }))
    expect((await within(plugin).findByRole('alert')).textContent).toBe('It is not on this computer yet.')
  })

  it('says No longer available to you on a plugin its marketplace no longer shows', async () => {
    plugins = [pin({ availability: 'unavailable', availabilityText: 'No longer available to you', mcpServers: [] })]
    renderTab()
    const plugin = await row()
    expect(within(plugin).getByText('No longer available to you')).toBeTruthy()
    expect(plugin.getAttribute('data-plugin-availability')).toBe('unavailable')
    expect(within(plugin).queryByRole('button', { name: /^Update/ })).toBeNull()
  })

  it('offers Update when the marketplace has a newer snapshot, and runs it', async () => {
    plugins = [pin({ availability: 'update_available', availabilityText: 'Update available', latestVersion: '1.1.0', latestSha256: 'def', mcpServers: [] })]
    renderTab()
    const plugin = await row()
    fireEvent.click(within(plugin).getByRole('button', { name: 'Update ledger-tools to version 1.1.0' }))
    await waitFor(() => expect(updatePlugin).toHaveBeenCalledWith('folder:a', 'ledger-tools'))
  })

  it('removes the plugin through the directory after a confirm inside its card', async () => {
    renderTab()
    const plugin = await row()
    fireEvent.click(within(plugin).getByRole('button', { name: 'Remove ledger-tools' }))
    const confirm = within(plugin).getByRole('group', { name: 'Remove ledger-tools' })
    fireEvent.click(within(confirm).getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(removeAddon).toHaveBeenCalledWith('folder:a', { source: 'core-marketplace-plugin', id: 'e-ledger' }))
  })

  it('shows a refused part change inside the plugin’s card', async () => {
    setPluginDisabled.mockResolvedValueOnce({ ok: false, code: 'read_only', message: 'This agent is shared with you to use only.' } as never)
    renderTab()
    const plugin = await row()
    fireEvent.click(within(plugin).getByRole('button', { expanded: false }))
    fireEvent.click(within(plugin).getByRole('switch', { name: 'ledger-howto' }))
    expect((await within(plugin).findByRole('alert')).textContent).toBe('This agent is shared with you to use only.')
  })
})

describe('AgentAddonsTab — manifest connectors', () => {
  const requirementRow = (name: string): Promise<HTMLElement> =>
    waitFor(() => {
      const found = document.querySelector(`[data-mcp-requirement="${name}"]`) as HTMLElement | null
      expect(found).toBeTruthy()
      return found!
    })
  const NEEDS: AddonMcpRequirement = {
    name: 'linear', ref: { source: 'mcp-registry:cinna', id: 'linear' }, transport: 'http', state: 'needs_setup', reason: null,
    mcpProviderId: null, entryRef: { source: 'mcp-registry:cinna', id: 'linear' }
  }

  it('lists a manifest connector that needs setup as a Connector row whose Set up opens the picker at that entry', async () => {
    requirements = [NEEDS, { ...NEEDS, name: 'github', state: 'ready', mcpProviderId: 'p-gh', entryRef: null }, { ...NEEDS, name: 'atlassian', state: 'needs_setup', mcpProviderId: 'jira' }]
    directory.mockResolvedValue({
      ok: true,
      entries: [
        {
          ref: { source: 'mcp-registry:cinna', id: 'linear' }, kind: 'mcp', name: 'linear', title: 'Linear', summary: 'Issues.', description: '',
          category: null, tags: [], iconUrl: null, publisher: null, origin: { label: 'Cinna MCP registry', kind: 'directory', repositoryUrl: null, homepage: null },
          version: null, digest: null, requires: { credentials: [] }, runsCode: false, status: 'ready', unsupportedReason: null, install: null,
          provider: 'mcp-registries', state: 'addable_with_setup', stateReason: 'Needs a sign-in after adding'
        }
      ],
      sources: [],
      policy: { externalDirectories: false, customMcp: false, pluginHooks: true, stdioMcp: true }
    })
    renderTab()
    const req = await requirementRow('linear')
    expect(req.getAttribute('data-addon-row')).toBe('mcp')
    expect(within(req).getByText('Needs setup on this computer')).toBeTruthy()
    // A met requirement is its connector's own row, never listed twice.
    expect(document.querySelector('[data-mcp-requirement="github"]')).toBeNull()
    // Nor is one whose connector is attached already (its own row says what it needs).
    expect(document.querySelector('[data-mcp-requirement="atlassian"]')).toBeNull()
    fireEvent.click(within(req).getByRole('button', { name: 'Set up linear' }))
    const dialog = await screen.findByRole('dialog', { name: 'Addons for Alpha' })
    await waitFor(() => expect(dialog.querySelector('[data-addon-detail="mcp-registry:cinna:linear"]')).toBeTruthy())
    expect(within(dialog.querySelector('[data-addon-detail]') as HTMLElement).getByRole('button', { name: 'Add to Alpha' })).toBeTruthy()
  })

  it('starts the picker’s search with the name when the directory does not list the entry', async () => {
    requirements = [{ ...NEEDS, entryRef: { source: 'mcp-registry:official', id: 'gone' } }]
    renderTab()
    const req = await requirementRow('linear')
    fireEvent.click(within(req).getByRole('button', { name: 'Set up linear' }))
    const dialog = await screen.findByRole('dialog', { name: 'Addons for Alpha' })
    await waitFor(() => expect((within(dialog).getByRole('textbox', { name: 'Search addons' }) as HTMLInputElement).value).toBe('linear'))
  })

  it('says why an unavailable manifest connector cannot be set up, and removes it from the manifest after a confirm', async () => {
    requirements = [{ ...NEEDS, state: 'unavailable', reason: 'No source you may use lists it any more', entryRef: null }]
    renderTab()
    const req = await requirementRow('linear')
    expect(within(req).getByText('No source you may use lists it any more')).toBeTruthy()
    expect(within(req).queryByRole('button', { name: 'Set up linear' })).toBeNull()
    fireEvent.click(within(req).getByRole('button', { name: 'Remove linear from cinna-agent.json' }))
    const confirm = within(req).getByRole('group', { name: 'Remove linear from cinna-agent.json' })
    fireEvent.click(within(confirm).getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(removeRequirement).toHaveBeenCalledWith('folder:a', 'linear'))
  })

  it('shows a refused requirement remove inside its card', async () => {
    requirements = [{ ...NEEDS, state: 'unavailable', reason: 'Gone', entryRef: null }]
    removeRequirement.mockResolvedValueOnce({ ok: false, code: 'read_only', message: 'This agent is shared with you to use only.' } as never)
    renderTab()
    const req = await requirementRow('linear')
    fireEvent.click(within(req).getByRole('button', { name: 'Remove linear from cinna-agent.json' }))
    fireEvent.click(within(within(req).getByRole('group')).getByRole('button', { name: 'Remove' }))
    expect((await within(req).findByRole('alert')).textContent).toBe('This agent is shared with you to use only.')
  })

  it('gives a manifest connector that needs setup main’s reason, and no trash while a directory lists it', async () => {
    requirements = [{ ...NEEDS, reason: 'Needs a sign-in on this computer' }]
    renderTab()
    const req = await requirementRow('linear')
    expect(within(req).getByText('Needs a sign-in on this computer')).toBeTruthy()
    expect(within(req).queryByRole('button', { name: /^Remove linear/ })).toBeNull()
  })

  it('sets a custom manifest connector up at Custom connector…, on its transport’s form with its name filled in', async () => {
    requirements = [{ ...NEEDS, name: 'ledger-local', ref: null, entryRef: null, transport: 'stdio' }]
    directory.mockResolvedValue({ ok: true, entries: [], sources: [], policy: { externalDirectories: false, customMcp: true, pluginHooks: true, stdioMcp: true } })
    renderTab()
    const req = await requirementRow('ledger-local')
    expect(within(req).getByRole('button', { name: 'Remove ledger-local from cinna-agent.json' })).toBeTruthy()
    fireEvent.click(within(req).getByRole('button', { name: 'Set up ledger-local' }))
    const dialog = await screen.findByRole('dialog', { name: 'Addons for Alpha' })
    await waitFor(() => expect(dialog.querySelector('[data-addon-custom]')).toBeTruthy())
    expect(within(dialog).getByDisplayValue('ledger-local')).toBeTruthy()
  })

  it('sends a custom manifest connector to the search when the admin turned custom connectors off', async () => {
    requirements = [{ ...NEEDS, name: 'ledger-local', ref: null, entryRef: null, transport: 'stdio' }]
    renderTab()
    const req = await requirementRow('ledger-local')
    fireEvent.click(within(req).getByRole('button', { name: 'Set up ledger-local' }))
    const dialog = await screen.findByRole('dialog', { name: 'Addons for Alpha' })
    await waitFor(() => expect((within(dialog).getByRole('textbox', { name: 'Search addons' }) as HTMLInputElement).value).toBe('ledger-local'))
    expect(dialog.querySelector('[data-addon-custom]')).toBeNull()
  })

  it('reads the manifest connectors again after a Detach, which drops the connector’s requirement', async () => {
    requirements = []
    renderTab()
    const detachButton = await screen.findByRole('button', { name: 'Detach Atlassian from this agent' })
    await waitFor(() => expect(mcpRequirements).toHaveBeenCalled())
    const reads = mcpRequirements.mock.calls.length
    fireEvent.click(detachButton)
    fireEvent.click(within(screen.getByRole('group', { name: 'Detach Atlassian from this agent' })).getByRole('button', { name: 'Detach' }))
    await waitFor(() => expect(detachMcpProvider).toHaveBeenCalledWith('folder:a', 'jira'))
    await waitFor(() => expect(mcpRequirements.mock.calls.length).toBeGreaterThan(reads))
  })

  it('counts plugins and manifest connectors in the tab badge, the plugin’s need as a problem', async () => {
    requirements = [NEEDS]
    const seen: Array<ReturnType<typeof useAddonsBadge>> = []
    function Probe(): null {
      seen.push(useAddonsBadge('folder:a', []))
      return null
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(createElement(QueryClientProvider, { client }, createElement(Probe)))
    // Atlassian, the plugin and the manifest connector; the managed connector is inside the plugin.
    await waitFor(() => expect(seen[seen.length - 1]).toMatchObject({ count: 3, problems: 2 }))
  })
})
