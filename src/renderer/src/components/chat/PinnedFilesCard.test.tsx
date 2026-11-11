import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PinnedAgentFile } from '../../../../shared/agentFiles'

vi.mock('../../stores/logger.store', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
const capabilities = vi.hoisted(() => ({ notesEnabled: true, dashboardsEnabled: true, loaded: true }))
vi.mock('../../hooks/useCapabilities', () => ({ useCapabilities: () => capabilities }))

import { PINNED_FILES_GUTTER_PX, PinnedFilesCard, PinnedFilesChip, gutterFits, middleEllipsisParts, pinDropRank, usePinnedFilesChipStore } from './PinnedFilesCard'
import { useFilePreviewStore } from '../../stores/filePreview.store'
import { useUIStore } from '../../stores/ui.store'
import { useAuthStore } from '../../stores/auth.store'
import { useChatStore } from '../../stores/chat.store'

/**
 * The chat's Pinned files: the card in the gutter right of the transcript's
 * column when it fits there, the top bar's chip and its popover when it does
 * not; when either shows, what a row does on a click, a right-click and a
 * drop, and how the card folds.
 */

/** The chat area's and the transcript column's boxes, as the layout would give them. */
const layout = vi.hoisted(() => ({ areaWidth: 1600, columnWidth: 768, resize: [] as Array<() => void> }))
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
let client: QueryClient
const originalOpen = useFilePreviewStore.getState().openAgentFile

beforeEach(() => {
  layout.areaWidth = 1600
  layout.resize = []
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.dataset.testid === 'area') return box(0, layout.areaWidth)
    if (this.hasAttribute('data-sidebar-band-limit')) {
      const width = Math.min(layout.columnWidth, layout.areaWidth - 32)
      return box((layout.areaWidth - width) / 2, width)
    }
    return box(0, 0, 0, 0)
  })
  window.ResizeObserver = class {
    constructor(private callback: ResizeObserverCallback) {
      layout.resize.push(() => this.callback([], this as never))
    }
    observe(): void {}
    disconnect(): void {}
  } as never
  usePinnedFilesChipStore.setState({ target: null })
  listPins.mockReset().mockResolvedValue({ success: true, pins: [pin('plan.md', 1), pin('main.py', 2), pin('gone.csv', 3, { exists: false })] })
  setPin.mockReset().mockResolvedValue({ success: true, pinned: false })
  movePin.mockReset().mockResolvedValue({ success: true })
  openAgentFile.mockReset().mockResolvedValue(undefined)
  window.api = { agentFiles: { listPins, setPin, movePin } } as never
  useFilePreviewStore.setState({ openAgentFile })
  useUIStore.setState({ minimalView: false, pinnedFilesCollapsed: false })
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
      <PinnedFilesChip />
      <div data-testid="area">
        <div data-sidebar-band-limit />
        <PinnedFilesCard chatId={props.chatId === undefined ? 'chat-1' : props.chatId} agentId={props.agentId === undefined ? 'folder:a' : props.agentId} />
      </div>
    </QueryClientProvider>
  )
}

const card = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-pinned-files-card]')
const chip = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-pinned-files-chip]')
const popover = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-pinned-files-popover]')
const header = (): HTMLElement => screen.getByRole('button', { name: /Pinned files/ })
const row = (name: string): HTMLElement => screen.getByTitle(name)

