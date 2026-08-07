import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  HINTS,
  findHint,
  hintText,
  type Hint,
  type HintContext,
  type HintSurface
} from '../constants/hints'
import { useHintsStore, isHintRetired } from '../stores/hints.store'

/** Floor dwell for an ambient hint. */
const AMBIENT_MIN_MS = 7000
/** Long lines get proportionally longer on screen — a flat interval reads badly. */
const MS_PER_WORD = 400
/** Contextual hints are the ones the user actually needs — they linger. */
const CONTEXTUAL_MS = 10_000
/** Grace period after mount so the bar doesn't flash during a view transition. */
const START_DELAY_MS = 1500

function dwellFor(hint: Hint): number {
  const words = hintText(hint).split(/\s+/).length
  return Math.max(AMBIENT_MIN_MS, words * MS_PER_WORD)
}

/** Fisher-Yates. Order is per-session so the same three tips don't lead every launch. */
function shuffle<T>(items: T[]): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

export interface HintRotation {
  hint: Hint | null
  isContextual: boolean
  /** Spread onto the bar so hovering holds the current hint long enough to read. */
  hoverProps: {
    onMouseEnter: () => void
    onMouseLeave: () => void
  }
}

/**
 * Drives the hint bar: eligibility → shuffled rotation → contextual preemption.
 *
 * Rotation pauses whenever advancing the text would be hostile — while the
 * pointer rests on the bar, while the composer has a picker open (`busy`), and
 * while the window is in the background (otherwise a user who alt-tabs away
 * burns through the whole catalog unseen).
 */
export function useHintRotation(
  enabled: boolean,
  surface: HintSurface,
  ctx: HintContext
): HintRotation {
  const progress = useHintsStore((s) => s.progress)
  const busy = useHintsStore((s) => s.busy)
  const silenced = useHintsStore((s) => s.silenced)
  const contextual = useHintsStore((s) => s.contextual)
  const clearContextual = useHintsStore((s) => s.clearContextual)

  const [hovered, setHovered] = useState(false)
  const [started, setStarted] = useState(false)
  const [hidden, setHidden] = useState(() => document.hidden)
  // The hint on screen is tracked by id, not by index into the pool: an
  // availability flip mid-session (selecting an agent, creating a note) must
  // not yank the line the user is mid-read of.
  const [currentId, setCurrentId] = useState<string | null>(null)

  const active = enabled && !silenced

  useEffect(() => {
    if (!active) return
    const t = setTimeout(() => setStarted(true), START_DELAY_MS)
    return () => clearTimeout(t)
  }, [active])

  useEffect(() => {
    const onVisibility = (): void => setHidden(document.hidden)
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  // Ambient pool: this surface, not retired, actionable right now.
  const pool = useMemo(
    () =>
      HINTS.filter(
        (h) =>
          !h.trigger &&
          h.surfaces.includes(surface) &&
          !isHintRetired(progress, h) &&
          (h.available?.(ctx) ?? true)
      ),
    [progress, ctx, surface]
  )

  // Session-stable ordering. The shuffle happens once per hint — newly eligible
  // ids are appended (shuffled among themselves) rather than triggering a
  // whole-pool reshuffle, so the sequence stays put as availability changes.
  // Ineligible ids are filtered out at read time, not forgotten, so a hint that
  // becomes eligible again keeps its original slot.
  const orderRef = useRef<string[]>([])
  const poolKey = pool.map((h) => h.id).join('|')
  const order = useMemo(() => {
    const known = new Set(orderRef.current)
    const fresh = pool.filter((h) => !known.has(h.id)).map((h) => h.id)
    // Idempotent: a repeat run (StrictMode double-render) sees these as known.
    if (fresh.length > 0) orderRef.current = [...orderRef.current, ...shuffle(fresh)]
    const live = new Map(pool.map((h) => [h.id, h]))
    return orderRef.current
      .map((id) => live.get(id))
      .filter((h): h is Hint => h !== undefined)
  }, [poolKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const contextualHint = contextual ? findHint(contextual.hintId) : null
  const contextualEligible =
    !!contextualHint &&
    contextualHint.surfaces.includes(surface) &&
    (contextualHint.available?.(ctx) ?? true)

  // Contextual dwell. An ineligible hint — the store fires on the event alone
  // and can't run `available` itself — is dropped immediately, refunding the
  // lifetime show it consumed so a hint the user never saw isn't spent.
  useEffect(() => {
    if (!contextual) return
    if (!active || !contextualEligible) {
      clearContextual(true)
      return
    }
    if (hovered) return
    const t = setTimeout(clearContextual, CONTEXTUAL_MS)
    return () => clearTimeout(t)
  }, [contextual, contextualEligible, active, hovered, clearContextual])

  const showingContextual = active && contextualEligible
  // Hold `currentId` while it's still eligible; fall back to the head of the
  // order when it retires or its predicate goes false.
  const currentIdx = currentId ? order.findIndex((h) => h.id === currentId) : -1
  const ambientHint = currentIdx >= 0 ? order[currentIdx] : (order[0] ?? null)

  const rotating =
    active && started && !showingContextual && !busy && !hovered && !hidden && order.length > 1

  useEffect(() => {
    if (!rotating || !ambientHint) return
    const t = setTimeout(() => {
      const from = order.findIndex((h) => h.id === ambientHint.id)
      setCurrentId(order[(from + 1) % order.length]?.id ?? null)
    }, dwellFor(ambientHint))
    return () => clearTimeout(t)
  }, [rotating, ambientHint, order])

  const onMouseEnter = useCallback(() => setHovered(true), [])
  const onMouseLeave = useCallback(() => setHovered(false), [])

  // Nothing to show until the start delay elapses — avoids a hint flashing in
  // during the transition onto the new-chat screen. Contextual hints skip the
  // grace period: they're a direct response to something the user just did.
  const hint = !active
    ? null
    : showingContextual
      ? contextualHint
      : started
        ? ambientHint
        : null

  return {
    hint,
    isContextual: showingContextual && hint === contextualHint,
    hoverProps: { onMouseEnter, onMouseLeave }
  }
}
