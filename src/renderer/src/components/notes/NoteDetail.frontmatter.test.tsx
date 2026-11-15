import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * A memory note's frontmatter is Cinna Assistant's (mobile) data: the desktop
 * edits the body as plain text and must send the frontmatter back exactly as
 * written — unknown keys, odd spacing, quotes, CRLF line endings and all.
 * Real `useAutosaveNote`; only the IPC bridge is faked.
 */

const FRONTMATTER =
  '---\r\nkind:   assistant-memory\r\nx-unknown_key :  "odd \'quoted\' value"  # comment\r\ntags: [ a,b ]\r\n---\r\n'
const BODY = `${FRONTMATTER}Prefers green tea. #drinks\r\n`

const ui = vi.hoisted(() => ({ setNotesTagFilter: vi.fn(), setSidebarTab: vi.fn(), revealSidebar: vi.fn() }))
vi.mock('../../stores/ui.store', () => {
  const state = { activeNoteId: 'm1', ...ui }
  const useUIStore = (select: (s: typeof state) => unknown): unknown => select(state)
  useUIStore.getState = () => state
  return { useUIStore }
})

const note = { id: 'm1', userId: 'u', title: 'Tea', body: BODY, folderId: null, position: 0, deletedAt: null, createdAt: new Date(0), updatedAt: new Date(0) }
const update = vi.fn(async (_id: string, patch: { body?: string }) => ({ ...note, ...patch }))

Object.defineProperty(window, 'api', {
  configurable: true,
  value: { notes: { get: vi.fn(async () => note), update, list: vi.fn(async () => [note]) } }
})

const { NoteDetail } = await import('./NoteDetail')

afterEach(() => update.mockClear())

describe('NoteDetail on a memory note', () => {
  it('keeps the frontmatter byte-identical when the body is edited', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <NoteDetail />
      </QueryClientProvider>
    )
    // The read view: the frontmatter as a card, the tag as a pill.
    await screen.findByTestId('frontmatter')
    expect(document.querySelector('[data-note-tag="drinks"]')?.textContent).toBe('#drinks')

    fireEvent.click(screen.getByText(/Prefers green tea/))
    const textarea = document.querySelector('textarea')!
    // A textarea holds LF only; what it sends back is folded into the stored body.
    const shown = BODY.replace(/\r\n/g, '\n')
    expect(textarea.value).toBe(shown)

    act(() => {
      fireEvent.change(textarea, { target: { value: `${shown}Also oolong.` } })
    })
    act(() => {
      fireEvent.blur(textarea)
    })

    await waitFor(() => expect(update).toHaveBeenCalled())
    const sent = update.mock.calls[0][1].body!
    expect(sent.startsWith(FRONTMATTER)).toBe(true)
    expect(sent).toBe(`${BODY}Also oolong.`)
  })

  it('shows the notes carrying a tag when its pill is clicked, without starting an edit', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <NoteDetail />
      </QueryClientProvider>
    )
    await screen.findByTestId('frontmatter')
    const pill = document.querySelector<HTMLElement>('[data-note-tag="drinks"]')!
    expect(pill.getAttribute('role')).toBe('button')
    fireEvent.click(pill)
    expect(ui.setNotesTagFilter).toHaveBeenCalledWith('drinks')
    expect(ui.setSidebarTab).toHaveBeenCalledWith('notes')
    expect(ui.revealSidebar).toHaveBeenCalledTimes(1)
    expect(document.querySelector('textarea')).toBeNull()

    ui.setNotesTagFilter.mockClear()
    ui.revealSidebar.mockClear()
    fireEvent.keyDown(pill, { key: 'Enter' })
    expect(ui.setNotesTagFilter).toHaveBeenCalledWith('drinks')
    expect(ui.revealSidebar).toHaveBeenCalledTimes(1)
  })
})
