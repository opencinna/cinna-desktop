import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ParkedAsk } from '../agents/drivers/driver'
import type { AsyncReplyBinding, AsyncRespondOutcome } from '../agents/drivers/replyDelivery'
import type { RequestResolution } from '../../shared/localAgentRequests'
import { pendingRequests } from '../agents/drivers/pendingRequests'
import { claimReplyAnswer, replyAnswerUncertainty } from './replyAnswerClaims'

vi.mock('../logger/logger', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }))

const once: RequestResolution = { kind: 'permission', reply: 'once' }
const deny: RequestResolution = { kind: 'permission', reply: 'reject' }
const ask: ParkedAsk = { requestId: 'managed-permission-1', chatId: 'chat-1', agentId: 'agent-1', kind: 'permission',
  request: { action: 'bash', resources: ['printf permitted'], savable: [] } }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function arrange(bindingOverrides: Partial<AsyncReplyBinding> = {}) {
  const delivery = deferred<AsyncRespondOutcome>()
  const started = deferred<void>()
  const respond = vi.fn<AsyncReplyBinding['respondAsync']>(() => { started.resolve(); return delivery.promise })
  const binding = { validate: vi.fn(), respondAsync: respond, ...bindingOverrides }
  const parked = pendingRequests.register({ ...ask, delivery: binding, timeoutMs: 1_000 })
  const registration = pendingRequests.registration(ask.requestId)!
  const released = vi.fn()
  void parked.answered.then(released)
  const validate = vi.fn()
  const commit = vi.fn()
  const answer = (resolution = once) => claimReplyAnswer({ registration: pendingRequests.registration(ask.requestId) ?? registration,
    ask, resolution, validate, commit })
  return { delivery, started, respond, binding, parked, registration, released, validate, commit, answer }
}

beforeEach(() => { vi.useFakeTimers(); pendingRequests.clear() })
afterEach(() => { pendingRequests.clear(); vi.useRealTimers() })

