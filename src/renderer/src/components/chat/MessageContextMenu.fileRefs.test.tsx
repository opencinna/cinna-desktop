import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentFileRef } from '../../../../shared/agentFiles'

vi.mock('../../stores/logger.store', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { useMessageContextMenu } from './MessageContextMenu'
import { MessageBubble } from './MessageBubble'
import { FileRefContext, type FileRefScope } from './fileRefs'
import { useAuthStore } from '../../stores/auth.store'
import { useUIStore } from '../../stores/ui.store'
import { useToastStore } from '../../stores/toast.store'
import { composerDraftKey, useComposerDraftStore } from '../../stores/composerDraft.store'

/**
 * The transcript's right-click menu over an inline code span that names a
 * file or folder: which actions it offers for each, and what they do.
 */

const ref = (text: string, over: Partial<AgentFileRef> = {}): AgentFileRef => ({
  text,
  path: `/agent/${text}`,
  displayPath: text,
  kind: 'file',
  inside: true,
  ...over
})
const refs = [
  ref('docs/plan.md'),
  ref('src/main.py'),
  ref('report.pdf'),
  ref('.env'),
  ref('credentials/key.json'),
  ref('pulled', { kind: 'dir' }),
  ref('dump.gz')
]
const scope: FileRefScope = { agentId: 'folder:a', refs: new Map(refs.map((r) => [r.text, r])) }
const content = refs.map((r) => `\`${r.text}\``).join(' and ') + ' and `npm test`.'

const clipboardText = vi.fn()
const bridge = vi.fn()
const authorize = vi.fn()
const readText = vi.fn()
const create = vi.fn()
const agentsList = vi.fn()
const DRAFT = composerDraftKey('alice', 'dashboard')
const originalClientRects = Range.prototype.getClientRects

beforeEach(() => {
  clipboardText.mockReset().mockResolvedValue(undefined)
  bridge.mockReset().mockResolvedValue({ success: true })
  authorize.mockReset().mockResolvedValue({ success: true, approved: true })
  readText.mockReset().mockResolvedValue({ success: true, text: 'print(1)\n' })
  create.mockReset().mockResolvedValue({ id: 'note-1' })
  agentsList.mockReset().mockResolvedValue([{ id: 'folder:a', name: 'GFCA', enabled: true }])
  vi.stubGlobal('navigator', { clipboard: { writeText: clipboardText } })
  window.api = {
    app: { setTheme: async () => {} },
    notes: { create },
    clipboard: { writeText: bridge },
    agentFiles: { authorize, readText },
    agents: { list: agentsList }
  } as never
  useAuthStore.setState({ currentUser: { id: 'alice' } as never })
  useUIStore.setState({ activeView: 'chat', sidebarTab: 'chats', activeNoteId: null, revealNoteId: null, pendingAgentId: null, activeJobId: null })
  useComposerDraftStore.setState({ drafts: {} })
  useToastStore.setState({ toast: null })
  window.getSelection()?.removeAllRanges()
})
afterEach(() => {
  vi.unstubAllGlobals()
  Range.prototype.getClientRects = originalClientRects
})

function Harness() {
  const context = useMessageContextMenu('chat-1')
  return (
    <>
      <div data-testid="transcript" onContextMenu={context.onContextMenu}>
        <FileRefContext.Provider value={scope}>
          <MessageBubble role="assistant" content={content} />
        </FileRefContext.Provider>
      </div>
      {context.menu}
    </>
  )
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<Harness />, { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> })
}

function openOn(text: string) {
  fireEvent.contextMenu(screen.getByText(text), { clientX: 50, clientY: 50 })
}

const itemNames = () => screen.getAllByRole('menuitem').map((item) => item.textContent)

