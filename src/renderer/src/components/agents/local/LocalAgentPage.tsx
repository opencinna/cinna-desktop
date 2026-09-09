import { useEffect, useRef, useState } from 'react'
import { Circle, MessageSquare } from 'lucide-react'
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
import type { LocalAgentDto } from '../../../../../shared/localAgents'
import { describedAs } from '../../../utils/localAgents'
import { RuntimePanel } from './RuntimePanel'
import { ReadinessStrip } from './ReadinessStrip'
import { OpenInMenu } from './OpenInMenu'
import { AgentActionsMenu } from './AgentActionsMenu'
import { DescriptionCard, ExamplePromptsCard } from './ManifestCards'
import { BareNameCard, BareReadmeCard } from './BareAgentCards'
import { PromptDocCard } from './PromptDocCard'
import { CommandsCard, StatusCard } from './ReadOnlyCards'
import { PermissionsCard } from './PermissionsCard'
import { FolderTab } from './FolderTab'

export type AgentPageTab = 'overview' | 'prompts' | 'commands' | 'permissions' | 'folder'

const TABS: { id: AgentPageTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'prompts', label: 'Prompts' },
  { id: 'commands', label: 'Commands' },
  // Permissions is a tab and not a card on Overview: in the common case it is a
  // fixed paragraph identical for every folder agent plus "nothing remembered
  // yet" — knowledge, not a control (rule 2) — and the count badge is what
  // makes a standing grant discoverable without opening it. A tab body also
  // mounts on selection, so its query cannot render an empty state for an agent
  // that has grants.
  { id: 'permissions', label: 'Permissions' },
  { id: 'folder', label: 'Folder' }
]

/** Dot colour for a folder's readiness. Severity tokens, never a raw colour. */
function readinessDot(agent: LocalAgentDto): { cls: string; title: string } {
  switch (agent.readiness) {
    case 'ok':
      return { cls: 'text-[var(--color-success)]', title: 'Ready' }
    case 'credentials_needed':
      return { cls: 'text-[var(--color-warning)]', title: 'Credentials needed' }
    default:
      return { cls: 'text-[var(--color-danger)]', title: agent.readinessReason ?? 'Not ready' }
  }
}

/**
 * A folder agent's page.
 *
 * Above the fold: what the user *does* with an agent — open its folder in
 * their own tool, start a chat, and choose what it runs with. The page used to
 * be eleven stacked cards, each a viewer over one file, which was faithful to
 * the folder and useless as a control surface: the runtime picker was the
 * seventh card down. Everything that is information rather than a control now
 * lives under four tabs, and the readiness banner appears only when something
 * needs attention — the dot beside the name covers the rest.
 *
 * Still a viewer over the folder on disk: every card names the file it reads,
 * the editable ones write straight back through the stamp guard, and there is
 * no state that survives deleting the folder.
 *
 * **Start chat** uses the exact mechanism the remote-agent status overlay
 * already uses (`AgentStatusOverlay`'s own "Start chat": `setActiveView('chat')`
 * + `pendingAgentId`, seeded into `pendingAgentIds` by `MainArea.tsx`).
 */
