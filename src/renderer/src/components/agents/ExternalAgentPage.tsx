import { useState } from 'react'
import { Code2, MessageSquare, Settings } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { useAgents } from '../../hooks/useAgents'
import { useUIStore } from '../../stores/ui.store'
import { useAuthStore } from '../../stores/auth.store'
import { useLocalDevStore } from '../../stores/localDev.store'
import { AgentTypeIcon } from './AgentTypeIcon'
import { ExternalAgentActionsMenu } from './ExternalAgentActionsMenu'
import { AgentCard } from '../settings/AgentCard'
import { CustomAgentModal } from './CustomAgentModal'
import { AgentInterfaceTab } from './AgentInterfaceTab'
import { SettingsButton, SettingsCard, SettingsRow, SettingsRows, SettingsSection } from '../settings/SettingsLayout'
import { ManagedAgentModal } from './ManagedAgentModal'
import { ChatWorkspace } from '../layout/ChatWorkspace'
import { canDevelopAgent, serverLabel } from '../../utils/agentNavigation'
import { unwrapIpcError } from '../../utils/ipcError'
import { describeOpenExternalFailure } from '../../hooks/useSystem'

/** All non-folder agents share a chat landing page and a separate settings mode. */
export function ExternalAgentPage(): React.JSX.Element {
  const activeId = useUIStore((s) => s.activeExternalAgentId)
  const mode = useUIStore((s) => s.agentPageMode)
  const setMode = useUIStore((s) => s.setAgentPageMode)
  const profile = useAuthStore((s) => s.currentUser)
  const localDev = useLocalDevStore((s) => s.state)
  const queryClient = useQueryClient()
  const { data: agents, isLoading, error } = useAgents()
  const agent = agents?.find((item) => item.id === activeId && item.source !== 'folder')
  const settingsMode = mode === 'settings' && !agent?.development
  const [editing, setEditing] = useState<string | null>(null)
  const [developing, setDeveloping] = useState<string | null>(null)
  const [developmentError, setDevelopmentError] = useState<{ id: string; message: string } | null>(null)
  const [tab, setTab] = useState('overview')

  const develop = async (): Promise<void> => {
    if (!agent || developing) return
    const id = agent.id, profileId = profile?.id
    setDeveloping(id)
    setDevelopmentError(null)
    try {
      const result = await window.api.localDev.developAgent(id)
      if (useAuthStore.getState().currentUser?.id !== profileId) return
      await queryClient.invalidateQueries({ queryKey: ['agents'] })
      if (useUIStore.getState().activeExternalAgentId !== id) return
      const ui = useUIStore.getState()
      ui.setActiveExternalAgentId(result.agentId)
      ui.setAgentPageMode('chat')
    } catch (err) {
      setDevelopmentError({ id, message: unwrapIpcError(err, 'Could not prepare local development.') })
    } finally { setDeveloping(null) }
  }

  return (
    <div className="flex flex-1 flex-col overflow-y-auto pt-[var(--topbar-h)] [scrollbar-gutter:stable]">
      <div data-sidebar-band-limit className="mx-auto flex w-full max-w-3xl flex-1 flex-col space-y-4 px-6 py-6">
        {agent ? <>
          <header className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <h1 className="flex items-center gap-2 text-xl font-semibold"><AgentTypeIcon agent={agent} size={18} /><span className="truncate">{agent.name}</span></h1>
              {agent.description && <p className="mt-1 text-xs text-[var(--color-text-secondary)] line-clamp-2">{agent.description}</p>}
              <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">{agent.source === 'remote' && profile?.cinnaServerUrl
                ? <a href={profile.cinnaServerUrl} onClick={(event) => {
                    event.preventDefault()
                    void window.api.system.openExternal(profile.cinnaServerUrl!).then((result) => {
                      if (!result.success) setDevelopmentError({ id: agent.id, message: describeOpenExternalFailure(result.error) })
                    }).catch((err) => setDevelopmentError({ id: agent.id, message: unwrapIpcError(err, 'Could not open the Cinna server.') }))
                  }}>{serverLabel(profile.cinnaServerUrl)}</a>
                : agent.driver === 'managed' ? 'Claude workspace' : agent.protocol.toUpperCase()}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {localDev.phase === 'ready' && canDevelopAgent(agent) && <button type="button" disabled={!!developing} onClick={() => void develop()} className="flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] disabled:opacity-50"><Code2 size={13} />{developing === agent.id ? 'Preparing…' : 'Develop'}</button>}
              <button type="button" onClick={() => {
                if (agent.development) { useLocalDevStore.getState().setPageMode('settings'); useUIStore.getState().setActiveView('local-development'); return }
                setMode(settingsMode ? 'chat' : 'settings')
              }} className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                settingsMode
                  ? 'border-transparent bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)]'
                  : 'ambient-button border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'
              }`}>
                {settingsMode ? <MessageSquare size={13} /> : <Settings size={13} />}{settingsMode ? 'Start chat' : 'Settings'}
              </button>
              <ExternalAgentActionsMenu key={`${profile?.id}:${agent.id}`} agent={agent} onError={(message) => setDevelopmentError(message ? { id: agent.id, message } : null)} />
            </div>
          </header>
          {developmentError?.id === agent.id && <p role="alert" className="text-xs text-[var(--color-danger)]">{developmentError.message}</p>}
          <div hidden={settingsMode} className={settingsMode ? undefined : 'flex flex-1 flex-col'}><ChatWorkspace key={`${profile?.id}:${agent.id}`} agentId={agent.id} embedded /></div>
          {settingsMode && <>
            <nav role="tablist" aria-label="Agent settings" className="flex gap-1 border-b border-[var(--color-border)]">
              {['overview', 'connection', 'interface'].map((id) => <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={`border-b-2 px-3 py-2 text-xs font-medium ${tab === id ? 'border-[var(--color-accent)] text-[var(--color-text)]' : 'border-transparent text-[var(--color-text-muted)]'}`}>{id === 'overview' ? 'Overview' : id === 'connection' ? 'Connection' : 'Interface'}</button>)}
            </nav>
            <div role="tabpanel" className="space-y-6">
              {tab === 'interface' ? <AgentInterfaceTab key={agent.id} agent={agent} /> : tab === 'overview' ? <>
                <SettingsSection title="About this agent">
                  <SettingsCard>
                    <p className="text-[13px] text-[var(--color-text-secondary)]">{agent.description || 'No description provided.'}</p>
                    <p className="mt-1 text-[13px] text-[var(--color-text-muted)]">{!agent.enabled ? 'Disabled in Desktop App' : agent.readiness?.reason || (agent.readiness?.state === 'ok' ? 'Ready to chat' : 'Status not checked yet')}</p>
                  </SettingsCard>
                </SettingsSection>
                {!!agent.skills?.length && <SettingsSection title="Skills">
                  <SettingsRows>
                    {agent.skills.map((skill) => <SettingsRow key={skill.id}>
                      <h3 className="text-[13px] font-medium text-[var(--color-text)]">{skill.name}</h3>
                      {skill.description && <p className="mt-0.5 text-[13px] text-[var(--color-text-muted)]">{skill.description}</p>}
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
