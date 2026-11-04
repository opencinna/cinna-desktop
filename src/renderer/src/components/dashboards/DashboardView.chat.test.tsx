import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentInfo, TileView } from '../../../../shared/dashboards'

vi.mock('../../stores/logger.store', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

// The panel's chat workspace, reduced to what the panel hands it: the chat it
// shows, what sits over its composer, and a composer that sends through the
// real `useChatComposer` (so the panel's send extras are what is tested).
vi.mock('../layout/ChatWorkspace', async () => {
  const { useChatComposer } = await import('../../hooks/useChatComposer')
  return {
    ChatWorkspace: ({ chatId, composerTop }: { chatId?: string; composerTop?: React.ReactNode }) => {
      const { submit } = useChatComposer(chatId ?? null)
      return (
        <div data-testid="workspace" data-chat-id={chatId}>
          {composerTop}
          <textarea aria-label="Message" />
          <button type="button" onClick={() => void submit('typed here')}>Send typed</button>
        </div>
      )
    }
  }
})

import { DashboardView } from './DashboardView'
import { SidebarTabs } from '../layout/SidebarTabs'
import { useUIStore } from '../../stores/ui.store'
import { useChatStore } from '../../stores/chat.store'
import { useAuthStore } from '../../stores/auth.store'
import { composerDraftKey, useComposerDraftStore } from '../../stores/composerDraft.store'

function info(over: Partial<ComponentInfo>): ComponentInfo {
  return {
    agentId: 'folder:sales', manifestId: 'sales', agentName: 'Sales Agent', name: 'deals', skill: null, title: 'Deals',
    description: '', view: 'table', size: 'wide', source: { endpoint: 'e' }, maxAge: '15m', refreshCommand: null,
    refresh: { maxAge: '15m', whileOpenEvery: null, afterTurn: false, onAppStart: false, command: null, schedule: null },
    params: {}, prompts: [], valid: true, findings: [], missingCredentials: [],
    ...over
  }
}

function tileView(id: string, title: string, component: ComponentInfo, size: TileView['tile']['size'] = 'wide', params: Record<string, unknown> = {}): TileView {
  return {
    tile: { id, dashboardId: 'd1', agentManifestId: component.manifestId, component: component.name, skill: null, title, size, position: 0, params, refreshOverride: null },
    displayTitle: title,
    state: 'ok',
    component,
    schedule: null
  }
}

const DEALS = tileView('t1', 'Deals pipeline', info({ prompts: [{ label: 'What stalled?', prompt: 'Which deals stalled this month?' }] }), 'wide', { month: '2026-09' })
const TODO = tileView('t2', 'Follow-ups', info({ name: 'todo', view: 'list' }))
const MAIL = tileView('t3', 'Client emails', info({ agentId: 'folder:mail', manifestId: 'mail', agentName: 'Mail agent', name: 'emails', view: 'list' }))

const DATA: Record<string, unknown> = {
  t1: { columns: [{ key: 'name', label: 'Deal' }], rows: [{ id: 'd-17', name: 'Acme' }, { id: 'd-21', name: 'Globex' }, { name: 'Initech' }] },
  t2: { items: [{ id: 'f1', title: 'Call Bob' }, { title: 'Send deck' }] },
  t3: { items: [{ id: 'm1', title: 'Invoice question' }] }
}

const panelChat = vi.fn()
const runStart = vi.fn()

function chatRow(id: string, agentId: string) {
  return { id, title: 'Chat', router: 'direct', agentId, messages: [], activeRunId: null, originatingJobRunId: null }
}

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <DashboardView />
    </QueryClientProvider>
  )
}

/** The sidebar tabs beside the center: the dashboard, or the Chats view. */
function Shell() {
  const view = useUIStore((s) => s.activeView)
  return (
    <>
      <SidebarTabs />
      {view === 'dashboard' ? <DashboardView /> : <div data-testid="chats-view" />}
    </>
  )
}

function showShell() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <Shell />
    </QueryClientProvider>
  )
  return client
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

