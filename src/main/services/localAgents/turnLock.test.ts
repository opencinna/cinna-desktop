import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

const { turnLock, BRIEF_EXCLUSIVE_WAIT_MS } = await import('./turnLock')

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
  it('queues runner acquisition atomically while ordinary callers still refuse', async () => {
    const held = turnLock.acquire('a', 'editor')
    const signal = new AbortController().signal
    const entered: string[] = []
    const first = turnLock.withQueuedLock('a', 'runner', signal, async () => { entered.push('first'); await Promise.resolve() })
    const second = turnLock.withQueuedLock('a', 'runner', signal, () => { entered.push('second') })
    expect(entered).toEqual([])
    expect(() => turnLock.acquire('a', 'interactive')).toThrow(/busy/i)
    held.release()
    await Promise.all([first, second])
    expect(entered).toEqual(['first', 'second'])
    expect(turnLock.isLocked('a')).toBe(false)
  })

  it('removes a cancelled queued runner and never runs its callback', async () => {
    const held = turnLock.acquire('a', 'editor')
    const controller = new AbortController()
    const callback = vi.fn()
    const queued = turnLock.withQueuedLock('a', 'runner', controller.signal, callback)
    controller.abort()
    await expect(queued).rejects.toThrow('stopped')
    held.release()
    expect(callback).not.toHaveBeenCalled()
    expect(turnLock.isLocked('a')).toBe(false)
  })


  describe('shared holds', () => {
    it('lets any number of shared holders coexist and frees the agent only at zero', () => {
      const one = turnLock.acquireShared('a', 'turn')
      const two = turnLock.acquireShared('a', 'command')
      const ran = vi.fn()
      turnLock.whenFree('a', ran)
      expect(turnLock.isLocked('a')).toBe(true)
      expect(turnLock.isExclusivelyLocked('a')).toBe(false)
      one.release()
      expect(turnLock.isLocked('a')).toBe(true)
      expect(ran).not.toHaveBeenCalled()
      two.release()
      expect(turnLock.isLocked('a')).toBe(false)
      expect(ran).toHaveBeenCalledOnce()
    })

    it('refuses an exclusive holder while a shared one holds, and a shared one while an exclusive one holds', () => {
      const turn = turnLock.acquireShared('a', 'turn')
      expect(() => turnLock.acquire('a', 'editor')).toThrow(/busy/i)
      turn.release()
      const editor = turnLock.acquire('a', 'editor')
      expect(turnLock.isExclusivelyLocked('a')).toBe(true)
      expect(() => turnLock.acquireShared('a', 'turn')).toThrow(/busy/i)
      editor.release()
      expect(() => turnLock.acquireShared('a', 'turn')).not.toThrow()
    })

    it('a stale shared handle cannot release a sibling’s hold', () => {
      const one = turnLock.acquireShared('a', 'turn')
      const two = turnLock.acquireShared('a', 'turn')
      one.release()
      one.release()
      expect(turnLock.isLocked('a')).toBe(true)
      expect(() => turnLock.acquire('a', 'editor')).toThrow(/busy/i)
      two.release()
      expect(turnLock.isLocked('a')).toBe(false)
    })

    it('releases through withSharedLock however the body ends, while siblings run', async () => {
      let inside = 0
      let peak = 0
      const body = async (): Promise<void> => { inside++; peak = Math.max(peak, inside); await Promise.resolve(); inside-- }
      await Promise.all([turnLock.withSharedLock('a', 'turn', body), turnLock.withSharedLock('a', 'turn', body)])
      expect(peak).toBe(2)
      await expect(turnLock.withSharedLock('a', 'turn', () => { throw new Error('boom') })).rejects.toThrow('boom')
      expect(turnLock.isLocked('a')).toBe(false)
    })

    it('queues a shared holder only behind an exclusive one, and admits queued shared holders together', async () => {
      const signal = new AbortController().signal
      const free: string[] = []
      await turnLock.withQueuedSharedLock('a', 'turn', signal, () => { free.push('immediate') })
      expect(free).toEqual(['immediate'])

      const editor = turnLock.acquire('a', 'editor')
      let inside = 0
      let peak = 0
      const body = async (): Promise<void> => { inside++; peak = Math.max(peak, inside); await new Promise((r) => setTimeout(r, 5)); inside-- }
      const first = turnLock.withQueuedSharedLock('a', 'turn', signal, body)
      const second = turnLock.withQueuedSharedLock('a', 'command', signal, body)
      await Promise.resolve()
      expect(inside).toBe(0)
      editor.release()
      await Promise.all([first, second])
      expect(peak).toBe(2)
      expect(turnLock.isLocked('a')).toBe(false)
    })

    it('queues an exclusive holder until every shared holder has left', async () => {
      const one = turnLock.acquireShared('a', 'turn')
      const two = turnLock.acquireShared('a', 'turn')
      const entered = vi.fn()
      const queued = turnLock.withQueuedLock('a', 'credentials', new AbortController().signal, entered)
      one.release()
      await Promise.resolve()
      expect(entered).not.toHaveBeenCalled()
      two.release()
      await queued
      expect(entered).toHaveBeenCalledOnce()
      expect(turnLock.isLocked('a')).toBe(false)
    })

    it('a shared hold waits out a brief credential write instead of refusing', async () => {
      const write = turnLock.acquire('a', 'credentials')
      const body = vi.fn(() => 'ran')
      const turn = turnLock.withSharedLock('a', 'turn', body)
      await new Promise((r) => setTimeout(r, 20))
      expect(body).not.toHaveBeenCalled()
      write.release()
      await expect(turn).resolves.toBe('ran')
      expect(turnLock.isLocked('a')).toBe(false)
    })

    it('a Stop during the wait for a credential write rejects at once and never runs the body', async () => {
      const write = turnLock.acquire('a', 'credentials')
      const controller = new AbortController()
      const body = vi.fn()
      const turn = turnLock.withSharedLock('a', 'turn', body, controller.signal)
      await new Promise((r) => setTimeout(r, 20))
      controller.abort()
      await expect(turn).rejects.toThrow(/stopped/)
      // Its waiter is gone: releasing the write takes no shared hold on its behalf.
      write.release()
      await new Promise((r) => setTimeout(r, 20))
      expect(body).not.toHaveBeenCalled()
      expect(turnLock.isLocked('a')).toBe(false)
    })

    it('a stopped turn takes no hold and never runs its body', async () => {
      const controller = new AbortController()
      controller.abort()
      const body = vi.fn()
      await expect(turnLock.withSharedLock('a', 'turn', body, controller.signal)).rejects.toThrow(/stopped/)
      expect(body).not.toHaveBeenCalled()
      expect(turnLock.isLocked('a')).toBe(false)
    })

    it('a shared hold still refuses at once behind any other exclusive owner', async () => {
      const editor = turnLock.acquire('a', 'editor')
      const body = vi.fn()
      await expect(turnLock.withSharedLock('a', 'turn', body)).rejects.toThrow(/busy/i)
      expect(body).not.toHaveBeenCalled()
      editor.release()
    })

    it('a shared hold refuses once the bounded wait for a credential write runs out', async () => {
      vi.useFakeTimers()
      try {
        const write = turnLock.acquire('a', 'credentials')
        const body = vi.fn()
        const turn = turnLock.withSharedLock('a', 'turn', body)
        const settled = expect(turn).rejects.toThrow(/busy/i)
        await vi.advanceTimersByTimeAsync(BRIEF_EXCLUSIVE_WAIT_MS + 10)
        await settled
        expect(body).not.toHaveBeenCalled()
        write.release()
        expect(turnLock.isLocked('a')).toBe(false)
      } finally { vi.useRealTimers() }
    })

    it('removes a cancelled queued shared holder and never runs its callback', async () => {
      const held = turnLock.acquire('a', 'editor')
      const controller = new AbortController()
      const callback = vi.fn()
      const queued = turnLock.withQueuedSharedLock('a', 'turn', controller.signal, callback)
      controller.abort()
      await expect(queued).rejects.toThrow('stopped')
      held.release()
      expect(callback).not.toHaveBeenCalled()
      expect(turnLock.isLocked('a')).toBe(false)
    })
  })
})
