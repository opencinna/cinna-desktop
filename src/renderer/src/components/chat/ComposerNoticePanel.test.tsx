import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { AlertTriangle, Link, Plus, UserPlus } from 'lucide-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ComposerNoticePanel, NoticeSplitButton, useNoticePanelPresence, type ComposerNotice } from './ComposerNoticePanel'

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

describe('a row with details', () => {
  const D: ComposerNotice = {
    key: 'd', tone: 'warning', icon: AlertTriangle, text: 'manifest: the first finding, cut short', singleLine: true,
    details: <ul><li>the second finding</li></ul>, detailsName: 'Show 1 more finding'
  }
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('opens them from an icon toggle named for what it opens, never a text link', () => {
    render(<ComposerNoticePanel notices={[D]} />)
    const toggle = screen.getByRole('button', { name: 'Show 1 more finding' })
    expect(toggle.getAttribute('title')).toBe('Show 1 more finding')
    expect(toggle.textContent).toBe('')
    expect(toggle.querySelector('svg')).toBeTruthy()
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('the second finding')).toBeNull()
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(toggle.className).toContain('bg-[var(--color-bg-hover)]')
    expect(toggle.querySelector('svg')!.getAttribute('class')).toContain('rotate-180')
    expect(screen.getByText('the second finding')).toBeTruthy()
  })

  it('shows the whole sentence while open, and clamps it again once closed (at once without motion)', () => {
    render(<ComposerNoticePanel notices={[D]} />)
    const line = screen.getByText('manifest: the first finding, cut short')
    expect(line.className).toContain('truncate')
    fireEvent.click(screen.getByRole('button', { name: 'Show 1 more finding' }))
    expect(line.className).not.toContain('truncate')
    expect(line.className).not.toContain('line-clamp-2')
    expect(line.className).toContain('break-words')
    fireEvent.click(screen.getByRole('button', { name: 'Show 1 more finding' }))
    expect(line.className).toContain('truncate')
  })

  it('a two-line row re-clamps only after the collapse has finished, when rows animate', () => {
    vi.useFakeTimers()
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    render(<ComposerNoticePanel notices={[{ ...D, singleLine: false }]} />)
    const line = screen.getByText('manifest: the first finding, cut short')
    expect(line.className).toContain('line-clamp-2')
    const toggle = screen.getByRole('button', { name: 'Show 1 more finding' })
    fireEvent.click(toggle)
    expect(line.className).not.toContain('line-clamp-2')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    // Still folding: the sentence keeps its lines until the details have gone.
    expect(line.className).not.toContain('line-clamp-2')
    act(() => { vi.advanceTimersByTime(200) })
    expect(line.className).toContain('line-clamp-2')
  })

  it('has no toggle without a name for it', () => {
    render(<ComposerNoticePanel notices={[{ ...D, detailsName: undefined }]} />)
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('NoticeSplitButton', () => {
  function renderSplit(props: Partial<React.ComponentProps<typeof NoticeSplitButton>> = {}) {
    const onClick = vi.fn()
    const onSelect = vi.fn()
    render(<NoticeSplitButton label="Add" icon={Plus} title="Add weekly-report to Research" onClick={onClick}
      moreLabel="More ways to add" items={[{ label: 'New agent with this skill', icon: UserPlus, onSelect }]} {...props} />)
    return { onClick, onSelect }
  }

  it('is named by its visible label, the long form in its title', () => {
    const { onClick } = renderSplit()
    const primary = screen.getByRole('button', { name: 'Add' })
    expect(primary.textContent).toBe('Add')
    expect(primary.getAttribute('title')).toBe('Add weekly-report to Research')
    expect(primary.querySelector('svg')).toBeTruthy()
    expect(primary.className).toContain('composer-notice-button-primary')
    fireEvent.click(primary)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('opens an opaque menu below the chevron, whose item runs and closes it', () => {
    const { onSelect, onClick } = renderSplit()
    const more = screen.getByRole('button', { name: 'More ways to add' })
    expect(more.getAttribute('aria-haspopup')).toBe('menu')
    expect(more.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(more)
    expect(more.getAttribute('aria-expanded')).toBe('true')
    const menu = screen.getByRole('menu')
    expect(menu.className).toContain('bg-[var(--color-bg-secondary)]')
    expect(menu.className).not.toContain('app-popover-surface')
    const item = within(menu).getByRole('menuitem', { name: 'New agent with this skill' })
    expect(item.querySelector('svg')).toBeTruthy()
    fireEvent.click(item)
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onClick).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('closes its menu on Escape, back on the chevron', () => {
    renderSplit()
    const more = screen.getByRole('button', { name: 'More ways to add' })
    fireEvent.click(more)
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'New agent with this skill' }), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(more)
  })

  it('refuses while disabled, keeps its pending label at the same place, and holds a menu whose items are all held', () => {
    const { onClick } = renderSplit({ disabled: true, pending: true, pendingLabel: 'Adding…', items: [{ label: 'New agent with this skill', icon: UserPlus, onSelect: vi.fn(), disabled: true }] })
    const primary = screen.getByRole('button', { name: 'Add' })
    expect(primary.getAttribute('aria-disabled')).toBe('true')
    expect(within(primary).getByText('Adding…').getAttribute('aria-hidden')).toBe('false')
    fireEvent.click(primary)
    expect(onClick).not.toHaveBeenCalled()
    const more = screen.getByRole('button', { name: 'More ways to add' })
    expect(more.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(more)
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
