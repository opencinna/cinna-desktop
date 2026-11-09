import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatListSummary } from '../../../../../shared/chatListSummary'
import type { ChatSearchFilter, ChatSearchResult } from '../../../../../shared/chatSearch'

/**
 * All-chats search: results after a pause in typing, chips for the agents the
 * query found, and a result that opens its chat and closes the search.
 */

const search = vi.fn()
;(window as unknown as { api: unknown }).api = {
  app: { setTheme: vi.fn().mockResolvedValue(undefined) },
  chat: { search }
}
const lists = vi.hoisted(() => ({
  chats: [] as { id: string; agentId: string | null; modeId: string | null; updatedAt: Date }[],
  summaries: {} as Record<string, ChatListSummary>
}))
vi.mock('../../../hooks/useChat', () => ({
  useChatList: () => ({ data: lists.chats }),
  useChatSummaries: () => ({ data: lists.summaries })
}))
vi.mock('../../../hooks/useAgents', () => ({ useAgents: () => ({ data: [] }) }))
vi.mock('../../../hooks/useChatModes', () => ({ useChatModes: () => ({ data: [] }) }))

const { AllChatsSearch } = await import('./AllChatsSearch')
const { useChatSearchStore } = await import('../../../stores/chatSearch.store')
const { useChatStore } = await import('../../../stores/chat.store')
const { useUIStore } = await import('../../../stores/ui.store')
const { AgentColorsContext } = await import('../../../utils/agentColors')

const agent = (agentId: string, name: string): ChatListSummary => ({
  with: { kind: 'agent', name, color: null, agentId, source: 'local', driver: null, protocol: 'a2a' },
  others: [], firstMessageAt: null, lastMessageAt: null, messageCount: 0
})
const at = (minute: number): Date => new Date(2026, 9, 1, 9, minute)
const RESULT: ChatSearchResult = {
  truncated: false,
  groups: [
    {
      chatId: 'c-flaky', title: 'Flaky checkout test', total: 1, latestAt: at(30),
      messages: [{ id: 'm-flaky', role: 'assistant', content: 'a retry would hide the race', createdAt: at(30) }]
    },
    {
      chatId: 'c-pg', title: 'Postgres migration plan', total: 5, latestAt: at(20),
      messages: [
        { id: 'm-pg-3', role: 'assistant', content: 'Retry each batch', createdAt: at(20) },
        { id: 'm-pg-2', role: 'user', content: 'And the retry policy?', createdAt: at(19) },
        { id: 'm-pg-1', role: 'assistant', content: 'a failed batch can be retried', createdAt: at(18) }
      ]
    },
    {
      chatId: 'c-q3', title: 'Q3 invoices', total: 1, latestAt: at(10),
      messages: [{ id: 'm-q3', role: 'assistant', content: 'a separate retry of the card charge', createdAt: at(10) }]
    }
  ]
}

/** What main finds for the next search; a filter narrows it by each chat's agent, as main does. */
let served: ChatSearchResult = RESULT
const agentOf = (chatId: string): string | undefined => {
  const who = lists.summaries[chatId]?.with
  return who?.kind === 'agent' ? who.agentId : undefined
}
async function serve(_query: string, filter?: ChatSearchFilter): Promise<ChatSearchResult> {
  if (!filter) return served
  return { ...served, groups: served.groups.filter((group) => filter.agentIds?.includes(agentOf(group.chatId) ?? '')) }
}

let client: QueryClient
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  served = RESULT
  search.mockReset().mockImplementation(serve)
  lists.chats = [
    { id: 'c-flaky', agentId: 'a-platform', modeId: null, updatedAt: at(30) },
    { id: 'c-pg', agentId: 'a-platform', modeId: null, updatedAt: at(20) },
    { id: 'c-q3', agentId: 'a-finance', modeId: null, updatedAt: at(10) }
  ]
  lists.summaries = {
    'c-flaky': agent('a-platform', 'Platform'),
    'c-pg': agent('a-platform', 'Platform'),
    'c-q3': agent('a-finance', 'Finance')
  }
  useChatSearchStore.setState({ scope: 'all', query: '', agents: [], searchableChatId: null, jump: null })
  useChatStore.setState({ activeChatId: null })
  useUIStore.setState({ activeView: 'chat' })
})
afterEach(() => {
  client.clear()
  vi.useRealTimers()
})

