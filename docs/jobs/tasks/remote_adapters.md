# Remote Task Adapters

## Purpose

A task always lives in SQLite here. A task may *additionally* be bound to a system that also holds it — cinna-core, or a tracker like Linear or GitHub Issues, or a managed-agent service. Everything system-specific about that second copy lives behind one interface, `RemoteTaskAdapter`, so the rest of the app asks an adapter what it *can do* rather than which service it *is*. It is the same arrangement [Agent Drivers](../../agents/drivers/drivers.md) give agents, for the same reason: the next integration should add a file, not a value to five unions.

## Core Concepts

- **Adapter** — `RemoteTaskAdapter` (`src/main/tasks/adapters/adapter.ts`): create, fetch, list, probe liveness, execute, push, comment, archive, ask and answer for one remote system. Its `id` is stored in `tasks.remote_adapter` and is **opaque outside this folder**
- **Binding** — `RemoteBinding`: the `remote_*` columns as one value — `{adapter, id, key, url, state}`. `key` is the human-facing short code and is display only; `url` is where a person would go to look, `http(s)` or null; `state` is the remote's own vocabulary and **may not be read outside the adapter that wrote it**, which is why `TaskDto.remote` carries the other four fields and not that one
- **Capabilities** — `RemoteTaskCapabilities`: what this adapter can actually do, computed with no I/O and the same on every call. **Callers ask this; they never branch on the id**
- **Null adapter** — what an id this build does not implement resolves to. Every capability false, a `ready: false` availability naming the service, `liveSession: null`, and `UnsupportedRemoteOperation` from gated operations
- **Registry** — `src/main/tasks/adapters/index.ts`. `adapterFor(id)` is **total**: it always returns something adapter-shaped, so no caller has a branch for "there is no adapter for that"
- **Contract suite** — `adapterContract.ts`, the clauses every adapter must satisfy, run over each implementation and over six fakes

## The capability set

| Capability | What it gates |
|---|---|
| `assigneeDirectory` | `listAssignees` returns selectable opaque remote references, names and kinds |
| `create` | work can be *put* on this remote at all. A pull-only remote — a shared board, a read-scoped token — is bound by a pull, and says `false` here |
| `writeStatus` | one status step may be pushed |
| `archive` | the remote can file a task away, through `archive()` — its **own route**, not a status |
| `writeFields` | which of `title` / `description` / `priority` / `assignee` a push may carry |
| `comments` | `addComment` / `listComments` |
| `handoffNote` | the note has somewhere to go: `putHandoffNote` |
| `writeArtifactKinds` | which `TaskArtifact` kinds the remote stores — `file`, `link`, or neither |
| `subtasks` | `listSubtasks` works, **and** `create` accepts a task that has a parent |
| `execute` | the remote can be asked to start working on it |
| `asks` | the remote parks on human input, and this adapter can list and answer those asks |
| `actionRequiredCount` | a cheap "is anything waiting for me" probe |

Two of them are **lists rather than flags**, and both were flags first. A boolean `attachments` would have said "attachments work" and been wrong half the time: cinna stores files and only files, while Linear's attachments are a URL with a title — so an adapter would have been handed the one kind it cannot store and could pass only by rejecting or by quietly posting it as a comment, which is a different capability wearing this one's flag. An empty list is truthy, so the gate is a helper that asks whether a capability allows *anything*; `caps[capability]` would have read "stores no artifact kind at all" as permission to try.

`create` and `subtasks` compose rather than imply: `subtasks` alone means "I can list children I did not make", and `subtasks && create` means a child can be put in the tree.

## Business Rules

- **The adapter owns remote assignee discovery.** The generic task picker submits an adapter id and opaque reference; handoff re-reads the directory and derives the name/kind in main. It does not use the local agent registry or a service-specific renderer hook. See [remote handoff](remote_handoff.md).

