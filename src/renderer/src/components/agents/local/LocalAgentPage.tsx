import { ServiceCredentialsTab } from './ServiceCredentialsTab'
import { useCallback, useEffect, useRef, useState } from 'react'
import { MessageSquare, Settings } from 'lucide-react'
import { useUIStore } from '../../../stores/ui.store'
import {
  useAgentsHomeQuestion,
  useDraftLocalAgent,
  useLocalAgent,
  useLocalAgentGrants,
  useOpenAgentPath,
  useRescanLocalAgents,
  useStampAgentIdentity
} from '../../../hooks/useLocalAgents'
import { MANIFEST_FILE } from '../../../../../shared/kit/manifest'
import { bareInstructionsFileList } from '../../../../../shared/localAgents'
import { describedAs } from '../../../utils/localAgents'
import { ChatWorkspace } from '../../layout/ChatWorkspace'
import { RuntimePanel } from './RuntimePanel'
import { ReadinessStrip } from './ReadinessStrip'
import { OpenInMenu } from './OpenInMenu'
import { AgentTypeIcon } from '../AgentTypeIcon'
import { AgentActionsMenu } from './AgentActionsMenu'
import { DescriptionCard, ExamplePromptsCard } from './ManifestCards'
import { BareNameCard, BareReadmeCard } from './BareAgentCards'
import { PromptDocCard } from './PromptDocCard'
import { CommandsCard, StatusCard } from './ReadOnlyCards'
import { PermissionsCard } from './PermissionsCard'
import { FolderTab } from './FolderTab'
import { SchedulesTab } from './SchedulesTab'
import { AgentInterfaceTab } from '../AgentInterfaceTab'
import { AgentAddonsTab, useAddonsBadge } from './AgentAddonsTab'
import { AgentTasksTab, useTasksTabBadge } from './AgentTasksTab'
import { AgentShareBadge } from './sharing/AgentShareBadge'
import { SharingTab } from './sharing/SharingTab'
import { useShareActions } from './sharing/useShareActions'
import { BringTogetherBanner } from './sharing/BringTogetherBanner'
import { useFinishSetup } from './FinishSetupDialog'
import { useListedShareStatus } from '../../../hooks/useSharing'
import { SHARE_UI_TEXT } from '../../../utils/shareText'

export type AgentPageTab = 'overview' | 'addons' | 'commands' | 'schedules' | 'tasks' | 'permissions' | 'folder' | 'credentials' | 'interface' | 'sharing'

const TABS: { id: AgentPageTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  // What the agent runs *with*, beyond its folder: MCP connectors today,
  // catalog plugins and skills later. The prompts it used to hold moved to
  // Overview, which is the tab that says what the agent is.
  { id: 'addons', label: 'Addons' },
  { id: 'credentials', label: 'Credentials' },
  { id: 'commands', label: 'Commands' },
  { id: 'schedules', label: 'Schedules' },
  // The agent's task queue: how its Ready tasks start (Manual / One at a
  // time) and Run next. Every folder agent has one, bare or kit.
  { id: 'tasks', label: 'Tasks' },
  // Permissions is a tab and not a card on Overview: in the common case it is a
  // fixed paragraph identical for every folder agent plus "nothing remembered
  // yet" — knowledge, not a control (rule 2) — and the count badge is what
  // makes a standing grant discoverable without opening it. A tab body also
  // mounts on selection, so its query cannot render an empty state for an agent
  // that has grants.
  { id: 'permissions', label: 'Permissions' },
  { id: 'folder', label: 'Folder' },
  { id: 'interface', label: 'Interface' },
  // Only for a shared agent: where it is shared, who has access, its
  // versions, and Remove sharing. Filtered out below for any other.
  { id: 'sharing', label: SHARE_UI_TEXT.tabLabel }
]


/**
 * The Addons badge's tooltip: what the total is made of, or — when the badge
 * shows the count needing attention — how many of the total that is. Names
 * connectors or skills when the total is only one kind.
 */
