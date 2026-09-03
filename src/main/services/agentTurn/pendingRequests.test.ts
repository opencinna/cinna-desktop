/**
 * The registry that holds a turn open across human latency, and the bound on
 * how long it may do so.
 *
 * The timeout is the interesting part and it is not about tidiness. A turn
 * holds its per-agent lock while parked, and `applyConfigChange` defers while
 * **any** lock is held — the global predicate Phase 5 introduced because one
 * `opencode serve` backs every folder agent. So an abandoned dialog does not
 * stall one chat; it stops every credential change, every default-chat-mode
 * change and the background account-config sync from reaching the engine, for
 * every folder agent, until the user comes back.
 *
 * Every mutation named below was run; the table is at the bottom.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const logged: string[] = []
vi.mock('../../logger/logger', () => ({
  createLogger: () => ({
    debug: (m: string) => logged.push(m),
    info: (m: string) => logged.push(m),
    warn: (m: string) => logged.push(m),
    error: (m: string) => logged.push(m)
  })
}))

import { pendingRequests } from './pendingRequests'

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

describe('pendingRequests', () => {
  beforeEach(() => {
    pendingRequests.clear()
    logged.length = 0
  })

  it('rejects a request nobody answered, rather than parking it forever', async () => {
    const handle = pendingRequests.register({
      requestId: 'que_1',
      chatId: 'c',
      agentId: 'a',
      kind: 'question',
      timeoutMs: 5
    })
    await new Promise((r) => setTimeout(r, 25))

    // Mutation: delete the `setTimeout` that settles on expiry → this hangs
    // and the test times out, which is the production symptom: the lock is
    // held, the reconcile defers, and nothing recovers without a restart.
    await expect(handle.answered).resolves.toEqual({ kind: 'rejected' })
    // **Rejected, not abandoned.** The runner posts a real `reject` for this
    // resolution, so the agent loop is told "denied" and the session goes idle
    // by the same path a deliberate Deny takes. Mutation: settle with a
    // `{kind:'permission', reply:'once'}` on expiry fails this — silently
    // granting a permission the user never saw is the worst possible timeout
    // behaviour.
    expect(pendingRequests.owner('que_1')).toBeNull()
  })

  it('does not reject a request the user answered in time', async () => {
    const handle = pendingRequests.register({
      requestId: 'per_1',
      chatId: 'c',
      agentId: 'a',
      kind: 'permission',
      timeoutMs: 5
    })
    pendingRequests.resolve('per_1', { kind: 'permission', reply: 'once' })
    await new Promise((r) => setTimeout(r, 25))

    // Note what this does **not** pin, having been written claiming it did:
    // the `entries.get(...)?.settle !== settle` guard in `settle`. Removing it
    // was run against this and **passed** — a Promise ignores its second
    // `resolve`, so a late expiry cannot change an answer that already landed.
    // The guard protects something else; the next test reaches it.
    await expect(handle.answered).resolves.toEqual({ kind: 'permission', reply: 'once' })
  })

  it('a stale handle cannot delete the entry that replaced it', async () => {
    // The sequence a reconnect produces: an ask is answered, then replayed, so
    // the same request id is registered a second time while the *first*
    // handle is still held by the turn's `parked` map and will be cancelled
    // when the turn ends.
    const first = pendingRequests.register({
      requestId: 'que_1',
      chatId: 'c',
      agentId: 'a',
      kind: 'question',
      timeoutMs: 60_000
    })
    pendingRequests.resolve('que_1', { kind: 'question', answers: [['A']] })
    await expect(first.answered).resolves.toEqual({ kind: 'question', answers: [['A']] })

    const second = pendingRequests.register({
      requestId: 'que_1',
      chatId: 'c',
      agentId: 'a',
      kind: 'question',
      timeoutMs: 60_000
    })

    // The turn ends and sweeps its parked handles, including the stale one.
    first.cancel()

    // Mutation: `if (entries.get(input.requestId)?.settle !== settle) return`
    // → `if (false) return` fails this. The stale handle's settle runs
    // `entries.delete('que_1')` and takes the *live* registration with it: the
    // renderer's block goes read-only while the engine is still parked, the
    // user can no longer answer, and `second.answered` resolves only when the
    // turn's own sweep gets to it — by which point the question is dead.
    expect(pendingRequests.owner('que_1')).not.toBeNull()
    let secondSettled = false
    void second.answered.then(() => {
      secondSettled = true
    })
    await settle()
    expect(secondSettled).toBe(false)
  })

  it('refuses an answer of the wrong kind rather than posting it to the wrong endpoint', () => {
    pendingRequests.register({
      requestId: 'que_1',
      chatId: 'c',
      agentId: 'a',
      kind: 'question',
      timeoutMs: 60_000
    })
    // A permission reply routed to a question id would be posted to
    // `.../question/que_1/reply` with a `{reply}` body — a 400 the user only
    // learns about after the dialog told them it worked.
    //
    // Mutation: drop the `entry.kind !== resolution.kind` check fails this.
    expect(pendingRequests.resolve('que_1', { kind: 'permission', reply: 'once' })).toBeNull()
    expect(pendingRequests.owner('que_1')).not.toBeNull()
  })

  it('reports the owner without consuming the request', () => {
    pendingRequests.register({
      requestId: 'per_1',
      chatId: 'chat_9',
      agentId: 'folder:x',
      kind: 'permission',
      timeoutMs: 60_000
    })
    // The IPC handler checks chat ownership *before* delivering. Mutation: make
    // `owner()` delegate to `resolve()` fails this — the answer would already
    // have been delivered by the time the ownership check could reject it.
    expect(pendingRequests.owner('per_1')).toEqual({
      chatId: 'chat_9',
      agentId: 'folder:x',
      kind: 'permission'
    })
    expect(pendingRequests.owner('per_1')).not.toBeNull()
  })

  it('a second registration under one id settles the first rather than orphaning it', async () => {
    const first = pendingRequests.register({
      requestId: 'que_1',
      chatId: 'c',
      agentId: 'a',
      kind: 'question',
      timeoutMs: 60_000
    })
    pendingRequests.register({
      requestId: 'que_1',
      chatId: 'c',
      agentId: 'a',
      kind: 'question',
      timeoutMs: 60_000
    })
    await settle()

    // A reconnect can replay an ask. Mutation: `entries.set` without settling
    // the existing entry fails this — the first promise never resolves, and
    // the runner awaits it forever inside a turn that can no longer end.
    await expect(first.answered).resolves.toEqual({ kind: 'rejected' })
  })
})

/**
 * ## Mutations run, and the test each one fails
 *
 * | Mutation | Fails |
 * |---|---|
 * | delete the expiry `setTimeout` | rejects a request nobody answered (times out) |
 * | expiry settles as `{permission, once}` instead of rejected | rejects a request nobody answered |
 * | `settle` drops the already-settled guard | a stale handle cannot delete the entry that replaced it |
 * | drop the `entry.kind !== resolution.kind` check | refuses an answer of the wrong kind |
 * | `owner()` delegates to `resolve()` | reports the owner without consuming the request |
 * | re-`register` without settling the existing entry | a second registration under one id settles the first |
 */
