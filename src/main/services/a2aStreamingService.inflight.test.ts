import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'
import type { RunEvent } from '../../shared/runEvents'
import type { MessagePart } from '../../shared/messageParts'

/**
 * The direct-chat wrapper's durable record of a running turn, against a real
 * database: the in-flight marker (written at start, gone on every ending, kept
 * by the quit flush) and the draft row (one assistant row kept up to date
 * while the turn runs, replaced by the turn's real rows so nothing is saved
 * twice).
 */

const holder = vi.hoisted(() => ({ current: null as TestDatabase | null }))

vi.mock('../db/client', () => ({
  getDb: () => {
    if (!holder.current) throw new Error('test database not initialised')
    return holder.current.db
  },
  getRawSqlite: () => {
    if (!holder.current) throw new Error('test database not initialised')
    return holder.current.sqlite
  }
}))
vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('./jobService', () => ({ jobService: { reportRunCompletion: () => {} } }))

const { a2aStreamingService, DRAFT_INTERVAL_MS, DRAFT_MAX_BYTES, DRAFT_LARGE_BYTES, DRAFT_LARGE_INTERVAL_MS } = await import('./a2aStreamingService')
const { inflightTurnRepo } = await import('../db/inflightTurns')
const { chatRepo } = await import('../db/chats')
const { messageRepo } = await import('../db/messages')

type TurnResult = Awaited<ReturnType<Parameters<typeof a2aStreamingService.streamToAgent>[0]['run']>>
type Io = Parameters<Parameters<typeof a2aStreamingService.streamToAgent>[0]['run']>[0]

const USER = 'profile-1'
const AGENT = 'agent-1'
const MARKER = { profileId: USER, userMessageId: 'user-row', driver: 'acp' }

let chatId = ''

beforeEach(() => {
  holder.current = createTestDatabase()
  chatId = chatRepo.create(USER).id
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  holder.current?.close()
  holder.current = null
})

const text = (value: string): MessagePart => ({ kind: 'text', text: value })

/** The transcript, as the renderer would load it. */
function transcript(): { role: string; content: string; parts?: MessagePart[] | null }[] {
  return chatRepo.listMessages(chatId).map((row) => ({
    role: row.role,
    content: row.role === 'error' ? JSON.parse(row.content).short : row.content,
    ...(row.role === 'assistant' ? { parts: row.parts } : {})
  }))
}

/**
 * A turn that registers a snapshot of `streamed` and resolves (or rejects)
 * only when told to. The request id is what the marker is keyed by.
 */
function heldTurn(options: { marker?: typeof MARKER | undefined; register?: boolean } = { marker: MARKER }) {
  const streamed: { parts: MessagePart[]; steers: { afterPart: number; text: string }[] } = { parts: [], steers: [] }
  const posted: RunEvent[] = []
  let io!: Io
  let release!: (result: TurnResult) => void
  let fail!: (error: Error) => void
  const done = a2aStreamingService.streamToAgent({
    chatId,
    agentId: AGENT,
    port: { postMessage: (event) => void posted.push(event), close: () => {} },
    ...(options.marker ? { marker: options.marker } : {}),
    run: (turnIo) => {
      io = turnIo
      if (options.register !== false) {
        turnIo.registerSnapshot?.(() => ({ parts: streamed.parts.slice(), notices: [], steers: streamed.steers.slice() }))
      }
      return new Promise<TurnResult>((resolve, reject) => { release = resolve; fail = reject })
    }
  })
  const requestId = (posted.find((event) => event.type === 'request-id') as { requestId: string }).requestId
  return { streamed, posted, done, requestId, io: () => io, release: (r: TurnResult) => release(r), fail: (e: Error) => fail(e) }
}

