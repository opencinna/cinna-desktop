import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteData, NoteFolderData } from '../../../../shared/notes'
import { useUIStore } from '../../stores/ui.store'

/**
 * The Notes list reads the body format Cinna Assistant (mobile) writes:
 * memory notes (`kind: assistant-memory`) sit in their own section, and the
 * tags of the regular notes offer a filter. Real hooks; only IPC is faked.
 */

const state = vi.hoisted(() => ({ notes: [] as unknown[], folders: [] as unknown[] }))
vi.hoisted(() => {
  window.api = {
    app: { setTheme: async () => {} },
    notes: { list: async () => state.notes, create: async () => new Promise(() => {}) },
    noteFolders: { list: async () => state.folders, create: async () => new Promise(() => {}) }
  } as never
})

const { NotesList } = await import('./NotesList')

let seq = 0
function note(title: string, body: string, folderId: string | null = null): NoteData {
  seq++
  return { id: `n${seq}`, userId: 'u', title, body, folderId, position: seq, deletedAt: null, createdAt: new Date(0), updatedAt: new Date(0) }
}
const folder = (id: string, name: string): NoteFolderData => ({ id, userId: 'u', name, position: 0, collapsed: false, createdAt: new Date(0), updatedAt: new Date(0) })
const MEMORY = (text: string): string => `---\nkind: assistant-memory\n---\n${text}`

function mountWith(): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <NotesList />
    </QueryClientProvider>
  )
  return client
}
const mount = (): void => void mountWith()

beforeEach(() => {
  seq = 0
  state.notes = []
  state.folders = []
  useUIStore.setState({ activeView: 'chat', activeNoteId: null, revealNoteId: null, notesTagFilter: null })
})

describe('NotesList Assistant memory', () => {
  it('lists memory notes only under a collapsed "Assistant memory" row that expands', async () => {
    state.folders = [folder('f1', 'Work')]
    state.notes = [note('Plan', 'x', 'f1'), note('Groceries', 'milk'), note('Tea', MEMORY('Likes green tea')), note('Desk', MEMORY('Standing desk'))]
    mount()
    await screen.findByText('Groceries')
    expect(screen.getByText('Plan')).toBeTruthy()
    const section = screen.getByRole('button', { name: /Assistant memory/ })
    expect(section.getAttribute('aria-expanded')).toBe('false')
    expect(section.textContent).toContain('2')
    expect(screen.queryByText('Tea')).toBeNull()
    expect(screen.queryByText('Desk')).toBeNull()

    fireEvent.click(section)
    expect(section.getAttribute('aria-expanded')).toBe('true')
    const tea = screen.getByText('Tea').closest('[draggable]') as HTMLElement
    expect(tea.getAttribute('draggable')).toBe('false')
    expect(screen.getByText('Groceries').closest('[draggable]')?.getAttribute('draggable')).toBe('true')

    fireEvent.click(screen.getByText('Tea'))
    expect(useUIStore.getState().activeNoteId).toBe('n3')
  })

  it('has no memory section without memory notes', async () => {
    state.notes = [note('Groceries', 'milk')]
    mount()
    await screen.findByText('Groceries')
    expect(screen.queryByRole('button', { name: /Assistant memory/ })).toBeNull()
  })
})

