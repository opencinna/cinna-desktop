import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddonDirectoryResult, AgentDirectoryEntry } from '../../../../../shared/addons/directory'

/**
 * The one Add picker over the addon directory: filtered locally per
 * keystroke (search, kind chips, source select), an entry's detail over the
 * list with Back keeping everything, Add with its next step in place, a
 * refusal inline, a blocked entry with its reason, a failed source said once
 * and quietly, and the public MCP registry below the results after a debounce.
 */

window.api = {} as never
const { AddonPicker, REGISTRY_DEBOUNCE_MS, EARLIER_REFUSAL_MS, addFlowOf } = await import('./AddonPicker')

function entry(over: Partial<AgentDirectoryEntry> & Pick<AgentDirectoryEntry, 'ref' | 'kind' | 'title'>): AgentDirectoryEntry {
  return {
    name: over.title.toLowerCase(),
    summary: `${over.title} in one line.`,
    description: '',
    category: null,
    tags: [],
    iconUrl: null,
    publisher: null,
    origin: { label: 'Catalog', kind: 'catalog', repositoryUrl: null, homepage: null },
    version: null,
    digest: null,
    requires: { credentials: [] },
    runsCode: null,
    status: 'ready',
    unsupportedReason: null,
    install: null,
    provider: over.ref.source === 'this-computer' ? 'this-computer' : over.ref.source.startsWith('mcp-registry:') ? 'mcp-registries' : 'cinna-core',
    state: 'addable',
    stateReason: null,
    ...over
  }
}

const PDF = entry({
  ref: { source: 'core-catalog', id: 'pkg-pdf' }, kind: 'skill', title: 'PDF', version: '1.2.0',
  description: '# Reads PDFs\n\nExtracts **text** and tables.', publisher: { name: 'Anthropic', verified: true },
  requires: { credentials: [{ name: 'docs.example.com' }] }, runsCode: true,
  origin: { label: 'Catalog', kind: 'catalog', repositoryUrl: 'https://git.example.test/pdf', homepage: null }
})
const RELEASE = entry({
  ref: { source: 'core-marketplace', id: 'e-rel' }, kind: 'skill', title: 'release-notes',
  origin: { label: 'Acme Skills', kind: 'marketplace', repositoryUrl: null, homepage: null }
})
const BIG = entry({
  ref: { source: 'core-marketplace', id: 'e-big' }, kind: 'skill', title: 'huge-skill', status: 'unsupported',
  unsupportedReason: 'too_large', state: 'blocked', stateReason: 'The server could not prepare it for adding',
  origin: { label: 'Acme Skills', kind: 'marketplace', repositoryUrl: null, homepage: null }
})
const PENDING = entry({
  ref: { source: 'core-marketplace', id: 'e-new' }, kind: 'skill', title: 'fresh-skill', status: 'pending',
  state: 'preparing', stateReason: 'Being prepared on the server'
})
const JIRA = entry({
  ref: { source: 'this-computer', id: 'jira' }, kind: 'mcp', title: 'Atlassian', state: 'added', stateReason: 'Added to this agent',
  mcpProviderId: 'jira', origin: { label: 'On this computer', kind: 'local', repositoryUrl: null, homepage: null }
})
const LINEAR = entry({
  ref: { source: 'mcp-registry:cinna-official', id: 'linear' }, kind: 'mcp', title: 'Linear', state: 'addable_with_setup',
  stateReason: 'Needs a sign-in or an access token after adding',
  origin: { label: 'Cinna MCP registry', kind: 'directory', repositoryUrl: null, homepage: null }
})

const SOURCES = [
  { id: 'cinna-core', label: 'Cinna' },
  { id: 'this-computer', label: 'On this computer' },
  { id: 'mcp-registries', label: 'MCP registries' }
]
const POLICY = { externalDirectories: true, customMcp: true, pluginHooks: true, stdioMcp: true }

let answer: Extract<AddonDirectoryResult, { ok: true }>
const directory = vi.fn(async () => answer)
const search = vi.fn()
const add = vi.fn()
const remove = vi.fn()
const connect = vi.fn()
const upsert = vi.fn()
let providers: Array<Record<string, unknown>> = []
const onClose = vi.fn()

