import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MarketplaceSkillDiscoverResult, MarketplaceSkillEntry } from '../../../../../shared/marketplaceSkills'

/**
 * Add skill's Marketplaces source: the header switch, the skills every
 * connected marketplace offers read once and filtered locally (by the search
 * and the marketplace choice), an unsupported entry disabled with its reason,
 * the one empty state, Add's states, and a card that keeps its size.
 */

window.api = {} as never
const { SkillAddModal } = await import('./SkillAddModal')
const { useAuthStore } = await import('../../../stores/auth.store')
const { MARKETPLACE_SKILL_TEXT } = await import('../../../utils/marketplaceSkills')
const { useSkillAddSourceStore } = await import('../../../stores/skillAddSource.store')

function entry(over: Partial<MarketplaceSkillEntry>): MarketplaceSkillEntry {
  return {
    entryUuid: 'e-pdf',
    name: 'pdf-report',
    description: 'Builds PDF reports.',
    marketplaceUuid: 'm-team',
    marketplaceName: 'Team skills',
    marketplaceOwner: 'Ada',
    repositoryUrl: 'https://github.com/example/skills',
    supported: true,
    unsupportedReason: null,
    archiveSha256: 'd'.repeat(64),
    archiveSize: 100,
    hasScripts: true,
    commitHash: 'abc',
    version: '0.3.1',
    ...over
  }
}

const PDF = entry({})
const CSV = entry({ entryUuid: 'e-csv', name: 'csv-export', description: 'Exports CSV.', marketplaceUuid: 'm-ops', marketplaceName: 'Ops skills', marketplaceOwner: null, repositoryUrl: null, hasScripts: false })
const BIG = entry({ entryUuid: 'e-big', name: 'huge-skill', description: 'Too big.', supported: false, unsupportedReason: 'too_large', archiveSha256: null })

const discover = vi.fn<() => Promise<MarketplaceSkillDiscoverResult>>()
const add = vi.fn()
const openExternal = vi.fn()
const onClose = vi.fn()

function mount(pinnedEntries: string[] = []): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(createElement(QueryClientProvider, { client }, createElement(SkillAddModal, { open: true, agentId: 'folder:a', pinnedEntries, onClose })))
  return client
}

/** One client across openings: `show(open, pins)` closes or reopens the modal, as the Addons tab does. */
function mountReopenable(): { client: QueryClient; show: (open: boolean, pinnedEntries?: string[]) => void } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const tree = (open: boolean, pinnedEntries: string[]) =>
    createElement(QueryClientProvider, { client }, createElement(SkillAddModal, { open, agentId: 'folder:a', pinnedEntries, onClose }))
  const { rerender } = render(tree(true, []))
  return { client, show: (open, pinnedEntries = []) => rerender(tree(open, pinnedEntries)) }
}

async function openMarketplaces(): Promise<void> {
  fireEvent.click(screen.getByRole('radio', { name: 'Marketplaces' }))
}

const tile = (name: string): HTMLElement => screen.getByRole('group', { name })

beforeEach(() => {
  vi.resetAllMocks()
  useSkillAddSourceStore.setState({ source: 'catalog' })
  useAuthStore.setState({
    currentUser: { id: 'p1', type: 'cinna_user', username: 'u', displayName: 'U', hasPassword: false } as never
  })
  discover.mockResolvedValue({ ok: true, entries: [PDF, CSV, BIG] })
  window.api = {
    catalog: { items: vi.fn().mockResolvedValue({ success: true, value: { host: 'https://core.test', items: [], fetchedAt: '', available: true } }) },
    sharing: {
      library: vi.fn().mockResolvedValue({ success: true, value: { host: 'https://core.test', agents: [], fetchedAt: '' } }),
      statuses: vi.fn().mockResolvedValue({ success: true, value: [] })
    },
    agents: { list: vi.fn().mockResolvedValue([]), onRemoteSyncComplete: () => () => {}, onReadinessChanged: () => () => {} },
    localAgents: { list: vi.fn(async () => ({ roots: [], agents: [] })) },
    catalogSkills: { add: vi.fn() },
    marketplaceSkills: { discover, add },
    system: { openExternal }
  } as never
})

