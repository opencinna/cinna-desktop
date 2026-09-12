import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentRow } from '../../db/agents'

/**
 * `driverFor` and the production wiring behind it — the dispatch point, and
 * the place the engine axis stops being a data model and starts choosing what
 * actually runs.
 *
 * It replaces `resolveTurnRunner`'s test and keeps every scenario it had,
 * because the failure it guards is silent and permanent. Before the Claude
 * engine existed, a folder agent whose manifest said `engine: "claude"` went to
 * the OpenCode runner, which looked it up in the running engine's config, did
 * not find it (the config generator skips it deliberately), found no skip
 * reason to explain that, and answered **"This agent is not available in the
 * running engine yet. Try again in a moment."** — every turn, for ever, with
 * nothing anywhere saying why.
 *
 * Since phase 3 there is one driver for every folder agent and the engine is a
 * **launcher** under it, so the same failure would now be a turn planned by the
 * wrong launcher. That is what these tests watch: the launchers are replaced by
 * markers that record which one was asked to plan, and each refuses, so the
 * turn's own error says which engine the driver chose.
 *
 * The whole module graph below `index.ts` is mocked because that module is the
 * production wiring: it names the binary resolver, the database and Electron in
 * one place precisely so nothing else has to.
 */

const state = vi.hoisted(() => ({
  handovers: [] as unknown[],
  kind: 'kit',
  handbackPlans: [] as boolean[],
  runtime: { engine: 'opencode' } as { engine?: string } | null,
  readiness: 'ok',
  getThrows: false,
  gets: 0,
  ran: [] as string[]
}))

vi.mock('electron', () => ({ app: { getVersion: () => '0.0.0', getPath: () => '/tmp' } }))
vi.mock('../../engine/binaryResolver', () => ({
  configuredEnginePath: () => null,
  realBinaryResolverDeps: () => ({}),
  resolveEngineBinaryWith: async () => ({ path: '/bin/opencode', source: 'path', version: '1.0.0' })
}))
vi.mock('../../engine/engineConfigSource', () => ({
  collectEngineConfigInput: async () => ({ providers: [], agents: [] })
}))
vi.mock('../../db/agents', () => ({ agentSessionRepo: { getByChatAndAgent: vi.fn(), upsert: vi.fn() } }))
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
        kind: state.kind,
        manifest: { handovers: state.handovers },
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
/**
 * `snapshot` as well as `get`: the ACP driver asks this machine's Default
 * Runtime what a folder that names no engine runs on, and that answer is the
 * last finished detection pass read synchronously. Empty here — these tests are
 * about dispatch, and an empty snapshot is the historical default (OpenCode),
 * which is what the engine assertions below expect.
 */
vi.mock('../../services/localAgents/toolDetectionService', () => ({
  toolDetectionService: { get: vi.fn(), snapshot: () => [] }
}))
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
/**
 * The launchers, as markers.
 *
 * Each records that it was asked and then refuses, so a turn never spawns
 * anything and its error names the engine the driver picked. `plan` is the one
 * method the driver calls before it touches a process, which is exactly the
 * decision under test.
 */
vi.mock('./acp/acpLaunchers', async (importOriginal) => {
  const original = await importOriginal<typeof import('./acp/acpLaunchers')>()
  const marker = (id: string) => () => ({
    id,
    plan: async (context: { folder: { coordinatorHandback?: boolean } }) => {
      state.handbackPlans.push(context.folder.coordinatorHandback === true)
      state.ran.push(id)
      return { error: `refused by the ${id} launcher` }
    }
  })
  return {
    ...original,
    createOpencodeLauncher: marker('opencode'),
    createClaudeLauncher: marker('claude')
  }
})
vi.mock('./acp/claudeAgents', () => ({ readFolderAgents: () => ({ agents: {} }) }))
vi.mock('./acp/claudeAuth', () => ({
  ClaudeAuthProbe: class {
    status = async (): Promise<{ state: string }> => ({ state: 'unknown' })
    refresh = async (): Promise<{ state: string }> => ({ state: 'unknown' })
  }
}))
vi.mock('./acp/claudeEnv', () => ({ buildClaudeEnv: () => ({}) }))
vi.mock('../../services/localAgents/runtimeService', () => ({
  runtimeService: { resolve: () => ({ modelId: 'sonnet' }) }
}))
vi.mock('../../shell/env', () => ({ getShellEnv: vi.fn(), shellEnvForChild: () => ({}) }))
vi.mock('../../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

const { driverFor } = await import('./index')

const folderRow = (launcher: string | null): AgentRow =>
  ({
    id: 'folder:aaa',
    name: 'A',
    source: 'folder',
    driver: 'acp',
    driverConfig: launcher ? { launcher } : null,
    cardUrl: null
  }) as unknown as AgentRow
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
  state.handovers = []; state.kind = 'kit'; state.handbackPlans = []
})

