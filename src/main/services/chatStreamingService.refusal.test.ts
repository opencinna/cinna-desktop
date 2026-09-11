import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunEvent } from '../../shared/runEvents'

/**
 * A turn refused before it starts is still an ending, and it has to say so.
 *
 * The three guards at the top of `stream` — no chat, no model/provider, no
 * adapter — post an error, save it to the transcript, close the port and
 * **throw**. `run.ipc.ts`'s `handOff` swallows that throw by design (a service
 * that owns the port owns its ending), so nothing downstream heard about it and
 * nothing reported a run outcome.
 *
 * Two things followed, and only the first was visible. The job run stayed
 * `running` for the life of the app — nothing reaps a stale one, and
 * `countInProgressByJob` is what keeps the sidebar's busy badge lit. And the
 * **task** stayed wherever its caller had put it, which is what let the task
 * page's "Re-run from the last message" destroy the state it exists to recover:
 * the re-run claims a `blocked` task `in_progress`, the turn is refused because
 * the credential behind the chat was deleted, and nothing ever moves the task
 * again — the re-run control is only offered for a task that is stuck, and the
 * task is now merely wrong.
 *
 * These pin the call. What it does to the two rows is
 * `jobService.reportRunCompletion.test.ts`, against a real database.
 */

const reported = vi.hoisted(() => [] as { status: string; message?: string }[])
const chat = vi.hoisted(() => ({
  current: null as { id: string; providerId: string | null; modelId: string | null } | null
}))
const adapter = vi.hoisted(() => ({ current: null as unknown }))

vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../db/chats', () => ({
  chatRepo: { getOwned: () => chat.current, listMessages: () => [] }
}))
vi.mock('../db/chatMcp', () => ({ chatMcpRepo: {} }))
vi.mock('../db/chatOnDemandMcp', () => ({ chatOnDemandMcpRepo: { clearPending: () => {} } }))
vi.mock('../db/chatOnDemandAgent', () => ({ chatOnDemandAgentRepo: { clearPending: () => {} } }))
vi.mock('../db/mcpProviders', () => ({ mcpProviderRepo: {} }))
vi.mock('../db/messages', () => ({
  messageRepo: {
    saveAssistant: () => {},
    saveError: () => {},
    saveToolCall: () => {},
    touchChat: () => {}
  }
}))
vi.mock('../auth/scope', () => ({ getSettingsScopeUserId: () => 'settings-user' }))
vi.mock('../llm/registry', () => ({ getAdapter: () => adapter.current }))
vi.mock('../mcp/manager', () => ({ mcpManager: {} }))
vi.mock('./a2aAsMcpProvider', () => ({
  A2AAsMcpProvider: class {},
  buildAgentToolProviders: () => []
}))
vi.mock('./agentService', () => ({ agentService: {} }))
vi.mock('./fileStore', () => ({ attachmentToMediaPart: async () => null }))
vi.mock('./jobService', () => ({
  jobService: {
    reportRunCompletion: (_chatId: string, status: string, message?: string) =>
      void reported.push({ status, message })
  }
}))

const { chatStreamingService } = await import('./chatStreamingService')

const CHAT = 'chat-1'

function port(): { postMessage: (e: RunEvent) => void; close: () => void; events: RunEvent[] } {
  const events: RunEvent[] = []
  return { postMessage: (e) => void events.push(e), close: () => {}, events }
}

async function refuse(): Promise<{ events: RunEvent[] }> {
  const p = port()
  await expect(
    chatStreamingService.stream({
      userId: 'u1',
      chatId: CHAT,
      wireContent: 'hello',
      port: p
    })
  ).rejects.toThrow()
  return p
}

beforeEach(() => {
  reported.length = 0
  chat.current = { id: CHAT, providerId: 'p1', modelId: 'm1' }
  adapter.current = { stream: async () => ({}), parseError: (e: Error) => ({ short: e.message }) }
})

describe('a turn refused before any stream owned it', () => {
  it('reports the ending when the chat is gone', async () => {
    chat.current = null
    const p = await refuse()
    expect(p.events).toContainEqual({ type: 'error', error: 'Chat not found' })
    expect(reported).toEqual([{ status: 'failed', message: 'Chat not found' }])
  })

  it('reports the ending when the chat has no model or provider', async () => {
    // The realistic one behind a broken re-run: the credential the job's chat
    // was bound to was deleted, so the chat has nothing to send with.
    chat.current = { id: CHAT, providerId: null, modelId: null }
    const p = await refuse()
    expect(p.events).toContainEqual({
      type: 'error',
      error: 'Chat has no model/provider configured'
    })
    expect(reported).toEqual([
      { status: 'failed', message: 'Chat has no model/provider configured' }
    ])
  })

  it('reports the ending when the provider has no adapter', async () => {
    adapter.current = null
    const p = await refuse()
    expect(p.events).toContainEqual({ type: 'error', error: 'Provider adapter not available' })
    expect(reported).toEqual([{ status: 'failed', message: 'Provider adapter not available' }])
  })
})
