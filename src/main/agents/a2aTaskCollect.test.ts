import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { collectPollDelays, collectTask, readTask, replyLost, serverCopyWins, type CollectedTask, type TaskGetter } from './a2aTaskCollect'
import { A2aHttpError, AgentCardFetchError } from './a2a-client'

vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

const OURS = 'user-row-1'
const text = (t: string, kind = 'text'): unknown => ({ kind: 'text', text: t, metadata: { 'cinna.content_kind': kind } })
const user = (id: string, clientId?: string): unknown => ({
  kind: 'message', role: 'user', messageId: id, parts: [text(`q ${id}`)],
  ...(clientId ? { metadata: { 'cinna.client_message_id': clientId } } : {})
})
const agent = (id: string, parts: unknown[], state = 'complete'): unknown => ({
  kind: 'message', role: 'agent', messageId: id, parts, metadata: { 'cinna.message_state': state }
})
const answer = (state: string, history: unknown[]): unknown => ({
  jsonrpc: '2.0', id: 1, result: { kind: 'task', id: 't', contextId: 't', status: { state }, history }
})

/** A client that answers each `getTask` from `answers` in turn; the last repeats. */
function clientOf(answers: (unknown | (() => unknown))[]): TaskGetter & { calls: number } {
  const c = {
    calls: 0,
    getTask: vi.fn(async () => {
      const next = answers[Math.min(c.calls++, answers.length - 1)]
      return typeof next === 'function' ? (next as () => unknown)() : next
    })
  }
  return c
}

const input = (client: TaskGetter, signal = new AbortController().signal) => ({
  client, taskId: 't', clientMessageId: OURS, signal
})

