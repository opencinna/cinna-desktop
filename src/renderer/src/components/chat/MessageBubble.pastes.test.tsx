import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../stores/logger.store', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { MessageBubble } from './MessageBubble'
import { messageContextText } from './MessageContextMenu'
import { TranscriptExpansionContext, createTranscriptExpansionStore } from './transcriptExpansion'
import { withPastes } from '../../../../shared/pastedText'
import { LEAVE_BOTTOM_EVENT } from '../../hooks/useStickToBottom'

const EMAIL = 'Hi Anna,\n\nCould we meet on Thursday?\n\nBest, Bob'
const LOG = 'line one\nline two'
const MESSAGE = withPastes('reply politely, decline the meeting', [{ text: EMAIL }, { text: LOG }])

/**
 * jsdom has no layout: the measured content (the clamp's inner box) reports
 * `contentHeight`, everything else 0. The observer is a stub fired by hand.
 */
let contentHeight = 0
let fireResize: () => void = () => {}
class StubResizeObserver {
  constructor(private cb: () => void) {
    fireResize = () => this.cb()
  }
  observe(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  contentHeight = 0
  vi.stubGlobal('ResizeObserver', StubResizeObserver)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute('data-message-markdown') ? contentHeight : 0
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const toggle = (): HTMLElement | null => screen.queryByRole('button', { name: /^Show (more|less)$/ })
const clampBox = (container: HTMLElement): HTMLElement =>
  container.querySelector('[data-message-markdown]')!.parentElement as HTMLElement

describe('MessageBubble paste cards', () => {
  it('renders each paste as a card and the typed text as markdown, in order', () => {
    const { container } = render(<MessageBubble role="user" content={MESSAGE} />)
    const cards = screen.getAllByTestId('paste-card')
    expect(cards.map((card) => card.textContent)).toEqual(['Hi Anna,· 5 lines', 'line one· 2 lines'])
    expect(container.textContent).not.toContain('<pasted_text')
    expect(container.textContent).not.toContain('Thursday')
    const paragraph = container.querySelector('p')
    expect(paragraph?.textContent).toBe('reply politely, decline the meeting')
    // Cards come before the typed text, as sent.
    expect(cards[1].compareDocumentPosition(paragraph!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('opens the raw paste in the preview from its card', () => {
    render(<MessageBubble role="user" content={MESSAGE} />)
    fireEvent.click(screen.getAllByTestId('paste-card')[0])
    const dialog = screen.getByRole('dialog', { name: 'Pasted text' })
    expect(dialog.textContent).toContain('Could we meet on Thursday?')
  })

  it('renders a message with no blocks as before, without cards', () => {
    const { container } = render(<MessageBubble role="user" content="My **question**" />)
    expect(screen.queryByTestId('paste-card')).toBeNull()
    expect(container.querySelector('strong')?.textContent).toBe('question')
    expect(container.querySelector('[data-message-markdown]')?.getAttribute('data-message-markdown')).toBe('My **question**')
  })

  it('leaves tags alone in an assistant reply', () => {
    render(<MessageBubble role="assistant" content={MESSAGE} />)
    expect(screen.queryByTestId('paste-card')).toBeNull()
  })

  it('copies a completely selected message as the raw pastes and the typed text, no tags', () => {
    const { container } = render(<MessageBubble role="user" content={MESSAGE} />)
    const message = container.querySelector<HTMLElement>('[data-message-markdown]')!
    const range = document.createRange()
    range.selectNodeContents(message)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    expect(messageContextText(container, container.querySelector('p')!, selection)).toBe(
      `${EMAIL}\n\n${LOG}\n\nreply politely, decline the meeting`
    )
  })
})

describe('MessageBubble clamp', () => {
  it('clamps a long message on its first render and offers Show more', () => {
    contentHeight = 900
    const { container } = render(<MessageBubble role="user" content="long" />)
    expect(toggle()?.textContent).toBe('Show more')
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false')
    expect(clampBox(container).style.maxHeight).toBe('300px')
  })

  it('offers no toggle for a message that fits', () => {
    contentHeight = 250
    const { container } = render(<MessageBubble role="user" content="short" />)
    expect(toggle()).toBeNull()
    expect(clampBox(container).style.maxHeight).toBe('')
  })

  it('does not clamp when it would hide less than the slack', () => {
    contentHeight = 379
    const { container } = render(<MessageBubble role="user" content="nearly" />)
    expect(toggle()).toBeNull()
    expect(clampBox(container).style.maxHeight).toBe('')
  })

  it('clamps once it would hide the slack or more', () => {
    contentHeight = 380
    render(<MessageBubble role="user" content="just over" />)
    expect(toggle()).not.toBeNull()
  })

  it('re-decides when the content resizes', () => {
    contentHeight = 250
    render(<MessageBubble role="user" content="narrowing" />)
    expect(toggle()).toBeNull()
    contentHeight = 700
    act(() => fireResize())
    expect(toggle()).not.toBeNull()
  })

  it('never clamps an assistant reply', () => {
    contentHeight = 900
    render(<MessageBubble role="assistant" content="a long reply" />)
    expect(toggle()).toBeNull()
  })

  it('expands to the measured height, then drops the limit; Show less clamps again', () => {
    vi.useFakeTimers()
    try {
      contentHeight = 900
      const { container } = render(<MessageBubble role="user" content="long" />)
      fireEvent.click(toggle()!)
      expect(toggle()?.textContent).toBe('Show less')
      expect(toggle()?.getAttribute('aria-expanded')).toBe('true')
      expect(clampBox(container).style.maxHeight).toBe('900px')
      act(() => {
        vi.advanceTimersByTime(400)
      })
      expect(clampBox(container).style.maxHeight).toBe('')
      fireEvent.click(toggle()!)
      expect(toggle()?.textContent).toBe('Show more')
      expect(clampBox(container).style.maxHeight).toBe('300px')
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves the bottom on Show more, so a pinned transcript does not follow the growth', () => {
    contentHeight = 900
    const leaves = vi.fn()
    render(
      <div data-testid="transcript" style={{ overflowY: 'auto' }}>
        <MessageBubble role="user" content="long" />
      </div>
    )
    screen.getByTestId('transcript').addEventListener(LEAVE_BOTTOM_EVENT, leaves)
    fireEvent.click(toggle()!)
    expect(leaves).toHaveBeenCalledTimes(1)
    // Show less holds its anchor instead; it does not leave the bottom again.
    fireEvent.click(toggle()!)
    expect(leaves).toHaveBeenCalledTimes(1)
  })

  it('registers an opened bubble with the transcript, and Collapse expanded closes it', () => {
    contentHeight = 900
    const store = createTranscriptExpansionStore()
    render(
      <TranscriptExpansionContext.Provider value={store}>
        <MessageBubble role="user" content="long" />
      </TranscriptExpansionContext.Provider>
    )
    expect(store.hasExpanded()).toBe(false)
    fireEvent.click(toggle()!)
    expect(store.hasExpanded()).toBe(true)
    act(() => store.collapseAll())
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false')
    expect(store.hasExpanded()).toBe(false)
  })
})
