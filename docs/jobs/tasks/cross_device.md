# A Task on the User's Other Devices

## Purpose

A task travels between the devices of one Cinna account as the fifth [app-sync](../../sync/data_sync/data_sync.md) collection, so the work a job started on the desktop is visible on the laptop. Exactly one device at a time is allowed to speak for a task's **run**, and the rest of this document is about that: which device that is, what it alone may write, and what the task page offers on a device that is only holding a copy.

## Core Concepts

- **The claim** — `tasks.executor_device`, the sync device id of the device running the task. `taskRunsHere` (`src/shared/tasks.ts`) is the rule that reads it, and it is shared by main and the renderer so the two cannot drift about who may write
- **This device's sync id** — `sync_state.device_id`, assigned by the server when the device enrolls. **Null until a profile has ever synced**, and null reads as "here": a profile with sync off is the only device there is, so there is nobody to disagree with
- **Peer copy** — the row app-sync wrote here for a task another device created or is running. Deliberately not called a *replica*: [remote sync](remote_sync.md) already uses that word for a copy of a task that lives on a **service**, and the two are different relationships
- **Take over** — the one write that moves the claim to this device (`taskService.takeOver`). A claim, not a lock; see below
- **`TaskDto.runsHere`** — `taskRunsHere` already applied, computed in main because the renderer has no way to ask which device it is

## What travels and what does not

| Carried | Left behind |
|---|---|
| The work: title, goal, description, status, priority, router, origin, parent, handoff note, artifacts, budget, error message, and the `created`/`started`/`finished`/`deleted` timestamps — `createdAt` included, unlike a job's, because the page prints it and a replica stamping its own arrival would say every task in the user's history began the moment this device joined the account | **`chat_id`** — chats are not a synced collection, so an id from another device would name a row that does not exist here |
| The claim: `executor` and `executor_device` — which is the whole point of it, since it is how the other device knows not to run this | **`assignee_agent_id`** — an `agents` row id is device-local. A portable descriptor travels in `assignee_ref` instead and is resolved on the way in |
| The **remote binding** (`remote_adapter`, `remote_id`, `remote_key`, `remote_url`, `remote_state`), so a peer opens the same [bound task](remote_sync.md) rather than creating a second one | **`remote_synced_at`** and **`remote_dirty`** — per-device bookkeeping. A device that has never spoken to that service must not inherit a watermark saying it has, nor a list of fields *this* device still owes it |
| `job_id` / `job_run_id`, carried as-is and tolerated as dangling: jobs sync, job runs do not, so a peer can name the job a task came from but never the run | |

The assignee descriptor is the same `JobDepDescriptor` a job's dependencies use, and **nothing is auto-created from it**: a device that does not have the agent resolves it to null, keeps the descriptor verbatim, and re-emits it byte for byte — so the assignee re-attaches by itself the day that agent appears here. A job's manifest auto-creates a disabled shell on a miss; a task deliberately does not, because a profile syncs a great many tasks and the user's Agents list would fill with rows they never asked for, from work that already finished somewhere else.

## Business Rules

### Only the holder writes the run

`status`, `assignee` and `handoffNote` follow the run, so only the device the claim names may write them; `requireRunsHere` refuses the rest with *"This task is running on another device"*. `title`, `description`, `priority` and `router` are writable from any device whatever the claim says — fixing a title on the machine in front of you is not a claim on the run.

### The claim is respected on the way **in** as well as on the way out

App-sync is **whole-record** last-writer-wins: one `client_updated_at` per record, and the winner's every column is written. So the ungated title edit above pushes the whole of the other device's row — including its stale copy of the three guarded fields — under a newer timestamp, and the holder applied that back over what its own agent had just produced. **The handoff note, the finish time and the error reason were destroyed on the one machine that had them.** `respectingTheClaim` closes it: a record arriving for a task this device holds keeps this device's `status`, `startedAt`, `finishedAt`, `errorMessage`, `handoffNote` and the four assignee columns.

