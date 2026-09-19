import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentFileRef } from '../../../../shared/agentFiles'

vi.mock('../../stores/logger.store', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../../stores/fileDownload.store', () => ({
  useFileDownloadStore: (select: (s: { download: () => void; downloadingIds: Set<string> }) => unknown) =>
    select({ download: () => {}, downloadingIds: new Set() })
}))

import { contentsGeometry, ENTRANCE_WAIT_MS, FilePreviewModal, OPEN_PRESS_GUARD_MS } from './FilePreviewModal'
import { FULL_TITLE_DELAY_MS } from './FilePreviewContents'
import { useFilePreviewStore } from '../../stores/filePreview.store'
import { useUIStore } from '../../stores/ui.store'

const csv: AgentFileRef = {
  text: 'data/omp.csv',
  path: '/agent/data/omp.csv',
  displayPath: 'data/omp.csv',
  kind: 'file',
  inside: true
}
const goneFolder: AgentFileRef = {
  text: 'data/report/old_exports',
  path: '/agent/data/report/old_exports',
  displayPath: 'data/report/old_exports',
  kind: 'dir',
  inside: true
}
const agentTarget = (ref: AgentFileRef = csv) => ({ type: 'agentFile' as const, agentId: 'folder:a', ref })

type OpenState = Partial<ReturnType<typeof useFilePreviewStore.getState>>

/** Open a preview the way the store does: fresh state, a bumped `openSeq`. */
function open(state: OpenState): void {
  act(() => {
    useFilePreviewStore.getState().close()
    useFilePreviewStore.setState({ ...state, openSeq: useFilePreviewStore.getState().openSeq + 1 })
  })
}

/** Elements a test put into the document itself, removed after it. */
const added: HTMLElement[] = []

const card = (): HTMLElement => document.querySelector<HTMLElement>('[tabindex="-1"]')!
const backdrop = (): HTMLElement => document.querySelector<HTMLElement>('[aria-hidden="true"]')!

/** The exit's length: `ENTRANCE.duration` in the modal, which is not exported. */
const EXIT_MS = 170

/** Every `animate()` call, with the transform origin set when it ran. */
let animations: Array<{
  element: Element
  origin: string
  keyframes: Keyframe[]
  options: KeyframeAnimationOptions
  cancelled: boolean
}>

beforeEach(() => {
  animations = []
  Object.defineProperty(HTMLElement.prototype, 'animate', {
    configurable: true,
    writable: true,
    value: function (this: HTMLElement, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
      const record = { element: this, origin: this.style.transformOrigin, keyframes, options, cancelled: false }
      animations.push(record)
      return {
        cancel: () => {
          record.cancelled = true
        }
      }
    }
  })
  // The loading card sits lower and is short; the settled one is where the user
  // will see it. The entrance must measure the second.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const loading = this.textContent?.includes('Loading preview') ?? false
    const top = loading ? 300 : 80
    const height = loading ? 98 : 600
    return { left: 100, top, width: 700, height, right: 800, bottom: top + height, x: 100, y: top, toJSON: () => ({}) } as DOMRect
  })
  act(() => useFilePreviewStore.getState().close())
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  delete (HTMLElement.prototype as { animate?: unknown }).animate
  // Only what the test added: the rendered tree is Testing Library's to unmount.
  for (const element of added.splice(0)) element.remove()
})

describe('the entrance', () => {
  it('keeps the card invisible while loading, then expands from the click on the settled card', () => {
    render(<FilePreviewModal />)
    open({ target: agentTarget(), kind: 'text', isLoading: true, origin: { x: 150, y: 120 } })
    expect(card().style.opacity).toBe('0')
    expect(backdrop().style.opacity).toBe('0')
    expect(animations).toHaveLength(0)

    act(() => useFilePreviewStore.setState({ isLoading: false, text: 'hello' }))
    expect(animations.map((a) => a.element)).toEqual([card(), backdrop()])
    // 150 - 100, 120 - 80: against the settled rect, not the loading one.
    expect(animations[0].origin).toBe('50px 40px')
    expect(card().style.opacity).toBe('')
    expect(backdrop().style.opacity).toBe('')
  })

  it('runs on the loading card when loading outlasts the wait, and only once', () => {
    vi.useFakeTimers()
    render(<FilePreviewModal />)
    open({ target: agentTarget(), kind: 'text', isLoading: true, origin: { x: 150, y: 120 } })
    act(() => vi.advanceTimersByTime(ENTRANCE_WAIT_MS - 1))
    expect(animations).toHaveLength(0)
    act(() => vi.advanceTimersByTime(1))
    expect(animations.map((a) => a.element)).toEqual([card(), backdrop()])
    expect(animations[0].origin).toBe('50px -180px')

    act(() => useFilePreviewStore.setState({ isLoading: false, text: 'hello' }))
    act(() => vi.advanceTimersByTime(ENTRANCE_WAIT_MS))
    expect(animations).toHaveLength(2)
  })

  it('runs at once for an open that is already settled, from the centre without a click', () => {
    render(<FilePreviewModal />)
    open({ target: agentTarget(), notice: 'unsupported' })
    expect(animations.map((a) => a.element)).toEqual([card(), backdrop()])
    expect(animations[0].origin).toBe('center')
  })

  it('pins the card to the top for agent files and attachments alike', () => {
    render(<FilePreviewModal />)
    for (const target of [
      agentTarget(),
      { type: 'attachment' as const, attachment: { id: 'f1', filename: 'a.txt', size: 1, mimeType: 'text/plain' } }
    ]) {
      open({ target, kind: 'text', text: 'x' })
      const overlay = card().parentElement!
      expect(overlay.className).toContain('items-start')
      expect(overlay.className).toContain('pt-[10vh]')
      expect(overlay.className).not.toContain('items-center')
      expect(card().className).toContain('max-h-[80vh]')
    }
  })
})