describe('driverFor', () => {
  it('sends an A2A row to the A2A driver without reading any folder', async () => {
    // A remote agent has no folder to read, and reading one for it would be a
    // filesystem hit on every turn of an agent this axis has nothing to do with.
    expect(driverFor(remote).id).toBe('a2a')
    expect(await ranFor(remote)).toEqual(['a2a'])
    expect(state.gets).toBe(0)
  })

  it('sends every folder agent to the one ACP driver, and the same instance every time', () => {
    expect(driverFor(folderRow('claude')).id).toBe('acp')
    expect(driverFor(folderRow('opencode'))).toBe(driverFor(folderRow('claude')))
    // Not set: a folder row still runs on the ACP driver.
    expect(driverFor(folderRow(null)).id).toBe('acp')
  })

  it.each([null, '', 'future-driver'])('refuses driver %s without reading a folder or dispatching', async (driver) => {
    const agent = { ...folderRow('claude'), driver }
    const chosen = driverFor(agent)
    expect(chosen.id).toBe('unsupported')
    expect(await chosen.readiness('user-1', agent)).toMatchObject({ state: 'invalid' })
    expect((await chosen.run('user-1', agent, turn)).error?.code).toBe('unsupported_driver')
    expect(state.ran).toEqual([])
    expect(state.gets).toBe(0)
    expect(agent.driver).toBe(driver)
  })

  it('reads the exact handback declaration afresh and never grants it to a bare folder', async () => {
    state.handovers = [{ target_slug: 'coordinator' }]
    await ranFor(folderRow('opencode'))
    state.handovers = [{ target_slug: 'coordinator', target_kind: 'future-role' }]
    await ranFor(folderRow('opencode'))
    state.handovers = [{ target_slug: 'coordinator', target_kind: 'coordinator' }]
    await ranFor(folderRow('opencode'))
    state.handovers = []
    await ranFor(folderRow('opencode'))
    state.handovers = [{ target_slug: 'coordinator', target_kind: 'coordinator' }]
    state.kind = 'bare'
    await ranFor(folderRow('opencode'))
    expect(state.handbackPlans).toEqual([false, false, true, false, false])
  })

  it('launches a folder agent that names no engine on OpenCode', async () => {
    state.runtime = null
    expect(await ranFor(folderRow('opencode'))).toEqual(['opencode'])
  })

  it('launches a Claude folder on Claude, even while its row still says OpenCode', async () => {
    // The line this whole test file exists for. The row is a cache of the
    // folder's own answer, and a stale one used to send the turn to an engine
    // that could not find the agent and said "try again in a moment" for ever.
    state.runtime = { engine: 'claude' }
    expect(await ranFor(folderRow('opencode'))).toEqual(['claude'])
    state.ran = []
    expect(await ranFor(folderRow('claude'))).toEqual(['claude'])
  })

  it('refuses an engine this build has no launcher for, in words, launching nothing', async () => {
    // A folder written by a newer tool. Running it on the default engine would
    // be worse than saying so: the agent would answer as something it is not.
    state.runtime = { engine: 'gemini' }
    const result = await driverFor(folderRow('claude')).run('user-1', folderRow('claude'), turn)
    expect(result.error?.message).toMatch(/does not support/)
    expect(state.ran).toEqual([])
  })

  it('refuses a folder it cannot read, launching nothing', async () => {
    // `localAgentService.get` throws when the row is gone or the folder moved.
    // The driver renders that as the runners' own sentence rather than guessing
    // an engine from a row it can no longer check.
    state.getThrows = true
    const result = await driverFor(folderRow('claude')).run('user-1', folderRow('claude'), turn)
    expect(result.error?.message).toMatch(/folder could not be found/)
    expect(state.ran).toEqual([])
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
