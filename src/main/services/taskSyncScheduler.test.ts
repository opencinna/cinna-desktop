import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sync = vi.hoisted(() => ({ pushAll: vi.fn(), pull: vi.fn(), invalidatePending: vi.fn() }))
vi.mock('./taskSyncService', () => ({ taskSyncService: sync }))
vi.mock('../logger/logger', () => ({ createLogger: () => ({ warn: vi.fn() }) }))
const { taskSyncScheduler } = await import('./taskSyncScheduler')

beforeEach(() => {
  vi.useFakeTimers()
  taskSyncScheduler.stop()
  taskSyncScheduler.setSuspended(false)
  sync.pushAll.mockReset().mockResolvedValue(undefined)
  sync.pull.mockReset().mockResolvedValue(undefined)
  sync.invalidatePending.mockClear()
})
afterEach(() => { taskSyncScheduler.stop(); vi.useRealTimers() })

const flush = () => vi.advanceTimersByTimeAsync(0)

describe('remote task sync lifecycle', () => {
  it('pushes then pulls on activation and every five seconds between completed passes', async () => {
    taskSyncScheduler.start('alice')
    await flush()
    expect(sync.pushAll).toHaveBeenCalledWith('alice')
    expect(sync.pull).toHaveBeenCalledWith('alice')
    expect(sync.pushAll.mock.invocationCallOrder[0]).toBeLessThan(sync.pull.mock.invocationCallOrder[0])
    await vi.advanceTimersByTimeAsync(4_999)
    expect(sync.pull).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(sync.pull).toHaveBeenCalledTimes(2)
    taskSyncScheduler.stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sync.pull).toHaveBeenCalledTimes(2)
  })

  it('coalesces repeated focus events into one trailing pass', async () => {
    let release!: () => void
    sync.pushAll.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve }))
    taskSyncScheduler.start('alice')
    const first = taskSyncScheduler.refresh()
    const second = taskSyncScheduler.refresh()
    const third = taskSyncScheduler.refresh()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sync.pushAll).toHaveBeenCalledTimes(1)
    expect(sync.pull).not.toHaveBeenCalled()
    release()
    await Promise.all([first, second, third])
    expect(sync.pushAll).toHaveBeenCalledTimes(2)
    expect(sync.pull).toHaveBeenCalledTimes(2)
  })

  it('does not begin the old profile pull when activation changes during its push', async () => {
    let release!: () => void
    sync.pushAll.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve }))
    taskSyncScheduler.start('alice')
    taskSyncScheduler.start('bob')
    expect(sync.invalidatePending).toHaveBeenCalledWith('alice')
    release()
    await flush()
    expect(sync.pull.mock.calls).toEqual([['bob']])
    expect(sync.pushAll.mock.calls).toEqual([['alice'], ['bob']])
  })

  it('pauses while suspended and catches up on resume', async () => {
    taskSyncScheduler.start('alice')
    await flush()
    taskSyncScheduler.setSuspended(true)
    expect(sync.invalidatePending).toHaveBeenCalledWith('alice')
    await taskSyncScheduler.refresh()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sync.pull).toHaveBeenCalledTimes(1)
    taskSyncScheduler.setSuspended(false)
    await flush()
    expect(sync.pull).toHaveBeenCalledTimes(2)
  })

  it('stops an in-flight pass before the next operation on deactivation', async () => {
    let release!: () => void
    sync.pushAll.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve }))
    taskSyncScheduler.start('alice')
    taskSyncScheduler.stop()
    expect(sync.invalidatePending).toHaveBeenCalledWith('alice')
    release()
    await flush()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sync.pull).not.toHaveBeenCalled()
    expect(sync.pushAll).toHaveBeenCalledTimes(1)
  })

  it('recovers on the next tick after a failed pass without an unhandled rejection', async () => {
    sync.pushAll.mockRejectedValueOnce(new Error('database locked'))
    taskSyncScheduler.start('alice')
    await flush()
    expect(sync.pull).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(sync.pull).toHaveBeenCalledWith('alice')
  })

  it('does no work before a profile has activated', async () => {
    await taskSyncScheduler.refresh()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sync.pushAll).not.toHaveBeenCalled()
    expect(sync.pull).not.toHaveBeenCalled()
  })
})