The guard is narrow on purpose. It holds only while **this device is the named holder and the arriving record still agrees that it is**:

- a record naming a *different* holder is a take-over, and the new holder's values are the ones that count — it yields entirely
- a `null` claim confers nothing. It means nobody in particular, and treating it as authority would let two devices each keep their own version for ever with nothing to converge on
- a task this device has soft-deleted, and a task running on a bound service rather than on a desktop, are both outside it

### A merged record does not converge until the holder writes again

When the guard keeps this device's run fields, the merged row is **not** re-pushed. The peer and the server keep the copy they had until the holder's next write, which is the ordinary way it converges. Re-pushing on apply is the other design, and it is the one that loops.

### A null claim used to mean two different things

`taskRunsHere` reads null as "here", which is right for a profile that has never synced. The moment a device enrolls it stops being right: those tasks travel with a null claim and read as *mine* on every device the account has, so pressing Run on the second one passes `requireRunsHere` and starts a second run of a task the first is already streaming. Enrolment is therefore where "nobody's" becomes "this device's" — `taskService.adoptUnclaimed`, called from the one place a device id can be recorded (`adoptDeviceId` in `syncService`, on both the first-device `init` path and the register path). Any device that enrolls later gets a different id and correctly sees those tasks as somebody else's.

Tasks that can never start again are skipped — `isUnstartable`: `completed`, `cancelled` and `archived`, the last of which `taskRepo.list` already excludes along with soft-deleted rows, so naming it in the predicate is belt-and-braces rather than its only guard. A profile's history is most of its tasks, and claiming all of it would bump `updated_at` across the lot to write a claim nobody reads. **`error` is deliberately not in that set**, and its absence is the point: `error → in_progress` is a legal transition and the task page's re-run control is exactly that transition. While the skip was written as "has stopped" it covered `error` too, so every failed task made before a profile had a sync identity kept its null claim — on precisely the rows the re-run is offered for — and read as *this device's* on every machine the account had.

### Which device this is, is never guessed

`identifyThisDevice` (`src/main/sync/deviceIdentity.ts`) answers from the account's device list two ways, and they are not the same kind of sure: a **matching public key** is proof, and **exactly one device on the account** is the shape `init` produces. Anything else is a guess between several real machines and the answer is **null**. The positional `devices[0]` fallback it replaced was harmless while `device_id` only selected a key envelope; it stopped being harmless the moment that id became the input to write authority over a run, because a device that adopted another device's id would see that device's tasks as its own and pass every guard.

### Take over claims, and does not run

One write. `executor_device` moves here and the page re-renders with the controls it was refusing to show; the second press is the user's. "This is mine now" and "go" are two decisions, and a task that may be mid-turn somewhere else is the worst case in which to take the second on the user's behalf.

It is offered where the work has **stopped** (`blocked`, `error`) and withheld while it is **streaming** (`in_progress`), because the claim does not stop the other device. Both outcomes of a mid-run take-over are bad, and the button has no third one: the other device's turn ends, its `applyRunState` hits `requireRunsHere`, throws into a best-effort catch, and the task sits `in_progress` for ever — or the run finishes first and whole-record LWW writes its own row back, silently undoing the claim.

A task a bound **service** is running gets the same treatment across the seam, for the identical reason — claiming does not stop the other worker. `RemoteTaskAdapter.liveSession(userId, binding)` answers `true | false | null` and is asked **once, by a person about to press Take over**, not on every pull pass, because it is a question about this moment and nobody is waiting on the answer at any other one. The three shapes are deliberately the device arm's three: an agent working there gets the sentence and **no control**; nothing working there gets *Take over*; a service that cannot say — unreachable, or bound by a build this one has no adapter for — gets an extra line saying so and *Take over anyway*, because a service nobody can reach must not hold a task hostage. `taskSyncService.takeOver` enforces the refusal again on the way through, since the probe is one round trip older than the press.

