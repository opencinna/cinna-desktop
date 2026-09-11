# Tasks: Technical Details

## File Locations

| Layer | Entry points |
|---|---|
| Shared | `src/shared/tasks.ts`, `src/shared/taskStatus.ts`, `src/shared/inbox.ts`, `src/shared/runEvents.ts` |
| Database | `src/main/db/schema.ts`, `src/main/db/client.ts`, `src/main/db/tasks.ts`, `src/main/db/taskInputRequests.ts` |
| Services | `src/main/services/taskService.ts`, `src/main/services/inboxService.ts`, `src/main/services/remoteInboxService.ts`, `src/main/services/taskSyncService.ts`, `src/main/services/taskFileService.ts` |
| Adapters | `src/main/tasks/adapters/adapter.ts`, `src/main/tasks/adapters/index.ts`, `src/main/tasks/adapters/nullAdapter.ts`, `src/main/tasks/adapters/cinnaTaskAdapter.ts`, `src/main/tasks/adapters/cinnaTaskAdapter.wiring.ts` |
| IPC / preload | `src/main/ipc/task.ipc.ts`, `src/preload/index.ts` |
| Renderer | `src/renderer/src/hooks/useTasks.ts`, `src/renderer/src/hooks/useInbox.ts`, `src/renderer/src/components/tasks/TaskView.tsx`, `src/renderer/src/components/tasks/TaskStatusPill.tsx`, `src/renderer/src/components/inbox/InboxView.tsx`, `src/renderer/src/components/inbox/InboxButton.tsx` |
| Device sync | `src/main/sync/collections.ts`, `src/main/sync/resolvers.ts` |

## Database Schema

- `tasks` in `src/main/db/schema.ts` stores profile ownership, title, immutable goal, current description, status, priority, origin, executor, executor device, router and assignee. The parent id expresses one level of subtasks; DTO counts are derived from child rows. Optional chat/job/run links retain navigation without owning the task's lifetime.
- The same row holds handoff note, artifacts, budget and timestamps; binding columns hold adapter/id/key/url and opaque state. `remote_dirty` and `remote_synced_at` are device-local bookkeeping and do not travel through app-sync.
- `task_input_requests` holds request id, required task id, chat/agent references, serialized input request, resume kind, status, resolution and timestamps. Reads scope through the owning task. The boot sweep expires open rows because no parked driver survives restart. Remote asks write no rows here.
- Inline migrations and legacy run backfill live in `src/main/db/client.ts`. Repository access is isolated in the two task repositories. Device apply passes through `taskService` so the exported handoff note follows incoming writes too.
- See [device sync and claims](cross_device.md) for the fields deliberately omitted from transport and [handoff export](handoff_note_export.md) for the file's location and lifetime.

## IPC Channels

All handlers are registered by `src/main/ipc/task.ipc.ts`, require activation and resolve the current profile in main. Preload exposes `window.api.tasks` and `window.api.inbox`.

| Channel | Request → response |
|---|---|
| `task:list` | optional `TaskListQuery` → `TaskDto[]`; renderer filters are rebuilt field by field |
| `task:get` | task id → `TaskDto` from local storage |
| `task:update` | task id, `TaskFieldPatch` → updated task; title, description, priority and router |
| `task:set-status` | task id, `TaskStatus` → updated task after ownership/transition validation |
| `task:remote-live` | task id → `boolean \| null`; unknown differs from stopped |
| `task:take-over` | task id, optional force → claimed task, without starting execution |
| `task:delete` | task id → success after soft deletion |
| `inbox:list` | no arguments → asynchronous complete `InboxEntry[]`; remote failure rejects |
| `inbox:answer` | `AskAnswerPayload` → asynchronous `InboxAnswerResult`; refusal codes remain result data |

`parseAnswerPayload` accepts exactly one of permission reply or question answers. Task IPC mutations nudge device sync; stream bookkeeping uses its normal periodic device cycle. That device-sync cycle is distinct from the not-yet-scheduled remote-adapter coordinator.

## Services and Key Methods

