/**
 * The file-handover contract — what a `brief.md` and a `report.md` mean.
 *
 * Any folder with an instructions file is already a bare agent. The handover
 * convention gives it an inbox: `.cinna/handovers/<id>/brief.md` is a request,
 * `report.md` beside it is the answer. The requester may be a Cinna agent, a
 * `claude` in a terminal, a script or a person; the executor likewise. So the
 * contract has to live in *files*, and the only thing both ends can agree on is
 * this module's reading of them.
 *
 * **Pure, and it has to stay pure.** This is the one description of the
 * contract, imported by the main process (scan and intake), by the renderer
 * (task page, agent card) and by tests. No Node built-ins — no `node:crypto`,
 * so digests are computed by whoever read the bytes, not here — no logging, no
 * throwing: a half-written file is a state, never a crash. Every parse failure
 * comes back as data with a {@link HandoverParseReason} the caller can show.
 *
 * **Why hand-written parsing.** The project has no YAML dependency and this is
 * not worth adding one for (`src/main/kit/miniYaml.ts` made the same call for
 * the kit contract, but it is a main-process module and the renderer cannot
 * import it). The subset here is deliberately smaller than miniYaml's: flat
 * `key: value` scalars, the one nested `origin:` map, and `artifacts:` as a
 * block list. Anything else in the frontmatter is ignored, so a newer writer's
 * extra keys do not make an old build refuse the file.
 *
 * Cinna reads this tree and never writes it (`drafts/file_handovers` §3.2,
 * §4.3): every desktop-side fact — task id, run state, refusal reason — has a
 * home in SQLite already.
 */

import type { InputQuestion } from './runEvents'

/** Marker *and* schema version: `cinna_handover: 1`. Without it, the folder is not a handover. */
export const HANDOVER_SCHEMA_VERSION = 1

/** Where handovers live, relative to the agent folder. Must be gitignored for `auto` (§3.4). */
export const HANDOVERS_DIR = '.cinna/handovers'

/** The requester's file: written once, immutable after `status: ready`. */
export const HANDOVER_BRIEF_FILE = 'brief.md'

/** The executor's file, and the only one it owns: rewritten as freely as it likes. */
export const HANDOVER_REPORT_FILE = 'report.md'

/**
 * Where the requester's follow-ups live, beside the brief (§3.2, phase 4).
 *
 * `revisions/001.md`, `002.md`, … — each written once and never edited, for the
 * same reason a `ready` brief is not: the executor may already be acting on it.
 * A correction to a revision is the next revision.
 */
export const HANDOVER_REVISIONS_DIR = 'revisions'

/**
 * `NNN.md`, three digits or more.
 *
 * Three so the ordinary case sorts lexicographically in every tool that lists
 * the directory, and "or more" so a hundredth revision does not need a new
 * rule. The number is the *order*, not an index into anything: gaps are fine,
 * and the desktop delivers whatever it finds, in name order.
 */
const REVISION_FILE_PATTERN = /^(\d{3,})\.md$/

export function isRevisionFileName(name: string): boolean {
  return REVISION_FILE_PATTERN.test(name)
}

/**
 * The digits out of a revision file name, **as written** — `001`, not `1`.
 *
 * The text the executor reads says "revision 001", which is the thing it can
 * find on disk; normalising the number would name a file that is not there.
 */
export function revisionOrdinal(name: string): string | null {
  return REVISION_FILE_PATTERN.exec(name)?.[1] ?? null
}

/**
 * How deep a chain of handovers may go: a ticket manager (depth 0) hands to
 * project agents (depth 1), which may hand once more (depth 2). Above that a
 * brief is recorded and refused with a visible reason — which is also what
 * stops two folders handing to each other forever (§3.4, §4.3).
 */
export const MAX_HANDOVER_DEPTH = 2

/**
 * A handover id, chosen by the requester (recommended `YYYYMMDD-HHMM-<slug>`).
 *
 * Lower case, starts alphanumeric, then dots, dashes and underscores; 3 to 64
 * characters in total. It becomes a directory name on three platforms and part
 * of an Inbox request id, so no spaces, no separators, no case games.
 */
export const HANDOVER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/

export function isHandoverId(value: unknown): value is string {
  return typeof value === 'string' && HANDOVER_ID_PATTERN.test(value)
}

/**
 * What the brief *asks for*. `auto` is a request, not a permission: it is
 * honoured only where the receiving agent's own setting allows it (§3.4), never
 * by the brief alone — anything that can write to the folder, including a
 * `git pull`, can plant one.
 */
export type HandoverExecution = 'ask' | 'auto'

export const HANDOVER_EXECUTIONS: readonly HandoverExecution[] = ['ask', 'auto']

/** Only `ready` is picked up; `draft` is a file someone is still writing. */
export type HandoverBriefStatus = 'draft' | 'ready'

export const HANDOVER_BRIEF_STATUSES: readonly HandoverBriefStatus[] = ['draft', 'ready']

/**
 * Where the work is, as the executor sees it.
 *
 * `in_progress` is also a **claim**: an executor running outside the app writes
 * it before it starts, so the desktop does not launch a second one on the same
 * brief (§3.9). `blocked` is a question for the requester, not a failure.
 */
export type HandoverReportStatus = 'in_progress' | 'blocked' | 'done' | 'failed'

export const HANDOVER_REPORT_STATUSES: readonly HandoverReportStatus[] = [
  'in_progress',
  'blocked',
  'done',
  'failed'
]

/** The two statuses that finish a handover and wake the origin (§3.6). */
export const TERMINAL_REPORT_STATUSES: readonly HandoverReportStatus[] = ['done', 'failed']

/**
 * Who asked, as the brief states it. **Nothing is inferred** (§3.5): a brief
 * with no origin, or one naming an agent that does not exist for this profile,
 * is a human-origin handover — it runs the same way and simply has nobody to
 * wake. Validating the ids is intake's job; this module only reads them.
 */
export interface HandoverOrigin {
  agentId?: string
  chatId?: string
  taskId?: string
}

