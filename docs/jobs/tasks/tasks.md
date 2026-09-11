# Tasks and the Inbox

## Purpose

A task is the durable record of work: its original goal, current status, assignee and handoff note remain available after a run or conversation closes. The Inbox gathers answerable questions and permissions from local runs and bound remote services, so the user can respond without finding the conversation that raised them.

## Core Concepts

- **Task** — one piece of work with an immutable goal and editable description. A job is its reusable specification; a run is one attempt; a chat carries the conversation.
- **Origin** — where the task was created, local or remote. It does not change when execution moves.
- **Executor** — where execution belongs now, desktop or remote. A desktop task also carries a device claim; claiming work and starting it are separate actions.
- **Binding** — the adapter and remote task identity that connect the local record to a service. SQLite remains the desktop's store even when the service is unreachable.
- **Inbox entry** — an open input request associated with a task. Local entries persist the driver's live reply address; remote entries are fetched from the service and create no local request record.
- **Handoff note** — what the next worker needs to continue. Its database value is also exported as a file for tools outside the app.

## User Stories / Flows

1. **Run saved work.** Execute a job; its attempt receives a task. Open the task from the run history to see the goal, status and available actions, then open its conversation or service view when needed. Deleting the run does not delete the task's record of the work.
2. **Answer a local agent.** A parked question or permission in a chat appears in the Inbox. A hand-opened chat acquires a task at its first persisted ask. Answer from the Inbox, keep the outcome visible, and return to the task or conversation.
3. **Answer remote work.** A locally known blocked task on an ask-capable adapter contributes its live questions to the same Inbox. Its task page offers **Open the Inbox** separately from takeover. A failed delivery keeps the question dialog and draft available for retry.
4. **Keep remote work current.** The active profile pushes local edits and discovers remote tasks automatically, with five seconds between completed passes. Focus and wake catch up. A bound task page opens its saved record immediately, refreshes in the background and marks failed remote refreshes as stale.
5. **Move execution.** A job can hand its task to a connected service. The task page checks remote liveness before offering takeover; a live remote agent cannot be taken over. Taking over claims the task without starting a conversation. See the current completion gaps below.

## Business Rules

- **The task outlives an attempt.** Status and provenance belong to the work; conversation and run links may disappear without erasing its goal or history.
- **Local writes are local first.** Network failures do not undo a task edit. Bound changes accumulate dirty markers for the adapter coordinator; device sync is a separate path.
- **Validate status writes; accept remote facts.** The desktop uses the shared transition table. Pulled status is accepted as the service's fact. Run state maps into task state at the recording boundary, rather than becoming a second task vocabulary.
- **A device claim controls execution fields.** The holder may write status, assignee and handoff note. A peer editing a title must not overwrite those fields with its stale copy.
- **An ask has one rendering.** The Inbox reuses the transcript's permission and question blocks. It counts requests, not a service's notification counter, which may count multiple activities for one question.
- **An unread Inbox is not empty.** Failed reads preserve the last successful list with an error indication. The badge and task actions cannot infer that nothing is waiting from stale data. The current complete-array contract also means one unavailable remote delays newly arriving local entries; it does not return a misleading partial success.
- **Answering remote work does not guess its status.** Another session may still be blocked. The remote remains authoritative until the task is refreshed.
- **A failed question delivery keeps the draft.** The modal stays open, disables edits and dismissal while sending, and shows the refusal beside the submission control. An acted-on Inbox card remains until the user leaves the view.

## Current Completion Gaps

- Taking over a task without a local conversation has no desktop-start control yet. There is no general task hand-off IPC/picker; jobs are the production handover entry point.
- A `next_message` ask has no parked reply address and writes no Inbox row. A hand-opened chat does not acquire a task for it; a job's completion path can still finish a task whose A2A agent requested the user's next message. This continuation lifecycle remains separate from the completed `reply` ask path.
- Headless execution, coordinator handback, the script router and attach/replay remain later runtime work; protocol updates, managed/SSH drivers and the final kind-branch cleanup are not supplied by this polling carrier.
- Partial Inbox reads need an explicit completeness contract before locally available entries can remain current through a remote outage. Returning a local-only successful array would make the waiting count and re-run gate wrong.

These are remaining implementation boundaries, not claims that the task runtime phase is complete.

## Architecture Overview

Job or chat → task service → SQLite task → task page.

Run input event → persisted local request; blocked bound task → remote adapter asks; both → Inbox → shared request block → local driver or remote adapter answer.

Task writes → device sync and handoff export; activated profile / focus / wake → task sync scheduler → dirty push then remote pull/reconcile → bound service.

## Integration Points

- [Technical details](tasks_tech.md) — schema, IPC and implementation entry points.
- [The Inbox](inbox.md) — request identities, failure policy, polling and answer retries.
- [Jobs](../jobs/jobs.md) and [Cinna task view](../cinna_task_view/cinna_task_view.md) — reusable work, attempt history and the service conversation.
- [A chat's first ask](chat_tasks.md) — lazy task creation and chat-owned completion.
- [Remote adapters](remote_adapters.md), [Cinna mapping](cinna_adapter.md) and [remote coordination](remote_sync.md) — capability contract, service translation and executor handover.
- [Device ownership](cross_device.md) and [handoff export](handoff_note_export.md) — portable work and its local file view.
