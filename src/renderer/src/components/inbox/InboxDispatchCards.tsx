import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { useOpenTask } from '../../hooks/useTasks'
import { dispatchGateSettledText, dispatchPausedParts, useAnswerDispatchGate, useDispatchControls } from '../../hooks/useTaskDispatch'
import { DISPATCH_NOTE_INTERRUPTED, DISPATCH_NOTE_UNREPORTED } from '../../../../shared/taskDispatch'
import { useUIStore } from '../../stores/ui.store'
import { formatRelativeFromDate } from '../../utils/cinnaTime'
import { unwrapIpcError } from '../../utils/ipcError'
import type { TaskDispatchGateAction, TaskDispatchGateItem, TaskDispatchPausedItem } from '../../../../shared/inbox'

/**
 * The task dispatcher's two Inbox cards, in the shell every Inbox row uses:
 * the task's title and who/when on the left, **Open the task** on the right,
 * and the thing to decide under it.
 *
 * Like an answered ask, a card the user acted on stays on screen with what it
 * settled as (`InboxView` retains it) rather than vanishing from under the
 * pointer on the next read (`ux_rules.md` §1). A failure keeps the card and
 * its buttons and says why beside them (§6).
 */

const PRIMARY =
  'inline-flex items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-2.5 py-1 text-[11px] font-medium text-white ' +
  'transition-colors hover:bg-[var(--color-accent-hover)] aria-disabled:opacity-60'
const SECONDARY =
  'inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-2.5 py-1 text-[11px] font-medium ' +
  'text-[var(--color-text)] transition-colors hover:bg-[var(--color-bg-hover)] aria-disabled:opacity-60'
const TEXT_ACTION =
  'shrink-0 text-[11px] font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] transition-colors'

/** The card shell an Inbox row has: subject, who · when, and the way back to the task. */
function DispatchCardShell({
  subject,
  meta,
  taskId,
  highlighted = false,
  cardRef,
  label,
  children
}: {
  subject: string
  meta: string
  taskId: string | null
  highlighted?: boolean
  cardRef?: React.Ref<HTMLElement>
  label: string
  children: ReactNode
}): React.JSX.Element {
  const openTask = useOpenTask()
  return (
    <article
      ref={cardRef}
      aria-label={label}
      tabIndex={-1}
      // A ring, not a border: drawn outside the box, so marking the card moves nothing.
      className={`rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/40 px-3 py-2.5 outline-none transition-shadow ${
        highlighted ? 'ring-2 ring-[var(--color-accent)]' : ''
      }`}
    >
      <div className="min-w-0 mb-2 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-[var(--color-text)] truncate" title={subject}>{subject}</div>
          <div className="text-[11px] text-[var(--color-text-muted)] truncate">{meta}</div>
        </div>
        {taskId && (
          <button type="button" onClick={() => openTask(taskId)} className={TEXT_ACTION}>
            Open the task
          </button>
        )}
      </div>
      {children}
    </article>
  )
}

/**
 * A gate's task file as the agent's folder sees it: from its `.cinna/`
 * folder on (`.cinna/tasks/fix-login.md`), where every folder task lives.
 * A path without one is cut to its file name, so the name always shows; the
 * full path is the tooltip either way.
 */
export function gateFileLabel(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const at = normalized.lastIndexOf('/.cinna/')
  if (at >= 0) return normalized.slice(at + 1)
  return normalized.slice(normalized.lastIndexOf('/') + 1) || path
}

/** How long a card opened from Run next keeps its ring. */
const REVEAL_RING_MS = 2_500

/**
 * "Run a task changed outside Cinna?" — the dispatcher's approval of a task
 * whose file was written outside the app, showing the body exactly as the
 * agent will receive it. Approve trusts that content and runs it; Skip leaves
 * it out of the queue until the file changes again.
 */
