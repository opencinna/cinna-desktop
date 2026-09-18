/**
 * Who answers the next message in a chat — the one place that decides.
 *
 * A chat used to be two shapes decided in five places: `chat.agentId &&
 * !chat.orchestrated` meant "direct A2A", anything else meant "the local model
 * conducts". The rule was re-derived by the composer, the attachment scope, the
 * new-chat flow, the example prompts and the job runner, and `derivePattern`
 * answered a *third* version of it for the new-chat badge. Phase 4 of the agent
 * runtime plan replaces all six with `chats.router` and this file.
 *
 * Pure — no React, no I/O, no Electron — so main and the renderer read the same
 * answer from the same code rather than from two copies of the same sentence.
 */

/**
 * How a chat decides who answers.
 *
 *  - `direct` — one counterparty: the chat's bound agent, or the local model
 *    when there is none. A plain LLM chat is "direct to the LLM".
 *  - `human` — several agents, and **the user routes**: each message addresses
 *    one of them, and the others see it as thread context on their next turn.
 *    No model is involved, so a chat like this runs with no LLM provider
 *    configured at all.
 *  - `coordinator` — the bound Local agent conducts, or the chat model when no
 *    root is bound, calling attached agents and MCP servers as tools.
 */
export type ChatRouter = 'direct' | 'human' | 'coordinator'

export type DefaultMultiAgentRouting = 'human' | 'coordinator'

/** Same Local/Remote criterion used by the connection badge. */
export function canConduct(agent: { source?: string | null; driver?: string | null; acpTransport?: string | null }): boolean {
  return agent.source === 'folder' || (agent.driver === 'acp' && agent.acpTransport !== 'websocket')
}

export const CHAT_ROUTERS: readonly ChatRouter[] = ['direct', 'human', 'coordinator']

/** What a chat row's `router` column defaults to, and what an unreadable value means. */
export const DEFAULT_CHAT_ROUTER: ChatRouter = 'direct'

export function isChatRouter(value: unknown): value is ChatRouter {
  return value === 'direct' || value === 'human' || value === 'coordinator'
}

/**
 * The fields of a chat the routing rule reads. Both the main-process row and
 * the renderer's cached DTO satisfy it, which is the point.
 *
 */
export interface RoutableChat {
  router?: string | null
  agentId?: string | null
}

/** Where a run goes: one agent, or the local model. */
export type RunTarget = { kind: 'model' } | { kind: 'agent'; agentId: string }

/**
 * What the answer to "who answers this message" depends on beyond the chat row
 * itself. Every field is optional: a caller that knows none of it still gets a
 * usable answer, and only `human` reads any of them.
 */
export interface Addressing {
  /** The agent this message addresses — the user's own gesture in the composer. */
  addressed?: string | null
  /** Who the previous user message addressed. Sticky: the default when nothing new is addressed. */
  lastAddressed?: string | null
  /** The agents attached to the chat, in attach order. An `addressed` id outside it is ignored. */
  attached?: readonly string[]
}

export interface ChatRouting {
  router: ChatRouter
  /** The agent bound as the chat's root. `direct` and `coordinator`; null when the model is the root. */
  rootAgentId: string | null
  /**
   * Where a file picked in this chat's composer is stored: `cinna` when the
   * message goes straight to an agent, `local` when the local model reads it.
   * Whether an attach button is offered at all is a separate question, asked of
   * the target agent's `capabilities.attachments`.
   */
  attachmentTarget: 'cinna' | 'local'
  /**
   * Whether this chat cannot send without a resolvable provider + model. False
   * for every chat an agent answers — which is the whole point of `human`.
   */
  needsModel: boolean
  /** Who answers the next user message. */
  answerer: (addressing?: Addressing) => RunTarget
}

/**
 * The router a chat runs on.
 *
 * Unknown or absent values use the persisted column default. Legacy rows are
 * backfilled before this helper is used.
 */
export function routerOf(chat: RoutableChat): ChatRouter {
  if (isChatRouter(chat.router)) return chat.router
  return DEFAULT_CHAT_ROUTER
}

/**
 * Everything the routing rule says about one chat.
 *
 * `answerer` is a function rather than a value because only `human` needs the
 * addressing, and most callers (the attachment scope, the send guard, the
 * badge) want the rest without having it.
 */
export function routingOf(chat: RoutableChat): ChatRouting {
  const router = routerOf(chat)
  const rootAgentId = router !== 'human' ? (chat.agentId ?? null) : null
  return {
    router,
    rootAgentId,
    attachmentTarget: router !== 'human' && !rootAgentId
      ? 'local'
      : 'cinna',
    needsModel: router !== 'human' && !rootAgentId,
    answerer: (addressing) => answererOf(router, rootAgentId, addressing)
  }
}

/**
 * Who answers, given the router and what the caller knows about addressing.
 *
 * The `human` rule, in order: the agent this message addresses, else the one
 * the last message addressed, else the first attached. An `addressed` id that
 * is not attached to the chat is not honoured — the composer and the row can
 * disagree for a moment after a chip is removed, and a message to an agent the
 * chat no longer has would be a turn nobody asked for.
 *
 * A `human` chat with no agents left falls back to the model. It should not
 * happen — removing the last chip is what sends a chat back to `direct` — but
 * "answer nobody" is not one of the shapes the send path can express.
 */
function answererOf(
  router: ChatRouter,
  rootAgentId: string | null,
  addressing: Addressing | undefined
): RunTarget {
  if (router !== 'human') {
    return rootAgentId ? { kind: 'agent', agentId: rootAgentId } : { kind: 'model' }
  }
  const attached = addressing?.attached ?? []
  const wanted = [addressing?.addressed, addressing?.lastAddressed].find(
    (id): id is string => !!id && (attached.length === 0 || attached.includes(id))
  )
  const agentId = wanted ?? attached[0]
  return agentId ? { kind: 'agent', agentId } : { kind: 'model' }
}

/**
 * The router a chat about to be created should run on, from what the user
 * picked on the new-chat screen.
 *
 * Replaces `derivePattern`, whose two values could not say the difference
 * between "several agents, the user routes" and "several agents, the model
 * conducts" — it called both `AI` and required a model for both.
 *
 *  - No agent at all → `direct`, to the local model. Its MCP servers are its
 *    own tools, as they are in every chat; that is not coordination.
 *  - One agent, no MCP → `direct`, bound as the chat's root.
 *  - Several agents, no MCP → the default multi-agent routing preference.
 *  - Any agent *with* an MCP server → `coordinator`: the conductor receives
 *    both agents and connected MCP tools.
 *  - `coordinate` — the composer's explicit toggle — wins over all of it.
 */
export function newChatRouter(opts: {
  agentIds: readonly string[]
  mcpIds: readonly string[]
  coordinate?: boolean
  defaultMultiAgentRouting?: DefaultMultiAgentRouting
}): ChatRouter {
  if (opts.coordinate) return 'coordinator'
  if (opts.agentIds.length === 0) return DEFAULT_CHAT_ROUTER
  if (opts.mcpIds.length > 0) return 'coordinator'
  return opts.agentIds.length === 1 ? 'direct' : (opts.defaultMultiAgentRouting ?? 'human')
}
