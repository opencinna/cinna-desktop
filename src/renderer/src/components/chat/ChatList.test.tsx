import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatListSummary } from '../../../../shared/chatListSummary'

/**
 * The tooltip's data reaches the rows through its own query, not the list's:
 * `chat:list` is polled every second and must stay cheap.
 */

const list = vi.fn()
const listSummaries = vi.fn()
const rename = vi.fn()
const setPinned = vi.fn()
const move = vi.fn()
const deleteChat = vi.fn()
;(window as unknown as { api: unknown }).api = {
  app: { setTheme: vi.fn().mockResolvedValue(undefined) },
  run: { cancelChat: vi.fn() },
  chat: { list, listSummaries, delete: deleteChat, rename, setPinned, move, onTitleUpdated: () => () => {} }
}
vi.mock('../../hooks/useStartNewChat', () => ({ useStartNewChat: () => () => {} }))
// The renderer's own lists group a row whose summary has not loaded yet.
const fallback = vi.hoisted(() => ({
  agents: [
    { id: 'a-writer', name: 'Writer', source: 'local', driver: null, protocol: 'a2a', enabled: true },
    // Listed but switched off: its group offers no new chat.
    { id: 'a-research', name: 'Research Agent', source: 'local', driver: null, protocol: 'a2a', enabled: false }
  ],
  modes: [{ id: 'm-research', name: 'Research', colorPreset: 'violet' }]
}))
vi.mock('../../hooks/useAgents', () => ({ useAgents: () => ({ data: fallback.agents }) }))
vi.mock('../../hooks/useChatModes', () => ({ useChatModes: () => ({ data: fallback.modes }) }))
// One folder agent: its chats offer Open Folder.
const folder = vi.hoisted(() => ({ agents: [{ id: 'folder:notes', readiness: 'ready' }], openPath: vi.fn() }))
vi.mock('../../hooks/useLocalAgents', () => ({
  useLocalAgents: () => ({ data: { roots: [], agents: folder.agents } }),
  useOpenAgentPath: () => ({ mutateAsync: folder.openPath })
}))

const { ChatList } = await import('./ChatList')
const { listRank } = await import('./chatGroups')
const { useUIStore } = await import('../../stores/ui.store')
const { useChatStore } = await import('../../stores/chat.store')

const chats = [
  { id: 'c-1', title: 'First chat', updatedAt: new Date(), createdAt: new Date() },
  { id: 'c-2', title: 'Second chat', updatedAt: new Date(), createdAt: new Date() }
]
const summary: ChatListSummary = {
  with: { kind: 'agent', name: 'Research Agent', color: null, agentId: 'a-research' },
  others: [],
  firstMessageAt: new Date(2026, 8, 12, 14, 0),
  lastMessageAt: new Date(2026, 8, 12, 14, 25),
  messageCount: 14
}
let client: QueryClient

beforeEach(() => {
  localStorage.clear()
  useUIStore.setState({ chatGroupByAgent: false, chatGroupByDate: false, chatShowActive: true, chatGroupCollapsed: {}, revealChatId: null, pendingAgentId: null, pendingModeId: null })
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  list.mockReset().mockResolvedValue(chats)
  listSummaries.mockReset().mockResolvedValue({ 'c-1': summary })
  rename.mockReset().mockResolvedValue({ success: true })
  setPinned.mockReset().mockResolvedValue({ pinnedRank: 1 })
  move.mockReset().mockResolvedValue({ success: true })
  deleteChat.mockReset().mockResolvedValue({ success: true })
  folder.openPath.mockReset().mockResolvedValue({ success: true })
})
afterEach(() => client.clear())

function view() {
  return <QueryClientProvider client={client}><ChatList /></QueryClientProvider>
}

it('hands each row its own summary, and a row without one gets no tooltip', async () => {
  render(view())
  await waitFor(() => expect(screen.getByText('First chat')).toBeTruthy())
  await waitFor(() => expect(listSummaries).toHaveBeenCalledTimes(1))
  await waitFor(() => expect(client.getQueryData(['chats', 'summaries'])).toBeTruthy())

  fireEvent.mouseEnter(screen.getByText('First chat').parentElement!)
  expect(screen.getByRole('tooltip').textContent).toContain('Research Agent')
  fireEvent.mouseLeave(screen.getByText('First chat').parentElement!)

  fireEvent.mouseEnter(screen.getByText('Second chat').parentElement!)
  expect(screen.queryByRole('tooltip')).toBeNull()
})

