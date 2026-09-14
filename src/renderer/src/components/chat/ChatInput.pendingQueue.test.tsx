import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, type RenderResult } from '@testing-library/react'
import { createElement, Fragment, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunQueueView, RunStartResult } from '../../../../shared/ipcPayloads'

/**
 * Typing while a turn runs: the text goes to main (into the turn, or queued
 * behind it), the composer row keeps Stop and Send for the whole turn, a queue
 * the turn left held comes back into the input, and ArrowUp/ArrowDown recall
 * the user's own messages — a queued one recalled for editing.
 */

const run = vi.hoisted(() => ({
  start: vi.fn(async (): Promise<RunStartResult> => ({ kind: 'queued', queuedId: 'q-1' })),
  cancelChat: vi.fn(async () => undefined),
  queueList: vi.fn(async (): Promise<RunQueueView> => ({ items: [], held: false })),
  queueTake: vi.fn(async (): Promise<string[]> => []),
  queueEdit: vi.fn(async (): Promise<boolean> => true),
  onQueueChanged: vi.fn((_handler: (payload: { chatId: string }) => void) => () => undefined)
}))

function namespace(methods: Record<string, unknown> = {}): unknown {
  return new Proxy(methods, {
    get: (target, method: string) =>
      method in target ? target[method] : method.startsWith('on') ? () => () => undefined : async () => []
  })
}
;(window as unknown as { api: unknown }).api = new Proxy(
  {},
  { get: (_t, ns: string) => (ns === 'run' ? namespace(run) : namespace()) }
)

const { ChatInput, QUEUED_EDIT_TOO_LATE } = await import('./ChatInput')
const { QueuedMessages, useQueuedMessages } = await import('./QueuedMessages')
const { useChatStore } = await import('../../stores/chat.store')
const { useComposerDraftStore, composerDraftKey } = await import('../../stores/composerDraft.store')

const DRAFT_KEY = composerDraftKey(undefined, 'chat:chat-1')
const RUNNING_PLACEHOLDER = 'Send a follow-up · Esc Esc to stop'
const TOO_LATE_WORDING = 'Sent before your edit was saved — your edit is still here.'

function chatRow(id: string, activeRunId: string | null, userTexts: string[]): unknown {
  return {
    id, router: 'direct', agentId: null, modeId: null, providerId: null, modelId: null,
    messages: userTexts.flatMap((content, index) => [
      { id: `u-${index}`, role: 'user', content },
      { id: `a-${index}`, role: 'assistant', content: `reply ${index}` }
    ]),
    activeRunId
  }
}

/** The transcript's queued bubbles for chat-1, as MessageStream renders them. */
function Bubbles(): React.JSX.Element {
  return createElement(QueuedMessages, { view: useQueuedMessages('chat-1', []) })
}

interface Mounted { client: QueryClient; rerender: RenderResult['rerender'] }

function mount(activeRunId: string | null, userTexts: string[] = [], options: { bubbles?: boolean } = {}): Mounted {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(['chat', 'chat-1'], chatRow('chat-1', activeRunId, userTexts))
  const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element =>
    createElement(QueryClientProvider, { client }, children)
  const { rerender } = render(
    createElement(Fragment, null, createElement(ChatInput, { chatId: 'chat-1' }), options.bubbles ? createElement(Bubbles) : null),
    { wrapper }
  )
  return { client, rerender }
}

const box = (): HTMLTextAreaElement => screen.getByRole('combobox') as HTMLTextAreaElement
/** The Send slot by its attribute: hidden, it has no accessible name for a role query to match. */
const sendSlot = (): HTMLElement | null => document.querySelector('button[aria-label="Send"]')
const key = (name: string): void => { fireEvent.keyDown(box(), { key: name }) }
const queued = (...texts: string[]): RunQueueView => ({
  items: texts.map((content, index) => ({ id: `q-${index + 1}`, content, createdAt: index })),
  held: false
})

/** Mount with a queue, and wait until the composer has read it. */
async function mountWithQueue(
  activeRunId: string | null,
  userTexts: string[],
  view: RunQueueView,
  options: { bubbles?: boolean } = {}
): Promise<Mounted> {
  run.queueList.mockResolvedValue(view)
  const mounted = mount(activeRunId, userTexts, options)
  await waitFor(() => expect(run.queueList).toHaveBeenCalledWith('chat-1'))
  await act(async () => {})
  return mounted
}

