import { useState } from 'react'
import { ArrowLeftRight, Check, FilePen, Undo2 } from 'lucide-react'
import { MANIFEST_FILE } from '../../../../../shared/kit/manifest'
import { RUNTIME_MODE_NAMES } from '../../../../../shared/chatModeRuntime'
import { isEngineLoginId } from '../../../../../shared/engine'
import type {
  LocalAgentDto,
  LocalAgentRuntimeConflict,
  LocalAgentRuntimeSide,
  RuntimeConflictAction
} from '../../../../../shared/localAgents'
import { useModels } from '../../../hooks/useModels'
import { useRuntimeModelCatalog } from '../../../hooks/useRuntimeModelCatalog'
import { useAgentActiveSessions } from '../../../hooks/useAgentSessions'
import { useResolveRuntimeConflict } from '../../../hooks/useLocalAgents'
import { unwrapIpcError } from '../../../utils/ipcError'
import { NoticeButton, NoticeSplitButton } from '../../chat/ComposerNoticePanel'

/**
 * The file and the app disagree about what a kit agent runs on
 * (`LocalAgentResolvedRuntime.conflict`, resolved in main) — the words and the
 * one operation every surface that tells it shares: the Runs with panel's
 * notice block, the composer's notice row and the publish warning.
 *
 * Two answers, both explicit (never a bare "Fix"): the app's side is the
 * default action, the file's side the alternative.
 */

/** Said instead of acting while the agent's turn runs: the write waits for the lock. */
export const RUNTIME_CONFLICT_BUSY = 'Wait for this agent’s turn to finish.'

export interface RuntimeConflictChoice {
  action: RuntimeConflictAction
  /** Short — a verb and at most one short word (ux_rules rule 20). */
  label: string
  /** The long form, for the button's `title`. */
  title: string
}

export interface RuntimeConflictCopy {
  kind: LocalAgentRuntimeConflict['kind']
  /**
   * The one-line form, for the panel's notice block and the composer's row:
   * short enough that both sides survive at the 800px minimum (ux rule 7/12).
   * Only the file's side names its model — that is the cost that hurt; the
   * running side's model is on the badges and the full `sentence`.
   */
  text: string
  /**
   * The whole sentence, naming the file: the line's `title` and
   * `aria-description`, and the share dialog, which has the room.
   */
  sentence: string
  primary: RuntimeConflictChoice
  alternative: RuntimeConflictChoice
}

/** A model id by the name the registry or the runtime's own list gives it, else null to leave it out. */
export type ConflictModelName = (side: LocalAgentRuntimeSide) => string | null

/**
 * The sentence and the two actions. Pure, so the wording is tested once.
 *
 * Each side names its engine and, when known, the model it would run — the
 * cost is what hurt in the report this exists for. The one-line `text` keeps
 * only the file's model, so the running side survives at 800px. When both sides are the
 * same engine (OpenCode) the difference is the credential, so each side names
 * its own, or says it has none: "OpenCode (GPT-5.5 Pro); runs on OpenCode"
 * would name no difference at all.
 */
export function runtimeConflictCopy(conflict: LocalAgentRuntimeConflict, modelName: ConflictModelName): RuntimeConflictCopy {
  const credentialOnly = conflict.file.engine === conflict.app.engine
  const side = (value: LocalAgentRuntimeSide, withModel = true): string => {
    const model = withModel ? modelName(value) : null
    const on = !credentialOnly ? '' : value.credentialName ? ` on ${value.credentialName}` : ' with no AI credential'
    return `${RUNTIME_MODE_NAMES[value.engine]}${on}${model ? ` (${model})` : ''}`
  }
  const fileName = RUNTIME_MODE_NAMES[conflict.file.engine]
  if (conflict.kind === 'choice') {
    return {
      kind: 'choice',
      text: `File asks for ${side(conflict.file)}; runs on ${side(conflict.app, false)}.`,
      sentence: `${MANIFEST_FILE} asks for ${side(conflict.file)}; this agent runs on ${side(conflict.app)}.`,
      primary: { action: 'update_file', label: 'Update file', title: `Rewrite ${MANIFEST_FILE} to say ${side(conflict.app)}` },
      alternative: { action: 'use_file', label: `Use ${fileName}`, title: `Run this agent on ${side(conflict.file)}, as ${MANIFEST_FILE} asks` }
    }
  }
  return {
    kind: 'unrecorded',
    text: `File pins ${side(conflict.file)}; Default is ${side(conflict.app, false)}.`,
    sentence: `${MANIFEST_FILE} pins ${side(conflict.file)}; your Default runtime is ${side(conflict.app)}.`,
    primary: { action: 'use_default', label: 'Use Default', title: `Use Default runtime — removes the pin from ${MANIFEST_FILE}` },
    alternative: { action: 'use_file', label: `Keep ${fileName}`, title: `Keep running this agent on ${side(conflict.file)}` }
  }
}

