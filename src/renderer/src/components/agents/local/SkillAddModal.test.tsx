import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CatalogItem, CatalogItemsListing } from '../../../../../shared/catalogItems'

/**
 * Add skill, opened from an agent's Skills section: the catalog's skills only,
 * each pinned into this agent with Add, already-pinned ones shown as Added, a
 * refusal under the card it was for, and the modal kept open throughout.
 */

window.api = {} as never
const { SkillAddModal } = await import('./SkillAddModal')
const { useAuthStore } = await import('../../../stores/auth.store')
const { CATALOG_TEXT } = await import('../../../utils/catalogItems')
const { useSkillAddSourceStore } = await import('../../../stores/skillAddSource.store')

function item(overrides: Partial<CatalogItem>): CatalogItem {
  return {
    kind: 'skill',
    runs_on: null,
    uuid: 'uuid',
    id: 'test.core.skill',
    name: 'skill',
    display_name: 'skill',
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
    ...overrides
  } as CatalogItem
}

const ERP = item({ uuid: 'u-erp', name: 'erp-lookup', display_name: 'erp-lookup', description: 'Look things up in the ERP.' })
const PDF = item({ uuid: 'u-pdf', name: 'pdf-tools', display_name: 'pdf-tools', description: 'Read and fill PDFs.' })
const AGENT = item({ uuid: 'u-agent', kind: 'agent', runs_on: 'cloud', name: 'Helpdesk', display_name: 'Helpdesk' })

function listing(items: CatalogItem[]): CatalogItemsListing {
  return { host: 'https://core.test', items, fetchedAt: '2026-10-10T00:00:00Z', available: true }
}

let pins: string[] = []
const add = vi.fn()
const onClose = vi.fn()

function mount(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(createElement(QueryClientProvider, { client }, createElement(SkillAddModal, { open: true, agentId: 'folder:a', onClose })))
}

const card = (name: string): HTMLElement => screen.getByRole('group', { name })

beforeEach(() => {
  vi.resetAllMocks()
  pins = []
  useSkillAddSourceStore.setState({ source: 'catalog' })
  useAuthStore.setState({
    currentUser: { id: 'p1', type: 'cinna_user', username: 'u', displayName: 'U', hasPassword: false } as never
  })
  window.api = {
    catalog: { items: vi.fn().mockResolvedValue({ success: true, value: listing([ERP, PDF, AGENT]) }) },
    sharing: {
      library: vi.fn().mockResolvedValue({ success: true, value: { host: 'https://core.test', agents: [], fetchedAt: '' } }),
      statuses: vi.fn().mockResolvedValue({ success: true, value: [] })
    },
    agents: { list: vi.fn().mockResolvedValue([]), onRemoteSyncComplete: () => () => {}, onReadinessChanged: () => () => {} },
    localAgents: {
      list: vi.fn(async () => ({
        roots: [],
        agents: [
          {
            id: 'folder:a',
            name: 'Alpha',
            manifestId: 'a',
            kind: 'kit',
            skills: pins.map((uuid) => ({ source: 'catalog', name: uuid, packageUuid: uuid, issues: [], credentials: [] }))
          }
        ]
      }))
    },
    catalogSkills: { add }
  } as never
})

