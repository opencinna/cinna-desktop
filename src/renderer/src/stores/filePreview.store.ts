import { create } from 'zustand'
import type { PreviewRenderKind } from '../../../shared/filePreview'
import type { MessageAttachment } from '../../../shared/attachments'

/**
 * Drives the single global {@link FilePreviewModal}. A badge click for a
 * previewable text attachment calls {@link openPreview}; the store fetches the
 * content over `files:read-preview` and the modal (mounted once at the app
 * root) renders it. Only one preview is open at a time — opening a second
 * replaces the first.
 *
 * The download action is intentionally NOT here — the modal's Download button
 * reuses the existing `useFileDownloadStore` so there's one source of truth for
 * the save-as flow.
 */
interface FilePreviewState {
  /** The attachment being previewed, or null when the modal is closed. */
  attachment: MessageAttachment | null
  /** How the modal should render the text (decided at open time). */
  kind: PreviewRenderKind | null
  text: string
  /** True while the content fetch is in flight. */
  isLoading: boolean
  /** True when the file exceeded the byte cap and only a prefix is shown. */
  truncated: boolean
  error: string | null
  /** Monotonic token guarding against a stale fetch resolving after the user
   *  reopened a different file. */
  requestId: number
  openPreview: (attachment: MessageAttachment, kind: PreviewRenderKind) => Promise<void>
  close: () => void
}

export const useFilePreviewStore = create<FilePreviewState>((set, get) => ({
  attachment: null,
  kind: null,
  text: '',
  isLoading: false,
  truncated: false,
  error: null,
  requestId: 0,
  openPreview: async (attachment, kind) => {
    const requestId = get().requestId + 1
    set({
      attachment,
      kind,
      text: '',
      isLoading: true,
      truncated: false,
      error: null,
      requestId
    })
    try {
      const result = await window.api.files.readPreview({
        fileId: attachment.id,
        source: attachment.source ?? 'cinna'
      })
      // A newer open (or a close) happened while we were fetching — drop this
      // result so we don't clobber the current modal.
      if (get().requestId !== requestId) return
      if (result.success) {
        set({ text: result.text, truncated: result.truncated, isLoading: false })
      } else {
        set({ error: result.error, isLoading: false })
      }
    } catch (err) {
      if (get().requestId !== requestId) return
      set({ error: err instanceof Error ? err.message : String(err), isLoading: false })
    }
  },
  close: () =>
    set((s) => ({
      attachment: null,
      kind: null,
      text: '',
      isLoading: false,
      truncated: false,
      error: null,
      // Bump so any in-flight fetch from the closed preview is discarded.
      requestId: s.requestId + 1
    }))
}))
