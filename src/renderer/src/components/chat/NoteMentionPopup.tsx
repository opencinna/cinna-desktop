import type { RefObject } from 'react'
import { NotebookPen } from 'lucide-react'
import type { NoteData } from '../../../../shared/notes'
import { MentionPopup } from './MentionPopup'

interface NoteMentionPopupProps {
  /** Already-filtered list — ChatInput owns the filter predicate. */
  items: NoteData[]
  selectedIndex: number
  onSelect: (note: NoteData) => void
  onClose: () => void
  listboxId: string
  /** Input that owns the popup — clicks inside it are treated as "inside". */
  anchorRef?: RefObject<HTMLElement | null>
}

function notePreview(body: string): string | null {
  const trimmed = body.trim()
  if (!trimmed) return null
  return trimmed.length > 140 ? trimmed.slice(0, 140) + '…' : trimmed
}

export function NoteMentionPopup(props: NoteMentionPopupProps): React.JSX.Element | null {
  return (
    <MentionPopup<NoteData>
      {...props}
      header="Notes"
      ariaLabel="Notes"
      icon={NotebookPen}
      width="w-80"
      getKey={(note) => note.id}
      getPrimary={(note) => note.title || 'Untitled note'}
      getSecondary={(note) => notePreview(note.body)}
      secondaryClamp="line-clamp-2"
    />
  )
}
