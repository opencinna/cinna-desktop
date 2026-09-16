import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'
import type { AgentRow } from '../db/agents'
import type { RunWatchMessage } from '../../shared/runWatch'
import type { ManagedEvent } from '../agents/drivers/managed/managedEvents'

/**
 * Relaunch recovery of Claude Managed turns the app was closed under, through
 * the generic recovery service, a real database, the production binding
 * (`managedAgentService`) and the Managed HTTP/SSE peer. The recovered turn is
 * followed from its saved kickoff id; nothing is ever sent again.
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
vi.mock('../auth/scope', () => ({
  getSettingsScopeUserId: () => '__default__',
  getProfileScopeUserId: () => '__default__',
  getAgentLookupScope: () => ['__default__'],
  getManagedResourceScopes: () => ['__default__']
}))
vi.mock('../security/keystore', () => ({ decryptApiKey: (value: Buffer) => value.toString(), encryptApiKey: (value: string) => Buffer.from(value) }))
vi.mock('../index', () => ({ getMainWindow: () => null }))
vi.mock('./cinnaApiService', () => ({ getCinnaServerUrl: () => null, cinnaApiService: {} }))
vi.mock('./syncService', () => ({ syncService: { markDirty: () => undefined } }))
vi.mock('./chatTitleService', () => ({ chatTitleService: { autoGenerateForFirstMessage: async () => undefined } }))
vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../agents/drivers', () => ({
  driverFor: () => { throw new Error('recovery never starts a turn') }
}))

const { managedPeer, user, message, idle, running, permissionTool, requires, interrupted, SESSION, KEY } =
  await import('../agents/drivers/managed/testSupport/managedPeer')
const { createManagedTurnRecoverer } = await import('../agents/drivers/managed/managedTurnRecoverer')
const { remoteTurnRecoveryService, registerRecoverer } = await import('./remoteTurnRecoveryService')
const { INTERRUPTED_TURN_NOTICE } = await import('./interruptedTurnService')
const { STILL_RUNNING_NOTICE } = await import('./turnRecoverers')
const { claimReplyAnswer } = await import('./replyAnswerClaims')
const { managedAgentService } = await import('./managedAgentService')
const { pendingRequests } = await import('../agents/drivers/pendingRequests')
const { inflightTurnRepo } = await import('../db/inflightTurns')
const { chatRepo } = await import('../db/chats')
const { messageRepo } = await import('../db/messages')
const { agentRepo } = await import('../db/agents')
const { llmProviderRepo } = await import('../db/llmProviders')
const { chatRunResultRepo } = await import('../db/chatRunResults')
const { taskInputRequestRepo } = await import('../db/taskInputRequests')
const { liveRunHub } = await import('./liveRunHub')
const { activeRunsByChat } = await import('./runExecutionState')
const { runExecutionService } = await import('./runExecutionService')
const { inboxService } = await import('./inboxService')

type Peer = Awaited<ReturnType<typeof managedPeer>>

const USER = '__default__'
const MARKER = 'req-managed'

const recovererDeps: Parameters<typeof createManagedTurnRecoverer>[0] = {
  findAgent: (_settings, _profile, agentId) => {
    const row = agentRepo.getOwned(USER, agentId)
    return row ? { row, userId: USER } : null
  },
  readiness: (agent) => managedAgentService.readiness(agent),
  prepare: (ownerId, agent, chatId) => managedAgentService.prepare(ownerId, agent, chatId),
  registerRequest: (input) => pendingRequests.register(input),
  requestTimeoutMs: 1_000,
  stopTimeoutMs: 200,
  probeTimeoutMs: 300
}
registerRecoverer('managed', createManagedTurnRecoverer(recovererDeps))

let chatId = ''
let agent: AgentRow
let credentialId = ''
let peer: Peer | null = null

beforeEach(() => {
  holder.current = createTestDatabase()
  chatId = chatRepo.create(USER).id
})

afterEach(async () => {
  pendingRequests.clear()
  await peer?.close()
  peer = null
  holder.current?.close()
  holder.current = null
})

/** The peer, and the agent and credential that point at it. */
async function remote(options: Parameters<typeof managedPeer>[0] = {}): Promise<Peer> {
  peer = await managedPeer(options)
  credentialId = llmProviderRepo.upsert(USER, { type: 'anthropic', name: 'Managed credential', enabled: true,
    apiKeyEncrypted: Buffer.from(KEY), baseUrl: peer.origin }).id
  agent = agentRepo.createRuntime(USER, { name: 'Managed', driver: 'managed',
    config: { credentialId, agentId: 'managed-agent', environmentId: 'managed-environment', version: 1 } })
  holder.current!.raw.prepare('UPDATE chats SET agent_id = ? WHERE id = ?').run(agent.id, chatId)
  return peer
}

