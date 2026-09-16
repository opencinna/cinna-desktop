import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NoteItem } from './NoteItem'
import { NotesDragContext } from './dragContext'
import { useUIStore } from '../../stores/ui.store'

vi.hoisted(() => { window.api = { app: { setTheme: async () => {} } } as never })
const note = { id: 'note-1', title: 'Saved excerpt', body: '', folderId: null } as never
const scrollIntoView = vi.fn()

beforeEach(() => {
  scrollIntoView.mockReset()
  Element.prototype.scrollIntoView = scrollIntoView
  useUIStore.setState({ activeView: 'chat', activeNoteId: null, revealNoteId: null })
})
afterEach(() => { delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView })

function mount() {
  const client = new QueryClient()
  return render(
    <QueryClientProvider client={client}>
      <NotesDragContext.Provider value={{ drag: null, setDrag: () => {} }}><NoteItem note={note} /></NotesDragContext.Provider>
    </QueryClientProvider>
  )
}

it('brings the row into view once when its note is opened from outside the list', () => {
  mount()
  act(() => useUIStore.setState({ activeView: 'note-detail', activeNoteId: 'note-1', revealNoteId: 'note-1' }))
  expect(scrollIntoView).toHaveBeenCalledTimes(1)
  expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
  expect(useUIStore.getState().revealNoteId).toBeNull()
})

it('brings the row into view when it first renders after the request, as a refetched list does', () => {
  useUIStore.setState({ activeView: 'note-detail', activeNoteId: 'note-1', revealNoteId: 'note-1' })
  mount()
  expect(scrollIntoView).toHaveBeenCalledTimes(1)
})

it('does not scroll when the active row remounts in a re-expanded folder or is clicked', () => {
  useUIStore.setState({ activeView: 'note-detail', activeNoteId: 'note-1', revealNoteId: 'note-1' })
  mount().unmount()
  mount()
  expect(scrollIntoView).toHaveBeenCalledTimes(1)
  act(() => useUIStore.setState({ activeNoteId: null }))
  act(() => useUIStore.setState({ activeNoteId: 'note-1' }))
  expect(scrollIntoView).toHaveBeenCalledTimes(1)
})
