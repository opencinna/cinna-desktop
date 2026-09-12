/**
 * Polymorphic tool-source abstraction for the orchestrator loop.
 *
 * Tool execution was historically hardwired to MCP (`mcpManager.callTool`).
 * `ToolProvider` decouples the orchestrator (`chatStreamingService`) from the
 * tool source so it can combine MCP tools, attached agent drivers and trusted
 * coordinator controls without deciding behavior from agent provenance.
 *
 * Implementations:
 *  - {@link McpToolProvider} — one per connected MCP provider, delegates to
 *    `mcpManager.callTool`.
 *  - `A2AAsMcpProvider` — one per attached agent, dispatches its driver and
 *    returns the agent's compact text to the orchestrator while forwarding the
 *    full-fidelity `parts[]` + live stream events to the UI sub-thread.
 *  - `CoordinatorToolProvider` — main-owned delegation, human gates and
 *    completion controls; ordinary MCP results cannot acquire this authority.
 */
import type { CoordinatorControl } from '../services/coordinatorToolProvider'
import type { ToolDefinition } from './types'
import type { MessagePart } from '../../shared/messageParts'
import type { RunEvent } from '../../shared/runEvents'
import { mcpManager } from '../mcp/manager'

export interface ToolCallOptions {
  queueWhenBusy?: boolean
  /** Root model tool-call identity for coordinator delegation and gates. */
  toolCallId?: string
  /**
   * Live sub-thread sink. Agent providers hand it each `RunEvent` of the agent's
   * turn so the orchestrator can forward it to the chat port wrapped in a
   * `child` event. MCP providers ignore this.
   */
  onEvent?: (event: RunEvent) => void
  /** Orchestrator abort — cancels an in-flight agent sub-turn. */
  signal?: AbortSignal
}

export interface ToolExecutionResult {
  /** Only a coordinator provider may return a runner control. */
  control?: CoordinatorControl
  /** A completed delegate is waiting for a persisted human continuation. */
  needsInput?: boolean
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
  /** Transcript/presentation identity; live delivery is owned by eventSink. */
  readonly providerType: 'mcp' | 'agent' | 'coordinator'
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
  /** Static specialist attribution; dynamic coordinator targets are per-call presentation only. */
  readonly attribution?: { agentId: string; displayName: string }
  /** Trusted provider wiring owns framing. Tool result content cannot choose this sink. */
  eventSink?(toolCallId: string, publish: (event: RunEvent) => void): (event: RunEvent) => void
  /** Validated display target for a coordinator's dynamic delegate call. */
  describeCall?(name: string, input: Record<string, unknown>): { agentId: string; displayName: string } | undefined
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
    return mcpManager.callTool(this.providerId, name, input)
  }
}
