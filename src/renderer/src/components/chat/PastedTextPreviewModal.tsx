import { ClipboardList, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { pasteLabel, pasteSizeLabel } from '../../../../shared/pastedText'
import { CopyButton } from '../artifacts/ArtifactCard'
import { MODAL_HEADER_ACTION, MODAL_HEADER_ICON } from '../ui/modalHeader'

const HEADER_ACTION_CLASS = MODAL_HEADER_ACTION + ' text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'

interface PastedTextPreviewModalProps {
  /** The paste's raw text. */
  text: string
  onClose: () => void
  /** Composer only: put the paste into the textarea and drop the chip. */
  onInsert?: () => void
  /** Composer only: drop the chip. */
  onRemove?: () => void
}

/**
 * A paste's raw text, as sent: monospace, wrapped, never rendered as markdown.
 * Opened from a paste chip in the composer (Copy, Insert as text, Remove) and
 * from a paste card in a sent user bubble (Copy).
 */
export function PastedTextPreviewModal({ text, onClose, onInsert, onRemove }: PastedTextPreviewModalProps): React.JSX.Element {
  const cardRef = useRef<HTMLDivElement>(null)
  const [copyFailed, setCopyFailed] = useState(false)

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

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[10vh]">
      <div aria-hidden className="app-modal-scrim absolute inset-0" />
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label="Pasted text"
        className="relative w-full max-w-3xl max-h-[80vh] flex flex-col rounded-xl border app-modal-panel"
      >
        <div className="flex items-center justify-between gap-2 px-5 py-3 border-b border-[var(--color-border)]">
          <div className="flex items-center gap-2 min-w-0">
            <ClipboardList size={16} className="text-[var(--color-text-muted)] shrink-0" />
            <div className="text-sm font-semibold text-[var(--color-text)] truncate">{pasteLabel(text)}</div>
            <div className="text-xs text-[var(--color-text-muted)] shrink-0">{pasteSizeLabel(text)}</div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <CopyButton text={text} label="Copy" className={HEADER_ACTION_CLASS} minWidth="min-w-[4.5rem]" onFailed={() => setCopyFailed(true)} />
            {onInsert && (
              <button type="button" className={HEADER_ACTION_CLASS} onClick={onInsert}>
                Insert as text
              </button>
            )}
            {onRemove && (
              <button type="button" className={HEADER_ACTION_CLASS} onClick={onRemove}>
                Remove
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className={MODAL_HEADER_ICON + ` hover:bg-[var(--color-bg-hover)]
                text-[var(--color-text-muted)] hover:text-[var(--color-text)]`}
              title="Close"
              aria-label="Close pasted text preview"
            >
              <X size={14} />
            </button>
          </div>
        </div>
        {copyFailed && (
          <div className="px-5 pt-2 text-xs text-[var(--color-danger)]">Couldn’t copy the text — the clipboard refused it.</div>
        )}
        <div className="app-modal-well m-3 min-h-0 flex-1 overflow-y-auto rounded-lg">
          <pre className="m-0 px-4 py-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-[var(--color-text)]">
            {text}
          </pre>
        </div>
      </div>
    </div>,
    document.body
  )
}
