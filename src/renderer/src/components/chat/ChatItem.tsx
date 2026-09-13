import { CircleAlert, CircleCheck, CircleHelp, Loader2, Square, Trash2 } from 'lucide-react'
import { useChatStore } from '../../stores/chat.store'
import { useDeleteChat, useInterruptChat } from '../../hooks/useChat'
import { useUIStore } from '../../stores/ui.store'
import { unwrapIpcError } from '../../utils/ipcError'
import type { ChatRunResult } from '../../../../shared/chatRunResult'

const resultIndicators = {
  completed: { icon: CircleCheck, label: 'Completed — unread results', color: 'text-[var(--color-success)]' },
  needs_input: { icon: CircleHelp, label: 'Needs input — unread results', color: 'text-[var(--color-warning)]' },
  failed: { icon: CircleAlert, label: 'Failed — unread results', color: 'text-[var(--color-danger)]' }
}

interface ChatItemProps {
  chat: {
    id: string
    title: string
    updatedAt: Date
    activeRunId?: string | null
    lastRunResult?: ChatRunResult | null
  }
}

export function ChatItem({ chat }: ChatItemProps): React.JSX.Element {
  const activeChatId = useChatStore((s) => s.activeChatId)
  const setActiveChatId = useChatStore((s) => s.setActiveChatId)
  const setActiveView = useUIStore((s) => s.setActiveView)
  const setActiveJobId = useUIStore((s) => s.setActiveJobId)
  const deleteChat = useDeleteChat()
  const isStreaming = useChatStore((s) => s.activeChatId === chat.id && s.isStreaming)
  const interrupt = useInterruptChat(chat.id)
  const isRunning = isStreaming || !!chat.activeRunId
  const isInterrupting = interrupt.isPending
  const unread = !isRunning && chat.lastRunResult?.unread && chat.lastRunResult.status !== 'canceled'
    ? resultIndicators[chat.lastRunResult.status] : null
  const ResultIcon = unread?.icon
  const actionLabel = isInterrupting ? 'Interrupting session…' : isRunning ? 'Interrupt session' : 'Delete session'
  const error = isRunning ? interrupt.error : deleteChat.error
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
    >
      <span className="flex-1 truncate">{chat.title}</span>
      <button
        onClick={(e) => {
          e.stopPropagation()
          if (isRunning) interrupt.mutate()
          else deleteChat.mutate(chat.id)
        }}
        aria-label={actionLabel}
        title={unread ? `${unread.label} · ${actionLabel}` : actionLabel}
        disabled={isInterrupting || deleteChat.isPending}
        className={`${isRunning || isInterrupting || unread ? '' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'} relative p-0.5 rounded hover:bg-[var(--color-danger)]/20 text-[var(--color-text-muted)] hover:text-[var(--color-danger)] transition-colors shrink-0 disabled:cursor-wait`}
      >
        {isRunning || isInterrupting ? (
          <>
            <Loader2 size={12} aria-hidden="true" className={`animate-spin ${isInterrupting ? '' : 'group-hover:opacity-0 group-focus-within:opacity-0'}`} />
            {!isInterrupting && <Square size={12} aria-hidden="true" className="absolute inset-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100" />}
          </>
        ) : unread && ResultIcon ? (
          <>
            <ResultIcon size={12} role="img" aria-label={unread.label} className={`${unread.color} group-hover:opacity-0 group-focus-within:opacity-0`} />
            <Trash2 size={12} aria-hidden="true" className="absolute inset-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100" />
          </>
        ) : <Trash2 size={12} aria-hidden="true" />}
      </button>
      {error && <span role="alert" className="text-[var(--color-danger)]" title={unwrapIpcError(error, 'The session action failed.')}>
        {unwrapIpcError(error, 'The session action failed.')}
      </span>}
    </div>
  )
}
