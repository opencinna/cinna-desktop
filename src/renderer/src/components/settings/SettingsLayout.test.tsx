import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsInfoTip, SettingsLabel } from './SettingsLayout'

/**
 * `SettingsLabel`'s `info` prop: the standing explanation goes behind a `(?)`
 * beside the label, named after the label, and is not on the page until it is
 * asked for (ux_rules rule 12).
 */
describe('SettingsLabel', () => {
  it('puts the explanation behind a tip named after the label, and keeps htmlFor', () => {
    render(
      <>
        <SettingsLabel htmlFor="tool" info={<p>The Open-in button uses this tool.</p>}>
          Open agents with
        </SettingsLabel>
        <select id="tool" />
      </>
    )

    // The label still labels its control through the wrapper row.
    expect(screen.getByLabelText('Open agents with').tagName).toBe('SELECT')
    // Nothing of the explanation is on the surface until the tip is opened.
    expect(screen.queryByText(/Open-in button uses this tool/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'About Open agents with' }))
    expect(screen.getByRole('dialog', { name: 'About Open agents with' })).toBeTruthy()
    expect(screen.getByText(/Open-in button uses this tool/)).toBeTruthy()
  })

  it('renders no tip without info, and takes an explicit infoLabel', () => {
    const { rerender } = render(<SettingsLabel>Plain</SettingsLabel>)
    expect(screen.queryByRole('button')).toBeNull()

    rerender(
      <SettingsLabel info={<p>Why.</p>} infoLabel="About the thing">
        <span>Not a string</span>
      </SettingsLabel>
    )
    expect(screen.getByRole('button', { name: 'About the thing' })).toBeTruthy()
  })
})

describe('SettingsInfoTip', () => {
  afterEach(() => vi.restoreAllMocks())

  // jsdom lays nothing out: the (?) sits at the bottom of an 800-tall window
  // and the tip is 200 tall, so below it there is no room.
  it('opens above its (?) when there is no room below', () => {
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(800)
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1000)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const rect = this.getAttribute('role') === 'dialog'
        ? { top: 0, left: 580, width: 320, height: 200 }
        : { top: 760, left: 880, width: 20, height: 20 }
      return { ...rect, bottom: rect.top + rect.height, right: rect.left + rect.width, x: rect.left, y: rect.top, toJSON: () => ({}) } as DOMRect
    })
    render(<SettingsInfoTip label="About the last row"><p>Long help.</p></SettingsInfoTip>)
    fireEvent.click(screen.getByRole('button', { name: 'About the last row' }))
    const tip = screen.getByRole('dialog', { name: 'About the last row' })
    expect(tip.style.bottom).toBe('48px')
    expect(tip.style.top).toBe('')
  })
})
