import { useRef } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AmbientGrid } from './AmbientGrid'

vi.mock('../../stores/ui.store', () => ({
  useUIStore: (selector: (state: { extraUIAnimation: boolean }) => unknown) => selector({ extraUIAnimation: true })
}))

function Composer({ borderColor = '#d97a4a' }: { borderColor?: string }): React.JSX.Element {
  const inputRef = useRef<HTMLTextAreaElement>(null)
  return <div><AmbientGrid inputRef={inputRef} borderColor={borderColor} /><textarea ref={inputRef} aria-label="Message" autoFocus /></div>
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, width: 600, height: 100, top: 0, right: 600, bottom: 100, left: 0, toJSON: () => ({})
  })
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('composer ambient grid', () => {
  it.each(['pointerDown', 'keyDown', 'input', 'compositionStart'] as const)(
    'fades on %s, stays quiet while editing, and resumes after leaving the field', (event) => {
      const { container } = render(<Composer />)
      const input = screen.getByRole('textbox')
      expect(document.activeElement).toBe(input)
      act(() => vi.advanceTimersByTime(3000))
      // Autofocus does not count as editing.
      expect(container.querySelector('svg')).not.toBeNull()

      fireEvent[event](input)
      expect(container.querySelector('[data-fading]')).not.toBeNull()
      expect(container.querySelector('svg')).not.toBeNull()
      act(() => vi.advanceTimersByTime(350))
      expect(container.querySelector('svg')).toBeNull()
      act(() => vi.advanceTimersByTime(60000))
      expect(container.querySelector('svg')).toBeNull()

      fireEvent.blur(input)
      act(() => vi.advanceTimersByTime(17999))
      expect(container.querySelector('svg')).toBeNull()
      act(() => vi.advanceTimersByTime(1))
      expect(container.querySelector('svg')).not.toBeNull()
      expect(container.querySelector('[data-fading]')).toBeNull()
    }
  )

  it('cancels pending fade and restart timers on unmount', () => {
    const { unmount } = render(<Composer />)
    act(() => vi.advanceTimersByTime(3000))
    fireEvent.pointerDown(screen.getByRole('textbox'))
    fireEvent.blur(screen.getByRole('textbox'))
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('runs the border glow less often, follows changing border tints, and fades it on input', () => {
    const { container, rerender } = render(<Composer />)
    act(() => vi.advanceTimersByTime(3000))
    expect(container.querySelector('.ambient-surface-border')).toBeNull()
    act(() => vi.advanceTimersByTime(23500))
    const border = container.querySelector('.ambient-surface-border')
    expect(border).not.toBeNull()
    rerender(<Composer borderColor="#218cda" />)
    expect(container.querySelector('.ambient-surface-border')).toBe(border)
    expect((border!.parentElement as HTMLElement).style.getPropertyValue('--ambient-input-tint')).toBe('#218cda')
    fireEvent.input(screen.getByRole('textbox'))
    expect(container.querySelector('[data-fading]')).not.toBeNull()
    expect(container.querySelector('.ambient-surface-border')).toBe(border)
    act(() => vi.advanceTimersByTime(350))
    expect(container.querySelector('.ambient-surface-border')).toBeNull()
    act(() => vi.advanceTimersByTime(120000))
    expect(container.querySelector('.ambient-surface-border')).toBeNull()
  })

  it('keeps the sidebar border glow independent of composer interaction', () => {
    const { container } = render(<><Composer /><aside><AmbientGrid borderGlow /></aside></>)
    act(() => vi.advanceTimersByTime(26500))
    expect(container.querySelectorAll('.ambient-surface-border')).toHaveLength(2)
    fireEvent.pointerDown(screen.getByRole('textbox'))
    act(() => vi.advanceTimersByTime(350))
    expect(container.querySelectorAll('.ambient-surface-border')).toHaveLength(1)
    expect(container.querySelector('aside .ambient-surface-border')).not.toBeNull()
    expect(container.querySelector('aside [data-fading]')).toBeNull()
  })
})
