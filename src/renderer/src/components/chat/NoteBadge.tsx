import { NotebookPen, X } from 'lucide-react'

export interface NoteBadgeData {
  id: string
  title: string
}

interface NoteBadgeProps {
  note: NoteBadgeData
  onRemove?: () => void
  /** Opens the preview modal — the whole pill is clickable when supplied. */
  onClick?: () => void
}

function truncate(name: string, max = 24): string {
  if (name.length <= max) return name
  return name.slice(0, max - 1) + '…'
}

/**
 * Visual sibling of {@link AttachmentBadge} for notes attached via the `?`
 * mention popup. Click anywhere on the pill to open the read-only preview;
 * the trailing X removes the note from the composer's pending list.
 */
export function NoteBadge({ note, onRemove, onClick }: NoteBadgeProps): React.JSX.Element {
  const label = (note.title || 'Untitled note').trim() || 'Untitled note'
  const isClickable = !!onClick
  const baseClasses =
    'inline-flex items-center gap-1 rounded-md border max-w-[18rem] ' +
    'pl-1.5 pr-1 py-0.5 text-[11px] ' +
    'bg-[var(--color-accent)]/10 border-[var(--color-accent)]/30 ' +
    'text-[var(--color-text-secondary)]' +
    (isClickable
      ? ' cursor-pointer hover:bg-[var(--color-accent)]/15 hover:text-[var(--color-text)] transition-colors'
      : '')

  const titleText = `${label} (note) — click to preview`

  const inner = (
    <>
      <NotebookPen size={12} className="shrink-0 text-[var(--color-accent)]" />
      <span className="truncate">{truncate(label, 24)}</span>
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          className="ml-0.5 p-0.5 rounded hover:bg-[var(--color-bg-hover)]
            text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
          aria-label={`Remove ${label}`}
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
        title={titleText}
        className={baseClasses}
        aria-label={`Preview note ${label}`}
      >
        {inner}
      </button>
    )
  }
  return (
    <span title={titleText} className={baseClasses}>
      {inner}
    </span>
  )
}

interface NoteBadgeListProps {
  notes: NoteBadgeData[]
  onRemove?: (id: string) => void
  onPreview?: (id: string) => void
  align?: 'left' | 'right'
}

export function NoteBadgeList({
  notes,
  onRemove,
  onPreview,
  align = 'left'
}: NoteBadgeListProps): React.JSX.Element | null {
  if (notes.length === 0) return null
  return (
    <div
      className={
        'flex flex-wrap gap-1 ' + (align === 'right' ? 'justify-end' : 'justify-start')
      }
    >
      {notes.map((n) => (
        <NoteBadge
          key={n.id}
          note={n}
          onRemove={onRemove ? () => onRemove(n.id) : undefined}
          onClick={onPreview ? () => onPreview(n.id) : undefined}
        />
      ))}
    </div>
  )
}
