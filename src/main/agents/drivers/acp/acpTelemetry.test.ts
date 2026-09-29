import { describe, expect, it } from 'vitest'
import type { SessionTelemetryChange } from '../../../../shared/sessionTelemetry'
import {
  authKindOf,
  canonicalModelId,
  codexTelemetryAuth,
  costDelta,
  CostReadings,
  isSessionLive,
  noteSessionLive,
  parsePromptTelemetry,
  readAuthStatus,
  sessionFingerprint,
  telemetryAuthOf,
  TurnTelemetry
} from './acpTelemetry'
import type { AcpConnection } from './types'

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
