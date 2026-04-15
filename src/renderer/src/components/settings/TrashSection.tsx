import { Trash2, RotateCcw } from 'lucide-react'
import { useTrashList, useRestoreChat, usePermanentDeleteChat, useEmptyTrash } from '../../hooks/useChat'

export function TrashSection(): React.JSX.Element {
  const { data: trashedChats, isLoading } = useTrashList()
  const restoreChat = useRestoreChat()
  const permanentDelete = usePermanentDeleteChat()
  const emptyTrash = useEmptyTrash()

  const hasItems = trashedChats && trashedChats.length > 0

  return (
    <div>
      {hasItems && (
        <div className="flex justify-end mb-4">
          <button
            onClick={() => emptyTrash.mutate()}
            disabled={emptyTrash.isPending}
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
            Deleted chats will appear here for 30 days
          </p>
        </div>
      )}

      {hasItems && (
        <div className="space-y-1">
          {trashedChats.map((chat) => {
            const deletedDate = new Date(chat.deletedAt!)
            const daysLeft = Math.max(
              0,
              30 - Math.floor((Date.now() - deletedDate.getTime()) / (1000 * 60 * 60 * 24))
            )
            return (
              <div
                key={chat.id}
                className="flex items-center gap-2 px-3 py-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-[var(--color-text)] truncate">
                    {chat.title}
                  </p>
                  <p className="text-[10px] text-[var(--color-text-muted)] mt-0.5">
                    {daysLeft > 0
                      ? `Auto-deletes in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}`
                      : 'Will be deleted on next launch'}
                  </p>
                </div>
                <button
                  onClick={() => restoreChat.mutate(chat.id)}
                  disabled={restoreChat.isPending}
                  className="p-1.5 rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-accent)]/10 hover:text-[var(--color-accent)] transition-colors shrink-0"
                  title="Restore"
                >
                  <RotateCcw size={13} />
                </button>
                <button
                  onClick={() => permanentDelete.mutate(chat.id)}
                  disabled={permanentDelete.isPending}
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
