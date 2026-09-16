import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import type { SessionActivityItem, SessionActivityStopResult } from '../../../shared/sessionActivity'
import { unwrapIpcError } from '../utils/ipcError'

/** What a popover row needs to offer Stop on one item. */
export interface SessionActivityStopControl {
  stop(itemId: string): void
  /** A stop for the item is in flight, or was accepted and the item still runs. */
  pending(itemId: string): boolean
  /** Why the last stop for the item did not happen, while the item still runs. */
  refusal(itemId: string): string | null
}

/**
 * How long an accepted stop keeps saying "Stopping…" when no push moves the
 * item. The engines send the stopped state before they answer, so this is
 * only a fallback.
 */
export const STOP_SETTLE_FALLBACK_MS = 10_000

interface StopVars {
  chatId: string
  itemId: string
}

const keyOf = ({ chatId, itemId }: StopVars): string => `${chatId}\n${itemId}`

function without<V>(map: ReadonlyMap<string, V>, keep: (key: string) => boolean): ReadonlyMap<string, V> {
  const next = new Map([...map].filter(([key]) => keep(key)))
  return next.size === map.size ? map : next
}

function withoutKeys(set: ReadonlySet<string>, keep: (key: string) => boolean): ReadonlySet<string> {
  const next = new Set([...set].filter(keep))
  return next.size === set.size ? set : next
}

/**
 * Stop per activity item, owned above the popover.
 *
 * The rows it serves come and go — a popover closes, a badge leaves with its
 * last running item — so the mutation and its callbacks live here, in the
 * component that holds the whole strip.
 *
 * - **Accepted:** the item says "Stopping…" until main's push shows it no
 *   longer running (usually already there), or the fallback passes.
 * - **Refused:** the reason is kept per item and shown under its row. A retry
 *   leaves it on screen until the new answer replaces or clears it, so the row
 *   does not shrink under the pointer.
 * - **Ended:** an item that is no longer running keeps neither.
 */
export function useSessionActivityStop(chatId: string, items: readonly SessionActivityItem[]): SessionActivityStopControl {
  // From the click until the answer refuses, or the item stops running.
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set())
  const [refusals, setRefusals] = useState<ReadonlyMap<string, string>>(() => new Map())
  const timers = useRef(new Map<string, number>())

  const running = useMemo(
    () => new Set(items.filter((item) => item.state === 'running').map((item) => keyOf({ chatId, itemId: item.id }))),
    [chatId, items]
  )
  const runningRef = useRef(running)
  runningRef.current = running

  const clearTimer = useCallback((key: string): void => {
    const timer = timers.current.get(key)
    if (timer !== undefined) window.clearTimeout(timer)
    timers.current.delete(key)
  }, [])

  const unpend = useCallback((key: string): void => {
    clearTimer(key)
    setPending((prev) => withoutKeys(prev, (k) => k !== key))
  }, [clearTimer])

  // Only this chat's running items keep either: anything else has ended (or
  // belongs to a chat no longer shown, whose keys are dropped with it).
  useEffect(() => {
    setPending((prev) => withoutKeys(prev, (key) => running.has(key)))
    setRefusals((prev) => without(prev, (key) => running.has(key)))
    for (const key of [...timers.current.keys()]) if (!running.has(key)) clearTimer(key)
  }, [running, clearTimer])

  useEffect(() => {
    const live = timers.current
    return () => {
      for (const timer of live.values()) window.clearTimeout(timer)
      live.clear()
    }
  }, [])

  // Callbacks on the hook, not on `mutate`: those are dropped once the caller unmounts.
  const { mutate } = useMutation<SessionActivityStopResult, unknown, StopVars>({
    mutationFn: (vars) => window.api.sessionActivity.stop(vars.chatId, vars.itemId),
    onMutate: (vars) => {
      setPending((prev) => new Set(prev).add(keyOf(vars)))
    },
    onSuccess: (result, vars) => {
      const key = keyOf(vars)
      if (!result.ok) {
        unpend(key)
        setRefusals((prev) => new Map(prev).set(key, result.reason))
        return
      }
      setRefusals((prev) => without(prev, (k) => k !== key))
      if (!runningRef.current.has(key)) {
        unpend(key)
        return
      }
      clearTimer(key)
      timers.current.set(key, window.setTimeout(() => unpend(key), STOP_SETTLE_FALLBACK_MS))
    },
    onError: (error, vars) => {
      const key = keyOf(vars)
      unpend(key)
      setRefusals((prev) => new Map(prev).set(key, unwrapIpcError(error, 'This process could not be stopped.')))
    }
  })

  return useMemo<SessionActivityStopControl>(() => ({
    stop: (itemId) => {
      const vars = { chatId, itemId }
      if (pending.has(keyOf(vars))) return
      mutate(vars)
    },
    pending: (itemId) => pending.has(keyOf({ chatId, itemId })),
    refusal: (itemId) => {
      const key = keyOf({ chatId, itemId })
      return running.has(key) ? refusals.get(key) ?? null : null
    }
  }), [chatId, mutate, pending, refusals, running])
}