- **Callers ask `capabilities()`, never the id.** An operation the capabilities deny is not a runtime condition to be caught — it is a bug at the call site, and calling it throws `UnsupportedRemoteOperation`. A quiet no-op would let a handover that cannot happen report success. This is what makes a poorer remote *expressible* rather than broken.
- **Only `create` invents a binding.** Every other call takes one and returns it, possibly refreshed, never re-identified — *including* the bindings nested inside snapshots. A `fetch` that re-creates the task when the remote answers 404 would have its new id written back, and the original abandoned with the user's comments and attachments on it: from the user's side, a task that "resynced" and a second copy on the web.
- **Ordinary sync follows a committed local write.** The adapter is called after SQLite is committed, so an adapter failure marks the binding stale and is retried — it never fails or rolls back the local write. That is what makes an unlinked profile, an offline laptop and a 500 the same code path. An adapter therefore **rejects rather than swallowing**: what a failure costs is the caller's decision.
- **A status push is one step, not a destination.** The remote validates transitions, so a task that went `new → completed` locally goes up as two calls. Walking the path belongs to the reconciler; an adapter doing it here would be guessing at the remote's table.
- **`archived` never travels as a status.** It is absent from `REMOTE_WRITABLE_STATUSES` (`src/shared/taskStatus.ts`) and is `archive()`'s job — on cinna-core a different route entirely. Without a method of its own, "the user filed it away" could only be expressed by smuggling a status through `pushStatus`.
- **A flat remote never gets a silent orphan.** `create` takes the **parent's binding**, not the local parent id — an adapter holds no mapping from one to the other, so a method that took only the task could be satisfied only by sending no parent at all: the top-level orphan the rule is against, created while reporting success. A parent offered to a `subtasks: false` adapter is `unsupported`; a task that *has* a parent offered with `parent: null` is `invalid_request` and the remote is never asked.
- **A remote ask is a run event's `InputRequest`.** A cinna tool question and a parked local permission reach the inbox in the same shape, so one component renders both and there is no second union to drift. Answering an ask that is no longer open is `{delivered: false}` — the commonest thing that happens to an ask, and an answer rather than a failure; it is what `AgentDriver.respond` already returns for a local park.
- **The handoff note is first-class, not a comment with a magic type.** Posting it as a `result` comment would have written a *cinna* literal outside this folder, in a field no ratchet watches — and an adapter with `comments: false` would have had no channel for the note at all, so a managed-agent service could not be handed over to. The desktop side of the same string is [the exported file](handoff_note_export.md).
- **What goes out is this app's vocabulary; what comes back is the remote's.** `RemoteCommentDraft.type` is the closed set `note | result | system`, because callers outside this folder choose it. `RemoteComment.type` on the way in is an open string: refusing a remote's own comment vocabulary would be the desktop arguing with the system doing the work.

### Liveness is a question, not a snapshot field

`RemoteTaskAdapter.liveSession(userId, binding)` returns `true | false | null`: working, stopped, or unable to tell. It has no capability flag because the third answer already expresses that limitation. `RemoteTaskSnapshot` carries the task’s durable fields and no liveness field. The task page asks separately when it needs to shape Take over; the take-over service asks again after the press, because a cached answer cannot authorize a later claim.

A failed probe remains a rejection at the adapter boundary. The caller decides that a failure means “cannot tell” and asks for confirmation. Inferring liveness from `status` instead both blocks safe take-overs and permits competing workers, since a service’s status can lag or outlive its sessions.

## Failure codes

`RemoteTaskError` carries one of five codes, and the distinctions are load-bearing:

- `unsupported` — the capabilities say no. A call-site bug.
- `invalid_request` — the call does not make sense and **the remote was never asked** (a subtask with no parent binding). A call-site bug reached with the capability present.
- `unavailable` — no profile, no network, a 5xx. Retry on the next pass.
- `rejected` — the remote understood and refused: an illegal transition, a field it will not take. Retrying unchanged fails the same way, so back off — but the task is still there and **the binding survives**.
- `not_ours` — the remote says the task is not this account's, or is gone. **Unbind, with a reason, and never retry.**

**An HTTP status is not enough to answer `not_ours`, and on cinna-core it is not close.** A non-owner is a 400 there, and so is an illegal transition, and so is a status outside the allowed set — all three through one handler. "400 means `not_ours`" would turn the most ordinary mistake in this area (pushing a status *destination* instead of a step) into a **permanent unbind**: the desktop drops the binding, the remote copy is stranded where it was, and no retry can re-link it. A bug that would have looked like a network fault would instead have looked like a deletion. So an adapter answers `not_ours` only for a 404, or for a refusal it has positively identified as an ownership refusal; every other refusal is `rejected`.

