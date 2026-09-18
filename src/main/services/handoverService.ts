/**
 * `.cinna/handovers/` — the desktop side of a folder's task inbox.
 *
 * Any bare agent's folder may hold `.cinna/handovers/<id>/brief.md`. Anything
 * can write one: a Cinna agent on its own turn, a `claude` in a terminal, a
 * shell script, a person. This service is what notices — on a watch event or on
 * the minute scan — records the brief as a **task assigned to that folder's
 * agent**, and then either asks in the Inbox or, where the user has opted in,
 * starts the executor. It also reads `report.md` back and moves the task with
 * it. `drafts/file_handovers/README.md` §3.2–§3.9 is the contract; the parsing
 * is `src/shared/handovers.ts` and lives there because the renderer reads it too.
 *
 * **Three rules run through everything below.**
 *
 * 1. *Cinna writes nothing under `.cinna/`, and deletes nothing there either.*
 *    Every desktop-side fact — the task id, the run, the refusal, what the gate
 *    said — is a `handovers` row. There is no mirror file and no cleanup;
 *    retention is the requester's (§3.2).
 * 2. *One brief, one task, forever.* `UNIQUE(agent_id, handover_id)` is what
 *    enforces it, not a read; an edited `ready` brief is recorded with a warning
 *    and otherwise ignored, because edit-after-ready is the mistake that would
 *    otherwise silently change what an agent is already working on.
 * 3. *`auto` is the receiving agent's setting, never the brief's.* A brief
 *    asking for `execution: auto` is a request. It is honoured only when the
 *    agent's own `handovers` setting says `auto` **and** git says the handovers
 *    directory cannot arrive by `git pull` — a folder is writable by anything
 *    that can write to the folder (`probe_results.md` "Surprises" 2 and 3 are
 *    that risk, observed).
 *
 * Built as `createHandoverService(deps)` over injected collaborators so intake
 * can be tested against real folders and fake repositories, with the production
 * singleton at the bottom.
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, type Dirent } from 'node:fs'
import { basename, join } from 'node:path'
import {
  HANDOVERS_DIR,
  HANDOVER_BRIEF_FILE,
  HANDOVER_GATE_OPTIONS,
  HANDOVER_REPORT_FILE,
  HANDOVER_REVISIONS_DIR,
  allowsAuto,
  autoRefusalFor,
  buildHandoverRevisionTurn,
  handoverGateQuestion,
  handoverGateRequestId,
  handoverProtocolParagraph,
  isDepthAllowed,
  isHandoverId,
  isRevisionFileName,
  parseHandoverBrief,
  parseHandoverGateRequestId,
  parseHandoverReport,
  parseHandoverRevision,
  revisionOrdinal,
  type HandoverBrief,
  type HandoverDto,
  type HandoverIgnoreCheck,
  type HandoverReport,
  type HandoverState,
  type HandoverWarning
} from '../../shared/handovers'
import { canTransition, type TaskStatus } from '../../shared/taskStatus'
import type { InboxAnswerResult } from '../../shared/inbox'
import type { RequestResolution } from '../../shared/localAgentRequests'
import type { TaskArtifact, TaskDto } from '../../shared/tasks'
import { handoverRepo, type HandoverInsert, type HandoverPatch, type HandoverRow } from '../db/handovers'
import type { TaskCreateInput } from '../db/tasks'
import { agentRepo } from '../db/agents'
import { chatRepo } from '../db/chats'
import { messageRepo } from '../db/messages'
import { getDb } from '../db/client'
import { taskInputRequestRepo } from '../db/taskInputRequests'
import { getAgentLookupScope, getProfileScopeUserId, getSettingsScopeUserId } from '../auth/scope'
import { userActivation } from '../auth/activation'
import { createLogger } from '../logger/logger'
import { chatAnswersToAgent } from './chatRouting'
import { handoverGit } from './handoverGit'
import { localAgentService } from './localAgents/localAgentService'
import { installTaskRunnerHooks } from './taskRunnerBridge'
import { taskExecutionService } from './taskExecutionService'
import { taskService } from './taskService'
import { runExecutionService } from './runExecutionService'
import { handoverWake, type HandoverGroupWakeInput, type HandoverWakeInput } from './handoverWake'
import { handoverRevisions, type HandoverRevisionSendInput } from './handoverRevisions'
import type { RunScope } from './runExecutionService'

/**
 * The part of a `RunOutcome` a handover reads. Narrow on purpose: everything
 * else on that object belongs to the turn, and a handover's question is only
 * "how did it end, and did it say anything".
 */
export interface HandoverTurnOutcome {
  state: 'completed' | 'needs_input' | 'failed' | 'canceled' | 'budget'
  text: string
}

/**
 * How long a `running` row is given before a scan calls its run lost.
 *
 * The app may have been closed mid-turn, in which case the handle that would
 * have reported the outcome died with it and nothing will ever close the task.
 * Two minutes is comfortably longer than the gap between a start and the first
 * scan that could see it, and short enough that a user reopening the app is
 * told before they wonder.
 */
export const HANDOVER_RUN_LOST_AFTER_MS = 2 * 60_000

/** Only what this service reads off an agent. Narrow, so a test can fake it. */
export interface HandoverAgent {
  id: string
  /** Absolute path of the agent folder. */
  path: string
  name: string
  /** The per-agent setting, `null` when the user has not chosen. */
  handovers: 'ask' | 'auto' | null
}

export interface HandoverDeps {
  repo: {
    insert(input: HandoverInsert): HandoverRow
    byAgentAndHandoverId(agentId: string, handoverId: string): HandoverRow | undefined
    getById(userId: string, id: string): HandoverRow | undefined
    byTaskId(userId: string, taskId: string): HandoverRow | undefined
    listForAgent(userId: string, agentId: string): HandoverRow[]
    /** Every row of one fan-out group under one origin chat (§3.7). */
    listForGroup(userId: string, originChatId: string, groupId: string): HandoverRow[]
    update(userId: string, id: string, patch: HandoverPatch): HandoverRow | undefined
    toDto(row: HandoverRow): HandoverDto
  }
  tasks: {
    create(userId: string, input: TaskCreateInput): TaskDto
    getById(userId: string, taskId: string): TaskDto
    setStatus(userId: string, taskId: string, status: TaskStatus, opts?: { errorMessage?: string | null }): TaskDto
    setHandoffNote(userId: string, taskId: string, note: string | null): TaskDto
    setArtifacts(userId: string, taskId: string, artifacts: TaskArtifact[]): TaskDto
    applyRunState(userId: string, taskId: string, state: 'needs_input'): TaskDto
  }
  execution: {
    start(
      scope: RunScope,
      taskId: string,
      target: { kind: 'agent'; agentId: string },
      options?: { reuseChatId?: string }
    ): Promise<{ chatId: string; runId: string; completed: Promise<HandoverTurnOutcome> }>
  }
  inputRequests: {
    open(input: {
      requestId: string
      taskId: string
      chatId: string
      agentId: string | null
      deliveryOwner: 'handover'
      request: { kind: 'question'; questions: ReturnType<typeof handoverGateQuestion>[] }
      resume: 'reply'
    }): unknown
    getById(requestId: string): { status: string } | undefined
    /**
     * Is anything on the Inbox still waiting for an answer about this task?
     *
     * Only the lost-run sweep asks: an executor parked on its own question has
     * ended its turn, so nothing will report an outcome and `updated_at` goes
     * stale while the user reads the card.
     */
    hasOpenForTask(taskId: string): boolean
    settle(requestId: string, status: 'answered' | 'expired' | 'rejected', resolution?: RequestResolution | null): unknown
  }
  chats: {
    create(userId: string, init: { title: string; router: 'direct'; agentId: string; hiddenFromList: boolean }): { id: string }
    /** Promote the gate's chat into the sidebar once a turn actually starts. */
    showInList(userId: string, chatId: string): boolean
    permanentDelete(userId: string, chatId: string): boolean
    /** Has anybody said anything in here? A chat with a word in it is not litter. */
    isEmpty(chatId: string): boolean
  }
  /** Every bare agent this profile may hand work to, already filtered. */
  agents(settingsUserId: string): HandoverAgent[]
  /** Is this agent id one the profile can see at all? Origin validation (§3.5). */
  agentExists(agentId: string): boolean
  /** Why this chat may not be woken by this agent, or null. `chatRouting`. */
  chatAnswersToAgent(profileUserId: string, chatId: string, agentId: string): string | null
  git: { check(agentDir: string): Promise<HandoverIgnoreCheck> }
  /** Flip the agent's own setting — the Run-and-auto option. Rejects on refusal. */
  setHandovers(settingsUserId: string, agentId: string, setting: 'auto'): Promise<unknown>
  /** Tell the origin chat how a handover ended. Fire-and-forget; never throws. */
  wake(input: HandoverWakeInput): void
  /** Tell the origin chat how a whole group ended, once (§3.7). Fire-and-forget. */
  wakeGroup(input: HandoverGroupWakeInput): void
  /** Put a revision in front of the executor as a new turn. Fire-and-forget. */
  sendRevision(input: HandoverRevisionSendInput): void
  /** Is a turn live in this chat right now? Reads `runExecutionService`. */
  isRunning(chatId: string): boolean
  transaction<T>(fn: () => T): T
  /** The active scope, or null when no profile is activated. */
  currentScope(): RunScope | null
  logger: { debug(msg: string, meta?: unknown): void; info(msg: string, meta?: unknown): void; warn(msg: string, meta?: unknown): void; error(msg: string, meta?: unknown): void }
  now(): Date
}

