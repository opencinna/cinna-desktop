import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PinnedAgentFile } from '../../../../shared/agentFiles'

vi.mock('../../stores/logger.store', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
const capabilities = vi.hoisted(() => ({ notesEnabled: true, dashboardsEnabled: true, loaded: true }))
vi.mock('../../hooks/useCapabilities', () => ({ useCapabilities: () => capabilities }))

import { PINNED_FILES_GUTTER_PX, PinnedFilesCard, gutterFits, middleEllipsisParts, pinDropRank, pinnedFilesMode } from './PinnedFilesCard'
import { useFilePreviewStore } from '../../stores/filePreview.store'
import { useUIStore } from '../../stores/ui.store'
import { useAuthStore } from '../../stores/auth.store'

/**
 * The chat's Pinned files: one always-open block, never over a message. It
 * floats in the gutter right of the transcript's column when it fits there;
 * otherwise it asks the chat area for room, beside the transcript or above
 * it. What a row does on a click, a right-click and a drop.
 */

/** The chat area's box, as the layout would give it. */
const layout = vi.hoisted(() => ({ areaWidth: 1600, resize: [] as Array<() => void> }))
const box = (left: number, width: number, top = 0, height = 800): DOMRect =>
  ({ left, width, right: left + width, top, height, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect
function setWidths(areaWidth: number): void {
  layout.areaWidth = areaWidth
  act(() => layout.resize.forEach((fire) => fire()))
}

const pin = (name: string, rank: number, more: Partial<PinnedAgentFile> = {}): PinnedAgentFile => ({
  path: `/agent/${name}`, displayPath: name, inside: true, rank, exists: true, ...more
})

const listPins = vi.fn()
const setPin = vi.fn()
const movePin = vi.fn()
const openAgentFile = vi.fn()
const onReserveChange = vi.fn()
let client: QueryClient
const originalOpen = useFilePreviewStore.getState().openAgentFile

beforeEach(() => {
  layout.areaWidth = 1600
  layout.resize = []
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.dataset.testid === 'area') return box(0, layout.areaWidth)
    return box(0, 0, 0, 0)
  })
  window.ResizeObserver = class {
    constructor(private callback: ResizeObserverCallback) {
      layout.resize.push(() => this.callback([], this as never))
    }
    observe(): void {}
    disconnect(): void {}
  } as never
  onReserveChange.mockReset()
  listPins.mockReset().mockResolvedValue({ success: true, pins: [pin('plan.md', 1), pin('main.py', 2), pin('gone.csv', 3, { exists: false })] })
  setPin.mockReset().mockResolvedValue({ success: true, pinned: false })
  movePin.mockReset().mockResolvedValue({ success: true })
  openAgentFile.mockReset().mockResolvedValue(undefined)
  window.api = { agentFiles: { listPins, setPin, movePin } } as never
  useFilePreviewStore.setState({ openAgentFile })
  useUIStore.setState({ minimalView: false })
  useAuthStore.setState({ currentUser: { id: 'alice' } as never })
  localStorage.clear()
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['agents'], [{ id: 'folder:a', name: 'A', enabled: true, capabilities: { cwd: true } }])
})

afterEach(() => {
  useFilePreviewStore.setState({ openAgentFile: originalOpen })
  vi.restoreAllMocks()
})

function mount(props: { chatId?: string | null; agentId?: string | null } = {}) {
  return render(
    <QueryClientProvider client={client}>
      <div data-testid="area">
        <PinnedFilesCard
          chatId={props.chatId === undefined ? 'chat-1' : props.chatId}
          agentId={props.agentId === undefined ? 'folder:a' : props.agentId}
          onReserveChange={onReserveChange}
        />
      </div>
    </QueryClientProvider>
  )
}

const card = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-pinned-files-card]')
const header = (): HTMLElement => screen.getByRole('heading', { name: /Pinned files/ })
/** The room last asked of the chat area. */
const reserve = (): unknown => onReserveChange.mock.calls.at(-1)?.[0]
const row = (name: string): HTMLElement => screen.getByTitle(name)

