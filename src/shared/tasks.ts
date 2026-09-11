/**
 * The Task — the unit of work that outlives a chat view.
 *
 * A task is a goal with a status, an assignee, a handoff note and artifacts. It
 * is stored in the desktop's SQLite **always**; a linked profile may carry it
 * further two independent ways:
 *
 *  - through the existing end-to-end-encrypted app-sync, to the user's other
 *    devices (a `task` collection — no server change; the server reads
 *    ciphertext);
 *  - as a record in a remote system, through a `RemoteTaskAdapter`
 *    (`src/main/tasks/adapters/`), when the task is meant to be seen or worked
 *    somewhere else.
 *
 * The DTO is shaped field-for-field like cinna-core's `InputTaskPublicExtended`
 * where the concepts coincide, plus the desktop's own three (`router`,
 * `executor`, `chatId`). That is deliberate: it is the shape with a server, a
 * web UI and a superset of the fields, so one component renders a local task, a
 * replica of a remote one, and — later — a managed agent's task.
 *
 * **Nothing here names a particular remote system.** `remote.adapter` is an
 * opaque id and `assignee.kind` says `remote_agent`, not the vendor. The one
 * place a vendor is named is its own file under `src/main/tasks/adapters/`.
 *
 * Pure type-only module plus constants: imported from main, preload and the
 * renderer alike.
 */
import { CHAT_ROUTERS, DEFAULT_CHAT_ROUTER, type ChatRouter } from './chatRouting'
import type { TaskStatus } from './taskStatus'

/**
 * Task priority, matching cinna-core's set (`input_task.py:128`). The jobs UI
 * already offers exactly these four for a cinna task; this is where the
 * vocabulary belongs now that a task is a first-class thing.
 */
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent'

/** Every priority, lowest first. The order *is* semantic — it sorts. */
export const TASK_PRIORITIES: readonly TaskPriority[] = ['low', 'normal', 'high', 'urgent']

export const DEFAULT_TASK_PRIORITY: TaskPriority = 'normal'

export function isTaskPriority(value: unknown): value is TaskPriority {
  return (TASK_PRIORITIES as readonly unknown[]).includes(value)
}

/** A priority off the wire. An unknown value is `normal`, never a throw. */
export function parseTaskPriority(raw: string | null | undefined): TaskPriority {
  return isTaskPriority(raw) ? raw : DEFAULT_TASK_PRIORITY
}

/**
 * A value off the wire, narrowed to a known member of a union, or the fallback.
 *
 * The four unions below all cross app-sync, where the sender may be a peer
 * running a newer build. A value this build has never heard of must render as
 * *something* rather than reach a `switch` that has no case for it.
 */
function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T
): T {
  return (allowed as readonly unknown[]).includes(value) ? (value as T) : fallback
}

/**
 * Where the task came from. **Provenance, and it never changes.**
 *
 *  - `local` — created here (by a user, or by a job run).
 *  - `remote` — pulled in from a bound remote system: a task someone created on
 *    the web, an agent-initiated inbox task, a delegated subtask.
 *
 * The same split the plan already made for agents: `agents.source` says who
 * owns the row, `agents.driver` says how it runs. Here {@link TaskOrigin} says
 * where it came from and {@link TaskExecutor} says who is running it.
 */
export type TaskOrigin = 'local' | 'remote'

export const TASK_ORIGINS: readonly TaskOrigin[] = ['local', 'remote']

export function parseTaskOrigin(raw: unknown): TaskOrigin {
  return oneOf(raw, TASK_ORIGINS, 'local')
}

/**
 * Who is running the task **now**, and the field authority that follows from
 * it. Unlike {@link TaskOrigin} this moves: flipping it is how work changes
 * hands, in either direction.
 *
 *  - `desktop` — a driver on some device of the user's is running it. The
 *    desktop writes `status`, `assignee` and `handoffNote`, and pushes them
 *    through the adapter when the task is bound.
 *  - `remote` — the bound system is running it. It writes those fields; the
 *    desktop pulls them and never pushes them.
 *
 * `title`, `description` and `priority` are writable from either side whatever
 * the executor is, reconciled per field on `updatedAt`.
 */