/** Let the composer's post-recall caret placement (a frame later) run. */
async function nextFrame(): Promise<void> {
  await act(async () => { await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())) })
}

beforeEach(() => {
  vi.clearAllMocks()
  run.queueList.mockResolvedValue({ items: [], held: false })
  run.queueEdit.mockResolvedValue(true)
  run.onQueueChanged.mockImplementation(() => () => undefined)
  useChatStore.getState().reset()
  useComposerDraftStore.setState({ drafts: {} })
})

describe('the composer while a turn runs', () => {
  it('sends only the text to main, shows no optimistic bubble, and keeps notes in the draft', async () => {
    mount('run-1')
    act(() => useComposerDraftStore.getState().update(DRAFT_KEY, () => ({ notes: [{ id: 'n-1', title: 'Plan' }] })))
    fireEvent.change(box(), { target: { value: 'also this' } })
    key('Enter')

    await waitFor(() => expect(run.start).toHaveBeenCalledWith({
      chatId: 'chat-1', content: 'also this', attachments: undefined, addressedAgentId: null
    }))
    await waitFor(() => expect(box().value).toBe(''))
    expect(useChatStore.getState().pendingUserMessage).toBeNull()
    expect(useComposerDraftStore.getState().drafts[DRAFT_KEY].notes).toEqual([{ id: 'n-1', title: 'Plan' }])
    expect(run.cancelChat).not.toHaveBeenCalled()
  })

  it('offers Stop alone on an empty input, with the Send slot held invisible at the right end', () => {
    mount('run-1')
    const stop = screen.getByRole('button', { name: 'Stop' })
    expect(stop.getAttribute('title')).toBe('Stop (Esc Esc)')
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
    const slot = sendSlot()!
    expect(slot.getAttribute('aria-hidden')).toBe('true')
    expect(slot.getAttribute('tabindex')).toBe('-1')
    expect(slot.classList.contains('invisible')).toBe(true)
    const row = stop.parentElement!
    expect(row.lastElementChild).toBe(slot)
    const stopIndex = Array.from(row.children).indexOf(stop)
    expect(stopIndex).toBe(row.children.length - 2)

    fireEvent.change(box(), { target: { value: 'a' } })
    // The same nodes in the same places: typing shows Send, never moves the row.
    const send = screen.getByRole('button', { name: 'Send' })
    expect(send).toBe(slot)
    expect(send.hasAttribute('disabled')).toBe(false)
    expect(send.classList.contains('invisible')).toBe(false)
    expect(screen.getByRole('button', { name: 'Stop' })).toBe(stop)
    expect(Array.from(row.children).indexOf(stop)).toBe(stopIndex)
    expect(row.lastElementChild).toBe(send)

    fireEvent.change(box(), { target: { value: '' } })
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
    expect(Array.from(row.children).indexOf(stop)).toBe(stopIndex)
    expect(row.lastElementChild).toBe(slot)
  })

  it('says how to stop in the placeholder while a turn runs, and not otherwise', () => {
    mount('run-1')
    expect(box().getAttribute('placeholder')).toBe(RUNNING_PLACEHOLDER)
  })

  it('offers Send alone, and the usual placeholder, when nothing is running', () => {
    mount(null)
    const send = screen.getByRole('button', { name: 'Send' })
    expect(send.parentElement!.lastElementChild).toBe(send)
    // The idle composer keeps a visible, disabled Send on an empty input.
    expect(send.hasAttribute('disabled')).toBe(true)
    expect(send.hasAttribute('aria-hidden')).toBe(false)
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
    expect(box().getAttribute('placeholder')).toBe('Type a message...')
  })

  it('does not send an empty message into a running turn', async () => {
    mount('run-1')
    key('Enter')
    await act(async () => {})
    expect(run.start).not.toHaveBeenCalled()
  })
})

