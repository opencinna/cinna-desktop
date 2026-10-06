# Handover Bus — durable work between agents

## Purpose

A folder agent can ask another adopted folder agent or a connected cloud assignee to do work, finish its own turn, and receive the result later. The request creates separate work: the requesting task keeps its executor, and a delegation links it to the task doing the requested work.

The [file protocol](file_handovers.md) remains usable by a terminal, script or person. The bus adds discovery, session-scoped tools and a shared lifecycle across files, kit agents and cloud tasks.

## Core Concepts

- **Delegation** — a device-local, profile-scoped record of one request, its origin, target, task, result, gate and return delivery. It survives task deletion so a retried request cannot silently create the same work again.
- **Channel** — how the request reaches its executor: `file` for a bare folder, `local` for a kit agent, `cloud` for a remote task adapter. The result and wake rules are shared.
- **Requester id** — an immutable id supplied by the requesting agent, unique for its origin, target and adapter within the profile. Repeating the same request returns its existing work; changing its contents under that id is refused.
- **Origin** — the requesting agent, chat and optional task. Main derives these from the tool session. A file origin is validated before it becomes a wake address or determines the owning profile.
- **Root and depth** — delegation-chain identity independent of the task tree. A first delegation has depth 1; an executor may delegate once more, at depth 2. A third step is refused. The chain also counts the requesting task's own [chain depth](agent_task_tools.md#who-may-create): a delegation is one deeper than the greater of its parent delegation's depth and that task's, so a task an agent put in its own queue cannot be used to start a fresh chain.
- **Group** — several delegations from the same origin chat sharing a group id. Their final results return together; a question for the requester returns immediately.
- **Gate** — the ordinary Inbox question through which the desktop asks permission to start delegated work.
- **Question audience** — who can answer a blocked result: the requester agent or the user. A local executor chooses with `tasks_report`'s `audience` (the requester when left out); a cloud result says it itself, and one that says nothing is the user's. A user question is not answered by the requesting agent and does not wake it.
- **Return packet** — the desktop-authored system turn that brings a result to the requesting chat. Its first line is always `Task result from <agent> on <ref>: <status> — <summary>`, the [Cinna Task Protocol](task_protocol.md)'s result prefix, on every channel and for a group too: the skill and the prompt tell an agent to recognise a result by those words.

## User Stories / Flows

### Request work and continue

1. A folder agent calls `tasks_targets` to discover its targets: for each, the exact `target` string, its name, kind (`folder`, `kit`, `cinna`), whether it runs locally or remotely, its folder, what its channel supports (`structured_report`, `reply`, `priority`, `custom_fields`, `attachments`), whether it accepts delegations, and whether a person must approve the run (`requires_approval`). No path or remote-assignee guessing is needed.
2. It calls `tasks_create` with that `target` as `assignee`, an id, a title and the brief as `description` — the [agent task tool](agent_task_tools.md) that also creates own-queue work; with an assignee it is exactly this request, and there is no separate create tool. It leaves `execution` out unless the user must approve this run: `ask` forces a gate, and otherwise the standing permission below decides. The request returns before the executor finishes, naming the delegated task's `ref`.
3. For a bare target, main writes the real brief, appends reporting instructions and requests an immediate file scan. The response includes its brief, report and revision paths. A requester that can already write the file directly may use the file protocol instead; engine sandbox rules still apply.
4. For a kit target, main creates a task and starts a separate chat on that agent's runtime after admission. For cloud, main creates a separate child work item through the selected adapter, then dispatches it after admission.
5. The requester ends its turn. A result later arrives as a desktop-authored system turn in the same requesting chat, waiting for that chat to become idle.

