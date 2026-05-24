import { useState } from 'react'
import { Plus, RefreshCw, AlertTriangle } from 'lucide-react'
import { AgentCard } from './AgentCard'
import { A2AAgentForm } from './A2AAgentForm'
import { useAgents, useRemoteSyncStatus, useSyncRemoteAgents } from '../../hooks/useAgents'
import { useCinnaReauth } from '../../hooks/useAuth'
import { useAuthStore } from '../../stores/auth.store'

const REMOTE_SECTION_LABELS: Record<string, string> = {
  agent: 'My Agents',
  app_mcp_route: 'Shared with Me',
  identity: 'People'
}

type RemoteAgent = NonNullable<ReturnType<typeof useAgents>['data']>[number]

/**
 * Within the "My Agents" group (target_type='agent'), a row can be either
 * an agent the user authored themselves (publisher install or an
 * unpublished agent) or a bundle install obtained through the catalog. The
 * cinna-server `/external/agents` response carries `bundle_uuid` and
 * `is_publisher_install` under `metadata` so we can split them locally.
 */
function isCatalogInstall(agent: RemoteAgent): boolean {
  const meta = agent.remoteMetadata ?? null
  if (!meta) return false
  const bundleUuid = meta.bundle_uuid
  const isPublisher = meta.is_publisher_install === true
  return typeof bundleUuid === 'string' && bundleUuid.length > 0 && !isPublisher
}

interface Props {
  /**
   * 'default' — shared local A2A agents (settings → Default group).
   * 'profile' — remote agents synced from the active Cinna account
   *             (settings → Profile group).
   */
  scope?: 'default' | 'profile'
}

export function AgentsSettingsSection({ scope = 'default' }: Props): React.JSX.Element {
  if (scope === 'profile') return <ProfileAgentsSection />
  return <DefaultAgentsSection />
}

function DefaultAgentsSection(): React.JSX.Element {
  const { data: agents } = useAgents()
  const [showAdd, setShowAdd] = useState(false)

  const localAgents = (agents ?? []).filter(
    (a) => a.source === 'local' && a.protocol === 'a2a'
  )

  return (
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
  )
}

function ProfileAgentsSection(): React.JSX.Element {
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

  const remoteAgents = (agents ?? []).filter((a) => a.source === 'remote')

  // Group remote agents by target type
  const remoteByType = remoteAgents.reduce<Record<string, typeof remoteAgents>>((acc, a) => {
    const key = a.remoteTargetType ?? 'agent'
    ;(acc[key] ??= []).push(a)
    return acc
  }, {})
  const remoteTypeOrder = ['agent', 'app_mcp_route', 'identity']

  if (!isCinnaUser) {
    return (
      <div className="text-xs text-[var(--color-text-muted)]">
        Remote agents are available when signed in to a Cinna account.
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] text-[var(--color-text-muted)]">
          Synced from your Cinna account
        </span>
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
                  className="mt-1.5 inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium
                    bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white transition-colors
                    disabled:opacity-50"
                >
                  <RefreshCw size={10} className={cinnaReauth.isPending ? 'animate-spin' : ''} />
                  {cinnaReauth.isPending ? 'Re-authenticating…' : 'Re-authenticate'}
                </button>
                {reauthError && (
                  <div className="mt-1.5 text-[10px] text-[var(--color-danger)]">{reauthError}</div>
                )}
              </>
            )}
          </div>
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
            .map((type) => {
              const rows = remoteByType[type]
              // For target_type='agent' split into "Created by me" vs
              // "Installed from catalog" so the user can see at a glance
              // which agents originate from a bundle install.
              if (type === 'agent') {
                const own = rows.filter((a) => !isCatalogInstall(a))
                const installed = rows.filter(isCatalogInstall)
                return (
                  <div key={type} className="space-y-3">
                    <div className="text-[10px] font-medium text-[var(--color-text-muted)] mb-1.5 pl-1">
                      {REMOTE_SECTION_LABELS[type]}
                    </div>
                    {own.length > 0 && (
                      <div>
                        <div className="text-[10px] font-medium text-[var(--color-text-secondary)] mb-1.5 pl-1">
                          Created by me
                        </div>
                        <div className="space-y-2">
                          {own.map((agent) => (
                            <AgentCard key={agent.id} agent={agent} />
                          ))}
                        </div>
                      </div>
                    )}
                    {installed.length > 0 && (
                      <div>
                        <div className="text-[10px] font-medium text-[var(--color-text-secondary)] mb-1.5 pl-1">
                          Installed from catalog ({installed.length})
                        </div>
                        <div className="space-y-2">
                          {installed.map((agent) => (
                            <AgentCard key={agent.id} agent={agent} />
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )
              }
              return (
                <div key={type}>
                  <div className="text-[10px] font-medium text-[var(--color-text-muted)] mb-1.5 pl-1">
                    {REMOTE_SECTION_LABELS[type] ?? type}
                  </div>
                  <div className="space-y-2">
                    {rows.map((agent) => (
                      <AgentCard key={agent.id} agent={agent} />
                    ))}
                  </div>
                </div>
              )
            })}
        </div>
      )}
    </div>
  )
}
