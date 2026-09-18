/**
 * "Start a turn in that chat, when that chat is free."
 *
 * Both halves of the asynchronous loop need it and neither owns it: the return
 * packet waits for the **origin** chat (`handoverWake`), a revision waits for
 * the **executor's** chat (`handoverRevisions`). In both cases the chat is very
 * likely mid-turn — an agent that farmed work out and carried on, or an
 * executor still working through the brief — and `runExecutionService.start`
 * refuses a chat that already has a turn running. So the wait loop is lifted
 * from `followUpTurnService.openOne` once, here, and the per-chat promise chain
 * is what stops two handovers finishing together from racing one conversation.
 *
 * Every queue is **per construction**, not global: the two callers make one
 * each, and that is safe because they never address the same chat — a
 * handover's executor runs in a chat of its own task, and the origin chat
 * belongs to whoever asked. Both queues are fire-and-forget; a job that throws
 * is the caller's to record.
 */

export interface ChatTurnQueueDeps {
  /** Is a turn live in this chat right now? */
  isRunning(chatId: string): boolean
  now(): number
  delay(ms: number): Promise<void>
  /**
   * Read at **every** poll rather than captured, so a test that shortens the
   * ceiling after construction is obeyed by a wait already in flight.
   */
  timings: { pollMs: number; maxWaitMs: number }
}

export interface ChatTurnJob {
  /** Called once the chat is idle. Its failures are its own to record. */
  send(): Promise<void>
  /** Called instead, when the chat never went idle in time. */
  onTimedOut(): void
}

export function createChatTurnQueue(deps: ChatTurnQueueDeps) {
  const chains = new Map<string, Promise<void>>()

  async function waitAndSend(chatId: string, job: ChatTurnJob): Promise<void> {
    const started = deps.now()
    while (deps.isRunning(chatId)) {
      if (deps.now() - started >= deps.timings.maxWaitMs) {
        job.onTimedOut()
        return
      }
      await deps.delay(deps.timings.pollMs)
    }
    await job.send()
  }

  return {
    /**
     * Behind everything else queued for this chat, and never in front of it.
     *
     * Returns immediately: a job may wait half an hour, and the caller is a
     * scan that has to get to the next folder.
     */
    enqueue(chatId: string, job: ChatTurnJob): void {
      const previous = chains.get(chatId) ?? Promise.resolve()
      const next = previous.catch(() => {}).then(() => waitAndSend(chatId, job))
      chains.set(chatId, next)
      void next.then(
        () => {
          if (chains.get(chatId) === next) chains.delete(chatId)
        },
        () => {
          if (chains.get(chatId) === next) chains.delete(chatId)
        }
      )
    },

    /** Tests only: has every queued job settled? */
    async idle(): Promise<void> {
      while (chains.size > 0) await Promise.allSettled([...chains.values()])
    }
  }
}

export type ChatTurnQueue = ReturnType<typeof createChatTurnQueue>
