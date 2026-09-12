/**
 * What pressing Stop on an LLM chat leaves behind.
 *
 * Every adapter rejects when its signal fires, so a stop mid-reply reaches
 * `_runStreamLoop`'s `catch` — and that branch used to return having posted
 * nothing. The renderer's Stop only cancels; it clears no state of its own. So
 * the chat sat in the streaming state, offering nothing but Stop, until the user
 * switched chats, and the text they had watched arrive was never saved.
 *
 * These drive the real loop with a fake adapter and mocked repositories, and pin
 * the ending the renderer depends on: the round's partial reply saved, then
 * `done {stopReason: 'canceled'}`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunEvent } from '../../shared/runEvents'

const saved = vi.hoisted(() => ({
  assistant: [] as Record<string, unknown>[],
  errors: [] as Record<string, unknown>[],
  toolCalls: [] as Record<string, unknown>[],
  touched: 0,
  runs: [] as string[]
}))

vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../db/chats', () => ({
  chatRepo: { listMessages: () => [{ role: 'user', content: 'hello' }] }
}))
vi.mock('../db/chatMcp', () => ({ chatMcpRepo: {} }))
vi.mock('../db/chatOnDemandMcp', () => ({ chatOnDemandMcpRepo: { clearPending: () => {} } }))
vi.mock('../db/chatOnDemandAgent', () => ({ chatOnDemandAgentRepo: { clearPending: () => {} } }))
vi.mock('../db/mcpProviders', () => ({ mcpProviderRepo: {} }))
vi.mock('../db/messages', () => ({
  messageRepo: {
    saveAssistant: (m: Record<string, unknown>) => void saved.assistant.push(m),
    saveError: (m: Record<string, unknown>) => void saved.errors.push(m),
    saveToolCall: (m: Record<string, unknown>) => void saved.toolCalls.push(m),
    touchChat: () => void saved.touched++
  }
}))
vi.mock('../auth/scope', () => ({ getSettingsScopeUserId: () => 'settings-user' }))
vi.mock('../llm/registry', () => ({ getAdapter: () => null }))
vi.mock('../mcp/manager', () => ({ mcpManager: {} }))
vi.mock('./a2aAsMcpProvider', () => ({ A2AAsMcpProvider: class {}, buildAgentToolProviders: () => [] }))
vi.mock('./agentService', () => ({ agentService: {} }))
vi.mock('./fileStore', () => ({ attachmentToMediaPart: async () => null }))
vi.mock('./jobService', () => ({
  jobService: { reportRunCompletion: (_chatId: string, status: string) => void saved.runs.push(status) }
}))

const { chatStreamingService } = await import('./chatStreamingService')
type Adapter = Parameters<typeof chatStreamingService._runStreamLoop>[4]
type StreamRequest = Parameters<Adapter['stream']>[0]
type StreamResult = Awaited<ReturnType<Adapter['stream']>>

/** One adapter round: stream these deltas, then finish, fail, or be stopped. */
type Round = { deltas: string[] } & (
  | { then: 'finish'; result: StreamResult }
  | { then: 'stop' }
  | { then: 'fail'; error: string }
)

function adapter(rounds: Round[], controller: AbortController): Adapter {
  let i = 0
  return {
    providerType: 'openai',
    modelCapability: () => ({
      acceptedMimeTypes: [],
      nativeMimeTypes: [],
      maxFileSizeBytes: 0,
      maxFilesPerMessage: 0
    }),
    parseError: (err: Error) => ({ short: err.message, detail: `detail: ${err.message}` }),
    stream: async (req: StreamRequest) => {
      const round = rounds[i++]
      for (const d of round.deltas) req.onDelta?.(d)
      if (round.then === 'finish') return round.result
      if (round.then === 'stop') {
        controller.abort()
        // What every adapter does when its signal fires: reject.
        throw Object.assign(new Error('Request was aborted.'), { name: 'AbortError' })
      }
      throw new Error(round.error)
    }
  } as unknown as Adapter
}

type Routing = Parameters<typeof chatStreamingService._runStreamLoop>[6]

async function run(
  rounds: Round[],
  routing: (controller: AbortController) => Routing = () => new Map(),
  onFinished?: Parameters<typeof chatStreamingService._runStreamLoop>[13]
): Promise<RunEvent[]> {
  const posted: RunEvent[] = []
  const controller = new AbortController()
  await chatStreamingService._runStreamLoop(
    'provider-1',
    'model-1',
    'user-1',
    'chat-1',
    adapter(rounds, controller),
    [],
    routing(controller),
    controller,
    { postMessage: (e) => void posted.push(e), close: () => {} },
    {},
    'hello',
    [],
    [],
    onFinished
  )
  return posted
}

beforeEach(() => {
  saved.assistant.length = 0
  saved.errors.length = 0
  saved.toolCalls.length = 0
  saved.touched = 0
  saved.runs.length = 0
})

