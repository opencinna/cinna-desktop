/**
 * The folder's own subagents, handed to the CLI without opening the boundary.
 *
 * ## Why this exists
 *
 * In a terminal, `claude` discovers `.claude/agents/*.md` in the working
 * directory and offers each as a `subagent_type` on the Agent tool. The runner
 * passes `settingSources: []`, which is the desktop's boundary — the folder's
 * `settings.json`, `CLAUDE.md`, skills and plugins must not redefine what the
 * agent may do — and the probe showed that switch also drops the folder's
 * agents: with `[]` the init message lists only the built-ins, with
 * `['project']` the folder's `probe-agent` appears beside them. So an agent
 * built as a lead with three specialists under `.claude/agents/` ran in the
 * desktop with none of them, and the model improvised a `general-purpose`
 * subagent with the specialist's job description pasted into its prompt.
 *
 * `options.agents` is the SDK's programmatic route to the same registry, so the
 * desktop reads the files itself and passes what a terminal would have found.
 * **Read, not trusted:** the fields copied across are the ones that describe a
 * subagent — its description, prompt, tools, model — and never the ones that
 * would move a permission decision away from the desktop. See
 * {@link CLAUDE_AGENT_FIELDS_DROPPED}.
 *
 * ## Fixed boundary, in one place
 *
 * `permissionMode` is the one that matters. A frontmatter line of
 * `permissionMode: bypassPermissions` would let a subagent run every tool
 * without the `canUseTool` callback ever being consulted — the grants store,
 * the permission block, the audit trail, all bypassed by a text file in the
 * folder. `mcpServers` is dropped for the same reason `strictMcpConfig` is set:
 * the desktop hands the CLI an empty connector list, and a subagent must not
 * reopen it. `memory` is dropped because it writes outside the transcript,
 * under `~/.claude/agent-memory/` or the folder, and nothing in Cinna shows or
 * clears it.
 */

import { readdirSync, readFileSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { parseFrontmatter, type MiniYamlValue } from '../../kit/miniYaml'

/** Where a terminal `claude` looks, relative to the working directory. */
export const CLAUDE_AGENTS_DIR = join('.claude', 'agents')

/**
 * The subagent fields copied from frontmatter, verbatim from `AgentDefinition`
 * in `sdk.d.ts` at 0.3.266. Anything not named here is dropped.
 */
export interface FolderAgentDefinition {
  description: string
  prompt: string
  tools?: string[]
  disallowedTools?: string[]
  model?: string
  maxTurns?: number
  skills?: string[]
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | number
  background?: boolean
}

/**
 * Frontmatter keys deliberately not carried across. Named so a test can pin
 * that each stays out, whatever the file says.
 */
export const CLAUDE_AGENT_FIELDS_DROPPED: readonly string[] = [
  'permissionMode',
  'mcpServers',
  'memory',
  'observer',
  'observerMessage',
  'criticalSystemReminder_EXPERIMENTAL',
  'initialPrompt'
]

/** What reading one folder produced, for the runner to log. */
export interface FolderAgents {
  agents: Record<string, FolderAgentDefinition>
  /** Files skipped, with why — a definition the model will not see should be visible somewhere. */
  skipped: { file: string; reason: string }[]
}

function strings(value: MiniYamlValue | undefined): string[] | undefined {
  if (typeof value === 'string') {
    const items = value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    return items.length > 0 ? items : undefined
  }
  if (Array.isArray(value)) {
    const items = value.filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    return items.length > 0 ? items.map((s) => s.trim()) : undefined
  }
  return undefined
}

function effortOf(value: MiniYamlValue | undefined): FolderAgentDefinition['effort'] {
  if (typeof value === 'number') return value
  if (value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max') {
    return value
  }
  return undefined
}

/**
 * Read `.claude/agents/*.md` under `agentDir` into `options.agents`.
 *
 * Never throws: a folder with no agents directory, or one that cannot be read,
 * yields no agents — the turn runs as it did before this module existed. A
 * single unreadable or malformed file is skipped and named, not fatal.
 */
export function readFolderAgents(agentDir: string): FolderAgents {
  const out: FolderAgents = { agents: {}, skipped: [] }
  let entries: Dirent[]
  try {
    entries = readdirSync(join(agentDir, CLAUDE_AGENTS_DIR), { withFileTypes: true })
  } catch {
    return out
  }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const file = join(CLAUDE_AGENTS_DIR, entry.name)
    let text: string
    try {
      text = readFileSync(join(agentDir, file), 'utf8')
    } catch (err) {
      out.skipped.push({ file, reason: err instanceof Error ? err.message : String(err) })
      continue
    }
    const parsed = parseFrontmatter(text)
    if (!parsed) {
      out.skipped.push({ file, reason: 'no frontmatter' })
      continue
    }
    const { data, body, issues } = parsed
    // **A flagged block is a skipped file, not a best effort.** The reader
    // turns a block scalar into the literal `"|"` and an unquoted `#` into a
    // truncated line — plausible values, both wrong, and a subagent described
    // to the model as "|" is worse than one it is not offered. The issue text
    // says how to write the line so it reads.
    if (issues.length > 0) {
      out.skipped.push({ file, reason: issues.map((i) => `line ${i.line}: ${i.message}`).join(' ') })
      continue
    }
    // The file name is what a terminal `claude` falls back to when `name` is
    // missing, and it is what the folder's docs refer to either way.
    const name =
      typeof data.name === 'string' && data.name.trim() !== ''
        ? data.name.trim()
        : entry.name.replace(/\.md$/, '')
    const description = typeof data.description === 'string' ? data.description.trim() : ''
    if (!description) {
      out.skipped.push({ file, reason: 'no description — the model would never pick it' })
      continue
    }
    const prompt = body.trim()
    if (!prompt) {
      out.skipped.push({ file, reason: 'no prompt below the frontmatter' })
      continue
    }

    const definition: FolderAgentDefinition = { description, prompt }
    const tools = strings(data.tools)
    if (tools) definition.tools = tools
    const disallowed = strings(data.disallowedTools)
    if (disallowed) definition.disallowedTools = disallowed
    if (typeof data.model === 'string' && data.model.trim() !== '') {
      definition.model = data.model.trim()
    }
    if (typeof data.maxTurns === 'number' && Number.isInteger(data.maxTurns) && data.maxTurns > 0) {
      definition.maxTurns = data.maxTurns
    }
    const skills = strings(data.skills)
    if (skills) definition.skills = skills
    const effort = effortOf(data.effort)
    if (effort !== undefined) definition.effort = effort
    if (typeof data.background === 'boolean') definition.background = data.background

    out.agents[name] = definition
  }
  return out
}
