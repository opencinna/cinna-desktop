import { create } from 'zustand'
import type { MessageAttachment } from '../../../shared/attachments'

interface FileDownloadStore {
  /**
   * File ids currently being downloaded. Held as a Set so multiple concurrent
   * downloads from different bubbles (or the same bubble) each tick their own
   * spinner without racing on a single `downloadingId` cell.
   */
  downloadingIds: ReadonlySet<string>
  /**
   * Last error from any download — the message includes the filename so the
   * user knows which click failed.
   */
  error: string | null
  /**
   * File id whose download produced {@link error}. Used by `MessageBubble` to
   * decide whether to render the error label — only the bubble holding the
   * failed badge surfaces it, so an error in chat A doesn't bleed into
   * every other bubble that happens to be on screen.
   */
  errorFileId: string | null
  download: (attachment: MessageAttachment) => Promise<void>
  dismissError: () => void
}

/**
 * Global download state. Replaces the per-bubble `useState` previously held
 * by `useFileDownload`, so:
 *
 *  - Multiple bubbles share one source of truth (no duplicated state per
 *    rendered message).
 *  - Two clicks on different badges in the same bubble each spin
 *    independently (each id has its own membership in the Set).
 *  - A future "downloads in progress" indicator can subscribe directly.
 */
export const useFileDownloadStore = create<FileDownloadStore>((set, get) => ({
  downloadingIds: new Set<string>(),
  error: null,
  errorFileId: null,
  download: async (attachment) => {
    const { downloadingIds, errorFileId } = get()
    if (downloadingIds.has(attachment.id)) return
    set({
      downloadingIds: new Set([...downloadingIds, attachment.id]),
      // Clear a stale error for this same file (user retrying) but leave
      // errors for other files alone — they belong to their own bubbles.
      error: errorFileId === attachment.id ? null : get().error,
      errorFileId: errorFileId === attachment.id ? null : get().errorFileId
    })
    try {
      const result = await window.api.files.download({
        fileId: attachment.id,
        filename: attachment.filename
      })
      if (!result.success) {
        set({
          error: `Couldn't download ${attachment.filename}: ${result.error}`,
          errorFileId: attachment.id
        })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set({
        error: `Couldn't download ${attachment.filename}: ${msg}`,
        errorFileId: attachment.id
      })
    } finally {
      const next = new Set(get().downloadingIds)
      next.delete(attachment.id)
      set({ downloadingIds: next })
    }
  },
  dismissError: () => set({ error: null, errorFileId: null })
}))
