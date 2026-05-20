import { Plus } from 'lucide-react'
import { useChatList } from '../../hooks/useChat'
import { useStartNewChat } from '../../hooks/useStartNewChat'
import { ChatItem } from './ChatItem'

export function ChatList(): React.JSX.Element {
  const { data: chats, isLoading } = useChatList()
  const startNewChat = useStartNewChat()

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 pt-1 pb-1">
        <span className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
          Chats
        </span>
        <button
          onClick={startNewChat}
          className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
          title="New chat"
        >
          <Plus size={14} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="px-2.5 py-2 text-xs text-[var(--color-text-muted)]">Loading...</div>
        ) : !chats || chats.length === 0 ? (
          <div className="px-2.5 py-6 text-center text-xs text-[var(--color-text-muted)]">
            No chats yet — click + to start one
          </div>
        ) : (
          <div className="px-1.5 py-1 space-y-px">
            {chats.map((chat) => (
              <ChatItem key={chat.id} chat={chat} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
