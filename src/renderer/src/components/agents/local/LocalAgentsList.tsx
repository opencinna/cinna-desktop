import { useCallback, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { MessageSquare, Plus } from 'lucide-react'
import { useUIStore } from '../../../stores/ui.store'
import { useAgentsHomeStore } from '../../../stores/agentsHome.store'
import {
  useAgentsHomeQuestion,
  useLocalAgents
} from '../../../hooks/useLocalAgents'
import { useAppSettings } from '../../../hooks/useAppSettings'
import { groupAgentsByRoot } from '../../../utils/localAgents'
import type { LocalAgentDto } from '../../../../../shared/localAgents'
import { NewLocalAgentModal } from './NewLocalAgentModal'
import { ManagedAgentModal } from '../ManagedAgentModal'
import { CustomAgentModal } from '../CustomAgentModal'
import { useAgents } from '../../../hooks/useAgents'
import { A2AAgentForm } from '../../settings/A2AAgentForm'
import { serverLabel } from '../../../utils/agentNavigation'
import { AgentTypeIcon } from '../AgentTypeIcon'
import { useAuthStore } from '../../../stores/auth.store'
import { CatalogBrowserModal } from '../CatalogBrowserModal'
import { useCatalogInstall } from '../../../hooks/useCatalogInstall'
import { landCatalogInstall } from '../../../stores/catalogInstall.store'

function AgentChatShortcut({ agentId, name, available = true }: {
  agentId: string
  name: string
  available?: boolean
}): React.JSX.Element {
  const setActiveView = useUIStore((s) => s.setActiveView)
  const setPendingAgentId = useUIStore((s) => s.setPendingAgentId)
  const setSidebarTab = useUIStore((s) => s.setSidebarTab)
  return (
    <span className="inline-flex items-center justify-center w-4 h-4 shrink-0 ml-1.5 mr-2.5 my-1.5">
      {available && <button
        type="button"
        onClick={(event) => {
          event.stopPropagation()
          setActiveView('chat')
          setPendingAgentId(agentId)
          setSidebarTab('chats')
        }}
        className="inline-flex items-center justify-center w-4 h-4 rounded
          opacity-0 group-hover:opacity-100 focus-visible:opacity-100
          bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white
          transition-opacity shrink-0"
        title={`Start a new chat with ${name}`}
        aria-label={`Start a new chat with ${name}`}
      >
        <MessageSquare size={10} />
      </button>}
    </span>
  )
}

function AgentRow({ agent }: { agent: LocalAgentDto }): React.JSX.Element {
  const activeLocalAgentId = useUIStore((s) => s.activeLocalAgentId)
  const setAgentPageMode = useUIStore((s) => s.setAgentPageMode)
  const activeView = useUIStore((s) => s.activeView)
  const setActiveLocalAgentId = useUIStore((s) => s.setActiveLocalAgentId)
  const setActiveView = useUIStore((s) => s.setActiveView)
  const isActive = activeLocalAgentId === agent.id && activeView === 'local-agent'
  // No chat button on a row the chat could not attach to. A duplicate-id
  // folder is listed but never indexed, so the new-chat screen would look the
  // agent up, find nothing and show nothing — the click would fail silently.
  // An invalid manifest cannot run either. The jobs row withholds run-now for
  // the same reason; the agent page explains its readiness.
  const canChat = agent.readiness !== 'invalid'

  const openPage = (): void => {
    setAgentPageMode('chat')
    setActiveLocalAgentId(agent.id)
    setActiveView('local-agent')
  }

  // The row and its chat button are siblings under one hover group, not a
  // button inside a button. Nesting would have made the row a `div`, and an
  // `aria-label`led button inside a `role="button"` joins the row's accessible
  // name while it is rendered — the row would be "Alpha" at rest and "Alpha
  // Start a new chat with Alpha" under the pointer, which is where every E2E
  // locator finds it. As a sibling the button lends the row nothing and can
  // stay in the tree, so a keyboard user reaches it by Tab.
  return (
    <div
      // The click lives on the wrapper so the whole highlighted row opens the
      // page, gap and trailing slot included, as the jobs row does. The inner
      // `<button>` is the accessible control; its own clicks — from the
      // pointer or from Enter — bubble up here.
      onClick={openPage}
      className={`group flex items-start rounded-md cursor-pointer transition-colors ${
        isActive
          ? 'app-nav-active text-[var(--color-text)]'
          : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]'
      }`}
    >
      <button
        type="button"
        className="min-w-0 flex-1 text-left flex items-start gap-1.5 pl-2.5 py-1.5 rounded-md"
      >
        <AgentTypeIcon agent={{ source: 'folder' }} className="mt-0.5" />
        <span className="min-w-0 flex-1 truncate text-xs">{agent.name}</span>
      </button>
      {/*
        A trailing 16x16 slot the row always has, so the name truncates at the
        same point whether or not the chat button is in it: nothing shifts under
        the pointer that just arrived (ux_rules rule 1). It mirrors the jobs
        row's run-now button and does what the page's "Start chat" does.
      */}
      <AgentChatShortcut agentId={agent.id} name={agent.name} available={canChat} />
    </div>
  )
}

function ExternalAgentRow({ agent, active, onClick }: {
  agent: Awaited<ReturnType<typeof window.api.agents.list>>[number]
  active: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <div onClick={onClick}
      className={`group flex w-full min-w-0 items-start rounded-md cursor-pointer transition-colors ${
        active
          ? 'app-nav-active text-[var(--color-text)]'
          : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]'
      }`}>
      <button type="button" className="flex min-w-0 flex-1 items-start gap-1.5 rounded-md pl-2.5 py-1.5 text-left">
        <AgentTypeIcon agent={agent} className="mt-0.5" />
        <span className="min-w-0 flex-1 truncate text-xs">{agent.name}</span>
      </button>
      <AgentChatShortcut agentId={agent.id} name={agent.name} available={agent.enabled} />
    </div>
  )
}

/**
 * The Agents tab's sidebar list: every folder agent, grouped by the root it
 * lives in — the default home first, then any folder the user added, followed
 * by ACP and managed agents. The default home is labelled "Local".
 */
export function LocalAgentsList(): React.JSX.Element {
  const { data, isLoading, error } = useLocalAgents()
  const { data: settings } = useAppSettings()
  const showSections = settings?.showAgentSidebarSections !== false
  const activeExternalAgentId = useUIStore((s) => s.activeExternalAgentId)
  const setAgentPageMode = useUIStore((s) => s.setAgentPageMode)
  const activeView = useUIStore((s) => s.activeView)
  const setActiveExternalAgentId = useUIStore((s) => s.setActiveExternalAgentId)
  const setActiveView = useUIStore((s) => s.setActiveView)
  const [addingA2A, setAddingA2A] = useState(false)
  const [creating, setCreating] = useState(false)
  const [managed, setManaged] = useState<string | true | null>(null)
  const [custom, setCustom] = useState<string | true | null>(null)
  const profile = useAuthStore((state) => state.currentUser)
  const profileId = profile?.id
  const isCinna = useAuthStore((s) => s.currentUser?.type === 'cinna_user')
  const [catalogOpen, setCatalogOpen] = useState(false)
  // A catalog opened under one account is not the next account's: close it on
  // a profile switch (adjusting state during render, not in an effect).
  const [catalogProfileId, setCatalogProfileId] = useState(profileId)
  if (catalogProfileId !== profileId) {
    setCatalogProfileId(profileId)
    setCatalogOpen(false)
  }
  const queryClient = useQueryClient()
  const openExternalAgent = useCallback(
    (agentId: string): void => {
      setAgentPageMode('chat')
      setActiveExternalAgentId(agentId)
      setActiveView('external-agent')
    },
    [setAgentPageMode, setActiveExternalAgentId, setActiveView]
  )
  /**
   * The catalog install runs in a store, not in the catalog dialog or in this
   * list: the user may close the dialog, or switch sidebar tabs (which
   * unmounts this list), mid-install, and the landing must still happen. The
   * landing — open the agent, raise the setup dialog if its credentials are
   * incomplete — touches only stores, so it runs either way; closing the
   * dialog is this list's own state and only matters while it is mounted.
   */
  const catalogInstall = useCatalogInstall({
    onInstalled: () => setCatalogOpen(false),
    onInstalledDetached: (agentId, result) => landCatalogInstall(queryClient, agentId, result)
  })
  const { clearError: clearCatalogError } = catalogInstall
  /** A stale install error belongs to the last visit, not the next one. */
  const openCatalog = (): void => {
    clearCatalogError()
    setCatalogOpen(true)
  }
  const closeCatalog = (): void => {
    setCatalogOpen(false)
    clearCatalogError()
  }
  const { data: agentData } = useAgents()
  const allAgents = agentData?.filter((agent) => agent.source !== 'remote' || agent.enabled !== false)
  const remoteAgents = profile?.type === 'cinna_user' ? (allAgents ?? []).filter((agent) => agent.source === 'remote') : []
  const a2aAgents = (allAgents ?? []).filter((agent) => agent.source === 'local' && agent.protocol === 'a2a')
  const managedAgents = (allAgents ?? []).filter((agent) => agent.driver === 'managed')
  const [remoteAcp, setRemoteAcp] = useState(false)
  const commandAgents = (allAgents ?? []).filter((agent) => agent.driver === 'acp' && agent.capabilities.cwd === false)
  const groups = useMemo(
    () => groupAgentsByRoot(data?.roots ?? [], data?.agents ?? []),
    [data]
  )
  const total = data?.agents.length ?? 0
  const homeAccess = useAgentsHomeQuestion()
  // Folder setup is requested only by the folder creation choice. External
  // agents have no local agents-home prerequisite.

  const renderGroup = ({ root, agents }: ReturnType<typeof groupAgentsByRoot>[number]): React.JSX.Element => (

              <div key={root.id}>
                {showSections && (root.isDefault || groups.length > 1 || !root.exists) && (
                  <div
                    className="px-1 pb-0.5 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)] truncate"
                    title={root.path}
                  >
                    {root.isDefault ? 'Local' : root.label}
                    {!root.exists && ' — missing'}
                  </div>
                )}
                {agents.length === 0 ? (showSections &&
                  <div className="px-2.5 py-1 text-[10px] text-[var(--color-text-muted)] italic">
                    Empty
                  </div>
                ) : (
                  <div className={showSections ? 'space-y-px' : undefined}>
                    {agents.map((agent) => (
                      <AgentRow
                        key={agent.id}
                        agent={agent}
                      />
                    ))}
                  </div>
                )}
              </div>
  )

  const renderExternalGroup = (label: string, agents: typeof remoteAgents): React.JSX.Element => (
    <div className={showSections ? 'px-1.5 py-1 space-y-px' : 'px-1.5'}>
      {showSections && <div className="px-2.5 pb-1 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)] truncate">{label}</div>}
      {agents.map((agent) => <ExternalAgentRow key={agent.id} agent={agent}
        active={activeView === 'external-agent' && activeExternalAgentId === agent.id}
        onClick={() => openExternalAgent(agent.id)}
      />)}
    </div>
  )

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 pt-1 pb-1">
        <span className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
          Agents
        </span>
        <button
          onClick={() => setCreating(true)}
          className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
          // Not "New agent" any more: this opens a choice between scaffolding
          // one and pointing at a folder that already is one. It also has to
          // differ from the "New agent" card the dialog then shows, or the two
          // are one ambiguous name to a screen reader and to every test.
          //
          // With no agents folder it raises the folder question instead. The
          // dialog it would otherwise open offers to "create a folder in your
          // agents folder" — the one that does not exist — so the click ends in
          // a step that cannot finish, which is the same dead end the empty
          // state below exists to prevent (ux_rules rule 9).
          title="Add an agent"
          aria-label="Add an agent"
        >
          <Plus size={14} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="px-2.5 py-2 text-xs text-[var(--color-text-muted)]">Loading...</div>
        ) : error ? (
          <div className="px-2.5 py-2 text-[10px] text-[var(--color-danger)]">
            {error instanceof Error ? error.message : 'Could not read the agents folder.'}
          </div>
        ) : homeAccess && homeAccess !== 'ready' ? (
          /* An empty list here is not "no agents yet" — the folder they would
             live in has not been made. Saying the wrong one of those sends the
             user to a `+` that opens a dialog which cannot finish (ux_rules
             rule 9). The button is the way back from the modal's "Not now". */
          <div className="px-2.5 py-6 text-center text-xs text-[var(--color-text-muted)] space-y-2">
            <div>Folder agents need a home.</div>
            {/* Named for the question it opens, not for the button inside it.
                "Choose folder…" belongs to the control that opens the OS
                picker; a trigger one click away wearing the same name is two
                actions under one name, and one locator matching both
                (ux_rules rule 10). */}
            <button
              onClick={() => useAgentsHomeStore.getState().reopen(homeAccess)}
              className="text-xs font-medium text-[var(--color-accent)] hover:underline"
            >
              {homeAccess === 'denied' ? 'Pick another folder' : 'Set one up'}
            </button>
          </div>
        ) : total === 0 && groups.length <= 1 ? (
          (showSections || managedAgents.length + commandAgents.length + a2aAgents.length + remoteAgents.length === 0) && <div className="px-2.5 py-6 text-center text-xs text-[var(--color-text-muted)]">
            {managedAgents.length + commandAgents.length + a2aAgents.length + remoteAgents.length ? 'No folder agents yet' : 'No agents yet — click + to add one'}
          </div>
        ) : (
          <div className={showSections ? 'px-1.5 py-1 space-y-2' : 'px-1.5'}>
            {groups.filter(({ root }) => root.isDefault).map(renderGroup)}
          </div>
        )}
        {remoteAgents.length > 0 && renderExternalGroup(serverLabel(profile?.cinnaServerUrl), remoteAgents)}
        {groups.some(({ root }) => !root.isDefault) && <div className={showSections ? 'px-1.5 py-1 space-y-2' : 'px-1.5'}>{groups.filter(({ root }) => !root.isDefault).map(renderGroup)}</div>}
        {a2aAgents.length > 0 && renderExternalGroup('A2A agents', a2aAgents)}
        {commandAgents.length > 0 && renderExternalGroup('ACP agents', commandAgents)}
        {managedAgents.length > 0 && renderExternalGroup('Managed', managedAgents)}
      </div>

      {creating && <NewLocalAgentModal onClose={() => setCreating(false)} onCatalog={isCinna ? () => { setCreating(false); openCatalog() } : undefined} onA2A={() => { setCreating(false); setAddingA2A(true) }} onManaged={() => { setCreating(false); setManaged(true) }} onCustom={() => { setCreating(false); setCustom(true) }} onRemoteAcp={() => { setCreating(false); setRemoteAcp(true) }} onCreateFolder={() => {
        if (homeAccess && homeAccess !== 'ready') { setCreating(false); useAgentsHomeStore.getState().reopen(homeAccess); return false }
        return true
      }} />}
      {catalogOpen && isCinna && (
        <CatalogBrowserModal
          onClose={closeCatalog}
          installingBundleId={catalogInstall.installingBundleId}
          installError={catalogInstall.error}
          onInstall={catalogInstall.install}
          onOpen={(agentId) => {
            closeCatalog()
            openExternalAgent(agentId)
          }}
        />
      )}
      {addingA2A && <A2AAgentForm key={profileId} onClose={() => setAddingA2A(false)} />}
      {remoteAcp && <CustomAgentModal remote onClose={() => setRemoteAcp(false)} />}
      {custom !== null && <CustomAgentModal key={`${profileId}:${custom}`} agentId={typeof custom === 'string' ? custom : undefined} onClose={() => setCustom(null)} />}
      {managed !== null && <ManagedAgentModal key={`${profileId}:${managed}`} agentId={typeof managed === 'string' ? managed : undefined} onClose={() => setManaged(null)} />}
    </div>
  )
}
