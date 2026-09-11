/**
 * Keeping a bound task and its remote copy in step — the only module that
 * talks to a {@link RemoteTaskAdapter} on a schedule.
 *
 * **The local write already happened.** `taskService` writes SQLite and returns;
 * everything here runs afterwards and may fail freely. That is what makes an
 * unlinked profile, an offline laptop, a 500 and a service this build does not
 * have the same code path: nothing the user did is undone by any of them, and
 * the markers in `tasks.remote_dirty` survive until the remote has actually
 * been told.
 *
 * Four jobs:
 *
 *  - **push** what this device knows and the remote does not — the dirty
 *    fields, the handoff note, and the status as a *path* rather than a
 *    destination;
 *  - **pull** what changed there, through the adapter's `updated_since` cursor;
 *  - **reconcile** periodically, because a delete is invisible to a cursor;
 *  - **count** what is waiting on the user, for the inbox badge's remote half.
 *
 * ## Three rules that are not obvious, each of which costs data if broken
 *
 * **The status goes up as a path.** cinna-core validates transitions, so a
 * desktop job that ran and finished between two polls has a local task at
 * `completed` and a remote copy still at `new` — and `new` to `completed` is
 * not a legal step. The push asks the remote where it is, walks
 * {@link taskStatusPath}, and sends each step. Sending the destination 400s on
 * every completed task, on a status code that also means "not your task".
 *
 * **The status is only ever pushed while `executor` is `desktop`.** §5.12 rule
 * 4: a task the remote is executing has its status recomputed from its own
 * sessions, so a write from here would be overwritten — correctly, because the
 * server has the last word where the server is doing the work.
 *
 * **A task missing from a pull is not a deleted task.** `list(userId, null)` is
 * the adapter's *active* set, and on cinna that excludes everything completed,
 * cancelled or archived. Dropping whatever the list omits would delete every
 * task the user ever finished. So the reconcile treats an absence as a
 * *question* and asks `fetch` about each one; only a `not_ours` — which an
 * adapter answers only when it is sure — removes the replica.
 *
 * ## What calls this
 *
 * **Nothing drives the loop yet** — no timer, no IPC channel, no service caller
 * for `push`, `pull`, `reconcile`, `pullOne` or `remoteWork`. Deliberately, the
 * same way `taskFileService` landed before anything wrote a handoff note and the
 * adapter seam landed before its first adapter. The producers arrive with step
 * 11, where the `cinna_task` job path folds onto `adapter.create` +
 * `adapter.execute` and `refreshCinnaRun` becomes {@link
 * taskSyncService.pullOne}.
 *
 * The one production import is `authService`, and it calls
 * {@link taskSyncService.resetCursors} alone — that hazard does not wait for a
 * scheduler, because it is about a cursor outliving the account it describes.
 *
 * The cursor is deliberately in memory for the same reason §5.7 wants a full
 * reconcile on start: a restart costs one active-set pull, which is the pass
 * that would have to happen anyway, plus the bounded history window beside it.
 */

import { taskRepo, type TaskRow } from '../db/tasks'
import { taskService, type RemoteSnapshotPatch } from './taskService'
import { taskStatusPath } from '../tasks/taskStatusPath'
import { adapterFor, allAdapters } from '../tasks/adapters'
import {
  RemoteTaskError,
  isRemoteDirtyField,
  type RemoteBinding,
  type RemoteDirtyField,
  type RemoteTaskAdapter,
  type RemoteTaskFields,
  type RemoteTaskSnapshot,
  type RemoteWritableField
} from '../tasks/adapters/adapter'
import { parseTaskStatus, type TaskStatus } from '../../shared/taskStatus'
import {
  parseTaskAssigneeKind,
  parseTaskPriority,
  type TaskAssignee,
  type TaskDto
} from '../../shared/tasks'
import { createLogger } from '../logger/logger'

const logger = createLogger('task-sync')

/**
 * How often a pull also reconciles.
 *
 * The first pull of a session always does, because that is §5.7's "on app
 * start" and because a fresh process has no cursor and is already asking for
 * the whole active set. After that it is every twentieth, which at the jobs
 * poll's cadence is often enough that a task deleted on the web does not linger
 * for a working day, and rare enough that the extra `fetch` per missing replica
 * is not a per-poll cost.
 */
const RECONCILE_EVERY = 20

/**
 * What a reason line on a remote status change says. It lands in an audit
 * trail — a `TaskStatusHistory` row and a `status_change` comment, per step.
 *
 * A catch-up of two steps therefore writes two lines, and writing the same
 * sentence twice would describe them as two things that happened rather than as
 * one thing reported late. Every step but the last says so.
 */
const PUSH_REASON = 'Reported by Cinna Desktop'
const CATCH_UP_REASON = 'Reported by Cinna Desktop (catching up)'

/**
 * How far back the cursor is rewound after each pull.
 *
 * The server filters `updated_at > updated_since`, strictly — so a change made
 * in the *same instant* as the newest row a pull saw is never returned again,
 * by any later pull, for ever. It is not a race that resolves itself: the row
 * simply falls into the gap between two passes and stays there.
 *
 * A second of overlap closes it, and costs nothing: an upsert of a row the
 * desktop already has is idempotent, and `applyRemoteSnapshot` skips any field
 * this device still owes the remote, so re-reading a boundary cannot undo a
 * local edit either.
 */
const CURSOR_OVERLAP_MS = 1_000

