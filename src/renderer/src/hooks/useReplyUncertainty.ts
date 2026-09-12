import { useEffect, useState, useSyncExternalStore } from 'react'

// Shared by transcript and Inbox; main remains authoritative after a reload.
const reasons = new Map<string, string>()
const listeners = new Set<() => void>()
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export function rememberReplyUncertainty(requestId: string, reason: string): void {
  reasons.set(requestId, reason)
  // Historical registrations never become live again. Main can rehydrate any
  // still-live registration evicted from this bounded display cache.
  if (reasons.size > 2000) reasons.delete(reasons.keys().next().value!)
  for (const listener of listeners) listener()
}

export function useReplyUncertainty(requestId: string | undefined, live: boolean): {
  reason: string | null; checking: boolean
} {
  const reason = useSyncExternalStore(subscribe, () => requestId ? reasons.get(requestId) ?? null : null)
  const [checked, setChecked] = useState<string | undefined>()
  useEffect(() => {
    if (!requestId || !live) return
    let current = true
    const refresh = async (): Promise<void> => {
      try {
        const result = await window.api.agents.replyUncertainty(requestId)
        if (!current) return
        if (result) rememberReplyUncertainty(requestId, result)
        setChecked(requestId)
      } catch { /* Retain the warning and keep an unverified new block inert. */ }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 700)
    return () => { current = false; clearInterval(timer) }
  }, [requestId, live])
  return { reason, checking: live && !!requestId && checked !== requestId && !reason }
}
