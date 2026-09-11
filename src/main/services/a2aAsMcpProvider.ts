import { taskInputRequestRepo } from '../db/taskInputRequests'
/**
 * Exposes an agent to the orchestrator LLM as an *emulated* MCP tool
 * (agents-as-MCP wrapper). One provider per attached agent. `getTools()`
 * synthesizes a single `<slug>` tool from the agent's stored `cinna.mcp`
 * descriptor (or a fallback built from name/description/example_prompts);
 * `callTool()` runs a port-free turn through the agent's driver and returns
 * the agent's **compact** text to the orchestrator while forwarding the
 * full-fidelity `parts[]` + live stream events to the UI sub-thread.
 *
 * Continuity is the desktop's own concern — the driver reuses the
 * `a2a_sessions` row per (chat, agent). The orchestrator LLM only ever passes
 * `{ message }`; it never sees a `context_id`.
 */
import type { ToolDefinition } from '../llm/types'
import type { ToolProvider, ToolCallOptions, ToolExecutionResult } from '../llm/toolProvider'
import type { AgentRow } from '../db/agents'
import { agentService } from './agentService'
import { driverFor } from '../agents/drivers'
import { hasRunConfig } from '../agents/drivers/capabilities'
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
    if (taskInputRequestRepo.listOpenForChat(this.chatId).some((request) =>
      request.agentId === this.agent.id && request.resume === 'next_message')) {
      return {
        isError: true,
        content: 'This agent is waiting for a human answer in the Inbox. Do not call it again until that request is answered.'
      }
    }
    const message =
      typeof input.message === 'string' && input.message.trim().length > 0
        ? input.message
        : JSON.stringify(input)

    const signal = opts?.signal ?? new AbortController().signal

    // The same driver the direct chat uses, so the pre-flight (endpoint, token,
    // an expired Cinna session) fails with the same sentence here, and an
    // orchestrator abort tells a remote agent to cancel its task the same way a
    // user's Stop does — both live in the driver now, not beside each caller.
    const result = await driverFor(this.agent).run(this.ownerId, this.agent, {
      chatId: this.chatId,
      wireContent: message,
      signal,
      onEvent: opts?.onEvent
    })

    if (result.error) {
      return { content: result.error.message, parts: result.parts, isError: true }
    }
    // Compact text to the orchestrator; rich parts ride along for the UI.
    return { content: result.text, parts: result.parts }
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
    // Skipped only when the row lacks what its driver needs. A folder agent
    // legitimately has no card URL (`cardUrl: null` at insert), so a bare
    // card check here once skipped every folder agent exactly as it was
    // skipped in the direct-chat handler — see `hasRunConfig`.
    if (!located || !hasRunConfig(located.row)) {
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
