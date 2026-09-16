/**
 * The ACP provider of session activity: which background processes and
 * subagents an ACP session is running, read off its `session/update`s and
 * reported to the engine-neutral hub (`shared/sessionActivity.ts`).
 *
 * The transcript translator (`acpMessages.ts`) ignores every kind read here;
 * none of them is transcript content.
 *
 * ## What the engines send (`drafts/session_activity/phase0_findings.md`)
 *
 * Both adapters send these only when the client advertises the JetBrains AIR
 * extension ({@link airClientMeta}):
 *
 * - `async_task_spawned` {asyncTaskId, name, description?, canStop,
 *   outputFilePath?, toolCallId?}, then `async_task_progress` {asyncTaskId,
 *   toolCallId?, outputFilePath?, summary?}, then `async_task_state_update`
 *   {asyncTaskId, state, summary?}. Claude's spawn has neither `toolCallId`
 *   nor `outputFilePath`: they come in the next progress and are merged in.
 *   Claude may send `stopped` then `completed` for one task, and the hub takes
 *   the correction.
 * - `subagent_spawned` {subagentSessionId, name, task} and
 *   `subagent_state_update` {subagentSessionId, state}, with the states
 *   `completed | failed | disconnected | cancelled`.
 *
 * **Codex is not told about native subagent sessions** (it would suppress the
 * spawn call and nothing would link the child to the chat). Its subagents are
 * read from the tool calls it sends on the root session instead:
 * `_meta.codex.subagent {threadId, path, activity}` (recorded:
 * `codex-q6-nocaps-subagent`) and, from the adapter's code only, the
 * `agentsStates` of a `_meta.codex.collaboration` call.
 *
 * ## Claude subagents, inline
 *
 * With `nativeSubagentSessions` on, a Claude subagent's own frames arrive
 * under the child session id, and the parent never receives the `Agent`
 * `tool_call` — only the PostToolUse `tool_call_update`, for an id it never
 * saw, with no title, input or status. Two things keep the transcript as it
 * was before the capability:
 *
 * - the connection routes the child's frames to whoever hears the parent
 *   ({@link AcpConnection.aliasSession}), registered here on `subagent_spawned`;
 * - {@link SubagentFrames} writes the missing `Agent` start (and its end)
 *   into the turn's stream, ahead of the first frame that needs it.
 */

import type { SessionNotification } from '@agentclientprotocol/sdk'
import type {
  SessionActivityChange,
  SessionActivityReporter,
  SessionActivityTerminalState
} from '../../../../shared/sessionActivity'
import { createLogger } from '../../../logger/logger'
import type { AcpConnection } from './types'

const logger = createLogger('acp-activity')

/** The AIR capabilities this client can honour. */
export type AirCapability = 'asyncTasks' | 'nativeSubagentSessions'

/**
 * `clientCapabilities._meta` for the AIR extension. Both adapters read
 * `jetbrains.air`, check `version >= 1` and look for each capability by name.
 */
