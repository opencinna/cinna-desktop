import { Paperclip, X, Image, FileText, Archive, Loader2 } from 'lucide-react'
import { previewKindFor } from '../../../../shared/filePreview'
import { AttachmentThumbnail } from './AttachmentThumbnail'
import type { ImageRef } from '../../utils/imageDataCache'

/**
 * Visual subset of an attachment the badge needs to render. Carries no
 * lifecycle/source field — consumers either pass a {@link MessageAttachment}
 * or a {@link PendingAttachment}, both of which structurally satisfy this
 * shape. The badge component itself doesn't branch on source.
 */
export interface AttachmentBadgeData {
  id: string
  filename: string
  size: number
  mimeType: string
}

interface AttachmentBadgeProps {
  attachment: AttachmentBadgeData
  /** Optional remove handler — shows the [x] button when supplied. */
  onRemove?: () => void
  /**
   * Click-through handler. When supplied, the badge itself is a button —
   * used for message-variant badges that trigger a save-as download.
   */
  onClick?: () => void
  /** Replace the icon with a spinner; disables click to prevent re-entry. */
  isLoading?: boolean
  /** Compact pill for inside the input area vs. under-bubble display. */
  variant?: 'input' | 'message'
  /**
   * The click opens the in-app preview for a file it can show
   * (`useAttachmentOpen`), so such a badge is named "Preview X" rather than
   * "Download X". Off for a list whose click always downloads.
   */
  previewsOnClick?: boolean
}

function pickIcon(mime: string): React.JSX.Element {
  const size = 12
  if (mime.startsWith('image/')) return <Image size={size} className="shrink-0" />
  if (mime.startsWith('text/') || mime === 'application/json')
    return <FileText size={size} className="shrink-0" />
  if (mime.includes('zip') || mime.includes('tar') || mime.includes('gzip'))
    return <Archive size={size} className="shrink-0" />
  return <Paperclip size={size} className="shrink-0" />
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function truncate(name: string, max = 24): string {
  if (name.length <= max) return name
  const dot = name.lastIndexOf('.')
  if (dot === -1 || name.length - dot > 6) return name.slice(0, max - 1) + '…'
  const ext = name.slice(dot)
  return name.slice(0, max - 1 - ext.length) + '…' + ext
}

/**
 * Compact attachment chip used both inside the composer (before sending) and
 * under sent user messages. Three interaction modes:
 *
 *  - `onRemove` set → trailing [x] removes the pending attachment (input variant)
 *  - `onClick` set → the whole chip is a button; click triggers download
 *    (message variant — opens save-as dialog), or the in-app preview for a
 *    file it can show when `previewsOnClick` — named to match
 *  - neither → static read-only display
 *
 * Both on the input variant (a composer file the preview can show): the name
 * is one button and the [x] a sibling button beside it, never nested.
 */
export function AttachmentBadge({
  attachment,
  onRemove,
  onClick,
  isLoading,
  variant = 'input',
  previewsOnClick = false
}: AttachmentBadgeProps): React.JSX.Element {
  const isInput = variant === 'input'
  const isClickable = !!onClick && !isLoading
  const baseClasses =
    'inline-flex items-center gap-1 rounded-md border max-w-[18rem] ' +
    (isInput
      ? 'pl-1.5 pr-1 py-0.5 text-[11px] bg-[var(--color-bg-secondary)] border-[var(--color-border)] text-[var(--color-text-secondary)]'
      : 'pl-1.5 pr-1.5 py-0.5 text-[10px] bg-[var(--color-bg-secondary)] border-[var(--color-border)] text-[var(--color-text-muted)]') +
    (isClickable
      ? ' cursor-pointer hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)] transition-colors'
      : '')

  // Agent attachments may arrive without a size (`cinna.file_size` omitted) —
  // show nothing rather than a misleading "0 B".
  const hasSize = attachment.size > 0
  const sizeSuffix = hasSize ? ` (${formatSize(attachment.size)})` : ''
  const clickVerb =
    previewsOnClick && previewKindFor(attachment.filename, attachment.mimeType) ? 'Preview' : 'Download'
  const titleText = isClickable
    ? `${clickVerb} ${attachment.filename}${sizeSuffix}`
    : `${attachment.filename}${sizeSuffix}`

  const innerContent = (
    <>
      {isLoading ? (
        <Loader2 size={12} className="shrink-0 animate-spin" />
      ) : (
        pickIcon(attachment.mimeType)
      )}
      <span className="truncate">{truncate(attachment.filename, isInput ? 24 : 22)}</span>
      {!isInput && hasSize && (
        <span className="opacity-70 ml-0.5">{formatSize(attachment.size)}</span>
      )}
      {onRemove && !isClickable && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          className="ml-0.5 p-0.5 rounded hover:bg-[var(--color-bg-hover)]
            text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
          aria-label={`Remove ${attachment.filename}`}
          title={`Remove ${attachment.filename}`}
        >
          <X size={10} />
        </button>
      )}
    </>
  )

  const removeButton = onRemove && (
    <button
      type="button"
      onClick={onRemove}
      className="ml-0.5 p-0.5 rounded hover:bg-[var(--color-bg-hover)]
        text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
      aria-label={`Remove ${attachment.filename}`}
      title={`Remove ${attachment.filename}`}
    >
      <X size={10} />
    </button>
  )

  // A composer file the preview can show: the name opens it, the [x] beside
  // it removes it — two sibling buttons inside one chip.
  if (isClickable && removeButton) {
    return (
      <span
        className={
          'inline-flex items-center rounded-md border max-w-[18rem] pl-1.5 pr-1 py-0.5 text-[11px] ' +
          'bg-[var(--color-bg-secondary)] border-[var(--color-border)] text-[var(--color-text-secondary)]'
        }
      >
        <button
          type="button"
          onClick={onClick}
          title={titleText}
          aria-label={`${clickVerb} ${attachment.filename}`}
          className="inline-flex items-center gap-1 min-w-0 rounded cursor-pointer
            hover:text-[var(--color-text)] transition-colors"
        >
          {innerContent}
        </button>
        {removeButton}
      </span>
    )
  }

  if (isClickable) {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={isLoading}
        title={titleText}
        className={baseClasses}
        aria-label={`${clickVerb} ${attachment.filename}`}
      >
        {innerContent}
      </button>
    )
  }

  return (
    <span title={titleText} className={baseClasses}>
      {innerContent}
    </span>
  )
}

