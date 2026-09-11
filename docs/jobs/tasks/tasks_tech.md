# Tasks: Technical Details

## File Locations

| Layer | Entry points |
|---|---|
| Shared | `src/shared/tasks.ts`, `src/shared/taskStatus.ts`, `src/shared/inbox.ts`, `src/shared/runEvents.ts` |
| Database | `src/main/db/schema.ts`, `src/main/db/client.ts`, `src/main/db/tasks.ts`, `src/main/db/taskInputRequests.ts` |
| Services | `src/main/services/taskService.ts`, `src/main/services/taskExecutionService.ts`, `src/main/services/taskModelConfig.ts`, `src/main/services/inboxService.ts`, `src/main/services/runExecutionService.ts`, `src/main/services/remoteInboxService.ts`, `src/main/services/taskSyncService.ts`, `src/main/services/taskSyncScheduler.ts`, `src/main/services/taskFileService.ts` |
| Adapters | `src/main/tasks/adapters/adapter.ts`, `src/main/tasks/adapters/index.ts`, `src/main/tasks/adapters/nullAdapter.ts`, `src/main/tasks/adapters/cinnaTaskAdapter.ts`, `src/main/tasks/adapters/cinnaTaskAdapter.wiring.ts` |
| IPC / preload | `src/main/ipc/task.ipc.ts`, `src/preload/index.ts` |
| Renderer | `src/renderer/src/hooks/useTasks.ts`, `src/renderer/src/hooks/useTaskList.ts`, `src/renderer/src/components/tasks/TaskList.tsx`, `src/renderer/src/hooks/useInbox.ts`, `src/renderer/src/components/tasks/TaskView.tsx`, `src/renderer/src/components/tasks/TaskStatusPill.tsx`, `src/renderer/src/components/inbox/InboxView.tsx`, `src/renderer/src/components/inbox/InboxButton.tsx` |
| Device sync | `src/main/sync/collections.ts`, `src/main/sync/resolvers.ts` |

## Database Schema

- `tasks` in `src/main/db/schema.ts` stores profile ownership, title, immutable goal, current description, status, priority, origin, executor, executor device, router and assignee. The parent id expresses one level of subtasks; DTO counts are derived from child rows. Optional chat/job/run links retain navigation without owning the task's lifetime.
- The same row holds handoff note, artifacts, budget and timestamps; binding columns hold adapter/id/key/url and opaque state. `remote_dirty` and `remote_synced_at` are device-local bookkeeping and do not travel through app-sync.
- `task_input_requests` holds request id, required task id, chat/agent references, serialized input request, resume kind, status, resolution and timestamps. Reads scope through the owning task. The boot sweep expires open `reply` rows because no parked driver survives restart; `next_message` rows survive and resume through main’s shared executor. Remote asks write no rows here.
- Inline migrations and legacy run backfill live in `src/main/db/client.ts`. Repository access is isolated in the two task repositories. Device apply passes through `taskService` so the exported handoff note follows incoming writes too.
- See [device sync and claims](cross_device.md) for the fields deliberately omitted from transport and [handoff export](handoff_note_export.md) for the file's location and lifetime.

## IPC Channels

All handlers are registered by `src/main/ipc/task.ipc.ts`, require activation and resolve the current profile in main. Preload exposes `window.api.tasks` and `window.api.inbox`.

| Channel | Request → response |
|---|---|
| `task:list` | optional `TaskListQuery` → `TaskDto[]`; renderer filters are rebuilt field by field |
| `task:children` | parent task id → `TaskListSnapshot` (`tasks`, `refreshed`, optional `refreshError`); saved child rows immediately, remote refresh in background |
| `task:get` | task id → saved `TaskDto` immediately; `getWatched` starts a bound-task refresh and carries any previous ephemeral refresh error |
| `task:start` | task id, `DesktopTaskTarget` → `TaskStartResult` (`task`, `chatId`, main turn `runId`) after acceptance; captures profile and settings scopes |
| `task:update` | task id, `TaskFieldPatch` → updated task; title, description, priority and router |
| `task:set-status` | task id, `TaskStatus` → updated task after ownership/transition validation |
| `task:remote-live` | task id → `boolean \| null`; unknown differs from stopped |
| `task:take-over` | task id, optional force → claimed task, without starting execution |
| `task:delete` | task id → success after soft deletion |
| `inbox:list` | no arguments → asynchronous complete `InboxEntry[]`; remote failure rejects |
| `inbox:answer` | `AskAnswerPayload` → asynchronous `InboxAnswerResult`; refusal codes remain result data |

`parseAnswerPayload` accepts exactly one of permission reply or question answers. Task IPC mutations nudge device sync; stream bookkeeping uses its normal periodic device cycle. That encrypted device-sync cycle is distinct from the active-profile remote-adapter scheduler, which also runs while app-sync is locked.

## Services and Key Methods

