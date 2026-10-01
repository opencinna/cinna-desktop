import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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

const SCAFFOLD = '# Workflow prompt\n\n<!-- This is the agent\'s system prompt.\n     Replace everything below. -->\n\nYou are Alpha. <!-- inline --> Go.\n\n<div>raw</div>'

describe('InlineFileEditor author notes', () => {
  it('keeps a block comment as an author note and drops other raw HTML', () => {
    // The scaffold's comment tells the author what to write; a prompt card
    // that dropped it, as a README viewer does, would hide the one line they
    // most need. Mutation: render prompt cards with `remarkStripHtml` and the
    // note is gone.
    render(<InlineFileEditor editor={editor(SCAFFOLD)} placeholder="" markdown commentNotes />)
    const note = screen.getByRole('note', { name: 'Author note' })
    // Reflowed: single line breaks are the author's editor wrapping.
    expect(note.textContent).toBe("This is the agent's system prompt. Replace everything below.")
    expect(screen.getByText(/You are Alpha\./).textContent).toBe('You are Alpha.  Go.')
    expect(document.body.textContent).not.toContain('raw')
    expect(document.body.textContent).not.toContain('<!--')
  })

  it('drops comments entirely without `commentNotes`', () => {
    render(<InlineFileEditor editor={editor(SCAFFOLD)} placeholder="" markdown />)
    expect(screen.queryByRole('note')).toBeNull()
  })
})

describe('InlineFileEditor clipping', () => {
  const tall = (height: number) =>
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ height } as DOMRect)

  it('clips a long document, reports the overflow, and opens up on edit', () => {
    const spy = tall(1000)
    const onOverflowChange = vi.fn()
    const onEditStart = vi.fn()
    render(<InlineFileEditor editor={editor('long')} placeholder="" markdown clipped onOverflowChange={onOverflowChange} onEditStart={onEditStart} />)
    expect(onOverflowChange).toHaveBeenLastCalledWith(true)
    const clip = screen.getByText('long').closest('.markdown-body') as HTMLElement
    expect(clip.style.maxHeight).toBe('12.1875rem')

    fireEvent.click(screen.getByText('long'))
    expect(onEditStart).toHaveBeenCalled()
    expect(screen.getByRole('textbox')).toBeTruthy()
    spy.mockRestore()
  })

  it('does not clip, or offer to, a document that fits', () => {
    const spy = tall(40)
    const onOverflowChange = vi.fn()
    render(<InlineFileEditor editor={editor('short')} placeholder="" markdown clipped onOverflowChange={onOverflowChange} />)
    expect(onOverflowChange).toHaveBeenLastCalledWith(false)
    const clip = screen.getByText('short').closest('.markdown-body') as HTMLElement
    expect(clip.style.maxHeight).toBe('')
    spy.mockRestore()
  })
})

describe('InlineFileEditor author notes, edge cases', () => {
  it('does not merge two comments and the markup between them into one note', () => {
    render(<InlineFileEditor editor={editor('<!-- a --> <b>x</b> <!-- c -->')} placeholder="" markdown commentNotes />)
    expect(screen.queryByRole('note')).toBeNull()
  })
})

describe('InlineFileEditor card title', () => {
  it('drops a leading heading that repeats the card title, and keeps any other', () => {
    // Mutation: drop `remarkDropTitle` and the first assertion fails.
    const { unmount } = render(<InlineFileEditor editor={editor('# Workflow prompt\n\nBody.')} placeholder="" markdown cardTitle="Workflow prompt" />)
    expect(screen.queryByRole('heading', { name: 'Workflow prompt' })).toBeNull()
    expect(screen.getByText('Body.')).toBeTruthy()
    unmount()
    render(<InlineFileEditor editor={editor('# Something else\n\nBody.')} placeholder="" markdown cardTitle="Workflow prompt" />)
    expect(screen.getByRole('heading', { name: 'Something else' })).toBeTruthy()
  })

  it('puts the caret where the user clicked, not at the end of the file', async () => {
    const source = 'First line.\n\nSecond line here.'
    const text = document.createTextNode('Second line here.')
    document.caretRangeFromPoint = (() => ({ startContainer: text, startOffset: 7 })) as never
    render(<InlineFileEditor editor={editor(source)} placeholder="" markdown />)
    fireEvent.click(screen.getByText('Second line here.'), { clientX: 5, clientY: 5 })
    // Mutation: go back to `el.value.length` and this reads the end of the file.
    const box = screen.getByRole('textbox') as HTMLTextAreaElement
    await waitFor(() => expect(box.selectionStart).toBe(source.indexOf('Second') + 7))
    delete (document as { caretRangeFromPoint?: unknown }).caretRangeFromPoint
  })
})