describe('a held queue', () => {
  it('comes back into the input, after what the user typed, when main says the queue changed', async () => {
    let notify!: (payload: { chatId: string; view?: RunQueueView }) => void
    run.onQueueChanged.mockImplementation((handler) => { notify = handler; return () => undefined })
    mount(null)
    await waitFor(() => expect(run.queueList).toHaveBeenCalledWith('chat-1'))
    fireEvent.change(box(), { target: { value: 'keep me' } })

    const held = { ...queued('first', 'second'), held: true }
    run.queueList.mockResolvedValue(held)
    run.queueTake.mockResolvedValueOnce(['first', 'second'])
    act(() => notify({ chatId: 'chat-1', view: held }))

    await waitFor(() => expect(box().value).toBe('keep me\n\nfirst\n\nsecond'))
    expect(run.queueTake).toHaveBeenCalledTimes(1)
    expect(run.queueTake).toHaveBeenCalledWith('chat-1')
  })

  it('leaves the input alone for a queue that is still waiting on its turn', async () => {
    await mountWithQueue('run-1', [], queued('first'))
    expect(run.queueTake).not.toHaveBeenCalled()
    expect(box().value).toBe('')
  })
})

describe('message history', () => {
  it('cycles back through the user’s messages with queued ones newest, and forward to an empty input', async () => {
    await mountWithQueue('run-1', ['one', 'two'], queued('queued A', 'queued B'))
    const seen: string[] = []
    for (let i = 0; i < 5; i++) { key('ArrowUp'); seen.push(box().value) }
    expect(seen).toEqual(['queued B', 'queued A', 'two', 'one', 'one'])
    const back: string[] = []
    for (let i = 0; i < 4; i++) { key('ArrowDown'); back.push(box().value) }
    expect(back).toEqual(['two', 'queued A', 'queued B', ''])
  })

  it('counts a message the running turn took in, before it is saved, between the saved and the queued ones', async () => {
    useChatStore.setState({ activeChatId: 'chat-1', isStreaming: true, streamingBlocks: [{ type: 'user', content: 'steered' }] })
    await mountWithQueue('run-1', ['one'], queued('queued A'))
    const seen: string[] = []
    for (let i = 0; i < 3; i++) { key('ArrowUp'); seen.push(box().value) }
    expect(seen).toEqual(['queued A', 'steered', 'one'])
    key('ArrowDown')
    expect(box().value).toBe('steered')
    // Delivered, not queued: a new message, not an edit.
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy()
    expect(useChatStore.getState().editingQueued).toBeNull()
  })

  it('does not count another chat’s live turn', async () => {
    useChatStore.setState({ activeChatId: 'chat-2', streamingBlocks: [{ type: 'user', content: 'elsewhere' }] })
    await mountWithQueue(null, ['one'], queued())
    key('ArrowUp')
    expect(box().value).toBe('one')
    key('ArrowUp')
    expect(box().value).toBe('one')
  })

  it('stops cycling once the recalled text is edited', async () => {
    await mountWithQueue(null, ['one', 'two'], queued())
    key('ArrowUp')
    fireEvent.change(box(), { target: { value: 'two, changed' } })
    key('ArrowUp')
    expect(box().value).toBe('two, changed')
  })

  it('saves a recalled queued message through run:queue-edit, with a save button in Send’s place', async () => {
    await mountWithQueue('run-1', ['one'], queued('queued A'))
    key('ArrowUp')
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save.getAttribute('title')).toBe('Save queued message')
    expect(save.parentElement!.lastElementChild).toBe(save)
    expect(sendSlot()).toBeNull()
    expect(useChatStore.getState().editingQueued).toEqual({ chatId: 'chat-1', id: 'q-1' })

    fireEvent.change(box(), { target: { value: 'queued A, better' } })
    key('Enter')
    await waitFor(() => expect(run.queueEdit).toHaveBeenCalledWith('chat-1', 'q-1', 'queued A, better'))
    expect(run.start).not.toHaveBeenCalled()
    await waitFor(() => expect(box().value).toBe(''))
    // Back to an empty composer in a running turn: Stop alone, the slot held.
    expect(document.querySelector('button[aria-label="Save"]')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
    expect(sendSlot()!.getAttribute('aria-hidden')).toBe('true')
    expect(useChatStore.getState().editingQueued).toBeNull()
  })

  it('saves on a click of Save too', async () => {
    await mountWithQueue('run-1', [], queued('queued A'))
    key('ArrowUp')
    fireEvent.change(box(), { target: { value: 'clicked' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(run.queueEdit).toHaveBeenCalledWith('chat-1', 'q-1', 'clicked'))
    expect(run.start).not.toHaveBeenCalled()
  })

  it('disables Save while the edited text is empty', async () => {
    await mountWithQueue('run-1', [], queued('queued A'))
    key('ArrowUp')
    fireEvent.change(box(), { target: { value: '' } })
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true)
  })

  it('sends a recalled delivered message as a new one', async () => {
    run.start.mockResolvedValue({ kind: 'started', runId: 'r' })
    await mountWithQueue(null, ['one', 'two'], queued())
    key('ArrowUp')
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy()
    key('Enter')
    await waitFor(() => expect(run.start).toHaveBeenCalledWith(expect.objectContaining({ content: 'two' })))
    expect(run.queueEdit).not.toHaveBeenCalled()
  })

  it('leaves editing on Esc, empties the input, and does not arm the stop chord', async () => {
    await mountWithQueue('run-1', [], queued('queued A'))
    key('ArrowUp')
    key('Escape')
    expect(box().value).toBe('')
    expect(document.querySelector('button[aria-label="Save"]')).toBeNull()
    expect(sendSlot()!.getAttribute('aria-hidden')).toBe('true')
    key('Escape')
    expect(run.cancelChat).not.toHaveBeenCalled()
  })

  it('keeps the edit, says main sent the message first, and drops that notice on the next send', async () => {
    let notify!: (payload: { chatId: string; view?: RunQueueView }) => void
    run.onQueueChanged.mockImplementation((handler) => { notify = handler; return () => undefined })
    await mountWithQueue('run-1', [], queued('queued A'))
    key('ArrowUp')
    fireEvent.change(box(), { target: { value: 'queued A, better' } })

    run.queueList.mockResolvedValue(queued())
    act(() => notify({ chatId: 'chat-1', view: queued() }))
    await waitFor(() => expect(useChatStore.getState().sendError).toBe(TOO_LATE_WORDING))
    expect(QUEUED_EDIT_TOO_LATE).toBe(TOO_LATE_WORDING)
    expect(box().value).toBe('queued A, better')
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy()

    key('Enter')
    await waitFor(() => expect(run.start).toHaveBeenCalledWith(expect.objectContaining({ content: 'queued A, better' })))
    await waitFor(() => expect(box().value).toBe(''))
    expect(useChatStore.getState().sendError).toBeNull()
  })

  it('says the same when main answers that the message is no longer queued, until the text is cleared', async () => {
    run.queueEdit.mockResolvedValue(false)
    await mountWithQueue('run-1', [], queued('queued A'))
    key('ArrowUp')
    key('Enter')
    await waitFor(() => expect(useChatStore.getState().sendError).toBe(QUEUED_EDIT_TOO_LATE))
    expect(box().value).toBe('queued A')
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy()

    fireEvent.change(box(), { target: { value: '' } })
    expect(useChatStore.getState().sendError).toBeNull()
  })

  it('folds the edit into a queue a stop held: one text per message, in queue order, and no notice', async () => {
    let notify!: (payload: { chatId: string; view?: RunQueueView }) => void
    run.onQueueChanged.mockImplementation((handler) => { notify = handler; return () => undefined })
    await mountWithQueue('run-1', [], queued('fix tests', 'then docs'))
    key('ArrowUp')
    key('ArrowUp')
    expect(useChatStore.getState().editingQueued).toEqual({ chatId: 'chat-1', id: 'q-1' })
    fireEvent.change(box(), { target: { value: 'fix tests please' } })

    const held = { ...queued('fix tests', 'then docs'), held: true }
    run.queueList.mockResolvedValue(held)
    run.queueTake.mockResolvedValueOnce(['fix tests', 'then docs'])
    act(() => notify({ chatId: 'chat-1', view: held }))
    await waitFor(() => expect(run.queueTake).toHaveBeenCalledWith('chat-1'))
    await waitFor(() => expect(box().value).toBe('fix tests please\n\nthen docs'))

    // Main announces the queue the take emptied.
    run.queueList.mockResolvedValue(queued())
    act(() => notify({ chatId: 'chat-1', view: queued() }))
    await act(async () => {})
    expect(box().value).toBe('fix tests please\n\nthen docs')
    expect(useChatStore.getState().sendError).toBeNull()
    expect(useChatStore.getState().editingQueued).toBeNull()
    expect(document.querySelector('button[aria-label="Save"]')).toBeNull()
  })

  it('lets the edit take the place of a message a refused start put back held, with no notice', async () => {
    let notify!: (payload: { chatId: string; view?: RunQueueView }) => void
    run.onQueueChanged.mockImplementation((handler) => { notify = handler; return () => undefined })
    await mountWithQueue('run-1', [], queued('queued A'))
    key('ArrowUp')
    fireEvent.change(box(), { target: { value: 'queued A, better' } })

    // Main drains it, and the composer renders the emptied queue…
    run.queueList.mockResolvedValue(queued())
    act(() => notify({ chatId: 'chat-1', view: queued() }))
    await waitFor(() => expect(useChatStore.getState().editingQueued).toBeNull())

    // …then the start is refused and it is back, held, under the same id.
    const held = { ...queued('queued A'), held: true }
    run.queueList.mockResolvedValue(held)
    run.queueTake.mockResolvedValueOnce(['queued A'])
    act(() => notify({ chatId: 'chat-1', view: held }))
    await waitFor(() => expect(run.queueTake).toHaveBeenCalledWith('chat-1'))
    await act(async () => { await Promise.resolve() })
    await nextFrame()
    expect(box().value).toBe('queued A, better')
    expect(useChatStore.getState().sendError).toBeNull()
  })

  it('leaves edit mode silently, keeping the text, when the user cancels the edited message from its bubble', async () => {
    await mountWithQueue('run-1', [], queued('queued A'), { bubbles: true })
    key('ArrowUp')
    fireEvent.change(box(), { target: { value: 'queued A, better' } })

    run.queueList.mockResolvedValue(queued())
    fireEvent.click(screen.getByRole('button', { name: 'Cancel queued message' }))
    await waitFor(() => expect(useChatStore.getState().editingQueued).toBeNull())
    await act(async () => {})
    expect(useChatStore.getState().sendError).toBeNull()
    expect(box().value).toBe('queued A, better')
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy()
  })

  it('does not carry an edit, or a notice about it, into another chat', async () => {
    const { client, rerender } = await mountWithQueue('run-1', [], queued('queued A'))
    key('ArrowUp')
    expect(useChatStore.getState().editingQueued).toEqual({ chatId: 'chat-1', id: 'q-1' })

    client.setQueryData(['chat', 'chat-2'], chatRow('chat-2', null, []))
    client.setQueryData(['run-queue', 'chat-2'], queued())
    rerender(createElement(ChatInput, { chatId: 'chat-2' }))
    await act(async () => {})
    expect(useChatStore.getState().sendError).toBeNull()
    expect(useChatStore.getState().editingQueued).toBeNull()
    expect(box().value).toBe('')
  })

  it('moves the caret inside a recalled multi-line message, stepping on only from its first or last line', async () => {
    await mountWithQueue(null, ['older', 'line one\nline two'], queued())
    key('ArrowUp')
    expect(box().value).toBe('line one\nline two')
    await nextFrame()

    // On line two: ArrowUp is the caret's, and ArrowDown on line one too.
    box().setSelectionRange(12, 12)
    expect(fireEvent.keyDown(box(), { key: 'ArrowUp' })).toBe(true)
    expect(box().value).toBe('line one\nline two')
    box().setSelectionRange(3, 3)
    expect(fireEvent.keyDown(box(), { key: 'ArrowDown' })).toBe(true)
    expect(box().value).toBe('line one\nline two')

    // On line one, ArrowUp steps back.
    expect(fireEvent.keyDown(box(), { key: 'ArrowUp' })).toBe(false)
    expect(box().value).toBe('older')
    await nextFrame()

    // And from the last line, ArrowDown steps forward, past the newest to empty.
    key('ArrowDown')
    expect(box().value).toBe('line one\nline two')
    await nextFrame()
    expect(fireEvent.keyDown(box(), { key: 'ArrowDown' })).toBe(false)
    expect(box().value).toBe('')
  })
})
