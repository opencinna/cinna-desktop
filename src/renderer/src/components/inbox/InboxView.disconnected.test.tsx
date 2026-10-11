import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InboxSnapshot, SkillDisconnectedInboxItem } from '../../../../shared/inbox'

/**
 * "Disconnected: *skill* in *agent*": a catalog skill the catalog no longer
 * gives the user. The card says what that means — for the copy on this
 * computer, or, with none, for the agent that cannot download it — and offers Remove — after the inline confirm — where the user may
 * change the agent, and Dismiss. Either settles the card in place.
 */

const listMock = vi.fn<() => Promise<InboxSnapshot>>()
const removeSkill = vi.fn<(agentId: string, name: string) => Promise<unknown>>()
const dismissDisconnected = vi.fn<(input: unknown) => Promise<unknown>>()

;(window as unknown as { api: Record<string, unknown> }).api = {
  app: { setTheme: async () => undefined },
  inbox: { list: () => listMock(), answer: vi.fn(), dismissDisconnected: (input: unknown) => dismissDisconnected(input) },
  catalogSkills: { remove: (agentId: string, name: string) => removeSkill(agentId, name) },
  tasks: { list: async () => [] },
  agents: {
    list: async () => [{ id: 'folder:invoices', name: 'Invoices' }],
    syncRemote: async () => ({ success: true }),
    onRemoteSyncComplete: () => () => {},
    onReadinessChanged: () => () => {}
  }
}

const { InboxView } = await import('./InboxView')
const { useUIStore } = await import('../../stores/ui.store')
const { SKILL_DISCONNECTED_TEXT } = await import('./InboxDisconnectedCard')
const { CATALOG_KIND_TEXT } = await import('../../utils/catalogItems')

const UUID = '0b6f3c1e-1111-4222-8333-444455556666'
const ITEM: SkillDisconnectedInboxItem = {
  kind: 'skill_disconnected',
  agentId: 'folder:invoices',
  agentName: 'Invoices',
  skillName: 'erp-lookup',
  skillTitle: 'ERP lookup',
  packageUuid: UUID,
  revision: 3,
  removable: true,
  cached: true
}

let client: QueryClient
function wrapper({ children }: { children: ReactNode }): React.JSX.Element {
  return createElement(QueryClientProvider, { client }, children)
}

const card = (): HTMLElement => screen.getByRole('article', { name: 'Disconnected: ERP lookup in Invoices' })

async function open(item: SkillDisconnectedInboxItem = ITEM): Promise<void> {
  listMock.mockResolvedValue({ entries: [], unreadable: [], dispatch: [], updates: [], disconnected: [item] })
  render(createElement(InboxView), { wrapper })
  await screen.findByRole('article', { name: 'Disconnected: ERP lookup in Invoices' })
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } })
  listMock.mockReset()
  removeSkill.mockReset()
  dismissDisconnected.mockReset()
  useUIStore.setState({ activeView: 'inbox', activeLocalAgentId: null } as never)
})

describe('Disconnected — a catalog skill the catalog no longer gives the user', () => {
  it('says which skill in which agent, what that means, with the Skill badge, Remove and Dismiss', async () => {
    await open()
    const c = card()
    expect(c.textContent).toContain('Disconnected: ERP lookup in Invoices')
    expect(
      within(c).getByText(
        'It is no longer in the catalog for you. The copy on this computer keeps working as a local version, but it no longer syncs or gets updates.'
      )
    ).toBeTruthy()
    expect(within(c).getByText(CATALOG_KIND_TEXT.skill)).toBeTruthy()
    expect(within(c).getAllByRole('button').map((b) => b.textContent)).toEqual(['Invoices', 'Remove', 'Dismiss'])
    // The agent's name opens its page.
    fireEvent.click(within(c).getByRole('button', { name: 'Invoices' }))
    expect(useUIStore.getState().activeLocalAgentId).toBe('folder:invoices')
  })

  it('leads its title with the state, so a truncated title still says it', async () => {
    await open()
    expect(card().firstElementChild?.firstElementChild?.firstElementChild?.textContent?.startsWith('Disconnected: ERP lookup in')).toBe(true)
  })

  it('says the agent cannot download it when there is no copy on this computer', async () => {
    await open({ ...ITEM, cached: false })
    expect(
      within(card()).getByText(
        'It is no longer in the catalog for you, so this agent can’t download it. Ask a maintainer for access, or remove it.'
      )
    ).toBeTruthy()
    expect(within(card()).queryByText(/keeps working/)).toBeNull()
  })

  it('removes the skill only after the confirm, and settles the card in place', async () => {
    removeSkill.mockResolvedValue({ ok: true })
    await open()
    fireEvent.click(within(card()).getByRole('button', { name: 'Remove' }))
    expect(removeSkill).not.toHaveBeenCalled()
    const confirm = within(card()).getByRole('group', { name: 'Remove ERP lookup from Invoices' })
    expect(confirm.textContent).toContain(SKILL_DISCONNECTED_TEXT.removeConfirm('ERP lookup'))
    // Cancel closes it with nothing removed.
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }))
    expect(within(card()).queryByRole('group')).toBeNull()
    fireEvent.click(within(card()).getByRole('button', { name: 'Remove' }))
    listMock.mockResolvedValue({ entries: [], unreadable: [], dispatch: [], updates: [], disconnected: [] })
    await act(async () => {
      fireEvent.click(within(card()).getByRole('button', { name: 'Remove skill' }))
    })
    expect(removeSkill).toHaveBeenCalledWith('folder:invoices', 'erp-lookup')
    expect(within(card()).getByRole('status').textContent).toBe('Removed. ERP lookup is no longer in Invoices.')
  })

  it('keeps a refused Remove on the card, with its buttons', async () => {
    removeSkill.mockResolvedValue({ ok: false, code: 'read_only', message: 'This agent is shared with you to use.' })
    await open()
    fireEvent.click(within(card()).getByRole('button', { name: 'Remove' }))
    await act(async () => {
      fireEvent.click(within(card()).getByRole('button', { name: 'Remove skill' }))
    })
    expect(within(card()).getByRole('alert').textContent).toBe('This agent is shared with you to use.')
    expect(within(card()).getByRole('button', { name: 'Dismiss' })).toBeTruthy()
  })

  it('dismisses the card for that pin and settles it in place', async () => {
    dismissDisconnected.mockResolvedValue({ ok: true })
    await open()
    listMock.mockResolvedValue({ entries: [], unreadable: [], dispatch: [], updates: [], disconnected: [] })
    await act(async () => {
      fireEvent.click(within(card()).getByRole('button', { name: 'Dismiss' }))
    })
    expect(dismissDisconnected).toHaveBeenCalledWith({ agentId: 'folder:invoices', packageUuid: UUID, revision: 3 })
    expect(within(card()).getByRole('status').textContent).toBe(SKILL_DISCONNECTED_TEXT.dismissed)
  })

  it('offers only Dismiss where the user may not change the agent', async () => {
    await open({ ...ITEM, removable: false })
    expect(within(card()).getAllByRole('button').map((b) => b.textContent)).toEqual(['Invoices', 'Dismiss'])
  })
})