describe('claimReplyAnswer with the real pending request registry', () => {
  it('joins the same answer across distinct handles, refuses an opposing answer, and commits before releasing after acknowledgment', async () => {
    const f = arrange()
    const order: string[] = []
    f.commit.mockImplementation((resolution: RequestResolution) => {
      expect(resolution).toEqual(once)
      expect(f.registration.isCurrent()).toBe(true)
      expect(f.released).not.toHaveBeenCalled()
      order.push('commit')
    })
    void f.parked.answered.then(() => order.push('continuation'))
    const first = f.answer()
    const second = f.answer({ kind: 'permission', reply: 'once' })
    expect(second).toBe(first)
    await f.started.promise
    expect(f.respond).toHaveBeenCalledTimes(1)
    expect(f.respond).toHaveBeenCalledWith(ask, once, { signal: f.registration.signal })
    expect(f.commit).not.toHaveBeenCalled()
    expect(f.released).not.toHaveBeenCalled()
    expect(f.registration.isCurrent()).toBe(true)
    await expect(f.answer(deny)).resolves.toMatchObject({ ok: false, code: 'answer_in_progress' })
    expect(f.respond).toHaveBeenCalledTimes(1)
    f.delivery.resolve({ status: 'accepted' })
    await expect(first).resolves.toEqual({ ok: true })
    await expect(second).resolves.toEqual({ ok: true })
    await expect(f.parked.answered).resolves.toEqual(once)
    expect(order).toEqual(['commit', 'continuation'])
    expect(f.commit).toHaveBeenCalledTimes(1)
    expect(pendingRequests.registration(ask.requestId)).toBeNull()
  })

  it('retries only the local commit after acceptance and a durable write failure', async () => {
    const f = arrange()
    f.commit.mockImplementationOnce(() => { throw new Error('DB write failed') })
    const first = f.answer()
    await f.started.promise
    f.delivery.resolve({ status: 'accepted' })
    await expect(first).resolves.toMatchObject({ ok: false, code: 'unavailable', reason: expect.stringContaining('DB write failed') })
    expect(f.registration.isCurrent()).toBe(true)
    expect(f.released).not.toHaveBeenCalled()
    await expect(f.answer(deny)).resolves.toMatchObject({ ok: false, code: 'answer_in_progress' })
    const retry = f.answer()
    expect(f.answer()).toBe(retry)
    await expect(retry).resolves.toEqual({ ok: true })
    expect(f.respond).toHaveBeenCalledTimes(1)
    expect(f.commit).toHaveBeenCalledTimes(2)
    await expect(f.parked.answered).resolves.toEqual(once)
  })

  it('releases only the claim on not_sent, so a later explicit retry sends once more', async () => {
    const f = arrange()
    const first = f.answer()
    await f.started.promise
    f.delivery.resolve({ status: 'not_sent', reason: 'Credential lookup failed before dispatch' })
    await expect(first).resolves.toMatchObject({ ok: false, code: 'unavailable' })
    expect(f.commit).not.toHaveBeenCalled()
    expect(f.released).not.toHaveBeenCalled()
    expect(f.registration.isCurrent()).toBe(true)
    f.respond.mockResolvedValueOnce({ status: 'accepted' })
    await expect(f.answer(deny)).resolves.toEqual({ ok: true })
    expect(f.respond).toHaveBeenCalledTimes(2)
    expect(f.respond.mock.calls[1][1]).toEqual(deny)
    expect(f.commit).toHaveBeenCalledExactlyOnceWith(deny)
    await expect(f.parked.answered).resolves.toEqual(deny)
  })

  it.each(['uncertain outcome', 'rejected delivery promise'] as const)('never resends after %s', async (failure) => {
    const f = arrange()
    const first = f.answer()
    await f.started.promise
    if (failure === 'uncertain outcome') f.delivery.resolve({ status: 'uncertain', reason: 'Acknowledgment lost' })
    else f.delivery.reject(new Error('Connection ended after dispatch'))
    await expect(first).resolves.toMatchObject({ ok: false, code: 'uncertain', reason: expect.stringContaining('Do not submit it again') })
    await expect(f.answer()).resolves.toMatchObject({ ok: false, code: 'uncertain' })
    await expect(f.answer(deny)).resolves.toMatchObject({ ok: false, code: 'answer_in_progress' })
    expect(f.respond).toHaveBeenCalledTimes(1)
    expect(f.commit).not.toHaveBeenCalled()
    expect(f.released).not.toHaveBeenCalled()
    expect(f.registration.isCurrent()).toBe(true)
    expect(replyAnswerUncertainty(pendingRequests.registration(ask.requestId))).toContain('Do not submit it again')
    f.parked.cancel()
    expect(replyAnswerUncertainty(f.registration)).toBeNull()
    expect(replyAnswerUncertainty(pendingRequests.registration(ask.requestId))).toBeNull()
  })

  it.each(['cancel', 'timeout', 'clear', 'replacement'] as const)('%s invalidates delivery and late acceptance cannot commit or release a new registration', async (action) => {
    const f = arrange()
    const first = f.answer()
    await f.started.promise
    let replacement: ReturnType<typeof pendingRequests.register> | undefined
    const freshDelivery = vi.fn<AsyncReplyBinding['respondAsync']>().mockResolvedValue({ status: 'accepted' })
    const registerNew = () => pendingRequests.register({ ...ask, delivery: { validate() {}, respondAsync: freshDelivery }, timeoutMs: 20_000 })
    if (action === 'cancel') f.parked.cancel()
    if (action === 'timeout') await vi.advanceTimersByTimeAsync(1_000)
    if (action === 'clear') pendingRequests.clear()
    if (action === 'replacement') replacement = registerNew()
    expect(f.registration.signal.aborted).toBe(true)
    // Local cancellation settles promptly even though the remote request remains unresolved.
    await expect(first).resolves.toMatchObject({ ok: false, code: 'no_longer_waiting' })
    replacement ??= registerNew()
    const current = pendingRequests.registration(ask.requestId)!
    const replacementReleased = vi.fn()
    void replacement.answered.then(replacementReleased)
    expect(current.token).not.toBe(f.registration.token)
    f.delivery.resolve({ status: 'accepted' })
    await f.delivery.promise
    await Promise.resolve()
    expect(f.commit).not.toHaveBeenCalled()
    expect(replacementReleased).not.toHaveBeenCalled()
    expect(current.isCurrent()).toBe(true)
    expect(f.registration.release(once)).toBe(false)
    f.parked.cancel()
    expect(current.isCurrent()).toBe(true)
    // Async drop rejects only the local barrier; the captured responder is not invoked again.
    await expect(f.parked.answered).resolves.toEqual({ kind: 'rejected' })
    expect(f.respond).toHaveBeenCalledTimes(1)
    const freshCommit = vi.fn()
    await expect(claimReplyAnswer({ registration: current, ask, resolution: deny, validate() {}, commit: freshCommit }))
      .resolves.toEqual({ ok: true })
    expect(freshDelivery).toHaveBeenCalledTimes(1)
    expect(freshCommit).toHaveBeenCalledExactlyOnceWith(deny)
    await expect(replacement.answered).resolves.toEqual(deny)
  })

  it('does not let the public ACP resolver consume a captured asynchronous registration', async () => {
    const f = arrange()
    expect(f.registration.origin).toBe('async')
    expect(pendingRequests.resolve(ask.requestId, once)).toBeNull()
    expect(pendingRequests.resolve(ask.requestId, { kind: 'permission', reply: 'always' })).toBeNull()
    expect(f.registration.isCurrent()).toBe(true)
    expect(f.released).not.toHaveBeenCalled()
    expect(f.respond).not.toHaveBeenCalled()
    const local = pendingRequests.register({ ...ask, requestId: 'acp-local' })
    expect(pendingRequests.registration('acp-local')?.origin).toBe('acp')
    expect(pendingRequests.resolve('acp-local', once)).toEqual({ chatId: ask.chatId, agentId: ask.agentId })
    await expect(local.answered).resolves.toEqual(once)
    expect(pendingRequests.owner(ask.requestId)).toEqual({ chatId: ask.chatId, agentId: ask.agentId, kind: ask.kind, request: ask.request })
    expect(pendingRequests.listForChat(ask.chatId)).toEqual([{ requestId: ask.requestId, kind: ask.kind }])
  })

  it('normalizes unsupported always to once consistently for joining, dispatch, commitment and continuation', async () => {
    const f = arrange({ normalize: (resolution) => resolution.kind === 'permission'
      ? { resolution: { kind: 'permission', reply: resolution.reply === 'always' ? 'once' : resolution.reply }, remembered: false }
      : { resolution } })
    const first = f.answer({ kind: 'permission', reply: 'always' })
    expect(f.answer(once)).toBe(first)
    await f.started.promise
    const effective = { kind: 'permission', reply: 'once', remembered: false }
    expect(f.respond.mock.calls[0][1]).toEqual(effective)
    f.delivery.resolve({ status: 'accepted' })
    await expect(first).resolves.toEqual({ ok: true, remembered: false })
    expect(f.commit).toHaveBeenCalledExactlyOnceWith(effective)
    await expect(f.parked.answered).resolves.toEqual(effective)
  })

  it('refuses before dispatch when current ownership validation fails, then permits a valid retry', async () => {
    const f = arrange()
    f.validate.mockImplementationOnce(() => { throw new Error('Profile no longer owns the chat') })
    await expect(f.answer()).resolves.toMatchObject({ ok: false, code: 'unavailable', reason: 'Profile no longer owns the chat' })
    expect(f.respond).not.toHaveBeenCalled()
    expect(f.commit).not.toHaveBeenCalled()
    expect(f.released).not.toHaveBeenCalled()
    f.respond.mockResolvedValueOnce({ status: 'accepted' })
    await expect(f.answer()).resolves.toEqual({ ok: true })
    expect(f.respond).toHaveBeenCalledTimes(1)
  })

  it('revalidates the captured binding after acceptance and cannot commit until it is valid, without resending', async () => {
    const bindingValid = vi.fn()
    const f = arrange({ validate: bindingValid })
    const first = f.answer()
    await f.started.promise
    bindingValid.mockImplementationOnce(() => { throw new Error('Captured session is no longer current') })
    f.delivery.resolve({ status: 'accepted' })
    await expect(first).resolves.toMatchObject({ ok: false, code: 'unavailable' })
    expect(f.commit).not.toHaveBeenCalled()
    expect(f.released).not.toHaveBeenCalled()
    await expect(f.answer()).resolves.toEqual({ ok: true })
    expect(f.respond).toHaveBeenCalledTimes(1)
    expect(f.commit).toHaveBeenCalledTimes(1)
  })
})