export function DispatchGateCard({
  item,
  agentLabel,
  now,
  onActed
}: {
  item: TaskDispatchGateItem
  agentLabel: string | null
  now: Date
  onActed: (item: TaskDispatchGateItem) => void
}): React.JSX.Element {
  const answer = useAnswerDispatchGate()
  const reveal = useUIStore((s) => s.revealInboxGateId)
  const setReveal = useUIStore((s) => s.setRevealInboxGateId)
  const card = useRef<HTMLElement>(null)
  const [highlighted, setHighlighted] = useState(false)
  const [pending, setPending] = useState<TaskDispatchGateAction | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [settled, setSettled] = useState<string | null>(null)
  const [revealError, setRevealError] = useState<string | null>(null)

  // Opened from Run next: show this card once, then let the intent go.
  useEffect(() => {
    if (reveal !== item.gateId) return
    setReveal(null)
    card.current?.scrollIntoView?.({ block: 'center' })
    card.current?.focus({ preventScroll: true })
    setHighlighted(true)
    const timer = setTimeout(() => setHighlighted(false), REVEAL_RING_MS)
    return () => clearTimeout(timer)
  }, [reveal, item.gateId, setReveal])

  const act = async (action: TaskDispatchGateAction): Promise<void> => {
    if (pending) return
    setPending(action)
    setError(null)
    // Before the await, as an answered ask is: the next read drops the card.
    onActed(item)
    try {
      const result = await answer(item.gateId, action)
      if (result.ok) {
        setSettled(dispatchGateSettledText(action, result))
      } else if (result.code === 'unavailable') {
        setError(result.reason)
      } else {
        // The approval itself is gone (answered, superseded, the task deleted):
        // nothing left to press, so the card settles with main's sentence.
        setSettled(result.reason)
      }
    } finally {
      setPending(null)
    }
  }

  const revealFile = async (): Promise<void> => {
    if (!item.filePath) return
    setRevealError(null)
    try {
      const result = await window.api.agentFiles.reveal({ agentId: item.agentId, path: item.filePath })
      if (!result.success) setRevealError(result.error)
    } catch (cause) {
      setRevealError(unwrapIpcError(cause, 'Finder could not show it.'))
    }
  }

  return (
    <DispatchCardShell
      subject={item.taskTitle}
      meta={[agentLabel, formatRelativeFromDate(item.createdAt, now)].filter(Boolean).join(' · ')}
      taskId={item.taskId}
      highlighted={highlighted}
      cardRef={card}
      label="Run a task changed outside Cinna?"
    >
      <div className="rounded-md border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/5 px-3 py-2">
        <div className="text-[13px] font-medium text-[var(--color-text)]">Run a task changed outside Cinna?</div>
        {item.filePath && (
          <div className="mt-1 flex min-w-0 items-center gap-2 text-[11px]">
            {revealError ? (
              <span role="alert" className="min-w-0 flex-1 truncate text-[var(--color-danger)]" title={revealError}>{revealError}</span>
            ) : (
              <span data-gate-file className="min-w-0 flex-1 truncate font-mono text-[var(--color-text-muted)]" title={item.filePath}>
                {gateFileLabel(item.filePath)}
              </span>
            )}
            <button type="button" onClick={() => void revealFile()} title="Show the file in its folder" className={TEXT_ACTION}>
              Reveal
            </button>
          </div>
        )}
        <pre
          aria-label="What the agent will receive"
          className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 font-mono text-[11px] text-[var(--color-text-secondary)]"
        >
          {item.body}
        </pre>
        {settled ? (
          <p role="status" className="mt-2 text-[11px] text-[var(--color-text-secondary)]">{settled}</p>
        ) : (
          <div className="mt-2 flex items-center gap-2">
            <button type="button" className={PRIMARY} aria-disabled={!!pending} aria-busy={pending === 'approve'}
              onClick={() => void act('approve')}>
              {pending === 'approve' && <Loader2 size={11} className="animate-spin" aria-hidden="true" />}
              Approve and run
            </button>
            <button type="button" className={SECONDARY} aria-disabled={!!pending} aria-busy={pending === 'skip'}
              onClick={() => void act('skip')}>
              {pending === 'skip' && <Loader2 size={11} className="animate-spin" aria-hidden="true" />}
              Skip
            </button>
          </div>
        )}
        {error && <p role="alert" className="mt-1.5 text-[11px] text-[var(--color-danger)]">{error}</p>}
      </div>
    </DispatchCardShell>
  )
}

/**
 * "<agent>'s queue is paused" — on the task it paused on, with the note the
 * dispatcher left and **Resume**. Resume restarts the queue; the flagged task
 * stays where it is.
 */
export function DispatchPausedCard({
  item,
  agentLabel,
  now,
  onActed
}: {
  item: TaskDispatchPausedItem
  agentLabel: string | null
  now: Date
  onActed: (item: TaskDispatchPausedItem) => void
}): React.JSX.Element {
  const controls = useDispatchControls(item.agentId)
  const [settled, setSettled] = useState(false)
  const resuming = controls.pending === 'resume'
  const error = controls.error?.action === 'resume' ? controls.error.message : null
  const subject = `${agentLabel ?? 'This agent'}’s queue is paused`
  const parts = dispatchPausedParts({ reason: item.reason, taskId: item.taskId, taskTitle: item.taskTitle, at: item.pausedAt.getTime() })
  const line = `${parts.title.charAt(0).toUpperCase()}${parts.title.slice(1)}${parts.tail}`
  // The two notes the dispatcher writes say what the line already says.
  const note = item.note && item.note !== DISPATCH_NOTE_UNREPORTED && item.note !== DISPATCH_NOTE_INTERRUPTED ? item.note : null

  const resume = async (): Promise<void> => {
    if (resuming) return
    // Before the await, as an answered ask is: a resumed queue drops the card.
    onActed(item)
    if (await controls.resume()) setSettled(true)
  }

  return (
    <DispatchCardShell
      subject={subject}
      meta={formatRelativeFromDate(item.pausedAt, now)}
      taskId={item.taskId}
      label={subject}
    >
      <div className="rounded-md border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/5 px-3 py-2">
        <div className="flex items-start gap-2">
          <AlertTriangle size={13} className="mt-0.5 shrink-0 text-[var(--color-warning)]" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] text-[var(--color-text)]">{line}</div>
            {note && <div className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">{note}</div>}
          </div>
        </div>
        {settled ? (
          <p role="status" className="mt-2 text-[11px] text-[var(--color-text-secondary)]">
            Resumed. The task it paused on stays where it is.
          </p>
        ) : (
          <div className="mt-2 flex items-center gap-2">
            <button type="button" className={PRIMARY} aria-disabled={resuming} aria-busy={resuming}
              title="Let the queue start tasks on its own again. The flagged task stays where it is."
              onClick={() => void resume()}>
              {resuming && <Loader2 size={11} className="animate-spin" aria-hidden="true" />}
              Resume
            </button>
          </div>
        )}
        {error && <p role="alert" className="mt-1.5 text-[11px] text-[var(--color-danger)]">{error}</p>}
      </div>
    </DispatchCardShell>
  )
}