describe('the items offered', () => {
  it.each([
    ['npm test', ['Copy text', 'Save to Notes'], 0],
    ['docs/plan.md', ['Copy contents', 'Save to Notes', 'Copy full path', 'Reference in a new chat'], 1],
    ['src/main.py', ['Copy contents', 'Save to Notes', 'Copy full path', 'Reference in a new chat'], 1],
    // An unknown type is offered: main decides from the bytes.
    ['dump.gz', ['Copy contents', 'Save to Notes', 'Copy full path', 'Reference in a new chat'], 1],
    ['report.pdf', ['Copy full path', 'Reference in a new chat'], 0],
    ['.env', ['Copy full path', 'Reference in a new chat'], 0],
    ['credentials/key.json', ['Copy full path', 'Reference in a new chat'], 0],
    ['pulled', ['Copy full path', 'Reference in a new chat'], 0]
  ])('over %s: %j', (text, items, separators) => {
    mount()
    openOn(text)
    expect(itemNames()).toEqual(items)
    expect(screen.queryAllByRole('separator')).toHaveLength(separators)
  })

  it('offers the plain-text menu for a selection inside a path', async () => {
    mount()
    const span = screen.getByText('docs/plan.md')
    const range = document.createRange()
    range.setStart(span.firstChild!, 0)
    range.setEnd(span.firstChild!, 4)
    window.getSelection()!.addRange(range)
    Range.prototype.getClientRects = () => [{ left: 0, top: 0, right: 20000, bottom: 20000 }] as never
    fireEvent.contextMenu(span, { clientX: 5, clientY: 5 })
    expect(itemNames()).toEqual(['Copy text', 'Save to Notes'])
  })

  it('moves the keyboard across every item, skipping the divider', () => {
    mount()
    openOn('docs/plan.md')
    const items = screen.getAllByRole('menuitem')
    expect(document.activeElement).toBe(items[0])
    for (const expected of [1, 2, 3, 0]) {
      fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
      expect(document.activeElement).toBe(items[expected])
    }
    fireEvent.keyDown(document.activeElement!, { key: 'End' })
    expect(document.activeElement).toBe(items[3])
  })
})

