import { useEffect, useState } from 'react'
import { MessageSquare, Settings } from 'lucide-react'
import { useAgents } from '../../hooks/useAgents'
import { useUIStore } from '../../stores/ui.store'
import { useAuthStore } from '../../stores/auth.store'
import { useLocalDevStore } from '../../stores/localDev.store'
import { AgentTypeIcon } from './AgentTypeIcon'
import { ExternalAgentActionsMenu } from './ExternalAgentActionsMenu'
import { AgentDetailsButton } from './AgentDetailsButton'
import { AgentCard } from '../settings/AgentCard'
import { CustomAgentModal } from './CustomAgentModal'
import { AgentInterfaceTab } from './AgentInterfaceTab'
import { CloudAgentDashboardsTab } from '../dashboards/AgentDashboardsTab'
import { SettingsButton, SettingsCard, SettingsRow, SettingsRows, SettingsSection } from '../settings/SettingsLayout'
import { ManagedAgentModal } from './ManagedAgentModal'
import { ChatWorkspace } from '../layout/ChatWorkspace'
import { canDevelopAgent, serverLabel } from '../../utils/agentNavigation'
import { unwrapIpcError } from '../../utils/ipcError'
import { describeOpenExternalFailure } from '../../hooks/useSystem'

type Agent = Awaited<ReturnType<typeof window.api.agents.list>>[number]

const TAB_LABELS: Record<string, string> = { overview: 'Overview', connection: 'Connection', interface: 'Interface', dashboards: 'Dashboards' }

/** All non-folder agents share a chat landing page and a separate settings mode. */
export function ExternalAgentPage(): React.JSX.Element {
  const activeId = useUIStore((s) => s.activeExternalAgentId)
  const mode = useUIStore((s) => s.agentPageMode)
  const setMode = useUIStore((s) => s.setAgentPageMode)
  const profile = useAuthStore((s) => s.currentUser)
  const { data: agents, isLoading, error } = useAgents()
  const agent = agents?.find((item) => item.id === activeId && item.source !== 'folder')
  const settingsMode = mode === 'settings' && !agent?.development
  const [editing, setEditing] = useState<string | null>(null)
  const [developmentError, setDevelopmentError] = useState<{ id: string; message: string } | null>(null)
  // A tab another surface asked for (a tile's Open agent: Dashboards) wins at first paint, as on the folder page.
  const tabRequest = useUIStore((s) => s.agentPageTabRequest)
  const setTabRequest = useUIStore((s) => s.setAgentPageTabRequest)
  const [tab, setTab] = useState<string>(() => tabRequest ?? 'overview')
  useEffect(() => {
    if (!tabRequest) return
    setTab(tabRequest)
    setTabRequest(null)
  }, [tabRequest, setTabRequest])
  // Dashboards only for the profile's own cloud agents: core's component routes are owner-only (D6.9).
  const tabs = agent && canDevelopAgent(agent) ? ['overview', 'connection', 'interface', 'dashboards'] : ['overview', 'connection', 'interface']
  // A tab this agent does not have (another agent's, or a folder agent's Credentials) shows Overview.
  const shownTab = tabs.includes(tab) ? tab : 'overview'

  return (
    <div className="flex flex-1 flex-col overflow-y-auto pt-[var(--topbar-h)] [scrollbar-gutter:stable]">
      <div data-sidebar-band-limit className="mx-auto flex w-full max-w-3xl flex-1 flex-col space-y-4 px-6 py-6">
        {agent ? <>
          {/* Keyed once here, not per child: everything in the header remounts when the agent or
              profile changes. Two siblings sharing a key left a stale Details button per switch. */}
          <ExternalAgentHeader
            key={`${profile?.id}:${agent.id}`}
            agent={agent}
            serverUrl={agent.source === 'remote' ? profile?.cinnaServerUrl ?? null : null}
            settingsMode={settingsMode}
            onToggleSettings={() => setMode(settingsMode ? 'chat' : 'settings')}
            onError={(message) => setDevelopmentError(message ? { id: agent.id, message } : null)}
          />
          {developmentError?.id === agent.id && <p role="alert" className="text-xs text-[var(--color-danger)]">{developmentError.message}</p>}
          <div hidden={settingsMode} className={settingsMode ? undefined : 'flex flex-1 flex-col'}><ChatWorkspace key={`${profile?.id}:${agent.id}`} agentId={agent.id} embedded /></div>
          {settingsMode && <>
            <nav role="tablist" aria-label="Agent settings" className="flex gap-1 border-b border-[var(--color-border)]">
              {tabs.map((id) => <button key={id} type="button" role="tab" aria-selected={shownTab === id} onClick={() => setTab(id)} className={`border-b-2 px-3 py-2 text-xs font-medium ${shownTab === id ? 'border-[var(--color-accent)] text-[var(--color-text)]' : 'border-transparent text-[var(--color-text-muted)]'}`}>{TAB_LABELS[id]}</button>)}
            </nav>
            <div role="tabpanel" className="space-y-6">
              {shownTab === 'interface' ? <AgentInterfaceTab key={agent.id} agent={agent} /> : shownTab === 'dashboards' ? <CloudAgentDashboardsTab key={agent.id} agent={agent} /> : shownTab === 'overview' ? <>
                <SettingsSection title="About this agent">
                  <SettingsCard>
                    <p className="text-[13px] text-[var(--color-text-secondary)]">{agent.description || 'No description provided.'}</p>
                    <p className="mt-1 text-[13px] text-[var(--color-text-muted)]">{!agent.enabled ? 'Disabled in Desktop App' : agent.readiness?.reason || (agent.readiness?.state === 'ok' ? 'Ready to chat' : 'Status not checked yet')}</p>
                  </SettingsCard>
                </SettingsSection>
                {!!agent.skills?.length && <SettingsSection title="Example prompts">
                  <SettingsRows>
                    {agent.skills.map((skill) => <SettingsRow key={skill.id}>
                      <h3 className="text-[13px] font-medium text-[var(--color-text)]">{skill.name}</h3>
                      {skill.description && skill.description.trim() !== skill.name.trim() && <p className="mt-0.5 text-[13px] text-[var(--color-text-muted)]">{skill.description}</p>}
                    </SettingsRow>)}
                  </SettingsRows>
                </SettingsSection>}
              </> : agent.driver === 'managed' || agent.driver === 'acp' ? (
                <SettingsSection title="Connection" action={<SettingsButton onClick={() => setEditing(agent.id)}>Configure</SettingsButton>}>
                  <SettingsCard>
                    <p className="text-[13px] text-[var(--color-text)]">{agent.driver === 'managed' ? 'Claude workspace' : agent.acpTransport === 'websocket' ? 'Remote ACP connection' : 'Command-line connection'}</p>
                  </SettingsCard>
                </SettingsSection>
              ) : <AgentCard key={agent.id} agent={agent} connectionOnly />}
            </div>
          </>}
          {!agent.development && editing === agent.id && (agent.driver === 'managed' ? <ManagedAgentModal key={agent.id} agentId={agent.id} onClose={() => setEditing(null)} /> : <CustomAgentModal key={agent.id} remote={agent.acpTransport === 'websocket'} agentId={agent.id} onClose={() => setEditing(null)} />)}
        </> : <p className="text-sm text-[var(--color-text-muted)]">{isLoading ? 'Loading…' : error ? 'Could not load this agent.' : 'Select an agent from the sidebar.'}</p>}
      </div>
    </div>
  )
}

