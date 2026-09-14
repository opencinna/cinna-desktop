const run = vi.hoisted(() => {
  const methods = {
    queueList: vi.fn(),
    queueRemove: vi.fn(async () => true),
    onQueueChanged: vi.fn((_handler: (payload: { chatId: string; view: unknown }) => void) => () => undefined)
  }
  Object.assign(window, { api: { app: { setTheme: async () => {} }, run: methods } })
  return methods
})
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatStore, type StreamBlock } from '../../stores/chat.store'
import { useUIStore } from '../../stores/ui.store'
import { MessageStream } from './MessageStream'
import { QUEUED_CANCEL_TOO_LATE } from './QueuedMessages'

const data = vi.hoisted(() => ({ messages: [] as unknown[] }))
const stick = vi.hoisted(() => ({ scrollToBottom: vi.fn() }))
vi.mock('../../hooks/useChat', () => ({ useChatDetail: () => ({ data: { messages: data.messages } }) }))
vi.mock('../../hooks/useAgents', () => ({ useAgents: () => ({ data: [] }) }))
vi.mock('../../hooks/useAgentRequests', () => ({ useAgentRequests: () => ({ isPending: () => false }) }))
vi.mock('../../hooks/useStickToBottom', () => ({ useStickToBottom: () => ({ containerRef: { current: null }, contentRef: { current: null }, pinned: true, scrollToBottom: stick.scrollToBottom }) }))
vi.mock('./MessageMetaFooter', () => ({ MessageMetaFooter: () => null }))

let client: QueryClient
function renderStream(): { rerender: () => void } {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const element = (): React.JSX.Element => <QueryClientProvider client={client}><MessageStream chatId="chat" /></QueryClientProvider>
  const view = render(element())
  return { rerender: () => view.rerender(element()) }
}

const follows = (first: Node, second: Node): boolean =>
  !!(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING)
const shown = (text: string): boolean => !screen.getByText(text).classList.contains('invisible')
const bubbleRow = (text: string): HTMLElement => screen.getByText(text).closest('[data-queued-message]') as HTMLElement

