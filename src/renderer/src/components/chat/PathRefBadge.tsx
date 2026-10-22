import { File, Folder, X } from 'lucide-react'
import { pathRefLabel, type ComposerPathRef } from '../../../../shared/pathMentions'
import { truncateFilename } from './AttachmentBadge'

/**
 * A file or folder referenced by path in the composer — a sibling of
 * {@link NoteBadge}. Nothing is attached: the message names the path. The pill
 * is not clickable; the trailing X removes it, and the tooltip is the path.
 */
export function PathRefBadge({ pathRef, onRemove }: { pathRef: ComposerPathRef; onRemove?: () => void }): React.JSX.Element {
  const label = pathRefLabel(pathRef.path)
  const Icon = pathRef.kind === 'dir' ? Folder : File
  return (
    <span
      title={pathRef.displayPath}
      data-testid="path-ref-badge"
      className="inline-flex items-center gap-1 rounded-md border pl-1.5 pr-1 py-0.5 text-[11px]
        bg-[var(--color-accent)]/10 border-[var(--color-accent)]/30 text-[var(--color-text-secondary)]"
    >
      <Icon size={12} className="shrink-0 text-[var(--color-accent)]" aria-hidden="true" />
      {/* Cut like an attachment's name, so the extension survives: `quarterly-rep…xlsx`. */}
      <span className="whitespace-nowrap">{truncateFilename(label)}</span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="ml-0.5 p-0.5 rounded hover:bg-[var(--color-bg-hover)]
            text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
          aria-label={`Remove ${label}`}
          title={`Remove ${label}`}
        >
          <X size={10} />
        </button>
      )}
    </span>
  )
}

export function PathRefBadgeList({
  refs,
  onRemove,
  align = 'left'
}: {
  refs: readonly ComposerPathRef[]
  onRemove?: (path: string) => void
  align?: 'left' | 'right'
}): React.JSX.Element | null {
  if (refs.length === 0) return null
  return (
    <div className={'flex flex-wrap gap-1 ' + (align === 'right' ? 'justify-end' : 'justify-start')}>
      {refs.map((ref) => (
        <PathRefBadge key={ref.path} pathRef={ref} onRemove={onRemove ? () => onRemove(ref.path) : undefined} />
      ))}
    </div>
  )
}
