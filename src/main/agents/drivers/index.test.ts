vi.mock('../../host/desktopFeatures', async () => {
  const context = await import('../../localdev/developmentSessionService')
  const { localDevService } = await import('../../localdev/localDevService')
  return { desktopFeatures: { ...context, developmentExecutionContext: localDevService.executionContext } }
})
vi.mock('../../host/runtimeHost', async () => {
  const { createDesktopHost } = await import('../../host/desktop/runtimeHost')
  return { runtimeHost: createDesktopHost() }
})
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AcpProcessPool } from './acp/types'
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
  utilityPlans: false,
  utilityEngine: 'opencode',
  codexPolicy: vi.fn(),
  liveRows: [] as AgentRow[],
  configInput: null as null | ((userId: string) => Promise<{ agents: { agentId: string; prompt: string; permissions?: Record<string, unknown> | null }[] }>),
  development: false,
  restore: vi.fn(),
  developmentEngine: 'claude',
  developmentComplexity: 'complex',
  codexSettings: null as null | ((userId: string, agentId: string) => { effort: string }),
  developmentPaths: [] as string[],
  handovers: [] as unknown[],
  runtimeModes: [] as unknown[],
  kind: 'kit',
  handbackPlans: [] as boolean[],
  runtime: { engine: 'opencode' } as { engine?: string } | null,
  readiness: 'ok',
  getThrows: false,
  gets: 0,
  ran: [] as string[],
  /** What the download-free look finds, and how often it was asked. */
  known: null as null | { path: string; source: string; version: string | null },
  looks: 0,
  claudeProbeDeps: null as null | { claudePath(): Promise<string | null> },
  claudeOptions: null as null | {
    agentSkillsPlugin?(userId: string, agentId: string): string | null
    systemPrompt(userId: string, agentId: string, mode: string): string
  },
  skillsPluginAsked: [] as unknown[],
  skillsPluginFails: false,
  promptContexts: [] as { ownSkills?: string; tasksSkill?: unknown }[],
  agySystemPrompt: null as null | ((userId: string, agentId: string, mode: 'isolated' | 'native') => string),
  agySettings: null as null | ((userId: string, agentId: string) => unknown),
  /** The agent id each Antigravity `plan` was asked for, in order. */
  agyPlanned: [] as string[],
  pinnedFolders: [] as string[],
  pinnedThrows: false,
  pinnedAsked: 0,
  /** Each launcher `plan` call's `warmOnly`, in order. */
  warmOnlyPlans: [] as boolean[]
}))

