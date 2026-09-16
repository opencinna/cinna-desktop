import Anthropic from '@anthropic-ai/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RunEvent } from '../../../../shared/runEvents'
import type { RequestResolution } from '../../../../shared/localAgentRequests'
import { pendingRequests } from '../pendingRequests'
import { claimReplyAnswer } from '../../../services/replyAnswerClaims'
import { followManagedSession, runManagedSession, type ManagedRunBinding, type ManagedRunResult } from './managedRun'
import { managedPeer, deferred, user, message, idle, permissionTool, requires, interrupted, running, exhausted, SESSION, STAMP, KEY,
  type ManagedPeer, type PeerOptions } from './testSupport/managedPeer'

vi.mock('../../../logger/logger', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }))
const peers: ManagedPeer[] = []
const runs: { controller: AbortController; result: Promise<ManagedRunResult> }[] = []
async function peer(options: PeerOptions = {}) { const p = await managedPeer(options); peers.push(p); return p }
function start(p: ManagedPeer, patch: Partial<ManagedRunBinding> = {}, preaborted = false,
  registerSnapshot?: Parameters<typeof runManagedSession>[2]['registerSnapshot']) {
  const controller = new AbortController()
  if (preaborted) controller.abort()
  const events: RunEvent[] = []
  const binding: ManagedRunBinding = {
    client: new Anthropic({ apiKey: KEY, baseURL: p.origin, maxRetries: 0 }),
    config: { credentialId: 'credential-peer', agentId: 'managed-agent-peer', environmentId: 'environment-peer', workspaceId: 'workspace-peer', version: 1 },
    checkpoint: null, validate: vi.fn(), save: vi.fn(), ...patch
  }
  const result = runManagedSession(binding, 'local-agent-peer', {
    chatId: 'chat-peer', wireContent: 'Complete the fixture goal.', messageId: 'user-row', signal: controller.signal,
    onEvent: event => events.push(event),
    ...(registerSnapshot ? { registerSnapshot } : {})
  }, { registerRequest: pendingRequests.register, requestTimeoutMs: 500, stopTimeoutMs: 80 })
  const finished = vi.fn()
  void result.then(finished)
  runs.push({ controller, result })
  return { controller, events, binding, result, finished }
}
/** Follow the turn kicked off by `kickoff` on the peer's session, as relaunch recovery does. */
function follow(p: ManagedPeer, kickoff = 'kickoff') {
  const controller = new AbortController()
  const events: RunEvent[] = []
  const binding: ManagedRunBinding = {
    client: new Anthropic({ apiKey: KEY, baseURL: p.origin, maxRetries: 0 }),
    config: { credentialId: 'credential-peer', agentId: 'managed-agent-peer', environmentId: 'environment-peer', workspaceId: 'workspace-peer', version: 1 },
    checkpoint: { sessionId: SESSION, state: 'inflight', kickoffEventId: kickoff }, validate: vi.fn(), save: vi.fn()
  }
  const result = followManagedSession(binding, 'local-agent-peer', {
    chatId: 'chat-peer', signal: controller.signal, onEvent: event => events.push(event)
  }, { registerRequest: pendingRequests.register, requestTimeoutMs: 500, stopTimeoutMs: 80 },
  { sessionId: SESSION, kickoffEventId: kickoff })
  runs.push({ controller, result })
  return { controller, events, binding, result }
}
const posts = (p: ManagedPeer) => p.requests.filter(r => r.method === 'POST')
function answer(requestId: string, resolution: RequestResolution, commit = vi.fn()) {
  const registration = pendingRequests.registration(requestId)!
  const owner = pendingRequests.owner(requestId)!
  return claimReplyAnswer({ registration, ask: { requestId, ...owner }, resolution, validate() {}, commit })
}
async function ready(p: ManagedPeer) { await vi.waitFor(() => expect(p.sends('user.message')).toHaveLength(1)) }
afterEach(async () => {
  for (const run of runs) run.controller.abort()
  await Promise.allSettled(runs.splice(0).map(run => run.result))
  pendingRequests.clear()
  await Promise.all(peers.splice(0).map(p => p.close()))
})