function mount(props: { kit?: boolean; skillBlock?: string | null; client?: QueryClient } = {}): { unmount: () => void } {
  const client = props.client ?? new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(AddonPicker, {
        agent: { id: 'folder:a', name: 'Alpha', kit: props.kit ?? true },
        skillBlock: props.skillBlock ?? null,
        onClose,
        onAttachCreated: vi.fn(async () => {})
      })
    )
  )
}

const dialog = (): HTMLElement => screen.getByRole('dialog', { name: 'Addons for Alpha' })
const list = (): HTMLElement => dialog().querySelector('[data-addon-list]') as HTMLElement
const tiles = (): string[] => [...list().querySelectorAll('[data-addon-results] [data-addon-tile]')].map((t) => t.getAttribute('aria-label') ?? '')
const detail = (): HTMLElement => dialog().querySelector('[data-addon-detail]') as HTMLElement
const open = async (title: string): Promise<HTMLElement> => {
  fireEvent.click(await within(list()).findByRole('button', { name: title }))
  return detail()
}

beforeEach(() => {
  vi.resetAllMocks()
  answer = { ok: true, entries: [PDF, RELEASE, BIG, PENDING, JIRA, LINEAR], sources: SOURCES, policy: { ...POLICY, externalDirectories: false } }
  providers = []
  directory.mockImplementation(async () => answer)
  search.mockResolvedValue({ ok: true, entries: [], sources: [{ id: 'mcp-registries', label: 'MCP registries' }] })
  window.api = {
    addons: { directory, search, entry: vi.fn(), add, remove },
    mcp: { list: vi.fn(async () => providers), onStatusChanged: () => () => {}, connect, upsert },
    system: { openExternal: vi.fn(async () => ({ success: true })) }
  } as never
})

