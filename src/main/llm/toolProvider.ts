/**
 * Polymorphic tool-source abstraction for the orchestrator loop.
 *
 * Tool execution was historically hardwired to MCP (`mcpManager.callTool`).
 * `ToolProvider` decouples the orchestrator (`chatStreamingService`) from the
 * tool source so it can union real MCP tools with *emulated* MCP tools that
 * front a remote A2A agent (orchestrated mode — see `A2AAsMcpProvider`).
 *
 * Two implementations:
 *  - {@link McpToolProvider} — one per connected MCP provider, delegates to
 *    `mcpManager.callTool`.
 *  - `A2AAsMcpProvider` — one per attached agent, runs `runAgentTurn` and
 *    returns the agent's compact text to the orchestrator while forwarding the
 *    full-fidelity `parts[]` + live stream events to the UI sub-thread.
 */
import type { ToolDefinition } from './types'
import type { MessagePart } from '../../shared/messageParts'
import type { AgentStreamEvent } from '../../shared/agentStreamEvents'
import { mcpManager } from '../mcp/manager'

export interface ToolCallOptions {
  /**
   * Live sub-thread sink. Agent providers wrap each `AgentStreamEvent` so the
   * orchestrator can forward it to the chat port as a `tool_subevent`. MCP
   * providers ignore this.
   */
  onEvent?: (event: AgentStreamEvent) => void
  /** Orchestrator abort — cancels an in-flight agent sub-turn. */
  signal?: AbortSignal
}

export interface ToolExecutionResult {
  /**
   * Value fed back to the orchestrator LLM as the tool result. Kept
   * **compact** for agent providers (final agent text only) — the rich
   * `parts[]` are UI-only and never re-enter orchestrator context.
   */
  content: unknown
  /**
   * Full-fidelity agent parts for the UI sub-thread (agent providers only).
   * Persisted on the `tool_call` row; absent for MCP providers.
   */
  parts?: MessagePart[]
  /** True when the call failed — the orchestrator posts `tool_error`. */
  isError?: boolean
}

export interface ToolProvider {
  /** Discriminates the dispatch path in the orchestrator loop. */
  readonly providerType: 'mcp' | 'agent'
  /**
   * Stable display name for persistence (`tool_call.toolProvider`) and the
   * `tool_use` event's `provider` field. For MCP this is the connection name;
   * for agents it is the agent's display name.
   */
  readonly displayName: string
  /**
   * Stable agent id for agent providers (drives the per-agent hash color and
   * is persisted on the tool_call row). Undefined for MCP providers.
   */
  readonly agentId?: string
  /** LLM-facing tool definitions this provider contributes. */
  getTools(): ToolDefinition[]
  /** Execute one of this provider's tools by its LLM-facing name. */
  callTool(
    name: string,
    input: Record<string, unknown>,
    opts?: ToolCallOptions
  ): Promise<ToolExecutionResult>
}

/**
 * Wraps a single connected MCP provider. `getTools()` returns that provider's
 * tools (already tagged `providerType: 'mcp'`); `callTool` delegates to
 * `mcpManager.callTool`, which throws on failure — the orchestrator's
 * try/catch turns that into a `tool_error`.
 */
export class McpToolProvider implements ToolProvider {
  readonly providerType = 'mcp' as const

  constructor(
    private readonly providerId: string,
    readonly displayName: string
  ) {}

  getTools(): ToolDefinition[] {
    return mcpManager.getToolsForProviders([this.providerId])
  }

  async callTool(
    name: string,
    input: Record<string, unknown>
  ): Promise<ToolExecutionResult> {
    const content = await mcpManager.callTool(this.providerId, name, input)
    return { content }
  }
}
