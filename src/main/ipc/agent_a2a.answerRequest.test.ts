import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * `agent:answer-request` — where a user's *Always allow* becomes a rule.
 *
 * This path is the only place `always` is allowed to mean anything, and it has
 * two jobs that must not come apart:
 *
 * 1. **The engine is never told `always`.** OpenCode's own grant is a
 *    user-global row naming no directory, no session and no agent — one click
 *    would authorise every folder agent on the machine, permanently, including
 *    from the user's own OpenCode install (`opencode_contract.md` §4). So the
 *    reply that leaves here is `once`, which persists nothing engine-side.
 * 2. **What it tells the user matches what is on disk.** The write happens
 *    while the user waits precisely so a refusal can be reported; a handler
 *    that answered `{ok:true}` regardless would have the block claim a rule
 *    that does not exist.
 *
 * Since phase 2 the handler validates and checks ownership, then hands the
 * answer to the agent's driver; the grant write lives in the folder drivers'
 * `respond`. So this file drives the **real** folder driver behind a mocked
 * `driverFor`, with the grant store and the registry recorded — the same two
 * facts, through the real path. The grant store's own correctness lives in
 * `permissionGrantService.test.ts`; the driver's in `folderDriver.test.ts`.
 */

const handlers = new Map<string, (...args: unknown[]) => unknown>()
vi.mock('./_wrap', () => ({
  ipcHandle: (channel: string, handler: (...args: unknown[]) => unknown) => {
    handlers.set(channel, handler)
  }
}))
vi.mock('electron', () => ({ ipcMain: { on: () => undefined, handle: () => undefined } }))
vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../db/messages', () => ({ messageRepo: {} }))
vi.mock('../db/chats', () => ({ chatRepo: { getOwned: vi.fn(() => ({ id: 'chat-1' })) } }))
vi.mock('../db/agents', () => ({ a2aSessionRepo: {} }))
vi.mock('../auth/activation', () => ({
  userActivation: { isActivated: () => true, requireActivated: () => undefined }
}))
vi.mock('../auth/scope', () => ({
  getProfileScopeUserId: () => 'profile-user',
  getSettingsScopeUserId: () => 'settings-user'
}))
vi.mock('../services/messageRoutingService', () => ({ messageRoutingService: {} }))
vi.mock('../services/a2aStreamingService', () => ({ a2aStreamingService: {} }))
vi.mock('../services/localAgents/commandService', () => ({ resolveCommandRunner: vi.fn() }))

const findAgent = vi.fn((_s: string, _p: string, agentId: string) => ({
  row: { id: agentId, name: 'Alpha', source: 'folder', driver: 'acp' },
  userId: 'settings-user'
}))
vi.mock('../services/agentService', () => ({
  agentService: { findAgent: (...args: [string, string, string]) => findAgent(...args) }
}))

const remember = vi.fn(() => true)
const resolve = vi.fn((): unknown => ({ chatId: 'chat-1', agentId: 'folder:alpha' }))
vi.mock('../agents/drivers', async () => {
  const { respondToAcpAsk } = await import('../agents/drivers/acp/acpDriver')
  const resolveRequest = (...args: unknown[]): boolean => resolve(...(args as [])) !== null
  const world = {
    rememberGrant: (...args: unknown[]) => remember(...(args as [])) as boolean,
    resolveRequest
  }
  return {
    // The answer path only ever calls `respond`, so the driver here is exactly
    // that — production's own implementation over the same two writers.
    driverFor: () => ({
      respond: (...args: Parameters<typeof respondToAcpAsk> extends [unknown, ...infer R] ? R : never) =>
        respondToAcpAsk(world, ...args)
    }),
    // The production shape: the registry, and a grant writer with no agent to write beside.
    respondToOrphanedAsk: (
      ...args: Parameters<typeof respondToAcpAsk> extends [unknown, ...infer R] ? R : never
    ) => respondToAcpAsk({ rememberGrant: () => false, resolveRequest }, ...args)
  }
})

const ASK = { action: 'webfetch', resources: ['https://docs.example.com/a?v=2'], savable: [] }
const owner = vi.fn((): unknown => ({
  chatId: 'chat-1',
  agentId: 'folder:alpha',
  kind: 'permission' as const,
  request: ASK
}))
vi.mock('../services/agentTurn/pendingRequests', () => ({
  pendingRequests: {
    owner: (...args: unknown[]) => owner(...(args as [])),
    listForChat: vi.fn(() => [])
  }
}))

const { registerA2AHandlers } = await import('./agent_a2a.ipc')

beforeEach(() => {
  handlers.clear()
  remember.mockReset()
  remember.mockReturnValue(true)
  resolve.mockClear()
  owner.mockClear()
  findAgent.mockClear()
  registerA2AHandlers()
})

const answer = async (
  reply: string
): Promise<{ ok: boolean; reason?: string; remembered?: boolean }> =>
  (await handlers.get('agent:answer-request')?.({}, { requestId: 'per_1', reply })) as {
    ok: boolean
    reason?: string
    remembered?: boolean
  }

