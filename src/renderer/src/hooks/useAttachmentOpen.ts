import { useFileDownloadStore } from '../stores/fileDownload.store'
import { useFilePreviewStore } from '../stores/filePreview.store'
import { previewKindFor } from '../../../shared/filePreview'
import type { ComposerAttachment, MessageAttachment } from '../../../shared/attachments'

/**
 * Click action for a sent attachment badge. Supported text formats (txt, csv,
 * md, json, yaml…) and images open the in-app {@link FilePreviewModal}; everything else
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

/**
 * Click action for a composer badge or thumbnail: the preview, never a
 * download (the file is the user's own and not sent yet). A new chat's file
 * is read by its path; an ingested one as an attachment, with no Download in
 * the modal. A file the preview cannot show is not clickable at all
 * ({@link composerCanPreview}).
 */
export function useComposerAttachmentOpen(): (attachment: ComposerAttachment) => void {
  const openPreview = useFilePreviewStore((s) => s.openPreview)
  const openPathPreview = useFilePreviewStore((s) => s.openPathPreview)
  return (attachment) => {
    const kind = previewKindFor(attachment.filename, attachment.mimeType)
    if (!kind) return
    if (attachment.source === 'pending') {
      void openPathPreview({ path: attachment.id, filename: attachment.filename, mimeType: attachment.mimeType }, kind)
    } else {
      void openPreview(attachment, kind, { composer: true })
    }
  }
}

export function composerCanPreview(attachment: ComposerAttachment): boolean {
  return previewKindFor(attachment.filename, attachment.mimeType) !== null
}
