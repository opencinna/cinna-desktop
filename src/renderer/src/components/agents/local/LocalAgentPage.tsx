import { useEffect, useRef } from 'react'
import { MessageSquare, RefreshCw } from 'lucide-react'
import { useUIStore } from '../../../stores/ui.store'
import {
  useDraftLocalAgent,
  useLocalAgent,
  useOpenAgentPath,
  useRescanLocalAgents,
  useStampAgentIdentity
} from '../../../hooks/useLocalAgents'
import { MANIFEST_FILE } from '../../../../../shared/kit/manifest'
import { RuntimeCard } from './RuntimeCard'
import { ReadinessStrip } from './ReadinessStrip'
import { OpenInRow } from './OpenInRow'
import { DescriptionCard, ExamplePromptsCard } from './ManifestCards'
import { PromptDocCard } from './PromptDocCard'
import {
  CommandsCard,
  CredentialsCard,
  PublishedCard,
  RunsCard,
  StatusCard
} from './ReadOnlyCards'

/**
 * A folder agent's page: a viewer over the folder on disk.
 *
 * Every card names the file it reads, and the three that are editable write
 * straight back to that file through the stamp guard — there is no separate
 * "agent record" behind this page, and no state that survives deleting the
 * folder. What the page cannot do yet it shows disabled rather than hiding:
 * chatting with a folder agent, running a command and choosing a runtime all
 * arrive with the local engine, and the shape of the finished page should be
 * legible before then.
 */
export function LocalAgentPage(): React.JSX.Element {
  const activeLocalAgentId = useUIStore((s) => s.activeLocalAgentId)
  const setActiveLocalAgentId = useUIStore((s) => s.setActiveLocalAgentId)
  const pendingDraftAgentId = useUIStore((s) => s.pendingDraftAgentId)
  const setPendingDraftAgentId = useUIStore((s) => s.setPendingDraftAgentId)
  const { data: agent, isLoading, error } = useLocalAgent(activeLocalAgentId)
  const draft = useDraftLocalAgent()
  const rescan = useRescanLocalAgents()
  const openPath = useOpenAgentPath()
  const stamp = useStampAgentIdentity()

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
        Select an agent from the sidebar, or create one with +.
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
            text-[var(--color-on-accent)] hover:bg-[var(--color-accent-hover)] transition-colors"
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

  return (
    <div className="flex-1 overflow-y-auto pt-[var(--topbar-h)]">
      <div className="mx-auto max-w-3xl space-y-3 px-6 py-6">
        <header className="space-y-2">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-xl font-semibold text-[var(--color-text)]">
                {agent.name}
              </h1>
              <button
                type="button"
                onClick={() => openPath.mutate({ agentId: agent.id })}
                title="Reveal this folder"
                className="mt-0.5 block max-w-full truncate font-mono text-[10px] text-[var(--color-text-muted)]
                  hover:text-[var(--color-text-secondary)] transition-colors"
              >
                {agent.path}
              </button>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                onClick={() => rescan.mutate(agent.rootId)}
                disabled={rescan.isPending}
                title="Re-read this agents folder"
                className="flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-2.5 py-1.5
                  text-[10px] font-medium text-[var(--color-text-secondary)]
                  hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)] transition-colors
                  disabled:opacity-40"
              >
                <RefreshCw size={11} />
                Rescan
              </button>
              <button
                type="button"
                disabled
                title="Chatting with a folder agent arrives with the local engine"
                className="flex items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-3 py-1.5
                  text-xs font-medium text-[var(--color-on-accent)]
                  disabled:cursor-not-allowed disabled:opacity-40"
              >
                <MessageSquare size={12} />
                Start chat
              </button>
            </div>
          </div>
          <OpenInRow agent={agent} />
        </header>

        <ReadinessStrip
          agent={agent}
          drafting={draft.isPending}
          draftNote={draftNote}
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

        <DescriptionCard agent={agent} />
        <ExamplePromptsCard agent={agent} />
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
        <RuntimeCard agent={agent} />
        <CredentialsCard agent={agent} />
        <CommandsCard agent={agent} />
        <StatusCard agent={agent} />
        <PublishedCard agent={agent} />
        <RunsCard agent={agent} />
      </div>
    </div>
  )
}
