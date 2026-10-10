import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InboxSnapshot, UpdateAvailableInboxItem } from '../../../../shared/inbox'
import type { AgentShareResult, SharingOutcome } from '../../../../shared/agentSharing'

/**
 * "Update available for X": one card type for every kind of agent with a
 * newer catalog version — a shared desktop agent the team moved past, and a
 * cloud agent whose install is behind — wearing the catalog's kind badge,
 * with Update. A clean Update settles the card in place; a desktop agent's
 * conflict takes the user to the agent page, where the two-button choice
 * lives; any other refusal stays on the card beside its button.
 */

const listMock = vi.fn<() => Promise<InboxSnapshot>>()
const update = vi.fn<(agentId: string) => Promise<SharingOutcome<AgentShareResult>>>()
const applyBundleUpdate = vi.fn<(installId: string) => Promise<unknown>>()
const updateSkill = vi.fn<(agentId: string, name: string) => Promise<unknown>>()

;(window as unknown as { api: Record<string, unknown> }).api = {
  app: { setTheme: async () => undefined },
  inbox: { list: () => listMock(), answer: vi.fn() },
  sharing: { update: (agentId: string) => update(agentId) },
  catalogSkills: { update: (agentId: string, name: string) => updateSkill(agentId, name) },
  tasks: { list: async () => [] },
  agents: {
    list: async () => [
      { id: 'folder:payroll', name: 'Payroll Checker' },
      { id: 'remote:rates', name: 'Exchange Rates' }
    ],
    applyBundleUpdate: (installId: string) => applyBundleUpdate(installId),
    syncRemote: async () => ({ success: true }),
    onRemoteSyncComplete: () => () => {},
    onReadinessChanged: () => () => {}
  }
}

const { InboxView } = await import('./InboxView')
const { useUIStore } = await import('../../stores/ui.store')
const { SHARE_REFUSAL_TEXT, SHARE_UI_TEXT } = await import('../../utils/shareText')
const { CATALOG_KIND_TEXT, CATALOG_SKILL_TEXT } = await import('../../utils/catalogItems')

const DESKTOP: UpdateAvailableInboxItem = {
  kind: 'update_available',
  target: 'desktop_agent',
  agentId: 'folder:payroll',
  agentName: 'Payroll Checker',
  repoId: 'r-payroll',
  version: 7,
  versionLabel: null,
  changedBy: 'Dana Ruiz',
  changedAt: new Date('2026-09-13T12:00:00Z')
}

const CLOUD: UpdateAvailableInboxItem = {
  kind: 'update_available',
  target: 'cloud_agent',
  agentId: 'remote:rates',
  agentName: 'Exchange Rates',
  installId: 'install-2',
  version: 5,
  versionLabel: '1.2.0',
  changedBy: null,
  changedAt: null
}

function result(overrides: Partial<AgentShareResult>): SharingOutcome<AgentShareResult> {
  return { success: true, value: { done: true, refusal: null, detail: null, status: null, agentId: null, autoAttached: [], setupNeeded: false, ...overrides } }
}

let client: QueryClient
function wrapper({ children }: { children: ReactNode }): React.JSX.Element {
  return createElement(QueryClientProvider, { client }, children)
}

function card(name: string): HTMLElement {
  return screen.getByRole('article', { name: SHARE_UI_TEXT.updateAvailableFor(name) })
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } })
  listMock.mockReset().mockResolvedValue({ entries: [], unreadable: [], dispatch: [], updates: [DESKTOP, CLOUD] })
  update.mockReset()
  applyBundleUpdate.mockReset()
  updateSkill.mockReset()
  useUIStore.setState({ activeView: 'inbox', activeLocalAgentId: null, activeExternalAgentId: null } as never)
})

