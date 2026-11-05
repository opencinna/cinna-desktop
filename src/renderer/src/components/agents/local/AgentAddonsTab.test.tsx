import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalAgentDto, LocalAgentSkill } from '../../../../../shared/localAgents'

/**
 * The agent's Addons tab over the real addon picker: one list of connectors
 * and skills in one row shell, attention first; adding from the picker and
 * creating a custom connector both link it to this agent, and Detach only
 * removes the link.
 */

const provider = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, transportType: 'streamable-http', url: `https://${id}.example.com/mcp`, enabled: true,
  hasAuth: false, authType: 'oauth', status: 'connected', tools: [], ...extra
})
let providers = [provider('jira', 'Atlassian'), provider('gh', 'GitHub', { status: 'error', error: 'HTTP 401' })]
let attached: string[] = []
const listMcpProviders = vi.fn(async () => [...attached])
const attachMcpProvider = vi.fn(async (_agent: string, id: string) => { attached = [...attached, id]; return { success: true as const } })
const detachMcpProvider = vi.fn(async (_agent: string, id: string) => { attached = attached.filter((a) => a !== id); return { success: true as const } })
const upsert = vi.fn(async (data: { name: string }) => {
  providers = [...providers, provider('new', data.name, { status: 'awaiting-auth' })]
  return { id: 'new', success: true }
})
const openPath = vi.fn(async (_input: { agentId: string; relPath?: string }) => ({ success: true as const }))
let shareStatuses: unknown[] = []
/** Set to a never-settling promise to hold the share statuses in loading. */
let statusesPending: Promise<never> | null = null
type Outcome = { ok: true; name: string; revisionNumber: number } | { ok: false; code: string; message: string }
const updateSkill = vi.fn<(agentId: string, name: string) => Promise<Outcome>>()
const removeSkill = vi.fn<(agentId: string, name: string) => Promise<Outcome>>()
const makeEditableSkill = vi.fn<(agentId: string, name: string) => Promise<Outcome>>()
type GetOutcome = { ok: true; name: string; revisionNumber: number; version: string | null; backupPath: string | null } | { ok: false; code: string; message: string }
const getLatestSkill = vi.fn<(agentId: string, name: string, replace?: boolean) => Promise<GetOutcome>>()
const ensureSkills = vi.fn<(agentId: string) => Promise<unknown>>()
const updateMarketplaceSkill = vi.fn<(agentId: string, name: string) => Promise<unknown>>()
const removeMarketplaceSkill = vi.fn<(agentId: string, name: string) => Promise<unknown>>()
const ensureMarketplaceSkills = vi.fn<(agentId: string) => Promise<unknown>>()
const marketplaceStatus = vi.fn<(agentId: string) => Promise<unknown>>()
const openExternal = vi.fn()
/** The directory main would answer: this computer's connectors, plus whatever a test sets. */
let extraEntries: unknown[] = []
const localEntry = (p: { id: string; name: string; url: string }) => ({
  ref: { source: 'this-computer', id: p.id }, kind: 'mcp', name: p.name, title: p.name, summary: p.url, description: '',
  category: null, tags: [], iconUrl: null, publisher: null,
  origin: { label: 'On this computer', kind: 'local', repositoryUrl: null, homepage: null },
  version: null, digest: null, requires: { credentials: [] }, runsCode: false, status: 'ready', unsupportedReason: null, install: null,
  state: attached.includes(p.id) ? 'added' : 'addable', stateReason: attached.includes(p.id) ? 'Added to this agent' : null, mcpProviderId: p.id
})
const directory = vi.fn(async () => ({
  ok: true,
  entries: [...providers.map(localEntry), ...extraEntries],
  sources: [{ id: 'cinna-core', label: 'Cinna' }, { id: 'this-computer', label: 'On this computer' }],
  policy: { externalDirectories: false, customMcp: true, pluginHooks: true, stdioMcp: true }
}))
const addAddon = vi.fn(async (agentId: string, ref: { source: string; id: string }) => {
  await attachMcpProvider(agentId, ref.id)
  return { ok: true, next: null, mcpProviderId: ref.id }
})
window.api = {
  addons: { directory, search: async () => ({ ok: true, entries: [], sources: [] }), entry: async () => ({ ok: true, entry: null }), add: addAddon, remove: async () => ({ ok: true, next: null }) },
  system: { openExternal },
  logger: { log: vi.fn() },
  localAgents: { listMcpProviders, attachMcpProvider, detachMcpProvider, openPath },
  mcp: { list: async () => providers, onStatusChanged: () => () => {}, upsert, agentsUsing: async () => [] },
  sharing: { statuses: () => statusesPending ?? Promise.resolve({ success: true, value: shareStatuses }) },
  catalogSkills: { update: updateSkill, remove: removeSkill, ensure: ensureSkills, makeEditable: makeEditableSkill },
  skillPublish: { getLatest: getLatestSkill },
  marketplaceSkills: { update: updateMarketplaceSkill, remove: removeMarketplaceSkill, ensure: ensureMarketplaceSkills, status: marketplaceStatus }
} as never

const { AgentAddonsTab, useAddonsBadge } = await import('./AgentAddonsTab')
const { useAuthStore } = await import('../../../stores/auth.store')

function renderTab(extra: Partial<LocalAgentDto> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const agent = { id: 'folder:a', name: 'Alpha', kind: 'kit', skills: [], ...extra } as unknown as LocalAgentDto
  return { ...render(createElement(QueryClientProvider, { client }, createElement(AgentAddonsTab, { agent }))), client }
}

beforeEach(() => {
  providers = [provider('jira', 'Atlassian'), provider('gh', 'GitHub', { status: 'error', error: 'HTTP 401' })]
  attached = []
  shareStatuses = []
  statusesPending = null
  extraEntries = []
  vi.clearAllMocks()
  useAuthStore.setState({ currentUser: null })
})