export type TaskExecutor = 'desktop' | 'remote'

export const TASK_EXECUTORS: readonly TaskExecutor[] = ['desktop', 'remote']

export function parseTaskExecutor(raw: unknown): TaskExecutor {
  return oneOf(raw, TASK_EXECUTORS, 'desktop')
}

/**
 * How the task's chat decides who answers — the same routers a chat has, plus
 * `script`, which phase 6 adds and nothing in this phase writes.
 */
export type TaskRouter = ChatRouter | 'script'

export const TASK_ROUTERS: readonly TaskRouter[] = [...CHAT_ROUTERS, 'script']

/**
 * An unknown router falls back to `direct` — one counterparty, the safest of
 * the four, and the one `DEFAULT_CHAT_ROUTER` already names for the same reason.
 */
export function parseTaskRouter(raw: unknown): TaskRouter {
  return oneOf(raw, TASK_ROUTERS, DEFAULT_CHAT_ROUTER)
}

/**
 * Who the task is assigned to.
 *
 *  - `agent` — an agent on this device; `agentId` is its `agents` row id.
 *  - `model` — the local LLM, or nobody in particular. `agentId` is null.
 *  - `remote_agent` — an agent that exists only in the bound remote system.
 *    `agentId` is null here; the binding's own state holds the remote id.
 *
 * `agentId` is device-local and therefore never syncs; a portable descriptor
 * (the `kind: 'agent'` arm of `JobDepDescriptor`, `shared/sync.ts`) travels in
 * its place and is resolved on arrival, exactly as a job's agent already is.
 */
export interface TaskAssignee {
  agentId: string | null
  /** Display name. A hint, not an identity — it may be stale or absent. */
  name: string | null
  kind: TaskAssigneeKind
}

export type TaskAssigneeKind = 'agent' | 'model' | 'remote_agent'

export const TASK_ASSIGNEE_KINDS: readonly TaskAssigneeKind[] = ['agent', 'model', 'remote_agent']

export function parseTaskAssigneeKind(raw: unknown): TaskAssigneeKind {
  return oneOf(raw, TASK_ASSIGNEE_KINDS, 'model')
}

/**
 * Something the task produced, or something it needs, that lives outside the
 * transcript.
 *
 *  - `file` — a path under the app's storage, or an uploaded attachment on the
 *    bound remote. The handoff note export (§5.11) is one of these.
 *  - `link` — a URL. A PR, a deploy, a document.
 *
 * `ref` is interpreted by `kind` and by nothing else; it is a path for a file
 * and a URL for a link.
 */
export interface TaskArtifact {
  kind: 'file' | 'link'
  name: string
  ref: string
}

/**
 * The ceiling on an autonomous run of this task. Stored from this phase so a
 * task carries it across sync and handover; **read** by the headless task
 * runner in phase 6. Nothing enforces it yet, which is why every field is
 * optional — a budget nobody set must be expressible.
 */
export interface TaskBudget {
  maxRounds?: number
  maxMinutes?: number
  maxTokens?: number
}

/**
 * The task's binding to a remote system, as the renderer sees it.
 *
 * Deliberately **not** the full `RemoteBinding` the adapters pass around: the
 * opaque `state` never crosses to the renderer, because nothing outside
 * `src/main/tasks/adapters/` may read it.
 */
export interface TaskRemoteRef {
  /** The adapter's id. Opaque — a caller asks the adapter for capabilities, never branches on this. */
  adapter: string
  /** The remote's id for this task. */
  id: string
  /** The remote's human-facing key: a short code, `ENG-421`, `#1234`. Display only. */
  key: string | null
  /** Deep link into the remote system, built by the adapter. */
  url: string | null
}

/** One task, as every surface sees it. */
export interface TaskDto {
  id: string
  title: string
  /** The original ask, immutable once created (cinna's `original_message`). */
  goal: string
  /** The working description, edited as the task is understood. Null until someone edits it. */
  description: string | null
  status: TaskStatus
  priority: TaskPriority
  router: TaskRouter

