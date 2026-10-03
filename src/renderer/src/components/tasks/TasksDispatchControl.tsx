import { useEffect, useId } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Check, ChevronDown, ExternalLink, Loader2, Play } from 'lucide-react'
import { usePopover } from '../ui/usePopover'
import { useOpenTask } from '../../hooks/useTasks'
import {
  DISPATCH_MODE_LABELS,
  dispatchPausedParts,
  dispatchPausedText,
  type useDispatchControls
} from '../../hooks/useTaskDispatch'
import { TASK_DISPATCH_MODES, type AgentDispatchState } from '../../../../shared/taskDispatch'

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
const ITEM_SELECTOR = '[role="menuitem"],[role="menuitemradio"]'

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
        title={`Run mode: ${DISPATCH_MODE_LABELS[mode]}`}
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
          {TASK_DISPATCH_MODES.map((value) => (
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
