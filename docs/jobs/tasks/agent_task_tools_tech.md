# Agent Task Tools — Technical Details

Behavior and rules: [Agent Task Tools](agent_task_tools.md). Delegation internals: [Handover Bus](handover_bus_tech.md).

## File Locations

| Layer | Files and responsibility |
|---|---|
| Tool surface | `src/main/services/delegationToolProvider.ts` — the `schemas` for `tasks_list`, `task_create`, `task_update`, `task_comment` beside `handover_*`; `callTool` routes any `task*` name to `taskToolService` |
| Service | `src/main/services/taskToolService.ts` — validation, relations, cap, chain depth, per-chat serialization, update/report rules, comments; `TASK_TOOL_CHAT_CAP` (20), `MAX_TASK_CHAIN_DEPTH` (2), `TASKS_LIST_MAX` (50) |
| Report mark | `src/main/tasks/agentStatusReports.ts` — `noteAgentStatusReport`, `takeAgentStatusReport`, `forgetAgentStatusReports` |
| Delegation | `src/main/services/delegationService.ts` — `validateSession` (exported, shared with the task tools), `create(…, options)` with `DelegationCreateOptions.beforeNew`; `src/main/services/delegationFiles.ts` — `delegationBriefExists` |
| Authoring | `src/main/services/taskAuthoringService.ts` — `createRouted(scope, input, extra)` takes `parentTaskId` and the provenance |
| Turn end / start | `src/main/services/inboxService.ts` (`endTurn` consults the report mark), `src/main/services/runExecutionService.ts` (`forgetAgentStatusReports` on each turn start; `turnHeaderFor` counts ready tasks), `src/main/services/threadContextService.ts` (`buildTurnHeader` `readyTasks`) |
| Comment copy | `src/main/services/taskSyncService.ts` — `copyComment`, `appendLog`; `src/main/tasks/adapters/adapter.ts` — optional `RemoteLocalHome.appendLog`; `src/main/tasks/adapters/folderTaskAdapter.ts` — its `localHome.appendLog`; `src/shared/folderTasks.ts` — `LOG_OPEN` / `LOG_CLOSE`, `FolderTaskPatch.appendLog`, `formatFolderLogEntry` |
| Database | `src/main/db/schema.ts` (`tasks` provenance columns, `taskComments`), `src/main/db/migrations/tasks.ts`, `src/main/db/tasks.ts` (`countCreatedInChat`, `countReadyFor`, `setProvenance`), `src/main/db/delegations.ts` (`countForOriginChat`, `listByOriginAgent`), `src/main/db/taskComments.ts` (`taskCommentRepo`) |
| Shared | `src/shared/tasks.ts` — `TaskCommentDto`, `TASK_COMMENT_MAX` (8000); `src/shared/handovers.ts` — `handoverRequesterSection` now names `task_create` |
| IPC / preload | `src/main/ipc/task.ipc.ts` (`task:comments`), `src/preload/index.ts` (`window.api.tasks.comments`) |
| Renderer | `src/renderer/src/hooks/useTasks.ts` (`useTaskComments`, `TASK_COMMENTS_KEY`), `src/renderer/src/components/tasks/TaskView.tsx` (`TaskComments`, `CommentItem`, `COMMENTS_SHOWN`) |
| Tests | `src/main/services/taskToolService.test.ts`, `delegationService.test.ts`, `inboxService.test.ts`, `conductorBridge.test.ts`, `threadContextService.test.ts`, `taskSyncService.folder.test.ts`, `src/shared/folderTasks.test.ts`, `src/main/ipc/task.ipc.test.ts`, `src/renderer/src/components/tasks/TaskView.test.tsx`; the e2e specs `delegation-bare`, `delegation-local`, `delegation-cloud`, `live-delegation` and `live-autorun` delegate through `task_create` |

## Database Schema

Added idempotently by `migrateTasks` (`src/main/db/migrations/tasks.ts`):

- `tasks.created_by_agent_id`, `tasks.created_by_chat_id` (text, null) and `tasks.chain_depth` (integer, default 0), indexed by `idx_tasks_created_by_chat (user_id, created_by_chat_id)` for the cap count. Null/0 for any task a person, a job or a pull created. Not in the device-sync payload (`src/main/sync/collections.ts` lists task fields explicitly).
- Own-queue creates set all three. A kit/cloud delegation's task gets `created_by_agent_id` and `chain_depth` (the delegation depth) at `createWithTask`; a bare delegation's task is made by the file intake, so `delegationService.create` stamps it afterwards through `taskRepo.setProvenance`, which writes only where `created_by_agent_id` is still null and leaves `updatedAt` alone. Delegated tasks get no `created_by_chat_id`: their cap share is counted from `delegations.origin_chat_id`.
- `task_comments`: `id`, `task_id` (`ON DELETE CASCADE`; a soft-deleted task keeps its comments until hard delete), `user_id`, `author_kind` (`agent` | `user`), `author_agent_id`, `body`, `remote_status` (`pending` | `sent` | `failed` | null), `created_at` (ms). Index `(user_id, task_id, created_at)`. Not a synced collection. `taskCommentRepo` is wrapped in `redactingRepository` on `create`, so credentials in a body are redacted on the way in.

## IPC Channels

| Channel | Request → response |
|---|---|
| `task:comments` | task id → `TaskCommentDto[]`, oldest first, in the active profile; rebuilt field by field so nothing beyond the DTO crosses. Empty for a missing or deleted task |

Creation, update and comment are session tools only; there is no renderer channel for them.

## Services & Key Methods

