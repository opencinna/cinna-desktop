import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * `resolveTurnRunner` — the one dispatch point, and the place the engine axis
 * stops being a data model and starts choosing what actually runs.
 *
 * It is worth a test of its own because the failure it replaced is silent and
 * permanent. Before the Claude runner existed, a folder agent whose manifest
 * said `engine: "claude"` went to the OpenCode runner, which looked it up in
 * the running engine's config, did not find it (the config generator now skips
 * it deliberately), found no skip reason to explain that, and answered **"This
 * agent is not available in the running engine yet. Try again in a moment."** —
 * every turn, for ever, with nothing anywhere saying why.
 *
 * The whole module graph below `index.ts` is mocked because that module is the
 * production wiring: it names `engineManager`, the database and Electron in one
 * place precisely so nothing else has to. What is under test is the three-way
 * choice, not anything it is wired to.
 */

const state = vi.hoisted(() => ({
  runtime: { engine: 'opencode' } as { engine?: string } | null,
  getThrows: false
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
vi.mock('../localAgents/localAgentService', () => ({
  localAgentService: {
    get: () => {
      if (state.getThrows) throw new Error('not_found')
      return { runtime: state.runtime, kind: 'kit', path: '/agents/a', name: 'A' }
    }
  }
}))
vi.mock('../localAgents/desktopStateService', () => ({ desktopStateService: { read: vi.fn(), patch: vi.fn() } }))
vi.mock('../localAgents/permissionGrantService', () => ({ permissionGrantService: { covers: () => false, remember: vi.fn() } }))
vi.mock('../localAgents/turnLock', () => ({ turnLock: { withLock: vi.fn() } }))
vi.mock('../localAgents/toolDetectionService', () => ({ toolDetectionService: { get: vi.fn() } }))
vi.mock('../localAgents/promptAssembly', () => ({
  assembleAgentPrompt: () => 'prompt',
  assembleBareAgentPrompt: () => 'prompt',
  resolveDesktopPromptContext: () => ({})
}))
vi.mock('../providerService', () => ({ providerService: { listMerged: () => [] } }))
vi.mock('../a2aStreamingService', () => ({ runAgentTurn: vi.fn() }))
vi.mock('../../shell/env', () => ({ getShellEnv: vi.fn(), shellEnvForChild: () => ({}) }))
vi.mock('../../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

const { resolveTurnRunner, localAgentTurnRunner, claudeAgentTurnRunner, a2aTurnRunner } =
  await import('./index')

const folder = { id: 'folder:aaa', source: 'folder' } as never
const remote = { id: 'remote:bbb', source: 'remote' } as never

beforeEach(() => {
  state.runtime = { engine: 'opencode' }
  state.getThrows = false
})

describe('resolveTurnRunner', () => {
  it('sends a non-folder agent to the A2A runner without reading any folder', () => {
    // Dispatch is `source` **then** `engine`: a remote agent has no folder to
    // read, and reading one for it would be a filesystem hit on every turn of
    // an agent this axis has nothing to do with.
    expect(resolveTurnRunner(remote)).toBe(a2aTurnRunner)
  })

  it('sends a folder agent that names no engine to the OpenCode runner', () => {
    state.runtime = null
    expect(resolveTurnRunner(folder)).toBe(localAgentTurnRunner)
  })

  it('sends a folder agent on the Claude engine to the Claude runner', () => {
    // The line this whole test file exists for. Without it the agent goes to
    // the OpenCode runner, which cannot find it in the engine config and says
    // "try again in a moment" for ever.
    state.runtime = { engine: 'claude' }
    expect(resolveTurnRunner(folder)).toBe(claudeAgentTurnRunner)
  })

  it('sends an unrecognised engine to the default runner', () => {
    // The contract's tolerant read, applied at the last place it could still be
    // forgotten: a folder written by a newer tool must keep running.
    state.runtime = { engine: 'codex' }
    expect(resolveTurnRunner(folder)).toBe(localAgentTurnRunner)
  })

  it('falls back to the default runner when the folder cannot be read', () => {
    // **The safe direction, and it is not symmetric.** `localAgentService.get`
    // throws when the row is gone or the manifest is mid-save by an assistant.
    // The OpenCode runner renders every one of those states as a readable turn
    // error; the Claude runner would replace them with "no Claude Code was
    // found on this machine", which is both wrong and unactionable.
    state.getThrows = true
    expect(resolveTurnRunner(folder)).toBe(localAgentTurnRunner)
  })
})
