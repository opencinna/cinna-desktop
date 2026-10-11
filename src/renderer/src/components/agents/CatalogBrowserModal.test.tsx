import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CatalogCredentialSpec } from '../../../../shared/catalog'
import type { CatalogItem, CatalogItemDetail, CatalogItemsListing } from '../../../../shared/catalogItems'
import type { LibraryAgentDto, LibraryListingDto } from '../../../../shared/agentSharing'
import type { CloudUpdateActions, DesktopAgentActions } from './CatalogBrowserModal'

/**
 * The one catalog: cloud agents, desktop agents and skills in one grid from
 * main's cached listing, filtered by All / Agents / Skills, each tile with its
 * kind badge and the action of its kind, and a detail whose versions are read
 * when it opens. What has to hold is that every action lands in the right
 * tile — the spinner, the disabled siblings and the error all belong to one
 * item — and that nothing the detail fails to read closes the dialog.
 */

vi.mock('../settings/CatalogCardCredentials', () => ({
  CatalogCardCredentials: ({
    entry,
    enabled,
    compact
  }: {
    entry: { bundleId: string; requiredCredentialSpecs: CatalogCredentialSpec[] }
    enabled: boolean
    compact?: boolean
  }) =>
    createElement(
      'div',
      { 'data-testid': 'credentials' },
      `${entry.bundleId}:${entry.requiredCredentialSpecs.map((s) => s.name).join('+')}:${enabled}:${compact ? 'compact' : 'full'}`
    )
}))

window.api = {} as never
const { CatalogBrowserModal, _resetCatalogFilter } = await import('./CatalogBrowserModal')
const { useAuthStore } = await import('../../stores/auth.store')
const { SETTLE_MS } = await import('../../hooks/useSettleGuard')
const { CATALOG_TEXT, CATALOG_KIND_TEXT, CATALOG_SKILL_TEXT } = await import('../../utils/catalogItems')

function item(overrides: Partial<CatalogItem>): CatalogItem {
  return {
    kind: 'agent',
    runs_on: 'cloud',
    uuid: 'uuid',
    id: 'test.core.item',
    name: 'Item',
    display_name: 'Item',
    description: null,
    publisher: null,
    maintainers: [],
    access: 'use',
    visibility: 'public',
    is_listed: true,
    latest: { revision_number: 1, version: null, published_at: '2026-10-01T00:00:00Z', published_by: null, release_notes: null },
    install_count: 0,
    my_installs: [],
    required_credential_specs: [],
    skills: [],
    desktop: null,
    skill: null,
    ...overrides
  }
}

const INVOICES = item({
  uuid: 'u-invoices',
  id: 'test.core.acme1',
  name: 'Invoice Watcher',
  display_name: 'Invoice Watcher',
  description: 'Flags invoices without a PO number.',
  publisher: { user_id: 'acme', display_name: 'Acme' },
  maintainers: [{ user_id: 'acme', display_name: 'Acme' }],
  install_count: 12,
  latest: { revision_number: 3, version: '1.2.0', published_at: '2026-03-01T00:00:00Z', published_by: null, release_notes: null },
  required_credential_specs: [{ name: 'Odoo', type: 'api_token', provided_by: 'user' }, { name: 'IMAP', type: 'imap' }]
})
const HELPDESK = item({
  uuid: 'u-helpdesk',
  id: 'test.core.help1',
  name: 'Helpdesk',
  display_name: 'Helpdesk',
  maintainers: [{ user_id: 'acme', display_name: 'Acme' }],
  latest: { revision_number: 4, version: null, published_at: '2026-03-01T00:00:00Z', published_by: null, release_notes: null },
  my_installs: [{ where: 'cloud', install_id: 'install-1', device_id: null, host_manifest_id: null, revision_number: 4 }]
})
const RATES = item({
  uuid: 'u-rates',
  id: 'test.core.fx1',
  name: 'Exchange Rates',
  display_name: 'Exchange Rates',
  description: 'Daily FX digest.',
  latest: { revision_number: 5, version: null, published_at: '2026-03-01T00:00:00Z', published_by: null, release_notes: null },
  my_installs: [{ where: 'cloud', install_id: 'install-2', device_id: null, host_manifest_id: null, revision_number: 2 }]
})
const PAYROLL = item({
  runs_on: 'desktop',
  uuid: 'u-payroll',
  id: 'test.core.payroll1',
  name: 'payroll-checker',
  display_name: 'Payroll Checker',
  description: 'Checks the payroll export.',
  maintainers: [{ user_id: 'u1', display_name: 'Dana Ruiz' }],
  latest: { revision_number: 7, version: null, published_at: '2026-10-01T00:00:00Z', published_by: null, release_notes: null }
})
const LEDGER = item({ runs_on: 'desktop', uuid: 'u-ledger', id: 'test.core.ledger1', name: 'ledger', display_name: 'Ledger' })
const ERP = item({
  kind: 'skill',
  runs_on: null,
  uuid: 'u-erp',
  id: 'test.core.skill.erp-lookup',
  name: 'erp-lookup',
  display_name: 'erp-lookup',
  description: 'Look things up in the ERP.',
  publisher: { user_id: 'u2', display_name: 'Anna Berg' },
  required_credential_specs: [{ name: 'erp-api', type: 'api_token' }],
  my_installs: [
    { where: 'local', install_id: null, device_id: 'd1', host_manifest_id: 'AAAA-1', revision_number: 1 },
    { where: 'local', install_id: null, device_id: 'd2', host_manifest_id: 'elsewhere', revision_number: 1 }
  ]
})

function libraryAgent(overrides: Partial<LibraryAgentDto>): LibraryAgentDto {
  return {
    uuid: 'u',
    bundleId: 'b',
    repoId: 'r',
    slug: 'agent',
    name: 'Agent',
    description: '',
    cloneUrl: 'https://core.test/git/r.git',
    headSha: 'a',
    access: 'use',
    visibility: 'users',
    isListed: true,
    maintainers: [],
    engine: null,
    manifestId: null,
    latest: null,
    localAgentId: null,
    updateAvailable: false,
    ...overrides
  }
}

const PAYROLL_LIB = libraryAgent({ uuid: 'u-payroll', repoId: 'r-payroll', name: 'Payroll Checker' })
const LEDGER_LIB = libraryAgent({ uuid: 'u-ledger', repoId: 'r-ledger', name: 'Ledger', localAgentId: 'folder:ledger', updateAvailable: true })

