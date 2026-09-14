import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useState,
  type SetStateAction
} from 'react'

/**
 * Which transcript blocks the user has opened, so the transcript can offer one
 * "Collapse expanded" action for all of them.
 *
 * A block counts only while it is expanded, its default is collapsed, **and**
 * every group around it is open ({@link TranscriptVisibleContext}).
 * A block that opens by default (a compact-mode thinking block, a live tool
 * result, an agent sub-thread while its agent streams) never counts, so the
 * pill does not appear merely because such a block exists; and a default-open
 * block the user closed has nothing to collapse.
 *
 * An external store rather than React state so a block toggling re-renders
 * only its subscribers, and only when "anything counted" flips.
 */
export interface TranscriptExpansionStore {
  subscribe: (listener: () => void) => () => void
  /** Snapshot for `useSyncExternalStore`: is any counted block expanded? */
  hasExpanded: () => boolean
  /** Collapse every counted block. Default-expanded blocks are left alone. */
  collapseAll: () => void
  /** Register `id` as counted with the setter that collapses it, or unregister with `null`. */
  set: (id: string, collapse: (() => void) | null) => void
}

export function createTranscriptExpansionStore(): TranscriptExpansionStore {
  const counted = new Map<string, () => void>()
  const listeners = new Set<() => void>()
  let snapshot = false

  const emit = (): void => {
    const next = counted.size > 0
    if (next === snapshot) return
    snapshot = next
    listeners.forEach((listener) => listener())
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    hasExpanded: () => snapshot,
    collapseAll() {
      const collapses = [...counted.values()]
      counted.clear()
      collapses.forEach((collapse) => collapse())
      emit()
    },
    set(id, collapse) {
      if (collapse) counted.set(id, collapse)
      else counted.delete(id)
      emit()
    }
  }
}

export const TranscriptExpansionContext = createContext<TranscriptExpansionStore | null>(null)

/**
 * False inside a closed group. A group keeps its steps mounted while closed
 * (its height animates), so a block the user opened inside it is still
 * "expanded" — but nothing of it is on screen, and a "Collapse expanded" pill
 * offered for it would point at nothing (ux_rules §7).
 */
export const TranscriptVisibleContext = createContext(true)

/**
 * Expand state for a transcript block, registered with the enclosing
 * transcript's {@link TranscriptExpansionStore}.
 *
 * - `setExpanded` is the user's toggle, `useState`-shaped.
 * - `setAutoExpanded` is for the component's own automatic transitions (an
 *   agent sub-thread opening while its agent streams and closing after): it
 *   moves the default along with the state, so an automatic open is never
 *   counted as the user's.
 *
 * Outside a provider (the Inbox, any surface that is not a transcript) this is
 * plain local state.
 */
export function useTranscriptDisclosure(
  initialExpanded: boolean
): [boolean, (value: SetStateAction<boolean>) => void, (value: boolean) => void] {
  const store = useContext(TranscriptExpansionContext)
  const id = useId()
  const [state, setState] = useState(() => ({
    expanded: initialExpanded,
    defaultExpanded: initialExpanded
  }))

  const setExpanded = useCallback((value: SetStateAction<boolean>) => {
    setState((s) => {
      const expanded = typeof value === 'function' ? value(s.expanded) : value
      return expanded === s.expanded ? s : { ...s, expanded }
    })
  }, [])

  const setAutoExpanded = useCallback((value: boolean) => {
    setState((s) =>
      s.expanded === value && s.defaultExpanded === value
        ? s
        : { expanded: value, defaultExpanded: value }
    )
  }, [])

  // Counted only while every group around it is open: collapse-all acts on
  // what the user can see.
  const visible = useContext(TranscriptVisibleContext)
  const counted = state.expanded && !state.defaultExpanded && visible
  useEffect(() => {
    if (!store || !counted) return
    store.set(id, () => setExpanded(false))
    return () => store.set(id, null)
  }, [store, id, counted, setExpanded])

  return [state.expanded, setExpanded, setAutoExpanded]
}
