import { useFileDownloadStore } from '../stores/fileDownload.store'
import { useFilePreviewStore } from '../stores/filePreview.store'
import { previewKindFor } from '../../../shared/filePreview'
import type { MessageAttachment } from '../../../shared/attachments'

/**
 * Click action for a sent attachment badge. Supported text formats (txt, csv,
 * md, json, yaml) open the in-app {@link FilePreviewModal}; everything else
 * falls through to the existing save-as download. Used by both user-message
 * badges and agent-attachment badges so they behave identically.
 */
export function useAttachmentOpen(): (attachment: MessageAttachment) => void {
  const download = useFileDownloadStore((s) => s.download)
  const openPreview = useFilePreviewStore((s) => s.openPreview)
  return (attachment) => {
    const kind = previewKindFor(attachment.filename, attachment.mimeType)
    if (kind) void openPreview(attachment, kind)
    else void download(attachment)
  }
}
