/**
 * `_claude/sdkMessage` params for telemetry tests.
 *
 * **Hand-built, not recorded.** Each frame is shaped after the pinned SDK's
 * types (`@anthropic-ai/claude-agent-sdk` `sdk.d.ts`; the assistant's
 * `message` is a Messages API `BetaMessage`) and checked against them with
 * `satisfies` on the fields it sets, so a renamed field fails the typecheck.
 * Only the fields telemetry reads, plus a little content to prove it is not
 * read. Replace with live-harness recordings when they exist.
 */

import type {
  ModelUsage,
  SDKAssistantMessage,
  SDKCompactBoundaryMessage,
  SDKResultSuccess,
  SDKSystemMessage
} from '@anthropic-ai/claude-agent-sdk'
import type { BetaMessage, BetaUsage } from '@anthropic-ai/sdk/resources/beta/messages/messages'

export const SDK_SESSION = 'ses_raw'

type AssistantFrame = Partial<Omit<SDKAssistantMessage, 'message'>> & {
  message: Partial<Omit<BetaMessage, 'usage'>> & { usage: Partial<BetaUsage> }
}

export function sdkParams(message: object, sessionId = SDK_SESSION): Record<string, unknown> {
  return { sessionId, message }
}

export const initMessage = {
  type: 'system',
  subtype: 'init',
  apiKeySource: 'none',
  claude_code_version: '2.1.274',
  model: 'claude-sonnet-5[1m]',
  betas: ['context-1m-2026-01-01'],
  effort: 'high',
  fast_mode_state: 'off',
  cwd: '/work/folder',
  tools: ['Read', 'Write'],
  session_id: 'cli-session'
} satisfies Partial<SDKSystemMessage>

export function assistantMessage(options: {
  id: string
  model?: string
  parent?: string | null
  input?: number
  cacheRead?: number
  write5m?: number
  write1h?: number
  output?: number
}): AssistantFrame {
  const write5m = options.write5m ?? 0
  const write1h = options.write1h ?? 0
  return {
    type: 'assistant',
    parent_tool_use_id: options.parent ?? null,
    session_id: 'cli-session',
    message: {
      id: options.id,
      type: 'message',
      role: 'assistant',
      model: options.model ?? 'claude-sonnet-5-20260101',
      content: [{ type: 'text', text: 'SECRET CONTENT that must never be logged', citations: null }],
      usage: {
        input_tokens: options.input ?? 10,
        output_tokens: options.output ?? 50,
        cache_read_input_tokens: options.cacheRead ?? 0,
        cache_creation_input_tokens: write5m + write1h,
        cache_creation: { ephemeral_5m_input_tokens: write5m, ephemeral_1h_input_tokens: write1h }
      }
    }
  } satisfies AssistantFrame
}

function modelRow(costUSD: number, contextWindow: number, maxOutputTokens: number, costBasis?: ModelUsage['costBasis']): Partial<ModelUsage> {
  return {
    inputTokens: 100,
    outputTokens: 200,
    cacheReadInputTokens: 3_000,
    cacheCreationInputTokens: 400,
    webSearchRequests: 0,
    costUSD,
    contextWindow,
    maxOutputTokens,
    ...(costBasis ? { costBasis } : {})
  } satisfies Partial<ModelUsage>
}

type ResultFrame = Partial<Omit<SDKResultSuccess, 'usage' | 'modelUsage'>> & {
  usage: Partial<BetaUsage>
  modelUsage: Record<string, Partial<ModelUsage>>
}

/** A result: `modelUsage` costs are running totals for the query. */
export function resultMessage(options: {
  costs: Record<string, number>
  windows?: Record<string, number>
  basis?: Record<string, ModelUsage['costBasis']>
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; write1h?: number }
  durationMs?: number
  apiDurationMs?: number
  numTurns?: number
}): ResultFrame {
  const modelUsage: Record<string, Partial<ModelUsage>> = {}
  for (const [model, cost] of Object.entries(options.costs)) {
    modelUsage[model] = modelRow(cost, options.windows?.[model] ?? 200_000, 64_000, options.basis?.[model])
  }
  const u = options.usage ?? { input: 12, output: 300, cacheRead: 20_000, cacheWrite: 1_000 }
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: options.durationMs ?? 4_000,
    duration_api_ms: options.apiDurationMs ?? 3_500,
    is_error: false,
    num_turns: options.numTurns ?? 2,
    result: 'SECRET RESULT TEXT',
    stop_reason: 'end_turn',
    total_cost_usd: Object.values(options.costs).reduce((a, b) => a + b, 0),
    usage: {
      input_tokens: u.input,
      output_tokens: u.output,
      cache_read_input_tokens: u.cacheRead,
      cache_creation_input_tokens: u.cacheWrite,
      cache_creation: { ephemeral_5m_input_tokens: u.cacheWrite - (u.write1h ?? 0), ephemeral_1h_input_tokens: u.write1h ?? 0 }
    },
    modelUsage,
    session_id: 'cli-session'
  } satisfies ResultFrame
}

export const compactMessage = {
  type: 'system',
  subtype: 'compact_boundary',
  compact_metadata: { trigger: 'auto', pre_tokens: 180_000, post_tokens: 20_000 },
  session_id: 'cli-session'
} satisfies Partial<SDKCompactBoundaryMessage>
