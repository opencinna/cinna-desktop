# Keeping a Bound Task in Step

## Purpose

A task bound to a remote system exists twice: as a row in this device's SQLite, and as whatever that service holds. `taskSyncService` coordinates the [remote task adapter](remote_adapters.md) calls that keep the copies in step and move execution between them: pushing local changes, pulling remote changes, reconciling replicas and handing work over.

**The active profile is kept in step in the background.** `taskSyncScheduler` starts a push-then-pull pass on activation and waits five seconds between completed passes. Focus and wake request catch-up; deactivation, profile replacement, suspend and quit invalidate pending work. Job handover, run refresh and task-page watched reads use the same coordinator. This carrier is independent of encrypted app-sync unlock.

## Core Concepts

- **Dirty marker** — an entry in `tasks.remote_dirty` (`RemoteDirtyField`): one of `title`, `description`, `priority`, `assignee`, `status`, `handoffNote`. A marker is a statement that *this device knows something the remote does not*. `taskService` adds them on a **bound** task's own mutations — `update`, `setStatus` (and so `applyRunState`), `setAssignee`, `setHandoffNote`, `start` — and the push clears one only when the service has actually been told. Two absences are deliberate: `acceptRemoteStatus` marks nothing, or every pull would queue a push of what it had just been told, and an unbound task is left alone, so the column stays null for the overwhelming majority of tasks and a later bind starts from a clean slate
- **Replica** (`origin: 'remote'`) — a task that exists here because a pull created it. The service is the original
- **Mirror** — a task created here and also put on a service. The desktop copy is the original; the binding is a claim that a second copy exists
- **Status path** — the *sequence* of status writes that moves a remote from where it is to where the local task is, rather than the destination on its own (`taskStatusPath`, `src/main/tasks/taskStatusPath.ts`)
- **Cursor** — per `(profile, adapter)`, the `updated_since` timestamp the next pull asks from. In memory, so a restart costs one active-set pull
- **Remote work** — `{waiting, complete}`: whether anything on a bound service is waiting on the user, and whether every bound service could be asked. Deliberately not a number

## The five jobs

| Job | What it does |
|---|---|
| `push(userId, taskId)` / `pushAll(userId)` | Send the dirty markers: the writable fields in one patch, the handoff note, and the status as a path. Serialised per task |
| `pull(userId)` / `pullOne(userId, taskId)` | Take everything the service changed since the cursor and write it locally, creating a replica for anything new |
| `reconcile(userId)` | Ask whether replicas the service no longer lists still exist, and drop the ones it says are gone |
| `remoteWork(userId)` | Ask each bound service whether anything there is waiting on a human |
| `handOff` / `takeOver` / `liveSession` | Move the executor across the seam, with a fresh liveness check before taking remote work back |

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

### Remote status finishes the current attempt

`taskService.persistRemotePatch` writes the merged remote task and projects its status into the matching active job attempt in one SQLite transaction. It reads the stored row after dirty-field protection, so an unaccepted remote value cannot finish a run. Projection requires a remote executor, no unresolved handoff receipt, a scoped pending/running attempt linked back to the task, and exact equality between the attempt's `localChatId` and the task's current `chatId`, including null. A retained job link is provenance after a new conversation starts; it does not authorize rewriting that earlier attempt.

`jobRunStatusForTask` in `src/shared/taskStatus.ts` maps completed/archived to succeeded, error to failed, cancelled to cancelled, new to pending, and other states (including blocked) to running. A failed projection carries the task's error. Terminal attempt rows are left alone, preserving their finish time and error across forced refreshes. `jobService.refreshCinnaRun` asks for a pull but does not repeat the status write. Jobs and run-history queries poll every five seconds only while their cached rows contain active attempts; this also updates local jobs handed to a remote service.

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
- **only replicas the desktop still believes are live.** A finished replica is absent from the active set by construction, so confirming them all would be one detail request each at every app start and every twentieth pull, for work nobody is waiting on. The consequence, stated rather than hidden: a replica that finished here and was *then* deleted on the service stays as local history — the better of the two wrongs, since it is a record of work that really happened

