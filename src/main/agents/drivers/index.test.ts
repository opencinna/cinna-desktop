import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentRow } from '../../db/agents'

/**
 * `driverFor` and the production wiring behind it — the dispatch point, and
 * the place the engine axis stops being a data model and starts choosing what
 * actually runs.
 *
 * It replaces `resolveTurnRunner`'s test and keeps every scenario it had,
 * because the failure it guards is silent and permanent. Before the Claude
 * runner existed, a folder agent whose manifest said `engine: "claude"` went to
 * the OpenCode runner, which looked it up in the running engine's config, did
 * not find it (the config generator skips it deliberately), found no skip
 * reason to explain that, and answered **"This agent is not available in the
 * running engine yet. Try again in a moment."** — every turn, for ever, with
 * nothing anywhere saying why. The row now names a driver, and a stale one is
 * exactly how that failure would come back; so the folder drivers check the
 * folder on every turn, and this file pins it through the real wiring.
 *
 * The whole module graph below `index.ts` is mocked because that module is the
 * production wiring: it names `engineManager`, the database and Electron in one
 * place precisely so nothing else has to. The runners are replaced by markers
 * that say which one ran.
 */

const state = vi.hoisted(() => ({
  runtime: { engine: 'opencode' } as { engine?: string } | null,
  readiness: 'ok',
  getThrows: false,
  gets: 0,
  ran: [] as string[]
}))