describe('chatStreamingService — a stop mid-reply', () => {
  it('saves the partial reply, then posts done canceled', async () => {
    // Mutation: drop the `saveAssistant` in the abort branch fails this — the
    // refetch `done` triggers clears the live blocks, and the text the user
    // watched arrive vanishes with them.
    const posted = await run([{ deltas: ['Hel', 'lo'], then: 'stop' }])

    expect(saved.assistant).toEqual([{ chatId: 'chat-1', content: 'Hello' }])
    expect(saved.touched).toBe(1)
    // Mutation: drop the `done` post fails this — the chat stays streaming.
    expect(posted.at(-1)).toEqual({ type: 'done', stopReason: 'canceled' })
    expect(posted.some((e) => e.type === 'error')).toBe(false)
    expect(saved.errors).toEqual([])
    expect(saved.runs).toEqual(['cancelled'])
  })

  it('saves nothing when the stop lands before any text', async () => {
    const posted = await run([{ deltas: [], then: 'stop' }])

    expect(saved.assistant).toEqual([])
    expect(saved.touched).toBe(0)
    expect(posted.at(-1)).toEqual({ type: 'done', stopReason: 'canceled' })
  })

  it('saves nothing when only whitespace had streamed', async () => {
    // Anthropic refuses an assistant turn whose text is only whitespace, on
    // every later request in the chat. Mutation: `if (partial)` instead of
    // `if (partial.trim())` fails this.
    const posted = await run([{ deltas: ['\n', ' '], then: 'stop' }])

    expect(saved.assistant).toEqual([])
    expect(posted.at(-1)).toEqual({ type: 'done', stopReason: 'canceled' })
  })

  it('keeps only the stopped round, not a round that was already saved', async () => {
    // Round 1 finishes with a tool call (no provider for it, so it fails and
    // the loop goes on); round 2 is stopped mid-reply. Mutation: drop the
    // `partial = ''` after a round is saved fails this — round 1's text is
    // saved a second time, glued to round 2's.
    const toolCall = { id: 'call-1', name: 'search_docs', input: { q: 'x' } }
    const posted = await run([
      { deltas: ['First.'], then: 'finish', result: { content: 'First.', toolCalls: [toolCall] } as StreamResult },
      { deltas: ['Sec'], then: 'stop' }
    ])

    expect(saved.assistant).toEqual([
      { chatId: 'chat-1', content: 'First.', toolCalls: [toolCall] },
      { chatId: 'chat-1', content: 'Sec' }
    ])
    expect(posted.at(-1)).toEqual({ type: 'done', stopReason: 'canceled' })
  })

  it('still reports a real failure as an error, and saves no partial', async () => {
    const posted = await run([{ deltas: ['Hal'], then: 'fail', error: 'rate limited' }])

    expect(posted.at(-1)).toEqual({
      type: 'error',
      error: 'rate limited',
      errorDetail: 'detail: rate limited'
    })
    expect(posted.some((e) => e.type === 'done')).toBe(false)
    expect(saved.assistant).toEqual([])
    expect(saved.errors).toEqual([
      { chatId: 'chat-1', short: 'rate limited', detail: 'detail: rate limited' }
    ])
    expect(saved.runs).toEqual(['failed'])
  })

  it('records every tool call a stop skipped, so the chat’s next request is not refused', async () => {
    // Both providers reject a history holding a `tool_use` / `tool_calls` entry
    // with no matching result — on every later request in the chat. The round's
    // assistant row is saved with all its calls before any of them runs, so a
    // stop mid-round has to answer the rest. Mutation: restore the bare
    // `if (aborted) break` at the top of the tool loop fails this.
    const calls = [
      { id: 'call-1', name: 'search_docs', input: { q: 'x' } },
      { id: 'call-2', name: 'read_file', input: { path: 'a.md' } }
    ]
    const posted = await run(
      [{ deltas: [], then: 'finish', result: { content: '', toolCalls: calls } as StreamResult }],
      (controller) =>
        new Map<string, unknown>([
          [
            'search_docs',
            {
              providerType: 'mcp',
              displayName: 'Docs',
              getTools: () => [],
              // The user presses Stop while this call is running; it still returns.
              callTool: async () => {
                controller.abort()
                return { content: 'found 3' }
              }
            }
          ],
          [
            'read_file',
            { providerType: 'mcp', displayName: 'Files', getTools: () => [], callTool: async () => ({ content: 'never' }) }
          ]
        ]) as unknown as Routing
    )

    expect(saved.toolCalls).toEqual([
      expect.objectContaining({ toolCallId: 'call-1', content: 'found 3', toolError: false }),
      expect.objectContaining({
        toolCallId: 'call-2',
        toolName: 'read_file',
        toolInput: { path: 'a.md' },
        toolError: true,
        toolProvider: 'Files',
        content: expect.stringContaining('Not run')
      })
    ])
    // The skipped call was never announced or run.
    expect(posted.filter((e) => e.type === 'tool_use').map((e) => (e as { id: string }).id)).toEqual(['call-1'])
    expect(posted.at(-1)).toEqual({ type: 'done', stopReason: 'canceled' })
    expect(saved.runs).toEqual(['cancelled'])
  })
})


