/**
 * The decisions the Agents tab makes, as pure functions.
 *
 * Two of them are worth pulling out of their components rather than three:
 * the list sub-line has an order that is easy to get subtly wrong, and the
 * in-place editors carry the **stamp round trip** — the rule that a save must
 * hand back the fingerprint the editor *read*, not a fresh one. A fresh stamp
 * detects nothing, so that rule is a correctness requirement rather than a
 * detail, and it is tested here rather than reasoned about in a component.
 *
 * Nothing in this file touches `window`, React or the DOM.
 */

import type {
  AgentRootDto,
  FileStamp,
  LocalAgentDto,
  LocalAgentReadiness
} from '../../../shared/localAgents'
import { describedAs } from '../../../shared/localAgents'
import { LAUNCHABLE_TOOL_KINDS, type DetectedTool } from '../../../shared/localTools'

export { describedAs }

/**
 * The installed tools a folder can be opened with, assistants before editors,
 * in detection order within each kind. The order the Open-in menu shows and
 * the new-agent flow offers.
 */
export function launchableTools(tools: readonly DetectedTool[]): DetectedTool[] {
  return LAUNCHABLE_TOOL_KINDS.flatMap((kind) =>
    tools.filter((tool) => tool.available && tool.kind === kind)
  )
}

/**
 * The default tool, if it is set **and** installed. A setting naming a tool
 * that has since been uninstalled (or was set on another machine's idea of
 * PATH) resolves to null — "ask" — rather than to a button that fails after
 * the click.
 */
export function resolveDefaultTool(
  launchable: readonly DetectedTool[],
  settingId: string
): DetectedTool | null {
  if (settingId === '') return null
  return launchable.find((tool) => tool.id === settingId) ?? null
}

/**
 * The most pressing readiness issue, in the words the list uses. `null` for an
 * agent with nothing wrong — the caller then falls through to the description.
 */
export function readinessLabel(readiness: LocalAgentReadiness): string | null {
  switch (readiness) {
    case 'credentials_needed':
      return 'credentials needed'
    case 'invalid':
      return 'manifest invalid'
    case 'contract_too_new':
      return 'update the app'
    default:
      return null
  }
}

/**
 * The line under an agent's name in the sidebar.
 *
 * Order matters and is the design's, not an accident: what the agent last said
 * about itself (`app-data/storage/STATUS.md`) outranks what the desktop noticed
 * about its folder, which outranks the static description. An agent that is
 * reporting on its own work should not have that replaced by "credentials
 * needed" the moment an optional slot goes unfilled.
 *
 * `credentialInactive` is the caller's, because it is not a property of the
 * folder: it is the join of this agent's resolved runtime against the *provider*
 * list, which only the sidebar has (`useAgentCredentialBindings`).
 */
