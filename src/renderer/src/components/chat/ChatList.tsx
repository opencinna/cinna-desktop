import { useChatList } from '../../hooks/useChat'
import { ChatItem } from './ChatItem'

export function ChatList(): React.JSX.Element {
  const { data: chats, isLoading } = useChatList()

  if (isLoading) {
    return (
      <div className="px-2.5 py-2 text-xs text-[var(--color-text-muted)]">Loading...</div>
    )
  }

  if (!chats || chats.length === 0) {
    return (
      <div className="px-2.5 py-6 text-center text-xs text-[var(--color-text-muted)]">
        No chats yet
      </div>
    )
  }

  return (
    <div className="px-1.5 py-1 space-y-px">
      {chats.map((chat) => (
        <ChatItem key={chat.id} chat={chat} />
      ))}
    </div>
  )
}