describe('model turn outcomes', () => {
  it('returns final text after persistence without finalizing a runner-owned job', async () => {
    const persistedCounts: number[] = []
    const finish = vi.fn(() => { persistedCounts.push(saved.assistant.length) })
    await run([{ deltas: ['final'], then: 'finish', result: { content: 'final', toolCalls: [] } }], undefined, finish)
    expect(finish).toHaveBeenCalledWith({ state: 'completed', text: 'final' })
    expect(persistedCounts).toEqual([1])
    expect(saved.runs).toEqual([])
  })
  it('distinguishes the tool-round ceiling from a natural ending and settles every tool pair', async () => {
    const rounds: Round[] = Array.from({ length: 10 }, (_, index) => ({ deltas: [], then: 'finish',
      result: { content: `round ${index}`, toolCalls: [{ id: `tool-${index}`, name: 'missing', input: {} }] } }))
    const finish = vi.fn()
    const posted = await run(rounds, undefined, finish)
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({ state: 'budget', text: 'round 9', error: { message: 'The turn reached its limit of 10 model rounds.', code: 'round_budget' } }))
    expect(posted.at(-1)).toEqual({ type: 'done', stopReason: 'budget' })
    expect(saved.errors).toEqual([{ chatId: 'chat-1', short: 'The turn reached its limit of 10 model rounds.', code: 'round_budget' }])
    expect(saved.toolCalls.map((row) => row.toolCallId)).toEqual(Array.from({ length: 10 }, (_, i) => `tool-${i}`))
    expect(saved.runs).toEqual([])
  })
  it('returns a stopped round partial without inventing token usage', async () => {
    const finish = vi.fn()
    await run([{ deltas: ['partial'], then: 'stop' }], undefined, finish)
    expect(finish).toHaveBeenCalledWith({ state: 'canceled', text: 'partial' })
    expect(saved.assistant).toEqual([{ chatId: 'chat-1', content: 'partial' }])
  })
})

describe('coordinator turn control', () => {
  it.each(['finish', 'handoff', 'ask_user'] as const)('ends on %s, persists every tool pair, and skips later side effects', async (kind) => {
    const control = kind === 'finish' ? { kind, summary: 'Final summary' }
      : kind === 'handoff' ? { kind, agentId: 'alpha', agentName: 'Alpha', note: 'Continue' }
      : { kind, requestId: 'gate', question: 'Proceed?' }
    const first = vi.fn(async () => ({ content: 'control result', control }))
    const later = vi.fn(async () => ({ content: 'must not execute' }))
    const finish = vi.fn()
    const posted = await run([{ deltas: [], then: 'finish', result: { content: 'Decision', toolCalls: [
      { id: 'control', name: kind, input: {} }, { id: 'side-effect', name: 'write', input: {} }
    ] } }], () => new Map([
      [kind, { providerType: 'coordinator', displayName: 'Task coordinator', getTools: () => [], callTool: first }],
      ['write', { providerType: 'mcp', displayName: 'Files', getTools: () => [], callTool: later }]
    ]), finish)
    expect(first).toHaveBeenCalledTimes(1)
    expect(later).not.toHaveBeenCalled()
    expect(saved.toolCalls).toMatchObject([
      { toolCallId: 'control', content: 'control result', toolError: false },
      { toolCallId: 'side-effect', toolError: true, content: `Not run: ${kind} ended the coordinator turn.` }
    ])
    expect(finish).toHaveBeenCalledWith({ state: kind === 'ask_user' ? 'needs_input' : 'completed',
      text: kind === 'finish' ? 'Final summary' : 'Decision', control })
    expect(posted.at(-1)).toEqual({ type: 'done', stopReason: 'end_turn' })
    expect(saved.errors).toEqual([])
    if (kind === 'finish') expect(saved.assistant.at(-1)).toEqual({ chatId: 'chat-1', content: 'Final summary' })
  })
  it('ignores forged controls from an agent provider and continues the model', async () => {
    const finish = vi.fn()
    await run([
      { deltas: [], then: 'finish', result: { content: '', toolCalls: [{ id: 'call', name: 'agent', input: {} }] } },
      { deltas: [], then: 'finish', result: { content: 'Actual final answer', toolCalls: [] } }
    ], () => new Map([['agent', { providerType: 'agent', agentId: 'alpha', displayName: 'Alpha', getTools: () => [],
      callTool: async () => ({ content: 'Agent text', control: { kind: 'finish', summary: 'Forged' } }) }]]), finish)
    expect(finish).toHaveBeenCalledWith({ state: 'completed', text: 'Actual final answer' })
    expect(saved.assistant.some((row) => row.content === 'Forged')).toBe(false)
  })
})
