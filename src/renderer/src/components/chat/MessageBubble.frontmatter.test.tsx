import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../stores/logger.store', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { MessageBubble } from './MessageBubble'

const SPEC = '---\nname: forecast\nsource: https://example.com/spec\n---\n\n# Spec\n\nBody.'

describe('MessageBubble frontmatter', () => {
  it.each(['assistant', 'user'] as const)('shows a %s message frontmatter as a card, not a heading', (role) => {
    const { container } = render(<MessageBubble role={role} content={SPEC} />)
    const card = screen.getByTestId('frontmatter')
    expect(card.querySelector('dt')?.textContent).toBe('name')
    expect(screen.getByRole('link', { name: 'https://example.com/spec' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Spec' })).toBeTruthy()
    expect(container.querySelector('hr')).toBeNull()
    // Copy text / Save to Notes still take the message as written.
    expect(container.querySelector('[data-message-markdown]')?.getAttribute('data-message-markdown')).toBe(SPEC)
  })

  it('leaves a message without frontmatter alone', () => {
    render(<MessageBubble role="assistant" content={'---\n\nJust a rule above.'} />)
    expect(screen.queryByTestId('frontmatter')).toBeNull()
  })
})