describe('the in-flight marker', () => {
  it('is written when the turn starts, naming the turn', async () => {
    const turn = heldTurn()
    expect(inflightTurnRepo.get(turn.requestId)).toMatchObject({
      id: turn.requestId, profileId: USER, chatId, agentId: AGENT, driver: 'acp', userMessageId: 'user-row', draftMessageId: null
    })
    turn.release({ text: '', parts: [], notices: [] })
    await turn.done
  })

  it.each([
    ['a normal end', (t: ReturnType<typeof heldTurn>) => t.release({ text: 'hi', parts: [text('hi')], notices: [] })],
    ['a failure', (t: ReturnType<typeof heldTurn>) => t.release({ text: '', parts: [], notices: [], error: { message: 'boom', raw: 'boom' } })],
    ['a throw', (t: ReturnType<typeof heldTurn>) => t.fail(new Error('runner broke'))],
    ['a stop', (t: ReturnType<typeof heldTurn>) => {
      a2aStreamingService.cancel(t.requestId)
      t.release({ text: '', parts: [], notices: [] })
    }]
  ])('is removed on %s', async (_name, end) => {
    // Mutation: drop the delete in the wrapper's `finally` → the marker stays.
    const turn = heldTurn()
    expect(inflightTurnRepo.list()).toHaveLength(1)
    end(turn)
    await turn.done
    expect(inflightTurnRepo.list()).toEqual([])
  })

  it('is not written for a turn that asked for none', async () => {
    const turn = heldTurn({ marker: undefined })
    expect(inflightTurnRepo.list()).toEqual([])
    turn.release({ text: '', parts: [], notices: [] })
    await turn.done
  })

  it('never fails the turn when it cannot be written or removed', async () => {
    vi.spyOn(inflightTurnRepo, 'open').mockImplementation(() => { throw new Error('disk full') })
    vi.spyOn(inflightTurnRepo, 'delete').mockImplementation(() => { throw new Error('disk full') })
    const turn = heldTurn()
    turn.release({ text: 'hi', parts: [text('hi')], notices: [] })
    await turn.done
    expect(turn.posted.at(-1)).toEqual({ type: 'done', stopReason: 'end_turn' })
    expect(transcript()).toEqual([{ role: 'assistant', content: 'hi', parts: [text('hi')] }])
  })

  it('stays through the quit flush, which replaces the draft with the flushed rows', async () => {
    // Mutation: have `flush` persist without `replaceDraft` → the draft and
    // the flushed row are both in the transcript.
    const turn = heldTurn()
    turn.streamed.parts.push(text('Hello'))
    vi.advanceTimersByTime(DRAFT_INTERVAL_MS)
    const draftId = inflightTurnRepo.get(turn.requestId)!.draftMessageId
    expect(draftId).not.toBeNull()

    a2aStreamingService.saveInFlight()
    expect(transcript()).toEqual([{ role: 'assistant', content: 'Hello', parts: [text('Hello')] }])
    expect(messageRepo.getById(draftId!)).toBeUndefined()
    expect(inflightTurnRepo.get(turn.requestId)).toMatchObject({ draftMessageId: null })

    // The process lives on for a moment: a new draft holds only what is past the flush.
    turn.streamed.parts.push(text(' world'))
    vi.advanceTimersByTime(DRAFT_INTERVAL_MS)
    expect(transcript()).toEqual([
      { role: 'assistant', content: 'Hello', parts: [text('Hello')] },
      { role: 'assistant', content: ' world', parts: [text(' world')] }
    ])

    turn.release({ text: 'Hello world', parts: [text('Hello'), text(' world'), text('!')], notices: [] })
    await turn.done
    expect(transcript()).toEqual([
      { role: 'assistant', content: 'Hello', parts: [text('Hello')] },
      { role: 'assistant', content: ' world!', parts: [text(' world'), text('!')] }
    ])
    expect(inflightTurnRepo.list()).toEqual([])
  })

  it('leaves the chat’s place in the list alone at the quit flush and for a turn that asks so, and only there', async () => {
    const pastSeconds = 1000
    const past = new Date(pastSeconds * 1000)
    const setPast = (): void => void holder.current!.raw.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(pastSeconds, chatId)
    const updatedAt = (): Date => chatRepo.getOwned(USER, chatId)!.updatedAt

    setPast()
    const turn = heldTurn()
    turn.streamed.parts.push(text('Hello'))
    // Mutation: flush at quit with the default touch → the chat moves up.
    a2aStreamingService.saveInFlight()
    expect(transcript()).toEqual([{ role: 'assistant', content: 'Hello', parts: [text('Hello')] }])
    expect(updatedAt()).toEqual(past)
    turn.release({ text: 'Hello', parts: [text('Hello'), text('!')], notices: [] })
    await turn.done
    // A live turn's own end still moves it.
    expect(updatedAt()).not.toEqual(past)

    setPast()
    await a2aStreamingService.streamToAgent({
      chatId, agentId: AGENT, touchChat: false,
      port: { postMessage: () => {}, close: () => {} },
      run: async () => ({ text: 'Again', parts: [text('Again')], notices: [] })
    })
    expect(transcript().at(-1)).toEqual({ role: 'assistant', content: 'Again', parts: [text('Again')] })
    expect(updatedAt()).toEqual(past)
  })
})

