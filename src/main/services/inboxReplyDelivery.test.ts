import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'
import type { AsyncReplyBinding, AsyncRespondOutcome } from '../agents/drivers/replyDelivery'
import type { RequestResolution } from '../../shared/localAgentRequests'

const state = vi.hoisted(() => ({ db: null as TestDatabase | null, profile: '__default__', validBinding: true, agentExists: true }))
vi.mock('../db/client', () => ({ getDb: () => state.db!.db, getRawSqlite: () => state.db!.sqlite }))
vi.mock('../logger/logger', () => ({ createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }))
vi.mock('../db/sync', () => ({ syncRepo: { getState: () => null } }))
vi.mock('../auth/scope', () => ({ getSettingsScopeUserId: () => '__default__', getProfileScopeUserId: () => state.profile }))
vi.mock('./runExecutionService', () => ({ runExecutionService: { isRunning: () => false } }))
vi.mock('./agentService', () => ({ agentService: { findAgent: () => state.agentExists ? { row: { id: 'agent', driver: 'acp' }, userId: '__default__' } : null } }))
vi.mock('../mcp/manager', () => ({ mcpManager: {} }))
vi.mock('./fileStore', () => ({ attachmentToMediaPart: async () => null }))
vi.mock('../agents/drivers', async () => {
  const { respondToAcpAsk } = await import('../agents/drivers/acp/acpDriver')
  const { pendingRequests } = await import('../agents/drivers/pendingRequests')
  const respond = (ask, resolution) => respondToAcpAsk({ rememberGrant: () => false,
    resolveRequest: (id, value) => pendingRequests.resolve(id, value) !== null }, ask, resolution)
  return { driverFor: () => ({ respond }), respondToOrphanedAsk: respond }
})
const { pendingRequests } = await import('../agents/drivers/pendingRequests')
const { inboxService } = await import('./inboxService')
const { taskService } = await import('./taskService')
const { taskInputRequestRepo } = await import('../db/taskInputRequests')
const USER = '__default__'
const ctx = { userId: USER, chatId: 'chat', agentId: 'agent', turnId: 'turn', rootRunId: 'turn' }
const once: RequestResolution = { kind: 'permission', reply: 'once' }
let taskId: string
beforeEach(() => {
  state.db = createTestDatabase(); state.profile = USER; state.validBinding = true; state.agentExists = true
  state.db.raw.exec("INSERT INTO chats (id,user_id,title,created_at,updated_at) VALUES ('chat','__default__','Reply',1,1)")
  const task = taskService.create(USER, { title: 'Reply', goal: 'Reply', chatId: 'chat' })
  taskId = task.id
  taskService.start(USER, task.id, { chatId: 'chat' })
})
afterEach(() => { pendingRequests.clear(); state.db?.close(); state.db = null; vi.restoreAllMocks() })
function deferred() {
  let resolve!: (value: AsyncRespondOutcome) => void
  const promise = new Promise<AsyncRespondOutcome>((yes) => { resolve = yes })
  return { promise, resolve }
}
function park(delivery?: AsyncReplyBinding, id = 'ask', validate?: () => void) {
  const handle = pendingRequests.register({ requestId: id, chatId: 'chat', agentId: 'agent', kind: 'permission', delivery, validate,
    request: { action: 'bash', resources: ['echo verified'], savable: [] } })
  inboxService.recordRunEvent(ctx, { type: 'needs_input', requestId: id, resume: 'reply', request: { kind: 'permission', action: 'bash', resources: ['echo verified'] } })
  return handle
}
function remote() {
  const gate = deferred()
  const send = vi.fn(() => gate.promise)
  const binding: AsyncReplyBinding = { respondAsync: send, validate: () => { if (!state.validBinding || !state.agentExists) throw new Error('Original binding changed') },
    normalize: (resolution) => resolution.kind === 'permission' && resolution.reply === 'always'
      ? { resolution: { kind: 'permission', reply: 'once' }, remembered: false } : { resolution } }
  return { gate, send, binding }
}

