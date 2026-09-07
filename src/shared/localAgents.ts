/**
 * The wire contract for **folder agents** — agents that are a plain folder on
 * disk laid out the way the kit contract describes (`src/shared/kit/`).
 *
 * Shared between main and renderer, so everything here is type-only or a plain
 * constant. Two rules shape the shapes below:
 *
 * 1. **Files are the truth.** The `agents` row is a derived index; a
 *    {@link LocalAgentDto} is a snapshot of what the folder said at scan time,
 *    carrying the parsed manifest verbatim so the agent page can render every
 *    card from one round trip.
 * 2. **Secrets never cross.** A manifest declares credential *slots*; it never
 *    holds a value. {@link LocalAgentCredentialState} reports which environment
 *    variable names are present in `credentials/.env` and nothing else, and the
 *    desktop-owned `app-data/desktop.json` is summarised without its token.
 */

import type {
  AgentPublication,
  AgentRuntimeRef,
  CinnaAgentManifest
} from './kit/manifest'
import { MANIFEST_FILE, SLUG_PATTERN } from './kit/manifest'
import type { ContractCompatibilityStatus } from './kit/contractVersion'
import type { LocalAgentRuntimeInput } from './engine'

/** Id prefix of a folder agent's `agents` row: `folder:<manifest id>`. */
export const FOLDER_AGENT_ID_PREFIX = 'folder:'

/** `agents.source` value for a folder agent. Joins `'local'` and `'remote'`. */
export const FOLDER_AGENT_SOURCE = 'folder'

/**
 * `agents.protocol` for a folder agent. Not `'a2a'` on purpose — a folder agent
 * is spoken to through the local engine, and the A2A-only paths
 * (`agentService.testAgent`, `listCliCommands`) already gate on `'a2a'`.
 */
export const FOLDER_AGENT_PROTOCOL = 'local-folder'

/** Main → renderer push when a watched folder changed on disk. */
export const LOCAL_AGENT_CHANGED_CHANNEL = 'local-agent:changed'

/** Directory inside a root that holds the agents, per `layout.json`. */
export const AGENTS_SUBDIR = 'Local'

/** True for an `agents` row id that names a folder agent. */
export function isFolderAgentId(agentId: string): boolean {
  return agentId.startsWith(FOLDER_AGENT_ID_PREFIX)
}

/** The `agents` row id for a manifest id. */
export function folderAgentId(manifestId: string): string {
  return `${FOLDER_AGENT_ID_PREFIX}${manifestId}`
}

/**
 * Where a folder agent's identity comes from.
 *
 * - `manifest` — the manifest states an `id`. The row id is `folder:<id>`, and
 *   it follows the folder through renames, moves between roots and a copy onto
 *   another machine.
 * - `legacy` — the manifest parsed but states no `id`. The kit contract
 *   deliberately tolerates this (contract 1.0.0, "Breaking": `schema_version`
 *   manifests are *read*, not rejected), so the folder is a supported agent —
 *   it is indexed, opens, edits and runs. Its identity is **positional**,
 *   derived from the root it sits in and its folder name, so renaming or moving
 *   the folder produces a different agent and its chats do not follow. "Stamp
 *   identity" ({@link LocalAgentFieldUpdate}) is the fix, and it is never
 *   applied automatically: writing to a user's manifest unprompted breaks
 *   Invariant 3, and an assistant may have that file open.
 * - `unresolved` — the manifest could not be read at all. There is no identity
 *   to key a row on, so the folder lists but is never indexed; the row it
 *   already had is held back rather than replaced.
 */
export type LocalAgentIdentity = 'manifest' | 'legacy' | 'unresolved'

/**
 * The `agents` row id of a folder whose manifest states no `id`.
 *
 * Keyed by **root id and folder name**, not folder name alone: two roots can
 * each hold a `Local/assistant`, and a name-only key would hand them the same
 * row — the second scan would then re-point the first one's row at the second
 * one's folder.
 */
