/**
 * A folder agent's `app-data/storage/STATUS.md`, shaped into the
 * {@link AgentStatusSnapshot} the status overlay, the sidebar-footer button and
 * the menu-bar tray already render — plus the one thing Phase 7 is the first
 * consumer of anywhere in `src/`: actually *running* the manifest's
 * `status_refresh_command`.
 *
 * ## What is reused, not rebuilt
 *
 * Reading and parsing STATUS.md is `scannerService.readStatus(agentDir,
 * statusFile)`. It already resolves the path from the contract
 * (`layout.agent.status_file`), already returns `null` for a missing file,
 * already tolerates absent frontmatter, and already accepts the key synonyms a
 * hand-written file uses. There is no second frontmatter reader here.
 * Executing the command is `commandService.run()` — the subprocess, the
 * localisation, the output cap, the ceiling and the turn lock are all 7a's.
 *
 * ## The two rules this module *does* own
 *
 * 1. **A free-form `state` word → an {@link AgentStatusSeverity}.** Nothing in
 *    the tree derived one before: `agentSeverity.ts` consumes a severity, the
 *    scanner carries the raw word, and nobody bridged them. See
 *    {@link severityFromState} for the table and why an unrecognised word maps
 *    to `unknown` rather than to `ok`.
 * 2. **Only the `/run:<name>` form of `status_refresh_command` executes.** See
 *    {@link runStatusRefresh}.
 */

import { statSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentStatusSeverity, AgentStatusSnapshot } from '../agentStatusService'
import type { LocalAgentStatusSummary } from '../../../shared/localAgents'
import { RUN_REFERENCE_PATTERN } from '../../../shared/kit/manifest'
import { getLayoutView } from '../../kit/contractStore'
import { createLogger } from '../../logger/logger'
import { commandService } from './commandService'
import { readStatus } from './scannerService'

const logger = createLogger('local-agent-status')

/**
 * The contract's four words, plus the near-synonyms a hand-written or
 * LLM-written STATUS.md actually uses.
 *
 * `resources/cinna-kit-contract/templates/agent/scripts/update_status.py:40`
 * declares `STATUSES = ("ok", "attention", "error", "unknown")` and normalises
 * anything else to `unknown` before writing the file — so those four are
 * normative, and a compliant agent can only ever write one of them. The rest of
 * this table is a tolerance layer for the files that do not go through that
 * script: `state:` is free-form in the frontmatter, `readStatus` accepts
 * `state`/`status`/`health` interchangeably, and an agent whose own prompt
 * writes `healthy` should not be punished for it with a permanently grey dot.
 *
 * The table is deliberately small and explicit rather than a fuzzy match: every
 * word here has exactly one defensible reading. Anything else is `unknown`.
 */
const SEVERITY_BY_STATE: Record<string, AgentStatusSeverity> = {
  // — the contract's own vocabulary —
  ok: 'ok',
  attention: 'warning',
  error: 'error',
  unknown: 'unknown',
  // — unambiguous synonyms —
  healthy: 'ok',
  green: 'ok',
  pass: 'ok',
  passing: 'ok',
  success: 'ok',
  warning: 'warning',
  warn: 'warning',
  degraded: 'warning',
  blocked: 'warning',
  failed: 'error',
  failure: 'error',
  fail: 'error',
  critical: 'error',
  info: 'info'
}

/**
 * The free-form `state` word from STATUS.md's frontmatter, as a severity.
 *
 * Three outcomes, and the distinction between the last two is the point:
 *
 * * a recognised word → its severity;
 * * **no word at all** (`null`, or an empty/whitespace `state:`) → `null`, i.e.
 *   *the agent claimed nothing*. `worstSeverity` skips a `null` and
 *   `sortByUrgency` ranks it below `unknown`, so an agent that reported a
 *   summary without a state does not colour the tray icon;
 * * **a word nobody recognises** → `'unknown'`, i.e. *the agent claimed
 *   something and we could not read it*. That is a real signal — it sorts above
 *   "claimed nothing" and shows an Unknown pill the user can act on.
 *
 * **An unrecognised word must never map to `ok`.** The whole surface this feeds
 * is a menu-bar dot a user glances at instead of opening the app: mapping a word
 * we did not understand to green paints "everything is fine" over a state
 * nobody read, which is silent false reassurance — strictly worse than grey,
 * because grey is a question and green is an answer.
 */
