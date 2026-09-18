import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { AgentFileEditor } from '../../../hooks/useLocalAgents'
import { InlineFileEditor } from './InlineFileEditor'

const editor = (text: string): AgentFileEditor => ({
  text,
  setText: vi.fn(),
  flushNow: vi.fn(),
  canSave: true,
  isSaving: false,
  conflict: null,
  blocked: false,
  diskText: null,
  reload: vi.fn(),
  error: null
})

const AGENT_MD = '---\nname: alpha\nrepo: https://example.com/alpha\n---\n# Alpha\n\nWatches the feed.'

describe('InlineFileEditor frontmatter', () => {
  it('renders a file’s frontmatter as a card above the document', () => {
    render(<InlineFileEditor editor={editor(AGENT_MD)} placeholder="" markdown />)
    expect(screen.getByTestId('frontmatter').querySelector('dt')?.textContent).toBe('name')
    expect(screen.getByRole('heading', { name: 'Alpha' })).toBeTruthy()
    expect(document.querySelector('.markdown-body hr')).toBeNull()
  })

  it('opens a link without starting an edit, and a click elsewhere still edits', () => {
    render(<InlineFileEditor editor={editor(AGENT_MD)} placeholder="" markdown />)
    fireEvent.click(screen.getByRole('link', { name: 'https://example.com/alpha' }))
    expect(screen.queryByRole('textbox')).toBeNull()

    fireEvent.click(screen.getByText('Watches the feed.'))
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(AGENT_MD)
  })
})
