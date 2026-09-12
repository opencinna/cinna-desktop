/**
 * The remote-task seam: everything system-specific about a task that also
 * lives somewhere else, behind one interface.
 *
 * SQLite is always the store. A task may additionally be **bound** to a remote
 * system — cinna-core today, Linear or GitHub Issues or an A2A task store
 * tomorrow — and the adapter is the only code that knows which system that is.
 * It is the same arrangement `AgentDriver` gives agents (`agents/drivers/`),
 * for the same reason: the next integration should add a file, not a value to
 * five unions.
 *
 * Three rules run through the whole interface, and the contract suite
 * (`adapterContract.test.ts`) exists to hold them:
 *
 * **Callers ask {@link RemoteTaskAdapter.capabilities}, never the id.** An
 * operation the capabilities deny is not a runtime condition to be caught — it
 * is a bug, and calling it throws {@link UnsupportedRemoteOperation}. That is
 * what makes a poorer remote *expressible* rather than broken: Linear can write
 * a status and hold no human-input asks, GitHub Issues has no agent assignee,
 * Claude Managed Agents has asks and no comments, and none of them needs a
 * column or an `if` outside its own file.
 *
 * **Only {@link RemoteTaskAdapter.create} invents a binding.** Every other call
 * takes one and returns it — possibly refreshed, never re-identified. A method
 * that could mint a second binding for a task is a method that can silently
 * fork it in two.
 *
 * **The local write already happened.** `taskService` writes SQLite and
 * `taskSyncService` reconciles afterwards, so an adapter failure marks the
 * binding stale and is retried; it never fails or rolls back the local write.
 * That is what makes an unlinked profile, an offline laptop and a 500 the same
 * code path. An adapter therefore *rejects* rather than swallowing — deciding
 * what a failure costs is the caller's job, not the adapter's.
 *
 * Type-only, with one error class. `index.ts` is where an implementation is
 * registered and where production wiring is named; each adapter takes its
 * world by injection so the contract suite can drive it against a fake
 * transport.
 */

import { DomainError } from '../../errors'
import type { InputRequest } from '../../../shared/runEvents'
import type { RequestResolution } from '../../../shared/localAgentRequests'
import type { TaskStatus } from '../../../shared/taskStatus'
import type {
  TaskArtifact,
  TaskAssigneeKind,
  TaskDto,
  TaskPriority
} from '../../../shared/tasks'

/**
 * What went wrong talking to a remote system.
 *
 * - `unsupported` — the capabilities say this adapter cannot do this. A bug at
 *   the call site, never a condition to recover from.
 * - `not_ours` — the remote says the task is not this account's, or is gone.
 *   **Unbind, with a reason, and never retry** — which is why an adapter must
 *   be sure before it answers this.
 *
 *   **An HTTP status is not enough to be sure, and on cinna-core specifically
 *   it is not even close.** `InputTaskError` defaults to `status_code=400`;
 *   `PermissionDeniedError` (a non-owner) is 400, and so is `ValidationError`
 *   — which is what an illegal transition raises ("Cannot transition task from
 *   'x' to 'y'") and what a status outside `allowed_user_statuses` raises. All
 *   three surface through the same handler. So "400 means `not_ours`" would
 *   turn the single most predicted failure in this phase — pushing a status
 *   destination instead of a status path, §5.12 rule 2 — into a **permanent
 *   unbind**: the desktop drops the binding, the remote copy is stranded at the
 *   status it was on, and no retry can ever re-link it. A bug that looked like
 *   a network fault becomes one that looks like a deletion.
 *
 *   An adapter therefore answers `not_ours` only for a 404, or for a 400 it has
 *   positively identified as an ownership refusal. Every other 400 is
 *   `rejected`, and `rejected` **keeps the binding**.
 * - `unavailable` — no profile, no network, a 5xx. Retry on the next pass.
 * - `rejected` — the remote understood and refused: an illegal transition, a
 *   field it will not take, a status it does not accept. Retrying unchanged
 *   will fail the same way, so back off — but the task is still *there*, and
 *   the binding survives.
 * - `invalid_request` — the call itself does not make sense and **the remote was
 *   never asked**: a subtask offered with no parent binding. A call-site bug,
 *   like `unsupported`, but reached with the capability present.
 */
export type RemoteTaskErrorCode =
  | 'unsupported'
  | 'not_ours'
  | 'unavailable'
  | 'rejected'
  | 'invalid_request'

export class RemoteTaskError extends DomainError<RemoteTaskErrorCode> {}

