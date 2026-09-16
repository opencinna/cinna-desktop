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
/** Every row written, in insertion — and so `sortOrder` — order. */
const rows: Record<string, unknown>[] = []
/** Set to make the next assistant write throw, as a deleted chat's insert does. */
const writes = { assistantFails: false }

vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../db/messages', () => ({
  messageRepo: {
    saveError: (i: { short: string }) => { saved.push(i); rows.push({ role: 'error', content: i.short }) },
    saveAssistant: (i: Record<string, unknown>) => {
      if (writes.assistantFails) throw new Error('FOREIGN KEY constraint failed')
      savedAssistant.push(i)
      rows.push({ role: 'assistant', content: i.content, parts: i.parts })
    },
    saveUser: (i: Record<string, unknown>) => {
      rows.push({ role: 'user', content: i.content, addressedAgentId: i.addressedAgentId })
      return 'user-row'
    },
    saveTransition: (i: Record<string, unknown>) => void rows.push({ role: 'agent_transition', content: i.content }),
    touchChat: () => {}
  }
}))
vi.mock('../db/agents', () => ({ agentSessionRepo: { getByChatAndAgent: () => undefined, upsert: () => {} } }))
// No draft is written here (no fake timers, no `needs_input`); the marker and
// the draft have their own suite against a real database.
vi.mock('../db/inflightTurns', () => ({
  inflightTurnRepo: {
    open: () => {},
    delete: () => {},
    writeDraft: () => 'draft',
    replaceDraft: (_marker: string | null, _draft: string | null, write: () => void) => write()
  }
}))
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
    writes.assistantFails = false
    saved.length = 0
    savedAssistant.length = 0
    runCompletions.length = 0
    rows.length = 0
  })

  it('persists a message steered into the turn between the parts streamed before and after it', async () => {
    const p = fakePort()
    await a2aStreamingService.streamToAgent({
      chatId: 'chat_1',
      agentId: 'folder:abc',
      port: p.port,
      run: async () => ({
        text: 'ac',
        parts: [
          { kind: 'text', text: 'a' },
          { kind: 'tool', toolName: 'Read', text: 'b' },
          { kind: 'text', text: 'c' }
        ],
        notices: [{ partKey: 'n', text: 'Starting up' }],
        steers: [{ afterPart: 2, text: 'also check d' }]
      })
    })
    expect(rows).toEqual([
      { role: 'agent_transition', content: 'Starting up' },
      { role: 'assistant', content: 'a', parts: [{ kind: 'text', text: 'a' }, { kind: 'tool', toolName: 'Read', text: 'b' }] },
      { role: 'user', content: 'also check d', addressedAgentId: 'folder:abc' },
      { role: 'assistant', content: 'c', parts: [{ kind: 'text', text: 'c' }] }
    ])
    expect(p.posted.at(-1)).toEqual({ type: 'done', stopReason: 'end_turn' })
  })

  it('keeps one row with the turn’s own text when nothing was steered', async () => {
    const p = fakePort()
    await a2aStreamingService.streamToAgent({
      chatId: 'chat_1', agentId: 'folder:abc', port: p.port,
      run: async () => ({ text: 'whole answer', parts: [{ kind: 'thinking', text: 'hm' }, { kind: 'text', text: 'whole answer' }], notices: [] })
    })
    expect(rows).toEqual([{ role: 'assistant', content: 'whole answer', parts: [{ kind: 'thinking', text: 'hm' }, { kind: 'text', text: 'whole answer' }] }])
  })

  it('keeps a steered message ahead of the error when the turn fails after it', async () => {
    const p = fakePort()
    await a2aStreamingService.streamToAgent({
      chatId: 'chat_1', agentId: 'folder:abc', port: p.port,
      run: async () => ({
        text: '', parts: [{ kind: 'text', text: 'a' }], notices: [],
        steers: [{ afterPart: 1, text: 'more' }],
        error: { message: 'The agent crashed.', raw: 'exit 1' }
      })
    })
    // A failure keeps what it streamed: the parts, the steer after them, then the error.
    expect(rows).toEqual([
      { role: 'assistant', content: 'a', parts: [{ kind: 'text', text: 'a' }] },
      { role: 'user', content: 'more', addressedAgentId: 'folder:abc' },
      { role: 'error', content: 'The agent crashed.' }
    ])
  })

  it('keeps the parts and notices of a failed turn, ahead of its error', async () => {
    // Mutation: drop the `persistTurn` call in the failure branch → only the
    // error row is left, which is how a long turn that failed used to vanish.
    const p = fakePort()
    await a2aStreamingService.streamToAgent({
      chatId: 'chat_1', agentId: 'folder:abc', port: p.port,
      run: async () => ({
        text: 'done half',
        parts: [{ kind: 'tool', toolName: 'Read', text: 'r' }, { kind: 'text', text: 'done half' }],
        notices: [{ partKey: 'n', text: 'Starting up' }],
        error: { message: 'The agent crashed.', raw: 'exit 1' }
      })
    })
    expect(rows).toEqual([
      { role: 'agent_transition', content: 'Starting up' },
      { role: 'assistant', content: 'done half', parts: [{ kind: 'tool', toolName: 'Read', text: 'r' }, { kind: 'text', text: 'done half' }] },
      { role: 'error', content: 'The agent crashed.' }
    ])
    expect(p.posted.at(-1)).toEqual({ type: 'error', error: 'The agent crashed.' })
  })

  it('does not repeat a failed A2A task’s answer as its error', async () => {
    // The A2A pump uses the answer as the error message of a `failed` task. The
    // answer is kept as a row now, so the error row says only that it failed.
    // Mutation: save `failure.message` → the answer appears twice.
    const p = fakePort()
    await a2aStreamingService.streamToAgent({
      chatId: 'chat_1', agentId: 'agent_1', port: p.port,
      run: async () => ({
        text: 'Could not reach the ledger.',
        parts: [{ kind: 'text', text: 'Could not reach the ledger.' }],
        notices: [],
        taskState: 'failed',
        error: { message: 'Could not reach the ledger.', raw: 'A2A task state: failed', code: 'agent_task_failed' }
      })
    })
    expect(rows).toEqual([
      { role: 'assistant', content: 'Could not reach the ledger.', parts: [{ kind: 'text', text: 'Could not reach the ledger.' }] },
      { role: 'error', content: 'The agent reported that its task failed.' }
    ])
    expect(p.posted.at(-1)).toEqual({ type: 'error', error: 'The agent reported that its task failed.', code: 'agent_task_failed' })
    // The job run still gets the agent's own reason.
    expect(runCompletions).toEqual([{ status: 'failed', message: 'Could not reach the ledger.' }])
  })

  it('posts one error when saving a failed turn’s rows throws', async () => {
    // Mutation: post the error before `persistTurn` → the branch posts one and
    // the `catch` a second.
    writes.assistantFails = true
    const p = fakePort()
    await a2aStreamingService.streamToAgent({
      chatId: 'chat_1', agentId: 'folder:abc', port: p.port,
      run: async () => ({
        text: 'half', parts: [{ kind: 'text', text: 'half' }], notices: [],
        error: { message: 'The agent crashed.', raw: 'exit 1' }
      })
    })
    expect(p.posted.filter((e) => e.type === 'error')).toHaveLength(1)
    expect(saved).toHaveLength(1)
  })

  it('keeps what a runner offered before it threw', async () => {
    // Mutation: drop the `flush()` in the `catch` → only the error row.
    const p = fakePort()
    await a2aStreamingService.streamToAgent({
      chatId: 'chat_1', agentId: 'folder:abc', port: p.port,
      run: async (io) => {
        io.registerSnapshot?.(() => ({ parts: [{ kind: 'text', text: 'so far' }], notices: [], steers: [] }))
        throw new Error('The runner broke.')
      }
    })
    expect(rows).toEqual([
      { role: 'assistant', content: 'so far', parts: [{ kind: 'text', text: 'so far' }] },
      { role: 'error', content: 'The runner broke.' }
    ])
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

  describe('saveInFlight', () => {
    /** A turn that registers `read` and resolves only when told to. */
    function heldTurn(chatId: string, read: () => { parts: { kind: 'text'; text: string }[]; notices: { partKey: string; text: string }[]; steers: { afterPart: number; text: string }[] }) {
      let release: (result: Awaited<ReturnType<Parameters<typeof a2aStreamingService.streamToAgent>[0]['run']>>) => void = () => {}
      let registered: () => void = () => {}
      const ready = new Promise<void>((resolve) => { registered = resolve })
      const done = a2aStreamingService.streamToAgent({
        chatId, agentId: 'folder:abc', port: fakePort().port,
        run: (io) => {
          io.registerSnapshot?.(read)
          registered()
          return new Promise((resolve) => { release = resolve })
        }
      })
      return { ready, done, release: (r: Parameters<typeof release>[0]) => release(r) }
    }

    it('saves what a running turn streamed, and only the rest when the turn later returns', async () => {
      // Mutation: make `saveInFlight` a no-op → nothing before the release;
      // drop the cursor (persist from 0 every time) → 'Hello' is saved twice.
      const streamed = {
        parts: [{ kind: 'text' as const, text: 'Hello' }],
        notices: [{ partKey: 'n', text: 'Starting up' }],
        steers: [] as { afterPart: number; text: string }[]
      }
      const turn = heldTurn('chat_1', () => ({ parts: streamed.parts.slice(), notices: streamed.notices.slice(), steers: streamed.steers.slice() }))
      await turn.ready
      a2aStreamingService.saveInFlight()
      expect(rows).toEqual([
        { role: 'agent_transition', content: 'Starting up' },
        { role: 'assistant', content: 'Hello', parts: [{ kind: 'text', text: 'Hello' }] }
      ])

      turn.release({
        text: 'Hello',
        parts: [{ kind: 'text', text: 'Hello' }, { kind: 'tool', toolName: 'Read', text: 'r' }, { kind: 'text', text: 'World' }],
        notices: [{ partKey: 'n', text: 'Starting up' }],
        // Landed before the flush's cursor; still saved, and ahead of the new parts.
        steers: [{ afterPart: 1, text: 'and more' }]
      })
      await turn.done
      expect(rows).toEqual([
        { role: 'agent_transition', content: 'Starting up' },
        { role: 'assistant', content: 'Hello', parts: [{ kind: 'text', text: 'Hello' }] },
        { role: 'user', content: 'and more', addressedAgentId: 'folder:abc' },
        { role: 'assistant', content: 'World', parts: [{ kind: 'tool', toolName: 'Read', text: 'r' }, { kind: 'text', text: 'World' }] }
      ])
    })

    it('saves a turn that was stopped but has not returned yet', async () => {
      // Mutation: delete the entry in `cancel` → the stopped turn is skipped.
      const posted: { type: string; requestId?: string }[] = []
      let release: (r: { text: string; parts: []; notices: [] }) => void = () => {}
      let registered: () => void = () => {}
      const ready = new Promise<void>((resolve) => { registered = resolve })
      const done = a2aStreamingService.streamToAgent({
        chatId: 'chat_1', agentId: 'folder:abc',
        port: { postMessage: (e) => { posted.push(e as never) }, close: () => {} },
        run: (io) => {
          io.registerSnapshot?.(() => ({ parts: [{ kind: 'text', text: 'before stop' }], notices: [], steers: [] }))
          registered()
          return new Promise((resolve) => { release = resolve })
        }
      })
      await ready
      const requestId = posted.find((e) => e.type === 'request-id')!.requestId!
      expect(a2aStreamingService.cancel(requestId)).toBe(true)
      a2aStreamingService.saveInFlight()
      expect(rows).toEqual([{ role: 'assistant', content: 'before stop', parts: [{ kind: 'text', text: 'before stop' }] }])
      release({ text: '', parts: [], notices: [] })
      await done
      // Gone once the turn has returned.
      expect(a2aStreamingService.cancel(requestId)).toBe(false)
    })

    it('saves a notice that filled in after a flush, and no other notice twice', async () => {
      // An empty notice is left out of the snapshot, so counting by position
      // would skip it and save the next one again. Mutation: count notices → fails.
      const notices = [{ partKey: 'b', text: 'Second' }]
      const turn = heldTurn('chat_1', () => ({ parts: [], notices: notices.slice(), steers: [] }))
      await turn.ready
      a2aStreamingService.saveInFlight()
      turn.release({ text: '', parts: [], notices: [{ partKey: 'a', text: 'First' }, { partKey: 'b', text: 'Second' }] })
      await turn.done
      expect(rows).toEqual([
        { role: 'agent_transition', content: 'Second' },
        { role: 'agent_transition', content: 'First' }
      ])
    })

    it('still saves the other turns when one of them cannot be read', async () => {
      // Two guards: `flush` catches its own read, `saveInFlight` each entry.
      // Mutation: drop both → the throw escapes and the second turn is never saved.
      const broken = heldTurn('chat_1', () => { throw new Error('unreadable') })
      const fine = heldTurn('chat_2', () => ({ parts: [{ kind: 'text', text: 'kept' }], notices: [], steers: [] }))
      await Promise.all([broken.ready, fine.ready])
      expect(() => a2aStreamingService.saveInFlight()).not.toThrow()
      expect(rows).toEqual([{ role: 'assistant', content: 'kept', parts: [{ kind: 'text', text: 'kept' }] }])
      broken.release({ text: '', parts: [], notices: [] })
      fine.release({ text: 'kept', parts: [{ kind: 'text', text: 'kept' }], notices: [] })
      await Promise.all([broken.done, fine.done])
    })
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

  describe('a question asked through Cinna’s ask-user tool', () => {
    const askTool = (input: unknown, name = 'askuserquestion') => ({
      kind: 'text',
      text: 'Using tool: askuserquestion\n2 questions',
      metadata: { 'cinna.content_kind': 'tool', 'cinna.tool_name': name, 'cinna.tool_input': input }
    })

    it('asks the tool’s questions, with their headers and options', () => {
      // Mutation: skip `askToolQuestionsOf` → the generic fallback question.
      const request = a2aInputRequestOf('input-required', message(
        { kind: 'text', text: 'deciding', metadata: { 'cinna.content_kind': 'thinking' } },
        askTool({
          questions: [
            {
              question: 'Which colour?', header: 'Colour', multiSelect: false,
              options: [{ label: 'Blue', description: 'Calm' }, { label: 'Red' }, { description: 'no label' }]
            },
            { question: 'Which days?', multiSelect: true, options: [{ label: 'Mon' }, { label: 'Tue' }] },
            { question: '   ' },
            'not a question'
          ]
        })
      ))
      expect(request).toEqual({
        kind: 'question',
        questions: [
          {
            question: 'Which colour?', header: 'Colour', multiSelect: false,
            options: [{ label: 'Blue', description: 'Calm' }, { label: 'Red' }]
          },
          { question: 'Which days?', multiSelect: true, options: [{ label: 'Mon' }, { label: 'Tue' }] }
        ]
      })
    })

    it('keeps the message’s own text as the question when it has some', () => {
      const request = a2aInputRequestOf('input-required', message(
        { kind: 'text', text: 'Pick one below.' },
        askTool({ questions: [{ question: 'Which colour?', options: [] }] })
      ))
      expect(request).toEqual({ kind: 'question', questions: [{ question: 'Pick one below.', multiSelect: false, options: [] }] })
    })

    it.each([
      ['another tool', askTool({ questions: [{ question: 'Which colour?' }] }, 'bash')],
      ['no questions array', askTool({ question: 'Which colour?' })],
      ['only empty questions', askTool({ questions: [{ question: '' }, {}] })]
    ])('falls back to the open question for %s', (_label, part) => {
      expect(a2aInputRequestOf('input-required', message(part))).toEqual({
        kind: 'question', questions: [{ question: 'What should the agent do next?', multiSelect: false, options: [] }]
      })
    })

    it('does not turn an auth-required message into questions', () => {
      expect(a2aInputRequestOf('auth-required', message(askTool({ questions: [{ question: 'Which colour?' }] }))))
        .toEqual({ kind: 'auth', message: A2A_AUTH_REQUIRED_FALLBACK })
    })
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
    // A failed turn keeps its streamed answer beside the error row.
    expect(timing).toEqual([{ closed: false, saved: state === 'failed' ? 2 : 1 }])
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