function listing(items: CatalogItem[], available = true): CatalogItemsListing {
  return { host: 'https://core.test', items, fetchedAt: '2026-10-10T00:00:00Z', available }
}

function library(agents: LibraryAgentDto[]): LibraryListingDto {
  return { host: 'https://core.test', agents, fetchedAt: '2026-10-10T00:00:00Z' }
}

function desktopActions(overrides: Partial<DesktopAgentActions> = {}): DesktopAgentActions {
  return { gettingRepoId: null, updatingAgentId: null, error: null, onGet: vi.fn(), onUpdate: vi.fn(), onOpenLocal: vi.fn(), ...overrides }
}

function cloudActions(overrides: Partial<CloudUpdateActions> = {}): CloudUpdateActions {
  return { updatingInstallId: null, error: null, onUpdate: vi.fn(), ...overrides }
}

let itemsMock: ReturnType<typeof vi.fn>
let itemMock: ReturnType<typeof vi.fn>
let libraryMock: ReturnType<typeof vi.fn>
const onClose = vi.fn()
const onInstall = vi.fn()
const onOpen = vi.fn()
const cinnaReauth = vi.fn()

beforeEach(() => {
  vi.resetAllMocks()
  _resetCatalogFilter()
  useAuthStore.setState({
    currentUser: { id: 'p1', type: 'cinna_user', username: 'u', displayName: 'U', hasPassword: false } as never
  })
  itemsMock = vi.fn().mockResolvedValue({ success: true, value: listing([INVOICES, HELPDESK, RATES, PAYROLL, LEDGER, ERP]) })
  itemMock = vi.fn().mockResolvedValue({ success: true, value: { ...INVOICES, revisions: [] } })
  libraryMock = vi.fn().mockResolvedValue({ success: true, value: library([PAYROLL_LIB, LEDGER_LIB]) })
  window.api = {
    catalog: { items: itemsMock, item: itemMock },
    sharing: { library: libraryMock },
    agents: {
      list: vi.fn().mockResolvedValue([
        { id: 'remote:helpdesk', name: 'Helpdesk', source: 'remote', remoteTargetId: 'install-1' },
        { id: 'remote:rates', name: 'Exchange Rates', source: 'remote', remoteTargetId: 'install-2' }
      ]),
      syncRemote: vi.fn().mockResolvedValue(undefined),
      onRemoteSyncComplete: () => () => {},
      onReadinessChanged: () => () => {}
    },
    localAgents: {
      list: vi.fn().mockResolvedValue({ roots: [], agents: [{ id: 'folder:aaaa-1', name: 'Alpha', manifestId: 'aaaa-1' }] })
    },
    auth: { cinnaReauth }
  } as never
})

let client: QueryClient
function mount(
  props: Partial<Parameters<typeof CatalogBrowserModal>[0]> = {},
  { reuseClient = false }: { reuseClient?: boolean } = {}
): {
  rerender: (next: Partial<Parameters<typeof CatalogBrowserModal>[0]>) => void
  unmount: () => void
} {
  if (!reuseClient) client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } })
  const base = {
    onClose,
    onInstall,
    onOpen,
    installingBundleId: null,
    installError: null,
    desktop: desktopActions(),
    cloudUpdate: cloudActions()
  }
  const tree = (p: typeof props): React.JSX.Element =>
    createElement(QueryClientProvider, { client }, createElement(CatalogBrowserModal, { ...base, ...p }))
  const view = render(tree(props))
  return { rerender: (next) => view.rerender(tree({ ...props, ...next })), unmount: view.unmount }
}

const tile = (name: string): HTMLElement => screen.getByRole('group', { name })
const names = (): string[] => screen.queryAllByRole('group').map((g) => g.getAttribute('aria-label')!)
const ALL = ['Invoice Watcher', 'Helpdesk', 'Exchange Rates', 'Payroll Checker', 'Ledger', 'erp-lookup']
async function loaded(): Promise<void> {
  await waitFor(() => expect(names()).toEqual(ALL))
  // The desktop agents' copies join from the sharing listing.
  await waitFor(() => expect(within(tile('Ledger')).queryByRole('button', { name: CATALOG_TEXT.update })).toBeTruthy())
}