/** A brief on disk, already parsed — or, for a known row, taken as read. */
interface FoundHandover {
  handoverId: string
  dir: string
  /**
   * `null` when the file was **not read this pass**: the row already knows this
   * brief and {@link FoundHandover.briefStat} says the bytes have not moved
   * since. Only intake needs the parsed brief, and intake only ever runs for a
   * brief no row has seen — which is exactly the case that is always read.
   */
  brief: HandoverBrief | null
  briefDigest: string
  /**
   * `mtime:size` of `brief.md` when it was looked at, or `null` when it could
   * not be stat'ed. The cheap half of the digest: a scan runs every minute over
   * every folder of every project, and hashing a brief that has not been
   * touched since yesterday is work nobody asked for.
   */
  briefStat: string | null
  /**
   * The names of the `revisions/NNN.md` files beside it, in order — names only.
   * A scan runs every minute over every folder, and reading a revision that was
   * delivered weeks ago to find out that it was delivered weeks ago is work
   * nobody asked for; the bytes are read when one turns out to be new.
   */
  revisionFiles: string[]
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

/** A file that is not there is not an error here — it is a state. */
function readBytes(path: string): Buffer | null {
  try {
    return readFileSync(path)
  } catch {
    return null
  }
}

/**
 * "Has this file moved since I last looked?", in one `stat`.
 *
 * Nanoseconds rather than milliseconds because two writes inside the same
 * millisecond are ordinary — a script that writes `report.md` twice, a test
 * that does — and `size` alone would miss a rewrite of the same length.
 * `null` for a file that is not there or cannot be stat'ed, which never
 * matches a stored stamp and therefore always falls through to the read: the
 * stamp may only ever *skip* work, never decide anything on its own.
 */
function fileStamp(path: string): string | null {
  try {
    const stat = statSync(path, { bigint: true })
    return `${stat.mtimeNs}:${stat.size}`
  } catch {
    return null
  }
}

/** The statuses that mean the task is over and the row should be left alone. */
const TERMINAL_TASK_STATUSES = ['completed', 'error', 'cancelled', 'archived']

export function createHandoverService(deps: HandoverDeps) {
  /**
   * Move a task to a status, through `in_progress` when the table demands it.
   *
   * A handover task is created `new`, and `new` cannot reach a terminal status
   * directly (`VALID_TRANSITIONS`) — a brief that arrives already `done` would
   * otherwise be stuck. Never throws: a status change refused by the table is a
   * fact about the task (somebody archived it, the user cancelled it), not a
   * failure of the scan, and a scan that threw would abandon every folder after
   * this one.
   */
  function advance(userId: string, taskId: string, to: TaskStatus, opts?: { errorMessage?: string | null }): void {
    try {
      const task = deps.tasks.getById(userId, taskId)
      if (task.status === to) return
      if (!canTransition(task.status, to)) {
        if (!canTransition(task.status, 'in_progress') || !canTransition('in_progress', to)) {
          deps.logger.debug('a handover could not move its task', { taskId, from: task.status, to })
          return
        }
        deps.tasks.setStatus(userId, taskId, 'in_progress')
      }
      deps.tasks.setStatus(userId, taskId, to, opts)
    } catch (error) {
      deps.logger.warn('a handover task status write failed', { taskId, to, error: String(error) })
    }
  }

  function isTaskTerminal(userId: string, taskId: string | null): boolean {
    if (!taskId) return true
    try {
      return TERMINAL_TASK_STATUSES.includes(deps.tasks.getById(userId, taskId).status)
    } catch {
      // The task is gone — `task_id` is `SET NULL`, so this is a row whose work
      // the user threw away. Nothing left to move.
      return true
    }
  }

  /**
   * Withdraw an open gate and take back the chat it was holding.
   *
   * Both halves matter. The Inbox row is a question about work that is no
   * longer waiting to be decided — leaving it would offer Run for a brief that
   * has gone or is already being worked on outside the app (§3.9). And the chat
   * was created for the gate alone (`task_input_requests.chat_id` is NOT NULL),
   * never attached to the task, so if nothing runs in it, it is litter.
   */
  function withdrawGate(row: HandoverRow): HandoverPatch {
    if (row.gateRequestId) {
      try {
        deps.inputRequests.settle(row.gateRequestId, 'expired')
      } catch (error) {
        deps.logger.warn('a handover gate could not be withdrawn', { id: row.id, error: String(error) })
      }
    }
    releaseGateChat(row)
    return { gateRequestId: null, gateChatId: null }
  }

  /**
   * Give up the chat the gate was holding — **unless somebody has used it.**
   *
   * The chat is created hidden and exists only so the Inbox row can have a
   * `chat_id`; if no turn ever starts in it, it is litter and goes. But a
   * hidden chat is still reachable (a direct link, a search), and a user who
   * opened it and talked to the agent has a conversation. Deleting that because
   * a brief was withdrawn would destroy work the user did by hand, and there is
   * no undo — `permanentDelete` is permanent. So an empty chat is removed and a
   * used one is simply let go of: the row stops pointing at it, and it stays.
   */
  function releaseGateChat(row: HandoverRow): void {
    if (!row.gateChatId) return
    try {
      if (!deps.chats.isEmpty(row.gateChatId)) {
        deps.logger.info('a handover’s gate chat was kept: somebody had used it', {
          id: row.id,
          chatId: row.gateChatId
        })
        deps.chats.showInList(row.userId, row.gateChatId)
        return
      }
      deps.chats.permanentDelete(row.userId, row.gateChatId)
    } catch (error) {
      deps.logger.warn('an unused handover chat could not be removed', { id: row.id, error: String(error) })
    }
  }

  /**
   * Read `.cinna/handovers/*` and keep the briefs that are ready.
   *
   * A directory whose name is not a {@link isHandoverId} is somebody else's —
   * the id becomes a directory name on three platforms and part of an Inbox
   * request id, so the rule is checked before the folder is opened, not after.
   * `draft`, a missing marker and an unparseable file are all "nothing here",
   * with no row: a half-written brief simply parses on the next event.
   */
  function readFolder(agentDir: string, known: Map<string, HandoverRow>): FoundHandover[] {
    let entries: Dirent[]
    try {
      entries = readdirSync(join(agentDir, HANDOVERS_DIR), { withFileTypes: true })
    } catch {
      return []
    }
    const found: FoundHandover[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !isHandoverId(entry.name)) continue
      const dir = join(agentDir, HANDOVERS_DIR, entry.name)
      const briefPath = join(dir, HANDOVER_BRIEF_FILE)
      // Taken **before** the read, so a brief rewritten between the two is
      // stamped as the older bytes and read again next minute. The other order
      // would store a stamp for bytes nobody has parsed.
      const briefStat = fileStamp(briefPath)
      const row = known.get(entry.name)
      if (row && briefStat && row.briefStat === briefStat) {
        // Known, and not touched since the last look: the row's own digest is
        // the answer, and `brief.md` is not opened at all. It parsed as `ready`
        // once — the row exists — and unchanged bytes still do.
        found.push({
          handoverId: entry.name,
          dir,
          brief: null,
          briefDigest: row.briefDigest,
          briefStat,
          revisionFiles: readRevisionFiles(dir)
        })
        continue
      }
      const bytes = readBytes(briefPath)
      if (!bytes) continue
      const parsed = parseHandoverBrief(bytes.toString('utf8'))
      if (!parsed.ok || parsed.brief.status !== 'ready') continue
      found.push({
        handoverId: entry.name,
        dir,
        brief: parsed.brief,
        briefDigest: sha256(bytes),
        briefStat,
        revisionFiles: readRevisionFiles(dir)
      })
    }
    // Directory order is the filesystem's, and differs between APFS, ext4 and
    // NTFS. A scan that intakes and reports in a different order on every
    // machine is a scan whose logs cannot be compared with anybody else's —
    // and, where one brief's intake waits on `git` while the next is
    // reconciled, an ordering the tests cannot pin.
    found.sort((left, right) => (left.handoverId < right.handoverId ? -1 : left.handoverId > right.handoverId ? 1 : 0))
    return found
  }

  /**
   * The revisions beside a brief, in the order they are to be delivered.
   *
   * Name order, which is numeric order while the digits line up — `001`, `002`,
   * `010` — and that is the whole of the rule (§3.2). Anything else in the
   * directory belongs to somebody else: a `notes.md` a person left there is not
   * a revision and is not read.
   */
  function readRevisionFiles(dir: string): string[] {
    let entries: Dirent[]
    try {
      entries = readdirSync(join(dir, HANDOVER_REVISIONS_DIR), { withFileTypes: true })
    } catch {
      return []
    }
    return entries
      .filter((entry) => entry.isFile() && isRevisionFileName(entry.name))
      .map((entry) => entry.name)
      .sort()
  }

  /** Which revisions this row has already sent. A column that will not parse is "none". */
  function deliveredRevisions(row: HandoverRow): string[] {
    if (!row.revisionsDelivered) return []
    try {
      const parsed: unknown = JSON.parse(row.revisionsDelivered)
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
    } catch {
      return []
    }
  }

  /** The report beside a brief, its digest and its stamp — or null when there is none. */
  function readReport(
    dir: string
  ): { digest: string; stat: string | null; parsed: ReturnType<typeof parseHandoverReport> } | null {
    const path = join(dir, HANDOVER_REPORT_FILE)
    const stat = fileStamp(path)
    const bytes = readBytes(path)
    if (!bytes) return null
    return { digest: sha256(bytes), stat, parsed: parseHandoverReport(bytes.toString('utf8')) }
  }