/**
 * A caller reached past `capabilities()`.
 *
 * Deliberately an error rather than a quiet no-op: a silent skip would let a
 * handover that cannot actually happen report success, and the whole point of
 * the capability set is that the caller checked.
 */
export class UnsupportedRemoteOperation extends RemoteTaskError {
  constructor(adapter: string, operation: string) {
    super(
      'unsupported',
      'That service cannot do this.',
      `The \`${adapter}\` adapter does not support \`${operation}\`; its capabilities say so and the caller did not ask.`
    )
  }
}

/** Fields a remote may let the desktop write. Narrower than `TaskPatch` on purpose. */
export type RemoteWritableField = 'title' | 'description' | 'priority' | 'assignee'

/**
 * What `tasks.remote_dirty` holds: the things changed here since the last
 * successful push.
 *
 * The four writable fields, plus the two that have channels of their own —
 * `status` goes through {@link RemoteTaskAdapter.pushStatus} (as a *path*, not
 * a destination) and `handoffNote` through
 * {@link RemoteTaskAdapter.putHandoffNote}. A marker is a statement that this
 * device knows something the remote does not; it is cleared only when the
 * remote has been told, so a laptop that was asleep, offline or unlinked when
 * the change happened still pushes it later.
 *
 * `goal` is deliberately absent: it is immutable once created. So are `router`,
 * `chatId`, `executor` and every other column the desktop owns outright — a
 * remote has no field for them and nothing to be told.
 */
export type RemoteDirtyField = RemoteWritableField | 'status' | 'handoffNote'

export const REMOTE_DIRTY_FIELDS: readonly RemoteDirtyField[] = [
  'title',
  'description',
  'priority',
  'assignee',
  'status',
  'handoffNote'
]

export function isRemoteDirtyField(value: unknown): value is RemoteDirtyField {
  return (REMOTE_DIRTY_FIELDS as readonly unknown[]).includes(value)
}

/** What this adapter can actually do. Callers ask; they never branch on `id`. */
export interface RemoteTaskCapabilities {
  /** Whether the service exposes selectable remote assignees. */
  assigneeDirectory: boolean
  /**
   * Work can be **put** on this remote — {@link RemoteTaskAdapter.create}
   * works, and §5.10's handover has somewhere to go.
   *
   * Not every bound remote can be created into: a shared board the desktop
   * mirrors, or an account whose token is scoped to reads, is bound by a
   * *pull* rather than by a create. Ungated, `create` was the one operation a
   * pull-only adapter had to implement anyway, which made "can I hand work to
   * this service at all" a question with no way to ask it.
   */
  create: boolean
  /** Can a status change be pushed? (cinna: `POST /tasks/{id}/status`.) */
  writeStatus: boolean
  /**
   * The remote can file a task away, through {@link RemoteTaskAdapter.archive}.
   *
   * Separate from `writeStatus` because on cinna-core it is a **different
   * route**: `archived` is not in `allowed_user_statuses`, and
   * `POST /tasks/{id}/archive` is how it is reached. Without a method of its
   * own, "the user filed it away" could only travel by smuggling `archived`
   * through `pushStatus` — which the status clause forbids, correctly, and
   * which would have to be excused by a recorded violation on an adapter that
   * was doing the right thing.
   */
  archive: boolean
  /** Which of the four writable fields a push may carry. */
  writeFields: readonly RemoteWritableField[]
  comments: boolean
  /** The note has somewhere to go: {@link RemoteTaskAdapter.putHandoffNote}. */
  handoffNote: boolean
  /**
   * Which kinds of {@link TaskArtifact} the remote can actually store — the
   * same shape as {@link RemoteTaskCapabilities.writeFields}, and for the same
   * reason: a boolean would say "attachments work" and be wrong half the time.
   *
   * cinna stores **files** and only files: a task attachment is
   * `file_name` / `file_path` / `content_type`, uploaded through
   * `POST /tasks/{id}/files/{file_id}`, and a *link* has no representation
   * there at all. Linear's attachments are the mirror image — a URL with a
   * title. An adapter handed a kind it does not list refuses with
   * {@link UnsupportedRemoteOperation}; posting a link as a comment instead
   * would be a different capability wearing this one's flag.
   *
   * Empty means the remote stores neither, and nothing calls `putArtifact`.
   *
   * **`write` is in the name because there is no read half.** Every other
   * capability here says its direction (`writeStatus`, `writeFields`), and this
   * is the seam's only write-only channel — comments and asks both have a
   * `list*`. A `listArtifacts` is additive when a surface needs one; until then
   * the absence is a statement in the type rather than a gap in a docstring.
   */
  writeArtifactKinds: readonly TaskArtifact['kind'][]
  /**
   * The remote models subtasks: {@link RemoteTaskAdapter.listSubtasks} works,
   * and {@link RemoteTaskAdapter.create} accepts a task that has a parent.
   * With this false, both refuse — a flat remote must not silently lose the
   * parent and create an orphan at top level.
   *
   * It **composes with `create`** rather than implying it: `subtasks` alone
   * says the tree can be read, and `subtasks && create` says a child can be
   * put in it. A pull-only remote with `subtasks: true` is meaningful and
   * means "I can list children I did not make".
   */
  subtasks: boolean
  /** The remote can be asked to execute the task (cinna: `POST /tasks/{id}/execute`). */
  execute: boolean
  /** The remote parks on human input, and this adapter can list and answer those asks. */
  asks: boolean
}

