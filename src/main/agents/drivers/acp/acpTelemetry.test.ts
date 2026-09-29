import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionTelemetryChange } from '../../../../shared/sessionTelemetry'
import {
  ApiDurationReadings,
  authKindOf,
  canonicalModelId,
  codexTelemetryAuth,
  costDelta,
  CostReadings,
  fingerprintDigest,
  isSessionLive,
  ModelCostReadings,
  noteSessionLive,
  PriceCalibration,
  parsePromptTelemetry,
  readAuthStatus,
  sessionFingerprint,
  telemetryAuthOf,
  TurnTelemetry
} from './acpTelemetry'
import type { AcpConnection } from './types'
import { readSdkMessage } from './acpSdkTelemetry'
import { assistantMessage, compactMessage, initMessage, resultMessage, sdkParams } from './testSupport/sdkMessageFixtures'
import { clearLogEntries, getLogEntries, setDebugEnabled } from '../../../logger/logger'

/**
 * The literal prompt-response shapes of the pinned adapters
 * (`claude-agent-acp` 0.76.0 `turnOutcome`; `codex-acp` `buildQuotaMeta`).
 */
const q = (inputTokens: number, cachedInputTokens: number, cachedWriteTokens: number, outputTokens: number) => ({
  totalTokens: inputTokens + cachedInputTokens + cachedWriteTokens + outputTokens,
  inputTokens, cachedInputTokens, cachedWriteTokens, outputTokens, reasoningOutputTokens: 0
})

const CLAUDE_RESPONSE = {
  stopReason: 'end_turn',
  // Main loop only.
  usage: { inputTokens: 10, outputTokens: 200, cachedReadTokens: 30_000, cachedWriteTokens: 1_500, totalTokens: 31_710 },
  _meta: {
    quota: {
      token_count: q(10, 30_000, 1_500, 200),
      model_usage: [
        { model: 'claude-sonnet-5[1m]', token_count: q(10, 30_000, 1_500, 200) },
        // A subagent on a smaller model.
        { model: 'claude-haiku-4-5-20251001', token_count: q(5, 8_000, 900, 120) }
      ]
    }
  }
}

const CODEX_RESPONSE = {
  stopReason: 'end_turn',
  usage: { totalTokens: 12_345, inputTokens: 1_000, cachedReadTokens: 11_000, outputTokens: 345, thoughtTokens: 100 },
  _meta: {
    quota: {
      token_count: { totalTokens: 12_345, inputTokens: 1_000, cachedInputTokens: 11_000, outputTokens: 345, reasoningOutputTokens: 100 },
      model_usage: [{ model: 'gpt-5.5-codex', token_count: { totalTokens: 12_345, inputTokens: 1_000, cachedInputTokens: 11_000, outputTokens: 345, reasoningOutputTokens: 100 } }]
    }
  }
}