  /**
   * Turn a brief's `origin:` block into ids this profile can actually reach.
   *
   * **Nothing is inferred and nothing is trusted** (§3.5): the block is text in
   * a file any process could have written. An agent it names must exist for this
   * profile; a chat must be owned by the profile *and* still answer to that
   * agent (the same rule `followUpTurnService` applies, which is why it lives in
   * `chatRouting`); a task must be one the profile owns. Anything that does not
   * resolve is dropped and the row is warned — a handover with no origin is a
   * **human-origin** handover, which runs exactly the same way and simply has
   * nobody to wake.
   */
  function resolveOrigin(
    profileUserId: string,
    brief: HandoverBrief
  ): { agentId: string | null; chatId: string | null; taskId: string | null; parentTaskId: string | null; warning: HandoverWarning | null } {
    const empty = { agentId: null, chatId: null, taskId: null, parentTaskId: null, warning: null as HandoverWarning | null }
    if (!brief.origin) return empty
    let unresolved = false

    let agentId: string | null = null
    if (brief.origin.agentId) {
      if (deps.agentExists(brief.origin.agentId)) agentId = brief.origin.agentId
      else unresolved = true
    }

    let chatId: string | null = null
    if (brief.origin.chatId) {
      // A chat is only meaningful together with the agent that answers in it:
      // waking "a chat" means starting a turn *for somebody*, and a chat whose
      // named agent did not resolve names nobody.
      const refusal = agentId ? deps.chatAnswersToAgent(profileUserId, brief.origin.chatId, agentId) : 'no origin agent'
      if (refusal === null) chatId = brief.origin.chatId
      else unresolved = true
    }

    let taskId: string | null = null
    let parentTaskId: string | null = null
    let warning: HandoverWarning | null = null
    if (brief.origin.taskId) {
      try {
        const task = deps.tasks.getById(profileUserId, brief.origin.taskId)
        taskId = task.id
        // Tasks are one level deep and `taskService.create` throws
        // `nested_too_deep` rather than flattening, so a handover from a subtask
        // hangs off nothing and says so. The work still runs; only the tree
        // view of it is lost.
        if (task.parentTaskId) warning = 'origin_parent_nested'
        else parentTaskId = task.id
      } catch {
        unresolved = true
      }
    }

    return { agentId, chatId, taskId, parentTaskId, warning: unresolved ? 'origin_unresolved' : warning }
  }

  /**
   * Open the Inbox gate for a brief that may not run unasked (§3.4).
   *
   * The chat is created **here**, before the row, for a structural reason:
   * `task_input_requests.chat_id` is NOT NULL and a task that has not started
   * has no chat. So the gate brings one, holds it in `gate_chat_id`, and hands
   * it to `taskExecutionService.start` as `reuseChatId` if the answer is Run —
   * `tasks.chat_id` stays null the whole time, which is what keeps the start's
   * own "this task already has a conversation" guard meaningful.
   *
   * `applyRunState(…, 'needs_input')` maps to the task status `blocked`, which
   * `new` cannot reach; the call is a **documented no-op** here and the task
   * stays `new`. That is deliberate rather than an oversight: the row still
   * reaches the Inbox through `inboxService.list`'s first branch (`resume:
   * 'reply'` and a `deliveryOwner` on that branch's allowlist) — pinned by
   * "shows a handover gate whose task has not started" in
   * `inboxService.test.ts`. Marking a task `blocked` before anybody has decided
   * to run it would claim work is under way.
   */
  function openGate(scope: RunScope, row: HandoverRow, title: string, offerAuto: boolean): HandoverRow | undefined {
    if (!row.taskId) return row
    // **Hidden**, because the user has not decided anything yet. An empty
    // conversation appearing in the sidebar the moment a file lands in a project
    // folder is the app moving under the user's hands (`ux_rules` §1); it is
    // promoted the moment a turn actually starts in it.
    const chat = deps.chats.create(scope.profileUserId, {
      title,
      router: 'direct',
      agentId: row.agentId,
      hiddenFromList: true
    })
    const requestId = handoverGateRequestId(row.id)
    try {
      return deps.transaction(() => {
        deps.inputRequests.open({
          requestId,
          taskId: row.taskId as string,
          chatId: chat.id,
          agentId: null,
          deliveryOwner: 'handover',
          request: {
            kind: 'question',
            questions: [
              handoverGateQuestion({ title, folderName: basename(row.folderPath), offerAuto })
            ]
          },
          resume: 'reply'
        })
        try {
          deps.tasks.applyRunState(scope.profileUserId, row.taskId as string, 'needs_input')
        } catch (error) {
          deps.logger.debug('a gated handover task kept its status', { id: row.id, error: String(error) })
        }
        return deps.repo.update(scope.profileUserId, row.id, {
          state: 'gated',
          gateRequestId: requestId,
          gateChatId: chat.id
        })
      })
    } catch (error) {
      // The row stays `seen` and the next scan tries again; the chat would
      // otherwise be an empty conversation nobody ever opens.
      deps.chats.permanentDelete(scope.profileUserId, chat.id)
      deps.logger.error('a handover gate could not be opened', { id: row.id, error: String(error) })
      return deps.repo.getById(scope.profileUserId, row.id)
    }
  }

  /**
   * Follow a turn we started, so a report that never arrives is not the end of
   * the story (§3.6).
   *
   * **Not awaited by anybody.** The caller is a scan or an Inbox answer, and
   * both have to return the moment the turn is accepted; a turn runs for
   * minutes. The continuation is attached and forgotten, and everything it does
   * afterwards is idempotent against whatever the scans did in the meantime.
   */
  function watchTurn(scope: RunScope, rowId: string, completed: Promise<HandoverTurnOutcome>): void {
    void completed
      .then((outcome) => applyOutcome(scope, rowId, outcome))
      .catch((error) => {
        deps.logger.warn('a handover turn ended in a way it could not report', {
          id: rowId,
          error: error instanceof Error ? error.message : String(error)
        })
      })
  }

  /** Start the executor and record the run, or fall back to the gate. */
  async function startExecutor(
    scope: RunScope,
    row: HandoverRow,
    title: string,
    offerAuto: boolean
  ): Promise<void> {
    if (!row.taskId) return
    try {
      const result = await deps.execution.start(scope, row.taskId, { kind: 'agent', agentId: row.agentId })
      deps.repo.update(scope.profileUserId, row.id, { state: 'running', runId: result.runId })
      watchTurn(scope, row.id, result.completed)
    } catch (error) {
      // A refusal here is not the user's answer to anything — it is the desktop
      // finding the agent unavailable, the profile changed, the task not
      // startable. Asking is the honest fallback: the work is still wanted.
      const reason = error instanceof Error ? error.message : String(error)
      deps.logger.warn('an auto handover could not start; asking instead', { id: row.id, reason })
      const gated = openGate(scope, row, title, offerAuto)
      if (gated) deps.repo.update(scope.profileUserId, gated.id, { warning: `start_refused:${reason}` })
    }
  }

