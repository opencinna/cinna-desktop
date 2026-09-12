# Remote handoff and recovery

## Purpose

Hand an existing desktop task to an agent on its connected service without losing its local record or starting the same work twice. The task page and remote jobs use one coordinator; a durable receipt makes uncertain network outcomes recoverable after restart or task deletion.

## User flow

1. Open a desktop-owned task and press **Hand off**. Choose an agent from the service's directory and enter the context the next worker needs.
2. The dialog keeps the draft and disables edits/dismissal while sending. A definite refusal remains beside the controls for retry. Accepted work changes the task's executor and writes a transition message naming the recipient and remote key in its existing conversation.
3. A lost acknowledgement or failed local acceptance record leaves **Review pending handoff**. Open the service when its receipt includes a URL, inspect the work, and explicitly choose whether to continue here. This action does not stop remote work; a known-live agent still prevents recovery.
4. Recovery is independent of the remote directory and remains reachable on terminal tasks, tasks without a chat, the missing-task view and the linked chat. Taking over an existing task changes its claim; starting a new turn is a separate action. Resolving a deleted task's receipt does not recreate the task.

## Admission and ordering

`handOff` in `src/main/services/taskSyncService.ts` joins the existing per-task push queue. Identical target/note intents share one promise; opposing intents refuse. `src/main/services/taskOperationState.ts` reserves the task and linked chat before asynchronous preparation; both `taskExecutionService` and `runExecutionService` refuse local admission while that reservation or an unresolved durable receipt exists.

Preflight requires a task that runs here, a status that can enter `in_progress`, no live local turn and no pending local question. It rechecks profile generation, binding, device claim, chat, parent and mutable task context after awaits. A bound task uses its binding's adapter; an unbound task uses the explicit target or the preferred adapter for an internal job. Main resolves the selected reference through `listAssignees`, including its name and kind. Bound work must be confirmed idle before handoff; unknown liveness refuses a new remote start.

The coordinator creates an unbound remote task with its parent binding, saves the returned binding, sends supported current fields/assignment and the note, then calls `execute` when supported. A create already carries its assignee; a child may need a later assignment patch. An adapter without execute transfers assignment without inventing an `in_progress` result. Unsupported capabilities are gated rather than simulated with comments or another operation.

After remote acceptance, `accepted_pending` is persisted before local bookkeeping. `taskService.handOffToRemote` and the accepted receipt commit in one database transaction: remote executor/device release, selected assignee, note, supported execution status, refreshed binding and paid dirty markers. Export and the chat transition follow commit. A later local failure is reported as `attention`, not a refused remote run. Jobs preserve tasks on both `handed_over` and `handoff_uncertain` errors.

## Following the current job attempt

Accepted remote snapshots update the task and its matching active job attempt in one transaction. The attempt must belong to the same profile, link back to this task, and have exactly the task’s current local-chat identity, including null. Terminal attempts and historical conversations remain unchanged; unresolved receipts suspend projection. A local job handed to the service therefore finishes in Jobs when the remote task finishes, without rewriting an older attempt after desktop continuation. Jobs lists poll while an attempt remains active. See [remote status projection](remote_sync.md#remote-status-finishes-the-current-attempt).

## Durable journal

`src/main/db/taskHandoffs.ts` owns `task_handoffs`, declared in `src/main/db/schema.ts` and created by `src/main/db/migrations/tasks.ts`. Its task primary key carries user scope, optional chat id and a serialized `TaskHandoffReceipt`; the user/chat index supports conversation recovery. The receipt records adapter, selected assignee, known remote id/key/URL, `bindingPending`, message and update time. It contains no credentials or opaque remote state and does not travel through app-sync.

| State | Meaning |
|---|---|
| `preparing` | No potentially executing request is outstanding; a definite refusal can be retried |
| `creating` | Create was about to be dispatched; restart cannot assume it was refused |
| `executing` | Execute was about to be dispatched; restart cannot assume work did not start |
| `accepted_pending` | The service accepted, but local acceptance bookkeeping has not committed |
| `accepted` | Remote ownership and the receipt committed together |
| `uncertain` | Create/execute acknowledgement or local binding could not be established safely |
| `dismissed` | Definitively refused or explicitly resolved for local continuation |

Creating, executing, accepted-pending and uncertain receipts block further local execution and outgoing sync. Dirty markers remain owed until recovery; otherwise a queued desktop status could overwrite the service's live execution after a lost acknowledgement. Full and child discovery defer imports for active or durable unbound creates: an unknown remote id must not become a second local task. Full discovery retains its cursor for a later pass. This can delay unrelated discovery on that adapter until the user resolves the creation.

Receipts survive task deletion because a peer's delete does not cancel an already dispatched request. Account deletion removes receipts explicitly, and `put` verifies the user still exists so a late response cannot reinsert private metadata for a removed account.

## IPC and recovery

`src/main/ipc/task.ipc.ts` requires activation and derives the profile in main; `src/preload/index.ts` exposes the matching `window.api.tasks` methods. `task:hand-off` returns the `accepted | attention | uncertain | refused` outcome defined in `src/shared/taskHandoff.ts`. Options, task receipt, owned-chat receipt and resolution have separate channels, listed in [Tasks technical details](tasks_tech.md#ipc-channels).

`takeOver` checks liveness again and validates the captured task, profile generation and receipt after the probe. `resolveHandoff` uses that path for a surviving task, or the scoped receipt directly after deletion. A known-live response refuses even an explicit continue-anyway request; an unknown response is allowed only through the explicit recovery gesture. Receipt identity checks prevent an older recovery probe from dismissing a newer uncertain attempt. Neither path cancels a remote run.

`HandOffTaskControl.tsx` and `PendingHandoffControl.tsx` under `src/renderer/src/components/tasks/` separate directory selection from five-second receipt polling. Every task page gets the independent receipt control. The handoff dialog remains outside its switching wrapper so a pending journal update cannot unmount the user's draft. Recovery invalidates receipt/task queries after success; errors stay in reserved dialog space.

## Integration and limits

- [Remote coordination](remote_sync.md) owns polling, revisions and ordinary dirty pushes; [adapter capabilities](remote_adapters.md) and [Cinna mapping](cinna_adapter.md) own service behavior.
- [Task lifecycle](tasks.md), [chat-owned tasks](chat_tasks.md) and [device claims](cross_device.md) remain the ownership model. A receipt is local uncertainty bookkeeping, not a distributed lock.
- Cinna JSON requests have a thirty-second abort; mutations use a [private Node dispatcher](cinna_adapter.md#transport-and-inbox-delivery) with retries and redirects disabled, preserving supported system-proxy routes without sharing Chromium’s mutation transport. An aborted dispatched write can still have taken effect remotely; the journal does not promise server-side cancellation or exactly-once execution. Top-level external references assist create identity, but the service's child create does not provide equivalent idempotency.
- Recovery records an explicit local decision. It does not automatically reconnect a lost create result, stop a remote worker, or reconstruct remote execution history.
- This service transfers execution to a remote adapter. [Autonomous coordination](autonomous_tasks.md) changes desktop specialist owners and supplies time/turn limits separately, reusing [live attachment](../../chat/messaging/live_runs.md). [Script execution](script_execution.md) also reserves its root and child conversations against handoff. [Local schedules](local_schedules.md) reuse those script reservations for admitted occurrences.

An autonomous runner reservation also blocks outgoing handoff while queued, working, waiting or interrupted; stopping only one model turn is not enough to release that reservation. Conversely, unresolved or in-flight remote handoff prevents autonomous start before its task/checkpoint transaction.
