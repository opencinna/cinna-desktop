import { Trash2, RotateCcw, MessageSquare, StickyNote } from 'lucide-react'
import {
  useTrashList,
  useRestoreChat,
  usePermanentDeleteChat,
  useEmptyTrash
} from '../../hooks/useChat'
import {
  useNotesTrash,
  useRestoreNote,
  usePermanentDeleteNote,
  useEmptyNotesTrash
} from '../../hooks/useNotes'

interface TrashRowMeta {
  id: string
  title: string
  deletedAt: Date
  kind: 'chat' | 'note'
}

function buildRows(
  chats: ReadonlyArray<{ id: string; title: string; deletedAt: Date | null }>,
  notes: ReadonlyArray<{ id: string; title: string; deletedAt: Date | null }>
): TrashRowMeta[] {
  const rows: TrashRowMeta[] = []
  for (const c of chats) {
    if (c.deletedAt) rows.push({ id: c.id, title: c.title, deletedAt: new Date(c.deletedAt), kind: 'chat' })
  }
  for (const n of notes) {
    if (n.deletedAt) rows.push({ id: n.id, title: n.title || 'Untitled note', deletedAt: new Date(n.deletedAt), kind: 'note' })
  }
  rows.sort((a, b) => b.deletedAt.getTime() - a.deletedAt.getTime())
  return rows
}

export function TrashSection(): React.JSX.Element {
  const { data: trashedChats, isLoading: chatsLoading } = useTrashList()
  const { data: trashedNotes, isLoading: notesLoading } = useNotesTrash()
  const restoreChat = useRestoreChat()
  const restoreNote = useRestoreNote()
  const permanentDeleteChat = usePermanentDeleteChat()
  const permanentDeleteNote = usePermanentDeleteNote()
  const emptyChatTrash = useEmptyTrash()
  const emptyNotesTrash = useEmptyNotesTrash()

  const isLoading = chatsLoading || notesLoading
  const rows = buildRows(trashedChats ?? [], trashedNotes ?? [])
  const hasItems = rows.length > 0
  const emptying = emptyChatTrash.isPending || emptyNotesTrash.isPending

  const handleEmptyAll = (): void => {
    if (emptying) return
    if ((trashedChats?.length ?? 0) > 0) emptyChatTrash.mutate()
    if ((trashedNotes?.length ?? 0) > 0) emptyNotesTrash.mutate()
  }

  return (
    <div>
      {hasItems && (
        <div className="flex justify-end mb-4">
          <button
            onClick={handleEmptyAll}
            disabled={emptying}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium
              text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10 transition-colors"
          >
            <Trash2 size={13} />
            Empty Trash
          </button>
        </div>
      )}

      {isLoading && (
        <p className="text-xs text-[var(--color-text-muted)]">Loading...</p>
      )}

      {!isLoading && !hasItems && (
        <div className="text-center py-12">
          <Trash2 size={32} className="mx-auto mb-3 text-[var(--color-text-muted)] opacity-40" />
          <p className="text-sm text-[var(--color-text-muted)]">Trash is empty</p>
          <p className="text-xs text-[var(--color-text-muted)] mt-1">
            Deleted chats and notes will appear here for 30 days
          </p>
        </div>
      )}

      {hasItems && (
        <div className="space-y-1">
          {rows.map((row) => {
            const daysLeft = Math.max(
              0,
              30 - Math.floor((Date.now() - row.deletedAt.getTime()) / (1000 * 60 * 60 * 24))
            )
            const Icon = row.kind === 'chat' ? MessageSquare : StickyNote
            const isChat = row.kind === 'chat'
            return (
              <div
                key={`${row.kind}:${row.id}`}
                className="flex items-center gap-2 px-3 py-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]"
              >
                <Icon size={14} className="shrink-0 text-[var(--color-text-muted)]" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-[var(--color-text)] truncate">
                    {row.title}
                  </p>
                  <p className="text-[10px] text-[var(--color-text-muted)] mt-0.5">
                    {daysLeft > 0
                      ? `Auto-deletes in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}`
                      : 'Will be deleted on next launch'}
                  </p>
                </div>
                <button
                  onClick={() =>
                    isChat ? restoreChat.mutate(row.id) : restoreNote.mutate(row.id)
                  }
                  disabled={isChat ? restoreChat.isPending : restoreNote.isPending}
                  className="p-1.5 rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-accent)]/10 hover:text-[var(--color-accent)] transition-colors shrink-0"
                  title="Restore"
                >
                  <RotateCcw size={13} />
                </button>
                <button
                  onClick={() =>
                    isChat
                      ? permanentDeleteChat.mutate(row.id)
                      : permanentDeleteNote.mutate(row.id)
                  }
                  disabled={
                    isChat ? permanentDeleteChat.isPending : permanentDeleteNote.isPending
                  }
                  className="p-1.5 rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-danger)]/10 hover:text-[var(--color-danger)] transition-colors shrink-0"
                  title="Delete permanently"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
