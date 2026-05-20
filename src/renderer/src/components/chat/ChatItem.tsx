import { Trash2 } from 'lucide-react'
import { useChatStore } from '../../stores/chat.store'
import { useDeleteChat } from '../../hooks/useChat'
import { useUIStore } from '../../stores/ui.store'
import { useState } from 'react'

interface ChatItemProps {
  chat: {
    id: string
    title: string
    updatedAt: Date
  }
}

export function ChatItem({ chat }: ChatItemProps): React.JSX.Element {
  const activeChatId = useChatStore((s) => s.activeChatId)
  const setActiveChatId = useChatStore((s) => s.setActiveChatId)
  const setActiveView = useUIStore((s) => s.setActiveView)
  const setActiveJobId = useUIStore((s) => s.setActiveJobId)
  const deleteChat = useDeleteChat()
  const [hovering, setHovering] = useState(false)
  const isActive = activeChatId === chat.id

  return (
    <div
      className={`group flex items-center gap-1.5 px-2.5 py-1.5 rounded-md cursor-pointer text-xs transition-colors ${
        isActive
          ? 'app-nav-active text-[var(--color-text)]'
          : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]'
      }`}
      onClick={() => {
        // Picking a chat from the main Chats list leaves any jobs-context
        // anchor behind — the user is navigating via chats now.
        setActiveJobId(null)
        setActiveChatId(chat.id)
        setActiveView('chat')
      }}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <span className="flex-1 truncate">{chat.title}</span>
      {hovering && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            deleteChat.mutate(chat.id)
          }}
          className="p-0.5 rounded hover:bg-[var(--color-danger)]/20 text-[var(--color-text-muted)] hover:text-[var(--color-danger)] transition-colors shrink-0"
        >
          <Trash2 size={12} />
        </button>
      )}
    </div>
  )
}
