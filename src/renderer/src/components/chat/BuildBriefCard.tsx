import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Check, ClipboardList, HelpCircle, Loader2 } from 'lucide-react'
import { ambientMeshStyle } from '../ui/ambientMesh'
import { useNewChatFlow } from '../../hooks/useNewChatFlow'
import { LOCAL_AGENTS_KEY, localAgentKey, useLocalAgent, useSetLocalAgentRuntime } from '../../hooks/useLocalAgents'
import { useChatStore } from '../../stores/chat.store'
import { useUIStore } from '../../stores/ui.store'
import { useToastStore } from '../../stores/toast.store'
import { unwrapIpcError } from '../../utils/ipcError'
import { openAgentCredentials } from './ComposerReadiness'
import { KEEP_ENGINE } from '../../../../shared/engine'
import { unwrapLocalAgentOutcome } from '../../../../shared/localAgents'
import {
  BUILD_BRIEF_CAPABILITY_LABELS,
  BUILD_BRIEF_EFFORT_COMPLEXITY,
  composeBuildMessage,
  parseBuildBrief,
  type BuildBrief,
  type BuildBriefCapabilityId
} from '../../../../shared/buildBrief'

const PRIMARY =
  'inline-flex min-w-[6.5rem] items-center justify-center gap-1 rounded-md bg-[var(--color-accent)] px-2.5 py-1 text-[11px] font-medium text-white ' +
  'transition-colors hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-50'
const SECONDARY =
  'inline-flex items-center justify-center gap-1 rounded-md border border-[var(--color-border)] px-2.5 py-1 text-[11px] font-medium ' +
  'text-[var(--color-text)] transition-colors hover:bg-[var(--color-bg-hover)] disabled:cursor-not-allowed disabled:opacity-50'
/** "Applied" in the Apply button's own box, so the swap moves nothing. */
const APPLIED =
  'inline-flex min-w-[3.75rem] items-center justify-center gap-1 rounded-md border border-transparent px-2.5 py-1 text-[11px] font-medium ' +
  'text-[var(--color-text-muted)]'
const LINK =
  'text-[11px] font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-50'
const SECTION_LABEL = 'text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]'
const SECTION = `mt-2.5 ${SECTION_LABEL}`

const EFFORT_LABEL: Record<NonNullable<BuildBrief['effort']>['level'], string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High'
}

/**
 * Start building: a new chat with the agent, its first message the brief,
 * then the agent's guided build marked done. Owned by a hook-level mutation,
 * because the card unmounts as soon as the new chat becomes the active one —
 * a `mutate`-level callback would be dropped there, a hook-level one is not.
 * The new chat is never guided: no `guidedBuild` is asked for.
 *
 * A done marker that fails after the chat started is not the card's error any
 * more — the card is gone — so it is a toast: the app-level one stays mounted.
 */
function useStartBuilding() {
  const queryClient = useQueryClient()
  const { startNewChat } = useNewChatFlow()
  return useMutation<void, Error, { agentId: string; message: string }>({
    mutationFn: async ({ agentId, message }) => {
      const ui = useUIStore.getState()
      ui.setActiveView('chat')
      ui.setSidebarTab('chats')
      const started = await startNewChat({
        message,
        agentIds: [agentId],
        mode: null,
        providerId: null,
        // Never read: one agent and no MCPs is a direct chat, bound to the agent.
        providers: undefined,
        allModels: undefined,
        mcpIds: []
      })
      if (!started) {
        // `startNewChat` reports into the composer's banner; the card says it
        // where the button was pressed instead, once.
        const store = useChatStore.getState()
        const reason = store.sendError
        store.setSendError(null)
        throw new Error(reason ?? 'Could not start the building chat.')
      }
      try {
        const agent = unwrapLocalAgentOutcome(await window.api.localAgents.markGuidedBuildDone(agentId))
        // The card's own read: an old brief turns read-only once its agent is no longer unbuilt.
        queryClient.setQueryData(localAgentKey(agent.id), agent)
      } catch (err) {
        useToastStore.getState().show(
          ('The building chat started, but the guided build could not be marked done, so a new chat may offer it again. ' +
            unwrapIpcError(err, '')).trim(),
          { kind: 'error', link: null }
        )
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: LOCAL_AGENTS_KEY })
    }
  })
}

interface BuildBriefCardProps {
  /** The chat the brief was proposed in; Keep talking focuses its composer. */
  chatId: string
  /** The chat's own agent — the one being built. */
  agentId: string | null
  input: Record<string, unknown> | undefined
  /**
   * The latest brief in the chat, with no user message after it: the only one
   * that may have controls — and only while its agent is still unbuilt (read
   * here). Every other renders as a read-only record.
   */
  active: boolean
}

/**
 * A guided first build's `build_brief_propose`: what the agent proposes to
 * build, with Start building and Keep talking. Matched in the transcript by
 * tool name and provider name, like the artifacts card. A brief whose input
 * does not parse renders nothing here; the caller falls back to the plain
 * tool row.
 */