  /**
   * Record a brief nobody has seen before: one row, one task, and then the
   * decision about running it.
   *
   * The row and the task are inserted in **one transaction** so a crash between
   * them cannot leave a task with no handover or a handover pointing at nothing.
   * A unique-index violation means a concurrent scan won the race — the pair is
   * then simply "known", and the loser does nothing rather than creating a
   * second task for the same brief.
   *
   * **The row goes in first, the task second, and the order is the fix for a
   * file the rollback cannot take back.** `taskService.create` exports the
   * task's handoff file to `<userData>/tasks/<id>.md`, and a filesystem write
   * inside a transaction survives the rollback the unique index causes: the
   * loser of a race left a task file for a task that never existed. Inserting
   * the row first makes the index fire before anything is written to disk.
   */
  async function intake(scope: RunScope, agent: HandoverAgent, found: FoundHandover, check: HandoverIgnoreCheck): Promise<void> {
    const brief = found.brief
    if (!brief) return
    const briefPath = join(found.dir, HANDOVER_BRIEF_FILE)
    const origin = resolveOrigin(scope.profileUserId, brief)
    const report = readReport(found.dir)
    const claimed = report?.parsed.ok === true

    let row: HandoverRow
    try {
      row = deps.transaction(() => {
        const inserted = deps.repo.insert({
          userId: scope.profileUserId,
          agentId: agent.id,
          folderPath: agent.path,
          handoverId: found.handoverId,
          taskId: null,
          originAgentId: origin.agentId,
          originChatId: origin.chatId,
          originTaskId: origin.taskId,
          depth: brief.depth,
          groupId: brief.group,
          execution: brief.execution,
          state: 'seen',
          warning: origin.warning,
          briefDigest: found.briefDigest,
          briefStat: found.briefStat,
          reportDigest: report?.digest ?? null,
          reportStat: report?.stat ?? null,
          reportStatus: report?.parsed.ok ? report.parsed.report.status : null,
          lastScannedAt: deps.now()
        })
        const task = deps.tasks.create(scope.profileUserId, {
          title: brief.title,
          goal: brief.body,
          // One path, once: the paragraph names the brief and the trailing
          // `Brief:` line said it a second time (`ux_rules.md` §7).
          description: handoverProtocolParagraph({ briefPath }),
          status: 'new',
          assigneeAgentId: agent.id,
          assigneeName: agent.name,
          assigneeKind: 'agent',
          parentTaskId: origin.parentTaskId,
          origin: 'local',
          executor: 'desktop'
        })
        return deps.repo.update(scope.profileUserId, inserted.id, { taskId: task.id }) ?? { ...inserted, taskId: task.id }
      })
    } catch (error) {
      // Either the unique index fired (another scan got here first) or the task
      // could not be created. Both are "not mine to act on now".
      deps.logger.debug('a handover was not taken in', { handoverId: found.handoverId, error: String(error) })
      return
    }

    const gitAllowsAuto = allowsAuto(check)

    if (!isDepthAllowed(brief.depth)) {
      // Recorded and refused with a visible reason — this is also what stops two
      // folders handing work to each other forever (§3.4).
      deps.repo.update(scope.profileUserId, row.id, { state: 'refused', refusalReason: 'depth_exceeded' })
      advance(scope.profileUserId, row.taskId as string, 'cancelled')
      // A refused member is a finished member: the rest of its group must not
      // wait for work the desktop has already declined.
      checkGroup(scope, row.id)
      return
    }

    if (claimed) {
      // Somebody outside the app wrote `report.md` before we looked: the claim
      // (§3.9). Start nothing — under `auto` this is the only thing standing
      // between a terminal `claude` and a second executor on the same brief.
      deps.repo.update(scope.profileUserId, row.id, { state: 'waiting_external' })
      advance(scope.profileUserId, row.taskId as string, 'in_progress')
      if (report && report.parsed.ok) applyReportEffects(scope, deps.repo.getById(scope.profileUserId, row.id) ?? row, report.parsed.report)
      return
    }

    const wantsAuto = brief.execution === 'auto'
    const settingAuto = agent.handovers === 'auto'
    if (wantsAuto && settingAuto && gitAllowsAuto) {
      await startExecutor(scope, row, brief.title, gitAllowsAuto)
      return
    }

    const gated = openGate(scope, row, brief.title, gitAllowsAuto)
    if (wantsAuto && gated) {
      // The brief asked to run unattended and did not get to. Saying *why* is
      // the difference between a setting the user can fix and a silent demotion.
      const reason = !settingAuto ? 'setting_ask' : autoRefusalFor(check)
      deps.repo.update(scope.profileUserId, gated.id, { warning: `auto_not_allowed:${reason}` })
    }
  }

  /** The row states that mean a member of a group is over, one way or another. */
  const GROUP_TERMINAL_STATES: readonly HandoverState[] = ['done', 'failed', 'skipped', 'refused']

  /**
   * A group wakes **once, when all of it is over** (§3.7) — the fan-in.
   *
   * Returns `true` when this row belongs to a group, which is the caller's
   * signal not to send the per-completion packet: a requester that handed the
   * same piece of work to five projects hears once with five results, not five
   * times over an hour. `blocked` never comes through here — a question cannot
   * wait for the other four — and neither does a handover with no origin chat,
   * which has nobody to wake at all.
   *
   * **"All" means all rows the desktop currently knows.** There is no list of
   * intended members anywhere: `group:` is a string in a file, and a sixth
   * brief may be written an hour from now. So a member that arrives after the
   * group has been reported wakes on its own, with a packet naming itself —
   * `woke_at` on the others is what keeps them out of it.
   */
  function wakeGroupIfComplete(scope: RunScope, row: HandoverRow): boolean {
    if (!row.groupId || !row.originChatId) return false
    let members: HandoverRow[]
    try {
      members = deps.repo.listForGroup(scope.profileUserId, row.originChatId, row.groupId)
    } catch (error) {
      deps.logger.warn('a handover group could not be listed', { id: row.id, error: String(error) })
      return false
    }
    if (members.length === 0) return false

    const pending = members.filter((member) => !GROUP_TERMINAL_STATES.includes(member.state))
    if (pending.length > 0) {
      deps.logger.debug('a handover group is not finished yet', {
        groupId: row.groupId,
        waitingFor: pending.length
      })
      return true
    }

    const unwoken = members.filter((member) => member.wokeAt === null)
    if (unwoken.length === 0) return true
    deps.wakeGroup({ scope, groupId: row.groupId, rows: unwoken })
    return true
  }

  /**
   * A row has just reached a terminal state without a packet of its own —
   * `skipped` or `refused`. It still *counts* towards its group, and it may
   * have been the last one the group was waiting for.
   */
  function checkGroup(scope: RunScope, rowId: string): void {
    try {
      const row = deps.repo.getById(scope.profileUserId, rowId)
      if (row) wakeGroupIfComplete(scope, row)
    } catch (error) {
      deps.logger.warn('a handover group check failed', { id: rowId, error: String(error) })
    }
  }

  /**
   * Tell the origin — **once per report**, on the group path and the single
   * path alike.
   *
   * The two paths used to disagree, and each was wrong in its own direction.
   * The group path filters its members on `woke_at === null`, so a group whose
   * report was rewritten was never spoken about again; the single path read the
   * column not at all, so a terminal report rewritten in place woke the origin
   * a second time with the same news. The rule both now follow is one wake per
   * (row, report digest): `reconcile` clears `woke_at` when a *new* report
   * digest lands, so a genuinely new terminal report may wake again and the
   * same bytes never do.
   *
   * The row is re-read first because everything the packet quotes — the state,
   * the summary, the task — was written a few lines ago, and because `woke_at`
   * is written by the wake module asynchronously.
   */
  function wakeOnce(
    scope: RunScope,
    row: HandoverRow,
    packet: Omit<HandoverWakeInput, 'scope' | 'row'>
  ): void {
    const fresh = deps.repo.getById(scope.profileUserId, row.id) ?? row
    if (fresh.wokeAt) {
      deps.logger.debug('a handover origin had already been told about this report', { id: row.id })
      return
    }
    // A terminal member of a group is reported by the group, once, when the
    // rest of it is done too (§3.7). `blocked` is exempt on purpose: it is a
    // question, and a question that waits for four other projects is a question
    // nobody answers.
    if (packet.status !== 'blocked' && wakeGroupIfComplete(scope, fresh)) return
    deps.wake({ scope, row: fresh, ...packet })
  }

  /**
   * What a parsed report means for the task and the row (§3.6).
   *
   * Exported through the service as `applyReport` because phase 3 hooks the
   * wake here: on a terminal status the origin chat gets a return packet, and
   * everything it needs — the origin ids, the summary, the folder — is what
   * this function already has in hand.
   */
  function applyReportEffects(scope: RunScope, row: HandoverRow, report: HandoverReport): void {
    const userId = scope.profileUserId
    const taskId = row.taskId
    if (!taskId) return
    // The summary is kept on the row as well as on the task: a group packet is
    // built from its members' rows, and reading five tasks to quote one line
    // each would be the alternative.
    const patch: HandoverPatch = { reportStatus: report.status, summary: report.summary }

    /*
      **A gated row loses its gate, whatever the report says.** A report on a
      brief the card is still offering is somebody answering it outside the app
      (§3.9), and every status means the same thing for the card: there is no
      longer an undecided brief to Run. Leaving it open on `blocked` would start
      a second executor on work an outside one is waiting on an answer for, and
      on `done`/`failed` it would leave the borrowed chat attached to a question
      about finished work. The state each branch writes is its own.
    */
    if (row.state === 'gated') Object.assign(patch, withdrawGate(row))

    /*
      The wake is fired from the *end* of each branch, after every write this
      function makes — never from inside a transaction, and never before the
      task carries the note the packet quotes. The turn it opens is somebody
      else's chat: letting it start while this row is half written would let the
      origin agent read the handover's task before the report reached it.

      It fires **once per report**, and the digest guard in `reconcile` is what
      guarantees that: a rescan over identical bytes never reaches this function
      at all, so a `done` report sitting in a folder for a week wakes the origin
      on the day it was written and never again.
    */
    const wakeWith = (status: HandoverReport['status']): void => {
      wakeOnce(scope, row, {
        status,
        summary: report.summary,
        question: report.question,
        artifacts: report.artifacts,
        body: report.body
      })
    }

    if (report.status === 'in_progress') {
      /*
        A claim arriving on a row we had gated is somebody answering the brief
        outside the app while the card sat in the Inbox: the work is under way
        elsewhere, and the withdrawal above has already taken the card back.

        `seen` counts the same way, and has to. It is the state a row is left in
        when `openGate` failed — a crash or a throw between the intake insert
        and the ask — and `retryGate` will not offer that brief again once a
        report status is set. So a `seen` row that hears `in_progress` would
        otherwise sit `seen` with its task `new` for ever, while an outside
        executor worked it: no card, no status, nothing to say who has it.
      */
      if (row.state === 'gated' || row.state === 'seen') {
        patch.state = 'waiting_external' as HandoverState
        advance(userId, taskId, 'in_progress')
      }
      deps.repo.update(userId, row.id, patch)
      return
    }

    if (report.status === 'blocked') {
      advance(userId, taskId, 'blocked')
      const question = report.question ? `\n\nQuestion: ${report.question}` : ''
      safely(() => deps.tasks.setHandoffNote(userId, taskId, `${report.summary}${question}\n\n${report.body}`))
      deps.repo.update(userId, row.id, { ...patch, state: 'blocked' })
      // `blocked` is a question for the requester, so it wakes exactly like a
      // terminal report — that *is* the return path for it (§3.6).
      wakeWith('blocked')
      return
    }

    // `done` and `failed` are final, and they are what closes the task. The
    // note is written before the status so a surface that reacts to the status
    // change already finds the report on the task.
    safely(() => deps.tasks.setHandoffNote(userId, taskId, `${report.summary}\n\n${report.body}`))
    safely(() =>
      deps.tasks.setArtifacts(
        userId,
        taskId,
        report.artifacts.map((path) => ({ kind: 'file' as const, name: basename(path), ref: join(row.folderPath, path) }))
      )
    )
    if (report.status === 'done') {
      advance(userId, taskId, 'completed')
      deps.repo.update(userId, row.id, { ...patch, state: 'done' })
    } else {
      advance(userId, taskId, 'error', { errorMessage: report.summary })
      deps.repo.update(userId, row.id, { ...patch, state: 'failed' })
    }
    wakeWith(report.status)
  }

