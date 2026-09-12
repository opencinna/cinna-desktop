import { useState } from 'react'
import { RefreshCw, AlertTriangle } from 'lucide-react'
import { AgentTypeIcon } from '../agents/AgentTypeIcon'
import { useAgentDesktopVisibility } from '../../hooks/useAgentDesktopVisibility'
import { useUIStore } from '../../stores/ui.store'
import { serverLabel } from '../../utils/agentNavigation'
import { unwrapIpcError } from '../../utils/ipcError'
import { useAgents, useRemoteSyncStatus, useSyncRemoteAgents } from '../../hooks/useAgents'
import { useCinnaReauth } from '../../hooks/useAuth'
import { useAuthStore } from '../../stores/auth.store'

type RemoteAgent = NonNullable<ReturnType<typeof useAgents>['data']>[number]

function AgentVisibilityRow({ agent }: { agent: RemoteAgent }): React.JSX.Element {
  const visibility = useAgentDesktopVisibility()
  const [error, setError] = useState<string | null>(null)
  return <div className="px-4 py-3">
    <div className="flex items-center gap-3">
      <AgentTypeIcon agent={agent} size={16} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium">{agent.name}</div>
        <p className="mt-0.5 truncate text-[11px] text-[var(--color-text-muted)]">{agent.enabled ? agent.description || 'Shown in Desktop' : 'Hidden from Desktop'}</p>
      </div>
      {agent.enabled && <button type="button" className="text-xs text-[var(--color-text-muted)]" onClick={() => {
        const ui = useUIStore.getState()
        ui.setActiveExternalAgentId(agent.id)
        ui.setAgentPageMode('settings')
        ui.setSidebarTab('agents')
        ui.setActiveView('external-agent')
      }}>Settings</button>}
      <button type="button" disabled={visibility.isPending}
        aria-label={`${agent.enabled ? 'Disable' : 'Enable'} ${agent.name} in Desktop App`}
        onClick={() => {
          setError(null)
          visibility.setVisible(agent, !agent.enabled, (err) => setError(unwrapIpcError(err, 'Could not update agent.')))
        }}
        className="min-w-16 rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-xs text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)] disabled:opacity-50">
        {agent.enabled ? 'Disable' : 'Enable'}
      </button>
    </div>
    {error && <p role="alert" className="mt-2 text-xs text-[var(--color-danger)]">{error}</p>}
  </div>
}

/** Remote agents synced from the active Cinna account. */
export function AgentsSettingsSection(): React.JSX.Element {
  const { data: agents } = useAgents()
  const syncRemote = useSyncRemoteAgents()
  const syncStatus = useRemoteSyncStatus()
  const currentUser = useAuthStore((s) => s.currentUser)
  const isCinnaUser = currentUser?.type === 'cinna_user'
  const cinnaReauth = useCinnaReauth()
  const [reauthError, setReauthError] = useState<string | null>(null)

  const handleReauth = async (): Promise<void> => {
    if (!currentUser) return
    setReauthError(null)
    const result = await cinnaReauth.mutateAsync()
    if (!result.success) {
      setReauthError(result.error ?? 'Re-authentication failed')
      return
    }
    // Tokens are back — kick off a fresh remote sync so the agents reappear.
    syncRemote.mutate()
  }

  const remoteAgents = (agents ?? []).filter((agent) => agent.source === 'remote')
  const groups = remoteAgents.length > 0
    ? [{ label: serverLabel(currentUser?.cinnaServerUrl), agents: remoteAgents }]
    : []

  if (!isCinnaUser) return <p className="text-xs text-[var(--color-text-muted)]">Connect a Cinna profile to manage its agents.</p>

  return (
    <div>
      <p className="mb-4 text-xs leading-relaxed text-[var(--color-text-muted)]">Choose which agents from this Cinna server appear in Desktop. Hidden agents stay here so you can enable them again.</p>
      {isCinnaUser && <div className="flex items-center justify-between mb-2">
        <span className="text-[12px] text-[var(--color-text-muted)]">
          Synced from your Cinna account
        </span>
        <button
          onClick={() => syncRemote.mutate()}
          disabled={syncRemote.isPending}
          className="flex items-center gap-1 text-[12px] text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] font-medium transition-colors disabled:opacity-50"
        >
          <RefreshCw size={10} className={syncRemote.isPending ? 'animate-spin' : ''} />
          {syncRemote.isPending ? 'Syncing...' : 'Sync'}
        </button>
      </div>}

      {isCinnaUser && syncStatus.error && (
        <div
          className="flex items-start gap-2 px-2.5 py-2 mb-2 rounded-md
            border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10
            text-[12px] text-[var(--color-text-secondary)]"
        >
          <AlertTriangle size={12} className="mt-0.5 shrink-0 text-[var(--color-danger)]" />
          <div className="flex-1 min-w-0">
            <div>
              {syncStatus.error === 'reauth_required'
                ? 'Cinna session expired. Re-authenticate to resume remote agent sync — your chats and settings will be preserved.'
                : 'Remote agent sync failed. Try again, or check the logger overlay (⌘`) for details.'}
            </div>
            {syncStatus.error === 'reauth_required' && (
              <>
                <button
                  onClick={handleReauth}
                  disabled={cinnaReauth.isPending}
                  className="mt-1.5 inline-flex items-center gap-1 px-2 py-1 rounded-md text-[12px] font-medium
                    bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white transition-colors
                    disabled:opacity-50"
                >
                  <RefreshCw size={10} className={cinnaReauth.isPending ? 'animate-spin' : ''} />
                  {cinnaReauth.isPending ? 'Re-authenticating…' : 'Re-authenticate'}
                </button>
                {reauthError && (
                  <div className="mt-1.5 text-[12px] text-[var(--color-danger)]">{reauthError}</div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {groups.length === 0 ? <p className="py-4 text-xs text-[var(--color-text-muted)]">No agents found on this Cinna server. Click Sync to refresh.</p> : (
        <div className="space-y-4">
          {groups.map((group) => <section key={group.label}>
            <h2 className="mb-2 text-xs font-medium text-[var(--color-text-muted)]">{group.label}</h2>
            <div className="divide-y divide-[var(--color-border)] overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
              {group.agents.map((agent) => <AgentVisibilityRow key={agent.id} agent={agent} />)}
            </div>
          </section>)}
        </div>
      )}
    </div>
  )
}
