import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentRow } from '../db/agents'
import { capabilitiesFor } from '../agents/drivers/capabilities'

/**
 * The one line review flagged as untested: `agent_a2a.ipc.ts`'s
 * `agent:send-message` handler hands `streamToAgent` the turn
 * `resolveCommandRunner` returned — not the driver's own. A hand-run mutation
 * (pass the driver's turn instead) survived the full suite — confirmed
 * independently twice — because nothing exercised this handler at all. If that
 * line regresses silently, `/run:<name>` no-ops for every folder agent: the
 * message falls through to the model instead of executing, with nothing
 * telling anyone.
 *
 * Everything upstream and downstream of that one line is mocked to a canned
 * happy path — `resolveCommandRunner` returns a distinguishable sentinel, and
 * the test's real assertion is *which* turn `streamToAgent` receives.
 * `resolveCommandRunner`'s own correctness (catalog resolution, localisation,
 * the subprocess) is proven in `commandService.test.ts` — this file only proves
 * the call site asks it with the driver's capability and uses what it returns.
 *
 * Since phase 2 the fallback is the agent's driver, bound to this turn, so the
 * file also proves that binding: the owner scope, the row and the message the
 * driver is given.
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

const FOLDER_AGENT: AgentRow = {
  id: 'folder:alpha',
  name: 'Alpha',
  source: 'folder',
  driver: 'opencode',
  cardUrl: null
} as unknown as AgentRow

const REMOTE_AGENT: AgentRow = {
  id: 'remote:alpha',
  name: 'Alpha',
  source: 'remote',
  driver: 'a2a',
  cardUrl: 'https://example.test/card'
} as unknown as AgentRow

const findAgent = vi.fn(() => ({ row: FOLDER_AGENT, userId: 'owner-1' }))
vi.mock('../services/agentService', () => ({ agentService: { findAgent } }))

const prepareAgentSend = vi.fn(() => ({ wireContent: '/run:check' }))
vi.mock('../services/messageRoutingService', () => ({
  messageRoutingService: { prepareAgentSend }
}))

const streamToAgent = vi.fn(async (_input: { run: unknown }) => undefined)
vi.mock('../services/a2aStreamingService', () => ({
  a2aStreamingService: { streamToAgent }
}))

// The driver `driverFor` hands back: real capabilities (pure), a recorded run.
// Pulling in the real drivers — the ACP process pool, the turn lock, the binary
// resolver — would be a child process and a database for a test about dispatch.
const driverRun = vi.fn(async () => ({ text: '', parts: [], notices: [] }))
const driverFor = vi.fn(() => ({
  id: 'acp',
  capabilities: (row: AgentRow) => capabilitiesFor(row),
  run: driverRun,
  readiness: vi.fn(),
  respond: vi.fn()
}))
vi.mock('../agents/drivers', () => ({ driverFor }))

const COMMAND_RUN_SENTINEL = vi.fn()
const resolveCommandRunner = vi.fn((..._args: unknown[]): unknown => COMMAND_RUN_SENTINEL)
vi.mock('../services/localAgents/commandService', () => ({ resolveCommandRunner }))

const { registerA2AHandlers } = await import('./agent_a2a.ipc')

function fakePort(): { start: () => void; close: () => void; postMessage: (m: unknown) => void } {
  return { start: vi.fn(), close: vi.fn(), postMessage: vi.fn() }
}

type BoundTurn = (io: { signal: AbortSignal; onEvent: (e: unknown) => void }) => Promise<unknown>

beforeEach(() => {
  ipcOnHandlers.clear()
  streamToAgent.mockClear()
  resolveCommandRunner.mockClear()
  driverRun.mockClear()
  registerA2AHandlers()
})

describe('agent:send-message — the /run: dispatch call site', () => {
  it('hands streamToAgent the resolveCommandRunner turn, not the driver’s own', async () => {
    const handler = ipcOnHandlers.get('agent:send-message')
    expect(handler).toBeDefined()

    const port = fakePort()
    const event = { ports: [port] }
    const payload = { agentId: 'folder:alpha', chatId: 'chat-1', content: '/run:check', attachments: [] }

    await handler?.(event, payload)

    expect(resolveCommandRunner).toHaveBeenCalledWith(
      'catalog', // the driver's capabilities.commands for a folder agent
      '/run:check', // wireContent
      'owner-1', // agentOwnerId
      'folder:alpha', // agentId
      expect.any(Function) // the driver's turn, bound
    )
    expect(streamToAgent).toHaveBeenCalledTimes(1)
    const call = streamToAgent.mock.calls[0][0] as { run: unknown }
    // The assertion that catches the regression: this must be the
    // command-backed turn, not the driver's. Passing the fallback straight to
    // `streamToAgent` makes this fail.
    expect(call.run).toBe(COMMAND_RUN_SENTINEL)
    expect(driverRun).not.toHaveBeenCalled()

    // And the fallback it was offered is this agent's driver, bound to this turn.
    const fallback = resolveCommandRunner.mock.calls[0][4] as BoundTurn
    const io = { signal: new AbortController().signal, onEvent: vi.fn() }
    await fallback(io)
    expect(driverRun).toHaveBeenCalledWith('owner-1', FOLDER_AGENT, {
      chatId: 'chat-1',
      wireContent: '/run:check',
      fileIds: [],
      signal: io.signal,
      onEvent: io.onEvent
    })
  })

  it('asks with the remote agent’s capability, and streams the driver’s turn it gets back', async () => {
    findAgent.mockReturnValueOnce({ row: REMOTE_AGENT, userId: 'owner-1' })
    prepareAgentSend.mockReturnValueOnce({ wireContent: 'hello' })
    // A card agent's commands are not intercepted: `resolveCommandRunner` hands
    // the fallback straight back (its own short-circuit, tested in
    // commandService.test.ts) — what matters here is that the remote agent's
    // real turn is what `streamToAgent` actually receives.
    resolveCommandRunner.mockImplementationOnce((...args: unknown[]) => args[4])

    const handler = ipcOnHandlers.get('agent:send-message')
    const port = fakePort()
    const payload = { agentId: 'remote:alpha', chatId: 'chat-1', content: 'hello', attachments: [] }
    await handler?.({ ports: [port] }, payload)

    expect(resolveCommandRunner.mock.calls[0][0]).toBe('card')
    expect(streamToAgent).toHaveBeenCalledTimes(1)
    const call = streamToAgent.mock.calls[0][0] as { run: BoundTurn }
    expect(call.run).not.toBe(COMMAND_RUN_SENTINEL)
    await call.run({ signal: new AbortController().signal, onEvent: vi.fn() })
    expect(driverRun).toHaveBeenCalledWith(
      'owner-1',
      REMOTE_AGENT,
      expect.objectContaining({ chatId: 'chat-1', wireContent: 'hello' })
    )
  })
})