export function legacyFolderAgentId(rootId: string, folderName: string): string {
  return `${FOLDER_AGENT_ID_PREFIX}legacy:${rootId}:${folderName}`
}

/**
 * The list id of a folder that lost a fight over a manifest `id`.
 *
 * When two folders claim the same `id` — which is what copying an agent folder
 * to start a new one produces, so it is ordinary rather than exotic — only the
 * first can own `folder:<id>`. The loser still has to *appear*, because the
 * finding naming the collision is attached to it and the agents list is the
 * only place the user can read it. It therefore needs an id of its own: the
 * list keys rows by this value **and selects by it**, so handing both rows the
 * same one gives React a duplicate key and sends a click on the loser to the
 * winner's page — where the editors then write to a different agent's files
 * than the one the user clicked.
 *
 * Positional, like {@link legacyFolderAgentId}, and never indexed: `locate()`
 * finds no row, so the page shows its "could not be read" state with a Rescan
 * button instead of silently opening somebody else's folder.
 */
export function duplicateFolderAgentId(rootId: string, folderName: string): string {
  return `${FOLDER_AGENT_ID_PREFIX}duplicate:${rootId}:${folderName}`
}

/**
 * How ready a folder is to run.
 *
 * - `ok` — validates, and every required credential slot is filled.
 * - `credentials_needed` — valid, but a required `.env` variable is missing.
 * - `invalid` — the manifest or the folder failed validation (this includes an
 *   unparseable manifest; a half-written file is a state, never a crash).
 * - `contract_too_new` — the folder records a contract major this build does
 *   not understand. Read-only until the app is updated.
 */
export type LocalAgentReadiness = 'ok' | 'credentials_needed' | 'invalid' | 'contract_too_new'

/** A validator finding, flattened for the renderer. */
export interface LocalAgentFinding {
  /** Stable dotted identifier — key messages off this, not the text. */
  code: string
  message: string
  /** Agent-relative path the finding is about, when there is one. */
  path?: string
}

export interface LocalAgentValidation {
  errors: LocalAgentFinding[]
  warnings: LocalAgentFinding[]
  infos: LocalAgentFinding[]
}

/**
 * One credential slot's local state. `presentFields` names the `.env` keys that
 * exist; no value is ever read, let alone sent.
 */
export interface LocalAgentCredentialState {
  name: string
  type: string
  optional: boolean
  envPrefix: string | null
  /** `<env_prefix><FIELD>` names the slot declares. */
  expectedKeys: string[]
  /** The subset of `expectedKeys` that `credentials/.env` defines. */
  presentKeys: string[]
  satisfied: boolean
}

/**
 * One entry of `docs/CLI_COMMANDS.yaml`. The catalog is cloud-first — commands
 * are written as the platform runs them — so `localCommand` carries the same
 * command rewritten by the contract's `local_command_runner` rules, which is
 * what a local run and the "copy" affordance should use.
 */
export interface LocalAgentCommand {
  name: string
  description: string
  /** Verbatim from the catalog. */
  command: string
  /** Localised: `python …` becomes `uv run …` where a `pyproject.toml` exists. */
  localCommand: string
}

/** Frontmatter of `app-data/storage/STATUS.md`, when the file exists. */
export interface LocalAgentStatusSummary {
  /** One-line summary the agents list shows under the name. */
  summary: string | null
  /** Free-form state word the agent writes (`healthy`, `blocked`, …). */
  state: string | null
  /** `updated`/`updated_at` frontmatter value, verbatim. */
  updatedAt: string | null
  /** The markdown after the frontmatter, for the Status card. */
  body: string
}

/**
 * What the desktop's own `app-data/desktop.json` says, minus the secret. The
 * agent token stays in the main process — only its presence crosses.
 */
export interface LocalAgentDesktopSummary {
  localApiBaseUrl: string | null
  hasAgentToken: boolean
  sessionCount: number
  lastStatusAt: number | null
}