function addonsBadgeTitle(count: number, skills: number, problems: number): string {
  const connectors = count - skills
  const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`
  if (problems > 0) {
    const noun = skills === 0 ? 'connector' : connectors === 0 ? 'skill' : 'addon'
    return `${problems} of ${plural(count, noun)} need${problems === 1 ? 's' : ''} attention`
  }
  return [connectors > 0 ? plural(connectors, 'connector') : null, skills > 0 ? plural(skills, 'skill') : null]
    .filter(Boolean)
    .join(', ')
}

/**
 * A folder agent's page.
 *
 * Above the fold: what the user *does* with an agent — open its folder in
 * their own tool, start a chat, and choose what it runs with. The page used to
 * be eleven stacked cards, each a viewer over one file, which was faithful to
 * the folder and useless as a control surface: the runtime picker was the
 * seventh card down. Everything that is information rather than a control now
 * lives under four tabs; what is wrong with the folder (findings, missing
 * credentials, the AI credential) is said by the composer's notice panel.
 *
 * Still a viewer over the folder on disk: every card names the file it reads,
 * the editable ones write straight back through the stamp guard, and there is
 * no state that survives deleting the folder.
 *
 * Chat mode shares the header and runtime controls; details belong to Settings.
 */
export function LocalAgentPage(): React.JSX.Element {
  const activeLocalAgentId = useUIStore((s) => s.activeLocalAgentId)
  const setActiveLocalAgentId = useUIStore((s) => s.setActiveLocalAgentId)
  const pendingDraftAgentId = useUIStore((s) => s.pendingDraftAgentId)
  const setPendingDraftAgentId = useUIStore((s) => s.setPendingDraftAgentId)
  // From the store, not `draft.isPending`: the draft outlives this page, so
  // leaving the agent and coming back must still know it is running.
  const drafting = useUIStore(
    (s) => activeLocalAgentId !== null && s.draftingAgentIds.includes(activeLocalAgentId)
  )
  const mode = useUIStore((s) => s.agentPageMode)
  const setMode = useUIStore((s) => s.setAgentPageMode)
  /** Whether there is an agents folder at all — see the placeholder below. */
  const homeAccess = useAgentsHomeQuestion()
  const { data: agent, isLoading, error } = useLocalAgent(activeLocalAgentId)
  const { data: grants } = useLocalAgentGrants(activeLocalAgentId)
  const addons = useAddonsBadge(activeLocalAgentId, agent?.skills)
  const tasksBadge = useTasksTabBadge(activeLocalAgentId)
  // From the statuses list the sidebar already holds, so whether the Sharing
  // tab and the chat header's badge exist is decided at first paint.
  const listedShare = useListedShareStatus(activeLocalAgentId)
  const draft = useDraftLocalAgent()
  const rescan = useRescanLocalAgents()
  const openPath = useOpenAgentPath()
  const stamp = useStampAgentIdentity()
  // Kept across agents on purpose: someone working through the addons of
  // three agents does not want to click "Addons" three times.
  const [tab, setTab] = useState<AgentPageTab>('overview')
  // One slot for every header action's refusal (Open in, Rescan, Reveal,
  // Terminal, Stamp). Two menus each drawing their own absolutely-positioned
  // message produced two unreadable overlapping boxes; and an old message
  // must not outlive the next action.
  const [actionError, setActionError] = useState<string | null>(null)
  /**
   * The same line, for the one header action whose outcome is worth a sentence
   * without being a failure: "Open .env" falling back to the file manager
   * because nothing on this machine opens `.env`. Muted and `status`, not red
   * and `alert` — the file *was* shown. The two share the slot and clear each
   * other, so the line still says exactly one thing about the last action.
   */
  const [actionNote, setActionNote] = useState<string | null>(null)
  const reportError = useCallback((message: string | null): void => {
    setActionNote(null)
    setActionError(message)
  }, [])
  const reportNote = useCallback((message: string | null): void => {
    setActionError(null)
    setActionNote(message)
  }, [])
  /**
   * Update / Share changes and their dialogs, owned here rather than by the
   * badge or the Sharing tab: clicking the badge switches to settings mode and
   * unmounts it, and a result landing after that — a collision from Update —
   * must still open the conflict dialog. A refusal goes to the Sharing tab's
   * own line while it is open (it registers itself), else to the page's slot.
   */
  const shareErrorSink = useRef<((message: string | null) => void) | null>(null)
  const shareActions = useShareActions(activeLocalAgentId ?? '', {
    onError: (message) => (shareErrorSink.current ?? reportError)(message),
    onNote: reportNote,
    agentName: agent?.name ?? ''
  })
  /**
   * Finish setup, owned here for the same reason: it opens after a Get lands
   * on this page, and must survive switching between chat and settings.
   */
  const finishSetup = useFinishSetup(activeLocalAgentId, agent?.name ?? '')
  const bindShareErrors = useCallback((sink: ((message: string | null) => void) | null): void => {
    shareErrorSink.current = sink
    // The tab's line takes over: a refusal still sitting in the page's slot
    // would otherwise be read twice, once stale, beside the tab's own.
    if (sink) setActionError(null)
  }, [])
  // After the badge's click: focus follows the user to the tab it opened.
  const [focusSharingTab, setFocusSharingTab] = useState(false)
  useEffect(() => {
    if (!focusSharingTab || mode !== 'settings') return
    document.getElementById('agent-tab-sharing')?.focus()
    setFocusSharingTab(false)
  }, [focusSharingTab, mode, tab])

  // A freshly scaffolded agent asks for its one-shot draft here rather than in
  // the form that created it: the call outlives that form, and this is the
  // screen that has somewhere to show its progress and its outcome.
  //
  // The ref is not belt-and-braces. `<StrictMode>` runs mount → cleanup → mount
  // with no render between, so the second invocation still closes over the
  // pre-`null` `pendingDraftAgentId` and fires a second call — two billed
  // single-shots of up to 90s each, whose writes then fight over the same
  // stamps until the loser reports "the draft could not be written" for a
  // folder that drafted fine. A ref is written synchronously and is what the
  // second invocation actually sees; the Zustand setter is not.
  const draftedRef = useRef<string | null>(null)
  useEffect(() => {
    setActionError(null)
    setActionNote(null)
  }, [activeLocalAgentId])
  useEffect(() => {
    if (!pendingDraftAgentId || pendingDraftAgentId !== activeLocalAgentId) return
    if (draftedRef.current === pendingDraftAgentId) return
    draftedRef.current = pendingDraftAgentId
    setPendingDraftAgentId(null)
    draft.mutate(pendingDraftAgentId)
    // `draft` is a stable mutation handle; re-running on its identity would
    // fire the AI call twice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingDraftAgentId, activeLocalAgentId, setPendingDraftAgentId])

  if (!activeLocalAgentId) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-[var(--color-text-muted)]">
        {/* The `+` is the folder question while there is no agents folder, so
            pointing at it as the way to add an agent would name a step that
            cannot finish — the same claim the sidebar's empty state branches
            for (ux_rules rule 9). */}
        {homeAccess && homeAccess !== 'ready'
          ? 'Your agents need a folder before you can add one.'
          : 'Select an agent from the sidebar, or add one with +.'}
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-[var(--color-text-muted)]">
        Loading…
      </div>
    )
  }

  if (error || !agent) {
    // `not_found` is the ordinary way to arrive here, not a fault: a folder
    // whose manifest id is already claimed by another folder is listed but
    // never indexed, so `locate()` has no row for it. Saying "no longer in your
    // agents folder" would send the user looking for a folder that is sitting
    // on disk — the sidebar sub-line already told them the real reason.
    //
    // The raw `error.message` is not shown in either case. Main's message
    // reaches the renderer wrapped as "Error invoking remote method
    // 'local-agent:get': …", which is a sentence about our IPC layer, not about
    // the user's folder.
    const notFound = (error as { code?: unknown } | null)?.code === 'not_found'
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="text-sm text-[var(--color-text)]">
          {notFound ? 'This agent is not indexed.' : 'This agent could not be read.'}
        </div>
        <div className="max-w-md text-xs text-[var(--color-text-muted)]">
          {notFound
            ? 'Its folder is still on disk — the app just has no entry for it. That usually means another folder already claims the same id in cinna-agent.json; the agents list says which. Give one of them a new id, then rescan.'
            : 'Its folder may have been moved or deleted outside the app.'}
        </div>
        <button
          type="button"
          onClick={() => rescan.mutate(undefined)}
          className="px-3 py-1.5 rounded-md text-xs font-medium bg-[var(--color-accent)]
            text-white hover:bg-[var(--color-accent-hover)] transition-colors"
        >
          Rescan agents folders
        </button>
      </div>
    )
  }

  // The draft's own words — "no AI credential is configured", "drafted except
  // the example prompts". Only for the agent it ran against, so switching
  // agents does not carry another one's note along.
  const draftResult = draft.data
  const draftNote =
    draft.isPending || draftResult?.agent.id !== agent.id ? null : draftResult.reason

  // Invariant 3 applies to stamping like every other write: the stamp handed
  // back is the one this render read, not one taken at click time.
  const manifestStamp = agent.stamps[MANIFEST_FILE] ?? null
  const description = describedAs(agent)
  const hasDescription = description !== ''
  const findings = agent.validation.errors.length + agent.validation.warnings.length
  // Only for the badge. The card runs the same query when the tab is open —
  // react-query serves both from one cache entry, so this costs no extra IPC.
  const grantCount = grants?.length ?? 0
  // A bare folder has no `docs/CLI_COMMANDS.yaml` and never will, so the tab
  // would be permanently empty and would say "no commands" about a file the
  // folder was never asked to have. Every other tab still has something true to
  // show: Overview its name and `AGENT.md`, Addons its connectors, Permissions the
  // profile it runs under, Folder the findings that explain what it is.
  const tabs = TABS.filter(
    (entry) =>
      !(agent.kind === 'bare' && ['commands', 'schedules'].includes(entry.id)) &&
      (entry.id !== 'sharing' || listedShare != null)
  )
  // The selected tab persists across agents, so someone on Commands who clicks
  // a bare agent would land on a tab that is not there and see an empty panel.
  // Falling back for the render only — `setTab` is untouched, so going back to
  // a kit agent returns to Commands.
  const activeTab = tabs.some((entry) => entry.id === tab) ? tab : 'overview'

  return (
    <div className="flex flex-1 flex-col overflow-y-auto pt-[var(--topbar-h)] [scrollbar-gutter:stable]">
      {/* A flex column that fills the page, so the chat below the header can
          take the remaining height and centre itself like the New Chat screen. */}
      <div data-sidebar-band-limit className="mx-auto flex w-full max-w-3xl flex-1 flex-col space-y-3 px-6 py-6">
        <header className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="flex items-center gap-2 text-xl font-semibold text-[var(--color-text)]">
              <AgentTypeIcon agent={{ source: 'folder' }} agentId={agent.id} size={18} />
              <span className="truncate">{agent.name}</span>
            </h1>
            {hasDescription ? (
              <p className="mt-0.5 line-clamp-2 text-xs text-[var(--color-text-secondary)]">
                {description}
              </p>
            ) : (
              // The invitation only where there is somewhere to accept it. A
              // bare folder states no description anywhere the desktop can
              // write one, so "add one under Overview" would send the user to a
              // tab with no such field (ux_rules rule 7).
              agent.kind !== 'bare' && (
                <button
                  type="button"
                  onClick={() => { setMode('settings'); setTab('overview') }}
                  className="mt-0.5 text-xs text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-secondary)]"
                >
                  No description yet — add one under Overview.
                </button>
              )
            )}
            <button
              type="button"
              onClick={() => openPath.mutate({ agentId: agent.id })}
              title="Reveal this folder"
              className="mt-1 block max-w-full truncate font-mono text-[10px] text-[var(--color-text-muted)]
                hover:text-[var(--color-text-secondary)] transition-colors"
            >
              {agent.path}
            </button>
            {mode === 'chat' && (
              <RuntimePanel
                agent={agent}
                compact
                leading={
                  /*
                    A shared agent's state with the team, and its Update /
                    Share changes, first in the row of runtime badges.
                    Present from the first frame for a shared agent and absent
                    for any other, so nothing in the row moves when the
                    agent's own status lands.
                  */
                  <AgentShareBadge
                    key={agent.id}
                    agentId={agent.id}
                    actions={shareActions}
                    onOpenSharing={() => {
                      setMode('settings')
                      setTab('sharing')
                      setFocusSharingTab(true)
                    }}
                  />
                }
              />
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <OpenInMenu agent={agent} onError={reportError} onNote={reportNote} />
            <button
              type="button"
              onClick={() => {
                setMode(mode === 'settings' ? 'chat' : 'settings')
              }}
              title={mode === 'settings' ? `Start a new chat with ${agent.name}` : 'Agent settings'}
              className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                mode === 'settings'
                  ? 'border-transparent bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)]'
                  : 'ambient-button border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'
              }`}
            >
              {mode === 'settings' ? <MessageSquare size={12} /> : <Settings size={12} />}
              {mode === 'settings' ? 'Start chat' : 'Settings'}
            </button>
            <AgentActionsMenu agent={agent} onError={reportError} />
          </div>
        </header>
        {/*
          Always rendered, exactly one line: a refusal appearing here must not
          push the panel below it down, and the macOS automation message wraps
          to two lines at the minimum window width. The full text is in `title`.
        */}
        <div
          role={actionError ? 'alert' : 'status'}
          title={actionError ?? actionNote ?? undefined}
          className={`h-4 truncate text-right text-[10px] leading-4 ${
            actionError ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-muted)]'
          }`}
        >
          {actionError ?? actionNote}
        </div>

        <ReadinessStrip
          agent={agent}
          drafting={drafting}
          draftNote={draftNote}
          onShowDetails={() => { setMode('settings'); setTab('folder') }}
          onStampIdentity={
            manifestStamp
              ? () =>
                  stamp.mutate(
                    { agentId: agent.id, expectedStamp: manifestStamp },
                    // Stamping re-keys the row, so the selection has to follow
                    // the agent to its new id — the old one is pruned, and the
                    // page would otherwise be left asking for a row that is gone.
                    { onSuccess: (next) => setActiveLocalAgentId(next.id) }
                  )
              : undefined
          }
          stamping={stamp.isPending}
          stampError={stamp.error ? stamp.error.message : null}
        />

        {/*
          One panel for both kinds. A bare agent picks its credential and model
          like any other; what differs is only where the answer is kept — its own
          state under `userData`, never a file in the adopted folder.
        */}
        {mode === 'settings' && <RuntimePanel agent={agent} />}

        <div hidden={mode === 'settings'} className={mode === 'settings' ? undefined : 'flex flex-1 flex-col'}>
          {/*
            Decided from the list the sidebar already holds, so the banner is
            there at first paint or not at all; keyed by agent so the decision
            is taken once per agent opened, never re-evaluated upward.
          */}
          <BringTogetherBanner
            key={agent.id}
            agentId={agent.id}
            initialOffered={listedShare?.state === 'diverged' && !listedShare.teamChangesDeclined}
            actions={shareActions}
          />
          <ChatWorkspace key={agent.id} agentId={agent.id} embedded />
        </div>
        {mode === 'settings' && <>
        <nav
          role="tablist"
          aria-label="Agent details"
          className="flex flex-wrap gap-x-1 shadow-[inset_0_-1px_0_var(--color-border)]"
        >
          {tabs.map((entry) => {
            const active = entry.id === activeTab
            return (
              <button
                key={entry.id}
                id={`agent-tab-${entry.id}`}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTab(entry.id)}
                className={`relative border-b-2 px-3 py-2 text-xs font-medium transition-colors ${
                  active
                    ? 'border-[var(--color-accent)] text-[var(--color-text)]'
                    : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'
                }`}
              >
                {entry.label}
                {entry.id === 'permissions' && grantCount > 0 && (
                  <span
                    className="ml-1.5 rounded bg-[var(--color-bg-tertiary)] px-1 text-[10px] text-[var(--color-text-muted)]"
                    title={`${grantCount} standing permission${grantCount === 1 ? '' : 's'}`}
                  >
                    {grantCount}
                  </span>
                )}
                {/* Like the Folder tab's: when an attached connector is not
                    connected — the agent's sessions are running without its
                    tools, and the Overview no longer says so anywhere — or a
                    skill has an issue, the count is of those, warning-toned;
                    otherwise the neutral total. */}
                {entry.id === 'addons' && addons.count > 0 && (
                  <span
                    className={`ml-1.5 rounded px-1 text-[10px] ${
                      addons.problems > 0
                        ? 'bg-[var(--color-warning)]/15 text-[var(--color-warning)]'
                        : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)]'
                    }`}
                    title={addonsBadgeTitle(addons.count, addons.skills ?? 0, addons.problems)}
                  >
                    {addons.problems > 0 ? addons.problems : addons.count}
                  </span>
                )}
                {/*
                  The queue paused on a task: it needs the user, and the tab is
                  hidden content (§2). A warning dot in the tab's own right
                  padding, positioned out of the flow, so the tab row does not
                  reflow when a poll brings it or takes it away (§1).
                */}
                {entry.id === 'tasks' && tasksBadge.paused && (
                  <span
                    role="img"
                    aria-label="Queue paused"
                    title="Queue paused"
                    data-tab-paused-dot
                    className="absolute right-1 top-1.5 h-1.5 w-1.5 rounded-full bg-[var(--color-warning)]"
                  />
                )}
                {entry.id === 'commands' && agent.commands.length > 0 && (
                  <span className="ml-1.5 rounded bg-[var(--color-bg-tertiary)] px-1 text-[10px] text-[var(--color-text-muted)]">
                    {agent.commands.length}
                  </span>
                )}
                {/*
                  Warning-severity findings on an otherwise ready folder are the
                  one thing the top of the page no longer mentions; the count
                  here is what makes them discoverable without opening the tab.
                */}
                {entry.id === 'folder' && findings > 0 && (
                  <span
                    className="ml-1.5 rounded bg-[var(--color-warning)]/15 px-1 text-[10px] text-[var(--color-warning)]"
                    title={`${findings} validation finding${findings === 1 ? '' : 's'}`}
                  >
                    {findings}
                  </span>
                )}
              </button>
            )
          })}
        </nav>

        <div role="tabpanel" className="space-y-3">
          {activeTab === 'credentials' && <ServiceCredentialsTab key={agent.id} agent={agent} />}
          {activeTab === 'schedules' && <SchedulesTab agentId={agent.id} />}
          {activeTab === 'tasks' && <AgentTasksTab key={agent.id} agent={agent} />}
          {activeTab === 'addons' && <AgentAddonsTab key={agent.id} agent={agent} onFinishSetup={finishSetup.open} />}
          {activeTab === 'overview' &&
            /* Three of the kit cards name a file only a kit folder has:
               `app-data/storage/STATUS.md`, and the manifest twice. A card is a
               viewer over a file, and one naming a file the folder was never
               asked to have is worse than no card — it reads as something
               missing rather than as something that does not apply. What a bare
               folder *does* have that the user can change is its name.

               The prompts follow the cards that say what the agent is, each
               collapsed to ten lines: a workflow prompt runs to hundreds, and
               six full cards would push everything but the first off screen.
               `key` resets the collapse when the page switches agents. */
            (agent.kind === 'bare' ? (
              <>
                <BareNameCard agent={agent} />
                {/* Rendered, not raw: a README is written to be read as
                    markdown, and a bare folder is very often a repository whose
                    README is the only prose about it anywhere. It renders
                    nothing at all when the folder has no README. */}
                <BareReadmeCard agent={agent} />
                {/* One document, because a bare agent has one: its instructions
                    file (`AGENT.md`, `AGENTS.md` or `CLAUDE.md`, as main
                    resolved it) is the whole system prompt. */}
                <PromptDocCard
                  key={`${agent.id}:bare_prompt`}
                  agentId={agent.id}
                  prompt="bare_prompt"
                  instructionsFile={agent.instructionsFile}
                  title="Instructions"
                  hint="This file is the agent: it is loaded as the system prompt for every conversation."
                  placeholder="Describe what this agent does, step by step, addressed to the agent."
                  missingNote={`This folder has no ${bareInstructionsFileList()}. Add one — it is the file that makes this folder an agent.`}
                />
              </>
            ) : (
              <>
                <StatusCard agent={agent} />
                <DescriptionCard agent={agent} />
                <ExamplePromptsCard agent={agent} />
                <PromptDocCard
                  key={`${agent.id}:workflow`}
                  agentId={agent.id}
                  prompt="workflow"
                  title="Workflow prompt"
                  hint="This document is the agent: it is loaded as the system prompt for every conversation."
                  placeholder="Describe what this agent does, step by step, addressed to the agent."
                />
                <PromptDocCard
                  key={`${agent.id}:entrypoint`}
                  agentId={agent.id}
                  prompt="entrypoint"
                  title="Entrypoint prompt"
                  hint="The first message of an unattended run, with nobody there to answer a question."
                  placeholder="One or two self-contained sentences telling the agent what to do."
                />
                <PromptDocCard
                  key={`${agent.id}:refiner`}
                  agentId={agent.id}
                  prompt="refiner"
                  title="Refiner prompt"
                  hint="Defaults and required inputs — what to assume when a request does not say."
                  placeholder="List the mandatory inputs and the defaults to fill in."
                />
              </>
            ))}
          {activeTab === 'commands' && <CommandsCard agent={agent} />}
          {activeTab === 'permissions' && <PermissionsCard agent={agent} />}
          {activeTab === 'folder' && <FolderTab agent={agent} />}
          {activeTab === 'interface' && <AgentInterfaceTab key={agent.id} agent={agent} />}
          {activeTab === 'sharing' && (
            <SharingTab
              key={agent.id}
              agent={agent}
              actions={shareActions}
              bindActionErrors={bindShareErrors}
              onNote={reportNote}
            />
          )}
        </div>
        </>}
        {shareActions.dialogs}
        {finishSetup.dialog}
      </div>
    </div>
  )
}