  /**
   * What the executor's **turn** says, when its `report.md` never said anything
   * final (§3.6: "report wins when both exist").
   *
   * This is the other half of the contract, and it only exists for executors
   * **Cinna ran**: an agent that finishes a turn without writing a terminal
   * report has still finished, and without this the task would sit
   * `in_progress` for ever and the origin would wait for a packet that never
   * comes. An executor running in a terminal has no turn here to fall back to —
   * its report is the only signal there is, which is why the file contract asks
   * for one.
   *
   * The folder is rescanned **first**, so a report written in the last second of
   * the turn still wins. Only a row that is *still* `running` after that is
   * decided by the outcome.
   */
  async function applyOutcome(scope: RunScope, rowId: string, outcome: HandoverTurnOutcome): Promise<void> {
    const userId = scope.profileUserId
    const before = deps.repo.getById(userId, rowId)
    if (!before) return
    try {
      const agent = deps.agents(scope.settingsUserId).find((candidate) => candidate.id === before.agentId)
      if (agent) await scanAgent(scope, agent)
    } catch (error) {
      deps.logger.warn('a handover could not be rescanned after its turn', { id: rowId, error: String(error) })
    }

    const row = deps.repo.getById(userId, rowId)
    // The report won, or the user cancelled, or a later scan moved it on.
    if (!row || row.state !== 'running' || !row.taskId) return

    // `needs_input` is not an end: the executor parked on its own ask and that
    // ask is on the Inbox. Answering it resumes the same turn, which will reach
    // one of the other states. Closing the task here would take the question
    // away from the user.
    if (outcome.state === 'needs_input') return

    settleWithoutReport(scope, row, outcome.state, outcome.text)
  }

  /**
   * Close a handover from something other than its report: the turn's outcome,
   * or a scan finding the run gone. Both write the same shape, and the warning
   * is what says which happened.
   *
   * **Not while a revision of this row is still owed a turn.** Two revisions
   * found in one scan are queued together and run one after the other, because
   * the second waits for the executor's chat; the first one's turn ending
   * without a report used to close the task and wake the origin there and then,
   * and the second revision then ran on a finished task whose outcome
   * `applyOutcome` dropped. The last turn of the row is the one that settles it.
   */
  function settleWithoutReport(
    scope: RunScope,
    row: HandoverRow,
    state: HandoverTurnOutcome['state'] | 'lost',
    text: string
  ): void {
    const userId = scope.profileUserId
    const taskId = row.taskId
    if (!taskId) return
    if (owesRevision(row.id)) {
      deps.logger.info('a handover turn ended with a revision still to come; it stays running', {
        id: row.id,
        state
      })
      return
    }
    /*
      `report_unparseable` is kept where it is already on the row: a `report.md`
      that exists and will not parse is a more specific — and more actionable —
      fact than "no report was written", and it is the one the executor has to
      fix. Overwriting it with `report_missing` told the user to write a file
      they had written.
    */
    const warning: HandoverWarning =
      row.warning === 'report_unparseable'
        ? 'report_unparseable'
        : state === 'lost'
          ? 'run_lost'
          : 'report_missing'
    const summary =
      state === 'lost'
        ? 'The executor’s run was lost — the app closed before it finished, and no report was written.'
        : state === 'completed'
          ? 'The executor finished its turn without writing a report.'
          : state === 'canceled'
            ? 'The executor’s turn was stopped before it wrote a report.'
            : 'The executor’s turn ended without a report.'

    if (state === 'canceled') {
      advance(userId, taskId, 'cancelled')
      deps.repo.update(userId, row.id, { state: 'skipped', warning, summary })
      // Nothing to report for this one, but a group may have been waiting on it.
      checkGroup(scope, row.id)
      return
    }

    const done = state === 'completed'
    if (text.trim()) safely(() => deps.tasks.setHandoffNote(userId, taskId, text))
    advance(userId, taskId, done ? 'completed' : 'error', done ? undefined : { errorMessage: summary })
    deps.repo.update(userId, row.id, { state: done ? 'done' : 'failed', warning, summary })

    // The origin asked for this work and is owed an answer whichever way it
    // ended. The turn's text is the body: it is all the executor left behind.
    wakeOnce(scope, row, { status: done ? 'done' : 'failed', summary, body: text })
  }

  /**
   * A `running` row whose turn nothing is going to report on.
   *
   * The app was closed or crashed mid-turn: `runExecutionService` lost the
   * handle with the process, and `applyOutcome` will never fire. The grace
   * period is what keeps this from racing a start that has only just happened —
   * and `updated_at` is the right clock for it because a scan that changes
   * nothing deliberately does not bump it (`handoverRepo.update`).
   */
  function sweepLostRuns(scope: RunScope, rows: HandoverRow[]): void {
    const userId = scope.profileUserId
    const cutoff = deps.now().getTime() - HANDOVER_RUN_LOST_AFTER_MS
    for (const row of rows) {
      if (row.state !== 'running' || !row.taskId) continue
      if (row.updatedAt.getTime() > cutoff) continue
      /*
        **An executor parked on a question is not a lost run.** `applyOutcome`
        returns on `needs_input` and leaves the row `running` on purpose — the
        ask is on the Inbox and answering it resumes the same turn — but the
        turn itself has ended, so nothing is live in the chat and `updated_at`
        goes stale while the user reads the card. Without this the sweep errored
        the task and told the origin the app had closed, with the question still
        on screen waiting for an answer.
      */
      if (hasOpenAsk(row.taskId)) continue
      let chatId: string | null = null
      try {
        chatId = deps.tasks.getById(userId, row.taskId).chatId
      } catch {
        continue
      }
      if (chatId && deps.isRunning(chatId)) continue
      deps.logger.warn('a handover run was lost with the app that started it', { id: row.id })
      settleWithoutReport(scope, row, 'lost', '')
    }
  }

  /**
   * Is the Inbox still holding a question about this task? A read that fails
   * answers **yes**: the sweep's write closes a task and wakes an origin, and
   * doing that on a read nobody could make is the expensive way to be wrong.
   */
  function hasOpenAsk(taskId: string): boolean {
    try {
      return deps.inputRequests.hasOpenForTask(taskId)
    } catch (error) {
      deps.logger.warn('a handover could not check its task’s open asks', { taskId, error: String(error) })
      return true
    }
  }

  function safely(fn: () => unknown): void {
    try {
      fn()
    } catch (error) {
      deps.logger.warn('a handover task write failed', { error: String(error) })
    }
  }

  /*
    Revisions handed to the sender whose turn has not ended yet, per row.

    The sender queues them per chat and lets each wait for the one before it, so
    a scan that found `001.md` and `002.md` together produces two turns minutes
    apart. Between them the row is still `running` and its task still open —
    which is a fact only this side knows, since neither the row nor the folder
    says "one more turn is coming" (see `settleWithoutReport`).

    File names rather than a counter so releasing is idempotent: a send that
    ends both ways — the turn was accepted and recording it then threw — must
    not take a later revision's claim with it.
  */
  const owedRevisions = new Map<string, Set<string>>()

  function claimRevisions(rowId: string, files: string[]): void {
    const owed = owedRevisions.get(rowId) ?? new Set<string>()
    for (const file of files) owed.add(file)
    owedRevisions.set(rowId, owed)
  }

  /** This revision will not produce another turn: its own ended, or none started. */
  function releaseRevision(rowId: string, file: string): void {
    const owed = owedRevisions.get(rowId)
    if (!owed) return
    owed.delete(file)
    if (owed.size === 0) owedRevisions.delete(rowId)
  }

  function owesRevision(rowId: string): boolean {
    return (owedRevisions.get(rowId)?.size ?? 0) > 0
  }