describe('CatalogBrowserModal — one list', () => {
  it('asks main for a fresh listing when it opens, and shows every kind with its badge', async () => {
    mount()
    expect(screen.getByRole('dialog', { name: CATALOG_TEXT.title })).toBeTruthy()
    await loaded()
    expect(itemsMock).toHaveBeenCalledWith(true)
    expect(within(tile('Invoice Watcher')).getByText(CATALOG_KIND_TEXT.cloud_agent)).toBeTruthy()
    expect(within(tile('Payroll Checker')).getByText(CATALOG_KIND_TEXT.desktop_agent)).toBeTruthy()
    expect(within(tile('erp-lookup')).getByText(CATALOG_KIND_TEXT.skill)).toBeTruthy()
  })

  it('shows the maintainers, Version N beside the kind badge, and what it needs — not how many use it', async () => {
    mount()
    await loaded()
    const invoices = tile('Invoice Watcher')
    const version = within(invoices).getByText('Version 3 (1.2.0)')
    // On the badge's line, so the name has its line to itself.
    expect(version.parentElement?.textContent).toContain(CATALOG_KIND_TEXT.cloud_agent)
    expect(within(invoices).getByText('Invoice Watcher').parentElement?.textContent).toBe('Invoice Watcher')
    expect(within(invoices).getByText('by Acme')).toBeTruthy()
    expect(within(invoices).getByText('Needs Odoo, IMAP')).toBeTruthy()
    expect(within(invoices).queryByText(/users?$/)).toBeNull()
    expect(within(tile('Payroll Checker')).getByText('Version 7')).toBeTruthy()
    expect(within(tile('Payroll Checker')).getByText('by Dana Ruiz')).toBeTruthy()
    // Without maintainers, the publisher.
    expect(within(tile('erp-lookup')).getByText('by Anna Berg')).toBeTruthy()
  })

  it('filters by All / Agents / Skills, and keeps the choice across a detail and a search', async () => {
    mount()
    await loaded()
    const filter = screen.getByRole('radiogroup', { name: CATALOG_TEXT.filterLabel })
    expect(within(filter).getByRole('radio', { name: 'All' }).getAttribute('aria-checked')).toBe('true')

    fireEvent.click(within(filter).getByRole('radio', { name: 'Skills' }))
    expect(names()).toEqual(['erp-lookup'])
    fireEvent.click(within(filter).getByRole('radio', { name: 'Agents' }))
    expect(names()).toEqual(ALL.filter((n) => n !== 'erp-lookup'))

    fireEvent.click(screen.getByRole('button', { name: 'Ledger' }))
    fireEvent.click(screen.getByRole('button', { name: CATALOG_TEXT.back }))
    expect(within(filter).getByRole('radio', { name: 'Agents' }).getAttribute('aria-checked')).toBe('true')
    expect(names()).toEqual(ALL.filter((n) => n !== 'erp-lookup'))

    // Search narrows inside the filter: the skill matches "erp" but is filtered out.
    fireEvent.change(screen.getByRole('textbox', { name: CATALOG_TEXT.searchLabel }), { target: { value: 'erp' } })
    expect(names()).toEqual([])
    expect(screen.getByText(CATALOG_TEXT.noMatch)).toBeTruthy()
    fireEvent.click(within(filter).getByRole('radio', { name: 'All' }))
    expect(names()).toEqual(['erp-lookup'])
  })

  it('searches name, description, maintainers, publisher and catalog id', async () => {
    mount()
    await loaded()
    const search = screen.getByRole('textbox', { name: CATALOG_TEXT.searchLabel })
    fireEvent.change(search, { target: { value: 'ACME' } })
    expect(names()).toEqual(['Invoice Watcher', 'Helpdesk'])
    fireEvent.change(search, { target: { value: 'po number' } })
    expect(names()).toEqual(['Invoice Watcher'])
    fireEvent.change(search, { target: { value: 'dana' } })
    expect(names()).toEqual(['Payroll Checker'])
    fireEvent.change(search, { target: { value: 'anna berg' } })
    expect(names()).toEqual(['erp-lookup'])
    fireEvent.change(search, { target: { value: 'core.fx1' } })
    expect(names()).toEqual(['Exchange Rates'])
  })

  it('says so when a filter holds nothing, and when the server has no catalog', async () => {
    itemsMock.mockResolvedValue({ success: true, value: listing([INVOICES]) })
    const view = mount()
    await waitFor(() => expect(names()).toEqual(['Invoice Watcher']))
    fireEvent.click(screen.getByRole('radio', { name: 'Skills' }))
    expect(screen.getByText(CATALOG_TEXT.empty.skills)).toBeTruthy()
    view.unmount()

    itemsMock.mockResolvedValue({ success: true, value: listing([], false) })
    mount()
    expect(await screen.findByText(CATALOG_TEXT.unavailable)).toBeTruthy()
  })
})

describe('CatalogBrowserModal — the action by kind', () => {
  it('a cloud agent: Get runs the parent’s install, and while one runs every Get is disabled', async () => {
    const view = mount()
    await loaded()
    fireEvent.click(within(tile('Invoice Watcher')).getByRole('button', { name: CATALOG_TEXT.get }))
    expect(onInstall).toHaveBeenCalledWith('test.core.acme1')

    view.rerender({ installingBundleId: 'test.core.acme1' })
    const running = within(tile('Invoice Watcher')).getByRole('button', { name: CATALOG_TEXT.getting })
    expect((running as HTMLButtonElement).disabled).toBe(true)
    expect(running.getAttribute('title')).toBeNull()
  })

  it('a cloud agent installed and current: Open once it has synced, with no label beside it', async () => {
    mount()
    await loaded()
    const helpdesk = tile('Helpdesk')
    expect(within(helpdesk).queryByText(CATALOG_TEXT.installed)).toBeNull()
    expect(within(helpdesk).queryByRole('button', { name: CATALOG_TEXT.get })).toBeNull()
    fireEvent.click(within(helpdesk).getByRole('button', { name: CATALOG_TEXT.open }))
    expect(onOpen).toHaveBeenCalledWith('remote:helpdesk')
  })

  it('a cloud agent installed but not synced yet: Installed, since there is nothing to Open', async () => {
    ;(window.api.agents.list as ReturnType<typeof vi.fn>).mockResolvedValue([])
    mount()
    await loaded()
    const helpdesk = tile('Helpdesk')
    expect(within(helpdesk).getByText(CATALOG_TEXT.installed)).toBeTruthy()
    expect(within(helpdesk).queryByRole('button', { name: CATALOG_TEXT.open })).toBeNull()
  })

  it('a cloud agent with two installs acts on the one synced to this computer, on every read', async () => {
    const twice = item({
      ...HELPDESK,
      my_installs: [
        { where: 'cloud', install_id: 'install-0', device_id: null, host_manifest_id: null, revision_number: 1 },
        { where: 'cloud', install_id: 'install-1', device_id: null, host_manifest_id: null, revision_number: 4 }
      ]
    })
    itemsMock.mockResolvedValue({ success: true, value: listing([twice]) })
    mount()
    await waitFor(() => expect(names()).toEqual(['Helpdesk']))
    // install-0 is behind but has no agent row here; install-1 has one.
    await waitFor(() => expect(within(tile('Helpdesk')).getByRole('button', { name: CATALOG_TEXT.open })).toBeTruthy())
    expect(within(tile('Helpdesk')).queryByRole('button', { name: CATALOG_TEXT.update })).toBeNull()
  })

  it('a cloud agent behind its latest version: Update applies it to the install, its failure in that tile only', async () => {
    const cloudUpdate = cloudActions()
    const view = mount({ cloudUpdate })
    await loaded()
    fireEvent.click(within(tile('Exchange Rates')).getByRole('button', { name: CATALOG_TEXT.update }))
    expect(cloudUpdate.onUpdate).toHaveBeenCalledWith('install-2')
    expect(within(tile('Helpdesk')).queryByRole('button', { name: CATALOG_TEXT.update })).toBeNull()

    view.rerender({ cloudUpdate: cloudActions({ updatingInstallId: 'install-2' }) })
    expect(within(tile('Exchange Rates')).getByRole('button', { name: CATALOG_TEXT.updating })).toBeTruthy()

    view.rerender({ cloudUpdate: cloudActions({ error: { installId: 'install-2', message: 'Environment busy.' } }) })
    expect(within(tile('Exchange Rates')).getByRole('alert').textContent).toBe('Environment busy.')
    expect(screen.getAllByRole('alert')).toHaveLength(1)
  })

  it('a cloud agent’s synced row has the last word on whether it is behind', async () => {
    ;(window.api.agents.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 'remote:rates',
        name: 'Exchange Rates',
        source: 'remote',
        remoteTargetId: 'install-2',
        remoteMetadata: { bundle_version: { update_available: false } }
      }
    ])
    mount()
    await waitFor(() => expect(within(tile('Exchange Rates')).getByRole('button', { name: CATALOG_TEXT.open })).toBeTruthy())
    expect(within(tile('Exchange Rates')).queryByRole('button', { name: CATALOG_TEXT.update })).toBeNull()
  })

  it('a desktop agent: Get, Update and Open act on the tile they sit in, its refusal there only', async () => {
    const desktop = desktopActions({ error: { repoId: 'r-payroll', message: 'Open Alpha instead.' } })
    mount({ desktop })
    await loaded()
    const payroll = tile('Payroll Checker')
    fireEvent.click(within(payroll).getByRole('button', { name: CATALOG_TEXT.get }))
    expect(desktop.onGet).toHaveBeenCalledWith('r-payroll')
    expect(within(payroll).getByRole('alert').textContent).toBe('Open Alpha instead.')
    expect(within(tile('Ledger')).queryByRole('alert')).toBeNull()

    const ledger = tile('Ledger')
    fireEvent.click(within(ledger).getByRole('button', { name: CATALOG_TEXT.update }))
    expect(desktop.onUpdate).toHaveBeenCalledWith(LEDGER_LIB)
    fireEvent.click(within(ledger).getByRole('button', { name: CATALOG_TEXT.open }))
    expect(desktop.onOpenLocal).toHaveBeenCalledWith('folder:ledger')
  })

  it('a desktop agent being got says so in its tile', async () => {
    mount({ desktop: desktopActions({ gettingRepoId: 'r-payroll' }) })
    await loaded()
    await waitFor(() => expect(within(tile('Payroll Checker')).getByRole('button', { name: CATALOG_TEXT.getting })).toBeTruthy())
  })

  it('a skill: Add to agent…, with which of this computer’s agents already has it', async () => {
    mount()
    await loaded()
    const erp = tile('erp-lookup')
    expect(within(erp).getAllByRole('button')).toEqual([
      within(erp).getByRole('button', { name: 'erp-lookup' }),
      within(erp).getByRole('button', { name: CATALOG_SKILL_TEXT.addToAgent })
    ])
    expect(within(erp).getByText('In 1 agent')).toBeTruthy()

    fireEvent.click(within(erp).getByRole('button', { name: 'erp-lookup' }))
    const used = screen.getByText(CATALOG_TEXT.usedByLabel)
    expect(used.nextElementSibling?.textContent).toBe('Alpha')
    expect(screen.getByTestId('credentials').textContent).toBe('test.core.skill.erp-lookup:erp-api:false:compact')
  })
})

