import { render, screen, fireEvent } from '@testing-library/react'
import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'

/**
 * The pure half of the composer's readiness refusal: which typed text is a
 * catalog `/run:` (main's grammar, not a looser one), and the example prompts
 * that go dim and inert while their agent is refused — without remounting.
 */

;(window as unknown as { api: unknown }).api = {}

const { isCatalogCommand, RefusableExamplePrompts } = await import('./ComposerReadiness')

const folder = { capabilities: { commands: 'catalog' } } as never
const remote = { capabilities: { commands: 'card' } } as never
const DOWN = {
  state: 'unreachable',
  reason: 'Could not reach the agent.',
  detail: 'ECONNREFUSED'
} as never

describe('isCatalogCommand', () => {
  it('matches a bare /run:<name> to a folder agent, surrounding space ignored', () => {
    expect(isCatalogCommand(folder, '/run:check')).toBe(true)
    expect(isCatalogCommand(folder, '  /run:status_refresh-2 ')).toBe(true)
  })

  it('does not match what main would hand to the engine instead', () => {
    for (const typed of ['/run:', '/run: check', '/run:check now', 'run:check', '/run:-x', 'x /run:check']) {
      expect(isCatalogCommand(folder, typed)).toBe(false)
    }
  })

  it('does not match for an agent whose commands are not a folder catalog', () => {
    expect(isCatalogCommand(remote, '/run:check')).toBe(false)
    expect(isCatalogCommand(null, '/run:check')).toBe(false)
  })
})

describe('RefusableExamplePrompts', () => {
  function gate(refusal: unknown, onSelect: () => void = vi.fn()): React.JSX.Element {
    return createElement(RefusableExamplePrompts, {
      refusal: refusal as never,
      children: createElement('button', { type: 'button', onClick: onSelect }, 'Summarise invoices')
    })
  }

  it('dims the prompts, makes them inert and says why while refused', () => {
    const { container } = render(gate(DOWN))
    const outer = container.firstElementChild as HTMLElement
    const inner = outer.firstElementChild as HTMLElement
    expect(outer.getAttribute('title')).toBe('ECONNREFUSED')
    expect(outer.getAttribute('aria-disabled')).toBe('true')
    expect(inner.hasAttribute('inert')).toBe(true)
    expect(inner.className).toContain('opacity-50')
  })

  it('leaves them live and unmarked when nothing is refused', () => {
    const onSelect = vi.fn()
    const { container } = render(gate(null, onSelect))
    const outer = container.firstElementChild as HTMLElement
    expect(outer.hasAttribute('title')).toBe(false)
    expect((outer.firstElementChild as HTMLElement).hasAttribute('inert')).toBe(false)
    fireEvent.click(screen.getByText('Summarise invoices'))
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it('keeps the same prompts mounted when a refusal arrives and clears', () => {
    const { rerender } = render(gate(null))
    const before = screen.getByText('Summarise invoices')
    rerender(gate(DOWN))
    expect(screen.getByText('Summarise invoices')).toBe(before)
    rerender(gate(null))
    expect(screen.getByText('Summarise invoices')).toBe(before)
  })
})
