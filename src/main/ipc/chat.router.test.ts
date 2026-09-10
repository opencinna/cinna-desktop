import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * The two channels that write `chats.router`, and the guard they share.
 *
 * The column is read by the send path to decide who answers, and
 * `src/shared/chatRouting.ts` falls back to the `orchestrated` mirror for a
 * value it does not recognise. So a router neither channel refused would not
 * fail loudly — it would leave a chat quietly routing to the local model while
 * the row said something else, which is the failure mode this project has
 * shipped once already with a different column.
 *
 * `chat:set-router` is the deliberate one. `chat:update` writes the same column
 * as part of a new chat's first save, so it needs the same guard: a channel
 * that validates and a sibling that does not is a guard with a door beside it.
 */

const handlers = new Map<string, (...args: unknown[]) => unknown>()
vi.mock('./_wrap', () => ({
  ipcHandle: (channel: string, handler: (...args: unknown[]) => unknown) => {
    handlers.set(channel, handler)
  }
}))
vi.mock('../auth/activation', () => ({
  userActivation: { isActivated: () => true, requireActivated: () => undefined }
}))
vi.mock('../auth/scope', () => ({ getProfileScopeUserId: () => 'profile-user' }))

const setRouter = vi.fn()
const update = vi.fn()
vi.mock('../services/chatService', () => ({
  chatService: new Proxy(
    { setRouter, update },
    { get: (target: Record<string, unknown>, key: string) => target[key] ?? (() => undefined) }
  )
}))

const { registerChatHandlers } = await import('./chat.ipc')

beforeEach(() => {
  handlers.clear()
  vi.clearAllMocks()
  registerChatHandlers()
})

const call = (channel: string, ...args: unknown[]): Promise<unknown> =>
  Promise.resolve(handlers.get(channel)?.({}, ...args))

describe('chat:set-router', () => {
  it.each(['direct', 'human', 'coordinator'])('accepts %s', async (router) => {
    await call('chat:set-router', 'chat-1', router)
    expect(setRouter).toHaveBeenCalledWith('profile-user', 'chat-1', router)
  })

  it.each(['orchestrated', '', 'DIRECT', null, 7, undefined])(
    'refuses %s without writing anything',
    async (router) => {
      await expect(call('chat:set-router', 'chat-1', router)).rejects.toThrow(/Unknown chat router/)
      expect(setRouter).not.toHaveBeenCalled()
    }
  )
})

describe('chat:update', () => {
  it('passes a router it recognises through', async () => {
    await call('chat:update', 'chat-1', { title: 'A chat', router: 'human' })
    expect(update).toHaveBeenCalledWith('profile-user', 'chat-1', {
      title: 'A chat',
      router: 'human'
    })
  })

  it('refuses one it does not, and writes none of the other fields either', async () => {
    // Not a partial write: a title that landed while the router was rejected
    // would leave the caller unable to tell what happened.
    await expect(
      call('chat:update', 'chat-1', { title: 'A chat', router: 'switchboard' })
    ).rejects.toThrow(/Unknown chat router/)
    expect(update).not.toHaveBeenCalled()
  })

  it('leaves an update that names no router alone', async () => {
    await call('chat:update', 'chat-1', { title: 'A chat' })
    expect(update).toHaveBeenCalledWith('profile-user', 'chat-1', { title: 'A chat' })
  })
})