describe('the draft row', () => {
  it('is inserted, then rewritten in place, and only when the turn changed', async () => {
    const turn = heldTurn()
    vi.advanceTimersByTime(DRAFT_INTERVAL_MS)
    expect(transcript()).toEqual([])

    turn.streamed.parts.push(text('Hel'))
    vi.advanceTimersByTime(DRAFT_INTERVAL_MS)
    const draftId = inflightTurnRepo.get(turn.requestId)!.draftMessageId!
    expect(messageRepo.getById(draftId)).toMatchObject({ role: 'assistant', content: 'Hel', parts: [text('Hel')], sourceAgentId: AGENT })

    const update = vi.spyOn(messageRepo, 'updateAssistantParts')
    vi.advanceTimersByTime(DRAFT_INTERVAL_MS)
    expect(update).not.toHaveBeenCalled()

    turn.streamed.parts = [text('Hello'), { kind: 'tool', toolName: 'Read', text: 'r' } as MessagePart]
    vi.advanceTimersByTime(DRAFT_INTERVAL_MS)
    expect(update).toHaveBeenCalledTimes(1)
    expect(chatRepo.listMessageIds(chatId)).toEqual([draftId])
    expect(messageRepo.getById(draftId)).toMatchObject({ content: 'Hello', parts: turn.streamed.parts })

    turn.release({ text: 'Hello', parts: turn.streamed.parts, notices: [] })
    await turn.done
  })

  it('is replaced by the real rows, with notices first and steers still splitting the parts', async () => {
    // Mutation: persist the final rows without `replaceDraft` → the draft
    // stays above them and the answer shows twice.
    const turn = heldTurn()
    turn.streamed.parts.push(text('Before'), text('After'))
    turn.streamed.steers.push({ afterPart: 1, text: 'and also' })
    vi.advanceTimersByTime(DRAFT_INTERVAL_MS)
    // Only parts: the steer is not written mid-turn.
    expect(transcript()).toEqual([{ role: 'assistant', content: 'BeforeAfter', parts: [text('Before'), text('After')] }])

    turn.release({
      text: 'BeforeAfter',
      parts: [text('Before'), text('After')],
      notices: [{ partKey: 'n', text: 'Starting up' }],
      steers: [{ afterPart: 1, text: 'and also' }]
    })
    await turn.done
    expect(transcript()).toEqual([
      { role: 'agent_transition', content: 'Starting up' },
      { role: 'assistant', content: 'Before', parts: [text('Before')] },
      { role: 'user', content: 'and also' },
      { role: 'assistant', content: 'After', parts: [text('After')] }
    ])
    // The timer is gone with the turn.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('is replaced ahead of the error row when the turn fails', async () => {
    const turn = heldTurn()
    turn.streamed.parts.push(text('partial'))
    vi.advanceTimersByTime(DRAFT_INTERVAL_MS)
    turn.release({ text: 'partial', parts: [text('partial')], notices: [], error: { message: 'boom', raw: 'boom' } })
    await turn.done
    expect(transcript()).toEqual([
      { role: 'assistant', content: 'partial', parts: [text('partial')] },
      { role: 'error', content: 'boom' }
    ])
  })

  it('is replaced by what the runner offered when it throws', async () => {
    const turn = heldTurn()
    turn.streamed.parts.push(text('partial'))
    vi.advanceTimersByTime(DRAFT_INTERVAL_MS)
    turn.streamed.parts.push(text(' more'))
    turn.fail(new Error('runner broke'))
    await turn.done
    expect(transcript()).toEqual([
      { role: 'assistant', content: 'partial more', parts: [text('partial'), text(' more')] },
      { role: 'error', content: 'runner broke' }
    ])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('is written at once when the turn parks on a question', async () => {
    // Mutation: drop the `needs_input` hook → nothing until the next tick.
    const turn = heldTurn()
    turn.streamed.parts.push(text('Which branch?'))
    turn.io().onEvent({
      type: 'needs_input', requestId: 't-1', resume: 'next_message',
      request: { kind: 'question', questions: [{ question: 'Which branch?', multiSelect: false, options: [] }] }
    })
    expect(transcript()).toEqual([{ role: 'assistant', content: 'Which branch?', parts: [text('Which branch?')] }])
    expect(turn.posted.some((event) => event.type === 'needs_input')).toBe(true)
    turn.release({ text: 'Which branch?', parts: [text('Which branch?')], notices: [], taskState: 'input-required' })
    await turn.done
    expect(transcript()).toEqual([{ role: 'assistant', content: 'Which branch?', parts: [text('Which branch?')] }])
  })

  it('is not kept for a turn with no marker, nor for one that registered no snapshot', async () => {
    // Mutation: start the draft timer and the park hook without a marker → the unmarked turn writes a draft.
    const unmarked = heldTurn({ marker: undefined })
    unmarked.streamed.parts.push(text('kept'))
    const command = heldTurn({ marker: MARKER, register: false })
    vi.advanceTimersByTime(DRAFT_INTERVAL_MS)
    unmarked.io().onEvent({
      type: 'needs_input', requestId: 't-1', resume: 'next_message',
      request: { kind: 'question', questions: [{ question: 'Which?', multiSelect: false, options: [] }] }
    })
    expect(transcript()).toEqual([])
    expect(inflightTurnRepo.get(command.requestId)).toMatchObject({ draftMessageId: null })
    unmarked.release({ text: 'kept', parts: [text('kept')], notices: [] })
    command.release({ text: 'ran', parts: [text('ran')], notices: [] })
    await Promise.all([unmarked.done, command.done])
    expect(transcript()).toEqual([
      { role: 'assistant', content: 'kept', parts: [text('kept')] },
      { role: 'assistant', content: 'ran', parts: [text('ran')] }
    ])
  })

  it('is rewritten when a tool part changes in place', async () => {
    // Mutation: drop the tool term from the fingerprint → the in-place change is never written.
    const turn = heldTurn()
    const tool: MessagePart = { kind: 'tool', text: '', toolName: 'Write', toolId: 'w1', toolInput: { path: 'a' } }
    turn.streamed.parts.push(tool)
    vi.advanceTimersByTime(DRAFT_INTERVAL_MS)
    const draftId = inflightTurnRepo.get(turn.requestId)!.draftMessageId!
    tool.toolInput = { path: 'a', content: 'the whole file' }
    vi.advanceTimersByTime(DRAFT_INTERVAL_MS)
    expect(messageRepo.getById(draftId)!.parts).toEqual([{ ...tool, toolInput: { path: 'a', content: 'the whole file' } }])
    tool.toolStream = 'stderr'
    vi.advanceTimersByTime(DRAFT_INTERVAL_MS)
    expect(messageRepo.getById(draftId)!.parts).toEqual([expect.objectContaining({ toolStream: 'stderr' })])
    turn.release({ text: '', parts: [tool], notices: [] })
    await turn.done
  })

  it('does not measure a small draft by serializing it', async () => {
    const turn = heldTurn()
    turn.streamed.parts.push(text('small'), { kind: 'tool', text: '', toolName: 'Read', toolInput: { path: 'a' } })
    const measure = vi.spyOn(Buffer, 'byteLength')
    vi.advanceTimersByTime(DRAFT_INTERVAL_MS)
    expect(measure).not.toHaveBeenCalled()
    expect(transcript()).toHaveLength(1)
    measure.mockRestore()
    turn.release({ text: 'small', parts: turn.streamed.parts, notices: [] })
    await turn.done
  })

  it('rewrites a large draft at most every large interval, except when the turn parks', async () => {
    // Mutation: drop the large-draft back-off → the second tick rewrites it.
    const turn = heldTurn()
    turn.streamed.parts.push(text('x'.repeat(DRAFT_LARGE_BYTES + 1)))
    vi.advanceTimersByTime(DRAFT_INTERVAL_MS)
    const draftId = inflightTurnRepo.get(turn.requestId)!.draftMessageId!
    const update = vi.spyOn(messageRepo, 'updateAssistantParts')

    turn.streamed.parts.push(text('more'))
    vi.advanceTimersByTime(DRAFT_INTERVAL_MS)
    expect(update).not.toHaveBeenCalled()
    vi.advanceTimersByTime(DRAFT_LARGE_INTERVAL_MS - DRAFT_INTERVAL_MS)
    expect(update).toHaveBeenCalledTimes(1)
    expect(messageRepo.getById(draftId)!.parts).toHaveLength(2)

    turn.streamed.parts.push(text('Which?'))
    turn.io().onEvent({
      type: 'needs_input', requestId: 't-1', resume: 'next_message',
      request: { kind: 'question', questions: [{ question: 'Which?', multiSelect: false, options: [] }] }
    })
    expect(update).toHaveBeenCalledTimes(2)
    expect(messageRepo.getById(draftId)!.parts).toHaveLength(3)
    turn.release({ text: '', parts: turn.streamed.parts, notices: [] })
    await turn.done
  })

  it('is skipped when too large, and a write that throws does not fail the turn', async () => {
    const turn = heldTurn()
    turn.streamed.parts.push(text('x'.repeat(DRAFT_MAX_BYTES + 1)))
    vi.advanceTimersByTime(DRAFT_INTERVAL_MS)
    expect(transcript()).toEqual([])

    turn.streamed.parts = [text('small')]
    const write = vi.spyOn(inflightTurnRepo, 'writeDraft').mockImplementation(() => { throw new Error('locked') })
    vi.advanceTimersByTime(DRAFT_INTERVAL_MS)
    expect(write).toHaveBeenCalled()
    turn.release({ text: 'small', parts: [text('small')], notices: [] })
    await turn.done
    expect(turn.posted.at(-1)).toEqual({ type: 'done', stopReason: 'end_turn' })
    expect(transcript()).toEqual([{ role: 'assistant', content: 'small', parts: [text('small')] }])
  })
})