export function severityFromState(state: string | null | undefined): AgentStatusSeverity | null {
  if (typeof state !== 'string') return null
  const word = state.trim().toLowerCase()
  if (word === '') return null
  return SEVERITY_BY_STATE[word] ?? 'unknown'
}

/**
 * `LocalAgentStatusSummary` → `AgentStatusSnapshot`, for one folder agent.
 *
 * Three fields of the remote shape have no local counterpart and are set
 * deliberately rather than left to default:
 *
 * * **`environmentId`** is `'local'`, not `null`. The renderer reads `null` as
 *   *the remote environment is not running* and prints "· env not running" /
 *   "Environment is not running — showing last cached status"
 *   (`statusViews.tsx:127,266`). A folder agent has no environment and its
 *   status was just read from this machine's disk, so `null` there would be a
 *   confident, visible falsehood. The non-null sentinel is how "not applicable"
 *   is said without adding a field to a type declared in two places
 *   (`agentStatusService.ts` and `preload/index.ts`). Nothing renders the value
 *   itself today.
 * * **`raw`** is `null`. `readStatus` returns the parsed body rather than the
 *   file text, and nothing in the renderer reads `raw`; `body` carries the
 *   markdown. Re-reading the file only to fill a field no one reads is not
 *   worth a second syscall on a 45-second poll.
 * * **`prevSeverity` / `severityChangedAt`** are `null`. Severity history is
 *   the remote platform's, kept server-side across polls; the desktop keeps no
 *   such history for a folder agent, and inventing one from a single read would
 *   claim a transition that was never observed.
 */
export function toStatusSnapshot(
  agentId: string,
  name: string,
  status: LocalAgentStatusSummary,
  statusPath: string,
  fetchedAt: Date = new Date()
): AgentStatusSnapshot {
  let reportedAt = status.updatedAt
  let reportedAtSource: AgentStatusSnapshot['reportedAtSource'] = reportedAt ? 'frontmatter' : null
  if (!reportedAt) {
    // Same fallback the remote side reports as `file_mtime`, and the renderer
    // already labels it as inferred ("· from file mtime"). A STATUS.md with no
    // timestamp still tells the user *when* it was written.
    try {
      reportedAt = statSync(statusPath).mtime.toISOString()
      reportedAtSource = 'file_mtime'
    } catch {
      reportedAt = null
      reportedAtSource = null
    }
  }

  return {
    agentId,
    // No remote id exists; the local id is the only identifier this snapshot
    // has, and nothing renders this field.
    remoteAgentId: agentId,
    name,
    environmentId: 'local',
    severity: severityFromState(status.state),
    summary: status.summary,
    reportedAt,
    reportedAtSource,
    fetchedAt: fetchedAt.toISOString(),
    raw: null,
    body: status.body,
    // "Is there metadata we could use" — not "did a `---` block parse". A
    // frontmatter block carrying only keys this app does not know is, for every
    // consumer of this flag, the same as no frontmatter at all.
    hasStructuredMetadata:
      status.summary !== null || status.state !== null || status.updatedAt !== null,
    prevSeverity: null,
    severityChangedAt: null
  }
}

/**
 * Read one folder agent's STATUS.md and shape it, or `null` when there is no
 * status to report.
 *
 * `null` covers both "no STATUS.md on disk" and "the kit contract could not be
 * loaded, so we do not know where STATUS.md would be". Omitting the agent
 * mirrors what the remote `list` already does with a sentinel snapshot
 * (`severity == null && raw == null` is skipped): a surface titled "agents that
 * have reported status" should not list one that has not.
 *
 * Never throws — it is called in a loop from a 45-second poll, and one
 * unreadable folder must not take the other agents' rows down with it.
 */
export function readFolderAgentSnapshot(
  agentId: string,
  name: string,
  rootPath: string,
  agentDir: string,
  fetchedAt: Date = new Date()
): AgentStatusSnapshot | null {
  let statusFile: string
  try {
    statusFile = getLayoutView(rootPath).layout.agent.status_file
  } catch (err) {
    // `getLayoutView` throws `KitError` for a contract it cannot load.
    logger.warn('folder agent status: contract unreadable', { agentId, error: String(err) })
    return null
  }
  const status = readStatus(agentDir, statusFile)
  if (!status) return null
  return toStatusSnapshot(agentId, name, status, join(agentDir, statusFile), fetchedAt)
}