describe('the prompt response', () => {
  it('sums Claude’s model_usage rows, subagents included, and picks the main model', () => {
    const parsed = parsePromptTelemetry(CLAUDE_RESPONSE, 'claude', 'default')
    expect(parsed).toEqual({
      model: 'claude-sonnet-5[1m]',
      tokens: { input: 15, output: 320, cacheRead: 38_000, cacheWrite: 2_400 },
      byModel: {
        'claude-sonnet-5[1m]': { input: 10, output: 200, cacheRead: 30_000, cacheWrite: 1_500 },
        'claude-haiku-4-5-20251001': { input: 5, output: 120, cacheRead: 8_000, cacheWrite: 900 }
      },
      tokenScope: 'turn'
    })
  })

  it('prefers the row matching the selected model’s canonical id over the biggest one', () => {
    expect(parsePromptTelemetry(CLAUDE_RESPONSE, 'claude', 'claude-haiku-4-5')?.model).toBe('claude-haiku-4-5-20251001')
    expect(canonicalModelId('claude-sonnet-5[1m]')).toBe('claude-sonnet-5')
    expect(canonicalModelId('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5')
  })

  it('falls back to Claude’s main-loop usage when there are no rows', () => {
    const parsed = parsePromptTelemetry({ ...CLAUDE_RESPONSE, _meta: {} }, 'claude')
    expect(parsed).toEqual({ tokens: { input: 10, output: 200, cacheRead: 30_000, cacheWrite: 1_500 }, byModel: {}, tokenScope: 'turn' })
  })

  it('takes Claude’s main-loop usage on a resumed session’s first turn, whose rows are its whole history', () => {
    const parsed = parsePromptTelemetry(CLAUDE_RESPONSE, 'claude', 'default', { mainLoopOnly: true })
    expect(parsed).toEqual({
      model: 'claude-sonnet-5[1m]',
      tokens: { input: 10, output: 200, cacheRead: 30_000, cacheWrite: 1_500 },
      byModel: {},
      tokenScope: 'turn'
    })
    // Codex has no such history in its rows: unchanged.
    expect(parsePromptTelemetry(CODEX_RESPONSE, 'codex', undefined, { mainLoopOnly: true })?.byModel).toHaveProperty('gpt-5.5-codex')
  })

  it('reads Codex’s usage as the last request only', () => {
    expect(parsePromptTelemetry(CODEX_RESPONSE, 'codex', 'gpt-5.5-codex')).toEqual({
      model: 'gpt-5.5-codex',
      tokens: { input: 1_000, output: 345, cacheRead: 11_000, cacheWrite: 0 },
      byModel: { 'gpt-5.5-codex': { input: 1_000, output: 345, cacheRead: 11_000, cacheWrite: 0 } },
      tokenScope: 'last_request'
    })
  })

  it('reads Codex’s quota when usage is null, and nothing from a response with neither', () => {
    expect(parsePromptTelemetry({ ...CODEX_RESPONSE, usage: null }, 'codex')?.tokens)
      .toEqual({ input: 1_000, output: 345, cacheRead: 11_000, cacheWrite: 0 })
    expect(parsePromptTelemetry({ stopReason: 'end_turn' }, 'codex')).toBeNull()
    expect(parsePromptTelemetry(null, 'claude')).toBeNull()
  })
})

describe('the cost of a turn', () => {
  it('is what the running total grew by, or the reading itself when there is no earlier one or it dropped', () => {
    expect(costDelta(undefined, 0.04)).toBe(0.04)
    expect(costDelta(0.04, 0.1)).toBeCloseTo(0.06)
    expect(costDelta(0.1, 0.02)).toBe(0.02)
  })

  it('is measured per session and per process', () => {
    const readings = new CostReadings()
    const a = {} as AcpConnection
    const b = {} as AcpConnection
    expect(readings.take(a, 's1', 0.05)).toBe(0.05)
    expect(readings.take(a, 's1', 0.08)).toBeCloseTo(0.03)
    expect(readings.take(a, 's2', 0.01)).toBe(0.01)
    // A new process starts its running totals over.
    expect(readings.take(b, 's1', 0.02)).toBe(0.02)
  })

  it('is measured against the persisted reading when this connection has none for the session', () => {
    const readings = new CostReadings()
    const restarted = {} as AcpConnection
    const persisted = (sessionId: string): number | undefined => (sessionId === 's1' ? 1.2 : undefined)
    // The resumed session's total carries on from 1.2.
    expect(readings.take(restarted, 's1', 1.25, persisted)).toBeCloseTo(0.05)
    // From then on, this connection's own reading.
    expect(readings.take(restarted, 's1', 1.3, () => 1.2)).toBeCloseTo(0.05)
    // A total that started over, and a session nobody read before, are taken as they are.
    expect(readings.take({} as AcpConnection, 's1', 0.1, persisted)).toBe(0.1)
    expect(readings.take(restarted, 's2', 0.3, persisted)).toBe(0.3)
  })
})

describe('the login', () => {
  it('maps the adapter’s kinds', () => {
    expect(authKindOf('account')).toBe('subscription')
    expect(authKindOf('api_key')).toBe('api_key')
    expect(authKindOf('apiKey')).toBe('api_key')
    expect(authKindOf('gateway')).toBe('gateway')
    expect(authKindOf('external')).toBe('cloud')
    expect(authKindOf('bedrock')).toBe('cloud')
    expect(authKindOf('none')).toBe('none')
    expect(authKindOf('something-new')).toBe('unknown')
  })

  it('keeps kind, label and plan, never the email or organisation', () => {
    const read = readAuthStatus({
      authStatus: {
        kind: 'account',
        label: 'Claude Max for someone@example.com',
        account: { plan: 'max', email: 'someone@example.com', organization: 'someone@example.com’s Organization' }
      }
    })
    expect(read).toEqual({ kind: 'account', label: 'Claude Max for …', plan: 'max' })
    expect(telemetryAuthOf(read!)).toEqual({ kind: 'subscription', label: 'Claude Max for …', plan: 'max' })
    expect(JSON.stringify(read)).not.toContain('example.com')
    expect(JSON.stringify(read)).not.toContain('Organization')
  })

  it('maps Codex’s login method', () => {
    expect(codexTelemetryAuth({ state: 'logged_in', method: 'chatgpt' })).toEqual({ kind: 'subscription', label: 'ChatGPT' })
    expect(codexTelemetryAuth({ state: 'logged_in', method: 'api_key' })).toEqual({ kind: 'api_key', label: 'OpenAI API key' })
    expect(codexTelemetryAuth({ state: 'logged_in' })).toEqual({ kind: 'unknown' })
    expect(codexTelemetryAuth({ state: 'logged_out' })).toEqual({ kind: 'none' })
  })
})

describe('one turn', () => {
  const connection = {} as AcpConnection
  const collect = (engine: 'claude' | 'codex' = 'claude') => {
    const changes: SessionTelemetryChange[] = []
    let clock = 1_000
    const turn = new TurnTelemetry({
      engine, chatId: 'chat', costs: new CostReadings(), now: () => (clock += 500),
      reporter: { report: (_chatId, change) => changes.push(change) }
    })
    return { turn, changes }
  }

  it('reports every reading, and the turn once with its cost, duration and last context', () => {
    const { turn, changes } = collect()
    turn.model('default')
    turn.started()
    turn.frame(connection, 's1', { used: 16_000, size: 200_000 })
    turn.frame(connection, 's1', { used: 16_400, size: 1_000_000, costUsd: 0.04 })
    turn.answered(CLAUDE_RESPONSE)
    const first = turn.settle('s1')
    expect(first).toEqual({
      model: 'claude-sonnet-5[1m]',
      tokens: { input: 15, output: 320, cacheRead: 38_000, cacheWrite: 2_400 },
      tokenScope: 'turn',
      costUsd: 0.04,
      costSource: 'runtime',
      durationMs: 1_500,
      contextUsedAfter: 16_400
    })
    expect(turn.settle('s1')).toBe(first)
    expect(changes.map((change) => change.type)).toEqual(['model', 'context', 'context', 'turn'])
    expect(changes[2]).toMatchObject({ type: 'context', used: 16_400, size: 1_000_000, costed: true })
  })

  it('settles a turn with no prompt response from its cost alone (a follow-up)', () => {
    const { turn, changes } = collect()
    turn.started()
    turn.frame(connection, 's1', { used: 16_470, size: 200_000, costUsd: 0.0407752, origin: { kind: 'task-notification' } })
    expect(turn.settle('s1')).toMatchObject({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, tokenScope: 'none', costUsd: 0.0407752 })
    expect(changes.filter((change) => change.type === 'turn')).toHaveLength(1)
  })

  it('takes a resumed session’s tokens from its main loop, its cost against the persisted reading, and reports the reading', () => {
    const changes: SessionTelemetryChange[] = []
    const turn = new TurnTelemetry({
      engine: 'claude', chatId: 'chat', costs: new CostReadings(), lastCostReading: () => 5,
      reporter: { report: (_chatId, change) => changes.push(change) }
    })
    turn.resumed()
    turn.frame(connection, 's1', { used: 1, size: 2, costUsd: 5.25 })
    turn.answered(CLAUDE_RESPONSE)
    expect(turn.settle('s1')).toMatchObject({ tokens: { input: 10, output: 200, cacheRead: 30_000, cacheWrite: 1_500 }, costUsd: 0.25 })
    expect(changes.find((change) => change.type === 'context')).toMatchObject({ costed: true, costReading: 5.25 })
    expect(changes.find((change) => change.type === 'turn')).not.toHaveProperty('byModel')
  })

  it('settles nothing, and reports no turn, when the runtime said nothing about usage', () => {
    const { turn, changes } = collect()
    turn.started()
    turn.frame(connection, 's1', { used: 100, size: 200_000 })
    expect(turn.settle('s1')).toBeUndefined()
    expect(changes.map((change) => change.type)).toEqual(['context'])
  })
})

describe('which loaded sessions start a fresh model-usage baseline', () => {
  const docs = { name: 'docs', command: 'docs-mcp', args: [], env: [] }
  const git = { name: 'git', command: 'git-mcp', args: [], env: [] }

  it('is live only on the connection, and under the params, its last measured result ran on', () => {
    const connection = {} as AcpConnection
    const setUp = sessionFingerprint({ cwd: '/w', mcpServers: [docs, git] })
    expect(isSessionLive(connection, 's1', setUp)).toBe(false)
    noteSessionLive(connection, 's1', setUp)
    // The adapter sorts servers by name before comparing; so does this.
    expect(isSessionLive(connection, 's1', sessionFingerprint({ cwd: '/w', mcpServers: [git, docs] }))).toBe(true)
    // A connector switched off, or another cwd: the adapter rebuilds the session.
    expect(isSessionLive(connection, 's1', sessionFingerprint({ cwd: '/w', mcpServers: [docs] }))).toBe(false)
    expect(isSessionLive(connection, 's1', sessionFingerprint({ cwd: '/other', mcpServers: [docs, git] }))).toBe(false)
    expect(isSessionLive({} as AcpConnection, 's1', setUp)).toBe(false)
  })
})

describe('one turn, with Claude’s raw SDK stream', () => {
  const sdk = (message: object) => readSdkMessage(sdkParams(message, 's1'))!
  const collect = (options: { engine?: 'claude' | 'codex'; calibration?: PriceCalibration; persisted?: Record<string, number> } = {}) => {
    const changes: SessionTelemetryChange[] = []
    let clock = 1_000
    const connection = {} as AcpConnection
    const turn = new TurnTelemetry({
      engine: options.engine ?? 'claude', chatId: 'chat', now: () => (clock += 500),
      costs: new CostReadings(), modelCosts: new ModelCostReadings(), calibration: options.calibration ?? new PriceCalibration(),
      ...(options.persisted ? { lastModelCostReadings: () => options.persisted } : {}),
      reporter: { report: (_chatId, change) => changes.push(change) }
    })
    return { turn, changes, connection }
  }

  beforeEach(() => setDebugEnabled(false))
  afterEach(() => {
    clearLogEntries()
    setDebugEnabled(false)
  })

  it('reports init, one request per main message, compaction; ignores subagent frames; settles durations, requests and the main window', () => {
    const { turn, changes, connection } = collect()
    turn.model('default')
    turn.started()
    turn.sdk(connection, 's1', sdk(initMessage))
    // Two blocks of one streamed message: one request.
    turn.sdk(connection, 's1', sdk(assistantMessage({ id: 'msg_1', input: 3, cacheRead: 15_000, write5m: 5_000 })))
    turn.sdk(connection, 's1', sdk(assistantMessage({ id: 'msg_1', input: 3, cacheRead: 15_000, write5m: 5_000 })))
    // A subagent on another model, writing 1h: never the session's model, context or cache.
    turn.sdk(connection, 's1', sdk(assistantMessage({ id: 'msg_sub', model: 'claude-haiku-4-5-20251001', parent: 'toolu_1', write1h: 9_000 })))
    turn.sdk(connection, 's1', sdk(assistantMessage({ id: 'msg_2', input: 4, cacheRead: 20_000, write1h: 1_000 })))
    turn.sdk(connection, 's1', sdk(compactMessage))
    turn.sdk(connection, 's1', sdk(resultMessage({
      costs: { 'claude-sonnet-5[1m]': 0.04, 'claude-haiku-4-5-20251001': 0.003 },
      windows: { 'claude-sonnet-5[1m]': 1_000_000 },
      numTurns: 2,
      apiDurationMs: 3_200
    })))
    turn.frame(connection, 's1', { used: 16_400, size: 1_000_000, costUsd: 0.043 })
    turn.answered(CLAUDE_RESPONSE)
    const message = turn.settle('s1')

    expect(changes.map((change) => change.type)).toEqual(['model', 'runtime', 'request', 'request', 'compaction', 'context', 'turn'])
    expect(changes[1]).toEqual({ type: 'runtime', engine: 'claude', sessionId: 's1', model: 'claude-sonnet-5[1m]', cliVersion: '2.1.274', betas: ['context-1m-2026-01-01'], effort: 'high', fastMode: 'off' })
    expect(changes[2]).toMatchObject({ type: 'request', model: 'claude-sonnet-5-20260101', input: 20_003, cacheWrite5m: 5_000, cacheWrite1h: 0 })
    expect(changes[3]).toMatchObject({ type: 'request', input: 21_004, cacheWrite1h: 1_000 })
    expect(changes[5]).toMatchObject({ type: 'context', cacheTimed: true })
    expect(message).toMatchObject({ requests: 2, costUsd: 0.043, costSource: 'runtime' })
    // The first reading this process has for the session: nothing to measure it against.
    expect(message).not.toHaveProperty('apiDurationMs')
    const turnChange = changes[6] as Extract<SessionTelemetryChange, { type: 'turn' }>
    expect(turnChange.contextWindow).toBe(1_000_000)
    expect(turnChange.maxOutputTokens).toBe(64_000)
    // Per-model costs, keyed like the token rows where the ids name the same model.
    expect(turnChange.byModelCost).toEqual({ 'claude-sonnet-5[1m]': 0.04, 'claude-haiku-4-5-20251001': 0.003 })
    expect(turnChange.modelCostReadings).toEqual({ 'claude-sonnet-5[1m]': 0.04, 'claude-haiku-4-5-20251001': 0.003 })
  })

  it('measures per-model cost against the session’s previous reading, and after a restart against the persisted one', () => {
    const { turn, changes, connection } = collect({ persisted: { 'claude-sonnet-5[1m]': 1 } })
    turn.sdk(connection, 's1', sdk(resultMessage({ costs: { 'claude-sonnet-5[1m]': 1.2, 'claude-haiku-4-5': 0.01 } })))
    // A second result in the same turn (a queued turn): its growth only.
    turn.sdk(connection, 's1', sdk(resultMessage({ costs: { 'claude-sonnet-5[1m]': 1.5, 'claude-haiku-4-5': 0.01 } })))
    turn.answered(CLAUDE_RESPONSE)
    turn.settle('s1')
    const turnChange = changes.find((change) => change.type === 'turn') as Extract<SessionTelemetryChange, { type: 'turn' }>
    expect(turnChange.byModelCost!['claude-sonnet-5[1m]']).toBeCloseTo(0.5)
    // Keyed like the token row that names the same model.
    expect(turnChange.byModelCost!['claude-haiku-4-5-20251001']).toBeCloseTo(0.01)
    expect(turnChange.modelCostReadings).toEqual({ 'claude-sonnet-5[1m]': 1.5, 'claude-haiku-4-5': 0.01 })
  })

  it('takes a follow-up’s tokens from the raw result’s usage, and keeps none without one', () => {
    const { turn, connection } = collect()
    turn.started()
    turn.sdk(connection, 's1', sdk(assistantMessage({ id: 'msg_1', model: 'claude-sonnet-5-20260101' })))
    turn.sdk(connection, 's1', sdk(resultMessage({ costs: { 'claude-sonnet-5-20260101': 0.02 }, usage: { input: 7, output: 90, cacheRead: 12_000, cacheWrite: 300, write1h: 100 } })))
    turn.frame(connection, 's1', { used: 12_400, size: 200_000, costUsd: 0.02 })
    expect(turn.settle('s1')).toMatchObject({
      model: 'claude-sonnet-5-20260101',
      tokens: { input: 7, output: 90, cacheRead: 12_000, cacheWrite: 300, cacheWrite1h: 100 },
      tokenScope: 'turn',
      costUsd: 0.02
    })
    const bare = collect()
    bare.turn.frame(bare.connection, 's1', { used: 1, size: 2, costUsd: 0.01 })
    expect(bare.turn.settle('s1')).toMatchObject({ tokenScope: 'none' })
  })

  it('checks each model’s list price against the runtime’s cost, but not on a resumed turn or a managed price', () => {
    const check = vi.fn()
    const calibration = { check } as unknown as PriceCalibration
    const { turn, connection } = collect({ calibration })
    turn.sdk(connection, 's1', sdk(resultMessage({ costs: { 'claude-sonnet-5[1m]': 0.02, 'claude-haiku-4-5-20251001': 0.004 }, basis: { 'claude-haiku-4-5-20251001': 'managed' } })))
    turn.answered(CLAUDE_RESPONSE)
    turn.settle('s1')
    // Sonnet 5 row: 10 in, 200 out, 30K read, 1.5K written at 5m.
    expect(check).toHaveBeenCalledTimes(1)
    expect(check.mock.calls[0][0]).toBe('claude-sonnet-5[1m]')
    expect(check.mock.calls[0][1]).toBeCloseTo((10 * 2 + 200 * 10 + 30_000 * 0.2 + 1_500 * 2.5) / 1_000_000)
    expect(check.mock.calls[0][2]).toBeCloseTo(0.02)

    const resumed = collect({ calibration })
    resumed.turn.resumed()
    resumed.turn.sdk(resumed.connection, 's1', sdk(resultMessage({ costs: { 'claude-sonnet-5[1m]': 0.02 } })))
    resumed.turn.answered(CLAUDE_RESPONSE)
    resumed.turn.settle('s1')
    expect(check).toHaveBeenCalledTimes(1)
  })

  it('logs a price drift once per model per process, with the model and the two figures only', () => {
    const calibration = new PriceCalibration()
    expect(calibration.check('claude-sonnet-5[1m]', 0.0118, 0.0119)).toBe(false)
    expect(calibration.check('claude-sonnet-5[1m]', 0.0118, 0.02)).toBe(true)
    expect(calibration.check('claude-sonnet-5-20260101', 0.0118, 0.03)).toBe(false)
    expect(calibration.check('claude-haiku-4-5', 0.01, 0.02)).toBe(true)
    expect(calibration.check('claude-opus-5', undefined, 0.02)).toBe(false)
    const warnings = getLogEntries().filter((entry) => entry.level === 'warn' && entry.scope === 'acp-telemetry')
    expect(warnings).toHaveLength(2)
    expect(warnings[0].data).toEqual({ model: 'claude-sonnet-5', estimatedUsd: 0.0118, runtimeUsd: 0.02 })
  })

  it('estimates a Codex turn’s cost from the price table, unless the model is unknown or a cloud paid', () => {
    const response = { ...CODEX_RESPONSE, _meta: { quota: { model_usage: [{ model: 'gpt-5.5', token_count: CODEX_RESPONSE._meta.quota.token_count }] } } }
    const { turn, changes } = collect({ engine: 'codex' })
    turn.answered(response)
    // 1,000 uncached in, 11,000 cached, 345 out at 5 / 0.50 / 30.
    const expected = (1_000 * 5 + 11_000 * 0.5 + 345 * 30) / 1_000_000
    expect(turn.settle('s1')).toMatchObject({ model: 'gpt-5.5', costSource: 'estimated', tokenScope: 'last_request' })
    const turnChange = changes.find((change) => change.type === 'turn') as Extract<SessionTelemetryChange, { type: 'turn' }>
    expect(turnChange.message.costUsd).toBeCloseTo(expected)
    expect(turnChange.byModelCost!['gpt-5.5']).toBeCloseTo(expected)

    const unknown = collect({ engine: 'codex' })
    unknown.turn.answered(CODEX_RESPONSE)
    expect(unknown.turn.settle('s1')).not.toHaveProperty('costUsd')

    const cloud = collect({ engine: 'codex' })
    cloud.turn.auth({ kind: 'cloud' })
    cloud.turn.answered(response)
    expect(cloud.turn.settle('s1')).not.toHaveProperty('costUsd')
  })

  it('measures the API time as a running total: the last reading less the one before the turn, unknown with none', () => {
    const apiDurations = new ApiDurationReadings()
    const connection = {} as AcpConnection
    const turnOn = (conn: AcpConnection, readings: Array<{ apiDurationMs: number; numTurns: number }>) => {
      const turn = new TurnTelemetry({ engine: 'claude', chatId: 'chat', costs: new CostReadings(), modelCosts: new ModelCostReadings(), apiDurations, calibration: new PriceCalibration() })
      for (const reading of readings) turn.sdk(conn, 's1', sdk(resultMessage({ costs: { 'claude-sonnet-5[1m]': 0.01 }, ...reading })))
      turn.answered(CLAUDE_RESPONSE)
      return turn.settle('s1')
    }
    // The first turn this connection sees for the session: unknown, not 3000.
    expect(turnOn(connection, [{ apiDurationMs: 3_000, numTurns: 1 }])).not.toHaveProperty('apiDurationMs')
    expect(turnOn(connection, [{ apiDurationMs: 7_000, numTurns: 2 }])).toMatchObject({ apiDurationMs: 4_000, requests: 2 })
    // Two results in one turn: the last reading less the pre-turn one, never a sum; requests still add up.
    expect(turnOn(connection, [{ apiDurationMs: 8_000, numTurns: 1 }, { apiDurationMs: 9_500, numTurns: 2 }])).toMatchObject({ apiDurationMs: 2_500, requests: 3 })
    // A new connection (a restarted process) has no earlier reading.
    expect(turnOn({} as AcpConnection, [{ apiDurationMs: 12_000, numTurns: 1 }])).not.toHaveProperty('apiDurationMs')
  })

  it('reports a session by its fingerprint’s digest, never the params', () => {
    const { turn, changes } = collect()
    const fingerprint = sessionFingerprint({ cwd: '/w', mcpServers: [{ name: 'x' }] })
    turn.session('s1', true, fingerprint)
    expect(changes).toEqual([{ type: 'session', engine: 'claude', sessionId: 's1', fresh: true, fingerprint: fingerprintDigest(fingerprint), at: 1_500 }])
    expect(fingerprintDigest(fingerprint)).toMatch(/^[0-9a-f]{16}$/)
  })

  it('logs the turn’s raw traffic by frame type at debug, without content', () => {
    setDebugEnabled(true)
    const { turn, connection } = collect()
    turn.sdk(connection, 's1', sdk(assistantMessage({ id: 'msg_1' })))
    turn.sdk(connection, 's1', sdk(resultMessage({ costs: { 'claude-sonnet-5[1m]': 0.01 } })))
    turn.answered(CLAUDE_RESPONSE)
    turn.settle('s1')
    const traffic = getLogEntries().filter((entry) => entry.level === 'debug' && entry.message.includes('raw SDK stream traffic'))
    expect(traffic).toHaveLength(1)
    const data = traffic[0].data as { bytes: number; byType: Record<string, { frames: number; bytes: number }> }
    expect(Object.keys(data.byType).sort()).toEqual(['assistant', 'result'])
    expect(data.byType.assistant.frames).toBe(1)
    expect(data.bytes).toBe(data.byType.assistant.bytes + data.byType.result.bytes)
    expect(JSON.stringify(traffic[0])).not.toContain('SECRET')
  })

  it('logs frame counts only, no sizes, while debug detail is off', () => {
    const { turn, connection } = collect()
    turn.sdk(connection, 's1', sdk(assistantMessage({ id: 'msg_1' })))
    turn.answered(CLAUDE_RESPONSE)
    turn.settle('s1')
    const traffic = getLogEntries().filter((entry) => entry.level === 'debug' && entry.message.includes('raw SDK stream traffic'))
    expect(traffic).toHaveLength(1)
    expect(traffic[0].data).toEqual({ chatId: 'chat', byType: { assistant: { frames: 1 } } })
  })
})
