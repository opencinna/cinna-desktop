import { useCallback } from 'react'
import { useUIStore } from '../stores/ui.store'
import { isFolderAgentId } from '../../../shared/localAgents'

/**
 * Whether an agent the app lists has a page to open. A server-owned agent
 * hidden from the desktop has a name and no page, so it stays plain text.
 */
export function hasAgentPage(agent: { source?: string | null; enabled?: boolean }): boolean {
  return agent.source !== 'remote' || !!agent.enabled
}

/**
 * Open an agent's own page, the way the sidebar does: a folder agent opens its
 * local page, anything else its external page. The sidebar is switched to
 * Agents so the row that was opened is the one showing.
 */
export function useOpenAgentPage(): (agent: { id: string }) => void {
  const setAgentPageMode = useUIStore((s) => s.setAgentPageMode)
  const setSidebarTab = useUIStore((s) => s.setSidebarTab)
  const setActiveLocalAgentId = useUIStore((s) => s.setActiveLocalAgentId)
  const setActiveExternalAgentId = useUIStore((s) => s.setActiveExternalAgentId)
  const setActiveView = useUIStore((s) => s.setActiveView)
  return useCallback(
    (agent: { id: string }) => {
      setAgentPageMode('chat')
      setSidebarTab('agents')
      if (isFolderAgentId(agent.id)) {
        setActiveLocalAgentId(agent.id)
        setActiveView('local-agent')
      } else {
        setActiveExternalAgentId(agent.id)
        setActiveView('external-agent')
      }
    },
    [setAgentPageMode, setSidebarTab, setActiveLocalAgentId, setActiveExternalAgentId, setActiveView]
  )
}
