import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

const { turnLock } = await import('./turnLock')

beforeEach(() => {
  turnLock.releaseAll()
})

describe('turnLock', () => {
  it('lets one holder in and refuses the next', () => {
    const handle = turnLock.acquire('a', 'turn')
    expect(turnLock.isLocked('a')).toBe(true)
    expect(() => turnLock.acquire('a', 'editor')).toThrow(/busy/i)
    handle.release()
    expect(turnLock.isLocked('a')).toBe(false)
  })

  it('locks per agent, not globally', () => {
    turnLock.acquire('a', 'turn')
    expect(() => turnLock.acquire('b', 'turn')).not.toThrow()
  })

  it('releases idempotently', () => {
    const handle = turnLock.acquire('a', 'turn')
    handle.release()
    handle.release()
    expect(turnLock.isLocked('a')).toBe(false)
  })

  it('never lets a stale handle release someone else’s lock', () => {
    const first = turnLock.acquire('a', 'turn')
    first.release()
    const second = turnLock.acquire('a', 'editor')

    // The error path of the first holder fires late.
    first.release()

    expect(turnLock.isLocked('a')).toBe(true)
    second.release()
  })

  it('releases through withLock however the body ends', async () => {
    await turnLock.withLock('a', 'turn', () => 'done')
    expect(turnLock.isLocked('a')).toBe(false)

    await expect(
      turnLock.withLock('a', 'turn', () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(turnLock.isLocked('a')).toBe(false)
  })

  it('runs a whenFree callback immediately when nothing holds the agent', () => {
    const ran = vi.fn()
    turnLock.whenFree('a', ran)
    expect(ran).toHaveBeenCalledOnce()
  })

  it('defers a whenFree callback until the lock is released', () => {
    const handle = turnLock.acquire('a', 'turn')
    const ran = vi.fn()
    turnLock.whenFree('a', ran)
    expect(ran).not.toHaveBeenCalled()

    handle.release()
    expect(ran).toHaveBeenCalledOnce()
  })

  it('runs every waiter even when one throws', () => {
    const handle = turnLock.acquire('a', 'turn')
    const second = vi.fn()
    turnLock.whenFree('a', () => {
      throw new Error('a rescan failed')
    })
    turnLock.whenFree('a', second)

    expect(() => handle.release()).not.toThrow()
    expect(second).toHaveBeenCalledOnce()
  })

  it('does not re-run a waiter on the next release', () => {
    const first = turnLock.acquire('a', 'turn')
    const ran = vi.fn()
    turnLock.whenFree('a', ran)
    first.release()

    turnLock.acquire('a', 'turn').release()
    expect(ran).toHaveBeenCalledOnce()
  })

  it('releaseAll frees everything and fires the waiters', () => {
    turnLock.acquire('a', 'turn')
    turnLock.acquire('b', 'turn')
    const ran = vi.fn()
    turnLock.whenFree('a', ran)

    turnLock.releaseAll()

    expect(turnLock.isLocked('a')).toBe(false)
    expect(turnLock.isLocked('b')).toBe(false)
    expect(ran).toHaveBeenCalledOnce()
  })
})
