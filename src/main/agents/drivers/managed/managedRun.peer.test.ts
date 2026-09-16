import Anthropic from '@anthropic-ai/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RunEvent } from '../../../../shared/runEvents'
import type { RequestResolution } from '../../../../shared/localAgentRequests'
import { pendingRequests } from '../pendingRequests'
import { claimReplyAnswer } from '../../../services/replyAnswerClaims'
import { runManagedSession, type ManagedRunBinding, type ManagedRunResult } from './managedRun'
import { managedPeer, deferred, user, message, idle, permissionTool, requires, interrupted, SESSION, STAMP, KEY,
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
    chatId: 'chat-peer', wireContent: 'Complete the fixture goal.', signal: controller.signal,
    onEvent: event => events.push(event),
    ...(registerSnapshot ? { registerSnapshot } : {})
  }, { registerRequest: pendingRequests.register, requestTimeoutMs: 500, stopTimeoutMs: 80 })
  const finished = vi.fn()
  void result.then(finished)
  runs.push({ controller, result })
  return { controller, events, binding, result, finished }
}
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
    await expect(run.result).resolves.toMatchObject({ error: { message: expect.stringContaining('unfinished work') } })
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