describe('Managed run through the official SDK and actual HTTP/SSE', () => {
  it.each(['inflight', 'uncertain', 'budget'] as const)('recovers a %s checkpoint once remote history is idle', async (state) => {
    const p = await peer({ pages: [[user('old'), idle('old-end')]] })
    const run = start(p, { checkpoint: { sessionId: SESSION, state } })
    await ready(p)
    p.send(user(), message('new-answer', 'Recovered.'), idle('new-end'))
    await expect(run.result).resolves.toMatchObject({ text: 'Recovered.', taskState: 'completed' })
    expect(run.binding.save).toHaveBeenLastCalledWith({ sessionId: SESSION, state: 'ready' })
  })

  it('refuses recovery while remote history still has pending input', async () => {
    const p = await peer({ pages: [[user('unprocessed', false)]] })
    const run = start(p, { checkpoint: { sessionId: SESSION, state: 'inflight' } })
    await expect(run.result).resolves.toMatchObject({ error: { message: expect.stringContaining('still queued') } })
    expect(p.sends('user.message')).toHaveLength(0)
  })

  it('attaches before all history pages and buffers processed kickoff before its queued HTTP acknowledgment', async () => {
    const ack = deferred<unknown>()
    const p = await peer({ pages: [[message('old-answer', 'Old history must not appear.'), permissionTool('old-tool'),
      requires(['old-tool'])], [{ type: 'user.tool_confirmation', id: 'old-confirm', processed_at: STAMP,
      tool_use_id: 'old-tool', result: 'allow' }, idle('old-idle')]],
      onSend(event, remote) {
        if (event.type === 'user.message') {
          remote.send(user('old-other'), idle('old-overlap'), user('kickoff', false), user(), message('answer', 'Fresh answer.'),
            user('kickoff', false), message('answer', 'Fresh answer.'), idle('finished'))
          return ack.promise
        }
        return undefined
      } })
    const run = start(p, { checkpoint: { sessionId: SESSION, state: 'ready' } })
    await ready(p)
    expect(p.requests.map(r => [r.method, r.path, r.page])).toEqual([
      ['GET', `/v1/sessions/${SESSION}`, null], ['GET', `/v1/sessions/${SESSION}/events/stream`, null],
      ['GET', `/v1/sessions/${SESSION}/events`, null], ['GET', `/v1/sessions/${SESSION}/events`, 'page-two'],
      ['POST', `/v1/sessions/${SESSION}/events`, null]
    ])
    expect(run.finished).not.toHaveBeenCalled()
    expect(run.events.filter(e => e.type === 'delta')).toHaveLength(0)
    ack.resolve({ data: [user('kickoff', false)] })
    await expect(run.result).resolves.toMatchObject({ text: 'Fresh answer.', taskState: 'completed', stopReason: 'end_turn' })
    expect(run.events.filter(e => e.type === 'needs_input')).toHaveLength(0)
    expect(run.events.filter(e => e.type === 'delta' && e.kind === 'text')).toEqual([expect.objectContaining({ text: 'Fresh answer.' })])
    expect(p.sends('user.message')).toHaveLength(1)
    expect(p.sends('user.message')[0].body).toEqual({ events: [{ type: 'user.message', content: [{ type: 'text', text: 'Complete the fixture goal.' }] }] })
    for (const request of p.requests) { expect(request.key).toBe(KEY); expect(request.workspace).toBe('workspace-peer') }
  })

  it('accepts a processed kickoff returned only in the HTTP acknowledgment', async () => {
    const p = await peer({ onSend(event, remote) { if (event.type === 'user.message') {
      remote.persist(user())
      remote.send(message('final', 'The acknowledged turn finished.'), idle('end'))
      return { data: [user()] }
    } return undefined } })
    const run = start(p)
    await vi.waitFor(() => expect(run.finished).toHaveBeenCalled(), { timeout: 1_000 })
    await expect(run.result).resolves.toMatchObject({ text: 'The acknowledged turn finished.', stopReason: 'end_turn' })
    expect(p.sends('user.message')).toHaveLength(1)
  })

  it('offers what it streamed to the quit flush, the same parts the result returns', async () => {
    // Mutation: drop `registerSnapshot` in `runManagedSession` → no snapshot.
    const p = await peer({ onSend(event, remote) { if (event.type === 'user.message') {
      remote.persist(user())
      remote.send(message('final', 'Streamed before the quit.'), idle('end'))
      return { data: [user()] }
    } return undefined } })
    let read: (() => { parts: unknown[] }) | undefined
    const run = start(p, {}, false, (snapshot) => { read = snapshot })
    expect(read).toBeDefined()
    const result = await run.result
    expect(read!().parts).toEqual(result.parts)
    expect(result.parts).toEqual([expect.objectContaining({ kind: 'text', text: 'Streamed before the quit.' })])
  })

  it('does not kick off when page two of baseline history fails', async () => {
    const p = await peer({ pages: [[idle('baseline-idle')], []], onHistory(page, res) {
      if (page === 1) { res.writeHead(503); res.end('history unavailable'); return true }
      return undefined
    } })
    const run = start(p)
    await expect(run.result).resolves.toMatchObject({ error: { message: expect.stringContaining('503') } })
    expect(p.sends('user.message')).toHaveLength(0)
    expect(p.requests.filter(r => r.page === 'page-two')).toHaveLength(1)
  })

  it('registers two permission barriers, preserves cross-thread denial, and cannot finish before remote acceptance and local retry commit', async () => {
    const acceptFirst = deferred<unknown>()
    const p = await peer({ onSend(event) {
      if (event.type === 'user.tool_confirmation' && event.tool_use_id === 'tool-one') return acceptFirst.promise
      return undefined
    } })
    const run = start(p)
    await ready(p)
    p.send(user(), permissionTool('tool-one'), permissionTool('tool-two', 'sthr_child'), requires(['tool-one', 'tool-two']))
    await vi.waitFor(() => expect(pendingRequests.listForChat('chat-peer')).toHaveLength(2))
    const asks = pendingRequests.listForChat('chat-peer')
    const first = asks.find(row => pendingRequests.owner(row.requestId)?.request?.callId === 'tool-one')!
    const second = asks.find(row => pendingRequests.owner(row.requestId)?.request?.callId === 'tool-two')!
    const commit = vi.fn().mockImplementationOnce(() => { throw new Error('Local answer transaction failed') })
    const allow = answer(first.requestId, { kind: 'permission', reply: 'always' }, commit)
    await expect(answer(second.requestId, { kind: 'permission', reply: 'reject' })).resolves.toEqual({ ok: true })
    await vi.waitFor(() => expect(p.sends('user.tool_confirmation')).toHaveLength(2))
    p.send(message('after-permission', 'Both decisions reached the agent.'), idle('end'))
    expect(commit).not.toHaveBeenCalled()
    expect(run.finished).not.toHaveBeenCalled()
    expect(pendingRequests.listForChat('chat-peer')).toHaveLength(1)
    acceptFirst.resolve({ data: [{ type: 'user.tool_confirmation', id: 'accepted-one', tool_use_id: 'tool-one', result: 'allow', processed_at: null }] })
    await expect(allow).resolves.toMatchObject({ ok: false, code: 'unavailable' })
    expect(run.finished).not.toHaveBeenCalled()
    await expect(answer(first.requestId, { kind: 'permission', reply: 'always' }, commit)).resolves.toEqual({ ok: true, remembered: false })
    await expect(run.result).resolves.toMatchObject({ text: 'Both decisions reached the agent.', stopReason: 'end_turn' })
    expect(commit).toHaveBeenLastCalledWith({ kind: 'permission', reply: 'once', remembered: false })
    expect(p.sends('user.tool_confirmation').map(r => r.body)).toEqual([
      { events: [{ type: 'user.tool_confirmation', result: 'allow', tool_use_id: 'tool-one' }] },
      { events: [{ type: 'user.tool_confirmation', result: 'deny', tool_use_id: 'tool-two', session_thread_id: 'sthr_child' }] }
    ])
    expect(run.events.filter(e => e.type === 'input_resolved')).toHaveLength(2)
  })

  it('keeps a lost confirmation uncertain without automatically retrying its POST', async () => {
    const p = await peer({ onSend(event, _remote, res) { if (event.type === 'user.tool_confirmation') res.destroy() } })
    const run = start(p)
    await ready(p)
    p.send(user(), permissionTool('tool-uncertain'), requires(['tool-uncertain']))
    await vi.waitFor(() => expect(pendingRequests.listForChat('chat-peer')).toHaveLength(1))
    const id = pendingRequests.listForChat('chat-peer')[0].requestId
    const commit = vi.fn()
    await expect(answer(id, { kind: 'permission', reply: 'once' }, commit)).resolves.toMatchObject({ ok: false, code: 'uncertain' })
    await expect(answer(id, { kind: 'permission', reply: 'once' }, commit)).resolves.toMatchObject({ ok: false, code: 'uncertain' })
    expect(commit).not.toHaveBeenCalled()
    expect(p.sends('user.tool_confirmation')).toHaveLength(1)
    expect(run.finished).not.toHaveBeenCalled()
    run.controller.abort()
    await expect(run.result).resolves.toMatchObject({ taskState: 'canceled', stopReason: 'canceled' })
  })

  it('ignores child idle and retains the session budget pause without another kickoff on reuse', async () => {
    const p = await peer()
    const run = start(p)
    await ready(p)
    p.send(user(), message('partial', 'Before budget.'), { type: 'session.thread_status_idle', id: 'child-idle', processed_at: STAMP,
      agent_name: 'child', session_thread_id: 'sthr_child', stop_reason: { type: 'end_turn' } })
    await vi.waitFor(() => expect(run.events.some(e => e.type === 'delta' && e.text === 'Before budget.')).toBe(true))
    expect(run.finished).not.toHaveBeenCalled()
    p.send(idle('budget', 'budget_reached'))
    await expect(run.result).resolves.toMatchObject({ text: 'Before budget.', stopReason: 'budget' })
    expect(run.binding.save).toHaveBeenLastCalledWith({ sessionId: SESSION, state: 'budget' })
    await expect(start(p, { checkpoint: { sessionId: SESSION, state: 'budget' } }).result)
      .resolves.toMatchObject({ error: { message: expect.stringContaining('remote budget') } })
    expect(p.sends('user.message')).toHaveLength(1)
  })

  it.each(['stream processed', 'HTTP processed', 'budget pause'] as const)('confirms one interrupt from %s plus relevant session idle', async (mode) => {
    const p = await peer({ onSend(event, remote) { if (event.type === 'user.interrupt') {
      if (mode !== 'HTTP processed') remote.send(idle('too-early'), interrupted(false), interrupted(true), idle('stopped', mode === 'budget pause' ? 'budget_reached' : 'end_turn'))
      else { remote.persist(interrupted(true)); remote.send(idle('stopped')) }
      return { data: [interrupted(mode === 'HTTP processed')] }
    } return undefined } })
    const run = start(p)
    await ready(p)
    p.send(user(), message('partial', 'Keep this partial answer.'))
    await vi.waitFor(() => expect(run.events.some(e => e.type === 'delta' && e.text === 'Keep this partial answer.')).toBe(true))
    run.controller.abort()
    await expect(run.result).resolves.toMatchObject({ taskState: 'canceled', stopReason: 'canceled', text: 'Keep this partial answer.', notices: [] })
    expect(p.sends('user.interrupt')).toHaveLength(1)
    expect(p.sends('user.interrupt')[0].body).toEqual({ events: [{ type: 'user.interrupt' }] })
    expect(run.binding.save).toHaveBeenLastCalledWith({ sessionId: SESSION, state: mode === 'budget pause' ? 'budget' : 'ready' })
  })

  it('bounds an unconfirmed Stop while the official stream stays silent', async () => {
    const p = await peer()
    const run = start(p)
    await ready(p)
    p.send(user(), message('partial', 'Partial retained.'))
    await vi.waitFor(() => expect(run.events.some(e => e.type === 'delta' && e.text === 'Partial retained.')).toBe(true))
    const started = Date.now()
    run.controller.abort()
    await expect(run.result).resolves.toMatchObject({ taskState: 'canceled', text: 'Partial retained.', notices: [
      { text: expect.stringContaining('remote stop was not confirmed') }
    ] })
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(p.sends('user.interrupt')).toHaveLength(1)
    expect(run.binding.save).toHaveBeenLastCalledWith({ sessionId: SESSION, state: 'uncertain' })
  })

  it.each(['inflight', 'uncertain', 'budget'] as const)('preserves a %s checkpoint when canceled before admission', async (state) => {
    const p = await peer()
    const run = start(p, { checkpoint: { sessionId: SESSION, state } }, true)
    await expect(run.result).resolves.toMatchObject({ taskState: 'canceled', stopReason: 'canceled' })
    expect(p.requests).toHaveLength(0)
    expect(run.binding.save).not.toHaveBeenCalled()
    expect(run.binding.checkpoint).toEqual({ sessionId: SESSION, state })
  })

  it('performs zero HTTP when the captured binding has changed before setup', async () => {
    const p = await peer()
    await expect(start(p, { validate() { throw new Error('Captured profile changed') } }).result)
      .resolves.toMatchObject({ error: { message: 'Captured profile changed' } })
    expect(p.requests).toHaveLength(0)
  })
})

