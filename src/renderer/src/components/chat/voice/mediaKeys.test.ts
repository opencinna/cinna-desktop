import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (() => void) | null

// The Media Session jsdom lacks: the handlers it holds, by action.
const handlers = new Map<string, Handler>()
const session = {
  playbackState: 'none' as MediaSessionPlaybackState,
  setActionHandler: vi.fn((action: string, handler: Handler) => { handlers.set(action, handler) })
}

let play: ReturnType<typeof vi.spyOn>
let pause: ReturnType<typeof vi.spyOn>
let addListener: ReturnType<typeof vi.spyOn>
let removeListener: ReturnType<typeof vi.spyOn>

// Module state (the stack, the audio element, the listeners) is per import;
// every registration is undone after its test, so no window listener outlives it.
const registrations: Array<{ unregister(): void }> = []
async function load(): Promise<typeof import('./mediaKeys')> {
  vi.resetModules()
  const module = await import('./mediaKeys')
  return {
    registerMediaToggle: (handlers) => {
      const registration = module.registerMediaToggle(handlers)
      registrations.push(registration)
      return registration
    }
  }
}

function entry(): { toggle: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> } {
  return { toggle: vi.fn(), send: vi.fn() }
}

function press(action: string): void {
  const handler = handlers.get(action)
  if (!handler) throw new Error(`no ${action} handler`)
  handler()
}

beforeEach(() => {
  handlers.clear()
  session.playbackState = 'none'
  session.setActionHandler.mockClear()
  Object.defineProperty(navigator, 'mediaSession', { configurable: true, value: session })
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  addListener = vi.spyOn(window, 'addEventListener')
  removeListener = vi.spyOn(window, 'removeEventListener')
})

afterEach(() => {
  registrations.splice(0).forEach((registration) => registration.unregister())
  vi.restoreAllMocks()
  delete (navigator as { mediaSession?: unknown }).mediaSession
})

describe('registerMediaToggle', () => {
  it('gives play, pause and stop to the top entry, and starts the silent loop', async () => {
    const { registerMediaToggle } = await load()
    const first = entry()
    const second = entry()
    registerMediaToggle(first)
    registerMediaToggle(second)
    for (const action of ['play', 'pause', 'stop']) press(action)
    expect(second.toggle).toHaveBeenCalledTimes(3)
    expect(first.toggle).not.toHaveBeenCalled()
    expect(session.playbackState).toBe('playing')
    expect(play).toHaveBeenCalled()
  })

  it('sends the top entry on next track', async () => {
    const { registerMediaToggle } = await load()
    const first = entry()
    const second = entry()
    registerMediaToggle(first)
    registerMediaToggle(second)
    press('nexttrack')
    expect(second.send).toHaveBeenCalledTimes(1)
    expect(second.toggle).not.toHaveBeenCalled()
    expect(first.send).not.toHaveBeenCalled()
  })

  it('moves a promoted entry to the top', async () => {
    const { registerMediaToggle } = await load()
    const first = entry()
    const second = entry()
    const a = registerMediaToggle(first)
    registerMediaToggle(second)
    a.promote()
    press('play')
    press('nexttrack')
    expect(first.toggle).toHaveBeenCalledTimes(1)
    expect(first.send).toHaveBeenCalledTimes(1)
    expect(second.toggle).not.toHaveBeenCalled()
  })

  it('hands the button to the next entry when the top one unregisters', async () => {
    const { registerMediaToggle } = await load()
    const first = entry()
    const second = entry()
    registerMediaToggle(first)
    const b = registerMediaToggle(second)
    b.unregister()
    press('play')
    expect(first.toggle).toHaveBeenCalledTimes(1)
    expect(second.toggle).not.toHaveBeenCalled()
    expect(session.playbackState).toBe('playing')
    expect(pause).not.toHaveBeenCalled()
  })

  it('stops everything when the last entry unregisters', async () => {
    const { registerMediaToggle } = await load()
    const first = entry()
    const second = entry()
    const a = registerMediaToggle(first)
    const b = registerMediaToggle(second)
    a.unregister()
    b.unregister()
    expect(pause).toHaveBeenCalled()
    for (const action of ['play', 'pause', 'stop', 'nexttrack']) expect(handlers.get(action)).toBeNull()
    expect(session.playbackState).toBe('none')
    const added = addListener.mock.calls.filter(([type]) => type === 'focus' || type === 'blur')
    const removed = removeListener.mock.calls.filter(([type]) => type === 'focus' || type === 'blur')
    expect(added).toHaveLength(2)
    expect(removed.map(([type, fn]) => [type, fn])).toEqual(added.map(([type, fn]) => [type, fn]))
    // A focus after that starts nothing.
    play.mockClear()
    window.dispatchEvent(new Event('focus'))
    expect(play).not.toHaveBeenCalled()
    expect(session.playbackState).toBe('none')
  })

  it('lets go of the button on blur and takes it back on focus', async () => {
    const { registerMediaToggle } = await load()
    const first = entry()
    registerMediaToggle(first)
    window.dispatchEvent(new Event('blur'))
    expect(pause).toHaveBeenCalledTimes(1)
    expect(handlers.get('play')).toBeNull()
    expect(session.playbackState).toBe('none')
    play.mockClear()
    window.dispatchEvent(new Event('focus'))
    expect(play).toHaveBeenCalledTimes(1)
    expect(session.playbackState).toBe('playing')
    press('play')
    expect(first.toggle).toHaveBeenCalledTimes(1)
  })

  it('does nothing while the window is not focused', async () => {
    vi.mocked(document.hasFocus).mockReturnValue(false)
    const { registerMediaToggle } = await load()
    registerMediaToggle(entry())
    expect(play).not.toHaveBeenCalled()
    expect(handlers.size).toBe(0)
  })
})