describe('both reply surfaces through the real registry and SQLite', () => {
  it.each(['inbox', 'transcript'] as const)('commits ACP %s answer before the parked continuation can end the turn', async (surface) => {
    const handle = park()
    const observed: string[] = []
    const continued = handle.answered.then((resolution) => {
      observed.push(taskInputRequestRepo.getById('ask')!.status)
      inboxService.closeAsk(ctx, 'ask', resolution)
      inboxService.endTurn(ctx, { type: 'done', stopReason: 'end_turn' })
    })
    const answer = surface === 'inbox' ? inboxService.answer(USER, 'ask', once) : inboxService.answerFromTranscript(USER, 'ask', once)
    expect(taskInputRequestRepo.getById('ask')?.status).toBe('answered')
    expect((await answer).ok).toBe(true)
    await continued
    expect(observed).toEqual(['answered'])
    expect(taskInputRequestRepo.getById('ask')?.status).toBe('answered')
  })

  it.each(['inbox', 'transcript'] as const)('refuses a deleted custom command before ACP orphan delivery from %s', async (surface) => {
    const handle = park(undefined, 'ask', () => { if (!state.agentExists) throw new Error('Captured command is gone') })
    const resolved = vi.fn(); void handle.answered.then(resolved)
    state.agentExists = false
    const result = surface === 'inbox'
      ? await inboxService.answer(USER, 'ask', { kind: 'permission', reply: 'always' })
      : await inboxService.answerFromTranscript(USER, 'ask', { kind: 'permission', reply: 'always' })
    expect(result).toMatchObject({ ok: false, reason: 'Captured command is gone' })
    expect(resolved).not.toHaveBeenCalled()
    expect(taskInputRequestRepo.getById('ask')?.resolution).not.toMatchObject({ kind: 'permission' })
    expect(pendingRequests.owner('ask')).not.toBeNull()
  })
  it('preserves the live ACP orphan answer and records an effective once-only grant', async () => {
    const handle = park(); state.agentExists = false
    expect(await inboxService.answerFromTranscript(USER, 'ask', { kind: 'permission', reply: 'always' })).toEqual({ ok: true, remembered: false })
    expect(await handle.answered).toEqual({ ...once, remembered: false })
    expect(taskInputRequestRepo.getById('ask')?.resolution).toEqual({ ...once, remembered: false })
  })

  it('shares one remote answer across Inbox/transcript and commits before continuation', async () => {
    const value = remote(); const handle = park(value.binding)
    let resumed = false
    const continuation = handle.answered.then((resolution) => {
      expect(taskInputRequestRepo.getById('ask')?.status).toBe('answered')
      resumed = true
      inboxService.closeAsk(ctx, 'ask', resolution)
      inboxService.endTurn(ctx, { type: 'done', stopReason: 'end_turn' })
    })
    const first = inboxService.answer(USER, 'ask', once)
    const second = inboxService.answerFromTranscript(USER, 'ask', once)
    await vi.waitFor(() => expect(value.send).toHaveBeenCalledTimes(1))
    expect(taskInputRequestRepo.getById('ask')?.status).toBe('open')
    expect(resumed).toBe(false)
    expect(await inboxService.answer(USER, 'ask', { kind: 'permission', reply: 'reject' })).toMatchObject({ ok: false, code: 'answer_in_progress' })
    value.gate.resolve({ status: 'accepted' })
    expect((await first).ok).toBe(true); expect((await second).ok).toBe(true)
    await continuation
    expect(value.send).toHaveBeenCalledTimes(1)
  })

  it('rolls back the reply and retains the park if aggregate persistence fails, then retries only local commitment', async () => {
    const value = remote(); park(value.binding)
    const apply = vi.spyOn(taskService, 'applyRunState').mockImplementationOnce(() => { throw new Error('injected database failure') })
    const answer = inboxService.answer(USER, 'ask', once)
    value.gate.resolve({ status: 'accepted' })
    expect(await answer).toMatchObject({ ok: false, code: 'unavailable' })
    expect(taskInputRequestRepo.getById('ask')?.status).toBe('open')
    expect(pendingRequests.owner('ask')).not.toBeNull()
    apply.mockRestore()
    expect(await inboxService.answerFromTranscript(USER, 'ask', once)).toEqual({ ok: true })
    expect(value.send).toHaveBeenCalledTimes(1)
    expect(taskInputRequestRepo.getById('ask')?.status).toBe('answered')
  })

  it.each(['profile', 'binding', 'task'] as const)('refuses a changed %s before dispatch', async (change) => {
    const value = remote(); park(value.binding)
    const answer = inboxService.answer(USER, 'ask', once)
    if (change === 'profile') state.profile = 'another-profile'
    if (change === 'binding') state.validBinding = false
    if (change === 'task') state.db!.raw.prepare("UPDATE tasks SET executor='remote' WHERE id=?").run(taskId)
    expect((await answer).ok).toBe(false)
    expect(value.send).not.toHaveBeenCalled()
    expect(taskInputRequestRepo.getById('ask')?.status).toBe('open')
  })

  it('never routes a missing Managed owner through the ACP orphan responder', async () => {
    const value = remote(); park(value.binding); state.agentExists = false
    expect((await inboxService.answerFromTranscript(USER, 'ask', once)).ok).toBe(false)
    expect(value.send).not.toHaveBeenCalled()
    expect(taskInputRequestRepo.getById('ask')?.status).toBe('open')
    expect(pendingRequests.owner('ask')).not.toBeNull()
  })

  it('keeps a replacement request open when the old remote acceptance arrives', async () => {
    const value = remote(); park(value.binding)
    const answer = inboxService.answer(USER, 'ask', once)
    await vi.waitFor(() => expect(value.send).toHaveBeenCalledTimes(1))
    park(remote().binding)
    value.gate.resolve({ status: 'accepted' })
    expect(await answer).toMatchObject({ ok: false, code: 'no_longer_waiting' })
    expect(taskInputRequestRepo.getById('ask')?.status).toBe('open')
    expect(pendingRequests.owner('ask')).not.toBeNull()
  })

  it('records effective once and leaves a sibling request blocking the task', async () => {
    const value = remote(); park(value.binding); park(undefined, 'sibling')
    const answer = inboxService.answer(USER, 'ask', { kind: 'permission', reply: 'always' })
    value.gate.resolve({ status: 'accepted' })
    expect(await answer).toEqual({ ok: true, remembered: false })
    expect(taskInputRequestRepo.getById('ask')?.resolution).toEqual({ ...once, remembered: false })
    expect(taskInputRequestRepo.getById('sibling')?.status).toBe('open')
    expect(taskService.getById(USER, taskId).status).toBe('blocked')
  })
})