describe('Managed turn start: the saved kickoff and the refusal causes', () => {
  it('saves the acknowledged kickoff id with inflight once the send is acknowledged, never before', async () => {
    // Mutation: drop `save('inflight', kickoffId)` in `begin` → no kickoff is ever saved.
    let atSend: unknown[][] = []
    const p = await peer({ onSend(event, remote) {
      if (event.type === 'user.message') {
        atSend = run.binding.save.mock.calls.map(call => [...call])
        remote.persist(user())
        remote.send(message('answer', 'Done.'), idle('end'))
      }
      return undefined
    } })
    const run = start(p) as ReturnType<typeof start> & { binding: { save: ReturnType<typeof vi.fn> } }
    await expect(run.result).resolves.toMatchObject({ text: 'Done.', stopReason: 'end_turn' })
    expect(atSend).toEqual([[{ sessionId: SESSION, state: 'ready' }], [{ sessionId: SESSION, state: 'inflight' }]])
    expect(run.binding.save.mock.calls.map(call => call[0])).toEqual([
      { sessionId: SESSION, state: 'ready' },
      { sessionId: SESSION, state: 'inflight' },
      { sessionId: SESSION, state: 'inflight', kickoffEventId: 'kickoff', kickoffMessageId: 'user-row' },
      { sessionId: SESSION, state: 'ready' }
    ])
  })

  it('drops an earlier turn’s kickoff before any request, keeping the saved state', async () => {
    // Mutation: drop the kickoff-clearing save at the top of `begin` → the first save follows the requests.
    const p = await peer({ status: () => 'running' })
    const requestsAtSave: number[] = []
    const run = start(p, { checkpoint: { sessionId: SESSION, state: 'inflight', kickoffEventId: 'old-kickoff', kickoffMessageId: 'old-row' },
      save: vi.fn(() => { requestsAtSave.push(p.requests.length) }) })
    // Admission is unchanged: a running session still refuses the message.
    await expect(run.result).resolves.toMatchObject({ error: { message: expect.stringContaining('still working') } })
    expect((run.binding.save as ReturnType<typeof vi.fn>).mock.calls.map(call => call[0])).toEqual([{ sessionId: SESSION, state: 'inflight' }])
    expect(requestsAtSave).toEqual([0])
    expect(p.sends('user.message')).toHaveLength(0)
  })

  it('keeps a running turn going when its kickoff cannot be saved', async () => {
    // Mutation: drop the try/catch around `save('inflight', kickoff)` → the turn fails and interrupts the session.
    const p = await peer({ onSend(event, remote) { if (event.type === 'user.message') {
      remote.persist(user())
      remote.send(message('answer', 'Still done.'), idle('end'))
      return { data: [user()] }
    } return undefined } })
    const run = start(p, { save: vi.fn((checkpoint: { kickoffEventId?: string | null }) => {
      if (checkpoint.kickoffEventId) throw new Error('database is locked')
    }) })
    await expect(run.result).resolves.toMatchObject({ text: 'Still done.', stopReason: 'end_turn' })
    expect(p.sends('user.interrupt')).toHaveLength(0)
  })

  it.each([
    ['the session reports it is running', { status: () => 'running' as const, pages: [[user('old'), idle('old-end')]] }, 'still working on an earlier message'],
    ['history ends running', { pages: [[user('old'), running('old-run')]] }, 'still working on an earlier message'],
    ['an earlier message is queued', { pages: [[user('old'), idle('old-end'), user('queued', false)]] }, 'still queued'],
    ['a permission is pending', { pages: [[user('old'), permissionTool('old-tool'), requires(['old-tool'])]] }, 'waiting for a permission decision']
  ])('refuses, naming the cause, when %s', async (_name, options: PeerOptions, cause) => {
    const p = await peer(options)
    const run = start(p, { checkpoint: { sessionId: SESSION, state: 'inflight' } })
    const result = await run.result
    expect(result.error?.message).toContain(cause)
    expect(result.error?.message).toContain('in Claude')
    expect(p.sends('user.message')).toHaveLength(0)
    expect(run.binding.save).not.toHaveBeenCalled()
  })

  it('takes a new message after a turn that exhausted its retries', async () => {
    // The SDK: "This turn is dead; queued inputs are flushed … Client may send a new prompt."
    const p = await peer({ pages: [[user('old'), exhausted('old-exhausted')]] })
    const run = start(p, { checkpoint: { sessionId: SESSION, state: 'uncertain' } })
    await ready(p)
    p.send(user(), message('answer', 'Fresh start.'), idle('end'))
    await expect(run.result).resolves.toMatchObject({ text: 'Fresh start.', stopReason: 'end_turn' })
    expect(p.sends('user.message')).toHaveLength(1)
  })

  it('takes a new message when an input queued before the exhausted turn was never processed', async () => {
    // Mutation: drop the queue clear on `retries_exhausted` → "still queued".
    const p = await peer({ pages: [[user('old'), user('flushed', false), exhausted('old-exhausted')]] })
    const run = start(p, { checkpoint: { sessionId: SESSION, state: 'uncertain' } })
    await ready(p)
    p.send(user(), message('answer', 'Fresh start.'), idle('end'))
    await expect(run.result).resolves.toMatchObject({ text: 'Fresh start.', stopReason: 'end_turn' })
  })

  it('still refuses an input queued after the exhausted turn', async () => {
    const p = await peer({ pages: [[user('old'), exhausted('old-exhausted'), user('queued', false)]] })
    const run = start(p, { checkpoint: { sessionId: SESSION, state: 'uncertain' } })
    await expect(run.result).resolves.toMatchObject({ error: { message: expect.stringContaining('still queued') } })
    expect(p.sends('user.message')).toHaveLength(0)
  })
})

