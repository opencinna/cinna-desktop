import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../stores/logger.store', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { MessageBubble } from './MessageBubble'

const TWO_LINES = 'widen it to ["pmp", "pg"] too? - yes ;\nthe IO leg  - leave as is'

describe('MessageBubble line breaks', () => {
  it('keeps a single newline in a user message as a line break', () => {
    const { container } = render(<MessageBubble role="user" content={TWO_LINES} />)
    const paragraph = container.querySelector('p')
    expect(paragraph?.querySelectorAll('br')).toHaveLength(1)
    expect(paragraph?.textContent).toContain('too? - yes ;')
    expect(paragraph?.textContent).toContain('the IO leg')
  })

  it('still renders Markdown in a user message', () => {
    const { container } = render(<MessageBubble role="user" content={'- one\n- two\n\n```\na\nb\n```'} />)
    expect(container.querySelectorAll('li')).toHaveLength(2)
    expect(container.querySelector('pre')?.querySelectorAll('br')).toHaveLength(0)
  })

  it('leaves a lone newline in an assistant message as a soft wrap', () => {
    const { container } = render(<MessageBubble role="assistant" content={'first line\nsecond line'} />)
    expect(container.querySelectorAll('br')).toHaveLength(0)
  })
})
