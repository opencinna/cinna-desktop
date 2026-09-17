import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRootDto, LocalAgentDto } from '../../../../../shared/localAgents'

/**
 * The sidebar row's chat action. It is the jobs row's run-now button with a
 * different verb: visible on hover, in a slot the row always reserves, and it
 * starts a chat the way the page's "Start chat" does — `setActiveView('chat')`
 * + `setPendingAgentId` — without also opening the agent page beside it.
 * Unlike the page's button it then moves the sidebar to Chats.
 *
 * The button is a *sibling* of the row, not a child: a labelled button inside
 * a `role="button"` joins the row's accessible name, and the row is found by
 * the agent's name alone in every E2E spec. As a sibling it can stay in the
 * tree (hidden by opacity, like the chat list's delete button), so it is also
 * reachable by keyboard.
 */

const setAgentPageMode = vi.fn()
const setActiveView = vi.fn()
const setPendingAgentId = vi.fn()
const setActiveLocalAgentId = vi.fn()
const setSidebarTab = vi.fn()
let externalAgents: Array<Record<string, unknown>> = []
let showAgentSidebarSections = true
vi.mock('../../../hooks/useAppSettings', () => ({ useAppSettings: () => ({ data: { showAgentSidebarSections } }) }))
const setActiveExternalAgentId = vi.fn()
vi.mock('../../../hooks/useAgents', () => ({ useAgents: () => ({ data: externalAgents }) }))
vi.mock('../../../stores/ui.store', () => {
  const state = (): Record<string, unknown> => ({
    activeLocalAgentId: null,
    activeView: 'local-agent',
    setActiveLocalAgentId,
    setActiveExternalAgentId,
    setAgentPageMode,
    setActiveView,
    setPendingAgentId,
    setSidebarTab
  })
  // `getState` too: the catalog install lands through the store, not a hook.
  const useUIStore = Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector(state()),
    { getState: state }
  )
  return { useUIStore }
})

const ROOT: AgentRootDto = {
  id: 'root-1',
  path: '/tmp/agents',
  label: 'Agents',
  isDefault: true,
  kind: 'workshop',
  exists: true,
  agentCount: 1,
  truncated: false
} as AgentRootDto

let AGENTS: LocalAgentDto[] = []

const AGENT = {
  id: 'folder:alpha',
  name: 'Alpha',
  description: 'Alpha',
  path: '/tmp/agents/alpha',
  rootId: 'root-1',
  readiness: 'ok',
  readinessReason: null,
  status: null,
  validation: { errors: [], warnings: [], infos: [] },
  commands: [],
  stamps: {}
} as unknown as LocalAgentDto

vi.mock('../../../hooks/useLocalAgents', () => ({
  useLocalAgents: () => ({
    data: { roots: [ROOT], agents: AGENTS },
    isLoading: false,
    error: null
  }),
  useAgentCredentialBindings: () => ({ data: [] }),
  useAgentsHomeQuestion: () => 'ready',
  useRaiseAgentsHomeQuestion: () => undefined
}))
vi.mock('../../../hooks/useProviders', () => ({ useProviders: () => ({ data: [] }) }))
let newAgentProps: { onCatalog?: () => void } | null = null
vi.mock('./NewLocalAgentModal', () => ({
  NewLocalAgentModal: (props: { onCatalog?: () => void }) => {
    newAgentProps = props
    return null
  }
}))
let catalogProps: {
  onClose: () => void
  onInstall: (bundleId: string) => void
  onOpen: (agentId: string) => void
  installingBundleId: string | null
  installError: { bundleId: string; message: string } | null
} | null = null
vi.mock('../CatalogBrowserModal', () => ({
  CatalogBrowserModal: (props: NonNullable<typeof catalogProps>) => {
    catalogProps = props
    return createElement('div', { role: 'dialog', 'aria-label': 'Agent catalog' })
  }
}))

const { useAuthStore } = await import('../../../stores/auth.store')
const { useCatalogInstallStore } = await import('../../../stores/catalogInstall.store')
const { LocalAgentsList } = await import('./LocalAgentsList')

function renderList(): ReturnType<typeof render> {
  const client = new QueryClient()
  return render(createElement(QueryClientProvider, { client }, createElement(LocalAgentsList)))
}

const CHAT = /start a new chat with alpha/i

