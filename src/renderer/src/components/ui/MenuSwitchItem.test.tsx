import { act, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { MenuSwitchItem } from './MenuSwitchItem'
import { switchThumbClass, switchTrackClass } from './SwitchTrack'

/** A boolean in a menu: one row, named by its label, carrying the app's switch. */

function Harness({ initial = false, description }: { initial?: boolean; description?: string }): React.JSX.Element {
  const [on, setOn] = useState(initial)
  return (
    <div role="menu" aria-label="Options">
      <MenuSwitchItem label="On Hover" checked={on} onToggle={() => setOn(!on)} description={description} />
    </div>
  )
}

const track = (row: HTMLElement): HTMLElement => row.querySelector<HTMLElement>('[data-switch-track]')!

describe('MenuSwitchItem', () => {
  it('is a menuitemcheckbox whose switch follows aria-checked, toggled by the whole row', () => {
    render(<Harness />)
    const row = screen.getByRole('menuitemcheckbox', { name: 'On Hover' })
    expect(row.getAttribute('aria-checked')).toBe('false')
    expect(track(row).getAttribute('data-switch-track')).toBe('off')
    expect(track(row).getAttribute('aria-hidden')).toBe('true')
    // No check mark: the switch is the only state.
    expect(row.querySelector('svg')).toBeNull()

    act(() => {
      fireEvent.click(row)
    })
    expect(row.getAttribute('aria-checked')).toBe('true')
    expect(track(row).getAttribute('data-switch-track')).toBe('on')
    expect(track(row).className).toBe(switchTrackClass(true, 'sm'))
    expect((track(row).firstElementChild as HTMLElement).className).toBe(switchThumbClass(true, 'sm'))

    act(() => {
      fireEvent.click(row)
    })
    expect(row.getAttribute('aria-checked')).toBe('false')
  })

  it('keeps the label as the name and reads the description as a description', () => {
    render(<Harness description="Shows over the chat at the left edge" />)
    const row = screen.getByRole('menuitemcheckbox', { name: 'On Hover' })
    expect(row).toBe(screen.getByRole('menuitemcheckbox', { description: 'Shows over the chat at the left edge' }))
  })

  it('does not toggle while disabled', () => {
    const onToggle = vi.fn()
    render(<MenuSwitchItem label="On Hover" checked={false} onToggle={onToggle} disabled />)
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'On Hover' }))
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('draws the settings switch at menu size, colours through tokens only', () => {
    expect(switchTrackClass(true)).toContain('h-5 w-9')
    expect(switchTrackClass(true, 'sm')).toContain('h-4 w-7')
    expect(switchTrackClass(true, 'sm')).toContain('bg-[var(--color-accent)]')
    expect(switchTrackClass(false, 'sm')).toContain('bg-[var(--color-border)]')
    expect(switchThumbClass(true)).toContain('left-[18px]')
    expect(switchThumbClass(true, 'sm')).toContain('left-[14px]')
    expect(switchThumbClass(false, 'sm')).toContain('left-0.5')
  })
})