describe('AgentAddonsTab', () => {
  it('adds a connector on this computer from the picker, which stays open saying it is ready', async () => {
    renderTab()
    await screen.findByText('No addons yet.')
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    const dialog = await screen.findByRole('dialog', { name: 'Addons for Alpha' })
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Atlassian' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add to Alpha' }))
    await within(dialog).findByText('Ready in the next chat')
    expect(addAddon).toHaveBeenCalledWith('folder:a', { source: 'this-computer', id: 'jira' })
    // Drawn with Settings' card in the addon row shell, which carries the row's Detach.
    await screen.findByRole('button', { name: 'Detach Atlassian from this agent' })
    fireEvent.click(within(dialog.querySelector('[data-addon-detail]') as HTMLElement).getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  const openCustom = async (): Promise<HTMLElement> => {
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    const dialog = await screen.findByRole('dialog', { name: 'Addons for Alpha' })
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Custom connector…' }))
    fireEvent.click(within(dialog).getByRole('button', { name: /Remote server/ }))
    return dialog
  }

  it('attaches a connector created from Custom connector…, then closes on it', async () => {
    // Mutation: drop `onCreated` from AddCustomMcpForm and the new connector
    // lands in Settings → MCP without ever reaching this agent.
    renderTab()
    await screen.findByText('No addons yet.')
    const dialog = await openCustom()
    fireEvent.change(within(dialog).getByPlaceholderText('e.g., My MCP Server'), { target: { value: 'Jira Cloud' } })
    fireEvent.change(within(dialog).getByPlaceholderText('https://mcp.example.com'), { target: { value: 'https://mcp.atlassian.com/v1/sse' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Connect' }))

    await waitFor(() => expect(attachMcpProvider).toHaveBeenCalledWith('folder:a', 'new'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await screen.findByRole('button', { name: 'Detach Jira Cloud from this agent' })
  })

  it('keeps an open form when the user clicks outside the picker or presses Escape', async () => {
    renderTab()
    await screen.findByText('No addons yet.')
    const dialog = await openCustom()
    fireEvent.change(within(dialog).getByPlaceholderText('e.g., My MCP Server'), { target: { value: 'Half typed' } })
    fireEvent.mouseDown(document.body)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect((screen.getByPlaceholderText('e.g., My MCP Server') as HTMLInputElement).value).toBe('Half typed')
    // While the form holds input the header button does nothing either; only the form's own Cancel leaves it.
    const back = within(dialog).getByRole('button', { name: 'Back to addons' }) as HTMLButtonElement
    expect(back.disabled).toBe(true)
    fireEvent.click(back)
    expect((screen.getByPlaceholderText('e.g., My MCP Server') as HTMLInputElement).value).toBe('Half typed')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('dialog', { name: 'Addons for Alpha' })).toBeTruthy()
    expect(screen.queryByPlaceholderText('e.g., My MCP Server')).toBeNull()
  })

  it('still attaches a connector whose create finishes after the picker closed', async () => {
    // TanStack drops mutate-level callbacks of an unmounted form; the attach
    // has to ride the promise. Mutation: go back to `mutate(…, { onSuccess })`
    // in AddCustomMcpForm and this fails.
    let finish!: () => void
    upsert.mockImplementationOnce(async (data: { name: string }) => {
      await new Promise<void>((resolve) => { finish = resolve })
      providers = [...providers, provider('new', data.name, { status: 'awaiting-auth' })]
      return { id: 'new', success: true }
    })
    const view = renderTab()
    await screen.findByText('No addons yet.')
    const dialog = await openCustom()
    fireEvent.change(within(dialog).getByPlaceholderText('e.g., My MCP Server'), { target: { value: 'Slow' } })
    fireEvent.change(within(dialog).getByPlaceholderText('https://mcp.example.com'), { target: { value: 'https://slow.example.com' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(upsert).toHaveBeenCalled())
    view.unmount()
    finish()
    await waitFor(() => expect(attachMcpProvider).toHaveBeenCalledWith('folder:a', 'new'))
  })

  it('lists connectors and skills in one list of one row shell, needing attention first, then by name', async () => {
    attached = ['jira', 'gh']
    const skill = (name: string, extra: Partial<LocalAgentSkill> = {}): LocalAgentSkill => ({
      name, description: '', version: null, source: 'authored', path: `skills/${name}/SKILL.md`, deliverable: true, issues: [], credentials: [], ...extra
    })
    renderTab({
      skills: [
        skill('zeta'),
        skill('broken', { issues: [{ code: 'name_mismatch', message: 'Mismatch.', severity: 'error' }] }),
        skill('beta')
      ]
    })
    await screen.findByRole('button', { name: 'Detach GitHub from this agent' })
    const section = screen.getByRole('heading', { name: 'Addons' }).closest('section')!
    const rows = [...section.querySelectorAll('[data-addon-row]')] as HTMLElement[]
    // GitHub (HTTP 401) and broken need attention; then Atlassian, beta, zeta by name.
    expect(rows.map((row) => row.getAttribute('data-addon-row'))).toEqual(['skill', 'mcp', 'mcp', 'skill', 'skill'])
    expect(rows.map((row) => row.querySelector('span[title]:not([data-addon-kind])')?.textContent)).toEqual(['broken', 'GitHub', 'Atlassian', 'beta', 'zeta'])
    // Each row names its kind in words beside its icon.
    expect(rows.map((row) => row.querySelector('[data-addon-kind]')?.textContent)).toEqual(['Skill', 'Connector', 'Connector', 'Skill', 'Skill'])
    // One section, one Add, no kind chips for a short list.
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['Addons'])
    expect(screen.queryByRole('group', { name: 'Show addons of kind' })).toBeNull()
  })

  it('offers kind chips only once the list is longer than a screen, and filters by them', async () => {
    attached = ['jira']
    const skills = Array.from({ length: 8 }, (_, i): LocalAgentSkill => ({
      name: `skill-${i}`, description: '', version: null, source: 'authored', path: `skills/skill-${i}/SKILL.md`, deliverable: true, issues: [], credentials: []
    }))
    renderTab({ skills })
    await screen.findByRole('button', { name: 'Detach Atlassian from this agent' })
    const chips = screen.getByRole('group', { name: 'Show addons of kind' })
    expect(within(chips).getAllByRole('button').map((b) => b.textContent)).toEqual(['All 9', 'Skills 8', 'Connectors 1'])
    fireEvent.click(within(chips).getByRole('button', { name: /^Connectors/ }))
    expect(document.querySelectorAll('[data-addon-row]')).toHaveLength(1)
    expect(within(chips).getByRole('button', { name: /^Connectors/ }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(within(chips).getByRole('button', { name: /^All/ }))
    expect(document.querySelectorAll('[data-addon-row]')).toHaveLength(9)
  })

  it('detaches without deleting the connector', async () => {
    attached = ['jira']
    renderTab()
    fireEvent.click(await screen.findByRole('button', { name: 'Detach Atlassian from this agent' }))
    // Asks first, inside the card, as a skill's Remove does.
    expect(detachMcpProvider).not.toHaveBeenCalled()
    const confirm = screen.getByRole('group', { name: 'Detach Atlassian from this agent' })
    fireEvent.click(within(confirm).getByRole('button', { name: 'Detach' }))
    await screen.findByText('No addons yet.')
    expect(detachMcpProvider).toHaveBeenCalledWith('folder:a', 'jira')
    expect(providers.map((p) => p.id)).toContain('jira')
  })

  it('shows a failed Detach in that connector’s card', async () => {
    attached = ['jira', 'gh']
    detachMcpProvider.mockRejectedValueOnce(new Error("Error invoking remote method 'local-agent:detach-mcp': Error: The agent folder is busy"))
    renderTab()
    fireEvent.click(await screen.findByRole('button', { name: 'Detach Atlassian from this agent' }))
    fireEvent.click(within(screen.getByRole('group', { name: 'Detach Atlassian from this agent' })).getByRole('button', { name: 'Detach' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('The agent folder is busy')
    expect(alert.closest('[data-mcp-row]')?.getAttribute('data-mcp-row')).toBe('jira')
  })

  it('opens a connector’s form from the keyboard: its title line is a button that says whether it is open', async () => {
    attached = ['jira']
    renderTab()
    await screen.findByRole('button', { name: 'Detach Atlassian from this agent' })
    const header = document.querySelector('[data-mcp-row="jira"] button[aria-expanded]') as HTMLButtonElement
    expect(header.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(header)
    expect(header.getAttribute('aria-expanded')).toBe('true')
  })

  it('keeps a row where it is while the user works it, and sorts again after an add or a remove', async () => {
    attached = ['jira', 'gh']
    const view = renderTab()
    await screen.findByRole('button', { name: 'Detach GitHub from this agent' })
    const order = (): string[] => [...document.querySelectorAll('[data-mcp-row]')].map((row) => row.getAttribute('data-mcp-row') ?? '')
    // GitHub needs attention (HTTP 401), so it leads.
    expect(order()).toEqual(['gh', 'jira'])
    // It connects while the tab is open: it no longer needs attention, and still does not move.
    providers = providers.map((p) => (p.id === 'gh' ? { ...p, status: 'connected', error: undefined } : p))
    await act(async () => {
      await view.client.invalidateQueries({ queryKey: ['mcp-providers'] })
    })
    await waitFor(() => expect(document.querySelector('[data-mcp-row="gh"] [role="img"]')?.getAttribute('aria-label')).toBe('Connected'))
    expect(order()).toEqual(['gh', 'jira'])
    // An add changes what is listed: sorted again, by name now.
    attached = ['jira', 'gh', 'zz']
    providers = [...providers, provider('zz', 'Zulip')]
    await act(async () => {
      await view.client.invalidateQueries({ queryKey: ['agent-mcp'] })
      await view.client.invalidateQueries({ queryKey: ['mcp-providers'] })
    })
    await waitFor(() => expect(order()).toEqual(['jira', 'gh', 'zz']))
  })
})

describe('the Skills section', () => {
  const skill = (name: string, extra: Partial<LocalAgentSkill> = {}): LocalAgentSkill => ({
    name, description: `${name} things.`, version: null, source: 'authored', path: `skills/${name}/SKILL.md`,
    deliverable: true, issues: [], credentials: [], ...extra
  })
  const SKILLS: LocalAgentSkill[] = [
    skill('broken', {
      description: '', deliverable: false,
      issues: [{ code: 'name_mismatch', message: 'The name in SKILL.md does not match the folder name.', severity: 'error' }]
    }),
    skill('leaky', {
      issues: [{ code: 'secrets', message: 'This skill holds files that look like credentials.', severity: 'warning', paths: ['scripts/.env'] }]
    }),
    skill('pdf-tools', { credentials: [{ slot: 'docs.example.com', type: 'api_token', description: null }] })
  ]

  it('lists each skill with its source, its state as a glyph naming the sentence, and its slots', async () => {
    renderTab({ skills: SKILLS })
    await waitFor(() => expect(listMcpProviders).toHaveBeenCalled())
    const section = screen.getByRole('heading', { name: 'Addons' }).closest('section')!
    const items = [...section.querySelector('ul')!.children] as HTMLElement[]
    expect(items.map((item) => within(item).getByTitle(/^(broken|leaky|pdf-tools)$/).textContent)).toEqual(['broken', 'leaky', 'pdf-tools'])
    for (const item of items) expect(within(item).getByText('Authored')).toBeTruthy()

    // Fine: a check, and no issue list.
    const fine = items[2]
    expect(within(fine).getByRole('img', { name: 'Every engine of this agent gets this skill' })).toBeTruthy()
    expect(within(fine).getByText('docs.example.com').tagName).toBe('CODE')
    // One card shell for the tab: the connector card's.
    for (const item of items) expect((item.firstElementChild as HTMLElement).className).toContain('bg-[var(--color-bg-secondary)]')
    expect(within(fine).queryByRole('list')).toBeNull()
    // Broken: the error is the glyph's name and the row's issue line.
    expect(within(items[0]).getByRole('img', { name: 'The name in SKILL.md does not match the folder name.' })).toBeTruthy()
    expect(within(items[0]).getAllByText('The name in SKILL.md does not match the folder name.')).toHaveLength(1)
    // A warning names the files that tripped it.
    expect(within(items[1]).getByRole('img', { name: 'This skill holds files that look like credentials.' })).toBeTruthy()
    expect(within(items[1]).getByText('scripts/.env').tagName).toBe('CODE')
  })

  it('draws a pinned catalog skill in the same row, from the catalog, with its version or revision and no reveal', async () => {
    const pin = (name: string, extra: Partial<LocalAgentSkill>): LocalAgentSkill => skill(name, {
      description: '', source: 'catalog', path: '', deliverable: false,
      issues: [{ code: 'not_downloaded', message: 'Not on this computer yet.', severity: 'warning' }],
      packageId: `io.example.skill.${name}`, packageUuid: '6f1e2d3c-4b5a-4968-8776-655443322110', revisionNumber: 3, ...extra
    })
    renderTab({ skills: [pin('csv-export', { version: '1.2.0' }), pin('pdf-report', {}), skill('pdf-tools')] })
    await waitFor(() => expect(listMcpProviders).toHaveBeenCalled())
    const section = screen.getByRole('heading', { name: 'Addons' }).closest('section')!
    const items = [...section.querySelector('ul')!.children] as HTMLElement[]
    expect(items.map((item) => (item.firstElementChild as HTMLElement).className)).toEqual(
      items.map(() => expect.stringContaining('bg-[var(--color-bg-secondary)]'))
    )
    expect(within(items[0]).getByText('From the catalog')).toBeTruthy()
    expect(within(items[0]).queryByText('Authored')).toBeNull()
    // Labelled as the catalog and the Inbox label versions (rule 13).
    expect(within(items[0]).getByText('Version 3 (1.2.0)')).toBeTruthy()
    expect(within(items[1]).getByText('Version 3')).toBeTruthy()
    expect(within(items[0]).getByRole('img', { name: 'Not on this computer yet.' })).toBeTruthy()
    // No reveal: only the catalog row's own actions.
    await waitFor(() => expect(within(items[0]).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
      'Download csv-export again',
      'Remove csv-export from this agent'
    ]))
    expect(within(items[2]).getByText('Authored')).toBeTruthy()
    expect(within(items[2]).queryByText(/^(Version|Revision) /)).toBeNull()
    expect(within(items[2]).getByRole('button', { name: 'Reveal SKILL.md of pdf-tools' })).toBeTruthy()
  })

  it('reveals a skill’s SKILL.md from its row', async () => {
    renderTab({ skills: SKILLS })
    fireEvent.click(await screen.findByRole('button', { name: 'Reveal SKILL.md of pdf-tools' }))
    await waitFor(() => expect(openPath).toHaveBeenCalledWith({ agentId: 'folder:a', relPath: 'skills/pdf-tools/SKILL.md' }))
  })

  it('says there is none plainly, in the one Addons section a bare agent has too', async () => {
    const view = renderTab()
    expect(await screen.findByText('No addons yet.')).toBeTruthy()
    view.unmount()
    renderTab({ kind: 'bare', skills: undefined })
    await screen.findByText('No addons yet.')
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['Addons'])
  })

  it('counts skills on the tab badge, and a skill with any issue as needing attention', async () => {
    attached = ['gh']
    let badge: ReturnType<typeof useAddonsBadge> | null = null
    function Probe(): null {
      badge = useAddonsBadge('folder:a', SKILLS)
      return null
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(createElement(QueryClientProvider, { client }, createElement(Probe)))
    // One connector in error (gh) plus two skills with issues, of four addons.
    await waitFor(() => expect(badge).toEqual({ count: 4, problems: 3, skills: 3 }))
  })

  it('counts a deliverable skill with an unattached slot as needing attention, not one that is attached or unjudged', async () => {
    attached = []
    const slot = (filled?: boolean) => [{ slot: 'docs.example.com', type: 'api_token', description: null, ...(filled === undefined ? {} : { filled }) }]
    const skills = [
      skill('gap', { credentials: slot(false) }),
      skill('done', { credentials: slot(true) }),
      skill('raw', { credentials: slot() }),
      skill('off', { deliverable: false, credentials: slot(false) })
    ]
    let badge: ReturnType<typeof useAddonsBadge> | null = null
    function Probe(): null {
      badge = useAddonsBadge('folder:a', skills)
      return null
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(createElement(QueryClientProvider, { client }, createElement(Probe)))
    await waitFor(() => expect(badge).toEqual({ count: 4, problems: 1, skills: 4 }))
  })

  it('does not count a catalog pin that is only not downloaded yet as needing attention', async () => {
    attached = []
    const pin = skill('csv-export', {
      description: '', source: 'catalog', path: '', deliverable: false,
      issues: [{ code: 'not_downloaded', message: 'Not on this computer yet.', severity: 'warning' }],
      packageId: 'io.example.skill.csv-export', packageUuid: '6f1e2d3c-4b5a-4968-8776-655443322110', revisionNumber: 3
    })
    let badge: ReturnType<typeof useAddonsBadge> | null = null
    function Probe(): null {
      badge = useAddonsBadge('folder:a', [pin])
      return null
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(createElement(QueryClientProvider, { client }, createElement(Probe)))
    await waitFor(() => expect(badge).toEqual({ count: 1, problems: 0, skills: 1 }))
  })

  it('puts declared slots on their own neutral Needs line, two chips then +N, never on the title line', async () => {
    // A ✓ followed by code reads as a connected credential (rule 13), and a
    // long slot list squeezed the name (rule 7).
    const slots = ['a.example', 'b.example', 'c.example', 'd.example', 'e.example', 'f.example']
    renderTab({
      skills: [skill('many', { credentials: slots.map((slot) => ({ slot, type: 'api_token', description: null })) })]
    })
    const name = await screen.findByTitle('many')
    const titleLine = name.parentElement!
    expect(titleLine.querySelector('code')).toBeNull()
    const line = document.querySelector('[data-skill-slots]') as HTMLElement
    expect(within(line).getByText('Needs')).toBeTruthy()
    expect([...line.querySelectorAll('code')].map((code) => code.textContent)).toEqual(['a.example', 'b.example'])
    expect(within(line).getByText('+4')).toBeTruthy()
    for (const slot of slots) expect(line.title).toContain(slot)
    expect(line.className).not.toMatch(/--color-(success|warning|danger)/)
  })

  it('marks each judged slot attached or not, and offers Finish setup on a deliverable skill with an unattached one', async () => {
    const onFinishSetup = vi.fn()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const agent = {
      id: 'folder:a', kind: 'kit',
      skills: [
        skill('docs', {
          credentials: [
            { slot: 'docs.example.com', type: 'api_token', description: null, filled: true, attachment: { credentialId: 'c1', state: 'ready' } },
            { slot: 'mail.example.com', type: 'api_token', description: null, filled: false, attachment: null }
          ]
        }),
        skill('done', { credentials: [{ slot: 'ok.example.com', type: 'api_token', description: null, filled: true }] }),
        skill('broken', {
          deliverable: false,
          credentials: [{ slot: 'never.example.com', type: 'api_token', description: null, filled: false }]
        })
      ]
    } as unknown as LocalAgentDto
    render(createElement(QueryClientProvider, { client }, createElement(AgentAddonsTab, { agent, onFinishSetup })))
    await waitFor(() => expect(listMcpProviders).toHaveBeenCalled())
    const slotsOf = (name: string): HTMLElement => document.querySelector(`[data-skill-row="${name}"] [data-skill-slots]`) as HTMLElement
    const [docs, done, broken] = [slotsOf('docs'), slotsOf('done'), slotsOf('broken')]
    expect(within(docs).getByRole('img', { name: 'A credential for docs.example.com is attached' })).toBeTruthy()
    expect(within(docs).getByRole('img', { name: 'No credential for mail.example.com is attached yet' }).className).toContain('--color-warning')
    expect(docs.title).toContain('mail.example.com (api_token) · not attached')
    fireEvent.click(within(docs).getByRole('button', { name: 'Finish setup' }))
    expect(onFinishSetup).toHaveBeenCalledTimes(1)
    // All attached, or a skill no session gets (Finish setup does not list it): no way in.
    expect(within(done).queryByRole('button', { name: 'Finish setup' })).toBeNull()
    expect(within(broken).getByRole('img', { name: 'No credential for never.example.com is attached yet' })).toBeTruthy()
    expect(within(broken).queryByRole('button', { name: 'Finish setup' })).toBeNull()
  })

  it('clamps a long description to two lines with the full text on hover', async () => {
    const long = 'x'.repeat(600)
    renderTab({ skills: [skill('wordy', { description: long })] })
    const text = await screen.findByText(long)
    expect(text.className).toContain('line-clamp-2')
    expect(text.title).toBe(long)
  })

  it('shows a failed reveal inside that skill’s card, last', async () => {
    // Rule 6: an error by the control that caused it, not at the tab's foot.
    openPath.mockRejectedValueOnce(new Error('The folder is gone.'))
    renderTab({ skills: [skill('ledger'), skill('pdf-tools')] })
    fireEvent.click(await screen.findByRole('button', { name: 'Reveal SKILL.md of pdf-tools' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('The folder is gone.')
    const card = screen.getByTitle('pdf-tools').closest('li')!.firstElementChild as HTMLElement
    expect(card.lastElementChild).toBe(alert)
    expect(screen.getByTitle('ledger').closest('li')!.contains(alert)).toBe(false)
  })
})

describe('the Skills section — a catalog skill’s actions', () => {
  const pin = (name: string, extra: Partial<LocalAgentSkill> = {}): LocalAgentSkill => ({
    name, description: '', version: null, source: 'catalog', path: '/cache/x/SKILL.md', deliverable: true, issues: [],
    credentials: [], packageId: `io.example.skill.${name}`, packageUuid: '6f1e2d3c-4b5a-4968-8776-655443322110',
    revisionNumber: 2, latestRevision: 2, updatable: false, ...extra
  })
  const row = (name: string): HTMLElement =>
    screen.getAllByTitle(name).map((el) => el.closest('li') as HTMLElement).find(Boolean)!

  it('offers Update when the catalog has a newer version, named with that version, and updates in place', async () => {
    let finish!: (outcome: Outcome) => void
    updateSkill.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    renderTab({ skills: [pin('erp-lookup', { latestRevision: 4, updatable: true }), pin('csv-export')] })
    const button = await screen.findByRole('button', { name: 'Update erp-lookup to Version 4' })
    expect(button.getAttribute('title')).toBe('Update erp-lookup to Version 4')
    // Current: no Update, no Try again — only Remove.
    expect(within(row('csv-export')).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
      'Remove csv-export from this agent'
    ])
    fireEvent.click(button)
    await waitFor(() => expect(updateSkill).toHaveBeenCalledWith('folder:a', 'erp-lookup'))
    // Busy inside the row; the other row waits.
    await waitFor(() => expect((screen.getByRole('button', { name: 'Update erp-lookup to Version 4' }) as HTMLButtonElement).disabled).toBe(true))
    expect((screen.getByRole('button', { name: 'Remove csv-export from this agent' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => finish({ ok: false, code: 'hash_mismatch', message: 'The download did not match the published skill, so nothing was kept.' }))
    // The refusal is that row's last line, in main's sentence.
    const alert = within(row('erp-lookup')).getByRole('alert')
    expect(alert.textContent).toBe('The download did not match the published skill, so nothing was kept.')
    expect(row('erp-lookup').firstElementChild!.lastElementChild).toBe(alert)
    expect(within(row('csv-export')).queryByRole('alert')).toBeNull()
  })

  it('offers Try again when the pinned version is not here, and shows that row’s own failure', async () => {
    ensureSkills.mockResolvedValue({
      ok: true, fetched: [], failed: [{ name: 'erp-lookup', code: 'download_failed', message: 'This version is not available to you.' }]
    })
    renderTab({
      skills: [pin('erp-lookup', { deliverable: false, issues: [{ code: 'download_failed', message: 'It could not be downloaded.', severity: 'warning' }] })]
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Download erp-lookup again' }))
    await waitFor(() => expect(ensureSkills).toHaveBeenCalledWith('folder:a'))
    expect((await within(row('erp-lookup')).findByRole('alert')).textContent).toBe('This version is not available to you.')
  })

  it('offers Check again, not Try again, on a Disconnected pin with no copy here, with the card’s sentence; a 404 adds no error line', async () => {
    const sentence =
      'Disconnected — this skill is no longer in the catalog for you, so this agent can’t download it. Ask a maintainer for access, or remove it.'
    ensureSkills.mockResolvedValue({
      ok: true, fetched: [], failed: [{ name: 'erp-lookup', code: 'download_failed', message: 'This skill is no longer available to you.' }]
    })
    renderTab({
      skills: [pin('erp-lookup', { path: '', deliverable: false, issues: [{ code: 'catalog_disconnected', message: sentence, severity: 'warning' }] })]
    })
    await screen.findByRole('button', { name: 'Remove erp-lookup from this agent' })
    expect(within(row('erp-lookup')).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
      'Check erp-lookup again',
      'Remove erp-lookup from this agent'
    ])
    expect(within(row('erp-lookup')).getByText(sentence)).toBeTruthy()
    // The same fetch as Try again; refused again, the row just stays Disconnected.
    fireEvent.click(screen.getByRole('button', { name: 'Check erp-lookup again' }))
    await waitFor(() => expect(ensureSkills).toHaveBeenCalledWith('folder:a'))
    await waitFor(() => expect((screen.getByRole('button', { name: 'Check erp-lookup again' }) as HTMLButtonElement).disabled).toBe(false))
    expect(within(row('erp-lookup')).queryByRole('alert')).toBeNull()
    expect(within(row('erp-lookup')).getByText(sentence)).toBeTruthy()
  })

  it('offers no Check again on a Disconnected pin whose copy is here: that copy keeps working', async () => {
    renderTab({
      skills: [pin('erp-lookup', { issues: [{ code: 'catalog_disconnected', message: 'Disconnected — a local version.', severity: 'warning' }] })]
    })
    await screen.findByRole('button', { name: 'Remove erp-lookup from this agent' })
    expect(within(row('erp-lookup')).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
      'Remove erp-lookup from this agent'
    ])
  })

  it('removes only after the confirm inside the card, which says what is kept', async () => {
    let finish!: (outcome: Outcome) => void
    removeSkill.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    renderTab({ skills: [pin('erp-lookup')] })
    fireEvent.click(await screen.findByRole('button', { name: 'Remove erp-lookup from this agent' }))
    const confirm = screen.getByRole('group', { name: 'Remove erp-lookup from this agent' })
    expect(row('erp-lookup').contains(confirm)).toBe(true)
    // The recoverable part first, then the consequence; not shared, so nothing about the team.
    expect(confirm.querySelector('p')!.textContent).toBe(
      'Remove erp-lookup from this agent? It stays in the catalog; you can add it again. erp-lookup stops being available to this agent in new chats.'
    )
    // Cancel closes it with nothing done.
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }))
    expect(removeSkill).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Remove erp-lookup from this agent' }))
    fireEvent.click(within(confirm).getByRole('button', { name: 'Remove skill' }))
    await waitFor(() => expect(removeSkill).toHaveBeenCalledWith('folder:a', 'erp-lookup'))
    // Undismissable while it runs.
    expect((within(confirm).getByRole('button', { name: 'Removing…' }) as HTMLButtonElement).disabled).toBe(true)
    expect((within(confirm).getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => finish({ ok: false, code: 'manifest_modified', message: 'cinna-agent.json changed while the skill was downloading. Try again.' }))
    // A refusal keeps the confirm open and says why, last in the card.
    expect(within(confirm).getByRole('button', { name: 'Remove skill' })).toBeTruthy()
    expect(within(row('erp-lookup')).getByRole('alert').textContent).toBe('cinna-agent.json changed while the skill was downloading. Try again.')
  })

  it('hides Update and Remove on an agent shared with the user to use only', async () => {
    shareStatuses = [{ agentId: 'folder:a', remote: { kind: 'cinna', access: 'use' } }]
    renderTab({
      skills: [pin('erp-lookup', { latestRevision: 4, updatable: true, issues: [{ code: 'not_downloaded', message: 'Not on this computer yet.', severity: 'warning' }] })]
    })
    // Fetching what the team's version pins is still theirs (U7).
    await screen.findByRole('button', { name: 'Download erp-lookup again' })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove erp-lookup from this agent' })).toBeNull())
    expect(screen.queryByRole('button', { name: 'Update erp-lookup to Version 4' })).toBeNull()
  })

  it('names a catalog row by its catalog title, with the folder name in its tooltip, everywhere on the row', async () => {
    renderTab({ skills: [pin('erp-lookup', { title: 'ERP lookup', latestRevision: 4, latestVersion: '2.0', updatable: true })] })
    const name = await screen.findByText('ERP lookup')
    expect(name.getAttribute('title')).toBe('ERP lookup — erp-lookup')
    expect(await screen.findByRole('button', { name: 'Update ERP lookup to Version 4 (2.0)' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Remove ERP lookup from this agent' }))
    expect(screen.getByRole('group', { name: 'Remove ERP lookup from this agent' }).querySelector('p')!.textContent).toContain(
      'ERP lookup stops being available to this agent in new chats.'
    )
  })

  it('on a shared agent the user can edit, the confirm says a Remove reaches the team only once shared', async () => {
    shareStatuses = [{ agentId: 'folder:a', remote: { kind: 'cinna', access: 'edit' } }]
    renderTab({ skills: [pin('erp-lookup')] })
    fireEvent.click(await screen.findByRole('button', { name: 'Remove erp-lookup from this agent' }))
    expect(screen.getByRole('group', { name: 'Remove erp-lookup from this agent' }).querySelector('p')!.textContent).toMatch(
      /in new chats\. Share changes to pass this on to the team\.$/
    )
  })

  it('offers no Update or Remove while the share status is still loading', async () => {
    statusesPending = new Promise<never>(() => undefined)
    renderTab({ skills: [pin('erp-lookup', { latestRevision: 4, updatable: true })] })
    await screen.findByText('erp-lookup')
    expect(screen.queryByRole('button', { name: 'Remove erp-lookup from this agent' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Update erp-lookup to Version 4' })).toBeNull()
  })

  it('offers no Update or Remove on a Cinna team agent whose access the listing does not know', async () => {
    shareStatuses = [{ agentId: 'folder:a', remote: { kind: 'cinna', access: null } }]
    renderTab({ skills: [pin('erp-lookup', { latestRevision: 4, updatable: true })] })
    await screen.findByText('erp-lookup')
    // Settled, and still not offered.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.queryByRole('button', { name: 'Remove erp-lookup from this agent' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Update erp-lookup to Version 4' })).toBeNull()
  })

  it('Try again whose failure is the sentence already on the row says it once', async () => {
    const sentence = 'This version is not available to you.'
    ensureSkills.mockResolvedValue({ ok: true, fetched: [], failed: [{ name: 'erp-lookup', code: 'download_failed', message: sentence }] })
    renderTab({ skills: [pin('erp-lookup', { deliverable: false, issues: [{ code: 'download_failed', message: sentence, severity: 'warning' }] })] })
    fireEvent.click(await screen.findByRole('button', { name: 'Download erp-lookup again' }))
    await waitFor(() => expect(ensureSkills).toHaveBeenCalled())
    await waitFor(() => expect((screen.getByRole('button', { name: 'Download erp-lookup again' }) as HTMLButtonElement).disabled).toBe(false))
    expect(within(row('erp-lookup')).queryByRole('alert')).toBeNull()
    expect(within(row('erp-lookup')).getAllByText(sentence)).toHaveLength(1)
  })

  it('offers Who can use on an own shared skill only to a maintainer of its package, and opens its People', async () => {
    const api = window.api as unknown as { sharing: Record<string, unknown>; catalog?: unknown }
    api.sharing.itemPeople = vi.fn(async () => ({ success: true, value: { visible: true, people: [], selfUserId: null } }))
    api.catalog = { items: vi.fn(async () => ({ success: true, value: null })) }
    const shared = (access: 'use' | 'edit' | 'maintain' | null) => ({ packageUuid: 'pkg-1', packageId: 'test.erp', revisionNumber: 2, access })
    const skill = (name: string, extra: Partial<LocalAgentSkill>): LocalAgentSkill =>
      pin(name, { source: 'authored', path: `skills/${name}/SKILL.md`, packageId: undefined, packageUuid: undefined, ...extra })
    renderTab({
      skills: [
        skill('erp-lookup', { shared: shared('maintain'), shareable: true }),
        skill('csv-tools', { shared: shared('edit'), shareable: true }),
        skill('pdf-tools', { shared: null, shareable: true })
      ]
    })
    await waitFor(() => expect(listMcpProviders).toHaveBeenCalled())
    expect(within(row('csv-tools')).queryByRole('button', { name: 'Who can use csv-tools…' })).toBeNull()
    expect(within(row('pdf-tools')).queryByRole('button', { name: 'Who can use pdf-tools…' })).toBeNull()
    fireEvent.click(within(row('erp-lookup')).getByRole('button', { name: 'Who can use erp-lookup…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Who can use erp-lookup' })
    await within(dialog).findByText('No one else has access yet.')
    expect(api.sharing.itemPeople).toHaveBeenCalledWith('pkg-1')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('offers Who can use on a catalog pin only to a maintainer of its package, whatever the agent’s access, and opens its People', async () => {
    const api = window.api as unknown as { sharing: Record<string, unknown>; catalog?: unknown }
    api.sharing.itemPeople = vi.fn(async () => ({ success: true, value: { visible: true, people: [], selfUserId: null } }))
    api.catalog = { items: vi.fn(async () => ({ success: true, value: null })) }
    // A team agent shared to use only: the pin's verbs are not offered, Who can use (about the package) is.
    shareStatuses = [{ agentId: 'folder:a', remote: { kind: 'cinna', access: 'use' } }]
    renderTab({
      skills: [
        pin('erp-lookup', { title: 'ERP lookup', access: 'maintain' }),
        pin('csv-tools', { access: 'edit', packageUuid: '7f1e2d3c-4b5a-4968-8776-655443322110' }),
        pin('pdf-tools', { access: null, packageUuid: '8f1e2d3c-4b5a-4968-8776-655443322110' })
      ]
    })
    await waitFor(() => expect(listMcpProviders).toHaveBeenCalled())
    const who = await within((document.querySelector('[data-skill-row="erp-lookup"]')!.closest('li') as HTMLElement)).findByRole('button', { name: 'Who can use ERP lookup…' })
    expect(who.getAttribute('title')).toBe('Who can use ERP lookup…')
    expect(within(row('csv-tools')).queryByRole('button', { name: 'Who can use csv-tools…' })).toBeNull()
    expect(within(row('pdf-tools')).queryByRole('button', { name: 'Who can use pdf-tools…' })).toBeNull()
    fireEvent.click(who)
    const dialog = await screen.findByRole('dialog', { name: 'Who can use ERP lookup' })
    await within(dialog).findByText('No one else has access yet.')
    expect(api.sharing.itemPeople).toHaveBeenCalledWith('6f1e2d3c-4b5a-4968-8776-655443322110')
  })

  it('offers Edit on a catalog pin the person may edit or maintain, only on an agent they may change', async () => {
    renderTab({
      skills: [
        pin('erp-lookup', { access: 'edit' }),
        pin('csv-tools', { access: 'maintain' }),
        pin('pdf-tools', { access: 'use' }),
        pin('xls-tools', { access: null })
      ]
    })
    await screen.findByRole('button', { name: 'Make erp-lookup editable…' })
    expect(within(row('erp-lookup')).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
      'Make erp-lookup editable…',
      'Remove erp-lookup from this agent'
    ])
    expect(within(row('csv-tools')).getByRole('button', { name: 'Make csv-tools editable…' })).toBeTruthy()
    expect(within(row('pdf-tools')).queryByRole('button', { name: 'Make pdf-tools editable…' })).toBeNull()
    expect(within(row('xls-tools')).queryByRole('button', { name: 'Make xls-tools editable…' })).toBeNull()
  })

  it('offers no Edit on an agent shared with the user to use only, nor while its access is loading', async () => {
    shareStatuses = [{ agentId: 'folder:a', remote: { kind: 'cinna', access: 'use' } }]
    renderTab({ skills: [pin('erp-lookup', { access: 'maintain' })] })
    await screen.findByRole('button', { name: 'Who can use erp-lookup…' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.queryByRole('button', { name: 'Make erp-lookup editable…' })).toBeNull()
  })

  it('makes a pin editable only after the confirm inside the card, one confirm at a time, and shows a refusal last', async () => {
    let finish!: (outcome: Outcome) => void
    makeEditableSkill.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    renderTab({ skills: [pin('erp-lookup', { title: 'ERP lookup', access: 'edit', latestRevision: 3, latestVersion: '1.2.0', updatable: true })] })
    // Remove's confirm open first; asking Edit swaps it for Edit's, never both.
    fireEvent.click(await screen.findByRole('button', { name: 'Remove ERP lookup from this agent' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Make ERP lookup editable…' }))
    const confirm = screen.getByRole('group', { name: 'Make ERP lookup editable…' })
    expect((document.querySelector('[data-skill-row="erp-lookup"]')!.closest('li') as HTMLElement).contains(confirm)).toBe(true)
    expect(confirm.querySelector('p')!.textContent).toBe(
      'Make ERP lookup editable in this agent? Its files move into skills/erp-lookup/ as Version 3 (1.2.0), linked to the catalog skill, and Publish sends your changes as its next version. Catalog updates stop; newer versions show here to get when you choose.'
    )
    // While it is open the row's other verbs wait.
    expect((screen.getByRole('button', { name: 'Remove ERP lookup from this agent' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Update ERP lookup to Version 3 (1.2.0)' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }))
    expect(makeEditableSkill).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Make ERP lookup editable…' }))
    fireEvent.click(within(confirm).getByRole('button', { name: 'Make editable' }))
    await waitFor(() => expect(makeEditableSkill).toHaveBeenCalledWith('folder:a', 'erp-lookup'))
    expect((within(confirm).getByRole('button', { name: 'Making editable…' }) as HTMLButtonElement).disabled).toBe(true)
    expect((within(confirm).getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => finish({ ok: false, code: 'folder_exists', message: 'Rename or remove skills/erp-lookup/ first.' }))
    expect(within(confirm).getByRole('button', { name: 'Make editable' })).toBeTruthy()
    const alert = within((document.querySelector('[data-skill-row="erp-lookup"]')!.closest('li') as HTMLElement)).getByRole('alert')
    expect(alert.textContent).toBe('Rename or remove skills/erp-lookup/ first.')
    expect((document.querySelector('[data-skill-row="erp-lookup"]')!.closest('li') as HTMLElement).firstElementChild!.lastElementChild).toBe(alert)
  })

  it('closes the Edit confirm and re-reads the agent once the pin is a linked copy', async () => {
    makeEditableSkill.mockResolvedValue({ ok: true, name: 'erp-lookup', revisionNumber: 2 })
    const { client } = renderTab({ skills: [pin('erp-lookup', { access: 'maintain' })] })
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    fireEvent.click(await screen.findByRole('button', { name: 'Make erp-lookup editable…' }))
    fireEvent.click(within(screen.getByRole('group', { name: 'Make erp-lookup editable…' })).getByRole('button', { name: 'Make editable' }))
    await waitFor(() => expect(makeEditableSkill).toHaveBeenCalledWith('folder:a', 'erp-lookup'))
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['local-agents'] }))
    expect(within(row('erp-lookup')).queryByRole('alert')).toBeNull()
  })

  it('puts Who can use in one place on pin and own rows: after Publish / Make editable, before Reveal / Remove', async () => {
    renderTab({
      skills: [
        pin('erp-lookup', { access: 'maintain' }),
        pin('own-one', {
          source: 'authored',
          path: 'skills/own-one/SKILL.md',
          packageId: undefined,
          packageUuid: undefined,
          shareable: true,
          shared: { packageUuid: 'pkg-2', packageId: 'test.own', revisionNumber: 1, access: 'maintain' }
        })
      ]
    })
    await screen.findByRole('button', { name: 'Make erp-lookup editable…' })
    expect(within(row('erp-lookup')).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
      'Make erp-lookup editable…',
      'Who can use erp-lookup…',
      'Remove erp-lookup from this agent'
    ])
    expect(within(row('own-one')).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
      'Publish a new version of own-one…',
      'Who can use own-one…',
      'Reveal SKILL.md of own-one'
    ])
  })

  it('names the version the copy will be in the Edit confirm when the pin is already at the latest', async () => {
    renderTab({ skills: [pin('erp-lookup', { access: 'edit', revisionNumber: 2, version: '1.1.0', latestRevision: 2, updatable: false })] })
    fireEvent.click(await screen.findByRole('button', { name: 'Make erp-lookup editable…' }))
    expect(screen.getByRole('group', { name: 'Make erp-lookup editable…' }).querySelector('p')!.textContent).toBe(
      'Make erp-lookup editable in this agent? Its files move into skills/erp-lookup/ as Version 2 (1.1.0), linked to the catalog skill, and Publish sends your changes as its next version. Catalog updates stop; newer versions show here to get when you choose.'
    )
  })

  it('offers no Edit or Who can use on a marketplace pin, whatever it carries', async () => {
    marketplaceStatus.mockResolvedValue({ ok: true, pins: [] })
    renderTab({
      skills: [
        pin('pdf-report', {
          source: 'marketplace', access: 'maintain', entryUuid: '3c9a7e21-5b4d-4f60-8e12-7a9b0c1d2e3f', marketplaceUuid: 'm',
          marketplaceName: 'Team skills', archiveSha256: 'd'.repeat(64), commitHash: null
        } as Partial<LocalAgentSkill>)
      ]
    })
    await screen.findByRole('button', { name: 'Remove pdf-report from this agent' })
    expect(within(row('pdf-report')).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
      'Remove pdf-report from this agent'
    ])
  })

  it('offers Add on every agent; on a team agent shared to use only the picker says why no skill can be added', async () => {
    extraEntries = [{
      ref: { source: 'core-catalog', id: 'pkg-csv' }, kind: 'skill', name: 'csv', title: 'CSV tools', summary: 'Reads CSV.', description: '',
      category: null, tags: [], iconUrl: null, publisher: null, origin: { label: 'Catalog', kind: 'catalog', repositoryUrl: null, homepage: null },
      version: '1.0.0', digest: null, requires: { credentials: [] }, runsCode: null, status: 'ready', unsupportedReason: null, install: null,
      state: 'addable', stateReason: null
    }]
    shareStatuses = [{ agentId: 'folder:a', remote: { kind: 'cinna', access: 'use' } }]
    useAuthStore.setState({ currentUser: { id: 'p1', type: 'cinna_user', username: 'u', displayName: 'U', hasPassword: false } as never })
    renderTab()
    const add = (await screen.findByRole('button', { name: 'Add' })) as HTMLButtonElement
    expect(add.disabled).toBe(false)
    fireEvent.click(add)
    const dialog = await screen.findByRole('dialog', { name: 'Addons for Alpha' })
    const tile = await within(dialog).findByRole('button', { name: 'CSV tools' })
    await waitFor(() => expect(tile.querySelector('[data-addon-state-line]')?.textContent).toBe('Its skills come with the team’s version'))
    fireEvent.click(tile)
    expect((within(dialog).getByRole('button', { name: 'Add to Alpha' }) as HTMLButtonElement).disabled).toBe(true)
    // A connector is local, and stays addable.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Back' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Atlassian' }))
    expect((within(dialog).getByRole('button', { name: 'Add to Alpha' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('offers Add on a bare agent too: its connectors work, and a skill says it needs a cinna-agent.json', async () => {
    extraEntries = [{
      ref: { source: 'core-catalog', id: 'pkg-csv' }, kind: 'skill', name: 'csv', title: 'CSV tools', summary: '', description: '',
      category: null, tags: [], iconUrl: null, publisher: null, origin: { label: 'Catalog', kind: 'catalog', repositoryUrl: null, homepage: null },
      version: null, digest: null, requires: { credentials: [] }, runsCode: null, status: 'ready', unsupportedReason: null, install: null,
      state: 'blocked', stateReason: 'Needs a cinna-agent.json'
    }]
    renderTab({ skills: undefined, kind: 'bare' } as never)
    await screen.findByText('No addons yet.')
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    const dialog = await screen.findByRole('dialog', { name: 'Addons for Alpha' })
    fireEvent.click(await within(dialog).findByRole('button', { name: 'CSV tools' }))
    expect((within(dialog).getByRole('button', { name: 'Add to Alpha' }) as HTMLButtonElement).disabled).toBe(true)
    const detail = within(dialog.querySelector('[data-addon-detail]') as HTMLElement)
    expect(detail.getByText('Needs a cinna-agent.json')).toBeTruthy()
    expect(detail.getByText(/skills are pinned there, and this agent is a plain folder/)).toBeTruthy()
  })
})

describe('the Skills section — a marketplace skill', () => {
  const ENTRY = '3c9a7e21-5b4d-4f60-8e12-7a9b0c1d2e3f'
  const mpin = (name: string, extra: Partial<LocalAgentSkill> = {}): LocalAgentSkill => ({
    name, description: `${name} things.`, version: '0.3.1', source: 'marketplace', path: `/cache/m/${name}/SKILL.md`, deliverable: true,
    issues: [], credentials: [], entryUuid: ENTRY, marketplaceUuid: 'm-team', marketplaceName: 'Team skills',
    archiveSha256: 'd'.repeat(64), commitHash: null, ...extra
  })
  const row = (name: string): HTMLElement => document.querySelector(`[data-skill-row="${name}"]`) as HTMLElement
  const status = (state: string, extra: Record<string, unknown> = {}) =>
    marketplaceStatus.mockResolvedValue({ ok: true, pins: [{ name: 'pdf-report', entryUuid: ENTRY, state, ...extra }] })

  it('is the same row as a catalog pin, from its marketplace, with its version and no reveal', async () => {
    status('current')
    renderTab({ skills: [mpin('pdf-report')] })
    await waitFor(() => expect(row('pdf-report').getAttribute('data-marketplace-skill-state')).toBe('current'))
    const card = within(row('pdf-report'))
    expect(card.getByText('From Team skills')).toBeTruthy()
    expect(card.getByText('Version 0.3.1')).toBeTruthy()
    expect(row('pdf-report').getAttribute('data-marketplace-skill')).toBe(ENTRY)
    expect(card.getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Remove pdf-report from this agent'])
    expect(marketplaceStatus).toHaveBeenCalledWith('folder:a')
  })

  it('links the source of a pin whose entry names one, as a row icon', async () => {
    status('current', { repositoryUrl: 'https://github.com/example/skills' })
    renderTab({ skills: [mpin('pdf-report')] })
    const source = await within(row('pdf-report')).findByRole('button', { name: 'Open the source of pdf-report' })
    expect(source.getAttribute('title')).toBe('Open the source repository')
    fireEvent.click(source)
    expect(openExternal).toHaveBeenCalledWith('https://github.com/example/skills')
  })

  it('reads where the pins stand again each time the tab mounts, and when the window regains focus', async () => {
    status('current')
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const agent = { id: 'folder:a', kind: 'kit', skills: [mpin('pdf-report')] } as unknown as LocalAgentDto
    const tree = createElement(QueryClientProvider, { client }, createElement(AgentAddonsTab, { agent }))
    const first = render(tree)
    await waitFor(() => expect(marketplaceStatus).toHaveBeenCalledTimes(1))
    first.unmount()
    // Back to the agent well within the minute the status counts as fresh.
    status('update_available', { latestSha256: 'e'.repeat(64), latestVersion: '0.4.0' })
    render(tree)
    await waitFor(() => expect(marketplaceStatus).toHaveBeenCalledTimes(2))
    await screen.findByRole('button', { name: 'Update pdf-report to version 0.4.0' })
    act(() => {
      focusManager.setFocused(false)
      focusManager.setFocused(true)
    })
    await waitFor(() => expect(marketplaceStatus).toHaveBeenCalledTimes(3))
    focusManager.setFocused(undefined)
  })

  it('asks for no status on an agent with no marketplace pin', async () => {
    renderTab({ skills: [] })
    await screen.findByText('No addons yet.')
    expect(marketplaceStatus).not.toHaveBeenCalled()
  })

  it('offers Update when the marketplace has a newer copy, named with its version, and runs the marketplace verb', async () => {
    status('update_available', { latestSha256: 'e'.repeat(64), latestVersion: '0.4.0' })
    updateMarketplaceSkill.mockResolvedValue({ ok: true, name: 'pdf-report', archiveSha256: 'e'.repeat(64) })
    renderTab({ skills: [mpin('pdf-report')] })
    fireEvent.click(await screen.findByRole('button', { name: 'Update pdf-report to version 0.4.0' }))
    await waitFor(() => expect(updateMarketplaceSkill).toHaveBeenCalledWith('folder:a', 'pdf-report'))
    expect(updateSkill).not.toHaveBeenCalled()
    // Read again once the update is in.
    await waitFor(() => expect(marketplaceStatus.mock.calls.length).toBeGreaterThan(1))
  })

  it('offers no Update on an agent shared with the user to use only', async () => {
    shareStatuses = [{ agentId: 'folder:a', remote: { kind: 'cinna', access: 'use' } }]
    status('update_available', { latestSha256: 'e'.repeat(64), latestVersion: '0.4.0' })
    renderTab({ skills: [mpin('pdf-report')] })
    await waitFor(() => expect(row('pdf-report').getAttribute('data-marketplace-skill-state')).toBe('update_available'))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove pdf-report from this agent' })).toBeNull())
    expect(screen.queryByRole('button', { name: /^Update pdf-report/ })).toBeNull()
  })

  it('says a pin no longer available is so, as a warning, still delivered and still removable', async () => {
    status('unavailable')
    renderTab({ skills: [mpin('pdf-report')] })
    const line = await within(row('pdf-report')).findByText('No longer available to you')
    expect(line.className).toContain('--color-warning')
    expect(within(row('pdf-report')).getByRole('button', { name: 'Remove pdf-report from this agent' })).toBeTruthy()
    expect(within(row('pdf-report')).queryByRole('button', { name: /^Update/ })).toBeNull()
  })

  it('offers Try again when the snapshot is not here, through the marketplace verb', async () => {
    marketplaceStatus.mockResolvedValue({ ok: true, pins: [] })
    ensureMarketplaceSkills.mockResolvedValue({ ok: true, fetched: [], failed: [{ name: 'pdf-report', code: 'snapshot_missing', message: 'The server no longer keeps this version of the skill.' }] })
    renderTab({ skills: [mpin('pdf-report', { path: '', deliverable: false, issues: [{ code: 'not_downloaded', message: 'Not on this computer yet.', severity: 'warning' }] })] })
    fireEvent.click(await screen.findByRole('button', { name: 'Download pdf-report again' }))
    await waitFor(() => expect(ensureMarketplaceSkills).toHaveBeenCalledWith('folder:a'))
    expect(ensureSkills).not.toHaveBeenCalled()
    expect((await within(row('pdf-report')).findByRole('alert')).textContent).toBe('The server no longer keeps this version of the skill.')
  })

  it('removes after the confirm, which says it stays in its marketplace', async () => {
    status('current')
    removeMarketplaceSkill.mockResolvedValue({ ok: true, name: 'pdf-report', archiveSha256: 'd'.repeat(64) })
    renderTab({ skills: [mpin('pdf-report')] })
    fireEvent.click(await screen.findByRole('button', { name: 'Remove pdf-report from this agent' }))
    const confirm = screen.getByRole('group', { name: 'Remove pdf-report from this agent' })
    expect(confirm.querySelector('p')!.textContent).toBe(
      'Remove pdf-report from this agent? It stays in its marketplace; you can add it again. pdf-report stops being available to this agent in new chats.'
    )
    fireEvent.click(within(confirm).getByRole('button', { name: 'Remove skill' }))
    await waitFor(() => expect(removeMarketplaceSkill).toHaveBeenCalledWith('folder:a', 'pdf-report'))
    expect(removeSkill).not.toHaveBeenCalled()
  })
})

describe('the Skills section — an own skill linked to a newer catalog version (co-maintainers D3)', () => {
  const linked = (name: string, extra: Partial<LocalAgentSkill> = {}): LocalAgentSkill => ({
    name, description: `${name} things.`, version: null, source: 'authored', path: `skills/${name}/SKILL.md`,
    deliverable: true, issues: [], credentials: [], shareable: true,
    shared: { packageUuid: '6f1e2d3c-4b5a-4968-8776-655443322110', packageId: `io.example.skill.${name}`, revisionNumber: 1, access: 'edit' },
    latest: { revisionNumber: 2, version: '1.0.1', publishedBy: 'Ann' },
    ...extra
  })
  const card = (name: string): HTMLElement => (document.querySelector(`[data-skill-row="${name}"]`) as HTMLElement).closest('li') as HTMLElement
  const labels = (name: string): (string | null)[] => within(card(name)).getAllByRole('button').map((b) => b.getAttribute('aria-label'))

  it('says which version is available and who shared it in Get’s and Replace’s names, with no line; nothing on changed', async () => {
    renderTab({
      skills: [
        linked('behind-one', { sync: 'behind' }),
        linked('diverged-one', { sync: 'diverged', latest: { revisionNumber: 3, version: null, publishedBy: null } }),
        linked('changed-one', { sync: 'changed' }),
        linked('in-sync', { sync: 'in_sync' })
      ]
    })
    const get = await screen.findByRole('button', { name: 'Get Version 2 of behind-one — shared by Ann' })
    expect(get.getAttribute('title')).toBe('Get Version 2 of behind-one — shared by Ann')
    expect(labels('behind-one')[0]).toBe('Get Version 2 of behind-one — shared by Ann')
    // The icon's name carries the fact: no muted line under the title.
    expect(within(card('behind-one')).queryByText(/available/)).toBeNull()

    // Who shared it unknown: the name stops at the version.
    expect(labels('diverged-one')[0]).toBe('Replace diverged-one with Version 3…')
    expect(within(card('diverged-one')).getByRole('button', { name: 'Replace diverged-one with Version 3…' }).getAttribute('title')).toBe(
      'Replace diverged-one with Version 3…'
    )
    expect(within(card('diverged-one')).queryByText(/available/)).toBeNull()
    expect(within(card('diverged-one')).queryByRole('button', { name: /^Get Version/ })).toBeNull()

    for (const name of ['changed-one', 'in-sync']) {
      expect(labels(name).some((label) => /^(Get|Replace)/.test(label ?? ''))).toBe(false)
    }
  })

  it('gets the newer version in place, spinning, with the other rows’ verbs locked, and shows a refusal last', async () => {
    let finish!: (outcome: GetOutcome) => void
    getLatestSkill.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    renderTab({
      skills: [
        linked('erp-lookup', { sync: 'behind' }),
        { name: 'csv', description: '', version: null, source: 'catalog', path: '/cache/x/SKILL.md', deliverable: true, issues: [], credentials: [], packageUuid: '7f1e2d3c-4b5a-4968-8776-655443322110', revisionNumber: 1, latestRevision: 1, updatable: false }
      ]
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Get Version 2 of erp-lookup — shared by Ann' }))
    await waitFor(() => expect(getLatestSkill).toHaveBeenCalledWith('folder:a', 'erp-lookup', false))
    expect((screen.getByRole('button', { name: 'Get Version 2 of erp-lookup — shared by Ann' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Get Version 2 of erp-lookup — shared by Ann' }).querySelector('.animate-spin')).not.toBeNull()
    expect((screen.getByRole('button', { name: 'Remove csv from this agent' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => finish({ ok: false, code: 'download_failed', message: 'The newer version couldn’t be downloaded. Nothing was changed.' }))
    const alert = within(card('erp-lookup')).getByRole('alert')
    expect(alert.textContent).toBe('The newer version couldn’t be downloaded. Nothing was changed.')
    expect(card('erp-lookup').firstElementChild!.lastElementChild).toBe(alert)
    expect((screen.getByRole('button', { name: 'Remove csv from this agent' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('replaces only after the confirm inside the card, which names the backup, and closes it on success', async () => {
    getLatestSkill.mockResolvedValue({ ok: true, name: 'erp-lookup', revisionNumber: 3, version: null, backupPath: '/u/skill-backups/a/erp-lookup-x' })
    const { client } = renderTab({ skills: [linked('erp-lookup', { sync: 'diverged', latest: { revisionNumber: 3, version: null, publishedBy: 'Ann' } })] })
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    fireEvent.click(await screen.findByRole('button', { name: 'Replace erp-lookup with Version 3… — shared by Ann' }))
    expect(getLatestSkill).not.toHaveBeenCalled()
    const confirm = screen.getByRole('group', { name: 'Replace erp-lookup with Version 3…' })
    expect(card('erp-lookup').contains(confirm)).toBe(true)
    expect(confirm.querySelector('p')!.textContent).toBe(
      'Replace erp-lookup with Version 3? Your changes that were never published are moved to a backup folder outside this agent, and the skill’s files become Version 3.'
    )
    // While it is open the row's verbs wait.
    expect((screen.getByRole('button', { name: 'Replace erp-lookup with Version 3… — shared by Ann' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Publish a new version of erp-lookup…' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }))
    expect(getLatestSkill).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Replace erp-lookup with Version 3… — shared by Ann' }))
    fireEvent.click(within(confirm).getByRole('button', { name: 'Replace' }))
    await waitFor(() => expect(getLatestSkill).toHaveBeenCalledWith('folder:a', 'erp-lookup', true))
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['local-agents'] }))
    await waitFor(() => expect((screen.getByRole('button', { name: 'Replace erp-lookup with Version 3… — shared by Ann' }) as HTMLButtonElement).disabled).toBe(false))
    expect(within(card('erp-lookup')).queryByRole('alert')).toBeNull()
  })

  it('offers no Get or Replace, and no line, on an agent shared with the user to use only', async () => {
    shareStatuses = [{ agentId: 'folder:a', remote: { kind: 'cinna', access: 'use' } }]
    renderTab({ skills: [linked('erp-lookup', { sync: 'behind', shareable: false }), linked('csv', { sync: 'diverged', shareable: false })] })
    await waitFor(() => expect(document.querySelector('[data-skill-row="erp-lookup"]')).not.toBeNull())
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(within(card('erp-lookup')).queryByText(/available/)).toBeNull()
    expect(screen.queryByRole('button', { name: /^Get Version/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Replace/ })).toBeNull()
  })
})
