import { Brain, ChevronDown, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import type { NoteData } from '../../../../shared/notes'
import { NoteItem } from './NoteItem'

/**
 * Cinna Assistant's memory notes (frontmatter `kind: assistant-memory`), kept
 * out of the folders under one collapsible row after them. Collapsed on every
 * launch. A row opens the note like any other; it is not a drag source and the
 * section takes no drops — memory notes have no folder or order of their own.
 */
export function MemoryNotesSection({ notes }: { notes: NoteData[] }): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(false)
  if (notes.length === 0) return null

  return (
    <div className="space-y-px pt-1">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="group flex w-full items-center gap-1 px-1.5 py-1 rounded-md cursor-pointer text-[11px] uppercase tracking-wide
          text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors"
      >
        {expanded ? <ChevronDown size={12} className="shrink-0" /> : <ChevronRight size={12} className="shrink-0" />}
        <Brain size={12} className="shrink-0" />
        <span className="flex-1 truncate text-left normal-case tracking-normal text-xs text-[var(--color-text-secondary)]">
          Assistant memory
        </span>
        <span className="w-4 shrink-0 text-right text-[10px] text-[var(--color-text-muted)] tabular-nums normal-case tracking-normal">
          {notes.length}
        </span>
      </button>
      {expanded && (
        <div className="pl-3 space-y-px">
          {notes.map((note) => (
            <NoteItem key={note.id} note={note} draggable={false} />
          ))}
        </div>
      )}
    </div>
  )
}
