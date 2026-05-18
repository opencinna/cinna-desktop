type AgentLike = { id: string; name: string }

/** Lower-kebab agent name — the canonical slug used by `@<slug>` mentions. */
export function slugForAgent(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '-')
}

/**
 * Parse a leading `@<slug>` at the start of `text` and resolve it to an agent
 * by slug or by id (case-insensitive). Returns the agent plus the remainder of
 * the text (everything after the consumed token), or `null` when no match.
 */
export function findAgentMention<T extends AgentLike>(
  text: string,
  agents: T[]
): { agent: T; remainder: string } | null {
  const match = text.match(/^@([\w-]+)(?:\s+|$)/)
  if (!match) return null
  const needle = match[1].toLowerCase()
  const agent = agents.find(
    (a) => slugForAgent(a.name) === needle || a.id.toLowerCase() === needle
  )
  if (!agent) return null
  return { agent, remainder: text.slice(match[0].length) }
}
