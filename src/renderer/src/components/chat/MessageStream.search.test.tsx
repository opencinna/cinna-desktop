vi.hoisted(() => { Object.assign(window, { api: { app: { setTheme: async () => {} } } }) })
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatStore } from '../../stores/chat.store'
import { useUIStore } from '../../stores/ui.store'
import { CHAT_SEARCH_JUMP_TTL_MS, useChatSearchStore } from '../../stores/chatSearch.store'
import { MessageStream } from './MessageStream'
import { useChatSearchShortcut } from './search/useChatSearchShortcut'

/**
 * Searching the chat on screen: the bar takes the pills' place, its results
 * wait for a pause in typing, a result scrolls the transcript to its message
 * and closes the search, and another chat closes it too. ⌘F opens it while a
 * chat is on screen and all-chats search otherwise.
 */

const data = vi.hoisted(() => ({ byChat: {} as Record<string, unknown[] | undefined> }))
// A chat whose messages are undefined has not loaded yet.
vi.mock('../../hooks/useChat', () => ({
  useChatDetail: (chatId: string) => ({ data: data.byChat[chatId] ? { messages: data.byChat[chatId] } : undefined })
}))
vi.mock('../../hooks/useAgents', () => ({ useAgents: () => ({ data: [] }) }))
vi.mock('../../hooks/useAgentRequests', () => ({ useAgentRequests: () => ({ isPending: () => false }) }))
const stick = vi.hoisted(() => ({ containerRef: { current: null }, contentRef: { current: null } }))
vi.mock('../../hooks/useStickToBottom', () => ({
  useStickToBottom: () => ({ ...stick, pinned: false, scrollToBottom: () => {} }),
  leaveBottom: () => {}
}))
vi.mock('./MessageMetaFooter', () => ({ MessageMetaFooter: () => null }))
vi.mock('./transcriptAnchor', () => ({ holdCollapseAnchor: () => () => {} }))
vi.mock('./QueuedMessages', () => ({
  QueuedMessages: () => null,
  useQueuedMessages: () => ({ chatId: 'chat', bubbles: [], holdsSent: false, handsOver: () => false, cancel: () => {} })
}))

const at = new Date(2026, 9, 1, 9, 0)
let client: QueryClient
beforeEach(() => {
  client = new QueryClient()
  data.byChat = {
    'c-1': [
      { id: 'm1', role: 'user', content: 'How should we retry a failed batch?', createdAt: at },
      { id: 't1', role: 'tool_call', toolName: 'search', content: 'retry found in a tool result', createdAt: at },
      { id: 'm2', role: 'assistant', content: 'Retry each batch up to five times.', createdAt: at },
      { id: 'm3', role: 'assistant', content: 'Nothing to see here.', createdAt: at }
    ],
    'c-2': [{ id: 'n1', role: 'user', content: 'Another chat', createdAt: at }]
  }
  useUIStore.setState({ verboseMode: false })
  useChatStore.setState({ streamingBlocks: [], isStreaming: false, liveBaselineMessageIds: null, inputRequests: [], settledInputRequestIds: [], pendingUserMessage: null })
  useChatSearchStore.setState({ scope: null, query: '', agents: [], searchableChatId: null, jump: null })
})
afterEach(() => {
  client.clear()
  vi.useRealTimers()
})

function Shortcut(): null {
  useChatSearchShortcut()
  return null
}
function view(chatId: string | null) {
  return (
    <QueryClientProvider client={client}>
      <Shortcut />
      {chatId && <MessageStream chatId={chatId} searchable />}
    </QueryClientProvider>
  )
}
const chatSearch = (): Element | null => document.querySelector('[data-chat-search="chat"]')
const pressFind = (): void => { fireEvent.keyDown(window, { key: 'f', metaKey: true }) }

