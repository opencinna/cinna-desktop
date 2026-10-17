import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../stores/logger.store', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { MessageBubble } from './MessageBubble'

const REPORT = { id: 'f-1', filename: 'report.pdf', size: 10, mimeType: 'application/pdf', source: 'local' as const }

describe('MessageBubble with files and no text', () => {
  it('shows the files alone, with no empty pill above them', () => {
    const { container } = render(<MessageBubble role="user" content="" attachments={[REPORT]} />)
    expect(screen.getByText('report.pdf')).toBeTruthy()
    expect(container.querySelector('[data-message-markdown]')).toBeNull()
  })

  it('keeps the pill when there is text beside the files', () => {
    const { container } = render(<MessageBubble role="user" content="look" attachments={[REPORT]} />)
    expect(container.querySelector('[data-message-markdown]')).not.toBeNull()
  })
})
