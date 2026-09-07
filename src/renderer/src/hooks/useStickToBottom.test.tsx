import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { useStickToBottom } from './useStickToBottom'

/**
 * jsdom has no layout and no ResizeObserver, so both are supplied here: the
 * observer is a stub whose callback the test fires by hand (standing in for
 * "a chunk arrived and the transcript got taller"), and the container's
 * geometry is defined on the instance because jsdom's own `scrollTop` is a
 * no-op setter that always reads 0.
 */
let fireResize: () => void

class StubResizeObserver {
  constructor(private cb: () => void) {
    fireResize = () => this.cb()
  }
  observe(): void {}
  disconnect(): void {}
}

const CONTENT_HEIGHT = 2000
const VIEWPORT_HEIGHT = 500

function Harness({ chatId }: { chatId: string }): React.JSX.Element {
  const { containerRef, contentRef, pinned, scrollToBottom } = useStickToBottom(chatId)
  return (
    <div ref={containerRef} data-testid="scroller">
      <div ref={contentRef}>content</div>
      <button onClick={scrollToBottom}>jump</button>
      <span data-testid="pinned">{pinned ? 'pinned' : 'free'}</span>
    </div>
  )
}

interface Harnessed {
  scroller: HTMLElement
  pinnedText: () => string
  /** The transcript gets taller, exactly as an arriving chunk makes it. */
  grow: (by: number) => void
  /** Open a different chat — the hook's `resetKey`. */
  openChat: (chatId: string) => void
  /**
   * The transcript gets shorter — a collapsible closing, a tool result
   * collapsing at the streaming-to-persisted hand-off. Re-clamps `scrollTop`
   * the way a browser does, which is the one path that legitimately moves the
   * view up without a user gesture.
   */
  shrink: (by: number) => void
}

function setup(contentHeight = CONTENT_HEIGHT): Harnessed {
  const view = render(<Harness chatId="chat-1" />)
  const scroller = view.getByTestId('scroller')
  let top = 0
  let height = contentHeight
  // A browser clamps to [0, scrollHeight - clientHeight]. Both ends matter:
  // without the lower bound the harness cannot represent a transcript shorter
  // than its viewport, where `stick()` would write a negative `scrollTop` that
  // no browser ever produces.
  const clamp = (v: number): number => Math.max(0, Math.min(v, height - VIEWPORT_HEIGHT))
  Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => height })
  Object.defineProperty(scroller, 'clientHeight', { value: VIEWPORT_HEIGHT, configurable: true })
  Object.defineProperty(scroller, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = clamp(v)
    }
  })
  return {
    scroller,
    pinnedText: () => view.getByTestId('pinned').textContent ?? '',
    openChat: (chatId: string) => view.rerender(<Harness chatId={chatId} />),
    grow: (by: number) => {
      height += by
    },
    shrink: (by: number) => {
      height -= by
      top = clamp(top)
    }
  }
}

