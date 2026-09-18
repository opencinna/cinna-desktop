import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const BODY = '---\nsource: https://example.com/ticket\n---\n# Plan\n\nShip it.'

vi.mock('../../stores/ui.store', () => ({
  useUIStore: (select: (s: { activeNoteId: string }) => unknown) => select({ activeNoteId: 'n1' })
}))
vi.mock('../../hooks/useNotes', async () => {
  const { useState } = await import('react')
  return {
    FALLBACK_TITLE: 'Untitled note',
    useNote: () => ({ data: { id: 'n1', title: 'Plan', body: BODY }, isLoading: false }),
    useAutosaveNote: () => {
      const [body, setBody] = useState(BODY)
      return { title: 'Plan', body, setTitle: () => {}, setBody, flushNow: () => {} }
    }
  }
})

import { NoteDetail } from './NoteDetail'

describe('NoteDetail frontmatter', () => {
  it('renders frontmatter as a card, and a link in it opens without starting an edit', () => {
    render(<NoteDetail />)
    expect(screen.getByTestId('frontmatter').querySelector('dt')?.textContent).toBe('source')
    expect(screen.getByRole('heading', { name: 'Plan' })).toBeTruthy()

    fireEvent.click(screen.getByRole('link', { name: 'https://example.com/ticket' }))
    expect(document.querySelector('textarea')).toBeNull()

    // The textarea holds the note as written, frontmatter included.
    fireEvent.click(screen.getByText('Ship it.'))
    expect(document.querySelector('textarea')?.value).toBe(BODY)
  })
})