/**
 * "Did this file change" fingerprint, round-tripped by the editors. Structurally
 * `manifestIo.ManifestStamp`: metadata to short-circuit, a content hash to
 * decide. Kept as its own type because it crosses the IPC boundary and covers
 * the prompt documents as well as the manifest.
 */
export interface FileStamp {
  mtimeMs: number
  size: number
  /** SHA-256 of the exact bytes the stamp was taken from. */
  hash: string
}

/**
 * A folder agent as the renderer sees it. `manifest` is the parsed
 * `cinna-agent.json` verbatim (unknown keys included) so the agent page can
 * render every card without a second call.
 */
export interface LocalAgentDto {
  /** `folder:<manifest id>` — also the `agents` row id. */
  id: string
  /** The manifest's own `id` (UUID), without the prefix. `''` when it has none. */
  manifestId: string
  /** Where {@link id} came from — see {@link LocalAgentIdentity}. */
  identity: LocalAgentIdentity
  rootId: string
  rootPath: string
  /** Absolute path of the agent folder. */
  path: string
  /** Folder name; equals `manifest.slug` when the folder validates. */
  slug: string
  name: string
  description: string
  enabled: boolean
  readiness: LocalAgentReadiness
  /** One sentence explaining a non-`ok` readiness. */
  readinessReason: string | null
  contractStatus: ContractCompatibilityStatus
  manifest: CinnaAgentManifest
  publications: AgentPublication[]
  runtime: AgentRuntimeRef | null
  credentials: LocalAgentCredentialState[]
  /** `docs/CLI_COMMANDS.yaml`, parsed — what the Commands card renders. */
  commands: LocalAgentCommand[]
  status: LocalAgentStatusSummary | null
  validation: LocalAgentValidation
  desktop: LocalAgentDesktopSummary
  /**
   * Stamps of the files the page can edit, keyed by agent-relative POSIX path.
   * An editor round-trips the stamp into `updateField` so a save over a file
   * that changed underneath is refused instead of clobbering it.
   */
  stamps: Record<string, FileStamp | null>
  /** When this snapshot was taken (epoch ms). */
  scannedAt: number
}

/** A registered agents root — the default home, or one the user added. */
export interface AgentRootDto {
  id: string
  path: string
  label: string
  isDefault: boolean
  /** False when the directory has gone missing since it was registered. */
  exists: boolean
  agentCount: number
  /** Kit contract this root resolves — the workshop's copy, else the bundled one. */
  contractVersion: string
  createdAt: number
}

export interface CreateLocalAgentInput {
  /** Human name. The slug is derived from it unless `slug` is given. */
  name: string
  /**
   * One sentence: what the agent does. Optional — a name is all that is needed
   * to scaffold a folder, and the description is usually written later by the
   * assistant that builds the agent. Absent or blank, main writes the name in
   * its place, because the kit schema requires a non-empty `description` and
   * an invalid folder would be a worse start than a redundant one.
   */
  description?: string
  /** Lower-case, hyphenated folder name. Derived from `name` when absent. */
  slug?: string
  /** Root to scaffold into. The default home when absent. */
  rootId?: string
}

/** The three document-backed prompts, by their manifest key. */
export type LocalAgentPromptKind = 'workflow' | 'entrypoint' | 'refiner'

/**
 * One in-place edit from the agent page. Every variant writes exactly one file
 * — the manifest, or one prompt document.
 */
