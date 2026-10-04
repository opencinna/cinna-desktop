import { useEffect, useId, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { createPortal } from 'react-dom'
import { AlertTriangle, Check, ChevronDown, ExternalLink, Loader2, Minus, Play, Plus } from 'lucide-react'
import { usePopover } from '../ui/usePopover'
import { useOpenTask } from '../../hooks/useTasks'
import {
  DISPATCH_MODE_LABELS,
  dispatchModeLabel,
  dispatchPausedParts,
  dispatchPausedText,
  refreshAfterDispatch,
  type useDispatchControls
} from '../../hooks/useTaskDispatch'
import { TASK_DISPATCH_MAX_RUNS, TASK_DISPATCH_MODES, type AgentDispatchState } from '../../../../shared/taskDispatch'

type Controls = ReturnType<typeof useDispatchControls>

const SPLIT_LEFT =
  'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-l-md border px-2 @3xl:px-2.5 ' +
  'text-xs font-medium transition-colors aria-disabled:cursor-not-allowed aria-disabled:opacity-60'
const SPLIT_LEFT_TONE =
  'border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'
/** A paused queue: the primary half is Resume, in the warning tone, because it needs the user. */
const SPLIT_LEFT_PAUSED =
  'border-[var(--color-warning)]/50 bg-[var(--color-warning)]/10 text-[var(--color-warning)] hover:bg-[var(--color-warning)]/20'
const SPLIT_RIGHT =
  'inline-flex h-7 shrink-0 items-center rounded-r-md border border-l-0 border-[var(--color-border)] px-1.5 ' +
  'text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]'
const MENU_SURFACE = 'app-popover-surface z-50 w-52 rounded-lg border border-[var(--color-border)] p-1 shadow-xl'
const MENU_ITEM =
  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-[var(--color-text)] ' +
  'transition-colors hover:bg-[var(--color-bg-hover)] focus-visible:bg-[var(--color-bg-hover)] focus-visible:outline-none ' +
  'disabled:cursor-not-allowed disabled:opacity-40'
/** How long − and + wait for the next click before saving N. */
const STEP_SAVE_DELAY_MS = 400
const ITEM_SELECTOR = '[role="menuitem"],[role="menuitemradio"]'
/** The − and + beside Up to N: square, on the item's line, so the menu keeps its rows. */
const STEP =
  'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--color-text-secondary)] ' +
  'transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)] focus-visible:bg-[var(--color-bg-hover)] ' +
  'focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40'

/**
 * The Tasks view's queue control, shown only while the view is filtered to one
 * agent whose queue Cinna works: **Run next** as the primary half, the run
 * mode behind the chevron with the current one checked (`ux_rules.md` §8).
 *
 * A paused queue changes the control, not the page: the primary half becomes
 * **Resume** in the warning tone, with a glyph whose tooltip and accessible
 * name is the pause sentence, and the menu gains the task it paused on and
 * Run next. Nothing is inserted above the list, so a poll that pauses the
 * queue moves nothing (§1); the Inbox card is what asks for attention.
 *
 * Narrower than the row needs (the 800 px window beside the sidebar), the
 * primary half drops its word for its icon; its name stays in `aria-label`
 * and `title`.
 *
 * Secondary-styled, so New task stays the row's one primary action. Its
 * actions belong to `TasksView` (`controls`), not to this control or its
 * menu, so a result survives the menu closing (§5).
 */
export function TasksRunNextControl({
  agentName,
  state,
  controls
}: {
  agentName: string
  state: AgentDispatchState
  controls: Controls
}): React.JSX.Element {
  const menu = usePopover<HTMLButtonElement>('below-right')
  const { open, setOpen, triggerRef, popoverRef } = menu
  const openTask = useOpenTask()
  const glyphId = useId()
  const running = controls.pending === 'run'
  const resuming = controls.pending === 'resume'
  const mode = controls.pendingMode ?? state.mode
  const savedRuns = controls.pendingMaxRuns ?? state.maxRuns
  // N for Up to N, held here so − and + answer every click at once: the
  // shown N is this one, never the one a save is still carrying. While the
  // queue runs Up to N, the latest N is saved once the clicks pause (and
  // after any save in flight); otherwise it is the N choosing Up to N saves.
  const [draftRuns, setDraftRuns] = useState<number | null>(null)
  const runs = draftRuns ?? savedRuns ?? TASK_DISPATCH_MAX_RUNS.default
  const paused = state.paused
  const pausedParts = paused ? dispatchPausedParts(paused) : null
  const pausedSentence = paused ? dispatchPausedText(paused) : null

  const items = (): HTMLButtonElement[] =>
    Array.from(popoverRef.current?.querySelectorAll<HTMLButtonElement>(ITEM_SELECTOR) ?? []).filter((item) => !item.disabled)

  // Focus moves into the menu once it is laid out, so the keyboard can act on it.
  useEffect(() => {
    if (open && menu.style) items()[0]?.focus({ preventScroll: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, menu.style !== null])

  // Escape and Tab close it and give focus back to the chevron; the arrows,
  // Home and End move between items (as `FileActionsMenu`).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' || e.key === 'Tab') {
        e.preventDefault()
        e.stopPropagation()
        setOpen(false)
        triggerRef.current?.focus({ preventScroll: true })
        return
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return
      const list = items()
      if (list.length === 0) return
      e.preventDefault()
      const at = list.indexOf(document.activeElement as HTMLButtonElement)
      const next =
        e.key === 'Home'
          ? 0
          : e.key === 'End'
            ? list.length - 1
            : e.key === 'ArrowDown'
              ? (at + 1) % list.length
              : (at - 1 + list.length) % list.length
      list[next].focus({ preventScroll: true })
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, setOpen, triggerRef])

  // The menu opening or closing drops the held N back to the saved one —
  // unless an N is still on its way to being saved, which is what the user
  // last chose.
  const unsaved = mode === 'up_to' && draftRuns !== null && draftRuns !== savedRuns
  useEffect(() => {
    if (!unsaved) setDraftRuns(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Save the latest N once the clicks pause and nothing else is being saved.
  // When the save settles, the held N gives way to what main saved (on a
  // refusal, the N that is really in force, with the error beside the
  // control) — unless another click has moved it meanwhile, which is then
  // saved in turn.
  const setMode = controls.setMode
  useEffect(() => {
    if (!unsaved || controls.pending !== null) return
    const n = draftRuns!
    const timer = setTimeout(() => {
      void setMode('up_to', n).then(() => setDraftRuns((current) => (current === n ? null : current)))
    }, STEP_SAVE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [unsaved, draftRuns, controls.pending, setMode])

  // An N still waiting for its pause is saved when the control goes away (the
  // filter moved to another agent or to all agents), straight through the
  // bridge for this control's agent: the controls hook now belongs to the next
  // agent, and its pending state is not this save's to show.
  const queryClient = useQueryClient()
  const flushRef = useRef<(() => void) | null>(null)
  flushRef.current = unsaved && controls.pending === null
    ? () => {
        void window.api.taskDispatch.setMode(state.agentId, 'up_to', draftRuns!)
          .then(() => refreshAfterDispatch(queryClient), () => refreshAfterDispatch(queryClient))
      }
    : null
  useEffect(() => () => flushRef.current?.(), [])

  const step = (delta: number): void => {
    const next = Math.min(TASK_DISPATCH_MAX_RUNS.max, Math.max(TASK_DISPATCH_MAX_RUNS.min, runs + delta))
    if (next !== runs) setDraftRuns(next)
  }

  const pick = (fn: () => void): void => {
    setOpen(false)
    triggerRef.current?.focus({ preventScroll: true })
    fn()
  }

  return (
    <div className="flex shrink-0">
      {paused ? (
        <button
          type="button"
          className={`${SPLIT_LEFT} ${SPLIT_LEFT_PAUSED}`}
          aria-label="Resume"
          aria-describedby={glyphId}
          aria-disabled={resuming}
          aria-busy={resuming}
          title={`${pausedSentence}. Resume lets the queue start tasks on its own again.`}
          onClick={() => { if (!resuming) void controls.resume() }}
        >
          {resuming ? (
            <Loader2 size={12} className="animate-spin" aria-hidden="true" />
          ) : (
            <span id={glyphId} role="img" aria-label={pausedSentence!} title={pausedSentence!} data-dispatch-paused className="flex">
              <AlertTriangle size={12} aria-hidden="true" />
            </span>
          )}
          <span className="hidden @3xl:inline">Resume</span>
        </button>
      ) : (
        <button
          type="button"
          className={`${SPLIT_LEFT} ${SPLIT_LEFT_TONE}`}
          aria-label="Run next"
          aria-disabled={running}
          aria-busy={running}
          title="Run next"
          onClick={() => { if (!running) void controls.runNext() }}
        >
          {running ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <Play size={12} aria-hidden="true" />}
          <span className="hidden @3xl:inline">Run next</span>
        </button>
      )}
      <button
        ref={triggerRef}
        type="button"
        className={SPLIT_RIGHT}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Choose how the queue runs"
        title={`Run mode: ${dispatchModeLabel(mode, mode === 'up_to' ? runs : null)}`}
        onClick={() => setOpen(!open)}
      >
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {open && menu.style && createPortal(
        <div ref={popoverRef} role="menu" aria-label="Run mode" style={menu.style} className={MENU_SURFACE}>
          {pausedParts?.taskId && (
            <button
              type="button"
              role="menuitem"
              className={MENU_ITEM}
              title={pausedParts.title}
              onClick={() => pick(() => openTask(pausedParts.taskId!))}
            >
              <ExternalLink size={12} className="shrink-0 text-[var(--color-text-muted)]" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">Open {pausedParts.title}</span>
            </button>
          )}
          {/* The primary half is Resume while paused; Run next stays one press away. */}
          {paused && (
            <button
              type="button"
              role="menuitem"
              className={MENU_ITEM}
              disabled={running}
              title={`Start ${agentName}’s next Ready task now`}
              onClick={() => pick(() => void controls.runNext())}
            >
              <Play size={12} className="shrink-0 text-[var(--color-text-muted)]" aria-hidden="true" />
              <span className="flex-1 truncate">Run next</span>
            </button>
          )}
          {paused && <div role="separator" className="my-1 border-t border-[var(--color-border)]" />}
          {TASK_DISPATCH_MODES.map((value) => value === 'up_to' ? (
            // N is chosen on the item's own line: − and + beside it, the menu
            // open meanwhile, and the item saves Up to that N.
            <div key={value} className="flex items-center gap-0.5" data-dispatch-up-to>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={value === mode}
                aria-label={dispatchModeLabel(value, runs)}
                className={`${MENU_ITEM} min-w-0 flex-1`}
                disabled={controls.pending === 'mode'}
                onClick={() => pick(() => { if (value !== mode || runs !== savedRuns) void controls.setMode(value, runs) })}
              >
                <span className="flex-1 truncate">{dispatchModeLabel(value, runs)}</span>
                {value === mode && <Check size={12} className="text-[var(--color-accent)]" aria-hidden="true" />}
              </button>
              <button
                type="button"
                role="menuitem"
                aria-label="Fewer tasks at once"
                title="Fewer tasks at once"
                className={STEP}
                disabled={runs <= TASK_DISPATCH_MAX_RUNS.min}
                onClick={() => step(-1)}
              >
                <Minus size={12} aria-hidden="true" />
              </button>
              <button
                type="button"
                role="menuitem"
                aria-label="More tasks at once"
                title="More tasks at once"
                className={STEP}
                disabled={runs >= TASK_DISPATCH_MAX_RUNS.max}
                onClick={() => step(1)}
              >
                <Plus size={12} aria-hidden="true" />
              </button>
            </div>
          ) : (
            <button
              key={value}
              type="button"
              role="menuitemradio"
              aria-checked={value === mode}
              className={MENU_ITEM}
              disabled={controls.pending === 'mode'}
              onClick={() => pick(() => { if (value !== mode) void controls.setMode(value) })}
            >
              <span className="flex-1 truncate">{DISPATCH_MODE_LABELS[value]}</span>
              {value === mode && <Check size={12} className="text-[var(--color-accent)]" aria-hidden="true" />}
            </button>
          ))}
        </div>,
        document.body
      )}
    </div>
  )
}
