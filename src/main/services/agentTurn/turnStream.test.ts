/**
 * `TurnStream` folded into the **real** `StreamPartsAccumulator`.
 *
 * That pairing is the point of this file rather than an incidental convenience.
 * The two halves have opposite conventions — OpenCode emits true deltas, the
 * accumulator expects each part's cumulative text and computes the delta itself
 * — and a unit test of either half in isolation passes while the pair
 * duplicates every character from the second chunk onwards. The bug lives in
 * the seam, so the test has to sit on the seam.
 *
 * Every mutation named below was **run**; the table at the bottom records the
 * result of each.
 */
import { describe, expect, it } from 'vitest'
import { StreamPartsAccumulator } from '../../agents/streamPartsAccumulator'
import type { AgentDeltaEvent } from '../../../shared/agentStreamEvents'
import type { MessagePart } from '../../../shared/messageParts'
import { PERMISSION_TOOL_NAME } from '../../../shared/localAgentRequests'
import {
  engineErrorMessage,
  isTurnOver,
  mapQuestions,
  renderToolOutput,
  TurnStream
} from './turnStream'
import type { EngineEvent } from './engineEvents'

const ev = (type: string, data: Record<string, unknown>, seq?: number): EngineEvent => ({
  type,
  id: 'evt',
  ...(seq === undefined ? {} : { durable: { aggregateID: 'ses_a', seq, version: 1 } }),
  data
})

/** Drive a list of events through both halves, exactly as the runner will. */
function run(events: EngineEvent[]): {
  parts: MessagePart[]
  deltas: AgentDeltaEvent[]
  answer: string
  stream: TurnStream
} {
  const stream = new TurnStream()
  const accumulator = new StreamPartsAccumulator()
  const deltas: AgentDeltaEvent[] = []
  const port = { postMessage: (m: AgentDeltaEvent): void => void deltas.push(m) }
  for (const event of events) {
    const update = stream.apply(event)
    if (update.message) accumulator.ingestMessage(update.message, port)
  }
  return {
    parts: accumulator.snapshotParts(),
    deltas,
    answer: accumulator.answerText(),
    stream
  }
}

const textDelta = (delta: string, textID = 't1'): EngineEvent =>
  ev('session.next.text.delta', {
    sessionID: 'ses_a',
    assistantMessageID: 'msg_1',
    textID,
    delta
  })

