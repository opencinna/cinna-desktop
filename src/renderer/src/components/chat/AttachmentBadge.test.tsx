import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../stores/logger.store', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { AttachmentList } from './AttachmentBadge'
import { AgentAttachment } from './AgentAttachment'

/** A badge is named for what its click does: the in-app preview, or a download. */

const files = [
  { id: 'a', filename: 'notes.md', size: 10, mimeType: 'text/markdown' },
  { id: 'b', filename: 'report.html', size: 10, mimeType: 'text/html' },
  { id: 'c', filename: 'archive.zip', size: 10, mimeType: 'application/zip' },
  // Named by its MIME type only.
  { id: 'd', filename: 'data', size: 10, mimeType: 'application/json' }
]

const names = (): string[] => screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? '')

describe('attachment badge names', () => {
  it('say Preview for a file the click previews, and Download for the rest', () => {
    render(<AttachmentList attachments={files} variant="message" onClick={() => {}} previewsOnClick />)
    expect(names()).toEqual(['Preview notes.md', 'Preview report.html', 'Download archive.zip', 'Preview data'])
    expect(screen.getByRole('button', { name: 'Preview notes.md' }).getAttribute('title')).toBe('Preview notes.md (10 B)')
    expect(screen.getByRole('button', { name: 'Download archive.zip' }).getAttribute('title')).toBe(
      'Download archive.zip (10 B)'
    )
  })

  it('say Download for every file in a list whose click always downloads', () => {
    render(<AttachmentList attachments={files} variant="message" onClick={() => {}} />)
    expect(names()).toEqual(['Download notes.md', 'Download report.html', 'Download archive.zip', 'Download data'])
  })

  it("follow an agent's attachment the same way", () => {
    render(<AgentAttachment file={{ fileId: 'f1', filename: 'feed.xml', mimeType: 'application/xml', size: 0 }} />)
    expect(screen.getByRole('button', { name: 'Preview feed.xml' })).toBeTruthy()
  })
})
