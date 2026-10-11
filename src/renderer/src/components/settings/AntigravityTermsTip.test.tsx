import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AntigravityTermsTip, ANTIGRAVITY_TERMS_URL } from './AntigravityTermsTip'

let openExternal: ReturnType<typeof vi.fn>
beforeEach(() => {
  openExternal = vi.fn(async () => ({ success: true }))
  Object.assign(window, { api: { system: { openExternal } } })
})

describe('AntigravityTermsTip', () => {
  it('is one (?) whose content names Google’s terms and telemetry and opens the terms page', async () => {
    const view = render(<AntigravityTermsTip />)
    // Closed, it is the icon alone: no prose in the layout.
    expect(view.container.textContent).toBe('')
    fireEvent.click(screen.getByRole('button', { name: 'About Antigravity’s terms' }))
    expect(screen.getByRole('dialog', { name: 'About Antigravity’s terms' }).textContent)
      .toContain('Antigravity is Google’s software, with its own terms and telemetry.')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Google Antigravity terms' })) })
    expect(openExternal).toHaveBeenCalledWith(ANTIGRAVITY_TERMS_URL)
    expect(screen.queryByText(/Could not open/)).toBeNull()
  })

  it('says in place, with the address, when the shell refused the link', async () => {
    openExternal.mockResolvedValue({ success: false, error: 'open_failed' })
    render(<AntigravityTermsTip />)
    fireEvent.click(screen.getByRole('button', { name: 'About Antigravity’s terms' }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Google Antigravity terms' })) })
    expect(screen.getByText(`Could not open ${ANTIGRAVITY_TERMS_URL}`)).toBeTruthy()
  })
})