### A person's write is nudged; a run's own progress is not

`syncService.markDirty` is called from `task.ipc.ts`, not from `taskService`, so the debounce covers `update`, `set-status`, `take-over` and `delete` and nothing else — and it is called **after** the write, so a refused write never announces itself. A run reports itself several times a turn through `applyRunState`, and debouncing a full sync cycle onto each of those is chatty for a row that is changing on its own; those ride the 60 s periodic cycle. Take-over is the one that most needs the nudge — its whole purpose is to tell another device it has lost the claim, and a minute of silence there is a minute in which both devices believe they own the run.

There is also a layering reason it cannot live in the service: `sync/collections.ts` imports `taskService` (the apply path goes through it so [the exported note](handoff_note_export.md) follows the row), and `syncService → syncEngine → collections → taskService` would close a cycle if the service imported `syncService` back. Nothing imports `ipc/`.

### The task page looks live, and is not

`useTask` re-reads every five seconds and stops once the task is settled — but it re-reads the **local** row, so nothing a peer wrote appears until a sync cycle has run. Two things run one: opening the page (`useSyncOnViewOpen`, throttled to one server ping per 8 s) and the 60 s periodic cycle. A pulled change surfaces through `data-changed` → the `['task']` query key, which is the prefix of every task page's key.

### The banner never names the device

`executor_device` is a sync device id; the names behind those ids live in the account's device list on the server, which this page has no read of and which can fail. A sentence that said "MacBook Pro" only after a second network round trip would also change width under the pointer, which `ux_rules.md` §1 forbids — so the generic sentence, which is always right, is the one that is shown.

## What the page does with a peer copy

The claim arm runs **before every other arm** of the attention block, because each of the others offers something this device cannot do to a task it does not hold: the re-run would be refused by `requireRunsHere` in main, and *Open the Inbox* would point at a list that cannot contain the ask — `task_input_requests` never syncs, so an ask only ever exists in the inbox of the device that raised it.

| Status | What the page shows |
|---|---|
| `in_progress` | A neutral sentence — *"This task is running on another of your devices."* — and **no control**. Neutral rather than amber because §2's banner is for something that needs attention, and a task another device is working on perfectly well is reporting, not warning |
| `blocked`, `error` | *"This task stopped on another of your devices. Take it over to pick it up here."* plus **Take over**. `error` also prints the reported error under the button |
| `new`, `open`, `completed`, `cancelled`, `archived` | Nothing. **Every** task a peer created carries that peer's claim from the moment it was created, so a set defined by exclusion put a banner on every task the user had ever made on their other machine — and a finished task keeps the claim of whichever device ran it, so there is nothing there to take over |

The **Take over** button sits on the right of its own row: a different row from *Open the Inbox* and a different edge from *Re-run from the last message*, because these arms replace each other on a poll and a control must never land on the pixels of one that sends a message. The spinner replaces the button's icon rather than its label, which would have grown the button under the pointer.

## What this deliberately does not do

- **It is not a lock.** Nothing on the server arbitrates; the claim is a value two devices agree to read. What it guarantees is only that two devices cannot both *believe* they own a run without one of them having written that it did.
- **It does not stop the other device.** A take-over is a statement about this device, and the other machine finds out on its next pull.
- **It does not carry the conversation.** A peer copy has `chatId: null`, so *Re-run from the last message* has nothing to send there even after a take-over, and the page says so. What a take-over buys today is the right to move the task's status and to be the device that writes the run when work does start here.
- **It does not sync the inbox.** `task_input_requests` is not a collection: a `reply` ask is an address on the machine that raised it, and it dies with the driver process holding it.
- **It does not validate what arrives.** No transition check (the peer is reporting what happened on the device that was running the work), no `requireRunsHere` (a copy of a task another device runs is the point) and no parent check. The rules here are about what *this* device may initiate.
- **It does not carry a hard delete.** A task's only delete is soft and travels as an ordinary upsert with `deleted: true`. The tombstone arm exists because every collection must answer one, and because a record a mapper ignores is one the server hands back on every pull for ever.