/**
 * How much finished history the first pull of a session brings in.
 *
 * The first pass has no cursor, so it asks for the adapter's *active* set —
 * which on cinna excludes `completed`, `cancelled` and `archived`. Without this
 * window, a task that finished before the profile linked (or before the app
 * last started) is unreachable by any route: filtered out by status on the
 * first pass, and absent from every later delta unless somebody touches it
 * again.
 *
 * A week, because the question this answers is "what did my agents finish
 * recently", and because the cost is paid per app start rather than per poll.
 * It is a cursored `list`, which carries no status filter and is therefore the
 * only route by which a terminal task arrives at all — and which is **paged**,
 * so it is one request per page rather than one request flat. A wider window is
 * not free: it is more pages, all awaited before the first upsert.
 *
 * **This number is a product decision, not a protocol one**, and nothing renders
 * the tasks it brings in yet. The screen that lists remote tasks is the right
 * place to revisit it — a longer window is one constant away, and an adapter
 * whose history is expensive should narrow it through its own `list` instead.
 */
const FIRST_PASS_BACKFILL_MS = 7 * 24 * 60 * 60 * 1_000

/**
 * The finished-history window, or an empty list if the service could not
 * produce it.
 *
 * **Isolated from the pass that needs it, deliberately.** The active set has
 * already been fetched by the time this runs, and letting a failure here escape
 * would discard it: nothing would be upserted, `state.pulls` would stay at zero,
 * and every later pass would repeat both requests and fail the same way — so a
 * service that answers the active set perfectly and times out on the larger
 * cursored one would sync **nothing at all**, indefinitely, logged as a plain
 * failed pull. A missing week of history is not a reason to lose the week that
 * is live.
 */
async function history(userId: string, adapter: RemoteTaskAdapter): Promise<RemoteTaskSnapshot[]> {
  const since = new Date(Date.now() - FIRST_PASS_BACKFILL_MS)
  try {
    return await adapter.list(userId, since)
  } catch (err) {
    logger.warn('could not read finished history; keeping the active set', {
      adapter: adapter.id,
      error: err instanceof Error ? err.message : String(err)
    })
    return []
  }
}

/**
 * Two lists of snapshots as one, keyed by the remote's id.
 *
 * The active set and the history window overlap by construction — anything
 * active *and* touched inside the window is in both — and upserting the same
 * task twice in one pass is a wasted write plus a duplicate in the parent
 * resolution batch.
 *
 * **The later list wins**, because the two are sequential round trips rather
 * than one instant: a task that changes between them appears in both with
 * different contents, and keeping the first-fetched copy would write the staler
 * one — a task that completed mid-pass recorded as still running. The Map keeps
 * the first insertion's *position*, so the ordering of `first` survives while
 * its values are overwritten.
 */
function mergeById(
  first: RemoteTaskSnapshot[],
  second: RemoteTaskSnapshot[]
): RemoteTaskSnapshot[] {
  const byId = new Map<string, RemoteTaskSnapshot>()
  for (const snapshot of [...first, ...second]) byId.set(snapshot.binding.id, snapshot)
  return [...byId.values()]
}

/** Per (profile, adapter) pull bookkeeping. In memory; a restart resets it. */
interface CursorState {
  cursor: Date | null
  pulls: number
}

const cursors = new Map<string, CursorState>()

/**
 * One push at a time per task.
 *
 * Two passes over the same task interleave at every `await`, and the damage is
 * specific: pass B's `fetch` can predate pass A's writes, so B computes the
 * path `in_progress → completed` for a remote A has already moved to
 * `completed`. `VALID_TRANSITIONS['completed']` is `{archived}`, so B's first
 * step is a 400, which is `rejected`, which **drops a status marker that was
 * legitimately owed**. The "clear only if the value has not moved" rule cannot
 * catch that one: the local value is innocent, and the conflict was
 * manufactured by this process. It also doubles the audit trail on the web,
 * where every step writes a history row and posts a `status_change` comment.
 *
 * Per **task**, not per profile: two tasks' statuses are independent on the
 * server, so there is nothing for them to race over, and a profile-wide lock
 * would serialise a whole `pushAll` behind one slow upload.
 */
const pushesInFlight = new Map<string, Promise<void>>()

/**
 * A profile id never contains a space (nanoid's alphabet, or `__default__`), so
 * the prefix up to the first one is the profile and `resetCursors(userId)` can
 * select a profile's keys without a second map.
 */
function cursorKey(userId: string, adapterId: string): string {
  return `${userId} ${adapterId}`
}

function stateFor(userId: string, adapterId: string): CursorState {
  const key = cursorKey(userId, adapterId)
  const existing = cursors.get(key)
  if (existing) return existing
  const created: CursorState = { cursor: null, pulls: 0 }
  cursors.set(key, created)
  return created
}

/** The binding a row carries, or null when it is not bound to anything. */
function bindingOf(row: TaskRow): RemoteBinding | null {
  if (!row.remoteAdapter || !row.remoteId) return null
  return {
    adapter: row.remoteAdapter,
    id: row.remoteId,
    key: row.remoteKey,
    url: row.remoteUrl,
    state: row.remoteState ?? {}
  }
}

/**
 * What a failed call means for the marker that caused it.
 *
 * The distinction the whole taxonomy turns on is `not_ours` against
 * `rejected` — one drops the binding for ever and the other keeps it — and on
 * cinna-core both arrive as a 400. Telling them apart is the adapter's job;
 * acting on the answer is this one's.
 */