describe('Update available — one card for both kinds of agent', () => {
  it('draws both kinds with the same card, each with its catalog badge and version', async () => {
    render(createElement(InboxView), { wrapper })
    await screen.findByRole('article', { name: SHARE_UI_TEXT.updateAvailableFor('Payroll Checker') })
    const desktop = card('Payroll Checker')
    expect(within(desktop).getByText(CATALOG_KIND_TEXT.desktop_agent)).toBeTruthy()
    expect(within(desktop).getByText('Version 7 · by Dana Ruiz')).toBeTruthy()
    // The date as the catalog writes it, with the month as a word, on its own.
    expect(within(desktop).getByText('13 Sep 2026')).toBeTruthy()
    const cloud = card('Exchange Rates')
    expect(within(cloud).getByText(CATALOG_KIND_TEXT.cloud_agent)).toBeTruthy()
    // The publisher's label beside the number, as the catalog shows it.
    expect(within(cloud).getByText('Version 5 (1.2.0)')).toBeTruthy()
    // The same controls on both.
    expect(within(desktop).getAllByRole('button').map((b) => b.textContent)).toEqual(['Payroll Checker', SHARE_UI_TEXT.update])
    expect(within(cloud).getAllByRole('button').map((b) => b.textContent)).toEqual(['Exchange Rates', SHARE_UI_TEXT.update])
  })

  it('links each name to its agent page', async () => {
    render(createElement(InboxView), { wrapper })
    await screen.findByRole('article', { name: SHARE_UI_TEXT.updateAvailableFor('Payroll Checker') })
    fireEvent.click(within(card('Payroll Checker')).getByRole('button', { name: 'Payroll Checker' }))
    expect(useUIStore.getState().activeView).toBe('local-agent')
    expect(useUIStore.getState().activeLocalAgentId).toBe('folder:payroll')
    fireEvent.click(within(card('Exchange Rates')).getByRole('button', { name: 'Exchange Rates' }))
    expect(useUIStore.getState().activeView).toBe('external-agent')
    expect(useUIStore.getState().activeExternalAgentId).toBe('remote:rates')
  })
})

describe('Update available — a desktop agent', () => {
  it('updates, and keeps the card with what it settled as after the next read drops it', async () => {
    update.mockResolvedValue(result({}))
    render(createElement(InboxView), { wrapper })
    await screen.findByRole('article', { name: SHARE_UI_TEXT.updateAvailableFor('Payroll Checker') })
    await act(async () => {
      fireEvent.click(within(card('Payroll Checker')).getByRole('button', { name: SHARE_UI_TEXT.update }))
    })
    expect(update).toHaveBeenCalledWith('folder:payroll')
    expect(applyBundleUpdate).not.toHaveBeenCalled()
    listMock.mockResolvedValue({ entries: [], unreadable: [], dispatch: [], updates: [] })
    await act(async () => {
      await client.refetchQueries({ queryKey: ['inbox'] })
    })
    expect(within(card('Payroll Checker')).getByRole('status').textContent).toBe(SHARE_UI_TEXT.updated)
  })

  it('a conflict opens the agent page, where the choice is', async () => {
    update.mockResolvedValue(result({ done: false, refusal: 'diverged_conflict' }))
    render(createElement(InboxView), { wrapper })
    await screen.findByRole('article', { name: SHARE_UI_TEXT.updateAvailableFor('Payroll Checker') })
    await act(async () => {
      fireEvent.click(within(card('Payroll Checker')).getByRole('button', { name: SHARE_UI_TEXT.update }))
    })
    expect(useUIStore.getState().activeView).toBe('local-agent')
    expect(useUIStore.getState().activeLocalAgentId).toBe('folder:payroll')
  })

  it('any other refusal stays on the card beside Update', async () => {
    update.mockResolvedValue(result({ done: false, refusal: 'dirty' }))
    render(createElement(InboxView), { wrapper })
    await screen.findByRole('article', { name: SHARE_UI_TEXT.updateAvailableFor('Payroll Checker') })
    await act(async () => {
      fireEvent.click(within(card('Payroll Checker')).getByRole('button', { name: SHARE_UI_TEXT.update }))
    })
    expect(within(card('Payroll Checker')).getByRole('alert').textContent).toBe(SHARE_REFUSAL_TEXT.dirty)
    expect(within(card('Payroll Checker')).getByRole('button', { name: SHARE_UI_TEXT.update })).toBeTruthy()
  })
})

describe('Update available — a cloud agent', () => {
  it('applies the latest version to the install, and settles in place', async () => {
    applyBundleUpdate.mockResolvedValue({ success: true, bundleVersion: {} })
    render(createElement(InboxView), { wrapper })
    await screen.findByRole('article', { name: SHARE_UI_TEXT.updateAvailableFor('Exchange Rates') })
    await act(async () => {
      fireEvent.click(within(card('Exchange Rates')).getByRole('button', { name: SHARE_UI_TEXT.update }))
    })
    expect(applyBundleUpdate).toHaveBeenCalledWith('install-2')
    expect(update).not.toHaveBeenCalled()
    listMock.mockResolvedValue({ entries: [], unreadable: [], dispatch: [], updates: [DESKTOP] })
    await act(async () => {
      await client.refetchQueries({ queryKey: ['inbox'] })
    })
    expect(within(card('Exchange Rates')).getByRole('status').textContent).toBe(SHARE_UI_TEXT.updated)
  })

  it('keeps a failure on the card beside Update, an expired session in the user’s words', async () => {
    applyBundleUpdate.mockResolvedValue({ success: false, code: 'request_failed', error: 'Environment busy.' })
    render(createElement(InboxView), { wrapper })
    await screen.findByRole('article', { name: SHARE_UI_TEXT.updateAvailableFor('Exchange Rates') })
    await act(async () => {
      fireEvent.click(within(card('Exchange Rates')).getByRole('button', { name: SHARE_UI_TEXT.update }))
    })
    expect(within(card('Exchange Rates')).getByRole('alert').textContent).toBe('Environment busy.')

    applyBundleUpdate.mockResolvedValue({ success: false, code: 'reauth_required', error: 'Session expired' })
    await act(async () => {
      fireEvent.click(within(card('Exchange Rates')).getByRole('button', { name: SHARE_UI_TEXT.update }))
    })
    expect(within(card('Exchange Rates')).getByRole('alert').textContent).toBe(SHARE_REFUSAL_TEXT.reauth_required)
  })
})

