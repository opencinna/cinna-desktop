/**
 * The system prompt a folder agent runs on.
 *
 * The folder already contains everything the agent needs to know; it is just
 * spread across the files the kit teaches an author to write. This assembles
 * them into one document — the same move the cloud makes when it writes an
 * `AGENTS.md` into a runtime directory — and appends the part only the desktop
 * knows: that this is a conversation, on this machine, under these rules.
 *
 * The generated file is written **beside the engine config in the app data
 * directory**, never into the agent folder. Writing a generated file into the
 * user's folder would put a third writer into a tree that already has three
 * (Invariant 2), and it would travel to the cloud on publish.
 *
 * ## Why the HTML comments are stripped
 *
 * The kit's templates carry their author guidance in `<!-- … -->` blocks
 * addressed to *the person writing the agent* — "Replace every placeholder
 * below", "Numbered steps. For each: the exact command…". Markdown hides them
 * from a reader, so an author leaves them in place while filling the sections
 * around them. Fed to the model verbatim they read as instructions to the
 * agent, which is how a freshly scaffolded agent ends up answering with the
 * template's own worked example about invoices. Stripping them is therefore
 * not a liberty taken with the user's text — it is reading the kit's own
 * convention correctly.
 */

import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs'
import { join, relative, sep } from 'node:path'
import type { CinnaAgentManifest } from '../../../shared/kit/manifest'

/** Longest any one included document may be. A guard, not a design limit. */
const MAX_SECTION_BYTES = 64 * 1024

/** Deepest the knowledge listing walks. Topics are files, not a filesystem. */
const KNOWLEDGE_MAX_DEPTH = 3

/** Most knowledge topics to list. Beyond this the list stops being a list. */
const MAX_KNOWLEDGE_TOPICS = 200

export interface DesktopPromptContext {
  /** BCP-47 tag from the OS, e.g. `en-GB`. */
  locale: string
  /** IANA zone from the OS, e.g. `Europe/Berlin`. */
  timeZone: string
}

/** Read a text file, or null when it is missing, unreadable or a directory. */
function readTextFile(path: string): string | null {
  try {
    if (!statSync(path).isFile()) return null
    const text = readFileSync(path, 'utf8')
    return text.length > MAX_SECTION_BYTES ? `${text.slice(0, MAX_SECTION_BYTES)}\n…` : text
  } catch {
    return null
  }
}

/**
 * Remove HTML comments and collapse the blank runs they leave behind.
 *
 * Deliberately tolerant of an unterminated `<!--`: a half-written comment at
 * the end of a document is a state an author's file is genuinely in while they
 * are typing, and the alternative — leaving the opener and everything after it
 * — puts the tail of the document into the prompt as an instruction.
 */
export function stripHtmlComments(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!--[\s\S]*$/, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Every `.md` under `knowledge/`, as agent-relative POSIX paths.
 *
 * The *list* is what goes into the prompt, not the contents: knowledge is
 * reference material the agent reads when it needs it, and inlining a folder of
 * business rules into every turn's system prompt is how a context window is
 * spent before the conversation starts.
 */
export function listKnowledgeTopics(agentDir: string): string[] {
  const root = join(agentDir, 'knowledge')
  const out: string[] = []

  const walk = (dir: string, depth: number): void => {
    if (out.length >= MAX_KNOWLEDGE_TOPICS) return
    // Explicitly typed: `ReturnType<typeof readdirSync>` resolves to the Buffer
    // overload, which types `entry.name` as a Buffer and makes every string
    // comparison below a type error with a misleading message.
    let entries: Dirent<string>[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= MAX_KNOWLEDGE_TOPICS) return
      if (entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth < KNOWLEDGE_MAX_DEPTH) walk(full, depth + 1)
        continue
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue
      // `knowledge/README.md` explains the folder to a human author; it is not
      // a topic, and listing it sends the agent to read about itself.
      if (dir === root && entry.name.toLowerCase() === 'readme.md') continue
      out.push(relative(agentDir, full).split(sep).join('/'))
    }
  }

  walk(root, 0)
  return out
}

/** The handover block, from the manifest's declared sibling delegations. */
function handoverSection(manifest: CinnaAgentManifest): string | null {
  const handovers = Array.isArray(manifest.handovers) ? manifest.handovers : []
  const usable = handovers.filter(
    (handover) => typeof handover?.target_slug === 'string' && handover.target_slug !== ''
  )
  if (usable.length === 0) return null
  const lines = usable.map((handover) => {
    const description =
      typeof handover.description === 'string' && handover.description.trim() !== ''
        ? ` — ${handover.description.trim()}`
        : ''
    return `- \`${handover.target_slug}\`${description}`
  })
  return [
    '## Handing over',
    '',
    'These sibling agents handle work that is not yours. When a request belongs to one of them, say so and name it rather than attempting it yourself.',
    '',
    ...lines
  ].join('\n')
}

