import { useId, useState } from 'react'
import { AlertTriangle, RefreshCw, Settings2 } from 'lucide-react'
import { AgentTypeIcon } from '../agents/AgentTypeIcon'
import { useAgentDesktopVisibility } from '../../hooks/useAgentDesktopVisibility'
import { useUIStore } from '../../stores/ui.store'
import { serverLabel } from '../../utils/agentNavigation'
import { unwrapIpcError } from '../../utils/ipcError'
import { useAgents, useRemoteSyncStatus, useSyncRemoteAgents } from '../../hooks/useAgents'
import { useCinnaReauth } from '../../hooks/useAuth'
import { useAuthStore } from '../../stores/auth.store'
import { SettingsButton, SettingsIconButton, SettingsInfoTip, SettingsSection, SettingsSwitch } from './SettingsLayout'

type RemoteAgent = NonNullable<ReturnType<typeof useAgents>['data']>[number]

/**
 * One Cinna server agent as a settings card (the Expandable Card Pattern's
 * shell, with nothing to expand): its type, name and what it is, a way to
 * its settings page while it is shown, and the switch that shows or hides it
 * in Desktop. The settings slot is held while it is hidden, so the switch
 * never moves under the pointer (ux_rules rule 1).
 */
function AgentVisibilityRow({ agent }: { agent: RemoteAgent }): React.JSX.Element {
  const visibility = useAgentDesktopVisibility()
  const [error, setError] = useState<string | null>(null)
  const openSettings = `Open ${agent.name} settings`
  const switchId = useId()
  return <div data-remote-agent={agent.id} className="overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
    <div className="flex items-center gap-2 px-4 py-2.5">
      <div className={`flex min-w-0 flex-1 items-center gap-2 ${agent.enabled ? '' : 'opacity-50'}`}>
        <AgentTypeIcon agent={agent} agentId={agent.id} size={16} />
        {/* The description gives way first, then the name: neither runs under the controls. */}
        <span className="min-w-0 truncate text-[14px] font-medium text-[var(--color-text)]" title={agent.name}>{agent.name}</span>
        <span className="min-w-0 shrink-[1000] truncate text-[13px] text-[var(--color-text-muted)]">
          {agent.enabled ? agent.description || 'Shown in Desktop' : 'Hidden from Desktop'}
        </span>
      </div>
      {agent.enabled ? (
        <SettingsIconButton
          title={openSettings}
          aria-label={openSettings}
          onClick={() => {
            const ui = useUIStore.getState()
            ui.setActiveExternalAgentId(agent.id)
            ui.setAgentPageMode('settings')
            ui.setSidebarTab('agents')
            ui.setActiveView('external-agent')
          }}
        >
          <Settings2 size={14} aria-hidden="true" />
        </SettingsIconButton>
      ) : (
        <span aria-hidden="true" className="h-7 w-7 shrink-0" />
      )}
      {/* Named for what it sets, the same on or off; its state is the switch's own. */}
      <label htmlFor={switchId} className="sr-only">{`Show ${agent.name} in Desktop`}</label>
      <SettingsSwitch
        id={switchId}
        checked={agent.enabled}
        disabled={visibility.isPending}
        title={agent.enabled ? 'Shown in Desktop' : 'Hidden from Desktop'}
        onToggle={() => {
          setError(null)
          visibility.setVisible(agent, !agent.enabled, (err) => setError(unwrapIpcError(err, 'Could not update agent.')))
        }}
      />
    </div>
    {/* Last in the card: a refusal moves nothing above it. */}
    {error && <p role="alert" className="border-t border-[var(--color-border)] px-4 py-2 text-[13px] text-[var(--color-danger)]">{error}</p>}
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

  if (!isCinnaUser) return <p className="text-[13px] text-[var(--color-text-muted)]">Connect a Cinna profile to manage its agents.</p>

  const label = serverLabel(currentUser?.cinnaServerUrl)
  return (
    <div className="space-y-6">
      {(groups.length > 0 ? groups : [{ label, agents: [] as RemoteAgent[] }]).map((group) => (
        <SettingsSection
          key={group.label}
          title={group.label}
          info={
            <SettingsInfoTip label={`About ${group.label}`}>
              Synced from your Cinna account. Choose which agents from this Cinna server appear in Desktop. Hidden agents stay here so you can enable them again.
            </SettingsInfoTip>
          }
          action={
            <SettingsButton onClick={() => syncRemote.mutate()} disabled={syncRemote.isPending} aria-busy={syncRemote.isPending}>
              <RefreshCw size={13} className={syncRemote.isPending ? 'animate-spin' : ''} aria-hidden="true" />
              Sync
            </SettingsButton>
          }
        >
          {group.agents.length === 0 ? (
            <p className="text-[13px] text-[var(--color-text-muted)]">No agents found on this Cinna server. Click Sync to refresh.</p>
          ) : (
            <div className="space-y-2">
              {group.agents.map((agent) => <AgentVisibilityRow key={agent.id} agent={agent} />)}
            </div>
          )}
          {/* Last in the section: a sync failing moves none of the switches above it. */}
          {syncStatus.error && (
            <div
              className="flex items-start gap-2 rounded-md border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 px-3 py-2.5
                text-[13px] text-[var(--color-text-secondary)]"
            >
              <AlertTriangle size={14} className="mt-0.5 shrink-0 text-[var(--color-danger)]" />
              <div className="min-w-0 flex-1">
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
                      className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-2.5 py-1 text-[13px] font-medium
                        text-white transition-colors hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
                    >
                      <RefreshCw size={12} className={cinnaReauth.isPending ? 'animate-spin' : ''} />
                      {cinnaReauth.isPending ? 'Re-authenticating…' : 'Re-authenticate'}
                    </button>
                    {reauthError && <div className="mt-1.5 text-[13px] text-[var(--color-danger)]">{reauthError}</div>}
                  </>
                )}
              </div>
            </div>
          )}
        </SettingsSection>
      ))}
    </div>
  )
}