The confirming `fetch` is not thrown away. A replica the desktop still calls live which the service does not list as active has usually finished there with the delta missed, so the snapshot that proves it exists also brings it up to date.

### A delete is invisible to a cursor, so full pulls include reconciliation

The first pull of a session always reconciles — a fresh process has no cursor and is already asking for the whole active set, so the "full reconcile on start" falls out of the design rather than needing a column. After that it is every twentieth pull, keeping the extra confirmation off most passes. These are completed-pull counts, not a wall-clock guarantee: the scheduler waits five seconds after work settles, and a contended pull retains its cursor/pass count so a skipped result is retried.

### The cursor overlaps itself by a second, and only advances on a new maximum

A service that filters `updated_at > cursor` **strictly** never returns a change made in the same instant as the newest row a pull saw — it falls into the gap between two passes and stays there, for ever. A second of overlap closes it and costs nothing, because the upsert is idempotent and skips owed fields.

Applying the rewind unconditionally has two costs that are invisible until they are not: an idle profile widens its own window by a second per poll, and the newest row is re-read on every pass for ever. So the cursor moves only on a new maximum, and an upsert that would change nothing writes nothing — otherwise the steady state of an idle profile is a database write **and a filesystem write** (every task write re-exports [the handoff note](handoff_note_export.md)) per poll, describing a change that did not happen.

That "would this change anything" question is asked about the **outcome**, field by field, rather than about timestamps. Timestamp columns here are second-resolution, so a `Date` carrying milliseconds never compares equal and the guard would silently never fire; comparing at second resolution instead discards a real edit made within the same second as the last one.

### The first pass asks twice, because the active set has no history in it

A pass with no cursor asks for the adapter's active set, and on cinna-core that filter excludes `completed`, `cancelled` and `archived`. A task that finished *before* this profile's first pull is therefore unreachable by every route the service offers: the first pass drops it by status, and each later pass is a delta that mentions it only if somebody touches it again. The seam that produces is at the moment of linking — work finished ten minutes earlier is missing while work finished ten minutes later is present, with nothing to explain the difference.

So the first pass makes a second, **cursored** `list` covering `FIRST_PASS_BACKFILL_MS` (a week) and merges it with the active set by remote id. A cursored list carries no status filter, which is what makes it the only route by which a terminal task arrives at all — and it is *paged*, by advancing the cursor, so it is one request per page rather than one request flat. A wider window is more pages, all awaited before the first upsert.

The **later** list wins the merge. The two are sequential round trips, not one instant: a task that changes between them is in both with different contents, and keeping the first-fetched copy would write the staler one — a task that completed mid-pass recorded as still running.

Three things follow that are easy to get wrong. The merged list is what gets upserted, but the **active set alone** is what the reconcile is handed: the history is mostly terminal tasks, and offering them as "still listed as active" is a claim about the service that is not true. The history request is **isolated in its own try/catch** — the active set has already been fetched by then, and letting a failure escape would discard it, leave the pass count at zero and repeat the same failure for ever, so a service that answers the active set and times out on the larger cursored one would sync nothing at all. And the window is a per-app-start cost, not a per-poll one — later passes have a cursor.

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

## Scheduling and Watched Reads

**One pass, then a delay.** `taskSyncScheduler` calls `pushAll` before `pull` for the active profile, then arms a five-second timeout after completion. It never queues one pass per elapsed interval. Multiple focus/catch-up requests during work become one trailing pass. Activation starts immediately; main-window focus refreshes, OS suspend pauses, resume catches up, and deactivation/quit stop the timer. Adapter availability decides whether a profile can use a service, so this loop does not depend on encrypted app-sync being unlocked.

