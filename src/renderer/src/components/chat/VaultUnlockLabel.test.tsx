import { render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { VaultUnlockLabel } from './VaultUnlockLabel'

function button(pending: boolean, percent: number | null): HTMLElement {
  render(createElement('button', null, createElement(VaultUnlockLabel, { pending, percent })))
  return screen.getByRole('button')
}

describe('VaultUnlockLabel', () => {
  it('says Unlock, then Unlocking…, then the download percent, always sized for the longest', () => {
    expect(button(false, null).textContent).toContain('Unlock')
    expect(screen.getByRole('button', { name: 'Unlock' })).toBeTruthy()
    // The hidden sizer is always there: the button never widens.
    expect(screen.getByRole('button').textContent).toContain('Unlocking… 100%')
  })

  it('names the pending state, with the percent while the image downloads', () => {
    button(true, null)
    expect(screen.getByRole('button', { name: 'Unlocking…' })).toBeTruthy()
  })

  it('carries the percent', () => {
    button(true, 40)
    expect(screen.getByRole('button', { name: 'Unlocking… 40%' })).toBeTruthy()
  })
})