`tasks_list` with `relation: delegated` answers a status question about work this agent requested, and `tasks_get` reads one delegated task with its delegation's state and result. Neither is a wait primitive: an unchanged repeated list within one turn explicitly tells the agent to end its turn. The wire-only turn header's counts line includes `open delegations: N` (with how many wait on the user) while any remain, and leaves it out at zero ([The Cinna Task Protocol](task_protocol.md#the-context-block-is-data-never-instructions)).

### Approve a request

The Inbox card identifies **Cinna Desktop** as the asker. The card names the agent that will run the work and the one that asked: a card reading "the selected local agent" asked the user to approve a stranger. Its options are, in this order, **Run**, the standing permission, and **Skip** — the same words and order as the [file gate](file_handovers.md), so one action has one label wherever the user meets it. Run starts this request; Skip cancels its task and settles the delegation; the standing option runs it and saves the grant from the table below. A bare target's card is the file gate itself, which leaves the standing option out when git forbids it.

An answer is matched against the options stored on the open card, not against labels rebuilt at answer time. The standing option carries an agent's name, and an agent renamed between asking and answering otherwise turned the user's click into a malformed answer.

| Target | Standing permission | Additional condition |
|---|---|---|
| Bare folder | Receiving agent's **Handovers** | Git must not track the handover directory and must ignore it when the folder is a repository |
| Kit agent | Receiving agent's **Delegations** | None beyond the agent being eligible and enabled |
| Cloud assignee | Requesting agent's **Cloud delegations** | Connected adapter must support the required dispatch capabilities |

All three default to asking. **The standing permission decides**: a request that says `execution: auto`, or says nothing, runs without a gate where the grant is set and asks where it is not. A requester can only force a gate — an explicit `execution: ask` always asks, grant or no grant. Requiring the request to name `auto` as well made auto-run look as if it worked only sometimes, because the protocol text agents copy said `ask`. Cloud consent belongs to the agent sending the brief because that agent chooses the content leaving the machine and the work that may incur charges.

### Report and answer

An executor reports with `tasks_report` from the conversation working on the delegated task: `in_progress`, `blocked`, `done` or `failed`, a required one-line summary, and optionally a question, an audience, artifacts (paths or URLs) and a full Markdown body. The same tool reports on an agent's own task; on delegated work it goes through the bus, so it sets the task, wakes the requester and counts toward a group. `tasks_update` cannot close delegated work at all. File executors can keep writing `report.md`; a tool report does not require a report file, and a bare executor whose task has a file handover but no delegation row found for it reports through the file channel's own report path instead.

A `blocked` report is for the requester unless it says `audience: user`. A requester question wakes the requester at once, even in a group. A user question leaves the delegation **Waiting on you** and wakes nobody; the requester hears when the work ends. For a kit executor there is no Inbox card for it: the question stands in the task's handoff note on its page, and the user answers by typing in the executor's own conversation, whose next `tasks_report` settles the delegation as any report does.

A requester calls `tasks_reply` with the delegated task's `ref` (the delegation's own id is still accepted) for a blocked result or follow-up. The file channel publishes the next immutable revision. The local channel persists a reply before queuing a turn on the existing executor chat. The cloud channel answers only a structured requester-directed question with a matching open ask; a user-directed question must be answered in the Inbox.

### Follow links

The task Details panel shows **Delegated from** on requested work and **Delegated to** on its requester. These links are separate from **Parent task** and **Subtasks**. File tasks retain the file-specific Folder and Note rows; local and cloud tasks show their delegation state, and a cloud task also shows where it runs (the remote task key); a local task has no such row. Deleted tasks remain identifiable as unavailable work rather than becoming new requests. A Delegated to row whose state is uncertain, failed or refused also shows its note beneath the state, on one truncated line with the full text on hover, so a poll cannot grow the row under the reader: those are the states where the label alone leaves the user nothing to act on, and the reason otherwise lived only on the other task's page. For an uncertain or failed cloud dispatch the note is the dispatch's own reason, which says what to check; the row's warning is often only a capability remark and explained nothing. A failed read of the links shows its retry row only when there is nothing to show — a background refresh that fails keeps the links already on screen.

## Business Rules

### Ownership and permissions come from main

Tool callers cannot supply a profile, origin chat, task or depth. Each operation validates that the active profile still owns the session and that the chat still answers to its agent. Admission rechecks after asynchronous directory reads, and cloud operations reject stale connection/profile generations. A validated file origin pins its owning profile; another active profile does not take the request over. The one exception is an origin chat shared across profiles ([Settings Scope](../../core/settings_scope/settings_scope.md#shared-local-chats)): the chat is the guest's, but the work started from it is the active profile's, so the active profile takes the handover in, keys its rows to itself and pays for it. With sharing off, the same brief resolves to the guest profile and stays foreign to a signed-in one.

Delegations and Cloud delegations permissions live under `userData` for both bare and kit agents. A kit manifest, a pulled folder or a synced task cannot grant them. Removing the agent's local state removes these grants. Engine approvals remain a separate boundary: admitting a task does not waive permissions for the commands it runs.

A chain started outside the app never uses the standing Cloud delegations grant. When the requesting executor's own delegation, or the root of its chain, has an `external` origin (a brief written from a terminal) or the reserved `remote_task` origin, a cloud request asks in the Inbox with the grant set, whatever it says about `execution`: nobody in the app chose what is about to leave the machine, and the grant was given for work the user's own agents start.

Depth is derived, and a brief can only raise it. A file brief that names no origin task has its chain looked up through the origin chat's task, and the recorded depth is the greater of the derived and the declared one. An executor that left `origin.task` out, or wrote `depth: 1`, would otherwise have been given a fresh chain and the cap would have stopped nothing. The chain's root comes from that same lookup, so a brief naming only `origin.chat` stays in its writer's chain, and the outside-origin rule above still reaches a cloud request made further down it.

A repeated request stays the same request when its chat gained a task in between. The origin key includes the origin task, so the lookup also tries the chat-only origin the first call was recorded under; without that the retry missed its own earlier row and delegated the work twice.

### Files remain an interoperable channel

Main may write requester briefs and revisions through the offered tools. It does not write reports, edit a ready brief, or tidy protocol files. New files are published whole using an exclusive temporary file and an atomic hard link that refuses an existing destination; protocol directories and file leaves reject symlinks. A collision cannot overwrite an external request.

A bare tool request may create a `draft`; it is not admitted until made `ready`. Retrying the tool with the same draft returns that draft and does not promote or edit it. Direct file writers retain responsibility for whole-file publication and the immutable-after-ready rule.

### Result and return delivery

- A structured report owns task status, note and artifacts. It beats the ordinary turn-ending fallback; a revision that ends without another report still receives outcome handling.
- A blocked requester question wakes immediately, even in a group. A blocked user question does not wake the agent; terminal cloud results do return regardless of their earlier question audience.
- A group final packet waits for every member to settle (`done`, `failed`, `skipped` or `refused`) and includes every member, including one whose earlier question already woke the requester.
- Wake acknowledgments are matched to the result digest captured when delivery was queued. An older queued result cannot acknowledge a newer report and suppress its return.
- Before starting the requester turn, the queue rechecks the active profile and result identity. Superseded packets are dropped; failed delivery releases its claim for a later retry. A fresh cloud question id counts as a new question even when its wording is unchanged.
- The queue waits up to 30 minutes for a chat to become idle. A failed delivery remains visible and an unacknowledged result can be retried; persistence does not promise exactly-once turn admission across a crash.
- Only an owed packet is retried: the row holds a result, was never acknowledged, and its delivery was not refused (`wake_refused:*`) and its report was not unparseable. A refusal is final, and a row with no result was never owed a packet; retrying either opened a paid turn in the origin chat on every minute tick.
- A handover that settled before the delegation journal existed is recorded as already delivered when it is backfilled. It is not news, and left unacknowledged it would have woken its origin chat on the first tick after the upgrade.
- An executor waiting on its own outbound delegations is not finished. One that delegated onward and ended its turn, as `tasks_create` tells it to, is a relay: its row stays running, and no "without a report" packet reaches its requester while a child is still open or owes it a packet. Delegations made from the executor's chat count as well as those from its task, including ones unrelated to the work it was handed.
- The turn a child's packet opens in the relay's chat is watched like the relay's first turn. A relay that answers with `tasks_report` settles through it; one that answers in plain text settles `done` with the no-report warning, and its text is the body the requester receives.
- A child's question to the relay stops counting once its packet has been delivered: the child now waits on the relay, and counting it too would leave each waiting on the other when the relay answers in plain text instead of `tasks_reply`. A child waiting on the user still holds the relay; that wait is the user's.
- A user Stop of a waiting relay's turn does not settle it while its children are running. The children are the live work, and they would come back to a relay already closed.
- When a child finished but its packet was refused (its origin chat was deleted, say), the relay is no longer waiting, and the lost-run sweep fails it with "The work it handed on finished, but its result could not be delivered to this executor." rather than calling its run lost.
- A single (ungrouped) local or cloud packet names the executor by its display name (else its agent id) and the delegated task's ref in its first line, then the delegation's requester key, target and task, the remote task (key and URL) when it has a URL, and the cloud warning as a note, so a requester reading a fallback result knows it is one and where the full work is. A question in it ends with how to answer: `tasks_reply` with that task's ref. A group packet's first line names every member's agent and the group, and each member line its agent.

### Recovery preserves uncertainty

The app must be open to scan or reconcile. Activation, focus, wake and the minute scheduler catch up saved requests. Missing gate cards are repaired; a task already linked to its executor chat is not blindly started again. A missing/deleted task projects as skipped and does not prevent other delegations from reconciling.

Local replies are saved as pending before queuing. A pending reply can be recovered after restart. A reply marked sending when the process died is visibly uncertain and is not sent again automatically, because the executor may already have accepted it.

Cloud dispatch journals creation, upload and execution before network effects. Interrupted creation is replayed only where the adapter supports idempotent create; ambiguous execution/upload remains uncertain instead of creating or running duplicate work. Capabilities are negotiated: structured metadata/results and attachment access are used when available. Older servers expose missing-attachment access and treat an unclassified blocked question as belonging to the user.

A profile or connection change in the middle of a dispatch is never a failure, because the service refused nothing. If no upload or execution had been sent, the journal returns to the acknowledged create and the next reconcile on that profile resumes from there; otherwise the delegation is uncertain. Recording it as failed told the requester that work had been refused which was merely waiting for its profile to come back.

While a cloud create is unacknowledged, the ordinary task pull for that service imports nothing and keeps its cursor. The remote task has no local binding yet, and a pull that met it would import it as somebody else's work beside the delegation's own task. As with an unresolved [remote handoff](remote_handoff.md), this can delay unrelated discovery on that service until the create resolves.

That hold must always be able to end. A create whose child task the user has since deleted does not count, because nobody will retry it. A create that can no longer be retried at all — its child task is no longer its own independent task, is no longer assigned to the approved cloud target, or its service has gone away or can no longer create and execute work — is settled as uncertain rather than failed, since the first attempt may have landed remotely. Either one, left in place, was refused again on every tick and held every import for that service back for good.

When a cloud task carries no structured result, the result is read from the task itself: the status decides the outcome, and the body is the latest `result` comment or, where none was filed, the remote agent's own `message` comments. Messages are kept from the newest backwards until a 3500-character budget is spent, then put back in order: the budget sits below the return packet's own body cap, so the fallback chooses what is dropped and the agent's final answer survives. Filled from the oldest, a long conversation lost exactly its last message to the cut. Only comments authored by the agent count, so a user's note on the task is never mistaken for the answer. Agents that answer in plain messages were otherwise returned as a bare status with none of the work. The delegation records a warning saying the fallback was used.

A terminal status beats a stale structured result. A task that ended after its question was answered keeps `in_progress` as its last structured result, and one somebody finished or answered on the web keeps `blocked`; either is ignored once the task is completed, failed, cancelled or archived, and the outcome is settled from the status through the same fallback. A task that has ended is not waiting on a question. Otherwise the delegation stayed running, or blocked on a question nobody could still answer, and the requester was never woken.

A kit executor with no live turn or open question is failed after the two-minute lost-run grace period; a pending local reply holds that off, and so does a delegation of its own it is still waiting on. The bus applies this test to the local channel only. File rows are swept by the [file channel](file_handovers.md), where a run between two queued revisions is not a lost one, and a cloud executor keeps running after this desktop closes, so an absent desktop run means nothing for it.

### Deliberate limits

Inbound cloud-to-local delegation is postponed. Origin types reserve room for it; no remote event starts local work through this bus. No OS background worker runs while the app is closed, no sandbox writable-root expansion is installed, and a delegation is not a synchronous subagent call or a parent/subtask relation.

Structured cloud results depend on the service, not on this app. cinna-core appends reporting instructions to the first message of a task executed with delegation metadata, and its agent environments carry a report tool (`tasks_report` on their own `cinna` server under the protocol, `handover_report` before it); with both, a cloud agent can ask the requester a question, receive the `tasks_reply` and file `done`. `tasks_targets` says which a cloud target has (`capabilities.structured_report`, `reply`) from the server's negotiated support. The tool is part of the built environment, so an environment built before it existed needs a rebuild to gain it. Until then that agent cannot file a structured result or ask the requester a question. It is read through the comment-and-status fallback above: its questions reach the user, not the requesting agent, and `tasks_reply` has nothing to answer.

## Architecture Overview

Folder session → session-scoped loopback MCP → main delegation service → permission gate → file intake / local task execution / remote adapter → shared result lifecycle → queued system turn in requester chat.

The renderer reads links and state and changes permissions through narrow IPC. It does not construct origins, dispatch work, perform file IO or enforce admission policy.

## Integration Points

- [File Handovers](file_handovers.md) — interoperable brief/report/revision contract and bare-folder git gate.
- [Tasks](tasks.md) and [Inbox](inbox.md) — durable work, related-task navigation and human questions.
- [Agent Permissions](../../agents/local_agents/permissions.md) — engine approvals and device-local delegation grants.
- [Remote Task Adapters](remote_adapters.md) — capability-based remote dispatch; existing [remote handoff](remote_handoff.md) moves a task, while delegation creates separate work.
- [ACP Contract](../../agents/local_agents/acp_contract.md) — measured folder-write and loopback MCP boundaries for the pinned engines.
- [Technical details](handover_bus_tech.md) — ownership, persistence and implementation entry points.
