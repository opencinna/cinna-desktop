import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Which row the transcript keeps for a routed send.
 *
 * The decision is one branch in send preparation, and it is
 * load-bearing in a way a reader of that line would not guess: the origin
 * decides whether the conversation shows a **user bubble nobody typed**. A task
 * runner's prompt and a file handover's returned report are both written by the
 * desktop, and a `user` row for either one puts words in the person's mouth and
 * titles their chat after them.
 */

const saveUser = vi.fn(() => 'user-row')
const saveSystem = vi.fn(() => 'system-row')
vi.mock('../db/messages', () => ({ messageRepo: { saveUser, saveSystem } }))
vi.mock('../db/chats', () => ({ chatRepo: { getOwned: () => ({ id: 'chat-1' }) } }))
const autoTitle = vi.fn(async () => undefined)
vi.mock('./chatTitleService', () => ({
  chatTitleService: { autoGenerateForFirstMessage: autoTitle },
  ChatTitleError: class ChatTitleError extends Error {}
}))
vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

const { messageRoutingService } = await import('./messageRoutingService')

beforeEach(() => {
  vi.clearAllMocks()
})

const agentSend = { userId: 'u', chatId: 'chat-1', agentId: 'a-1', userContent: 'Report from the uploader project' }

describe('the row a send stores', () => {
  it('is a user row for a person, with a title generated from it', () => {
    expect(messageRoutingService.prepareAgentSend({ ...agentSend, origin: 'user' }).userMessageId).toBe('user-row')
    expect(saveSystem).not.toHaveBeenCalled()
    expect(autoTitle).toHaveBeenCalledTimes(1)
  })

  it('is a user row when no origin is given, which is how the composer sends', () => {
    expect(messageRoutingService.prepareAgentSend(agentSend).userMessageId).toBe('user-row')
    expect(saveSystem).not.toHaveBeenCalled()
  })

  it.each(['runner', 'handover', 'specialist'] as const)('is a system row for a %s turn, and titles nothing', (origin) => {
    // Mutation: route `handover` to `saveUser` and the return packet appears as
    // a message the user typed; leave the title call in and the chat is renamed
    // after another project's report.
    expect(messageRoutingService.prepareAgentSend({ ...agentSend, origin }).userMessageId).toBe('system-row')
    expect(saveUser).not.toHaveBeenCalled()
    expect(saveSystem).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'chat-1', content: agentSend.userContent, addressedAgentId: 'a-1' }),
      undefined
    )
    expect(autoTitle).not.toHaveBeenCalled()
  })

})
