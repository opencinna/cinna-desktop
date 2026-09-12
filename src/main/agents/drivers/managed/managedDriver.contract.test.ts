import Anthropic from '@anthropic-ai/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { describeDriverContract, type DriverContractSubject, type ParkedTurn, type TurnIO } from '../__golden__/driverContract'
import { goldenRow } from '../__golden__/driverWorld'
import { createManagedDriver } from './managedDriver'
import type { ManagedSessionCheckpoint } from './managedRun'
import { pendingRequests, type RequestResolution } from '../pendingRequests'
import { claimReplyAnswer } from '../../../services/replyAnswerClaims'
import type { RunEvent } from '../../../../shared/runEvents'
import { idle, managedPeer, message, permissionTool, requires, user, SESSION, STAMP, KEY, type ManagedPeer } from './testSupport/managedPeer'

vi.mock('../../../logger/logger', () => ({ createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }))

const USER = 'user-contract'
const CHAT = 'chat-contract'
const ROW = goldenRow({ id: 'managed-contract', name: 'Managed contract', driver: 'managed', source: 'local' })
const worlds: { close(): Promise<void> }[] = []
type Scenario = 'complete' | 'hang' | 'park' | 'failed' | 'history_failed'

/** Only the remote peer and injected persistence are fakes; SDK/driver/claims are real. */
function world(scenario: Scenario = 'complete') {
  let checkpoint: ManagedSessionCheckpoint | null = null
  const saved: string[] = []
  const reads: (string | null)[] = []
  const commits: RequestResolution[] = []
  const cleanup = new AbortController()
  let sequence = 0
  let client: Anthropic
  const remote = managedPeer({
    onHistory(_page, response) {
      if (scenario === 'history_failed') { response.writeHead(503); response.end('history unavailable'); return true }
      return undefined
    },
    onSend(event, peer) {
      if (event.type !== 'user.message') return undefined
      const id = `kickoff-${++sequence}`
      peer.persist(user(id))
      if (scenario === 'complete') peer.send(message(`answer-${sequence}`, 'Contract answer.'), idle(`end-${sequence}`))
      if (scenario === 'hang') peer.send(message(`partial-${sequence}`, 'A partial answer.'))
      if (scenario === 'park') peer.send(permissionTool(`tool-${sequence}`), requires([`tool-${sequence}`]))
      if (scenario === 'failed') peer.send({ type: 'session.status_idle', id: 'failed', processed_at: STAMP, stop_reason: { type: 'retries_exhausted' } })
      return { data: [user(id)] }
    }
  }).then((peer) => {
    client = new Anthropic({ apiKey: KEY, baseURL: peer.origin, maxRetries: 0 })
    return peer
  })
  const driver = createManagedDriver({
    prepare() {
      reads.push(checkpoint?.sessionId ?? null)
      return {
        client, config: { credentialId: 'credential', agentId: 'agent', environmentId: 'environment' },
        checkpoint, validate() {},
        save(value) { checkpoint = { ...value }; saved.push(value.sessionId) }
      }
    },
    readiness() {},
    registerRequest: (input) => pendingRequests.register(input),
    requestTimeoutMs: 300,
    stopTimeoutMs: 40
  })
  const running: ReturnType<typeof driver.run>[] = []
  const run = (io: TurnIO): ReturnType<typeof driver.run> => {
    // Wait only for the local socket to bind; never alter a driver result or
    // catch its rejection, which would defeat the common contract assertions.
    const result = remote.then(() => driver.run(USER, ROW, {
      ...io, signal: AbortSignal.any([io.signal, cleanup.signal]), chatId: CHAT, wireContent: 'Contract goal.'
    }))
    running.push(result)
    return result
  }
  const answerRequest = async (requestId: string, resolution: RequestResolution): Promise<{ delivered: boolean }> => {
    // Registry rejection is expiry/teardown, not a remote permission denial.
    if (resolution.kind === 'rejected') return { delivered: pendingRequests.resolve(requestId, resolution) !== null }
    const registration = pendingRequests.registration(requestId)
    const owner = pendingRequests.owner(requestId)
    if (!registration || !owner) return { delivered: false }
    const result = await claimReplyAnswer({
      registration, ask: { requestId, ...owner }, resolution,
      validate() {
        expect(pendingRequests.owner(requestId)).toMatchObject({ chatId: CHAT, agentId: ROW.id })
      },
      commit(effective) {
        // Acceptance precedes durable commitment, and the continuation stays
        // parked until that commitment succeeds. No direct async release here.
        expect(registration.isCurrent()).toBe(true)
        expect(pendingRequests.owner(requestId)).not.toBeNull()
        commits.push(effective)
      }
    })
    if (result.ok) expect(commits).toHaveLength(1)
    return { delivered: result.ok }
  }
  const value = {
    driver, remote, run, saved, reads, commits, answerRequest,
    async started() { const peer = await remote; await vi.waitFor(() => expect(peer.sends('user.message')).toHaveLength(1)) },
    async afterSettle() { (await remote).send(message('after-answer', 'The permission settled.'), idle('after-answer-end')) },
    async close() { cleanup.abort(); await Promise.allSettled(running); await (await remote).close() }
  }
  worlds.push(value)
  return value
}