describe('the file actions', () => {
  it("copies a file's contents through main's clipboard, after authorizing it", async () => {
    mount()
    openOn('src/main.py')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy contents' }))
    await waitFor(() => expect(bridge).toHaveBeenCalledWith('print(1)\n'))
    expect(authorize).toHaveBeenCalledWith({ agentId: 'folder:a', path: '/agent/src/main.py', purpose: 'read' })
    expect(readText).toHaveBeenCalledWith({ agentId: 'folder:a', path: '/agent/src/main.py' })
    expect(clipboardText).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  })

  it("shows main's reason in the menu, which stays open", async () => {
    readText.mockResolvedValueOnce({ success: false, code: 'too_large', error: 'This file is over 4 MB.' })
    mount()
    openOn('src/main.py')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy contents' }))
    expect((await screen.findByRole('alert')).textContent).toBe('This file is over 4 MB.')
    expect(screen.getByRole('menu')).toBeTruthy()
    expect(bridge).not.toHaveBeenCalled()
  })

  it('stays open while the consent dialog has the window focus, and reads nothing when declined', async () => {
    let answer!: (value: unknown) => void
    authorize.mockReturnValueOnce(new Promise((resolve) => { answer = resolve }))
    mount()
    openOn('src/main.py')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy contents' }))
    act(() => void window.dispatchEvent(new Event('blur')))
    expect(screen.getByRole('menu')).toBeTruthy()
    await act(async () => answer({ success: true, approved: false }))
    expect(readText).not.toHaveBeenCalled()
    expect(bridge).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('closes on window blur once the consent call has answered, while the read runs', async () => {
    let finish!: (value: unknown) => void
    readText.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
    mount()
    openOn('src/main.py')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy contents' }))
    await waitFor(() => expect(readText).toHaveBeenCalled())
    act(() => void window.dispatchEvent(new Event('blur')))
    expect(screen.queryByRole('menu')).toBeNull()
    await act(async () => finish({ success: true, text: 'late' }))
  })

  it('spins the running item, dims the rest, keeps them focusable, and refocuses the item that failed', async () => {
    let finish!: (value: unknown) => void
    readText.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
    mount()
    openOn('src/main.py')
    const save = screen.getByRole('menuitem', { name: 'Save to Notes' })
    fireEvent.click(save)
    await waitFor(() => expect(save.querySelector('.animate-spin')).not.toBeNull())
    expect(save.getAttribute('aria-busy')).toBe('true')
    for (const item of screen.getAllByRole('menuitem')) {
      expect(item.hasAttribute('disabled')).toBe(false)
      expect(item.getAttribute('aria-disabled')).toBe('true')
    }
    const copyItem = screen.getByRole('menuitem', { name: 'Copy contents' })
    expect(copyItem.className).toContain('opacity-50')
    expect(save.className).not.toContain('opacity-50')
    // A second click while busy starts nothing; the arrows still move.
    fireEvent.click(copyItem)
    copyItem.focus()
    fireEvent.keyDown(copyItem, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(save)
    fireEvent.keyDown(save, { key: 'ArrowDown' })
    await act(async () => finish({ success: false, code: 'not_text', error: "This isn't a text file." }))
    await screen.findByRole('alert')
    expect(document.activeElement).toBe(save)
    expect(readText).toHaveBeenCalledTimes(1)
    expect(save.querySelector('.animate-spin')).toBeNull()
    expect(save.getAttribute('aria-disabled')).toBeNull()
  })

  it('saves a markdown file as a note titled by its heading, and opens it', async () => {
    readText.mockResolvedValueOnce({ success: true, text: 'Intro\n\n# The plan\n\nSteps.\n' })
    mount()
    openOn('docs/plan.md')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save to Notes' }))
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({ title: 'The plan', body: 'Intro\n\n# The plan\n\nSteps.\n' })
    )
    await waitFor(() => expect(useUIStore.getState().activeNoteId).toBe('note-1'))
    expect(useUIStore.getState().activeView).toBe('note-detail')
  })

  it('saves a code file fenced in its language, titled by its name', async () => {
    mount()
    openOn('src/main.py')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save to Notes' }))
    await waitFor(() => expect(create).toHaveBeenCalledWith({ title: 'main.py', body: '```py\nprint(1)\n```' }))
  })

  it('copies the full path without reading or asking', async () => {
    mount()
    openOn('report.pdf')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy full path' }))
    await waitFor(() => expect(clipboardText).toHaveBeenCalledWith('/agent/report.pdf'))
    expect(authorize).not.toHaveBeenCalled()
    expect(readText).not.toHaveBeenCalled()
  })
})

describe('Reference in a new chat', () => {
  it('lands on the new-chat screen with the agent and the path in the composer', async () => {
    mount()
    openOn('src/main.py')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reference in a new chat' }))
    await waitFor(() => expect(useUIStore.getState().pendingAgentId).toBe('folder:a'))
    expect(useUIStore.getState().activeView).toBe('chat')
    expect(useUIStore.getState().sidebarTab).toBe('chats')
    expect(useComposerDraftStore.getState().drafts[DRAFT]?.text).toBe('The file `/agent/src/main.py` ')
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  })

  it('adds a folder on a new line under what the new-chat draft already holds', async () => {
    useComposerDraftStore.getState().update(DRAFT, () => ({ text: 'Compare these:\n' }))
    mount()
    openOn('pulled')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reference in a new chat' }))
    await waitFor(() => expect(useUIStore.getState().pendingAgentId).toBe('folder:a'))
    expect(useComposerDraftStore.getState().drafts[DRAFT]?.text).toBe('Compare these:\nThe folder `/agent/pulled` ')
  })

  it('says why when the agent is switched off, and changes nothing', async () => {
    agentsList.mockResolvedValue([{ id: 'folder:a', name: 'GFCA', enabled: false }])
    mount()
    openOn('src/main.py')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reference in a new chat' }))
    await waitFor(() => expect(useToastStore.getState().toast?.message).toBe('GFCA is disabled'))
    expect(useUIStore.getState().pendingAgentId).toBeNull()
    expect(useComposerDraftStore.getState().drafts[DRAFT]).toBeUndefined()
  })
})

describe('placement', () => {
  const originalRect = HTMLElement.prototype.getBoundingClientRect
  beforeEach(() => {
    // jsdom has no layout: the menu measures 224×150 wherever it is.
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      return this.getAttribute('role') === 'menu'
        ? ({ left: 0, top: 0, right: 224, bottom: 150, width: 224, height: 150, x: 0, y: 0 } as DOMRect)
        : originalRect.call(this)
    }
  })
  afterEach(() => {
    HTMLElement.prototype.getBoundingClientRect = originalRect
  })

  const failOnce = () =>
    readText.mockResolvedValueOnce({ success: false, code: 'not_text', error: "This isn't a text file." })

  async function positionsAround(y: number) {
    failOnce()
    mount()
    fireEvent.contextMenu(screen.getByText('dump.gz'), { clientX: 50, clientY: y })
    const menu = screen.getByRole('menu')
    const before = { top: menu.style.top, bottom: menu.style.bottom }
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy contents' }))
    const alert = await screen.findByRole('alert')
    const after = { top: menu.style.top, bottom: menu.style.bottom }
    const first = screen.getAllByRole('menuitem')[0]
    const alertFirst = Boolean(alert.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING)
    return { before, after, alertFirst }
  }

  it('opens downwards with room to spare, the error row below the items, and nothing moves', async () => {
    const { before, after, alertFirst } = await positionsAround(100)
    expect(before).toEqual({ top: '100px', bottom: '' })
    expect(after).toEqual(before)
    expect(alertFirst).toBe(false)
  })

  it('near the window foot, anchors by its bottom edge with the error row above the items, and nothing moves', async () => {
    const { before, after, alertFirst } = await positionsAround(window.innerHeight - 60)
    expect(before).toEqual({ top: '', bottom: '8px' })
    expect(after).toEqual(before)
    expect(alertFirst).toBe(true)
  })

  it('keeps the error row room when the menu itself would just fit', async () => {
    // 150px menu fits below y, the 48px error row would not: bottom-anchored at the menu's own foot.
    const y = window.innerHeight - 150 - 8 - 20
    const { before } = await positionsAround(y)
    expect(before).toEqual({ top: '', bottom: '28px' })
  })
})
