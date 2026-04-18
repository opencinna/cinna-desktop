type AgentData = Awaited<ReturnType<typeof window.api.agents.list>>[number]

export interface ExamplePrompt {
  /** Short form shown on the tag — e.g. `dad-joke` from `dad-joke: tell me a dad joke`. */
  label: string
  /** Full prompt text used as the actual message. */
  full: string
}

const LABEL_MAX = 32

function splitPrompt(raw: string): ExamplePrompt {
  const trimmed = raw.trim()
  const match = /^([^\s:][^:\n]{0,40}):\s+(.+)$/s.exec(trimmed)
  if (match) {
    return { label: match[1].trim(), full: match[2].trim() }
  }
  return {
    label: trimmed.length > LABEL_MAX ? trimmed.slice(0, LABEL_MAX) + '…' : trimmed,
    full: trimmed
  }
}

export function extractExamplePrompts(agent: AgentData | null | undefined): ExamplePrompt[] {
  const prompts = agent?.remoteMetadata?.example_prompts
  if (!Array.isArray(prompts)) return []
  const out: ExamplePrompt[] = []
  for (const item of prompts) {
    if (typeof item !== 'string' || !item.trim()) continue
    out.push(splitPrompt(item))
  }
  return out
}
