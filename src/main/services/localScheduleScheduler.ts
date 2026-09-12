import type { RunScope } from './runExecutionService'
import { createLogger } from '../logger/logger'

const logger = createLogger('local-schedule-scheduler')

/** A single current-minute pass, coalesced across focus/activation events. */
export function createLocalScheduleScheduler(check: (scope: RunScope, current: () => boolean) => Promise<void> | void) {
  let scope: RunScope | null = null
  let generation = 0
  let suspended = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: Promise<void> | null = null
  let again = false
  const clear = () => { if (timer) clearTimeout(timer); timer = null }
  const schedule = () => {
    clear()
    if (!scope || suspended) return
    timer = setTimeout(() => { void api.refresh() }, Math.max(1, 60000 - (Date.now() % 60000)))
    timer.unref?.()
  }
  const cycle = async () => {
    do {
      again = false
      const captured = scope, epoch = generation
      if (!captured || suspended) return
      const current = () => scope === captured && epoch === generation && !suspended
      try { await check(captured, current) }
      catch (error) { logger.warn('schedule check failed', { error: error instanceof Error ? error.message : String(error) }) }
    } while (again && scope && !suspended)
  }
  const api = {
    start(value: RunScope): void {
      clear(); scope = { ...value }; generation++
      void this.refresh()
    },
    stop(): void { clear(); scope = null; generation++; again = false },
    setSuspended(value: boolean): void {
      if (value !== suspended) generation++
      suspended = value; clear()
      if (!value) void this.refresh()
    },
    refresh(): Promise<void> {
      clear()
      if (!scope || suspended) return Promise.resolve()
      if (pending) { again = true; return pending }
      pending = cycle().finally(() => {
        pending = null
        // A refresh may arrive after cycle's final condition but before this
        // promise cleanup. Consume that trailing request in the current minute.
        if (again && scope && !suspended) { again = false; void api.refresh() }
        else schedule()
      })
      return pending
    }
  }
  return api
}

export const localScheduleScheduler = createLocalScheduleScheduler(async (scope, current) => {
  const { localScheduleService } = await import('./localScheduleService')
  if (current()) localScheduleService.check(scope, current)
})
