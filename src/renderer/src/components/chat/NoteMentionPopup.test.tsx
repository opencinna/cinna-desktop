import { render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it } from 'vitest'
import type { NoteData } from '../../../../shared/notes'
import { NoteMentionPopup } from './NoteMentionPopup'

const note = (id: string, title: string, body: string): NoteData => ({
  id,
  userId: 'u',
  title,
  body,
  folderId: null,
  position: 0,
  deletedAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0)
})

// jsdom has no layout; the popup scrolls its selected row into view.
beforeAll(() => {
  Element.prototype.scrollIntoView = (): void => {}
})

function show(items: NoteData[]): HTMLElement {
  render(<NoteMentionPopup items={items} selectedIndex={0} onSelect={() => {}} onClose={() => {}} listboxId="notes" />)
  return screen.getByRole('listbox')
}

describe('NoteMentionPopup snippet', () => {
  it('previews the body below the frontmatter, never the YAML', () => {
    const list = show([note('a', 'Tea', '---\nkind: assistant-memory\nsummary: x\n---\n\nPrefers green tea.')])
    expect(list.textContent).toContain('Prefers green tea.')
    expect(list.textContent).not.toContain('kind:')
    expect(list.textContent).not.toContain('---')
  })

  it('caps the snippet at 140 characters after the frontmatter', () => {
    const list = show([note('a', 'Long', `---\ntags: [a]\n---\n${'x'.repeat(200)}`)])
    expect(list.textContent).toContain(`${'x'.repeat(140)}…`)
    expect(list.textContent).not.toContain('x'.repeat(141))
  })

  it('shows no snippet for a note that is only frontmatter', () => {
    const list = show([note('a', 'Empty', '---\nkind: assistant-memory\n---\n  \n')])
    expect(list.textContent).not.toContain('kind')
    expect(list.querySelector('[role="option"]')?.textContent?.trim()).toBe('Empty')
  })
})