describe('chat search in the transcript', () => {
  it('opens on ⌘F while a chat is on screen, in place of Jump to latest', () => {
    render(view('c-1'))
    expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeTruthy()
    pressFind()
    expect(useChatSearchStore.getState().scope).toBe('chat')
    expect(chatSearch()).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Search this chat' }))
  })

  it('opens all-chats search on ⌘F when no chat is on screen', () => {
    const { rerender } = render(view('c-1'))
    rerender(view(null))
    pressFind()
    expect(useChatSearchStore.getState().scope).toBe('all')
  })

  it('selects the query on ⌘F when the open search has focus', () => {
    useChatSearchStore.setState({ query: 'retry' })
    render(view('c-1'))
    pressFind()
    const input = screen.getByRole('combobox', { name: 'Search this chat' }) as HTMLInputElement
    input.setSelectionRange(5, 5)
    pressFind()
    expect(useChatSearchStore.getState().scope).toBe('chat')
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 5])
  })

  it('shows results only after the pause, from user and assistant messages only', () => {
    vi.useFakeTimers()
    render(view('c-1'))
    pressFind()
    fireEvent.change(screen.getByRole('combobox', { name: 'Search this chat' }), { target: { value: 'retry' } })
    act(() => { vi.advanceTimersByTime(299) })
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    expect(chatSearch()!.hasAttribute('data-pending')).toBe(true)
    act(() => { vi.advanceTimersByTime(1) })
    const options = screen.getAllByRole('option')
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining('How should we retry a failed batch?'),
      expect.stringContaining('Retry each batch up to five times.')
    ])
    expect(options[0].textContent).toMatch(/^You/)
    expect(screen.getByText('2 matches')).toBeTruthy()
    // The newest, nearest the bar, is the active one.
    expect(options[1].getAttribute('aria-selected')).toBe('true')
  })

  it('scrolls to a clicked result, flashes its block and closes', () => {
    useChatSearchStore.setState({ query: 'retry' })
    render(view('c-1'))
    pressFind()
    fireEvent.click(screen.getAllByRole('option')[1])
    expect(useChatSearchStore.getState().scope).toBeNull()
    expect(chatSearch()).toBeNull()
    const block = document.querySelector('[data-message-id="m2"] .chat-search-flash')
    expect(block?.textContent).toBe('Retry each batch up to five times.')
    expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeTruthy()
  })

  it('closes when another chat opens', () => {
    useChatSearchStore.setState({ query: 'retry' })
    const { rerender } = render(view('c-1'))
    pressFind()
    expect(chatSearch()).not.toBeNull()
    rerender(view('c-2'))
    expect(useChatSearchStore.getState().scope).toBeNull()
    expect(chatSearch()).toBeNull()
    // The query is remembered for the next ⌘F.
    pressFind()
    expect((screen.getByRole('combobox', { name: 'Search this chat' }) as HTMLInputElement).value).toBe('retry')
  })

  it('takes a jump from all-chats search: scrolls to the message once it is drawn', async () => {
    vi.useFakeTimers()
    useChatSearchStore.getState().requestJump({ chatId: 'c-1', messageId: 'm2', query: 'retry' })
    render(view('c-1'))
    await act(async () => { vi.advanceTimersByTime(50) })
    expect(document.querySelector('[data-message-id="m2"] .chat-search-flash')).not.toBeNull()
    expect(useChatSearchStore.getState().jump).toBeNull()
  })

  it('opens its own search on the query for "N older in this chat"', () => {
    useChatSearchStore.getState().requestJump({ chatId: 'c-1', messageId: null, query: 'retry' })
    render(view('c-1'))
    expect(useChatSearchStore.getState().scope).toBe('chat')
    expect(useChatSearchStore.getState().query).toBe('retry')
    expect(screen.getAllByRole('option')).toHaveLength(2)
  })

  it('waits for the messages before a jump fires, then fires it once', async () => {
    vi.useFakeTimers()
    const saved = data.byChat['c-1']
    data.byChat['c-1'] = undefined
    useChatSearchStore.getState().requestJump({ chatId: 'c-1', messageId: 'm2', query: 'retry' })
    const { rerender } = render(view('c-1'))
    await act(async () => { vi.advanceTimersByTime(50) })
    expect(useChatSearchStore.getState().jump).not.toBeNull()
    expect(document.querySelector('.chat-search-flash')).toBeNull()
    data.byChat['c-1'] = saved
    rerender(view('c-1'))
    await act(async () => { vi.advanceTimersByTime(50) })
    expect(document.querySelectorAll('.chat-search-flash')).toHaveLength(1)
    expect(document.querySelector('[data-message-id="m2"] .chat-search-flash')).not.toBeNull()
    expect(useChatSearchStore.getState().jump).toBeNull()
  })

  it('drops a jump when another chat opens before it fires, so a later visit does not take it', async () => {
    vi.useFakeTimers()
    const saved = data.byChat['c-1']
    data.byChat['c-1'] = undefined
    useChatSearchStore.getState().requestJump({ chatId: 'c-1', messageId: 'm2', query: 'retry' })
    const { rerender } = render(view('c-1'))
    // The user goes to another chat before c-1 has loaded.
    rerender(view('c-2'))
    expect(useChatSearchStore.getState().jump).toBeNull()
    data.byChat['c-1'] = saved
    rerender(view('c-1'))
    await act(async () => { vi.advanceTimersByTime(50) })
    expect(document.querySelector('.chat-search-flash')).toBeNull()
  })

  it('keeps a jump for the chat that opens next', () => {
    useChatSearchStore.setState({ searchableChatId: 'c-2' })
    useChatSearchStore.getState().requestJump({ chatId: 'c-1', messageId: 'm2', query: 'retry' })
    // The old transcript lets go first, then the picked chat's shows.
    useChatSearchStore.getState().setSearchableChatId(null)
    useChatSearchStore.getState().setSearchableChatId('c-1')
    expect(useChatSearchStore.getState().jump).toMatchObject({ chatId: 'c-1', messageId: 'm2' })
  })

  it.each([
    ['a dialog without aria-modal', (el: HTMLElement) => el.setAttribute('role', 'dialog')],
    ['an alert dialog', (el: HTMLElement) => el.setAttribute('role', 'alertdialog')],
    ['a modal scrim', (el: HTMLElement) => el.classList.add('app-modal-scrim')],
    ['an aria-modal element', (el: HTMLElement) => el.setAttribute('aria-modal', 'true')]
  ])('leaves ⌘F alone while %s is open', (_name, mark) => {
    const dialog = document.createElement('div')
    mark(dialog)
    document.body.append(dialog)
    try {
      render(view('c-1'))
      pressFind()
      expect(useChatSearchStore.getState().scope).toBeNull()
      // A hidden one does not count.
      dialog.hidden = true
      pressFind()
      expect(useChatSearchStore.getState().scope).toBe('chat')
    } finally {
      dialog.remove()
    }
  })

  it('shows the newest 30 cards and says how many older matches it left out', () => {
    data.byChat['c-1'] = Array.from({ length: 35 }, (_, k) => ({
      id: `r${k}`, role: k % 2 ? 'assistant' : 'user', content: `retry number ${k}`, createdAt: at
    }))
    useChatSearchStore.setState({ query: 'retry' })
    render(view('c-1'))
    pressFind()
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(30)
    expect(options[0].textContent).toContain('retry number 5')
    expect(options[29].textContent).toContain('retry number 34')
    expect(screen.getByText('35 matches')).toBeTruthy()
    const older = document.querySelector('[data-chat-search-older]')!
    expect(older.textContent).toBe('5 older matches. Refine the search to see them.')
    // At the far end of the list, above the oldest card shown.
    expect(older.compareDocumentPosition(options[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('gives focus back on Escape: to what had it, else the chat\'s composer', () => {
    const before = document.createElement('button')
    const composer = document.createElement('textarea')
    composer.setAttribute('data-chat-composer', 'c-1')
    document.body.append(before, composer)
    try {
      render(view('c-1'))
      before.focus()
      pressFind()
      const input = screen.getByRole('combobox', { name: 'Search this chat' })
      expect(document.activeElement).toBe(input)
      fireEvent.keyDown(input, { key: 'Escape' })
      expect(chatSearch()).toBeNull()
      expect(document.activeElement).toBe(before)

      ;(document.activeElement as HTMLElement).blur()
      expect(document.activeElement).toBe(document.body)
      pressFind()
      fireEvent.keyDown(screen.getByRole('combobox', { name: 'Search this chat' }), { key: 'Escape' })
      expect(document.activeElement).toBe(composer)
    } finally {
      before.remove()
      composer.remove()
    }
  })

  it("focuses the opened chat's composer once a picked result's jump fires, not where the search started", async () => {
    vi.useFakeTimers()
    const before = document.createElement('button')
    const composer = document.createElement('textarea')
    composer.setAttribute('data-chat-composer', 'c-1')
    document.body.append(before, composer)
    try {
      before.focus()
      // As all-chats search does on a pick.
      act(() => { useChatSearchStore.getState().open('all') })
      act(() => {
        useChatSearchStore.getState().closeForPick()
        useChatSearchStore.getState().requestJump({ chatId: 'c-1', messageId: 'm2', query: 'retry' })
      })
      render(view('c-1'))
      await act(async () => { vi.advanceTimersByTime(50) })
      expect(useChatSearchStore.getState().jump).toBeNull()
      expect(document.activeElement).toBe(composer)
    } finally {
      before.remove()
      composer.remove()
    }
  })

  it("focuses this chat's composer after a pick in the chat's own search", () => {
    const before = document.createElement('button')
    const composer = document.createElement('textarea')
    composer.setAttribute('data-chat-composer', 'c-1')
    document.body.append(before, composer)
    try {
      useChatSearchStore.setState({ query: 'retry' })
      render(view('c-1'))
      before.focus()
      pressFind()
      fireEvent.click(screen.getAllByRole('option')[1])
      expect(chatSearch()).toBeNull()
      expect(document.activeElement).toBe(composer)
    } finally {
      before.remove()
      composer.remove()
    }
  })

  it('drops a jump that has not fired within its time limit, as when the user left the chat view', async () => {
    vi.useFakeTimers()
    const saved = data.byChat['c-1']
    data.byChat['c-1'] = undefined
    useChatSearchStore.getState().requestJump({ chatId: 'c-1', messageId: 'm2', query: 'retry' })
    const { rerender } = render(view('c-1'))
    // Settings: no transcript at all, so no other chat clears it.
    rerender(view(null))
    act(() => { vi.advanceTimersByTime(CHAT_SEARCH_JUMP_TTL_MS) })
    expect(useChatSearchStore.getState().jump).toBeNull()
    data.byChat['c-1'] = saved
    rerender(view('c-1'))
    await act(async () => { vi.advanceTimersByTime(50) })
    expect(document.querySelector('.chat-search-flash')).toBeNull()
  })
})
