import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { AgentContribution } from './AgentContribution'

/** jsdom lays nothing out: make every element report `scroll` px of content in `client` px of box. */
function layout(scroll: number, client: number): void {
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(scroll)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(client)
}

afterEach(() => vi.restoreAllMocks())

describe('the ask line', () => {
  it('clamps a long prompt to two lines, with the rest behind Show more, below the text', () => {
    // Mutation: drop `line-clamp-2` → the whole prompt is a wall of text; drop the toggle → no way to read it.
    layout(120, 30)
    render(<AgentContribution parts={[]} askMessage={'Run the command.\n'.repeat(12)} />)
    const ask = screen.getByTestId('agent-ask')
    expect(ask.className).toContain('line-clamp-2')
    // Mutation: `block` beside the clamp → it wins in the built CSS and nothing is clamped.
    expect(ask.classList.contains('block')).toBe(false)
    const toggle = screen.getByRole('button', { name: 'Show more' })
    // Below the text, so opening it moves nothing above.
    expect(ask.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(toggle)
    expect(ask.className).not.toContain('line-clamp-2')
    expect(screen.getByRole('button', { name: 'Show less' }).getAttribute('aria-expanded')).toBe('true')
  })

  it('offers no toggle for a prompt that fits', () => {
    layout(30, 30)
    render(<AgentContribution parts={[]} askMessage="Confirm pg" />)
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull()
  })
})