describe('NotesList tag filter', () => {
  it('offers no filter while no regular note has a tag', async () => {
    state.notes = [note('Groceries', 'milk'), note('Tea', MEMORY('#drinks'))]
    mount()
    await screen.findByText('Groceries')
    expect(screen.queryByRole('button', { name: 'Filter by tag' })).toBeNull()
  })

  it('filters by a parent tag, lists matches flat, and clears', async () => {
    state.folders = [folder('f1', 'Work')]
    state.notes = [
      note('Reading', 'Later #inbox/to-read', 'f1'),
      note('Bills', 'Pay #bills'),
      note('Inbox', '---\ntags: [inbox]\n---\nbody'),
      note('Tea', MEMORY('#inbox'))
    ]
    mount()
    await screen.findByText('Bills')
    fireEvent.click(screen.getByRole('button', { name: 'Filter by tag' }))
    const menu = screen.getByRole('menu', { name: 'Tags' })
    const items = within(menu).getAllByRole('menuitemradio').map((i) => i.textContent)
    // Memory notes' tags are not offered; the parent counts its nested tag's note.
    expect(items).toEqual(['All notes', '#bills1', '#inbox2', 'to-read1'])
    expect(within(menu).getByRole('menuitemradio', { name: 'to-read1' }).getAttribute('title')).toBe('#inbox/to-read')

    fireEvent.click(within(menu).getByRole('menuitemradio', { name: /#inbox2/ }))
    expect(screen.queryByRole('menu', { name: 'Tags' })).toBeNull()
    expect(useUIStore.getState().notesTagFilter).toBe('inbox')
    expect(screen.getByText('Reading')).toBeTruthy()
    expect(screen.getByText('Inbox')).toBeTruthy()
    expect(screen.queryByText('Bills')).toBeNull()
    expect(screen.queryByText('Work')).toBeNull()
    expect(screen.queryByRole('button', { name: /Assistant memory/ })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Clear tag filter' }))
    expect(useUIStore.getState().notesTagFilter).toBeNull()
    expect(screen.getByText('Bills')).toBeTruthy()
    expect(screen.getByText('Work')).toBeTruthy()
  })

  it('colours the filter button by state alone', async () => {
    state.notes = [note('Bills', 'Pay #bills')]
    mount()
    await screen.findByText('Bills')
    const button = screen.getByRole('button', { name: 'Filter by tag' })
    expect(button.className).toContain('--color-text-muted')
    act(() => useUIStore.setState({ notesTagFilter: 'bills' }))
    expect(button.className).toContain('--color-accent')
    expect(button.className).not.toContain('--color-text-muted')
  })

  it('moves between the menu items with the arrow keys', async () => {
    state.notes = [note('Bills', 'Pay #bills')]
    mount()
    await screen.findByText('Bills')
    fireEvent.click(screen.getByRole('button', { name: 'Filter by tag' }))
    const items = within(screen.getByRole('menu', { name: 'Tags' })).getAllByRole('menuitemradio')
    fireEvent.keyDown(window, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(items[0])
    fireEvent.keyDown(window, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(items[1])
    fireEvent.keyDown(window, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(items[0])
  })

  it('keeps the open note listed after its tag is edited away, until it is left', async () => {
    const bills = note('Bills', 'Pay #bills')
    const other = note('Other', 'Pay #bills too')
    state.notes = [bills, other]
    useUIStore.setState({ notesTagFilter: 'bills', activeView: 'note-detail', activeNoteId: bills.id })
    const client = mountWith()
    await screen.findByText('Bills')
    state.notes = [{ ...bills, body: 'Pay' }, other]
    await act(async () => {
      await client.refetchQueries({ queryKey: ['notes'], exact: true })
    })
    expect((client.getQueryData(['notes']) as NoteData[])[0].body).toBe('Pay')
    // Let the list render the refetched notes.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(screen.getByText('Bills')).toBeTruthy()
    act(() => useUIStore.setState({ activeNoteId: other.id }))
    expect(screen.queryByText('Bills')).toBeNull()
  })

  it('does not add an open note that never matched', async () => {
    const plain = note('Plain', 'no tags')
    state.notes = [plain, note('Bills', 'Pay #bills')]
    useUIStore.setState({ notesTagFilter: 'bills', activeView: 'note-detail', activeNoteId: plain.id })
    mount()
    await screen.findByText('Bills')
    expect(screen.queryByText('Plain')).toBeNull()
  })

  it('clears the filter when a note or folder is created, so the new row is in view', async () => {
    state.notes = [note('Bills', 'Pay #bills')]
    useUIStore.setState({ notesTagFilter: 'bills' })
    mount()
    await screen.findByText('Bills')
    fireEvent.click(screen.getByTitle('New note'))
    expect(useUIStore.getState().notesTagFilter).toBeNull()
    act(() => useUIStore.setState({ notesTagFilter: 'bills' }))
    fireEvent.click(screen.getByTitle('New folder'))
    expect(useUIStore.getState().notesTagFilter).toBeNull()
  })

  it('says so when no note carries the active tag', async () => {
    state.notes = [note('Bills', 'Pay #bills')]
    useUIStore.setState({ notesTagFilter: 'gone' })
    mount()
    expect(await screen.findByText('No notes tagged #gone')).toBeTruthy()
  })
})
