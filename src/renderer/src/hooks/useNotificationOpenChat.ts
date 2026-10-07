import { useEffect } from 'react'
import { useChatStore } from '../stores/chat.store'
import { useUIStore } from '../stores/ui.store'

/**
 * Answers a click on an OS desktop notification: main has raised the window
 * and names the chat whose turn stopped; open it, as the sidebar does. A
 * task's chat is hidden from the list and opens by id all the same.
 *
 * Mount once, in the main window only.
 */
export function useNotificationOpenChat(): void {
  const setActiveChatId = useChatStore((s) => s.setActiveChatId)
  const setActiveView = useUIStore((s) => s.setActiveView)
  const setLogsOpen = useUIStore((s) => s.setLogsOpen)
  const setAgentStatusOpen = useUIStore((s) => s.setAgentStatusOpen)
  const setAgentStatusDetailId = useUIStore((s) => s.setAgentStatusDetailId)

  useEffect(() => {
    const open = (chatId: string): void => {
      // Clear any open overlay so the chat is not left hidden underneath.
      setLogsOpen(false)
      setAgentStatusOpen(false)
      setAgentStatusDetailId(null)
      setActiveChatId(chatId)
      setActiveView('chat')
    }
    // Main keeps a clicked chat until a renderer takes it: a click that
    // recreated the window, or landed before this shell mounted, was pushed to
    // nobody. Taken on mount, and on every push so a delivered click does not
    // reopen at the next mount. Opened even if this effect was torn down
    // meanwhile (a StrictMode remount): taking it cleared it, so nobody else will.
    const takePending = (): void => {
      void window.api.notifications.takePendingOpenChat().then((pending) => {
        if (pending) open(pending.chatId)
      }).catch(() => { /* nothing to open */ })
    }
    const unsubscribe = window.api.notifications.onOpenChat(({ chatId }) => {
      open(chatId)
      takePending()
    })
    takePending()
    return unsubscribe
  }, [setActiveChatId, setActiveView, setLogsOpen, setAgentStatusOpen, setAgentStatusDetailId])
}
