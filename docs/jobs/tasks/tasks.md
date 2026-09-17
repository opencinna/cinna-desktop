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

1. **Browse work.** Open the Inbox and use **Recent tasks** below the asks to open a root task, including work with no job or open ask. A root page with subtasks lists them (a task with none shows no Subtasks section); the back arrow before the title goes to the **Parent task** for a child, **Back to {job}** for a job's task, and **Back to the Inbox** for a task with neither, or whose job has been deleted. A subtask that also has a job reaches the job from the Details panel. Finished children can be discovered from the parent even when the service’s active list omits them.
2. **Run saved work.** Execute a job; its attempt receives a task. Open the task from the run history to see the goal, status and available actions, then open its conversation or service view when needed. Deleting the run does not delete the task's record of the work.
3. **Answer an agent running here.** A parked question/permission or A2A next-message question appears in the Inbox. A hand-opened chat acquires a task at its first persisted ask. Answer from the Inbox and keep the outcome visible. A next-message answer continues the same agent/chat/task in main without navigating away; its pending request survives app restart.
4. **Answer remote work.** A locally known blocked task on an ask-capable adapter contributes its live questions to the same Inbox. Its task page offers **Open the Inbox** separately from takeover. A failed delivery keeps the question dialog and draft available for retry.
5. **Keep remote work current.** The active profile pushes local edits and discovers remote tasks automatically, with five seconds between completed passes. Focus and wake catch up. A bound task page opens its saved record immediately, refreshes in the background and marks failed remote refreshes as stale.
6. **Move execution.** On a desktop task, press **Hand off**, choose a remote agent and supply the handoff note. Jobs use the same handoff service. Accepted work moves to the service and leaves a receipt in its existing conversation. An uncertain result offers **Review pending handoff** before execution can continue here. The task page checks remote liveness before offering takeover; a live remote agent cannot be taken over. Taking over claims the task without starting a conversation. For a task with no local chat, choose an available agent or **Default chat model**, then press **Continue**. Main starts one new conversation with the goal, distinct description and handoff note, and opens it after acceptance.

7. **Run on its own.** An existing coordinator chat can start an [autonomous task](autonomous_tasks.md). Main coordinates consecutive owner turns, waits for durable Inbox answers and offers explicit recovery after interruption. Leaving the conversation does not stop it; closing the app does.

## Business Rules

- Job history keeps its original provenance when a task changes executor. Bound refresh and completion use the current task and matching active attempt. Confirmed remote loss fails that attempt while retaining a locally authored Task and its last-known status/executor; an account relink is not remote-deletion evidence. See [Job execution](../jobs/execution_tech.md).

