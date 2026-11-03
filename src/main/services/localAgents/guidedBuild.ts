/**
 * Guided first build — a blank kit agent's first chat interviews the person
 * and ends with a build brief instead of attempting work it is not set up for.
 *
 * Three pure decisions live here, so each is tested on its own:
 *
 * * {@link isUnbuiltKitAgent} — is this folder still the scaffold? Read by the
 *   scanner into `LocalAgentDto.unbuilt`.
 * * {@link decideGuidedChat} — may a new chat be stored as guided? Read once,
 *   by `chatService.update`, when the new chat is bound to its agent.
 * * {@link guidedBuildSection} — what a guided chat's turn header says. It
 *   travels in the turn header, never in the system prompt: the system prompt
 *   must stay chat-independent, because Codex pools processes by prompt bytes.
 *
 * Core: no Electron.
 */

import { BUILD_BRIEF_TOOL } from '../../../shared/buildBrief'

/** What the kit's scaffold puts in `scripts/`. Anything else is something built. */
export const SCAFFOLD_SCRIPT_FILES: readonly string[] = ['README.md', 'update_status.py', 'cinna_credentials.py']

/** What the kit's scaffold puts in `skills/`. */
export const SCAFFOLD_SKILL_FILES: readonly string[] = ['README.md']

/** Entries a scan never counts: caches and dotfiles (`.DS_Store`, `.gitkeep`). */
function ignored(name: string): boolean {
  return name === '__pycache__' || name.startsWith('.')
}

function onlyScaffold(entries: readonly string[], scaffold: readonly string[]): boolean {
  return entries.every((name) => ignored(name) || scaffold.includes(name))
}

/**
 * A kit folder's facts. Only the kit scan asks: a bare folder is the user's
 * own and is never unbuilt (`scanBareAgentFolder` says false outright).
 */
export interface UnbuiltInput {
  /** Entry names directly under `scripts/`; empty when the folder is absent. */
  scripts: readonly string[]
  /** Entry names directly under `skills/`; empty when the folder is absent. */
  skills: readonly string[]
  /** The manifest's `credentials` and `schedules`, as read (anything not an array counts as none). */
  credentials: unknown
  schedules: unknown
  /** A team or catalog link (`shared_remote`): somebody else's agent, built already. */
  shared: boolean
  /** Start building was pressed, or the person picked Skip guidance. */
  guidedDone: boolean
}

/**
 * True for a kit agent that is still exactly what the scaffold made: only the
 * scaffold's scripts and skills, no credential slots, no schedules, and its
 * guided build neither done nor dismissed. The workflow prompt does not count —
 * a template prompt and an AI-drafted one are both unbuilt.
 */
export function isUnbuiltKitAgent(input: UnbuiltInput): boolean {
  if (input.shared || input.guidedDone) return false
  const none = (value: unknown): boolean => !Array.isArray(value) || value.length === 0
  if (!none(input.credentials) || !none(input.schedules)) return false
  return onlyScaffold(input.scripts, SCAFFOLD_SCRIPT_FILES) && onlyScaffold(input.skills, SCAFFOLD_SKILL_FILES)
}

export interface GuidedChatInput {
  /** The renderer asked for it. */
  requested: boolean
  /** `guidedFirstBuild` in app settings. */
  settingOn: boolean
  /** The row is guided already. */
  alreadyGuided: boolean
  /** The chat has a message or a file: the flag is fixed at creation only. */
  hasContent: boolean
  /** The chat's router and root agent after the update. */
  router: string
  agentId: string | null
  /** Agents attached beside the root. */
  attachedAgents: number
  /**
   * The bound agent as a local folder agent, or null when it is none.
   * `unbuilt` is only ever true for a kit agent.
   */
  agent: { unbuilt: boolean } | null
}

/**
 * Whether a new chat is stored as guided. Only when asked, only with the
 * setting on, only before anything was said, and only for a chat whose one
 * and only agent is a local kit agent that is unbuilt right now.
 */
export function decideGuidedChat(input: GuidedChatInput): boolean {
  if (!input.requested || !input.settingOn || input.alreadyGuided || input.hasContent) return false
  if (input.router !== 'direct' || !input.agentId || input.attachedAgents > 0) return false
  return input.agent?.unbuilt === true
}

/** First line of the section, under the turn header's facts. */
export const GUIDED_BUILD_TITLE = 'Guided first build:'

/**
 * The guided chat's section of the turn header. Sent every turn, for the
 * chat's whole life. The seed is the person's own description at creation,
 * when it says more than the name.
 */
export function guidedBuildSection(agent: { name: string; description: string | null }): string {
  const description = (agent.description ?? '').trim()
  const seed = description !== '' && description.toLowerCase() !== agent.name.trim().toLowerCase()
    ? [`- At creation the person described it as: ${JSON.stringify(description)}`]
    : []
  return [
    GUIDED_BUILD_TITLE,
    '- This agent has not been built yet, and the person may be new to agents. Until they say go, guide: do not build, and do not edit the agent folder.',
    ...seed,
    '- Every question to the person goes through your question tool, so they can answer with a click. Never end a turn on a question in plain text.',
    '- If their message is a task rather than a job description, do not attempt it. Call your question tool straight away with one question that says you are not set up for it yet and names the job you would be built for, with options like "Build me for that", "Just try it once", "Something else". No reply text before the call.',
    '- If their message names an area rather than a job ("help me with my expenses", "fix my mailbox"), work out the role first: where they manage it (the app, service or files), what exactly they want done there, and how (when you are asked or on a schedule; suggest or act). Name the role in the brief\'s summary ("An expense assistant that…").',
    '- Otherwise ask only what is still missing: the job, where the data comes from, what comes out, when it runs, and whether other people rely on it. At most four questions, in one round, with your question tool, in everyday words, with the recommended option marked. Never ask what they already said.',
    '- If the first message already says the job, where the data comes from, what comes out and when it runs, skip the questions. Where the data comes from is a named place (a site, an app, a folder, a mailbox); a topic ("AI news", "my expenses") is not one.',
    '- Recommend a capability only when the answers call for it. Follow the workshop kit\'s capability ladder and its anti-over-engineering rule (`../../.cinna-kit/README.md` from the agent folder) and the advisor table in its `guides/13-design-patterns.md` §0. Name each capability by what it gives the person in the app: the Credentials tab, the Schedules tab, the status shown on the agent, `/run:` commands, skills for separate kinds of request, handing work to another agent, published dashboards. No file names or manifest fields toward the person.',
    '- Never ask for a password, token or key in chat: they go in the agent\'s Credentials tab. If one is pasted, say so and suggest replacing it.',
    '- The brief\'s prompt holds only what they said or chose. A detail they did not give (a time, a format, an extra feature) is a `maybe` capability or a question, never written into the prompt as theirs; the card adds what they include.',
    '- The brief is the plan: never write a plan of your own for approval.',
    `- End with one call to \`${BUILD_BRIEF_TOOL}\`, then stop and wait. If they ask for changes, call it again with the revision.`
  ].join('\n')
}