function view(colors: ReadonlyMap<string, string> = new Map()) {
  return render(
    <QueryClientProvider client={client}>
      <AgentColorsContext.Provider value={colors}>
        <AllChatsSearch />
      </AgentColorsContext.Provider>
    </QueryClientProvider>
  )
}
const field = (): HTMLInputElement => screen.getByRole('combobox', { name: 'Search all chats' })
const chipRow = (): HTMLElement | null => screen.queryByRole('group', { name: 'Limit to agents' })
const chip = (name: RegExp): HTMLElement => within(chipRow()!).getByRole('button', { name })
const groupTitles = (): string[] => screen.queryAllByRole('region').map((group) => group.getAttribute('aria-label') ?? '')

async function searchFor(text: string): Promise<void> {
  fireEvent.change(field(), { target: { value: text } })
  await waitFor(() => expect(screen.getAllByRole('option').length).toBeGreaterThan(0))
}

describe('all-chats search', () => {
  it('searches only once typing has paused', async () => {
    vi.useFakeTimers()
    view()
    fireEvent.change(field(), { target: { value: 're' } })
    act(() => { vi.advanceTimersByTime(200) })
    fireEvent.change(field(), { target: { value: 'retry' } })
    act(() => { vi.advanceTimersByTime(299) })
    expect(search).not.toHaveBeenCalled()
    expect(document.querySelector('[data-chat-search="all"]')?.hasAttribute('data-pending')).toBe(true)
    await act(async () => { vi.advanceTimersByTime(1) })
    expect(search).toHaveBeenCalledTimes(1)
    expect(search).toHaveBeenCalledWith('retry')
  })

  it('shows no chips before a query, then only the agents it found, with counts', async () => {
    view()
    expect(chipRow()).toBeNull()
    await searchFor('retry')
    const names = within(chipRow()!).getAllByRole('button').map((button) => button.textContent)
    expect(names).toEqual(['All agents', 'Finance 1', 'Platform 6'])
    expect(chip(/^All agents$/).getAttribute('aria-pressed')).toBe('true')
  })

  it('hides the chip row when the query found one agent only', async () => {
    served = { truncated: false, groups: [RESULT.groups[0]] }
    view()
    await searchFor('race')
    expect(chipRow()).toBeNull()
  })

  it('narrows to a pressed chip, keeps every count, and All agents clears it', async () => {
    view()
    await searchFor('retry')
    // Newest chat nearest the bar: drawn last.
    expect(groupTitles()).toEqual(['Q3 invoices', 'Postgres migration plan', 'Flaky checkout test'])
    fireEvent.click(chip(/^Finance/))
    expect(groupTitles()).toEqual(['Q3 invoices'])
    expect(chip(/^Finance/).getAttribute('aria-pressed')).toBe('true')
    // Counts say what pressing a chip would show, whatever is pressed.
    expect(chip(/^Platform/).textContent).toBe('Platform 6')
    expect(screen.getByText('1 in 1 chat')).toBeTruthy()
    fireEvent.click(chip(/^Platform/))
    expect(groupTitles()).toEqual(['Q3 invoices', 'Postgres migration plan', 'Flaky checkout test'])
    fireEvent.click(chip(/^All agents$/))
    expect(useChatSearchStore.getState().agents).toEqual([])
    expect(chip(/^Finance/).getAttribute('aria-pressed')).toBe('false')
  })

  it("toggles the filter from a chat heading's chip too, and a pressed agent with no matches stays", async () => {
    view()
    await searchFor('retry')
    const heading = screen.getByRole('region', { name: 'Postgres migration plan' })
    fireEvent.click(within(heading).getByRole('button', { name: /^Platform/ }))
    expect(useChatSearchStore.getState().agents).toEqual(['agent:a-platform'])
    expect(groupTitles()).toEqual(['Postgres migration plan', 'Flaky checkout test'])
    // A new query that finds no Platform chat: its chip stays, at 0, so it can be unpressed.
    served = { truncated: false, groups: [RESULT.groups[2]] }
    fireEvent.change(field(), { target: { value: 'card' } })
    await waitFor(() => expect(chip(/^Platform/).textContent).toBe('Platform 0'))
    expect(screen.getByText(/No matches for “card” with these agents/)).toBeTruthy()
    fireEvent.click(chip(/^Platform/))
    await waitFor(() => expect(groupTitles()).toEqual(['Q3 invoices']))
  })

  it('shows at most the returned messages per chat and counts the rest as older', async () => {
    view()
    await searchFor('retry')
    const heading = screen.getByRole('region', { name: 'Postgres migration plan' })
    expect(within(heading).getAllByRole('option')).toHaveLength(3)
    expect(within(heading).getByText('5 messages')).toBeTruthy()
    expect(within(heading).getByRole('button', { name: '2 older in this chat' })).toBeTruthy()
  })

  it('tints the cards of an agent with a chosen colour only', async () => {
    view(new Map([['a-finance', '#D4A84A']]))
    await searchFor('retry')
    expect(screen.getByRole('region', { name: 'Q3 invoices' }).hasAttribute('data-tinted')).toBe(true)
    expect(screen.getByRole('region', { name: 'Flaky checkout test' }).hasAttribute('data-tinted')).toBe(false)
  })

  it('opens the chat of a clicked result, asks it to scroll there, and closes', async () => {
    view()
    await searchFor('retry')
    fireEvent.click(screen.getByText('Retry each batch'))
    expect(useChatSearchStore.getState().scope).toBeNull()
    expect(useChatStore.getState().activeChatId).toBe('c-pg')
    expect(useUIStore.getState().activeView).toBe('chat')
    expect(useChatSearchStore.getState().jump).toMatchObject({ chatId: 'c-pg', messageId: 'm-pg-3', query: 'retry' })
    expect(document.querySelector('[data-chat-search]')).toBeNull()
  })

  it('opens the active result on Enter, the newest by default, and moves with the arrows', async () => {
    view()
    await searchFor('retry')
    expect(screen.getAllByRole('option').at(-1)!.getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(field(), { key: 'ArrowUp' })
    fireEvent.keyDown(field(), { key: 'Enter' })
    // One up from the newest (Flaky) is the newest of the chat before it.
    expect(useChatSearchStore.getState().jump).toMatchObject({ chatId: 'c-pg', messageId: 'm-pg-3' })
  })

  it('closes on Escape, keeping the query for the next open', async () => {
    view()
    await searchFor('retry')
    fireEvent.keyDown(field(), { key: 'Escape' })
    expect(useChatSearchStore.getState().scope).toBeNull()
    expect(useChatSearchStore.getState().query).toBe('retry')
  })

  it('cannot switch to this chat with no chat open', () => {
    view()
    const scope = screen.getByRole('button', { name: 'Search this chat instead' }) as HTMLButtonElement
    // Named for what it does; it shows the scope it searches.
    expect(scope.textContent).toBe('All chats')
    expect(scope.disabled).toBe(true)
  })

  it('asks main for the pressed agents, and keeps the chips counting every chat', async () => {
    view()
    await searchFor('retry')
    // Main's filtered search finds a Finance chat the newest 50 did not hold.
    const older = {
      chatId: 'c-old', title: 'Old Finance chat', total: 1, latestAt: at(1),
      messages: [{ id: 'm-old', role: 'assistant' as const, content: 'retry the export', createdAt: at(1) }]
    }
    lists.summaries['c-old'] = agent('a-finance', 'Finance')
    search.mockImplementation(async (query: string, filter?: ChatSearchFilter) =>
      filter ? { truncated: false, groups: [RESULT.groups[2], older] } : serve(query))
    fireEvent.click(chip(/^Finance/))
    await waitFor(() => expect(groupTitles()).toEqual(['Old Finance chat', 'Q3 invoices']))
    expect(search).toHaveBeenLastCalledWith('retry', { agentIds: ['a-finance'] })
    // The chips still count the unfiltered results.
    expect(chip(/^Finance/).textContent).toBe('Finance 1')
    expect(chip(/^Platform/).textContent).toBe('Platform 6')
    expect(screen.getByText('2 in 2 chats')).toBeTruthy()
  })

  it('says when the results stop at the newest 50 chats, in the count and beside the bar', async () => {
    served = { ...RESULT, truncated: true }
    view()
    await searchFor('retry')
    expect(screen.getByText('50+ chats')).toBeTruthy()
    const notice = document.querySelector('[data-chat-search-notice]')!
    expect(notice.textContent).toMatch(/Showing the 50 chats with the newest matches/)
    // Between the chip row and the bar, not at the far end of the list.
    const bar = screen.getByRole('search')
    expect(chipRow()!.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(notice.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByRole('listbox').contains(notice)).toBe(false)
  })

  it('keeps the notice when the agent filter leaves nothing', async () => {
    served = { ...RESULT, truncated: true }
    view()
    await searchFor('retry')
    search.mockImplementation(async (query: string, filter?: ChatSearchFilter) =>
      filter ? { truncated: false, groups: [] } : serve(query))
    fireEvent.click(chip(/^Finance/))
    await waitFor(() => expect(screen.getByText(/No matches for “retry” with these agents/)).toBeTruthy())
    expect(document.querySelector('[data-chat-search-notice]')?.textContent).toMatch(/50 chats with the newest matches/)
  })

  it("does not open an earlier query's result on Enter while the new one is in flight", async () => {
    view()
    await searchFor('retry')
    search.mockImplementation(() => new Promise(() => {}))
    fireEvent.change(field(), { target: { value: 'card' } })
    // Past the pause: the new query is asked, the old results still drawn.
    await waitFor(() => expect(search).toHaveBeenLastCalledWith('card'), { timeout: 1000 })
    expect(screen.getAllByRole('option').length).toBeGreaterThan(0)
    expect(document.querySelector('[data-chat-search="all"]')?.hasAttribute('data-pending')).toBe(true)
    fireEvent.keyDown(field(), { key: 'Enter' })
    expect(useChatSearchStore.getState().jump).toBeNull()
    expect(useChatSearchStore.getState().scope).toBe('all')
  })

  it('gives focus back on Escape: to what had it, else the composer', async () => {
    useChatSearchStore.setState({ scope: null })
    const before = document.createElement('button')
    const composer = document.createElement('textarea')
    composer.setAttribute('data-chat-composer', 'c-pg')
    document.body.append(before, composer)
    try {
      view()
      before.focus()
      act(() => { useChatSearchStore.getState().open('all') })
      expect(document.activeElement).toBe(field())
      fireEvent.keyDown(field(), { key: 'Escape' })
      expect(document.activeElement).toBe(before)

      // What had focus is gone: the composer takes it.
      act(() => { useChatSearchStore.getState().open('all') })
      expect(document.activeElement).toBe(field())
      before.remove()
      fireEvent.keyDown(field(), { key: 'Escape' })
      expect(document.activeElement).toBe(composer)
    } finally {
      before.remove()
      composer.remove()
    }
  })

  it('does not give focus back to where the search started after a pick', async () => {
    useChatSearchStore.setState({ scope: null })
    const before = document.createElement('button')
    document.body.append(before)
    try {
      view()
      before.focus()
      act(() => { useChatSearchStore.getState().open('all') })
      await searchFor('retry')
      fireEvent.click(screen.getByText('Retry each batch'))
      expect(useChatSearchStore.getState().jump).toMatchObject({ chatId: 'c-pg' })
      expect(document.activeElement).not.toBe(before)
    } finally {
      before.remove()
    }
  })

  it("does not call a narrowed list of the newest 50 chats truncated while main's filtered search runs", async () => {
    served = { ...RESULT, truncated: true }
    view()
    await searchFor('retry')
    expect(screen.getByText('50+ chats')).toBeTruthy()
    search.mockImplementation(async (query: string, filter?: ChatSearchFilter) =>
      filter ? new Promise(() => {}) : serve(query))
    fireEvent.click(chip(/^Finance/))
    await waitFor(() => expect(groupTitles()).toEqual(['Q3 invoices']))
    expect(screen.queryByText('50+ chats')).toBeNull()
    expect(screen.getByText('1 in 1 chat')).toBeTruthy()
  })
})