describe('Following a turn already on the session (relaunch recovery)', () => {
  it('streams a still-running turn to its end, from its kickoff only, and sends nothing', async () => {
    const p = await peer({ pages: [[user('old'), message('old-answer', 'An earlier turn.'), idle('old-end'),
      user(), running('run'), message('part-one', 'Part one.')]] })
    const run = follow(p)
    await vi.waitFor(() => expect(run.events.some(e => e.type === 'delta' && e.text === 'Part one.')).toBe(true))
    p.send(message('part-two', 'Part two.'), idle('end'))
    await expect(run.result).resolves.toMatchObject({ text: 'Part one.\n\nPart two.', taskState: 'completed', stopReason: 'end_turn' })
    expect(run.events.filter(e => e.type === 'delta').map(e => e.type === 'delta' && e.text)).toEqual(['Part one.', '\n\nPart two.'])
    expect(posts(p)).toHaveLength(0)
    expect(run.binding.save).toHaveBeenLastCalledWith({ sessionId: SESSION, state: 'ready' })
  })

  it('returns at once with a turn that ended while the app was closed', async () => {
    const p = await peer({ pages: [[user(), running('run'), message('final', 'The final answer.'), idle('end')]] })
    const run = follow(p)
    await expect(run.result).resolves.toMatchObject({ text: 'The final answer.', stopReason: 'end_turn' })
    expect(posts(p)).toHaveLength(0)
    expect(p.requests.some(r => r.path === `/v1/sessions/${SESSION}` || r.path === '/v1/sessions')).toBe(false)
  })

  it('offers a parked permission again, delivers the answer, then completes', async () => {
    const p = await peer({ pages: [[user(), permissionTool('tool-parked'), requires(['tool-parked'])]] })
    const run = follow(p)
    await vi.waitFor(() => expect(pendingRequests.listForChat('chat-peer')).toHaveLength(1))
    const { requestId } = pendingRequests.listForChat('chat-peer')[0]
    expect(run.events).toContainEqual(expect.objectContaining({ type: 'needs_input', requestId, resume: 'reply',
      request: expect.objectContaining({ kind: 'permission', callId: 'tool-parked' }) }))
    await expect(answer(requestId, { kind: 'permission', reply: 'once' })).resolves.toEqual({ ok: true })
    expect(p.sends('user.tool_confirmation').map(r => r.body)).toEqual([
      { events: [{ type: 'user.tool_confirmation', result: 'allow', tool_use_id: 'tool-parked' }] }
    ])
    p.send(message('after', 'Ran it.'), idle('end'))
    await expect(run.result).resolves.toMatchObject({ text: 'Ran it.', stopReason: 'end_turn' })
    expect(run.events.filter(e => e.type === 'input_resolved')).toHaveLength(1)
    expect(p.sends('user.message')).toHaveLength(0)
  })

  it('does not offer again a permission whose answer was queued before the kill', async () => {
    const confirmation = (processed: boolean) => ({ type: 'user.tool_confirmation' as const, id: 'confirm-before-kill',
      tool_use_id: 'tool-answered', result: 'allow' as const, processed_at: processed ? STAMP : null })
    const p = await peer({ pages: [[user(), permissionTool('tool-answered'), requires(['tool-answered']), confirmation(false)]] })
    const run = follow(p)
    await vi.waitFor(() => expect(p.requests.filter(r => r.path.endsWith('/events/stream'))).toHaveLength(1))
    p.send(confirmation(true), message('after', 'Answered before the kill.'), idle('end'))
    await expect(run.result).resolves.toMatchObject({ text: 'Answered before the kill.', stopReason: 'end_turn' })
    expect(run.events.filter(e => e.type === 'needs_input')).toHaveLength(0)
    expect(posts(p)).toHaveLength(0)
  })

  it('interrupts the session on Stop and ends canceled with what it streamed', async () => {
    const p = await peer({ pages: [[user(), running('run'), message('partial', 'Partial.')]],
      onSend(event, remote) { if (event.type === 'user.interrupt') {
        remote.send(interrupted(true), idle('stopped'))
        return { data: [interrupted(false)] }
      } return undefined } })
    const run = follow(p)
    await vi.waitFor(() => expect(run.events.some(e => e.type === 'delta' && e.text === 'Partial.')).toBe(true))
    run.controller.abort()
    await expect(run.result).resolves.toMatchObject({ taskState: 'canceled', stopReason: 'canceled', text: 'Partial.', notices: [] })
    expect(p.sends('user.interrupt')).toHaveLength(1)
    expect(p.sends('user.message')).toHaveLength(0)
    expect(run.binding.save).toHaveBeenLastCalledWith({ sessionId: SESSION, state: 'ready' })
  })

  it.each([
    ['its stream keeps closing', { onStream: (res: import('node:http').ServerResponse) => { res.end(); return true } }, 'network'],
    ['its history answers 503', { onHistory: (_page: number, res: import('node:http').ServerResponse) => { res.writeHead(503); res.end('down'); return true } }, 'network'],
    ['its history refuses the credential', { onHistory: (_page: number, res: import('node:http').ServerResponse) => { res.writeHead(401); res.end('no'); return true } }, 'auth']
  ] as const)('leaves the session and checkpoint alone when %s', async (_name, options, reason) => {
    // Mutation: treat follow-mode errors as a live turn's (interrupt, save `uncertain`) → an interrupt is posted.
    const p = await peer({ pages: [[user(), running('run')]], ...options })
    const run = follow(p)
    const result = await run.result
    expect(result).toMatchObject({ unreachable: reason, error: { message: expect.any(String) } })
    expect(posts(p)).toHaveLength(0)
    expect(run.binding.save).not.toHaveBeenCalled()
  })

  it('reports an unreachable session when the connection itself fails', async () => {
    const p = await peer()
    const origin = p.origin
    await p.close()
    peers.splice(peers.indexOf(p), 1)
    const dead = { ...p, origin } as ManagedPeer
    const run = follow(dead)
    await expect(run.result).resolves.toMatchObject({ unreachable: 'network' })
    expect(run.binding.save).not.toHaveBeenCalled()
  })

  it('interrupts a followed turn that failed on the session once its kickoff was read, as a live turn does, and will not follow it again', async () => {
    // Mutation: drop the `reducer.seen` branch (interrupt nothing on a follow) → no interrupt is posted.
    const p = await peer({ pages: [[user(), running('run'), { type: 'session.error', id: 'err', processed_at: STAMP,
      error: { type: 'unknown_error', message: 'model crashed', retry_status: { type: 'terminal' } } } as never]] })
    const run = follow(p)
    const result = await run.result
    expect(result).toMatchObject({ error: { message: expect.stringContaining('model crashed') } })
    expect(result.unreachable).toBeUndefined()
    expect(p.sends('user.interrupt')).toHaveLength(1)
    expect(p.sends('user.message')).toHaveLength(0)
    expect(run.binding.save).toHaveBeenLastCalledWith({ sessionId: SESSION, state: 'uncertain' })
  })

  it('fails without touching the session when its history has no such kickoff', async () => {
    const p = await peer({ pages: [[user('another'), idle('end')]] })
    const run = follow(p)
    await expect(run.result).resolves.toMatchObject({ error: { message: expect.stringContaining('no record') } })
    expect(posts(p)).toHaveLength(0)
    expect(run.binding.save).toHaveBeenLastCalledWith({ sessionId: SESSION, state: 'uncertain' })
  })
})