/** What a refusal says, in the user's words; null for one that only means "look again". */
export function conflictRefusalText(code: string, message: string): string | null {
  if (code === 'no_conflict') return null
  if (code === 'turn_in_progress') return `${RUNTIME_CONFLICT_BUSY} Then try again.`
  if (code === 'manifest_modified') return `${MANIFEST_FILE} just changed — check this again.`
  return message
}

export interface RuntimeConflictState {
  copy: RuntimeConflictCopy
  /** A turn of this agent is running: the actions wait (the write needs the turn lock). */
  running: boolean
  pending: boolean
  /** The last refusal, until the next try or the conflict changes. */
  failure: string | null
  run: (action: RuntimeConflictAction) => void
}

/**
 * The conflict of `agent`, worded, with its actions — or null when there is
 * none (and always for a vault agent or a bare one, which main never gives a
 * conflict).
 *
 * `onResolved` hears every success, worded ({@link runtimeConflictSettledText}):
 * what the file lost ("Dropped “gpt-5.5-pro”."), else what changed — every
 * surface puts it in the conflict's place, so an answer never just vanishes;
 * `turnRunning` adds the caller's own knowledge of a running turn (the
 * composer's stream) to main's list of running sessions.
 */
export function useRuntimeConflict(
  agent: LocalAgentDto | null | undefined,
  options: { onResolved?: (text: string) => void; turnRunning?: boolean } = {}
): RuntimeConflictState | null {
  const conflict = agent && !agent.vault ? (agent.resolvedRuntime?.conflict ?? null) : null
  const fileCli = conflict && isEngineLoginId(conflict.file.engine) ? conflict.file.engine : null
  const appCli = conflict && isEngineLoginId(conflict.app.engine) ? conflict.app.engine : null
  const { data: models } = useModels()
  const { data: fileCatalog } = useRuntimeModelCatalog(fileCli)
  const { data: appCatalog } = useRuntimeModelCatalog(appCli)
  const { data: sessions } = useAgentActiveSessions({ enabled: conflict !== null })
  const resolve = useResolveRuntimeConflict()
  const key = conflict && agent ? `${agent.id}:${JSON.stringify(conflict)}` : null
  const [failure, setFailure] = useState<{ key: string; text: string } | null>(null)
  if (!conflict || !agent || key === null) return null

  const modelName: ConflictModelName = (side) => {
    if (!side.modelId) return null
    const catalog = side === conflict.file ? fileCatalog : appCatalog
    return catalog?.models.find((model) => model.id === side.modelId)?.name
      ?? (models ?? []).find((model) => model.id === side.modelId)?.name
      ?? side.modelId
  }
  const running = options.turnRunning === true || (sessions ?? []).some((session) => session.agentId === agent.id)
  const stamp = agent.stamps[MANIFEST_FILE] ?? null
  const run = (action: RuntimeConflictAction): void => {
    if (running || resolve.isPending || !stamp) return
    setFailure(null)
    resolve.mutate({ agentId: agent.id, action, stamp }, {
      onSuccess: (outcome) => {
        if (outcome.ok) {
          options.onResolved?.(runtimeConflictSettledText(action, conflict, outcome.note))
          return
        }
        const text = conflictRefusalText(outcome.code, outcome.message)
        if (text) setFailure({ key, text })
      },
      onError: (err) => setFailure({ key, text: unwrapIpcError(err) })
    })
  }
  return {
    copy: runtimeConflictCopy(conflict, modelName),
    running,
    pending: resolve.isPending,
    failure: failure?.key === key ? failure.text : null,
    run
  }
}

