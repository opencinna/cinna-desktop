import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { NoticeBlock } from './NoticeBlock'

/**
 * A warning notice (a provider error, a turn gone silent) is one expanded row
 * in the warning colour with a triangle, live and persisted alike — never the
 * collapsed dot an info notice folds to in compact mode.
 */
describe('NoticeBlock tone', () => {
  it('draws a persisted warning expanded in compact mode, with no toggle', () => {
    // Mutation: drop the `tone === 'warning'` branch → the collapsed "Show agent notice" dot.
    const { container } = render(<NoticeBlock content="Gemini answered an error (503)." tone="warning" defaultExpanded={false} />)
    const row = container.querySelector('[data-notice-tone="warning"]') as HTMLElement
    expect(row).toBeTruthy()
    expect(row.textContent).toBe('Gemini answered an error (503).')
    expect(row.className).toContain('text-[var(--color-severity-warning-text)]')
    expect(row.className).not.toContain('text-muted')
    expect(row.querySelector('svg.lucide-triangle-alert, svg.lucide-alert-triangle')).toBeTruthy()
    expect(row.querySelector('svg.lucide-info')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('draws the live warning as the same row, adding the Stop hint only while live', () => {
    // Mutation: drop the `live &&` guard on the hint → the saved row still says "Stop ends the turn."
    const { container } = render(<NoticeBlock content="No reply yet." tone="warning" live />)
    const row = container.querySelector('[data-notice-tone="warning"]') as HTMLElement
    expect(row.textContent).toBe('No reply yet. Stop ends the turn.')
    expect(row.getAttribute('role')).toBeNull()
    const persisted = render(<NoticeBlock content="No reply yet." tone="warning" />).container.querySelector('[data-notice-tone="warning"]') as HTMLElement
    expect(persisted.textContent).toBe('No reply yet.')
    // No jump between the live and the saved form.
    expect(persisted.className).toBe(row.className)
  })

  it('colours the triangle like the composer warning, the text with the severity text token', () => {
    const { container } = render(<NoticeBlock content="x" tone="warning" />)
    expect(container.querySelector('svg')!.getAttribute('class')).toContain('text-[var(--color-warning)]')
  })

  it('keeps an info notice as it was: collapsed to the dot in compact mode', () => {
    const { container } = render(<NoticeBlock content="Starting up" />)
    expect(screen.getByRole('button', { name: 'Show agent notice' })).toBeTruthy()
    expect(container.querySelector('[data-notice-tone]')).toBeNull()
  })
})