beforeEach(() => {
  // Main resumes the latest chat for (dashboard, agent); `fresh` starts a new one.
  const latest = new Map<string, string>()
  panelChat.mockReset().mockImplementation(async ({ agentId, fresh }: { agentId: string; fresh?: boolean }) => {
    if (fresh) latest.set(agentId, `fresh-${agentId}`)
    return { ok: true, chatId: latest.get(agentId) ?? `chat-${agentId}` }
  })
  runStart.mockReset().mockResolvedValue({ kind: 'started', runId: 'r1' })
  window.api = {
    dashboards: {
      list: async () => [{ id: 'd1', name: 'Sales overview', sortOrder: 0, tileCount: 3, createdAt: 0, updatedAt: 0 }],
      tiles: async () => ({ ok: true, dashboard: { id: 'd1', name: 'Sales overview', sortOrder: 0, tileCount: 3, createdAt: 0, updatedAt: 0 }, tiles: [DEALS, TODO, MAIL] }),
      tileResult: async (tileId: string) => ({
        ok: true,
        result: { tileId, data: DATA[tileId], fetchedAt: Date.now() - 12 * 60_000, error: null, refreshing: false, stale: false, tooLarge: false, notice: null }
      }),
      ensureFresh: async () => ({ ok: true }),
      lease: async () => ({ ok: true }),
      dropLease: async () => ({ ok: true }),
      onTileChanged: () => () => {},
      highlight: async () => [],
      onTileHighlight: () => () => {},
      clearHighlight: async () => true,
      highlightReady: async () => true,
      panelChat
    },
    chat: {
      get: async (chatId: string) => chatRow(chatId, chatId.replace(/^(chat|fresh)-/, '')),
      list: async () => [{ id: 'other-chat' }, { id: 'chats-view-chat' }, { id: 'chat-folder:sales' }],
      markResultRead: async () => {},
      onTitleUpdated: () => () => {}
    },
    run: { start: runStart, cancel: () => {} },
    system: { openExternal: async () => {} }
  } as never
  useAuthStore.setState({ currentUser: { id: 'alice', type: 'local_user' } as never })
  useUIStore.setState({ activeView: 'dashboard', activeDashboardId: 'd1', dashboardPanelOpen: false, dashboardPanelWidth: 400 })
  useChatStore.getState().setActiveChatId('chats-view-chat')
})

const tileEl = (title: string) => screen.getByRole('group', { name: title })

async function askAbout(title: string) {
  fireEvent.pointerDown(tileEl(title))
  fireEvent.click(within(tileEl(title)).getByRole('button', { name: `Ask about ${title}` }))
}

async function panel() {
  return screen.findByRole('complementary', { name: 'Dashboard chat' })
}