/**
 * The agent page header. The page keys it by profile and agent, so its children
 * (the Details button's fetch and modal, the ⋯ menu's open state) start fresh
 * per agent without keys of their own — never key a child here.
 */
function ExternalAgentHeader({ agent, serverUrl, settingsMode, onToggleSettings, onError }: {
  agent: Agent
  serverUrl: string | null
  settingsMode: boolean
  onToggleSettings: () => void
  onError: (message: string | null) => void
}): React.JSX.Element {
  return (
    <header className="flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <h1 className="flex items-center gap-2 text-xl font-semibold"><AgentTypeIcon agent={agent} agentId={agent.id} size={18} /><span className="truncate">{agent.name}</span></h1>
        {agent.description && <p className="mt-1 text-xs text-[var(--color-text-secondary)] line-clamp-2">{agent.description}</p>}
        <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">{serverUrl
          ? <a href={serverUrl} onClick={(event) => {
              event.preventDefault()
              void window.api.system.openExternal(serverUrl).then((result) => {
                if (!result.success) onError(describeOpenExternalFailure(result.error))
              }).catch((err) => onError(unwrapIpcError(err, 'Could not open the Cinna server.')))
            }}>{serverLabel(serverUrl)}</a>
          : agent.driver === 'managed' ? 'Claude workspace' : agent.protocol.toUpperCase()}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {/* A Cinna agent's Details page on core: only a synced remote row names a target. */}
        {agent.remoteTargetType === 'agent' && agent.remoteTargetId && (
          <AgentDetailsButton
            target={{ kind: 'agent', remoteAgentId: agent.remoteTargetId }}
            agentName={agent.name}
            className="ambient-button flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium text-[var(--color-text)] transition-colors hover:bg-[var(--color-bg-hover)]"
          />
        )}
        <button type="button" onClick={() => {
          if (agent.development) { useLocalDevStore.getState().setPageMode('settings'); useUIStore.getState().setActiveView('local-development'); return }
          onToggleSettings()
        }} className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
          settingsMode
            ? 'border-transparent bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)]'
            : 'ambient-button border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'
        }`}>
          {settingsMode ? <MessageSquare size={13} /> : <Settings size={13} />}{settingsMode ? 'Start chat' : 'Settings'}
        </button>
        <ExternalAgentActionsMenu agent={agent} onError={onError} />
      </div>
    </header>
  )
}
