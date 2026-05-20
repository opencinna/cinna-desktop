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
  const setActiveJobId = useUIStore((s) => s.setActiveJobId)
  return useCallback(() => {
    // Starting a new chat from the top-bar `+` always leaves any jobs
    // context behind — the user is creating an ad-hoc chat, not running a
    // job, so the job sidebar highlight must drop.
    setActiveJobId(null)
    setActiveChatId(null)
    setActiveView('chat')
  }, [setActiveChatId, setActiveView, setActiveJobId])
}