export type LocalAgentFieldUpdate =
  | { field: 'name'; value: string }
  | { field: 'description'; value: string }
  | { field: 'example_prompts'; value: string[] }
  | { field: 'router_trigger_prompt'; value: string | null }
  | { field: 'status_refresh_command'; value: string | null }
  | { field: 'prompt'; prompt: LocalAgentPromptKind; value: string }
  /**
   * Which credential and model this agent runs on.
   *
   * A **reference** and a model id, never a key — `runtimeService` refuses a
   * value matching the validator's own secret-lookalike pattern rather than
   * trusting the renderer, because this lands in a file the user commits.
   * Clearing both removes the `runtime` block and the agent falls back to the
   * Default runtime derived from the default chat mode.
   */
  | { field: 'runtime'; value: LocalAgentRuntimeInput }
  /**
   * Give a legacy folder a durable identity: a fresh UUID `id`, plus the active
   * `contract_version` when the manifest has none.
   *
   * Carries no value — the UUID is minted in main. The renderer has no business
   * choosing an agent's identity, and a `value` here would be an id-setter that
   * any other card could reach.
   *
   * Both keys, not just `id`: the validator reads "`schema_version` and neither
   * `contract_version` nor `id`" as the legacy shape and warns; writing `id`
   * alone leaves that shape behind and the manifest becomes *invalid* for a
   * missing `contract_version`. The contract's own migration note says the same
   * — "re-stamp a legacy manifest by adding `contract_version` and `id`".
   */
  | { field: 'stamp_identity' }

export interface UpdateLocalAgentFieldInput {
  agentId: string
  update: LocalAgentFieldUpdate
  /**
   * The stamp the editor last read for the file this update writes, from
   * {@link LocalAgentDto.stamps}. Required: without it the desktop cannot tell
   * an unchanged file from one an assistant rewrote while the editor was open.
   */
  expectedStamp: FileStamp
}

/** Payload of {@link LOCAL_AGENT_CHANGED_CHANNEL}. */
export interface LocalAgentChangedPayload {
  rootId: string
  /** The agent that changed, or null when the whole root was rescanned. */
  agentId: string | null
  reason: 'watch' | 'rescan' | 'create'
}

/** What a rescan did, for the caller's log line. */
export interface RescanResult {
  rootId: string
  scanned: number
  indexed: number
  pruned: number
}

/** `local-agent:open-path` — reveal a file or folder inside an agent. */
/**
 * The description worth showing, or `''` when it is only the name repeated.
 *
 * A folder created from a name alone carries that name as its `description`
 * — the kit schema requires one — and every surface that renders a sub-line
 * under the name (the agent page header, the Agents tab, the `@` and `[+]`
 * pickers' `agents.description` column) would otherwise say the name twice.
 * Applied where the index row is built as well as where it is rendered, so
 * the two agree.
 */
export function describedAs(agent: { name: string; description: string }): string {
  const description = agent.description.trim()
  return description === agent.name.trim() ? '' : description
}

/** What `local-agent:delete` returns on success. */
export interface DeleteLocalAgentResult {
  agentId: string
  /** The folder went to the OS trash, never `rm -rf` — it can be put back. */
  trashed: true
}

/** What `local-agent:open-credentials` reports back about the click. */
export interface OpenLocalAgentCredentialsResult {
  /** The file was not there and was seeded with the declared variable names. */
  created: boolean
  /**
   * Nothing on this machine would open the file, so it was revealed in the
   * file manager instead. The renderer says so rather than claiming an editor
   * opened somewhere the user cannot see.
   */
  revealed: boolean
}

export interface OpenLocalAgentPathInput {
  agentId: string
  /**
   * Agent-relative POSIX path. Omitted or empty reveals the agent folder
   * itself. Never absolute, never containing `..` — the main process refuses
   * both rather than trusting the renderer.
   */
  relPath?: string
}

/**
 * Agent-relative paths of the three document-backed prompts, keyed the way
 * {@link LocalAgentFieldUpdate} names them.
 *
 * Shared rather than main-private because the editor has to look the *right*
 * stamp up in {@link LocalAgentDto.stamps} before it can save: a save that
 * hands back the manifest's stamp for a prompt document would be waved through
 * by a guard that is comparing two unrelated files.
 */
export const LOCAL_AGENT_PROMPT_PATHS: Record<LocalAgentPromptKind, string> = {
  workflow: 'docs/WORKFLOW_PROMPT.md',
  entrypoint: 'docs/ENTRYPOINT_PROMPT.md',
  refiner: 'docs/REFINER_PROMPT.md'
}

/** The one file a given update writes, as a key into {@link LocalAgentDto.stamps}. */
export function fieldFilePath(update: LocalAgentFieldUpdate): string {
  return update.field === 'prompt' ? LOCAL_AGENT_PROMPT_PATHS[update.prompt] : MANIFEST_FILE
}