describe('CatalogBrowserModal — a skill none of the user’s agents has', () => {
  it('has Add to agent… and no pill', async () => {
    ;(window.api.localAgents.list as ReturnType<typeof vi.fn>).mockResolvedValue({ roots: [], agents: [] })
    mount()
    await loaded()
    const erp = tile('erp-lookup')
    expect(within(erp).getByRole('button', { name: CATALOG_SKILL_TEXT.addToAgent })).toBeTruthy()
    expect(within(erp).queryByText(/^In \d/)).toBeNull()
  })
})

describe('CatalogBrowserModal — In N agents', () => {
  it('counts this computer’s kit agents by their own pins, not by an install core still lists', async () => {
    ;(window.api.localAgents.list as ReturnType<typeof vi.fn>).mockResolvedValue({
      roots: [],
      agents: [
        // Core still lists Alpha (AAAA-1) as having it, but its pin was removed here.
        { id: 'folder:aaaa-1', name: 'Alpha', manifestId: 'aaaa-1', kind: 'kit', skills: [] },
        { id: 'folder:gamma', name: 'Gamma', manifestId: 'gamma', kind: 'kit', skills: [{ name: 'erp-lookup', source: 'catalog', packageUuid: 'u-erp' }] }
      ]
    })
    mount()
    await loaded()
    await waitFor(() => expect(within(tile('erp-lookup')).getByText('In 1 agent')).toBeTruthy())
    fireEvent.click(within(tile('erp-lookup')).getByRole('button', { name: 'erp-lookup' }))
    expect(screen.getByText(CATALOG_TEXT.usedByLabel).nextElementSibling?.textContent).toBe('Gamma')
  })
})

