import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLocalScheduleScheduler } from './localScheduleScheduler'

vi.mock('../logger/logger', () => ({ createLogger: () => ({ warn() {} }) }))
const scope = { profileUserId: 'a', settingsUserId: 'settings' }
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

describe('local schedule clock and activation', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-12T09:00:23Z')) })
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })
  it('aligns checks to minute boundaries and resumes only at the observed time', async () => {
    const times: number[] = []
    const scheduler = createLocalScheduleScheduler(() => { times.push(Date.now()) })
    scheduler.start(scope); await flush()
    await vi.advanceTimersByTimeAsync(37000)
    expect(times.map((now) => new Date(now).toISOString())).toEqual(['2026-09-12T09:00:23.000Z', '2026-09-12T09:01:00.000Z'])
    scheduler.setSuspended(true)
    await vi.advanceTimersByTimeAsync(10 * 60000)
    expect(times).toHaveLength(2)
    scheduler.setSuspended(false); await flush()
    expect(new Date(times[2]).toISOString()).toBe('2026-09-12T09:11:00.000Z')
    scheduler.stop()
  })
  it('coalesces refreshes and revokes old profile work during an awaited check', async () => {
    let finish = () => {}
    const authorized: string[] = []
    const check = vi.fn(async (captured, current) => {
      if (captured.profileUserId === 'a') await new Promise<void>((resolve) => { finish = resolve })
      if (current()) authorized.push(captured.profileUserId)
    })
    const scheduler = createLocalScheduleScheduler(check)
    scheduler.start(scope)
    void scheduler.refresh(); void scheduler.refresh()
    scheduler.start({ ...scope, profileUserId: 'b' })
    finish(); await flush()
    expect(authorized).toEqual(['b'])
    expect(check).toHaveBeenCalledTimes(2)
    scheduler.stop()
  })
  it('drains a profile change arriving between cycle completion and promise cleanup', async () => {
    const profiles: string[] = []
    const scheduler = createLocalScheduleScheduler(async (captured) => { profiles.push(captured.profileUserId) })
    scheduler.start(scope)
    // cycle's resolved await is ahead of this microtask, but its finally is
    // behind it. No timer advance should be necessary to check profile B.
    void Promise.resolve().then(() => scheduler.start({ ...scope, profileUserId: 'b' }))
    await flush()
    expect(profiles).toEqual(['a', 'b'])
    scheduler.stop()
  })
  it.each(['stop', 'suspend'] as const)('revokes an awaited check on %s', async (action) => {
    let finish = () => {}
    let accepted = false
    const scheduler = createLocalScheduleScheduler(async (_captured, current) => {
      await new Promise<void>((resolve) => { finish = resolve }); accepted = current()
    })
    scheduler.start(scope)
    if (action === 'stop') scheduler.stop(); else scheduler.setSuspended(true)
    finish(); await flush()
    expect(accepted).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    scheduler.stop()
  })
})
