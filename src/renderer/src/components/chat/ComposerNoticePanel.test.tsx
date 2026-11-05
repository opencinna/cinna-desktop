import { act, render, screen } from '@testing-library/react'
import { AlertTriangle, Link } from 'lucide-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ComposerNoticePanel, useNoticePanelPresence, type ComposerNotice } from './ComposerNoticePanel'

const A: ComposerNotice = { key: 'a', tone: 'warning', icon: AlertTriangle, text: 'Engine not logged in', textId: 'a-text' }
const B: ComposerNotice = { key: 'b', tone: 'accent', icon: Link, text: 'Skill link offer' }

function rowOf(text: string): HTMLElement {
  return screen.getByText(text).closest('li') as HTMLElement
}

/**
 * An animationend as Chromium sends it. jsdom has no AnimationEvent, so React
 * listens for the prefixed name there; either one reaches onAnimationEnd.
 */
function endAnimation(el: HTMLElement, animationName: string): void {
  const type = 'AnimationEvent' in window ? 'animationend' : 'webkitAnimationEnd'
  const event = new Event(type, { bubbles: true })
  Object.defineProperty(event, 'animationName', { value: animationName })
  act(() => { el.dispatchEvent(event) })
}

describe('ComposerNoticePanel row motion', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('opens with its first rows still, and unfolds only a row added later', () => {
    const view = render(<ComposerNoticePanel notices={[A]} />)
    expect(rowOf('Engine not logged in').className).not.toContain('composer-notice-row-enter')
    view.rerender(<ComposerNoticePanel notices={[A, B]} />)
    const added = rowOf('Skill link offer')
    expect(added.className).toContain('composer-notice-row-enter')
    endAnimation(added, 'composer-notice-unfold')
    expect(rowOf('Skill link offer').className).not.toContain('composer-notice-row-enter')
  })

  it('keeps a removed row in its place, inert and without its id, until it has folded up', () => {
    const view = render(<ComposerNoticePanel notices={[A, B]} />)
    view.rerender(<ComposerNoticePanel notices={[B]} />)
    const leaving = rowOf('Engine not logged in')
    expect(leaving.className).toContain('composer-notice-row-leave')
    expect(leaving.hasAttribute('inert')).toBe(true)
    expect(document.getElementById('a-text')).toBeNull()
    // Still first: it folds where it stood.
    expect(leaving.parentElement!.firstElementChild).toBe(leaving)
    endAnimation(leaving, 'composer-notice-fold')
    expect(screen.queryByText('Engine not logged in')).toBeNull()
    expect(screen.getByText('Skill link offer')).toBeTruthy()
  })

  it('drops a leaving row after the fallback when its animation never ends', () => {
    vi.useFakeTimers()
    const view = render(<ComposerNoticePanel notices={[A, B]} />)
    view.rerender(<ComposerNoticePanel notices={[B]} />)
    expect(screen.getByText('Engine not logged in')).toBeTruthy()
    act(() => { vi.advanceTimersByTime(700) })
    expect(screen.queryByText('Engine not logged in')).toBeNull()
  })

  it('takes a row back when its key returns while it is leaving', () => {
    const view = render(<ComposerNoticePanel notices={[A, B]} />)
    view.rerender(<ComposerNoticePanel notices={[B]} />)
    view.rerender(<ComposerNoticePanel notices={[A, B]} />)
    const row = rowOf('Engine not logged in')
    expect(row.className).not.toContain('composer-notice-row-leave')
    expect(row.hasAttribute('inert')).toBe(false)
    expect(screen.getAllByText('Engine not logged in')).toHaveLength(1)
  })

  it('removes a row at once under reduced motion', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    const view = render(<ComposerNoticePanel notices={[A, B]} />)
    view.rerender(<ComposerNoticePanel notices={[B]} />)
    expect(screen.queryByText('Engine not logged in')).toBeNull()
  })

  describe('the panel sinking with its last notice', () => {
    /** As ChatInput mounts it: only while the presence has notices to draw. */
    function Host({ notices }: { notices: ComposerNotice[] }): React.JSX.Element | null {
      const panel = useNoticePanelPresence(notices)
      return panel.notices.length > 0 ? <ComposerNoticePanel {...panel} /> : null
    }

    it('keeps the last notices, inert and sinking, until the animation ends', () => {
      const view = render(<Host notices={[A]} />)
      view.rerender(<Host notices={[]} />)
      const panel = screen.getByRole('status', { hidden: true })
      expect(panel.className).toContain('composer-notice-panel-leave')
      expect(panel.hasAttribute('inert')).toBe(true)
      expect(document.getElementById('a-text')).toBeNull()
      endAnimation(panel, 'composer-notice-sink')
      expect(screen.queryByText('Engine not logged in')).toBeNull()
    })

    it('stays up when a notice arrives while it sinks', () => {
      const view = render(<Host notices={[A]} />)
      view.rerender(<Host notices={[]} />)
      view.rerender(<Host notices={[B]} />)
      const panel = screen.getByRole('status')
      expect(panel.className).not.toContain('composer-notice-panel-leave')
      expect(panel.hasAttribute('inert')).toBe(false)
    })

    it('drops the held notices when the chat changes', () => {
      function ChatHost({ notices, chatId }: { notices: ComposerNotice[]; chatId: string }): React.JSX.Element | null {
        const panel = useNoticePanelPresence(notices, chatId)
        return panel.notices.length > 0 ? <ComposerNoticePanel {...panel} /> : null
      }
      const view = render(<ChatHost notices={[A]} chatId="a" />)
      view.rerender(<ChatHost notices={[]} chatId="b" />)
      expect(screen.queryByText('Engine not logged in')).toBeNull()
    })

    it('goes at once under reduced motion', () => {
      vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
      const view = render(<Host notices={[A]} />)
      view.rerender(<Host notices={[]} />)
      expect(screen.queryByText('Engine not logged in')).toBeNull()
    })
  })
})
