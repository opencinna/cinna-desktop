/**
 * Exposes a remote A2A agent to the orchestrator LLM as an *emulated* MCP tool
 * (agents-as-MCP wrapper). One provider per attached agent. `getTools()`
 * synthesizes a single `<slug>` tool from the agent's stored `cinna.mcp`
 * descriptor (or a fallback built from name/description/example_prompts);
 * `callTool()` runs a port-free A2A turn via `runAgentTurn` and returns the
 * agent's **compact** text to the orchestrator while forwarding the
 * full-fidelity `parts[]` + live stream events to the UI sub-thread.
 *
 * Continuity is the desktop's own concern — `runAgentTurn` reuses the
 * `a2a_sessions` row per (chat, agent). The orchestrator LLM only ever passes
 * `{ message }`; it never sees a `context_id`.
 */
import type { ToolDefinition } from '../llm/types'
import type { ToolProvider, ToolCallOptions, ToolExecutionResult } from '../llm/toolProvider'
import type { AgentRow } from '../db/agents'
import type { A2AClient } from '@a2a-js/sdk/client'
import { agentService } from './agentService'
import { runAgentTurn } from './a2aStreamingService'
import { chatOnDemandAgentRepo } from '../db/chatOnDemandAgent'
import { createLogger } from '../logger/logger'

const logger = createLogger('agent-tool')

/** Default tool schema when the descriptor omits one — `{ message }` only. */
const DEFAULT_AGENT_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    message: {
      type: 'string',
      description:
        'The task or question for the agent. Be self-contained — include all the context the agent needs to act, since it does not see the rest of this conversation.'
    }
  },
  required: ['message']
}

/**
 * Sanitize a raw label into an LLM-facing tool slug: `^[a-z0-9_-]+$`,
 * lowercase, collapsed separator repeats, ≤64 chars.
 */
export function sanitizeToolSlug(raw: string): string {
  let s = raw.toLowerCase().replace(/[^a-z0-9_-]+/g, '_')
  s = s.replace(/_{2,}/g, '_').replace(/-{2,}/g, '-')
  s = s.replace(/^[_-]+|[_-]+$/g, '')
  if (!s) s = 'agent'
  return s.slice(0, 64)
}

/** Stable 3-hex-char hash of a string — used as a collision suffix. */
function shortHash(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0
  }
  return h.toString(16).padStart(3, '0').slice(-3)
}

export class A2AAsMcpProvider implements ToolProvider {
  readonly providerType = 'agent' as const

  constructor(
    /** Chat the agent turn belongs to (drives `a2a_sessions` continuity). */
    private readonly chatId: string,
    /** The resolved agent row. */
    private readonly agent: AgentRow,
    /** Owner userId — local agents in default scope, remote in profile scope. */
    private readonly ownerId: string,
    /** Final, collision-resolved LLM-facing tool name. */
    readonly toolName: string
  ) {}

  get displayName(): string {
    return this.agent.name
  }

  /** Routing key — the stable agent id. Never shown to the LLM. */
  get agentId(): string {
    return this.agent.id
  }

  getTools(): ToolDefinition[] {
    const desc = this.agent.remoteMetadata?.cinna_mcp
    const description =
      desc?.description?.trim() || this.fallbackDescription()
    const inputSchema =
      desc?.input_schema && typeof desc.input_schema === 'object'
        ? desc.input_schema
        : DEFAULT_AGENT_INPUT_SCHEMA
    return [
      {
        name: this.toolName,
        description,
        inputSchema,
        // Routing happens via the provider map keyed by `toolName`; this field
        // is unused for agent tools but kept structurally valid. Never shown
        // to the LLM.
        mcpProviderId: this.agent.id,
        providerType: 'agent'
      }
    ]
  }

  private fallbackDescription(): string {
    const meta = this.agent.remoteMetadata
    const examples = meta?.example_prompts ?? []
    let d = `Send a self-contained task or question to the "${this.agent.name}" agent. It runs its own model and tools and returns a result.`
    if (this.agent.description?.trim()) {
      d += ` ${this.agent.description.trim()}`
    }
    if (examples.length > 0) {
      d += ` Example tasks: ${examples.slice(0, 3).join('; ')}.`
    }
    return d
  }