## The registry

- `adapterFor(id)` never returns null and never throws. An unknown id gets a null adapter that keeps the id, so `binding.adapter === adapter.id` holds exactly as for a real one and the reason can name the service the task claims to be on.
- **One null adapter per id**, cached. Nothing keys on adapter identity today; something will, and a factory minting a fresh object per call is the kind of trap that surfaces in a `useMemo` dependency or a `Map` key.
- **A duplicate id throws.** Two adapters answering to one name is a collision with no symptom — whichever registered last wins, silently, and the tasks bound to the other start talking to it. Registering the *same* instance twice is fine: a double import is not a collision.
- **Implementations register from the foot of `index.ts`, not from app boot.** A missed wiring line or a tree-shaken side-effect import would mean every bound task opens perfectly, shows the null adapter's reason, syncs nothing, iterates nothing, and logs nothing — indistinguishable from a build that genuinely lacks the adapter, which is precisely the state the null adapter exists to make comfortable.

## A task bound to a service this build does not have

This is a normal state, not an error: the row carries whatever `remote_adapter` string was written by an older build, a newer one over device sync, or a feature since removed. The task still opens — its title, status, handoff note and history are all local. The null adapter reports `ready: false` with a sentence saying the task is on a service this version of Cinna does not know about, that everything on the page is stored here, and that nothing is being sent to that service.

## The contract suite

`adapterContract.ts` holds the clauses; `adapterContract.test.ts` runs them. **The suite owns the assertions** — a world only says how to build the adapter and how to make its far side misbehave, so an adapter cannot pass by describing its own behaviour back to the suite. `knownViolations` records a clause an adapter does not satisfy, with a reason, and a recorded violation that *starts* passing fails the suite, so the record has to be deleted in the commit that fixes it rather than rotting into a ceiling.

Six of the subjects are fakes: a full service, Linear (status, no asks, no execute, no nesting, link attachments), GitHub Issues (no agent assignee, no nesting, no action-required probe), a managed-agent service (asks, no comments), a remote the desktop may only read, and the null adapter. The named risk they answer is a seam shaped by a single implementation — an interface drawn around one remote acquires its field names and breaks on the second. **The caveat that goes with them is that they all speak the seam's vocabulary already, so what they prove is that the capability set can describe six services, not that a real mapping survives.**

The seventh and eighth subjects are the answer to that caveat: [the cinna-core adapter](cinna_adapter.md) itself, on a linked profile and an unlinked one, driven over a fake *server* rather than a fake adapter. Everything below the transport there is production code — the routes, the payload field names, the status refusal, the ask translation, the error taxonomy — and the fake refuses the way the real service refuses. It passed the clauses on its first run with no `knownViolations` entry, so the seam did not have to move for its first real mapping; what moved was everything around it.

Clauses, by name: `id.stable`, `capabilities.stable`, `availability.answers`, `create.binds`, `create.only_inventor`, `handoffNote.lands`, `unsupported.refused`, `supported.works`, `status.narrow`, `subtasks.no_orphan`, `asks.run_vocabulary`, `failure.is_domain`, `not_ours.no_retry`, `rejected.keeps_binding`, `deepLink.openable`, `count.counts`.

Two properties of the clauses are easy to lose and are held on purpose: a refused operation must **not touch the far side** (the world counts requests), and every binding a call hands back — nested in a snapshot included — must carry a `url` that is null or `http(s)`, because that is what the task page opens and `app:open-external` refuses every other scheme.

## No service may be named outside this folder

`src/main/tasks/adapters/` is the only place an adapter id is compared to anything. The kind-branch ratchet (`src/main/agents/kindBranches.test.ts`) counts that as its `remoteAdapter` category, allowlists this folder, and holds the count at **zero** — so the first `if (task.remoteAdapter === 'cinna')` written anywhere else fails a test instead of shipping.