export interface HandoverBrief {
  title: string
  status: HandoverBriefStatus
  execution: HandoverExecution
  origin: HandoverOrigin | null
  /** The requester's own depth + 1. Over {@link MAX_HANDOVER_DEPTH} is a refusal, not a parse failure. */
  depth: number
  /** Fan-out group id (phase 4); `null` when absent. */
  group: string | null
  /** The markdown after the frontmatter, trimmed at the ends and otherwise verbatim. */
  body: string
}

/**
 * A `revisions/NNN.md` — the requester coming back with more to say.
 *
 * Deliberately thinner than a brief: no `status`, no `execution`, no `origin`.
 * All of those were decided when the brief was picked up, and a revision that
 * could change them would be an edit-after-ready by another name. It carries
 * only what a follow-up turn needs — an optional `title` and the text.
 */
export interface HandoverRevision {
  title: string | null
  /** Required: a revision with nothing in it has nothing to deliver. */
  body: string
}

export interface HandoverReport {
  status: HandoverReportStatus
  /** One line, required: it becomes the task's handoff note together with the body. */
  summary: string
  /** Only meaningful with `blocked`, but accepted whatever the status says. */
  question: string | null
  /** Paths relative to the project, exactly as written — this module resolves nothing. */
  artifacts: string[]
  body: string
}

/**
 * Why a file is not a handover.
 *
 * Distinct codes rather than one message, because the desktop shows them: a
 * `no_marker` file is somebody else's markdown and is silently ignored, while
 * `bad_depth` on a file that carries the marker is worth telling the user about.
 */
export type HandoverParseReason =
  | 'no_frontmatter'
  | 'no_marker'
  | 'bad_schema_version'
  | 'bad_status'
  | 'bad_execution'
  | 'bad_depth'
  | 'bad_title'
  | 'bad_origin'
  | 'bad_group'
  | 'bad_summary'
  | 'bad_artifacts'
  | 'bad_body'

export type HandoverParseFailure = { ok: false; reason: HandoverParseReason; detail?: string }

export type HandoverBriefParseResult = { ok: true; brief: HandoverBrief } | HandoverParseFailure

export type HandoverReportParseResult = { ok: true; report: HandoverReport } | HandoverParseFailure

export type HandoverRevisionParseResult =
  | { ok: true; revision: HandoverRevision }
  | HandoverParseFailure

/** Is a depth within the cap? Over it, the brief is recorded and refused (§3.4). */
export function isDepthAllowed(depth: number): boolean {
  return Number.isInteger(depth) && depth >= 0 && depth <= MAX_HANDOVER_DEPTH
}

/** Would Cinna act on this brief? Parsed, marked, and `status: ready` (§3.2). */
export function isReadyBrief(result: HandoverBriefParseResult): boolean {
  return result.ok && result.brief.status === 'ready'
}

export function isReportTerminal(status: HandoverReportStatus): boolean {
  return (TERMINAL_REPORT_STATUSES as readonly string[]).includes(status)
}

// ---------------------------------------------------------------------------
// The frontmatter subset
// ---------------------------------------------------------------------------

/** A scalar as this subset understands it. `null` is an empty or omitted value. */
type Scalar = string | number | null

interface Frontmatter {
  scalars: Map<string, Scalar>
  /** Present only when the file has an `origin:` block; values unparsed. */
  origin: Map<string, Scalar> | null
  /** Present only when the file has an `artifacts:` key. */
  artifacts: Scalar[] | null
  /** An `artifacts:` key whose shape is not a list — reported, not guessed. */
  badArtifacts: boolean
  /** An `origin:` key with an inline value instead of a nested map. */
  badOrigin: boolean
  body: string
}

/**
 * Split off the frontmatter.
 *
 * A leading UTF-8 BOM and CRLF line endings are accepted — both arrive from
 * editors on Windows and from scripts that write with `iconv`. The **closing
 * `---` is the first later line that is exactly `---`**, with no exception for
 * a ``` fence opened inside the frontmatter region. That is the whole rule, on
 * purpose: tracking fences here would mean a stray unclosed fence could swallow
 * the entire file, and the frontmatter subset has no room for a fenced value
 * anyway. A fence in the *body* is untouched, `---` inside it included.
 */
function splitFrontmatter(text: string): { lines: string[]; body: string } | null {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  // `trimEnd`, not `trim`: a delimiter must start its line, so a markdown
  // horizontal rule halfway down a README never turns a document into a
  // handover, while a trailing space an editor left behind is forgiven.
  const isDelimiter = (line: string): boolean => line.trimEnd() === '---'
  if (lines.length === 0 || !isDelimiter(lines[0])) return null
  const close = lines.findIndex((line, index) => index > 0 && isDelimiter(line))
  if (close === -1) return null
  return { lines: lines.slice(1, close), body: lines.slice(close + 1).join('\n').trim() }
}