describe('the dashboard chat panel', () => {
  it('Ask focuses the tile with a ring and opens the agent’s chat for this dashboard', async () => {
    show()
    await screen.findByText('Acme')
    expect(tileEl('Deals pipeline').dataset.focused).toBeUndefined()
    await askAbout('Deals pipeline')
    expect(tileEl('Deals pipeline').dataset.focused).toBe('true')
    expect(tileEl('Deals pipeline').className).toContain('ring-2')
    const aside = await panel()
    expect(within(aside).getByText('Sales Agent')).toBeTruthy()
    expect(panelChat).toHaveBeenCalledWith({ dashboardId: 'd1', agentId: 'folder:sales' })
    await waitFor(() => expect(screen.getByTestId('workspace').dataset.chatId).toBe('chat-folder:sales'))
    expect(useChatStore.getState().activeChatId).toBe('chat-folder:sales')
    expect(useUIStore.getState().dashboardPanelOpen).toBe(true)
  })

  it('a tile of the same agent changes only the context; one of another agent switches the chat', async () => {
    show()
    await screen.findByText('Acme')
    await askAbout('Deals pipeline')
    await waitFor(() => expect(screen.getByTestId('workspace').dataset.chatId).toBe('chat-folder:sales'))
    expect(screen.getByTestId('dashboard-context-chip').textContent).toContain('Deals pipeline · Sep 2026')

    fireEvent.pointerDown(tileEl('Follow-ups'))
    await waitFor(() => expect(screen.getByTestId('dashboard-context-chip').textContent).toContain('Follow-ups'))
    expect(panelChat).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('workspace').dataset.chatId).toBe('chat-folder:sales')

    fireEvent.pointerDown(tileEl('Client emails'))
    await waitFor(() => expect(screen.getByTestId('workspace').dataset.chatId).toBe('chat-folder:mail'))
    expect(panelChat).toHaveBeenLastCalledWith({ dashboardId: 'd1', agentId: 'folder:mail' })
    expect(within(await panel()).getByText('Mail agent')).toBeTruthy()
    expect(screen.getByTestId('dashboard-context-chip').textContent).toContain('Client emails')

    // Back to the first agent: its chat is remembered, not asked for again.
    fireEvent.pointerDown(tileEl('Deals pipeline'))
    await waitFor(() => expect(screen.getByTestId('workspace').dataset.chatId).toBe('chat-folder:sales'))
    expect(panelChat).toHaveBeenCalledTimes(2)
  })

  it('click selects a row, ⌘-click adds and removes, Escape clears; keys are the row id, else its index', async () => {
    show()
    await screen.findByText('Acme')
    await askAbout('Deals pipeline')
    await waitFor(() => expect(screen.getByTestId('workspace')).toBeTruthy())
    const row = (name: string) => screen.getByText(name).closest('tr')!
    const chip = () => screen.getByTestId('dashboard-context-chip').textContent

    fireEvent.click(row('Acme'))
    expect(row('Acme').getAttribute('aria-selected')).toBe('true')
    expect(chip()).toContain('1 selected')
    fireEvent.click(row('Initech'), { metaKey: true })
    expect(chip()).toContain('2 selected')
    fireEvent.click(row('Globex'))
    expect(chip()).toContain('1 selected')
    expect(row('Acme').getAttribute('aria-selected')).toBe('false')
    fireEvent.click(row('Initech'), { metaKey: true })
    fireEvent.click(row('Initech'), { metaKey: true })
    expect(chip()).toContain('1 selected')

    fireEvent.click(row('Initech'), { ctrlKey: true })
    fireEvent.click(within(await panel()).getByRole('button', { name: 'Send typed' }))
    await waitFor(() => expect(runStart).toHaveBeenCalled())
    expect(runStart.mock.calls[0][0].dashboardContext.focused.selection).toEqual(['d-21', '2'])

    fireEvent.keyDown(tileEl('Deals pipeline'), { key: 'Escape' })
    expect(row('Globex').getAttribute('aria-selected')).toBe('false')
    expect(chip()).not.toContain('selected')
  })

  it('a send from the panel carries the context; removing the chip sends without it until the selection changes', async () => {
    show()
    await screen.findByText('Acme')
    await askAbout('Deals pipeline')
    const aside = await panel()
    await waitFor(() => expect(screen.getByTestId('workspace')).toBeTruthy())

    fireEvent.click(within(aside).getByRole('button', { name: 'Send typed' }))
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(1))
    const sent = runStart.mock.calls[0][0]
    expect(sent).toMatchObject({ chatId: 'chat-folder:sales', content: 'typed here' })
    expect(sent.dashboardContext).toMatchObject({
      dashboardId: 'd1',
      dashboard: 'Sales overview',
      focused: { tileId: 't1', component: 'deals', title: 'Deals pipeline', params: { month: '2026-09' }, selection: [], dataAge: '12 min' },
      alsoYours: ['Follow-ups'],
      otherTiles: ['Client emails (Mail agent)']
    })
    expect(sent.dashboardContext.focused.summary).toContain('Deal\nAcme')

    fireEvent.click(within(aside).getByRole('button', { name: "Don't send Deals pipeline" }))
    expect(screen.getByTestId('dashboard-context-chip').textContent).toContain('Not sending Deals pipeline')
    fireEvent.click(within(aside).getByRole('button', { name: 'Send typed' }))
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(2))
    expect(runStart.mock.calls[1][0].dashboardContext).toBeUndefined()

    // A new selection brings the context back.
    fireEvent.click(screen.getByText('Globex').closest('tr')!)
    expect(screen.getByTestId('dashboard-context-chip').textContent).toContain('Deals pipeline · Sep 2026 · 1 selected')
    // Only the title is cut short; "· 1 selected" is outside the truncating span.
    const title = screen.getByTestId('dashboard-context-chip-title')
    expect(title.textContent).toBe('Deals pipeline')
    expect(title.className).toContain('truncate')
    fireEvent.click(within(aside).getByRole('button', { name: 'Send typed' }))
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(3))
    expect(runStart.mock.calls[2][0].dashboardContext.focused.selection).toEqual(['d-21'])
  })

  it('a suggested question on the hover bar focuses the tile, opens the panel and sends with the context', async () => {
    show()
    await screen.findByText('Acme')
    fireEvent.click(within(tileEl('Deals pipeline')).getByRole('button', { name: 'What stalled?' }))
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(1))
    expect(useUIStore.getState().dashboardPanelOpen).toBe(true)
    expect(tileEl('Deals pipeline').dataset.focused).toBe('true')
    expect(runStart.mock.calls[0][0]).toMatchObject({
      chatId: 'chat-folder:sales',
      content: 'Which deals stalled this month?',
      dashboardContext: { focused: { tileId: 't1' } }
    })
  })

  it('an empty panel chat shows the focused tile’s questions as starters, and one sends', async () => {
    show()
    await screen.findByText('Acme')
    await askAbout('Deals pipeline')
    const starters = await screen.findByTestId('dashboard-panel-starters')
    expect(runStart).not.toHaveBeenCalled()
    fireEvent.click(within(starters).getByRole('button', { name: 'What stalled?' }))
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(1))
    expect(runStart.mock.calls[0][0].content).toBe('Which deals stalled this month?')
    expect(runStart.mock.calls[0][0].dashboardContext.focused.tileId).toBe('t1')
  })

  it('New chat asks for a fresh one; Open in Chats moves it there; closing gives Chats its own chat back', async () => {
    show()
    await screen.findByText('Acme')
    await askAbout('Deals pipeline')
    const aside = await panel()
    await waitFor(() => expect(screen.getByTestId('workspace').dataset.chatId).toBe('chat-folder:sales'))

    fireEvent.click(within(aside).getByRole('button', { name: 'New chat' }))
    await waitFor(() => expect(screen.getByTestId('workspace').dataset.chatId).toBe('fresh-folder:sales'))
    expect(panelChat).toHaveBeenLastCalledWith({ dashboardId: 'd1', agentId: 'folder:sales', fresh: true })

    fireEvent.click(within(aside).getByRole('button', { name: 'Close chat panel' }))
    expect(screen.queryByRole('complementary', { name: 'Dashboard chat' })).toBeNull()
    expect(useChatStore.getState().activeChatId).toBe('chats-view-chat')

    fireEvent.click(screen.getByRole('button', { name: 'Chat' }))
    await waitFor(() => expect(useChatStore.getState().activeChatId).toBe('fresh-folder:sales'))
    await act(async () => fireEvent.click(within(await panel()).getByRole('button', { name: 'Open in Chats' })))
    expect(useUIStore.getState()).toMatchObject({ activeView: 'chat', sidebarTab: 'chats', dashboardPanelOpen: false })
    expect(useChatStore.getState().activeChatId).toBe('fresh-folder:sales')
  })

  it('panelChat refusing says why in the panel', async () => {
    panelChat.mockResolvedValue({ ok: false, code: 'agent_not_found', message: 'Sales Agent is not on this computer.' })
    show()
    await screen.findByText('Acme')
    await askAbout('Deals pipeline')
    expect((await screen.findByRole('alert')).textContent).toBe('Sales Agent is not on this computer.')
  })

  it('the Chats tab opens the Chats view’s own chat, not the panel’s', async () => {
    // Mutation: read `activeChatId` instead of the stash in SidebarTabs and
    // this lands on the panel's chat.
    useUIStore.setState({ sidebarTab: 'dashboards' })
    const client = showShell()
    await screen.findByText('Acme')
    await askAbout('Deals pipeline')
    await waitFor(() => expect(useChatStore.getState().activeChatId).toBe('chat-folder:sales'))
    await waitFor(() => expect(client.getQueryData(['chats'])).toBeTruthy())
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Chats' })))
    expect(screen.getByTestId('chats-view')).toBeTruthy()
    expect(useChatStore.getState().activeChatId).toBe('chats-view-chat')
    expect(useUIStore.getState().dashboardChatsStash).toBeNull()
  })

  it('a link to the panel’s own chat keeps that chat, live, when the panel goes away', async () => {
    // Mutation: restore the stash on unmount whatever the view and this
    // switches the user to a different chat (and drops the running turn).
    const client = showShell()
    void client
    await screen.findByText('Acme')
    await askAbout('Deals pipeline')
    await waitFor(() => expect(useChatStore.getState().activeChatId).toBe('chat-folder:sales'))
    act(() => useChatStore.setState({ isStreaming: true }))
    // What a notification or a task's chat link does.
    act(() => {
      useChatStore.getState().setActiveChatId('chat-folder:sales')
      useUIStore.getState().setSidebarTab('chats')
      useUIStore.getState().setActiveView('chat')
    })
    expect(screen.getByTestId('chats-view')).toBeTruthy()
    expect(useChatStore.getState().activeChatId).toBe('chat-folder:sales')
    expect(useChatStore.getState().isStreaming).toBe(true)
  })

  it('switching dashboards with the panel open never opens a chat for the old agent there', async () => {
    const D2 = { id: 'd2', name: 'Inbox', sortOrder: 1, tileCount: 1, createdAt: 0, updatedAt: 0 }
    const MAIL2 = { ...MAIL, tile: { ...MAIL.tile, id: 't9', dashboardId: 'd2' } }
    const api = window.api as unknown as { dashboards: Record<string, unknown> }
    api.dashboards.tiles = async (id: string) =>
      id === 'd2'
        ? { ok: true, dashboard: D2, tiles: [MAIL2] }
        : { ok: true, dashboard: { id: 'd1', name: 'Sales overview', sortOrder: 0, tileCount: 3, createdAt: 0, updatedAt: 0 }, tiles: [DEALS, TODO, MAIL] }
    show()
    await screen.findByText('Acme')
    await askAbout('Deals pipeline')
    await waitFor(() => expect(screen.getByTestId('workspace').dataset.chatId).toBe('chat-folder:sales'))

    act(() => useUIStore.getState().setActiveDashboardId('d2'))
    await screen.findByRole('group', { name: 'Client emails' })
    expect(panelChat).not.toHaveBeenCalledWith({ dashboardId: 'd2', agentId: 'folder:sales' })
    expect(within(await panel()).getByText('Click a tile to ask its agent about it.')).toBeTruthy()

    // Back: the first dashboard's panel is as it was left.
    act(() => useUIStore.getState().setActiveDashboardId('d1'))
    await waitFor(() => expect(screen.getByTestId('workspace').dataset.chatId).toBe('chat-folder:sales'))
    expect(panelChat.mock.calls.every(([arg]) => arg.dashboardId === 'd1')).toBe(true)
  })

  it('a New chat answered after the focus moved to another agent leaves the panel on that agent', async () => {
    show()
    await screen.findByText('Acme')
    await askAbout('Deals pipeline')
    const aside = await panel()
    await waitFor(() => expect(screen.getByTestId('workspace').dataset.chatId).toBe('chat-folder:sales'))
    const late = deferred<{ ok: true; chatId: string }>()
    panelChat.mockImplementationOnce(() => late.promise)
    fireEvent.click(within(aside).getByRole('button', { name: 'New chat' }))
    fireEvent.pointerDown(tileEl('Client emails'))
    await waitFor(() => expect(screen.getByTestId('workspace').dataset.chatId).toBe('chat-folder:mail'))
    await act(async () => late.resolve({ ok: true, chatId: 'fresh-folder:sales' }))
    expect(screen.getByTestId('workspace').dataset.chatId).toBe('chat-folder:mail')
    expect(useChatStore.getState().activeChatId).toBe('chat-folder:mail')
    // Its own agent finds the new chat when focused again.
    fireEvent.pointerDown(tileEl('Deals pipeline'))
    await waitFor(() => expect(screen.getByTestId('workspace').dataset.chatId).toBe('fresh-folder:sales'))
  })

  it('a suggested question whose chat could not be opened is dropped, not sent when the panel opens again', async () => {
    panelChat.mockResolvedValueOnce({ ok: false, code: 'agent_not_found', message: 'Sales Agent is not on this computer.' })
    show()
    await screen.findByText('Acme')
    fireEvent.click(within(tileEl('Deals pipeline')).getByRole('button', { name: 'What stalled?' }))
    await screen.findByRole('alert')
    fireEvent.click(within(await panel()).getByRole('button', { name: 'Close chat panel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }))
    await waitFor(() => expect(screen.getByTestId('workspace').dataset.chatId).toBe('chat-folder:sales'))
    await act(async () => {})
    expect(runStart).not.toHaveBeenCalled()
  })

  it('a suggested question is dropped when the focus moves to another agent before its chat opens', async () => {
    const slow = deferred<{ ok: true; chatId: string }>()
    panelChat.mockImplementationOnce(() => slow.promise)
    show()
    await screen.findByText('Acme')
    fireEvent.click(within(tileEl('Deals pipeline')).getByRole('button', { name: 'What stalled?' }))
    await panel()
    fireEvent.pointerDown(tileEl('Client emails'))
    await waitFor(() => expect(screen.getByTestId('workspace').dataset.chatId).toBe('chat-folder:mail'))
    await act(async () => slow.resolve({ ok: true, chatId: 'chat-folder:sales' }))
    fireEvent.pointerDown(tileEl('Deals pipeline'))
    await waitFor(() => expect(screen.getByTestId('workspace').dataset.chatId).toBe('chat-folder:sales'))
    await act(async () => {})
    expect(runStart).not.toHaveBeenCalled()
  })
})

describe('the dashboard header', () => {
  it('a failed tile move says why under the title; the next move clears it', async () => {
    const moveTile = vi.fn().mockResolvedValueOnce({ ok: false, code: 'not_found', message: 'That tile is gone.' }).mockResolvedValue({ ok: true })
    ;(window.api as unknown as { dashboards: Record<string, unknown> }).dashboards.moveTile = moveTile
    show()
    await screen.findByText('Acme')
    fireEvent.click(screen.getByRole('button', { name: 'Edit layout' }))
    const drag = () => {
      const target = tileEl('Client emails')
      ;(document as unknown as { elementsFromPoint: () => Element[] }).elementsFromPoint = () => [target]
      act(() => { fireEvent.pointerDown(within(tileEl('Deals pipeline')).getByRole('button', { name: 'Move Deals pipeline' })) })
      act(() => { fireEvent.pointerMove(window, { clientX: 10, clientY: 10 }) })
      act(() => { fireEvent.pointerUp(window) })
    }
    drag()
    expect((await screen.findByRole('alert')).textContent).toContain('That tile is gone.')
    expect(moveTile).toHaveBeenCalledWith('t1', 2)
    drag()
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(moveTile).toHaveBeenCalledTimes(2)
  })

  it('Edit layout keeps one width as it turns into Done', async () => {
    show()
    await screen.findByText('Acme')
    const button = screen.getByRole('button', { name: 'Edit layout' })
    expect(button.className).toContain('min-w-[6.5rem]')
    expect(screen.getByRole('heading', { level: 1, name: 'Sales overview' }).className).toContain('text-xl')
  })

  it('a page’s cinna.ask focuses its tile, opens the panel and fills that chat’s composer, never sending', async () => {
    // Mutation: make the fill a send (drop `fill` from the pending prompt) and runStart is called.
    const PAGE = tileView('t4', 'Weekly chart', info({ name: 'chart', view: 'html' }), 'm')
    const api = window.api as unknown as { dashboards: Record<string, unknown> }
    api.dashboards.tiles = async () => ({ ok: true, dashboard: { id: 'd1', name: 'Sales overview', sortOrder: 0, tileCount: 2, createdAt: 0, updatedAt: 0 }, tiles: [DEALS, PAGE] })
    api.dashboards.openFrame = async () => ({ ok: true, token: 'tok', url: 'cinna-preview://dash-h/t4/index.html' })
    api.dashboards.releaseFrame = async () => {}
    show()
    const iframe = (await screen.findByTestId('dashboard-frame')) as HTMLIFrameElement
    const win = iframe.contentWindow!
    const posted: Array<Record<string, unknown>> = []
    vi.spyOn(win, 'postMessage').mockImplementation(((message: unknown) => { posted.push(message as Record<string, unknown>) }) as never)
    const send = (data: Record<string, unknown>) => act(() => { window.dispatchEvent(new MessageEvent('message', { data, origin: 'null', source: win })) })
    send({ jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: {} })
    const nonce = (posted[0].result as { _meta: { cinna: { nonce: string } } })._meta.cinna.nonce
    send({ jsonrpc: '2.0', id: 2, method: 'ui/message', params: { role: 'user', content: [{ type: 'text', text: 'Why did W3 drop?' }], _meta: { cinna: { nonce } } } })
    expect(posted.find((m) => m.id === 2)).toEqual({ jsonrpc: '2.0', id: 2, result: {} })
    expect(useUIStore.getState().dashboardPanelOpen).toBe(true)
    expect(tileEl('Weekly chart').dataset.focused).toBe('true')
    await waitFor(() => expect(screen.getByTestId('workspace').dataset.chatId).toBe('chat-folder:sales'))
    const key = composerDraftKey('alice', 'chat:chat-folder:sales')
    await waitFor(() => expect(useComposerDraftStore.getState().drafts[key]?.text).toBe('Why did W3 drop?'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(runStart).not.toHaveBeenCalled()
  })

  it('the composer gaining focus asks the focused page what is selected; an empty answer drops the quoted text from the chip and the send', async () => {
    // Mutation: drop the panel's onFocus, or keep selectedText on an empty answer, and this fails.
    const PAGE = tileView('t4', 'Weekly chart', info({ name: 'chart', view: 'html' }), 'm')
    const api = window.api as unknown as { dashboards: Record<string, unknown> }
    api.dashboards.tiles = async () => ({ ok: true, dashboard: { id: 'd1', name: 'Sales overview', sortOrder: 0, tileCount: 1, createdAt: 0, updatedAt: 0 }, tiles: [PAGE] })
    api.dashboards.tileResult = async (tileId: string) => ({ ok: true, result: { tileId, data: null, fetchedAt: null, error: null, refreshing: false, stale: false, tooLarge: false, notice: null } })
    api.dashboards.openFrame = async () => ({ ok: true, token: 'tok', url: 'cinna-preview://dash-h/t4/index.html' })
    api.dashboards.releaseFrame = async () => {}
    show()
    const iframe = (await screen.findByTestId('dashboard-frame')) as HTMLIFrameElement
    const win = iframe.contentWindow!
    const posted: Array<Record<string, unknown>> = []
    vi.spyOn(win, 'postMessage').mockImplementation(((message: unknown) => { posted.push(message as Record<string, unknown>) }) as never)
    const send = (data: Record<string, unknown>) => act(() => { window.dispatchEvent(new MessageEvent('message', { data, origin: 'null', source: win })) })
    send({ jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: {} })
    const nonce = (posted[0].result as { _meta: { cinna: { nonce: string } } })._meta.cinna.nonce
    send({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: { _meta: { cinna: { nonce } } } })
    const collects = () => posted.filter((m) => m.method === 'cinna/collect-context')
    const answer = (id: unknown, selectedText: string) =>
      send({ jsonrpc: '2.0', id, result: { source: 'collected', summary: 'Chart', selection: [], visible: [], microdata: [], selected_text: selectedText, _meta: { cinna: { nonce } } } })

    await askAbout('Weekly chart')
    const aside = await panel()
    const composer = await within(aside).findByRole('textbox', { name: 'Message' })
    // Focus moves from the page to the composer: the page is asked, once.
    const asked = collects().length
    fireEvent.focus(composer)
    expect(collects()).toHaveLength(asked + 1)
    answer(collects().at(-1)!.id, 'W3 dropped 40%')
    const chip = screen.getByTestId('dashboard-context-chip')
    await waitFor(() => expect(chip.textContent).toContain('Weekly chart · quoted text'))
    expect(chip.querySelector('[title]')!.getAttribute('title')).toContain('“W3 dropped 40%”')

    // The owner deselected in the page, then came back to the composer.
    fireEvent.focus(composer)
    answer(collects().at(-1)!.id, '')
    await waitFor(() => expect(chip.textContent).not.toContain('quoted text'))
    expect(chip.querySelector('[title]')!.getAttribute('title')).toBe('Sent with your message: what this tile shows')
    fireEvent.click(within(aside).getByRole('button', { name: 'Send typed' }))
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(1))
    expect(runStart.mock.calls[0][0].dashboardContext.focused).not.toHaveProperty('selectedText')
  })
})
