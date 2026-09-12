import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SettingsLabel } from './SettingsLayout'

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
