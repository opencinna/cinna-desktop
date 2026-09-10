import { describe, it, expect, vi } from 'vitest'
import type { AgentRow } from '../../db/agents'
import type { RunAgentTurnInput } from '../../services/a2aStreamingService'
import { describeEngineSkip } from '../../../shared/runtimeMessages'
import type { RequestResolution } from '../../../shared/localAgentRequests'
import { createOpencodeDriver } from './opencodeDriver'
import { createClaudeDriver, type ClaudeDriverDeps } from './claudeDriver'
import { FOLDER_NOT_FOUND, type FolderDriver, type FolderDriverDeps, type FolderView } from './folderDriver'
import type { ParkedAsk } from './driver'

vi.mock('../../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

/**
 * The two folder drivers: the reconcile that replaced `resolveTurnRunner`'s
 * engine read, the folder half of readiness, and the answer path that turns
 * *Always allow* into a rule.
 */

const AGENT = { id: 'folder:alpha', name: 'Alpha', source: 'folder', driver: 'opencode' } as AgentRow

const folder = (over: Partial<FolderView> = {}): FolderView => ({
  name: 'Alpha',
  enabled: true,
  readiness: 'ok',
  readinessReason: null,
  runtime: null,
  ...over
})

interface World {
  opencode: FolderDriver
  claude: FolderDriver
  ran: { driver: string; input: RunAgentTurnInput }[]
  claudePath: ReturnType<typeof vi.fn>
}

function world(
  view: FolderView | null | (() => FolderView | null) = folder(),
  over: Partial<ClaudeDriverDeps> = {}
): World {
  const ran: World['ran'] = []
  const runner = (driver: string): FolderDriverDeps['runner'] => ({
    runTurn: async (input) => {
      ran.push({ driver, input })
      return { text: driver, parts: [], notices: [] }
    }
  })
  const shared = {
    readFolder: typeof view === 'function' ? view : () => view,
    rememberGrant: () => true,
    resolveRequest: () => true,
    sibling: (id: 'opencode' | 'claude') => drivers[id]
  }
  const claudePath = vi.fn(async () => '/usr/local/bin/claude')
  const drivers = {
    opencode: createOpencodeDriver({ ...shared, runner: runner('opencode') }),
    claude: createClaudeDriver({
      ...shared,
      runner: runner('claude'),
      claudePath,
      claudeAuth: async () => ({ state: 'logged_in', authMethod: null, subscriptionType: null, email: null }),
      ...over
    })
  }
  return { ...drivers, ran, claudePath }
}

const turn = { chatId: 'chat-1', wireContent: 'hello', signal: new AbortController().signal }

describe('folder drivers — run', () => {
  it('runs its own runner with the row’s id and name and the turn’s input', async () => {
    const w = world()
    const onEvent = vi.fn()
    const result = await w.opencode.run('user-1', AGENT, { ...turn, fileIds: ['f1'], onEvent })
    expect(result.text).toBe('opencode')
    expect(w.ran).toEqual([
      {
        driver: 'opencode',
        input: {
          chatId: 'chat-1',
          agentId: 'folder:alpha',
          agentName: 'Alpha',
          wireContent: 'hello',
          fileIds: ['f1'],
          signal: turn.signal,
          onEvent
        }
      }
    ])
  })

  it('hands the turn to the other engine when the folder now names it', async () => {
    // The stored driver is a cache of the manifest. Without the reconcile, a
    // folder switched to Claude a moment ago runs on OpenCode, which cannot
    // find it in the engine config and says "try again in a moment" for ever.
    const w = world(folder({ runtime: { engine: 'claude' } }))
    await w.opencode.run('user-1', AGENT, turn)
    expect(w.ran.map((r) => r.driver)).toEqual(['claude'])
  })

  it('and back again, without a second read deciding for a third time', async () => {
    let reads = 0
    const w = world(() => {
      reads++
      return folder({ runtime: { engine: 'opencode' } })
    })
    await w.claude.run('user-1', { ...AGENT, driver: 'claude' } as AgentRow, turn)
    expect(w.ran.map((r) => r.driver)).toEqual(['opencode'])
    expect(reads).toBe(1)
  })

  it('keeps the stored driver when the folder cannot be read', async () => {
    const w = world(null)
    await w.claude.run('user-1', { ...AGENT, driver: 'claude' } as AgentRow, turn)
    expect(w.ran.map((r) => r.driver)).toEqual(['claude'])
  })

  it('keeps the stored driver while the folder is invalid, even though its runtime reads as none', async () => {
    // A manifest is unparseable for a moment every time an assistant saves it.
    // Its runtime is then null — the default engine — and moving a Claude agent
    // for that moment gains nothing: both runners refuse an invalid folder.
    const w = world(folder({ readiness: 'invalid', runtime: null }))
    await w.claude.run('user-1', { ...AGENT, driver: 'claude' } as AgentRow, turn)
    expect(w.ran.map((r) => r.driver)).toEqual(['claude'])
  })

  it('reads an unrecognised engine as the default one', async () => {
    const w = world(folder({ runtime: { engine: 'codex' } }))
    await w.claude.run('user-1', { ...AGENT, driver: 'claude' } as AgentRow, turn)
    expect(w.ran.map((r) => r.driver)).toEqual(['opencode'])
  })

  it('runs here when it has no sibling to hand to', async () => {
    const ran: string[] = []
    const driver = createOpencodeDriver({
      runner: { runTurn: async () => (ran.push('opencode'), { text: '', parts: [], notices: [] }) },
      readFolder: () => folder({ runtime: { engine: 'claude' } }),
      rememberGrant: () => true,
      resolveRequest: () => true
    })
    await driver.run('user-1', AGENT, turn)
    expect(ran).toEqual(['opencode'])
  })
})

describe('folder drivers — readiness', () => {
  it.each([
    ['ok', null, { state: 'ok', reason: null }],
    ['credentials_needed', 'Add VENDOR_TOKEN.', { state: 'credentials_needed', reason: 'Add VENDOR_TOKEN.' }],
    ['contract_too_new', 'Update the app.', { state: 'contract_too_new', reason: 'Update the app.' }],
    ['invalid', null, { state: 'invalid', reason: 'This agent’s folder is not in a state it can be run from.' }],
    ['something_new', null, { state: 'invalid', reason: 'This agent’s folder is not in a state it can be run from.' }]
  ] as const)('reports a folder that is %s', async (readiness, readinessReason, expected) => {
    const w = world(folder({ readiness, readinessReason }))
    await expect(w.opencode.readiness('user-1', AGENT)).resolves.toEqual(expected)
  })

  it('reports a folder that cannot be found in the runners’ own words', async () => {
    await expect(world(null).opencode.readiness('user-1', AGENT)).resolves.toEqual({
      state: 'invalid',
      reason: FOLDER_NOT_FOUND
    })
  })

  it('never throws, even when the folder read does', async () => {
    const w = world(() => {
      throw new Error('EACCES')
    })
    await expect(w.opencode.readiness('user-1', AGENT)).resolves.toEqual({
      state: 'invalid',
      reason: FOLDER_NOT_FOUND
    })
  })

  it('asks a Claude folder about the CLI only once the folder itself is ready', async () => {
    const w = world(folder({ readiness: 'credentials_needed', readinessReason: 'Add X.' }))
    await expect(w.claude.readiness('user-1', AGENT)).resolves.toEqual({
      state: 'credentials_needed',
      reason: 'Add X.'
    })
    expect(w.claudePath).not.toHaveBeenCalled()
  })

  it('says there is no Claude Code on this machine', async () => {
    const w = world(folder(), { claudePath: async () => null })
    await expect(w.claude.readiness('user-1', AGENT)).resolves.toEqual({
      state: 'not_installed',
      reason: describeEngineSkip('claude_not_installed')
    })
  })

  it('says the install is logged out only when the probe is sure', async () => {
    const out = world(folder(), {
      claudeAuth: async () => ({ state: 'logged_out', authMethod: 'none', subscriptionType: null, email: null })
    })
    await expect(out.claude.readiness('user-1', AGENT)).resolves.toEqual({
      state: 'not_logged_in',
      reason: describeEngineSkip('claude_not_logged_in')
    })

    // `unknown` — and a probe that failed outright — never block.
    const unknown = world(folder(), {
      claudeAuth: async () => ({ state: 'unknown', authMethod: null, subscriptionType: null, email: null })
    })
    await expect(unknown.claude.readiness('user-1', AGENT)).resolves.toEqual({ state: 'ok', reason: null })
    const failed = world(folder(), { claudeAuth: () => Promise.reject(new Error('timed out')) })
    await expect(failed.claude.readiness('user-1', AGENT)).resolves.toEqual({ state: 'ok', reason: null })
  })

  it('does not ask an OpenCode folder about Claude at all', async () => {
    const w = world(folder())
    await expect(w.opencode.readiness('user-1', AGENT)).resolves.toEqual({ state: 'ok', reason: null })
    expect(w.claudePath).not.toHaveBeenCalled()
  })
})

describe('folder drivers — respond', () => {
  const REQUEST = { action: 'webfetch', resources: ['https://docs.example.com/a'], savable: [] }
  const ask = (over: Partial<ParkedAsk> = {}): ParkedAsk => ({
    requestId: 'per_1',
    chatId: 'chat-1',
    agentId: 'folder:alpha',
    kind: 'permission',
    request: REQUEST as unknown as ParkedAsk['request'],
    ...over
  })

  function answering(remembered = true, delivered = true) {
    const order: string[] = []
    const rememberGrant = vi.fn(() => (order.push('remember'), remembered))
    const resolveRequest = vi.fn((_id: string, _r: RequestResolution) => (order.push('resolve'), delivered))
    const driver = createOpencodeDriver({
      runner: { runTurn: vi.fn() },
      readFolder: () => folder(),
      rememberGrant,
      resolveRequest
    })
    return { driver, order, rememberGrant, resolveRequest }
  }

  it('says nothing was delivered when nothing waits on that id', () => {
    const { driver } = answering(true, false)
    expect(driver.respond(ask(), { kind: 'permission', reply: 'once' })).toEqual({ delivered: false })
  })

  it('stores Always as a rule first, then settles the park as once', () => {
    // Mutation: pass the resolution through unchanged — `always` would reach
    // the engine, which stores a user-global grant, and nothing would be kept
    // beside the agent.
    const { driver, order, rememberGrant, resolveRequest } = answering()
    const outcome = driver.respond(ask(), { kind: 'permission', reply: 'always' })
    expect(rememberGrant).toHaveBeenCalledWith('folder:alpha', REQUEST)
    expect(resolveRequest).toHaveBeenCalledWith('per_1', { kind: 'permission', reply: 'once', remembered: true })
    expect(order).toEqual(['remember', 'resolve'])
    expect(outcome).toEqual({ delivered: true, remembered: true })
  })

  it('still allows the action when the store refuses, and says the rule was not saved', () => {
    const { driver, resolveRequest } = answering(false)
    expect(driver.respond(ask(), { kind: 'permission', reply: 'always' })).toEqual({
      delivered: true,
      remembered: false
    })
    expect(resolveRequest).toHaveBeenCalledWith('per_1', { kind: 'permission', reply: 'once', remembered: false })
  })

  it('invents no grant for an ask that was never recorded', () => {
    const { driver, rememberGrant } = answering()
    expect(driver.respond(ask({ request: undefined }), { kind: 'permission', reply: 'always' })).toEqual({
      delivered: true,
      remembered: false
    })
    expect(rememberGrant).not.toHaveBeenCalled()
  })

  it('passes once, reject and a question’s answers through untouched, claiming nothing', () => {
    const { driver, rememberGrant, resolveRequest } = answering()
    expect(driver.respond(ask(), { kind: 'permission', reply: 'once' })).toEqual({ delivered: true })
    expect(driver.respond(ask(), { kind: 'permission', reply: 'reject' })).toEqual({ delivered: true })
    const answers: RequestResolution = { kind: 'question', answers: [['Teal']] }
    expect(driver.respond(ask({ kind: 'question', requestId: 'que_1' }), answers)).toEqual({ delivered: true })
    expect(resolveRequest.mock.calls).toEqual([
      ['per_1', { kind: 'permission', reply: 'once' }],
      ['per_1', { kind: 'permission', reply: 'reject' }],
      ['que_1', answers]
    ])
    expect(rememberGrant).not.toHaveBeenCalled()
  })

  it('answers the same way from either folder driver', () => {
    const order: string[] = []
    const deps = {
      runner: { runTurn: vi.fn() },
      readFolder: () => folder(),
      rememberGrant: () => (order.push('remember'), true),
      resolveRequest: () => (order.push('resolve'), true),
      claudePath: async () => null,
      claudeAuth: async () => ({ state: 'unknown' as const, authMethod: null, subscriptionType: null, email: null })
    }
    expect(createClaudeDriver(deps).respond(ask(), { kind: 'permission', reply: 'always' })).toEqual({
      delivered: true,
      remembered: true
    })
    expect(order).toEqual(['remember', 'resolve'])
  })
})
