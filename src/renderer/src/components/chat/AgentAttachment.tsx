import { X } from 'lucide-react'
import { AttachmentList } from './AttachmentBadge'
import { useFileDownload } from '../../hooks/useFileDownload'
import type { MessagePartFile } from '../../../../shared/messageParts'
import { agentFileToAttachment } from '../../../../shared/attachments'

/**
 * Renders an agent-attached file (A2A `FilePart`, `cinna.content_kind: 'file'`)
 * as a downloadable badge inline in the assistant turn — the mirror of how a
 * user's own attachments render under their message.
 *
 * The badge is built as a `cinna`-sourced {@link MessageAttachment}, so the
 * download routes through the existing Cinna path: `files:download` →
 * `cinnaFileService.downloadToPath` → `GET /api/v1/files/{fileId}/download`
 * with the user's OAuth bearer token (no signed `?token=` URL). Lifecycle is
 * tied to the user's revocable session, not a standalone 1h grant.
 *
 * The download state is shared via {@link useFileDownload}; this component only
 * surfaces the error label for its own file (matching `errorFileId`).
 */
export function AgentAttachment({
  file,
  align = 'left'
}: {
  file: MessagePartFile
  align?: 'left' | 'right'
}): React.JSX.Element {
  const { isDownloading, download, error, errorFileId, dismissError } = useFileDownload()
  const attachment = agentFileToAttachment(file)
  const errorForThisFile = error && errorFileId === file.fileId ? error : null

  return (
    <div className="flex flex-col gap-1">
      <AttachmentList
        attachments={[attachment]}
        variant="message"
        align={align}
        onClick={(a) => void download(a)}
        isLoading={isDownloading}
      />
      {errorForThisFile && (
        <div
          className={
            'flex items-center gap-1 text-[10px] text-[var(--color-danger)] ' +
            (align === 'right' ? 'justify-end' : 'justify-start')
          }
        >
          <span className="truncate">{errorForThisFile}</span>
          <button
            type="button"
            onClick={dismissError}
            className="p-0.5 rounded hover:bg-[var(--color-bg-hover)] shrink-0"
            aria-label="Dismiss download error"
          >
            <X size={10} />
          </button>
        </div>
      )}
    </div>
  )
}
