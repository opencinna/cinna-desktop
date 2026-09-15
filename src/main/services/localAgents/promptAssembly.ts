import { isCoordinatorHandover } from '../../../shared/kit/handovers'
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
import {
  BARE_AGENT_INSTRUCTION_FILES,
  BARE_AGENT_README_FILE,
  bareInstructionsFileList,
  type BareInstructionsFile
} from '../../../shared/localAgents'
import { resolveBareInstructionsFile } from './externalScan'

/** Longest any one included document may be. A guard, not a design limit. */
const MAX_SECTION_BYTES = 64 * 1024

/** Deepest the knowledge listing walks. Topics are files, not a filesystem. */
const KNOWLEDGE_MAX_DEPTH = 3

/** Most knowledge topics to list. Beyond this the list stops being a list. */
const MAX_KNOWLEDGE_TOPICS = 200

/** A kit folder's guide for an assistant working *on* the agent. */
const KIT_BUILDER_GUIDE_FILE = 'AGENTS.md'

export interface DesktopPromptContext {
  /** BCP-47 tag from the OS, e.g. `en-GB`. */
  locale: string
  /** IANA zone from the OS, e.g. `Europe/Berlin`. */
  timeZone: string
}

/** True when `path` is a regular file. */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
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
  const siblings = handovers.filter((handover) => handover?.target_kind === undefined &&
    typeof handover?.target_slug === 'string' && handover.target_slug !== '')
  const coordinator = handovers.some(isCoordinatorHandover)
  if (!siblings.length && !coordinator) return null
  const sections = ['## Handing over', '']
  if (siblings.length) {
    sections.push('These sibling agents handle work that is not yours. When a request belongs to one of them, say so and name it rather than attempting it yourself.', '',
      ...siblings.map((handover) => `- \`${handover.target_slug}\`${typeof handover.description === 'string' && handover.description.trim() ? ` — ${handover.description.trim()}` : ''}`))
  }
  if (coordinator) sections.push('',
    'When a Cinna task coordinator has handed this task to you, you may return a note after completing your work: end your answer with a standalone `/handback <note>` line (at most 4000 characters). The note should say what you did, verified, and left open. This returns to that existing coordinator; it does not finish the whole task or authorize another agent. In an ordinary conversation this marker has no control effect. Ask any necessary human question before returning the task.')
  return sections.join('\n')
}

/**
 * Building mode: the person asked to change the agent, so this conversation
 * becomes the build session.
 *
 * A local agent is something its user builds and uses in the same breath —
 * "you got the rebate wrong, add that to your workflow" is the ordinary next
 * message after a wrong answer. The rule this replaced refused exactly that
 * and sent the user to another assistant, turning the one person entitled to
 * change the agent away from the window they were already in. So the request
 * *is* the decision: no confirmation is asked, and the mode sticks for the rest
 * of the conversation, because refining an agent is several rounds of change
 * and try.
 *
 * What stays out is the case the old rule existed for: an agent that decides
 * **by itself** that it is the builder, or an unattended task asking for a
 * change nobody is there to see. Neither switches. On OpenCode the identity
 * files still ask (`configGenerator.ts`, `IDENTITY_FILES`), and that — not this
 * text — is the control; Claude and Codex have only this text.
 *
 * The last line matters on every engine: the system prompt was assembled before
 * the agent's own edits, so within a turn the edited file, not the prompt, is
 * what holds.
 *
 * `guide` finishes the "say you are switching, then …" sentence and names a
 * builder document only when the folder has one: a rule that points at a
 * missing file is how a model ends up refusing the work.
 */
function buildingModeSection(guide: string, editable: string): string[] {
  return [
    '## Building mode',
    '',
    'When the person asks you to change how you work — correct an answer for next time, add a trigger or a step, fix or add a script, extend what you do — switch to **building mode** and make the change yourself. The request is their decision to build you: do not refuse it, do not ask them to confirm it, and do not send them to another tool.',
    '',
    '- Only a person\'s request switches you. Never switch on your own initiative, and never for an unattended or handed-over task.',
    `- Say in one line that you are switching to building mode, then ${guide}`,
    `- In building mode you may edit ${editable}. Say which files you changed.`,
    '- Stay in building mode for the rest of this conversation: the person may keep refining you and trying the result. When they ask for your actual job, do it the way your edited files now say — the instructions above were read before your edits.'
  ]
}