type Consequence = 'retry' | 'drop' | 'unbind'

function consequenceOf(err: unknown, what: string): Consequence {
  if (err instanceof RemoteTaskError) {
    switch (err.code) {
      case 'unavailable':
        return 'retry'
      case 'not_ours':
        return 'unbind'
      case 'rejected':
      case 'invalid_request':
      case 'unsupported':
        // Understood and refused, or a call that does not make sense. Retrying
        // it unchanged fails the same way for ever, and a marker that can never
        // clear makes every later push do the same doomed work first.
        logger.warn('a change will not be sent', { what, code: err.code, detail: err.detail })
        return 'drop'
    }
  }
  // An adapter that threw something that is not a `RemoteTaskError` has broken
  // its own contract (`failure.is_domain`). Loud, and retried — losing a user's
  // edit over an adapter bug is the worse of the two mistakes.
  logger.error('a remote call failed in a way its adapter does not describe', {
    what,
    error: err instanceof Error ? err.message : String(err)
  })
  return 'retry'
}

/**
 * Would writing this patch change anything the user or a peer could see?
 *
 * Asked because the cursor is deliberately rewound a second on every pass, so
 * the newest row falls inside the window **for ever** — and without this the
 * steady state of an idle profile is a database write and a filesystem write,
 * per poll, per task at the boundary, describing a change that did not happen.
 *
 * It compares the *outcome* rather than the timestamps, and that is not
 * fussiness. Every timestamp column here is drizzle
 * `integer({ mode: 'timestamp' })`, which is **seconds**: a `Date` carrying
 * milliseconds comes back rounded down, so `stored.getTime() === fresh.getTime()`
 * can never be true and the guard would silently never fire. Comparing at
 * second resolution instead swaps that for the opposite fault — a real edit
 * made within the same second as the last one is discarded as "nothing to say".
 * Neither is a trade worth making when the question being asked is simply
 * whether the write is a no-op, which is directly checkable.
 *
 * The `owed` skips mirror {@link taskService.applyRemoteSnapshot}: a field this
 * device still has to push is not one the pull would write, so a difference
 * there is not a reason to write.
 */
function wouldChange(row: TaskRow, patch: RemoteSnapshotPatch): boolean {
  const owed = new Set<string>(row.remoteDirty ?? [])
  if (patch.title !== undefined && !owed.has('title') && patch.title !== row.title) return true
  if (
    patch.description !== undefined &&
    !owed.has('description') &&
    patch.description !== row.description
  ) {
    return true
  }
  if (patch.priority !== undefined && !owed.has('priority') && patch.priority !== row.priority) {
    return true
  }
  if (!owed.has('status')) {
    if (patch.status !== undefined && patch.status !== row.status) return true
    if (patch.errorMessage !== undefined && patch.errorMessage !== row.errorMessage) return true
  }
  if (patch.assignee !== undefined && !owed.has('assignee')) {
    if (patch.assignee.agentId !== row.assigneeAgentId) return true
    if (patch.assignee.name !== row.assigneeName) return true
    if (patch.assignee.kind !== row.assigneeKind) return true
  }
  if (patch.parentTaskId !== undefined && patch.parentTaskId !== row.parentTaskId) return true
  if (patch.binding !== undefined) {
    if (patch.binding.key !== row.remoteKey) return true
    if (patch.binding.url !== row.remoteUrl) return true
  }
  return false
}

/** A task that has stopped. Nobody is waiting on one, which is what makes it cheap to skip. */
function isTerminalStatus(status: TaskStatus): boolean {
  return (
    status === 'completed' ||
    status === 'error' ||
    status === 'cancelled' ||
    status === 'archived'
  )
}

const WRITABLE: readonly RemoteWritableField[] = ['title', 'description', 'priority', 'assignee']

function isWritableField(field: RemoteDirtyField): field is RemoteWritableField {
  return (WRITABLE as readonly string[]).includes(field)
}

/** The writable fields, as a patch the adapter takes. */
function fieldPatch(
  row: TaskRow,
  fields: readonly RemoteWritableField[]
): Partial<RemoteTaskFields> {
  const patch: Partial<RemoteTaskFields> = {}
  for (const field of fields) {
    if (field === 'title') patch.title = row.title
    if (field === 'description') patch.description = row.description
    if (field === 'priority') patch.priority = parseTaskPriority(row.priority)
    if (field === 'assignee') {
      const kind = parseTaskAssigneeKind(row.assigneeKind)
      // **Only an assignee the remote could possibly know.** `assigneeAgentId`
      // is an id in the space its `kind` names — a local `agents` row for
      // `agent`, and the remote's own id for `remote_agent` — so a
      // `remote_agent` is the one kind that has a reference to send.
      //
      // Not read out of `remoteState`, which is opaque outside
      // `tasks/adapters/` by §5.6 rule 1; `shared/tasks.ts` used to say the
      // binding state held this, which no caller outside the adapters could
      // ever have honoured. Corrected there.
      patch.assignee =
        kind === 'remote_agent' && row.assigneeAgentId
          ? { ref: row.assigneeAgentId, name: row.assigneeName, kind }
          : null
    }
  }
  return patch
}

/**
 * Does the field a marker stands for still hold what it held when the push read
 * it?
 *
 * Rendered rather than compared field by field so `null` and the string
 * `"null"` cannot collide, and so the assignee — three columns behind one
 * marker — is one comparison.
 */