describe('SkillAddModal', () => {
  it('lists the catalog’s skills only, and pins one into this agent, staying open', async () => {
    add.mockImplementation(async (_agentId: string, uuid: string) => {
      pins = [...pins, uuid]
      return { ok: true, name: 'erp-lookup', revisionNumber: 1 }
    })
    mount()
    await screen.findByText('erp-lookup')
    expect(screen.getByText('pdf-tools')).toBeTruthy()
    expect(screen.queryByText('Helpdesk')).toBeNull()

    const erp = card('erp-lookup')
    await waitFor(() => expect((within(erp).getByRole('button', { name: /^Add erp-lookup/ }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(within(erp).getByRole('button', { name: /^Add erp-lookup/ }))
    await within(erp).findByRole('button', { name: 'erp-lookup added' })
    expect(add).toHaveBeenCalledWith('folder:a', 'u-erp')
    expect(screen.getByRole('dialog', { name: 'Add skill' })).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('lets a skill removed since its add be added again in the next opening', async () => {
    add.mockImplementation(async (_agentId: string, uuid: string) => {
      pins = [...pins, uuid]
      return { ok: true, name: 'erp-lookup', revisionNumber: 1 }
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const tree = (open: boolean) => createElement(QueryClientProvider, { client }, createElement(SkillAddModal, { open, agentId: 'folder:a', onClose }))
    const { rerender } = render(tree(true))
    await screen.findByText('erp-lookup')
    await waitFor(() => expect((within(card('erp-lookup')).getByRole('button', { name: /^Add erp-lookup/ }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(within(card('erp-lookup')).getByRole('button', { name: /^Add erp-lookup/ }))
    await within(card('erp-lookup')).findByRole('button', { name: 'erp-lookup added' })
    // Removed from the agent's Skills section while the modal was closed.
    rerender(tree(false))
    pins = []
    await client.invalidateQueries()
    rerender(tree(true))
    await screen.findByText('erp-lookup')
    await waitFor(() => expect((within(card('erp-lookup')).getByRole('button', { name: /^Add erp-lookup/ }) as HTMLButtonElement).disabled).toBe(false))
  })

  it('shows a skill this agent already pins as Added', async () => {
    pins = ['u-pdf']
    mount()
    await screen.findByText('pdf-tools')
    const button = await within(card('pdf-tools')).findByRole('button', { name: 'pdf-tools added' })
    expect((button as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows a refusal under the card it was for', async () => {
    add.mockResolvedValue({ ok: false, code: 'forbidden', message: 'You no longer have access to this skill.' })
    mount()
    await screen.findByText('erp-lookup')
    const erp = card('erp-lookup')
    await waitFor(() => expect((within(erp).getByRole('button', { name: /^Add erp-lookup/ }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(within(erp).getByRole('button', { name: /^Add erp-lookup/ }))
    expect((await within(erp).findByRole('alert')).textContent).toBe('You no longer have access to this skill.')
    expect(within(card('pdf-tools')).queryByRole('alert')).toBeNull()
  })

  it('filters by the search', async () => {
    mount()
    await screen.findByText('erp-lookup')
    fireEvent.change(screen.getByRole('textbox', { name: 'Search skills' }), { target: { value: 'pdf' } })
    expect(screen.queryByText('erp-lookup')).toBeNull()
    expect(screen.getByText('pdf-tools')).toBeTruthy()
  })

  it('says the catalog needs a Cinna account when the profile is not one', () => {
    useAuthStore.setState({ currentUser: { id: 'p1', type: 'local_user', username: 'u', displayName: 'U', hasPassword: false } as never })
    mount()
    expect(screen.getByText(CATALOG_TEXT.signedOut)).toBeTruthy()
  })

  it('opens a skill’s detail with Add, and Escape steps back to the grid before closing', async () => {
    add.mockResolvedValue({ ok: true, name: 'erp-lookup', revisionNumber: 1 })
    window.api.catalog.item = vi.fn().mockResolvedValue({ success: true, value: { ...ERP, revisions: [] } })
    mount()
    await screen.findByText('erp-lookup')
    fireEvent.click(within(card('erp-lookup')).getByRole('button', { name: 'erp-lookup' }))
    const back = await screen.findByRole('button', { name: CATALOG_TEXT.back })
    const detail = back.parentElement as HTMLElement
    await waitFor(() => expect((within(detail).getByRole('button', { name: /^Add erp-lookup/ }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(within(detail).getByRole('button', { name: /^Add erp-lookup/ }))
    await waitFor(() => expect(add).toHaveBeenCalledWith('folder:a', 'u-erp'))

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('button', { name: CATALOG_TEXT.back })).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})
