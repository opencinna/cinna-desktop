import { useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, FilePen, Loader2, Undo2 } from 'lucide-react'
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
import { usePopover } from '../../ui/usePopover'
import { unwrapIpcError } from '../../../utils/ipcError'
import { LINE_BUTTON } from './fieldClasses'
import { MENU_ITEM } from './OpenInMenu'

/**
 * The file and the app disagree about what a kit agent runs on
 * (`LocalAgentResolvedRuntime.conflict`, resolved in main) — the words and the
 * one operation every surface that tells it shares: the Runs with panel's
 * status line, the composer's notice row and the publish warning.
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
  text: string
  primary: RuntimeConflictChoice
  alternative: RuntimeConflictChoice
}

/** A model id by the name the registry or the runtime's own list gives it, else null to leave it out. */
export type ConflictModelName = (side: LocalAgentRuntimeSide) => string | null

/**
 * The sentence and the two actions. Pure, so the wording is tested once.
 *
 * Each side names its engine and, when known, the model it would run — the
 * cost is what hurt in the report this exists for. When both sides are
 * OpenCode the difference is the credential, so both sides name it.
 */
export function runtimeConflictCopy(conflict: LocalAgentRuntimeConflict, modelName: ConflictModelName): RuntimeConflictCopy {
  const credentialOnly = conflict.file.engine === conflict.app.engine
  const side = (value: LocalAgentRuntimeSide): string => {
    const model = modelName(value)
    const on = credentialOnly && value.credentialName ? ` on ${value.credentialName}` : ''
    return `${RUNTIME_MODE_NAMES[value.engine]}${on}${model ? ` (${model})` : ''}`
  }
  const fileName = RUNTIME_MODE_NAMES[conflict.file.engine]
  if (conflict.kind === 'choice') {
    return {
      kind: 'choice',
      text: `${MANIFEST_FILE} asks for ${side(conflict.file)}; this agent runs on ${side(conflict.app)}.`,
      primary: { action: 'update_file', label: 'Update file', title: `Rewrite ${MANIFEST_FILE} to say ${side(conflict.app)}` },
      alternative: { action: 'use_file', label: `Use ${fileName}`, title: `Run this agent on ${side(conflict.file)}, as ${MANIFEST_FILE} asks` }
    }
  }
  return {
    kind: 'unrecorded',
    text: `${MANIFEST_FILE} pins ${side(conflict.file)}; your Default runtime is ${side(conflict.app)}.`,
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
 * `onNote` hears what the file lost ("Dropped “gpt-5.5-pro”.") on success;
 * `turnRunning` adds the caller's own knowledge of a running turn (the
 * composer's stream) to main's list of running sessions.
 */
export function useRuntimeConflict(
  agent: LocalAgentDto | null | undefined,
  options: { onNote?: (text: string) => void; turnRunning?: boolean } = {}
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
          if (outcome.note) options.onNote?.(outcome.note)
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

/** The opaque menu a line's split button opens (ux_rules rule 20): a control, not glass. */
const LINE_MENU_SURFACE =
  'z-50 w-56 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-1 shadow-xl'

/**
 * The conflict on the Runs with panel's reserved line: the sentence, then the
 * app's answer as the one labelled button and the file's behind its chevron —
 * at this line's scale, inside its fixed height (rule 1). A refusal stands in
 * for the sentence, cause first, until the next try (rule 6).
 */
export function RuntimeConflictLine({ state, tone, danger }: {
  state: RuntimeConflictState
  /** The line's warning colour class. */
  tone: string
  /** The line's error colour class. */
  danger: string
}): React.JSX.Element {
  const menu = usePopover<HTMLButtonElement>('below-right')
  const { copy, running, pending, failure } = state
  const blocked = running || pending
  const busyTitle = running ? RUNTIME_CONFLICT_BUSY : undefined
  return (
    <div className="flex h-4 min-w-0 items-center gap-2">
      {failure
        ? <div role="alert" className={`min-w-0 truncate ${danger}`} title={failure}>{failure}</div>
        : <div className={`min-w-0 truncate ${tone}`} title={copy.text}>{copy.text}</div>}
      <div className="flex shrink-0 items-stretch">
        <button type="button" className={`${LINE_BUTTON} rounded-r-none`} aria-label={copy.primary.label}
          title={busyTitle ?? copy.primary.title} aria-disabled={blocked || undefined}
          onClick={() => state.run(copy.primary.action)}>
          {pending ? <Loader2 size={10} className="animate-spin" aria-hidden="true" /> : <FilePen size={10} aria-hidden="true" />}
          {copy.primary.label}
        </button>
        <button type="button" ref={menu.triggerRef} className={`${LINE_BUTTON} -ml-px rounded-l-none px-0.5`}
          aria-label="More ways to settle the runtime" title="More ways to settle the runtime"
          aria-haspopup="menu" aria-expanded={menu.open} aria-disabled={blocked || undefined}
          onClick={() => { if (!blocked || menu.open) menu.setOpen(!menu.open) }}>
          <ChevronDown size={10} aria-hidden="true" />
        </button>
      </div>
      {menu.open && menu.style && createPortal(
        <div ref={menu.popoverRef} role="menu" aria-label="More ways to settle the runtime" style={menu.style} className={LINE_MENU_SURFACE}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            event.stopPropagation()
            menu.setOpen(false)
            menu.triggerRef.current?.focus()
          }}>
          <button type="button" role="menuitem" aria-label={copy.alternative.label} title={copy.alternative.title}
            className={MENU_ITEM} disabled={blocked}
            onClick={() => { menu.setOpen(false); state.run(copy.alternative.action) }}>
            <Undo2 size={12} aria-hidden="true" />
            <span className="flex-1 truncate">{copy.alternative.label}</span>
          </button>
        </div>,
        document.body
      )}
    </div>
  )
}