/** What a kill leaves: the user row, what the quit flush saved, the checkpoint and the marker. */
function killedTurn(checkpoint: { state: 'ready' | 'inflight' | 'uncertain'; kickoffEventId?: string; kickoffMessageId?: string } | null = { state: 'inflight', kickoffEventId: 'kickoff' }): string {
  const userMessageId = messageRepo.saveUser({ chatId, content: 'Fix the build', addressedAgentId: agent.id })
  inflightTurnRepo.open({ id: MARKER, profileId: USER, chatId, agentId: agent.id, driver: 'managed', userMessageId })
  messageRepo.saveAssistant({ chatId, content: 'Half', parts: [{ kind: 'text', text: 'Half' }], sourceAgentId: agent.id })
  // The kickoff answers this turn's user row unless the case says otherwise.
  if (checkpoint) managedAgentService.prepare(USER, agent, chatId).save({ sessionId: SESSION,
    ...(checkpoint.kickoffEventId ? { kickoffMessageId: userMessageId } : {}), ...checkpoint })
  return userMessageId
}
/** The recoverer's plan for the killed turn, asked directly (without the service). */
function planKilled() {
  return createManagedTurnRecoverer(recovererDeps).plan(inflightTurnRepo.get(MARKER)!, { profileUserId: USER, settingsUserId: USER })
}
/** A recovery IO that records nothing and never resends. */
function quietIO(signal = new AbortController().signal, notices: string[] = []) {
  return { signal, notice: (text: string) => { notices.push(text) }, event: () => {}, resend: async () => { throw new Error('never resent') }, hasRows: () => false, savedOutputSize: () => ({ textLength: 0, parts: 0 }) }
}

function watch(): RunWatchMessage[] {
  const seen: RunWatchMessage[] = []
  liveRunHub.watch(USER, chatId, (entry) => { seen.push(entry) })
  return seen
}
const deltas = (seen: RunWatchMessage[]): string[] =>
  seen.flatMap((m) => m.type === 'event' && m.event.type === 'delta' && m.event.kind === 'text' ? [m.event.text] : [])
const transcript = (): [string, string][] =>
  chatRepo.listMessages(chatId).map((row) => [row.role, row.role === 'error' ? JSON.parse(row.content).short : row.content])
const checkpoint = () => managedAgentService.prepare(USER, agent, chatId).checkpoint
const posts = (p: Peer) => p.requests.filter((request) => request.method === 'POST')
const history = (...events: ManagedEvent[]) => ({ pages: [[user('earlier'), message('earlier-answer', 'Earlier turn.'), idle('earlier-end'), ...events]] })

describe('a Managed turn still running on the session', () => {
  it('streams to the chat as a running turn, then replaces the killed rows and leaves the session ready', async () => {
    const p = await remote(history(user(), running('run'), message('half', 'Half')))
    const userMessageId = killedTurn()
    const seen = watch()

    const done = remoteTurnRecoveryService.resume(USER)
    await vi.waitFor(() => expect(deltas(seen)).toEqual(['Half']))
    expect(activeRunsByChat.get(chatId)?.id).toBe(MARKER)
    // The replay stands in for what the kill left: those rows are not in the
    // live view's baseline, or they would show twice.
    // Mutation: drop `replaysLive` from the Managed plan → the flushed row is in it.
    const snapshot = seen.find((m) => m.type === 'snapshot' && m.active && m.runId === MARKER)
    expect(snapshot?.type === 'snapshot' && snapshot.baselineMessageIds).toEqual([userMessageId])
    p.send(message('rest', 'the fix is in.'), idle('end'))
    await done

    // Mutation: return `interrupted` from `recover` → the notice row, no answer.
    expect(transcript()).toEqual([['user', 'Fix the build'], ['assistant', 'Half\n\nthe fix is in.']])
    expect(deltas(seen)).toEqual(['Half', '\n\nthe fix is in.'])
    expect(posts(p)).toEqual([])
    expect(inflightTurnRepo.list()).toEqual([])
    expect(activeRunsByChat.has(chatId)).toBe(false)
    expect(chatRunResultRepo.get(USER, chatId)).toMatchObject({ runId: MARKER, status: 'completed' })
    expect(checkpoint()).toEqual({ sessionId: SESSION, state: 'ready' })
  })
})

