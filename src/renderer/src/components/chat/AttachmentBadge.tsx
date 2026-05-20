import { Paperclip, X, Image, FileText, Archive, Loader2 } from 'lucide-react'

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

function formatSize(bytes: number): string {
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
 *    (message variant — opens save-as dialog)
 *  - neither → static read-only display
 *
 * `onRemove` and `onClick` are mutually exclusive at the call site — input
 * badges remove, message badges download.
 */
export function AttachmentBadge({
  attachment,
  onRemove,
  onClick,
  isLoading,
  variant = 'input'
}: AttachmentBadgeProps): React.JSX.Element {
  const isInput = variant === 'input'
  const isClickable = !!onClick && !isLoading
  const baseClasses =
    'inline-flex items-center gap-1 rounded-md border max-w-[18rem] ' +
    (isInput
      ? 'pl-1.5 pr-1 py-0.5 text-[11px] bg-[var(--color-bg-elevated)] border-[var(--color-border)] text-[var(--color-text-secondary)]'
      : 'pl-1.5 pr-1.5 py-0.5 text-[10px] bg-[var(--color-bg-elevated)] border-[var(--color-border)] text-[var(--color-text-muted)]') +
    (isClickable
      ? ' cursor-pointer hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)] transition-colors'
      : '')

  const titleText = isClickable
    ? `Download ${attachment.filename} (${formatSize(attachment.size)})`
    : `${attachment.filename} (${formatSize(attachment.size)})`

  const innerContent = (
    <>
      {isLoading ? (
        <Loader2 size={12} className="shrink-0 animate-spin" />
      ) : (
        pickIcon(attachment.mimeType)
      )}
      <span className="truncate">{truncate(attachment.filename, isInput ? 24 : 22)}</span>
      {!isInput && (
        <span className="opacity-70 ml-0.5">{formatSize(attachment.size)}</span>
      )}
      {onRemove && (
        // The remove button is also a real <button>; its onClick stops
        // propagation so a click on the X doesn't bubble up to the parent
        // download trigger (relevant if both ever overlap on the input
        // variant — today they don't, but cheap to keep correct).
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          className="ml-0.5 p-0.5 rounded hover:bg-[var(--color-bg-hover)]
            text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
          aria-label={`Remove ${attachment.filename}`}
        >
          <X size={10} />
        </button>
      )}
    </>
  )

  if (isClickable) {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={isLoading}
        title={titleText}
        className={baseClasses}
        aria-label={`Download ${attachment.filename}`}
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
  align = 'left'
}: AttachmentListProps<T>): React.JSX.Element | null {
  if (attachments.length === 0) return null
  return (
    <div
      className={
        'flex flex-wrap gap-1 ' +
        (align === 'right' ? 'justify-end' : 'justify-start')
      }
    >
      {attachments.map((a) => (
        <AttachmentBadge
          key={a.id}
          attachment={a}
          variant={variant}
          onRemove={onRemove ? () => onRemove(a.id) : undefined}
          onClick={onClick ? () => onClick(a) : undefined}
          isLoading={isLoading ? isLoading(a.id) : false}
        />
      ))}
    </div>
  )
}

