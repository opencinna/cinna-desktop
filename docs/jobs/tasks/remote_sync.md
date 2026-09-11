# Keeping a Bound Task in Step

## Purpose

A task bound to a remote system exists twice: as a row in this device's SQLite, and as whatever that service holds. `taskSyncService` is the only module that talks to a [remote task adapter](remote_adapters.md) on a schedule, and its whole job is to make the two copies agree — pushing what this device knows and the service does not, pulling what changed there, and periodically asking whether a replica still exists at all.

**Nothing in the running app calls it yet.** See [What this deliberately does not do](#what-this-deliberately-does-not-do).

## Core Concepts

- **Dirty marker** — an entry in `tasks.remote_dirty` (`RemoteDirtyField`): one of `title`, `description`, `priority`, `assignee`, `status`, `handoffNote`. A marker is a statement that *this device knows something the remote does not*. `taskService` adds them on a **bound** task's own mutations — `update`, `setStatus` (and so `applyRunState`), `setAssignee`, `setHandoffNote`, `start` — and the push clears one only when the service has actually been told. Two absences are deliberate: `acceptRemoteStatus` marks nothing, or every pull would queue a push of what it had just been told, and an unbound task is left alone, so the column stays null for the overwhelming majority of tasks and a later bind starts from a clean slate
- **Replica** (`origin: 'remote'`) — a task that exists here because a pull created it. The service is the original
- **Mirror** — a task created here and also put on a service. The desktop copy is the original; the binding is a claim that a second copy exists
- **Status path** — the *sequence* of status writes that moves a remote from where it is to where the local task is, rather than the destination on its own (`taskStatusPath`, `src/main/tasks/taskStatusPath.ts`)
- **Cursor** — per `(profile, adapter)`, the `updated_since` timestamp the next pull asks from. In memory, so a restart costs one active-set pull
- **Remote work** — `{waiting, complete}`: whether anything on a bound service is waiting on the user, and whether every bound service could be asked. Deliberately not a number

## The four jobs

| Job | What it does |
|---|---|
| `push(userId, taskId)` / `pushAll(userId)` | Send the dirty markers: the writable fields in one patch, the handoff note, and the status as a path. Serialised per task |
| `pull(userId)` / `pullOne(userId, taskId)` | Take everything the service changed since the cursor and write it locally, creating a replica for anything new |
| `reconcile(userId)` | Ask whether replicas the service no longer lists still exist, and drop the ones it says are gone |
| `remoteWork(userId)` | Ask each bound service whether anything there is waiting on a human |

## Business Rules

### The local write already happened

`taskService` writes SQLite and returns. Everything here runs afterwards and may fail freely — which is what makes an unlinked profile, an offline laptop, a 500 and a service this build does not implement the same code path. Nothing the user did is undone by any of them, and the markers survive until the service has been told, so a task edited on a laptop that was asleep still pushes when it wakes.

### A status goes up as a path, not as a destination

A remote that validates transitions will refuse `new → completed`, and a desktop job that starts and finishes between two polls produces exactly that: a local task at `completed` over a remote copy still at `new`. The push asks the service where it is, walks `taskStatusPath`, and sends each step. This is the single most predicted defect in this area, and the reason it is dangerous is that it is *misread* — the refusal arrives on every completed task, looks like a network fault, and lands on the same HTTP status that also means "not your task".

The walk is breadth-first, so the answer is the **shortest** path, and shortest is not tidiness. On a service that records each step, a longer route does not write a richer history — it writes a false one:

- a task cancelled before it ever ran goes `new → cancelled` in one step, and the service never claims work started. Routed through `in_progress`, it stamps an execution time for a task nobody ran
- a task that was `blocked` and is now `completed` omits the block, correctly. Replaying it raises an action-required activity and lights the user's own inbox for a block that was resolved minutes ago

What is lost is the *local* history — blocked episodes, a retry after an error. If that is wanted on the service the channel is a comment, not a status replay.

Every step of a path is itself a push, so every step must be pushable: the search is confined to `REMOTE_WRITABLE_STATUSES`. That is what keeps `archived` out of the middle of a path — it is reachable from everywhere and reaches nothing, so an unfiltered search would file the task away on the way past.

**`null` from the walker is an answer, not an error.** There may be no sequence of legal steps at all: `completed → in_progress` is a legal *local* retry and has no expression on a service whose completed state reaches only `archived`. The local task is right, the remote copy stays where it is, and the marker is dropped with a log — queueing it would be a refusal per poll for the life of the app.

### The status is only pushed while the task runs here

A task the service is executing has its status recomputed from its own sessions, so a write from here would be overwritten — correctly, because the service has the last word where the service is doing the work. `executor !== 'desktop'` therefore owes the remote no status at all.

### A marker is cleared only if the value it stands for has not moved

Every adapter call is an `await`, and a local write can land in any of them. Writing the remaining markers back wholesale erases a marker added *during* the push. Clearing by name alone is worse: it erases the marker for a field the user changed **after** the old value had already gone up, so the field is no longer dirty and the next pull overwrites the user's newer value with the older one the service was given. The push compares the rendered value before and after instead.

### A refusal is about one field, but a patch is refused as a unit

Rename a task and assign it to an agent the account cannot use, and a single patch carrying both is refused whole. Dropping the whole batch's markers would silently discard the rename, with nothing on screen to say so and the next pull overwriting the local title because nothing was owed any more. A refused batch is taken apart and each field asked on its own; only what is individually refused is given up.

### One push at a time per task

Two passes over one task interleave at every `await`, and the damage is specific: the second pass's view of the remote can predate the first pass's writes, so it computes a path from a status the remote has already left, and the first step is refused. That refusal drops a status marker that was legitimately owed — and the value comparison above cannot catch it, because the local value is innocent and the conflict was manufactured by this process. It also doubles the audit trail on the service, where every step is a history row and a comment.

The lock is per **task**, not per profile: two tasks' statuses are independent on the service, and a profile-wide lock would serialise a whole `pushAll` behind one slow upload. A second push is **chained rather than dropped** — a caller that asked for a push wants one, and starting from the first pass's finished state is exactly right.

### A pull never overwrites a field this device still owes

The markers mean "we know something it does not", so taking the service's value for one of them would throw the user's change away moments before it was going to be sent. The pull skips every owed field; the push clears the marker; until then the local value wins.

`errorMessage` is protected by the **status** marker rather than one of its own, because it is part of the status rather than a field beside it. Letting it through alone was a real hole: a pull always sends an error message (null when the service has none), so a task that had just failed here lost its reason on the very next poll — and nothing could put it back, since a status path carries a short reason and not the text. A task reading `error` that can no longer say why.

### A pulled task's timestamp is the remote's, not now

Conflicts are reconciled per field on `updatedAt`, and a mirror that always looked newer than the thing it mirrors would win every conflict it should lose. The same rule is why clearing a marker does not bump `updatedAt` at all: `taskRepo.list` orders by it, so bookkeeping would float a task nobody touched to the top of the user's list every time a push succeeded.

### A pulled status is taken as fact

No transition check. A service's own handlers may bypass its table, so a replica can arrive in a state the table calls unreachable — and arguing with the system doing the work is how the desktop would become the one corrupting state.

### A task missing from a pull is not a deleted task

An uncursored `list` is the adapter's **active set**, which on cinna-core excludes everything completed, cancelled or archived. "Drop every replica the list did not mention" is the obvious implementation and it **deletes every task the user ever finished**. So an absence is a *question*: each candidate is confirmed with a `fetch`, and only a `not_ours` — which an adapter answers only when it is sure — removes anything.

Two narrowings, each with a stated cost:

- **only replicas are candidates.** A mirror vanishing from the service means the *binding* is stale, not the task, and deleting a user's own task because a mirror went missing is the one outcome with no way back
- **only replicas the desktop still believes are live.** A finished replica is absent from the active set by construction, so confirming them all would be two requests each at every app start and every twentieth pull, for work nobody is waiting on. The consequence, stated rather than hidden: a replica that finished here and was *then* deleted on the service stays as local history — the better of the two wrongs, since it is a record of work that really happened

The confirming `fetch` is not thrown away. A replica the desktop still calls live which the service does not list as active has usually finished there with the delta missed, so the snapshot that proves it exists also brings it up to date.

### A delete is invisible to a cursor, so the reconcile is on a timer

The first pull of a session always reconciles — a fresh process has no cursor and is already asking for the whole active set, so the "full reconcile on start" falls out of the design rather than needing a column. After that it is every twentieth pull: often enough that a task deleted on the web does not linger for a working day, rare enough that the extra confirmation is not a per-poll cost.

### The cursor overlaps itself by a second, and only advances on a new maximum

A service that filters `updated_at > cursor` **strictly** never returns a change made in the same instant as the newest row a pull saw — it falls into the gap between two passes and stays there, for ever. A second of overlap closes it and costs nothing, because the upsert is idempotent and skips owed fields.

Applying the rewind unconditionally has two costs that are invisible until they are not: an idle profile widens its own window by a second per poll, and the newest row is re-read on every pass for ever. So the cursor moves only on a new maximum, and an upsert that would change nothing writes nothing — otherwise the steady state of an idle profile is a database write **and a filesystem write** (every task write re-exports [the handoff note](handoff_note_export.md)) per poll, describing a change that did not happen.

That "would this change anything" question is asked about the **outcome**, field by field, rather than about timestamps. Timestamp columns here are second-resolution, so a `Date` carrying milliseconds never compares equal and the guard would silently never fire; comparing at second resolution instead discards a real edit made within the same second as the last one.

### A pulled subtask needs a second pass

A parent is resolved by looking it up locally, and an uncursored list may arrive newest-first — so a subtask can arrive *before* the parent it hangs off, with nothing to resolve against. One pass leaves every pulled subtask at top level, reading as unrelated work nobody asked for and with the parent's counts at zero, and it does not heal: the next pass is a delta, and the child is in it only if it changed on the service.

So the pull upserts everything, then re-parents the orphans. Depth is decided from the **batch**, not from rows as they are written: mid-pass a parent's own link may not exist yet and it still looks like a root, so a grandchild consulting it produced the two-level tree the one-level rule exists to prevent. Whether a parent is itself a child is a fact about the service's tree, and the snapshots carry it.

### "Something is waiting" is not a number

Each adapter answers `actionRequiredCount` from whatever its own service counts, and on cinna-core that figure is profile-wide, raises two rows per ask, and is gated on a read flag **only the web clears** — so for a user who lives in the desktop it can never reach zero however much work they do, and a badge that cannot be cleared by doing the work teaches its user to ignore the badge. The adapter keeps returning a count, because it is meaningful server-side and is a legitimate cheap trigger; the shaping happens one layer up. `remoteWork` answers `{waiting, complete}`, so a surface counts what it can enumerate and shows a dot for the rest.

`complete` is false when at least one bound service could not be asked. **A failed read is not an empty inbox** — a caller that renders `waiting` without looking at `complete` tells the user nothing is waiting on them when the truth is that nobody knows.

### An unbind keeps the task

`not_ours` is the only failure that drops a binding, and it is reached only from a refusal the adapter positively identified as an ownership one. Everything the user can see is local and survives: goal, status, note, history. What goes is the claim that a copy exists somewhere else, which had stopped being true. `executor` is deliberately **not** moved back to `desktop` — a task that was running remotely is not now running here, and pretending otherwise would put a Stop button over nothing.

### What a failure costs is decided here, not in the adapter

| Adapter code | Consequence |
|---|---|
| `unavailable` | retry on the next pass; the markers stay |
| `rejected` / `invalid_request` / `unsupported` | drop the marker, with a warning. Retrying unchanged fails the same way for ever, and a marker that can never clear makes every later push redo the doomed work first |
| `not_ours` | unbind, with a reason, and never retry |
| anything that is not a `RemoteTaskError` | the adapter broke its own contract. Logged loudly and **retried** — losing a user's edit over an adapter bug is the worse of the two mistakes |

`remoteSyncedAt` means "when this device last got an answer about this task", so it is stamped only when the service actually answered. A **refusal counts** — the server spoke. A pass whose every marker turned out to name a field the service has no room for sends nothing, and stamping it would make the column advance for ever on a service nobody can reach, which is the one reading it exists to rule out.

### One failure never cancels the pass

Each service in a pull, and each task in a `pushAll`, is isolated. It does not take an adapter bug to need this: a push awaits the network and then writes, and a task the user deleted while it was in flight makes that write throw — which without isolation would silently skip every task after it in the list.

## What this deliberately does not do

- **Nothing drives the loop.** There is no timer, no IPC channel and no service caller for `push`, `pull`, `reconcile`, `pullOne` or `remoteWork` — the only production import of this module is `authService`, and it calls `resetCursors` alone (see the next bullet). This is the same shape as the handoff-note writer landing before anything wrote a note, and the adapter seam landing before its first adapter. The producers arrive with the step that folds the `cinna_task` job path onto `adapter.create` + `adapter.execute`; until then the sync loop is written, tested and inert
- **`resetCursors()` is the exception — it does have callers**, both in `authService`, because the hazard it guards against does not wait for `pull` to have a scheduler. A profile id is *this device's*, not the account's, and `registerCinna`'s rebind branch finds a profile row by **email** and refreshes its server URL: so signing in with the same address on a different cinna server lands on the same profile row, keeping its id, its tasks and its cursor. The next pull would then be a **delta rather than the active set** — nothing on the new account older than that cursor is ever fetched, and the reconcile does not run either because the pass count is no longer zero, leaving a half-empty profile with nothing on screen to explain it. `deleteAccount` resets too, which is hygiene rather than a fix: it drops the `users` row as well, so a later sign-in mints a fresh id and the stale entry could never be read. A profile *switch* deliberately does **not** reset — the data is still there, the claim is still true, and re-pulling the active set to learn nothing is a wasted request
- **It never pulls a task that was already finished when the desktop first linked.** The first pull of a session has no cursor and asks for the active set. Incremental pulls do see completions, because a cursor carries no status filter — so anything the desktop watched while it was live stays correct, and historical finished tasks simply never arrive. A volume decision, not an oversight
- **It does not decide who executes a task.** Handing work over and taking it back are `taskService.handOffToRemote` / `takeOver`, and a person's decision
- **It does not read `remote_state`.** That blob is the adapter's own vocabulary and is opaque here, which is why the remote's id for an assignee lives in `assigneeAgentId` — an id in the space its `kind` names — rather than inside the binding. A field only the adapter can read is no use to the code that builds the push
- **It never compares an adapter id to anything.** It asks `capabilities()` and `availability()`; the kind-branch ratchet holds the count of such comparisons outside `src/main/tasks/adapters/` at zero
- **It does not surface anything.** There is no DTO field for `liveSession`, which `fetch` currently pays a request for and the pull discards; the take-over control that needs it arrives with the screen that renders it

## Architecture Overview

```
taskService.<any write>  ->  taskRepo (SQLite, committed)
                         ->  remote_dirty markers (bound tasks only)

taskSyncService.push     ->  adapterFor(binding.adapter)
   fields (one patch, split on refusal)   ->  pushFields
   handoff note                           ->  putHandoffNote
   status: fetch, taskStatusPath, step    ->  pushStatus / archive
                         ->  taskService.markRemoteSynced | unbindRemote

taskSyncService.pull     ->  adapter.list(userId, cursor)
                         ->  upsert -> taskService.create | applyRemoteSnapshot
                         ->  second pass: re-parent orphaned subtasks
                         ->  every 20th pass (and the first): reconcile

taskSyncService.reconcile -> adapter.list(userId, null)
                         ->  live replicas the list omits -> adapter.fetch
                         ->  not_ours -> taskService.remove
```

## Where it lives

- `src/main/services/taskSyncService.ts` — `push`, `pushAll`, `pullOne`, `pull`, `reconcile`, `remoteWork`, `resetCursors`; module-private `pushOne`, `upsert`, `dropMissing`, `resolveParent`, `wouldChange`, `consequenceOf`
- `src/main/tasks/taskStatusPath.ts` — `taskStatusPath(from, to)`, the breadth-first walk. Main-only rather than `shared/`: the renderer has no business knowing a remote exists, and this is the one rule about a *remote's* transition table rather than the desktop's own
- `src/main/services/taskService.ts` — `bindRemote`, `unbindRemote`, `markRemoteSynced`, `applyRemoteSnapshot`, and the `dirtied()` helper every mutator of a bound task passes its patch through. All four end in `written(row)`, so a binding write keeps [the exported note](handoff_note_export.md) current
- `src/main/tasks/adapters/adapter.ts` — `RemoteDirtyField`, `REMOTE_DIRTY_FIELDS`, `isRemoteDirtyField`
- `src/main/db/tasks.ts` — `tasks.remote_dirty` (a JSON array of marker names) and `remote_synced_at`; `taskRepo.getByRemote`, which deliberately returns soft-deleted rows so a pull can tell "the user deleted this here" from "we have never seen it"
- `src/shared/taskStatus.ts` — `VALID_TRANSITIONS` and `REMOTE_WRITABLE_STATUSES`, which the walk is confined to
- Tests: `src/main/tasks/taskStatusPath.test.ts`, `src/main/services/taskSyncService.test.ts` (push and pull), `src/main/services/taskSyncService.reconcile.test.ts`, and the four writers' cases in `src/main/services/taskService.test.ts`

## Integration Points

- [Remote Task Adapters](remote_adapters.md) — the seam this service is the only scheduled caller of
- [cinna-core as a Remote Task Adapter](cinna_adapter.md) — the one adapter this build ships, and the source of most of the rules above
- [The Handoff Note, Exported](handoff_note_export.md) — the file every task write re-exports, which is why a no-op pull must write nothing
- [Jobs](../jobs/jobs.md) — where tasks come from, and where the producers for this service will be wired
- [Cinna Task Run View](../cinna_task_view/cinna_task_view.md) — the read-only view of a `cinna_task` run, which talks to cinna-core directly and predates this service
