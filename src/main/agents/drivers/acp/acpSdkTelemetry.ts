/**
 * Claude's raw SDK stream, read for session telemetry and nothing else.
 *
 * `claude-agent-acp` forwards the SDK messages a session asks for in
 * `_meta.claudeCode.emitRawSDKMessages` as `_claude/sdkMessage
 * {sessionId, message}` extension notifications (`acp-agent.js`
 * `shouldEmitRawMessage`). They carry the full content again — every
 * assistant block, every result text — so a frame is reduced here to the
 * handful of numbers and ids telemetry reads, and **no frame is ever logged,
 * stored or put in the transcript whole**.
 *
 * Every field is read structurally and defensively: the shapes follow the
 * pinned SDK (`@anthropic-ai/claude-agent-sdk` `sdk.d.ts`: `SDKSystemMessage`,
 * `SDKAssistantMessage`, `SDKResultMessage`, `ModelUsage`,
 * `SDKCompactBoundaryMessage`; the assistant's `message.usage` is the
 * Messages API `BetaUsage`), and a field that is missing or of another type
 * is simply absent from the frame.
 */

import { createLogger } from '../../../logger/logger'
import type { AcpSdkFrame, AcpSdkModelUsage, AcpSdkUsage } from './types'

/** The scope the turn's traffic is logged under (`acpTelemetry.ts`). */
const trafficLogger = createLogger('acp-telemetry')

/** The extension method the adapter forwards raw SDK messages under. */
export const SDK_MESSAGE_METHOD = '_claude/sdkMessage'

/**
 * Which raw SDK messages a Claude session asks the adapter for
 * (`_meta.claudeCode.emitRawSDKMessages`).
 *
 * `assistant` is the heavy one (each frame repeats a content block) and the
 * only source of the cache TTL and the exact per-request timing. Dropping it
 * is a one-line change here: the TTL then stays `assumed` and the cache clock
 * falls back to the `usage_update` readings.
 */
export const RAW_SDK_MESSAGE_FILTER: ReadonlyArray<{ type: string; subtype?: string }> = Object.freeze([
  { type: 'system', subtype: 'init' },
  { type: 'system', subtype: 'compact_boundary' },
  { type: 'assistant' },
  { type: 'result' }
])

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function amount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function tokens(value: unknown): number {
  return amount(value) ?? 0
}

/** A Messages API usage block (`input_tokens`, `cache_read_input_tokens`, …). */
export function sdkUsageOf(value: unknown): AcpSdkUsage | undefined {
  const u = record(value)
  if (!u) return undefined
  const usage: AcpSdkUsage = {
    input: tokens(u.input_tokens),
    output: tokens(u.output_tokens),
    cacheRead: tokens(u.cache_read_input_tokens),
    cacheWrite: tokens(u.cache_creation_input_tokens)
  }
  const creation = record(u.cache_creation)
  if (creation) {
    usage.cacheWrite5m = tokens(creation.ephemeral_5m_input_tokens)
    usage.cacheWrite1h = tokens(creation.ephemeral_1h_input_tokens)
  }
  return usage
}

function modelUsageOf(value: unknown): Record<string, AcpSdkModelUsage> {
  const models: Record<string, AcpSdkModelUsage> = {}
  const rows = record(value)
  if (!rows) return models
  for (const [model, row] of Object.entries(rows)) {
    const r = record(row)
    if (!r || model === '') continue
    const costUsd = amount(r.costUSD)
    const contextWindow = amount(r.contextWindow)
    const maxOutputTokens = amount(r.maxOutputTokens)
    const costBasis = text(r.costBasis)
    models[model] = {
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
      ...(costBasis ? { costBasis } : {})
    }
  }
  return models
}

/** `'system/init'`, `'assistant'`, … — the frame's type for the traffic count, never its content. */
function labelOf(message: Record<string, unknown> | undefined): string {
  const type = text(message?.type) ?? 'unknown'
  const subtype = text(message?.subtype)
  return subtype && type === 'system' ? `system/${subtype}` : type
}

/**
 * One `_claude/sdkMessage`'s params as telemetry reads them, or null when the
 * params are not one (no session id).
 */
export function readSdkMessage(params: Record<string, unknown>): AcpSdkFrame | null {
  const sessionId = text(params.sessionId)
  if (!sessionId) return null
  // Sizing a frame serializes it whole, on every frame, only for a debug
  // line: done only when that detail is wanted. (`?.`: a test's stub logger
  // may not have it.)
  let bytes: number | undefined
  if (trafficLogger.isDebugEnabled?.() === true) {
    try {
      bytes = JSON.stringify(params).length
    } catch {
      bytes = undefined
    }
  }
  const message = record(params.message)
  const type = message?.type
  const subtype = message?.subtype
  if (!message) return { kind: 'other', sessionId, ...(bytes !== undefined ? { bytes } : {}), label: labelOf(message) }

  if (type === 'system' && subtype === 'init') {
    const betas = Array.isArray(message.betas) ? message.betas.filter((beta): beta is string => typeof beta === 'string') : undefined
    const model = text(message.model)
    const cliVersion = text(message.claude_code_version)
    const fastMode = text(message.fast_mode_state)
    const apiKeySource = text(message.apiKeySource)
    const effort = message.effort === null ? null : text(message.effort)
    return {
      kind: 'init',
      sessionId,
      ...(bytes !== undefined ? { bytes } : {}),
      ...(model ? { model } : {}),
      ...(cliVersion ? { cliVersion } : {}),
      ...(betas ? { betas } : {}),
      ...(effort !== undefined ? { effort } : {}),
      ...(fastMode ? { fastMode } : {}),
      ...(apiKeySource ? { apiKeySource } : {})
    }
  }

  if (type === 'system' && subtype === 'compact_boundary') return { kind: 'compact', sessionId, ...(bytes !== undefined ? { bytes } : {}) }

  if (type === 'assistant') {
    const inner = record(message.message)
    // A subagent's frame names the Agent tool call it runs under.
    const parent = message.parent_tool_use_id
    const main = parent === null || parent === undefined || parent === ''
    const messageId = text(inner?.id)
    const model = text(inner?.model)
    const usage = sdkUsageOf(inner?.usage)
    return {
      kind: 'assistant',
      sessionId,
      ...(bytes !== undefined ? { bytes } : {}),
      main,
      ...(messageId ? { messageId } : {}),
      ...(model ? { model } : {}),
      ...(usage ? { usage } : {})
    }
  }

  if (type === 'result') {
    const usage = sdkUsageOf(message.usage)
    const durationMs = amount(message.duration_ms)
    const apiDurationMs = amount(message.duration_api_ms)
    const numTurns = amount(message.num_turns)
    const fastMode = text(message.fast_mode_state)
    return {
      kind: 'result',
      sessionId,
      ...(bytes !== undefined ? { bytes } : {}),
      ...(usage ? { usage } : {}),
      models: modelUsageOf(message.modelUsage),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(apiDurationMs !== undefined ? { apiDurationMs } : {}),
      ...(numTurns !== undefined ? { numTurns } : {}),
      ...(fastMode ? { fastMode } : {})
    }
  }

  return { kind: 'other', sessionId, ...(bytes !== undefined ? { bytes } : {}), label: labelOf(message) }
}

/** The frame's type for the per-turn traffic count. */
export function sdkFrameLabel(frame: AcpSdkFrame): string {
  switch (frame.kind) {
    case 'init':
      return 'system/init'
    case 'compact':
      return 'system/compact_boundary'
    case 'other':
      return frame.label
    default:
      return frame.kind
  }
}
