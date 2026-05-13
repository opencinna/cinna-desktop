import { useCallback } from 'react'
import { useChatStore } from '../stores/chat.store'
import { useUIStore } from '../stores/ui.store'

/**
 * Returns a stable callback that lands the user on the new-chat screen
 * (clears the active chat and switches to the chat view). Single source of
 * truth for the "+" entry-points scattered around the UI.
 */
export function useStartNewChat(): () => void {
  const setActiveChatId = useChatStore((s) => s.setActiveChatId)
  const setActiveView = useUIStore((s) => s.setActiveView)
  return useCallback(() => {
    setActiveChatId(null)
    setActiveView('chat')
  }, [setActiveChatId, setActiveView])
}