describe('TurnStream → StreamPartsAccumulator', () => {
  it('streams three deltas as three deltas', () => {
    const { parts, deltas, answer } = run([textDelta('Hel'), textDelta('lo '), textDelta('world')])

    expect(deltas.map((d) => d.text)).toEqual(['Hel', 'lo ', 'world'])
    expect(parts).toEqual([{ kind: 'text', text: 'Hello world' }])
    expect(answer).toBe('Hello world')

    // **This test does NOT pin the cumulative-vs-raw-delta contract, and used
    // to claim it did.** The mutation `(state.parts[idx].text ?? '') + delta`
    // → `delta` — handing the accumulator a raw engine delta as if it were an
    // A2A part — was run against this and **passed 19/19**. The accumulator's
    // `text.startsWith(prior) ? slice : text` fallback happens to reconstruct
    // exactly the same string for a plain sequential stream, so both
    // conventions agree here. The two tests below are the ones that separate
    // them; keep them if this file is ever reorganised.
  })

  it('does not swallow a chunk identical to the one before it', () => {
    // An LLM repeating a token — '  ', 'the ', a markdown '**' — is ordinary,
    // and under the raw-delta convention the accumulator sees `text === prior`
    // and skips it as a no-op. The output is silently one chunk short, with
    // nothing anywhere saying so.
    //
    // Mutation `(state.parts[idx].text ?? '') + delta` → `delta` fails here:
    // parts become 'abc' and the deltas ['ab', 'c'].
    const { parts, deltas } = run([textDelta('ab'), textDelta('ab'), textDelta('c')])

    expect(deltas.map((d) => d.text)).toEqual(['ab', 'ab', 'c'])
    expect(parts).toEqual([{ kind: 'text', text: 'ababc' }])
  })

  it('a block-level ended after several deltas does not re-emit what streamed', () => {
    // The gap-fill path with more than one delta behind it — the case the
    // single-delta test below cannot reach. Under the raw-delta convention the
    // part holds only the *last* delta, so `text.ended` is not a prefix of it
    // and the accumulator appends the whole thing again.
    //
    // Mutation `(state.parts[idx].text ?? '') + delta` → `delta` fails here
    // with 'Hello Hello world'.
    const { parts, deltas } = run([
      textDelta('Hel'),
      textDelta('lo '),
      ev('session.next.text.ended', {
        sessionID: 'ses_a',
        assistantMessageID: 'msg_1',
        textID: 't1',
        text: 'Hello world'
      })
    ])

    expect(deltas.map((d) => d.text)).toEqual(['Hel', 'lo ', 'world'])
    expect(parts).toEqual([{ kind: 'text', text: 'Hello world' }])
  })

  it('files a text.ended under the message its deltas built, not a second one', () => {
    // The landmine the heal path walks toward. `text.ended` is replayed off the
    // durable stream, whose exact field set on this event nobody has watched,
    // and the fallback for a missing `assistantMessageID` used to be
    // `anon:text` — a *different* key from the deltas' `msg_1`. The block would
    // then be filed twice and the whole answer duplicated into the transcript.
    //
    // Mutation: delete the `streamOwner` lookup (back to
    // `str(data.assistantMessageID) ?? \`anon:${kind}\`) fails this with
    // 'HelHello world'.
    const { parts } = run([
      textDelta('Hel'),
      ev('session.next.text.ended', {
        sessionID: 'ses_a',
        // No `assistantMessageID` — the case the fallback exists for.
        textID: 't1',
        text: 'Hello world'
      })
    ])

    expect(parts).toEqual([{ kind: 'text', text: 'Hello world' }])
  })

  it('keeps a stream id with a changed message id in its original block', () => {
    // The other half: not absent but *different*. Same duplication, and it is
    // the shape a replay is most likely to produce if the durable stream
    // reports a message id the live stream did not.
    const { parts } = run([
      textDelta('Hel'),
      ev('session.next.text.ended', {
        sessionID: 'ses_a',
        assistantMessageID: 'msg_DIFFERENT',
        textID: 't1',
        text: 'Hello world'
      })
    ])
    expect(parts).toEqual([{ kind: 'text', text: 'Hello world' }])
  })

  it('keeps thinking and text in separate parts', () => {
    const { parts } = run([
      ev('session.next.reasoning.delta', {
        sessionID: 'ses_a',
        assistantMessageID: 'msg_1',
        reasoningID: 'r1',
        delta: 'pondering'
      }),
      textDelta('answer')
    ])

    // Mutation: `slot(state, `${kind}:${streamId}`, …)` → `slot(state,
    // streamId, …)` fails this when a reasoning id and a text id collide;
    // more directly, mapping reasoning to kind 'text' fails it here.
    expect(parts).toEqual([
      { kind: 'thinking', text: 'pondering' },
      { kind: 'text', text: 'answer' }
    ])
  })

  it('a block-level text.ended after the deltas adds nothing', () => {
    // The replay case: live, `ended` carries text already streamed. It must be
    // idempotent or a reconnect would double the answer.
    const { parts, deltas } = run([
      textDelta('Hello'),
      ev('session.next.text.ended', {
        sessionID: 'ses_a',
        assistantMessageID: 'msg_1',
        textID: 't1',
        text: 'Hello'
      })
    ])

    // Mutation: `setText`'s `if (text.length <= current.length) return {}` →
    // always set fails this with a second, duplicate delta.
    expect(deltas.map((d) => d.text)).toEqual(['Hello'])
    expect(parts).toEqual([{ kind: 'text', text: 'Hello' }])
  })

  it('a text.ended whose deltas were lost restores the missing tail', () => {
    // The gap-fill case: the socket dropped after 'Hel', and the durable
    // per-session stream replays the block-level `ended`.
    const { parts, deltas } = run([
      textDelta('Hel'),
      ev('session.next.text.ended', {
        sessionID: 'ses_a',
        assistantMessageID: 'msg_1',
        textID: 't1',
        text: 'Hello world'
      })
    ])

    // Mutation: drop the `textEnded` case from the switch fails this — the
    // answer stays truncated at 'Hel' with no sign anything was lost, which is
    // the failure mode hardest to notice.
    expect(deltas.map((d) => d.text)).toEqual(['Hel', 'lo world'])
    expect(parts).toEqual([{ kind: 'text', text: 'Hello world' }])
  })

  it('a shorter text.ended never shrinks what already streamed', () => {
    const { parts, deltas } = run([
      textDelta('Hello world'),
      ev('session.next.text.ended', {
        sessionID: 'ses_a',
        assistantMessageID: 'msg_1',
        textID: 't1',
        text: 'Hel'
      })
    ])

    // Without the never-shrink rule the accumulator's `startsWith(prior)` is
    // false, so it emits the *whole* short string as a delta and the user sees
    // 'Hello worldHel'. Mutation: `<=` → `===` in `setText` fails this.
    expect(deltas.map((d) => d.text)).toEqual(['Hello world'])
    expect(parts).toEqual([{ kind: 'text', text: 'Hello world' }])
  })

  it('pairs a tool call with its result by callID', () => {
    const { parts } = run([
      ev('session.next.tool.called', {
        sessionID: 'ses_a',
        assistantMessageID: 'msg_1',
        callID: 'c1',
        tool: 'bash',
        input: { command: 'uv run scripts/x.py' },
        provider: { executed: true }
      }),
      ev('session.next.tool.success', {
        sessionID: 'ses_a',
        assistantMessageID: 'msg_1',
        callID: 'c1',
        structured: {},
        content: [{ type: 'text', text: 'done' }],
        provider: { executed: true }
      })
    ])

    // Mutation: drop `TOOL_ID_METADATA_KEY` from either part fails this — the
    // renderer pairs a call to its result on `toolId`, and without it the
    // result renders as an orphan block.
    expect(parts).toEqual([
      {
        kind: 'tool',
        text: 'bash: uv run scripts/x.py',
        toolName: 'bash',
        toolInput: { command: 'uv run scripts/x.py' },
        toolId: 'c1'
      },
      { kind: 'tool_result', text: 'done', toolId: 'c1', toolStream: 'stdout' }
    ])
  })

  it('routes a failed tool to stderr with the engine\'s own reason', () => {
    const { parts } = run([
      ev('session.next.tool.called', {
        sessionID: 'ses_a',
        assistantMessageID: 'msg_1',
        callID: 'c1',
        tool: 'bash',
        input: {},
        provider: { executed: true }
      }),
      ev('session.next.tool.failed', {
        sessionID: 'ses_a',
        assistantMessageID: 'msg_1',
        callID: 'c1',
        // `SessionErrorUnknown` is `{type, message}` — NOT the `{name, data:
        // {message}}` shape the other seven errors use.
        error: { type: 'unknown', message: 'exit status 1' },
        provider: { executed: true }
      })
    ])

    // Mutation: `engineErrorMessage` reading only `obj.data.message` fails
    // this with the generic fallback, losing the only line that says what
    // actually went wrong.
    expect(parts[1]).toEqual({
      kind: 'tool_result',
      text: 'exit status 1',
      toolId: 'c1',
      toolStream: 'stderr'
    })
  })

  it('emits a permission ask as a tool part whose toolId is the reply address', () => {
    const stream = new TurnStream()
    const update = stream.apply(
      ev('permission.v2.asked', {
        id: 'per_9',
        sessionID: 'ses_a',
        action: 'bash',
        resources: ['rm -rf build'],
        save: ['bash:rm *'],
        source: { type: 'tool', messageID: 'msg_1', callID: 'c1' }
      })
    )

    expect(update.asked).toEqual({ kind: 'permission', requestId: 'per_9' })
    const accumulator = new StreamPartsAccumulator()
    accumulator.ingestMessage(update.message!, { postMessage: () => {} })
    const [part] = accumulator.snapshotParts()
    // Mutation: `[TOOL_ID_METADATA_KEY]: requestId` → the callID fails this.
    // The tool id IS the address a reply is posted to, so getting it wrong
    // sends the answer to a request that does not exist and parks the session
    // forever.
    expect(part.toolId).toBe('per_9')
    expect(part.toolName).toBe(PERMISSION_TOOL_NAME)
    expect(part.toolInput).toEqual({
      action: 'bash',
      resources: ['rm -rf build'],
      savable: ['bash:rm *'],
      callId: 'c1'
    })
  })

  it('carries an empty savable through when the engine offers no save patterns', () => {
    const stream = new TurnStream()
    const update = stream.apply(
      ev('permission.v2.asked', {
        id: 'per_9',
        sessionID: 'ses_a',
        action: 'webfetch',
        resources: ['https://example.com']
        // no `save`
      })
    )
    const request = update.message!.parts[0].metadata!['cinna.tool_input'] as {
      savable: string[]
    }
    // Mutation: `savable: Array.isArray(data.save) ? … : []` → `['*']` or a
    // copy of `resources` fails this. The renderer hides Always when savable is
    // empty; a non-empty default would offer a grant the engine then ignores,
    // which the user reads as a decision that silently did not stick.
    expect(request.savable).toEqual([])
  })

  it('normalises an OpenCode question to the desktop AskQuestion shape', () => {
    const stream = new TurnStream()
    const update = stream.apply(
      ev('question.v2.asked', {
        id: 'que_3',
        sessionID: 'ses_a',
        questions: [
          {
            question: 'Which database?',
            header: 'DB',
            multiple: true,
            custom: true,
            options: [
              { label: 'Postgres', description: 'relational' },
              { label: 'SQLite', description: 'embedded' }
            ]
          }
        ],
        tool: { messageID: 'msg_1', callID: 'c1' }
      })
    )

    expect(update.asked).toEqual({ kind: 'question', requestId: 'que_3' })
    const input = update.message!.parts[0].metadata!['cinna.tool_input'] as {
      questions: { multiSelect: boolean }[]
    }
    // Mutation: `multiSelect: obj.multiple === true` → `obj.multiSelect ===
    // true` fails this with `false`. The renderer would then show radio
    // buttons for a question the agent asked as multi-select, and the user
    // could only ever return one answer where several were wanted.
    expect(input.questions[0].multiSelect).toBe(true)
  })

  it('closes a permission ask with a paired decision record', () => {
    const stream = new TurnStream()
    const accumulator = new StreamPartsAccumulator()
    const port = { postMessage: (): void => {} }
    for (const e of [
      ev('permission.v2.asked', {
        id: 'per_9',
        sessionID: 'ses_a',
        action: 'bash',
        resources: ['rm -rf build'],
        source: { type: 'tool', messageID: 'msg_1', callID: 'c1' }
      }),
      ev('permission.v2.replied', { sessionID: 'ses_a', requestID: 'per_9', reply: 'once' })
    ]) {
      const u = stream.apply(e)
      if (u.message) accumulator.ingestMessage(u.message, port)
    }

    // Two things need this pairing and neither is cosmetic. The transcript has
    // to record what was decided — a permission prompt replayed with no answer
    // beside it is an approval nobody can account for. And the shared
    // `cinna.tool_id` is what lets the renderer *consume* the result through
    // the pairing machinery already there, instead of leaving a bare terminal
    // block next to every decision.
    //
    // Mutation: `settleRequest` returning `{ settled }` without the message
    // (which is what it did first) fails this with one part.
    expect(accumulator.snapshotParts()).toEqual([
      {
        kind: 'tool',
        text: 'Permission needed for bash: rm -rf build',
        toolName: PERMISSION_TOOL_NAME,
        toolId: 'per_9',
        toolInput: { action: 'bash', resources: ['rm -rf build'], savable: [], callId: 'c1' }
      },
      { kind: 'tool_result', text: 'Allowed once.', toolId: 'per_9', toolStream: 'stdout' }
    ])
  })

  it('files the decision against the message the ask lives in', () => {
    // `permission.v2.replied` carries only `{sessionID, requestID, reply}` —
    // no `assistantMessageID`. Mutation: file the decision under a fresh
    // synthetic message id rather than looking it up in `requestMessage` fails
    // this, and in production would strand the decision in a message of its own
    // where the renderer's pairing never finds it.
    const stream = new TurnStream()
    stream.apply(
      ev('permission.v2.asked', {
        id: 'per_9',
        sessionID: 'ses_a',
        action: 'bash',
        resources: [],
        source: { type: 'tool', messageID: 'msg_7', callID: 'c1' }
      })
    )
    const settled = stream.apply(
      ev('permission.v2.replied', { sessionID: 'ses_a', requestID: 'per_9', reply: 'reject' })
    )
    expect(settled.settled).toBe('per_9')
    expect(settled.message?.messageId).toBe('msg_7')
    expect(settled.message?.parts).toHaveLength(2)
  })

  it('records an answered question with the labels the user chose', () => {
    const stream = new TurnStream()
    stream.apply(
      ev('question.v2.asked', {
        id: 'que_3',
        sessionID: 'ses_a',
        questions: [{ question: 'Which?', header: 'DB', options: [{ label: 'A' }] }],
        tool: { messageID: 'msg_1', callID: 'c1' }
      })
    )
    const settled = stream.apply(
      ev('question.v2.replied', {
        sessionID: 'ses_a',
        requestID: 'que_3',
        answers: [['Postgres'], ['Redis']]
      })
    )
    // Mutation: `questionDecisionText` returning a bare 'Answered.' fails this.
    // The transcript is the only place the choice survives — the modal is gone
    // and the engine's copy is not ours to read back.
    expect(settled.message?.parts[1].text).toBe('Answered: Postgres, Redis.')
  })

  it('records a rejected question as an explicit non-answer', () => {
    const stream = new TurnStream()
    stream.apply(
      ev('question.v2.asked', {
        id: 'que_3',
        sessionID: 'ses_a',
        questions: [{ question: 'Which?', header: 'DB', options: [{ label: 'A' }] }],
        tool: { messageID: 'msg_1', callID: 'c1' }
      })
    )
    const settled = stream.apply(
      ev('question.v2.rejected', { sessionID: 'ses_a', requestID: 'que_3' })
    )
    // A timed-out or cancelled question must leave a record saying so, not look
    // identical to one that was never asked. Mutation: drop the
    // `questionRejected` case fails this.
    expect(settled.message?.parts[1].text).toBe('No answer was given.')
  })

  it('tracks the highest durable seq as the gap-fill cursor', () => {
    const stream = new TurnStream()
    stream.apply(ev('session.next.text.delta', { assistantMessageID: 'm', textID: 't', delta: 'a' }, 5))
    stream.apply(ev('session.next.text.delta', { assistantMessageID: 'm', textID: 't', delta: 'b' }, 9))
    // Out of order: the cursor must not go backwards, or a reconnect would
    // replay events already rendered.
    stream.apply(ev('session.next.text.delta', { assistantMessageID: 'm', textID: 't', delta: 'c' }, 7))

    // Mutation: `event.durable.seq > this.highestSeq` → unconditional
    // assignment fails this with 7.
    expect(stream.lastSeq()).toBe(9)
  })

  it('ends the turn on the last step, not the first', () => {
    // **The regression for the phase's worst defect.** `session.idle` is never
    // emitted by 1.18.27 and `POST /wait` answers 503 "not available yet", so
    // `step.ended` is the only working completion signal — and a tool-calling
    // turn emits several. Settling on the first ends the turn mid-tool-call
    // with a truncated answer; settling on none hangs it forever, holding the
    // per-agent lock for the life of the app.
    //
    // Mutation: `isTurnOver` → `finish === undefined || true` (settle on any
    // `step.ended`) fails this at the first assertion.
    const stream = new TurnStream()
    const step = (finish: string): EngineEvent =>
      ev('session.next.step.ended', {
        sessionID: 'ses_a',
        assistantMessageID: 'msg_1',
        finish,
        cost: 0,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }
      })

    expect(stream.apply(step('tool-calls')).idle).toBeUndefined()
    expect(stream.apply(step('stop')).idle).toBe(true)
  })

  it('treats an unrecognised finish reason as the end of the turn', () => {
    // The OpenAPI document declares `finish` as a bare `"type": "string"` with
    // **no enum**, so the terminal set cannot be read off the spec. The rule is
    // therefore inverted deliberately: continuation is enumerated, termination
    // is the default.
    //
    // Mutation: `isTurnOver` → `finish === 'stop'` fails this. That is the
    // obvious rule, and it hangs the turn forever the moment a real turn ends
    // with `length`, `content-filter` or anything else — invisibly, and taking
    // the engine's reconcile down with it via `turnLock.anyHeld()`.
    expect(isTurnOver('stop')).toBe(true)
    expect(isTurnOver('length')).toBe(true)
    expect(isTurnOver('content-filter')).toBe(true)
    expect(isTurnOver('error')).toBe(true)
    expect(isTurnOver('some-future-reason')).toBe(true)
    expect(isTurnOver(undefined)).toBe(true)
    // The one observed continuation.
    expect(isTurnOver('tool-calls')).toBe(false)
  })

  it('reports idle and error without touching the message', () => {
    const stream = new TurnStream()
    expect(stream.apply(ev('session.idle', { sessionID: 'ses_a' })).idle).toBe(true)
    expect(
      stream.apply(
        ev('session.error', {
          sessionID: 'ses_a',
          error: { name: 'ProviderAuthError', data: { providerID: 'anthropic', message: '401' } }
        })
      ).error
      // The provider is named. A rotated key is the failure a user is most
      // likely to hit, and Phase 5 already fought a version of it where every
      // turn 401'd while the UI showed a valid credential and a green engine.
      // "401" alone leaves the user guessing which of their credentials broke.
      //
      // Mutation: drop the `providerID` prefix fails this with a bare '401'.
    ).toBe('anthropic: 401')
  })

  it('ignores an unknown event type instead of throwing', () => {
    const stream = new TurnStream()
    // The global stream has 88 variants today and will have more. Mutation: a
    // `default: throw` in the switch fails this, and would kill a turn because
    // the engine learned a new trick.
    expect(stream.apply(ev('pty.created', { sessionID: 'ses_a' }))).toEqual({})
  })
})