- `DelegationToolProvider.getTools` offers every schema except `handover_report` to non-executor sessions; `callTool` refuses unoffered tools and unknown arguments ("The tool received an unknown argument.") before dispatch.
- `taskToolService.taskCreate` runs `createTask` through `serializedInChat(chatId, …)`, a per-chat promise chain. `createTask` decides self vs. delegation; a delegation maps `assignee → target`, `description → brief` and calls `delegationService.create` with `beforeNew: () => assertChatCap(session)`. `create` calls `beforeNew` only after the idempotency lookup and when `delegationBriefExists` says no bare brief is already written at that id, so repeats are answered at the cap.
- Own queue: depth `depthOf(task) + 1` (or 0 with no chat task), where `depthOf` is `max(delegationRepo.byTaskId(…).depth, task.chainDepth)`; `status` `ready` → `open`, otherwise `new`; `taskAuthoringService.createRouted` with `assignee: { kind: 'agent', agentId }`, which picks the folder home or native through `localHomeFor`. `delegationService.create` computes its depth as `max(parent.depth, task.chainDepth) + 1` against `MAX_HANDOVER_DEPTH`.
- `assertChatCap` = `taskRepo.countCreatedInChat` + `delegationRepo.countForOriginChat` (all delegation rows from the chat, settled and skipped included).
- `tasksList` walks `taskRepo.list`, tags relations (`delegationRepo.listByOriginAgent` for `delegated`), drops archived rows (no category) and closed ones unless `include_closed` or `category: closed`, sorts by `createdAt` desc and caps at 50 with `truncated` / `total`.
- `taskUpdate`: permission (current task, assigned, or created with no `chatId`) → `delegatedRefusal` (a `delegationRepo` or `handoverRepo` row for the task) → `ownedElsewhere` (`taskRuntimeRepo`, `scriptRuntimeRepo.owner`, or `activeChatRunId` in another chat) → field patch via `taskAuthoringService.update` → status via `resolveStatus`. A report (current task; `completed` / `blocked` / `error`) refuses a `jobRunId` task and one in `taskRunnersByChat`, then calls `taskService.setStatus` directly (not the manual path) and `noteAgentStatusReport(taskId, chatId, activeChatRunId(chatId))`. Any other status goes through `taskAuthoringService.setStatus`, i.e. the manual-move rules.
- `resolveStatus`: a canonical status passes; for a device-local task with an agent, a `folderBoard` column word or a default word becomes `{ status, label }`; otherwise a default word maps to its category's status.
- `inboxService.endTurn` returns early when `takeAgentStatusReport(task.id, ctx.turnId)` is true and the task is not `in_progress`. `takeAgentStatusReport` always clears the mark and is true only for the same run id; `runExecutionService` calls `forgetAgentStatusReports(chatId)` when it registers a new turn.
- `taskComment` stores the row as `pending`, then `taskSyncService.copyComment(userId, taskId, { logEntry, remoteBody })`: a binding whose adapter has `localHome.appendLog` → `appendLog` (queued behind the task's push in `pushesInFlight`, revision bumped around the write, binding stored with `stateWhileOwed` so owed fields keep their base); else an adapter with `capabilities().comments` → `addComment` with `type: 'note'` and `**<agent>:** <body>`; else false. Result → `remote_status` `sent`, `failed` (on throw; logged) or null.
- Folder adapter `localHome.appendLog` keeps `writtenDigest` at its prior value unless the file was Cinna's own before the append, so an entry never launders an outside edit into trusted content. Its `capabilities().comments` stays false.
- `formatFolderLogEntry` writes `**<author>** · YYYY-MM-DD HH:MM UTC` then the body, with `<!--` escaped so a body cannot close the log or the handoff section. `patchFolderTaskFile` with `appendLog` adds lines only; a file without a log gets one after the description and before the handoff section. `parseFolderTaskFile` excludes the log (last `LOG_CLOSE`, nearest `LOG_OPEN` before it) from the description, and `setDescription` rewrites the description while keeping the log and handoff section byte for byte.
- `taskToolService.comments` resolves agent author names through `localAgentService.get` (null when the agent is gone).

## Renderer Components

- `TaskView` reads `useTaskComments(task.id)` (polled on `POLL_MS`, `retry: 1`) and renders `TaskComments` last, after `TaskList` (Subtasks) and outside the Goal/Details grid, which is unchanged by comments. `TaskComments` returns null with no comments; a failed first read (`errorUpdateCount > 0 && !data`, so a refetch does not hide it) keeps the section with Try again.
- `TaskComments` anchors its window at the first comment id shown on first data (`COMMENTS_SHOWN` = 5), offers "Show earlier comments (N)", which with `showAll` becomes "Show fewer comments" (same button element, `aria-expanded`; collapsing re-anchors at the latest `COMMENTS_SHOWN`), and renders `CommentItem`s: Bot/User icon, author (button to the agent page via `hasAgentPage` / `useOpenAgentPage`), `Timestamp`, an `AlertTriangle` with an aria-label when `remoteStatus === 'failed'` (file / connected service / plain "Not copied" by `home`), the body in `<Prose compact>` (`.markdown-compact`: h1–h6 at 1em, body line height) clamped past 600 characters / 8 lines by `.comment-clamp` in `main.css` (six lines of `1.625em` on a `text-xs` wrapper, last line masked out).

## Configuration

None. The caps are constants in `taskToolService.ts`; the turn header line is wire-only and omitted at zero.

## Security

- Every call goes through `validateSession`; tool arguments cannot name a profile, chat or depth.
- Comment bodies are redacted on insert; folder writes go through the folder adapter's fresh-read, temp-file-and-rename path and its symlink refusals.
- Errors reach the agent as the refusing service's message (`plain` / `plainAsync`), never a stack.
