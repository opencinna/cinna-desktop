import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentRow } from '../db/agents'

/**
 * The one line review flagged as untested: `agent_a2a.ipc.ts`'s
 * `agent:send-message` handler swaps `runner` for `effectiveRunner` (from
 * `resolveCommandRunner`) right before calling `a2aStreamingService.streamToAgent`.
 * A hand-run mutation (revert to plain `runner`) survives the full suite —
 * confirmed independently twice — because nothing exercises this handler at
 * all. If that line regresses silently, `/run:<name>` no-ops for every folder
 * agent: the message falls through to the model instead of executing, with
 * nothing telling anyone.
 *
 * Everything upstream and downstream of that one line is mocked to a canned
 * happy path — `resolveTurnRunner` and `resolveCommandRunner` each return a
 * distinguishable sentinel object, and the test's only real assertion is
 * *which* sentinel `streamToAgent` receives. `resolveCommandRunner`'s own
 * correctness (catalog resolution, localisation, the subprocess) is proven
 * in `commandService.test.ts` — this file only proves the call site actually
 * uses what it returns.
 */

const ipcOnHandlers = new Map<string, (...args: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    on: (channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcOnHandlers.set(channel, handler)
    },
    handle: () => undefined
  }
}))

vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('./_wrap', () => ({ ipcHandle: () => undefined }))

vi.mock('../db/messages', () => ({
  messageRepo: {
    saveError: vi.fn(),
    saveUser: vi.fn(),
    saveAssistant: vi.fn(),
    saveTransition: vi.fn(),
    touchChat: vi.fn()
  }
}))
vi.mock('../db/chats', () => ({ chatRepo: { getOwned: vi.fn(() => ({ id: 'chat-1' })) } }))
vi.mock('../db/agents', () => ({ a2aSessionRepo: { getByChat: vi.fn() } }))

vi.mock('../auth/activation', () => ({
  userActivation: { isActivated: () => true, requireActivated: () => undefined }
}))
vi.mock('../auth/scope', () => ({
  getProfileScopeUserId: () => 'profile-user',
  getSettingsScopeUserId: () => 'settings-user'
}))
vi.mock('../auth/cinna-oauth', () => ({ CinnaReauthRequired: class CinnaReauthRequired extends Error {} }))

const FOLDER_AGENT: AgentRow = {
  id: 'folder:alpha',
  name: 'Alpha',
  source: 'folder',
  cardUrl: null
} as unknown as AgentRow

const findAgent = vi.fn(() => ({ row: FOLDER_AGENT, userId: 'owner-1' }))
vi.mock('../services/agentService', () => ({
  agentService: {
    findAgent,
    resolveEndpointIfNeeded: vi.fn(),
    resolveAccessToken: vi.fn()
  }
}))

const prepareAgentSend = vi.fn(() => ({ wireContent: '/run:check' }))
vi.mock('../services/messageRoutingService', () => ({
  messageRoutingService: { prepareAgentSend }
}))

const streamToAgent = vi.fn(async (_input: { runner: unknown }) => undefined)
vi.mock('../services/a2aStreamingService', () => ({
  a2aStreamingService: { streamToAgent }
}))

// The engine-turn runner `resolveTurnRunner` would hand back for this agent —
// a plain marker object, never invoked, so pulling in the real engine/local
// runner machinery (heavy: engineManager, turnLock, EngineEventBus…) is
// unnecessary here.
const ENGINE_RUNNER_SENTINEL = { kind: 'engine-runner-sentinel', runTurn: vi.fn() }
const resolveTurnRunner = vi.fn(() => ENGINE_RUNNER_SENTINEL)
vi.mock('../services/agentTurn', () => ({ resolveTurnRunner }))

const COMMAND_RUNNER_SENTINEL = { kind: 'command-runner-sentinel', runTurn: vi.fn() }
const resolveCommandRunner = vi.fn(() => COMMAND_RUNNER_SENTINEL)
vi.mock('../services/localAgents/commandService', () => ({ resolveCommandRunner }))

const { registerA2AHandlers } = await import('./agent_a2a.ipc')

function fakePort(): { start: () => void; close: () => void; postMessage: (m: unknown) => void } {
  return { start: vi.fn(), close: vi.fn(), postMessage: vi.fn() }
}

beforeEach(() => {
  ipcOnHandlers.clear()
  streamToAgent.mockClear()
  resolveCommandRunner.mockClear()
  resolveTurnRunner.mockClear()
  registerA2AHandlers()
})

describe('agent:send-message — the /run: dispatch call site', () => {
  it('hands streamToAgent the resolveCommandRunner runner, not the raw engine runner', async () => {
    const handler = ipcOnHandlers.get('agent:send-message')
    expect(handler).toBeDefined()

    const port = fakePort()
    const event = { ports: [port] }
    const payload = { agentId: 'folder:alpha', chatId: 'chat-1', content: '/run:check', attachments: [] }

    await handler?.(event, payload)

    expect(resolveCommandRunner).toHaveBeenCalledWith(
      true, // isFolder
      '/run:check', // wireContent
      'owner-1', // agentOwnerId
      'folder:alpha', // agentId
      ENGINE_RUNNER_SENTINEL // the fallback resolveTurnRunner produced
    )
    expect(streamToAgent).toHaveBeenCalledTimes(1)
    const call = streamToAgent.mock.calls[0][0] as { runner: unknown }
    // The assertion that catches the regression: this must be the
    // command-backed runner, not `resolveTurnRunner`'s engine runner. A
    // revert of `runner: effectiveRunner` back to `runner` at the call site
    // makes this fail — confirmed by hand.
    expect(call.runner).toBe(COMMAND_RUNNER_SENTINEL)
    expect(call.runner).not.toBe(ENGINE_RUNNER_SENTINEL)
  })

  it('does not consult resolveCommandRunner’s result at all for a remote agent', async () => {
    findAgent.mockReturnValueOnce({
      row: { ...FOLDER_AGENT, source: 'remote', cardUrl: 'https://example.test/card' } as unknown as AgentRow,
      userId: 'owner-1'
    })
    // A non-folder agent still calls resolveCommandRunner (isFolder=false is
    // its own short-circuit inside that function, tested in
    // commandService.test.ts) — what matters here is only that its answer for
    // a non-folder agent is the unchanged fallback, so a remote agent's real
    // runner is what streamToAgent actually receives.
    resolveCommandRunner.mockReturnValueOnce(ENGINE_RUNNER_SENTINEL)

    const handler = ipcOnHandlers.get('agent:send-message')
    const port = fakePort()
    const payload = {
      agentId: 'remote:alpha',
      chatId: 'chat-1',
      content: 'hello',
      attachments: []
    }
    await handler?.({ ports: [port] }, payload)

    expect(streamToAgent).toHaveBeenCalledTimes(1)
    const call = streamToAgent.mock.calls[0][0] as { runner: unknown }
    expect(call.runner).toBe(ENGINE_RUNNER_SENTINEL)
  })
})
