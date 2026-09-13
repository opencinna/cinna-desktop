import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useMessageContextMenu } from './MessageContextMenu'
import { MessageBubble } from './MessageBubble'
import { useAuthStore } from '../../stores/auth.store'
import { useUIStore } from '../../stores/ui.store'

vi.hoisted(() => { window.api = { app: { setTheme: async () => {} } } as never })
const copy = vi.fn()
const create = vi.fn()
const markdown = '# Plan\n\nKeep **formatting** and [links](https://example.com).\n\n```ts\nconst value = 1\n```'

beforeEach(() => {
  copy.mockReset().mockResolvedValue(undefined)
  create.mockReset().mockResolvedValue({ id: 'note-1' })
  vi.stubGlobal('navigator', { clipboard: { writeText: copy } })
  window.api = { notes: { create }, app: { setTheme: async () => {} } } as never
  useAuthStore.setState({ currentUser: { id: 'alice' } as never })
  useUIStore.setState({ activeView: 'chat', activeNoteId: null })
  window.getSelection()?.removeAllRanges()
})
afterEach(() => vi.unstubAllGlobals())

function Harness({ chatId = 'chat-1', content = markdown }: { chatId?: string; content?: string }) {
  const context = useMessageContextMenu(chatId)
  return <><button>Outside</button><div data-testid="transcript" onContextMenu={context.onContextMenu}>
    <MessageBubble role="assistant" content={content} />
    <MessageBubble role="user" content="My **question**" />
    <pre>Selected tool output</pre>
    <textarea aria-label="Inline input" />
  </div>{context.menu}</>
}
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const result = render(<Harness />, { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> })
  return { ...result, client }
}
function selectText(element: Node, start = 0, end = element.textContent!.length) {
  const range = document.createRange()
  range.setStart(element, start)
  range.setEnd(element, end)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
}
function open() { fireEvent.contextMenu(screen.getByRole('heading', { name: 'Plan' }), { clientX: 150, clientY: 100 }) }

it('copies the original Markdown of assistant and user messages', async () => {
  mount()
  open()
  fireEvent.click(screen.getByRole('menuitem', { name: 'Copy text' }))
  await waitFor(() => expect(copy).toHaveBeenCalledWith(markdown))
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  fireEvent.contextMenu(screen.getByText('question'))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Copy text' }))
  await waitFor(() => expect(copy).toHaveBeenLastCalledWith('My **question**'))
})

it('captures the selected excerpt before menu focus or streaming changes it', async () => {
  const { rerender } = mount()
  const bold = screen.getByText('formatting')
  selectText(bold.firstChild!, 0, 6)
  fireEvent.contextMenu(bold)
  window.getSelection()?.removeAllRanges()
  rerender(<Harness content={markdown + '\n\nMore streaming text'} />)
  fireEvent.click(screen.getByRole('menuitem', { name: 'Copy text' }))
  await waitFor(() => expect(copy).toHaveBeenCalledWith('format'))
})

it('saves selected text as a new note and opens it', async () => {
  const { client } = mount()
  const invalidated = vi.spyOn(client, 'invalidateQueries')
  const output = screen.getByText('Selected tool output')
  selectText(output.firstChild!, 0, 8)
  fireEvent.contextMenu(output)
  window.getSelection()?.removeAllRanges()
  fireEvent.click(screen.getByRole('menuitem', { name: 'Save to Notes' }))
  await waitFor(() => expect(create).toHaveBeenCalledWith({ title: 'Selected', body: 'Selected' }))
  await waitFor(() => expect(useUIStore.getState().activeNoteId).toBe('note-1'))
  expect(useUIStore.getState().activeView).toBe('note-detail')
  expect(invalidated).toHaveBeenCalledWith({ queryKey: ['notes'] })
})

it('uses the full Markdown and a readable title when saving without a selection', async () => {
  mount()
  open()
  fireEvent.click(screen.getByRole('menuitem', { name: 'Save to Notes' }))
  await waitFor(() => expect(create).toHaveBeenCalledWith({ title: 'Plan', body: markdown }))
})

it('supports keyboard navigation, viewport clamping and dismissal on navigation', () => {
  const { rerender } = mount()
  screen.getByText('Outside').focus()
  fireEvent.contextMenu(screen.getByRole('heading'), { clientX: 10000, clientY: 10000 })
  const menu = screen.getByRole('menu')
  expect(parseFloat(menu.style.left)).toBeLessThan(window.innerWidth)
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Copy text' }))
  fireEvent.pointerEnter(screen.getByRole('menuitem', { name: 'Save to Notes' }))
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Save to Notes' }))
  fireEvent.pointerMove(screen.getByRole('menuitem', { name: 'Copy text' }))
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Copy text' }))
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Save to Notes' }))
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  expect(screen.queryByRole('menu')).toBeNull()
  expect(document.activeElement).toBe(screen.getByText('Outside'))
  open()
  fireEvent.pointerDown(screen.getByText('Outside'))
  expect(screen.queryByRole('menu')).toBeNull()
  open()
  rerender(<Harness chatId="chat-2" />)
  expect(screen.queryByRole('menu')).toBeNull()
  open()
  fireEvent.scroll(screen.getByTestId('transcript'))
  expect(screen.getByRole('menu')).toBeTruthy()
  fireEvent.wheel(screen.getByTestId('transcript'))
  expect(screen.queryByRole('menu')).toBeNull()
})

it('keeps failed actions retryable and does not create duplicate notes while saving', async () => {
  copy.mockRejectedValueOnce(new Error('Clipboard unavailable'))
  create.mockRejectedValueOnce(new Error('Notes unavailable'))
  mount()
  open()
  fireEvent.click(screen.getByRole('menuitem', { name: 'Copy text' }))
  await screen.findByRole('alert')
  expect(create).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('menuitem', { name: 'Save to Notes' }))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Notes unavailable'))
  let finish!: (note: unknown) => void
  create.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Save to Notes' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Save to Notes' }))
  await waitFor(() => expect(create).toHaveBeenCalledTimes(2))
  await act(async () => finish({ id: 'note-2' }))
})

it.each([false, true])('guards a profile change when notes IPC has started=%s', async (started) => {
  let finish!: (note: unknown) => void
  create.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
  const { client } = mount()
  const invalidated = vi.spyOn(client, 'invalidateQueries')
  open()
  fireEvent.click(screen.getByRole('menuitem', { name: 'Save to Notes' }))
  if (started) await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
  act(() => useAuthStore.setState({ currentUser: { id: 'bob' } as never }))
  await act(async () => finish({ id: 'alice-note' }))
  expect(useUIStore.getState().activeNoteId).toBeNull()
  expect(invalidated).not.toHaveBeenCalled()
  expect(create).toHaveBeenCalledTimes(started ? 1 : 0)
})

it('leaves blank transcript areas and editable fields to their usual context menu', () => {
  mount()
  fireEvent.contextMenu(screen.getByTestId('transcript'))
  expect(screen.queryByRole('menu')).toBeNull()
  fireEvent.contextMenu(screen.getByRole('textbox', { name: 'Inline input' }))
  expect(screen.queryByRole('menu')).toBeNull()
})