**Stopping a timer is not stopping its work.** Lifecycle changes invalidate the profile’s service generation while keeping valid cursors. Push batches check before each task, queued pushes check before beginning, and reads/pushes check generation and binding around awaited adapter operations. An already issued request may finish, but it cannot authorize the next operation or apply a late local result. The scheduler waits for that operation to return before its trailing pass; Cinna’s HTTP deadline bounds individual requests.

**One current read per scope.** Full pulls coalesce per profile; detail pulls coalesce per local task. Pushes remain serialized per task. A watched detail first waits for an already-running full pull and for the task’s queued push. Without that first wait, a five-second task-page poll repeatedly invalidated a slow history pass, keeping it on its first window forever.

**Binding revisions order responses without comparing clocks.** Each push boundary and accepted detail/full/reconcile response advances an in-memory revision for the profile/adapter/remote-id binding. A read whose revision changed discards its response; dirty markers alone were insufficient because a successfully completed push had already cleared them before an older detail response arrived. The same guard applies to ownership refusals before unbinding/deleting. If a full pass skips a contended snapshot, it retains the cursor and first-pass flag so a different row’s newer timestamp cannot make that skipped work disappear from future deltas.

**The task page opens from SQLite, then refreshes.** `task:get` calls `getWatched`: return the saved DTO immediately and start `pullOne` for a binding. Bound task pages keep their five-second polling even after a terminal status, since the service can change or remove finished work. Unbound settled tasks stop polling. A failed or unavailable detail refresh records an ephemeral `remote.refreshError`, returned on the next watched read and shown through the page’s stale footer. A successful detail clears it. The error is neither persisted nor synced; it does not stop the page opening offline.

## Moving execution across the seam

### Desktop to service

The task page's remote agent picker and `jobService.executeCinnaTask` both call `taskSyncService.handOff`. It shares the task's writer queue, reserves local execution, validates the captured claim/context after waits, and records acceptance or uncertainty durably. Accepted work commits its remote executor, selected assignee, note, status and receipt together, then appends a transition message to the existing chat.

A lost create/execute response cannot be treated as a retryable refusal: the service may already have created or started the work. Unresolved receipts block outgoing pushes and local starts; uncorrelated creates also defer discovery rather than importing a duplicate. The full ordering, journal states, dirty-marker policy and recovery controls are in [Remote handoff and recovery](remote_handoff.md).

### Service to desktop

1. The task page probes liveness separately from its local task read. The probe has a five-second UI deadline and a one-minute cache; the deadline does not cancel the underlying request.
2. While checking, the banner names the wait. A live agent gets a sentence and no Take over control. A stopped agent gets **Take over**. Unknown liveness gets an explanation and **Take over anyway**; that label and sentence are the confirmation, without a modal.
3. `task:take-over(taskId, force?)` probes again. `true` refuses even when forced; `null` requires `force: true`. A stale probe’s refusal stays beside the button and triggers a fresh probe.
4. `taskService.takeOver` changes the executor and device claim. It starts no work and sends no stop or status command to the remote. A separate **Continue** gesture starts a new desktop conversation for a task without a local chat.

The remote banner precedes local re-run controls for `in_progress`, `blocked` and `error`. A blocked task with enumerated asks has **Open the Inbox** in a separate left-hand slot, while takeover stays on the right; answering a question is not a claim on execution. Reserved liveness and control rows keep a late answer from moving the page under the pointer. A task that lost its binding can still be claimed: the probe answers false locally rather than waiting forever for a disabled query.

## What this deliberately does not do

