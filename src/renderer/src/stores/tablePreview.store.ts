import { create } from 'zustand'

/**
 * Drives the single global `TablePreviewModal`: a table out of a chat
 * message (a markdown table or a code block that reads as one), opened from
 * its "Table actions" menu. Held here rather than in the bubble, so the
 * modal survives the bubble re-rendering or unmounting under it.
 */
interface TablePreviewState {
  /** The table, first row the header; null while closed. */
  rows: string[][] | null
  /** Bumped on every open, so filters never carry over between tables. */
  openSeq: number
  /** What focus goes back to on close, when it is still in the page. */
  returnFocus: HTMLElement | null
  open: (rows: string[][], returnFocus?: HTMLElement | null) => void
  close: () => void
}

export const useTablePreviewStore = create<TablePreviewState>((set, get) => ({
  rows: null,
  openSeq: 0,
  returnFocus: null,
  open: (rows, returnFocus = null) => set((s) => ({ rows, returnFocus, openSeq: s.openSeq + 1 })),
  close: () => {
    const { rows, returnFocus } = get()
    if (rows === null) return
    set({ rows: null, returnFocus: null })
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true })
  }
}))
