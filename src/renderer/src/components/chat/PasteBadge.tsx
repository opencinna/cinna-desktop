import { ClipboardList, X } from 'lucide-react'
import { pasteLabel, pasteSizeLabel, type ComposerPaste } from '../../../../shared/pastedText'

/**
 * A long plain-text paste held in the composer — a sibling of
 * {@link NoteBadge} and {@link PathRefBadge}. The whole pill opens the preview
 * (Copy, Insert as text, Remove); the trailing X removes it. On send it becomes
 * a `<pasted_text>` block of the message text, not a file.
 */
export function PasteBadge({ paste, onRemove, onClick }: { paste: ComposerPaste; onRemove: () => void; onClick: () => void }): React.JSX.Element {
  const label = pasteLabel(paste.text)
  const size = pasteSizeLabel(paste.text)
  return (
    <button
      type="button"
      onClick={onClick}
      title={`${label} (pasted text, ${size}) — click to preview`}
      aria-label={`Preview pasted text ${label}`}
      data-testid="paste-badge"
      className="inline-flex items-center gap-1 rounded-md border max-w-[18rem] pl-1.5 pr-1 py-0.5 text-[11px]
        bg-[var(--color-accent)]/10 border-[var(--color-accent)]/30 text-[var(--color-text-secondary)]
        cursor-pointer hover:bg-[var(--color-accent)]/15 hover:text-[var(--color-text)] transition-colors"
    >
      <ClipboardList size={12} className="shrink-0 text-[var(--color-accent)]" aria-hidden="true" />
      <span className="truncate">{label}</span>
      <span className="shrink-0 whitespace-nowrap text-[var(--color-text-muted)]">· {size}</span>
      {/* A span, not a nested button: the pill itself is the button. */}
      <span
        role="button"
        tabIndex={0}
        onClick={(e) => {
          e.stopPropagation()
          onRemove()
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return
          e.preventDefault()
          e.stopPropagation()
          onRemove()
        }}
        className="ml-0.5 p-0.5 rounded hover:bg-[var(--color-bg-hover)]
          text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
        aria-label={`Remove pasted text ${label}`}
        title="Remove"
      >
        <X size={10} />
      </span>
    </button>
  )
}

export function PasteBadgeList({
  pastes,
  onRemove,
  onPreview,
  align = 'left'
}: {
  pastes: readonly ComposerPaste[]
  onRemove: (id: string) => void
  onPreview: (id: string) => void
  align?: 'left' | 'right'
}): React.JSX.Element | null {
  if (pastes.length === 0) return null
  return (
    <div className={'flex flex-wrap gap-1 ' + (align === 'right' ? 'justify-end' : 'justify-start')}>
      {pastes.map((paste) => (
        <PasteBadge key={paste.id} paste={paste} onRemove={() => onRemove(paste.id)} onClick={() => onPreview(paste.id)} />
      ))}
    </div>
  )
}
