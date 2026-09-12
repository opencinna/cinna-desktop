import { useQueryClient } from '@tanstack/react-query'
import { useSetAgentEnabled } from './useAgents'
import type { LocalAgentsSnapshot } from './useLocalAgents'
import { useUIStore } from '../stores/ui.store'
import { useAuthStore } from '../stores/auth.store'
import { useChatStore } from '../stores/chat.store'
import { useToastStore } from '../stores/toast.store'
import { nextAgentAfterHiding, sidebarAgentOrder } from '../utils/agentNavigation'

type Agent = Awaited<ReturnType<typeof window.api.agents.list>>[number]

export function useAgentDesktopVisibility() {
  const mutation = useSetAgentEnabled()
  const queryClient = useQueryClient()
  const setVisible = (agent: Agent, enabled: boolean, onError: (error: unknown) => void): void => {
    if (!enabled && agent.source !== 'remote') {
      onError(new Error('Direct agent connections can be deleted, but cannot be disabled.'))
      return
    }
    // Snapshot before the optimistic switch hides this row from the cache.
    const profileId = useAuthStore.getState().currentUser?.id
    const order = sidebarAgentOrder(queryClient.getQueryData<Agent[]>(['agents']) ?? [agent], queryClient.getQueryData<LocalAgentsSnapshot>(['local-agents']))
    mutation.mutate({ agentId: agent.id, enabled }, {
      onError,
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ['agent-status'] })
        if (enabled || useAuthStore.getState().currentUser?.id !== profileId) return
        useToastStore.getState().show(`${agent.name} is hidden from Desktop. Re-enable it in Settings → Profile → Agents.`)
        const ui = useUIStore.getState()
        if (ui.activeView !== 'external-agent' || ui.activeExternalAgentId !== agent.id) return
        // Exclude anything else hidden or removed while the request was in flight.
        const current = queryClient.getQueryData<Agent[]>(['agents'])
        const next = nextAgentAfterHiding(order.filter((item) => item.id === agent.id || item.source === 'folder' || !current || current.some((row) => row.id === item.id && (row.source !== 'remote' || row.enabled))), agent.id)
        ui.setAgentPageMode('chat')
        if (next?.source === 'folder') {
          ui.setActiveLocalAgentId(next.id)
          ui.setActiveView('local-agent')
        } else if (next) {
          ui.setActiveExternalAgentId(next.id)
          ui.setActiveView('external-agent')
        } else {
          ui.setActiveExternalAgentId(null)
          ui.setPendingAgentId(null)
          useChatStore.getState().setActiveChatId(null)
          ui.setActiveView('chat')
        }
      }
    })
  }
  return { setVisible, isPending: mutation.isPending }
}