describe('Update available — a catalog skill in an agent', () => {
  const SKILL = (skillName: string, skillTitle: string): UpdateAvailableInboxItem => ({
    kind: 'update_available',
    target: 'skill',
    agentId: 'folder:payroll',
    agentName: 'Payroll Checker',
    skillName,
    skillTitle,
    pinnedRevision: 1,
    version: 3,
    versionLabel: '3.0',
    changedBy: 'Anna Berg',
    changedAt: new Date('2026-09-13T12:00:00Z')
  })
  const skillCard = (title: string): HTMLElement =>
    screen.getByRole('article', { name: CATALOG_SKILL_TEXT.updateAvailableIn(title, 'Payroll Checker') })

  beforeEach(() => {
    listMock.mockResolvedValue({
      entries: [], unreadable: [], dispatch: [],
      updates: [DESKTOP, SKILL('erp-lookup', 'ERP lookup'), SKILL('csv-export', 'CSV export')]
    })
  })

  it('draws one card per agent and skill in the same card, with the Skill badge, and the agent’s name opening it', async () => {
    render(createElement(InboxView), { wrapper })
    await screen.findByRole('article', { name: CATALOG_SKILL_TEXT.updateAvailableIn('ERP lookup', 'Payroll Checker') })
    const erp = skillCard('ERP lookup')
    expect(skillCard('CSV export')).not.toBe(erp)
    // The agent card for the same agent is still its own.
    expect(card('Payroll Checker')).toBeTruthy()
    expect(within(erp).getByText(CATALOG_KIND_TEXT.skill)).toBeTruthy()
    expect(within(erp).getByText('Version 3 (3.0) · by Anna Berg')).toBeTruthy()
    expect(within(erp).getAllByRole('button').map((b) => b.textContent)).toEqual(['Payroll Checker', SHARE_UI_TEXT.update])
    fireEvent.click(within(erp).getByRole('button', { name: 'Payroll Checker' }))
    expect(useUIStore.getState().activeLocalAgentId).toBe('folder:payroll')
  })

  it('updates that pin, and settles in place', async () => {
    updateSkill.mockResolvedValue({ ok: true, name: 'erp-lookup', revisionNumber: 3 })
    render(createElement(InboxView), { wrapper })
    await screen.findByRole('article', { name: CATALOG_SKILL_TEXT.updateAvailableIn('ERP lookup', 'Payroll Checker') })
    await act(async () => {
      fireEvent.click(within(skillCard('ERP lookup')).getByRole('button', { name: SHARE_UI_TEXT.update }))
    })
    expect(updateSkill).toHaveBeenCalledWith('folder:payroll', 'erp-lookup')
    expect(update).not.toHaveBeenCalled()
    expect(within(skillCard('ERP lookup')).getByRole('status').textContent).toBe(CATALOG_SKILL_TEXT.updatedIn('ERP lookup'))
    expect(within(skillCard('CSV export')).getByRole('button', { name: SHARE_UI_TEXT.update })).toBeTruthy()
  })

  it('keeps a refusal on the card beside Update, in main’s sentence', async () => {
    updateSkill.mockResolvedValue({ ok: false, code: 'read_only', message: 'This agent is shared with you to use. Its skills change when the team shares a new version.' })
    render(createElement(InboxView), { wrapper })
    await screen.findByRole('article', { name: CATALOG_SKILL_TEXT.updateAvailableIn('ERP lookup', 'Payroll Checker') })
    await act(async () => {
      fireEvent.click(within(skillCard('ERP lookup')).getByRole('button', { name: SHARE_UI_TEXT.update }))
    })
    expect(within(skillCard('ERP lookup')).getByRole('alert').textContent).toBe(
      'This agent is shared with you to use. Its skills change when the team shares a new version.'
    )
    expect(within(skillCard('ERP lookup')).getByRole('button', { name: SHARE_UI_TEXT.update })).toBeTruthy()
  })
})
