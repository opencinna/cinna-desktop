import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { focus: vi.fn() } }))

const { ensureMainWindow, installWindowCreator, installWindowResolver } = await import('./focus')

class FakeWindow extends EventEmitter {
  visible = false
  destroyed = false
  isVisible = (): boolean => this.visible
  isDestroyed = (): boolean => this.destroyed
}

function setup(): { current: () => FakeWindow | null; create: ReturnType<typeof vi.fn>; set: (w: FakeWindow | null) => void } {
  let win: FakeWindow | null = null
  installWindowResolver(() => win as never)
  const create = vi.fn(() => {
    win = new FakeWindow()
  })
  installWindowCreator(create)
  return { current: () => win, create, set: (w) => { win = w } }
}

describe('ensureMainWindow', () => {
  it('returns the existing window without creating one', async () => {
    const s = setup()
    const win = new FakeWindow()
    s.set(win)
    expect(await ensureMainWindow()).toBe(win)
    expect(s.create).not.toHaveBeenCalled()
  })

  it('reopens a closed window and waits until it is shown', async () => {
    const s = setup()
    let settled = false
    const pending = ensureMainWindow().then((w) => {
      settled = true
      return w
    })
    expect(s.create).toHaveBeenCalledTimes(1)
    await Promise.resolve()
    expect(settled).toBe(false)
    s.current()!.visible = true
    s.current()!.emit('show')
    expect(await pending).toBe(s.current())
  })

  it('returns null when the new window closes before it shows', async () => {
    const s = setup()
    const pending = ensureMainWindow()
    const win = s.current()!
    win.destroyed = true
    win.emit('closed')
    expect(await pending).toBeNull()
  })

  it('gives up waiting after the timeout', async () => {
    vi.useFakeTimers()
    try {
      const s = setup()
      const pending = ensureMainWindow()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(await pending).toBe(s.current())
    } finally {
      vi.useRealTimers()
    }
  })
})