describe('agent:answer-request — Always allow', () => {
  it('stores the rule against the agent folder and settles the request as once', async () => {
    // Mutation: pass the parsed resolution through unchanged fails this twice —
    // `always` would reach the engine, and nothing would be stored.
    const result = await answer('always')

    expect(remember).toHaveBeenCalledWith('folder:alpha', ASK)
    expect(resolve).toHaveBeenCalledWith('per_1', {
      kind: 'permission',
      reply: 'once',
      remembered: true
    })
    expect(result).toEqual({ ok: true, remembered: true })
  })

  it('still allows the action when the store refuses, and says the rule was not saved', async () => {
    // The user said yes. Failing the action they approved because a preference
    // file would not take the write is the worse half of the trade — but
    // reporting it as remembered would be a lie the agent page would then
    // contradict. Mutation: `remembered: true` regardless fails this.
    // `rememberGrant` reports a refused write as `false` rather than throwing —
    // the store's own failure handling is proven in
    // `permissionGrantService.test.ts` and in that wiring.
    remember.mockReturnValue(false)

    const result = await answer('always')

    expect(resolve).toHaveBeenCalledWith('per_1', {
      kind: 'permission',
      reply: 'once',
      remembered: false
    })
    expect(result).toEqual({ ok: true, remembered: false })
  })

  it('leaves once and reject exactly as the user sent them', async () => {
    // Nothing is stored and nothing is claimed for the other two answers.
    expect(await answer('once')).toEqual({ ok: true })
    expect(resolve).toHaveBeenCalledWith('per_1', { kind: 'permission', reply: 'once' })
    expect(await answer('reject')).toEqual({ ok: true })
    expect(resolve).toHaveBeenLastCalledWith('per_1', { kind: 'permission', reply: 'reject' })
    expect(remember).not.toHaveBeenCalled()
  })

  it('does not invent a grant for a request whose ask was never recorded', async () => {
    // A registry entry with no `request` — an older turn, a replayed
    // registration — must not produce a rule for nothing. The action is still
    // allowed once. Mutation: build the grant from the renderer's payload
    // instead fails this.
    owner.mockReturnValueOnce({
      chatId: 'chat-1',
      agentId: 'folder:alpha',
      kind: 'permission' as const,
      request: undefined
    })

    const result = await answer('always')

    expect(remember).not.toHaveBeenCalled()
    expect(result).toEqual({ ok: true, remembered: false })
  })
})

describe('agent:answer-request — what reaches the driver', () => {
  it('asks the driver of the agent that parked the ask', async () => {
    await answer('once')
    expect(findAgent).toHaveBeenCalledWith('settings-user', 'profile-user', 'folder:alpha')
  })

  it('reports a stale block plainly when nothing is waiting', async () => {
    owner.mockReturnValueOnce(undefined)
    expect(await answer('once')).toEqual({
      ok: false,
      reason: 'This request is no longer waiting for an answer.'
    })
    expect(findAgent).not.toHaveBeenCalled()
  })

  it('reports the same when the park ended between the lookup and the answer', async () => {
    resolve.mockReturnValueOnce(null)
    expect(await answer('once')).toEqual({
      ok: false,
      reason: 'This request is no longer waiting for an answer.'
    })
  })

  it('still delivers an answer when the agent row is gone, and writes no rule', async () => {
    // Removing an agents folder prunes its rows without waiting for the turn
    // lock, so the turn can still be parked. Refusing the answer would leave it
    // stuck until the park timed out. Mutation: return "no longer waiting" when
    // `findAgent` is null (what this handler first did in phase 2) fails this.
    findAgent.mockReturnValueOnce(null as never)
    expect(await answer('always')).toEqual({ ok: true, remembered: false })
    expect(remember).not.toHaveBeenCalled()
    expect(resolve).toHaveBeenCalledWith('per_1', {
      kind: 'permission',
      reply: 'once',
      remembered: false
    })
  })

  it('delivers once and reject unchanged for an agent whose row is gone', async () => {
    findAgent.mockReturnValue(null as never)
    try {
      expect(await answer('reject')).toEqual({ ok: true })
      expect(resolve).toHaveBeenLastCalledWith('per_1', { kind: 'permission', reply: 'reject' })
      expect(await answer('once')).toEqual({ ok: true })
      expect(resolve).toHaveBeenLastCalledWith('per_1', { kind: 'permission', reply: 'once' })
    } finally {
      findAgent.mockImplementation((_s: string, _p: string, agentId: string) => ({
        row: { id: agentId, name: 'Alpha', source: 'folder', driver: 'acp' },
        userId: 'settings-user'
      }))
    }
  })

  it('refuses an answer of the wrong kind before any driver sees it', async () => {
    const result = (await handlers
      .get('agent:answer-request')
      ?.({}, { requestId: 'per_1', answers: [['Teal']] })) as { ok: boolean; reason?: string }
    expect(result).toEqual({ ok: false, reason: 'Malformed answer' })
    expect(findAgent).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
  })
})