## Architecture Overview

```
this device                                    another device
-----------                                    --------------
task.ipc (user's write) -> taskService -> row
                        -> syncService.markDirty (1.5s debounce)
                                       -> syncEngine push -> Cinna app-sync store
                                                                 |
 taskService.applySyncedTask <- taskMapper.apply <- pull <--------+
   respectingTheClaim (keeps this device's run fields)
   -> taskRepo.upsertFromSync -> row
   -> taskFileService.exportHandoff / removeHandoff

renderer: useSyncOnViewOpen (page open, 8s throttle) -> sync.syncNow
          data-changed -> invalidate ['task'] -> TaskView
          TaskDto.runsHere -> ElsewhereBanner -> tasks.takeOver
```

## Where it lives

- `src/shared/tasks.ts` — `taskRunsHere(task, thisDeviceId)` and `TaskDto.runsHere`
- `src/shared/sync.ts` — `SyncCollection`, which `task` is the fifth member of
- `src/main/sync/deviceIdentity.ts` — `identifyThisDevice(devices, myPublicKey)`, a pure module with no runtime imports
- `src/main/sync/collections.ts` — `taskMapper`: `listDirty` / `maxUpdatedAt` / `apply`, and the four columns it leaves out
- `src/main/sync/manifest.ts` — `buildTaskAssigneeRef(userId, task)`, the assignee descriptor built at encode time
- `src/main/sync/resolvers.ts` — `resolveTaskAssignee(profileUserId, desc)`, the lookup that never auto-creates
- `src/main/services/taskService.ts` — `applySyncedTask`, `removeSyncedTask`, `adoptUnclaimed`, `takeOver`, the private `respectingTheClaim` and `requireRunsHere`, and `toTaskDto(row, thisDevice, counts)` whose device argument is required rather than defaulted (the honest default is `null`, which reads as "this device owns everything it can see")
- `src/main/services/syncService.ts` — `adoptDeviceId`, the only writer of `sync_state.device_id`
- `src/main/db/tasks.ts` — `listChangedSince`, `maxUpdatedAt` (SQLite `max()`, seconds → ms), `upsertFromSync` (the one writer allowed to touch a soft-deleted row), `deleteOwned`
- `src/main/ipc/task.ipc.ts` — `task:take-over`, and the `markDirty` calls on the four writes a person makes
- `src/renderer/src/hooks/useTasks.ts` — `useTakeOverTask`, `useTask` (5 s poll of the local row)
- `src/renderer/src/hooks/useSync.ts` — `useSyncOnViewOpen`, `SYNCED_VIEWS`, and `task → ['task']` in `COLLECTION_QUERY_KEYS`
- `src/renderer/src/components/tasks/TaskView.tsx` — `ElsewhereBanner`, `CLAIM_MATTERS`, and the `neutral` banner tone
- Tests: `src/main/sync/taskCollection.test.ts` (what travels, the claim on the way in, adoption), `src/main/sync/deviceIdentity.test.ts`, `src/main/services/deviceAdoption.test.ts` (the call site, read out of the source), `src/main/ipc/task.ipc.test.ts` (which writes nudge sync), `src/renderer/src/components/tasks/TaskView.test.tsx`

## Integration Points

- [Native Client Data Sync](../../sync/data_sync/data_sync.md) — the engine, the crypto and the other four collections
- [The Handoff Note, Exported](handoff_note_export.md) — why the apply path goes through `taskService` and not `taskRepo`
- [Keeping a Bound Task in Step](remote_sync.md) — the other direction a task can exist twice in, and the columns of that relationship which deliberately stay on one device
- [Jobs](../jobs/jobs.md) — where tasks come from, and the run history row that opens the task page