/**
 * A result that can carry a **failure code across the IPC boundary**.
 *
 * Electron serialises a rejected `ipcMain.handle` as `{message, stack}` and
 * nothing else. `_wrap.ts` faithfully attaches `err.code` to the error it
 * throws, and that property is dropped in transit — the renderer receives a
 * plain `Error` whose only own properties are `stack` and `message`, and whose
 * message is wrapped as *"Error invoking remote method '<channel>': …"*.
 *
 * Everything that branches on a code therefore has to see it in the **payload**
 * rather than on the error. The channels that need one return this, and the
 * preload bridge turns a failure back into a rejected `Error` carrying `code`,
 * so callers keep their ordinary try/catch and `isStaleWriteError` and
 * {@link isBlockedWriteError} answer truthfully.
 *
 * Only the channels whose codes drive behaviour use this. A channel whose
 * failure is only ever shown as a sentence keeps throwing.
 */
export type LocalAgentOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; name: string; message: string }

/** The failure half of a {@link LocalAgentOutcome}, from a coded error. */
export function localAgentFailure(err: {
  code: string
  name: string
  message: string
}): LocalAgentOutcome<never> {
  return { ok: false, code: err.code, name: err.name, message: err.message }
}

/**
 * Turn an outcome back into a value or a thrown error carrying its `code`.
 *
 * Lives here, not in preload, so the two halves of the contract can be driven
 * against each other in a test. The property being restored is invisible at
 * every call site — `isStaleWriteError` simply starts returning the truth — so
 * nothing else would notice it breaking again.
 */
export function unwrapLocalAgentOutcome<T>(outcome: LocalAgentOutcome<T>): T {
  if (outcome.ok) return outcome.value
  const error = new Error(outcome.message) as Error & { code: string }
  error.name = outcome.name
  error.code = outcome.code
  throw error
}

/**
 * Error codes a write carries when it was refused because the file changed
 * since the editor read it.
 *
 * Two codes because two writers report it: `manifestIo.writeIfUnchanged`
 * throws `KitError('manifest_modified')` for the manifest, and the prompt
 * documents go through `LocalAgentError('file_modified')`. Both mean the same
 * thing to the user — reload before saving — and neither may be retried.
 */
export const STALE_WRITE_ERROR_CODES: readonly string[] = ['manifest_modified', 'file_modified']

/** True when a rejected save must become a reload prompt rather than a retry. */
export function isStaleWriteError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && STALE_WRITE_ERROR_CODES.includes(code)
}

/**
 * Error code a write carries when a **turn holds the agent** — `turnLock`
 * refuses rather than queueing, so the desktop never writes mid-stream
 * (Invariant 3).
 *
 * Deliberately *not* in {@link STALE_WRITE_ERROR_CODES}. Those two mean the
 * file changed and the edit can never be applied; this one means *not yet*.
 * Nothing was written, the stamp is still valid, and the identical save will
 * succeed once the run finishes — so the right response is to keep the text and
 * try again, never a reload prompt (which discards it) and never a dead-end
 * error (which strands it until the user happens to type another character).
 */
export const BLOCKED_WRITE_ERROR_CODE = 'turn_in_progress'

/** True when a rejected save should be retried once the agent is free. */
export function isBlockedWriteError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === BLOCKED_WRITE_ERROR_CODE
}

/**
 * Folder name for an agent name. The scaffolder applies exactly this rule, so
 * the slug the new-agent form shows is the folder the user will get; an empty
 * result means "no usable slug", which the caller must surface rather than
 * silently substituting one.
 */
export function slugifyAgentName(name: string): string {
  const slug = reduceToSlugCharacters(name)
  return SLUG_PATTERN.test(slug) ? slug : ''
}

/** The ASCII reduction, before the contract's pattern gets a vote. */
function reduceToSlugCharacters(name: string): string {
  return name
    .normalize('NFKD')
    // Strip combining marks so "Café" becomes "cafe", not "caf".
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/, '')
}