it('shows the rows before the summaries arrive, without tooltips', async () => {
  listSummaries.mockReturnValue(new Promise(() => {}))
  render(view())
  await waitFor(() => expect(screen.getByText('First chat')).toBeTruthy())
  fireEvent.mouseEnter(screen.getByText('First chat').parentElement!)
  expect(screen.queryByRole('tooltip')).toBeNull()
})

it('is never polled, refreshes with every invalidation of the list, and is left alone by the list\'s exact-key writes', async () => {
  render(view())
  await waitFor(() => expect(listSummaries).toHaveBeenCalledTimes(1))
  await waitFor(() => expect(client.getQueryData(['chats', 'summaries'])).toBeTruthy())

  const query = client.getQueryCache().find({ queryKey: ['chats', 'summaries'] })!
  expect(query.observers.length).toBe(1)
  expect(query.observers[0].options.refetchInterval).toBeUndefined()
  // The list beside it is the polled one.
  expect(client.getQueryCache().find({ queryKey: ['chats'], exact: true })!.observers[0].options.refetchInterval).toBe(1_000)

  // What useLiveRunWatch and useReadChatResult do to the list.
  await act(async () => {
    await client.cancelQueries({ queryKey: ['chats'], exact: true })
    client.setQueryData(['chats'], (rows: typeof chats | undefined) => rows?.map((row) => ({ ...row, activeRunId: 'run-1' })))
  })
  expect(client.getQueryData(['chats', 'summaries'])).toEqual({ 'c-1': summary })
  expect(listSummaries).toHaveBeenCalledTimes(1)

  // What every create/delete/turn-end does.
  await act(async () => { await client.invalidateQueries({ queryKey: ['chats'] }) })
  expect(listSummaries).toHaveBeenCalledTimes(2)
})

it('refreshes the summaries once when background turns end, and not on first load or while they run', async () => {
  const withRuns = (a: string | null, b: string | null) => [{ ...chats[0], activeRunId: a }, { ...chats[1], activeRunId: b }]
  list.mockResolvedValue(withRuns('run-1', 'run-2'))
  render(view())
  await waitFor(() => expect(screen.getByText('First chat')).toBeTruthy())
  await waitFor(() => expect(client.getQueryData(['chats', 'summaries'])).toBeTruthy())
  expect(listSummaries).toHaveBeenCalledTimes(1)

  // Still running: a new poll result changes nothing.
  await act(async () => { client.setQueryData(['chats'], withRuns('run-1', 'run-2')) })
  expect(listSummaries).toHaveBeenCalledTimes(1)

  // Both end in the same result: one refresh, not one per row.
  await act(async () => { client.setQueryData(['chats'], withRuns(null, null)) })
  await waitFor(() => expect(listSummaries).toHaveBeenCalledTimes(2))

  // Idle results after that, and a run starting, refresh nothing.
  await act(async () => { client.setQueryData(['chats'], withRuns(null, null)) })
  await act(async () => { client.setQueryData(['chats'], withRuns('run-3', null)) })
  expect(listSummaries).toHaveBeenCalledTimes(2)
})