describe('engineErrorMessage', () => {
  it('reads both error shapes the engine uses', () => {
    expect(engineErrorMessage({ type: 'unknown', message: 'boom' })).toBe('boom')
    expect(engineErrorMessage({ name: 'APIError', data: { message: '429', isRetryable: true } })).toBe(
      '429'
    )
  })

  it('falls back to the error name rather than to nothing', () => {
    expect(engineErrorMessage({ name: 'ContextOverflowError', data: {} })).toBe(
      'The agent stopped: ContextOverflowError.'
    )
    expect(engineErrorMessage(undefined)).toBe('The agent stopped with an unspecified error.')
  })
})

describe('renderToolOutput', () => {
  it('prefers the model-facing content over the structured payload', () => {
    expect(
      renderToolOutput({ content: [{ type: 'text', text: 'hello' }], structured: { a: 1 } })
    ).toBe('hello')
  })

  it('falls back to the structured payload when there is no content', () => {
    expect(renderToolOutput({ content: [], structured: { a: 1 } })).toBe('{\n  "a": 1\n}')
  })

  it('names a file rather than inlining it', () => {
    expect(renderToolOutput({ content: [{ type: 'file', uri: 'f://x', name: 'x.png' }] })).toBe(
      '[file] x.png'
    )
  })
})

