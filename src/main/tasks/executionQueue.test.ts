import { describe, expect, it } from 'vitest'
import { ExecutionQueue } from './executionQueue'

describe('task admission', () => {
  it('caps running work and admits live waiters in order after a cancellation', async () => {
    const queue = new ExecutionQueue(() => 1)
    const first = await queue.acquire(new AbortController().signal)
    const canceled = new AbortController()
    const dead = queue.acquire(canceled.signal)
    const admitted: string[] = []
    const next = queue.acquire(new AbortController().signal).then((release) => { admitted.push('next'); return release })
    canceled.abort()
    await expect(dead).rejects.toThrow('stopped')
    expect(admitted).toEqual([])
    first()
    const releaseNext = await next
    expect(admitted).toEqual(['next'])
    first() // A stale release must not free the newer owner.
    const last = queue.acquire(new AbortController().signal).then((release) => { admitted.push('last'); return release })
    await Promise.resolve()
    expect(admitted).toEqual(['next'])
    releaseNext()
    ;(await last)()
    expect(admitted).toEqual(['next', 'last'])
  })

  it('applies a lower limit to new admissions without canceling existing work', async () => {
    let limit = 2
    const queue = new ExecutionQueue(() => limit)
    const first = await queue.acquire(new AbortController().signal)
    const second = await queue.acquire(new AbortController().signal)
    limit = 1
    let entered = false
    const waiting = queue.acquire(new AbortController().signal).then((release) => { entered = true; return release })
    first()
    await Promise.resolve()
    expect(entered).toBe(false)
    second()
    ;(await waiting)()
    expect(entered).toBe(true)
  })
})