- `taskService.create`, `getById`, `list`, `update`, `setStatus`, `applyRunState`, `acceptRemoteStatus`, `start`, `takeOver` and `remove` own task validation and lifecycle. `written` keeps the handoff export current. `start` associates an existing chat. `beginDesktopChat` binds a new direct conversation and assignee within message acceptance; its export is deferred until commit by `taskExecutionService`.
- `taskExecutionService.start(scope, taskId, target)` reserves a profile/task start, validates ownership/status/no current conversation/no local ask/non-script router, and preflights the target. It rechecks activation, profile, claim and configuration after awaits and during acceptance. `taskContinuationPrompt` includes the full goal, a nonempty distinct description, and a nonempty handoff note once each. The new chat’s first user message and task binding commit together; refused acceptance rolls back both and removes only that new chat. Export follows acceptance. Origin, binding and historical job/run links remain; no job attempt is created.
- `resolveTaskModelConfig(scope, modeId?)` in `taskModelConfig.ts` resolves an explicit enabled mode or the effective default using captured settings/profile scopes, account-default precedence and profile overrides. It validates the provider, required credential, registered adapter and settings-scoped MCP baseline. Model priority is mode → provider default → managed curated candidates → selected adapter discovery. Discovery has a ten-second caller deadline and shares an unresolved adapter request across retries; explicit configuration queries no model list. `assertCurrent` checks the snapshot again before acceptance.
- `inboxService.recordRunEvent`, `openAsk`, `closeAsk` and `endTurn` record local asks and complete chat-owned tasks through the non-throwing observer. `hasNextMessage` selects refusal preservation; `resumeChat` validates authority and settles matching requests inside the message transaction, where a throw rejects acceptance. `taskForChat` lazily creates their parent. See [chat task lifecycle](chat_tasks.md).
- `inboxService.list` merges local records with `remoteInboxService.list`; `answer` dispatches local versus namespaced remote addresses. See [Inbox mechanics](inbox.md) for the ten-second UI deadline, thirty-second Cinna transport abort, all-settled read coalescing and resolution-aware answer coalescing.
- `runExecutionService.start(scope, payload, options)` admits one active turn per chat and returns `id`, `accepted`, `completed` and `cancel`. It observes events before optional renderer forwarding; disconnected/absent ports do not end execution. Acceptance runs through `messageRepo.saveUser`’s transaction callback. See [shared turn lifetime](../../chat/chat_routing/chat_routing_tech.md#shared-turn-lifetime-and-acceptance).
- `taskSyncService.getChildren` returns saved child rows plus process-local refresh metadata. For a bound root with the adapter’s subtask capability, it launches a coalesced `listChildren` read. That read waits for the current profile pull and parent detail/push work, then imports only children naming the same adapter and remote parent. Generation/binding checks reject obsolete connections; per-child revisions prevent old reads replacing newer child data. Absence from the response does not delete saved children. Unbound tasks, child tasks and adapters without subtask support return local rows as refreshed.
- `taskSyncScheduler.start`, `stop`, `setSuspended` and `refresh` own lifecycle and completion-based polling; activation and main-window/power/quit hooks call them. See [scheduling and read ordering](remote_sync.md#scheduling-and-watched-reads).
- `taskSyncService.getWatched`, `invalidatePending`, `push`, `pushAll`, `pull`, `pullOne`, `reconcile`, `handOff`, `takeOver`, `liveSession` and `remoteWork` coordinate adapters. Dirty status pushes use `src/main/tasks/taskStatusPath.ts`; they send legal steps, never a guessed direct destination. See [remote coordination](remote_sync.md) for reconciliation, cursors, failure classification and production callers.
- `taskService.setStatus` expires next-message requests on completed/error/cancelled/archived and settles a linked pending/running job: completed → succeeded, error → failed, cancelled/archive → cancelled. `jobService.setRunStatus` leaves terminal attempts unchanged and updates a desktop task via `applyRunState` before writing a new terminal attempt status, so a refused device claim changes neither.
- A job’s completion hook owns the task only when `jobRunsRepo.getByLocalChatId(ctx.chatId)` resolves an attempt linked to this task. A new desktop conversation may retain an old `jobRunId` as provenance and still finish from Inbox root-event bookkeeping; a historical link alone must not leave the new conversation running forever.
- `taskFileService.exportHandoff` writes the local file view. It never imports edits back into the database.

## Renderer Components

- `TaskView` renders persisted work, description, status and actions. Attention branches distinguish work on this device, another device and a remote service. The remote banner probes liveness and keeps **Open the Inbox** separate from takeover. The conversation and service views remain their own navigation targets.
- `TaskList` is mounted below Jobs in an independently scrollable area capped at 45% of the sidebar, and below Details on root task pages as Subtasks. Child pages offer Parent task instead. Rows use `TaskStatusPill`, full-title accessible names/tooltips and `useOpenTask`; twenty rows are initially visible, with increments of twenty. The list is ordered by the repository’s descending updatedAt.
- `useTaskList` polls every five seconds with one retry. The root query calls local-only `tasks.list({rootOnly:true})`; child keys include the parent id and call `tasks.children(parentTaskId)`. `TaskListSnapshot.refreshed` distinguishes confirmed empty children from the first pending read. Errors retain rows and use the reserved footer; Try again refetches, with completed background refresh visible on the next snapshot read. Refresh metadata is cleared with sync generation invalidation and is not persisted or synced.
- `TaskView.StartTaskControls` offers enabled, currently ready agents and the default model for a locally owned task without a chat. `useStartTask` invokes main once, then updates task/chat/Inbox queries and navigates only after acceptance; it never sends the prompt again from the renderer. Error space and button width stay reserved; errors clear on target change, while refusal retains selection.
- `chatService.get` includes ephemeral `activeRunId`; `useChatDetail` polls every second while that id is present and there is no attached renderer stream. `ChatInput` shows Stop for either source of activity. `run:cancel-chat`/`window.api.run.cancelChat(chatId)` cancel an owned main turn. Final persisted messages arrive through polling; this is not token replay or subscription.
- `useTask` polls bound tasks every five seconds even after completion; unbound tasks poll only while non-settled. Each `task:get` returns local data and starts a coalesced remote detail refresh. `TaskRemoteRef.refreshError` carries the last watched failure into the existing stale footer without persisting or syncing it. `useRemoteLiveSession` is a separate query with its own liveness deadline/cache.
- `useInboxList` shares one five-second query between the badge, task page and Inbox. Read errors override cached-count claims; the task page uses success before offering an empty-Inbox re-run.
- `InboxView` retains acted-on cards for the mount and appends new arrivals below known cards. `PermissionRequestBlock` and `AskUserQuestionBlock` are the same components used in the transcript. `AnswerQuestionsModal` keeps the draft through failed delivery and disables mutation/dismissal while pending.
- The task and Inbox are tabless views in `src/renderer/src/stores/ui.store.ts`; reselecting the active sidebar tab returns from them through `src/renderer/src/components/layout/SidebarTabs.tsx`.

## Configuration

There is no separate task database, Inbox enablement setting or service token in renderer state. The Inbox poll uses five seconds, remote list/answer UI waits use ten seconds, and the production Cinna JSON fetch aborts after thirty seconds, including body reads. Adapter availability uses the profile's service configuration. Handoff exports use the application's user-data directory. The active-profile scheduler waits five seconds between completed push/pull passes, catches up on focus/resume and invalidates pending generations on stop/profile replacement/suspend. No new user setting controls that timer.

## Security

Task repositories and service ownership checks scope access to the current profile. Remote request identities include their original binding; deleted/rebound tasks cannot send a stale card's answer. Device claims gate execution fields and are respected during incoming record apply. Opaque remote state and bearer tokens stay in main. The exported handoff note contains task content and is a local view, not a credential file.

## Adapter Contract and Cinna Mapping

The authority is [Remote Task Adapters](remote_adapters.md): capability-gated operations, total registry/null fallback, one binding creation operation, and the shared contract suite. [Cinna mapping](cinna_adapter.md#what-it-can-do) holds the route table and service-specific refusals. Keep those aspect documents authoritative rather than copying their evolving tables here.

## Current Gap List

- Takeover and Continue remain separate actions. A general remote hand-off IPC/picker is absent; Continue chooses a local agent or model only.
- The later orchestration phase still owns autonomous task execution, handback, script routing and attach/replay; the shared executor owns one explicitly started or continued turn; subsequent cleanup/protocol/new-driver work is separate from this scheduler.
- A failed remote enumeration rejects the complete Inbox array, delaying new local entries too. Partial-result completeness must be carried explicitly before changing that policy.
- Service-specific limitations, including recent-history bounds and the absence of a subscription, remain in the [Cinna mapping](cinna_adapter.md) and [remote coordination](remote_sync.md) documents.

## Adding an Adapter

1. Implement `RemoteTaskAdapter` behind injected transport/configuration; keep service literals and opaque binding-state interpretation inside the adapter folder.
2. Declare capabilities honestly, refuse unsupported operations, preserve the binding identity after creation, and classify ownership separately from transient failure or validation refusal.
3. Register through `src/main/tasks/adapters/index.ts`; leave unknown ids to the null adapter. Do not add service-id branches to services, IPC or renderer.
4. Add a fake transport and run the common suite in `src/main/tasks/adapters/adapterContract.test.ts`, plus service-specific paging, status, ownership and answer tests. Test unavailable reads as errors, not empty successful lists.
5. Update the adapter aspect documentation and mapping table. Verify that task coordination and Inbox behavior require no system-specific branch outside the adapter, including the kind-branch ratchet.