  /**
   * Deliver the `revisions/NNN.md` this row has not seen yet (§3.2, §3.7).
   *
   * A revision is the requester coming back to a handover that is already on
   * its way, so it is **a new turn on the handover's own chat** — the session
   * continues, the executor keeps everything it has read, and the revision
   * lands as a follow-up rather than as a second task.
   *
   * Four ways it is not sent, each for a different reason:
   *
   *  - the brief has not run yet (`seen`, `gated`): the executor reads the
   *    folder when it starts, and the revision is sitting beside the brief. It
   *    is left undelivered rather than marked, so the first turn after a Run
   *    picks it up through this same path.
   *  - the desktop declined or the requester withdrew (`refused`, `skipped`):
   *    there is no work to revise.
   *  - nothing of ours is running it (`waiting_external`, or a gate whose start
   *    never happened): there is no chat to send a turn on, and an outside
   *    executor reads the folder for everything else too.
   *  - the task is over. `completed` reaches only `archived`, so there is no
   *    legal way back to `in_progress` and no turn to carry the revision: the
   *    row records `revision_after_terminal` and the requester needs a new
   *    brief. A **failed** task is different — `error → in_progress` is legal —
   *    and a revision is exactly how a requester says "try again, like this".
   */
  function deliverRevisions(scope: RunScope, row: HandoverRow, found: FoundHandover): void {
    const userId = scope.profileUserId
    if (found.revisionFiles.length === 0 || !row.taskId) return
    const delivered = deliveredRevisions(row)
    const pending = found.revisionFiles.filter((file) => !delivered.includes(file))
    if (pending.length === 0) return
    if (row.state === 'seen' || row.state === 'gated' || row.state === 'refused' || row.state === 'skipped') return

    let task: TaskDto
    try {
      task = deps.tasks.getById(userId, row.taskId)
    } catch {
      return
    }
    const chatId = task.chatId
    if (!chatId) {
      deps.logger.debug('a handover revision has no chat of ours to arrive on', { id: row.id, state: row.state })
      return
    }

    if (task.status !== 'in_progress' && !canTransition(task.status, 'in_progress')) {
      // Marked delivered along with the warning: the file will still be there
      // next minute, and rewriting the same warning once a minute for ever is
      // how a row's `updated_at` stops meaning anything.
      deps.repo.update(userId, row.id, {
        warning: 'revision_after_terminal',
        revisionsDelivered: JSON.stringify([...delivered, ...pending])
      })
      deps.logger.info('a handover revision arrived after its task was over', { id: row.id, files: pending })
      return
    }

    const queued: { file: string; content: string }[] = []
    for (const file of pending) {
      const bytes = readBytes(join(found.dir, HANDOVER_REVISIONS_DIR, file))
      if (!bytes) break
      const parsed = parseHandoverRevision(bytes.toString('utf8'))
      if (!parsed.ok) {
        // Order is the whole meaning of `NNN`, so a file that will not parse
        // holds the ones after it rather than being stepped over. It is left
        // undelivered: a half-written file parses on the next scan, and only
        // the warning says it has been waiting.
        if (row.warning !== 'revision_unparseable') {
          deps.repo.update(userId, row.id, { warning: 'revision_unparseable' })
        }
        break
      }
      queued.push({
        file,
        content: buildHandoverRevisionTurn({
          handoverId: row.handoverId,
          ordinal: revisionOrdinal(file) ?? file,
          title: parsed.revision.title,
          body: parsed.revision.body,
          reportPath: join(found.dir, HANDOVER_REPORT_FILE)
        })
      })
    }
    if (queued.length === 0) return

    /*
      Claimed **before** the sends, in one write, for the same reason the gate
      claims a row before it starts one: a send waits for the chat to be free,
      which may be the length of a turn, and a scan a minute later must not
      find these files pending and queue them a second time. A send that is
      then refused records `revision_send_failed:` on the row — the revision is
      on disk either way, which is what the file contract is for.
    */
    const updated =
      deps.repo.update(userId, row.id, {
        state: 'running',
        revisionsDelivered: JSON.stringify([...delivered, ...queued.map((item) => item.file)])
      }) ?? row
    advance(userId, row.taskId, 'in_progress')
    // Claimed with the same write, and for the neighbouring reason: from here
    // until the last of these turns ends, the row owes more work than either
    // the row or the folder can show.
    claimRevisions(updated.id, queued.map((item) => item.file))

    for (const item of queued) {
      deps.sendRevision({
        scope,
        row: updated,
        chatId,
        file: item.file,
        content: item.content,
        /*
          A revision's turn is watched exactly like the first one. Without this
          the row sat `running` behind a turn nobody was following: the
          executor finished, no report was written, and two minutes later the
          lost-run sweep closed the task as "the app closed" while the app was
          open and the turn had ended normally (§3.6).

          The claim is given up **before** the outcome is applied — `finally`
          runs ahead of the chain `watchTurn` attaches — so this revision's own
          turn never counts itself as the one still to come.
        */
        watch: (completed) =>
          watchTurn(scope, updated.id, completed.finally(() => releaseRevision(updated.id, item.file))),
        // No turn will happen: the chat is gone, the send was refused, or it
        // never went idle. The row keeps the sender's warning, and the next
        // turn to end is free to settle it.
        onNotSent: () => releaseRevision(updated.id, item.file)
      })
    }
  }

  /**
   * The retry `openGate`'s failure path promises.
   *
   * A gate that could not be opened — the ask row, the task write or the row
   * patch threw — leaves the handover `seen` with no request of its own, and
   * the comment there says "the next scan tries again". Nothing did: `seen` is
   * reached only through intake, and a known row never went back through it. So
   * a brief nobody was ever asked about sat in a folder for ever, with a task
   * in `new` and no card in the Inbox.
   *
   * Narrow on purpose: a live task, no open gate, and **no report status at
   * all** — a `seen` row that has heard from an outside executor is being
   * worked on, and offering Run for it is the second-executor mistake §3.9
   * exists to prevent.
   */
  async function retryGate(
    scope: RunScope,
    row: HandoverRow,
    found: FoundHandover,
    gitCheck: () => Promise<HandoverIgnoreCheck>
  ): Promise<void> {
    if (row.state !== 'seen' || row.gateRequestId || !row.taskId) return
    if (row.reportStatus !== null) return
    if (isTaskTerminal(scope.profileUserId, row.taskId)) return

    let title = found.brief?.title ?? ''
    if (!title) {
      try {
        title = deps.tasks.getById(scope.profileUserId, row.taskId).title
      } catch {
        title = row.handoverId
      }
    }
    deps.logger.info('a handover gate that failed to open is being asked again', { id: row.id })
    openGate(scope, row, title, allowsAuto(await gitCheck()))
  }

  /** A row we have seen before: the brief may have been edited, the report may have moved. */
  async function reconcile(
    scope: RunScope,
    row: HandoverRow,
    found: FoundHandover,
    gitCheck: () => Promise<HandoverIgnoreCheck>
  ): Promise<void> {
    const userId = scope.profileUserId
    const patch: HandoverPatch = { lastScannedAt: deps.now() }
    // A brief that is back — restored from the trash, or a folder that was
    // simply not readable for one scan. The row stopped pointing at its
    // directory when it went; it starts again now that the file is there.
    if (row.briefMissingAt) patch.briefMissingAt = null
    // Only when it moved: a stamp rewritten on every scan would turn an
    // untouched folder into a row that changes once a minute, and the lost-run
    // sweep reads exactly that freshness (`handoverRepo.update`).
    if (found.briefStat && row.briefStat !== found.briefStat) patch.briefStat = found.briefStat

    if (row.briefDigest !== found.briefDigest) {
      // Recorded, never acted on: one brief, one task, forever (§4.3). Rewriting
      // a `ready` brief is the mistake this catches, and the executor may
      // already be working from what it said the first time.
      patch.briefDigest = found.briefDigest
      patch.warning = 'brief_edited'
    }

    // The same stamp shortcut the brief gets: a `report.md` whose mtime and
    // size are where the last scan left them is the report this row already
    // knows, and it is neither read nor hashed.
    const reportStat = fileStamp(join(found.dir, HANDOVER_REPORT_FILE))
    const report = reportStat && row.reportStat === reportStat ? null : readReport(found.dir)
    if (!report || report.digest === row.reportDigest) {
      if (report?.stat && row.reportStat !== report.stat) patch.reportStat = report.stat
      const scanned = deps.repo.update(userId, row.id, patch) ?? row
      await retryGate(scope, scanned, found, gitCheck)
      deliverRevisions(scope, scanned, found)
      return
    }
    patch.reportDigest = report.digest
    if (row.reportStat !== report.stat) patch.reportStat = report.stat
    /*
      A new report is news the origin has not had. Clearing `woke_at` is what
      makes "one wake per (row, report digest)" true on both wake paths: the
      group path has always skipped a member that carries the column, and
      {@link wakeOnce} now does the same for a single handover.
    */
    patch.wokeAt = null
    patch.wakeRunId = null
    if (!report.parsed.ok) {
      patch.warning = 'report_unparseable'
      const scanned = deps.repo.update(userId, row.id, patch) ?? row
      deliverRevisions(scope, scanned, found)
      return
    }
    const updated = deps.repo.update(userId, row.id, patch) ?? row
    applyReportEffects(scope, updated, report.parsed.report)
    // **After** the report, deliberately: a report and a revision arriving in
    // the same scan are the executor finishing and the requester following up,
    // in that order, and the revision has to be read against the state the
    // report left behind — including a `done` it cannot reopen.
    deliverRevisions(scope, deps.repo.getById(userId, row.id) ?? updated, found)
  }

  /**
   * A row whose brief is no longer on disk.
   *
   * Deleting a pending handover is how a requester withdraws it, so the task is
   * cancelled and the row becomes `skipped`. **Except while it is running**: the
   * executor is mid-turn in that folder right now, and cancelling underneath it
   * would abandon work in progress over a file that has already served its
   * purpose. That case is a warning and nothing else. A terminal task keeps its
   * row and its note — the folder was simply cleaned up, which §3.2 invites.
   */
  function briefRemoved(scope: RunScope, row: HandoverRow): void {
    /*
      Recorded before anything else is decided, and for a terminal task too:
      the task page prints `.cinna/handovers/<id>` and that row is a claim
      about a directory on disk (`ux_rules.md` §9). The claim stops being true
      the moment the brief goes, whether the work had finished or not.
    */
    if (!row.briefMissingAt) {
      row = deps.repo.update(scope.profileUserId, row.id, { briefMissingAt: deps.now() }) ?? row
    }
    if (isTaskTerminal(scope.profileUserId, row.taskId)) return
    if (row.state === 'running') {
      deps.repo.update(scope.profileUserId, row.id, { warning: 'brief_removed_while_running' })
      return
    }
    const patch = withdrawGate(row)
    advance(scope.profileUserId, row.taskId as string, 'cancelled')
    deps.repo.update(scope.profileUserId, row.id, { ...patch, state: 'skipped' })
    checkGroup(scope, row.id)
  }