describe('CatalogBrowserModal — Add to agent…', () => {
  const pinned = { name: 'erp-lookup', source: 'catalog', packageUuid: 'U-ERP' }
  const AGENTS = [
    { id: 'folder:gamma', name: 'Gamma', manifestId: 'gamma', kind: 'kit', skills: [] },
    { id: 'folder:aaaa-1', name: 'Alpha', manifestId: 'aaaa-1', kind: 'kit', skills: [pinned] },
    { id: 'folder:beta', name: 'Beta', manifestId: 'beta', kind: 'kit', skills: [] },
    // A bare folder cannot hold a pin: not listed at all.
    { id: 'folder:bare', name: 'Bare', manifestId: '', kind: 'bare' }
  ]
  let add: ReturnType<typeof vi.fn>

  beforeEach(() => {
    add = vi.fn()
    ;(window.api.localAgents.list as ReturnType<typeof vi.fn>).mockResolvedValue({ roots: [], agents: AGENTS })
    Object.assign(window.api, {
      catalogSkills: { add },
      sharing: {
        library: libraryMock,
        statuses: vi.fn().mockResolvedValue({ success: true, value: [{ agentId: 'folder:beta', remote: { kind: 'cinna', access: 'use' } }] })
      }
    })
  })

  async function openMenu(): Promise<HTMLElement> {
    mount()
    await loaded()
    fireEvent.click(within(tile('erp-lookup')).getByRole('button', { name: CATALOG_SKILL_TEXT.addToAgent }))
    const menu = screen.getByRole('menu', { name: 'Add erp-lookup to an agent' })
    // The share statuses land after the agents.
    await waitFor(() => expect(within(menu).getByText(CATALOG_SKILL_TEXT.canUseOnly)).toBeTruthy())
    return menu
  }
  const item = (menu: HTMLElement, name: string): HTMLButtonElement =>
    within(menu).getAllByRole('menuitem').find((el) => el.textContent?.startsWith(name)) as HTMLButtonElement

  it('lists the kit agents, each disabled with its reason when it cannot take the skill', async () => {
    const menu = await openMenu()
    expect(within(menu).getAllByRole('menuitem').map((el) => el.textContent)).toEqual([
      `Alpha${CATALOG_SKILL_TEXT.added}`,
      `Beta${CATALOG_SKILL_TEXT.canUseOnly}`,
      'Gamma'
    ])
    expect(item(menu, 'Alpha').disabled).toBe(true)
    expect(item(menu, 'Beta').disabled).toBe(true)
    expect(item(menu, 'Beta').title).toBe(`Beta: ${CATALOG_SKILL_TEXT.canUseOnlyTitle}`)
    expect(item(menu, 'Gamma').disabled).toBe(false)
    fireEvent.click(item(menu, 'Beta'))
    expect(add).not.toHaveBeenCalled()
  })

  it('adds to the picked agent with the row busy, closes on success, and the pill counts it', async () => {
    let finish!: (value: unknown) => void
    add.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const menu = await openMenu()
    fireEvent.click(item(menu, 'Gamma'))
    await waitFor(() => expect(add).toHaveBeenCalledWith('folder:gamma', 'u-erp'))
    expect(item(menu, 'Gamma').textContent).toBe(`Gamma${CATALOG_SKILL_TEXT.adding}`)
    expect(item(menu, 'Gamma').getAttribute('aria-busy')).toBe('true')
    ;(window.api.localAgents.list as ReturnType<typeof vi.fn>).mockResolvedValue({
      roots: [],
      agents: AGENTS.map((agent) => (agent.id === 'folder:gamma' ? { ...agent, skills: [pinned] } : agent))
    })
    await act(async () => finish({ ok: true, name: 'erp-lookup', revisionNumber: 1 }))
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(screen.getByRole('dialog', { name: CATALOG_TEXT.title })).toBeTruthy()
    await waitFor(() => expect(within(tile('erp-lookup')).getByText('In 2 agents')).toBeTruthy())
  })

  it('while the share statuses load, every agent waits as Checking access…', async () => {
    window.api.sharing.statuses = vi.fn(() => new Promise(() => undefined)) as never
    mount()
    await loaded()
    fireEvent.click(within(tile('erp-lookup')).getByRole('button', { name: CATALOG_SKILL_TEXT.addToAgent }))
    const menu = screen.getByRole('menu', { name: 'Add erp-lookup to an agent' })
    await waitFor(() =>
      expect(within(menu).getAllByRole('menuitem').map((el) => el.textContent)).toEqual([
        `Alpha${CATALOG_SKILL_TEXT.added}`,
        `Beta${CATALOG_SKILL_TEXT.checkingAccess}`,
        `Gamma${CATALOG_SKILL_TEXT.checkingAccess}`
      ])
    )
    expect(item(menu, 'Gamma').disabled).toBe(true)
  })

  it('a Cinna team agent whose access the listing does not know is Can use only; edit is not', async () => {
    window.api.sharing.statuses = vi.fn().mockResolvedValue({
      success: true,
      value: [
        { agentId: 'folder:beta', remote: { kind: 'cinna', access: null } },
        { agentId: 'folder:gamma', remote: { kind: 'cinna', access: 'edit' } }
      ]
    }) as never
    const menu = await openMenu()
    expect(item(menu, 'Beta').textContent).toBe(`Beta${CATALOG_SKILL_TEXT.canUseOnly}`)
    expect(item(menu, 'Gamma').disabled).toBe(false)
  })

  it('an add outlives the menu: remounted, it still reads Adding…, then shows the refusal', async () => {
    let finish!: (value: unknown) => void
    add.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const first = mount()
    await loaded()
    fireEvent.click(within(tile('erp-lookup')).getByRole('button', { name: CATALOG_SKILL_TEXT.addToAgent }))
    let menu = screen.getByRole('menu', { name: 'Add erp-lookup to an agent' })
    await waitFor(() => expect(item(menu, 'Gamma').disabled).toBe(false))
    fireEvent.click(item(menu, 'Gamma'))
    await waitFor(() => expect(add).toHaveBeenCalledTimes(1))
    first.unmount()

    mount({}, { reuseClient: true })
    await loaded()
    fireEvent.click(within(tile('erp-lookup')).getByRole('button', { name: CATALOG_SKILL_TEXT.addToAgent }))
    menu = screen.getByRole('menu', { name: 'Add erp-lookup to an agent' })
    await waitFor(() => expect(item(menu, 'Gamma').textContent).toBe(`Gamma${CATALOG_SKILL_TEXT.adding}`))
    // A second pick of the same agent waits for the first.
    expect(item(menu, 'Gamma').disabled).toBe(true)
    fireEvent.click(item(menu, 'Gamma'))
    expect(add).toHaveBeenCalledTimes(1)

    await act(async () => finish({ ok: false, code: 'clash', message: 'This agent already has a skill with that name.' }))
    const alert = await within(screen.getByRole('menu')).findByRole('alert')
    expect(alert.textContent).toBe('This agent already has a skill with that name.')
    expect(item(screen.getByRole('menu'), 'Gamma').parentElement?.contains(alert)).toBe(true)
  })

  it('a refusal that lands while the menu is closed reopens it; closing it again drops the refusal', async () => {
    let finish!: (value: unknown) => void
    add.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const menu = await openMenu()
    fireEvent.click(item(menu, 'Gamma'))
    await waitFor(() => expect(add).toHaveBeenCalledTimes(1))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    await act(async () => finish({ ok: false, code: 'write_failed', message: 'Nope.' }))
    expect((await within(await screen.findByRole('menu')).findByRole('alert')).textContent).toBe('Nope.')
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.click(within(tile('erp-lookup')).getByRole('button', { name: CATALOG_SKILL_TEXT.addToAgent }))
    expect(within(screen.getByRole('menu')).queryByRole('alert')).toBeNull()
  })

  const REFUSALS: [string, string][] = [
    ['no_account', 'Catalog skills need a Cinna account.'],
    ['not_found', 'That agent or skill is no longer here.'],
    ['not_kit_agent', 'Only an agent with a cinna-agent.json can hold catalog skills.'],
    ['not_in_catalog', 'This skill is not in the catalog any more.'],
    ['read_only', 'This agent is shared with you to use. Its skills change when the team shares a new version.'],
    ['access_unknown', 'This shared agent is not in your catalog listing, so its skills cannot be changed here.'],
    ['clash', 'This agent already has a skill with that name.'],
    ['already_added', 'This agent already has this skill.'],
    ['download_failed', 'This version is not available to you.'],
    ['hash_mismatch', 'The download did not match the published skill, so nothing was kept.'],
    ['invalid_archive', 'The skill’s files could not be unpacked safely.'],
    ['too_large', 'The skill is larger than 16 MB.'],
    ['manifest_modified', 'cinna-agent.json changed while the skill was downloading. Try again.'],
    ['write_failed', 'The skill could not be saved on this computer.'],
    ['reauth_required', 'Sign in to Cinna again to download this skill.']
  ]

  it.each(REFUSALS)('a %s refusal stays in the menu under the row, in main’s sentence', async (code, message) => {
    add.mockResolvedValue({ ok: false, code, message })
    const menu = await openMenu()
    fireEvent.click(item(menu, 'Gamma'))
    const alert = await within(menu).findByRole('alert')
    expect(alert.textContent).toBe(message)
    // Under the row it was for; the menu and the dialog stay open.
    expect(item(menu, 'Gamma').parentElement?.contains(alert)).toBe(true)
    expect(screen.getByRole('menu')).toBe(menu)
    expect(item(menu, 'Gamma').disabled).toBe(false)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('a refusal without a sentence still says something', async () => {
    add.mockResolvedValue({ ok: false, code: 'write_failed', message: '' })
    const menu = await openMenu()
    fireEvent.click(item(menu, 'Gamma'))
    expect((await within(menu).findByRole('alert')).textContent).toBe(CATALOG_SKILL_TEXT.addFailed)
  })

  it('belongs to the dialog: a press inside does not close it, and Escape closes the menu first', async () => {
    const menu = await openMenu()
    fireEvent.mouseDown(item(menu, 'Alpha'))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})

describe('CatalogBrowserModal — detail', () => {
  it('opens from the tile with the credentials, and Back returns to the same search', async () => {
    mount()
    await loaded()
    fireEvent.change(screen.getByRole('textbox', { name: CATALOG_TEXT.searchLabel }), { target: { value: 'invoice' } })
    fireEvent.click(screen.getByRole('button', { name: 'Invoice Watcher' }))
    expect(screen.getByRole('heading', { name: 'Invoice Watcher' })).toBeTruthy()
    expect(screen.getByText('test.core.acme1')).toBeTruthy()
    // Who stands behind it is the Maintainers row, not a "by" line in the header too.
    expect(screen.getByText(CATALOG_TEXT.maintainersLabel).nextElementSibling?.textContent).toBe('Acme')
    const header = screen.getByRole('heading', { name: 'Invoice Watcher' }).parentElement!
    expect(header.textContent).toBe(`Invoice Watcher${CATALOG_KIND_TEXT.cloud_agent}Version 3 (1.2.0)`)
    expect(screen.getByText(CATALOG_TEXT.usersLabel).nextElementSibling?.textContent).toBe('12')
    // Not installed: the install context is checked.
    expect(screen.getByTestId('credentials').textContent).toBe('test.core.acme1:Odoo+IMAP:true:compact')
    expect(screen.queryByRole('textbox', { name: CATALOG_TEXT.searchLabel })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: CATALOG_TEXT.back }))

    fireEvent.click(screen.getByRole('button', { name: CATALOG_TEXT.back }))
    const search = screen.getByRole('textbox', { name: CATALOG_TEXT.searchLabel }) as HTMLInputElement
    expect(search.value).toBe('invoice')
    expect(document.activeElement).toBe(search)
  })

  it('reads the versions when it opens, newest first, with who shared each and its notes', async () => {
    let answer: (value: unknown) => void = () => undefined
    itemMock.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    mount()
    await loaded()
    fireEvent.click(screen.getByRole('button', { name: 'Invoice Watcher' }))
    expect(screen.getByText(CATALOG_TEXT.versionsLoading)).toBeTruthy()
    expect(itemMock).toHaveBeenCalledWith('u-invoices')
    const detail: CatalogItemDetail = {
      ...INVOICES,
      revisions: [
        { revision_number: 3, version: '1.2.0', published_at: '2026-09-13T12:00:00Z', published_by: { user_id: 'a', display_name: 'Anna' }, release_notes: 'Line one\nLine two\nLine three\nLine four', origin: 'publish', git_commit_sha: null },
        { revision_number: 2, version: null, published_at: '2026-02-01T00:00:00Z', published_by: null, release_notes: 'Short note.', origin: 'publish', git_commit_sha: null }
      ]
    }
    await act(async () => answer({ success: true, value: detail }))
    const versions = screen.getByRole('region', { name: CATALOG_TEXT.versionsHeading })
    const rows = await within(versions).findAllByRole('listitem')
    expect(within(rows[0]).getByText('Version 3 (1.2.0)')).toBeTruthy()
    expect(within(rows[0]).getByText('shared by Anna')).toBeTruthy()
    // The month as a word: no reader has to guess the order.
    expect(within(rows[0]).getByText('13 Sep 2026')).toBeTruthy()
    expect(within(rows[1]).getByText('Version 2')).toBeTruthy()
    // Long notes start clamped, with a control to open them; short ones have none.
    const more = within(rows[0]).getByRole('button', { name: CATALOG_TEXT.showMore })
    fireEvent.click(more)
    expect(within(rows[0]).getByRole('button', { name: CATALOG_TEXT.showLess }).getAttribute('aria-expanded')).toBe('true')
    expect(within(rows[1]).queryByRole('button')).toBeNull()

    // Kept while the dialog is open: back and in again reads nothing.
    fireEvent.click(screen.getByRole('button', { name: CATALOG_TEXT.back }))
    fireEvent.click(screen.getByRole('button', { name: 'Invoice Watcher' }))
    expect(itemMock).toHaveBeenCalledTimes(1)
  })

  it('shows a failed read in the Versions section, keeps the dialog open, and retries there', async () => {
    itemMock.mockResolvedValue({ success: false, code: 'request_failed', message: 'Not Found' })
    mount()
    await loaded()
    fireEvent.click(screen.getByRole('button', { name: 'Payroll Checker' }))
    const versions = screen.getByRole('region', { name: CATALOG_TEXT.versionsHeading })
    await waitFor(() => expect(within(versions).getByRole('alert').textContent).toContain(CATALOG_TEXT.versionsFailed))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('heading', { name: 'Payroll Checker' })).toBeTruthy()

    itemMock.mockResolvedValue({ success: true, value: { ...PAYROLL, revisions: [] } })
    fireEvent.click(within(versions).getByRole('button', { name: CATALOG_TEXT.retry }))
    expect(await within(versions).findByText(CATALOG_TEXT.versionsEmpty)).toBeTruthy()
  })

  it('drops the versions it read when the dialog closes', async () => {
    const view = mount()
    await loaded()
    fireEvent.click(screen.getByRole('button', { name: 'Invoice Watcher' }))
    await waitFor(() => expect(itemMock).toHaveBeenCalledTimes(1))
    expect(client.getQueryCache().findAll({ queryKey: ['catalog', 'item'] })).toHaveLength(1)
    view.unmount()
    expect(client.getQueryCache().findAll({ queryKey: ['catalog', 'item'] })).toHaveLength(0)
  })

  describe('right after a detail opens', () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('ignores a pointer click on Get until the view has settled', async () => {
      mount()
      await loaded()
      fireEvent.click(screen.getByRole('button', { name: 'Invoice Watcher' }), { detail: 1 })
      // The second half of the double-click that opened the detail.
      fireEvent.click(screen.getByRole('button', { name: CATALOG_TEXT.get }), { detail: 2 })
      expect(onInstall).not.toHaveBeenCalled()
      // Enter on the focused button is deliberate, settled or not.
      fireEvent.click(screen.getByRole('button', { name: CATALOG_TEXT.get }), { detail: 0 })
      expect(onInstall).toHaveBeenCalledTimes(1)
      act(() => vi.advanceTimersByTime(SETTLE_MS))
      fireEvent.click(screen.getByRole('button', { name: CATALOG_TEXT.get }), { detail: 1 })
      expect(onInstall).toHaveBeenCalledTimes(2)
    })

    it('ignores a pointer click on the first version’s Show more until the view has settled', async () => {
      itemMock.mockResolvedValue({
        success: true,
        value: {
          ...INVOICES,
          revisions: [
            { revision_number: 3, version: null, published_at: null, published_by: null, release_notes: 'One\nTwo\nThree\nFour', origin: 'publish', git_commit_sha: null }
          ]
        }
      })
      // Versions read before: they show the moment the detail opens, under the pointer.
      mount()
      await loaded()
      await act(() => client.prefetchQuery({ queryKey: ['catalog', 'item', 'p1', 'u-invoices'], queryFn: async () => (await itemMock()).value }))
      fireEvent.click(screen.getByRole('button', { name: 'Invoice Watcher' }), { detail: 1 })
      const more = screen.getByRole('button', { name: CATALOG_TEXT.showMore })
      fireEvent.click(more, { detail: 2 })
      expect(more.getAttribute('aria-expanded')).toBe('false')
      act(() => vi.advanceTimersByTime(SETTLE_MS))
      fireEvent.click(more, { detail: 1 })
      expect(more.getAttribute('aria-expanded')).toBe('true')
    })
  })
})