function sameValue(before: TaskRow, after: TaskRow, field: RemoteDirtyField): boolean {
  return render(before, field) === render(after, field)
}

function render(row: TaskRow, field: RemoteDirtyField): string {
  switch (field) {
    case 'title':
      return JSON.stringify(row.title)
    case 'description':
      return JSON.stringify(row.description)
    case 'priority':
      return JSON.stringify(row.priority)
    case 'assignee':
      return JSON.stringify([row.assigneeAgentId, row.assigneeName, row.assigneeKind])
    case 'status':
      return JSON.stringify(row.status)
    case 'handoffNote':
      return JSON.stringify(row.handoffNote)
  }
}

/** A snapshot, in the desktop's words, with the parent already resolved. */
function patchFrom(snapshot: RemoteTaskSnapshot, parentTaskId: string | null): RemoteSnapshotPatch {
  const assignee: TaskAssignee | undefined = snapshot.assignee
    ? {
        // `agentId` is an id **in the space `kind` names**, so the remote's own
        // `ref` belongs here for a `remote_agent` and nowhere else. Dropping it
        // — which the first version did — is what left a replica unable to push
        // an assignee at all: the only place the remote's agent id ever arrives
        // is this snapshot, and a pull is the only way a replica gets one.
        agentId: snapshot.assignee.kind === 'remote_agent' ? snapshot.assignee.ref : null,
        name: snapshot.assignee.name,
        kind: snapshot.assignee.kind
      }
    : undefined
  return {
    title: snapshot.title,
    description: snapshot.description,
    priority: snapshot.priority,
    status: snapshot.status,
    assignee,
    parentTaskId,
    errorMessage: snapshot.errorMessage,
    updatedAt: snapshot.updatedAt,
    binding: {
      key: snapshot.binding.key,
      url: snapshot.binding.url,
      state: snapshot.binding.state
    }
  }
}

/**
 * Whether anything on a bound service is waiting on the user — **not how
 * much**, and the difference is not fussiness.
 *
 * Each adapter answers from whatever its own service counts, and cinna's is
 * unread, unarchived activities with `action_required` set. Three things follow
 * and the third decides the shape: it is profile-wide; one ask raises two rows;
 * and **nothing on the desktop clears `is_read` — only the web does.** So for a
 * user who lives here the number can never reach zero however much work they
 * do, and a badge that cannot be cleared by doing the work teaches its user to
 * ignore the badge.
 *
 * The number is still meaningful server-side and is a legitimate cheap trigger,
 * which is all §5.7 step 1 asks of it — so the *adapter* keeps returning a
 * count and the shaping happens here, one layer up, where the desktop's own
 * arithmetic is. A surface counts what it can enumerate (local open asks, plus
 * remote asks it actually pulled) and shows a dot for the rest.
 */
export interface RemoteWork {
  waiting: boolean
  /**
   * False when at least one bound service could not be asked.
   *
   * A failed read is not an empty inbox — the lesson step 5 and step 6 each had
   * to learn on screen. A caller that renders `waiting` without looking at this
   * tells the user nothing is waiting on them when the truth is that nobody
   * knows.
   */
  complete: boolean
}

/**
 * One push pass. Serialised per task by {@link taskSyncService.push}, which is
 * the only caller — see {@link pushesInFlight} for what two of these
 * interleaving costs.
 */
