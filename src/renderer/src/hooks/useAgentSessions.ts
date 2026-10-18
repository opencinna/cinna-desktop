import { useEffect } from 'react'
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import type { AgentActiveSession } from '../../../shared/agentSessions'

/**
 * The agents already running a session (a chat whose turn is running, typed or
 * dispatched), for the warning a surface shows before it starts one more on
 * the same agent. Main decides; this reads it.
 *
 * Kept fresh by pushes alone, with no poll: main's `agentSessions:changed`
 * (a turn taking or letting go of a chat, in any chat), the task dispatcher's
 * `taskDispatch:changed` (a dispatched run starting or ending), and a chat's
 * new title, which the warning names.
 */
export const AGENT_SESSIONS_KEY = ['agent-sessions'] as const

/** `enabled: false` reads nothing (a composer in an existing chat, which never warns). */
export function useAgentActiveSessions({ enabled = true }: { enabled?: boolean } = {}): UseQueryResult<AgentActiveSession[]> {
  const queryClient = useQueryClient()
  useEffect(() => {
    if (!enabled) return
    const refresh = (): void => { void queryClient.invalidateQueries({ queryKey: AGENT_SESSIONS_KEY }) }
    const offSessions = window.api.agentSessions.onChanged(refresh)
    const offDispatch = window.api.taskDispatch.onChanged(refresh)
    const offTitle = window.api.chat.onTitleUpdated(refresh)
    return () => { offSessions(); offDispatch(); offTitle() }
  }, [queryClient, enabled])
  return useQuery({
    queryKey: AGENT_SESSIONS_KEY,
    queryFn: async () => {
      const result = await window.api.agentSessions.active()
      return result.ok ? result.sessions : []
    },
    // Read again on every mount: the pushes reach only mounted readers, so a
    // run that started while no surface showed the warning (the app's default
    // `staleTime` would keep the older read for 5 s) must not be missed.
    staleTime: 0,
    enabled,
    refetchOnWindowFocus: true,
    retry: 1
  })
}