describe('CatalogBrowserModal — loading the list', () => {
  it('offers Re-authenticate when the session expired, and does not retry by itself', async () => {
    itemsMock.mockResolvedValue({ success: false, code: 'reauth_required', message: 'expired' })
    cinnaReauth.mockResolvedValue({ success: false, error: 'Browser closed.' })
    mount()
    const button = await screen.findByRole('button', { name: 'Re-authenticate' })
    expect(screen.queryByRole('button', { name: CATALOG_TEXT.retry })).toBeNull()
    expect(itemsMock).toHaveBeenCalledTimes(1)
    fireEvent.click(button)
    expect(await screen.findByText('Browser closed.')).toBeTruthy()
  })

  it('offers Retry for any other failure', async () => {
    itemsMock.mockRejectedValue(new Error('boom'))
    mount()
    const retry = await screen.findByRole('button', { name: CATALOG_TEXT.retry })
    itemsMock.mockResolvedValue({ success: true, value: listing([INVOICES]) })
    fireEvent.click(retry)
    await waitFor(() => expect(names()).toEqual(['Invoice Watcher']))
  })

  it('shows a failed refresh beside Refresh, and moves no tile', async () => {
    mount()
    await loaded()
    const grid = tile('Invoice Watcher').parentElement!
    const scroller = grid.parentElement!
    expect(scroller.firstElementChild).toBe(grid)
    itemsMock.mockResolvedValue({ success: false, code: 'request_failed', message: 'boom' })
    const refresh = screen.getByRole('button', { name: CATALOG_TEXT.refresh })
    expect(refresh.textContent).toBe(CATALOG_TEXT.refresh)
    fireEvent.click(refresh)
    const alert = await screen.findByRole('alert')
    // The reason is text, not only a tooltip.
    expect(alert.textContent).toBe(`${CATALOG_TEXT.refreshFailed} boom`)
    // In the header, beside the button — the grid is still the body's first part.
    expect(alert.parentElement).toBe(refresh.parentElement)
    expect(scroller.firstElementChild).toBe(grid)
    expect(names()).toEqual(ALL)
  })

  it('shows the read in progress, not the last failure, while the next read runs', async () => {
    const view = mount()
    await loaded()
    itemsMock.mockResolvedValue({ success: false, code: 'request_failed', message: 'boom' })
    fireEvent.click(screen.getByRole('button', { name: CATALOG_TEXT.refresh }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    view.unmount()

    // Reopened: the failure is still cached beside the list, and the new read is on its way.
    itemsMock.mockReturnValue(new Promise(() => undefined))
    render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(CatalogBrowserModal, { onClose, onInstall, onOpen, installingBundleId: null, installError: null })
      )
    )
    const refresh = screen.getByRole('button', { name: CATALOG_TEXT.refresh })
    await waitFor(() => expect(refresh.getAttribute('aria-busy')).toBe('true'))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText(CATALOG_TEXT.loadFailed)).toBeNull()
    expect(names()).toEqual(ALL)
  })

  it('keeps the filter for the session: the next open shows the same kind', async () => {
    const view = mount()
    await loaded()
    fireEvent.click(screen.getByRole('radio', { name: 'Skills' }))
    view.unmount()
    mount()
    await waitFor(() => expect(names()).toEqual(['erp-lookup']))
    expect(screen.getByRole('radio', { name: 'Skills' }).getAttribute('aria-checked')).toBe('true')
  })

  it('Escape on a detail goes back to the grid, with its filter and search; Escape on the grid closes', async () => {
    mount()
    await loaded()
    fireEvent.click(screen.getByRole('radio', { name: 'Agents' }))
    fireEvent.change(screen.getByRole('textbox', { name: CATALOG_TEXT.searchLabel }), { target: { value: 'ledger' } })
    fireEvent.click(screen.getByRole('button', { name: 'Ledger' }))
    expect(screen.getByRole('heading', { name: 'Ledger' })).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.queryByRole('heading', { name: 'Ledger' })).toBeNull()
    expect((screen.getByRole('textbox', { name: CATALOG_TEXT.searchLabel }) as HTMLInputElement).value).toBe('ledger')
    expect(screen.getByRole('radio', { name: 'Agents' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on Escape and on a click outside', () => {
    mount()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.mouseDown(document.body)
    expect(onClose).toHaveBeenCalledTimes(2)
    fireEvent.mouseDown(screen.getByRole('dialog', { name: CATALOG_TEXT.title }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})

describe('CatalogBrowserModal — Uninstall', () => {
  it('an installed cloud agent’s detail offers Uninstall behind a confirm that Escape closes alone', async () => {
    const onUninstall = vi.fn()
    const clearError = vi.fn()
    mount({ uninstall: { uninstallingInstallId: null, error: null, onUninstall, clearError } })
    await loaded()
    fireEvent.click(screen.getByRole('button', { name: 'Helpdesk' }))
    fireEvent.click(screen.getByRole('button', { name: CATALOG_TEXT.uninstallLabel('Helpdesk') }))
    const confirm = screen.getByRole('dialog', { name: 'Uninstall Helpdesk' })
    // Escape closes the confirm, not the detail under it nor the dialog.
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Uninstall Helpdesk' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'Helpdesk' })).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: CATALOG_TEXT.uninstallLabel('Helpdesk') }))
    expect(confirm).toBeTruthy()
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Uninstall Helpdesk' })).getByRole('button', { name: 'Uninstall' }))
    expect(onUninstall).toHaveBeenCalledWith('install-1', expect.any(Function))
  })

  it('a confirm belongs to its install: when the detail moves to another install of the bundle, it closes', async () => {
    const second = { where: 'cloud' as const, install_id: 'install-3', device_id: null, host_manifest_id: null, revision_number: 4 }
    itemsMock.mockResolvedValue({
      success: true,
      value: listing([INVOICES, { ...HELPDESK, my_installs: [...HELPDESK.my_installs, second] }, RATES, PAYROLL, LEDGER, ERP])
    })
    const onUninstall = vi.fn()
    mount({ uninstall: { uninstallingInstallId: null, error: null, onUninstall, clearError: vi.fn() } })
    await loaded()
    fireEvent.click(screen.getByRole('button', { name: 'Helpdesk' }))
    fireEvent.click(screen.getByRole('button', { name: CATALOG_TEXT.uninstallLabel('Helpdesk') }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Uninstall Helpdesk' })).getByRole('button', { name: 'Uninstall' }))
    expect(onUninstall).toHaveBeenCalledWith('install-1', expect.any(Function))
    // The removal of install-1 shows up in the listing before its own answer does.
    itemsMock.mockResolvedValue({
      success: true,
      value: listing([INVOICES, { ...HELPDESK, my_installs: [second] }, RATES, PAYROLL, LEDGER, ERP])
    })
    const reads = itemsMock.mock.calls.length
    await act(() => client.invalidateQueries({ queryKey: ['catalog'] }))
    await waitFor(() => expect(itemsMock.mock.calls.length).toBeGreaterThan(reads))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Uninstall Helpdesk' })).toBeNull())
    expect(screen.getByRole('heading', { name: 'Helpdesk' })).toBeTruthy()
  })

  it('a cloud agent not installed, and a host without uninstall, offer none', async () => {
    mount()
    await loaded()
    fireEvent.click(screen.getByRole('button', { name: 'Helpdesk' }))
    expect(screen.queryByRole('button', { name: CATALOG_TEXT.uninstallLabel('Helpdesk') })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: CATALOG_TEXT.back }))
    fireEvent.click(screen.getByRole('button', { name: 'Invoice Watcher' }))
    expect(screen.queryByRole('button', { name: CATALOG_TEXT.uninstallLabel('Invoice Watcher') })).toBeNull()
  })
})

describe('CatalogBrowserModal — who can use a skill', () => {
  it('offers a maintainer Who can use on the skill’s detail; its dialog closes on Escape alone and a press inside closes nothing', async () => {
    itemsMock.mockResolvedValue({ success: true, value: listing([INVOICES, HELPDESK, RATES, PAYROLL, LEDGER, { ...ERP, access: 'maintain' }]) })
    const itemPeople = vi.fn().mockResolvedValue({ success: true, value: { visible: true, people: [], selfUserId: null } })
    Object.assign((window.api as unknown as { sharing: object }).sharing, { itemPeople })
    mount()
    await loaded()
    fireEvent.click(screen.getByRole('button', { name: 'erp-lookup' }))
    const icon = screen.getByRole('button', { name: 'Who can use erp-lookup…' })
    // The tooltip says what the accessible name says.
    expect(icon.getAttribute('title')).toBe('Who can use erp-lookup…')
    fireEvent.click(icon)
    const dialog = screen.getByRole('dialog', { name: 'Who can use erp-lookup' })
    await within(dialog).findByText('No one else has access yet.')
    expect(itemPeople).toHaveBeenCalledWith('u-erp')
    fireEvent.mouseDown(within(dialog).getByRole('button', { name: 'Close' }))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Who can use erp-lookup' })).toBeNull()
    // The detail under it stays, and so does the catalog.
    expect(screen.getByRole('heading', { name: 'erp-lookup' })).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('offers no Who can use to someone who can only use or edit the skill', async () => {
    itemsMock.mockResolvedValue({ success: true, value: listing([INVOICES, HELPDESK, RATES, PAYROLL, LEDGER, { ...ERP, access: 'edit' }]) })
    mount()
    await loaded()
    fireEvent.click(screen.getByRole('button', { name: 'erp-lookup' }))
    expect(screen.getByRole('heading', { name: 'erp-lookup' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Who can use erp-lookup…' })).toBeNull()
  })
})