The category counts an **equality comparison against an adapter id**, not a read of `remote_adapter`: `taskRepo`, `taskService` and `schema.ts` read the column to ask *whether* a task is bound and to pass the opaque id through to the DTO, and counting those would have entered the category non-zero on code that branches on nothing. Comparisons through a constant (`CINNA_ADAPTER_ID`) and through an adapter object (`cinnaTaskAdapter.id`) are counted too — the second is the *natural* way to write the branch once a real adapter exists, because it reads more correct than a magic string does. The known gap is a subject renamed off the word the pattern looks for (`adapterId === 'cinna'`, a bare `id === 'cinna'`); widening the subject to any identifier would count the legitimate `=== 'cinna'` comparisons in the account-type and file-scope code, so it stays a recorded blind spot.

## What this deliberately does not do

- **It ships one adapter.** The registry holds `cinna`; a test asserts its registration so the null adapter cannot hide a missing import. Job handover, run refresh and take-over controls reach adapters through [the sync service](remote_sync.md). The active-profile scheduler also runs dirty push, pull and periodic reconciliation; the adapter does not own those timers.
- **No read half for artifacts.** `putArtifact` is the seam's only write-only channel — comments and asks both have a `list*`, and a snapshot carries no artifacts — so a replica's remote attachments are invisible here. The capability is named `writeArtifactKinds` so the absence is a statement in the type rather than a gap in a docstring; a `listArtifacts` is additive when a surface needs one.
- **No push subscription.** Every adapter is polled. A later adapter may expose a subscription and be preferred over polling; nothing here builds one.
- **The renderer never sees which service a task is on beyond its display fields.** `TaskListQuery` has no `remoteAdapter` arm, and `TaskDto.remote` omits `state`.

## Architecture Overview

```
taskService (SQLite write, committed)
        |
        v
 taskSyncService (scheduled push/pull; watched refresh; handover IPC)
        |
        v
 adapterFor(binding.adapter) -> RemoteTaskAdapter
            |                          |
     null adapter                 cinnaTaskAdapter
 (unknown id: refuses,          (create / fetch / push /
  says so in words)              comments / asks / archive)
```

## Where it lives

- `src/main/tasks/adapters/adapter.ts` — the interface, `RemoteTaskError`, `UnsupportedRemoteOperation`, the binding/snapshot/ask/comment shapes, and `RemoteDirtyField`, the names a pending change is recorded under
- `src/main/tasks/adapters/index.ts` — `adapterFor()`, `registerAdapter()`, `hasAdapter()`, `allAdapters()`, and the import list implementations join
- `src/main/tasks/adapters/nullAdapter.ts` — `createNullAdapter(id)`
- `src/main/tasks/adapters/cinnaTaskAdapter.ts` + `.wiring.ts` — the one implementation this build ships ([its own doc](cinna_adapter.md))
- `src/main/tasks/adapters/adapterContract.ts` — `describeAdapterContract(name, world, options?)`, `AdapterWorld`, the clause union
- `src/main/tasks/adapters/testSupport/fakeRemote.ts` — the configurable fake and `CAPABILITY_SHAPES`, the worked services
- `src/main/tasks/adapters/testSupport/fakeCinnaServer.ts` — cinna-core in memory, so the real adapter can be a contract subject
- `src/shared/taskStatus.ts` — `REMOTE_WRITABLE_STATUSES`, the vocabulary a status push is narrowed to
- `src/shared/tasks.ts` — `TaskDto`, `TaskRemoteRef`, `TaskArtifact`

## Integration Points

- [cinna-core as a Remote Task Adapter](cinna_adapter.md) — the first implementation, and where every cinna field name lives
- [Keeping a Bound Task in Step](remote_sync.md) — who calls an adapter, in what order, and what a failure costs
- [The Handoff Note, Exported](handoff_note_export.md) — the local side of `putHandoffNote`
- [Agent Drivers & Readiness](../../agents/drivers/drivers.md) — the same capability-not-kind arrangement, one layer down
- [Cinna Task Run View](../cinna_task_view/cinna_task_view.md) — the read-only view of a `cinna_task` job run, which talks to cinna-core directly and predates this seam
- [Jobs](../jobs/jobs.md) — where tasks come from today