/** Let main's queue change reach the transcript: main pushes the queue as it now stands. */
async function queueBecomes(view: unknown): Promise<void> {
  const notify = run.onQueueChanged.mock.calls.at(-1)![0]
  await act(async () => { notify({ chatId: 'chat', view }) })
  await waitFor(() => expect(client.getQueryData(['run-queue', 'chat'])).toEqual(view))
  // The cache is ahead of the transcript: let its re-render and diff effect run.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

beforeEach(() => {
  vi.clearAllMocks()
  data.messages = []
  run.queueList.mockResolvedValue({ items: [], held: false })
  useUIStore.setState({ verboseMode: false })
  useChatStore.setState({ streamingBlocks: [], isStreaming: false, liveBaselineMessageIds: null, inputRequests: [], settledInputRequestIds: [], pendingUserMessage: null, editingQueued: null, sendError: null, cancelledQueuedIds: [] })
})

describe('a queued message in the transcript', () => {
  it('is a user bubble below the live turn with a Queued badge whose [x] reads Cancel? and removes it', async () => {
    run.queueList.mockResolvedValue({ items: [{ id: 'q-1', content: 'Queued one', createdAt: 1 }], held: false })
    useChatStore.setState({ isStreaming: true, streamingBlocks: [{ type: 'text', kind: 'text', content: 'Live answer' }] })
    renderStream()

    const bubble = await screen.findByText('Queued one')
    expect(follows(screen.getByText('Live answer'), bubble)).toBe(true)
    expect(shown('Queued')).toBe(true)
    expect(shown('Cancel?')).toBe(false)
    // Every label shares one grid cell, so the swap cannot resize the badge.
    expect(screen.getByText('Queued').parentElement).toBe(screen.getByText('Cancel?').parentElement)
    expect(screen.getByText('Editing').parentElement).toBe(screen.getByText('Queued').parentElement)

    const cancel = screen.getByRole('button', { name: 'Cancel queued message' })
    fireEvent.mouseEnter(cancel)
    expect(shown('Cancel?')).toBe(true)
    expect(shown('Queued')).toBe(false)
    fireEvent.mouseLeave(cancel)
    expect(shown('Queued')).toBe(true)

    fireEvent.click(cancel)
    expect(bubbleRow('Queued one').dataset.phase).toBe('leaving')
    await waitFor(() => expect(run.queueRemove).toHaveBeenCalledWith('chat', 'q-1'))
  })

  it('gives its [x] a chip of its own before any hover, so it does not read as part of the label', async () => {
    run.queueList.mockResolvedValue({ items: [{ id: 'q-1', content: 'Queued one', createdAt: 1 }], held: false })
    renderStream()
    await screen.findByText('Queued one')
    const cancel = screen.getByRole('button', { name: 'Cancel queued message' })
    const classes = cancel.className.split(/\s+/)
    expect(classes).toContain('bg-[var(--color-bg-secondary)]')
    // The badge it sits in has another surface, so the chip shows against it.
    expect(cancel.parentElement!.className.split(/\s+/)).toContain('bg-[var(--color-bg-tertiary)]')
  })

  it('collapses the gap above it along with itself when cancelled, so nothing snaps at unmount', async () => {
    run.queueList.mockResolvedValue({ items: [{ id: 'q-1', content: 'Queued one', createdAt: 1 }], held: false })
    useChatStore.setState({ isStreaming: true, streamingBlocks: [{ type: 'text', kind: 'text', content: 'Live answer' }] })
    renderStream()
    await screen.findByText('Queued one')
    const row = bubbleRow('Queued one')
    // The transcript's gap is taken back from the element before…
    expect(row.classList.contains('-mt-3')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel queued message' }))
    expect(row.dataset.phase).toBe('leaving')
    expect(row.style.gridTemplateRows).toBe('0fr')
    // …and given out again inside the box that collapses to nothing.
    const collapsing = row.firstElementChild as HTMLElement
    expect(collapsing.classList.contains('overflow-hidden')).toBe(true)
    expect((collapsing.firstElementChild as HTMLElement).classList.contains('pt-3')).toBe(true)
  })

  it('reads Cancel? while its [x] has keyboard focus', async () => {
    run.queueList.mockResolvedValue({ items: [{ id: 'q-1', content: 'Queued one', createdAt: 1 }], held: false })
    renderStream()
    await screen.findByText('Queued one')
    const cancel = screen.getByRole('button', { name: 'Cancel queued message' })
    fireEvent.focus(cancel)
    expect(shown('Cancel?')).toBe(true)
    fireEvent.blur(cancel)
    expect(shown('Queued')).toBe(true)
  })

  it('reads Editing while the composer edits it, and Cancel? over its [x] even then', async () => {
    run.queueList.mockResolvedValue({ items: [{ id: 'q-1', content: 'Queued one', createdAt: 1 }], held: false })
    renderStream()
    await screen.findByText('Queued one')
    act(() => useChatStore.getState().setEditingQueued({ chatId: 'chat', id: 'q-1' }))
    expect(shown('Editing')).toBe(true)
    expect(shown('Queued')).toBe(false)
    const cancel = screen.getByRole('button', { name: 'Cancel queued message' })
    fireEvent.mouseEnter(cancel)
    expect(shown('Cancel?')).toBe(true)
    fireEvent.mouseLeave(cancel)
    expect(shown('Editing')).toBe(true)
  })

  it('stays in place without its badge once sent, until its saved row takes over', async () => {
    run.queueList.mockResolvedValue({ items: [{ id: 'q-1', content: 'Queued one', createdAt: 1 }], held: false })
    const view = renderStream()
    await screen.findByText('Queued one')

    await queueBecomes({ items: [], held: false })
    expect(bubbleRow('Queued one').dataset.phase).toBe('sent')
    expect(screen.getByRole('button', { name: 'Cancel queued message' }).hasAttribute('disabled')).toBe(true)

    data.messages = [{ id: 'u-1', role: 'user', content: 'Queued one' }]
    view.rerender()
    expect(screen.getAllByText('Queued one')).toHaveLength(1)
    expect(screen.getByText('Queued one').closest('[data-queued-message]')).toBeNull()
  })

  it('stands in for several messages sent as one until the merged row appears, then swaps once', async () => {
    run.queueList.mockResolvedValue({ items: [{ id: 'q-1', content: 'first', createdAt: 1 }, { id: 'q-2', content: 'second', createdAt: 2 }], held: false })
    const view = renderStream()
    await screen.findByText('second')
    await queueBecomes({ items: [], held: false })
    expect(bubbleRow('first').dataset.phase).toBe('sent')
    expect(bubbleRow('second').dataset.phase).toBe('sent')

    data.messages = [{ id: 'u-1', role: 'user', content: 'first\n\nsecond' }]
    view.rerender()
    expect(document.querySelectorAll('[data-queued-message]')).toHaveLength(0)
  })

  it('is not retired by the same words the ended turn took in, only by its own row', async () => {
    // "yes" went into the running turn, then "yes" again was queued behind it.
    run.queueList.mockResolvedValue({ items: [{ id: 'q-1', content: 'yes', createdAt: 1 }], held: false })
    useChatStore.setState({ isStreaming: true, streamingBlocks: [{ type: 'text', kind: 'text', content: 'Working on it' }, { type: 'user', content: 'yes' }] })
    renderStream()
    const queuedRow = (): HTMLElement | null => document.querySelector('[data-queued-message]')
    await waitFor(() => expect(queuedRow()).not.toBeNull())

    // The turn ends and main sends the queued "yes" before the ended turn is read back.
    act(() => useChatStore.setState({ isStreaming: false }))
    await queueBecomes({ items: [], held: false })
    expect(queuedRow()?.dataset.phase).toBe('sent')

    // The ended turn's rows land — the steered "yes" among them — as its live blocks go.
    data.messages = [{ id: 'a-1', role: 'assistant', content: 'Working on it' }, { id: 'u-1', role: 'user', content: 'yes' }]
    act(() => useChatStore.setState({ streamingBlocks: [] }))
    expect(queuedRow()?.dataset.phase).toBe('sent')
    expect(screen.getAllByText('yes')).toHaveLength(2)

    // The next turn's read brings the sent message's own row.
    data.messages = [...data.messages, { id: 'u-2', role: 'user', content: 'yes' }]
    act(() => useChatStore.setState({ isStreaming: true }))
    expect(queuedRow()).toBeNull()
    expect(screen.getAllByText('yes')).toHaveLength(2)
  })

  it('is not retired by an earlier saved message with the same words', async () => {
    data.messages = [{ id: 'u-0', role: 'user', content: 'yes' }, { id: 'a-0', role: 'assistant', content: 'Noted' }]
    run.queueList.mockResolvedValue({ items: [{ id: 'q-1', content: 'yes', createdAt: 1 }], held: false })
    const view = renderStream()
    const queuedRow = (): HTMLElement | null => document.querySelector('[data-queued-message]')
    await waitFor(() => expect(queuedRow()).not.toBeNull())
    await queueBecomes({ items: [], held: false })
    expect(queuedRow()?.dataset.phase).toBe('sent')

    data.messages = [...data.messages, { id: 'u-1', role: 'user', content: 'yes' }]
    view.rerender()
    expect(queuedRow()).toBeNull()
    expect(screen.getAllByText('yes')).toHaveLength(2)
  })

  it('keeps the second of two identical messages sent back to back until its own row lands', async () => {
    run.queueList.mockResolvedValue({ items: [{ id: 'q-1', content: 'yes', createdAt: 1 }], held: false })
    const view = renderStream()
    const rows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('[data-queued-message]'))
    await waitFor(() => expect(rows()).toHaveLength(1))
    await queueBecomes({ items: [], held: false })
    await queueBecomes({ items: [{ id: 'q-2', content: 'yes', createdAt: 2 }], held: false })
    // Drained too, while the first one's saved row has not landed.
    await queueBecomes({ items: [], held: false })
    expect(rows().map((row) => row.dataset.phase)).toEqual(['sent', 'sent'])

    data.messages = [{ id: 'u-1', role: 'user', content: 'yes' }]
    view.rerender()
    expect(rows()).toHaveLength(1)
    expect(screen.getAllByText('yes')).toHaveLength(2)

    data.messages = [...data.messages, { id: 'u-2', role: 'user', content: 'yes' }]
    view.rerender()
    expect(rows()).toHaveLength(0)
    expect(screen.getAllByText('yes')).toHaveLength(2)
  })

  it('is not left standing as sent when main refuses to start it and holds it again under the same id', async () => {
    run.queueList.mockResolvedValue({ items: [{ id: 'q-1', content: 'Queued one', createdAt: 1 }], held: false })
    renderStream()
    await screen.findByText('Queued one')
    // Main announces the queue it drained, renders in between, then the held queue the refusal left.
    await queueBecomes({ items: [], held: false })
    expect(bubbleRow('Queued one').dataset.phase).toBe('sent')
    await queueBecomes({ items: [{ id: 'q-1', content: 'Queued one', createdAt: 1 }], held: true })
    expect(document.querySelector('[data-queued-message]')).toBeNull()
    // The composer takes it back.
    await queueBecomes({ items: [], held: false })
    expect(document.querySelector('[data-queued-message]')).toBeNull()
  })

  it('comes back as sent, and says so, when main sent it before the cancel reached it', async () => {
    run.queueList.mockResolvedValue({ items: [{ id: 'q-1', content: 'Queued one', createdAt: 1 }], held: false })
    let answer!: (removed: boolean) => void
    run.queueRemove.mockImplementationOnce(() => new Promise<boolean>((resolve) => { answer = resolve }))
    const view = renderStream()
    await screen.findByText('Queued one')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel queued message' }))
    expect(bubbleRow('Queued one').dataset.phase).toBe('leaving')
    expect(useChatStore.getState().cancelledQueuedIds).toContain('q-1')

    // Main had drained it already: its queue reaches the view before its answer.
    run.queueList.mockResolvedValue({ items: [], held: false })
    await queueBecomes({ items: [], held: false })
    await act(async () => { answer(false) })
    expect(bubbleRow('Queued one').dataset.phase).toBe('sent')
    expect(useChatStore.getState().sendError).toBe(QUEUED_CANCEL_TOO_LATE)
    expect(QUEUED_CANCEL_TOO_LATE).toBe('Already sent — it couldn\'t be cancelled.')
    expect(useChatStore.getState().cancelledQueuedIds).not.toContain('q-1')

    // Past the fade it still stands in for its row, which then takes over.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)) })
    expect(bubbleRow('Queued one').dataset.phase).toBe('sent')
    data.messages = [{ id: 'u-1', role: 'user', content: 'Queued one' }]
    view.rerender()
    expect(document.querySelectorAll('[data-queued-message]')).toHaveLength(0)
    expect(screen.getAllByText('Queued one')).toHaveLength(1)
  })

  it('does not show a held queue: those messages go back to the composer', async () => {
    run.queueList.mockResolvedValue({ items: [{ id: 'q-1', content: 'Held one', createdAt: 1 }], held: true })
    renderStream()
    await waitFor(() => expect(client.getQueryData(['run-queue', 'chat'])).toBeTruthy())
    expect(screen.queryByText('Held one')).toBeNull()
  })

  it('is not mistaken for sent when it is taken back from a held queue', async () => {
    run.queueList.mockResolvedValue({ items: [{ id: 'q-1', content: 'Queued one', createdAt: 1 }], held: false })
    renderStream()
    await screen.findByText('Queued one')
    await queueBecomes({ items: [{ id: 'q-1', content: 'Queued one', createdAt: 1 }], held: true })
    await queueBecomes({ items: [], held: false })
    expect(screen.queryByText('Queued one')).toBeNull()
  })
})

describe('a queued message main hands to the running turn', () => {
  const queuedRow = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-queued-message]')
  const popsIn = (text: string): boolean => !!screen.getByText(text).closest('.anim-user-bubble-pop')

  it('gives way to its live message in the render that shows it, and that message does not pop in a second time', async () => {
    run.queueList.mockResolvedValue({ items: [{ id: 'q-1', content: 'Check the build too', createdAt: 1 }], held: false })
    const blocks: StreamBlock[] = [{ type: 'text', kind: 'text', content: 'Running the check' }]
    useChatStore.setState({ isStreaming: true, streamingBlocks: blocks })
    renderStream()
    await screen.findByText('Check the build too')
    await queueBecomes({ items: [], held: false })
    expect(queuedRow()?.dataset.phase).toBe('sent')

    act(() => useChatStore.setState({ streamingBlocks: [...blocks, { type: 'user', content: 'Check the build too' }] }))
    expect(queuedRow()).toBeNull()
    expect(screen.getAllByText('Check the build too')).toHaveLength(1)
    // Mounted in the hand-over render, and still quiet once the bubble's entry is gone.
    expect(popsIn('Check the build too')).toBe(false)
  })

  it('is not retired by a live message with the same words the turn took in before it was sent', async () => {
    run.queueList.mockResolvedValue({ items: [{ id: 'q-1', content: 'yes', createdAt: 1 }], held: false })
    const blocks: StreamBlock[] = [{ type: 'text', kind: 'text', content: 'Working on it' }, { type: 'user', content: 'yes' }]
    useChatStore.setState({ isStreaming: true, streamingBlocks: blocks })
    renderStream()
    await waitFor(() => expect(queuedRow()).not.toBeNull())
    await queueBecomes({ items: [], held: false })
    expect(queuedRow()?.dataset.phase).toBe('sent')

    act(() => useChatStore.setState({ streamingBlocks: [...blocks, { type: 'text', kind: 'text', content: 'Still working' }] }))
    expect(queuedRow()?.dataset.phase).toBe('sent')
    expect(screen.getAllByText('yes')).toHaveLength(2)

    act(() => useChatStore.setState({ streamingBlocks: [...blocks, { type: 'text', kind: 'text', content: 'Still working' }, { type: 'user', content: 'yes' }] }))
    expect(queuedRow()).toBeNull()
    expect(screen.getAllByText('yes')).toHaveLength(2)
  })

  it('is queued again in place, not brought in again, when main puts it back because the turn would not take it', async () => {
    useChatStore.setState({ isStreaming: true, streamingBlocks: [{ type: 'text', kind: 'text', content: 'Live answer' }] })
    renderStream()
    await waitFor(() => expect(client.getQueryData(['run-queue', 'chat'])).toEqual({ items: [], held: false }))
    await queueBecomes({ items: [{ id: 'q-1', content: 'Queued one', createdAt: 1 }], held: false })
    const row = bubbleRow('Queued one')
    await queueBecomes({ items: [], held: false })
    expect(row.dataset.phase).toBe('sent')

    await queueBecomes({ items: [{ id: 'q-1', content: 'Queued one', createdAt: 1 }], held: false })
    expect(bubbleRow('Queued one')).toBe(row)
    expect(row.dataset.phase).toBe('queued')
    expect(shown('Queued')).toBe(true)
    expect(screen.getAllByText('Queued one')).toHaveLength(1)
    expect(popsIn('Queued one')).toBe(false)
    expect(screen.getByRole('button', { name: 'Cancel queued message' }).hasAttribute('disabled')).toBe(false)

    // And it leaves as sent again when main hands it over the next time.
    await queueBecomes({ items: [], held: false })
    expect(row.dataset.phase).toBe('sent')
  })

  it('keeps the second of two hand-overs with the same words until its own live message, when both left before the first one’s', async () => {
    run.queueList.mockResolvedValue({ items: [{ id: 'q-1', content: 'yes', createdAt: 1 }], held: false })
    const blocks: StreamBlock[] = [{ type: 'text', kind: 'text', content: 'Working on it' }]
    useChatStore.setState({ isStreaming: true, streamingBlocks: blocks })
    renderStream()
    const rows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('[data-queued-message]'))
    await waitFor(() => expect(rows()).toHaveLength(1))
    await queueBecomes({ items: [], held: false })
    await queueBecomes({ items: [{ id: 'q-2', content: 'yes', createdAt: 2 }], held: false })
    await queueBecomes({ items: [], held: false })
    expect(rows().map((row) => row.dataset.phase)).toEqual(['sent', 'sent'])

    act(() => useChatStore.setState({ streamingBlocks: [...blocks, { type: 'user', content: 'yes' }] }))
    expect(rows().map((row) => row.dataset.phase)).toEqual(['sent'])
    expect(screen.getAllByText('yes')).toHaveLength(2)

    act(() => useChatStore.setState({ streamingBlocks: [...blocks, { type: 'user', content: 'yes' }, { type: 'user', content: 'yes' }] }))
    expect(rows()).toHaveLength(0)
    expect(screen.getAllByText('yes')).toHaveLength(2)
  })

  describe('whose cancel main answered too late', () => {
    async function cancelRacingHandOver(): Promise<(removed: boolean) => void> {
      run.queueList.mockResolvedValue({ items: [{ id: 'q-1', content: 'Queued one', createdAt: 1 }], held: false })
      let answer!: (removed: boolean) => void
      run.queueRemove.mockImplementationOnce(() => new Promise<boolean>((resolve) => { answer = resolve }))
      useChatStore.setState({ isStreaming: true, streamingBlocks: [{ type: 'text', kind: 'text', content: 'Live answer' }] })
      renderStream()
      await screen.findByText('Queued one')
      fireEvent.click(screen.getByRole('button', { name: 'Cancel queued message' }))
      // Main handed it to the turn: its queue reaches the view before its answer.
      run.queueList.mockResolvedValue({ items: [], held: false })
      await queueBecomes({ items: [], held: false })
      return answer
    }
    const putBack = { items: [{ id: 'q-1', content: 'Queued one', createdAt: 1 }], held: false }
    /** Cancelled again: it leaves, still the user's cancel, and once main has removed it the bubble is gone. */
    async function leavesCancelled(): Promise<void> {
      expect(run.queueRemove).toHaveBeenCalledTimes(2)
      expect(run.queueRemove).toHaveBeenLastCalledWith('chat', 'q-1')
      expect(bubbleRow('Queued one').dataset.phase).toBe('leaving')
      expect(useChatStore.getState().cancelledQueuedIds).toContain('q-1')
      run.queueList.mockResolvedValue({ items: [], held: false })
      await queueBecomes({ items: [], held: false })
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)) })
      expect(document.querySelector('[data-queued-message]')).toBeNull()
      expect(useChatStore.getState().cancelledQueuedIds).toContain('q-1')
    }

    it('cancels it again when main puts it back after answering, and drops "Already sent"', async () => {
      const answer = await cancelRacingHandOver()
      await act(async () => { answer(false) })
      expect(bubbleRow('Queued one').dataset.phase).toBe('sent')
      expect(useChatStore.getState().sendError).toBe(QUEUED_CANCEL_TOO_LATE)

      run.queueList.mockResolvedValue(putBack)
      await queueBecomes(putBack)
      expect(useChatStore.getState().sendError).toBeNull()
      await leavesCancelled()
      expect(useChatStore.getState().sendError).toBeNull()
    })

    it('leaves another error in its place alone', async () => {
      const answer = await cancelRacingHandOver()
      await act(async () => { answer(false) })
      act(() => useChatStore.getState().setSendError('Could not change who answers'))

      run.queueList.mockResolvedValue(putBack)
      await queueBecomes(putBack)
      expect(bubbleRow('Queued one').dataset.phase).toBe('leaving')
      expect(useChatStore.getState().sendError).toBe('Could not change who answers')
    })

    it('cancels it again, saying nothing, when main had put the message back before it answered', async () => {
      const answer = await cancelRacingHandOver()
      run.queueList.mockResolvedValue(putBack)
      await queueBecomes(putBack)
      await act(async () => { answer(false) })
      expect(useChatStore.getState().sendError).toBeNull()
      await leavesCancelled()
      expect(useChatStore.getState().sendError).toBeNull()
    })

    it('leaves it queued, saying nothing, when main answers the second cancel too late as well', async () => {
      const answer = await cancelRacingHandOver()
      await act(async () => { answer(false) })
      run.queueRemove.mockResolvedValueOnce(false)
      run.queueList.mockResolvedValue(putBack)
      await queueBecomes(putBack)
      await act(async () => {})
      expect(run.queueRemove).toHaveBeenCalledTimes(2)
      expect(bubbleRow('Queued one').dataset.phase).toBe('queued')
      expect(useChatStore.getState().sendError).toBeNull()
      expect(useChatStore.getState().cancelledQueuedIds).not.toContain('q-1')
      // Past the fade it is still there, queued.
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)) })
      expect(bubbleRow('Queued one').dataset.phase).toBe('queued')
    })
  })
})