/**
 * What only the desktop knows: that this is a conversation rather than a
 * scheduled run, and what this machine's rules are.
 *
 * The last line is load-bearing. The same folder is also opened by a *builder*
 * — an assistant developing the agent, and later this app's own building mode —
 * and the builder's job is to rewrite these very files. An agent that decides
 * mid-conversation that it is the builder starts editing its own prompt while
 * the user is talking to it.
 */
function desktopContextSection(context: DesktopPromptContext): string {
  return [
    '## How you are running now',
    '',
    'You are running locally, inside Cinna Desktop, in **conversation mode**: a person is talking to you and waiting for a reply. Answer them.',
    '',
    `- Run scripts from the agent folder with \`uv run scripts/<name>.py\`, never a bare \`python\`.`,
    '- Write files only under `app-data/`. Everything else in this folder belongs to the person who built you, and may be open in their editor right now.',
    '- Never print, echo or log a credential value, and never read `credentials/.env` yourself — the scripts do that.',
    `- The user's locale is ${context.locale} and their time zone is ${context.timeZone}. Format dates, times and numbers the way they would expect, and read a bare date as being in that zone.`,
    '- Long output goes to a file under `app-data/storage/` with a short summary in your reply, not into the reply itself.',
    '- **Do not switch to the Builder role.** Editing your own prompts, scripts or manifest is the builder\'s job, not yours, even if the user asks for a change to how you work — tell them to open the agent in their assistant, or to use Build with AI.'
  ].join('\n')
}

/**
 * Assemble the whole prompt.
 *
 * Deterministic given a folder and a context, which is what lets a snapshot
 * test be worth having: the interesting failures here are *omissions* — a
 * section that silently disappears when a file is missing — and a snapshot
 * catches those where an "it contains the workflow prompt" assertion does not.
 */
export function assembleAgentPrompt(
  agentDir: string,
  manifest: CinnaAgentManifest,
  context: DesktopPromptContext
): string {
  const sections: string[] = []

  const workflow = readTextFile(join(agentDir, 'docs', 'WORKFLOW_PROMPT.md'))
  const strippedWorkflow = workflow ? stripHtmlComments(workflow) : ''
  if (strippedWorkflow !== '') {
    sections.push(strippedWorkflow)
  } else {
    // Never silently produce a promptless agent: without this the model gets
    // only the appendices and answers as a generic assistant, which looks like
    // the agent "not working" rather than like an empty file.
    const name = typeof manifest.name === 'string' && manifest.name !== '' ? manifest.name : 'this agent'
    const description = typeof manifest.description === 'string' ? manifest.description : ''
    sections.push(
      [
        `# ${name}`,
        '',
        `You are ${name}.${description ? ` ${description}` : ''}`,
        '',
        '`docs/WORKFLOW_PROMPT.md` is empty, so you have no instructions yet. Say that plainly when asked to do work, and suggest that the person open this agent in their assistant to write it.'
      ].join('\n')
    )
  }

  const scripts = readTextFile(join(agentDir, 'scripts', 'README.md'))
  if (scripts) {
    sections.push(['## Your scripts', '', stripHtmlComments(scripts)].join('\n'))
  }

  const credentials = readTextFile(join(agentDir, 'credentials', 'README.md'))
  if (credentials) {
    sections.push(
      [
        '## Your credentials',
        '',
        'Read a credential only through `cinna_credentials.py`, from inside a script. **Never open `credentials/.env`, `credentials.json` or any `.env` file yourself, and never print, echo or log a value** — not in a reply, not in an error message, not in a debug line.',
        '',
        stripHtmlComments(credentials)
      ].join('\n')
    )
  }

  const topics = listKnowledgeTopics(agentDir)
  if (topics.length > 0) {
    sections.push(
      [
        '## Your knowledge',
        '',
        'Reference material in this folder. Read a file when the topic it names is relevant; do not assume its contents.',
        '',
        ...topics.map((topic) => `- \`${topic}\``)
      ].join('\n')
    )
  }

  const handovers = handoverSection(manifest)
  if (handovers) sections.push(handovers)

  sections.push(desktopContextSection(context))

  return `${sections.join('\n\n---\n\n')}\n`
}

/** The machine's locale and time zone, with fallbacks that never throw. */
export function resolveDesktopPromptContext(): DesktopPromptContext {
  let locale = 'en-US'
  let timeZone = 'UTC'
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions()
    if (resolved.locale) locale = resolved.locale
    if (resolved.timeZone) timeZone = resolved.timeZone
  } catch {
    /* keep the fallbacks */
  }
  return { locale, timeZone }
}