/**
 * The `remote_*` columns, as one value.
 *
 * `state` is **opaque outside the adapter that wrote it** — it is where a
 * remote's own vocabulary lives (cinna keeps the session currently answering
 * there) and nothing else may read it, which is why `TaskDto.remote` carries
 * the other four fields and not this one.
 */
export interface RemoteBinding {
  adapter: string
  /** The remote's id for this task. */
  id: string
  /** The remote's human-facing key: `TASK-12`, `ENG-421`, `#1234`. Display only. */
  key: string | null
  url: string | null
  state: Record<string, unknown>
}

/** Who holds a remote task, in the remote's own terms plus the desktop's kind. */
export interface RemoteAssignee {
  /** The remote's id for whoever holds it — an agent id, a user id, a login. */
  ref: string
  name: string | null
  kind: TaskAssigneeKind
}

/**
 * What a pull brings back, in desktop vocabulary — the adapter does the
 * mapping, and it is the only place that can.
 *
 * `updatedAt` is a `Date` rather than the plan's epoch number, because every
 * task timestamp in this tree is one (`TaskDto`, `TaskRow`, `JobData`), and a
 * single `number` here would have put a conversion in `taskSyncService`.
 */
export interface RemoteTaskSnapshot {
  binding: RemoteBinding
  title: string
  description: string | null
  /**
   * What the task was originally asked for — cinna's `original_message`, and
   * the task page's main prose.
   *
   * Carried because of what its absence costs and cannot undo: `taskRepo.create`
   * **requires** a `goal`, and `TaskPatch` deliberately excludes it ("immutable
   * once created"). A pull with no goal in the snapshot would have to invent one
   * — the title, or an empty string — and then *nothing could ever correct it*,
   * not the next pull and not the periodic full reconcile. Null where the remote
   * genuinely has no such field, so a caller can fall back deliberately rather
   * than by accident.
   */
  goal: string | null
  status: TaskStatus
  priority: TaskPriority
  /** Why it failed, in the remote's words. The page prints a generic sentence without it. */
  errorMessage: string | null
  assignee: RemoteAssignee | null
  /**
   * The **parent's remote id**, in the same space as `RemoteBinding.id`.
   *
   * Not its display key: cinna returns `parent_task_id` as a UUID and its
   * `short_code` is documented display-only, so keying the tree on the key would
   * mean an extra fetch per parent and then matching a *printed string* to
   * re-parent a replica.
   */
  parentId: string | null
  /** The remote's own counts. cinna computes both; a flat remote reports zero. */
  subtaskCount: number
  subtaskCompletedCount: number
  updatedAt: Date
}

/** The four fields a push may carry, as far as `capabilities().writeFields` allows. */
export interface RemoteTaskFields {
  title: string
  description: string | null
  priority: TaskPriority
  assignee: RemoteAssignee | null
}

/** A comment as it comes back from the remote. */
export interface RemoteComment {
  id: string
  /**
   * Open string, not a union: cinna's `comment_type` is a free field its own
   * agents extend (`message | result | status_change | assignment | system` are
   * the ones in use), and `cinnaTaskView.ts` already types it this way. An
   * unknown type is treated as `message` by the caller, never refused.
   */
  type: string
  body: string
  author: string | null
  createdAt: Date
}

/**
 * A comment on its way out. Separate from {@link RemoteComment} because a post
 * supplies none of `id`, `author` or `createdAt` — the remote assigns all
 * three — and one type with half its fields optional would have been a type
 * that lies in whichever direction you are not looking.
 */
export interface RemoteCommentDraft {
  /**
   * **A closed set, unlike the one on the way back.** What comes *out* of a
   * remote is whatever vocabulary it has (cinna's `comment_type` is a free
   * string its own agents extend), and refusing an unknown one would be the
   * desktop arguing with the system doing the work. What goes *in* is chosen
   * here, by callers outside this folder — so it is three words every adapter
   * maps to its own, rather than a cinna literal written in `taskService`.
   */
  type: 'note' | 'result' | 'system'
  body: string
}