describe('a Managed turn that ended while the app was closed', () => {
  it('shows its final message', async () => {
    const p = await remote(history(user(), running('run'), message('half', 'Half'), message('final', 'Build fixed.'), idle('end')))
    killedTurn()

    await remoteTurnRecoveryService.resume(USER)

    expect(transcript()).toEqual([['user', 'Fix the build'], ['assistant', 'Half\n\nBuild fixed.']])
    expect(posts(p)).toEqual([])
    expect(chatRunResultRepo.get(USER, chatId)?.status).toBe('completed')
  })
})

describe('a Managed turn parked on a permission', () => {
  it('offers it again, delivers the answer from the app, and completes', async () => {
    const p = await remote(history(user(), permissionTool('tool-parked'), requires(['tool-parked'])))
    killedTurn()

    const done = remoteTurnRecoveryService.resume(USER)
    await vi.waitFor(() => expect(taskInputRequestRepo.listOpenForChat(chatId)).toHaveLength(1))
    const [ask] = taskInputRequestRepo.listOpenForChat(chatId)
    expect(ask).toMatchObject({ agentId: agent.id, resume: 'reply' })
    expect(pendingRequests.listForChat(chatId)).toEqual([{ requestId: ask.id, kind: 'permission' }])

    await expect(inboxService.answerFromTranscript(USER, ask.id, { kind: 'permission', reply: 'once' })).resolves.toEqual({ ok: true })
    expect(p.sends('user.tool_confirmation').map((request) => request.body)).toEqual([
      { events: [{ type: 'user.tool_confirmation', result: 'allow', tool_use_id: 'tool-parked' }] }
    ])
    p.send(message('after', 'Ran it.'), idle('end'))
    await done

    expect(transcript().at(-1)).toEqual(['assistant', 'Ran it.'])
    expect(chatRepo.listMessages(chatId).at(-1)!.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'tool', toolId: ask.id }),
      expect.objectContaining({ kind: 'tool_result', toolId: ask.id, text: 'Allowed once.' })
    ]))
    expect(p.sends('user.message')).toEqual([])
    expect(chatRunResultRepo.get(USER, chatId)?.status).toBe('completed')
  })
})

describe('Stop during a Managed recovery', () => {
  it('interrupts the session and records the turn canceled, keeping what streamed', async () => {
    const p = await remote({
      ...history(user(), running('run'), message('half', 'Half')),
      onSend(event, peerRef) {
        if (event.type !== 'user.interrupt') return undefined
        peerRef.send(interrupted(true), idle('stopped'))
        return { data: [interrupted(false)] }
      }
    })
    killedTurn()
    const seen = watch()

    const done = remoteTurnRecoveryService.resume(USER)
    await vi.waitFor(() => expect(deltas(seen)).toEqual(['Half']))
    runExecutionService.cancelChat(USER, chatId)
    await done

    expect(p.sends('user.interrupt')).toHaveLength(1)
    expect(p.sends('user.message')).toEqual([])
    expect(transcript()).toEqual([['user', 'Fix the build'], ['assistant', 'Half']])
    expect(chatRunResultRepo.get(USER, chatId)?.status).toBe('canceled')
    expect(inflightTurnRepo.list()).toEqual([])
  })
})

