import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * `agent:answer-request` — where a user's *Always allow* becomes a rule.
 *
 * This handler is the only place `always` is allowed to mean anything, and it
 * has two jobs that must not come apart:
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
 * Everything around those two facts is mocked to a canned happy path. The
 * grant store's own correctness lives in `permissionGrantService.test.ts`, and
 * resolving an agent id to its folder in `services/agentTurn/index.ts`.
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
vi.mock('../auth/cinna-oauth', () => ({
  CinnaReauthRequired: class CinnaReauthRequired extends Error {}
}))
vi.mock('../services/agentService', () => ({ agentService: {} }))
vi.mock('../services/messageRoutingService', () => ({ messageRoutingService: {} }))
vi.mock('../services/a2aStreamingService', () => ({ a2aStreamingService: {} }))
const remember = vi.fn(() => true)
vi.mock('../services/agentTurn', () => ({
  resolveTurnRunner: vi.fn(),
  rememberPermissionGrant: (...args: unknown[]) => remember(...(args as []))
}))
vi.mock('../services/localAgents/commandService', () => ({ resolveCommandRunner: vi.fn() }))

const ASK = { action: 'webfetch', resources: ['https://docs.example.com/a?v=2'], savable: [] }
const owner = vi.fn(() => ({
  chatId: 'chat-1',
  agentId: 'folder:alpha',
  kind: 'permission' as const,
  request: ASK
}))
const resolve = vi.fn(() => ({ chatId: 'chat-1', agentId: 'folder:alpha' }))
vi.mock('../services/agentTurn/pendingRequests', () => ({
  pendingRequests: {
    owner: (...args: unknown[]) => owner(...(args as [])),
    resolve: (...args: unknown[]) => resolve(...(args as [])),
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
  registerA2AHandlers()
})

const answer = async (reply: string): Promise<{ ok: boolean; remembered?: boolean }> =>
  (await handlers.get('agent:answer-request')?.({}, { requestId: 'per_1', reply })) as {
    ok: boolean
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
    // `rememberPermissionGrant` reports a refused write as `false` rather than
    // throwing — the store's own failure handling is proven in
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
    await answer('once')
    expect(resolve).toHaveBeenCalledWith('per_1', { kind: 'permission', reply: 'once' })
    await answer('reject')
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
      request: undefined as unknown as typeof ASK
    })

    const result = await answer('always')

    expect(remember).not.toHaveBeenCalled()
    expect(result).toEqual({ ok: true, remembered: false })
  })
})