describe('collectTask', () => {
  const saved = { ...collectPollDelays }
  beforeEach(() => void Object.assign(collectPollDelays, { fastMs: 1, slowMs: 1 }))
  afterEach(() => void Object.assign(collectPollDelays, saved))

  it('builds the turn from the agent messages after ours, and names the last one', async () => {
    const client = clientOf([answer('completed', [
      user('u0', 'older'), agent('a0', [text('Old')]),
      user('u1', OURS), agent('a1', [text('Thinking', 'thinking')]), agent('a2', [text('Answer'), text('Starting', 'notice')])
    ])])
    const got = await collectTask(input(client))
    expect(got).toMatchObject({ supported: true, state: 'completed', found: true, hasReply: true, historyFull: false, text: 'Answer' })
    if (!got.supported) throw new Error('unreachable')
    expect(got.parts.map((p) => [p.kind, p.text])).toEqual([['thinking', 'Thinking'], ['text', 'Answer']])
    expect(got.notices.map((n) => n.text)).toEqual(['Starting'])
    expect(got.lastAgentMessage?.messageId).toBe('a2')
    expect(client.getTask).toHaveBeenCalledWith({ id: 't', historyLength: 50 })
  })

  it('stops at the next user message: the replies after it are another turn’s', async () => {
    const client = clientOf([answer('completed', [
      user('u1', OURS), agent('a1', [text('Ours')]),
      user('u-other', 'later'), agent('a2', [text('Theirs'), text('Their notice', 'notice')], 'canceled')
    ])])
    const got = await collectTask(input(client))
    // Mutation: skip later user messages instead of stopping → "Theirs" and
    // its notice join our turn, and its `canceled` becomes ours.
    expect(got).toMatchObject({ supported: true, state: 'completed', found: true, text: 'Ours', lastAgentState: 'complete' })
    if (!got.supported) throw new Error('unreachable')
    expect(got.parts.map((p) => p.text)).toEqual(['Ours'])
    expect(got.notices).toEqual([])
    expect(got.lastAgentMessage?.messageId).toBe('a1')
  })

  it('says our turn is over while the task works on a later message, once our reply is no longer streaming', async () => {
    const client = clientOf([
      answer('working', [user('u1', OURS), agent('a1', [text('Half')], 'streaming'), user('u2', 'later')]),
      answer('working', [user('u1', OURS), agent('a1', [text('Whole')]), user('u2', 'later'), agent('a2', [text('Next')], 'streaming')])
    ])
    const got = await collectTask({ ...input(client), onPoll: () => undefined })
    // Mutation: judge only the task's state → polls for as long as the later
    // turn runs.
    expect(got).toMatchObject({ supported: true, state: 'completed', text: 'Whole' })
    expect(client.calls).toBe(2)
  })

  it('keeps polling a turn with no reply of its own yet, although a later message follows it', async () => {
    const client = clientOf([
      answer('working', [user('u1', OURS), user('u2', 'later')]),
      answer('completed', [user('u1', OURS), user('u2', 'later'), agent('a2', [text('Both')])])
    ])
    const got = await collectTask({ ...input(client), onPoll: () => undefined })
    expect(got).toMatchObject({ supported: true, state: 'completed', found: true, parts: [] })
    expect(client.calls).toBe(2)
  })

  it.each([
    ['canceled', 'completed', 'canceled'],
    ['aborted', 'completed', 'aborted'],
    ['aborted', 'failed', 'aborted'],
    ['complete', 'failed', 'failed'],
    ['complete', 'input-required', 'input-required']
  ])('reports a turn whose reply is %s under a %s task as %s', async (messageState, taskState, expected) => {
    const got = await collectTask(input(clientOf([answer(taskState, [user('u1', OURS), agent('a1', [text('x')], messageState)])])))
    expect(got).toMatchObject({ supported: true, state: expected })
  })

  it('reports a canceled turn a later message followed as canceled, not as the task’s state', async () => {
    const got = await collectTask(input(clientOf([answer('input-required', [
      user('u1', OURS), agent('a1', [text('x')], 'canceled'), user('u2', 'later'), agent('a2', [text('Which?')])
    ])])))
    expect(got).toMatchObject({ supported: true, state: 'canceled' })
  })

  it('says not found when our message is missing', async () => {
    const got = await collectTask(input(clientOf([answer('completed', [user('u0', 'older'), agent('a0', [text('Old')])])])))
    expect(got).toEqual({ supported: true, state: 'completed', found: false, hasReply: false, historyFull: false, parts: [], notices: [], text: '' })
  })

  it('says the history is full when it came back as long as asked', async () => {
    const history = Array.from({ length: 50 }, (_, i) => (i % 2 ? agent(`a${i}`, [text('a')]) : user(`u${i}`, `older-${i}`)))
    const got = await collectTask(input(clientOf([answer('completed', history)])))
    expect(got).toMatchObject({ supported: true, found: false, historyFull: true })
  })

  it.each([
    ['a history without cinna keys', answer('working', [{ kind: 'message', role: 'user', messageId: 'm', parts: [] }]), 'unsupported'],
    ['an empty history', answer('completed', []), 'unsupported'],
    ['a JSON-RPC error', { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'nope' } }, 'unsupported'],
    ['a plain thrown error', () => { throw new Error('bad frame') }, 'unsupported'],
    ['a thrown network error', () => { throw new TypeError('fetch failed') }, 'unreachable'],
    ['a connection refused', () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) }) }, 'unreachable'],
    ['a timeout', () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError') }, 'unreachable'],
    ['a bad URL', () => { throw new TypeError('fetch failed', { cause: Object.assign(new TypeError('Invalid URL'), { code: 'ERR_INVALID_URL' }) }) }, 'unsupported'],
    ['a URL that does not parse', () => { throw Object.assign(new TypeError('Failed to parse URL from nope'), { cause: { code: 'ERR_INVALID_URL' } }) }, 'unsupported'],
    ['any other TypeError', () => { throw new TypeError('Cannot read properties of undefined') }, 'unsupported'],
    ['a socket error', () => { throw Object.assign(new Error('closed'), { cause: { code: 'ECONNRESET' } }) }, 'unreachable'],
    ['a 401', () => { throw new A2aHttpError(401, 'Unauthorized', 'u') }, 'unauthorized'],
    ['a 403', () => { throw new A2aHttpError(403, 'Forbidden', 'u') }, 'unauthorized']
  ])('cannot report the turn on %s, after one call', async (_label, first, reason) => {
    const client = clientOf([first])
    expect(await collectTask(input(client))).toEqual({ supported: false, reason })
    expect(client.calls).toBe(1)
  })

  /** The plain `Error` the SDK throws for a non-OK JSON-RPC response it cannot read as an error frame. */
  const sdkHttpError = (status: number, statusText: string) => () => {
    throw new Error(`HTTP error for tasks/get! Status: ${status} ${statusText}. Response: upstream down`, { cause: new SyntaxError('x') })
  }

  it.each([
    ['a 502 from tasks/get', sdkHttpError(502, 'Bad Gateway')],
    ['a 503 from tasks/get', sdkHttpError(503, 'Service Unavailable')],
    ['a 408 from tasks/get', sdkHttpError(408, 'Request Timeout')],
    ['a 429 from tasks/get', sdkHttpError(429, 'Too Many Requests')],
    ['a 503 from the card a poll client is built from', () => { throw new AgentCardFetchError(503, 'Service Unavailable', 'u') }]
  ])('reads %s as unreachable only when asked to, and as unsupported for the live turn', async (_label, first) => {
    // Mutation: drop the `transientStatusUnreachable` check in `fetchTask` → unsupported both times.
    expect(await collectTask({ ...input(clientOf([first])), transientStatusUnreachable: true })).toEqual({ supported: false, reason: 'unreachable' })
    expect(await readTask(clientOf([first]), 't', { transientStatusUnreachable: true })).toEqual({ failed: 'unreachable' })
    expect(await collectTask(input(clientOf([first])))).toEqual({ supported: false, reason: 'unsupported' })
  })

  it.each([
    ['a 500', sdkHttpError(500, 'Internal Server Error')],
    ['a 404', sdkHttpError(404, 'Not Found')],
    ['a card 404', () => { throw new AgentCardFetchError(404, 'Not Found', 'u') }],
    ['a message that only mentions a status', () => { throw new Error('upstream said Status: 502') }]
  ])('keeps %s as the status says, with the option on', async (label, first) => {
    const reason = label === 'a 500' ? 'unreachable' : 'unsupported'
    expect(await collectTask({ ...input(clientOf([first])), transientStatusUnreachable: true })).toEqual({ supported: false, reason })
  })

  it('starts from a first answer read beforehand, without asking again', async () => {
    const client = clientOf([answer('completed', [user('u1', OURS), agent('a1', [text('Done')])])])
    const initial = await readTask(client, 't')
    const got = await collectTask({ ...input(client), initial })
    expect(got).toMatchObject({ supported: true, state: 'completed', text: 'Done' })
    expect(client.calls).toBe(1)
  })

  it('counts an echoed client message id alone as support (a queued first turn)', async () => {
    const got = await collectTask(input(clientOf([answer('failed', [user('u1', OURS)])])))
    expect(got).toMatchObject({ supported: true, state: 'failed', found: true, hasReply: false, parts: [] })
  })

  it('says a turn the backend ended with no agent message has no reply, even with a later message’s reply after it', async () => {
    // Mutation: `hasReply: true` for every found turn → a crashed turn's
    // empty history replaces what streamed.
    const got = await collectTask(input(clientOf([answer('completed', [user('u1', OURS), user('u2', 'later'), agent('a2', [text('Theirs')])])])))
    expect(got).toMatchObject({ supported: true, found: true, hasReply: false, parts: [] })
  })

  it('says an agent message whose only part is empty text is no reply, and keeps its state', async () => {
    // The backend writes a canceled or aborted row with no events as one
    // empty text part. Mutation: `hasReply: !!lastAgentMessage` → true.
    const got = await collectTask(input(clientOf([answer('completed', [user('u1', OURS), agent('a1', [text('')], 'aborted')])])))
    expect(got).toMatchObject({ supported: true, state: 'aborted', found: true, hasReply: false, parts: [], lastAgentState: 'aborted' })
    if (!got.supported) throw new Error('unreachable')
    expect(replyLost(got)).toBe(true)
  })

  it('does not call a reply lost when a later message follows ours and the agent answered after it', async () => {
    // The backend may answer two queued messages in one reply. Mutation:
    // drop `answeredWithNext` from `replyLost` → a cut-off failure.
    const got = await collectTask(input(clientOf([answer('completed', [user('u1', OURS), user('u2', 'later'), agent('a2', [text('Both')])])])))
    if (!got.supported) throw new Error('unreachable')
    expect(got).toMatchObject({ state: 'completed', found: true, hasReply: false, parts: [], answeredWithNext: true })
    expect(replyLost(got)).toBe(false)
  })

  it.each([
    ['no answer after the later message', [user('u1', OURS), user('u2', 'later')]],
    ['only a later user message after that', [user('u1', OURS), user('u2', 'later'), user('u3', 'latest')]],
    ['an empty row of our own before it', [user('u1', OURS), agent('a1', [text('')], 'aborted'), user('u2', 'later'), agent('a2', [text('Theirs')])]]
  ])('still calls a reply lost with %s', async (_label, history) => {
    const got = await collectTask(input(clientOf([answer('completed', history)])))
    if (!got.supported) throw new Error('unreachable')
    expect(got.answeredWithNext).toBeUndefined()
    expect(replyLost(got)).toBe(true)
  })

  it('counts a reply that is only a notice as a reply, with no parts', async () => {
    // Mutation: `hasReply: parts.length > 0` → the notice-only reply reads lost.
    const got = await collectTask(input(clientOf([answer('completed', [user('u1', OURS), agent('a1', [text('Env started', 'notice')])])])))
    if (!got.supported) throw new Error('unreachable')
    expect(got).toMatchObject({ state: 'completed', found: true, hasReply: true, parts: [], text: '' })
    expect(got.notices.map((n) => n.text)).toEqual(['Env started'])
    expect(replyLost(got)).toBe(false)
    // It ended normally, so it is the turn's copy; cut off, its parts are weighed.
    expect(serverCopyWins(got, { textLength: 5, parts: 1 })).toBe(true)
    expect(serverCopyWins({ ...got, state: 'aborted' }, { textLength: 5, parts: 1 })).toBe(false)
    expect(serverCopyWins({ ...got, state: 'aborted' }, { textLength: 0, parts: 0 })).toBe(true)
  })

  const turn =(over: Partial<Extract<CollectedTask, { supported: true }>>): Extract<CollectedTask, { supported: true }> => ({
    supported: true, state: 'completed', found: true, hasReply: false, historyFull: false, parts: [], notices: [], text: '', ...over
  })

  describe('serverCopyWins', () => {
    const reply = (state: string, texts: string[], lastAgentState?: string) => turn({
      state, hasReply: texts.length > 0, parts: texts.map((t) => ({ kind: 'text' as const, text: t })),
      ...(lastAgentState ? { lastAgentState } : {})
    })
    const local = { textLength: 10, parts: 2 }

    it.each([
      ['completed', undefined],
      ['completed', 'complete'],
      ['input-required', undefined],
      ['auth-required', 'complete']
    ])('always takes a %s reply (message %s), however short', (state, message) => {
      expect(serverCopyWins(reply(state, ['x'], message), local)).toBe(true)
    })

    // Mutation: `isCutOff` back to `aborted`/`canceled` only → the `failed`,
    // `rejected` and `streaming` rows win however short they are.
    it.each([
      ['aborted', undefined],
      ['canceled', undefined],
      ['failed', undefined],
      ['failed', 'complete'],
      ['rejected', undefined],
      ['unknown', undefined],
      ['completed', 'aborted'],
      ['completed', 'streaming'],
      ['input-required', 'streaming'],
      ['failed', 'canceled'],
      ['failed', 'streaming']
    ])('weighs a reply cut off (state %s, message %s) against the local copy', (state, message) => {
      expect(serverCopyWins(reply(state, ['short'], message), local)).toBe(false)
      expect(serverCopyWins(reply(state, ['0123456789', '!'], message), local)).toBe(true)
      // Same text length: the part count decides, a tie goes to the server.
      expect(serverCopyWins(reply(state, ['0123456789'], message), local)).toBe(false)
      expect(serverCopyWins(reply(state, ['01234', '56789'], message), local)).toBe(true)
    })

    it('never takes no reply, or a message never found', () => {
      expect(serverCopyWins(reply('completed', []), { textLength: 0, parts: 0 })).toBe(false)
      expect(serverCopyWins({ ...reply('completed', ['x']), found: false }, { textLength: 0, parts: 0 })).toBe(false)
    })
  })

  describe('replyLost', () => {

    it.each(['completed', 'failed', 'aborted', 'rejected'])('is true for a found turn with no reply that ended %s', (state) => {
      expect(replyLost(turn({ state }))).toBe(true)
    })

    it.each([
      ['a stop', turn({ state: 'canceled' })],
      ['a question', turn({ state: 'input-required' })],
      ['a sign-in ask', turn({ state: 'auth-required' })],
      ['a turn still running', turn({ state: 'working' })],
      ['a turn with a reply', turn({ hasReply: true })],
      ['a message never found', turn({ found: false })]
    ])('is false for %s', (_label, collected) => {
      expect(replyLost(collected)).toBe(false)
    })
  })

  describe('polling', () => {
    beforeEach(() => {
      Object.assign(collectPollDelays, saved)
      vi.useFakeTimers()
    })
    afterEach(() => void vi.useRealTimers())

    const running = answer('working', [user('u1', OURS)])

    it('asks every 2 s for two minutes, then every 5 s, until the task stops working', async () => {
      const times: number[] = []
      const start = Date.now()
      let calls = 0
      const client: TaskGetter = {
        getTask: async () => {
          times.push(Date.now() - start)
          return ++calls < 64 ? running : answer('completed', [user('u1', OURS), agent('a', [text('Done')])])
        }
      }
      const promise = collectTask(input(client))
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      await expect(promise).resolves.toMatchObject({ supported: true, state: 'completed', text: 'Done' })
      const gaps = times.slice(1).map((t, i) => t - times[i])
      expect(gaps.slice(0, 60)).toEqual(Array(60).fill(2_000))
      expect(times[60]).toBe(120_000)
      expect(gaps.slice(60)).toEqual([5_000, 5_000, 5_000])
    })

    it('rejects as soon as it is aborted mid-wait, without another call', async () => {
      const client = clientOf([running])
      const controller = new AbortController()
      const promise = collectTask(input(client, controller.signal))
      const settled = vi.fn()
      promise.then(settled, settled)
      await vi.advanceTimersByTimeAsync(500)
      controller.abort(new Error('stopped'))
      await Promise.resolve()
      await Promise.resolve()
      expect(settled).toHaveBeenCalledWith(new Error('stopped'))
      expect(client.calls).toBe(1)
    })

    it('rides out a network error once polling has started', async () => {
      const client = clientOf([
        running,
        () => { throw new TypeError('fetch failed') },
        answer('completed', [user('u1', OURS), agent('a', [text('Back')])])
      ])
      const promise = collectTask(input(client))
      await vi.advanceTimersByTimeAsync(10_000)
      await expect(promise).resolves.toMatchObject({ state: 'completed', text: 'Back' })
      expect(client.calls).toBe(3)
    })

    it('gives up as unreachable once drops outlast the poll’s patience', async () => {
      const client = clientOf([running, () => { throw new TypeError('terminated') }])
      const promise = collectTask(input(client))
      await vi.advanceTimersByTimeAsync(collectPollDelays.dropsForMs + 10_000)
      // Mutation: `continue` on every drop → still polling.
      await expect(promise).resolves.toEqual({ supported: false, reason: 'unreachable' })
    })

    it('asks a refused poll again once, after renewing the client', async () => {
      const client = clientOf([
        running,
        () => { throw new A2aHttpError(401, 'Unauthorized', 'u') },
        answer('completed', [user('u1', OURS), agent('a', [text('Renewed')])])
      ])
      const renewClient = vi.fn()
      const promise = collectTask({ ...input(client), renewClient })
      await vi.advanceTimersByTimeAsync(10_000)
      await expect(promise).resolves.toMatchObject({ state: 'completed', text: 'Renewed' })
      expect(renewClient).toHaveBeenCalledTimes(1)
      expect(client.calls).toBe(3)
    })

    it('gives up as unauthorized when the renewed client is refused too, or when it cannot renew', async () => {
      const refused = () => { throw new A2aHttpError(401, 'Unauthorized', 'u') }
      const renewClient = vi.fn()
      const renewing = collectTask({ ...input(clientOf([running, refused])), renewClient })
      const plain = collectTask(input(clientOf([running, refused])))
      await vi.advanceTimersByTimeAsync(10_000)
      await expect(renewing).resolves.toEqual({ supported: false, reason: 'unauthorized' })
      await expect(plain).resolves.toEqual({ supported: false, reason: 'unauthorized' })
      expect(renewClient).toHaveBeenCalledTimes(1)
    })

    it('rides out a 502 once polling has started, when asked to; the live turn gives up on it', async () => {
      const bad = () => { throw new Error('HTTP error for tasks/get! Status: 502 Bad Gateway. Response: down') }
      const done = answer('completed', [user('u1', OURS), agent('a', [text('Back')])])
      const riding = collectTask({ ...input(clientOf([running, bad, done])), transientStatusUnreachable: true })
      const live = collectTask(input(clientOf([running, bad, done])))
      await vi.advanceTimersByTimeAsync(10_000)
      await expect(riding).resolves.toMatchObject({ state: 'completed', text: 'Back' })
      await expect(live).resolves.toEqual({ supported: false, reason: 'unsupported' })
    })

    it('gives up as unreachable once 5xx answers outlast the poll’s patience', async () => {
      const bad = () => { throw new Error('HTTP error for tasks/get! Status: 503 Service Unavailable. Response: down') }
      const promise = collectTask({ ...input(clientOf([running, bad])), transientStatusUnreachable: true })
      await vi.advanceTimersByTimeAsync(collectPollDelays.dropsForMs + 10_000)
      await expect(promise).resolves.toEqual({ supported: false, reason: 'unreachable' })
    })

    describe('a first read with no answer', () => {
      const done = answer('completed', [user('u1', OURS), agent('a', [text('Back')])])
      const dropped = () => { throw new TypeError('fetch failed') }

      it('is ridden out with rideOutFirstRead until an answer arrives', async () => {
        // Mutation: drop the `rideOutFirstRead` loop → unreachable after one call.
        const client = clientOf([dropped, dropped, done])
        const promise = collectTask({ ...input(client), rideOutFirstRead: true })
        await vi.advanceTimersByTimeAsync(10_000)
        await expect(promise).resolves.toMatchObject({ supported: true, state: 'completed', text: 'Back' })
        expect(client.calls).toBe(3)
      })

      it('gives up as unreachable once it outlasts dropsForMs, counted from that first failure', async () => {
        const client = clientOf([dropped])
        const promise = collectTask({ ...input(client), rideOutFirstRead: true })
        const settled = vi.fn()
        promise.then(settled)
        await vi.advanceTimersByTimeAsync(collectPollDelays.dropsForMs - 10_000)
        expect(settled).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(20_000)
        // Mutation: `continue` for ever → still pending.
        await expect(promise).resolves.toEqual({ supported: false, reason: 'unreachable' })
      })

      it('still needs the cinna keys on the first answer that arrives', async () => {
        const client = clientOf([dropped, answer('working', [{ kind: 'message', role: 'user', messageId: 'm', parts: [] }])])
        const promise = collectTask({ ...input(client), rideOutFirstRead: true })
        await vi.advanceTimersByTimeAsync(10_000)
        await expect(promise).resolves.toEqual({ supported: false, reason: 'unsupported' })
        expect(client.calls).toBe(2)
      })

      it('ends at once without the flag, as before', async () => {
        const client = clientOf([dropped, done])
        await expect(collectTask(input(client))).resolves.toEqual({ supported: false, reason: 'unreachable' })
        expect(client.calls).toBe(1)
      })

      it('ends at once with the flag on a refusal or an unusable answer', async () => {
        const refused = clientOf([() => { throw new A2aHttpError(401, 'Unauthorized', 'u') }, done])
        const bad = clientOf([() => { throw new Error('bad frame') }, done])
        await expect(collectTask({ ...input(refused), rideOutFirstRead: true })).resolves.toEqual({ supported: false, reason: 'unauthorized' })
        await expect(collectTask({ ...input(bad), rideOutFirstRead: true })).resolves.toEqual({ supported: false, reason: 'unsupported' })
        expect(refused.calls + bad.calls).toBe(2)
      })

      it('rides out a 502 with transientStatusUnreachable and the flag, and only then', async () => {
        const bad = () => { throw new Error('HTTP error for tasks/get! Status: 502 Bad Gateway. Response: down') }
        const riding = clientOf([bad, done])
        const withoutTransient = clientOf([bad, done])
        const promise = collectTask({ ...input(riding), rideOutFirstRead: true, transientStatusUnreachable: true })
        await vi.advanceTimersByTimeAsync(10_000)
        await expect(promise).resolves.toMatchObject({ supported: true, state: 'completed', text: 'Back' })
        await expect(collectTask({ ...input(withoutTransient), rideOutFirstRead: true })).resolves.toEqual({ supported: false, reason: 'unsupported' })
        expect(withoutTransient.calls).toBe(1)
      })

      it('does not apply to a first answer read beforehand', async () => {
        const client = clientOf([done])
        const got = await collectTask({ ...input(client), rideOutFirstRead: true, initial: { failed: 'unreachable' } })
        expect(got).toEqual({ supported: false, reason: 'unreachable' })
        expect(client.calls).toBe(0)
      })

      it('rejects on abort while riding out', async () => {
        const controller = new AbortController()
        const promise = collectTask({ ...input(clientOf([dropped]), controller.signal), rideOutFirstRead: true })
        const settled = vi.fn()
        promise.then(settled, settled)
        await vi.advanceTimersByTimeAsync(5_000)
        controller.abort(new Error('stopped'))
        await vi.advanceTimersByTimeAsync(0)
        expect(settled).toHaveBeenCalledWith(new Error('stopped'))
      })
    })

    it('gives up on a JSON-RPC error once polling has started', async () => {
      const client = clientOf([running, { jsonrpc: '2.0', id: 2, error: { code: -32001, message: 'Task not found' } }])
      const promise = collectTask(input(client))
      await vi.advanceTimersByTimeAsync(10_000)
      await expect(promise).resolves.toEqual({ supported: false, reason: 'unsupported' })
    })
  })
})