  async function scanFolderPass(scope: RunScope, agent: HandoverAgent): Promise<void> {
    const known = new Map(deps.repo.listForAgent(scope.profileUserId, agent.id).map((row) => [row.handoverId, row]))
    const found = readFolder(agent.path, known)
    const seen = new Set<string>()

    // Asked once per folder, and only when there is something to decide with it:
    // `git` is a subprocess, and a folder with no new brief must cost nothing.
    let check: HandoverIgnoreCheck | null = null
    const gitCheck = async (): Promise<HandoverIgnoreCheck> => {
      check ??= await deps.git.check(agent.path).catch(() => ({ result: 'unknown' as const }))
      return check
    }

    for (const item of found) {
      seen.add(item.handoverId)
      const existing = known.get(item.handoverId) ?? deps.repo.byAgentAndHandoverId(agent.id, item.handoverId)
      // The dedupe read is unscoped on purpose — it has to match the unique
      // index — but a *bare agent* is settings-scoped and therefore visible from
      // every profile, while its handover rows are profile-scoped. So profile B
      // scanning the same folder finds profile A's row. Every write it then made
      // would be silently scoped away, and `advance` would throw on A's task and
      // be swallowed, once a minute, for ever. The brief is A's; B leaves it be.
      if (existing && existing.userId !== scope.profileUserId) {
        deps.logger.debug('a handover in this folder belongs to another profile', {
          agentId: agent.id,
          handoverId: item.handoverId
        })
        continue
      }
      try {
        /*
          Re-read, never the snapshot. `known` was taken before the first
          `await` in this pass, and between then and now a turn may have
          finished, an Inbox answer may have started an executor or a report may
          have moved the row on. Reconciling the stale copy re-applied a report
          that had already been applied — and woke the origin a second time.
        */
        const fresh = existing ? (deps.repo.getById(scope.profileUserId, existing.id) ?? existing) : null
        if (fresh) await reconcile(scope, fresh, item, gitCheck)
        else await intake(scope, agent, item, await gitCheck())
      } catch (error) {
        deps.logger.error('a handover could not be processed', {
          agentId: agent.id,
          handoverId: item.handoverId,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }

    for (const [handoverId, row] of known) {
      if (seen.has(handoverId)) continue
      try {
        // Re-read for the same reason as above, and here it decides more: a
        // stale `running` would be read as a settled row and the brief's
        // disappearance would cancel a task under a live turn.
        briefRemoved(scope, deps.repo.getById(scope.profileUserId, row.id) ?? row)
      } catch (error) {
        deps.logger.error('a withdrawn handover could not be settled', { id: row.id, error: String(error) })
      }
    }

    // Re-read: the loops above may have moved rows out of `running`, and a row
    // settled a moment ago must not be swept as lost.
    try {
      sweepLostRuns(scope, deps.repo.listForAgent(scope.profileUserId, agent.id))
    } catch (error) {
      deps.logger.error('the lost-run sweep failed', { agentId: agent.id, error: String(error) })
    }
  }

  /*
    One pass per folder at a time, and at most one waiting behind it.

    A scan is not atomic: it awaits a `git` subprocess and a start, and while it
    does, the minute tick or a watch event can begin a second pass over the same
    folder. Both then hold snapshots of the same rows and act on them twice — the
    same report applied twice, the origin woken twice, a `briefRemoved` decided
    against a state that has since changed. Re-reading each row before acting is
    half the answer (see `scanFolderPass`); this is the other half.

    Two callers arriving while a pass runs get **one** follow-up between them,
    not two: the folder is read afresh by that pass anyway, so a second identical
    sweep would only cost `git` another subprocess.

    The follow-up is queued as an **intent** — an agent id — and never as the
    queuer's `agent` and `scope`. Those are a snapshot taken when the caller
    arrived, and the pass runs the length of a turn later: the queuer that most
    often waits is the rescan the gate fires right after the user chose "Run
    automatically", and serving it the snapshot from before that click gated the
    next brief for the permission the user had just granted. A profile switch in
    the same window is the other half of it. So both are read again where the
    pass actually starts.
  */
  const activeScans = new Map<string, Promise<void>>()
  const queuedScans = new Map<string, Promise<void>>()

  function startScan(scope: RunScope, agent: HandoverAgent): Promise<void> {
    const pass = scanFolderPass(scope, agent).finally(() => {
      if (activeScans.get(agent.id) === pass) activeScans.delete(agent.id)
    })
    activeScans.set(agent.id, pass)
    return pass
  }

  /**
   * The agent and the scope a queued pass should run with, read now.
   *
   * `null` when the agent has gone in the meantime — removed from the list,
   * disabled, its root dropped — because a pass over a folder the profile can
   * no longer hand work to would take in briefs for an agent that is not there.
   * The queuer's scope is the fallback and not the answer: `currentScope()` is
   * null only when no profile is activated, and a pass that wrote tasks under
   * whatever id it found last is the mistake `scanFolderNow` already refuses.
   */
  function resolveScan(agentId: string, queuedWith: RunScope): { scope: RunScope; agent: HandoverAgent } | null {
    const scope = deps.currentScope() ?? queuedWith
    try {
      const agent = deps.agents(scope.settingsUserId).find((candidate) => candidate.id === agentId)
      if (agent) return { scope, agent }
      deps.logger.debug('a queued handover scan found its agent gone', { agentId })
    } catch (error) {
      deps.logger.warn('a queued handover scan could not list agents', { agentId, error: String(error) })
    }
    return null
  }

  function scanAgent(scope: RunScope, agent: HandoverAgent): Promise<void> {
    const active = activeScans.get(agent.id)
    if (!active) return startScan(scope, agent)
    const queued = queuedScans.get(agent.id)
    if (queued) return queued
    const agentId = agent.id
    const next = active.catch(() => {}).then(() => {
      if (queuedScans.get(agentId) === next) queuedScans.delete(agentId)
      const resolved = resolveScan(agentId, scope)
      if (!resolved) return
      return startScan(resolved.scope, resolved.agent)
    })
    queuedScans.set(agent.id, next)
    return next
  }

  /**
   * Every bare agent of this profile, one folder at a time.
   *
   * **Never throws, and one folder's failure never reaches the next.** This runs
   * on a minute tick; a scan that threw would stop scanning the rest of the
   * user's projects until the app restarted, and would do it silently.
   */
  async function scanAll(scope: RunScope): Promise<void> {
    let agents: HandoverAgent[] = []
    try {
      agents = deps.agents(scope.settingsUserId)
    } catch (error) {
      deps.logger.warn('the handover scan could not list agents', { error: String(error) })
      return
    }
    for (const agent of agents) {
      try {
        await scanAgent(scope, agent)
      } catch (error) {
        deps.logger.error('a handover folder scan failed', {
          agentId: agent.id,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
  }

  return {
    scanAll,
    scanAgent,

    /**
     * One folder, now — what a watch event under `.cinna/handovers/` asks for.
     *
     * Resolves the agent and the scope itself, and does nothing at all when no
     * profile is activated: the watcher outlives a profile switch, and a scan
     * without a profile would write tasks under whatever id it found last.
     */
    async scanFolderNow(agentDir: string): Promise<void> {
      const scope = deps.currentScope()
      if (!scope) return
      try {
        const agent = deps.agents(scope.settingsUserId).find((candidate) => candidate.path === agentDir)
        if (!agent) return
        await scanAgent(scope, agent)
      } catch (error) {
        deps.logger.error('a handover watch scan failed', { agentDir, error: String(error) })
      }
    },

    /**
     * Answer a gate card. `null` for every request id that is not a gate — this
     * runs through `taskRunnerBridge`, which asks every hook in turn.
     */
    answer(userId: string, requestId: string, resolution: RequestResolution): Promise<InboxAnswerResult> | null {
      const rowId = parseHandoverGateRequestId(requestId)
      if (!rowId) return null
      const row = deps.repo.getById(userId, rowId)
      if (!row) return null
      return (async (): Promise<InboxAnswerResult> => {
        const request = deps.inputRequests.getById(requestId)
        if (!request) return { ok: false, code: 'no_longer_waiting', reason: 'This request is no longer waiting for an answer.' }
        if (request.status !== 'open') return { ok: false, code: 'already_answered', reason: 'This request has already been answered.' }
        if (!row.taskId) return { ok: false, code: 'no_longer_waiting', reason: 'This handover’s task is gone.' }
        if (resolution.kind !== 'question') return { ok: false, code: 'malformed', reason: 'Choose one of the options.' }
        const label = resolution.answers?.[0]?.[0]

        if (label === HANDOVER_GATE_OPTIONS.skip) {
          deps.transaction(() => {
            deps.inputRequests.settle(requestId, 'answered', resolution)
            releaseGateChat(row)
            deps.repo.update(userId, row.id, { state: 'skipped', gateRequestId: null, gateChatId: null })
          })
          advance(userId, row.taskId, 'cancelled')
          // A skipped member is a finished member. Only with a profile
          // activated, because the group wake starts a turn and that needs the
          // settings scope — without one the next scan does this anyway.
          const activeScope = deps.currentScope()
          if (activeScope) checkGroup(activeScope, row.id)
          return { ok: true }
        }

        if (label !== HANDOVER_GATE_OPTIONS.run && label !== HANDOVER_GATE_OPTIONS.runAndAuto) {
          return { ok: false, code: 'malformed', reason: 'Choose one of the options.' }
        }

        // No fallback to the profile id: `setHandovers` writes under the
        // settings scope, and guessing it wrong would put a standing permission
        // to run code on the wrong scope's agent. Unreachable from the IPC path
        // (every handler calls `requireActivated` first), so this is the
        // belt-and-braces refusal, not a case the user meets.
        const active = deps.currentScope()
        if (!active) {
          return { ok: false, code: 'unavailable', reason: 'Sign in to this profile before running a handover.' }
        }
        const settingsUserId = active.settingsUserId
        if (label === HANDOVER_GATE_OPTIONS.runAndAuto) {
          // The setting is flipped first, so a folder git has since started
          // tracking refuses the *permission* without refusing the run the user
          // asked for in the same click.
          try {
            await deps.setHandovers(settingsUserId, row.agentId, 'auto')
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            deps.logger.info('a handover ran without being made automatic', { id: row.id, reason })
            /*
              The refusal's own answer, not a word read out of its sentence.
              `LocalAgentError` carries `check.result` as its `detail`, and
              sniffing `message.includes('track')` instead reported `not_ignored`
              for a folder git tracks whenever the wording of that sentence
              changed, and for `unknown` — git missing, timed out — always.
            */
            const detail = (error as { detail?: unknown })?.detail
            const refusal = autoRefusalFor({
              result: (typeof detail === 'string' ? detail : 'unknown') as HandoverIgnoreCheck['result']
            })
            deps.repo.update(userId, row.id, { warning: `auto_not_allowed:${refusal}` })
          }
        }

        /*
          Settled **before** the start, because `taskExecutionService.start`
          refuses outright while any ask is open for the task — an unsettled
          gate makes its own answer impossible to act on.

          `state: 'running'` is written in the *same* transaction, ahead of the
          start it describes, and that ordering is the fix for a real race: a
          minute scan landing in the window between the settle and `start`
          resolving would otherwise find a row still `gated`, take it for an
          undecided brief, and — if the requester had meanwhile deleted the
          brief — delete the gate chat and cancel the task under a Run the user
          had just clicked. `start` would then fail on a chat that no longer
          exists. Claiming the row first makes that window take the `running`
          path instead, which only warns; the catch below puts the row back if
          the start really does fail.
        */
        deps.transaction(() => {
          deps.inputRequests.settle(requestId, 'answered', resolution)
          deps.repo.update(userId, row.id, { state: 'running', gateRequestId: null })
        })

        try {
          const result = await deps.execution.start(
            { profileUserId: userId, settingsUserId },
            row.taskId,
            { kind: 'agent', agentId: row.agentId },
            row.gateChatId ? { reuseChatId: row.gateChatId } : undefined
          )
          // The chat is the task's now, and a running task's conversation
          // belongs in the sidebar.
          if (row.gateChatId) deps.chats.showInList(userId, row.gateChatId)
          deps.repo.update(userId, row.id, { state: 'running', runId: result.runId, gateChatId: null })
          watchTurn({ profileUserId: userId, settingsUserId }, row.id, result.completed)
          return { ok: true }
        } catch (error) {
          // The gate is **spent**. Putting the row back to `gated` would leave a
          // card whose Inbox row has already been answered, so the refusal is
          // recorded and the user is told; the task keeps whatever status it has
          // and can be started from its own page.
          // Back to `gated` as a *state*, not as an offer: the Inbox row is
          // already answered and no new card appears. It is the honest label for
          // a handover that was approved and did not start, and it lets the
          // ordinary `briefRemoved` path settle the row if the brief is gone.
          const reason = error instanceof Error ? error.message : String(error)
          deps.repo.update(userId, row.id, { state: 'gated', warning: `start_refused:${reason}` })
          return { ok: false, code: 'unavailable', reason }
        }
      })()
    },

    /** The handover behind a task, for the task page. */
    forTask(userId: string, taskId: string): HandoverDto | null {
      const row = deps.repo.byTaskId(userId, taskId)
      return row ? deps.repo.toDto(row) : null
    },

    listForAgent(userId: string, agentId: string): HandoverDto[] {
      return deps.repo.listForAgent(userId, agentId).map((row) => deps.repo.toDto(row))
    },

    /** The seam phase 3 hooks for the return packet. */
    applyReport: applyReportEffects
  }
}

export type HandoverService = ReturnType<typeof createHandoverService>

// ---------------------------------------------------------------------------
// The production wiring
// ---------------------------------------------------------------------------

/**
 * The real collaborators.
 *
 * Every task write goes through `taskService`, never `taskRepo`: the service is
 * what exports the handoff file a folder agent reads, refuses illegal
 * transitions and keeps the sync bookkeeping honest. Chats, asks and tasks are
 * written under `scope.profileUserId`; the agent list and its settings are read
 * under `scope.settingsUserId`, because folder agents live in the Default scope
 * and follow every profile.
 */
function productionDeps(): HandoverDeps {
  return {
    repo: handoverRepo,
    tasks: {
      create: (userId, input) => taskService.create(userId, input),
      getById: (userId, taskId) => taskService.getById(userId, taskId),
      setStatus: (userId, taskId, status, opts) => taskService.setStatus(userId, taskId, status, opts),
      setHandoffNote: (userId, taskId, note) => taskService.setHandoffNote(userId, taskId, note),
      setArtifacts: (userId, taskId, artifacts) => taskService.setArtifacts(userId, taskId, artifacts),
      applyRunState: (userId, taskId, state) => taskService.applyRunState(userId, taskId, state)
    },
    execution: {
      start: (scope, taskId, target, options) => taskExecutionService.start(scope, taskId, target, options)
    },
    inputRequests: {
      open: (input) => taskInputRequestRepo.open(input),
      getById: (requestId) => taskInputRequestRepo.getById(requestId),
      hasOpenForTask: (taskId) => taskInputRequestRepo.listOpenForTask(taskId).length > 0,
      settle: (requestId, status, resolution) => taskInputRequestRepo.settle(requestId, status, resolution ?? null)
    },
    chats: {
      create: (userId, init) => chatRepo.create(userId, init),
      showInList: (userId, chatId) => chatRepo.showInList(userId, chatId),
      permanentDelete: (userId, chatId) => chatRepo.permanentDelete(userId, chatId),
      // `lastId` rather than a count: it is the cheapest question that answers
      // "has anybody written in here", and it is what `taskExecutionService`
      // asks of the same chat before it adopts one.
      isEmpty: (chatId) => messageRepo.lastId(chatId) === null
    },
    /**
     * **The one place this feature asks what kind of agent something is.**
     *
     * Handover targets are bare folders only (§3.8), and that is a fact about
     * the folder rather than about how a turn runs: a kit folder is *published*
     * and Cinna already writes into it, so a `.cinna/handovers` there would
     * travel to whoever installed the kit. A disabled agent is skipped for the
     * same reason it is skipped everywhere — the user has turned it off.
     */
    agents: (settingsUserId) =>
      localAgentService
        .list(settingsUserId)
        .agents.filter((agent) => agent.kind === 'bare' && agent.enabled && agent.path)
        .map((agent) => ({
          id: agent.id,
          path: agent.path,
          name: agent.name,
          handovers: agent.desktop?.handovers ?? null
        })),
    agentExists: (agentId) =>
      getAgentLookupScope().some((scopeUserId) => agentRepo.getOwned(scopeUserId, agentId) !== undefined),
    chatAnswersToAgent,
    git: handoverGit,
    setHandovers: (settingsUserId, agentId, setting) =>
      localAgentService.setHandovers(settingsUserId, agentId, setting),
    wake: (input) => handoverWake.wake(input),
    wakeGroup: (input) => handoverWake.wakeGroup(input),
    sendRevision: (input) => handoverRevisions.send(input),
    isRunning: (chatId) => runExecutionService.isRunning(chatId),
    transaction: (fn) => getDb().transaction(fn),
    currentScope: () =>
      userActivation.isActivated()
        ? { profileUserId: getProfileScopeUserId(), settingsUserId: getSettingsScopeUserId() }
        : null,
    logger: createLogger('handovers'),
    now: () => new Date()
  }
}

export const handoverService = createHandoverService(productionDeps())

/**
 * The gate's answer path. Registered like every runner's, at the module bottom,
 * and reached from `inboxService.answer` **before** its `deliveryOwner ===
 * 'runner' || !row.agentId` arm — which a handover row (no agent) would
 * otherwise fall into and be told to wait for a local runner that does not exist.
 */
installTaskRunnerHooks(
  {
    answer: (userId, requestId, resolution) => handoverService.answer(userId, requestId, resolution),
    // Nothing to do: a handover keeps no in-memory execution state. The row is
    // the state, and the next scan reconciles it against the folder.
    taskChanged: () => {},
    chatRemoved: () => {},
    profileRemoved: () => {}
  },
  'handover'
)