- `taskService.create`, `getById`, `list`, `update`, `setStatus`, `applyRunState`, `acceptRemoteStatus`, `start`, `takeOver` and `remove` own task validation and lifecycle. `written` keeps the handoff export current. `start` currently associates an existing chat; it is not a renderer-facing conversation factory.
- `inboxService.recordRunEvent`, `openAsk`, `closeAsk` and `endTurn` record local asks and complete chat-owned tasks without throwing into a stream. `taskForChat` lazily creates their parent. See [chat task lifecycle](chat_tasks.md).
- `inboxService.list` merges local records with `remoteInboxService.list`; `answer` dispatches local versus namespaced remote addresses. See [Inbox mechanics](inbox.md) for the ten-second UI deadline, thirty-second Cinna transport abort, all-settled read coalescing and resolution-aware answer coalescing.
- `taskSyncService.push`, `pushAll`, `pull`, `pullOne`, `reconcile`, `handOff`, `takeOver`, `liveSession` and `remoteWork` coordinate adapters. Dirty status pushes use `src/main/tasks/taskStatusPath.ts`; they send legal steps, never a guessed direct destination. See [remote coordination](remote_sync.md) for reconciliation, cursors, failure classification and production callers.
- `taskFileService.exportHandoff` writes the local file view. It never imports edits back into the database.

## Renderer Components

- `TaskView` renders persisted work, description, status and actions. Attention branches distinguish work on this device, another device and a remote service. The remote banner probes liveness and keeps **Open the Inbox** separate from takeover. The conversation and service views remain their own navigation targets.
- `useTask` polls non-settled local records every five seconds; a task read does not itself refresh the bound service. `useRemoteLiveSession` is a separate query with its own liveness deadline/cache.
- `useInboxList` shares one five-second query between the badge, task page and Inbox. Read errors override cached-count claims; the task page uses success before offering an empty-Inbox re-run.
- `InboxView` retains acted-on cards for the mount and appends new arrivals below known cards. `PermissionRequestBlock` and `AskUserQuestionBlock` are the same components used in the transcript. `AnswerQuestionsModal` keeps the draft through failed delivery and disables mutation/dismissal while pending.
- The task and Inbox are tabless views in `src/renderer/src/stores/ui.store.ts`; reselecting the active sidebar tab returns from them through `src/renderer/src/components/layout/SidebarTabs.tsx`.

## Configuration

There is no separate task database, Inbox enablement setting or service token in renderer state. The Inbox poll uses five seconds, remote list/answer UI waits use ten seconds, and the production Cinna JSON fetch aborts after thirty seconds, including body reads. Adapter availability uses the profile's service configuration. Handoff exports use the application's user-data directory. Remote periodic scheduling remains a completion gap rather than a configurable timer already running.

## Security

Task repositories and service ownership checks scope access to the current profile. Remote request identities include their original binding; deleted/rebound tasks cannot send a stale card's answer. Device claims gate execution fields and are respected during incoming record apply. Opaque remote state and bearer tokens stay in main. The exported handoff note contains task content and is a local view, not a credential file.

## Adapter Contract and Cinna Mapping

The authority is [Remote Task Adapters](remote_adapters.md): capability-gated operations, total registry/null fallback, one binding creation operation, and the shared contract suite. [Cinna mapping](cinna_adapter.md#what-it-can-do) holds the route table and service-specific refusals. Keep those aspect documents authoritative rather than copying their evolving tables here.

## Current Gap List

- No periodic production caller invokes adapter `pull`, `pushAll` or `reconcile`; Inbox polling cannot discover unknown remote task rows.
- Takeover claims but does not create/start a local conversation; general task hand-off IPC and an assignee picker are absent.
- `next_message` has no reply-address Inbox entry, and its task continuation/completion behavior still needs the desktop-start/lifecycle work described in [Tasks](tasks.md#current-completion-gaps).
- A failed remote enumeration rejects the complete Inbox array, delaying new local entries too. Partial-result completeness must be carried explicitly before changing that policy.
- Service-specific limitations, including recent-history bounds and the absence of a subscription, remain in the [Cinna mapping](cinna_adapter.md) and [remote coordination](remote_sync.md) documents.

## Adding an Adapter

1. Implement `RemoteTaskAdapter` behind injected transport/configuration; keep service literals and opaque binding-state interpretation inside the adapter folder.
2. Declare capabilities honestly, refuse unsupported operations, preserve the binding identity after creation, and classify ownership separately from transient failure or validation refusal.
3. Register through `src/main/tasks/adapters/index.ts`; leave unknown ids to the null adapter. Do not add service-id branches to services, IPC or renderer.
4. Add a fake transport and run the common suite in `src/main/tasks/adapters/adapterContract.test.ts`, plus service-specific paging, status, ownership and answer tests. Test unavailable reads as errors, not empty successful lists.
5. Update the adapter aspect documentation and mapping table. Verify that task coordination and Inbox behavior require no system-specific branch outside the adapter, including the kind-branch ratchet.