describe('a Managed turn recovery cannot follow', () => {
  it.each([
    ['no kickoff id was saved', { state: 'inflight' as const }],
    ['the checkpoint is ready', { state: 'ready' as const }],
    ['no session was opened', null]
  ])('is settled as interrupted, sending nothing, when %s', async (_name, saved) => {
    const p = await remote(history(user(), running('run')))
    killedTurn(saved)

    await remoteTurnRecoveryService.resume(USER)

    // Mutation: let `targetOf` follow these checkpoints with a stand-in kickoff → requests reach the peer.
    expect(p.requests).toEqual([])
    expect(transcript()).toEqual([['user', 'Fix the build'], ['assistant', 'Half'], ['error', INTERRUPTED_TURN_NOTICE]])
    expect(inflightTurnRepo.list()).toEqual([])
    expect(chatRunResultRepo.get(USER, chatId)?.status).toBe('failed')
  })

  it('is settled as interrupted, following nothing, when the saved kickoff answers another user row', async () => {
    // Mutation: drop the `kickoffMessageId` comparison in `targetOf` → the earlier turn is followed.
    const p = await remote(history(user(), running('run')))
    killedTurn({ state: 'inflight', kickoffEventId: 'kickoff', kickoffMessageId: 'an-earlier-row' })

    await expect(planKilled()).resolves.toEqual({ kind: 'interrupted', reason: expect.stringContaining('another turn') })
    await remoteTurnRecoveryService.resume(USER)

    expect(p.requests).toEqual([])
    expect(transcript().at(-1)).toEqual(['error', INTERRUPTED_TURN_NOTICE])
  })

  it('whose agent is gone is settled as interrupted', async () => {
    const p = await remote(history(user(), running('run')))
    killedTurn()
    holder.current!.raw.prepare('UPDATE agents SET enabled = 0 WHERE id = ?').run(agent.id)

    await remoteTurnRecoveryService.resume(USER)

    expect(p.requests).toEqual([])
    expect(transcript().at(-1)).toEqual(['error', INTERRUPTED_TURN_NOTICE])
  })

  it('waits, marker kept, while its credential needs the user', async () => {
    const p = await remote(history(user(), running('run')))
    killedTurn()
    llmProviderRepo.upsert(USER, { id: credentialId, type: 'anthropic', name: 'Managed credential', enabled: false })

    await remoteTurnRecoveryService.resume(USER)

    expect(p.requests).toEqual([])
    expect(inflightTurnRepo.list()).toHaveLength(1)
    expect(transcript()).toEqual([['user', 'Fix the build'], ['assistant', 'Half']])
  })
})

/**
 * The recoverer's own answers when the session cannot be reached. Asked
 * directly: the service's handling of `defer` is built separately.
 */
describe('a Managed session that cannot be reached', () => {
  it('defers the plan (network) when the session does not answer the probe in time', async () => {
    await remote({ ...history(user(), running('run')), onRetrieve: () => true })
    killedTurn()
    await expect(planKilled()).resolves.toEqual({ kind: 'defer', reason: 'network' })
  })

  it('defers the plan (network) when the connection fails', async () => {
    const p = await remote(history(user(), running('run')))
    killedTurn()
    await p.close()
    peer = null
    await expect(planKilled()).resolves.toEqual({ kind: 'defer', reason: 'network' })
  })

  it('defers the plan (auth) when the session refuses the credential', async () => {
    await remote({ ...history(user(), running('run')), onRetrieve: (res) => { res.writeHead(401); res.end('{}'); return true } })
    killedTurn()
    await expect(planKilled()).resolves.toEqual({ kind: 'defer', reason: 'auth' })
  })

  it('defers the plan (auth) while the credential needs the user', async () => {
    await remote(history(user(), running('run')))
    killedTurn()
    llmProviderRepo.upsert(USER, { id: credentialId, type: 'anthropic', name: 'Managed credential', enabled: false })
    await expect(planKilled()).resolves.toEqual({ kind: 'defer', reason: 'auth' })
  })

  it('settles as interrupted when the session is gone', async () => {
    await remote({ ...history(user(), running('run')), onRetrieve: (res) => { res.writeHead(404); res.end('{}'); return true } })
    killedTurn()
    await expect(planKilled()).resolves.toMatchObject({ kind: 'interrupted' })
  })

  it('defers a follow whose stream keeps closing, interrupting nothing and keeping the kickoff', async () => {
    // Mutation: interrupt and save `uncertain` on any follow error → an interrupt is posted and the kickoff is gone.
    const p = await remote({ ...history(user(), running('run'), message('half', 'Half')),
      onStream: (res) => { res.end(); return true } })
    const userMessageId = killedTurn()
    const plan = await planKilled()
    if (plan.kind !== 'recover') throw new Error(`expected a recover plan, got ${plan.kind}`)
    await expect(plan.recover(quietIO())).resolves.toEqual({ kind: 'defer', reason: 'network' })
    expect(p.requests.filter((r) => r.path.endsWith('/events/stream')).length).toBeGreaterThan(1)
    expect(posts(p)).toEqual([])
    expect(checkpoint()).toEqual({ sessionId: SESSION, state: 'inflight', kickoffEventId: 'kickoff', kickoffMessageId: userMessageId })
    expect(inflightTurnRepo.list()).toHaveLength(1)
  })

  it('defers a follow that loses the connection mid-turn', async () => {
    const p = await remote(history(user(), running('run'), message('half', 'Half')))
    killedTurn()
    const plan = await planKilled()
    if (plan.kind !== 'recover') throw new Error(`expected a recover plan, got ${plan.kind}`)
    const recovering = plan.recover(quietIO())
    await vi.waitFor(() => expect(p.requests.filter((r) => r.path.endsWith('/events/stream'))).toHaveLength(1))
    await vi.waitFor(() => expect(p.requests.filter((r) => r.path.endsWith('/events'))).toHaveLength(1))
    await p.close()
    peer = null
    await expect(recovering).resolves.toEqual({ kind: 'defer', reason: 'network' })
    expect(posts(p)).toEqual([])
    expect(checkpoint()).toMatchObject({ state: 'inflight', kickoffEventId: 'kickoff' })
  })

  it('still records a Stop during a follow as canceled, not deferred', async () => {
    const p = await remote({ ...history(user(), running('run'), message('half', 'Half')),
      onSend(event, peerRef) {
        if (event.type !== 'user.interrupt') return undefined
        peerRef.send(interrupted(true), idle('stopped'))
        return { data: [interrupted(false)] }
      } })
    killedTurn()
    const plan = await planKilled()
    if (plan.kind !== 'recover') throw new Error(`expected a recover plan, got ${plan.kind}`)
    const controller = new AbortController()
    const recovering = plan.recover(quietIO(controller.signal))
    await vi.waitFor(() => expect(p.requests.filter((r) => r.path.endsWith('/events/stream'))).toHaveLength(1))
    controller.abort()
    await expect(recovering).resolves.toMatchObject({ outcome: { state: 'canceled' } })
    expect(p.sends('user.interrupt')).toHaveLength(1)
  })
})

