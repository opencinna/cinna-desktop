import { useState } from 'react'
import { Plus, RefreshCw, Cloud, AlertTriangle } from 'lucide-react'
import { AgentCard } from './AgentCard'
import { A2AAgentForm } from './A2AAgentForm'
import { useAgents, useRemoteSyncStatus, useSyncRemoteAgents } from '../../hooks/useAgents'
import { useAuthStore } from '../../stores/auth.store'

const REMOTE_SECTION_LABELS: Record<string, string> = {
  agent: 'My Agents',
  app_mcp_route: 'Shared with Me',
  identity: 'People'
}

export function AgentsSettingsSection(): React.JSX.Element {
  const { data: agents } = useAgents()
  const [showAdd, setShowAdd] = useState(false)
  const syncRemote = useSyncRemoteAgents()
  const syncStatus = useRemoteSyncStatus()
  const currentUser = useAuthStore((s) => s.currentUser)
  const isCinnaUser = currentUser?.type === 'cinna_user'

  const allAgents = agents ?? []
  const remoteAgents = allAgents.filter((a) => a.source === 'remote')
  const localAgents = allAgents.filter((a) => a.source === 'local' && a.protocol === 'a2a')

  // Group remote agents by target type
  const remoteByType = remoteAgents.reduce<Record<string, typeof remoteAgents>>((acc, a) => {
    const key = a.remoteTargetType ?? 'agent'
    ;(acc[key] ??= []).push(a)
    return acc
  }, {})
  const remoteTypeOrder = ['agent', 'app_mcp_route', 'identity']

  return (
    <div className="space-y-4">
      {/* Remote Agents section */}
      {isCinnaUser && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider flex items-center gap-1.5">
              <Cloud size={12} />
              Remote Agents
            </h2>
            <button
              onClick={() => syncRemote.mutate()}
              disabled={syncRemote.isPending}
              className="flex items-center gap-1 text-[10px] text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] font-medium transition-colors disabled:opacity-50"
            >
              <RefreshCw size={10} className={syncRemote.isPending ? 'animate-spin' : ''} />
              {syncRemote.isPending ? 'Syncing...' : 'Sync'}
            </button>
          </div>

          {syncStatus.error && (
            <div
              className="flex items-start gap-2 px-2.5 py-2 mb-2 rounded-md
                border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10
                text-[10px] text-[var(--color-text-secondary)]"
            >
              <AlertTriangle size={12} className="mt-0.5 shrink-0 text-[var(--color-danger)]" />
              <span>
                {syncStatus.error === 'reauth_required'
                  ? 'Cinna session expired. Sign out and back in to resume remote agent sync.'
                  : 'Remote agent sync failed. Try again, or check the logger overlay (⌘`) for details.'}
              </span>
            </div>
          )}

          {remoteAgents.length === 0 ? (
            <div className="text-[10px] text-[var(--color-text-muted)] py-2">
              No remote agents found. Click Sync to fetch from your Cinna account.
            </div>
          ) : (
            <div className="space-y-3">
              {remoteTypeOrder
                .filter((type) => remoteByType[type]?.length)
                .map((type) => (
                  <div key={type}>
                    <div className="text-[10px] font-medium text-[var(--color-text-muted)] mb-1.5 pl-1">
                      {REMOTE_SECTION_LABELS[type] ?? type}
                    </div>
                    <div className="space-y-2">
                      {remoteByType[type].map((agent) => (
                        <AgentCard key={agent.id} agent={agent} />
                      ))}
                    </div>
                  </div>
                ))}
            </div>
          )}
        </div>
      )}

      {/* Local A2A Agents section */}
      <div>
        <h2 className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-2">
          {isCinnaUser ? 'Local A2A Agents' : 'A2A Agents'}
        </h2>
        <div className="space-y-3">
          {localAgents.map((agent) => (
            <AgentCard key={agent.id} agent={agent} />
          ))}

          {showAdd ? (
            <A2AAgentForm onClose={() => setShowAdd(false)} />
          ) : (
            <button
              onClick={() => setShowAdd(true)}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-lg
                border border-dashed border-[var(--color-border)] text-xs
                text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]
                hover:border-[var(--color-text-muted)] transition-colors"
            >
              <Plus size={14} />
              Add A2A Agent
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