interface AttachmentListProps<T extends AttachmentBadgeData> {
  attachments: T[]
  variant?: 'input' | 'message'
  onRemove?: (id: string) => void
  /** Per-badge click action — typically the download trigger for message variant. */
  onClick?: (attachment: T) => void
  /**
   * Predicate flipping a badge into spinner / disabled state. Predicate form
   * (vs. a single id) lets multiple concurrent downloads each light up.
   */
  isLoading?: (id: string) => boolean
  align?: 'left' | 'right'
  /** See {@link AttachmentBadgeProps.previewsOnClick}. */
  previewsOnClick?: boolean
  /**
   * Whether a badge takes `onClick`; all do when omitted. The composer's
   * badges are clickable only when the preview can show the file.
   */
  canClick?: (attachment: T) => boolean
  /**
   * Where an image's bytes come from. When given, an attachment the preview
   * shows as an image renders as a thumbnail instead of a badge; thumbnails
   * come first.
   */
  thumbnailFor?: (attachment: T) => ImageRef | null
}

/**
 * Generic on the concrete attachment type the caller passes in, so the
 * `onClick` callback sees the same type — e.g. `MessageAttachment` for
 * the message-bubble (and the download store stays narrow), or
 * {@link ComposerAttachment} for the new-chat composer.
 */
export function AttachmentList<T extends AttachmentBadgeData>({
  attachments,
  variant = 'input',
  onRemove,
  onClick,
  isLoading,
  align = 'left',
  previewsOnClick,
  canClick,
  thumbnailFor
}: AttachmentListProps<T>): React.JSX.Element | null {
  if (attachments.length === 0) return null
  const refs = new Map<string, ImageRef>()
  if (thumbnailFor) {
    for (const a of attachments) {
      const ref = previewKindFor(a.filename, a.mimeType) === 'image' ? thumbnailFor(a) : null
      if (ref) refs.set(a.id, ref)
    }
  }
  const badge = (a: T): React.JSX.Element => (
    <AttachmentBadge
      key={a.id}
      attachment={a}
      variant={variant}
      onRemove={onRemove ? () => onRemove(a.id) : undefined}
      onClick={onClick && (canClick?.(a) ?? true) ? () => onClick(a) : undefined}
      isLoading={isLoading ? isLoading(a.id) : false}
      previewsOnClick={previewsOnClick}
    />
  )
  // Thumbnails first, then badges, in one wrap aligned on their bottom edge.
  const ordered = [...attachments.filter((a) => refs.has(a.id)), ...attachments.filter((a) => !refs.has(a.id))]
  return (
    <div
      className={
        'flex flex-wrap items-end gap-1 ' +
        (align === 'right' ? 'justify-end' : 'justify-start')
      }
    >
      {ordered.map((a) => {
        const ref = refs.get(a.id)
        if (!ref) return badge(a)
        return (
          <AttachmentThumbnail
            key={a.id}
            attachment={a}
            imageRef={ref}
            onClick={onClick ? () => onClick(a) : undefined}
            onRemove={onRemove ? () => onRemove(a.id) : undefined}
          />
        )
      })}
    </div>
  )
}

