import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Timed due tokens (Phase 2d) are mobile's data: the read view turns them into
 * chips, but an edit elsewhere in the body must send every token back exactly
 * as written — offsets with and without a colon, zones, seconds, and the forms
 * the desktop does not read. Real `useAutosaveNote`; only the IPC bridge is faked.
 */

const TOKENS = [
  'due:2026-11-20T09:00-05:00[America/New_York]',
  'due:2026-11-21T09:00+0100',
  'due:2026-11-22T07:30:15Z',
  'due:2026-11-23T08:00+25:00[Mars/Olympus_Mons]',
  'due:2026-11-24T09:00[Europe/London]',
  '📅 2026-11-25T09:00'
]
const BODY = TOKENS.map((t, i) => `- [ ] item ${i} ${t}`).join('\n') + '\n\nPlan the week.'

vi.mock('../../stores/ui.store', () => {
  const state = { activeNoteId: 'n1', setNotesTagFilter: vi.fn(), setSidebarTab: vi.fn(), revealSidebar: vi.fn() }
  const useUIStore = (select: (s: typeof state) => unknown): unknown => select(state)
  useUIStore.getState = () => state
  return { useUIStore }
})

const note = { id: 'n1', userId: 'u', title: 'Week', body: BODY, folderId: null, position: 0, deletedAt: null, createdAt: new Date(0), updatedAt: new Date(0) }
const update = vi.fn(async (_id: string, patch: { body?: string }) => ({ ...note, ...patch }))

Object.defineProperty(window, 'api', {
  configurable: true,
  value: { notes: { get: vi.fn(async () => note), update, list: vi.fn(async () => [note]) } }
})

const { NoteDetail } = await import('./NoteDetail')

afterEach(() => update.mockClear())

describe('NoteDetail with timed due tokens', () => {
  it('saves every token byte-identical when another line is edited', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <NoteDetail />
      </QueryClientProvider>
    )
    // Read view: the four read tokens are chips; the unread forms stay as text.
    await waitFor(() => expect(document.querySelectorAll('[data-note-due]')).toHaveLength(4))
    expect(screen.getByText(/due:2026-11-24T09:00\[Europe\/London\]/)).toBeTruthy()

    fireEvent.click(screen.getByText('Plan the week.'))
    const textarea = document.querySelector('textarea')!
    expect(textarea.value).toBe(BODY)

    act(() => {
      fireEvent.change(textarea, { target: { value: BODY.replace('Plan the week.', 'Plan the month.') } })
    })
    act(() => {
      fireEvent.blur(textarea)
    })

    await waitFor(() => expect(update).toHaveBeenCalled())
    const sent = update.mock.calls[0][1].body!
    expect(sent).toBe(BODY.replace('Plan the week.', 'Plan the month.'))
    for (const token of TOKENS) expect(sent).toContain(token)
  })
})