describe('when it shows', () => {
  it('lists the root agent’s pins under a header with their count', async () => {
    mount()
    await waitFor(() => expect(card()).not.toBeNull())
    expect(header().textContent).toBe('Pinned files3')
    expect(header().getAttribute('aria-expanded')).toBe('true')
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
    setWidths(900)
    expect(chip()).toBeNull()
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
    expect(chip()).toBeNull()
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

describe('folding', () => {
  it('folds to its header and keeps the choice for every chat', async () => {
    const { unmount } = mount()
    await waitFor(() => expect(card()).not.toBeNull())
    fireEvent.click(header())
    expect(header().getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('list')).toBeNull()
    expect(useUIStore.getState().pinnedFilesCollapsed).toBe(true)
    expect(localStorage.getItem('cinna-pinned-files-collapsed')).toBe('1')
    unmount()
    mount({ chatId: 'chat-2' })
    await waitFor(() => expect(card()).not.toBeNull())
    expect(header().getAttribute('aria-expanded')).toBe('false')
  })

})

describe('where it goes', () => {
  it('fits the gutter only with the card and its margins clear of the column', () => {
    const column = (areaWidth: number) => box((areaWidth - 768) / 2, 768)
    // 1600 wide: 416 px right of the column.
    expect(gutterFits(box(0, 1600), column(1600))).toBe(true)
    // The card's 224 px plus 20 px to the window side and 12 px from the column: 256 exactly, then one pixel less.
    expect(PINNED_FILES_GUTTER_PX).toBe(256)
    expect(gutterFits(box(0, 768 + 2 * 256), column(768 + 2 * 256))).toBe(true)
    expect(gutterFits(box(0, 768 + 2 * 255), column(768 + 2 * 255))).toBe(false)
    // Room for the card alone, not its margins, is not enough.
    expect(gutterFits(box(0, 768 + 2 * 230), column(768 + 2 * 230))).toBe(false)
    expect(gutterFits(box(0, 900), column(900))).toBe(false)
    // Not laid out: taken to fit. No column yet: measured against the one it will have.
    expect(gutterFits(box(0, 0), null)).toBe(true)
    expect(gutterFits(box(0, 1600), null)).toBe(true)
    expect(gutterFits(box(0, 900), null)).toBe(false)
  })

  it('floats in the gutter when it fits, and becomes the top bar chip when it does not, back and forth', async () => {
    mount()
    await waitFor(() => expect(card()).not.toBeNull())
    expect(chip()).toBeNull()
    setWidths(900)
    expect(card()).toBeNull()
    expect(await screen.findByRole('button', { name: 'Pinned files, 3' })).toBe(chip())
    expect(chip()!.title).toBe('Pinned files')
    setWidths(1600)
    expect(card()).not.toBeNull()
    expect(chip()).toBeNull()
  })
})

describe('the chip', () => {
  async function openChip(): Promise<HTMLElement> {
    layout.areaWidth = 900
    mount()
    const button = await screen.findByRole('button', { name: 'Pinned files, 3' })
    fireEvent.click(button)
    await waitFor(() => expect(popover()).not.toBeNull())
    expect(button.getAttribute('aria-expanded')).toBe('true')
    return popover()!
  }

  it('opens the same rows as a popover', async () => {
    const list = await openChip()
    expect(within(list).getAllByRole('button').map((b) => b.title)).toEqual(['plan.md', 'main.py', 'gone.csv'])
    expect(list.className).toContain('app-popover-surface')
    expect(within(list).getByRole('img', { name: 'File not found' })).toBeTruthy()
  })

  it('opens the preview from a row and closes', async () => {
    const list = await openChip()
    fireEvent.click(within(list).getByTitle('main.py'), { detail: 1, clientX: 30, clientY: 40 })
    expect(openAgentFile).toHaveBeenCalledWith('folder:a', expect.objectContaining({ path: '/agent/main.py', kind: 'file' }), { x: 30, y: 40 })
    expect(popover()).toBeNull()
  })

  it('closes on Escape and on a press outside', async () => {
    await openChip()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(popover()).toBeNull()
    fireEvent.click(chip()!)
    await waitFor(() => expect(popover()).not.toBeNull())
    fireEvent.mouseDown(document.body)
    expect(popover()).toBeNull()
  })

  it('offers the shared menu on a right-click, Unpin file first, and the menu keeps its error when the popover closes', async () => {
    setPin.mockResolvedValue({ success: false, code: 'agent_not_found', error: 'That agent is no longer in your agents folder.' })
    const list = await openChip()
    fireEvent.contextMenu(within(list).getByTitle('plan.md'), { clientX: 20, clientY: 20 })
    expect(screen.getAllByRole('menuitem')[0]).toBe(await screen.findByRole('menuitem', { name: 'Unpin file' }))
    // Escape is the menu's first, wherever focus is: the popover stays for the next one.
    fireEvent.keyDown(document.body, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu', { name: 'Message actions' })).toBeNull())
    expect(popover()).not.toBeNull()
    fireEvent.contextMenu(within(list).getByTitle('plan.md'), { clientX: 20, clientY: 20 })
    const unpin = await screen.findByRole('menuitem', { name: 'Unpin file' })
    // A press on the menu is outside the popover, which closes; the menu stays to finish.
    fireEvent.mouseDown(unpin)
    fireEvent.click(unpin)
    expect(popover()).toBeNull()
    expect((await screen.findByRole('alert')).textContent).toBe('That agent is no longer in your agents folder.')
    expect(screen.getByRole('menu', { name: 'Message actions' })).toBeTruthy()
  })

  it('says a refusal of the last pin’s unpin, although the chip goes with the pin', async () => {
    listPins.mockResolvedValue({ success: true, pins: [pin('plan.md', 1)] })
    let refuse!: (answer: unknown) => void
    setPin.mockReturnValue(new Promise((resolve) => { refuse = resolve }))
    layout.areaWidth = 900
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Pinned files, 1' }))
    await waitFor(() => expect(popover()).not.toBeNull())
    fireEvent.contextMenu(within(popover()!).getByTitle('plan.md'), { clientX: 20, clientY: 20 })
    const unpin = await screen.findByRole('menuitem', { name: 'Unpin file' })
    fireEvent.mouseDown(unpin)
    fireEvent.click(unpin)
    // Unpinned at once: the chip goes, and the chat no longer hands it a target.
    await waitFor(() => expect(chip()).toBeNull())
    expect(usePinnedFilesChipStore.getState().target).toBeNull()
    await act(async () => refuse({ success: false, code: 'agent_not_found', error: 'That agent is no longer in your agents folder.' }))
    expect((await screen.findByRole('alert')).textContent).toBe('That agent is no longer in your agents folder.')
    expect(screen.getByRole('menu', { name: 'Message actions' })).toBeTruthy()
  })

  it('closes the menu when the active chat changes, to a chat with no chip too', async () => {
    act(() => useChatStore.getState().setActiveChatId('chat-1'))
    const list = await openChip()
    fireEvent.contextMenu(within(list).getByTitle('plan.md'), { clientX: 20, clientY: 20 })
    await screen.findByRole('menu', { name: 'Message actions' })
    // The chip goes (the other chat shows no pins), and so does the menu.
    act(() => usePinnedFilesChipStore.setState({ target: null }))
    expect(screen.getByRole('menu', { name: 'Message actions' })).toBeTruthy()
    act(() => useChatStore.getState().setActiveChatId('chat-2'))
    expect(screen.queryByRole('menu', { name: 'Message actions' })).toBeNull()
  })

  it('focuses its first row when the popover opens, and Escape gives focus back to the chip', async () => {
    const list = await openChip()
    await waitFor(() => expect(document.activeElement).toBe(within(list).getByTitle('plan.md')))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(popover()).toBeNull()
    expect(document.activeElement).toBe(chip())
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
