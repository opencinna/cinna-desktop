import { create } from 'zustand'
import { createLogger } from './logger.store'

const logger = createLogger('task-attachment-download')

interface DownloadInput {
  taskId: string
  attachmentId: string
  filename: string
}

interface TaskAttachmentDownloadStore {
  /** Attachment ids currently being downloaded. */
  downloadingIds: ReadonlySet<string>
  /** Last error message — decorated with the filename. */
  error: string | null
  /** Attachment id the current error belongs to (so only the right badge shows it). */
  errorAttachmentId: string | null
  download: (input: DownloadInput) => Promise<void>
  dismissError: () => void
}

/**
 * Global state for `TaskAttachment` downloads. Mirrors `fileDownloadStore`
 * but hits the task-scoped endpoint (the task attachments are not
 * `FileUpload` rows — they live under cinna-core's `/api/v1/tasks/{id}/
 * attachments/...` namespace, see workflow-runner-core docs).
 *
 * Holds `downloadingIds` as a Set so multiple concurrent downloads each
 * tick their own spinner.
 */
export const useTaskAttachmentDownloadStore = create<TaskAttachmentDownloadStore>(
  (set, get) => ({
    downloadingIds: new Set<string>(),
    error: null,
    errorAttachmentId: null,
    download: async ({ taskId, attachmentId, filename }) => {
      const { downloadingIds, errorAttachmentId } = get()
      if (downloadingIds.has(attachmentId)) return
      set({
        downloadingIds: new Set([...downloadingIds, attachmentId]),
        // Clear a stale error for this same attachment (user retrying) but
        // leave others alone.
        error: errorAttachmentId === attachmentId ? null : get().error,
        errorAttachmentId:
          errorAttachmentId === attachmentId ? null : get().errorAttachmentId
      })
      try {
        const result = await window.api.files.downloadTaskAttachment({
          taskId,
          attachmentId,
          filename
        })
        if (!result.success) {
          logger.warn('task attachment download failed', {
            taskId,
            attachmentId,
            filename,
            error: result.error,
            code: result.code
          })
          set({
            error: `Couldn't download ${filename}: ${result.error}`,
            errorAttachmentId: attachmentId
          })
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error('task attachment download threw', {
          taskId,
          attachmentId,
          filename,
          error: msg
        })
        set({
          error: `Couldn't download ${filename}: ${msg}`,
          errorAttachmentId: attachmentId
        })
      } finally {
        const next = new Set(get().downloadingIds)
        next.delete(attachmentId)
        set({ downloadingIds: next })
      }
    },
    dismissError: () => set({ error: null, errorAttachmentId: null })
  })
)