afterEach(async () => {
  pendingRequests.clear()
  await Promise.all(worlds.splice(0).map((item) => item.close()))
})

function underTest(failure?: unknown) {
  const driver = createManagedDriver({
    prepare() { throw new Error('Preparation refused by the fixture.') },
    readiness() { if (failure !== undefined) throw failure },
    registerRequest: (input) => pendingRequests.register(input)
  })
  return { driver, row: ROW, grantsWritten: () => 0 }
}

describeDriverContract('managed', (): DriverContractSubject => ({
  completes: () => world('complete'),
  failures: () => ({
    setup_refused: { run: (io) => underTest().driver.run(USER, ROW, { ...io, chatId: CHAT, wireContent: 'Goal' }) },
    history_unavailable: world('history_failed'),
    remote_retries_exhausted: world('failed')
  }),
  hangs: () => world('hang'),
  parks: (): ParkedTurn => ({ ...world('park'), answer: { kind: 'permission', reply: 'once' } }),
  session: () => {
    const w = world('complete')
    return { first: w, second: w, saved: () => w.saved, readBySecond: () => w.reads[1] ?? null }
  },
  underTest,
  readinessWorlds: () => ({ ready: underTest(), credential_refused: underTest(new Error('Credential unavailable.')),
    unexpected_type_error: underTest(new TypeError('Configuration unreadable.')), non_error_throw: underTest('Invalid credential.') })
}))

describe('Managed asynchronous contract boundaries', () => {
  it('denies through remote acceptance and commitment, then refuses a duplicate without another POST', async () => {
    const w = world('park')
    const events: RunEvent[] = []
    const result = w.run({ signal: new AbortController().signal, onEvent: (event) => events.push(event) })
    await vi.waitFor(() => expect(pendingRequests.listForChat(CHAT)).toHaveLength(1))
    const id = pendingRequests.listForChat(CHAT)[0].requestId
    expect(await w.answerRequest(id, { kind: 'permission', reply: 'reject' })).toEqual({ delivered: true })
    expect(await w.answerRequest(id, { kind: 'permission', reply: 'reject' })).toEqual({ delivered: false })
    await w.afterSettle()
    await expect(result).resolves.toMatchObject({ taskState: 'completed' })
    expect((await w.remote).sends('user.tool_confirmation').map((request) => request.body?.events)).toEqual([
      [{ type: 'user.tool_confirmation', result: 'deny', tool_use_id: 'tool-1' }]
    ])
    expect(w.commits).toEqual([{ kind: 'permission', reply: 'reject' }])
    expect(events.filter((event) => event.type === 'input_resolved')).toEqual([
      { type: 'input_resolved', requestId: id, resolution: { kind: 'permission', reply: 'reject' } }
    ])
  })

  it('ignores real peer events after completion and reuses the saved session without another create', async () => {
    const w = world('complete')
    const events: RunEvent[] = []
    const io = { signal: new AbortController().signal, onEvent: (event: RunEvent) => events.push(event) }
    const first = await w.run(io)
    expect(first).toMatchObject({ text: 'Contract answer.', contextId: SESSION })
    const count = events.length
    const peer: ManagedPeer = await w.remote
    peer.send(message('late-after-close', 'Must not appear after completion.'))
    await new Promise((resolve) => setTimeout(resolve, 35))
    expect(events).toHaveLength(count)
    const second = await w.run(io)
    expect(second).toMatchObject({ text: 'Contract answer.', contextId: SESSION })
    expect(w.reads).toEqual([null, SESSION])
    expect(peer.requests.filter((request) => request.method === 'POST' && request.path === '/v1/sessions')).toHaveLength(1)
    expect(peer.sends('user.message')).toHaveLength(2)
    expect(events.filter((event) => event.type === 'delta' && event.text.includes('Must not appear'))).toEqual([])
  })
})