describe('focus', () => {
  function opener(): HTMLButtonElement {
    const button = document.createElement('button')
    button.textContent = 'opener'
    document.body.appendChild(button)
    added.push(button)
    button.focus()
    return button
  }

  it('moves into the card on a keyboard open and back to the opener on Escape', () => {
    vi.useFakeTimers()
    const button = opener()
    render(<FilePreviewModal />)
    // No origin: opened from the keyboard.
    open({ target: agentTarget(), kind: 'text', text: 'hello' })
    expect(document.activeElement).toBe(card())
    // Tab from the card reaches the header actions.
    expect(card().contains(screen.getByRole('button', { name: 'More file actions' }))).toBe(true)
    expect(card().contains(screen.getByRole('button', { name: 'Close preview' }))).toBe(true)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useFilePreviewStore.getState().target).toBeNull()
    // Focus goes back once the fading card leaves, not while it still shows.
    act(() => vi.advanceTimersByTime(EXIT_MS - 1))
    expect(document.activeElement).toBe(card())
    act(() => vi.advanceTimersByTime(1))
    expect(document.activeElement).toBe(button)
  })

  it('moves into the card on a click open, and lets it go on close rather than ringing the link', () => {
    for (const closeBy of ['Escape', 'backdrop'] as const) {
      vi.useFakeTimers()
      const button = opener()
      const { unmount } = render(<FilePreviewModal />)
      open({ target: agentTarget(), kind: 'text', text: 'hello', origin: { x: 150, y: 120 } })
      expect(document.activeElement).toBe(card())
      if (closeBy === 'Escape') fireEvent.keyDown(window, { key: 'Escape' })
      else {
        act(() => vi.advanceTimersByTime(OPEN_PRESS_GUARD_MS))
        fireEvent.mouseDown(backdrop())
      }
      expect(useFilePreviewStore.getState().target).toBeNull()
      act(() => vi.advanceTimersByTime(EXIT_MS))
      expect(document.querySelector('[tabindex="-1"]')).toBeNull()
      expect(document.activeElement).not.toBe(button)
      expect(document.activeElement).toBe(document.body)
      unmount()
      vi.useRealTimers()
    }
  })

  it('moves focus in only once the entrance starts', () => {
    const button = opener()
    render(<FilePreviewModal />)
    open({ target: agentTarget(), kind: 'text', isLoading: true })
    expect(document.activeElement).toBe(button)
    act(() => useFilePreviewStore.setState({ isLoading: false, text: 'hello' }))
    expect(document.activeElement).toBe(card())
  })

  it('returns to the element from before the first open when a preview was replaced', () => {
    vi.useFakeTimers()
    const button = opener()
    render(<FilePreviewModal />)
    open({ target: agentTarget(), kind: 'text', text: 'one' })
    open({ target: agentTarget({ ...csv, path: '/agent/b.csv', text: 'b.csv', displayPath: 'b.csv' }), kind: 'text', text: 'two' })
    expect(document.activeElement).toBe(card())
    act(() => useFilePreviewStore.getState().close())
    act(() => vi.advanceTimersByTime(EXIT_MS))
    expect(document.activeElement).toBe(button)
  })

  it('goes nowhere when the opener left the document', () => {
    vi.useFakeTimers()
    const button = opener()
    render(<FilePreviewModal />)
    open({ target: agentTarget(), kind: 'text', text: 'hello' })
    button.remove()
    act(() => useFilePreviewStore.getState().close())
    act(() => vi.advanceTimersByTime(EXIT_MS))
    expect(document.querySelector('[tabindex="-1"]')).toBeNull()
    expect(document.activeElement).not.toBe(button)
  })

  it('closes on a backdrop press without letting the press take focus from the opener', () => {
    vi.useFakeTimers()
    const button = opener()
    render(<FilePreviewModal />)
    open({ target: agentTarget(), kind: 'text', text: 'hello' })
    // Past the double-click guard.
    act(() => vi.advanceTimersByTime(OPEN_PRESS_GUARD_MS))
    const notPrevented = fireEvent.mouseDown(backdrop())
    expect(notPrevented).toBe(false)
    expect(useFilePreviewStore.getState().target).toBeNull()
    act(() => vi.advanceTimersByTime(EXIT_MS))
    expect(document.activeElement).toBe(button)
  })
})

