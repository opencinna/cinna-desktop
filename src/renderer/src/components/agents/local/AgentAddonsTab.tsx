import { useState } from 'react'
import { Plus } from 'lucide-react'
import type { LocalAgentDto } from '../../../../../shared/localAgents'
import { useAgentMcpProviders, useAttachAgentMcp, useDetachAgentMcp, useMcpProviders } from '../../../hooks/useMcp'
import { unwrapIpcError } from '../../../utils/ipcError'
import { MCPProviderCard } from '../../settings/MCPProviderCard'
import { SettingsButton, SettingsInfoTip, SettingsSection } from '../../settings/SettingsLayout'
import { McpAttachModal } from './McpAttachModal'
import { mcpProblem } from '../../settings/mcpPresentation'

/**
 * The Addons tab's count badge: attached connectors, and how many of them the
 * agent's sessions are running without. Shares the tab's queries, so it costs
 * no extra IPC.
 */
export function useAddonsBadge(agentId: string | null): { count: number; problems: number } {
  const { data: ids } = useAgentMcpProviders(agentId)
  const { data: providers } = useMcpProviders()
  const attached = (providers ?? []).filter((p) => ids?.includes(p.id))
  return { count: attached.length, problems: attached.filter((p) => mcpProblem(p) !== null).length }
}

/**
 * What a local agent runs with beyond its own folder. MCP connectors today;
 * catalog plugins and skills join as their own sections when they exist —
 * not as empty sections now.
 *
 * A connector attached here is the same record Settings → MCP lists, drawn
 * with the same card (ux_rules rule 13): toggling, editing or reconnecting it
 * here changes it everywhere. Detach only removes the link to this agent.
 */
export function AgentAddonsTab({ agent }: { agent: LocalAgentDto }): React.JSX.Element {
  const { data: ids, error: idsError } = useAgentMcpProviders(agent.id)
  const { data: providers } = useMcpProviders()
  // Owned here, not in the modal: an attach outlives the modal closing.
  const attach = useAttachAgentMcp()
  const detach = useDetachAgentMcp()
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState('')

  // In attach order; a link whose connector is gone is never drawn (the
  // delete cascades, and the provider list may simply not have caught up).
  const attached = (ids ?? []).flatMap((id) => providers?.find((p) => p.id === id) ?? [])

  return (
    <div className="space-y-4 text-[13px]">
      <SettingsSection
        title="MCP Connectors"
        info={
          <SettingsInfoTip label="About MCP connectors">
            <p>Every session of this agent gets the tools of the connectors attached here — its own chats, scheduled jobs, task runs, and runs where another agent calls it.</p>
            <p className="mt-2">Connectors run in Cinna, which keeps their sign-in; the agent’s runtime reaches them through Cinna and never sees a token. A connector that is not connected when a session starts is left out of that session.</p>
            <p className="mt-2">Each one is also listed in Settings → MCP. Detach removes it from this agent only.</p>
          </SettingsInfoTip>
        }
        action={
          <SettingsButton onClick={() => setPicking(true)}>
            <Plus size={14} />
            Attach
          </SettingsButton>
        }
      >
        {ids?.length === 0 && <p className="text-[var(--color-text-muted)]">No connectors attached.</p>}
        {attached.length > 0 && (
          <ul className="space-y-2">
            {attached.map((provider) => (
              <li key={provider.id}>
                <MCPProviderCard
                  provider={provider}
                  detach={{
                    disabled: detach.isPending,
                    onDetach: () => {
                      setError('')
                      detach.mutateAsync({ agentId: agent.id, mcpProviderId: provider.id })
                        .catch((e) => setError(unwrapIpcError(e)))
                    }
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>
      {(error || idsError) && (
        <p role="alert" className="text-[var(--color-danger)]">{error || unwrapIpcError(idsError)}</p>
      )}
      <McpAttachModal
        open={picking}
        attachedIds={ids ?? []}
        onClose={() => setPicking(false)}
        onAttach={async (mcpProviderId) => {
          await attach.mutateAsync({ agentId: agent.id, mcpProviderId })
        }}
      />
    </div>
  )
}