  origin: TaskOrigin
  executor: TaskExecutor
  /**
   * The sync device id running this task while `executor === 'desktop'`; null
   * means *this* device (and is also what a profile with sync off always has).
   *
   * This is the claim that keeps two devices from both believing they own a
   * run. A peer showing a task whose `executorDevice` is not itself renders it
   * read-only with a Take over action — and taking over is a write that syncs,
   * so the claim is explicit rather than raced.
   */
  executorDevice: string | null

  /** The chat this task runs in, on this device. Never syncs — chats are not a synced collection. */
  chatId: string | null
  assignee: TaskAssignee
  parentTaskId: string | null
  /** cinna's computed pair, mirrored: how many subtasks, how many of them are done. */
  subtaskCount: number
  subtaskCompletedCount: number

  /** Null for a desktop-only task. */
  remote: TaskRemoteRef | null

  /** Markdown, rewritten at each handoff. Exported to a file so a folder agent can read it. */
  handoffNote: string | null
  artifacts: TaskArtifact[]
  budget: TaskBudget | null
  errorMessage: string | null

  /** Which job run created this task, when one did. Provenance only — the rows may be gone. */
  jobId: string | null
  jobRunId: string | null

  createdAt: Date
  updatedAt: Date
  startedAt: Date | null
  finishedAt: Date | null
}

/**
 * What a surface may ask a task list for.
 *
 * The renderer-facing subset of the repo's own filter: no `remoteAdapter` arm,
 * because which service a task is bound to is a question only the adapters and
 * `taskSyncService` ask, and nothing outside `src/main/tasks/adapters/` may
 * branch on the answer.
 */
export interface TaskListQuery {
  /** Only these statuses. Omitted = every status the other filters allow. */
  statuses?: readonly TaskStatus[]
  executor?: TaskExecutor
  /** Children of this task. Mutually exclusive with `rootOnly`. */
  parentTaskId?: string
  /** Only tasks with no parent. */
  rootOnly?: boolean
  /** Archived tasks are excluded unless asked for — they are the filed-away pile. */
  includeArchived?: boolean
}

/**
 * Where an entry in the inbox stands.
 *
 *  - `open` — waiting for a human. This is what the badge counts.
 *  - `answered` — a resolution was posted back to the driver.
 *  - `rejected` — the user declined (a permission denied, a question dismissed).
 *  - `expired` — the address died before anyone answered: the app restarted,
 *    or the driver process was reaped. Never an error; the row says so and the
 *    task offers a re-run.
 */
export type TaskInputRequestStatus = 'open' | 'answered' | 'rejected' | 'expired'

/**
 * Is this device the one running the task?
 *
 * The rule lives here because two surfaces need the same answer and would
 * otherwise each re-derive it: the renderer, to decide whether to show controls
 * or a read-only "running on <device>" with a Take over action, and the main
 * process, to refuse a write that belongs to another device.
 *
 * Two nulls, and they mean different things:
 *
 *  - A null `executorDevice` means the task was claimed by a device that had no
 *    sync identity — so nobody in particular holds it, which is correct: there
 *    is no other device that could disagree.
 *  - A null `thisDeviceId` means **this** device has no sync identity, and it
 *    therefore owns every desktop-executed task it can see. Sync being off is
 *    the obvious case; the one that bites is `syncService.disconnect`, which
 *    keeps the `sync_state` row and nulls its `deviceId`, and reconnecting
 *    enrols a *new* id. Without this arm, turning sync off would lock the only
 *    device there is out of every task it had already claimed — a run would
 *    never be able to report that it finished.
 *
 * It is a claim, not a lock — taking over is an explicit write that syncs, so
 * two devices cannot both believe they own a run without one of them saying so.
 */
export function taskRunsHere(
  task: Pick<TaskDto, 'executor' | 'executorDevice'>,
  thisDeviceId: string | null
): boolean {
  if (task.executor !== 'desktop') return false
  if (thisDeviceId === null) return true
  return task.executorDevice === null || task.executorDevice === thisDeviceId
}