describe('the exit', () => {
  const second = agentTarget({ ...csv, path: '/agent/b.csv', text: 'b.csv', displayPath: 'b.csv' })
  const overlay = (): HTMLElement => card().parentElement!
  /** The `animate()` calls made after the first `from` of them. */
  const since = (from: number) => animations.slice(from)

  it('keeps the card on screen, untouchable, while the entrance plays backwards, then unmounts', () => {
    vi.useFakeTimers()
    render(<FilePreviewModal />)
    open({ target: agentTarget(), kind: 'text', text: 'hello', origin: { x: 150, y: 120 } })
    const entered = animations.length
    expect(overlay().className).not.toContain('pointer-events-none')

    act(() => useFilePreviewStore.getState().close())
    expect(useFilePreviewStore.getState().target).toBeNull()
    expect(card()).not.toBeNull()
    expect(screen.getByText('hello')).toBeTruthy()
    expect(overlay().className.split(/\s+/)).toContain('pointer-events-none')
    const exit = since(entered)
    expect(exit.map((a) => a.element)).toEqual([card(), backdrop()])
    expect(exit[0].keyframes).toEqual([
      { opacity: 1, transform: 'scale(1)' },
      { opacity: 0, transform: 'scale(0.92)' }
    ])
    expect(exit[1].keyframes).toEqual([{ opacity: 1 }, { opacity: 0 }])
    for (const animation of exit) expect(animation.options).toMatchObject({ duration: EXIT_MS, fill: 'forwards' })

    act(() => vi.advanceTimersByTime(EXIT_MS - 1))
    expect(document.querySelector('[tabindex="-1"]')).not.toBeNull()
    act(() => vi.advanceTimersByTime(1))
    expect(document.querySelector('[tabindex="-1"]')).toBeNull()
    expect(document.querySelector('[aria-hidden="true"]')).toBeNull()
  })

  it('only fades under reduced motion', () => {
    vi.useFakeTimers()
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    try {
      render(<FilePreviewModal />)
      open({ target: agentTarget(), kind: 'text', text: 'hello' })
      const entered = animations.length
      act(() => useFilePreviewStore.getState().close())
      expect(since(entered).map((a) => a.keyframes)).toEqual([
        [{ opacity: 1 }, { opacity: 0 }],
        [{ opacity: 1 }, { opacity: 0 }]
      ])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('is cancelled by an open during the fade, which shows the new preview and closes normally', () => {
    vi.useFakeTimers()
    render(<FilePreviewModal />)
    open({ target: agentTarget(), kind: 'text', text: 'one' })
    const entered = animations.length
    act(() => useFilePreviewStore.getState().close())
    const exit = since(entered)
    expect(exit).toHaveLength(2)

    act(() => vi.advanceTimersByTime(EXIT_MS / 2))
    const beforeReopen = animations.length
    open({ target: second, kind: 'text', text: 'two' })
    expect(screen.getByText('two')).toBeTruthy()
    expect(screen.queryByText('one')).toBeNull()
    expect(overlay().className).not.toContain('pointer-events-none')
    // A held last frame would leave the new preview invisible.
    expect(exit.every((a) => a.cancelled)).toBe(true)
    // The new preview enters as any open does.
    expect(since(beforeReopen)[0].keyframes).toEqual([
      { opacity: 0, transform: 'scale(0.92)' },
      { opacity: 1, transform: 'scale(1)' }
    ])

    // Past where the cancelled exit would have ended: still open, and listening.
    act(() => vi.advanceTimersByTime(EXIT_MS))
    expect(screen.getByText('two')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useFilePreviewStore.getState().target).toBeNull()
    // It fades out what it showed last.
    expect(screen.getByText('two')).toBeTruthy()
    act(() => vi.advanceTimersByTime(EXIT_MS))
    expect(document.querySelector('[tabindex="-1"]')).toBeNull()
  })

  it('does not flash in a card closed while it was still hidden waiting to settle: it just goes', () => {
    vi.useFakeTimers()
    render(<FilePreviewModal />)
    open({ target: agentTarget(), kind: 'text', isLoading: true, origin: { x: 150, y: 120 } })
    act(() => vi.advanceTimersByTime(ENTRANCE_WAIT_MS - 50))
    expect(card().style.opacity).toBe('0')

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useFilePreviewStore.getState().target).toBeNull()
    expect(animations).toHaveLength(0)
    expect(card().style.opacity).toBe('0')
    act(() => vi.advanceTimersByTime(0))
    expect(document.querySelector('[tabindex="-1"]')).toBeNull()
    expect(animations).toHaveLength(0)
  })

  it('never starts the entrance its pending wait was for, once closed', () => {
    vi.useFakeTimers()
    render(<FilePreviewModal />)
    open({ target: agentTarget(), kind: 'text', isLoading: true, origin: { x: 150, y: 120 } })
    act(() => vi.advanceTimersByTime(ENTRANCE_WAIT_MS - 50))
    act(() => useFilePreviewStore.getState().close())
    // One advance over both timers: the entrance wait comes due before React
    // commits the unmount the 0 ms exit timer asked for, with the card still
    // mounted.
    act(() => vi.advanceTimersByTime(ENTRANCE_WAIT_MS))
    expect(animations).toHaveLength(0)
    expect(document.querySelector('[tabindex="-1"]')).toBeNull()
  })

  it('ignores Escape and a backdrop press while fading', () => {
    vi.useFakeTimers()
    render(<FilePreviewModal />)
    open({ target: agentTarget(), kind: 'text', text: 'hello' })
    act(() => vi.advanceTimersByTime(OPEN_PRESS_GUARD_MS))
    fireEvent.keyDown(window, { key: 'Escape' })
    const { requestId } = useFilePreviewStore.getState()
    const exitCalls = animations.length

    // `close` bumps the request id, so a second close would show here.
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(fireEvent.mouseDown(backdrop())).toBe(true)
    expect(useFilePreviewStore.getState().requestId).toBe(requestId)
    expect(animations).toHaveLength(exitCalls)
    act(() => vi.advanceTimersByTime(EXIT_MS))
    expect(document.querySelector('[tabindex="-1"]')).toBeNull()
  })
})

describe('the header path', () => {
  let writeText: ReturnType<typeof vi.fn>

  beforeEach(() => {
    writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  })

  afterEach(() => {
    delete (navigator as { clipboard?: unknown }).clipboard
  })

  const pathButton = (): HTMLElement => screen.getByRole('button', { name: 'data/omp.csv' })
  const hint = (): HTMLElement => screen.getByRole('status')
  const hintShown = (): boolean => hint().className.split(/\s+/).includes('opacity-100')

  async function click(): Promise<void> {
    await act(async () => {
      fireEvent.click(pathButton())
    })
  }

  it('is a button that copies the path it shows, titled with it', async () => {
    render(<FilePreviewModal />)
    open({ target: agentTarget(), kind: 'text', text: 'hello' })
    expect(pathButton().tagName).toBe('BUTTON')
    expect(pathButton().getAttribute('title')).toBe('data/omp.csv')
    expect(pathButton().className.split(/\s+/)).toContain('cursor-pointer')
    await click()
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith('data/omp.csv')
  })

  it('hints on hover, says Copied, fades after the delay, and stays hidden until the pointer comes back', async () => {
    vi.useFakeTimers()
    render(<FilePreviewModal />)
    open({ target: agentTarget(), kind: 'text', text: 'hello' })
    expect(hintShown()).toBe(false)

    fireEvent.mouseEnter(pathButton())
    expect(hintShown()).toBe(true)
    expect(hint().textContent).toBe('Click to copy')

    await click()
    expect(hintShown()).toBe(true)
    expect(hint().textContent).toBe('Copied')

    act(() => vi.advanceTimersByTime(1199))
    expect(hintShown()).toBe(true)
    act(() => vi.advanceTimersByTime(1))
    expect(hintShown()).toBe(false)
    // Fading out as it was, not flipping back to the hover text.
    expect(hint().textContent).toBe('Copied')

    // Still under the pointer: it does not come back by itself.
    act(() => vi.advanceTimersByTime(5000))
    expect(hintShown()).toBe(false)

    fireEvent.mouseLeave(pathButton())
    expect(hintShown()).toBe(false)
    fireEvent.mouseEnter(pathButton())
    expect(hintShown()).toBe(true)
    expect(hint().textContent).toBe('Click to copy')
  })

  it('hints on keyboard focus, and after a copy comes back once focus has left', async () => {
    vi.useFakeTimers()
    render(<FilePreviewModal />)
    open({ target: agentTarget(), kind: 'text', text: 'hello' })
    act(() => pathButton().focus())
    expect(hintShown()).toBe(true)
    expect(hint().textContent).toBe('Click to copy')

    await click()
    act(() => vi.advanceTimersByTime(1200))
    expect(hintShown()).toBe(false)

    act(() => pathButton().blur())
    act(() => pathButton().focus())
    expect(hintShown()).toBe(true)
    expect(hint().textContent).toBe('Click to copy')
  })

  it("says Couldn't copy when the clipboard refuses", async () => {
    writeText.mockImplementation(() => Promise.reject(new Error('denied')))
    render(<FilePreviewModal />)
    open({ target: agentTarget(), kind: 'text', text: 'hello' })
    fireEvent.mouseEnter(pathButton())
    await click()
    expect(hintShown()).toBe(true)
    expect(hint().textContent).toBe("Couldn't copy")
  })
})

describe('zebra rows', () => {
  it('mark the csv table and the markdown body for the preview-only stripes', () => {
    render(<FilePreviewModal />)
    open({ target: agentTarget(), kind: 'csv', text: 'a,b\n1,2\n3,4\n' })
    expect(screen.getByRole('table').classList.contains('file-preview-table')).toBe(true)

    open({ target: agentTarget(), kind: 'markdown', text: '| a | b |\n| - | - |\n| 1 | 2 |\n' })
    const body = screen.getByRole('table').closest('.markdown-body')
    expect(body?.classList.contains('file-preview-markdown')).toBe(true)
  })
})

describe('markdown frontmatter', () => {
  it('shows it as a key/value card above the body, with URLs as links, instead of a heading', () => {
    render(<FilePreviewModal />)
    const text = [
      '---',
      'name: global-forecast',
      'models: pipeline-(A),res.partner-(M)',
      'ticket: https://example.com/T-1',
      '---',
      '',
      '# Spec'
    ].join('\n')
    open({ target: agentTarget(), kind: 'markdown', text })

    const card = screen.getByTestId('frontmatter')
    expect(card.closest('.markdown-body')).toBeNull()
    expect(card.querySelector('dt')?.textContent).toBe('name')
    expect(screen.getByText('res.partner-(M)')).toBeTruthy()
    const link = screen.getByRole('link', { name: 'https://example.com/T-1' })
    expect(link.getAttribute('href')).toBe('https://example.com/T-1')
    expect(link.getAttribute('target')).toBe('_blank')
    // The body starts at the document, not at a rule and a setext heading.
    expect(screen.getByRole('heading', { name: 'Spec' })).toBeTruthy()
    expect(document.querySelector('.markdown-body hr')).toBeNull()
  })
})

describe('json', () => {
  it('shows a parsed file as a tree, and text that does not parse as itself', () => {
    render(<FilePreviewModal />)
    open({ target: agentTarget(), kind: 'json', text: '{"a": [1, 2]}' })
    expect(screen.getByTestId('json-tree')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Collapse a' })).toBeTruthy()

    // A file cut at the preview cap is not valid JSON.
    open({ target: agentTarget(), kind: 'json', text: '{"a": [1, 2' })
    expect(screen.queryByTestId('json-tree')).toBeNull()
    expect(document.querySelector('pre')?.textContent).toBe('{"a": [1, 2')
  })
})

describe('a press outside the card straight after an open', () => {
  it('is ignored for the guard after each open, and closes once it has passed', () => {
    vi.useFakeTimers()
    render(<FilePreviewModal />)
    open({ target: agentTarget(), kind: 'text', text: 'hello', origin: { x: 150, y: 120 } })

    // The second press of the double-click that opened it.
    act(() => vi.advanceTimersByTime(OPEN_PRESS_GUARD_MS - 1))
    const notPrevented = fireEvent.mouseDown(backdrop())
    expect(notPrevented).toBe(true)
    expect(useFilePreviewStore.getState().target).not.toBeNull()
    // A press inside the card is the card's either way.
    fireEvent.mouseDown(screen.getByRole('button', { name: 'More file actions' }))
    expect(useFilePreviewStore.getState().target).not.toBeNull()

    // A newer open restarts the guard.
    act(() => vi.advanceTimersByTime(1))
    open({ target: agentTarget({ ...csv, path: '/agent/b.csv', text: 'b.csv', displayPath: 'b.csv' }), kind: 'text', text: 'two', origin: { x: 1, y: 1 } })
    act(() => vi.advanceTimersByTime(OPEN_PRESS_GUARD_MS - 1))
    fireEvent.mouseDown(backdrop())
    expect(useFilePreviewStore.getState().target).not.toBeNull()

    act(() => vi.advanceTimersByTime(1))
    fireEvent.mouseDown(backdrop())
    expect(useFilePreviewStore.getState().target).toBeNull()
  })
})

describe('agent file header and errors', () => {
  it('shows a folder that has gone by name and path, with no file actions', () => {
    render(<FilePreviewModal />)
    open({ target: agentTarget(goneFolder), error: 'That file is no longer there.', errorCode: 'not_found', failedStep: 'authorize' })
    expect(screen.getByText('That folder is no longer there.')).toBeTruthy()
    expect(screen.getByText('old_exports')).toBeTruthy()
    expect(screen.getByText('data/report/old_exports')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'More file actions' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Close preview' })).toBeTruthy()
  })

  it('shows a failed folder reveal in main\'s words, without a second prefix', () => {
    render(<FilePreviewModal />)
    open({
      target: agentTarget(goneFolder),
      error: 'Could not show the file in its folder.',
      errorCode: 'launch_failed',
      failedStep: 'reveal'
    })
    expect(screen.getByText('Could not show the file in its folder.')).toBeTruthy()
    expect(screen.queryByText(/Couldn't show it in its folder/)).toBeNull()
  })

  it('says a missing file once, not again in the action row', () => {
    render(<FilePreviewModal />)
    open({
      target: agentTarget(),
      error: 'That file is no longer there.',
      errorCode: 'not_found',
      failedStep: 'authorize',
      actionError: { action: 'reveal', code: 'not_found', reason: 'That file is no longer there.' }
    })
    expect(screen.getAllByText(/no longer there/)).toHaveLength(1)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('disables Open and Open folder while the body says the file has gone, and only then', () => {
    const actions = () => {
      fireEvent.click(screen.getByRole('button', { name: 'More file actions' }))
      const disabled = ['Open', 'Open folder'].map((name) => (screen.getByRole('menuitem', { name }) as HTMLButtonElement).disabled)
      // The trigger stays usable, so the unavailable items can be seen.
      expect((screen.getByRole('button', { name: 'More file actions' }) as HTMLButtonElement).disabled).toBe(false)
      fireEvent.click(screen.getByRole('button', { name: 'More file actions' }))
      expect(screen.queryByRole('menu')).toBeNull()
      return disabled
    }
    render(<FilePreviewModal />)
    for (const failedStep of ['authorize', 'preview'] as const) {
      open({ target: agentTarget(), error: 'That file is no longer there.', errorCode: 'not_found', failedStep })
      expect(actions()).toEqual([true, true])
    }
    // Other failures, content, and a load still in flight leave them usable.
    open({ target: agentTarget(), error: 'Could not read it.', errorCode: 'read_failed', failedStep: 'preview' })
    expect(actions()).toEqual([false, false])
    open({ target: agentTarget(), kind: 'text', text: 'hello' })
    expect(actions()).toEqual([false, false])
    open({ target: agentTarget(), kind: 'text', isLoading: true })
    expect(actions()).toEqual([false, false])
  })

  it('names the failed action in the row under the header', () => {
    render(<FilePreviewModal />)
    open({ target: agentTarget(), kind: 'text', text: 'hello' })
    act(() =>
      useFilePreviewStore.setState({ actionError: { action: 'open', code: 'launch_failed', reason: 'No app could open this file.' } })
    )
    expect(screen.getByRole('alert').textContent).toBe('No app could open this file.')
    act(() => useFilePreviewStore.setState({ actionError: { action: 'reveal', code: null, reason: 'boom' } }))
    expect(screen.getByRole('alert').textContent).toBe("Couldn't show it in its folder: boom")
  })

  it('keeps the attachment body copy', () => {
    render(<FilePreviewModal />)
    open({
      target: { type: 'attachment', attachment: { id: 'f1', filename: 'a.txt', size: 1, mimeType: 'text/plain' } },
      attachment: { id: 'f1', filename: 'a.txt', size: 1, mimeType: 'text/plain' },
      kind: 'text',
      error: 'nope'
    })
    expect(screen.getByText("Couldn't load preview: nope")).toBeTruthy()
  })

  it('gives the filename a title, for when it truncates', () => {
    render(<FilePreviewModal />)
    open({ target: agentTarget(), kind: 'text', text: 'hello' })
    expect(screen.getByText('omp.csv').getAttribute('title')).toBe('omp.csv')
  })

  it('rings the scrolling body in the accent when tabbed to, not in Chromium’s default', () => {
    render(<FilePreviewModal />)
    open({ target: agentTarget(), kind: 'text', text: 'hello' })
    const body = screen.getByText('hello').closest('.overflow-auto')!
    expect(body.className.split(/\s+/)).toEqual(
      expect.arrayContaining(['focus-visible:outline-2', 'focus-visible:outline-[var(--color-accent)]'])
    )
  })
})

/** A spec-shaped file: a title, several sections, a repeated heading. */
const LONG_MD = [
  '# Spec',
  '',
  '## Goal',
  '',
  'Why.',
  '',
  '## Design',
  '',
  '### Edge Cases',
  '',
  '## Tests',
  '',
  '### Edge Cases'
].join('\n')
const mdFile: AgentFileRef = { text: 'docs/spec.md', path: '/agent/docs/spec.md', displayPath: 'docs/spec.md', kind: 'file', inside: true }
const CONTENTS_KEY = 'cinna-preview-contents-open'

const contentsButton = (): HTMLElement | null => screen.queryByRole('button', { name: 'Contents' })
const body = (): HTMLElement => document.querySelector<HTMLElement>('div.overflow-auto')!

describe('the Contents panel', () => {
  let innerWidth: number
  beforeEach(() => {
    innerWidth = window.innerWidth
    localStorage.removeItem(CONTENTS_KEY)
    act(() => useUIStore.setState({ previewContentsOpen: true }))
  })
  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: innerWidth })
    delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo
  })

  it('is offered for a long markdown file, open by default, listing H2s under a lone H1', () => {
    render(<FilePreviewModal />)
    open({ target: agentTarget(mdFile), kind: 'markdown', text: LONG_MD })
    const button = contentsButton()!
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(button.getAttribute('aria-controls')).toBe('file-preview-contents')
    const nav = screen.getByRole('navigation', { name: 'Contents' })
    expect(nav.id).toBe('file-preview-contents')
    expect(Array.from(nav.querySelectorAll('button')).map((b) => b.textContent)).toEqual([
      'Goal',
      'Design',
      'Edge Cases',
      'Tests',
      'Edge Cases'
    ])
    // Every rendered heading carries its line; the order is Contents, ⋯, ×.
    expect(Array.from(body().querySelectorAll('[data-heading-line]')).map((h) => h.getAttribute('data-heading-line'))).toEqual(
      ['1', '3', '7', '9', '11', '13']
    )
    const header = screen.getByRole('button', { name: 'Close preview' }).parentElement!
    expect(Array.from(header.querySelectorAll('button')).map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual([
      'Contents',
      'More file actions',
      'Close preview'
    ])
  })

  it('is not offered for a short markdown file, a non-markdown file, or an attachment csv', () => {
    render(<FilePreviewModal />)
    open({ target: agentTarget(mdFile), kind: 'markdown', text: '# Title\n\n## Only\n\n### Sub\n\n### Sub' })
    expect(screen.getByRole('heading', { name: 'Only' })).toBeTruthy()
    expect(contentsButton()).toBeNull()
    expect(screen.queryByRole('navigation', { name: 'Contents' })).toBeNull()

    open({ target: agentTarget(), kind: 'text', text: LONG_MD })
    expect(contentsButton()).toBeNull()

    const attachment = { id: 'f1', filename: 'a.csv', size: 1, mimeType: 'text/csv' }
    open({ target: { type: 'attachment', attachment }, attachment, kind: 'csv', text: 'a,b\n1,2\n' })
    expect(contentsButton()).toBeNull()

    // A long markdown attachment is offered it like an agent file.
    const md = { id: 'f2', filename: 'spec.md', size: 1, mimeType: 'text/markdown' }
    open({ target: { type: 'attachment', attachment: md }, attachment: md, kind: 'markdown', text: LONG_MD })
    expect(contentsButton()).not.toBeNull()
  })

  it('does not count a frontmatter block, which is not part of the rendered body', () => {
    render(<FilePreviewModal />)
    const text = ['---', 'name: spec', '---', '', '# Spec', '', '## Only'].join('\n')
    open({ target: agentTarget(mdFile), kind: 'markdown', text })
    expect(screen.getByTestId('frontmatter')).toBeTruthy()
    expect(contentsButton()).toBeNull()
  })

  it('shows a cut-off entry in full after a short rest, and never an entry that fits', () => {
    vi.useFakeTimers()
    render(<FilePreviewModal />)
    open({ target: agentTarget(mdFile), kind: 'markdown', text: LONG_MD })
    act(() => {
      vi.advanceTimersByTime(ENTRANCE_WAIT_MS)
    })
    const entries = screen.getByRole('navigation', { name: 'Contents' }).querySelectorAll('button')
    const hint = (): HTMLElement | null => document.body.querySelector('[data-toc-full-title]')
    Object.defineProperty(entries[1], 'scrollWidth', { configurable: true, value: 400 })
    Object.defineProperty(entries[1], 'clientWidth', { configurable: true, value: 200 })

    fireEvent.mouseEnter(entries[0])
    act(() => {
      vi.advanceTimersByTime(FULL_TITLE_DELAY_MS)
    })
    expect(hint()).toBeNull()

    fireEvent.mouseLeave(entries[0])
    fireEvent.mouseEnter(entries[1])
    act(() => {
      vi.advanceTimersByTime(FULL_TITLE_DELAY_MS - 1)
    })
    expect(hint()).toBeNull()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(hint()?.textContent).toBe(entries[1].textContent)

    fireEvent.mouseLeave(entries[1])
    expect(hint()).toBeNull()
    vi.useRealTimers()
  })

  it('scrolls the body container to the clicked heading, and marks that entry current', () => {
    const scrolled: Array<{ element: HTMLElement; options: ScrollToOptions }> = []
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      writable: true,
      value: function (this: HTMLElement, options: ScrollToOptions) {
        scrolled.push({ element: this, options })
      }
    })
    render(<FilePreviewModal />)
    open({ target: agentTarget(mdFile), kind: 'markdown', text: LONG_MD })
    const nav = screen.getByRole('navigation', { name: 'Contents' })
    const entries = nav.querySelectorAll('button')
    fireEvent.click(entries[3])
    expect(scrolled).toHaveLength(1)
    expect(scrolled[0].element).toBe(body())
    expect(scrolled[0].options.behavior).toBe('smooth')
    expect(entries[3].getAttribute('aria-current')).toBe('location')
    expect(entries[0].getAttribute('aria-current')).toBeNull()
    // The window is never what scrolls.
    expect(scrolled.every((s) => s.element !== document.documentElement)).toBe(true)
  })

  it('remembers being closed, across previews and in localStorage', () => {
    render(<FilePreviewModal />)
    open({ target: agentTarget(mdFile), kind: 'markdown', text: LONG_MD })
    fireEvent.click(contentsButton()!)
    expect(contentsButton()!.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('navigation', { name: 'Contents' })).toBeNull()
    expect(localStorage.getItem(CONTENTS_KEY)).toBe('0')

    open({ target: agentTarget({ ...mdFile, path: '/agent/b.md', text: 'b.md', displayPath: 'b.md' }), kind: 'markdown', text: LONG_MD })
    expect(contentsButton()!.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('navigation', { name: 'Contents' })).toBeNull()

    fireEvent.click(contentsButton()!)
    expect(screen.getByRole('navigation', { name: 'Contents' })).toBeTruthy()
    expect(localStorage.getItem(CONTENTS_KEY)).toBe('1')
  })

  it('widens the card to the right in a wide window, keeping the body at the closed width', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1600 })
    render(<FilePreviewModal />)
    open({ target: agentTarget(mdFile), kind: 'markdown', text: LONG_MD })
    // Opened already open: at its final width, with nothing to animate.
    expect(card().style.width).toBe('1008px')
    expect(card().style.left).toBe('120px')
    expect(card().style.transition).toBe('')
    expect(body().style.width).toBe('766px')
    expect(screen.getByRole('navigation', { name: 'Contents' }).className).not.toContain('shadow-[')

    // The button's own change animates, and the body keeps its width.
    fireEvent.click(contentsButton()!)
    expect(card().style.width).toBe('768px')
    expect(card().style.left).toBe('0px')
    expect(card().style.transition).toContain('width 170ms')
    expect(body().style.width).toBe('766px')

    // A new preview never inherits the animation.
    open({ target: agentTarget({ ...mdFile, path: '/agent/b.md', text: 'b.md', displayPath: 'b.md' }), kind: 'markdown', text: LONG_MD })
    expect(card().style.transition).toBe('')
  })

  it('still widens when the right side is short of room, moving left only as far as it must', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1100 })
    render(<FilePreviewModal />)
    open({ target: agentTarget(mdFile), kind: 'markdown', text: LONG_MD })
    // Centred at 1008px the right edge is at 1054; 30px more keeps 16 to spare.
    expect(card().style.width).toBe('1008px')
    expect(card().style.left).toBe('30px')
    expect(body().style.width).toBe('766px')
    expect(screen.getByRole('navigation', { name: 'Contents' }).className).not.toContain('shadow-[')
  })

  it('ignores a press outside straight after a toggle, which moved the card from under the pointer', () => {
    vi.useFakeTimers()
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1600 })
    render(<FilePreviewModal />)
    open({ target: agentTarget(mdFile), kind: 'markdown', text: LONG_MD })
    act(() => vi.advanceTimersByTime(OPEN_PRESS_GUARD_MS))
    fireEvent.click(contentsButton()!)
    act(() => vi.advanceTimersByTime(OPEN_PRESS_GUARD_MS - 1))
    fireEvent.mouseDown(backdrop())
    expect(useFilePreviewStore.getState().target).not.toBeNull()
    act(() => vi.advanceTimersByTime(1))
    fireEvent.mouseDown(backdrop())
    expect(useFilePreviewStore.getState().target).toBeNull()
  })

  it('lays the panel over the body after a slow load, until the user toggles it', () => {
    vi.useFakeTimers()
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1600 })
    render(<FilePreviewModal />)
    open({ target: agentTarget(mdFile), kind: 'markdown', isLoading: true })
    act(() => vi.advanceTimersByTime(ENTRANCE_WAIT_MS))
    act(() => useFilePreviewStore.setState({ isLoading: false, text: LONG_MD }))
    // The loading card was shown narrow: it stays that width.
    expect(card().style.width).toBe('768px')
    expect(screen.getByRole('navigation', { name: 'Contents' }).className).toContain('shadow-[')

    fireEvent.click(contentsButton()!)
    fireEvent.click(contentsButton()!)
    expect(card().style.width).toBe('1008px')
  })

  it('takes the closed width from the root font size', () => {
    expect(contentsGeometry(1400, 17).closedWidth).toBe(816)
    expect(contentsGeometry(1400).closedWidth).toBe(768)
  })

  it('follows a resize made while no preview was open', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1600 })
    render(<FilePreviewModal />)
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1100 })
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    open({ target: agentTarget(mdFile), kind: 'markdown', text: LONG_MD })
    expect(card().style.left).toBe('30px')
  })

  it('lays the panel over the body in a narrow window, and follows a resize', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 })
    render(<FilePreviewModal />)
    open({ target: agentTarget(mdFile), kind: 'markdown', text: LONG_MD })
    expect(card().style.width).toBe('768px')
    expect(card().style.left).toBe('0px')
    expect(screen.getByRole('navigation', { name: 'Contents' }).className).toContain('shadow-[')

    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1600 })
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    expect(card().style.width).toBe('1008px')
    expect(screen.getByRole('navigation', { name: 'Contents' }).className).not.toContain('shadow-[')
  })
})