describe('when it shows', () => {
  it('lists the root agent’s pins under a header with their count, always open', async () => {
    mount()
    await waitFor(() => expect(card()).not.toBeNull())
    expect(header().textContent).toBe('Pinned files3')
    expect(card()!.getAttribute('aria-labelledby')).toBe(header().id)
    // No fold and no chip: the header is not a control, and every row is there.
    expect(within(card()!).queryByRole('button', { name: /Pinned files/ })).toBeNull()
    expect(card()!.querySelector('[aria-expanded]')).toBeNull()
    expect(document.querySelector('[data-pinned-files-chip]')).toBeNull()
    const list = screen.getByRole('list', { name: 'Pinned files' })
    expect(within(list).getAllByRole('button').map((b) => b.title)).toEqual(['plan.md', 'main.py', 'gone.csv'])
    expect(listPins).toHaveBeenCalledWith({ agentId: 'folder:a' })
  })

  it('is not there with no pins', async () => {
    listPins.mockResolvedValue({ success: true, pins: [] })
    mount()
    await waitFor(() => expect(listPins).toHaveBeenCalled())
    await act(async () => {})
    expect(card()).toBeNull()
    // No block, so no room asked for at any width.
    setWidths(900)
    setWidths(500)
    expect(card()).toBeNull()
    expect(onReserveChange.mock.calls.every(([value]) => value === null)).toBe(true)
  })

  it('is not there for a chat whose root agent is not a folder agent, and asks nothing', () => {
    mount({ agentId: null })
    expect(card()).toBeNull()
    expect(listPins).not.toHaveBeenCalled()
  })

  it('is not there in Minimal view', async () => {
    useUIStore.setState({ minimalView: true })
    layout.areaWidth = 900
    mount()
    await act(async () => {})
    expect(card()).toBeNull()
    expect(reserve()).toBeNull()
    expect(listPins).not.toHaveBeenCalled()
  })

  it('sits under the top bar’s drag strip, out of its drag region', async () => {
    mount()
    await waitFor(() => expect(card()).not.toBeNull())
    expect(card()!.style.top).toBe('calc(var(--topbar-h) + 12px)')
    expect(card()!.className).toContain('[-webkit-app-region:no-drag]')
  })
})

describe('a row', () => {
  it('opens the preview, as a reference in the transcript does', async () => {
    mount()
    await waitFor(() => expect(card()).not.toBeNull())
    fireEvent.click(row('main.py'), { detail: 1, clientX: 30, clientY: 40 })
    expect(openAgentFile).toHaveBeenCalledWith(
      'folder:a',
      { text: 'main.py', path: '/agent/main.py', displayPath: 'main.py', kind: 'file', inside: true },
      { x: 30, y: 40 }
    )
  })

  it('opens the same menu as the transcript on a right-click, Unpin file first, and unpins', async () => {
    mount()
    await waitFor(() => expect(card()).not.toBeNull())
    fireEvent.contextMenu(row('plan.md'), { clientX: 20, clientY: 20 })
    await screen.findByRole('menuitem', { name: 'Unpin file' })
    listPins.mockResolvedValue({ success: true, pins: [pin('main.py', 2), pin('gone.csv', 3, { exists: false })] })
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Unpin file', 'Copy contents', 'Save to Notes', 'Copy full path', 'Show in the folder', 'Reference in a new chat'
    ])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Unpin file' }))
    await waitFor(() => expect(setPin).toHaveBeenCalledWith({ agentId: 'folder:a', path: '/agent/plan.md', pinned: false }))
    await waitFor(() => expect(screen.queryByTitle('plan.md')).toBeNull())
  })

  it('shows a missing file dimmed, with a glyph that says so, and still unpinnable', async () => {
    mount()
    await waitFor(() => expect(card()).not.toBeNull())
    const gone = row('gone.csv')
    expect(within(gone).getByRole('img', { name: 'File not found' })).toBeTruthy()
    expect(gone.querySelector('[data-pin-label]')!.className).toContain('opacity-50')
    expect(within(row('plan.md')).queryByRole('img', { name: 'File not found' })).toBeNull()
    fireEvent.contextMenu(gone, { clientX: 20, clientY: 20 })
    expect(await screen.findByRole('menuitem', { name: 'Unpin file' })).toBeTruthy()
    // Only what works without the file: no contents, no folder, no new chat about it.
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Unpin file', 'Copy full path'])
    expect(screen.getAllByRole('separator')).toHaveLength(1)
  })
})

