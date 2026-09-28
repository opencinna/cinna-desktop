import { routingOf, type RoutableChat } from '../../../shared/chatRouting'
import { MOD_KEY, resolveKey } from '../constants/hints'

/** The fields of an agent row the shortcut rules read. */
export interface ShortcutAgent {
  id: string
  name: string
  enabled: boolean
  conductor?: boolean
}

/** What is on screen when ⇧⌘N is pressed. */
export interface ShortcutScreen {
  activeView: string
  /** The chat open in the chat view — only read when `activeView` is `chat`. */
  chat: RoutableChat | null
  activeExternalAgentId: string | null
  activeLocalAgentId: string | null
}

/** An agent a new chat can be started with: listed, switched on, not internal. */
export function startableAgent<A extends ShortcutAgent>(
  agents: readonly A[],
  agentId: string | null | undefined
): A | null {
  if (!agentId) return null
  const agent = agents.find((a) => a.id === agentId)
  return agent && agent.enabled && !agent.conductor ? agent : null
}

/**
 * The agent ⇧⌘N starts a new chat with, or null for a plain new chat.
 *
 * In a chat, only a `direct` chat has one agent the user is talking to: a
 * `coordinator` chat's root is an internal conductor, and a `human` chat has
 * several agents and no single one to carry over. On an agent page, the page's
 * agent.
 */
export function resolveShortcutAgent(
  screen: ShortcutScreen,
  agents: readonly ShortcutAgent[]
): string | null {
  let agentId: string | null = null
  if (screen.activeView === 'chat') {
    const routing = screen.chat ? routingOf(screen.chat) : null
    agentId = routing?.router === 'direct' ? routing.rootAgentId : null
  } else if (screen.activeView === 'external-agent') {
    agentId = screen.activeExternalAgentId
  } else if (screen.activeView === 'local-agent') {
    agentId = screen.activeLocalAgentId
  }
  return startableAgent(agents, agentId)?.id ?? null
}

/** `⌘3` on a Mac, `Ctrl+3` elsewhere. */
export function agentShortcutLabel(slot: number): string {
  const mod = resolveKey(MOD_KEY)
  return mod === '⌘' ? `⌘${slot}` : `${mod}+${slot}`
}

/** Shorten a name for a select option so the option fits its control. */
export function truncateName(name: string, max = 24): string {
  return name.length > max ? `${name.slice(0, max - 1).trimEnd()}…` : name
}
