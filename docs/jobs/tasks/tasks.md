# Tasks and the Inbox

## Purpose

A task is the durable record of work: its original goal, current status, assignee and handoff note remain available after a run or conversation closes. The Inbox gathers answerable questions and permissions from local runs and bound remote services, so the user can respond without finding the conversation that raised them.

## Core Concepts

- **Task** — one piece of work with an immutable goal and editable description. A job is its reusable specification; a run is one attempt; a chat carries the conversation.
- **Origin** — where the task was created, local or remote. It does not change when execution moves.
- **Executor** — where execution belongs now, desktop or remote. A desktop task also carries a device claim; claiming work and starting it are separate actions.
- **Binding** — the adapter and remote task identity that connect the local record to a service. SQLite remains the desktop's store even when the service is unreachable.
- **Inbox entry** — an open input request associated with a task. Local entries persist a live driver reply address, durable next-message continuation or runner gate; remote entries are fetched from the service and create no local request record.
- **Handoff note** — what the next worker needs to continue. Its database value is also exported as a file for tools outside the app.

## User Stories / Flows

1. **Browse work.** Open Jobs and use its Tasks section to open a root task, including work with no job or open ask. A root page lists Subtasks; a child page offers **Parent task**. Finished children can be discovered from the parent even when the service’s active list omits them.
2. **Run saved work.** Execute a job; its attempt receives a task. Open the task from the run history to see the goal, status and available actions, then open its conversation or service view when needed. Deleting the run does not delete the task's record of the work.
3. **Answer an agent running here.** A parked question/permission or A2A next-message question appears in the Inbox. A hand-opened chat acquires a task at its first persisted ask. Answer from the Inbox and keep the outcome visible. A next-message answer continues the same agent/chat/task in main without navigating away; its pending request survives app restart.
4. **Answer remote work.** A locally known blocked task on an ask-capable adapter contributes its live questions to the same Inbox. Its task page offers **Open the Inbox** separately from takeover. A failed delivery keeps the question dialog and draft available for retry.
5. **Keep remote work current.** The active profile pushes local edits and discovers remote tasks automatically, with five seconds between completed passes. Focus and wake catch up. A bound task page opens its saved record immediately, refreshes in the background and marks failed remote refreshes as stale.
6. **Move execution.** On a desktop task, press **Hand off**, choose a remote agent and supply the handoff note. Jobs use the same handoff service. Accepted work moves to the service and leaves a receipt in its existing conversation. An uncertain result offers **Review pending handoff** before execution can continue here. The task page checks remote liveness before offering takeover; a live remote agent cannot be taken over. Taking over claims the task without starting a conversation. For a task with no local chat, choose an available agent or **Default chat model**, then press **Continue**. Main starts one new conversation with the goal, distinct description and handoff note, and opens it after acceptance.

7. **Run on its own.** An existing coordinator chat can start an [autonomous task](autonomous_tasks.md). Main coordinates consecutive owner turns, waits for durable Inbox answers and offers explicit recovery after interruption. Leaving the conversation does not stop it; closing the app does.

## Business Rules

