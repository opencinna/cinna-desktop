import { useTaskAttachmentDownloadStore } from '../stores/taskAttachmentDownload.store'

export interface TaskAttachmentDownloadAPI {
  /** True iff this specific attachment is currently being downloaded. */
  isDownloading: (attachmentId: string) => boolean
  /** Last error message (decorated with filename). Null when no error. */
  error: string | null
  /** Attachment id the current error belongs to. */
  errorAttachmentId: string | null
  download: (input: {
    taskId: string
    attachmentId: string
    filename: string
  }) => Promise<void>
  dismissError: () => void
}

/**
 * Thin façade over {@link useTaskAttachmentDownloadStore}, mirroring
 * `useFileDownload`. Components subscribe via this hook and never reach
 * into the store directly. Task attachments use cinna-core's task-scoped
 * download endpoint, which is why this is separate from the standard
 * `useFileDownload` (which targets `FileUpload` rows).
 */
export function useTaskAttachmentDownload(): TaskAttachmentDownloadAPI {
  const downloadingIds = useTaskAttachmentDownloadStore((s) => s.downloadingIds)
  const error = useTaskAttachmentDownloadStore((s) => s.error)
  const errorAttachmentId = useTaskAttachmentDownloadStore((s) => s.errorAttachmentId)
  const download = useTaskAttachmentDownloadStore((s) => s.download)
  const dismissError = useTaskAttachmentDownloadStore((s) => s.dismissError)

  return {
    isDownloading: (id) => downloadingIds.has(id),
    error,
    errorAttachmentId,
    download,
    dismissError
  }
}