- **There is no remote subscription.** The scheduler polls adapters, the Inbox separately enumerates known blocked tasks, and `remoteWork` still has no production caller. Task data stays local-first; a watched read starts refresh without awaiting the network.
- **`resetCursors()` and `forgetBindings()` protect account changes**, both in `authService`, because a profile id can outlive the account its remote bindings name. A profile id is *this device's*, not the account's, and `registerCinna`'s rebind branch finds a profile row by **email** and refreshes its server URL: signing in with the same address on a different cinna server lands on the same row, keeping its id, its tasks, its cursors *and* every `remote_*` column on them. The cursor half would make the next pull a **delta rather than the active set** — nothing on the new account older than that cursor ever fetched, and no reconcile either because the pass count is no longer zero. The binding half is worse because it is written down: a replica keeps a short code and a deep link into a server this profile can no longer see, and a mirror keeps a remote id belonging to another account. The reconcile cannot clean either up — it skips mirrors by design and skips *terminal* replicas as a per-poll cost it refuses to pay, which is exactly the set that would otherwise survive for ever. So a rebind whose server URL changed calls `forgetBindings`, which **unbinds without deleting**: a replica degrades into an ordinary local task, an honest record of work that really happened, while the wrong links and push targets go. Deleting instead would be a destructive write on a sign-in path, and now that the [`task` collection syncs](cross_device.md) it would carry that delete to the user's other devices — as an ordinary upsert marked deleted, since a soft delete is not a tombstone — which is a much larger claim than "this profile changed accounts". `deleteAccount` resets cursors too, which is hygiene rather than a fix: it drops the `users` row as well, so a later sign-in mints a fresh id and the stale entry could never be read. A profile *switch* retains the cursor and bindings — the account has not changed — but invalidates pending operations so late results cannot continue the previous activation’s pass.
- **It pulls finished history only as far back as a week.** The first pull of a session has no cursor and asks for the active set, which excludes everything completed, cancelled and archived — so the first pass also makes one *cursored* request covering the last seven days, because a cursor carries no status filter and is the only route by which a terminal task arrives at all. Without it there was a visible seam at the moment of linking: work finished ten minutes before was missing while work finished ten minutes after was there. Anything older than the window still never arrives, which is the volume decision — `FIRST_PASS_BACKFILL_MS` is one constant, and the screen that lists remote tasks is the right place to revisit it. The window costs one request per page on the first pull of a session, not on every poll
- **Taking over claims; Continue starts.** After a no-chat task is claimed here, the task page offers a local agent/default-model selector and Continue. `taskExecutionService` creates the conversation and dispatches the full goal, distinct description and handoff note through the shared executor, preserving task/binding/job provenance. See [task start](tasks_tech.md). The separate remote **Hand off** picker invokes the same handover service as jobs.
- **It does not read `remote_state`.** That blob is the adapter's own vocabulary and is opaque here, which is why the remote's id for an assignee lives in `assigneeAgentId` — an id in the space its `kind` names — rather than inside the binding. A field only the adapter can read is no use to the code that builds the push
- **It never compares an adapter id to anything.** It asks `capabilities()` and `availability()`; the kind-branch ratchet holds the count of such comparisons outside `src/main/tasks/adapters/` at zero
- **Liveness is not persisted or polled with task snapshots.** The task page asks `task:remote-live` separately; a failed probe becomes unknown, and `takeOver` probes again before changing the executor.

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

## Credential replacement during a request