describe('LocalAgentsList — the row’s chat button', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    AGENTS = [AGENT]
    externalAgents = []
    showAgentSidebarSections = true
    useAuthStore.setState({ currentUser: null })
  })

  it('groups Cinna agents under the active server immediately after Local', () => {
    useAuthStore.setState({ currentUser: { id: 'p1', type: 'cinna_user', username: 'u', displayName: 'U', hasPassword: false, cinnaServerUrl: 'https://core.example.com/api' } })
    externalAgents = [{ id: 'remote:1', name: 'Cloud helper', source: 'remote', protocol: 'a2a', enabled: true }]
    const view = renderList()
    const local = screen.getByText('Local')
    const server = screen.getByText('core.example.com')
    expect(local.compareDocumentPosition(server) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cloud helper' }))
    expect(setActiveExternalAgentId).toHaveBeenCalledWith('remote:1')
    expect(setAgentPageMode).toHaveBeenCalledWith('chat')
    const orderedButtons = screen.getAllByRole('button').map((button) => button.textContent)
    view.unmount()
    showAgentSidebarSections = false
    renderList()
    expect(screen.queryByText('Local')).toBeNull()
    expect(screen.queryByText('core.example.com')).toBeNull()
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(orderedButtons)
  })

  it.each([
    { protocol: 'a2a', description: 'A2A', driver: 'a2a' },
    { protocol: 'acp', description: 'Remote ACP', driver: 'acp', acpTransport: 'websocket', capabilities: { cwd: false } }
  ])('opens saved $protocol agents from the sidebar', (connection) => {
    externalAgents = [{ id: 'external-1', name: 'Remote helper', source: 'local', enabled: true, ...connection }]
    renderList()
    const local = screen.getByRole('button', { name: 'Alpha' })
    const remote = screen.getByRole('button', { name: /^Remote helper/ })
    expect(local.compareDocumentPosition(remote) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(remote)
    expect(setActiveExternalAgentId).toHaveBeenCalledWith('external-1')
    expect(setActiveView).toHaveBeenCalledWith('external-agent')
    expect(setAgentPageMode).toHaveBeenCalledWith('chat')
  })

  it('lends the row nothing: the row is a button named by the agent alone', () => {
    renderList()
    const row = screen.getByRole('button', { name: 'Alpha' })
    expect(row.tagName).toBe('BUTTON')
    expect(row.textContent).toBe('Alpha')
    // Present and reachable, not rendered on hover: no `tabindex="-1"`.
    const chat = screen.getByRole('button', { name: CHAT })
    expect(chat.getAttribute('tabindex')).toBeNull()
    expect(row.contains(chat)).toBe(false)
  })

  it('starts a chat the way the page’s Start chat does, without opening the page', () => {
    renderList()
    fireEvent.click(screen.getByRole('button', { name: CHAT }))
    expect(setActiveView).toHaveBeenCalledTimes(1)
    expect(setActiveView).toHaveBeenCalledWith('chat')
    expect(setPendingAgentId).toHaveBeenCalledWith('folder:alpha')
    // The sidebar follows the chat into the Chats tab.
    expect(setSidebarTab).toHaveBeenCalledWith('chats')
    expect(setActiveLocalAgentId).not.toHaveBeenCalled()
  })

  it('the row itself still opens the agent page', () => {
    renderList()
    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }))
    expect(setActiveLocalAgentId).toHaveBeenCalledWith('folder:alpha')
    expect(setActiveView).toHaveBeenCalledWith('local-agent')
    expect(setPendingAgentId).not.toHaveBeenCalled()
    expect(setSidebarTab).not.toHaveBeenCalled()
  })

  it('is withheld on a row the chat could not attach to', () => {
    // A duplicate-id folder is listed but never indexed: the new-chat screen
    // would look it up, find nothing, and show nothing, and its page offers no
    // Start chat. The gate is on `readiness` and so also covers an indexed
    // folder with an invalid manifest, which cannot run a turn either.
    AGENTS = [
      {
        ...AGENT,
        id: 'folder:duplicate:alpha',
        readiness: 'invalid',
        readinessReason: 'Another folder already claims this id.'
      } as LocalAgentDto
    ]
    renderList()
    expect(screen.getByRole('button', { name: /^Alpha/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: CHAT })).toBeNull()
  })
})