vi.mock('electron', () => ({ app: { getVersion: () => '0.0.0', getPath: () => '/tmp' } }))
vi.mock('../../engine/engineManager', () => ({
  engineManager: {
    request: vi.fn(),
    onStateChange: vi.fn(),
    ensureRunning: vi.fn(),
    agentKey: vi.fn(),
    agentModel: vi.fn(),
    lastSkips: () => ({ agents: [] })
  }
}))
vi.mock('../../db/agents', () => ({ a2aSessionRepo: { getByChatAndAgent: vi.fn(), upsert: vi.fn() } }))
vi.mock('../../auth/scope', () => ({ getSettingsScopeUserId: () => 'user-1' }))
vi.mock('../../auth/cinna-oauth', () => ({ CinnaReauthRequired: class CinnaReauthRequired extends Error {} }))
vi.mock('../../services/localAgents/localAgentService', () => ({
  localAgentService: {
    get: () => {
      state.gets++
      if (state.getThrows) throw new Error('not_found')
      return {
        name: 'A',
        path: '/agents/a',
        kind: 'kit',
        enabled: true,
        readiness: state.readiness,
        readinessReason: null,
        runtime: state.runtime
      }
    }
  }
}))
vi.mock('../../services/localAgents/desktopStateService', () => ({
  desktopStateService: { read: vi.fn(), patch: vi.fn() }
}))
vi.mock('../../services/localAgents/permissionGrantService', () => ({
  permissionGrantService: { covers: () => false, remember: vi.fn() }
}))
vi.mock('../../services/localAgents/turnLock', () => ({ turnLock: { withLock: vi.fn() } }))
vi.mock('../../services/localAgents/toolDetectionService', () => ({ toolDetectionService: { get: vi.fn() } }))
vi.mock('../../services/localAgents/promptAssembly', () => ({
  assembleAgentPrompt: () => 'prompt',
  assembleBareAgentPrompt: () => 'prompt',
  resolveDesktopPromptContext: () => ({})
}))
vi.mock('../../services/providerService', () => ({ providerService: { listMerged: () => [] } }))
vi.mock('../../services/a2aStreamingService', () => ({
  runAgentTurn: vi.fn(async () => {
    state.ran.push('a2a')
    return { text: '', parts: [], notices: [] }
  })
}))
vi.mock('./a2aConnection', () => ({
  resolveEndpointIfNeeded: async () => 'https://agents.example/rpc',
  resolveAccessToken: async () => undefined
}))
vi.mock('../../services/agentTurn/localAgentTurnRunner', () => ({
  LocalAgentTurnRunner: class {
    async runTurn() {
      state.ran.push('opencode')
      return { text: '', parts: [], notices: [] }
    }
  }
}))
vi.mock('../../services/agentTurn/claudeAgentTurnRunner', () => ({
  ClaudeAgentTurnRunner: class {
    async runTurn() {
      state.ran.push('claude')
      return { text: '', parts: [], notices: [] }
    }
  }
}))
vi.mock('../../shell/env', () => ({ getShellEnv: vi.fn(), shellEnvForChild: () => ({}) }))
vi.mock('../../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

const { driverFor } = await import('./index')

const folderRow = (driver: string | null): AgentRow =>
  ({ id: 'folder:aaa', name: 'A', source: 'folder', driver, cardUrl: null }) as unknown as AgentRow
const remote = {
  id: 'remote:bbb',
  name: 'B',
  source: 'remote',
  driver: 'a2a',
  cardUrl: 'https://agents.example/card'
} as unknown as AgentRow

const turn = { chatId: 'chat-1', wireContent: 'hi', signal: new AbortController().signal }

async function ranFor(agent: AgentRow): Promise<string[]> {
  await driverFor(agent).run('user-1', agent, turn)
  return state.ran
}

beforeEach(() => {
  state.runtime = { engine: 'opencode' }
  state.readiness = 'ok'
  state.getThrows = false
  state.gets = 0
  state.ran = []
})

describe('driverFor', () => {
  it('sends an A2A row to the A2A driver without reading any folder', async () => {
    // A remote agent has no folder to read, and reading one for it would be a
    // filesystem hit on every turn of an agent this axis has nothing to do with.
    expect(driverFor(remote).id).toBe('a2a')
    expect(await ranFor(remote)).toEqual(['a2a'])
    expect(state.gets).toBe(0)
  })

  it('answers by the row, and the same driver every time', () => {
    expect(driverFor(folderRow('claude')).id).toBe('claude')
    expect(driverFor(folderRow('opencode'))).toBe(driverFor(folderRow('opencode')))
    // Not set: a folder row falls back to the default engine.
    expect(driverFor(folderRow(null)).id).toBe('opencode')
  })

  it('runs a folder agent that names no engine on OpenCode', async () => {
    state.runtime = null
    expect(await ranFor(folderRow('opencode'))).toEqual(['opencode'])
  })

  it('runs a folder agent on the Claude engine on Claude, even while its row still says OpenCode', async () => {
    // The line this whole test file exists for. Without the reconcile the turn
    // goes to the OpenCode runner, which cannot find it in the engine config
    // and says "try again in a moment" for ever.
    state.runtime = { engine: 'claude' }
    expect(await ranFor(folderRow('opencode'))).toEqual(['claude'])
    state.ran = []
    expect(await ranFor(folderRow('claude'))).toEqual(['claude'])
  })

  it('runs an unrecognised engine on the default runner', async () => {
    // The contract's tolerant read: a folder written by a newer tool must keep running.
    state.runtime = { engine: 'codex' }
    expect(await ranFor(folderRow('claude'))).toEqual(['opencode'])
  })

  it('keeps the row’s driver when the folder cannot be read', async () => {
    // `localAgentService.get` throws when the row is gone or the folder moved.
    // Both runners now render that as the same readable turn error, so the row
    // — the scanner's last good read — decides.
    state.getThrows = true
    expect(await ranFor(folderRow('claude'))).toEqual(['claude'])
    state.ran = []
    expect(await ranFor(folderRow('opencode'))).toEqual(['opencode'])
  })

  it('answers an unknown request with nothing delivered, through the real registry', () => {
    expect(
      driverFor(folderRow('opencode')).respond(
        { requestId: 'per_nobody', chatId: 'chat-1', agentId: 'folder:aaa', kind: 'permission' },
        { kind: 'permission', reply: 'once' }
      )
    ).toEqual({ delivered: false })
  })
})
