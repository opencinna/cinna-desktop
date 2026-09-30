import { useState } from 'react'
import { Image as ImageIcon, ImageOff, X } from 'lucide-react'
import { useImage, type ImageRef } from '../../utils/imageDataCache'
import { formatSize, type AttachmentBadgeData } from './AttachmentBadge'

/** The thumbnail's side, in px: the box is this size from the first paint, in every state. */
export const THUMBNAIL_SIZE = 64

/**
 * An image attachment as a fixed square thumbnail, under a sent message, in an
 * agent's reply and in the composer. The box keeps its size in every state —
 * a placeholder while the small image loads, the image, or a broken-image
 * icon when it cannot be shown (main refused it, or the bytes do not decode) —
 * so nothing moves. A click opens the preview, which says why a broken one is
 * not shown (and, for a sent file, offers its Download). In the composer an
 * [x] in the corner removes the file: a sibling button, not nested.
 */
export function AttachmentThumbnail({
  attachment,
  imageRef,
  onClick,
  onRemove
}: {
  attachment: AttachmentBadgeData
  imageRef: ImageRef
  onClick?: () => void
  onRemove?: () => void
}): React.JSX.Element {
  const image = useImage(imageRef, 'thumbnail')
  // Main can hand back bytes that pass its sniff yet do not decode.
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null)
  const failed = image.status === 'error' || (image.status === 'ready' && brokenUrl === image.dataUrl)
  const name = attachment.filename
  const sized = attachment.size > 0 ? `${name} (${formatSize(attachment.size)})` : name
  const title = failed ? `${sized} — no thumbnail for this image` : sized
  const box =
    'flex items-center justify-center overflow-hidden rounded-md border border-[var(--color-border)] ' +
    'bg-[var(--color-bg-secondary)]'
  const content = failed ? (
    <ImageOff size={16} className="text-[var(--color-text-muted)]" aria-hidden />
  ) : image.status === 'ready' ? (
    <img
      src={image.dataUrl}
      alt=""
      draggable={false}
      onError={() => setBrokenUrl(image.dataUrl)}
      className="h-full w-full object-cover"
    />
  ) : (
    <ImageIcon size={16} className="text-[var(--color-text-muted)]" aria-hidden />
  )
  const sizeStyle = { width: THUMBNAIL_SIZE, height: THUMBNAIL_SIZE }
  return (
    <span
      data-testid="attachment-thumbnail"
      data-state={failed ? 'failed' : image.status}
      className="relative inline-flex shrink-0"
      style={sizeStyle}
    >
      {onClick ? (
        <button
          type="button"
          onClick={onClick}
          title={`Preview ${title}`}
          aria-label={`Preview ${name}`}
          className={`${box} cursor-pointer hover:border-[var(--color-text-muted)] transition-colors`}
          style={sizeStyle}
        >
          {content}
        </button>
      ) : (
        <span role="img" aria-label={name} title={title} className={box} style={sizeStyle}>
          {content}
        </span>
      )}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${name}`}
          title={`Remove ${name}`}
          className="absolute top-1 right-1 flex h-5 w-5 items-center justify-center rounded-full
            border border-[var(--color-border)] bg-[var(--color-bg)] shadow-sm
            text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors"
        >
          <X size={11} strokeWidth={2.5} />
        </button>
      )}
    </span>
  )
}
