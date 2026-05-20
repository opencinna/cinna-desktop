import { NotebookPen, X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { useNote } from '../../hooks/useNotes'
import { markdownComponents } from '../../utils/markdownComponents'

interface NotePreviewModalProps {
  noteId: string
  /** Title fallback while the note body is still loading. */
  fallbackTitle?: string
  onClose: () => void
}

/**
 * Read-only popover over the current view that renders a note's markdown.
 * Used by the composer's note attachment badge so the user can re-check the
 * note's contents without leaving the chat.
 */
export function NotePreviewModal({
  noteId,
  fallbackTitle,
  onClose
}: NotePreviewModalProps): React.JSX.Element {
  const cardRef = useRef<HTMLDivElement>(null)
  const { data: note, isLoading } = useNote(noteId)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    const onMouse = (e: MouseEvent): void => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onMouse)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onMouse)
    }
  }, [onClose])

  const title = note?.title || fallbackTitle || 'Untitled note'
  const body = note?.body ?? ''

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 px-4">
      <div
        ref={cardRef}
        className="w-full max-w-2xl max-h-[80vh] flex flex-col rounded-xl border
          border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-lg"
      >
        <div className="flex items-start justify-between gap-2 px-5 py-4 border-b
          border-[var(--color-border)]">
          <div className="flex items-center gap-2 min-w-0">
            <NotebookPen size={16} className="text-[var(--color-text-muted)] shrink-0" />
            <div className="text-sm font-semibold text-[var(--color-text)] truncate">
              {title}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 -mt-1 -mr-1 rounded hover:bg-[var(--color-bg-hover)]
              text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
            title="Close"
            aria-label="Close note preview"
          >
            <X size={14} />
          </button>
        </div>

        <div className="px-5 py-4 overflow-y-auto flex-1">
          {isLoading && !note ? (
            <div className="text-xs text-[var(--color-text-muted)]">Loading…</div>
          ) : body.trim() ? (
            <div className="markdown-body text-sm text-[var(--color-text)] leading-relaxed">
              <Markdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeHighlight]}
                components={markdownComponents}
              >
                {body}
              </Markdown>
            </div>
          ) : (
            <div className="text-xs italic text-[var(--color-text-muted)]">
              This note is empty.
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