The shared Cinna HTTP transport captures the credential-session generation and server base before awaiting an access token, then checks both immediately before fetch. Re-authentication/re-linking cannot make a pending old request use the replacement session; it fails before dispatch with `CinnaSessionChanged`, an operation-retry error that does not request another sign-in. Silent token rotation preserves the generation and proceeds. This preparation guard complements the coordinator’s generation/binding checks on responses; it does not retract an already-sent mutation. See [token lifecycle internals](../../auth/cinna_accounts/token_lifecycle_tech.md#http-credential-preparation-guard).

## Watched children

Opening a root task also watches its children. `task:children` calls `taskSyncService.getChildren`, which returns SQLite rows immediately with `TaskListSnapshot.refreshed` and optional `refreshError`. The background `listChildren` uses the adapter’s full subtask list, so a child completed before the active/delta cursor can still appear under its parent. `task:list` remains a local-array read.

Reads coalesce per profile/parent and wait for the current profile pull and parent detail/push. They recheck profile generation, binding and root/child relationship before applying, accept only the same adapter/remote parent, and compare each child’s revision with the pre-read snapshot. A concurrent unchanged parent detail must not invalidate useful child data. Responses do not remove saved children merely because a remote omitted them. Active or durable unresolved creates defer child imports, just as they defer full discovery, until the new remote identity can be resolved without a duplicate.

The renderer polls the snapshot every five seconds. Both a first offline read and a later failure retain known children; the footer reports the failed refresh and offers retry. Before the first successful refresh, an empty snapshot says loading rather than “No subtasks.” Local-only parents return a confirmed local snapshot without contacting an adapter.

## Where it lives

- `src/main/services/taskSyncScheduler.ts` — activation/focus/resume carrier, coalesced trailing pass and completion-based timer; lifecycle hooks in `src/main/auth/activation.ts` and `src/main/index.ts`.
- `src/main/services/taskSyncService.ts` — `getWatched`, `getChildren`, `listChildren`, `invalidatePending`, `handOff`, `takeOver`, `liveSession`, `preferredAdapterId`, `push`, `pushAll`, `pullOne`, `pull`, `reconcile`, `remoteWork`, `resetCursors`, `forgetBindings`; module-private `pushOne`, `upsert`, `dropMissing`, `resolveParent`, `wouldChange`, `consequenceOf`
- `src/main/tasks/taskStatusPath.ts` — `taskStatusPath(from, to)`, the breadth-first walk. Main-only rather than `shared/`: the renderer has no business knowing a remote exists, and this is the one rule about a *remote's* transition table rather than the desktop's own
- `src/main/services/taskService.ts` — `bindRemote`, `unbindRemote`, `markRemoteSynced`, `applyRemoteSnapshot`, and the `dirtied()` helper every mutator of a bound task passes its patch through. All four end in `written(userId, row)`, so a binding write keeps [the exported note](handoff_note_export.md) current
- `src/main/tasks/adapters/adapter.ts` — `RemoteDirtyField`, `REMOTE_DIRTY_FIELDS`, `isRemoteDirtyField`
- `src/main/db/tasks.ts` — `tasks.remote_dirty` (a JSON array of marker names) and `remote_synced_at`; `taskRepo.getByRemote`, which deliberately returns soft-deleted rows so a pull can tell "the user deleted this here" from "we have never seen it"
- `src/shared/taskStatus.ts` — `VALID_TRANSITIONS` and `REMOTE_WRITABLE_STATUSES`, which the walk is confined to
- Tests: `src/main/tasks/taskStatusPath.test.ts`, `src/main/services/taskSyncService.test.ts` (push and pull), `src/main/services/taskSyncService.reconcile.test.ts`, `src/main/services/taskSyncScheduler.test.ts` (activation, stop, suspend and catch-up), and the four writers' cases in `src/main/services/taskService.test.ts`

## Integration Points

- [Tasks](tasks.md) and [the Inbox](inbox.md) — durable task UI and live ask enumeration; the five-second Inbox poll does not schedule a remote task pull.

- [Remote Task Adapters](remote_adapters.md) — the seam used for handover, refresh and reconciliation
- [cinna-core as a Remote Task Adapter](cinna_adapter.md) — the one adapter this build ships, and the source of most of the rules above
- [The Handoff Note, Exported](handoff_note_export.md) — the file every task write re-exports, which is why a no-op pull must write nothing
- [Jobs](../jobs/jobs.md) — creates tasks and hands remote runs over here; their run status is derived from the refreshed task
- [Cinna Task Run View](../cinna_task_view/cinna_task_view.md) — the read-only view of a `cinna_task` run, which talks to cinna-core directly and predates this service
- [A Task on the User's Other Devices](cross_device.md) — the other way a task exists twice: `remote_synced_at` and `remote_dirty` are the two columns of *this* relationship that deliberately never leave the device that owns them