/**
 * What only the desktop knows: how this local turn receives requests and
 * asks for human input, what this machine's rules are, and when the
 * conversation may turn into building the agent.
 *
 * The `app-data/` rule is scoped to conversation mode, since building a kit
 * agent means editing `docs/`, `scripts/` and the manifest. The kit folder's own
 * `AGENTS.md` routes on the same two roles — Builder when the user asks to
 * change the agent — so building mode hands over to it where it exists.
 */
function desktopContextSection(agentDir: string, context: DesktopPromptContext): string {
  const guide = isFile(join(agentDir, KIT_BUILDER_GUIDE_FILE))
    ? `read \`${KIT_BUILDER_GUIDE_FILE}\` in this folder and follow it — it is the guide to building this agent.`
    : 'keep your definition coherent: `docs/WORKFLOW_PROMPT.md` is what you do, `scripts/README.md` catalogues every script, and `cinna-agent.json` describes you truthfully.'
  return [
    '## How you are running now',
    '',
    'You are running locally, inside Cinna Desktop, and you start in **conversation mode**. Reply to the current request. It may come from a person or an unattended task; request human input through the available question or permission mechanism when needed, and do not assume a person is watching.',
    '',
    `- Run scripts from the agent folder with \`uv run scripts/<name>.py\`, never a bare \`python\`.`,
    '- In conversation mode, write files only under `app-data/`. Everything else in this folder is your definition, and may be open in an editor right now.',
    '- Never print, echo or log a credential value, and never read `credentials/.env` yourself — the scripts do that.',
    `- The user's locale is ${context.locale} and their time zone is ${context.timeZone}. Format dates, times and numbers the way they would expect, and read a bare date as being in that zone.`,
    '- Long output goes to a file under `app-data/storage/` with a short summary in your reply, not into the reply itself.',
    '',
    ...buildingModeSection(
      guide,
      'whatever in this folder the change needs — `docs/`, `scripts/`, `knowledge/`, `config/`, `cinna-agent.json`, the `Makefile`, `pyproject.toml` — but never `app-data/desktop.json`, which belongs to Cinna Desktop'
    ),
    // The scanner marks a folder whose manifest or command catalog fails
    // validation `invalid`, and the driver refuses every turn after that — so a
    // broken edit is one the person cannot ask this agent to repair.
    '- Keep `cinna-agent.json` and `docs/CLI_COMMANDS.yaml` valid. If either stops validating, Cinna Desktop will not run your next turn, and the person cannot ask you to fix it.'
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
        '`docs/WORKFLOW_PROMPT.md` is empty, so you have no instructions yet. Say that plainly when asked to do work, and suggest that the person tell you what you should do, so you can write it in building mode.'
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

  sections.push(desktopContextSection(agentDir, context))

  return `${sections.join('\n\n---\n\n')}\n`
}

/**
 * The desktop context block for a **bare** agent.
 *
 * Three of the kit block's rules are dropped rather than reworded, because each
 * of them describes a folder convention a bare folder never agreed to: `uv run`
 * (the kit scaffolds a `pyproject.toml`; this folder may be a shell script or
 * nothing at all), "write only under `app-data/`" (there is no `app-data/`, and
 * the desktop deliberately keeps its own state out of this folder), and the
 * `credentials/.env` rule (there are no declared slots to read through). Stating
 * a rule about a file that does not exist is how a model ends up refusing to do
 * ordinary work in the folder it was pointed at.
 *
 * Building mode is kept, pointed at this shape's own builder document: the
 * folder's `README.md` where it has one — the same file the init prompt briefs
 * an outside assistant from — and otherwise the instructions file itself.
 *
 * `instructionsFile` is the one the folder resolved to; a folder with none is
 * named `AGENT.md`, the file building mode would write to give it instructions.
 */
function bareDesktopContextSection(
  agentDir: string,
  instructionsFile: BareInstructionsFile,
  context: DesktopPromptContext
): string {
  const hasReadme = isFile(join(agentDir, BARE_AGENT_README_FILE))
  return [
    '## How you are running now',
    '',
    'You are running locally, inside Cinna Desktop, and you start in **conversation mode**. Reply to the current request. It may come from a person or an unattended task; request human input through the available question or permission mechanism when needed, and do not assume a person is watching.',
    '',
    '- Your working directory is this agent folder. It may be open in an editor right now, so in conversation mode prefer reading over rewriting, and say what you changed.',
    '- Follow whatever the instructions above say about how to run this folder\'s own scripts and tools. Cinna Desktop imposes no convention of its own here.',
    '- Never print, echo or log a credential value, and never read a `.env` file or any other secret file to answer a question about it.',
    `- The user's locale is ${context.locale} and their time zone is ${context.timeZone}. Format dates, times and numbers the way they would expect, and read a bare date as being in that zone.`,
    '- Long output goes to a file in this folder with a short summary in your reply, not into the reply itself.',
    '',
    ...buildingModeSection(
      hasReadme
        // "Read it for", not "follow it": a repository README is setup steps as
        // much as guidance, and a model told to follow it runs `make install`
        // before making a one-line change to its instructions file.
        ? `read \`${BARE_AGENT_README_FILE}\` in this folder for how this agent is organised and developed — as background, not as setup steps to run.`
        : `work from \`${instructionsFile}\`, which is your whole definition.`,
      `\`${instructionsFile}\`${hasReadme ? ` and \`${BARE_AGENT_README_FILE}\`` : ''}, and anything else in this folder the change needs`
    )
  ].join('\n')
}

/**
 * The system prompt a **bare** agent runs on: its instructions file — the first
 * of `AGENT.md`, `AGENTS.md` or `CLAUDE.md` the folder has, resolved the way the
 * scan resolves it — and nothing else the folder contains.
 *
 * The asymmetry with {@link assembleAgentPrompt} is the whole design. A kit
 * folder has a known shape, so the assembler can safely reach into `scripts/`,
 * `credentials/` and `knowledge/` and know what it will find. A bare folder has
 * no shape at all: it is somebody's repository. Concatenating whatever `.md`
 * files happen to be lying in it would put a changelog, a licence or another
 * agent's notes into the system prompt as instructions.
 *
 * **`README.md` is deliberately not included.** A folder's README is written
 * for the person developing the agent — how to install it, how to run it, what
 * it needs — not for the agent, which would read "run `make install` first" as
 * a step it should take. It is the *builder's* document: the init prompt
 * (`localAgentService.initPrompt`) briefs an outside assistant from it, and
 * building mode names it for the agent to read only once the person has asked
 * for a change.
 *
 * HTML comments are stripped for the same reason they are in a kit folder: they
 * are addressed to a reader of the source, and a model reads them as
 * instructions.
 */
export function assembleBareAgentPrompt(
  agentDir: string,
  name: string,
  context: DesktopPromptContext
): string {
  const sections: string[] = []
  const instructionsFile = resolveBareInstructionsFile(agentDir)
  const raw = instructionsFile === null ? null : readTextFile(join(agentDir, instructionsFile))
  const instructions = raw ? stripHtmlComments(raw) : ''

  if (instructions !== '') {
    sections.push(instructions)
  } else {
    // Same rule as the kit path: never silently produce a promptless agent.
    // Without this the model gets only the context block and answers as a
    // generic assistant, which reads as "the agent is broken" rather than as
    // "the file is empty".
    const absence =
      instructionsFile === null
        ? `This folder has no ${bareInstructionsFileList((file) => `\`${file}\``)}, so you have no instructions yet.`
        : `\`${instructionsFile}\` in this folder is empty, so you have no instructions yet.`
    sections.push(
      [
        `# ${name}`,
        '',
        `You are ${name}.`,
        '',
        `${absence} Say that plainly when asked to do work, and suggest that the person tell you what you should do, so you can write it in building mode.`
      ].join('\n')
    )
  }

  sections.push(
    bareDesktopContextSection(
      agentDir,
      instructionsFile ?? BARE_AGENT_INSTRUCTION_FILES[0],
      context
    )
  )
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