describe('grouping', () => {
  const day = 86_400_000
  const grouped = [
    { id: 'g-1', title: 'Agent today', agentId: 'a-research', modeId: null, updatedAt: new Date(), createdAt: new Date() },
    { id: 'g-2', title: 'Mode old', agentId: null, modeId: 'm-research', updatedAt: new Date(Date.now() - 30 * day), createdAt: new Date() },
    // No summary yet: grouped by the renderer's agent list.
    { id: 'g-3', title: 'Writer fresh', agentId: 'a-writer', modeId: null, updatedAt: new Date(), createdAt: new Date() }
  ]
  const at = (date: Date): ChatListSummary => ({ ...summary, firstMessageAt: date, lastMessageAt: date })
  beforeEach(() => {
    list.mockResolvedValue(grouped)
    listSummaries.mockResolvedValue({
      'g-1': at(new Date()),
      'g-2': { ...at(new Date(Date.now() - 30 * day)), with: { kind: 'mode', name: 'Research', color: 'violet', modeId: 'm-research' } }
    })
  })

  async function openMenu() {
    render(view())
    await waitFor(() => expect(client.getQueryData(['chats', 'summaries'])).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Chats list options' }))
    return screen.getByRole('menu', { name: 'Chats list options' })
  }

  it('groups by agent from the menu, checked while on, and falls back for a row with no summary', async () => {
    const menu = await openMenu()
    const byAgent = within(menu).getByRole('menuitemcheckbox', { name: 'Group by Agent' })
    expect(byAgent.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(byAgent)
    // Stays open, and says it is on.
    expect(within(screen.getByRole('menu', { name: 'Chats list options' })).getByRole('menuitemcheckbox', { name: 'Group by Agent' }).getAttribute('aria-checked')).toBe('true')
    expect(localStorage.getItem('cinna-chat-group-by-agent')).toBe('1')

    // The count is in the name, not beside it.
    expect(screen.getByRole('button', { name: 'Research Agent', expanded: true })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Research', expanded: true })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Writer', expanded: true })).toBeTruthy()
    // A disabled agent's group keeps its count and offers no new chat.
    expect(screen.queryByRole('button', { name: 'Start a new chat with Research Agent' })).toBeNull()

    // A header's click folds it; its start button does not.
    fireEvent.click(screen.getByRole('button', { name: 'Start a new chat with Writer' }))
    expect(useUIStore.getState().pendingAgentId).toBe('a-writer')
    expect(screen.getByText('Writer fresh')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Research', expanded: true }))
    expect(screen.queryByText('Mode old')).toBeNull()
    expect(useUIStore.getState().chatGroupCollapsed).toEqual({ 'mode:m-research': true })

    fireEvent.click(screen.getByRole('button', { name: 'Start a new chat in Research' }))
    expect(useUIStore.getState().pendingModeId).toBe('m-research')
  })

  it('groups by the last message\'s day, and nests days inside agents when both are on', async () => {
    const menu = await openMenu()
    fireEvent.click(within(menu).getByRole('menuitemcheckbox', { name: 'Group by Date' }))
    expect(screen.getByRole('button', { name: 'Today', expanded: true })).toBeTruthy()
    // Older history starts closed beside another day, and opens on a click.
    expect(screen.getByRole('button', { name: 'Previous chats', expanded: false })).toBeTruthy()
    expect(screen.queryByText('Mode old')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Previous chats' }))
    expect(screen.getByText('Mode old')).toBeTruthy()
    expect(useUIStore.getState().chatGroupCollapsed).toEqual({ 'all|previous': false })
    // Empty days are not shown.
    expect(screen.queryByRole('button', { name: /^Yesterday/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Research Agent/ })).toBeNull()

    fireEvent.click(within(menu).getByRole('menuitemcheckbox', { name: 'Group by Agent' }))
    // One "Today" inside each of the two agent groups with a chat today.
    expect(screen.getAllByRole('button', { name: 'Today' })).toHaveLength(2)
    // The mode group's only day is Previous chats: alone, it starts open.
    expect(screen.getByRole('button', { name: 'Previous chats', expanded: true })).toBeTruthy()
    expect(screen.getByText('Mode old')).toBeTruthy()
  })

  it('is a menu to the keyboard: first item focused, arrows move, Escape returns to the trigger', async () => {
    const menu = await openMenu()
    const [byAgent, byDate, showActive] = within(menu).getAllByRole('menuitemcheckbox')
    await waitFor(() => expect(document.activeElement).toBe(byAgent))
    fireEvent.keyDown(window, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(byDate)
    fireEvent.keyDown(window, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(showActive)
    fireEvent.keyDown(window, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(byAgent)
    fireEvent.keyDown(window, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(showActive)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Chats list options' }))
  })

  it('opens a collapsed group when one of its chats is to be shown', async () => {
    useUIStore.setState({ chatGroupByAgent: true, chatGroupByDate: true, chatGroupCollapsed: { 'mode:m-research': true, 'mode:m-research|previous': true, 'agent:a-writer': true } })
    render(view())
    await waitFor(() => expect(client.getQueryData(['chats', 'summaries'])).toBeTruthy())
    expect(screen.queryByText('Mode old')).toBeNull()
    act(() => useUIStore.getState().setRevealChatId('g-2'))
    await waitFor(() => expect(screen.getByText('Mode old')).toBeTruthy())
    expect(useUIStore.getState().chatGroupCollapsed).toEqual({ 'mode:m-research': false, 'mode:m-research|previous': false, 'agent:a-writer': true })
  })
})

describe('Pinned, the row menu and drag order', () => {
  const minute = 60_000
  const base = Date.now()
  const rows = [
    { id: 'p-1', title: 'Pinned low', agentId: 'a-writer', modeId: null, pinnedRank: 1, sortKey: null, updatedAt: new Date(base), createdAt: new Date() },
    { id: 'r-1', title: 'Recent', agentId: 'folder:notes', modeId: null, pinnedRank: null, sortKey: null, updatedAt: new Date(base - minute), createdAt: new Date() },
    { id: 'p-2', title: 'Pinned high', agentId: null, modeId: 'm-research', pinnedRank: 2, sortKey: null, updatedAt: new Date(base - 2 * minute), createdAt: new Date() },
    { id: 'r-2', title: 'Older', agentId: 'a-writer', modeId: null, pinnedRank: null, sortKey: null, updatedAt: new Date(base - 3 * minute), createdAt: new Date() },
    { id: 'r-3', title: 'Oldest', agentId: 'a-writer', modeId: null, pinnedRank: null, sortKey: null, updatedAt: new Date(base - 4 * minute), createdAt: new Date() }
  ]
  beforeEach(() => {
    list.mockResolvedValue(rows)
    listSummaries.mockResolvedValue({})
  })
  const titles = (): string[] => [...document.querySelectorAll('[data-chat-row]')].map((row) => row.textContent ?? '')
  const rowOf = (title: string): HTMLElement => screen.getByText(title).closest('[data-chat-row]') as HTMLElement

  async function shown() {
    render(view())
    await waitFor(() => expect(screen.getByText('Recent')).toBeTruthy())
  }

  it('draws Pinned first, flat by rank, and keeps pinned chats out of the groups below', async () => {
    await shown()
    expect(screen.getByRole('button', { name: 'Pinned', expanded: true })).toBeTruthy()
    expect(titles()).toEqual(['Pinned high', 'Pinned low', 'Recent', 'Older', 'Oldest'])

    act(() => useUIStore.setState({ chatGroupByAgent: true, chatGroupByDate: true }))
    // Pinned is still one flat list at the head; the Writer group holds only its unpinned chats.
    expect(titles().slice(0, 2)).toEqual(['Pinned high', 'Pinned low'])
    const header = screen.getAllByRole('button').find((b) => b.hasAttribute('data-chat-group'))!
    expect(header.textContent).toBe('Pinned')
    expect(screen.queryByRole('button', { name: 'Research' })).toBeNull()
    expect(titles()).toHaveLength(5)
  })

  it('draws no Pinned block when nothing is pinned', async () => {
    list.mockResolvedValue(rows.map((row) => ({ ...row, pinnedRank: null })))
    await shown()
    expect(screen.queryByRole('button', { name: 'Pinned' })).toBeNull()
  })

  it('opens a menu at the row with Pin, Rename, Open Folder and Delete — Open Folder only for a folder agent', async () => {
    await shown()
    fireEvent.contextMenu(rowOf('Recent'), { clientX: 40, clientY: 50 })
    const menu = screen.getByRole('menu', { name: 'Chat actions' })
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Pin', 'Rename', 'Open Folder', 'Delete'])
    await waitFor(() => expect(document.activeElement).toBe(within(menu).getByRole('menuitem', { name: 'Pin' })))
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(within(menu).getByRole('menuitem', { name: 'Rename' }))
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Open Folder' }))
    await waitFor(() => expect(folder.openPath).toHaveBeenCalledWith({ agentId: 'folder:notes' }))
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())

    fireEvent.contextMenu(rowOf('Pinned low'))
    const pinnedMenu = screen.getByRole('menu', { name: 'Chat actions' })
    expect(within(pinnedMenu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Unpin', 'Rename', 'Delete'])
    fireEvent.keyDown(pinnedMenu, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()

    fireEvent.contextMenu(rowOf('Older'))
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('pins and unpins from the menu', async () => {
    await shown()
    fireEvent.contextMenu(rowOf('Older'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pin' }))
    await waitFor(() => expect(setPinned).toHaveBeenCalledWith('r-2', true))
    fireEvent.contextMenu(rowOf('Pinned high'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Unpin' }))
    await waitFor(() => expect(setPinned).toHaveBeenCalledWith('p-2', false))
  })

  it('renames in place: Enter commits a trimmed new title, Escape and an unchanged title do nothing', async () => {
    await shown()
    fireEvent.contextMenu(rowOf('Older'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    const input = screen.getByRole('textbox', { name: 'Chat title' }) as HTMLInputElement
    expect(document.activeElement).toBe(input)
    fireEvent.change(input, { target: { value: '  Renamed  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(rename).toHaveBeenCalledWith('r-2', 'Renamed'))
    expect(screen.queryByRole('textbox', { name: 'Chat title' })).toBeNull()

    fireEvent.contextMenu(rowOf('Oldest'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    const second = screen.getByRole('textbox', { name: 'Chat title' })
    fireEvent.change(second, { target: { value: 'Something else' } })
    fireEvent.keyDown(second, { key: 'Escape' })
    expect(screen.queryByRole('textbox', { name: 'Chat title' })).toBeNull()

    fireEvent.contextMenu(rowOf('Oldest'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    const third = screen.getByRole('textbox', { name: 'Chat title' })
    fireEvent.change(third, { target: { value: '   ' } })
    fireEvent.blur(third)
    expect(rename).toHaveBeenCalledTimes(1)
  })

  it('disables Delete for a running chat', async () => {
    list.mockResolvedValue(rows.map((row) => (row.id === 'r-1' ? { ...row, activeRunId: 'run-1' } : row)))
    await shown()
    fireEvent.contextMenu(rowOf('Recent'))
    expect((screen.getByRole('menuitem', { name: 'Delete' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    fireEvent.contextMenu(rowOf('Older'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    await waitFor(() => expect(deleteChat).toHaveBeenCalledWith('r-2'))
  })

  /** jsdom has no DragEvent, so a pointer position has to be set on the event by hand. */
  function dragEvent(kind: 'dragOver' | 'drop', target: HTMLElement, dataTransfer: object, clientY: number): boolean {
    const event = createEvent[kind](target, { dataTransfer })
    Object.defineProperty(event, 'clientY', { value: clientY })
    return fireEvent(target, event)
  }
  function dragTo(from: string, to: string, half: 'top' | 'bottom') {
    const source = rowOf(from)
    const target = rowOf(to)
    target.getBoundingClientRect = () => ({ top: 100, bottom: 120, height: 20, left: 0, right: 200, width: 200, x: 0, y: 100, toJSON: () => ({}) })
    const dataTransfer = { setData: vi.fn(), getData: vi.fn(), effectAllowed: '', dropEffect: '' }
    fireEvent.dragStart(source, { dataTransfer })
    const y = half === 'top' ? 105 : 115
    const accepted = dragEvent('dragOver', target, dataTransfer, y)
    return { source, target, drop: () => dragEvent('drop', target, dataTransfer, y), accepted }
  }

  it('moves a chat between its neighbours inside its group, and the row stays where it was dropped', async () => {
    // Main keeps what it was sent, as the next poll will show.
    move.mockImplementation(async (chatId: string, { rank }: { rank: number }) => {
      list.mockResolvedValue(rows.map((row) => (row.id === chatId ? { ...row, sortKey: rank } : row)))
      return { success: true }
    })
    await shown()
    const { target, drop, accepted } = dragTo('Oldest', 'Recent', 'bottom')
    // `false`: the dragover was cancelled, which is what accepts a drop.
    expect(accepted).toBe(false)
    expect(target.querySelector('[data-drop-indicator="after"]')).toBeTruthy()
    drop()
    const midpoint = (listRank(rows[1]) + listRank(rows[3])) / 2
    await waitFor(() => expect(move).toHaveBeenCalledWith('r-3', { list: 'chats', rank: midpoint }))
    await waitFor(() => expect(titles().slice(2)).toEqual(['Recent', 'Oldest', 'Older']))
  })

  it('moves inside Pinned by the pinned rank', async () => {
    await shown()
    const { target, drop } = dragTo('Pinned low', 'Pinned high', 'top')
    expect(target.querySelector('[data-drop-indicator="before"]')).toBeTruthy()
    drop()
    await waitFor(() => expect(move).toHaveBeenCalledWith('p-1', { list: 'pinned', rank: 3 }))
  })

  it('shows a failed rename in the row, and the new title while it is on its way', async () => {
    let fail!: (error: Error) => void
    rename.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject }))
    await shown()
    fireEvent.contextMenu(rowOf('Older'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    const input = screen.getByRole('textbox', { name: 'Chat title' })
    fireEvent.change(input, { target: { value: 'Pending title' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByText('Pending title')).toBeTruthy()
    await waitFor(() => expect(rename).toHaveBeenCalledWith('r-2', 'Pending title'))
    await act(async () => fail(new Error('A chat needs a title.')))
    await waitFor(() => expect(within(rowOf('Older')).getByRole('alert').textContent).toBe('A chat needs a title.'))
  })

  it('writes nothing where no rank fits between the neighbours, says so, and clears the notice', async () => {
    list.mockResolvedValue(rows.map((row) => (row.id === 'r-1' ? { ...row, sortKey: 2 ** 53 } : row.id === 'r-2' ? { ...row, sortKey: 2 ** 53 - 1 } : row)))
    await shown()
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const { drop } = dragTo('Oldest', 'Recent', 'bottom')
      drop()
      expect(move).not.toHaveBeenCalled()
      expect(screen.getByRole('alert').textContent).toBe("Couldn't place the chat there — try another spot")
      // Over the list, not in it: the rows keep their place.
      expect(screen.getByRole('alert').className).toContain('absolute')
      await act(async () => { vi.advanceTimersByTime(4_100) })
      expect(screen.queryByRole('alert')).toBeNull()
    } finally { vi.useRealTimers() }
  })

  it('places a drop by the pointer at the drop, even after a dragleave cleared the line', async () => {
    await shown()
    const { target } = dragTo('Pinned high', 'Pinned low', 'top')
    // A leave onto a child reports no relatedTarget.
    fireEvent.dragLeave(target, { relatedTarget: null })
    const event = createEvent.drop(target, { dataTransfer: {} })
    Object.defineProperty(event, 'clientY', { value: 115 })
    fireEvent(target, event)
    await waitFor(() => expect(move).toHaveBeenCalledWith('p-2', { list: 'pinned', rank: 0 }))
  })

  it('ends a drag from the document when the dragged row lost its own dragend', async () => {
    await shown()
    fireEvent.dragStart(rowOf('Older'), { dataTransfer: { setData: vi.fn(), effectAllowed: '' } })
    expect(rowOf('Older').className).toContain('opacity-40')
    act(() => { document.dispatchEvent(new Event('dragend')) })
    expect(rowOf('Older').className).not.toContain('opacity-40')
  })

  it('opens no tooltip on another row while a row menu is open', async () => {
    listSummaries.mockResolvedValue({ 'r-1': summary })
    await shown()
    await waitFor(() => expect(client.getQueryData(['chats', 'summaries'])).toBeTruthy())
    fireEvent.contextMenu(rowOf('Older'))
    fireEvent.mouseEnter(rowOf('Recent'))
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    fireEvent.mouseLeave(rowOf('Recent'))
    fireEvent.mouseEnter(rowOf('Recent'))
    expect(screen.getByRole('tooltip')).toBeTruthy()
  })

  it('refuses a drop from another group: no line, no accepted dragover', async () => {
    await shown()
    const { target, drop, accepted } = dragTo('Pinned low', 'Recent', 'top')
    expect(accepted).toBe(true)
    expect(target.querySelector('[data-drop-indicator]')).toBeNull()
    drop()
    expect(move).not.toHaveBeenCalled()
  })
})

describe('the Active block', () => {
  const minute = 60_000
  const base = Date.now()
  const row = (id: string, title: string, ago: number, extra: object = {}) =>
    ({ id, title, agentId: 'a-writer', modeId: null, pinnedRank: null, sortKey: null, updatedAt: new Date(base - ago * minute), createdAt: new Date(), ...extra })
  const unread = { lastRunResult: { runId: 'run-1', status: 'completed', unread: true } }
  const read = { lastRunResult: { runId: 'run-1', status: 'completed', unread: false } }
  const rows = [
    row('p-1', 'Pinned busy', 0, { pinnedRank: 1, activeRunId: 'run-9' }),
    row('r-1', 'Fresh', 1),
    row('r-2', 'Done unseen', 2, unread),
    row('r-3', 'Quiet', 3)
  ]
  beforeEach(() => {
    list.mockResolvedValue(rows)
    listSummaries.mockResolvedValue({})
    useChatStore.setState({ activeChatId: null, isStreaming: false })
    useUIStore.setState({ activeView: 'chat' })
  })
  const titles = (): string[] => [...document.querySelectorAll('[data-chat-row]')].map((el) => el.textContent ?? '')
  const activeTitles = (): string[] =>
    [...(screen.queryByRole('group', { name: 'Active' })?.querySelectorAll('[data-chat-row]') ?? [])].map((el) => el.textContent ?? '')
  const scroller = (): HTMLElement => screen.getByText('Fresh').closest('.overflow-y-auto') as HTMLElement
  // Where the pointer is comes from document moves, not enter/leave.
  const pointerOnList = () => fireEvent.mouseMove(scroller())
  const pointerOffList = () => fireEvent.mouseMove(document.body)
  // TanStack tells its observers on a timer: wait it out, or a "nothing moved" would hold before anything rendered.
  const poll = async (next: typeof rows): Promise<void> => {
    await act(async () => {
      client.setQueryData(['chats'], next)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }

  async function shown() {
    render(view())
    await waitFor(() => expect(screen.getByText('Fresh')).toBeTruthy())
  }

  it('draws running and unread chats first, above Pinned, each listed once', async () => {
    await shown()
    expect(activeTitles()).toEqual(['Pinned busy', 'Done unseen'])
    // Its only pinned chat is in Active, so there is no Pinned block.
    expect(screen.queryByRole('button', { name: 'Pinned' })).toBeNull()
    expect(titles()).toEqual(['Pinned busy', 'Done unseen', 'Fresh', 'Quiet'])
  })

  it('draws no block with nothing active, and none while switched off in the menu', async () => {
    await shown()
    fireEvent.click(screen.getByRole('button', { name: 'Chats list options' }))
    const item = within(screen.getByRole('menu', { name: 'Chats list options' })).getByRole('menuitemcheckbox', { name: 'Show Active group' })
    expect(item.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(item)
    expect(localStorage.getItem('cinna-chat-show-active')).toBe('0')
    expect(screen.queryByRole('group', { name: 'Active' })).toBeNull()
    expect(titles()).toEqual(['Pinned busy', 'Fresh', 'Done unseen', 'Quiet'])

    fireEvent.click(item)
    expect(activeTitles()).toEqual(['Pinned busy', 'Done unseen'])
    await poll(rows.map((r) => ({ ...r, activeRunId: null, lastRunResult: null })))
    expect(screen.queryByRole('group', { name: 'Active' })).toBeNull()
  })

  it('changes nothing under the pointer: a read chat and a new run wait until it leaves the list', async () => {
    await shown()
    pointerOnList()
    await poll(rows.map((r) => (r.id === 'r-2' ? { ...r, ...read } : r.id === 'r-3' ? { ...r, activeRunId: 'run-5' } : r)))
    expect(activeTitles()).toEqual(['Pinned busy', 'Done unseen'])
    expect(titles()).toEqual(['Pinned busy', 'Done unseen', 'Fresh', 'Quiet'])

    pointerOffList()
    expect(activeTitles()).toEqual(['Quiet', 'Pinned busy'])
    expect(titles()).toEqual(['Quiet', 'Pinned busy', 'Fresh', 'Done unseen'])
  })

  it('shows a chat opened from the block where it went when it leaves: its group opens and it is revealed', async () => {
    useUIStore.setState({ chatGroupByAgent: true, chatGroupCollapsed: { 'agent:a-writer': true } })
    render(view())
    await waitFor(() => expect(activeTitles()).toEqual(['Pinned busy', 'Done unseen']))
    expect(screen.queryByText('Fresh')).toBeNull()
    fireEvent.click(screen.getByText('Done unseen'))
    expect(useChatStore.getState().activeChatId).toBe('r-2')

    await poll(rows.map((r) => (r.id === 'r-2' ? { ...r, ...read } : r)))
    await waitFor(() => expect(activeTitles()).toEqual(['Pinned busy']))
    await waitFor(() => expect(screen.getByText('Done unseen')).toBeTruthy())
    expect(useUIStore.getState().chatGroupCollapsed['agent:a-writer']).toBe(false)
    // The row took the request; a chat that was not open is not revealed.
    expect(useUIStore.getState().revealChatId).toBeNull()
  })

  it('reveals nothing when a chat that is not open leaves the block', async () => {
    useUIStore.setState({ chatGroupByAgent: true, chatGroupCollapsed: { 'agent:a-writer': true } })
    render(view())
    await waitFor(() => expect(activeTitles()).toEqual(['Pinned busy', 'Done unseen']))
    act(() => useChatStore.setState({ activeChatId: 'r-1' }))
    await poll(rows.map((r) => (r.id === 'r-2' ? { ...r, ...read } : r)))
    await waitFor(() => expect(activeTitles()).toEqual(['Pinned busy']))
    expect(useUIStore.getState().chatGroupCollapsed['agent:a-writer']).toBe(true)
  })

  it('keeps the chat on screen out of the block: its own turn does not move its row', async () => {
    await shown()
    act(() => useChatStore.setState({ activeChatId: 'r-3' }))
    await poll(rows.map((r) => (r.id === 'r-3' ? { ...r, activeRunId: 'run-7' } : r)))
    act(() => useChatStore.setState({ isStreaming: true }))
    expect(activeTitles()).toEqual(['Pinned busy', 'Done unseen'])
    expect(titles()).toEqual(['Pinned busy', 'Done unseen', 'Fresh', 'Quiet'])

    // Looking elsewhere, its turn is news: it joins.
    act(() => useUIStore.setState({ activeView: 'task' }))
    expect(activeTitles()).toEqual(['Quiet', 'Pinned busy', 'Done unseen'])
    // Back on it, it stays in the block until its turn is over and read.
    act(() => useUIStore.setState({ activeView: 'chat' }))
    expect(activeTitles()).toEqual(['Quiet', 'Pinned busy', 'Done unseen'])
  })

  it('does not count a chat opened elsewhere as opened from the block', async () => {
    // Open behind a task page, so it is in the block when the list mounts.
    useUIStore.setState({ chatGroupByAgent: true, chatGroupCollapsed: { 'agent:a-writer': true }, activeView: 'task' })
    useChatStore.setState({ activeChatId: 'r-2' })
    render(view())
    await waitFor(() => expect(activeTitles()).toEqual(['Pinned busy', 'Done unseen']))
    await poll(rows.map((r) => (r.id === 'r-2' ? { ...r, ...read } : r)))
    await waitFor(() => expect(activeTitles()).toEqual(['Pinned busy']))
    expect(useUIStore.getState().chatGroupCollapsed['agent:a-writer']).toBe(true)
  })

  it('holds while a row is being renamed, so the input and its text survive', async () => {
    await shown()
    fireEvent.contextMenu(screen.getByText('Done unseen').closest('[data-chat-row]') as HTMLElement)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    const input = screen.getByRole('textbox', { name: 'Chat title' }) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Half typed' } })
    pointerOffList()
    await poll(rows.map((r) => (r.id === 'r-2' ? { ...r, ...read } : r)))
    expect(activeTitles()).toHaveLength(2)
    expect(screen.getByRole('textbox', { name: 'Chat title' })).toBe(input)
    expect(input.value).toBe('Half typed')

    fireEvent.keyDown(input, { key: 'Escape' })
    await waitFor(() => expect(activeTitles()).toEqual(['Pinned busy']))
  })
})