export function airClientMeta(capabilities: readonly AirCapability[]): { jetbrains: { air: { version: 1; capabilities: AirCapability[] } } } {
  return { jetbrains: { air: { version: 1, capabilities: [...capabilities] } } }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function updateOf(notification: SessionNotification): Record<string, unknown> {
  return record(notification?.update) ?? {}
}

/** What the translation remembers about one observed session. */
export interface AcpActivityState {
  /** Async task ids the session announced. */
  tasks: Set<string>
  /** Subagent ids (native child sessions, or Codex threads) the session announced. */
  subagents: Set<string>
  /** Codex subagents whose current run has ended. */
  endedSubagents: Set<string>
  /** Codex subagent → its run number, when it ran more than once. */
  subagentRuns: Map<string, number>
}

export function createAcpActivityState(): AcpActivityState {
  return { tasks: new Set(), subagents: new Set(), endedSubagents: new Set(), subagentRuns: new Map() }
}

/**
 * The item id of a Codex subagent's current run: the thread id, then
 * `<thread>#2`, `#3`… for each run after an ended one. The hub never moves an
 * ended item back to running (C5), so a new run is a new item.
 */
function subagentRun(state: AcpActivityState, threadId: string): string {
  const run = state.subagentRuns.get(threadId)
  return run === undefined ? threadId : `${threadId}#${run}`
}

/** An async task's state, in the hub's words; `null` while it still runs. */
function taskState(state: string | undefined): SessionActivityTerminalState | null {
  switch (state) {
    case 'running':
    case 'stopping':
      return null
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'stopped':
    case 'killed':
    case 'cancelled':
      return 'stopped'
    default:
      logger.warn('an async task reported a state this build does not know; shown as lost', { state })
      return 'lost'
  }
}

/** A native subagent's state (Claude and Codex share the vocabulary). */
function subagentState(state: string | undefined): SessionActivityTerminalState | null {
  switch (state) {
    case 'running':
      return null
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'stopped'
    case 'disconnected':
      return 'lost'
    default:
      logger.warn('a subagent reported a state this build does not know; shown as lost', { state })
      return 'lost'
  }
}

/** A Codex collaboration agent's status (`terminalStateOf` in codex-acp). */
function codexAgentState(status: string | undefined): SessionActivityTerminalState | null | undefined {
  switch (status) {
    case 'pendingInit':
    case 'running':
      return null
    case 'completed':
      return 'completed'
    case 'interrupted':
      return 'stopped'
    case 'errored':
    case 'shutdown':
    case 'notFound':
      return 'failed'
    default:
      return undefined
  }
}

function isRootAgentPath(path: string): boolean {
  const trimmed = path.replace(/\/+$/, '')
  return trimmed === '/root' || trimmed === 'root' || trimmed === ''
}

/**
 * One notification's activity changes. Item ids are `owner:wireId`, so two
 * sessions of one chat never collide. Pure apart from `state`.
 */
export function translateActivity(
  notification: SessionNotification,
  state: AcpActivityState,
  owner: string
): SessionActivityChange[] {
  const update = updateOf(notification)
  const id = (wire: string): string => `${owner}:${wire}`
  switch (update.sessionUpdate) {
    case 'async_task_spawned': {
      const taskId = str(update.asyncTaskId)
      if (!taskId) return []
      state.tasks.add(taskId)
      const description = str(update.description) ?? null
      const title = str(update.name) ?? description ?? taskId
      return [{
        type: 'upsert',
        id: id(taskId),
        kind: 'background',
        title,
        // Claude repeats the name as the description; saying it twice says nothing.
        detail: description === title ? null : description,
        outputPath: str(update.outputFilePath) ?? null,
        canStop: update.canStop === true
      }]
    }
    case 'async_task_progress': {
      const taskId = str(update.asyncTaskId)
      if (!taskId || !state.tasks.has(taskId)) return []
      return [{
        type: 'upsert',
        id: id(taskId),
        kind: 'background',
        detail: str(update.summary) ?? null,
        outputPath: str(update.outputFilePath) ?? null
      }]
    }
    case 'async_task_state_update': {
      const taskId = str(update.asyncTaskId)
      if (!taskId || !state.tasks.has(taskId)) return []
      const ended = taskState(str(update.state))
      const summary = str(update.summary) ?? null
      const outputPath = str(update.outputFilePath) ?? null
      if (ended === null) {
        return [{ type: 'upsert', id: id(taskId), kind: 'background', detail: summary, outputPath }]
      }
      const changes: SessionActivityChange[] = []
      if (outputPath) changes.push({ type: 'upsert', id: id(taskId), kind: 'background', outputPath })
      changes.push({ type: 'end', id: id(taskId), state: ended, ...(summary ? { summary } : {}) })
      return changes
    }
    case 'subagent_spawned': {
      const childId = str(update.subagentSessionId)
      if (!childId) return []
      state.subagents.add(childId)
      return [{
        type: 'upsert',
        id: id(childId),
        kind: 'subagent',
        title: str(update.name) ?? 'Subagent',
        detail: str(update.task) ?? null
      }]
    }
    case 'subagent_state_update': {
      const childId = str(update.subagentSessionId)
      if (!childId || !state.subagents.has(childId)) return []
      const ended = subagentState(str(update.state))
      return ended === null ? [] : [{ type: 'end', id: id(childId), state: ended }]
    }
    case 'tool_call':
    case 'tool_call_update':
      return codexSubagents(update, state, id)
    default:
      return []
  }
}

/** Codex subagents, from the root session's tool calls (no native sessions advertised). */
function codexSubagents(
  update: Record<string, unknown>,
  state: AcpActivityState,
  id: (wire: string) => string
): SessionActivityChange[] {
  const codex = record(record(update._meta)?.codex)
  if (!codex) return []
  const changes: SessionActivityChange[] = []

  const activity = record(codex.subagent)
  if (activity) {
    const threadId = str(activity.threadId)
    const path = str(activity.path) ?? ''
    if (!threadId || isRootAgentPath(path)) return []
    const name = path.split('/').filter(Boolean).at(-1) ?? 'Subagent'
    switch (activity.activity) {
      case 'started':
      case 'interacted':
        // A message to a subagent whose run ended starts a new run.
        if (state.endedSubagents.delete(threadId)) {
          state.subagentRuns.set(threadId, (state.subagentRuns.get(threadId) ?? 1) + 1)
        }
        state.subagents.add(threadId)
        changes.push({ type: 'upsert', id: id(subagentRun(state, threadId)), kind: 'subagent', title: name })
        break
      case 'completed':
        if (state.subagents.has(threadId)) changes.push(endSubagent(state, threadId, 'completed', id))
        break
      case 'interrupted':
        if (state.subagents.has(threadId)) changes.push(endSubagent(state, threadId, 'stopped', id))
        break
    }
    return changes
  }

  // Derived from codex-acp's code (`createCollabAgentToolCallUpdate`), not
  // watched: a `spawnAgent` call names its children, and every collaboration
  // call carries the states of the agents it touched.
  const collaboration = record(codex.collaboration)
  if (!collaboration) return []
  const input = record(update.rawInput) ?? {}
  if (collaboration.tool === 'spawnAgent' && update.status !== 'failed') {
    const receivers = Array.isArray(collaboration.receiverThreadIds) ? collaboration.receiverThreadIds : []
    for (const receiver of receivers) {
      const threadId = str(receiver)
      if (!threadId || state.subagents.has(threadId)) continue
      state.subagents.add(threadId)
      changes.push({ type: 'upsert', id: id(threadId), kind: 'subagent', title: 'Subagent', detail: str(input.prompt) ?? null })
    }
  }
  const states = record(input.agentsStates) ?? {}
  for (const [threadId, agent] of Object.entries(states)) {
    if (!state.subagents.has(threadId)) continue
    const ended = codexAgentState(str(record(agent)?.status))
    if (ended) changes.push(endSubagent(state, threadId, ended, id))
  }
  return changes
}

/** The end of a Codex subagent's current run. */
function endSubagent(
  state: AcpActivityState,
  threadId: string,
  ended: SessionActivityTerminalState,
  id: (wire: string) => string
): SessionActivityChange {
  state.endedSubagents.add(threadId)
  return { type: 'end', id: id(subagentRun(state, threadId)), state: ended }
}

/** The child session a `subagent_spawned` announces, if this is one. */
export function spawnedSubagent(notification: SessionNotification): { sessionId: string; name?: string; task?: string } | undefined {
  const update = updateOf(notification)
  if (update.sessionUpdate !== 'subagent_spawned') return undefined
  const sessionId = str(update.subagentSessionId)
  if (!sessionId) return undefined
  return { sessionId, name: str(update.name), task: str(update.task) }
}

/** The subagent a terminal `subagent_state_update` ends, if this is one. */
function endedSubagent(notification: SessionNotification): string | undefined {
  const update = updateOf(notification)
  if (update.sessionUpdate !== 'subagent_state_update') return undefined
  // Every state but `running` ends it, as in `subagentState`.
  if (str(update.state) === 'running') return undefined
  return str(update.subagentSessionId)
}

/* ------------------------------------------------------- per session feed */

/** Whose session this is. */
export interface ActivityScope {
  chatId: string
  agentId: string
}

/**
 * One session's activity: the translation state, the child sessions it
 * aliased, and what it knows about each subagent it spawned.
 */
export interface SessionActivity {
  readonly sessionId: string
  /**
   * Report the notification's changes, once per notification object: the
   * same frame can reach both the between-turn listener and, replayed, the
   * turn that took it.
   */
  observe(notification: SessionNotification): void
  /** What `subagent_spawned` said about a child session. */
  subagent(childSessionId: string): { name?: string; task?: string } | undefined
  /** What {@link SubagentFrames} knows about this session's Agent calls, across its turns. */
  readonly agentCalls: AgentCallMemory
  /** Drop the aliases. The hub items stay; they end on their own messages or with the process. */
  close(): void
}

/**
 * A session's Agent calls, kept per session rather than per turn: a subagent
 * can outlive the turn that started it (a Stop returns the prompt while it
 * runs on), and the next turn must not announce its call again.
 */
export interface AgentCallMemory {
  /** Agent call ids a turn announced or synthesized. */
  readonly announced: Set<string>
  /** Child session id → the Agent call it runs under. */
  readonly callOfChild: Map<string, string>
}

function createAgentCallMemory(): AgentCallMemory {
  return { announced: new Set(), callOfChild: new Map() }
}

/**
 * How long a subagent's route and what `subagent_spawned` said about it are
 * kept after its terminal state: long enough for the parent's hook update
 * that follows it (Q3: 2 ms later) and a corrected state (C5).
 */
export const ACP_SUBAGENT_FORGET_MS = 30_000

/** An opaque handle for whatever `setTimer` returned. */
export type ActivityTimerHandle = unknown

export interface SessionActivityRegistryOptions {
  /** Schedules the forgetting of an ended subagent. Production uses `setTimeout`. */
  setTimer?: (fn: () => void, ms: number) => ActivityTimerHandle
  clearTimer?: (handle: ActivityTimerHandle) => void
  /** Overrides {@link ACP_SUBAGENT_FORGET_MS}. Tests only. */
  subagentForgetMs?: number
}

/**
 * The sessions of every connection a driver talks to, and their children.
 * Owned by the driver; the reporter is the hub's port.
 */
export interface SessionActivityRegistry {
  /** The session's feed, created on first use; a later scope replaces the earlier one. */
  session(connection: AcpConnection, sessionId: string, scope: ActivityScope): SessionActivity
  /** The feed that owns this session id — its own, or its parent's for a child. */
  lookup(connection: AcpConnection, sessionId: string): SessionActivity | undefined
  /** Close the chat's sessions (only the agent's, if named). */
  forgetChat(chatId: string, agentId?: string): void
  /**
   * Where a background task item of the chat's agent lives, for Stop: any
   * open session of the chat, not only the latest turn's.
   */
  asyncTask(chatId: string, agentId: string, itemId: string): AsyncTaskTarget | undefined
}

/** One background task on the wire. */
export interface AsyncTaskTarget {
  connection: AcpConnection
  sessionId: string
  asyncTaskId: string
}

interface Entry {
  activity: SessionActivity
  scope: ActivityScope
  connection: AcpConnection
  tasks: ReadonlySet<string>
  sessions: Map<string, Entry>
  children: Map<string, Entry>
}

export function createSessionActivityRegistry(
  reporter?: SessionActivityReporter,
  options: SessionActivityRegistryOptions = {}
): SessionActivityRegistry {
  const setTimer = options.setTimer ?? ((fn, ms) => {
    const timer = setTimeout(fn, ms)
    // Forgetting must never be the reason the app stays awake.
    timer.unref?.()
    return timer
  })
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const forgetMs = options.subagentForgetMs ?? ACP_SUBAGENT_FORGET_MS

  /** Per connection: session id → entry, and child session id → the parent's entry. */
  const byConnection = new WeakMap<AcpConnection, { sessions: Map<string, Entry>; children: Map<string, Entry> }>()
  const entries = new Set<Entry>()

  const tables = (connection: AcpConnection): { sessions: Map<string, Entry>; children: Map<string, Entry> } => {
    let found = byConnection.get(connection)
    if (!found) {
      const created = { sessions: new Map<string, Entry>(), children: new Map<string, Entry>() }
      found = created
      byConnection.set(connection, created)
      // The connection clears its own aliases when it closes.
      void connection.exited.then(() => {
        for (const entry of [...created.sessions.values()]) entry.activity.close()
      })
    }
    return found
  }

  const create = (connection: AcpConnection, sessionId: string, scope: ActivityScope): Entry => {
    const { sessions, children } = tables(connection)
    const state = createAcpActivityState()
    const seen = new WeakSet<SessionNotification>()
    const spawned = new Map<string, { name?: string; task?: string }>()
    const unalias = new Map<string, () => void>()
    const agentCalls = createAgentCallMemory()
    const forgetTimers = new Map<string, ActivityTimerHandle>()
    let closed = false
    const dropRoute = (childId: string): void => {
      unalias.get(childId)?.()
      unalias.delete(childId)
      if (children.get(childId) === entry) children.delete(childId)
    }
    /**
     * An ended subagent's route, spawn info and call link, a grace period
     * after its end. The announced call id stays: a late hook must not
     * announce the call again.
     */
    const scheduleForget = (childId: string): void => {
      if (forgetTimers.has(childId)) return
      forgetTimers.set(childId, setTimer(() => {
        forgetTimers.delete(childId)
        if (closed) return
        dropRoute(childId)
        spawned.delete(childId)
        state.subagents.delete(childId)
        agentCalls.callOfChild.delete(childId)
      }, forgetMs))
    }
    const entry: Entry = {
      scope,
      connection,
      tasks: state.tasks,
      sessions,
      children,
      activity: {
        sessionId,
        observe: (notification) => {
          if (closed || seen.has(notification)) return
          seen.add(notification)
          const child = spawnedSubagent(notification)
          if (child && child.sessionId !== sessionId) {
            spawned.set(child.sessionId, { name: child.name, task: child.task })
            const pending = forgetTimers.get(child.sessionId)
            if (pending !== undefined) {
              clearTimer(pending)
              forgetTimers.delete(child.sessionId)
            }
            if (!unalias.has(child.sessionId)) {
              children.set(child.sessionId, entry)
              try {
                unalias.set(child.sessionId, connection.aliasSession(child.sessionId, sessionId))
              } catch (err) {
                logger.warn('a subagent session could not be routed to its parent', { sessionId, error: String(err) })
              }
            }
          }
          let changes: SessionActivityChange[]
          try {
            changes = translateActivity(notification, state, sessionId)
          } catch (err) {
            logger.warn('an activity update could not be read', { sessionId, error: String(err) })
            return
          }
          const ended = endedSubagent(notification)
          if (ended && spawned.has(ended)) scheduleForget(ended)
          if (!reporter) return
          for (const change of changes) {
            try {
              reporter.report(entry.scope.chatId, entry.scope.agentId, change)
            } catch (err) {
              logger.warn('the activity reporter failed', { sessionId, error: String(err) })
            }
          }
        },
        subagent: (childSessionId) => spawned.get(childSessionId),
        agentCalls,
        close: () => {
          if (closed) return
          closed = true
          for (const timer of forgetTimers.values()) clearTimer(timer)
          forgetTimers.clear()
          for (const childId of [...unalias.keys()]) dropRoute(childId)
          if (sessions.get(sessionId) === entry) sessions.delete(sessionId)
          entries.delete(entry)
        }
      }
    }
    sessions.set(sessionId, entry)
    entries.add(entry)
    return entry
  }

  return {
    session: (connection, sessionId, scope) => {
      const existing = tables(connection).sessions.get(sessionId)
      if (existing) {
        existing.scope = scope
        return existing.activity
      }
      return create(connection, sessionId, scope).activity
    },
    lookup: (connection, sessionId) => {
      const found = byConnection.get(connection)
      return (found?.sessions.get(sessionId) ?? found?.children.get(sessionId))?.activity
    },
    forgetChat: (chatId, agentId) => {
      for (const entry of [...entries]) {
        if (entry.scope.chatId !== chatId) continue
        if (agentId !== undefined && entry.scope.agentId !== agentId) continue
        entry.activity.close()
      }
    },
    asyncTask: (chatId, agentId, itemId) => {
      for (const entry of entries) {
        if (entry.scope.chatId !== chatId || entry.scope.agentId !== agentId) continue
        const sessionId = entry.activity.sessionId
        if (!itemId.startsWith(`${sessionId}:`)) continue
        const asyncTaskId = itemId.slice(sessionId.length + 1)
        if (entry.tasks.has(asyncTaskId)) return { connection: entry.connection, sessionId, asyncTaskId }
      }
      return undefined
    }
  }
}

/* ---------------------------------------------------- the Agent tool call */

const SUBAGENT_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task'])

function claudeMeta(update: Record<string, unknown>): Record<string, unknown> | undefined {
  return record(record(update._meta)?.claudeCode)
}

/**
 * The `Agent` tool call a Claude parent session no longer receives, written
 * back into one turn's stream.
 *
 * Before `nativeSubagentSessions` the parent got `tool_call` Agent
 * {title: description, kind: think, rawInput {description, prompt, …},
 * content [prompt]}, then the child's frames (each with
 * `_meta.claudeCode.parentToolUseId`), then the PostToolUse update, then a
 * completed update with the subagent's report. With it on, only the PostToolUse
 * update reaches the parent — after the child's frames for a synchronous
 * subagent. So:
 *
 * - the first frame that names an Agent call nobody announced (a child frame's
 *   `parentToolUseId`, or the parent's update) is preceded by a synthesized
 *   `tool_call`, from what `subagent_spawned` said (name → description, task →
 *   prompt);
 * - the PostToolUse update of a synthesized call is followed by its end:
 *   `completed` with the report for a finished subagent, `completed` without
 *   one for a background launch (the launch text is the CLI's and not on the
 *   wire);
 * - a subagent that ends with its call still open closes it: `completed`, or
 *   `failed` with a line saying how it ended. The adapter drops the call's
 *   own failed update once a child exists, and the hook never runs for a
 *   failed tool, so this is the only end such a call gets;
 * - a subagent that ends before any Agent call was linked to it (its first
 *   request failed, so it sent nothing) gets a start and that end under
 *   `subagent:<child session id>`. Not for `completed`: a synchronous
 *   subagent's hook update follows its end and names the real call.
 *
 * A call the agent did announce is passed through untouched. One per turn:
 * the stream it feeds is. Which Agent calls exist, and which child runs
 * under which, is the session's ({@link AgentCallMemory}), so a later turn
 * never announces a call again.
 */
export class SubagentFrames {
  /** Every call id this turn saw start. */
  private readonly announced = new Set<string>()
  private readonly synthesized = new Set<string>()
  private readonly open = new Set<string>()
  /** For frames no session feed claims. */
  private readonly unowned = createAgentCallMemory()

  constructor(private readonly activityOf: (sessionId: string) => SessionActivity | undefined) {}

  /** The frames the stream should fold for this one, in order. */
  expand(notification: SessionNotification): SessionNotification[] {
    try {
      return this.expandUnsafe(notification)
    } catch {
      return [notification]
    }
  }

  private memory(sessionId: string): AgentCallMemory {
    return this.activityOf(sessionId)?.agentCalls ?? this.unowned
  }

  private isAnnounced(toolCallId: string, memory: AgentCallMemory): boolean {
    return this.announced.has(toolCallId) || memory.announced.has(toolCallId)
  }

  private expandUnsafe(notification: SessionNotification): SessionNotification[] {
    const update = updateOf(notification)
    const kind = update.sessionUpdate
    const meta = claudeMeta(update)
    const toolCallId = str(update.toolCallId)
    const memory = this.memory(notification.sessionId)
    const out: SessionNotification[] = []

    if (kind === 'subagent_state_update') {
      const child = str(update.subagentSessionId)
      const wire = str(update.state)
      if (!child || wire === 'running') return [notification]
      const ending = subagentEnding(wire)
      const call = memory.callOfChild.get(child)
      if (call) {
        if (this.open.has(call)) out.push(this.end(notification, call, ending.status, undefined, ending.note))
      } else if (ending.status === 'failed') {
        const activity = this.activityOf(notification.sessionId)
        const info = activity?.subagent(child)
        if (activity && info) {
          const placeholder = `subagent:${child}`
          memory.callOfChild.set(child, placeholder)
          if (!this.isAnnounced(placeholder, memory)) {
            out.push(this.start(notification, placeholder, info))
            out.push(this.end(notification, placeholder, ending.status, undefined, ending.note))
          }
        }
      }
      return [notification, ...out]
    }

    // A frame of a child session, under its parent's Agent call.
    const parentCall = str(meta?.parentToolUseId)
    if (parentCall && !this.isAnnounced(parentCall, memory)) {
      const activity = this.activityOf(notification.sessionId)
      const info = activity && activity.sessionId !== notification.sessionId ? activity.subagent(notification.sessionId) : undefined
      if (activity && info) {
        activity.agentCalls.callOfChild.set(notification.sessionId, parentCall)
        out.push(this.start({ ...notification, sessionId: activity.sessionId }, parentCall, info))
      }
    }

    if ((kind === 'tool_call' || kind === 'tool_call_update') && toolCallId) {
      const isSubagentTool = SUBAGENT_TOOLS.has(str(meta?.toolName) ?? '')
      if (kind === 'tool_call') {
        this.announced.add(toolCallId)
        if (isSubagentTool) memory.announced.add(toolCallId)
      } else if (isSubagentTool && !this.isAnnounced(toolCallId, memory)) {
        const response = record(meta?.toolResponse)
        const child = str(response?.agentId)
        const info = (child ? this.activityOf(notification.sessionId)?.subagent(child) : undefined) ?? {
          name: str(response?.description),
          task: str(response?.prompt)
        }
        if (child) memory.callOfChild.set(child, toolCallId)
        out.push(this.start(notification, toolCallId, info))
      }
      out.push(notification)
      if (kind === 'tool_call_update' && isSubagentTool && this.synthesized.has(toolCallId)) {
        const response = record(meta?.toolResponse)
        if (response) {
          const status = str(response.status)
          if (status === 'completed' || status === 'async_launched') {
            out.push(this.end(notification, toolCallId, 'completed', status === 'completed' ? response.content : undefined))
          }
        }
      }
      if (update.status === 'completed' || update.status === 'failed') this.open.delete(toolCallId)
      return out
    }

    out.push(notification)
    return out
  }

  private start(from: SessionNotification, toolCallId: string, info: { name?: string; task?: string }): SessionNotification {
    this.announced.add(toolCallId)
    this.memory(from.sessionId).announced.add(toolCallId)
    this.synthesized.add(toolCallId)
    this.open.add(toolCallId)
    const rawInput: Record<string, unknown> = {}
    if (info.name) rawInput.description = info.name
    if (info.task) rawInput.prompt = info.task
    return {
      sessionId: from.sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId,
        title: info.name ?? 'Task',
        kind: 'think',
        status: 'pending',
        rawInput,
        content: info.task ? [{ type: 'content', content: { type: 'text', text: info.task } }] : [],
        _meta: { claudeCode: { toolName: 'Agent' } }
      }
    } as SessionNotification
  }

  private end(
    from: SessionNotification,
    toolCallId: string,
    status: 'completed' | 'failed',
    report?: unknown,
    note?: string
  ): SessionNotification {
    this.open.delete(toolCallId)
    const blocks = Array.isArray(report)
      ? report.flatMap((block) => {
          const text = str(record(block)?.text)
          return text ? [{ type: 'content', content: { type: 'text', text } }] : []
        })
      : []
    if (note) blocks.push({ type: 'content', content: { type: 'text', text: note } })
    const activity = this.activityOf(from.sessionId)
    return {
      sessionId: activity?.sessionId ?? from.sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status,
        ...(blocks.length > 0 ? { content: blocks } : {}),
        _meta: { claudeCode: { toolName: 'Agent' } }
      }
    } as SessionNotification
  }
}

/** How a subagent's terminal state closes its Agent call. */
function subagentEnding(state: string | undefined): { status: 'completed' | 'failed'; note?: string } {
  switch (state) {
    case 'completed':
      return { status: 'completed' }
    case 'failed':
      return { status: 'failed', note: 'Subagent failed.' }
    case 'cancelled':
      return { status: 'failed', note: 'Subagent stopped.' }
    default:
      // `disconnected`, and a state this build does not know (shown as lost).
      return { status: 'failed', note: 'Subagent disconnected.' }
  }
}
