import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../stores/logger.store', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { MessageBubble } from '../chat/MessageBubble'
import { ComponentRefScopeContext } from './ComponentCard'
import { useAuthStore } from '../../stores/auth.store'
import { composerDraftKey, useComposerDraftStore } from '../../stores/composerDraft.store'
import { useUIStore } from '../../stores/ui.store'
import type { ComponentInfo, ComponentReferenceResolution } from '../../../../shared/dashboards'

const ID = '2f6c3a1e-9b7d-4c2a-8e1f-0a1b2c3d4e5f'
const REF = `cinna://component/id:${ID}/deals-pipeline`
const CANONICAL = 'cinna://component/bundle:io.example.cinna.ab12cd34/deals-pipeline'

const component: ComponentInfo = {
  agentId: `folder:${ID}`,
  manifestId: ID,
  agentName: 'Sales Agent',
  name: 'deals-pipeline',
  skill: null,
  title: 'Deals pipeline',
  description: '',
  view: 'table',
  size: 'm',
  source: { endpoint: 'deals' },
  maxAge: '15m',
  refreshCommand: null,
  refresh: { maxAge: '15m', whileOpenEvery: null, afterTurn: false, onAppStart: false, command: null, schedule: null },
  params: {},
  valid: true,
  findings: [],
  missingCredentials: [],
  prompts: []
}

function found(over: Partial<ComponentInfo> = {}, placements: { dashboardName: string }[] = []): ComponentReferenceResolution {
  return {
    found: true,
    component: { ...component, ...over },
    placements: placements.map((p, i) => ({ component: component.name, skill: over.skill ?? null, tileId: `t${i}`, dashboardId: `d${i}`, dashboardName: p.dashboardName })),
    canonicalReference: CANONICAL
  }
}

function miss(reason: Extract<ComponentReferenceResolution, { found: false }>['reason'], over: Partial<Extract<ComponentReferenceResolution, { found: false }>> = {}): ComponentReferenceResolution {
  return { found: false, reason, agentName: null, agentId: null, bundleId: null, ...over }
}

const resolveReference = vi.fn()
const writeText = vi.fn()
const items = vi.fn()

function show(text: string, scope = { chatId: 'chat-1', agentId: 'agent-root' }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ComponentRefScopeContext.Provider value={scope}>
        <MessageBubble role="assistant" content={text} />
      </ComponentRefScopeContext.Provider>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  resolveReference.mockReset()
  writeText.mockReset().mockResolvedValue({ success: true })
  items.mockReset().mockResolvedValue({ success: true, value: { host: 'http://core.test', items: [], fetchedAt: '', available: true } })
  window.api = {
    app: { setTheme: async () => {} },
    clipboard: { writeText },
    dashboards: { resolveReference },
    catalog: { items }
  } as never
  useAuthStore.setState({ currentUser: { id: 'alice', type: 'local_user' } as never })
  useComposerDraftStore.setState({ drafts: {} })
})