describe('useStickToBottom', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', StubResizeObserver)
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** Let the wheel suspension window close. */
  const passWheelWindow = (): void => {
    act(() => {
      vi.advanceTimersByTime(200)
    })
  }

  it('follows the bottom while pinned', () => {
    const { scroller, pinnedText } = setup()
    expect(pinnedText()).toBe('pinned')

    act(() => fireResize())

    expect(scroller.scrollTop).toBe(CONTENT_HEIGHT - VIEWPORT_HEIGHT)
  })

  it('stops following once the user scrolls up, and does not drag them back', () => {
    const { scroller, pinnedText } = setup()
    act(() => fireResize())

    // The user scrolls well away from the bottom.
    act(() => {
      scroller.scrollTop = 200
      scroller.dispatchEvent(new Event('scroll'))
    })
    expect(pinnedText()).toBe('free')

    // More content arrives. The view must stay exactly where the user left it.
    act(() => fireResize())
    expect(scroller.scrollTop).toBe(200)
  })

  it('does not stick while an upward wheel gesture is still in flight', () => {
    const { scroller, pinnedText } = setup()
    act(() => fireResize())
    expect(scroller.scrollTop).toBe(CONTENT_HEIGHT - VIEWPORT_HEIGHT)

    // In order: the user wheels up, the browser scrolls, a chunk lands. The
    // `scroll` event has not been dispatched yet — a wheel handled off the
    // main thread need not even have reached `scrollTop` — and this is the
    // window in which the old code pulled the view back to the bottom.
    act(() => {
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -400 }))
      scroller.scrollTop = 1100
      fireResize()
    })
    expect(scroller.scrollTop).toBe(1100)

    // Once the window closes the state has caught up with where the view is.
    passWheelWindow()
    expect(pinnedText()).toBe('free')
  })

  it('re-pins when the user scrolls back to the bottom mid-stream', () => {
    const { scroller, pinnedText } = setup()
    act(() => fireResize())

    act(() => {
      scroller.scrollTop = 200
      scroller.dispatchEvent(new Event('scroll'))
    })
    expect(pinnedText()).toBe('free')

    act(() => {
      scroller.scrollTop = CONTENT_HEIGHT - VIEWPORT_HEIGHT
      scroller.dispatchEvent(new Event('scroll'))
    })
    expect(pinnedText()).toBe('pinned')

    act(() => fireResize())
    expect(scroller.scrollTop).toBe(CONTENT_HEIGHT - VIEWPORT_HEIGHT)
  })

  it('jumps back to the bottom and re-pins on demand', () => {
    const { scroller, pinnedText } = setup()
    act(() => fireResize())

    act(() => {
      scroller.scrollTop = 100
      scroller.dispatchEvent(new Event('scroll'))
    })
    expect(pinnedText()).toBe('free')

    act(() => {
      ;(document.querySelector('button') as HTMLButtonElement).click()
    })

    expect(pinnedText()).toBe('pinned')
    expect(scroller.scrollTop).toBe(CONTENT_HEIGHT - VIEWPORT_HEIGHT)
  })

  // --- the two races the code reviewer found -----------------------------

  it('stays pinned when a chunk lands between a stick and the scroll event it queued', () => {
    const { scroller, pinnedText, grow } = setup()
    act(() => fireResize())
    const bottom = scroller.scrollTop

    // The stick assignment queued a scroll event for the *next* frame. React
    // commits a tall chunk first — a table gaining rows, a code block
    // appearing — so the handler reads geometry showing 400px of distance the
    // user never opened up.
    act(() => {
      grow(400)
      scroller.dispatchEvent(new Event('scroll'))
    })

    expect(pinnedText()).toBe('pinned')

    // And the next chunk still follows.
    act(() => fireResize())
    expect(scroller.scrollTop).toBeGreaterThan(bottom)
  })

  it('lets a slow trackpad drag escape instead of being reset by every chunk', () => {
    const { scroller, pinnedText, grow } = setup()
    act(() => fireResize())

    // A trackpad delivers only ~25px of accumulated delta per frame — well
    // inside the 64px band that counts as "at the bottom". Without a
    // suspension that outlives the frame, each frame reads `distance ≈ 25`,
    // takes the unconditional-pin branch, and the next chunk's stick discards
    // the 25px: the drag never escapes, and the transcript is felt to be
    // fighting the gesture. A mouse wheel's ~120px notch clears the band in
    // one event and never noticed this.
    for (let i = 0; i < 4; i++) {
      act(() => {
        scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -25, bubbles: true }))
        // The browser scrolls from wherever the view currently is.
        scroller.scrollTop = scroller.scrollTop - 25
        scroller.dispatchEvent(new Event('scroll'))
        // ...and a chunk lands in the same frame.
        grow(20)
        fireResize()
      })
    }

    const distance = scroller.scrollHeight - scroller.scrollTop - VIEWPORT_HEIGHT
    expect(distance).toBeGreaterThan(64)
    expect(pinnedText()).toBe('free')
  })

  it('never unpins a transcript too short to scroll', () => {
    // The shape the phantom pill lived in: nothing to scroll, and a wheel that
    // bubbled up from something nested. `stick()` here writes a `scrollTop` a
    // browser would clamp to 0.
    const { scroller, pinnedText } = setup(300)
    act(() => fireResize())
    expect(scroller.scrollTop).toBe(0)

    act(() => {
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, bubbles: true }))
    })
    passWheelWindow()

    expect(pinnedText()).toBe('pinned')
    expect(scroller.scrollTop).toBe(0)
  })

  it('does not let a swallowed gesture hold the transcript frozen', () => {
    const { scroller, grow } = setup()
    act(() => fireResize())

    // Ten wheel events over a second, all swallowed by a nested scroller, with
    // chunks arriving throughout. Refreshing the window on every one of them
    // would freeze the transcript for the whole second and then jump it.
    for (let i = 0; i < 10; i++) {
      act(() => {
        scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true }))
        grow(60)
        fireResize()
        vi.advanceTimersByTime(100)
      })
    }

    // It kept up all the way through instead of catching up in one jump.
    expect(scroller.scrollTop).toBe(scroller.scrollHeight - VIEWPORT_HEIGHT)
  })

  it('drops the pill when shrinking content puts the view back at the bottom', () => {
    const { scroller, pinnedText, shrink } = setup()
    act(() => fireResize())

    act(() => {
      scroller.scrollTop = 1000
      scroller.dispatchEvent(new Event('scroll'))
    })
    expect(pinnedText()).toBe('free')

    // A tool result collapses. The view is now 50px from the bottom, but the
    // new maximum is above where it sits, so nothing clamps and no scroll
    // event fires — only the resize says anything happened.
    act(() => {
      shrink(450)
      fireResize()
    })

    expect(pinnedText()).toBe('pinned')
  })

  it('does not carry a wheel suspension across a chat switch', () => {
    const { scroller, openChat, grow } = setup()
    act(() => fireResize())

    // A wheel-up, and then the user picks a different chat inside the 150ms
    // window. The suspension belongs to the transcript being left.
    act(() => {
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, bubbles: true }))
    })
    act(() => openChat('chat-2'))

    // The new transcript's messages land. It must open at its bottom, not sit
    // at the top until a timer from the previous chat fires and jumps it.
    act(() => {
      grow(500)
      fireResize()
    })
    expect(scroller.scrollTop).toBe(scroller.scrollHeight - VIEWPORT_HEIGHT)
  })

  it('keeps following when an upward wheel is swallowed by a nested scroller', () => {
    const { scroller, pinnedText, grow } = setup()
    act(() => fireResize())

    // `wheel` bubbles: this one belongs to a tool result's own
    // `overflow-y-auto`, so the transcript itself never moves and no scroll
    // event is ever dispatched for it.
    act(() => {
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, bubbles: true }))
    })

    // Nothing is stuck to while the window is open — the gesture might yet
    // turn out to have been real.
    const held = scroller.scrollTop
    act(() => {
      grow(400)
      fireResize()
    })
    expect(scroller.scrollTop).toBe(held)

    // When it closes and the container has not moved, following resumes and
    // catches up on everything that arrived meanwhile.
    passWheelWindow()
    expect(pinnedText()).toBe('pinned')
    expect(scroller.scrollTop).toBe(CONTENT_HEIGHT + 400 - VIEWPORT_HEIGHT)

    const before = scroller.scrollTop
    act(() => {
      grow(200)
      fireResize()
    })
    expect(scroller.scrollTop).toBeGreaterThan(before)
  })
})