describe('AddonPicker', () => {
  it('opens with the search focused and every entry, each saying where it stands', async () => {
    mount()
    await waitFor(() => expect(tiles()).toEqual(['PDF', 'release-notes', 'huge-skill', 'fresh-skill', 'Atlassian', 'Linear']))
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Search addons' })))
    const state = (title: string): string | null | undefined =>
      within(list()).getByRole('button', { name: title }).querySelector('[data-addon-state-line]')?.textContent
    expect(state('Atlassian')).toBe('Added')
    expect(state('fresh-skill')).toBe('Being prepared on the server')
    // Core's code, as the renderer's sentence.
    expect(state('huge-skill')).toBe('This skill is larger than 16 MB, so it cannot be added.')
    expect(state('PDF')).toBeUndefined()
    // Kind in words on every tile.
    expect(within(list()).getByRole('button', { name: 'Linear' }).querySelector('[data-addon-kind]')?.textContent).toBe('Connector')
  })

  it('filters locally per keystroke, by kind and by source, asking nothing more', async () => {
    mount()
    await waitFor(() => expect(tiles()).toHaveLength(6))
    const searchBox = screen.getByRole('textbox', { name: 'Search addons' })
    // Title, summary and source all match: "On this computer" and "Cinna MCP registry" hold a p.
    fireEvent.change(searchBox, { target: { value: 'p' } })
    expect(tiles()).toEqual(['PDF', 'Atlassian', 'Linear'])
    fireEvent.change(searchBox, { target: { value: 'pd' } })
    expect(tiles()).toEqual(['PDF'])
    fireEvent.change(searchBox, { target: { value: '' } })

    fireEvent.click(within(dialog()).getByRole('button', { name: 'Connectors' }))
    expect(tiles()).toEqual(['Atlassian', 'Linear'])
    fireEvent.click(within(dialog()).getByRole('button', { name: 'All' }))

    const source = within(dialog()).getByRole('combobox', { name: 'Source' })
    expect([...source.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['All sources', 'Cinna', 'On this computer', 'MCP registries'])
    fireEvent.change(source, { target: { value: 'this-computer' } })
    expect(tiles()).toEqual(['Atlassian'])
    fireEvent.change(source, { target: { value: 'cinna-core' } })
    expect(tiles()).toEqual(['PDF', 'release-notes', 'huge-skill', 'fresh-skill'])
    expect(directory).toHaveBeenCalledTimes(1)
    expect(search).not.toHaveBeenCalled()
  })

  it('opens an entry’s detail over the list; Back keeps the search, the filters and the scroll', async () => {
    mount()
    await waitFor(() => expect(tiles()).toHaveLength(6))
    fireEvent.change(screen.getByRole('textbox', { name: 'Search addons' }), { target: { value: 'skill' } })
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Skills' }))
    expect(tiles()).toEqual(['release-notes', 'huge-skill', 'fresh-skill'])
    fireEvent.change(screen.getByRole('textbox', { name: 'Search addons' }), { target: { value: 'pdf' } })
    list().scrollTop = 120
    const view = within(await open('PDF'))
    expect(view.getByRole('heading', { name: 'PDF' })).toBeTruthy()
    // The description as markdown, demoted under the detail's own heading.
    expect(view.getByRole('heading', { name: 'Reads PDFs' }).tagName).toBe('H3')
    expect(view.getByText('text').tagName).toBe('STRONG')
    expect(view.getByText('docs.example.com').tagName).toBe('CODE')
    expect(view.getByText('Runs code on this computer')).toBeTruthy()
    expect(view.getByText('Anthropic')).toBeTruthy()
    fireEvent.click(view.getByRole('link', { name: /Catalog/ }))
    expect(window.api.system.openExternal).toHaveBeenCalledWith('https://git.example.test/pdf')
    // The list is still laid out underneath, only hidden.
    expect(list().closest('.invisible')).toBeTruthy()

    fireEvent.click(view.getByRole('button', { name: 'Back' }))
    expect(detail()).toBeNull()
    expect((screen.getByRole('textbox', { name: 'Search addons' }) as HTMLInputElement).value).toBe('pdf')
    expect(within(dialog()).getByRole('button', { name: 'Skills' }).getAttribute('aria-pressed')).toBe('true')
    expect(list().scrollTop).toBe(120)
    expect(tiles()).toEqual(['PDF'])
  })

  it('Escape steps back from a detail first, then closes', async () => {
    mount()
    await open('PDF')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(detail()).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('adds an entry with nothing more to do, and says it is ready in the next chat, staying open', async () => {
    add.mockResolvedValue({ ok: true, next: null })
    mount()
    const view = within(await open('PDF'))
    fireEvent.click(view.getByRole('button', { name: 'Add to Alpha' }))
    await view.findByText('Ready in the next chat')
    expect(add).toHaveBeenCalledWith('folder:a', { source: 'core-catalog', id: 'pkg-pdf' })
    expect(onClose).not.toHaveBeenCalled()
    // The re-read after an add happens at the hook, not in this view.
    await waitFor(() => expect(directory).toHaveBeenCalledTimes(2))
    // "Done", not a second "Close" beside the header's.
    expect(view.queryByRole('button', { name: 'Close' })).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'Done' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('keeps a refusal inline under the button, closing nothing', async () => {
    add.mockResolvedValue({ ok: false, code: 'forbidden', message: 'Your account may not use this skill.' })
    mount()
    const view = within(await open('PDF'))
    fireEvent.click(view.getByRole('button', { name: 'Add to Alpha' }))
    expect((await view.findByRole('alert')).textContent).toBe('Your account may not use this skill.')
    expect(view.getByRole('button', { name: 'Add to Alpha' })).toBeTruthy()
    expect(screen.getByRole('dialog', { name: 'Addons for Alpha' })).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('disables Add with the reason beside it on a blocked or preparing entry, and on a skill the agent cannot take', async () => {
    mount()
    let view = within(await open('fresh-skill'))
    expect((view.getByRole('button', { name: 'Add to Alpha' }) as HTMLButtonElement).disabled).toBe(true)
    expect(view.getByText('Being prepared on the server')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Back' }))
    view = within(await open('huge-skill'))
    expect((view.getByRole('button', { name: 'Add to Alpha' }) as HTMLButtonElement).disabled).toBe(true)
    expect(view.getByText('This skill is larger than 16 MB, so it cannot be added.')).toBeTruthy()
    expect(add).not.toHaveBeenCalled()
  })

  it('shows an added entry as Added, with Remove', async () => {
    remove.mockResolvedValue({ ok: true, next: null, mcpProviderId: 'jira' })
    mount()
    const view = within(await open('Atlassian'))
    expect((view.getByRole('button', { name: 'Atlassian added' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(view.getByRole('button', { name: 'Remove Atlassian from Alpha' }))
    // Asks first, in the card, as the tab's rows do.
    expect(remove).not.toHaveBeenCalled()
    const confirm = view.getByRole('group', { name: 'Remove Atlassian from Alpha' })
    expect(confirm.textContent).toContain('The connector stays on this computer')
    fireEvent.click(within(confirm).getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(remove).toHaveBeenCalledWith('folder:a', { source: 'this-computer', id: 'jira' }))
  })

  it('after an add that needs a key, asks for it in place, saves it on the connector, then says ready', async () => {
    add.mockResolvedValue({ ok: true, next: 'bearer', mcpProviderId: 'p-lin' })
    providers = [{ id: 'p-lin', name: 'Linear', transportType: 'streamable-http', url: 'https://mcp.linear.app', enabled: true, hasAuth: false, authType: 'oauth', status: 'disconnected', tools: [] }]
    upsert.mockImplementation(async () => {
      providers = [{ ...providers[0], status: 'connected', hasAuth: true, authType: 'bearer' }]
      return { id: 'p-lin', success: true }
    })
    mount()
    const view = within(await open('Linear'))
    fireEvent.click(view.getByRole('button', { name: 'Add to Alpha' }))
    const key = await view.findByLabelText(/Paste the access token for Linear/)
    // A form holding input: neither Escape nor a click outside closes or leaves it.
    fireEvent.change(key, { target: { value: 'lin_secret' } })
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.mouseDown(document.body)
    // Nor do the header's close, the detail's Back or Custom connector… (rule 13: lost work).
    for (const name of ['Close', 'Back', 'Custom connector…']) {
      const control = within(dialog()).getByRole('button', { name }) as HTMLButtonElement
      expect(control.disabled).toBe(true)
      fireEvent.click(control)
    }
    expect(onClose).not.toHaveBeenCalled()
    expect(detail()).toBeTruthy()
    expect((view.getByLabelText(/Paste the access token for Linear/) as HTMLInputElement).value).toBe('lin_secret')
    fireEvent.click(view.getByRole('button', { name: 'Save' }))
    await view.findByText('Ready in the next chat')
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ id: 'p-lin', authType: 'bearer', bearerToken: 'lin_secret', enabled: true }))
  })

  it('lets an empty key step go: every way out stays open, and Not now leaves the connector added with its need', async () => {
    add.mockResolvedValue({ ok: true, next: 'bearer', mcpProviderId: 'p-lin' })
    providers = [{ id: 'p-lin', name: 'Linear', transportType: 'streamable-http', url: 'https://mcp.linear.app', enabled: true, hasAuth: false, authType: 'bearer', status: 'disconnected', tools: [] }]
    mount()
    const view = within(await open('Linear'))
    fireEvent.click(view.getByRole('button', { name: 'Add to Alpha' }))
    const key = await view.findByLabelText(/Paste the access token for Linear/)
    // Nothing typed: nothing to lose, so nothing is held.
    for (const name of ['Close', 'Back', 'Custom connector…']) {
      expect((within(dialog()).getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(false)
    }
    // Typed, it holds; emptied again, it lets go.
    fireEvent.change(key, { target: { value: 'x' } })
    expect((within(dialog()).getByRole('button', { name: 'Back' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(key, { target: { value: '' } })
    expect((within(dialog()).getByRole('button', { name: 'Back' }) as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(view.getByRole('button', { name: 'Not now' }))
    expect(view.queryByLabelText(/Paste the access token for Linear/)).toBeNull()
    expect(view.getByRole('button', { name: 'Linear added' })).toBeTruthy()
    expect(detail().querySelector('[data-addon-need]')?.textContent).toBe('Added — needs an access token')
    expect(view.queryByRole('button', { name: 'Add to Alpha' })).toBeNull()
    // The step comes back on asking.
    fireEvent.click(view.getByRole('button', { name: 'Finish setup' }))
    expect(view.getByLabelText(/Paste the access token for Linear/)).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(detail()).toBeNull()
    expect(upsert).not.toHaveBeenCalled()
  })

  it('lets an added connector’s empty key step go too, with Not now', async () => {
    const KEYED = entry({
      ref: { source: 'this-computer', id: 'k' }, kind: 'mcp', title: 'Keyed', state: 'added', stateReason: 'Added — needs an access token',
      setupStep: 'bearer', mcpProviderId: 'k', origin: { label: 'On this computer', kind: 'local', repositoryUrl: null, homepage: null }
    })
    answer = { ...answer, entries: [KEYED] }
    providers = [{ id: 'k', name: 'Keyed', transportType: 'streamable-http', url: 'https://k.example', enabled: true, hasAuth: false, authType: 'bearer', status: 'disconnected', tools: [] }]
    mount()
    const view = within(await open('Keyed'))
    await view.findByLabelText(/Paste the access token for Keyed/)
    expect((view.getByRole('button', { name: 'Back' }) as HTMLButtonElement).disabled).toBe(false)
    expect((view.getByRole('button', { name: 'Remove Keyed from Alpha' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(view.getByRole('button', { name: 'Not now' }))
    expect(detail().querySelector('[data-addon-need]')?.textContent).toBe('Added — needs an access token')
    expect(view.getByRole('button', { name: 'Finish setup' })).toBeTruthy()
  })

  it('shows a turned-off connector as such, and turns it on from its detail', async () => {
    const OFF = entry({
      ref: { source: 'this-computer', id: 'off' }, kind: 'mcp', title: 'Sleepy', state: 'added', stateReason: 'Added — turned off',
      setupStep: 'enable', mcpProviderId: 'off', origin: { label: 'On this computer', kind: 'local', repositoryUrl: null, homepage: null }
    })
    answer = { ...answer, entries: [OFF] }
    providers = [{ id: 'off', name: 'Sleepy', transportType: 'streamable-http', url: 'https://s.example', env: {}, enabled: false, hasAuth: false, authType: 'oauth', status: 'disconnected', tools: [] }]
    upsert.mockImplementation(async () => {
      providers = [{ ...providers[0], enabled: true, status: 'connected' }]
      return { id: 'off', success: true }
    })
    mount()
    await waitFor(() => expect(tiles()).toEqual(['Sleepy']))
    expect(within(list()).getByRole('button', { name: 'Sleepy' }).querySelector('[data-addon-state-line]')?.textContent).toBe('Added — turned off')
    const view = within(await open('Sleepy'))
    fireEvent.click(await view.findByRole('button', { name: 'Turn on' }))
    await view.findByText('Ready in the next chat')
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ id: 'off', name: 'Sleepy', enabled: true }))
  })

  it('keeps a refusal of an add that ran on after the picker closed, on that entry when reopened', async () => {
    let finish!: (value: unknown) => void
    add.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const first = mount({ client })
    fireEvent.click(within(await open('PDF')).getByRole('button', { name: 'Add to Alpha' }))
    await waitFor(() => expect(add).toHaveBeenCalledTimes(1))
    first.unmount()
    await act(async () => finish({ ok: false, code: 'forbidden', message: 'Your account may not use this skill.' }))

    mount({ client })
    const view = within(await open('PDF'))
    expect(view.getByRole('alert').textContent).toBe('Your account may not use this skill.')
    expect(view.getByRole('button', { name: 'Add to Alpha' })).toBeTruthy()
  })

  it('shows an earlier opening’s refusal for five minutes, and never an earlier success', () => {
    const run = { key: 'k', status: 'success' as const, result: { ok: false as const, code: 'x', message: 'No.' }, error: null, submittedAt: 1_000, mutationId: 7 }
    const earlier = new Set([7])
    expect(addFlowOf(run, earlier, 1_000 + EARLIER_REFUSAL_MS - 1)).toEqual({ phase: 'idle', error: 'No.' })
    expect(addFlowOf(run, earlier, 1_000 + EARLIER_REFUSAL_MS)).toBeNull()
    expect(addFlowOf({ ...run, result: { ok: true, next: null } }, earlier, 1_001)).toBeNull()
  })

  it('after an add that needs a sign-in, connects and waits for the connector to be connected', async () => {
    add.mockResolvedValue({ ok: true, next: 'oauth', mcpProviderId: 'p-lin' })
    providers = [{ id: 'p-lin', name: 'Linear', transportType: 'streamable-http', url: 'https://mcp.linear.app', enabled: true, hasAuth: false, authType: 'oauth', status: 'awaiting-auth', tools: [] }]
    let statusChanged: () => void = () => {}
    ;(window.api as unknown as { mcp: Record<string, unknown> }).mcp.onStatusChanged = (cb: () => void) => {
      statusChanged = cb
      return () => {}
    }
    connect.mockResolvedValue({ success: true, tools: [], status: 'awaiting-auth' })
    mount()
    const view = within(await open('Linear'))
    fireEvent.click(view.getByRole('button', { name: 'Add to Alpha' }))
    fireEvent.click(await view.findByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(connect).toHaveBeenCalledWith('p-lin'))
    await view.findByText('Waiting for you to sign in in your browser…')
    providers = [{ ...providers[0], status: 'connected' }]
    act(() => statusChanged())
    await view.findByText('Ready in the next chat')
  })

  it('shows a connect failure under its button', async () => {
    add.mockResolvedValue({ ok: true, next: 'oauth', mcpProviderId: 'p-lin' })
    providers = [{ id: 'p-lin', name: 'Linear', transportType: 'streamable-http', url: 'https://mcp.linear.app', enabled: true, hasAuth: false, authType: 'oauth', status: 'disconnected', tools: [] }]
    connect.mockResolvedValue({ success: false, error: 'The server refused the sign-in.' })
    mount()
    const view = within(await open('Linear'))
    fireEvent.click(view.getByRole('button', { name: 'Add to Alpha' }))
    fireEvent.click(await view.findByRole('button', { name: 'Connect' }))
    expect((await view.findByRole('alert')).textContent).toBe('The server refused the sign-in.')
  })

  it('after an add whose connector did not connect, says why and offers Connect, never "ready"', async () => {
    const raw = 'SdkError: Version negotiation probe failed: fetch failed'
    add.mockResolvedValue({ ok: true, next: 'connect', mcpProviderId: 'p-lin', message: raw })
    providers = [{ id: 'p-lin', name: 'Linear', transportType: 'streamable-http', url: 'https://mcp.linear.app', enabled: true, hasAuth: false, authType: 'oauth', status: 'error', tools: [] }]
    connect.mockResolvedValue({ success: true, tools: [] })
    mount()
    const view = within(await open('Linear'))
    fireEvent.click(view.getByRole('button', { name: 'Add to Alpha' }))
    // A sentence, with main's own words behind the (?).
    const alert = await view.findByRole('alert')
    expect(alert.textContent).toBe('It could not reach the server.')
    expect(within(alert).getByRole('img', { name: `Details: ${raw}` }).getAttribute('title')).toBe(raw)
    expect(view.queryByText('Ready in the next chat')).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(connect).toHaveBeenCalledWith('p-lin'))
    await view.findByRole('button', { name: 'Try again' })
  })

  it('keeps an add across closing the picker: reopened, it is still Adding…, then shows its step', async () => {
    let finish!: (value: unknown) => void
    add.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    providers = [{ id: 'p-lin', name: 'Linear', transportType: 'streamable-http', url: 'https://mcp.linear.app', enabled: true, hasAuth: false, authType: 'oauth', status: 'awaiting-auth', tools: [] }]
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const first = mount({ client })
    fireEvent.click(within(await open('Linear')).getByRole('button', { name: 'Add to Alpha' }))
    await waitFor(() => expect(add).toHaveBeenCalledTimes(1))
    first.unmount()

    mount({ client })
    const view = within(await open('Linear'))
    const adding = view.getByRole('button', { name: 'Adding…' }) as HTMLButtonElement
    expect(adding.disabled).toBe(true)
    await act(async () => finish({ ok: true, next: 'oauth', mcpProviderId: 'p-lin' }))
    await view.findByRole('button', { name: 'Connect' })
    expect(add).toHaveBeenCalledTimes(1)
  })

  it('shows an added connector that still needs a step as such, and offers that step', async () => {
    const SLACK = entry({
      ref: { source: 'this-computer', id: 'slack' }, kind: 'mcp', title: 'Slack', state: 'added', stateReason: 'Added — needs you to sign in',
      setupStep: 'oauth', mcpProviderId: 'slack', origin: { label: 'On this computer', kind: 'local', repositoryUrl: null, homepage: null }
    })
    answer = { ...answer, entries: [SLACK] }
    providers = [{ id: 'slack', name: 'Slack', transportType: 'streamable-http', url: 'https://mcp.slack.com', enabled: true, hasAuth: false, authType: 'oauth', status: 'awaiting-auth', tools: [] }]
    mount()
    await waitFor(() => expect(tiles()).toEqual(['Slack']))
    expect(within(list()).getByRole('button', { name: 'Slack' }).querySelector('[data-addon-state-line]')?.textContent).toBe('Added — needs you to sign in')
    const view = within(await open('Slack'))
    expect(view.getByRole('button', { name: 'Connect' })).toBeTruthy()
    expect(view.getByRole('button', { name: 'Remove Slack from Alpha' })).toBeTruthy()
  })

  it('reads the directory past the sources’ caches once per opening', async () => {
    mount()
    await waitFor(() => expect(tiles()).toHaveLength(6))
    expect(directory).toHaveBeenCalledWith('folder:a', { refresh: true })
    expect(directory).toHaveBeenCalledTimes(1)
  })

  it('filters the source select by the provider main names on each entry', async () => {
    // A core MCP entry (U4) is core's, whatever its ref looks like.
    const CORE_MCP = entry({ ref: { source: 'core-mcp', id: 'x' }, kind: 'mcp', title: 'Core connector', provider: 'cinna-core' })
    const ODD = entry({ ref: { source: 'this-computer', id: 'odd' }, kind: 'mcp', title: 'Odd', provider: 'mcp-registries' })
    answer = { ...answer, entries: [CORE_MCP, ODD] }
    mount()
    await waitFor(() => expect(tiles()).toHaveLength(2))
    fireEvent.change(within(dialog()).getByRole('combobox', { name: 'Source' }), { target: { value: 'mcp-registries' } })
    expect(tiles()).toEqual(['Odd'])
  })

  it('offers a sign-in beside an expired Cinna session', async () => {
    answer = { ...answer, sources: [{ id: 'cinna-core', label: 'Cinna', error: 'Your Cinna session expired.', errorCode: 'reauth' }, SOURCES[1]] }
    const reauthenticate = vi.fn(async () => ({ success: true }))
    ;(window.api as unknown as Record<string, unknown>).auth = { cinnaReauth: reauthenticate }
    mount()
    const button = await within(dialog()).findByRole('button', { name: 'Re-authenticate' })
    fireEvent.click(button)
    await waitFor(() => expect(reauthenticate).toHaveBeenCalled())
    await waitFor(() => expect(directory).toHaveBeenCalledTimes(2))
    expect(directory).toHaveBeenLastCalledWith('folder:a', { refresh: true })
  })

  it('names a need without restating its heading, and keeps kind, version and source to the facts list', async () => {
    mount()
    const view = within(await open('Linear'))
    const needs = view.getByRole('heading', { name: 'What it needs' }).parentElement as HTMLElement
    expect(within(needs).getByRole('listitem').textContent).toBe('A sign-in or an access token after adding')
    const pdf = within((fireEvent.click(view.getByRole('button', { name: 'Back' })), await open('PDF')))
    // The version once, in the facts list.
    expect(pdf.getAllByText('1.2.0')).toHaveLength(1)
  })

  it('says a failed source once, quietly in the footer, beside the healthy results', async () => {
    answer = { ok: true, entries: [JIRA], sources: [{ id: 'cinna-core', label: 'Cinna', error: 'Could not load the catalog.' }, SOURCES[1]], policy: POLICY }
    mount()
    await waitFor(() => expect(tiles()).toEqual(['Atlassian']))
    const quiet = dialog().querySelector('[data-addon-source-error]') as HTMLElement
    expect(quiet.textContent).toBe('Cinna: Could not load the catalog.')
    expect(within(dialog()).queryByRole('alert')).toBeNull()
  })

  it('asks the public MCP registry after a pause, from two characters, under its own heading below the results', async () => {
    answer = { ...answer, policy: POLICY }
    const NOTION = entry({
      ref: { source: 'mcp-registry:official', id: 'notion' }, kind: 'mcp', title: 'Notion',
      origin: { label: 'Official MCP registry', kind: 'directory', repositoryUrl: null, homepage: null }
    })
    // A result already listed above is not shown twice.
    search.mockResolvedValue({ ok: true, entries: [NOTION, LINEAR], sources: [{ id: 'mcp-registries', label: 'MCP registries' }] })
    mount()
    await waitFor(() => expect(tiles()).toHaveLength(6))
    const box = screen.getByRole('textbox', { name: 'Search addons' })
    fireEvent.change(box, { target: { value: 'n' } })
    expect(within(dialog()).queryByRole('region', { name: 'More from the public MCP registry' })).toBeNull()
    fireEvent.change(box, { target: { value: 'no' } })
    const region = within(dialog()).getByRole('region', { name: 'More from the public MCP registry' })
    expect(within(region).getByRole('heading', { name: 'More from the public MCP registry' })).toBeTruthy()
    // Space held while it is asked; nothing asked yet.
    expect(region.querySelector('[aria-busy="true"]')).toBeTruthy()
    expect(search).not.toHaveBeenCalled()
    await waitFor(() => expect(search).toHaveBeenCalledWith('folder:a', 'no'), { timeout: REGISTRY_DEBOUNCE_MS + 1000 })
    expect(search).toHaveBeenCalledTimes(1)
    await within(region).findByRole('button', { name: 'Notion' })
    expect(within(region).queryByRole('button', { name: 'Linear' })).toBeNull()

    // The next query keeps those results, dimmed, while it is asked: nothing collapses into placeholders.
    let answerNext!: (value: unknown) => void
    search.mockImplementationOnce(() => new Promise((resolve) => { answerNext = resolve }))
    fireEvent.change(box, { target: { value: 'not' } })
    await waitFor(() => expect(search).toHaveBeenCalledWith('folder:a', 'not'), { timeout: REGISTRY_DEBOUNCE_MS + 1000 })
    expect(within(region).getByRole('button', { name: 'Notion' })).toBeTruthy()
    expect(region.querySelector('[aria-busy="true"]')?.className).toContain('opacity-50')
    await act(async () => answerNext({ ok: true, entries: [NOTION], sources: [{ id: 'mcp-registries', label: 'MCP registries' }] }))
    await waitFor(() => expect(region.querySelector('[aria-busy="true"]')).toBeNull())
  })

  it('asks no registry when the account’s policy turns external directories off', async () => {
    mount()
    await waitFor(() => expect(tiles()).toHaveLength(6))
    fireEvent.change(screen.getByRole('textbox', { name: 'Search addons' }), { target: { value: 'notion' } })
    await new Promise((resolve) => setTimeout(resolve, REGISTRY_DEBOUNCE_MS + 50))
    expect(search).not.toHaveBeenCalled()
    expect(within(dialog()).queryByRole('region', { name: 'More from the public MCP registry' })).toBeNull()
  })

  it('offers Custom connector… only when the policy allows own connectors', async () => {
    answer = { ...answer, policy: { ...POLICY, customMcp: false } }
    mount()
    await waitFor(() => expect(tiles()).toHaveLength(6))
    expect(within(dialog()).queryByRole('button', { name: 'Custom connector…' })).toBeNull()
  })

  it('blocks a skill with the tab’s reason on an agent whose pins are not the user’s to change, leaving connectors addable', async () => {
    mount({ skillBlock: 'Its skills come with the team’s version' })
    let view = within(await open('PDF'))
    expect((view.getByRole('button', { name: 'Add to Alpha' }) as HTMLButtonElement).disabled).toBe(true)
    expect(view.getByText('Its skills come with the team’s version')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Back' }))
    view = within(await open('Linear'))
    expect((view.getByRole('button', { name: 'Add to Alpha' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('keeps one size whatever it shows', async () => {
    mount()
    await waitFor(() => expect(tiles()).toHaveLength(6))
    const card = dialog()
    const size = card.className.split(/\s+/).filter((c) => /^(h|max-h|max-w)-\[/.test(c))
    // …and never more than the window: the 600 px minimum is shorter than 36rem.
    expect(size).toEqual(['h-[36rem]', 'max-h-[calc(100vh-2rem)]', 'max-w-[46rem]'])
    await open('PDF')
    expect(dialog().className).toBe(card.className)
    // Built on the glass materials: a scrim beside the panel, never its parent.
    expect(card.className).toContain('app-modal-panel')
    expect(card.previousElementSibling?.className).toContain('app-modal-scrim')
  })
})
