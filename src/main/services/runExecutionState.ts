import type { RunHandle } from './runExecutionService'

/** Process-local turn ownership. Type-only dependencies keep read views acyclic. */
export const activeRunsByChat = new Map<string, RunHandle>()

const closedListeners = new Set<(chatId: string) => void>()

/**
 * Told the chat id each time a main-owned turn lets go of its chat. The task
 * dispatcher waits for exactly this before it starts work in a folder where a
 * turn was running. A listener that throws is ignored.
 */
export function onRunClosed(listener: (chatId: string) => void): () => void {
  closedListeners.add(listener)
  return () => { closedListeners.delete(listener) }
}

export function runClosed(chatId: string): void {
  for (const listener of [...closedListeners]) {
    try { listener(chatId) } catch { /* a listener's failure is its own */ }
  }
}
