import { useFileDownloadStore } from '../stores/fileDownload.store'
import type { MessageAttachment } from '../../../shared/attachments'

export interface FileDownloadAPI {
  /** True iff this specific attachment is currently being downloaded. */
  isDownloading: (fileId: string) => boolean
  /** Last error message (decorated with filename). Null when no error. */
  error: string | null
  /** File id the current error belongs to. Bubbles compare against their own
   *  attachments so only the offending bubble renders the label. */
  errorFileId: string | null
  download: (attachment: MessageAttachment) => Promise<void>
  dismissError: () => void
}

/**
 * Thin façade over {@link useFileDownloadStore}. Components stay React-Query
 * style — they subscribe via this hook and never reach into the store
 * directly. The store owns the Set so multiple bubbles share one source of
 * truth; the per-id helper hides the Set details from callers.
 */
export function useFileDownload(): FileDownloadAPI {
  const downloadingIds = useFileDownloadStore((s) => s.downloadingIds)
  const error = useFileDownloadStore((s) => s.error)
  const errorFileId = useFileDownloadStore((s) => s.errorFileId)
  const download = useFileDownloadStore((s) => s.download)
  const dismissError = useFileDownloadStore((s) => s.dismissError)

  return {
    isDownloading: (fileId) => downloadingIds.has(fileId),
    error,
    errorFileId,
    download,
    dismissError
  }
}