describe('sending', () => {
  it('re-engages following for a send with no optimistic bubble', () => {
    renderStream()
    stick.scrollToBottom.mockClear()
    act(() => useChatStore.getState().noteSent())
    expect(stick.scrollToBottom).toHaveBeenCalled()
  })
})

describe('a message the running turn took in', () => {
  it('renders as a user bubble where it landed, splitting the tool dots before and after it', () => {
    const blocks: StreamBlock[] = [
      { type: 'text', kind: 'tool', toolId: 't1', toolName: 'Read', content: 'Read a.ts' },
      { type: 'text', kind: 'tool_result', toolId: 't1', toolStream: 'stdout', content: 'contents of a' },
      { type: 'user', content: 'Also check b' },
      { type: 'text', kind: 'tool', toolId: 't2', toolName: 'Read', content: 'Read b.ts' },
      { type: 'text', kind: 'tool_result', toolId: 't2', toolStream: 'stdout', content: 'contents of b' }
    ]
    useChatStore.setState({ isStreaming: true, streamingBlocks: blocks })
    renderStream()

    const groups = screen.getAllByRole('button', { name: /^(Expand|Collapse) \d+ steps?$/ })
    expect(groups).toHaveLength(2)
    const message = screen.getByText('Also check b')
    expect(follows(groups[0], message)).toBe(true)
    expect(follows(message, groups[1])).toBe(true)
    expect(message.closest('[data-queued-message]')).toBeNull()
    // A message steered straight in, with no queued bubble before it, pops in.
    expect(message.closest('.anim-user-bubble-pop')).not.toBeNull()
  })
})