describe('ComponentCard', () => {
  it('shows a skeleton while main resolves, then the card; it asks with the chat’s agent', async () => {
    let answer!: (value: unknown) => void
    resolveReference.mockReturnValue(new Promise((resolve) => { answer = resolve }))
    const { container } = show(`Here:\n\n${REF}`)
    expect(container.querySelector('[data-component-card-skeleton]')).not.toBeNull()
    expect(resolveReference).toHaveBeenCalledWith({ reference: REF, chatAgentId: 'agent-root' })
    await act(async () => answer({ ok: true, resolution: found({ skill: 'crm' }, [{ dashboardName: 'Sales overview' }]) }))
    const card = await screen.findByRole('group', { name: 'Component Deals pipeline' })
    expect(within(card).getByText('Table')).toBeTruthy()
    expect(card.textContent).toContain('Sales Agent · from skill crm')
    expect(within(card).getByRole('button', { name: 'Sales overview' })).toBeTruthy()
    expect(within(card).getByRole('button', { name: 'Preview Deals pipeline' })).toBeTruthy()
    expect(within(card).getByRole('button', { name: 'Add Deals pipeline to a dashboard' })).toBeTruthy()
    expect(container.querySelector('[data-component-card-skeleton]')).toBeNull()
  })

  it('resolves for the agent whose message it is in a chat of several', async () => {
    resolveReference.mockResolvedValue({ ok: true, resolution: found() })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <ComponentRefScopeContext.Provider value={{ chatId: 'chat-1', agentId: 'agent-root' }}>
          <MessageBubble role="assistant" content={REF} agentId="agent-other" agentName="Other" />
        </ComponentRefScopeContext.Provider>
      </QueryClientProvider>
    )
    await screen.findByRole('group', { name: 'Component Deals pipeline' })
    expect(resolveReference).toHaveBeenCalledWith({ reference: REF, chatAgentId: 'agent-other' })
  })

  it('takes a link’s text as the subtitle and copies the canonical reference', async () => {
    resolveReference.mockResolvedValue({ ok: true, resolution: found() })
    show(`[My pipeline](${REF})`)
    const card = await screen.findByRole('group', { name: 'Component Deals pipeline' })
    expect(card.textContent).toContain('My pipeline · Sales Agent')
    expect(card.textContent).toContain('Not on a dashboard yet.')
    await act(async () => fireEvent.click(within(card).getByRole('button', { name: 'Copy reference' })))
    expect(writeText).toHaveBeenCalledWith(CANONICAL)
    expect(within(card).getByRole('button', { name: 'Copied' })).toBeTruthy()
  })

  it('draws two references as one list of two cards and resolves each once', async () => {
    resolveReference.mockImplementation(async ({ reference }: { reference: string }) =>
      ({ ok: true, resolution: found(reference.endsWith('revenue') ? { name: 'revenue', title: 'Revenue' } : {}) }))
    const { container } = show(`${REF}\ncinna://component/id:${ID}/revenue\n\n${REF}`)
    await screen.findByRole('group', { name: 'Component Revenue' })
    expect(container.querySelectorAll('[data-component-cards]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-component-card]')).toHaveLength(2)
    expect(resolveReference).toHaveBeenCalledTimes(2)
  })

  it('lists errors then warnings, and Ask to fix fills this chat’s composer without sending', async () => {
    resolveReference.mockResolvedValue({
      ok: true,
      resolution: found({
        valid: false,
        findings: [
          { path: 'dashboards/deals-pipeline/component.json', code: 'script_missing', field: 'endpoints.deals.script', severity: 'error', message: 'api/deals.py does not exist.' },
          { path: 'dashboards/deals-pipeline/app.js', code: 'network_reference', field: 'fetch', severity: 'warning', message: 'The page calls fetch; it has no network.' }
        ]
      })
    })
    const key = composerDraftKey('alice', 'chat:chat-1')
    useComposerDraftStore.getState().update(key, () => ({ text: 'half a thought' }))
    show(REF)
    const card = await screen.findByRole('group', { name: 'Component Deals pipeline' })
    expect(within(card).getByRole('list', { name: 'Problems with Deals pipeline' }).textContent).toContain('api/deals.py does not exist.')
    expect(within(card).getByRole('list', { name: 'Warnings for Deals pipeline' }).textContent).toContain('it has no network')
    // The errors are the line: no separate "Has problems to fix" above them.
    expect(card.textContent).not.toContain('Has problems to fix')
    // An invalid component offers no Preview or Add.
    expect(within(card).queryByRole('button', { name: 'Preview Deals pipeline' })).toBeNull()
    expect(within(card).queryByRole('button', { name: 'Add Deals pipeline to a dashboard' })).toBeNull()
    fireEvent.click(within(card).getByRole('button', { name: 'Ask to fix' }))
    const text = useComposerDraftStore.getState().drafts[key].text
    expect(text.startsWith('half a thought\n\n')).toBe(true)
    expect(text).toContain(CANONICAL)
    expect(text).toContain('- dashboards/deals-pipeline/component.json (endpoints.deals.script): api/deals.py does not exist.')
    expect(text).not.toContain('it has no network')
    expect(useComposerDraftStore.getState().drafts[key].sending).toBe(false)
  })

  it('offers no Ask to fix outside a chat, and only warnings get no Ask to fix', async () => {
    resolveReference.mockResolvedValue({
      ok: true,
      resolution: found({ findings: [{ path: 'p', code: 'c', field: null, severity: 'warning', message: 'Quiet warning.' }] })
    })
    show(REF)
    const card = await screen.findByRole('group', { name: 'Component Deals pipeline' })
    expect(card.textContent).toContain('Quiet warning.')
    expect(within(card).queryByRole('button', { name: 'Ask to fix' })).toBeNull()
    expect(within(card).getByRole('button', { name: 'Preview Deals pipeline' })).toBeTruthy()
  })

  it('names missing credentials, links to the Credentials tab and offers no Preview or Add', async () => {
    resolveReference.mockResolvedValue({ ok: true, resolution: found({ missingCredentials: ['gmail'] }) })
    show(REF)
    const card = await screen.findByRole('group', { name: 'Component Deals pipeline' })
    expect(card.querySelector('[data-missing-credentials]')?.textContent).toContain('Needs the gmail credential.')
    expect(within(card).queryByRole('button', { name: 'Preview Deals pipeline' })).toBeNull()
    expect(within(card).queryByRole('button', { name: 'Add Deals pipeline to a dashboard' })).toBeNull()
    fireEvent.click(within(card).getByRole('button', { name: 'Open Credentials' }))
    expect(useUIStore.getState().agentPageTabRequest).toBe('credentials')
    expect(useUIStore.getState().activeLocalAgentId).toBe(`folder:${ID}`)
  })

  it.each([
    ['agent_not_here', {}, 'Its agent is not on this machine.'],
    ['ambiguous', {}, 'Two agents match this reference.'],
    ['gone', { agentName: 'Sales Agent', agentId: 'folder:x' }, 'Not in Sales Agent.'],
    ['not_in_this_copy', { agentName: 'Sales Agent', agentId: 'folder:x' }, 'Not in your copy of Sales Agent.'],
    ['not_kit_agent', { agentName: 'Notes' }, 'Components need a kit agent, and Notes is a plain folder.']
  ] as const)('says why for %s, with no Add', async (reason, over, sentence) => {
    resolveReference.mockResolvedValue({ ok: true, resolution: miss(reason, over) })
    const { container } = show(REF)
    await waitFor(() => expect(container.querySelector(`[data-miss-reason="${reason}"]`)?.textContent).toBe(sentence))
    expect(screen.queryByRole('button', { name: /Add .* to a dashboard/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Preview/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Copy reference' })).toBeTruthy()
  })

  it('links a copy without the component to the agent’s Sharing tab', async () => {
    resolveReference.mockResolvedValue({ ok: true, resolution: miss('not_in_this_copy', { agentName: 'Sales Agent', agentId: 'folder:x' }) })
    show(REF)
    fireEvent.click(await screen.findByRole('button', { name: 'Open Sharing' }))
    expect(useUIStore.getState().agentPageTabRequest).toBe('sharing')
    expect(useUIStore.getState().activeLocalAgentId).toBe('folder:x')
  })

  it('falls back to "an agent that is not installed" when the catalog does not list the bundle', async () => {
    resolveReference.mockResolvedValue({ ok: true, resolution: miss('bundle_not_installed', { bundleId: 'io.example.cinna.ab12cd34' }) })
    const { container } = show(REF)
    await waitFor(() => expect(container.querySelector('[data-miss-reason="bundle_not_installed"]')?.textContent).toBe('It belongs to an agent that is not installed.'))
    expect(screen.queryByRole('button', { name: 'Open in catalog' })).toBeNull()
  })

  it('names a bundle the catalog lists and opens it there', async () => {
    useAuthStore.setState({ currentUser: { id: 'alice', type: 'cinna_user' } as never })
    items.mockResolvedValue({
      success: true,
      value: { host: 'http://core.test', fetchedAt: '', available: true, items: [{ kind: 'agent', id: 'io.example.cinna.ab12cd34', uuid: 'uuid-1', name: 'sales', display_name: 'Sales Agent' }] }
    })
    resolveReference.mockResolvedValue({ ok: true, resolution: miss('bundle_not_installed', { bundleId: 'io.example.cinna.ab12cd34' }) })
    const { container } = show(REF)
    await waitFor(() => expect(container.querySelector('[data-miss-reason="bundle_not_installed"]')?.textContent).toBe('Sales Agent is not installed.'))
    fireEvent.click(screen.getByRole('button', { name: 'Open in catalog' }))
    expect(useUIStore.getState().catalogItemRequest).toBe('uuid-1')
    expect(useUIStore.getState().settingsTab).toBe('profile-catalog')
    expect(useUIStore.getState().activeView).toBe('settings')
  })

  it('says so in the card when main refuses the reference', async () => {
    resolveReference.mockResolvedValue({ ok: false, code: 'invalid_input', message: 'That is not a component reference.' })
    show(REF)
    const card = await screen.findByRole('group', { name: 'Component deals-pipeline' })
    await waitFor(() => expect(card.textContent).toContain('That is not a component reference.'))
  })
})