async function pushOne(userId: string, taskId: string): Promise<void> {
  const row = taskRepo.getById(userId, taskId)
  if (!row || row.deletedAt) return
  const bound = bindingOf(row)
  if (!bound) return

  const owed = (row.remoteDirty ?? []).filter(isRemoteDirtyField)
  if (owed.length === 0) return

  const adapter = adapterFor(bound.adapter)
  const availability = await adapter.availability(userId)
  if (!availability.ready) return

  const caps = adapter.capabilities()
  const remaining = new Set<RemoteDirtyField>(owed)
  let binding = bound
  /**
   * Did the service answer, about anything? A refusal counts — the server
   * spoke. Only "it did not answer" leaves the binding as stale as it was.
   */
  let contacted = false

  /** Returns false when the binding is gone and there is nothing left to do. */
  const settle = (err: unknown, what: string, markers: RemoteDirtyField[]): boolean => {
    const consequence = consequenceOf(err, what)
    if (consequence !== 'retry') contacted = true
    if (consequence === 'unbind') {
      taskService.unbindRemote(userId, taskId, `${what}: ${describe(err)}`)
      return false
    }
    if (consequence === 'drop') for (const marker of markers) remaining.delete(marker)
    return true
  }

  // The writable fields, in one patch.
  //
  // A field the remote cannot take is not owed to it. Dropping the marker
  // rather than retrying is the difference between "this service has no
  // priority" and "this service is down".
  const writable = owed.filter(isWritableField)
  for (const field of writable) {
    if (!caps.writeFields.includes(field)) remaining.delete(field)
  }
  const fields = writable.filter((field) => caps.writeFields.includes(field))
  if (fields.length > 0) {
    /** One PATCH. `refused` means the remote understood it and said no. */
    const attemptFields = async (
      batch: RemoteWritableField[]
    ): Promise<'sent' | 'refused' | 'retry' | 'unbound'> => {
      try {
        binding = await adapter.pushFields(userId, binding, fieldPatch(row, batch))
        contacted = true
        for (const field of batch) remaining.delete(field)
        return 'sent'
      } catch (err) {
        const consequence = consequenceOf(err, 'pushing fields')
        if (consequence !== 'retry') contacted = true
        if (consequence === 'unbind') {
          taskService.unbindRemote(userId, taskId, `pushing fields: ${describe(err)}`)
          return 'unbound'
        }
        return consequence === 'drop' ? 'refused' : 'retry'
      }
    }

    const outcome = await attemptFields(fields)
    if (outcome === 'unbound') return
    if (outcome === 'refused') {
      // **A refusal is about one field, but a PATCH is refused as a unit.**
      // Dropping the whole batch's markers would silently discard the user's
      // other edits — rename a task and assign an agent it will not take, and
      // the rename is lost with it, with nothing on screen to say so and the
      // next pull overwriting the local title because nothing is owed any
      // more. So the batch is taken apart and each field asked on its own;
      // only what is individually refused is given up.
      if (fields.length === 1) {
        remaining.delete(fields[0])
      } else {
        for (const field of fields) {
          const single = await attemptFields([field])
          if (single === 'unbound') return
          if (single === 'refused') remaining.delete(field)
        }
      }
    }
  }

  // The handoff note.
  if (remaining.has('handoffNote')) {
    if (!caps.handoffNote || row.handoffNote === null) {
      // A cleared note has nothing to post. Comment streams are append-only
      // and there is no unposting, so the marker goes rather than queueing a
      // write whose body would be empty.
      remaining.delete('handoffNote')
    } else {
      try {
        await adapter.putHandoffNote(userId, binding, row.handoffNote)
        contacted = true
        remaining.delete('handoffNote')
      } catch (err) {
        if (!settle(err, 'posting the handoff note', ['handoffNote'])) return
      }
    }
  }

  // The status, as a path.
  if (remaining.has('status')) {
    const status = parseTaskStatus(row.status)
    if (row.executor !== 'desktop') {
      // §5.12 rule 4. The remote recomputes the status of a task it is
      // executing from its own sessions, so a write from here is overwritten
      // — correctly. Nothing is owed.
      remaining.delete('status')
    } else if (status === 'archived') {
      if (!caps.archive) remaining.delete('status')
      else {
        try {
          binding = await adapter.archive(userId, binding)
          contacted = true
          remaining.delete('status')
        } catch (err) {
          if (!settle(err, 'archiving', ['status'])) return
        }
      }
    } else if (!caps.writeStatus) {
      remaining.delete('status')
    } else {
      try {
        // What the remote thinks, asked rather than remembered: it may have
        // moved on its own, and the path depends on where it actually is.
        const there = await adapter.fetch(userId, binding)
        contacted = true
        binding = there.binding
        const path = taskStatusPath(there.status, status)
        if (path === null) {
          // No sequence of legal steps gets there — a local `error` to
          // `in_progress` retry on a remote that is `completed`, say. The
          // local task is right; the remote copy stays where it is. Queueing
          // it would be a 400 per poll for ever.
          logger.info('no way to tell the service about this status', {
            taskId,
            from: there.status,
            to: status
          })
          remaining.delete('status')
        } else {
          for (const [index, step] of path.entries()) {
            const reason = index === path.length - 1 ? PUSH_REASON : CATCH_UP_REASON
            binding = await adapter.pushStatus(userId, binding, step, reason)
          }
          remaining.delete('status')
        }
      } catch (err) {
        if (!settle(err, 'pushing the status', ['status'])) return
      }
    }
  }

  // **Clear a marker only if the value it stands for has not moved since the
  // attempt.**
  //
  // Every adapter call is an await, and a local write can land in any of
  // them. Writing `remaining` back wholesale would erase a marker added
  // while the push was in flight; clearing by name alone would erase the
  // marker for a field the user changed *after* the old value had already
  // gone up — and that one is worse than losing the push, because the field
  // is then no longer dirty and the next pull overwrites the user's newer
  // value with the older one the remote was given. Comparing the value
  // closes both.
  const attempted = owed.filter((field) => !remaining.has(field))
  const current = taskRepo.getById(userId, taskId)
  if (!current || current.deletedAt) return
  const stillOwed = (current.remoteDirty ?? [])
    .filter(isRemoteDirtyField)
    .filter((field) => !(attempted.includes(field) && sameValue(row, current, field)))

  taskService.markRemoteSynced(userId, taskId, stillOwed, {
    binding: { key: binding.key, url: binding.url, state: binding.state },
    contacted
  })
}