/** What {@link runStatusRefresh} did, for a caller that has to decide what to show. */
export interface StatusRefreshOutcome {
  /** The command ran to a clean exit and STATUS.md may have changed. */
  ran: boolean
  /**
   * Nothing ran, and that is not a fault: no `status_refresh_command` is
   * configured, the agent was busy, or the caller cancelled. The caller shows
   * whatever is on disk and reports no error.
   */
  skipped: boolean
  /**
   * The refresh genuinely failed — the script exited non-zero, the name is not
   * in the catalog, the folder is gone, the binary is not on `PATH`, the
   * ceiling fired, or the manifest asked for something this app will not run.
   * Carries a user-facing reason; the caller is expected to surface it rather
   * than log it and move on.
   */
  error: string | null
}

const RAN: StatusRefreshOutcome = { ran: true, skipped: false, error: null }
const SKIPPED: StatusRefreshOutcome = { ran: false, skipped: true, error: null }
const failed = (error: string): StatusRefreshOutcome => ({ ran: false, skipped: false, error })

/**
 * Run the manifest's `status_refresh_command` before STATUS.md is read.
 *
 * ## Only the `/run:<name>` form executes
 *
 * The schema calls the field "Shell command, or a /run:<name> reference"
 * (`resources/cinna-kit-contract/schema/cinna-agent.schema.json:160`) and
 * `validator.ts:975` only ever checks the `/run:` form. This app runs **only**
 * that form; a raw string comes back as an error naming the supported syntax.
 *
 * The reason is not "shell is dangerous" — 7a already spawns agent-supplied
 * shell out of `docs/CLI_COMMANDS.yaml`, out of the same folder, so that
 * argument would prove too much. The difference is *visibility and validation*.
 * A catalog command is listed on the agent page with its name, description and
 * command text; the validator checks it; and the user runs it by pressing Run
 * or typing `/run:`. A `status_refresh_command` is run **by the app, on the
 * user's behalf, without ever being displayed** — so the one thing it can be is
 * a reference to a command the user can already see and the validator has
 * already resolved. Widening this later, if the contract asks, is one branch;
 * narrowing it after arbitrary strings have started executing is not.
 *
 * ## Busy and cancelled are not failures
 *
 * `commandService.run()` takes the per-agent turn lock as owner `'command'`, so
 * a refresh fired while a model turn streams is refused. That refusal comes
 * back as `busy` and is treated exactly the way the remote `get` treats a 429:
 * a soft no-op, the on-disk snapshot is returned, nothing is shown. A cancel
 * (`aborted`) is likewise never a failure — this module calls `run()` directly
 * rather than through `streamToAgent`, which is what suppresses the error
 * surface on abort for the chat path, so the suppression has to happen here.
 */
export async function runStatusRefresh(
  userId: string,
  agentId: string,
  statusRefreshCommand: unknown,
  signal?: AbortSignal
): Promise<StatusRefreshOutcome> {
  if (typeof statusRefreshCommand !== 'string' || statusRefreshCommand.trim() === '') {
    return SKIPPED
  }
  const trimmed = statusRefreshCommand.trim()
  const reference = RUN_REFERENCE_PATTERN.exec(trimmed)
  if (!reference) {
    logger.warn('status refresh: unsupported command form', { agentId, command: trimmed })
    return failed(
      `This agent's status_refresh_command is not a /run:<name> reference, so it was not run. Cinna Desktop only runs commands listed in the agent's command catalog.`
    )
  }

  const outcome = await commandService.run(userId, agentId, reference[1], signal)
  if (outcome.ok) return RAN
  if (outcome.busy) {
    logger.debug('status refresh deferred: agent busy', { agentId })
    return SKIPPED
  }
  if (outcome.aborted) return SKIPPED
  logger.warn('status refresh failed', { agentId, name: reference[1], error: outcome.error })
  return failed(outcome.error ?? `/run:${reference[1]} failed.`)
}
