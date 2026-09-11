import { taskSyncService } from './taskSyncService'
import { createLogger } from '../logger/logger'

const logger = createLogger('task-sync-scheduler')
const POLL_MS = 5_000
let profile: string | null = null
let suspended = false
let timer: ReturnType<typeof setTimeout> | null = null
let pending: Promise<void> | null = null
let epoch = 0
let again = false

function clearTimer(): void {
  if (timer) clearTimeout(timer)
  timer = null
}

/** Wait between completed passes, so a slow service never creates a backlog. */
function schedule(): void {
  clearTimer()
  if (!profile || suspended) return
  timer = setTimeout(() => { void taskSyncScheduler.refresh() }, POLL_MS)
  timer.unref?.()
}

async function cycle(): Promise<void> {
  do {
    again = false
    const userId = profile
    const started = epoch
    if (!userId || suspended) return
    try {
      // Push first: the local edit's dirty markers protect it on the pull,
      // and a successful push lets the pull read the resulting remote state.
      await taskSyncService.pushAll(userId)
      if (profile !== userId || started !== epoch || suspended) continue
      await taskSyncService.pull(userId)
    } catch (error) {
      logger.warn('task sync pass failed', {
        error: error instanceof Error ? error.message : String(error)
      })
    }
  } while (again && profile && !suspended)
}

/** The adapter carrier is independent of whether encrypted app-sync is unlocked. */
export const taskSyncScheduler = {
  start(userId: string): void {
    clearTimer()
    if (profile) taskSyncService.invalidatePending(profile)
    profile = userId
    epoch += 1
    void this.refresh()
  },

  stop(): void {
    clearTimer()
    if (profile) taskSyncService.invalidatePending(profile)
    profile = null
    epoch += 1
    again = false
  },

  setSuspended(value: boolean): void {
    if (value && !suspended && profile) {
      epoch += 1
      taskSyncService.invalidatePending(profile)
    }
    suspended = value
    clearTimer()
    if (!value) void this.refresh()
  },

  refresh(): Promise<void> {
    clearTimer()
    if (!profile || suspended) return Promise.resolve()
    if (pending) {
      // A focus/profile change during a pass needs one trailing pass, never
      // another concurrent writer and never a queued pass per focus event.
      again = true
      return pending
    }
    pending = cycle().finally(() => {
      pending = null
      schedule()
    })
    return pending
  }
}
