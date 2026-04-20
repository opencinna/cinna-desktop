/**
 * Parsing helpers for the A2A "CLI command" convention (docs:
 * `CINNA_DESKTOP_CLI_COMMANDS_INTEGRATION.md`). Shared between main (card fetch)
 * and renderer (display) — keep type-only / pure so it can be imported from
 * both Electron processes.
 */

export interface CliCommand {
  /** Slug portion after `cinna.run.` — e.g. `check` for `cinna.run.check`. */
  slug: string
  /** Human-readable label from `skill.name`; falls back to `run:<slug>`. */
  name: string
  /** One-line short description, truncated. */
  description: string
  /** Invocation text inserted into the chat input, e.g. `/run:check`. */
  command: string
}

const CLI_SKILL_PREFIX = 'cinna.run.'
const CLI_RUN_TAG = 'cinna-run'
const DESC_MAX = 140

function firstLine(s: string): string {
  const trimmed = s.trim()
  const idx = trimmed.indexOf('\n')
  const head = idx === -1 ? trimmed : trimmed.slice(0, idx).trimEnd()
  if (head.length <= DESC_MAX) return head
  return head.slice(0, DESC_MAX - 1).trimEnd() + '…'
}

export function extractCliCommands(skills: unknown): CliCommand[] {
  if (!Array.isArray(skills)) return []
  const out: CliCommand[] = []
  for (const raw of skills) {
    if (!raw || typeof raw !== 'object') continue
    const s = raw as {
      id?: unknown
      name?: unknown
      description?: unknown
      tags?: unknown
      examples?: unknown
    }
    const id = typeof s.id === 'string' ? s.id : null
    const tags = Array.isArray(s.tags)
      ? s.tags.filter((t): t is string => typeof t === 'string')
      : []
    const isCli = (id !== null && id.startsWith(CLI_SKILL_PREFIX)) || tags.includes(CLI_RUN_TAG)
    if (!isCli) continue

    const slug =
      id && id.startsWith(CLI_SKILL_PREFIX) ? id.slice(CLI_SKILL_PREFIX.length) : id ?? 'command'
    const name =
      typeof s.name === 'string' && s.name.trim() ? s.name.trim() : `run:${slug}`
    const description =
      typeof s.description === 'string' && s.description.trim()
        ? firstLine(s.description)
        : name
    const examples = Array.isArray(s.examples)
      ? s.examples.filter((e): e is string => typeof e === 'string')
      : []
    const command = examples[0]?.trim() || `/run:${slug}`

    out.push({ slug, name, description, command })
  }
  return out
}
