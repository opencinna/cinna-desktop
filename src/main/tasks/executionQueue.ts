/** Cancelable FIFO admission. The limit is read when a waiter is admitted. */
export class ExecutionQueue {
  private active = 0
  private waiting: { signal: AbortSignal; resolve: (release: () => void) => void; reject: (error: Error) => void; abort: () => void }[] = []
  constructor(private readonly limit: () => number) {}
  /** Whether an `acquire` now would be admitted at once: a slot is free and nobody is queued ahead. */
  hasFree(): boolean {
    return this.waiting.length === 0 && this.active < Math.max(1, Math.floor(this.limit()))
  }
  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(new Error('The task was stopped while queued.'))
    return new Promise((resolve, reject) => {
      const entry = { signal, resolve, reject, abort: () => {
        this.waiting = this.waiting.filter((candidate) => candidate !== entry)
        reject(new Error('The task was stopped while queued.'))
      } }
      signal.addEventListener('abort', entry.abort, { once: true })
      this.waiting.push(entry)
      this.drain()
    })
  }
  private drain(): void {
    const max = Math.max(1, Math.floor(this.limit()))
    while (this.waiting.length && this.active < max) {
      const entry = this.waiting.shift()!
      entry.signal.removeEventListener('abort', entry.abort)
      if (entry.signal.aborted) { entry.reject(new Error('The task was stopped while queued.')); continue }
      this.active++
      let released = false
      entry.resolve(() => {
        if (released) return
        released = true
        this.active--
        this.drain()
      })
    }
  }
}