/**
 * One open human-input request on the remote, in the **same shape a local run
 * emits**.
 *
 * This is plan rule 1 applied one level up: a cinna tool question and a parked
 * ACP permission reach the inbox as the same `InputRequest`, so one component
 * renders both and no second union exists to drift.
 */
export interface RemoteAsk {
  /** The remote's id for the ask — what `answerAsk` is given back. */
  id: string
  request: InputRequest
  createdAt: Date
}

/** What became of an answer posted to a remote ask. */
export interface RemoteAnswerOutcome {
  /** False when nothing was waiting on that id — answered already, or expired. */
  delivered: boolean
}

export interface RemoteAvailability {
  ready: boolean
  /**
   * Why not, as a sentence for a person. Required whenever `ready` is false —
   * this is shown, not logged, and "the service is unavailable" with no reason
   * is the state a user cannot act on.
   */
  reason?: string
}

export interface RemoteTaskAdapter {
  /**
   * Opaque outside this folder. It is stored in `tasks.remote_adapter` and used
   * to look the adapter back up; it is never compared to a literal anywhere
   * else, which is what the ratchet's `remoteAdapter` category counts.
   */
  readonly id: string

  /** Pure and stable: no I/O, the same answer every call, immune to a caller editing it. */
  capabilities(): RemoteTaskCapabilities

  /**
   * Is this adapter usable for this profile right now? Never rejects — an
   * unlinked profile is an answer, not a failure.
   */
  availability(userId: string): Promise<RemoteAvailability>

  listAssignees(userId: string): Promise<RemoteAssignee[]>

  /**
   * Put the task on the remote and return the binding that results. **The only
   * call allowed to invent one.**
   *
   * `parent` is the **parent's binding**, not its local id, and that is not a
   * detail. `TaskDto.parentTaskId` is a desktop id; cinna's
   * `InputTaskCreate.parent_task_id` is a cinna UUID, and Linear's is a Linear
   * id — none of them derivable from the local one by an adapter, which holds
   * no mapping. An earlier draft of this method took only the task, and the
   * only way any real adapter could have satisfied it was to send no parent at
   * all: **the top-level orphan the whole rule is against**, created while
   * reporting success.
   *
   * So the caller resolves the parent first and hands it over. Three refusals
   * follow, and each is a different mistake:
   *
   *  - a parent offered to an adapter whose `subtasks` capability is false is
   *    `unsupported` — a flat remote must not quietly flatten the tree;
   *  - a task that *has* a `parentTaskId` offered with `parent: null` is
   *    `invalid_request`, and the remote is never asked — this is the orphan
   *    caught at the seam rather than discovered in the remote a week later;
   *  - anything else the remote itself refuses is `rejected`.
   */
  create(userId: string, task: TaskDto, parent: RemoteBinding | null): Promise<RemoteBinding>

  /**
   * Leave the handoff note where the next agent on this remote will find it.
   *
   * **First-class, rather than a comment with a magic type**, for two reasons
   * the comment version failed on. §5.10 would have posted it as
   * `{ type: 'result' }` — a *cinna* literal, written in `taskService`, outside
   * this folder, in a field the ratchet does not watch because it counts
   * adapter ids and not comment types: the exit criterion leaking through the
   * one door nobody is guarding. And an adapter with `comments: false` would
   * have had no channel for the note at all — not a writable field, not on the
   * snapshot, not an artifact — so Claude Managed Agents, one of the four
   * worked examples, could not be handed over to.
   *
   * Each adapter maps it to whatever its service actually reads: cinna posts a
   * `result` comment, a session-log remote appends a message. The desktop side
   * of the same string is `taskFileService`'s exported file (§5.11) — one note,
   * in the two places an agent might look.
   */
  putHandoffNote(userId: string, binding: RemoteBinding, note: string): Promise<void>

  pushFields(
    userId: string,
    binding: RemoteBinding,
    fields: Partial<RemoteTaskFields>
  ): Promise<RemoteBinding>

  /**
   * Push one status.
   *
   * **One step, not a destination.** The remote validates transitions, so a
   * task that went `new → completed` locally goes up as two calls; walking the
   * path is `taskSyncService`'s job, and an adapter that tried to do it here
   * would be guessing at the remote's table. A status outside
   * `REMOTE_WRITABLE_STATUSES` never leaves the process — including `archived`,
   * which is {@link RemoteTaskAdapter.archive}'s job and not a status push.
   */
  pushStatus(
    userId: string,
    binding: RemoteBinding,
    status: TaskStatus,
    reason?: string
  ): Promise<RemoteBinding>