vi.mock('../../localdev/developmentSessionService', () => {
  const context = () => ({ profileId: 'profile-1', workspacePath: '/accounts/alice', complexity: state.developmentComplexity, runtime: { launcher: state.developmentEngine } })
  return {
    isDevelopmentAgent: (row: AgentRow) => !!row?.driverConfig?.developmentProfileId,
    contextForDevelopmentAgent: context,
    restoreDevelopmentContext: async (row: AgentRow, options?: { fresh?: boolean }) => { state.restore(row, options); return context() },
    developmentAgentContext: () => state.development ? context() : null,
    developmentPlanKey: (key: string) => key
  }
})
vi.mock('../../localdev/localDevService', () => ({ localDevService: {
  executionContext: async () => ({ env: { PATH: '/managed/tools:/usr/bin' } })
} }))
vi.mock('../../services/customAgentService', () => ({ customAgentService: {
  launcher: { id: 'custom', plan: async () => { state.ran.push('custom'); return { error: 'custom' } } },
  runtime: () => ({ type: 'external', validate() {}, readSession: () => null, saveSession() {}, isGranted: () => false, rememberGrant: () => false })
} }))
vi.mock('./acp/codexConductorPolicy', () => ({ prepareCodexConductorPolicy: async (plan: unknown, root: string) => {
  state.codexPolicy(plan, root)
  return { ...(plan as object), conductorPolicy: 'no-native-tools' }
} }))
vi.mock('./acp/codexLauncher', () => ({ createCodexLauncher: (options: { settings: (userId: string, agentId: string) => { effort: string }; systemPrompt: (userId: string, agentId: string, mode: unknown) => string }) => { state.codexSettings = options.settings; return { id: 'codex',
  plan: async (context: { userId: string; agentId: string; folder: { path: string; runtimeMode?: unknown } }) => {
    if (state.utilityPlans) return { spec: { command: 'codex', args: [], env: { CODEX_CONFIG: JSON.stringify({ developer_instructions: options.systemPrompt(context.userId, context.agentId, context.folder.runtimeMode) }) }, cwd: context.folder.path, key: 'utility-key' }, init: { protocolVersion: 1 }, session: { mcpServers: [] }, setup: {} }
    state.ran.push('codex'); state.developmentPaths.push(context.folder.path)
    state.runtimeModes.push(context.folder.runtimeMode)
    return { error: 'refused by the codex launcher' }
  }
} } }))
vi.mock('./acp/antigravityLauncher', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./acp/antigravityLauncher')>()
  return { ...actual, createAntigravityLauncher: (options: { systemPrompt: (userId: string, agentId: string, mode: 'isolated' | 'native') => string; home?: (userId: string, agentId: string, path: string) => string; settings: (userId: string, agentId: string) => unknown }) => (state.agySystemPrompt = options.systemPrompt, state.agySettings = options.settings, { id: 'antigravity',
    plan: async (context: { userId: string; agentId: string; folder: { path: string; runtimeMode: 'isolated' | 'native' } }) => {
      state.agyPlanned.push(context.agentId)
      if (!state.utilityPlans) return { error: 'refused by the antigravity launcher' }
      const instructions = options.systemPrompt(context.userId, context.agentId, context.folder.runtimeMode)
      const home = options.home?.(context.userId, context.agentId, context.folder.path) ?? actual.antigravityIsolatedHome(context.folder.path)
      return { spec: { command: 'agy', args: [], env: { GEMINI_HOME: home }, cwd: context.folder.path, key: 'utility-key' },
        init: { protocolVersion: 1 }, session: { mcpServers: [], meta: { agy: { disabledTools: ['schedule'] } } },
        firstPromptPreamble: actual.antigravityPreamble(instructions), setup: {} }
    } }) }
})
vi.mock('electron', () => ({ app: { getVersion: () => '0.0.0', getPath: () => '/tmp' } }))
vi.mock('../../engine/binaryResolver', () => ({
  configuredEnginePath: () => null,
  realBinaryResolverDeps: () => ({}),
  // The managed Codex CLI's half of the same module: the wiring under test
  // reads these to build the Codex service and its login probe.
  configuredCodexPath: () => null,
  realCodexResolverDeps: () => ({}),
  // …and the pinned Claude Code's, on the same terms.
  configuredClaudePath: () => null,
  realClaudeResolverDeps: () => ({}),
  // …and the Antigravity server's.
  configuredAntigravityPath: () => null,
  realAntigravityResolverDeps: () => ({}),
  binaryFingerprint: async () => null,
  // What the binary services' own wiring reads: the download-free look, the
  // used-stamp and the pinned asset's size.
  knownRuntimeBinary: async () => { state.looks++; return state.known },
  markUsed: async () => undefined,
  pinnedAssetBytes: () => null,
  resolveEngineBinaryWith: async () => ({ path: '/bin/opencode', source: 'path', version: '1.0.0' })
}))
vi.mock('../../engine/engineConfigSource', () => ({
  collectEngineConfigInput: async () => ({ providers: [], agents: [] })
}))
vi.mock('../../db/agents', () => ({ agentRepo: { getOwned: (_userId: string, agentId: string) => state.liveRows.find((row) => row.id === agentId), list: () => state.liveRows }, agentSessionRepo: { getByChatAndAgent: vi.fn(), upsert: vi.fn() } }))
vi.mock('../../db/chats', () => ({ chatRepo: { getOwned: (_userId: string, chatId: string) => ({ id: chatId, deletedAt: null }) } }))
vi.mock('../../auth/scope', () => ({ getSettingsScopeUserId: () => 'user-1' }))
vi.mock('../../auth/cinna-oauth', () => ({ CinnaReauthRequired: class CinnaReauthRequired extends Error {} }))
vi.mock('../../services/agentSkillsPlugin', () => ({
  ensureKitAgentSkillsPlugin: (agent: { id: string; path: string }) => {
    state.skillsPluginAsked.push(agent)
    return state.skillsPluginFails ? null : { dir: '/userData/cinna-plugins/agents/key', skills: ['pdf-tools'] }
  },
  kitAgentPinnedSkillFolders: () => {
    state.pinnedAsked++
    if (state.pinnedThrows) throw new Error('the cache could not be read')
    return state.pinnedFolders
  }
}))
vi.mock('../../services/localAgents/localAgentService', () => ({
  localAgentService: {
    locate: () => ({ root: { id: 'root-1' }, agentDir: '/agents/a' }),
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
  assembleAgentPrompt: (_dir: string, _manifest: unknown, context: { ownSkills?: string }) => {
    state.promptContexts.push(context)
    return 'prompt'
  },
  assembleBareNativePrompt: (_dir: string, _name: string, context: { tasksSkill?: unknown }) => {
    state.promptContexts.push(context)
    return 'prompt'
  },
  resolveDesktopPromptContext: (engine?: string) => (engine === 'claude' ? { ownSkills: 'skill' }
    : engine === 'antigravity' ? { ownSkills: 'pointer', tasksSkill: { kind: 'pointer', path: '/kit/skills/cinna-tasks/SKILL.md' } } : {})
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
  const marker = (id: string) => (options?: { configInput?: typeof state.configInput }) => {
    if (id === 'opencode') state.configInput = options?.configInput ?? null
    if (id === 'claude') state.claudeOptions = options as unknown as typeof state.claudeOptions
    return ({
    id,
    plan: async (context: { warmOnly?: boolean; folder: { coordinatorHandback?: boolean; path: string; runtimeMode?: unknown } }) => {
      state.warmOnlyPlans.push(context.warmOnly === true)
      if (state.utilityPlans) return { spec: { command: id, args: [], env: {}, cwd: context.folder.path, key: 'utility-key' }, init: { protocolVersion: 1 }, session: { mcpServers: [] }, setup: { configOptions: [{ configId: 'mode', value: 'utility' }] } }
      state.developmentPaths.push(context.folder.path)
      state.handbackPlans.push(context.folder.coordinatorHandback === true)
      state.runtimeModes.push(context.folder.runtimeMode)
      state.ran.push(id)
      return { error: `refused by the ${id} launcher` }
    }
  }) }
  return {
    ...original,
    createOpencodeLauncher: marker('opencode'),
    createClaudeLauncher: marker('claude')
  }
})
vi.mock('./acp/claudeAgents', () => ({ readFolderAgents: () => ({ agents: {} }) }))
vi.mock('./acp/claudeAuth', () => ({
  ClaudeAuthProbe: class {
    constructor(deps: { claudePath(): Promise<string | null> }) { state.claudeProbeDeps = deps }
    status = async (): Promise<{ state: string }> => ({ state: 'unknown' })
    refresh = async (): Promise<{ state: string }> => ({ state: 'unknown' })
  }
}))
vi.mock('./acp/claudeEnv', () => ({ buildClaudeEnv: () => ({}) }))
vi.mock('../../services/localAgents/runtimeService', () => ({
  runtimeService: { resolve: () => ({ launcher: state.utilityEngine, modelId: 'sonnet', credentialId: null }) }
}))
vi.mock('../../shell/env', () => ({ getShellEnv: vi.fn(), shellEnvForChild: () => ({}) }))
vi.mock('../../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

const { driverFor, prepareAiFunctionRuntime, acpProcessPool, acpLauncherFor } = await import('./index')
const { TITLE_SYSTEM_PROMPT } = await import('../../services/aiFunctionPrompts')
const { desktopStateService } = await import('../../services/localAgents/desktopStateService')

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
  vi.restoreAllMocks()
  state.utilityPlans = false; state.utilityEngine = 'opencode'; state.liveRows = []; state.warmOnlyPlans = []
  state.restore.mockClear()
  state.codexPolicy.mockClear()
  state.development = false; state.developmentComplexity = 'complex'; state.developmentPaths = []
  state.runtime = { engine: 'opencode' }
  state.readiness = 'ok'
  state.getThrows = false
  state.gets = 0
  state.ran = []
  state.handovers = []; state.kind = 'kit'; state.handbackPlans = []; state.runtimeModes = []
})

describe('an Antigravity chat runtime’s launch', () => {
  it('runs its sessions in the empty process folder, its home beside it, never the chat folder', async () => {
    // Mutation: drop the wrapper's `sessionCwd` and sessions run in the chat
    // folder; the home's place is the layout the lead chose (beside the folder).
    state.utilityPlans = true
    const agent: AgentRow = { ...folderRow('antigravity'), id: 'conductor:agy', source: 'local', enabled: true,
      driverConfig: { launcher: 'antigravity', conductorChatId: 'chat-agy', conductorEngine: 'antigravity',
        cwd: '/owned/chat-agy', conductorPrompt: 'Chat instructions' } }
    state.liveRows = [agent]
    const plan = await acpLauncherFor('antigravity')!.plan({ userId: 'user-1', agentId: agent.id, folder: {
      name: 'Chat', slug: 'chat', description: '', path: '/owned/chat-agy', kind: 'bare', runtimeMode: 'isolated' } })
    if ('error' in plan) throw new Error(plan.error)
    expect(plan.sessionCwd).toMatch(/\/chat-conductors\/processes\/[0-9a-f]{64}$/)
    expect(plan.spec.cwd).toBe(plan.sessionCwd)
    expect(plan.spec.env.GEMINI_HOME).toBe(`${plan.sessionCwd}.agyhome`)
    expect(plan.firstPromptPreamble).toContain('Chat instructions')
  })
})

describe('driverFor', () => {
  it.each([
    ['Codex cannot enforce the chat tool policy: only the verified Codex CLI version is supported. Choose Claude or OpenCode.',
      'Codex cannot enforce the chat tool policy: only the verified Codex CLI version is supported. Choose Claude or OpenCode.'],
    ['private CLI config: secret-token', 'Codex chat policy could not be verified. Check the installed runtime.']
  ])('surfaces a safe synthetic Codex policy refusal through the production driver (%s)', async (reason, expected) => {
    state.utilityPlans = true
    const agent: AgentRow = { ...folderRow('codex'), id: 'conductor:error', source: 'local', enabled: true,
      driverConfig: { launcher: 'codex', conductorChatId: turn.chatId, conductorEngine: 'codex',
        cwd: '/tmp/conductor-error', conductorPrompt: 'Chat instructions' } }
    state.liveRows = [agent]
    state.codexPolicy.mockImplementationOnce(() => { throw new Error(reason) })
    const result = await driverFor(agent).run('user-1', agent, turn)
    expect(result.error?.message).toBe(expected)
    expect(state.codexPolicy).toHaveBeenCalledOnce()
    expect(result.error?.raw).not.toContain('secret-token')
  })

  it('does not seal ordinary folder Codex launches with the synthetic chat policy', async () => {
    state.runtime = { engine: 'codex' }
    state.kind = 'bare'
    const agent = folderRow('codex')
    state.liveRows = [agent]
    const result = await driverFor(agent).run('user-1', agent, turn)
    expect(result.error?.message).toBe('refused by the codex launcher')
    expect(state.runtimeModes).toEqual(['native'])
    expect(state.codexPolicy).not.toHaveBeenCalled()
  })

  it.each([['simple', 'low'], ['medium', 'medium'], ['complex', 'high']])('passes %s build complexity to Codex as %s effort', (complexity, effort) => {
    state.development = true
    state.developmentComplexity = complexity
    expect(state.codexSettings?.('user-1', 'builder').effort).toBe(effort)
    expect(state.gets).toBe(0)
  })
  it('forwards the chat readiness freshness flag through production builder runtime wiring', async () => {
    state.development = true
    const row: AgentRow = { ...folderRow('custom'), id: 'builder', source: 'local', enabled: true,
      driverConfig: { launcher: 'custom', developmentProfileId: 'profile-1' } }
    const driver = driverFor(row)
    await driver.readiness('user-1', row, { fresh: true })
    expect(state.restore).toHaveBeenLastCalledWith(row, { fresh: true })
    await driver.readiness('user-1', row)
    expect(state.restore).toHaveBeenLastCalledWith(row, undefined)
  })

  it.each(['claude', 'codex', 'opencode'])('runs an account builder through its selected %s runtime in the CLI workspace', async (engine) => {
    state.development = true
    state.developmentEngine = engine
    const row = { ...folderRow('custom'), source: 'local', enabled: true,
      driverConfig: { launcher: 'custom', command: ['cinna-development-session'], developmentProfileId: 'profile-1' } } as AgentRow
    expect(await ranFor(row)).toEqual([engine])
    expect(state.developmentPaths).toEqual(['/accounts/alice'])
    expect(state.gets).toBe(0)
  })

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

  it('gives an adopted bare folder the native runtime and a kit folder the isolated one', async () => {
    // The whole of file-handovers phase 1, decided **here** rather than in a
    // launcher: `runtimeMode` is what the Claude launcher forks its session
    // options on, so this is the line that says a repository the user adopted
    // runs on its own settings, hooks and MCP servers and a scaffolded kit
    // folder does not.
    state.runtime = { engine: 'claude' }
    state.kind = 'bare'
    await ranFor(folderRow('claude'))
    state.kind = 'kit'
    await ranFor(folderRow('claude'))
    expect(state.runtimeModes).toEqual(['native', 'isolated'])
  })

  it('keeps Cinna’s own build session isolated, though its folder view says bare', async () => {
    // The build session's workspace is a folder **the desktop synced**, not a
    // repository the user adopted: its prompt is the one
    // `developmentContext` assembled, and a `.claude/settings.json` that
    // happened to arrive in that workspace must not become this session's
    // permission mode or MCP set. Its view says `kind: 'bare'` because there
    // is no manifest, which is exactly why the launchers read the derived mode
    // instead. Mutation: derive the mode from the kind and this session picks
    // up the folder's runtime.
    state.development = true
    state.developmentEngine = 'claude'
    const row = { ...folderRow('custom'), source: 'local', enabled: true,
      driverConfig: { launcher: 'custom', command: ['cinna-development-session'], developmentProfileId: 'profile-1' } } as AgentRow
    expect(await ranFor(row)).toEqual(['claude'])
    expect(state.runtimeModes).toEqual(['isolated'])
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

  it('runs an engine a folder cannot use on OpenCode, not on the row or the machine default', async () => {
    // A folder written by a newer tool. `runtime.engine` is a preference, never
    // refused: an engine this build cannot run a folder on — `gemini` has no
    // launcher, `custom` belongs to external agents — runs on OpenCode.
    for (const engine of ['gemini', 'custom']) {
      state.ran = []
      state.runtime = { engine }
      expect(await ranFor(folderRow('claude')), engine).toEqual(['opencode'])
    }
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


describe('a kit agent’s own skills on Claude', () => {
  it('asks the one shared plugin builder with the same identity OpenCode’s config uses', () => {
    // Both callers write one folder; a launcher that built it from its own
    // slug or skill set (it once used the folder basename and a separate scan)
    // flapped the plugin's name and contents against the OpenCode config.
    // engineConfigSource.test.ts asserts the same `{ id, path }` on its side.
    state.liveRows = [folderRow('claude')]
    state.skillsPluginAsked = []
    state.skillsPluginFails = false
    expect(state.claudeOptions?.agentSkillsPlugin?.('user-1', 'folder:aaa')).toBe('/userData/cinna-plugins/agents/key')
    expect(state.skillsPluginAsked).toEqual([{ id: 'folder:aaa', path: '/agents/a' }])
  })

  it('points the prompt at each SKILL.md when the plugin could not be written', () => {
    // Mutation: keep `skill` regardless and the prompt promises a skill tool
    // entry the session was never given.
    state.liveRows = [folderRow('claude')]
    state.promptContexts = []
    state.skillsPluginFails = false
    state.claudeOptions?.systemPrompt('user-1', 'folder:aaa', 'isolated')
    state.skillsPluginFails = true
    state.claudeOptions?.systemPrompt('user-1', 'folder:aaa', 'isolated')
    state.skillsPluginFails = false
    expect(state.promptContexts.map((context) => context.ownSkills)).toEqual(['skill', 'pointer'])
  })
})

describe('the cinna-tasks skill on Antigravity', () => {
  it('is named as a skill in an isolated folder, where it is installed, and a path in a native one', () => {
    // Mutation: drop the override and an isolated agent is pointed at a file
    // outside its workspace, which `view_file` refuses to read.
    state.liveRows = [folderRow('antigravity')]
    state.promptContexts = []
    state.agySystemPrompt?.('user-1', 'folder:aaa', 'isolated')
    state.agySystemPrompt?.('user-1', 'folder:aaa', 'native')
    expect(state.promptContexts.map((context) => context.tasksSkill)).toEqual([
      { kind: 'skill' }, { kind: 'pointer', path: '/kit/skills/cinna-tasks/SKILL.md' }
    ])
  })
})

describe('the Antigravity folder policy’s inputs', () => {
  beforeEach(() => {
    state.pinnedFolders = ['/cache/catalog/word-count']; state.pinnedThrows = false; state.pinnedAsked = 0; state.agyPlanned = []
    vi.mocked(desktopStateService.read).mockReturnValue({ antigravityApproval: 'ask' } as never)
  })
  const settings = (agentId = 'folder:aaa'): unknown => state.agySettings!('user-1', agentId)

  it('gives a kit agent on Ask its pinned skills’ folders, and a bare one none', () => {
    // Mutation: drop `autoApprove` from the folder branch and no ask is settled.
    expect(settings()).toEqual({ model: 'sonnet', approval: 'ask', autoApprove: { scriptRoots: ['/cache/catalog/word-count'] } })
    state.kind = 'bare'
    expect(settings()).toEqual({ model: 'sonnet', approval: 'ask', autoApprove: { scriptRoots: [] } })
    expect(state.pinnedAsked).toBe(1)
  })

  it('gives no folders when they cannot be read, and no policy on Automatic', () => {
    state.pinnedThrows = true
    expect(settings()).toMatchObject({ autoApprove: { scriptRoots: [] } })
    vi.mocked(desktopStateService.read).mockReturnValue({ antigravityApproval: 'auto' } as never)
    expect(settings()).not.toHaveProperty('autoApprove')
  })

  it('gives none to a conductor or a build session', () => {
    state.liveRows = [{ id: 'conductor:agy', driver: 'acp', driverConfig: { conductorChatId: 'chat', conductorEngine: 'antigravity',
      conductorModel: 'flash', conductorPrompt: 'Chat', cwd: '/owned/chat' } } as unknown as AgentRow]
    expect(settings('conductor:agy')).not.toHaveProperty('autoApprove')
    state.liveRows = []
    state.development = true
    expect(settings()).not.toHaveProperty('autoApprove')
  })

  it('gives none to a chat runtime or an AI function', async () => {
    state.utilityPlans = true
    const agent: AgentRow = { ...folderRow('antigravity'), id: 'conductor:agy', source: 'local', enabled: true,
      driverConfig: { launcher: 'antigravity', conductorChatId: 'chat-agy', conductorEngine: 'antigravity', cwd: '/owned/chat-agy', conductorPrompt: 'Chat' } }
    state.liveRows = [agent]
    await acpLauncherFor('antigravity')!.plan({ userId: 'user-1', agentId: agent.id, folder: {
      name: 'Chat', slug: 'chat', description: '', path: '/owned/chat-agy', kind: 'bare', runtimeMode: 'isolated' } })
    expect(state.agySettings!('user-1', state.agyPlanned.at(-1)!)).not.toHaveProperty('autoApprove')
    state.liveRows = []
    state.utilityEngine = 'antigravity'
    const utility = await prepareAiFunctionRuntime('user-1', 'Summarize.', false)
    expect(state.agySettings!('user-1', utility.poolKey)).not.toHaveProperty('autoApprove')
  })
})

describe('the login probe’s binary', () => {
  it('is the one the Runtime row found — an exact-version PATH copy included — from one shared look', async () => {
    // Before: the probe asked the disk without probing PATH, so this user's
    // login read `unknown` beside a row that had probed PATH and said "ready".
    state.known = { path: '/real/claude/versions/2.1.276', source: 'path-pinned', version: '2.1.276 (Claude Code)' }
    state.looks = 0
    const { claudeBinaryService } = await import('../../engine/engineBinaryService')
    expect(await state.claudeProbeDeps?.claudePath()).toBe('/real/claude/versions/2.1.276')
    expect(await state.claudeProbeDeps?.claudePath()).toBe('/real/claude/versions/2.1.276')
    expect(claudeBinaryService.state()).toMatchObject({ state: 'ready', source: 'path-pinned' })
    expect(state.looks).toBe(1)
  })
})

describe('AI function runtime production prompt wiring', () => {
  beforeEach(() => { state.utilityPlans = true })

  it('keys OpenCode by exact system prompt and puts it in the generated utility agent', async () => {
    const first = await prepareAiFunctionRuntime('prompt-profile', 'Write a summary.', false)
    const repeated = await prepareAiFunctionRuntime('prompt-profile', 'Write a summary.', false)
    const second = await prepareAiFunctionRuntime('prompt-profile', 'Write a review.', false)
    expect(first.poolKey).toBe(repeated.poolKey)
    expect(first.cwd).toBe(repeated.cwd)
    expect(second.poolKey).not.toBe(first.poolKey)
    const config = await state.configInput!('prompt-profile')
    expect(config.agents.find(agent => agent.agentId === first.poolKey)?.prompt).toBe('Write a summary.')
    expect(config.agents.find(agent => agent.agentId === second.poolKey)?.prompt).toBe('Write a review.')
  })

  it('only title instructions may reuse the fixed no-tools companion on a warm chat process', async () => {
    state.liveRows = [{ id: 'chat-root', driver: 'acp', driverConfig: {
      conductorChatId: 'chat', conductorEngine: 'opencode', conductorModel: 'sonnet',
      conductorPrompt: 'Chat instructions', cwd: '/owned/chat'
    } } as unknown as AgentRow]
    vi.spyOn(acpProcessPool, 'status').mockImplementation(id => ({ state: id === 'chat-root' ? 'running' : 'stopped' }) as ReturnType<typeof acpProcessPool.status>)
    vi.spyOn(acpProcessPool as Required<Pick<AcpProcessPool, 'peek'>>, 'peek').mockReturnValue({} as never)
    const title = await prepareAiFunctionRuntime('warm-profile', TITLE_SYSTEM_PROMPT, true)
    expect(title.poolKey).toMatch(/^chat-runtime:/)
    // Mutation: drop `warmOnly` from the plan and a background title on a
    // fresh profile starts OpenCode's database bootstrap engine.
    expect(state.warmOnlyPlans).toEqual([true])
    const config = await state.configInput!('warm-profile')
    expect(config.agents.find(agent => agent.agentId === `${title.poolKey}:utility`)?.prompt).toBe(TITLE_SYSTEM_PROMPT)
    // The chat runtime's replace policy reaches Cinna's tools through Code Mode's `execute`.
    expect(config.agents.find(agent => agent.agentId === 'chat-root')?.permissions)
      .toEqual({ '*': 'deny', 'cinna_*': 'allow', execute: 'allow', question: 'allow' })
    await expect(prepareAiFunctionRuntime('warm-profile', 'Draft new instructions.', true)).rejects.toThrow('deferred')
    const draft = await prepareAiFunctionRuntime('warm-profile', 'Draft new instructions.', false)
    expect(draft.poolKey).toMatch(/^ai-function:/)
    expect(state.warmOnlyPlans).toEqual([true, false])
  })

  it('Claude keeps the function prompt in its per-session system prompt', async () => {
    state.utilityEngine = 'claude'
    const first = await prepareAiFunctionRuntime('claude-profile', 'Summarize.', false)
    const second = await prepareAiFunctionRuntime('claude-profile', 'Review.', false)
    expect(first.poolKey).toBe(second.poolKey)
    expect(first.cwd).not.toBe(second.cwd)
    expect(first.plan.session.meta).toMatchObject({ claudeCode: { options: { systemPrompt: 'Summarize.', tools: [] } } })
    expect(second.plan.session.meta).toMatchObject({ claudeCode: { options: { systemPrompt: 'Review.', tools: [] } } })
  })

  it('verifies the Codex policy and gives shared-process functions independent system prompts and folders', async () => {
    state.utilityEngine = 'codex'
    const first = await prepareAiFunctionRuntime('codex-profile', 'Summarize.', false)
    const second = await prepareAiFunctionRuntime('codex-profile', 'Review.', false)
    expect(first.poolKey).toBe(second.poolKey)
    expect(first.cwd).not.toBe(second.cwd)
    expect(first.plan.spec.cwd).toBe(second.plan.spec.cwd)
    expect(state.codexPolicy).toHaveBeenCalledTimes(2)
    expect(first.plan.session.meta).toMatchObject({ cinna: { systemPrompt: 'Summarize.' } })
    expect(second.plan.session.meta).toMatchObject({ cinna: { systemPrompt: 'Review.' } })
    expect(first.plan.session.mcpServers).toEqual([])
    expect(first.plan.conductorPolicy).toBe('no-native-tools')
  })

  it('gives Antigravity functions their own instructions as the preamble, every built-in off, in a profile-owned process folder', async () => {
    // Mutation: leave Antigravity out of the preamble override and a function
    // reusing a chat's process runs on that chat's instructions.
    state.utilityEngine = 'antigravity'
    const first = await prepareAiFunctionRuntime('agy-profile', 'Summarize.', false)
    const second = await prepareAiFunctionRuntime('agy-profile', 'Review.', false)
    expect(first.poolKey).toBe(second.poolKey)
    expect(first.plan.spec.cwd).toBe(second.plan.spec.cwd)
    expect(first.plan.spec.cwd).toContain('/chat-conductors/processes/')
    expect(first.plan.firstPromptPreamble).toContain('<instructions>\nSummarize.\n</instructions>')
    expect(second.plan.firstPromptPreamble).toContain('<instructions>\nReview.\n</instructions>')
    expect(first.plan.session.meta).toMatchObject({ agy: { enabledTools: ['view_file'] } })
    expect((first.plan.session.meta?.agy as { disabledTools: string[] }).disabledTools).toContain('run_command')
    expect(first.plan.session.mcpServers).toEqual([])
    // The session runs in the empty process folder, its home beside it.
    expect(first.cwd).toBe(first.plan.spec.cwd)
    expect(first.plan.spec.env.GEMINI_HOME).toBe(`${first.cwd}.agyhome`)
  })

  it('opens a function on a warm Antigravity chat process with the function’s instructions, not the chat’s', async () => {
    state.utilityEngine = 'antigravity'
    state.liveRows = [{ id: 'agy-chat-root', driver: 'acp', driverConfig: {
      conductorChatId: 'chat', conductorEngine: 'antigravity', conductorModel: 'sonnet',
      conductorPrompt: 'Private chat instructions', cwd: '/owned/agy-chat'
    } } as unknown as AgentRow]
    vi.spyOn(acpProcessPool, 'status').mockImplementation(id => ({ state: id === 'agy-chat-root' ? 'running' : 'stopped' }) as ReturnType<typeof acpProcessPool.status>)
    vi.spyOn(acpProcessPool as Required<Pick<AcpProcessPool, 'peek'>>, 'peek').mockReturnValue({} as never)
    const title = await prepareAiFunctionRuntime('agy-warm-profile', TITLE_SYSTEM_PROMPT, true)
    expect(title.poolKey).toMatch(/^chat-runtime:/)
    expect(title.plan.firstPromptPreamble).toContain(TITLE_SYSTEM_PROMPT)
    expect(title.plan.firstPromptPreamble).not.toContain('Private chat instructions')
  })

  it('reuses a compatible warm Codex chat process with the function instructions and no MCP tools', async () => {
    state.utilityEngine = 'codex'
    state.liveRows = [{ id: 'codex-chat-root', driver: 'acp', driverConfig: {
      conductorChatId: 'chat', conductorEngine: 'codex', conductorModel: 'sonnet',
      conductorPrompt: 'Private chat instructions', cwd: '/owned/codex-chat'
    } } as unknown as AgentRow]
    vi.spyOn(acpProcessPool, 'status').mockImplementation(id => ({ state: id === 'codex-chat-root' ? 'running' : 'stopped' }) as ReturnType<typeof acpProcessPool.status>)
    vi.spyOn(acpProcessPool as Required<Pick<AcpProcessPool, 'peek'>>, 'peek').mockReturnValue({} as never)
    const title = await prepareAiFunctionRuntime('codex-warm-profile', TITLE_SYSTEM_PROMPT, true)
    expect(title.poolKey).toMatch(/^chat-runtime:/)
    expect(title.plan.session.meta).toMatchObject({ cinna: { systemPrompt: TITLE_SYSTEM_PROMPT } })
    expect(title.plan.session.mcpServers).toEqual([])
    expect(title.cwd).not.toBe('/owned/codex-chat')
    expect(title.plan.spec.cwd).toContain('/chat-conductors/processes/')
    expect(state.codexPolicy).toHaveBeenCalledTimes(1)
  })
})