/** Strip a trailing ` # comment` from an unquoted scalar, as `miniYaml` does. */
function stripComment(value: string): string {
  const index = value.search(/\s#/)
  return index === -1 ? value : value.slice(0, index).trimEnd()
}

function unquote(value: string): string | null {
  if (value.length < 2) return null
  const quote = value[0]
  if ((quote !== '"' && quote !== "'") || value[value.length - 1] !== quote) return null
  const inner = value.slice(1, -1)
  return quote === '"' ? inner.replace(/\\(["\\])/g, '$1') : inner.replace(/''/g, "'")
}

/**
 * One scalar token. Quoted strings keep their content; a bare integer becomes a
 * number (that is how `cinna_handover` and `depth` arrive); everything else
 * stays a string. No booleans and no floats: nothing in this contract has one,
 * and a `title: true` is a title.
 */
function parseScalar(raw: string): Scalar {
  const trimmed = raw.trim()
  const quoted = unquote(trimmed)
  if (quoted !== null) return quoted
  const value = stripComment(trimmed)
  if (value === '' || value === '~' || value === 'null') return null
  if (/^[-+]?\d+$/.test(value)) return Number(value)
  return value
}

/**
 * The keys a list item may name its path with — `- path: x`, `- file: x`.
 *
 * Nothing else: a map with a key this contract does not define says the writer
 * meant something the desktop cannot read, and reading it as a path anyway is
 * how `name: "path: RETRY.md"` ended up on a task (observed on a live run).
 */
const ARTIFACT_PATH_KEYS = ['path', 'file']

function splitKey(content: string): { key: string; rest: string } | null {
  const match = /^([A-Za-z0-9_.-]+)\s*:(?:\s*(.*))?$/.exec(content)
  if (!match) return null
  return { key: match[1], rest: (match[2] ?? '').trim() }
}

function parseFrontmatter(lines: string[], body: string): Frontmatter {
  const fm: Frontmatter = {
    scalars: new Map(),
    origin: null,
    artifacts: null,
    badArtifacts: false,
    badOrigin: false,
    body
  }
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index].replace(/\t/g, '  ')
    const content = raw.trim()
    if (content === '' || content.startsWith('#')) continue
    if (raw.length - raw.trimStart().length > 0) continue // a stray indented line: not ours
    const pair = splitKey(content)
    if (!pair) continue

    if (pair.key === 'origin') {
      if (pair.rest !== '') {
        // `origin: something` is a requester that meant to name an agent and
        // got the shape wrong — louder than an ignored unknown key.
        fm.badOrigin = true
        continue
      }
      const origin = new Map<string, Scalar>()
      while (index + 1 < lines.length) {
        const next = lines[index + 1].replace(/\t/g, '  ')
        const trimmed = next.trim()
        if (trimmed === '') {
          index += 1
          continue
        }
        if (next.length - next.trimStart().length === 0) break
        index += 1
        if (trimmed.startsWith('#')) continue
        const child = splitKey(trimmed)
        if (child) origin.set(child.key, parseScalar(child.rest))
      }
      fm.origin = origin
      continue
    }

    if (pair.key === 'artifacts') {
      if (pair.rest === '') {
        const items: Scalar[] = []
        while (index + 1 < lines.length) {
          const next = lines[index + 1].replace(/\t/g, '  ').trim()
          if (next === '') {
            index += 1
            continue
          }
          if (!next.startsWith('-')) break
          index += 1
          const item = next.slice(1).trim()
          // `- path: src/x.ts` is what a real executor wrote when this contract
          // asked for "one `- path` per line": it read the placeholder as a key.
          // The two keys that can only have meant the path itself are read as
          // the path; any other map shape is `bad_artifacts` rather than a
          // guess, because an artifact is a thing the UI links to. A quoted item
          // is never a map — `- "a: b"` is a file whose name has a colon in it.
          const entry = unquote(item) === null ? splitKey(item) : null
          if (entry) {
            if (!ARTIFACT_PATH_KEYS.includes(entry.key.toLowerCase())) {
              fm.badArtifacts = true
              continue
            }
            items.push(parseScalar(entry.rest))
            continue
          }
          items.push(parseScalar(item))
        }
        fm.artifacts = items
        continue
      }
      // `artifacts: [a, b]` — the one inline form, because a writer that emits
      // real YAML may well produce it.
      if (pair.rest.startsWith('[') && pair.rest.endsWith(']')) {
        const inner = pair.rest.slice(1, -1).trim()
        fm.artifacts = inner === '' ? [] : inner.split(',').map((item) => parseScalar(item))
        continue
      }
      fm.badArtifacts = true
      continue
    }

    fm.scalars.set(pair.key, parseScalar(pair.rest))
  }
  return fm
}

/** A scalar as a non-empty string, or `null`. Numbers stringify: an id may be digits. */
function asText(value: Scalar | undefined): string | null {
  if (value === null || value === undefined) return null
  const text = typeof value === 'number' ? String(value) : value.trim()
  return text === '' ? null : text
}

function fail(reason: HandoverParseReason, detail?: string): HandoverParseFailure {
  return detail === undefined ? { ok: false, reason } : { ok: false, reason, detail }
}

/**
 * The marker check both files share. The version is compared as a number, and a
 * quoted `"1"` passes: a writer that quotes everything is still speaking this
 * contract.
 */
function checkMarker(fm: Frontmatter): HandoverParseFailure | null {
  if (!fm.scalars.has('cinna_handover')) return fail('no_marker')
  const raw = fm.scalars.get('cinna_handover') ?? null
  const version = typeof raw === 'number' ? raw : Number(asText(raw) ?? 'NaN')
  if (version !== HANDOVER_SCHEMA_VERSION) {
    return fail('bad_schema_version', String(asText(raw) ?? ''))
  }
  return null
}

function readOrigin(fm: Frontmatter): { ok: true; origin: HandoverOrigin | null } | HandoverParseFailure {
  if (fm.badOrigin) return fail('bad_origin', 'inline')
  if (!fm.origin) return { ok: true, origin: null }
  const origin: HandoverOrigin = {}
  const keys: [string, keyof HandoverOrigin][] = [
    ['agent', 'agentId'],
    ['chat', 'chatId'],
    ['task', 'taskId']
  ]
  for (const [key, field] of keys) {
    if (!fm.origin.has(key)) continue
    const raw = fm.origin.get(key) ?? null
    // A key that is *there* but empty, or not a string, is a broken origin
    // rather than an absent one — the requester meant to name something.
    if (typeof raw !== 'string' || raw.trim() === '') return fail('bad_origin', key)
    origin[field] = raw.trim()
  }
  return { ok: true, origin }
}

/**
 * Read a `brief.md`.
 *
 * `status` is required: there is no safe default between "pick this up" and
 * "somebody is still typing", so a brief without one is a parse failure the
 * user can see rather than a file that silently never runs. `execution`
 * defaults to `ask` and `depth` to 1 — both have an obviously safe value.
 *
 * A depth over the cap parses fine. Refusing it is intake's decision (it wants
 * to record the row and show a reason), so ask {@link isDepthAllowed}.
 */
export function parseHandoverBrief(text: string): HandoverBriefParseResult {
  const split = splitFrontmatter(text)
  if (!split) return fail('no_frontmatter')
  const fm = parseFrontmatter(split.lines, split.body)

  const marker = checkMarker(fm)
  if (marker) return marker

  const status = asText(fm.scalars.get('status'))
  if (!status || !(HANDOVER_BRIEF_STATUSES as readonly string[]).includes(status)) {
    return fail('bad_status', status ?? '')
  }

  const rawExecution = fm.scalars.get('execution')
  const execution = rawExecution === undefined ? 'ask' : asText(rawExecution)
  if (!execution || !(HANDOVER_EXECUTIONS as readonly string[]).includes(execution)) {
    return fail('bad_execution', execution ?? '')
  }

  const rawDepth = fm.scalars.get('depth')
  // A quoted `"1"` counts, for the same reason a quoted marker does: a writer
  // that quotes every value is still speaking this contract.
  const depthText = rawDepth === undefined ? '1' : (asText(rawDepth) ?? '')
  const depth = /^\d+$/.test(depthText) ? Number(depthText) : Number.NaN
  if (!Number.isInteger(depth)) return fail('bad_depth', depthText)

  const title = asText(fm.scalars.get('title'))
  if (!title) return fail('bad_title')

  const origin = readOrigin(fm)
  if (!origin.ok) return origin

  const rawGroup = fm.scalars.get('group')
  const group = rawGroup === undefined ? null : asText(rawGroup)
  if (rawGroup !== undefined && !isHandoverId(group)) return fail('bad_group', group ?? '')

  return {
    ok: true,
    brief: {
      title,
      status: status as HandoverBriefStatus,
      execution: execution as HandoverExecution,
      origin: origin.origin,
      depth,
      group,
      body: fm.body
    }
  }
}

/**
 * Read a `report.md`.
 *
 * `summary` is required because it is what the requester and the task list
 * read; a report body nobody summarised is a report nobody can see in a list.
 * `artifacts` is optional, and a shape that is not a list is `bad_artifacts`
 * rather than a guess — an artifact path is a thing the UI links to.
 */
export function parseHandoverReport(text: string): HandoverReportParseResult {
  const split = splitFrontmatter(text)
  if (!split) return fail('no_frontmatter')
  const fm = parseFrontmatter(split.lines, split.body)

  const marker = checkMarker(fm)
  if (marker) return marker

  const status = asText(fm.scalars.get('status'))
  if (!status || !(HANDOVER_REPORT_STATUSES as readonly string[]).includes(status)) {
    return fail('bad_status', status ?? '')
  }

  const summary = asText(fm.scalars.get('summary'))
  if (!summary) return fail('bad_summary')

  if (fm.badArtifacts) return fail('bad_artifacts')
  const artifacts: string[] = []
  for (const item of fm.artifacts ?? []) {
    const path = asText(item)
    if (!path) return fail('bad_artifacts')
    artifacts.push(path)
  }

  return {
    ok: true,
    report: {
      status: status as HandoverReportStatus,
      summary,
      question: asText(fm.scalars.get('question')),
      artifacts,
      body: fm.body
    }
  }
}

/**
 * Read a `revisions/NNN.md`.
 *
 * Same marker as the other two files — a directory beside a brief is still a
 * place anything may drop a markdown file, and the marker is what says "this
 * one is for you". `title` is optional because a follow-up is usually a
 * paragraph, not a ticket; the **body is required**, because the body is the
 * entire message and an empty revision would wake an executor with nothing.
 *
 * Anything else in the frontmatter is ignored rather than refused: a revision
 * cannot change the brief's `status`, `execution` or `origin`, and the way to
 * say so is to not read them (§3.2 — a `ready` brief is never edited again).
 */
export function parseHandoverRevision(text: string): HandoverRevisionParseResult {
  const split = splitFrontmatter(text)
  if (!split) return fail('no_frontmatter')
  const fm = parseFrontmatter(split.lines, split.body)

  const marker = checkMarker(fm)
  if (marker) return marker

  const body = fm.body.trim()
  if (body === '') return fail('bad_body')

  return { ok: true, revision: { title: asText(fm.scalars.get('title')), body } }
}

// ---------------------------------------------------------------------------
// Desktop-side state
// ---------------------------------------------------------------------------

/**
 * Where a handover is, from the desktop's side — the `handovers` table's
 * `state` (§4.1). Wider than the report's vocabulary because it also records
 * what the desktop did or refused to do:
 *
 *  - `seen` — recorded, nothing decided yet. Also the fallback for a value this
 *    build does not know.
 *  - `gated` — a question is open in the Inbox (§3.4).
 *  - `running` — Cinna started the executor.
 *  - `waiting_external` — somebody else claimed it with `status: in_progress`
 *    before we started (§3.9); Cinna starts nothing.
 *  - `blocked` — the report asks the requester a question.
 *  - `done` / `failed` — a terminal report arrived.
 *  - `skipped` — the user answered Skip, or the brief disappeared before the
 *    task finished.
 *  - `refused` — the desktop declined: over the depth cap, or `auto` in a
 *    folder whose handovers are tracked by git. `refusalReason` says which.
 */
export type HandoverState =
  | 'seen'
  | 'gated'
  | 'running'
  | 'waiting_external'
  | 'blocked'
  | 'done'
  | 'failed'
  | 'skipped'
  | 'refused'

export const HANDOVER_STATES: readonly HandoverState[] = [
  'seen',
  'gated',
  'running',
  'waiting_external',
  'blocked',
  'done',
  'failed',
  'skipped',
  'refused'
]

/** A state off a row or the wire. Unknown → `seen`: recorded, and nothing claimed about it. */
export function parseHandoverState(raw: unknown): HandoverState {
  return (HANDOVER_STATES as readonly unknown[]).includes(raw) ? (raw as HandoverState) : 'seen'
}

/**
 * The per-agent desktop setting — the actual security boundary (§3.4). Stored in
 * desktop state under `userData`, never in the folder: the folder can be written
 * by anything that can write to the folder.
 */
export type HandoverSetting = 'ask' | 'auto'

export const HANDOVER_SETTINGS: readonly HandoverSetting[] = ['ask', 'auto']

/** Ask, always, until the user says otherwise for a specific project. */
export const DEFAULT_HANDOVER_SETTING: HandoverSetting = 'ask'

export function parseHandoverSetting(raw: unknown): HandoverSetting {
  return (HANDOVER_SETTINGS as readonly unknown[]).includes(raw)
    ? (raw as HandoverSetting)
    : DEFAULT_HANDOVER_SETTING
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * The three answers to a gate card, in the order they are offered.
 *
 * Constants because main matches the user's answer against them and the tests
 * pin the order; the wording is the one part a UX review may still change
 * (draft §7), and changing it here changes it everywhere at once.
 */
export const HANDOVER_GATE_OPTIONS = {
  run: 'Run',
  runAndAuto: 'Run and auto-run handovers in this project',
  skip: 'Skip'
} as const

/**
 * A gate is a `question` with options — the existing Inbox rendering, not a new
 * component ("an ask has one rendering", `docs/jobs/tasks`). Single choice: the
 * options are mutually exclusive decisions about one brief.
 *
 * `offerAuto` is the security boundary showing through the copy. "Run and
 * auto-run handovers in this project" writes a standing permission, and
 * {@link HandoverIgnoreCheck} may already say that permission cannot be given
 * — a `.cinna/handovers` that git tracks travels, so anything that can land a
 * commit could plant a brief. Offering an option that would be refused on the
 * way back is worse than not offering it, so the caller passes what the check
 * said and the card shows two options instead of three.
 */
export function handoverGateQuestion(input: {
  title: string
  folderName: string
  /** Defaults to true — the three-option card. */
  offerAuto?: boolean
}): InputQuestion {
  const title = input.title.trim() || 'Untitled handover'
  const folder = input.folderName.trim() || 'this project'
  return {
    question: `Run the handover “${title}” in ${folder}?`,
    header: 'Handover',
    multiSelect: false,
    options: [
      { label: HANDOVER_GATE_OPTIONS.run },
      ...(input.offerAuto === false ? [] : [{ label: HANDOVER_GATE_OPTIONS.runAndAuto }]),
      { label: HANDOVER_GATE_OPTIONS.skip }
    ]
  }
}

const GATE_REQUEST_PREFIX = 'handover:'

/**
 * The Inbox request id for a gate, keyed by the `handovers` **row** id (not the
 * requester-chosen handover id, which is only unique per folder).
 */
export function handoverGateRequestId(handoverRowId: string): string {
  return `${GATE_REQUEST_PREFIX}${handoverRowId}`
}

/** The row id back out of a request id, or `null` when the id belongs to somebody else. */
export function parseHandoverGateRequestId(requestId: string): string | null {
  if (!requestId.startsWith(GATE_REQUEST_PREFIX)) return null
  const rowId = requestId.slice(GATE_REQUEST_PREFIX.length)
  return rowId === '' ? null : rowId
}

// ---------------------------------------------------------------------------
// The words the protocol is taught in
// ---------------------------------------------------------------------------

/**
 * What the requester is told to put at the end of `brief.md`.
 *
 * It is part of the *brief* because the executor may be a terminal session
 * Cinna never talks to (§3.2). The `in_progress`-before-you-start line is not
 * politeness: it is how an outside executor claims the brief so the desktop
 * does not start a second one (§3.9).
 */
export const HANDOVER_HOW_TO_REPORT = [
  '## How to report',
  '',
  `Write \`${HANDOVER_REPORT_FILE}\` beside this file, with frontmatter \`cinna_handover: ${HANDOVER_SCHEMA_VERSION}\`,`,
  '`status: in_progress | blocked | done | failed`, a one-line `summary`, and the details below it.',
  'Write it with `status: in_progress` before you start, so nothing else picks this up.',
  '`done` and `failed` are final; `blocked` means you need an answer — put it in `question`.',
  'List any files you changed under `artifacts:` as a YAML list of paths relative to the',
  'project, one per line, like `- src/upload/retry.ts`.'
].join('\n')

/**
 * What a Cinna agent is told about *asking* for a handover — the requester's
 * half of the protocol, pasted into every folder agent's system prompt (§3.5,
 * §3.8: kit agents are requesters too, even though they are not targets).
 *
 * It names the agent's own id because that is what `origin.agent` has to say,
 * and it points at the turn header for the chat and task ids: those change per
 * turn and cannot live in a system prompt (a chat id there would start one
 * Codex process per chat).
 *
 * The example is a whole file rather than a list of fields, because the failure
 * this text exists to prevent is a half-written brief: a `ready` frontmatter
 * with no body, or a body appended after the desktop already recorded the file.
 */
export function handoverRequesterSection(agentId: string): string {
  return [
    '## Handing work to another project',
    '',
    `Any folder adopted in Cinna Desktop has a handover inbox. To ask one for work, create \`${HANDOVERS_DIR}/<id>/${HANDOVER_BRIEF_FILE}\` inside **that** project. The \`<id>\` is yours to choose: 3 to 64 characters, lower case, starting with a letter or digit, then dots, dashes and underscores — use \`YYYYMMDD-HHMM-<slug>\`, e.g. \`20260917-1430-add-retry\`.`,
    '',
    'Write the file whole — a temp file, then a rename — and set `status: ready` only when everything else in it is final. A `ready` brief is never edited again; if you got it wrong, write a new one.',
    '',
    '```yaml',
    '---',
    `cinna_handover: ${HANDOVER_SCHEMA_VERSION}`,
    'title: Add retry to the uploader',
    'status: ready',
    'execution: ask          # `auto` is honoured only where that project allows it',
    'origin:',
    `  agent: ${agentId}`,
    "  chat: <the chat id from this turn's context>",
    "  task: <the task id from this turn's context, when there is one>",
    "depth: 1                # this turn's handover depth, plus one",
    '---',
    'What you need done, in Markdown.',
    '```',
    '',
    'End the brief with these lines unchanged — the executor may be a terminal session Cinna never talks to, and this is all it gets:',
    '',
    '```markdown',
    HANDOVER_HOW_TO_REPORT,
    '```',
    '',
    "Cinna Desktop notices the file, records it as a task for that folder's agent, asks the person or runs it, and brings the result back to this conversation as a turn. Once the report is final and you have read it you may delete your own handover folder; nothing else cleans it up. Never write in another project's handover folder except to create your own."
  ].join('\n')
}

/**
 * The same protocol, for the task description when **Cinna** runs the executor.
 *
 * It points at the brief and names the three fields the desktop actually reads.
 * The full vocabulary — the `artifacts:` list, the `question:` line, the
 * wording of each status — is in {@link HANDOVER_HOW_TO_REPORT}, and repeating
 * *that* here made the task's Description a 250-word paragraph naming the same
 * absolute path three times (`ux_rules.md` §7).
 *
 * **What it may not do is describe the brief.** It used to say the brief "ends
 * with the exact format", which is true only of a brief written from this
 * app's own template: anything can write a brief, the footer is a
 * recommendation, and an executor sent to look for a format that is not there
 * has been told something false about a file (`ux_rules.md` §9). So the format
 * is named here instead of pointed at.
 */
export function handoverProtocolParagraph(input: { briefPath: string }): string {
  return [
    `This is a file handover. Read the brief at \`${input.briefPath}\` first and do what it asks.`,
    `Write \`${HANDOVER_REPORT_FILE}\` beside it, with frontmatter \`cinna_handover: 1\`,`,
    '`status: in_progress | blocked | done | failed` and a one-line `summary`:',
    '`in_progress` before you start, a final status when you stop.',
    'Do not edit the brief.'
  ].join(' ')
}

// ---------------------------------------------------------------------------
// What the desktop has to say about a handover it did not refuse
// ---------------------------------------------------------------------------

/**
 * Why a brief did not get the treatment it asked for, while still being acted
 * on. Distinct from {@link HandoverState}'s `refused`, which is the desktop
 * declining outright: a warning is attached to a row that carries on.
 *
 * A closed union rather than free text because the task page renders it and the
 * tests pin it. `auto_not_allowed:` and `start_refused:` carry a machine
 * suffix, so the vocabulary is a prefix set and {@link handoverWarningKind}
 * reads it back.
 *
 *  - `brief_edited` — a `ready` brief changed after intake. One brief, one
 *    task, forever (§4.3): the edit is *recorded*, never acted on.
 *  - `auto_not_allowed:<reason>` — the brief asked `execution: auto` and it was
 *    not honoured. The reason is the agent's own setting, or what git said.
 *  - `origin_unresolved` — an `origin:` block naming an agent, chat or task
 *    this profile cannot see. The handover runs; it has nobody to wake (§3.5).
 *  - `origin_parent_nested` — the `origin:` task resolved and is itself a
 *    subtask. Tasks are one level deep and `taskService.create` refuses a
 *    second rather than flattening it, so the handover's task hangs off nothing
 *    and says so: the work runs and only the tree view of it is lost.
 *  - `brief_removed_while_running` — the requester deleted the brief mid-run.
 *    Cancelling would abandon a turn that is writing to the folder right now,
 *    so the run finishes and this is the record that the ask went away.
 *  - `report_unparseable` — a `report.md` exists and is not one.
 *  - `start_refused:<reason>` — the gate was answered Run and the start was
 *    refused. The gate is spent; the reason is what `taskExecutionService` said.
 *  - `wake_refused:<reason>` — the origin chat no longer answers to the origin
 *    agent (deleted, in the trash, re-pointed). The work is finished and
 *    recorded; there is simply nobody left to tell.
 *  - `wake_failed:<message>` / `wake_timed_out` — the return packet could not be
 *    delivered: the turn was refused, or the origin chat stayed busy past
 *    `HANDOVER_WAKE_MAX_WAIT_MS`. The task page is then the only record.
 *  - `report_missing` — Cinna ran the executor and its turn ended without a
 *    terminal `report.md`. The turn's own outcome closed the task instead.
 *  - `run_lost` — the app was closed or crashed while the executor ran, so the
 *    handle that would have reported the outcome is gone.
 *  - `revision_after_terminal` — a `revisions/NNN.md` arrived for a task that
 *    is already over. `completed` reaches only `archived`, so there is no turn
 *    to send it on; the file is on disk and the requester needs a new brief.
 *  - `revision_unparseable` — a file in `revisions/` carries the marker and is
 *    not a revision. Later revisions wait behind it, so this one is loud.
 *  - `revision_send_failed:<message>` / `revision_send_timed_out` — the
 *    follow-up turn was refused, or the executor's chat stayed busy past
 *    `HANDOVER_WAKE_MAX_WAIT_MS`. The revision is on disk either way.
 */
export type HandoverWarning =
  | 'brief_edited'
  | `auto_not_allowed:${HandoverAutoRefusal}`
  | 'origin_unresolved'
  | 'origin_parent_nested'
  | 'brief_removed_while_running'
  | 'report_unparseable'
  | `start_refused:${string}`
  | `wake_refused:${string}`
  | `wake_failed:${string}`
  | 'wake_timed_out'
  | 'report_missing'
  | 'run_lost'
  | 'revision_after_terminal'
  | 'revision_unparseable'
  | `revision_send_failed:${string}`
  | 'revision_send_timed_out'

/**
 * Every kind in {@link HandoverWarning}, without its `:<detail>`.
 *
 * The union is a type and a type cannot be iterated, so the surface that turns
 * a warning into a sentence had no way to prove it covers all of them — and it
 * did not: seven of the sixteen were written, and a task page showed the raw
 * token `report_missing` to the user. This list is what a test walks.
 */
export const HANDOVER_WARNING_KINDS: readonly string[] = [
  'brief_edited',
  'auto_not_allowed',
  'origin_unresolved',
  'origin_parent_nested',
  'brief_removed_while_running',
  'report_unparseable',
  'start_refused',
  'wake_refused',
  'wake_failed',
  'wake_timed_out',
  'report_missing',
  'run_lost',
  'revision_after_terminal',
  'revision_unparseable',
  'revision_send_failed',
  'revision_send_timed_out'
]

/** Why `execution: auto` was not honoured. */
export type HandoverAutoRefusal = 'setting_ask' | 'not_ignored' | 'tracked' | 'unknown'

/** The part of a warning before its `:<detail>`, for a surface that groups them. */
export function handoverWarningKind(warning: string): string {
  const colon = warning.indexOf(':')
  return colon === -1 ? warning : warning.slice(0, colon)
}

/** Why the desktop declined a brief outright — {@link HandoverState} `refused`. */
export type HandoverRefusalReason = 'depth_exceeded'

// ---------------------------------------------------------------------------
// Is `.cinna/handovers` out of git's way?
// ---------------------------------------------------------------------------

/**
 * What git says about `.cinna/handovers` in a folder (§3.4).
 *
 * `auto` execution is arbitrary code execution under the folder's own
 * permission settings, and a tracked handovers directory means a `git pull`
 * can plant a brief. So the answer is recorded with its uncertainty intact:
 * `unknown` is not `ignored`, and only the two answers {@link allowsAuto}
 * names are good enough to stand a standing permission on.
 *
 *  - `ignored` — git is there and ignores the directory. The intended setup.
 *  - `not_ignored` — inside a repository, not ignored, not yet tracked. One
 *    `git add -A` away from travelling.
 *  - `tracked` — already committed. The worst case, and the loudest.
 *  - `not_a_repo` — no repository at all, so nothing can arrive by pull.
 *  - `unknown` — git could not be asked (no binary, a timeout, an error). Not
 *    a permission.
 */
export interface HandoverIgnoreCheck {
  result: 'ignored' | 'not_ignored' | 'tracked' | 'not_a_repo' | 'unknown'
  /** One sentence for a surface, when there is something to say. */
  detail?: string
}

/** May a folder in this state run handovers without asking? */
export function allowsAuto(check: HandoverIgnoreCheck | null | undefined): boolean {
  return check?.result === 'ignored' || check?.result === 'not_a_repo'
}

/** The `auto_not_allowed:` reason a check that forbids `auto` produces. */
export function autoRefusalFor(check: HandoverIgnoreCheck): HandoverAutoRefusal {
  return check.result === 'tracked' ? 'tracked' : check.result === 'not_ignored' ? 'not_ignored' : 'unknown'
}

// ---------------------------------------------------------------------------
// What crosses to the renderer
// ---------------------------------------------------------------------------

/**
 * One `handovers` row, as the task page and the agent card see it.
 *
 * The digests are **not** here: they are a main-process reconciliation detail
 * (has this file changed since the last scan), never a fact about the work, and
 * a renderer that had them would be tempted to compare them itself. Dates are
 * epoch milliseconds, as `LocalAgentDto.scannedAt` is — this DTO travels beside
 * the local-agent ones, not beside the task ones.
 */
export interface HandoverDto {
  id: string
  /** The executor agent's row id. Positional, and it survives re-adoption. */
  agentId: string
  folderPath: string
  /** The requester's chosen id — unique per folder, not globally. */
  handoverId: string
  /** Null once the task has been deleted; such a row is inert. */
  taskId: string | null
  originAgentId: string | null
  originChatId: string | null
  originTaskId: string | null
  depth: number
  groupId: string | null
  execution: HandoverExecution
  state: HandoverState
  refusalReason: string | null
  warning: string | null
  reportStatus: HandoverReportStatus | null
  runId: string | null
  /** When the origin chat was told how this ended. Null for a human origin. */
  wokeAt: number | null
  /**
   * When the brief stopped being on disk, if it has.
   *
   * A surface that prints `.cinna/handovers/<id>` is asserting that directory
   * exists (`ux_rules.md` §9), and the requester deleting the brief is how a
   * handover is withdrawn — so the row that says where the files are has to
   * know they are gone. Cleared the moment a brief with that id is read again.
   */
  briefMissingAt: number | null
  lastScannedAt: number | null
  createdAt: number
  updatedAt: number
}

// ---------------------------------------------------------------------------
// The return packet
// ---------------------------------------------------------------------------

/**
 * How much of a report body travels back to the origin chat.
 *
 * The same number as the catch-up packet's `CATCH_UP_CAP`, and deliberately not
 * imported from it: `threadContextService` is a main-process module and this
 * one is read by the renderer too. Callers in main pass their own `cap` where
 * the two must agree.
 */
export const HANDOVER_PACKET_CAP = 4000

const PACKET_TRUNCATED = '[…report truncated; read report.md]'

/**
 * How the executor's status reads in the first line of the packet.
 *
 * A sentence rather than the raw status because the origin is an *agent reading
 * prose*: `done` and `failed` are both "finished", and the difference is what
 * the sentence says, not a field it has to know the vocabulary of. `blocked` is
 * present tense on purpose — it is a question still waiting, not an outcome.
 */
const PACKET_VERB: Record<HandoverReportStatus, string> = {
  done: 'finished',
  failed: 'failed',
  blocked: 'is blocked',
  in_progress: 'is in progress'
}

export interface HandoverReturnPacketInput {
  handoverId: string
  folderPath: string
  /** The handover task, so the origin can open it. */
  taskId: string | null
  status: HandoverReportStatus
  summary: string
  /** Only meaningful with `blocked`; ignored otherwise. */
  question?: string | null
  artifacts?: string[]
  body?: string
  /** Character ceiling for the body. Defaults to {@link HANDOVER_PACKET_CAP}. */
  cap?: number
}

/**
 * What the origin chat is told when a handover it asked for reaches an end.
 *
 * **The cap drops from the end**, which is the opposite of the catch-up packet
 * and the reason this is not that function. A transcript's newest lines are the
 * ones an agent needs; a report is written top-down — summary, what changed,
 * then detail — so its *beginning* is what carries the answer, and a report cut
 * from the front would arrive as a fragment of its own appendix.
 *
 * Pure: no paths resolved, no files read, nothing thrown. The header lines are
 * short and always present, so a packet is never only a marker; if the cap is
 * smaller than the body's first sentence the body is dropped to the marker
 * alone rather than cut mid-word into nonsense.
 */
export function buildHandoverReturnPacket(input: HandoverReturnPacketInput): string {
  const cap = input.cap ?? HANDOVER_PACKET_CAP
  const summary = input.summary.trim() || 'No summary was given.'
  const lines = [`Handover \`${input.handoverId}\` ${PACKET_VERB[input.status]}: ${summary}`, '']

  lines.push(`Project: ${input.folderPath}`)
  if (input.taskId) lines.push(`Task: ${input.taskId}`)

  if (input.status === 'blocked') {
    const question = input.question?.trim()
    // The question is the *point* of a blocked report, so it is stated even
    // when the report left it empty — an origin told "blocked" with nothing to
    // answer would otherwise have to go and read the file to find that out.
    lines.push('', `Question: ${question || 'The executor did not say what it needs.'}`)
    lines.push('Answer by writing a new brief or a revision in the handover folder.')
  }

  const artifacts = (input.artifacts ?? []).filter((path) => path.trim() !== '')
  if (artifacts.length > 0) {
    lines.push('', 'Artifacts:')
    for (const path of artifacts) lines.push(`- ${path}`)
  }

  const body = (input.body ?? '').trim()
  if (body !== '') {
    lines.push('', body.length <= cap ? body : `${body.slice(0, cap).trimEnd()}\n${PACKET_TRUNCATED}`)
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// The follow-up turn a revision becomes
// ---------------------------------------------------------------------------

export interface HandoverRevisionTurnInput {
  handoverId: string
  /** The digits of the file name, as written: `001`. */
  ordinal: string
  title?: string | null
  body: string
  /** Where the report lives, so the reminder names a real path. */
  reportPath: string
}

/**
 * What the executor's chat is told when the requester adds a revision.
 *
 * It is a **new turn on the handover's own chat**, so the session, the folder
 * and everything the executor already knows are still there; this text only has
 * to say which handover moved and what changed. Three things it always says,
 * in this order, because an agent reads the first line and decides what kind of
 * message this is:
 *
 *  1. that it is revision NNN of a handover it is already working on — not a
 *     new request, and not a person typing into its chat;
 *  2. the revision itself, verbatim;
 *  3. that the report is still the way to answer. A revision arrives *after*
 *     a `done` report as often as before one, and an executor that forgot to
 *     rewrite `report.md` leaves the requester waiting on a file that still
 *     says the old thing.
 *
 * Pure, like every other builder here: the caller resolved the paths.
 */
export function buildHandoverRevisionTurn(input: HandoverRevisionTurnInput): string {
  const title = input.title?.trim()
  const headline = `Revision ${input.ordinal} of handover \`${input.handoverId}\`${title ? `: ${title}` : ''}`
  return [
    `${headline}. The requester added this to the brief you are working on:`,
    '',
    input.body.trim(),
    '',
    `Update \`${input.reportPath}\` when you are done — same file, same statuses.`
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Groups: one packet for a fan-out
// ---------------------------------------------------------------------------

/** One row of a group, as the group packet names it. */
export interface HandoverGroupMember {
  handoverId: string
  /** The desktop's state, which is wider than the report's: `skipped` counts. */
  state: HandoverState
  summary?: string | null
  taskId?: string | null
}

/** How a member's state reads in the list. Prose, for the same reason `PACKET_VERB` is. */
const GROUP_MEMBER_VERB: Partial<Record<HandoverState, string>> = {
  done: 'done',
  failed: 'failed',
  skipped: 'skipped',
  refused: 'refused by the desktop',
  blocked: 'blocked'
}

const GROUP_TRUNCATED = '[…more handovers in this group; open the tasks]'

/**
 * What the origin chat is told when every handover of a `group:` has finished.
 *
 * The fan-in the draft calls "wake once" (§3.7): a requester that handed the
 * same piece of work to five projects hears once, with all five results, rather
 * than five times over an hour. The packet is a **list, not a report** — one
 * line per member, its id, how it ended and its one-line summary — because the
 * detail of each one is on its own task and in its own `report.md`, and a
 * packet carrying five bodies would push the origin's context out for nothing.
 *
 * The cap drops members from the **end**, with a marker, for the same reason
 * the return packet cuts its body from the end: the first lines are the ones
 * that arrived first and the reader can still find the rest.
 */
export function buildHandoverGroupPacket(input: {
  groupId: string
  members: readonly HandoverGroupMember[]
  cap?: number
}): string {
  const cap = input.cap ?? HANDOVER_PACKET_CAP
  const head = `Handover group \`${input.groupId}\` has finished — ${input.members.length} ${
    input.members.length === 1 ? 'handover' : 'handovers'
  }:`
  const lines = [head, '']
  let used = head.length + 1

  let dropped = 0
  for (const member of input.members) {
    const verb = GROUP_MEMBER_VERB[member.state] ?? member.state
    const summary = member.summary?.trim()
    const line = `- \`${member.handoverId}\` — ${verb}${summary ? `: ${summary}` : ''}${
      member.taskId ? ` (task ${member.taskId})` : ''
    }`
    if (used + line.length + 1 > cap && lines.length > 2) {
      dropped += 1
      continue
    }
    lines.push(line)
    used += line.length + 1
  }
  if (dropped > 0) lines.push(GROUP_TRUNCATED)

  return lines.join('\n')
}
