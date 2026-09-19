import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useUIStore } from '../../stores/ui.store'
import { useChatStore } from '../../stores/chat.store'
import type { ChatListSummary } from '../../../../shared/chatListSummary'
import { HOVER_CLOSE_DELAY_MS } from '../ui/useHoverPopover'

const cancelChat = vi.fn()
const deleteChat = vi.fn()
;(window as unknown as { api: unknown }).api = {
  app: { setTheme: vi.fn().mockResolvedValue(undefined) },
  run: { cancelChat },
  chat: { delete: deleteChat }
}
const { ChatItem } = await import('./ChatItem')
const chat = { id: 'background-chat', title: 'Background session', updatedAt: new Date() }
let client: QueryClient

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  cancelChat.mockReset().mockResolvedValue(undefined)
  deleteChat.mockReset().mockResolvedValue({ success: true })
  useChatStore.setState({ activeChatId: 'selected-chat', isStreaming: false })
})
afterEach(() => { vi.useRealTimers(); client.clear() })

function row(activeRunId: string | null) {
  return <QueryClientProvider client={client}><ChatItem chat={{ ...chat, activeRunId }} /></QueryClientProvider>
}

it('interrupts a background session without selecting or deleting it, then allows deletion after it stops', async () => {
  let finishCancel!: () => void
  cancelChat.mockImplementation(() => new Promise<void>((resolve) => { finishCancel = resolve }))
  const view = render(row('run-1'))
  expect(screen.queryByRole('button', { name: 'Delete session' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Interrupt session' }))
  await waitFor(() => expect(cancelChat).toHaveBeenCalledWith(chat.id))
  expect(useChatStore.getState().activeChatId).toBe('selected-chat')
  expect(deleteChat).not.toHaveBeenCalled()
  expect((screen.getByRole('button', { name: 'Interrupting session…' }) as HTMLButtonElement).disabled).toBe(true)

  await act(async () => finishCancel())
  // Cancel acknowledges the request before the run actually finishes.
  await waitFor(() => expect(screen.getByRole('button', { name: 'Interrupt session' })).toBeTruthy())
  expect(screen.queryByRole('button', { name: 'Delete session' })).toBeNull()
  view.rerender(row(null))
  fireEvent.click(screen.getByRole('button', { name: 'Delete session' }))
  await waitFor(() => expect(deleteChat).toHaveBeenCalledWith(chat.id))
})

it('keeps a running row interruptible after selecting a different chat', () => {
  useChatStore.setState({ activeChatId: chat.id, isStreaming: true })
  render(row('run-1'))
  expect(screen.getByRole('button', { name: 'Interrupt session' })).toBeTruthy()
  act(() => useChatStore.getState().setActiveChatId('another-chat'))
  expect(screen.getByRole('button', { name: 'Interrupt session' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Delete session' })).toBeNull()
})

it('shows interruption failures and keeps the running session available to retry', async () => {
  cancelChat.mockRejectedValue(new Error('Could not interrupt'))
  render(row('run-1'))
  fireEvent.click(screen.getByRole('button', { name: 'Interrupt session' }))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Could not interrupt'))
  expect((screen.getByRole('button', { name: 'Interrupt session' }) as HTMLButtonElement).disabled).toBe(false)
  expect(deleteChat).not.toHaveBeenCalled()
})

it.each([
  ['completed', 'Completed'], ['needs_input', 'Needs input'], ['failed', 'Failed']
] as const)('shows the unread %s result until it is read, with delete still available', (status, label) => {
  const result = { runId: 'run-1', status, unread: true }
  const content = (unread: boolean, activeRunId: string | null = null) =>
    <QueryClientProvider client={client}><ChatItem chat={{ ...chat, activeRunId, lastRunResult: { ...result, unread } }} /></QueryClientProvider>
  const view = render(content(true))
  expect(screen.getByRole('img', { name: `${label} — unread results` })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Delete session' })).toBeTruthy()
  view.rerender(content(true, 'run-2'))
  expect(screen.queryByRole('img')).toBeNull()
  expect(screen.getByRole('button', { name: 'Interrupt session' })).toBeTruthy()
  view.rerender(content(false))
  expect(screen.queryByRole('img')).toBeNull()
  expect(screen.getByRole('button', { name: 'Delete session' })).toBeTruthy()
})

it('returns directly to delete after interruption without an unread indicator', () => {
  render(<QueryClientProvider client={client}><ChatItem chat={{ ...chat,
    lastRunResult: { runId: 'run-1', status: 'canceled', unread: false } }} /></QueryClientProvider>)
  expect(screen.queryByRole('img')).toBeNull()
  expect(screen.getByRole('button', { name: 'Delete session' })).toBeTruthy()
})

const summary: ChatListSummary = {
  with: { kind: 'agent', name: 'Research Agent', color: null, agentId: 'a-research', source: 'folder', driver: 'acp', protocol: 'acp' },
  others: ['Writer', 'Reviewer'],
  firstMessageAt: new Date(2026, 8, 12, 14, 0),
  lastMessageAt: new Date(2026, 8, 12, 14, 25),
  messageCount: 14
}

function summarised(value: ChatListSummary | null = summary) {
  return <QueryClientProvider client={client}><ChatItem chat={{ ...chat, createdAt: new Date(2026, 8, 12, 13, 59) }} summary={value ?? undefined} /></QueryClientProvider>
}

it('names who the chat is with as soon as the row is hovered, and takes it away on leaving', () => {
  render(summarised())
  const item = screen.getByText('Background session').parentElement!
  expect(screen.queryByRole('tooltip')).toBeNull()

  fireEvent.mouseEnter(item)
  const tooltip = screen.getByRole('tooltip')
  expect(tooltip.textContent).toContain('Research Agent')
  // The agent's type icon, as the Agents list draws it — not a coloured dot.
  expect(tooltip.querySelector('[title="Local CLI agent"] svg')).toBeTruthy()
  expect(tooltip.querySelector('.rounded-full')).toBeNull()
  expect(tooltip.textContent).toContain('with Writer, Reviewer')
  expect(tooltip.textContent).toContain('25 min · 14 messages')
  expect(item.getAttribute('aria-describedby')).toBe(tooltip.id)
  expect(item.contains(tooltip)).toBe(false)

  vi.useFakeTimers()
  fireEvent.mouseLeave(item)
  // Not at once: the pointer may be on its way onto the tooltip.
  act(() => { vi.advanceTimersByTime(HOVER_CLOSE_DELAY_MS - 1) })
  expect(screen.queryByRole('tooltip')).toBeTruthy()
  act(() => { vi.advanceTimersByTime(1) })
  expect(screen.queryByRole('tooltip')).toBeNull()
  expect(item.hasAttribute('aria-describedby')).toBe(false)
})

it('marks a plain chat\'s mode as a chat mode', () => {
  render(summarised({ ...summary, with: { kind: 'mode', name: 'Research', color: 'violet' }, others: [] }))
  fireEvent.mouseEnter(screen.getByText('Background session').parentElement!)
  expect(screen.getByRole('tooltip').textContent).toContain('Researchchat mode')
  expect(screen.getByRole('tooltip').textContent).not.toContain('with ')
  // A chat, in the mode's colour; no agent type is claimed.
  const icon = screen.getByRole('tooltip').querySelector('svg') as SVGElement
  expect(icon.style.color).not.toBe('')
  expect(icon.style.color).not.toBe('var(--color-text-muted)')
  expect(screen.getByRole('tooltip').querySelector('[title]')).toBeNull()
})

it('leads with the model of a chat that has neither agent nor mode, and with nothing when it has no model', () => {
  const view = render(summarised({ ...summary, with: { kind: 'none', name: 'claude-sonnet', color: null }, others: [] }))
  fireEvent.mouseEnter(screen.getByText('Background session').parentElement!)
  expect(screen.getByRole('tooltip').textContent).toMatch(/^claude-sonnetStarted/)
  expect((screen.getByRole('tooltip').querySelector('svg') as SVGElement).style.color).toBe('var(--color-text-muted)')
  view.unmount()

  const nameless = { ...summary, with: { kind: 'none' as const, name: '', color: null }, others: [] }
  const second = render(summarised(nameless))
  fireEvent.mouseEnter(screen.getByText('Background session').parentElement!)
  const tooltip = screen.getByRole('tooltip')
  expect(tooltip.textContent).toMatch(/^Started/)
  expect(tooltip.querySelector('svg')).toBeNull()
  expect(tooltip.querySelector('dl')!.className).not.toContain('mt-')
  second.unmount()

  // Nothing but a start time is nothing the list's order has not said already.
  render(summarised({ ...nameless, messageCount: 1 }))
  fireEvent.mouseEnter(screen.getByText('Background session').parentElement!)
  expect(screen.queryByRole('tooltip')).toBeNull()
})

it('stays open across the action button, which lies on the way to it, and holds the button\'s native title back meanwhile', () => {
  render(summarised())
  const item = screen.getByText('Background session').parentElement!
  const button = screen.getByRole('button', { name: 'Delete session' })
  expect(button.getAttribute('title')).toBe('Delete session')
  fireEvent.mouseEnter(item)
  fireEvent.mouseEnter(button)
  expect(screen.getByRole('tooltip')).toBeTruthy()
  expect(button.getAttribute('title')).toBeNull()
  expect(screen.getByRole('button', { name: 'Delete session' })).toBe(button)
})

it('stays open when the pointer goes from the tooltip straight back onto its own row', () => {
  vi.useFakeTimers()
  render(summarised())
  const title = screen.getByText('Background session')
  fireEvent.mouseEnter(title.parentElement!)
  const tooltip = screen.getByRole('tooltip')

  // A real pointer: React derives enter/leave from mouseout, and with the row
  // as the common React parent the row itself hears neither.
  fireEvent.mouseOut(tooltip, { relatedTarget: title })
  act(() => { vi.advanceTimersByTime(HOVER_CLOSE_DELAY_MS * 5) })
  expect(screen.getByRole('tooltip')).toBe(tooltip)
})

it('stays open when the pointer crosses from the row onto the tooltip, and closes after it has left both', () => {
  vi.useFakeTimers()
  render(summarised())
  const item = screen.getByText('Background session').parentElement!
  fireEvent.mouseEnter(item)
  const tooltip = screen.getByRole('tooltip')
  expect(tooltip.className).not.toContain('pointer-events-none')

  fireEvent.mouseLeave(item)
  act(() => { vi.advanceTimersByTime(HOVER_CLOSE_DELAY_MS - 50) })
  fireEvent.mouseEnter(tooltip)
  act(() => { vi.advanceTimersByTime(HOVER_CLOSE_DELAY_MS * 5) })
  expect(screen.getByRole('tooltip')).toBe(tooltip)

  // And back onto the row the same way.
  fireEvent.mouseLeave(tooltip)
  act(() => { vi.advanceTimersByTime(HOVER_CLOSE_DELAY_MS - 50) })
  fireEvent.mouseEnter(item)
  act(() => { vi.advanceTimersByTime(HOVER_CLOSE_DELAY_MS * 5) })
  expect(screen.getByRole('tooltip')).toBeTruthy()

  fireEvent.mouseLeave(item)
  act(() => { vi.advanceTimersByTime(HOVER_CLOSE_DELAY_MS) })
  expect(screen.queryByRole('tooltip')).toBeNull()
})

it('never shows two: hovering another row closes the first row\'s tooltip at once', () => {
  vi.useFakeTimers()
  render(<QueryClientProvider client={client}>
    <ChatItem chat={{ ...chat, id: 'a', title: 'Row A' }} summary={summary} />
    <ChatItem chat={{ ...chat, id: 'b', title: 'Row B' }} summary={{ ...summary, with: { ...summary.with, name: 'Writer' } }} />
  </QueryClientProvider>)
  const a = screen.getByText('Row A').parentElement!
  const b = screen.getByText('Row B').parentElement!
  fireEvent.mouseEnter(a)
  fireEvent.mouseLeave(a)
  fireEvent.mouseEnter(b)
  const open = screen.getAllByRole('tooltip')
  expect(open.length).toBe(1)
  expect(open[0].textContent).toContain('Writer')
  // A's pending close must not take B's with it.
  act(() => { vi.advanceTimersByTime(HOVER_CLOSE_DELAY_MS * 2) })
  expect(screen.getByRole('tooltip').textContent).toContain('Writer')
})

it('does not navigate or close on a press or click inside the tooltip', () => {
  render(summarised())
  fireEvent.mouseEnter(screen.getByText('Background session').parentElement!)
  const tooltip = screen.getByRole('tooltip')
  fireEvent.mouseDown(tooltip)
  fireEvent.click(tooltip)
  expect(screen.getByRole('tooltip')).toBe(tooltip)
  expect(useChatStore.getState().activeChatId).toBe('selected-chat')
})

it('still opens the chat on click, closing the tooltip on the way', () => {
  render(summarised())
  const item = screen.getByText('Background session').parentElement!
  fireEvent.mouseEnter(item)
  fireEvent.mouseDown(item)
  expect(screen.queryByRole('tooltip')).toBeNull()
  fireEvent.click(item)
  expect(useChatStore.getState().activeChatId).toBe(chat.id)
})

it('closes when a container of the row scrolls, rather than stay beside the wrong row', () => {
  render(<div data-testid="list">{summarised()}</div>)
  fireEvent.mouseEnter(screen.getByText('Background session').parentElement!)
  expect(screen.getByRole('tooltip')).toBeTruthy()
  fireEvent.scroll(screen.getByTestId('list'))
  expect(screen.queryByRole('tooltip')).toBeNull()
})

it('closes when the window itself scrolls', () => {
  render(summarised())
  fireEvent.mouseEnter(screen.getByText('Background session').parentElement!)
  fireEvent.scroll(document)
  expect(screen.queryByRole('tooltip')).toBeNull()
})

it('stays open while something that does not hold the row scrolls, as the transcript does all through a streaming turn', () => {
  render(<div><div data-testid="list">{summarised()}</div><div data-testid="transcript" /></div>)
  fireEvent.mouseEnter(screen.getByText('Background session').parentElement!)
  fireEvent.scroll(screen.getByTestId('transcript'))
  fireEvent.scroll(screen.getByTestId('transcript'))
  expect(screen.getByRole('tooltip')).toBeTruthy()
})

it('shows no tooltip for a row that carries no summary', () => {
  render(summarised(null))
  fireEvent.mouseEnter(screen.getByText('Background session').parentElement!)
  expect(screen.queryByRole('tooltip')).toBeNull()
})

it('closes when the list moves the row, rather than stay beside another', () => {
  const at = (index: number) => <QueryClientProvider client={client}><ChatItem chat={chat} summary={summary} index={index} /></QueryClientProvider>
  const { rerender } = render(at(2))
  fireEvent.mouseEnter(screen.getByText('Background session').parentElement!)
  expect(screen.getByRole('tooltip')).toBeTruthy()

  rerender(at(2))
  expect(screen.getByRole('tooltip')).toBeTruthy()
  rerender(at(0))
  expect(screen.queryByRole('tooltip')).toBeNull()
})

it('glows on some openings only, and never with Extra UI animation off', () => {
  const chance = vi.spyOn(Math, 'random').mockReturnValue(0.1)
  useUIStore.setState({ extraUIAnimation: true })
  const first = render(summarised())
  fireEvent.mouseEnter(screen.getByText('Background session').parentElement!)
  expect(screen.getByRole('tooltip').hasAttribute('data-ambient-glow')).toBe(true)
  expect(screen.getByRole('tooltip').style.getPropertyValue('--button-glow-duration')).not.toBe('')
  first.unmount()

  useUIStore.setState({ extraUIAnimation: false })
  const second = render(summarised())
  fireEvent.mouseEnter(screen.getByText('Background session').parentElement!)
  expect(screen.getByRole('tooltip').hasAttribute('data-ambient-glow')).toBe(false)
  second.unmount()

  useUIStore.setState({ extraUIAnimation: true })
  chance.mockReturnValue(0.9)
  render(summarised())
  fireEvent.mouseEnter(screen.getByText('Background session').parentElement!)
  expect(screen.getByRole('tooltip').hasAttribute('data-ambient-glow')).toBe(false)
  chance.mockRestore()
})