describe('the still-running notice of a Managed recovery', () => {
  it('is shown once history is read and the turn is still working', async () => {
    // Mutation: drop the `onStillRunning` hook in `recover` → no notice.
    const p = await remote(history(user(), running('run'), message('half', 'Half')))
    killedTurn()
    const plan = await planKilled()
    if (plan.kind !== 'recover') throw new Error(`expected a recover plan, got ${plan.kind}`)
    const notices: string[] = []
    const recovering = plan.recover(quietIO(undefined, notices))
    await vi.waitFor(() => expect(notices).toEqual([STILL_RUNNING_NOTICE]))
    p.send(message('rest', 'Done.'), idle('end'))
    await expect(recovering).resolves.toMatchObject({ kind: 'collected', outcome: { state: 'completed' } })
    expect(notices).toEqual([STILL_RUNNING_NOTICE])
  })

  it('is not shown for a turn that ended while the app was closed', async () => {
    await remote(history(user(), running('run'), message('final', 'Build fixed.'), idle('end')))
    killedTurn()
    const plan = await planKilled()
    if (plan.kind !== 'recover') throw new Error(`expected a recover plan, got ${plan.kind}`)
    const notices: string[] = []
    await expect(plan.recover(quietIO(undefined, notices))).resolves.toMatchObject({ kind: 'collected' })
    expect(notices).toEqual([])
  })

  it('is shown for a parked permission only once its answer is delivered', async () => {
    const p = await remote(history(user(), permissionTool('tool-parked'), requires(['tool-parked'])))
    killedTurn()
    const plan = await planKilled()
    if (plan.kind !== 'recover') throw new Error(`expected a recover plan, got ${plan.kind}`)
    const notices: string[] = []
    const recovering = plan.recover(quietIO(undefined, notices))
    await vi.waitFor(() => expect(pendingRequests.listForChat(chatId)).toHaveLength(1))
    expect(notices).toEqual([])
    const { requestId } = pendingRequests.listForChat(chatId)[0]
    const registration = pendingRequests.registration(requestId)!
    const owner = pendingRequests.owner(requestId)!
    await expect(claimReplyAnswer({ registration, ask: { requestId, ...owner }, resolution: { kind: 'permission', reply: 'once' },
      validate() {}, commit() {} })).resolves.toEqual({ ok: true })
    await vi.waitFor(() => expect(notices).toEqual([STILL_RUNNING_NOTICE]))
    p.send(message('after', 'Ran it.'), idle('end'))
    await expect(recovering).resolves.toMatchObject({ kind: 'collected' })
  })
})