/**
 * What an answer did, for the place the conflict held once it lands: main's
 * note when the file lost something ("Dropped “gpt-5.5-pro”."), else the change
 * itself. Keeping a pin the app never chose changes nothing that runs.
 */
export function runtimeConflictSettledText(action: RuntimeConflictAction, conflict: LocalAgentRuntimeConflict, note?: string): string {
  if (note) return note
  if (action === 'update_file') return `Updated ${MANIFEST_FILE}.`
  if (action === 'use_default') return 'Follows the Default runtime now.'
  const engine = RUNTIME_MODE_NAMES[conflict.file.engine]
  return conflict.kind === 'unrecorded' ? `Keeps running on ${engine}.` : `Runs on ${engine} now.`
}

/**
 * The conflict in the Runs with panel, as its own notice block under the
 * reserved line — the composer row's layout (icon, one-line message with the
 * whole sentence as its title and description, the split button pinned to the
 * end) and the composer's own {@link NoticeSplitButton}, so the two surfaces
 * draw one control, not two.
 *
 * It exists only while main reports a conflict, which the file or the choice
 * changing brings about, never a click on the block itself. Once an answer
 * lands, `settled` holds the block's place as an inert note ("Dropped “…”.",
 * or what changed) until the panel's next edit, so the button just clicked
 * does not vanish and pull the panel up under the pointer (ux_rules rule 1).
 * A refusal stands in for the sentence, cause first, until the next try
 * (rule 6); the actions stay where they were.
 */
export function RuntimeConflictBlock({ state, settled }: {
  state: RuntimeConflictState | null
  settled: string | null
}): React.JSX.Element | null {
  if (!state && settled === null) return null
  if (!state) {
    return (
      <div data-runtime-conflict="settled" inert className={`${BLOCK} border-[var(--color-border)] bg-[var(--color-bg)]`}>
        <NoticeButton aria-hidden="true" tabIndex={-1} className="invisible w-0 !px-0 !border-x-0 overflow-hidden">{'\u00a0'}</NoticeButton>
        <Check size={13} aria-hidden="true" className="-ml-2 shrink-0 text-[var(--color-accent)]" />
        <p className="min-w-0 flex-1 truncate text-xs leading-snug text-[var(--color-text)]" title={settled ?? undefined}>{settled}</p>
      </div>
    )
  }
  const { copy, running, pending, failure } = state
  const blocked = running || pending
  return (
    <div data-runtime-conflict="open" className={`${BLOCK} border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10`}>
      {/* The composer row's strut: one button tall in every state, so the note that follows an answer keeps the height. */}
      <NoticeButton aria-hidden="true" tabIndex={-1} className="invisible w-0 !px-0 !border-x-0 overflow-hidden">{'\u00a0'}</NoticeButton>
      <ArrowLeftRight size={13} aria-hidden="true" className="-ml-2 shrink-0 text-[var(--color-warning)]" />
      {failure
        ? <p role="alert" className="min-w-0 flex-1 truncate text-xs leading-snug text-[var(--color-danger)]" title={failure}>{failure}</p>
        : <p className="min-w-0 flex-1 truncate text-xs leading-snug text-[var(--color-text)]" title={copy.sentence} aria-description={copy.sentence}>{copy.text}</p>}
      {/* Pinned to the end: a sentence or a refusal of another length never moves it (rules 1, 19). */}
      <div data-conflict-actions className="ml-auto flex shrink-0 items-center">
        <NoticeSplitButton label={copy.primary.label} icon={FilePen}
          title={running ? RUNTIME_CONFLICT_BUSY : copy.primary.title}
          pending={pending} pendingLabel="Saving…" disabled={blocked}
          onClick={() => state.run(copy.primary.action)}
          moreLabel="More ways to settle the runtime"
          items={[{ label: copy.alternative.label, icon: Undo2, title: running ? RUNTIME_CONFLICT_BUSY : copy.alternative.title, disabled: blocked, onSelect: () => state.run(copy.alternative.action) }]} />
      </div>
    </div>
  )
}

/** The block's shell, in both states: same border width and padding, so the note keeps the conflict's height. */
const BLOCK = 'mt-2 flex min-w-0 items-center gap-2 rounded-md border px-2.5 py-1.5'