describe('a long name', () => {
  it('is cut in the middle, keeping the end of the stem and the extension', () => {
    expect(middleEllipsisParts('quarterly_revenue_breakdown_04.md')).toEqual({ head: 'quarterly_revenue_breakd', tail: 'own_04.md' })
    expect(middleEllipsisParts('quarterly_revenue_breakdown_12.md').tail).toBe('own_12.md')
    // No extension, or one too long to be one: the last characters alone.
    expect(middleEllipsisParts('Makefile_for_the_release')).toEqual({ head: 'Makefile_for_the_r', tail: 'elease' })
    expect(middleEllipsisParts('archive.verylongext')).toEqual({ head: 'archive.veryl', tail: 'ongext' })
    // Short: not split.
    expect(middleEllipsisParts('plan.md')).toEqual({ head: 'plan.md', tail: '' })
  })

  it('renders as a truncating head and a tail that always shows, the whole name read as one', async () => {
    listPins.mockResolvedValue({ success: true, pins: [pin('quarterly_revenue_breakdown_04.md', 1)] })
    mount()
    await waitFor(() => expect(card()).not.toBeNull())
    const button = row('quarterly_revenue_breakdown_04.md')
    const label = button.querySelector('[data-pin-label]')!
    expect(label.textContent).toBe('quarterly_revenue_breakdown_04.md')
    const [head, tail] = Array.from(label.children)
    expect(head.className).toContain('truncate')
    expect(tail.textContent).toBe('own_04.md')
    expect(tail.className).toContain('shrink-0')
  })
})

describe('where it goes', () => {
  it('fits the gutter only with the block and its margins clear of the column', () => {
    // 1600 wide: 416 px right of the 768 px column.
    expect(gutterFits(1600)).toBe(true)
    // The block's 224 px plus 20 px to the window side and 12 px from the column: 256 exactly, then one pixel less.
    expect(PINNED_FILES_GUTTER_PX).toBe(256)
    expect(gutterFits(768 + 2 * 256)).toBe(true)
    expect(gutterFits(768 + 2 * 255)).toBe(false)
    // Room for the block alone, not its margins, is not enough.
    expect(gutterFits(768 + 2 * 230)).toBe(false)
    // At the app's 17 px rem the column is 816 px wide.
    expect(gutterFits(816 + 2 * 256, 17)).toBe(true)
    expect(gutterFits(816 + 2 * 255, 17)).toBe(false)
    expect(gutterFits(900)).toBe(false)
  })

  it('floats in the gutter, makes room beside the transcript down to 640 px, and goes above it below that', () => {
    expect(pinnedFilesMode(1600)).toBe('gutter')
    expect(pinnedFilesMode(1280)).toBe('gutter')
    expect(pinnedFilesMode(1279)).toBe('reserve')
    expect(pinnedFilesMode(640)).toBe('reserve')
    expect(pinnedFilesMode(639)).toBe('top')
    // Not laid out: taken to fit.
    expect(pinnedFilesMode(0)).toBe('gutter')
  })

  it('asks for no room in the gutter, for a right-hand column when narrower, and for the top below 640 px, back and forth', async () => {
    mount()
    await waitFor(() => expect(card()).not.toBeNull())
    expect(reserve()).toBeNull()
    expect(card()!.className).toContain('absolute')
    expect(card()!.dataset.pinnedFilesPlacement).toBe('side')
    // In px, as the transcript's reserve is: Tailwind's rem sizes would be 17/16 of these.
    expect(card()!.style.width).toBe('224px')
    expect(card()!.style.right).toBe('20px')

    setWidths(1100)
    expect(reserve()).toBe('right')
    // Still at the chat area's right, at the same top: the transcript keeps clear of it.
    expect(card()!.className).toContain('absolute')
    expect(card()!.style.top).toBe('calc(var(--topbar-h) + 12px)')
    expect(within(card()!).getAllByRole('button').map((b) => b.title)).toEqual(['plan.md', 'main.py', 'gone.csv'])

    setWidths(600)
    expect(reserve()).toBe('top')
    // In the flow, first, full width: its own band above the transcript, under the top bar's strip.
    expect(card()!.dataset.pinnedFilesPlacement).toBe('top')
    expect(card()!.className).not.toContain('absolute')
    expect(card()!.className).toContain('order-first')
    expect(card()!.style.marginTop).toBe('calc(var(--topbar-h) + 12px)')
    expect(card()!.className).toContain('[-webkit-app-region:no-drag]')
    expect(within(card()!).getAllByRole('button').map((b) => b.title)).toEqual(['plan.md', 'main.py', 'gone.csv'])

    setWidths(1600)
    expect(reserve()).toBeNull()
    expect(card()!.dataset.pinnedFilesPlacement).toBe('side')
  })

  it('keeps the room only while the block shows: the first pin takes it, the last unpin gives it back', async () => {
    listPins.mockResolvedValue({ success: true, pins: [] })
    layout.areaWidth = 1100
    mount()
    await waitFor(() => expect(listPins).toHaveBeenCalled())
    await act(async () => {})
    expect(card()).toBeNull()
    expect(reserve()).toBeNull()

    listPins.mockResolvedValue({ success: true, pins: [pin('plan.md', 1)] })
    await act(async () => client.invalidateQueries({ queryKey: ['agent-pinned-files', 'folder:a'] }))
    await waitFor(() => expect(card()).not.toBeNull())
    expect(reserve()).toBe('right')

    listPins.mockResolvedValue({ success: true, pins: [] })
    fireEvent.contextMenu(row('plan.md'), { clientX: 20, clientY: 20 })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Unpin file' }))
    await waitFor(() => expect(card()).toBeNull())
    expect(reserve()).toBeNull()
  })

  it('gives the room back when it stops showing for the chat (Minimal view) and when it unmounts', async () => {
    layout.areaWidth = 1100
    const { unmount } = mount()
    await waitFor(() => expect(reserve()).toBe('right'))
    act(() => useUIStore.setState({ minimalView: true }))
    expect(card()).toBeNull()
    expect(reserve()).toBeNull()
    act(() => useUIStore.setState({ minimalView: false }))
    await waitFor(() => expect(reserve()).toBe('right'))
    unmount()
    expect(reserve()).toBeNull()
  })
})