describe('mapQuestions', () => {
  it('drops a malformed entry rather than the whole list', () => {
    const out = mapQuestions([
      null,
      { question: '' },
      { question: 'ok', options: [{ label: 'a' }, { notALabel: 1 }] }
    ])
    expect(out).toEqual([
      { question: 'ok', header: undefined, multiSelect: false, options: [{ label: 'a', description: undefined }] }
    ])
  })
})

/**
 * ## Mutations run, and the test each one fails
 *
 * | Mutation | Fails |
 * |---|---|
 * | `appendText` hands the raw delta instead of the cumulative text | does not swallow a chunk identical to the one before it; a block-level ended after several deltas… |
 * | reasoning mapped to kind `text` | keeps thinking and text in separate parts |
 * | `setText`'s `<=` guard removed (always set) | a block-level text.ended after the deltas adds nothing |
 * | delete the `textEnded` case | a text.ended whose deltas were lost restores the missing tail |
 * | `setText`'s `<=` → `===` | a shorter text.ended never shrinks what already streamed |
 * | drop `TOOL_ID_METADATA_KEY` from the tool part | pairs a tool call with its result by callID |
 * | `engineErrorMessage` reads only `data.message` | routes a failed tool to stderr… |
 * | permission part's tool id → the callID | emits a permission ask as a tool part… |
 * | `savable` defaults to `resources` when `save` is absent | carries an empty savable through… |
 * | `multiSelect: obj.multiple` → `obj.multiSelect` | normalises an OpenCode question… |
 * | seq comparison → unconditional assignment | tracks the highest durable seq… |
 * | `default:` in the switch throws | ignores an unknown event type instead of throwing |
 * | `settleRequest` returns `{settled}` with no message | closes a permission ask with a paired decision record |
 * | decision filed under a fresh message id | files the decision against the message the ask lives in |
 * | `questionDecisionText` → bare 'Answered.' | records an answered question with the labels the user chose |
 * | drop the `questionRejected` case | records a rejected question as an explicit non-answer |
 * | delete the `streamOwner` lookup | files a text.ended under the message its deltas built; keeps a stream id with a changed message id |
 * | `isTurnOver` → settle on any `step.ended` | ends the turn on the last step, not the first |
 * | `isTurnOver` → `finish === 'stop'` only | treats an unrecognised finish reason as the end of the turn |
 *
 * ### The survivor that mattered most
 *
 * `appendText`'s `(cumulative + delta)` → `delta` is the mutation this whole
 * class exists to prevent, and it **survived the original 19-test suite**. The
 * test it was named for streamed 'Hel' / 'lo ' / 'world', and for a plain
 * sequential stream the two conventions produce byte-identical output: the
 * accumulator's `text.startsWith(prior) ? slice(prior.length) : text` fallback
 * reconstructs the same string either way. It was found by running the
 * mutation rather than by reading, and then by probing which inputs actually
 * separate the conventions. Two do, and both are ordinary rather than exotic:
 *
 * - **a chunk identical to the one before it** — the raw convention makes
 *   `text === prior`, the accumulator skips it as a no-op, and the answer is
 *   silently one chunk short;
 * - **a block-level `text.ended` after more than one delta** — the raw
 *   convention leaves only the last delta in the part, so `ended` is not a
 *   prefix of it and the whole text is appended a second time.
 *
 * If this file is ever reorganised, those two tests are the load-bearing ones.
 * The plain sequential test is kept only because it reads as documentation,
 * and it says so at the assertion.
 */