export function agentSubline(agent: LocalAgentDto, credentialInactive = false): string {
  const summary = agent.status?.summary?.trim()
  if (summary) return summary
  // For an `invalid` folder the *reason* is the whole content: "manifest
  // invalid" names a state the user already sees and gives them nothing to act
  // on. It matters most for a duplicate manifest id, where the reason names the
  // other folder — and the row cannot be opened, so the agent page, where the
  // readiness strip would normally explain this, is out of reach. The one line
  // in the sidebar is the only place that explanation can land.
  if (agent.readiness === 'invalid') {
    // The validator's own words, minus its markdown: a sidebar line is not
    // rendered, so "`id` is required." would show its backticks.
    const reason = agent.readinessReason?.replace(/`/g, '').trim()
    if (reason) return reason
  }
  /*
    Above `readinessLabel`, and the ordering is the whole point.

    `credentials_needed` is about the *folder's* own `credentials/.env`; this is
    about the app's AI credential in Settings. Ranked the other way, an agent
    that is both showed a red dot — which this state owns — over the sub-line
    "credentials needed", pointing the user at a `.env` file for a problem two
    screens away. Two different meanings of one word is exactly the collision to
    resolve in favour of the one that made the dot red.

    Still below the `invalid` reason above: a folder that does not validate is
    never handed to the engine at all, so its credential is not yet the problem.
  */
  if (credentialInactive) return 'AI credential switched off'
  const issue = readinessLabel(agent.readiness)
  if (issue) return issue
  return describedAs(agent)
}

export interface LocalAgentGroup {
  root: AgentRootDto
  agents: LocalAgentDto[]
}

/**
 * Agents grouped by the root they live in: the default home first, then the
 * added roots in registration order. A registered root with no agents still
 * gets a group — that is how the user sees a folder they added is empty rather
 * than assuming the app ignored it.
 */
export function groupAgentsByRoot(
  roots: AgentRootDto[],
  agents: LocalAgentDto[]
): LocalAgentGroup[] {
  const ordered = [...roots].sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1
    return a.createdAt - b.createdAt
  })
  return ordered.map((root) => ({
    root,
    agents: agents
      .filter((agent) => agent.rootId === root.id)
      .sort((a, b) => a.name.localeCompare(b.name))
  }))
}


/**
 * `example_prompts` is a list in the manifest and a textarea on the page, one
 * prompt per line. These two are that translation, and they live here rather
 * than in the card for the reason the whole file exists: it is a data
 * transformation with an edge case, and a component is where an edge case goes
 * to be untested.
 *
 * The edge case is the newline. A prompt containing one cannot survive the
 * round trip — it comes back as two prompts — and doing that silently loses
 * text the user typed. {@link formatExamplePrompts} therefore refuses to encode
 * such a prompt as a plain line, and the parse rejects the input rather than
 * splitting it, so the manifest and the textarea never disagree about how many
 * prompts there are.
 */
export interface ExamplePromptsParse {
  prompts: string[]
  /** One sentence naming the offending line, or null when the text is usable. */
  error: string | null
}

/** Longest a single example prompt may be — `localAgentService`'s own limit. */
export const MAX_EXAMPLE_PROMPT_LENGTH = 2000

/** Most example prompts a manifest holds — again `localAgentService`'s limit. */
export const MAX_EXAMPLE_PROMPTS = 20

/**
 * The textarea's text as the list the manifest stores.
 *
 * Blank lines are how a list is edited, not entries, so they are dropped. A
 * line that is too long is reported **with its number**, because "that is too
 * long" against a ten-line textarea is not something a user can act on.
 */
export function parseExamplePrompts(text: string): ExamplePromptsParse {
  const prompts: string[] = []
  const lines = text.split('\n')
  let error: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line === '') continue
    // Every line is kept even when one is unusable: `prompts` must never be a
    // *shortened* list, because that is a silent edit — the card would save
    // three prompts where the user typed four and nothing would say so. The
    // error is what stops the save; the list is only what would have been sent.
    if (error === null && line.length > MAX_EXAMPLE_PROMPT_LENGTH) {
      error = `Line ${i + 1} is longer than ${MAX_EXAMPLE_PROMPT_LENGTH} characters.`
    }
    prompts.push(line)
  }
  if (error === null && prompts.length > MAX_EXAMPLE_PROMPTS) {
    error = `That is ${prompts.length} example prompts; the manifest holds at most ${MAX_EXAMPLE_PROMPTS}.`
  }
  return { prompts, error }
}

/**
 * The manifest's list as the textarea's text.
 *
 * A prompt holding a newline — which only an assistant or a hand edit can put
 * there, since the textarea cannot produce one — is flattened to a single line
 * rather than allowed to appear as two. Flattening is visible and reversible;
 * splitting silently changes how many prompts the agent has.
 */
export function formatExamplePrompts(prompts: readonly string[] | undefined): string {
  return (prompts ?? []).map((prompt) => prompt.replace(/\r?\n+/g, ' ').trim()).join('\n')
}

/**
 * What the page is showing for one editable file, and what it may do next.
 *
 * `stamp` is the whole point: it is the fingerprint taken by the read that
 * produced `savedText`, it is what a save hands back, and it is **not**
 * refreshed while the editor holds unsaved work. That is what makes a save
 * over an assistant's edit refusable — replacing it with whatever disk says
 * now would turn the guard into a rubber stamp.
 */
export interface FileEditorState {
  /** Agent-relative path — also the key into {@link LocalAgentDto.stamps}. */
  relPath: string
  /** What the user sees and types in. */
  text: string
  /** What the file said when `stamp` was taken. */
  savedText: string
  /** The stamp a save must hand back. `null` when the file does not exist. */
  stamp: FileStamp | null
  /**
   * Set when the folder moved underneath the editor:
   * - `external-change` — the file changed while there were unsaved edits.
   * - `refused` — a save was rejected because it had already changed.
   *
   * Either way the page shows a reload prompt and stops saving. There is no
   * retry: retrying is exactly the overwrite the refusal prevented.
   */
  conflict: 'external-change' | 'refused' | null
  /**
   * True when the last save was refused because a **turn holds the agent**.
   *
   * Categorically different from a conflict, and must not be shown as one. A
   * conflict means *someone else changed this file* — the edit can no longer be
   * applied and the only honest exit is a reload. Blocked means *not yet*: the
   * file is untouched, the stamp is still good, and the same save will succeed
   * once the run finishes. So the text is kept, {@link saveRequest} keeps
   * returning it, and the caller re-arms its timer. Dropping the edit here
   * would read Invariant 3 as "discard what the user typed during a run", which
   * it does not say.
   */
  blocked: boolean
  /** What the file says now, offered by the reload prompt. */
  diskText: string | null
  /**
   * The stamp {@link diskText} was read with. Kept beside it so a reload
   * adopts a text and a fingerprint from the *same* read — pairing the
   * conflicting text with a stamp from some other read is how a reload turns
   * into the next refused save.
   */
  diskStamp: FileStamp | null
}

/** A fresh editor over a file. */
export function seedFileEditor(
  relPath: string,
  text: string,
  stamp: FileStamp | null
): FileEditorState {
  return {
    relPath,
    text,
    savedText: text,
    stamp,
    conflict: null,
    blocked: false,
    diskText: null,
    diskStamp: null
  }
}

/** True when the editor holds work the folder has not seen. */
export function isDirty(state: FileEditorState): boolean {
  return state.text !== state.savedText
}

/** A keystroke. A standing conflict survives it — only a reload clears one. */
export function editFileText(state: FileEditorState, text: string): FileEditorState {
  if (text === state.text) return state
  return { ...state, text }
}

function sameStamp(a: FileStamp | null, b: FileStamp | null): boolean {
  if (a === null || b === null) return a === b
  return a.hash === b.hash && a.size === b.size
}

/**
 * A newly-scanned snapshot of the same file arrived — from a watcher push, a
 * refetch, or the save that just landed.
 *
 * Clean editor: adopt it, so an assistant's edit appears without a click.
 * Dirty editor: keep the user's text and raise `external-change`, keeping the
 * **old** stamp so a save cannot go through until they choose. Nothing is
 * discarded on either side without the user saying so.
 */
export function receiveFileSnapshot(
  state: FileEditorState,
  text: string,
  stamp: FileStamp | null
): FileEditorState {
  if (sameStamp(state.stamp, stamp)) return state
  if (state.conflict !== null) {
    // A refusal is the stronger statement — it is a save that already bounced —
    // so a later snapshot updates what the reload would take without demoting it.
    return { ...state, diskText: text, diskStamp: stamp }
  }
  if (text === state.savedText) {
    // The file moved but *this* editor's slice of it did not: the manifest
    // holds several cards, so saving the description changes the stamp the
    // example-prompts editor is holding without touching its value. Adopting
    // the new stamp keeps that editor usable, and loses nothing — main
    // re-reads the manifest and applies one field, so the other card's write
    // lands on top of this change rather than reverting it.
    return { ...state, stamp }
  }
  if (!isDirty(state)) {
    return seedFileEditor(state.relPath, text, stamp)
  }
  return { ...state, conflict: 'external-change', diskText: text, diskStamp: stamp }
}

/**
 * What to send for a save, or `null` when there is nothing to send.
 *
 * The returned `expectedStamp` is `state.stamp` — the one the rendered text was
 * read with. Handing back anything else (a stamp re-read at save time, the
 * stamp from a snapshot that arrived since) defeats the guard completely.
 */
export function saveRequest(
  state: FileEditorState
): { text: string; expectedStamp: FileStamp } | null {
  if (state.conflict !== null) return null
  if (!isDirty(state)) return null
  if (state.stamp === null) return null
  return { text: state.text, expectedStamp: state.stamp }
}

/**
 * A save landed. `savedText` is what the folder now holds — read back from the
 * returned agent, not echoed from the request, because main normalises what it
 * writes. Edits made while the save was in flight stay dirty and save next.
 */
export function saveSucceeded(
  state: FileEditorState,
  savedText: string,
  stamp: FileStamp | null
): FileEditorState {
  return {
    ...state,
    savedText,
    stamp,
    conflict: null,
    blocked: false,
    diskText: null,
    diskStamp: null
  }
}

/**
 * A save was refused because a turn holds the agent. **Retryable**, unlike
 * {@link saveRefused}: nothing was written, nothing changed underneath, and the
 * same request will land once the lock clears.
 *
 * Always returns a fresh object even when the flag is already set, because the
 * caller's debounce effect keys off state identity — returning `state` here
 * would leave a blocked editor with no armed timer and the user's text stranded
 * until they typed again.
 */
export function saveBlocked(state: FileEditorState): FileEditorState {
  return { ...state, blocked: true }
}

/** A save was refused because the file had changed. Never retried. */
export function saveRefused(state: FileEditorState, diskText: string | null): FileEditorState {
  return { ...state, conflict: 'refused', diskText: diskText ?? state.diskText }
}

/**
 * The user chose to take what is on disk, dropping their unsaved edits.
 *
 * The conflicting read is preferred when there is one, because it is the pair
 * the conflict was raised from; `text`/`stamp` are the caller's current
 * snapshot, used when a save was refused before any snapshot arrived. Either
 * way the two halves come from one read — a text reloaded against some other
 * read's stamp would simply bounce the next save.
 */
export function reloadFileEditor(
  state: FileEditorState,
  text: string,
  stamp: FileStamp | null
): FileEditorState {
  if (state.diskText !== null) {
    return seedFileEditor(state.relPath, state.diskText, state.diskStamp)
  }
  return seedFileEditor(state.relPath, text, stamp)
}
