import { create } from 'zustand'
import { HINTS, DEFAULT_RETIRE_AFTER, type Hint, type HintEvent } from '../constants/hints'

/**
 * Hint progress + the contextual-trigger bus.
 *
 * Progress (which hints the user has outgrown) is persisted to localStorage,
 * matching how the renderer already stores its other UI preferences (theme,
 * verbose mode, onboarding flags). It deliberately does NOT live in the
 * `app_settings` KV: that schema is all-boolean feature switches, and a
 * cosmetic per-hint counter map has no business widening it. Trade-off we're
 * taking knowingly — counters are per-install, not per-profile, and don't sync.
 */

const STORAGE_KEY = 'cinna-hints'

/** A contextual hint preempts at most this many times across all sessions. */
const CONTEXTUAL_SHOW_CAP = 2
/** Floor between two contextual preemptions, so a burst of activity can't nag. */
const MIN_PREEMPT_GAP_MS = 5000

interface HintProgress {
  /** hintId → times the user performed the gesture this hint teaches. */
  used: Record<string, number>
  /** hintId → times this contextual hint has preempted the rotation. */
  shown: Record<string, number>
}

/**
 * A factory, not a shared constant. Every write path here is copy-on-write, but
 * handing the same object out as both "initial state" and "state after reset"
 * means one future in-place mutation would corrupt it for the whole process —
 * and survive `reset()`.
 */
const emptyProgress = (): HintProgress => ({ used: {}, shown: {} })

function loadProgress(): HintProgress {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return emptyProgress()
    const parsed = JSON.parse(raw) as Partial<HintProgress>
    return {
      used: parsed.used && typeof parsed.used === 'object' ? parsed.used : {},
      shown: parsed.shown && typeof parsed.shown === 'object' ? parsed.shown : {}
    }
  } catch {
    // Corrupt blob — start over rather than break the new-chat screen.
    return emptyProgress()
  }
}

function saveProgress(progress: HintProgress): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(progress))
  } catch {
    /* quota / private mode — hints just won't retire across restarts */
  }
}

/** A hint is retired once its teaching signal has been observed enough times. */
export function isHintRetired(progress: HintProgress, hint: Hint): boolean {
  if (!hint.retiredBy?.length) return false
  const count = progress.used[hint.id] ?? 0
  return count >= (hint.retireAfter ?? DEFAULT_RETIRE_AFTER)
}

export function hasHintProgress(progress: HintProgress): boolean {
  return Object.keys(progress.used).length > 0 || Object.keys(progress.shown).length > 0
}

// Session-only bookkeeping. Kept outside the store because nothing renders
// from it and re-render churn on every keystroke-adjacent event is pure waste.
let firedThisSession = new Set<string>()
let lastPreemptAt = 0
// Monotonic across clears — deriving the next nonce from the current state
// would reset it to 1 on every fire (the state is null by then), so the same
// hint firing twice would be indistinguishable to any consumer keying on it.
let preemptSeq = 0

interface HintsStore {
  progress: HintProgress
  /**
   * Composer is mid-interaction (a picker or modal is open). Rotation holds so
   * the bar doesn't change text under a user who's making a selection.
   */
  busy: boolean
  /**
   * Contextual hint currently preempting the rotation. `nonce` distinguishes
   * two consecutive fires of the same hint so the dwell timer restarts.
   */
  contextual: { hintId: string; nonce: number } | null
  /** Hidden for this session only via the bar's ×. The Settings toggle is the durable off-switch. */
  silenced: boolean
  observe: (event: HintEvent) => void
  /**
   * Retire the current contextual hint. `refund: true` also gives back the
   * lifetime show it consumed — used when the rotation hook drops a hint the
   * store couldn't know was inactionable, so an ESC pressed with no agents
   * selected doesn't silently spend one of that hint's two chances.
   */
  clearContextual: (refund?: boolean) => void
  setBusy: (busy: boolean) => void
  silence: () => void
  reset: () => void
}

export const useHintsStore = create<HintsStore>((set, get) => ({
  progress: loadProgress(),
  busy: false,
  contextual: null,
  silenced: false,

  /**
   * Single entry point for "the user just did X". Does two things:
   *   1. Credits every hint that teaches X, moving it toward retirement.
   *   2. Fires the contextual hint triggered by X, if it's still eligible.
   *
   * Availability is NOT checked here (the store has no `HintContext`) — the
   * rotation hook drops a contextual hint whose `available` predicate fails.
   */
  observe: (event) => {
    const state = get()
    let progress = state.progress
    let contextual = state.contextual
    let dirty = false

    const taught = HINTS.filter((h) => h.retiredBy?.includes(event))
    if (taught.length > 0) {
      const used = { ...progress.used }
      for (const h of taught) used[h.id] = (used[h.id] ?? 0) + 1
      progress = { ...progress, used }
      dirty = true
    }

    const candidate = HINTS.find((h) => h.trigger === event)
    if (
      candidate &&
      !isHintRetired(progress, candidate) &&
      !firedThisSession.has(candidate.id) &&
      (progress.shown[candidate.id] ?? 0) < CONTEXTUAL_SHOW_CAP &&
      Date.now() - lastPreemptAt >= MIN_PREEMPT_GAP_MS
    ) {
      firedThisSession.add(candidate.id)
      lastPreemptAt = Date.now()
      progress = {
        ...progress,
        shown: {
          ...progress.shown,
          [candidate.id]: (progress.shown[candidate.id] ?? 0) + 1
        }
      }
      contextual = { hintId: candidate.id, nonce: ++preemptSeq }
      dirty = true
    }

    if (!dirty) return
    saveProgress(progress)
    set({ progress, contextual })
  },

  clearContextual: (refund = false) => {
    const { contextual, progress } = get()
    if (!contextual) return
    if (!refund) {
      set({ contextual: null })
      return
    }
    const count = progress.shown[contextual.hintId] ?? 0
    const shown = { ...progress.shown }
    if (count <= 1) delete shown[contextual.hintId]
    else shown[contextual.hintId] = count - 1
    firedThisSession.delete(contextual.hintId)
    const next = { ...progress, shown }
    saveProgress(next)
    set({ contextual: null, progress: next })
  },

  setBusy: (busy) => {
    if (get().busy !== busy) set({ busy })
  },

  silence: () => set({ silenced: true, contextual: null }),

  reset: () => {
    firedThisSession = new Set()
    lastPreemptAt = 0
    preemptSeq = 0
    const fresh = emptyProgress()
    saveProgress(fresh)
    set({ progress: fresh, contextual: null, silenced: false })
  }
}))