describe('LocalAgentsList — Install from catalog', () => {
  const CINNA = { id: 'p1', type: 'cinna_user', username: 'u', displayName: 'U', hasPassword: false }
  let setupStatus: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    AGENTS = [AGENT]
    externalAgents = []
    newAgentProps = null
    catalogProps = null
    useCatalogInstallStore.setState({ installingBundleId: null, error: null, pendingSetup: null })
    setupStatus = vi.fn().mockResolvedValue({ status: 'ready', missing: [], setupUrl: null })
    window.api = {
      catalog: {
        quickInstall: vi.fn().mockResolvedValue({
          success: true,
          value: { installId: 'inst-1', bundleId: 'b', agentName: 'Invoices' }
        }),
        setupStatus
      },
      agents: {
        syncRemote: vi.fn().mockResolvedValue({ success: true }),
        list: vi.fn().mockResolvedValue([{ id: 'remote:inv', remoteTargetId: 'inst-1' }])
      },
      logger: { log: vi.fn().mockResolvedValue(undefined) }
    } as never
  })

  it('offers the catalog only to a Cinna account', () => {
    useAuthStore.setState({ currentUser: null })
    renderList()
    fireEvent.click(screen.getByRole('button', { name: 'Add an agent' }))
    expect(newAgentProps?.onCatalog).toBeUndefined()
  })

  it('lands on the installed agent, closing the catalog, with no setup when ready', async () => {
    useAuthStore.setState({ currentUser: CINNA as never })
    renderList()
    fireEvent.click(screen.getByRole('button', { name: 'Add an agent' }))
    act(() => newAgentProps!.onCatalog!())
    expect(screen.getByRole('dialog', { name: 'Agent catalog' })).toBeTruthy()

    act(() => catalogProps!.onInstall('b'))
    await waitFor(() => expect(setActiveExternalAgentId).toHaveBeenCalledWith('remote:inv'))
    expect(setActiveView).toHaveBeenCalledWith('external-agent')
    expect(setAgentPageMode).toHaveBeenCalledWith('chat')
    expect(screen.queryByRole('dialog', { name: 'Agent catalog' })).toBeNull()
    await waitFor(() => expect(setupStatus).toHaveBeenCalledWith('inst-1'))
    await act(async () => {})
    expect(useCatalogInstallStore.getState().pendingSetup).toBeNull()
  })

  it('raises setup over the agent when its credentials are incomplete, or unknown', async () => {
    setupStatus.mockRejectedValue(new Error('offline'))
    useAuthStore.setState({ currentUser: CINNA as never })
    renderList()
    fireEvent.click(screen.getByRole('button', { name: 'Add an agent' }))
    act(() => newAgentProps!.onCatalog!())
    act(() => catalogProps!.onInstall('b'))
    await waitFor(() =>
      expect(useCatalogInstallStore.getState().pendingSetup).toEqual({
        installId: 'inst-1',
        agentName: 'Invoices',
        profileId: 'p1'
      })
    )
    expect(setActiveExternalAgentId).toHaveBeenCalledWith('remote:inv')
  })

  it('still lands on the agent when the list was unmounted mid-install (a sidebar tab switch)', async () => {
    let finish!: (value: unknown) => void
    ;(window.api.catalog.quickInstall as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise((resolve) => (finish = resolve))
    )
    setupStatus.mockResolvedValue({ status: 'needs_setup', missing: [], setupUrl: null })
    useAuthStore.setState({ currentUser: CINNA as never })
    const view = renderList()
    fireEvent.click(screen.getByRole('button', { name: 'Add an agent' }))
    act(() => newAgentProps!.onCatalog!())
    act(() => catalogProps!.onInstall('b'))
    view.unmount()
    await act(async () => finish({ success: true, value: { installId: 'inst-1', bundleId: 'b', agentName: 'Invoices' } }))

    await waitFor(() => expect(setActiveExternalAgentId).toHaveBeenCalledWith('remote:inv'))
    expect(setActiveView).toHaveBeenCalledWith('external-agent')
    expect(setAgentPageMode).toHaveBeenCalledWith('chat')
    await waitFor(() =>
      expect(useCatalogInstallStore.getState().pendingSetup?.installId).toBe('inst-1')
    )
  })

  it('clears a stale install error when the catalog opens, and when it closes', () => {
    useAuthStore.setState({ currentUser: CINNA as never })
    useCatalogInstallStore.setState({ error: { bundleId: 'b', message: 'Quota reached.' } })
    renderList()
    fireEvent.click(screen.getByRole('button', { name: 'Add an agent' }))
    act(() => newAgentProps!.onCatalog!())
    expect(catalogProps!.installError).toBeNull()

    act(() => useCatalogInstallStore.setState({ error: { bundleId: 'b', message: 'Again.' } }))
    expect(catalogProps!.installError?.message).toBe('Again.')
    act(() => catalogProps!.onClose())
    expect(screen.queryByRole('dialog', { name: 'Agent catalog' })).toBeNull()
    expect(useCatalogInstallStore.getState().error).toBeNull()
  })

  it('closes the catalog when the profile changes', () => {
    useAuthStore.setState({ currentUser: CINNA as never })
    renderList()
    fireEvent.click(screen.getByRole('button', { name: 'Add an agent' }))
    act(() => newAgentProps!.onCatalog!())
    expect(screen.getByRole('dialog', { name: 'Agent catalog' })).toBeTruthy()
    act(() => useAuthStore.setState({ currentUser: { ...CINNA, id: 'p2' } as never }))
    expect(screen.queryByRole('dialog', { name: 'Agent catalog' })).toBeNull()
    // And it stays closed on the way back.
    act(() => useAuthStore.setState({ currentUser: CINNA as never }))
    expect(screen.queryByRole('dialog', { name: 'Agent catalog' })).toBeNull()
  })

  it('opens an installed agent from the catalog', () => {
    useAuthStore.setState({ currentUser: CINNA as never })
    renderList()
    fireEvent.click(screen.getByRole('button', { name: 'Add an agent' }))
    act(() => newAgentProps!.onCatalog!())
    act(() => catalogProps!.onOpen('remote:other'))
    expect(setActiveExternalAgentId).toHaveBeenCalledWith('remote:other')
    expect(setActiveView).toHaveBeenCalledWith('external-agent')
    expect(screen.queryByRole('dialog', { name: 'Agent catalog' })).toBeNull()
  })
})