- **Browsing does not start work.** Root and child rows open the same task page. Lists show the most recently updated work first, initially twenty rows with **Show more tasks** for another twenty. They exclude archived records by default.
- **Saved children survive a failed refresh.** Opening Subtasks returns saved rows immediately and refreshes the remote parent’s children in the background. A failure leaves those rows visible with a retry message; an unconfirmed empty read does not claim there are no subtasks.
- **Starting here keeps the work.** Continue reuses the task and its remote/job provenance; it does not create another job attempt or reuse the remote protocol session. A refused start keeps the selected target and task page open. Changing the target clears the old refusal. Pending controls disable in place.
- **Start only work this device owns.** Existing conversations continue through their own controls. Active turns, pending local questions, script tasks and completed/cancelled/archived tasks cannot be replaced by a new start. Failed tasks may be retried. Agent readiness and model configuration are checked before dispatch, with profile/claim/configuration rechecks after asynchronous preparation.
- **A lost acknowledgement is not a refusal.** A durable handoff receipt blocks another local start and outgoing task writes until explicit recovery. Known-live remote work cannot be taken over; an unknown result requires an explicit continue-anyway decision. Recovery remains available if the task was deleted or the agent directory is offline.
- **Remote completion finishes the current attempt.** A handed-off job follows the remote task’s result. Older attempts retain their recorded outcome, including after the task starts a new local conversation.
- **The task outlives an attempt.** Status and provenance belong to the work; conversation and run links may disappear without erasing its goal or history.
- **Local writes are local first.** Network failures do not undo a task edit. Bound changes accumulate dirty markers for the adapter coordinator; device sync is a separate path.
- **Validate status writes; accept remote facts.** The desktop uses the shared transition table. Pulled status is accepted as the service's fact. Run state maps into task state at the recording boundary, rather than becoming a second task vocabulary.
- **A device claim controls execution fields.** The holder may write status, assignee and handoff note. A peer editing a title must not overwrite those fields with its stale copy.
- **An ask has one rendering.** The Inbox reuses the transcript's permission and question blocks. It counts requests, not a service's notification counter, which may count multiple activities for one question.
- **An unread Inbox is not empty.** Failed reads preserve the last successful list with an error indication. The badge and task actions cannot infer that nothing is waiting from stale data. The current complete-array contract also means one unavailable remote delays newly arriving local entries; it does not return a misleading partial success.
- **Answering remote work does not guess its status.** Another session may still be blocked. The remote remains authoritative until the task is refreshed.
- **A pending continuation prevents premature completion.** Normal turn completion and restart preserve next-message asks. Answers settle only their agent’s requests; sibling asks prevent task/job finalization. A stale card cannot resume settled or remotely claimed work.
- **A child ending affects its own asks.** Root/invocation ownership prevents a late resolution or child failure from consuming another invocation’s question. Answering any one request recomputes the task’s blocked state from all surviving siblings.
- **An explicit ending closes idle continuations.** Completing, failing, cancelling or archiving a task expires its next-message requests and settles its linked active job attempt; stale cards cannot restart it.
- **A failed question delivery keeps the draft.** The modal stays open, disables edits and dismissal while sending, and shows the refusal beside the submission control. An acted-on Inbox card remains until the user leaves the view.

## Current Completion Gaps

- [Autonomous coordination](autonomous_tasks.md) supplies multi-turn execution, durable runner gates and specialist handback using existing [live attachment/replay](../../chat/messaging/live_runs.md). [Script definitions](script_definitions.md) now validate, persist and sync, but graph execution remains unfinished. Schedules, manifest-driven handback, complete token accounting, protocol updates, managed/SSH drivers and the final kind-branch cleanup remain separate work.
- Partial Inbox reads need an explicit completeness contract before locally available entries can remain current through a remote outage. Returning a local-only successful array would make the waiting count and re-run gate wrong.

These are remaining implementation boundaries, not claims that the task runtime phase is complete.

## Architecture Overview

Job or chat → task service → SQLite task → task page.

Take over → device claim; Continue → task execution preflight → new chat + transactional message/task binding → shared main executor → accepted chat navigation.

Run input event → persisted local request; blocked bound task → remote adapter asks; both → Inbox → shared request block → local driver reply, same-chat next-message continuation or remote adapter answer.

Task writes → device sync and handoff export; activated profile / focus / wake → task sync scheduler → dirty push then remote pull/reconcile → bound service.

## Integration Points

- [Script definitions](script_definitions.md) — portable agent aliases, validated graph/template data and the current execution boundary.
- [Autonomous tasks](autonomous_tasks.md) — coordinator controls, local checkpoints, limits, queues and interruption recovery.
- [Remote handoff and recovery](remote_handoff.md) — selected remote destination, durable uncertainty, shared jobs path and recovery controls.
- [Technical details](tasks_tech.md) — schema, IPC and implementation entry points.
- [The Inbox](inbox.md) — request identities, failure policy, polling and answer retries.
- [Jobs](../jobs/jobs.md) and [Cinna task view](../cinna_task_view/cinna_task_view.md) — reusable work, attempt history and the service conversation.
- [A chat's first ask](chat_tasks.md) — lazy task creation and chat-owned completion.
- [Remote adapters](remote_adapters.md), [Cinna mapping](cinna_adapter.md) and [remote coordination](remote_sync.md) — capability contract, service translation and executor handover.
- [Device ownership](cross_device.md) and [handoff export](handoff_note_export.md) — portable work and its local file view.