  async callTool(
    _name: string,
    input: Record<string, unknown>,
    opts?: ToolCallOptions
  ): Promise<ToolExecutionResult> {
    const message =
      typeof input.message === 'string' && input.message.trim().length > 0
        ? input.message
        : JSON.stringify(input)

    const signal = opts?.signal ?? new AbortController().signal

    let endpointUrl: string
    let accessToken: string | undefined
    try {
      endpointUrl = await agentService.resolveEndpointIfNeeded(this.ownerId, this.agent)
      accessToken = await agentService.resolveAccessToken(this.ownerId, this.agent)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error('agent tool pre-flight failed', { agentId: this.agent.id, error: message })
      return { content: `Agent unavailable: ${message}`, parts: [], isError: true }
    }

    if (!this.agent.cardUrl) {
      return { content: 'Agent has no card URL configured', parts: [], isError: true }
    }

    // When the orchestrator aborts, also tell the remote agent to cancel its
    // task — otherwise it keeps running server-side after we stop reading the
    // stream. We capture the client + live task id via the turn callbacks.
    let client: A2AClient | undefined
    let taskId: string | undefined
    const onAbort = (): void => {
      if (client && taskId) {
        client
          .cancelTask({ id: taskId })
          .catch((err) =>
            logger.warn('cancelTask failed', { agentId: this.agent.id, error: String(err) })
          )
      }
    }
    signal.addEventListener('abort', onAbort, { once: true })

    try {
      const result = await runAgentTurn({
        chatId: this.chatId,
        agentId: this.agent.id,
        agentName: this.agent.name,
        endpointUrl,
        cardUrl: this.agent.cardUrl,
        accessToken,
        wireContent: message,
        isCinnaTokenAuth: this.agent.source === 'remote',
        signal,
        onEvent: opts?.onEvent,
        onClient: (c) => {
          client = c
        },
        onTaskId: (id) => {
          taskId = id
        }
      })

      if (result.error) {
        return { content: result.error.message, parts: result.parts, isError: true }
      }
      // Compact text to the orchestrator; rich parts ride along for the UI.
      return { content: result.text, parts: result.parts }
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }
}

/**
 * Build one {@link A2AAsMcpProvider} per on-demand agent attached to the chat.
 * Resolves each agent across the dual scopes, assigns collision-resolved tool
 * slugs (deterministic id-derived suffix on clash — never positional), and
 * avoids any name already taken by an MCP tool (`reservedNames`). Synchronous:
 * endpoint/token resolution is deferred to `callTool` (first turn).
 */
export function buildAgentToolProviders(
  chatId: string,
  defaultUserId: string,
  profileUserId: string,
  reservedNames: Set<string>
): A2AAsMcpProvider[] {
  const agentIds = chatOnDemandAgentRepo.listAgentIds(chatId)
  const taken = new Set(reservedNames)
  const providers: A2AAsMcpProvider[] = []

  for (const agentId of agentIds) {
    const located = agentService.findAgent(defaultUserId, profileUserId, agentId)
    if (!located || !located.row.cardUrl) {
      logger.warn('on-demand agent skipped (unresolved or no card URL)', { agentId })
      continue
    }
    const row = located.row
    const desc = row.remoteMetadata?.cinna_mcp
    const base = sanitizeToolSlug(desc?.tool_name || desc?.display_name || row.name)

    let name = base
    if (taken.has(name)) {
      const suffix = `_${shortHash(agentId)}`
      name = `${base.slice(0, 64 - suffix.length)}${suffix}`
      // Defensive: extremely unlikely double-clash — keep appending a stable
      // hash of the current candidate until unique.
      while (taken.has(name)) {
        const s = `_${shortHash(name)}`
        name = `${name.slice(0, 64 - s.length)}${s}`
      }
    }
    taken.add(name)
    providers.push(new A2AAsMcpProvider(chatId, row, located.userId, name))
  }

  return providers
}
