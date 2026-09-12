/**
 * `streamToAgent`'s guarantee to the renderer: **the port always gets a
 * verdict.**
 *
 * `useChatStream` leaves the streaming state on `done` or on `error` and on
 * nothing else, so a port that closes having posted neither leaves the chat
 * spinning until the app restarts. That is not a hypothetical — it is what
 * the folder runners did when `turnLock.acquire` refused a second
 * concurrent turn, because this `try` had only a `finally`.
 *
 * The runner is fixed at its own end too. This is the wrapper every future
 * runner passes through, and it must not depend on all of them keeping the
 * `AgentDriver.run` contract that says it never throws.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunEvent } from '../../shared/runEvents'

const saved: { short: string }[] = []
const savedAssistant: Record<string, unknown>[] = []
const runCompletions: { status: string; message?: string }[] = []

vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../db/messages', () => ({
  messageRepo: {
    saveError: (i: { short: string }) => saved.push(i),
    saveAssistant: (i: Record<string, unknown>) => void savedAssistant.push(i),
    saveTransition: () => {},
    touchChat: () => {}
  }
}))
vi.mock('../db/agents', () => ({ agentSessionRepo: { getByChatAndAgent: () => undefined, upsert: () => {} } }))
vi.mock('./jobService', () => ({
  jobService: {
    reportRunCompletion: (_c: string, status: string, message?: string) =>
      runCompletions.push({ status, message })
  }
}))

import {
  A2A_AUTH_REQUIRED_FALLBACK,
  a2aInputRequestOf,
  a2aStreamingService,
  toRunState
} from './a2aStreamingService'

function fakePort(): { posted: RunEvent[]; closed: boolean; port: { postMessage: (m: RunEvent) => void; close: () => void } } {
  const posted: RunEvent[] = []
  const state = { closed: false }
  return {
    posted,
    get closed() {
      return state.closed
    },
    port: {
      postMessage: (m) => void posted.push(m),
      close: () => {
        state.closed = true
      }
    }
  }
}

describe('a2aStreamingService.streamToAgent', () => {
  it('preserves a remote budget ending through the common turn wrapper and durable partial answer', async () => {
    const p = fakePort()
    const onFinished = vi.fn()
    await a2aStreamingService.streamToAgent({ chatId: 'chat_1', agentId: 'managed', port: p.port, onFinished,
      run: async () => ({ text: 'partial', parts: [{ kind: 'text', text: 'partial' }], notices: [], taskState: 'completed', stopReason: 'budget' }) })
    expect(p.posted.at(-1)).toEqual({ type: 'done', stopReason: 'budget' })
    expect(onFinished).toHaveBeenCalledWith({ state: 'budget', text: 'partial' })
    expect(savedAssistant.at(-1)).toMatchObject({ content: 'partial' })
  })
  beforeEach(() => {
    saved.length = 0
    savedAssistant.length = 0
    runCompletions.length = 0
  })

  it('posts an error when a runner throws instead of returning', async () => {
    const p = fakePort()
    await a2aStreamingService.streamToAgent({
      // A turn that breaks the "never throws" contract — which is exactly
      // what the local runner did via `turnLock.acquire`.
      run: async () => {
        throw new Error('This agent is busy right now. Try again when the current run finishes.')
      },
      chatId: 'chat_1',
      agentId: 'folder:abc',
      port: p.port
    })

    // Mutation: delete the `catch` block, leaving only `try`/`finally` → this
    // fails with only the `request-id` event posted. In production that is a
    // chat that spins forever, unrecoverable without restarting the app.
    const kinds = p.posted.map((e) => e.type)
    expect(kinds).toContain('error')
    expect(kinds).not.toContain('done')
    expect(p.closed).toBe(true)

    // The failure must also be durable and must release the job, or a Job
    // waiting on this run never completes either.
    expect(saved).toHaveLength(1)
    expect(saved[0].short).toContain('busy right now')
    expect(runCompletions).toEqual([
      { status: 'failed', message: 'This agent is busy right now. Try again when the current run finishes.' }
    ])
  })

  it('a runner cancelled cleanly is a stop, not a success — the exit a stop actually takes', async () => {
    // **The common case, and the one the error branches below do not cover.** A
    // cancelled runner returns what it streamed with *no error* — that is the
    // documented `AgentDriver.run` contract and what the folder path does —
    // so a stopped turn leaves through the success path. Reporting `succeeded`
    // there is the same lie the OpenAI adapter told by resolving on abort: the
    // job run reads as one that finished, indistinguishable from one that did.
    const p = fakePort()
    await a2aStreamingService.streamToAgent({
      run: async () => {
        const requestId = p.posted.find((e) => e.type === 'request-id')
        a2aStreamingService.cancel((requestId as { requestId: string }).requestId)
        // Exactly what a cancelled runner returns: whatever streamed, no error.
        return { text: 'half an ans', parts: [{ kind: 'text' as const, text: 'half an ans' }], notices: [] }
      },
      chatId: 'chat_1',
      agentId: 'folder:abc',
      port: p.port
    })

    // `done` still goes out and the partial answer is still kept — a stop is
    // not an error and the user keeps what they were given.
    expect(p.posted.map((e) => e.type)).toContain('done')
    expect(p.posted.map((e) => e.type)).not.toContain('error')
    expect(runCompletions).toEqual([{ status: 'cancelled', message: undefined }])
    // …and the `done` itself says it was a stop, which is the only place on the
    // wire that does: the runner's result looks like any other success.
    expect(p.posted.find((e) => e.type === 'done')).toEqual({ type: 'done', stopReason: 'canceled' })
  })

  it.each([
    [
      'the runner reports the cancel as an error',
      async (): Promise<{ text: string; parts: []; notices: []; error: { message: string; raw: string } }> => ({
        text: '',
        parts: [],
        notices: [],
        error: { message: 'aborted', raw: 'aborted' }
      })
    ],
    [
      'the runner throws on the way out',
      async (): Promise<never> => {
        throw new Error('aborted')
      }
    ]
  ])('finalizes a stopped run as cancelled when %s', async (_label, endTurn) => {
    // **Suppressing the error surface is not the same as reporting nothing.**
    // Both branches below correctly refuse to post or save a cancel as a
    // failure — and both used to return without finalizing the run at all, so a
    // stopped agent-backed job sat at `running` for the life of the app, with
    // the sidebar's "currently running" badge lit. `chatStreamingService` had
    // the same hole on the LLM path; this is the other half of that fix.
    const p = fakePort()
    await a2aStreamingService.streamToAgent({
      run: async () => {
        // Stop it the way the user does: through the service's own cancel,
        // keyed by the request id it just posted.
        const requestId = p.posted.find((e) => e.type === 'request-id')
        a2aStreamingService.cancel((requestId as { requestId: string }).requestId)
        return endTurn()
      },
      chatId: 'chat_1',
      agentId: 'folder:abc',
      port: p.port
    })

    // A stop is not a failure: nothing posted as an error, nothing persisted.
    expect(p.posted.map((e) => e.type)).not.toContain('error')
    expect(saved).toHaveLength(0)
    // But it is an ending.
    expect(runCompletions).toEqual([{ status: 'cancelled', message: undefined }])
    // …and the renderer has to hear that it ended: its Stop clears no state of
    // its own, so a stop that posted no terminal event left the chat streaming
    // until the user switched away. Mutation: restore the early `return` for an
    // aborted turn's error, or drop the `done` in the `catch`, fails this.
    expect(p.posted.at(-1)).toEqual({ type: 'done', stopReason: 'canceled' })
  })

  it('keeps what a stopped turn streamed even when its result also carries an error', async () => {
    // A local runner that errors after a partial answer returns its parts beside
    // the error. When the user had already stopped the turn, that is a stop, and
    // the parts are kept like any stopped turn's — the refetch `done` triggers
    // would otherwise clear text the user watched arrive.
    const p = fakePort()
    await a2aStreamingService.streamToAgent({
      run: async () => {
        const requestId = p.posted.find((e) => e.type === 'request-id')
        a2aStreamingService.cancel((requestId as { requestId: string }).requestId)
        return {
          text: 'half',
          parts: [{ kind: 'text' as const, text: 'half' }],
          notices: [],
          error: { message: 'aborted', raw: 'aborted' }
        }
      },
      chatId: 'chat_1',
      agentId: 'folder:abc',
      port: p.port
    })

    expect(savedAssistant).toEqual([
      { chatId: 'chat_1', content: 'half', parts: [{ kind: 'text', text: 'half' }], sourceAgentId: 'folder:abc' }
    ])
    expect(saved).toHaveLength(0)
    expect(p.posted.at(-1)).toEqual({ type: 'done', stopReason: 'canceled' })
  })

  it('still posts done on the ordinary path', async () => {
    const p = fakePort()
    await a2aStreamingService.streamToAgent({
      run: async () => ({ text: 'hello', parts: [{ kind: 'text', text: 'hello' }], notices: [] }),
      chatId: 'chat_1',
      agentId: 'folder:abc',
      port: p.port
    })
    // Guards against a `catch` written so broadly it swallows success.
    expect(p.posted.map((e) => e.type)).toEqual(['request-id', 'done'])
    expect(p.posted[1]).toEqual({ type: 'done', stopReason: 'end_turn' })
    expect(runCompletions).toEqual([{ status: 'succeeded', message: undefined }])
  })
})

describe('toRunState', () => {
  it.each([
    ['submitted', 'submitted'],
    ['working', 'working'],
    ['completed', 'completed'],
    ['failed', 'failed'],
    ['canceled', 'canceled'],
    ['rejected', 'rejected'],
    ['input-required', 'needs_input'],
    ['auth-required', 'needs_input'],
    // A2A's own `unknown`, a near miss that must not be forgiven, and a state
    // no version of A2A has: none of them is a state the union knows.
    ['unknown', 'unknown'],
    ['cancelled', 'unknown'],
    ['paused', 'unknown'],
    [undefined, 'unknown']
  ] as const)('maps %s to %s', (state, expected) => {
    expect(toRunState(state)).toBe(expected)
  })
})

describe('a2aInputRequestOf', () => {
  const message = (...parts: { kind: string; text?: string; metadata?: Record<string, unknown> }[]) => ({
    messageId: 'msg-1',
    parts
  })

  it('asks nothing for a state that is not waiting on the user', () => {
    for (const state of ['working', 'completed', 'failed', undefined]) {
      expect(a2aInputRequestOf(state, message({ kind: 'text', text: 'Which one?' }))).toBeUndefined()
    }
  })

  it('turns an auth-required status message into an auth request', () => {
    expect(
      a2aInputRequestOf('auth-required', message({ kind: 'text', text: '  Sign in to GitHub to continue.\n' }))
    ).toEqual({ kind: 'auth', message: 'Sign in to GitHub to continue.' })
  })

  it('still says what the agent needs when auth-required carries no text', () => {
    // No message at all, and a message whose only part is not answer text:
    // either way the user must be told something, not shown an empty ask.
    expect(a2aInputRequestOf('auth-required', undefined)).toEqual({
      kind: 'auth',
      message: A2A_AUTH_REQUIRED_FALLBACK
    })
    expect(
      a2aInputRequestOf(
        'auth-required',
        message({ kind: 'text', text: 'checking scopes', metadata: { 'cinna.content_kind': 'thinking' } })
      )
    ).toEqual({ kind: 'auth', message: A2A_AUTH_REQUIRED_FALLBACK })
  })

  it('makes one open question of the text parts only, joined as paragraphs', () => {
    expect(
      a2aInputRequestOf(
        'input-required',
        message(
          { kind: 'text', text: 'deciding', metadata: { 'cinna.content_kind': 'thinking' } },
          { kind: 'text', text: 'Which environment?' },
          { kind: 'file' },
          { kind: 'text', text: 'Staging or production.', metadata: { 'cinna.content_kind': 'text' } }
        )
      )
    ).toEqual({
      kind: 'question',
      questions: [{ question: 'Which environment?\n\nStaging or production.', multiSelect: false, options: [] }]
    })
  })

  it('offers a free-text answer when input-required carries no text', () => {
    expect(a2aInputRequestOf('input-required', undefined)).toEqual({ kind: 'question', questions: [{ question: 'What should the agent do next?', multiSelect: false, options: [] }] })
  })
})

describe('typed agent turn outcomes', () => {
  it.each([
    ['completed', 'completed'], ['input-required', 'needs_input'], ['auth-required', 'needs_input'],
    ['canceled', 'canceled'], ['failed', 'failed'], ['rejected', 'failed'], ['working', 'failed']
  ] as const)('reports %s as %s after persistence and before close', async (taskState, state) => {
    saved.length = 0
    savedAssistant.length = 0
    runCompletions.length = 0
    const p = fakePort()
    const timing: { closed: boolean; saved: number }[] = []
    const finish = vi.fn((_outcome) => { timing.push({ closed: p.closed, saved: saved.length + savedAssistant.length }) })
    await a2aStreamingService.streamToAgent({
      chatId: 'chat_1', agentId: 'agent_1', port: p.port, onFinished: finish,
      run: async () => ({ text: 'Agent response', parts: [{ kind: 'text', text: 'Agent response' }], notices: [], taskState })
    })
    expect(finish).toHaveBeenCalledTimes(1)
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({ state, text: 'Agent response' }))
    expect(timing).toEqual([{ closed: false, saved: 1 }])
    expect(runCompletions).toEqual([])
    expect(p.closed).toBe(true)
    expect(finish.mock.calls[0][0].usage).toBeUndefined()
    if (state === 'failed') {
      expect(saved).toHaveLength(1)
      expect(p.posted.some((event) => event.type === 'error')).toBe(true)
      expect(p.posted.some((event) => event.type === 'done')).toBe(false)
    }
  })
})