describe('Add skill → Marketplaces', () => {
  it('opens on Catalog, and reads the marketplaces only once that source is chosen', async () => {
    mount()
    expect(screen.getByRole('dialog', { name: 'Add skill' })).toBeTruthy()
    expect((screen.getByRole('radio', { name: 'Catalog' }) as HTMLElement).getAttribute('aria-checked')).toBe('true')
    expect(discover).not.toHaveBeenCalled()
    await openMarketplaces()
    await screen.findByText('pdf-report')
    expect(discover).toHaveBeenCalledTimes(1)
    // Back and forth within one opening asks nothing again.
    fireEvent.click(screen.getByRole('radio', { name: 'Catalog' }))
    await openMarketplaces()
    await screen.findByText('pdf-report')
    expect(discover).toHaveBeenCalledTimes(1)
  })

  it('draws the catalog tile: the marketplace as its badge, the version chip, by its owner, a scripts mark, and its source', async () => {
    mount()
    await openMarketplaces()
    const pdf = within(await screen.findByRole('group', { name: 'pdf-report' }))
    expect(pdf.getByTitle('From the Team skills marketplace').textContent).toBe('Team skills')
    expect(pdf.getByText('0.3.1')).toBeTruthy()
    expect(pdf.getByText('by Ada')).toBeTruthy()
    expect(pdf.getByRole('img', { name: MARKETPLACE_SKILL_TEXT.hasScripts })).toBeTruthy()
    const source = pdf.getByRole('button', { name: 'Open the source of pdf-report' })
    // Bordered, like the tile's other secondary actions — not a bare muted icon (rule 11).
    expect(source.className).toContain('border-[var(--color-border)]')
    fireEvent.click(source)
    expect(openExternal).toHaveBeenCalledWith('https://github.com/example/skills')
    const csv = within(tile('csv-export'))
    expect(csv.getByTitle('From the Ops skills marketplace').textContent).toBe('Ops skills')
    expect(csv.queryByText(/^by /)).toBeNull()
    expect(csv.queryByRole('img', { name: MARKETPLACE_SKILL_TEXT.hasScripts })).toBeNull()
    expect(csv.queryByRole('button', { name: /Open the source/ })).toBeNull()
  })

  it('opens a skill’s detail from its tile, with its facts, its source and Add; Back and Escape return to the grid', async () => {
    add.mockResolvedValue({ ok: true, name: 'pdf-report', archiveSha256: 'd'.repeat(64) })
    mount()
    await openMarketplaces()
    fireEvent.click(within(await screen.findByRole('group', { name: 'pdf-report' })).getByRole('button', { name: 'pdf-report' }))
    const back = await screen.findByRole('button', { name: MARKETPLACE_SKILL_TEXT.back })
    const detail = within(document.querySelector('[data-marketplace-skill-detail="e-pdf"]') as HTMLElement)
    expect(detail.getByRole('heading', { name: 'pdf-report' })).toBeTruthy()
    expect(detail.getByText('Builds PDF reports.')).toBeTruthy()
    expect(detail.getByText('Ada')).toBeTruthy()
    expect(detail.getAllByText('0.3.1').length).toBe(2)
    expect(detail.getByText(MARKETPLACE_SKILL_TEXT.hasScripts)).toBeTruthy()
    fireEvent.click(detail.getByRole('button', { name: 'Open the source of pdf-report' }))
    expect(openExternal).toHaveBeenCalledWith('https://github.com/example/skills')
    fireEvent.click(detail.getByRole('button', { name: 'Add pdf-report to this agent' }))
    await detail.findByRole('button', { name: 'pdf-report added' })
    expect(add).toHaveBeenCalledWith('folder:a', 'e-pdf')

    fireEvent.click(back)
    expect(screen.queryByRole('button', { name: MARKETPLACE_SKILL_TEXT.back })).toBeNull()
    // The tile shows the add the detail made.
    expect(within(tile('pdf-report')).getByRole('button', { name: 'pdf-report added' })).toBeTruthy()

    fireEvent.click(within(tile('csv-export')).getByRole('button', { name: 'csv-export' }))
    await screen.findByRole('button', { name: MARKETPLACE_SKILL_TEXT.back })
    expect(screen.getByText(MARKETPLACE_SKILL_TEXT.noScripts)).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('button', { name: MARKETPLACE_SKILL_TEXT.back })).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('keeps the last entries on a failed refresh and says so on the header line, with Re-authenticate when expired', async () => {
    const { show } = mountReopenable()
    await openMarketplaces()
    await screen.findByText('pdf-report')
    show(false)
    discover.mockResolvedValueOnce({ ok: false, code: 'network', message: 'The server could not be reached.' })
    show(true)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Couldn’t refresh. The server could not be reached.')
    expect(screen.getByText('pdf-report')).toBeTruthy()
    expect(screen.queryByText(MARKETPLACE_SKILL_TEXT.loadFailed)).toBeNull()

    show(false)
    discover.mockResolvedValueOnce({ ok: false, code: 'reauth_required', message: 'x' })
    show(true)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Session expired.'))
    expect(within(screen.getByRole('alert')).getByRole('button', { name: 'Re-authenticate' })).toBeTruthy()
    expect(screen.getByText('csv-export')).toBeTruthy()
    expect(discover).toHaveBeenCalledTimes(3)
  })

  it('reopens on the source chosen last', async () => {
    const { show } = mountReopenable()
    await openMarketplaces()
    await screen.findByText('pdf-report')
    show(false)
    show(true)
    expect(screen.getByRole('radio', { name: 'Marketplaces' }).getAttribute('aria-checked')).toBe('true')
    expect(await screen.findByText('pdf-report')).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: 'Catalog' }))
    show(false)
    show(true)
    expect(screen.getByRole('radio', { name: 'Catalog' }).getAttribute('aria-checked')).toBe('true')
  })

  it('lets a skill removed since its add be added again: a cached Added lasts only until the pin shows up, or the next opening', async () => {
    add.mockResolvedValue({ ok: true, name: 'pdf-report', archiveSha256: 'd'.repeat(64) })
    const { show } = mountReopenable()
    await openMarketplaces()
    fireEvent.click(within(await screen.findByRole('group', { name: 'pdf-report' })).getByRole('button', { name: 'Add pdf-report to this agent' }))
    await within(tile('pdf-report')).findByRole('button', { name: 'pdf-report added' })
    // Closed before the rescan brought the pin in; the pin was then removed.
    show(false)
    show(true)
    await screen.findByText('pdf-report')
    const again = within(tile('pdf-report')).getByRole('button', { name: 'Add pdf-report to this agent' }) as HTMLButtonElement
    expect(again.disabled).toBe(false)

    // Within one opening: added, the pin arrives, then goes — addable again.
    fireEvent.click(again)
    await within(tile('pdf-report')).findByRole('button', { name: 'pdf-report added' })
    show(true, ['e-pdf'])
    expect(within(tile('pdf-report')).getByRole('button', { name: 'pdf-report added' })).toBeTruthy()
    show(true, [])
    expect((within(tile('pdf-report')).getByRole('button', { name: 'Add pdf-report to this agent' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('filters by search and marketplace locally, with no request per keystroke', async () => {
    mount()
    await openMarketplaces()
    await screen.findByText('pdf-report')
    const select = screen.getByRole('combobox', { name: 'Marketplace' }) as HTMLSelectElement
    expect([...select.options].map((option) => option.textContent)).toEqual(['All marketplaces', 'Ops skills', 'Team skills'])
    fireEvent.change(select, { target: { value: 'm-ops' } })
    expect(screen.queryByText('pdf-report')).toBeNull()
    expect(screen.getByText('csv-export')).toBeTruthy()
    fireEvent.change(select, { target: { value: '' } })
    const search = screen.getByRole('textbox', { name: MARKETPLACE_SKILL_TEXT.searchLabel })
    fireEvent.change(search, { target: { value: 'team' } })
    expect(screen.getByText('pdf-report')).toBeTruthy()
    expect(screen.queryByText('csv-export')).toBeNull()
    fireEvent.change(search, { target: { value: 'nothing like it' } })
    expect(screen.getByText(MARKETPLACE_SKILL_TEXT.noMatch)).toBeTruthy()
    expect(discover).toHaveBeenCalledTimes(1)
  })

  it('shows an unsupported entry with its reason and no Add', async () => {
    mount()
    await openMarketplaces()
    const big = within(await screen.findByRole('group', { name: 'huge-skill' }))
    expect(big.getByText('This skill is larger than 16 MB, so it cannot be added.')).toBeTruthy()
    expect((big.getByRole('button', { name: /^Add huge-skill/ }) as HTMLButtonElement).disabled).toBe(true)
    expect(tile('huge-skill').getAttribute('data-marketplace-skill-state')).toBe('unsupported')
  })

  it('adds one, staying open; shows a pinned one as Added; and a refusal under its tile', async () => {
    let finish!: (value: unknown) => void
    add.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    mount(['E-CSV'])
    await openMarketplaces()
    const pdf = within(await screen.findByRole('group', { name: 'pdf-report' }))
    expect(within(tile('csv-export')).getByRole('button', { name: 'csv-export added' })).toBeTruthy()
    fireEvent.click(pdf.getByRole('button', { name: 'Add pdf-report to this agent' }))
    await pdf.findByRole('button', { name: 'Adding pdf-report…' })
    expect(add).toHaveBeenCalledWith('folder:a', 'e-pdf')
    await act(async () => finish({ ok: true, name: 'pdf-report', archiveSha256: 'd'.repeat(64) }))
    await pdf.findByRole('button', { name: 'pdf-report added' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('shows a refusal in main’s words under the tile it was for', async () => {
    add.mockResolvedValue({ ok: false, code: 'snapshot_missing', message: 'The server no longer keeps this version of the skill.' })
    mount()
    await openMarketplaces()
    const pdf = within(await screen.findByRole('group', { name: 'pdf-report' }))
    fireEvent.click(pdf.getByRole('button', { name: 'Add pdf-report to this agent' }))
    expect((await pdf.findByRole('alert')).textContent).toBe('The server no longer keeps this version of the skill.')
  })

  it('says where marketplaces come from when none are visible', async () => {
    discover.mockResolvedValue({ ok: true, entries: [] })
    mount()
    await openMarketplaces()
    expect(await screen.findByText(MARKETPLACE_SKILL_TEXT.empty)).toBeTruthy()
    // The filter row stays drawn: nothing above the list moves as it arrives.
    expect(screen.getByRole('combobox', { name: 'Marketplace' })).toBeTruthy()
  })

  it('offers Re-authenticate for an expired session and Retry for a failed read', async () => {
    discover.mockResolvedValueOnce({ ok: false, code: 'reauth_required', message: 'x' })
    mount()
    await openMarketplaces()
    expect(await screen.findByText(MARKETPLACE_SKILL_TEXT.reauth)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Re-authenticate/ })).toBeTruthy()
    cleanupAndRemount({ ok: false, code: 'network', message: 'x' })
    await openMarketplaces()
    expect(await screen.findByText(MARKETPLACE_SKILL_TEXT.loadFailed)).toBeTruthy()
    discover.mockResolvedValueOnce({ ok: true, entries: [PDF] })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.getByText('pdf-report')).toBeTruthy())
  })

  it('keeps one card size across sources and states', async () => {
    mount()
    const card = screen.getByRole('dialog', { name: 'Add skill' }).firstElementChild as HTMLElement
    const before = card.className
    expect(before).toContain('h-[32rem]')
    await openMarketplaces()
    await screen.findByText('pdf-report')
    expect(card.className).toBe(before)
  })
})

function cleanupAndRemount(result: MarketplaceSkillDiscoverResult): void {
  cleanup()
  discover.mockResolvedValueOnce(result)
  mount()
}