  /**
   * File the task away. Gated by `capabilities().archive` and **not** by
   * `writeStatus`: archiving is its own operation on a remote that has one, and
   * `archived` is deliberately absent from `REMOTE_WRITABLE_STATUSES` so it can
   * never reach {@link RemoteTaskAdapter.pushStatus} by accident.
   */
  archive(userId: string, binding: RemoteBinding): Promise<RemoteBinding>

  /**
   * Everything the desktop mirrors about the task, in one call.
   *
   * Deliberately **not** an answer to "is something running there right now" —
   * that is {@link RemoteTaskAdapter.liveSession}, and the split is step 11's.
   * It was one call in step 8 (a `liveSession` field on the snapshot) because
   * the seam then had nothing else to ask, and the cost of that shape only
   * became visible once something used it: the pull calls `fetch` for every
   * watched replica on every pass and throws the session state away, because
   * there is nowhere in a `TaskPatch` to put it. On cinna that was a whole
   * extra round trip per task per poll, paid for a question nobody was asking.
   */
  fetch(userId: string, binding: RemoteBinding): Promise<RemoteTaskSnapshot>

  /**
   * Is something **running on the remote right now**?
   *
   * `null` is a real answer — "this adapter cannot tell" — and §5.10 says what
   * the caller does with each of the three: a take-over is refused while work
   * is live there, offered when it is not, and asks for confirmation when
   * nobody knows. A **failed** probe collapses onto `null` at the call site
   * rather than here, because the two are the same answer to the only question
   * anybody asks of it, and an adapter that swallowed its own transport
   * failures would be the one call in this interface that reports success for
   * a request that did not happen.
   *
   * There is no capability for it. The tri-state already carries the whole
   * answer — an adapter that cannot tell says `null` — and a boolean beside it
   * would be a second way to spell the same thing, which is how the two drift.
   *
   * Its own question rather than a field on the snapshot, because the two are
   * asked at completely different rates: the snapshot is pulled for every
   * watched replica on every pass, and this is asked once, by a person about to
   * press Take over. The reason it may not be inferred instead — `status ===
   * 'in_progress'` in the renderer — is unchanged and is why it exists at all:
   * cinna recomputes status from its sessions, so a task can sit `in_progress`
   * with nothing live and can be live before the recompute lands, and
   * `RemoteBinding.state` (where cinna keeps its sessions) is opaque outside
   * this folder by rule. Inferring is wrong in both directions — it blocks a
   * take-over that was safe, and it offers one into a live agent, which ends
   * with two runners on one task and `compute_status_from_sessions` overwriting
   * whatever the desktop wrote.
   */
  liveSession(userId: string, binding: RemoteBinding): Promise<boolean | null>

  /** Everything changed since `since`, or the adapter's own active set when null. */
  list(userId: string, since: Date | null): Promise<RemoteTaskSnapshot[]>

  /** The remote's children of this task, flat. One level is shown; depth is a badge. */
  listSubtasks(userId: string, binding: RemoteBinding): Promise<RemoteTaskSnapshot[]>

  /** Ask the remote to start working on it. */
  execute(userId: string, binding: RemoteBinding): Promise<RemoteBinding>

  addComment(userId: string, binding: RemoteBinding, comment: RemoteCommentDraft): Promise<void>
  listComments(userId: string, binding: RemoteBinding): Promise<RemoteComment[]>
  /** Gated by `capabilities().writeArtifactKinds` containing `artifact.kind`. */
  putArtifact(userId: string, binding: RemoteBinding, artifact: TaskArtifact): Promise<void>

  listOpenAsks(userId: string, binding: RemoteBinding): Promise<RemoteAsk[]>

  /**
   * Answer one of them.
   *
   * `{ delivered: false }` rather than the plan's `void`, and rather than a
   * throw, for the ask that is no longer open — the commonest thing that
   * happens to an ask, and not a failure. It is the same answer
   * `AgentDriver.respond` gives for a local park, which is what lets
   * `inboxService` return its `no_longer_waiting` refusal from one branch
   * instead of two.
   */
  answerAsk(
    userId: string,
    binding: RemoteBinding,
    askId: string,
    resolution: RequestResolution
  ): Promise<RemoteAnswerOutcome>

  /**
   * Where a person would go to look at this task, or null when there is nowhere.
   *
   * `http:`/`https:` only. `app:open-external` refuses every other scheme, so a
   * link the app cannot open is a control that does nothing.
   */
  deepLink(binding: RemoteBinding): string | null
}