/**
 * Why a name produced no folder name, and what to offer instead.
 *
 * {@link slugifyAgentName} returns `''` for three unrelated reasons, and a form
 * that reports them with one sentence tells two of those users something false.
 * "日本語エージェント" has plenty of letters; "X" has one and it is fine. Saying
 * *"no letters or digits"* to either is wrong, and for a user typing in a
 * non-Latin script it is also a wall — there is no hint that an ASCII folder
 * name is what is wanted, and the folder field is the way through.
 *
 * So each case gets its own sentence and, crucially, its own **editable
 * suggestion**: the caller prefills it and the user proceeds, rather than being
 * stopped by a form that will not say what it wants.
 */
export type AgentSlugProblem = 'ok' | 'empty' | 'too_short' | 'not_transliterable'

export interface AgentSlugCheck {
  /** The folder name to use — the derived one, else {@link suggestion}. */
  slug: string
  problem: AgentSlugProblem
  /** One sentence for the form, or null when the name produced a slug. */
  message: string | null
  /** An ASCII starting point when the name could not produce one. */
  suggestion: string | null
}

export function describeAgentSlug(name: string): AgentSlugCheck {
  if (name.trim() === '') {
    return { slug: '', problem: 'empty', message: null, suggestion: null }
  }
  const reduced = reduceToSlugCharacters(name)
  if (SLUG_PATTERN.test(reduced)) {
    return { slug: reduced, problem: 'ok', message: null, suggestion: null }
  }
  if (reduced === '') {
    // Cyrillic, CJK, Greek, emoji — letters the ASCII fold cannot carry.
    // Transliterating them properly is a library-sized problem and guessing
    // badly is worse than asking, so offer a name and let the user edit it.
    return {
      slug: 'agent',
      problem: 'not_transliterable',
      message:
        'Folder names use Latin letters and digits, which this name has none of. Edit the folder name below — the agent keeps the name you typed.',
      suggestion: 'agent'
    }
  }
  // One usable character. The contract's pattern wants at least two.
  const suggestion = `${reduced}-agent`
  return {
    slug: suggestion,
    problem: 'too_short',
    message: `Folder names need at least two letters or digits, so this one becomes "${suggestion}". Edit it below if you would rather it were something else.`,
    suggestion
  }
}

/** `local-agent:read-doc` — one of the three prompt documents. */
export interface ReadLocalAgentDocInput {
  agentId: string
  prompt: LocalAgentPromptKind
}

/**
 * One prompt document, with the stamp taken from the **same read** as the text.
 *
 * The prompt documents are not carried in {@link LocalAgentDto} — the list
 * would then haul three markdown files per agent around for a sub-line — so the
 * page reads the one it is showing. Pairing the text with its own stamp here is
 * what lets the editor satisfy Invariant 3 exactly: what it renders and what it
 * hands back at save time came from one read of one file.
 */
export interface LocalAgentDocDto {
  /** Agent-relative POSIX path, matching the key in {@link LocalAgentDto.stamps}. */
  relPath: string
  text: string
  /** `null` when the document does not exist; such a document cannot be saved. */
  stamp: FileStamp | null
}

/** Which half of the draft the AI managed to write. */
export interface LocalAgentDraftParts {
  workflowPrompt: boolean
  examplePrompts: boolean
  routerTrigger: boolean
}

/**
 * Outcome of the one-shot AI draft that follows a scaffold.
 *
 * Never an exception for the ordinary cases: a machine with no AI credential
 * configured still gets its folder, and the page says what to add. `agent` is
 * always the freshly-scanned folder, drafted or not, so the caller can seed its
 * cache from one round trip.
 */
export interface DraftLocalAgentResult {
  status: 'drafted' | 'skipped' | 'failed'
  parts: LocalAgentDraftParts
  /** One sentence explaining a `skipped` or `failed` outcome. */
  reason: string | null
  agent: LocalAgentDto
}
