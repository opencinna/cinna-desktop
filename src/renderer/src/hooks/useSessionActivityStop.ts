import { useCallback, useMemo, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import type { SessionActivityStopResult } from '../../../shared/sessionActivity'
import { unwrapIpcError } from '../utils/ipcError'

/** What a popover row needs to offer Stop on one item. */
export interface SessionActivityStopControl {
  stop(itemId: string): void
  /** A stop for the item is in flight. */
  pending(itemId: string): boolean
  /** Why the last stop for the item did not happen, until the next one. */
  refusal(itemId: string): string | null
}

interface StopVars {
  chatId: string
  itemId: string
}

const keyOf = ({ chatId, itemId }: StopVars): string => `${chatId}\n${itemId}`

/**
 * Stop per activity item, owned above the popover.
 *
 * The rows it serves come and go — a popover closes, a badge leaves with its
 * last running item — so the mutation and its callbacks live here, in the
 * component that holds the whole strip. Success needs nothing: main's push
 * moves the row. A refusal is kept per item and shown under its row.
 */
export function useSessionActivityStop(chatId: string): SessionActivityStopControl {
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set())
  const [refusals, setRefusals] = useState<ReadonlyMap<string, string>>(() => new Map())

  const settle = useCallback((vars: StopVars, reason: string | null): void => {
    const key = keyOf(vars)
    setPending((prev) => {
      if (!prev.has(key)) return prev
      const next = new Set(prev)
      next.delete(key)
      return next
    })
    if (reason !== null) setRefusals((prev) => new Map(prev).set(key, reason))
  }, [])

  // Callbacks on the hook, not on `mutate`: those are dropped once the caller unmounts.
  const { mutate } = useMutation<SessionActivityStopResult, unknown, StopVars>({
    mutationFn: (vars) => window.api.sessionActivity.stop(vars.chatId, vars.itemId),
    onMutate: (vars) => {
      const key = keyOf(vars)
      setPending((prev) => new Set(prev).add(key))
      setRefusals((prev) => {
        if (!prev.has(key)) return prev
        const next = new Map(prev)
        next.delete(key)
        return next
      })
    },
    onSuccess: (result, vars) => settle(vars, result.ok ? null : result.reason),
    onError: (error, vars) => settle(vars, unwrapIpcError(error, 'This process could not be stopped.'))
  })

  return useMemo<SessionActivityStopControl>(() => ({
    stop: (itemId) => {
      const vars = { chatId, itemId }
      if (pending.has(keyOf(vars))) return
      mutate(vars)
    },
    pending: (itemId) => pending.has(keyOf({ chatId, itemId })),
    refusal: (itemId) => refusals.get(keyOf({ chatId, itemId })) ?? null
  }), [chatId, mutate, pending, refusals])
}