describe('the ⋯ menu', () => {
  const trigger = (): HTMLElement => screen.getByRole('button', { name: 'More file actions' })
  const item = (name: string): HTMLButtonElement => screen.getByRole('menuitem', { name }) as HTMLButtonElement

  it('holds Open then Open folder, and runs the one picked without closing the preview', () => {
    vi.useFakeTimers()
    const openExternally = vi.fn(() => Promise.resolve())
    const reveal = vi.fn(() => Promise.resolve())
    render(<FilePreviewModal />)
    open({ target: agentTarget(), kind: 'text', text: 'hello' })
    act(() => useFilePreviewStore.setState({ openAgentFileExternally: openExternally, revealAgentFile: reveal }))
    act(() => vi.advanceTimersByTime(OPEN_PRESS_GUARD_MS))

    fireEvent.click(trigger())
    const menu = screen.getByRole('menu', { name: 'File actions' })
    expect(Array.from(menu.querySelectorAll('[role="menuitem"]')).map((m) => m.textContent)).toEqual(['Open', 'Open folder'])
    expect(card().contains(menu)).toBe(false)
    // The first item takes focus, for the keyboard.
    expect(document.activeElement).toBe(item('Open'))

    // A press on the portaled menu is not a press outside the preview.
    fireEvent.mouseDown(item('Open folder'))
    expect(useFilePreviewStore.getState().target).not.toBeNull()
    fireEvent.click(item('Open folder'))
    expect(reveal).toHaveBeenCalledTimes(1)
    expect(openExternally).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).toBeNull()
    expect(useFilePreviewStore.getState().target).not.toBeNull()
    expect(document.activeElement).toBe(trigger())
  })

  it('takes a press outside while open for itself, as Escape does', () => {
    vi.useFakeTimers()
    render(<FilePreviewModal />)
    open({ target: agentTarget(), kind: 'text', text: 'hello' })
    act(() => vi.advanceTimersByTime(OPEN_PRESS_GUARD_MS))
    fireEvent.click(trigger())
    fireEvent.mouseDown(backdrop())
    expect(useFilePreviewStore.getState().target).not.toBeNull()
    act(() => vi.runOnlyPendingTimers())
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.mouseDown(backdrop())
    expect(useFilePreviewStore.getState().target).toBeNull()
  })

  it('closes on Escape without closing the preview; the next Escape closes the preview', () => {
    render(<FilePreviewModal />)
    open({ target: agentTarget(), kind: 'text', text: 'hello' })
    fireEvent.click(trigger())
    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(useFilePreviewStore.getState().target).not.toBeNull()
    expect(document.activeElement).toBe(trigger())

    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(useFilePreviewStore.getState().target).toBeNull()
  })

  it('moves between its items with the arrow keys', () => {
    render(<FilePreviewModal />)
    open({ target: agentTarget(), kind: 'text', text: 'hello' })
    fireEvent.click(trigger())
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(item('Open folder'))
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(item('Open'))
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(item('Open folder'))
  })

  it('spins its trigger while an action runs, with both items disabled and the trigger usable', () => {
    render(<FilePreviewModal />)
    open({ target: agentTarget(), kind: 'text', text: 'hello' })
    expect(trigger().querySelector('.animate-spin')).toBeNull()
    act(() => useFilePreviewStore.setState({ pendingAction: 'reveal' }))
    expect(trigger().querySelector('.animate-spin')).not.toBeNull()
    expect((trigger() as HTMLButtonElement).disabled).toBe(false)
    // A real click focuses the button; jsdom's does not.
    act(() => trigger().focus())
    fireEvent.click(trigger())
    expect([item('Open').disabled, item('Open folder').disabled]).toEqual([true, true])
    // Nothing usable to focus: it stays on the trigger.
    expect(document.activeElement).toBe(trigger())
    act(() => useFilePreviewStore.setState({ pendingAction: null }))
    expect([item('Open').disabled, item('Open folder').disabled]).toEqual([false, false])
  })

  it('is not offered for an attachment, which keeps its Download button', () => {
    const attachment = { id: 'f1', filename: 'a.txt', size: 1, mimeType: 'text/plain' }
    render(<FilePreviewModal />)
    open({ target: { type: 'attachment', attachment }, attachment, kind: 'text', text: 'x' })
    expect(screen.queryByRole('button', { name: 'More file actions' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Download a.txt' })).toBeTruthy()
  })
})
