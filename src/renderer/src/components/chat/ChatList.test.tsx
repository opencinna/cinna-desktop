import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatListSummary } from '../../../../shared/chatListSummary'

/**
 * The tooltip's data reaches the rows through its own query, not the list's:
 * `chat:list` is polled every second and must stay cheap.
 */

const list = vi.fn()
const listSummaries = vi.fn()
;(window as unknown as { api: unknown }).api = {
  app: { setTheme: vi.fn().mockResolvedValue(undefined) },
  run: { cancelChat: vi.fn() },
  chat: { list, listSummaries, delete: vi.fn(), onTitleUpdated: () => () => {} }
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
vi.mock('../../hooks/useLocalAgents', () => ({ useLocalAgents: () => ({ data: { roots: [], agents: [] } }) }))

const { ChatList } = await import('./ChatList')
const { useUIStore } = await import('../../stores/ui.store')

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
  useUIStore.setState({ chatGroupByAgent: false, chatGroupByDate: false, chatGroupCollapsed: {}, revealChatId: null, pendingAgentId: null, pendingModeId: null })
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  list.mockReset().mockResolvedValue(chats)
  listSummaries.mockReset().mockResolvedValue({ 'c-1': summary })
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
    fireEvent.click(screen.getByRole('button', { name: 'Group chats' }))
    return screen.getByRole('menu', { name: 'Group chats' })
  }

  it('groups by agent from the menu, checked while on, and falls back for a row with no summary', async () => {
    const menu = await openMenu()
    const byAgent = within(menu).getByRole('menuitemcheckbox', { name: 'Group by Agent' })
    expect(byAgent.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(byAgent)
    // Stays open, and says it is on.
    expect(within(screen.getByRole('menu', { name: 'Group chats' })).getByRole('menuitemcheckbox', { name: 'Group by Agent' }).getAttribute('aria-checked')).toBe('true')
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
    const [byAgent, byDate] = within(menu).getAllByRole('menuitemcheckbox')
    await waitFor(() => expect(document.activeElement).toBe(byAgent))
    fireEvent.keyDown(window, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(byDate)
    fireEvent.keyDown(window, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(byAgent)
    fireEvent.keyDown(window, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(byDate)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Group chats' }))
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
