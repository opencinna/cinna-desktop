/**
 * The init prompt: what you paste into a coding assistant Cinna cannot launch.
 *
 * "Open in…" only reaches the assistants the desktop detects and knows how to
 * start (`localTools.ts`). Everything else — an assistant already running in
 * another window, one that lives in a browser, one nobody has written a
 * launcher for — is reachable only by telling it, in words, where the folder is
 * and what to read first. That is this string, and it is why the menu item sits
 * next to the launchers rather than in Settings.
 *
 * Built here, shared, so the main process (which knows which entry document the
 * folder actually has) and any test see one copy of the wording.
 */

import { MANIFEST_FILE } from './kit/manifest'
import { LOCAL_AGENT_PROMPT_PATHS } from './localAgents'

/**
 * Candidate entry documents, in the order an assistant should be pointed at
 * them. `AGENTS.md` is the kit's own instructions-for-an-assistant file;
 * `CLAUDE.md` points at it; `README.md` is what a hand-made folder is likeliest
 * to have. The main process names the first one that exists — pointing an
 * assistant at a file that is not there is worse than not pointing at all.
 */
export const AGENT_INIT_ENTRY_FILES = ['AGENTS.md', 'CLAUDE.md', 'README.md'] as const

export interface AgentInitPromptInput {
  /** Absolute path of the agent folder. */
  folder: string
  /** The agent's display name. */
  name: string
  /**
   * The entry document present in the folder, from
   * {@link AGENT_INIT_ENTRY_FILES}, or null when the folder has none of them.
   */
  entryFile: string | null
}

/**
 * The paste-anywhere briefing for one agent folder.
 *
 * Deliberately short: it says where to work and what to read, and leaves the
 * rest to the folder's own entry document, which is version-controlled with the
 * agent and is the thing that stays true as the kit changes. Restating the
 * folder layout here would give an assistant two sources that drift.
 */
export function buildAgentInitPrompt(input: AgentInitPromptInput): string {
  const name = input.name.trim() || 'this agent'
  const read = input.entryFile
    ? `Read \`${input.entryFile}\` in that folder first — it explains the folder's structure and how to work on this agent, and points at every other file you need.`
    : `Read \`${MANIFEST_FILE}\` (the manifest) and \`${LOCAL_AGENT_PROMPT_PATHS.workflow}\` in that folder first — together they say what this agent is and what it does when it runs.`

  return [
    // Backticked: a folder path is the one filename in this string that is not
    // a literal, and an unquoted one containing spaces reads ambiguously.
    `Your working directory is \`${input.folder}\``,
    '',
    `That folder is "${name}", a Cinna local agent: its manifest, prompts, scripts and knowledge all live inside it.`,
    '',
    read,
    '',
    // The folder's own `AGENTS.md` routes on two roles — building the agent
    // versus performing its job — and reads differently under each. This
    // prompt is the "Open in…" menu in words, so it is always the first.
    'You are working *on* this agent, not running it. Keep every change inside that folder, and follow what you read there.'
  ].join('\n')
}