export const taskSyncService = {
  /**
   * Send what this device owes the remote for one task.
   *
   * Order matters only in that the status goes last: a field push that fails
   * should not stop the status from being reported, because the status is what
   * a person is looking at in a list somewhere else.
   */
  async push(userId: string, taskId: string): Promise<void> {
    const key = `${userId} ${taskId}`
    // Chained rather than rejected: a caller that asked for a push wants one,
    // and the second pass starting from the first's finished state is exactly
    // right. `catch` before chaining so one failure does not poison the queue.
    const queued = (pushesInFlight.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(() => pushOne(userId, taskId))
      .finally(() => {
        if (pushesInFlight.get(key) === queued) pushesInFlight.delete(key)
      })
    pushesInFlight.set(key, queued)
    return queued
  },


  /**
   * Every bound task with something outstanding.
   *
   * Each task is isolated, for the same reason {@link taskSyncService.pull}
   * isolates each service: one failure must not cancel everyone else's pass.
   * It does not take an adapter bug to reach — `push` awaits the network and
   * then writes, and if the user deleted *that* task while it was in flight the
   * write throws `not_found`, which without this would silently skip every task
   * after it in the list.
   */
  async pushAll(userId: string): Promise<void> {
    const rows = taskRepo
      .list(userId, { includeArchived: true })
      .filter((row) => row.remoteAdapter && (row.remoteDirty ?? []).length > 0)
    for (const row of rows) {
      try {
        await this.push(userId, row.id)
      } catch (err) {
        logger.warn('push failed for a task', {
          taskId: row.id,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }
  },

  /**
   * Bring one task up to date from its remote.
   *
   * This is what a task page open on a remote replica asks for, and what
   * `refreshCinnaRun` becomes in step 11.
   */
  async pullOne(userId: string, taskId: string): Promise<TaskDto | null> {
    const row = taskRepo.getById(userId, taskId)
    if (!row || row.deletedAt) return null
    const binding = bindingOf(row)
    if (!binding) return null

    const adapter = adapterFor(binding.adapter)
    if (!(await adapter.availability(userId)).ready) return null

    let snapshot: RemoteTaskSnapshot
    try {
      snapshot = await adapter.fetch(userId, binding)
    } catch (err) {
      if (consequenceOf(err, 'fetching the task') === 'unbind') {
        taskService.unbindRemote(userId, taskId, `fetching the task: ${describe(err)}`)
      }
      return null
    }
    return taskService.applyRemoteSnapshot(
      userId,
      taskId,
      patchFrom(snapshot, resolveParent(userId, adapter.id, snapshot.parentId))
    )
  },

  /**
   * One pass over every bound service: what changed there since last time.
   *
   * A service that fails is logged and skipped — one unreachable remote must
   * not stop another from syncing — and its cursor is left where it was, so
   * nothing is missed when it comes back.
   */
  async pull(userId: string): Promise<void> {
    for (const adapter of allAdapters()) {
      try {
        if (!(await adapter.availability(userId)).ready) continue
        const state = stateFor(userId, adapter.id)
        const firstPass = state.pulls === 0
        const active = await adapter.list(userId, state.cursor)
        // On the first pass there is no cursor, so `active` is the adapter's
        // *active* set — which on cinna excludes everything completed,
        // cancelled and archived. Left at that, a task that had already
        // finished when this profile linked would never arrive by any route:
        // the first pass filters it out by status, and every later pass is a
        // delta that mentions it only if somebody touches it again. The result
        // is a visible seam at the moment of linking — work finished ten
        // minutes before is missing while work finished ten minutes after is
        // there — so the first pass also asks for a bounded window of recent
        // history, where a cursor carries no status filter at all.
        const snapshots = firstPass ? mergeById(active, await history(userId, adapter)) : active

        // Two passes, and the second one is not belt-and-braces.
        //
        // A parent is resolved by looking it up **locally**, and cinna returns
        // an uncursored list `created_at DESC` — newest first — so a subtask
        // arrives *before* the parent it hangs off and there is nothing to
        // resolve against yet. One pass leaves every pulled subtask at top
        // level, reading as unrelated work nobody asked for, with the parent's
        // counts at zero. Nor does it heal: the next pass is a delta, and the
        // child is only in it if it changed on the server.
        const orphaned: { taskId: string; parentId: string }[] = []
        for (const snapshot of snapshots) {
          const taskId = upsert(userId, adapter, snapshot)
          if (taskId && snapshot.parentId) orphaned.push({ taskId, parentId: snapshot.parentId })
        }
        // Depth is decided from the **batch**, not from the rows as they are
        // being written. `resolveParent` refuses a parent that is itself a
        // subtask, but in the second pass the parent's own link may not have
        // been written yet — so a grandchild consulted a parent that still
        // looked like a root and produced the two-level tree the one-level rule
        // exists to prevent. Whether the parent is a child is a fact about the
        // remote's tree, and the snapshots carry it.
        const childrenOfChildren = new Set(
          snapshots.filter((s) => s.parentId !== null).map((s) => s.binding.id)
        )
        for (const { taskId, parentId } of orphaned) {
          if (childrenOfChildren.has(parentId)) continue
          const row = taskRepo.getById(userId, taskId)
          if (!row || row.parentTaskId) continue
          const resolved = resolveParent(userId, adapter.id, parentId)
          if (resolved) {
            // `updatedAt` carried over deliberately: re-parenting is this
            // device catching up with what the remote already said, not a
            // change to the task, and `taskRepo.list` orders by that column.
            taskService.applyRemoteSnapshot(userId, taskId, {
              parentTaskId: resolved,
              updatedAt: row.updatedAt
            })
          }
        }
        const newest = snapshots.reduce<Date | null>(
          (latest, snapshot) =>
            latest === null || snapshot.updatedAt > latest ? snapshot.updatedAt : latest,
          state.cursor
        )
        state.pulls += 1
        // **Before the reconcile, not after.** The pull's own work — every
        // upsert — is finished at this point, and the reconcile below is a
        // separate concern that can throw (`dropMissing`'s `taskService.remove`
        // is not individually guarded). With the order reversed, that throw
        // landed after `pulls` had been incremented and before the cursor was
        // written: the session was then never a first pass again, so it got no
        // history window and no reconcile until pass twenty, while still
        // holding a null cursor — which means re-fetching the entire active set
        // on every poll for the life of the process.
        //
        // **Only on a new maximum.** Applying the rewind unconditionally has
        // two costs that are invisible until they are not: an idle profile
        // widens its own window by a second per poll, because `newest` falls
        // back to the cursor it is about to move; and the newest row is
        // re-read on every single pass for ever, which is an upsert that ends
        // in `written(row)` and therefore a **filesystem write per poll**. An
        // idle cursor stays parked instead.
        if (newest !== null && (state.cursor === null || newest > state.cursor)) {
          state.cursor = new Date(newest.getTime() - CURSOR_OVERLAP_MS)
        }
        if (firstPass || state.pulls % RECONCILE_EVERY === 0) {
          // `active`, not `snapshots`: on the first pass the cursor was null, so
          // `active` *is* the active set and asking for it again would be the
          // same request twice — but the history merged into `snapshots` is
          // mostly terminal tasks, and handing those to `dropMissing` as "still
          // listed as active" is a claim about the service that is not true.
          await dropMissing(userId, adapter, firstPass ? active : null)
        }
      } catch (err) {
        logger.warn('pull failed for a service', {
          adapter: adapter.id,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }
  },

  /**
   * Drop replicas of tasks that are no longer on the service.
   *
   * Separate from {@link taskSyncService.pull} because a delete is invisible to
   * an `updated_since` cursor: the row simply stops being returned, and no
   * amount of polling will ever mention it again.
   */
  async reconcile(userId: string): Promise<void> {
    for (const adapter of allAdapters()) {
      try {
        if (!(await adapter.availability(userId)).ready) continue
        await dropMissing(userId, adapter, null)
      } catch (err) {
        logger.warn('reconcile failed for a service', {
          adapter: adapter.id,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }
  },

  /** Is anything on a bound service waiting on the user? See {@link RemoteWork}. */
  async remoteWork(userId: string): Promise<RemoteWork> {
    let waiting = false
    let complete = true
    for (const adapter of allAdapters()) {
      if (!adapter.capabilities().actionRequiredCount) continue
      try {
        if (!(await adapter.availability(userId)).ready) continue
        if ((await adapter.actionRequiredCount(userId)) > 0) waiting = true
      } catch (err) {
        complete = false
        logger.warn('could not ask a service what is waiting', {
          adapter: adapter.id,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }
    return { waiting, complete }
  },

  /**
   * Forget a profile's cursors, or every cursor when no profile is named.
   *
   * A cursor is the claim "for this profile, I have seen everything on this
   * service up to time T". `authService` calls this from the two places that
   * can falsify it, and only one of them is a live bug:
   *
   * 1. **A profile is re-linked to a different account** — the real one. A
   *    profile id is *this device's*, not the account's. `registerCinna`'s
   *    rebind branch finds the row by **email** and refreshes `cinnaServerUrl`
   *    from the flow that just completed, so the same address on a different
   *    cinna server (cloud to self-hosted, or between two self-hosted ones)
   *    lands on the same profile row, keeping its id, its tasks *and* its
   *    cursor. The next pull is then a **delta rather than the active set**:
   *    nothing on the new account older than T is ever fetched, and the
   *    reconcile does not run either because the pass count is no longer zero.
   *    The profile looks half-empty with nothing on screen to explain it, and
   *    stays that way until the app restarts.
   * 2. **The profile's tasks are deleted** (`deleteAccount`, both branches).
   *    Hygiene, not a fix: `deleteWithCascade` drops the `users` row too, so a
   *    later sign-in mints a fresh id and nothing could read the stale entry
   *    anyway. Resetting there keeps "a cursor never outlives the tasks it
   *    describes" an invariant rather than a consequence of how ids are minted.
   *
   * A profile *switch* is on neither list and deliberately does not reset: the
   * data is still there, the claim is still true, and re-pulling the whole
   * active set on every switch would cost a request to learn nothing.
   *
   * Called with no argument by tests that want two passes to be two first
   * passes.
   */
  resetCursors(userId?: string): void {
    if (userId === undefined) {
      cursors.clear()
      return
    }
    for (const key of [...cursors.keys()]) {
      if (key.startsWith(`${userId} `)) cursors.delete(key)
    }
  }
}

/**
 * Write a snapshot into the local store, creating a replica if there is none.
 *
 * Returns the local task id, or null when the snapshot was deliberately
 * skipped — which the caller needs so it can come back for a parent that had
 * not arrived yet.
 */
function upsert(
  userId: string,
  adapter: RemoteTaskAdapter,
  snapshot: RemoteTaskSnapshot
): string | null {
  const existing = taskRepo.getByRemote(userId, adapter.id, snapshot.binding.id)
  if (existing?.deletedAt) {
    // The user deleted it here. `getByRemote` deliberately returns soft-deleted
    // rows so this case is *reachable*: without it the next pull would create a
    // second local task for the same remote one.
    return null
  }
  const parentTaskId = resolveParent(userId, adapter.id, snapshot.parentId)
  if (existing) {
    // Nothing new to say, so nothing is written — see {@link wouldChange}.
    const patch = patchFrom(snapshot, parentTaskId)
    if (!wouldChange(existing, patch)) return existing.id
    taskService.applyRemoteSnapshot(userId, existing.id, patch)
    return existing.id
  }
  return taskService.create(userId, {
    title: snapshot.title,
    // A remote with no notion of an original ask falls back to the title —
    // deliberately, and visibly: `taskRepo.create` requires a goal and
    // `TaskPatch` refuses to update one, so this is a decision that can never
    // be revisited for this row. It is why `goal` is on the snapshot at all.
    goal: snapshot.goal ?? snapshot.title,
    description: snapshot.description,
    status: snapshot.status,
    priority: snapshot.priority,
    origin: 'remote',
    executor: 'remote',
    assigneeAgentId:
      snapshot.assignee?.kind === 'remote_agent' ? snapshot.assignee.ref : null,
    assigneeName: snapshot.assignee?.name ?? null,
    assigneeKind: snapshot.assignee?.kind ?? 'model',
    parentTaskId,
    remoteAdapter: adapter.id,
    remoteId: snapshot.binding.id,
    remoteKey: snapshot.binding.key,
    remoteUrl: snapshot.binding.url,
    remoteState: snapshot.binding.state,
    updatedAt: snapshot.updatedAt
  }).id
}

/**
 * The local id of a remote parent, if the desktop has it and may nest under it.
 *
 * Two ways this is null. One is correct: the parent is itself a subtask, and
 * the desktop keeps one level — §5.7 shows a deeper tree as a flat list with a
 * depth badge rather than pretending it can nest, and `taskService.create`
 * would refuse it anyway.
 *
 * The other is temporary and **the caller has to come back for it**: the parent
 * has not been written yet, because an uncursored cinna list arrives
 * `created_at DESC` and a subtask is younger than its parent. An earlier
 * version of this comment claimed the next pull would fix it; it would not, and
 * would not have to, because the next pull is a delta that only carries rows
 * that changed on the server. {@link taskSyncService.pull} makes a second pass
 * for exactly this.
 */
function resolveParent(userId: string, adapterId: string, parentId: string | null): string | null {
  if (!parentId) return null
  const parent = taskRepo.getByRemote(userId, adapterId, parentId)
  if (!parent || parent.deletedAt || parent.parentTaskId) return null
  return parent.id
}

/**
 * Remove replicas the service no longer has.
 *
 * `active` is the adapter's own active set when the caller already has it. The
 * central point is that being absent from it is a **question**, not an answer:
 * on cinna that list excludes everything completed, cancelled and archived, so
 * treating an absence as a delete would remove every task the user finished.
 * Each candidate is confirmed with a `fetch`, and only a `not_ours` — which an
 * adapter answers only when it is sure — removes anything.
 *
 * **Only replicas the desktop still believes are live are candidates**, and
 * that is a cost decision with a consequence worth stating. Every finished
 * replica is absent from the active set *by construction*, so confirming them
 * all would mean two requests each (`fetch` is `/detail` plus `/sessions`) at
 * every app start and every twentieth pull, for ever — four hundred requests
 * for two hundred finished tasks, none of which the user is waiting on. The
 * consequence is that a replica which finished here and was *then* deleted on
 * the service stays as local history. That is the better of the two wrongs: it
 * is a record of work that really happened, and nothing about it is stale.
 *
 * The confirming `fetch` is not thrown away either. A replica the desktop still
 * calls live, which the service does not list as active, has usually finished
 * there and the delta was missed — so the snapshot that proves it exists also
 * brings it up to date, and the request buys two answers instead of one.
 */
async function dropMissing(
  userId: string,
  adapter: RemoteTaskAdapter,
  active: RemoteTaskSnapshot[] | null
): Promise<void> {
  const live = active ?? (await adapter.list(userId, null))
  const seen = new Set(live.map((snapshot) => snapshot.binding.id))
  const locals = taskRepo.list(userId, { remoteAdapter: adapter.id, includeArchived: true })

  for (const row of locals) {
    // Only replicas. A task created here and merely *mirrored* there is this
    // device's own work: the remote copy vanishing means the **binding** is
    // stale, not the task, and deleting the user's own task because a mirror
    // went missing is the one outcome with no way back. Note what that leaves: a stale
    // binding is discovered by whatever next talks to the service about that
    // task — a push with something to send, or a pull of that task. A task with
    // nothing owed and nobody looking at it keeps its binding, its short code
    // and a deep link that answers 404 until one of those happens. Step 11
    // shortens that to "the first time anyone opens it", by having the task
    // page pull the task it is showing.
    if (row.origin !== 'remote' || !row.remoteId || seen.has(row.remoteId)) continue
    // Terminal replicas are absent from the active set by construction, so
    // confirming them is a permanent per-poll cost for tasks nobody is waiting
    // on. See the method comment.
    if (isTerminalStatus(parseTaskStatus(row.status))) continue
    const binding = bindingOf(row)
    if (!binding) continue
    try {
      const snapshot = await adapter.fetch(userId, binding)
      // It is still there, and the desktop's copy said otherwise. The delta
      // that would have told us was missed; this request tells us instead.
      taskService.applyRemoteSnapshot(
        userId,
        row.id,
        patchFrom(snapshot, resolveParent(userId, adapter.id, snapshot.parentId))
      )
    } catch (err) {
      if (err instanceof RemoteTaskError && err.code === 'not_ours') {
        logger.info('dropping a replica the service no longer has', {
          taskId: row.id,
          adapter: adapter.id
        })
        taskService.remove(userId, row.id)
      }
    }
  }
}

function describe(err: unknown): string {
  if (err instanceof RemoteTaskError) return err.detail ?? err.message
  return err instanceof Error ? err.message : String(err)
}