- **Browsing does not start work.** Root and child rows open the same task page. Both lists exclude archived records by default and put the most recently updated work first. Recent tasks and a task page's Subtasks use the same row and the same two rules: each keeps the order it first showed for as long as it is open, so a poll cannot move a row under the pointer, and **Show more** reveals the next page without moving the button — once the list has been expanded, an **All N shown** line of the button's height takes its place on the last page, so no row slides under the pointer that pressed it. Recent tasks pages by ten (**Show more tasks**), Subtasks by twenty (**Show more subtasks**). See [Recent Tasks](inbox.md#recent-tasks).
- **The task page names the work and leaves the goal to describe it.** It has the local agent page's shape: one row with the back arrow, a status icon and a one-line title (the full title in its tooltip), and level with it the actions, least to most important — **Hand off** / **Review pending handoff**, the service link, then **Open the chat** as the primary. That row sits at the same height as on the local agent page, with the title and the buttons sharing a top edge. The work (goal, description, handoff note, artifacts, under uppercase section headings) is the main column; the facts sit in a **Details** panel beside it, or below the work on a narrow page, one per row with the label on the left and the value on the right: status, assignee (a link to the agent's page), priority, where it runs, remote key, job (a link to the job, left out once the job has been deleted), and the updated/created/started/finished times. A time shows relative until clicked, then the exact local date and time. The status is an icon before the title and a word in Details, so a screen reader hears it once, in words.
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
- **An unread Inbox is not empty.** A failed read keeps the last successful list and shows an error. An unreachable service is reported as a named gap beside the asks that could be read, so local asks stay current during a remote outage. Remote asks already on screen stay there while their service cannot be read. The badge, the view and a bound task's page never infer that nothing is waiting from a read with a gap in it. See [the Inbox](inbox.md#polling-failures-and-concurrency).
- **Answering remote work does not guess its status.** Another session may still be blocked. The remote remains authoritative until the task is refreshed.
- **A pending continuation prevents premature completion.** Normal turn completion and restart preserve next-message asks. Answers settle only their agent’s requests; sibling asks prevent task/job finalization. A stale card cannot resume settled or remotely claimed work.
- **A child ending affects its own asks.** Root/invocation ownership prevents a late resolution or child failure from consuming another invocation’s question. Answering any one request recomputes the task’s blocked state from all surviving siblings.
- **An explicit ending closes idle continuations.** Completing, failing, cancelling or archiving a task expires its next-message requests and settles its linked active job attempt; stale cards cannot restart it.
- **A failed question delivery keeps the draft.** The modal stays open, disables edits and dismissal while sending, and shows the refusal beside the submission control. An acted-on Inbox card remains until the user leaves the view.

## Current Completion Gaps

- [Manifest handback](manifest_handback.md) supplies bounded kit-agent notes to the existing coordinator return. [Autonomous coordination](autonomous_tasks.md) supplies multi-turn execution, durable runner gates and specialist handback using existing [live attachment/replay](../../chat/messaging/live_runs.md). [Script execution](script_execution.md) runs validated graphs in isolated child conversations with durable gates and whole-script controls. [Local schedules](local_schedules.md) supply explicit device-local timed script admission. Complete token accounting, protocol updates, managed/SSH drivers and the final kind-branch cleanup remain separate work.

These are remaining implementation boundaries, not claims that the task runtime phase is complete.

## Architecture Overview

Job or chat → task service → SQLite task → task page.

Take over → device claim; Continue → task execution preflight → new chat + transactional message/task binding → shared main executor → accepted chat navigation.

Run input event → persisted local request; blocked bound task → remote adapter asks; both → Inbox → shared request block → local driver reply, same-chat next-message continuation or remote adapter answer.

Task writes → device sync and handoff export; activated profile / focus / wake → task sync scheduler → dirty push then remote pull/reconcile → bound service.

## Integration Points

- [Sidebar Session Status](../../chat/session_status/session_status.md) — Listed local conversations retain running/interrupt controls and unread outcomes. These are latest local session results, not task status or an Inbox count; opening the task page alone does not mark its conversation read.
- [Script definitions](script_definitions.md) — portable agent aliases and validated graph/template data; [execution](script_execution.md) covers checkpoints and isolated children.
- [Autonomous tasks](autonomous_tasks.md) — coordinator controls, local checkpoints, limits, queues and interruption recovery.
- [Remote handoff and recovery](remote_handoff.md) — selected remote destination, durable uncertainty, shared jobs path and recovery controls.
- [Technical details](tasks_tech.md) — schema, IPC and implementation entry points.
- [The Inbox](inbox.md) — request identities, failure policy, polling and answer retries.
- [Jobs](../jobs/jobs.md) and [Cinna task view](../cinna_task_view/cinna_task_view.md) — reusable work, attempt history and the service conversation.
- [A chat's first ask](chat_tasks.md) — lazy task creation and chat-owned completion.
- [Remote adapters](remote_adapters.md), [Cinna mapping](cinna_adapter.md) and [remote coordination](remote_sync.md) — capability contract, service translation and executor handover.
- [Device ownership](cross_device.md) and [handoff export](handoff_note_export.md) — portable work and its local file view.