export function BuildBriefCard({ chatId, agentId, input, active }: BuildBriefCardProps): React.JSX.Element | null {
  const parsed = parseBuildBrief(input)
  if (!parsed.ok) return null
  if (!active || agentId === null) return <BriefBody brief={parsed.brief} chatId={chatId} agentId={agentId} active={false} />
  return <LatestBrief brief={parsed.brief} chatId={chatId} agentId={agentId} />
}

/**
 * The latest brief: live only while its agent is still unbuilt. After Start
 * building or Skip guidance, or once this chat built something, it is a record
 * like the others. Read-only too until the agent has been read, so a Start
 * building never shows for a build already started.
 */
function LatestBrief({ brief, chatId, agentId }: { brief: BuildBrief; chatId: string; agentId: string }): React.JSX.Element {
  const { data: agent } = useLocalAgent(agentId)
  return <BriefBody brief={brief} chatId={chatId} agentId={agentId} active={agent?.unbuilt === true} />
}

function BriefBody({ brief, chatId, agentId, active }: { brief: BuildBrief; chatId: string; agentId: string | null; active: boolean }): React.JSX.Element {
  const [prompt, setPrompt] = useState(brief.prompt)
  const [editing, setEditing] = useState(false)
  const [included, setIncluded] = useState<ReadonlySet<BuildBriefCapabilityId>>(new Set())
  const setUp = brief.capabilities.filter((c) => c.state !== 'not_needed')
  const notNeeded = brief.capabilities.filter((c) => c.state === 'not_needed')
  // The credentials are named once: in their Set up row when there is one,
  // otherwise on a line of their own.
  const credentialRow = setUp.some((c) => c.id === 'credentials')
  const credentialNames = brief.credentials.map((c) => c.name).join(', ')
  const credentialsLine = !credentialRow && brief.credentials.length > 0
  const addCredentials = active && agentId ? (
    <button type="button" className={`${LINK} shrink-0`} onClick={() => openAgentCredentials(agentId)}>
      Add in Credentials
    </button>
  ) : null

  const toggle = (id: BuildBriefCapabilityId, include: boolean): void => {
    setIncluded((current) => {
      const next = new Set(current)
      if (include) next.add(id)
      else next.delete(id)
      return next
    })
  }

  return (
    <div
      data-tone={active ? 'ask' : undefined}
      style={ambientMeshStyle(brief.summary)}
      aria-label="Build brief"
      role="group"
      className={
        'ambient-block rounded-lg border px-3.5 py-3 ' +
        (active ? 'border-[var(--color-accent)]/40' : 'border-[var(--color-border)] opacity-90')
      }
    >
      <div className="flex items-start gap-2.5">
        <ClipboardList size={16} className={`mt-0.5 shrink-0 ${active ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]'}`} />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-[var(--color-text)]">Build brief</div>
          <p className="mt-0.5 text-[12px] text-[var(--color-text-secondary)]">{brief.summary}</p>

          <div className="mt-2.5 flex items-center gap-2">
            <span className={SECTION_LABEL}>Starting prompt</span>
            {active && !editing && (
              <button type="button" className={LINK} onClick={() => setEditing(true)}>Edit</button>
            )}
            {active && editing && (
              <button type="button" className={LINK} onClick={() => setEditing(false)}>Done</button>
            )}
          </div>
          {editing && active ? (
            <textarea
              aria-label="Starting prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={Math.min(8, Math.max(3, prompt.split('\n').length + 1))}
              className="mt-1 w-full resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5
                text-[12px] text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none"
            />
          ) : (
            <p className="mt-1 whitespace-pre-wrap text-[12px] text-[var(--color-text)]">{prompt}</p>
          )}

          {setUp.length > 0 && (
            <>
              <div className={SECTION}>Set up</div>
              <ul className="mt-1 space-y-1">
                {setUp.map((c) => (
                  <li key={c.id} className="flex items-start gap-1.5 text-[12px]">
                    {c.state === 'used' ? (
                      <Check size={12} aria-label="Included" className="mt-0.5 shrink-0 text-[var(--color-success)]" />
                    ) : (
                      <HelpCircle size={12} aria-label="Your choice" className="mt-0.5 shrink-0 text-[var(--color-warning)]" />
                    )}
                    <span className="min-w-0 flex-1 text-[var(--color-text)]">
                      {BUILD_BRIEF_CAPABILITY_LABELS[c.id]}
                      {/* The credentials row names the access once: the names when given, else the note. */}
                      {c.id === 'credentials' && credentialNames ? (
                        <span className="text-[var(--color-text-secondary)]"> — {credentialNames}</span>
                      ) : (
                        c.note && <span className="text-[var(--color-text-secondary)]"> — {c.note}</span>
                      )}
                    </span>
                    {c.id === 'credentials' && addCredentials}
                    {c.state === 'maybe' && active && (
                      <div role="group" aria-label={`${BUILD_BRIEF_CAPABILITY_LABELS[c.id]}: include or leave out`}
                        className="flex shrink-0 rounded-md border border-[var(--color-border)] p-0.5">
                        {([true, false] as const).map((include) => {
                          const on = included.has(c.id) === include
                          return (
                            <button key={String(include)} type="button" aria-pressed={on}
                              onClick={() => toggle(c.id, include)}
                              className={`rounded px-1.5 text-[10px] transition-colors ${on
                                ? 'app-nav-active text-[var(--color-text)]'
                                : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]'}`}>
                              {include ? 'Include' : 'Leave out'}
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
          {notNeeded.length > 0 && (
            <p className="mt-1.5 text-[11px] text-[var(--color-text-muted)]">
              Not needed now: {notNeeded.map((c) => BUILD_BRIEF_CAPABILITY_LABELS[c.id]).join(', ')}
            </p>
          )}

          {brief.skills.length > 0 && (
            <>
              <div className={SECTION}>Skills</div>
              <ul className="mt-1 space-y-0.5">
                {brief.skills.map((skill) => (
                  <li key={skill.name} className="text-[12px] text-[var(--color-text)]">
                    {skill.name} <span className="text-[var(--color-text-secondary)]">— {skill.purpose}</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {credentialsLine && (
            <div className="mt-2 flex items-center gap-2 text-[12px]">
              <span className="min-w-0 flex-1 text-[var(--color-text-secondary)]">Access it needs: {credentialNames}</span>
              {addCredentials}
            </div>
          )}

          {active && agentId && (
            <BriefActions brief={brief} chatId={chatId} agentId={agentId} prompt={prompt} included={included} />
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * The active brief's effort suggestion and buttons. Separate so that only the
 * one live card mounts the new-chat flow and reads the agent; read-only
 * records hold no subscriptions.
 */
function BriefActions({ brief, chatId, agentId, prompt, included }: {
  brief: BuildBrief
  chatId: string
  agentId: string
  prompt: string
  included: ReadonlySet<BuildBriefCapabilityId>
}): React.JSX.Element {
  const [appliedLevel, setAppliedLevel] = useState<string | null>(null)
  const [applyError, setApplyError] = useState<string | null>(null)
  const start = useStartBuilding()
  const setRuntime = useSetLocalAgentRuntime()
  const { data: agent } = useLocalAgent(agentId)

  // The suggestion is applied as the manifest's work-complexity tier. Hidden
  // when the agent is already there, and when it names a concrete model: that
  // was chosen on purpose, and a tier would replace it.
  const effortTier = brief.effort ? BUILD_BRIEF_EFFORT_COMPLEXITY[brief.effort.level] : null
  const stamp = agent?.stamps['cinna-agent.json'] ?? null
  const showEffort =
    brief.effort !== null &&
    agent !== undefined &&
    (appliedLevel !== null || (!agent.runtime?.model && agent.runtime?.complexity !== effortTier))

  const applyEffort = async (): Promise<void> => {
    if (!agent || !stamp || !effortTier || setRuntime.isPending) return
    setApplyError(null)
    try {
      await setRuntime.mutateAsync({
        agentId: agent.id,
        expectedStamp: stamp,
        runtime: { engine: KEEP_ENGINE, credential: agent.runtime?.credential ?? null, modelId: null, complexity: effortTier }
      })
      setAppliedLevel(effortTier)
    } catch (err) {
      setApplyError(unwrapIpcError(err, 'Could not apply the effort.'))
    }
  }

  const startBuilding = (): void => {
    if (start.isPending || prompt.trim() === '') return
    start.mutate({ agentId, message: composeBuildMessage(brief, prompt, included) })
  }

  const keepTalking = (): void => {
    document.querySelector<HTMLTextAreaElement>(`textarea[data-chat-composer="${chatId}"]`)?.focus()
  }

  const startError = start.error ? unwrapIpcError(start.error, 'Could not start the building chat.') : null

  return (
    <>
      {showEffort && brief.effort && (
        <div className="mt-2 flex items-center gap-2 text-[12px]">
          <span className="min-w-0 flex-1 text-[var(--color-text-secondary)]">
            Suggested effort: {EFFORT_LABEL[brief.effort.level]}
            {brief.effort.reason && <> — {brief.effort.reason}</>}
          </span>
          {appliedLevel !== null ? (
            <span className={APPLIED}>
              <Check size={12} />Applied
            </span>
          ) : (
            <button type="button" className={`${SECONDARY} min-w-[3.75rem]`} disabled={!stamp || setRuntime.isPending} onClick={() => void applyEffort()}>
              {setRuntime.isPending ? <Loader2 size={12} className="animate-spin" aria-label="Applying" /> : 'Apply'}
            </button>
          )}
        </div>
      )}
      {/* Under the row it belongs to, never under Start building. */}
      {showEffort && applyError && (
        <p role="alert" className="mt-1 text-right text-[11px] text-[var(--color-danger)]">{applyError}</p>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" className={SECONDARY} onClick={keepTalking}>Keep talking</button>
        <button type="button" className={PRIMARY} disabled={start.isPending || prompt.trim() === ''} onClick={startBuilding}>
          {start.isPending ? <Loader2 size={12} className="animate-spin" aria-label="Starting" /> : 'Start building'}
        </button>
      </div>
      {startError && (
        <p role="alert" className="mt-1.5 text-right text-[11px] text-[var(--color-danger)]">{startError}</p>
      )}
    </>
  )
}