export function LocalAgentPage(): React.JSX.Element {
  const activeLocalAgentId = useUIStore((s) => s.activeLocalAgentId)
  const setActiveLocalAgentId = useUIStore((s) => s.setActiveLocalAgentId)
  const pendingDraftAgentId = useUIStore((s) => s.pendingDraftAgentId)
  const setPendingDraftAgentId = useUIStore((s) => s.setPendingDraftAgentId)
  const setActiveView = useUIStore((s) => s.setActiveView)
  const setPendingAgentId = useUIStore((s) => s.setPendingAgentId)
  /** Whether there is an agents folder at all — see the placeholder below. */
  const homeAccess = useAgentsHomeQuestion()
  const { data: agent, isLoading, error } = useLocalAgent(activeLocalAgentId)
  const { data: grants } = useLocalAgentGrants(activeLocalAgentId)
  const draft = useDraftLocalAgent()
  const rescan = useRescanLocalAgents()
  const openPath = useOpenAgentPath()
  const stamp = useStampAgentIdentity()
  // Kept across agents on purpose: someone working through the prompts of
  // three agents does not want to click "Prompts" three times.
  const [tab, setTab] = useState<AgentPageTab>('overview')
  // One slot for every header action's refusal (Open in, Rescan, Reveal,
  // Terminal, Stamp). Two menus each drawing their own absolutely-positioned
  // message produced two unreadable overlapping boxes; and an old message
  // must not outlive the next action.
  const [actionError, setActionError] = useState<string | null>(null)

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
  const dot = readinessDot(agent)
  const description = describedAs(agent)
  const hasDescription = description !== ''
  const findings = agent.validation.errors.length + agent.validation.warnings.length
  // Only for the badge. The card runs the same query when the tab is open —
  // react-query serves both from one cache entry, so this costs no extra IPC.
  const grantCount = grants?.length ?? 0
  // A bare folder has no `docs/CLI_COMMANDS.yaml` and never will, so the tab
  // would be permanently empty and would say "no commands" about a file the
  // folder was never asked to have. Every other tab still has something true to
  // show: Overview its name and status, Prompts its `AGENT.md`, Permissions the
  // profile it runs under, Folder the findings that explain what it is.
  const tabs = agent.kind === 'bare' ? TABS.filter((entry) => entry.id !== 'commands') : TABS
  // The selected tab persists across agents, so someone on Commands who clicks
  // a bare agent would land on a tab that is not there and see an empty panel.
  // Falling back for the render only — `setTab` is untouched, so going back to
  // a kit agent returns to Commands.
  const activeTab = tabs.some((entry) => entry.id === tab) ? tab : 'overview'

  return (
    <div className="flex-1 overflow-y-auto pt-[var(--topbar-h)] [scrollbar-gutter:stable]">
      <div className="mx-auto max-w-3xl space-y-3 px-6 py-6">
        <header className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="flex items-center gap-2 text-xl font-semibold text-[var(--color-text)]">
              <Circle
                size={8}
                className={`shrink-0 fill-current ${dot.cls}`}
                aria-label={dot.title}
              />
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
                  onClick={() => setTab('overview')}
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
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <OpenInMenu agent={agent} onError={setActionError} />
            <button
              type="button"
              onClick={() => {
                setActiveView('chat')
                setPendingAgentId(agent.id)
              }}
              title={`Start a new chat with ${agent.name}`}
              className="flex items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-3 py-1.5
                text-xs font-medium text-white
                hover:bg-[var(--color-accent-hover)] transition-colors"
            >
              <MessageSquare size={12} />
              Start chat
            </button>
            <AgentActionsMenu agent={agent} onError={setActionError} />
          </div>
        </header>
        {/*
          Always rendered, exactly one line: a refusal appearing here must not
          push the panel below it down, and the macOS automation message wraps
          to two lines at the minimum window width. The full text is in `title`.
        */}
        <div
          role="alert"
          title={actionError ?? undefined}
          className="h-4 truncate text-right text-[10px] leading-4 text-[var(--color-danger)]"
        >
          {actionError}
        </div>

        <ReadinessStrip
          agent={agent}
          drafting={draft.isPending}
          draftNote={draftNote}
          onShowDetails={() => setTab('folder')}
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
        <RuntimePanel agent={agent} />

        <nav
          role="tablist"
          aria-label="Agent details"
          className="flex gap-1 border-b border-[var(--color-border)]"
        >
          {tabs.map((entry) => {
            const active = entry.id === activeTab
            return (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTab(entry.id)}
                className={`-mb-px border-b-2 px-3 py-2 text-xs font-medium transition-colors ${
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
          {activeTab === 'overview' &&
            /* Three of the four Overview cards name a file only a kit folder
               has: `app-data/storage/STATUS.md`, and the manifest twice. A card
               is a viewer over a file, and one naming a file the folder was
               never asked to have is worse than no card — it reads as something
               missing rather than as something that does not apply. What a bare
               folder *does* have that the user can change is its name. */
            (agent.kind === 'bare' ? (
              <>
                <BareNameCard agent={agent} />
                {/* Where a folder describes itself, that description belongs on
                    the tab that asks what this agent is. Rendered, not raw: a
                    README is written to be read as markdown, and a bare folder
                    is very often a repository whose README is the only prose
                    about it anywhere. It renders nothing at all when the folder
                    has no README. */}
                <BareReadmeCard agent={agent} />
              </>
            ) : (
              <>
                <StatusCard agent={agent} />
                <DescriptionCard agent={agent} />
                <ExamplePromptsCard agent={agent} />
              </>
            ))}
          {activeTab === 'prompts' &&
            (agent.kind === 'bare' ? (
              /* One document, because a bare agent has one: `AGENT.md` is the
                 whole system prompt. The folder's README moved to Overview,
                 where a description of the agent is what the tab is for — here
                 it was the longer of two cards on the tab whose point is the
                 shorter one, and read as though it too were sent to the agent. */
              <PromptDocCard
                agentId={agent.id}
                prompt="bare_prompt"
                title="Instructions"
                hint="This file is the agent: it is loaded as the system prompt for every conversation."
                placeholder="Describe what this agent does, step by step, addressed to the agent."
                markdown
                missingNote="AGENT.md is not in this folder. Add it there — it is the file that makes this folder an agent."
              />
            ) : (
              <>
                <PromptDocCard
                  agentId={agent.id}
                  prompt="workflow"
                  title="Workflow prompt"
                  hint="This document is the agent: it is loaded as the system prompt for every conversation."
                  placeholder="Describe what this agent does, step by step, addressed to the agent."
                />
                <PromptDocCard
                  agentId={agent.id}
                  prompt="entrypoint"
                  title="Entrypoint prompt"
                  hint="The first message of an unattended run, with nobody there to answer a question."
                  placeholder="One or two self-contained sentences telling the agent what to do."
                />
                <PromptDocCard
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
        </div>
      </div>
    </div>
  )
}