describe('drag to reorder', () => {
  const pins = [pin('a.md', 1), pin('b.md', 2), pin('c.md', 3)]

  it('writes the rank between the new neighbours, or one past the end', () => {
    expect(pinDropRank(pins, '/agent/c.md', '/agent/a.md', 'after')).toBe(1.5)
    expect(pinDropRank(pins, '/agent/c.md', '/agent/a.md', 'before')).toBe(0)
    expect(pinDropRank(pins, '/agent/a.md', '/agent/c.md', 'after')).toBe(4)
    expect(pinDropRank(pins, '/agent/a.md', '/agent/b.md', 'before')).toBe('unchanged')
  })

  async function dropOn(dragged: string, target: string, place: 'before' | 'after'): Promise<void> {
    listPins.mockResolvedValue({ success: true, pins })
    mount()
    await waitFor(() => expect(card()).not.toBeNull())
    const targetRow = row(target)
    targetRow.getBoundingClientRect = () => ({ top: 100, height: 20, bottom: 120, left: 0, right: 200, width: 200, x: 0, y: 100, toJSON: () => ({}) })
    const dataTransfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '' }
    fireEvent.dragStart(row(dragged), { dataTransfer })
    const clientY = place === 'before' ? 105 : 115
    // jsdom has no DragEvent, so the pointer is put on the event by hand.
    const fire = (kind: 'dragOver' | 'drop'): void => {
      const event = createEvent[kind](targetRow, { dataTransfer })
      Object.defineProperty(event, 'clientY', { value: clientY })
      fireEvent(targetRow, event)
    }
    fire('dragOver')
    expect(card()!.querySelector('[data-drop-indicator]')?.getAttribute('data-drop-indicator')).toBe(place)
    fire('drop')
  }

  it.each([
    ['into the middle', 'c.md', 'a.md', 'after', 1.5, ['a.md', 'c.md', 'b.md']],
    ['to the top', 'c.md', 'a.md', 'before', 0, ['c.md', 'a.md', 'b.md']],
    ['to the bottom', 'a.md', 'c.md', 'after', 4, ['b.md', 'c.md', 'a.md']]
  ] as const)('a drop %s writes the rank between its new neighbours and shows the new order at once', async (_label, dragged, target, place, rank, order) => {
    movePin.mockReturnValue(new Promise(() => {}))
    await dropOn(dragged, target, place)
    await waitFor(() => expect(movePin).toHaveBeenCalledWith({ agentId: 'folder:a', path: `/agent/${dragged}`, rank }))
    await waitFor(() =>
      expect(within(screen.getByRole('list')).getAllByRole('button').map((b) => b.title)).toEqual([...order])
    )
  })

  it('says so when main refuses the move, and puts the order back', async () => {
    movePin.mockResolvedValue({ success: false, code: 'not_found', error: 'That file is not pinned.' })
    await dropOn('c.md', 'a.md', 'before')
    expect((await screen.findByRole('alert')).textContent).toBe('Could not move the file there.')
    await waitFor(() =>
      expect(within(screen.getByRole('list')).getAllByRole('button').map((b) => b.title)).toEqual(['a.md', 'b.md', 'c.md'])
    )
  })
})
