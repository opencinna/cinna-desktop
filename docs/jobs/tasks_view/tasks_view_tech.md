# The Tasks View: Technical Details

## File Locations

| Layer | Files |
|---|---|
| Shared | `src/shared/taskStatus.ts` (categories, manual overlay), `src/shared/folderTasks.ts` (`TaskBoardColumn`, `normalizeStatusWord`, `folderCategoryForStatus` — the folder board's types), `src/shared/tasks.ts` (`TaskCustomFields`, `validateTaskCustomFields`, `TaskCreateInput`, `TaskUpdateInput`, `TaskAssigneeInput`) |
| Database | `src/main/db/schema.ts` (`tasks.customFields`), `src/main/db/migrations/tasks.ts`, `src/main/db/tasks.ts` |
| Services | `src/main/services/taskAuthoringService.ts`, `src/main/services/taskService.ts` |
| IPC / preload | `src/main/ipc/task.ipc.ts` (`parseTaskCreatePayload`, `parseTaskUpdatePayload`), `src/preload/index.ts` (`window.api.tasks.create` / `update` / `setStatus` / `folderBoard`) |
| Device sync | `src/main/sync/collections.ts` (`taskMapper`, `syncedCustomFields`) |
| Renderer | `src/renderer/src/components/tasks/TasksView.tsx`, `TasksList.tsx`, `TasksBoard.tsx`, `TasksButton.tsx`, `TaskFormDialog.tsx`, `TaskAssigneeChip.tsx`, `tasksViewModel.ts`; also `TaskRow.tsx`, `TaskStatusPill.tsx`, `TaskView.tsx`, `TaskActionsMenu.tsx`, `DetailParts.tsx`, `src/renderer/src/hooks/useTasks.ts`, `src/renderer/src/stores/ui.store.ts`, `src/renderer/src/components/layout/{TopBar,MainArea,SidebarTabs}.tsx`, `src/renderer/src/hooks/useSync.ts`, `src/renderer/src/components/settings/FeaturesSettingsSection.tsx` |
| Tests | `src/shared/taskStatus.test.ts`, `src/shared/tasks.test.ts`, `src/main/services/taskAuthoringService.test.ts`, `src/main/ipc/task.ipc.test.ts`, `src/renderer/src/components/tasks/TasksView.test.tsx`, `src/renderer/src/components/layout/TopBar.agentStatusButton.test.tsx` |

## Database Schema

- `tasks.custom_fields` — nullable JSON (`TaskCustomFields`), added idempotently by `migrateTasks` in `src/main/db/migrations/tasks.ts`. Null means "none" for every task written before the column; an empty set is also stored as null (`checkedCustomFields`), so "has none" has one spelling.
- `TaskSyncValues.customFields` is optional on purpose: `undefined` means the peer's payload had no key, and `taskRepo`'s sync upsert then leaves the column out of the update set. A sync insert writes `values.customFields ?? null`.

## Shared Rules (`src/shared/taskStatus.ts`)

- `TaskStatusCategory` (`backlog | ready | active | waiting | closed`), `TASK_STATUS_CATEGORIES` (lifecycle order = board columns), `TASK_STATUS_CATEGORY_LABEL`, `taskStatusCategory(status)` (null for `archived`).
- `CATEGORY_DROP_STATUS` — the status a drop on a user column writes: backlog → `new`, ready → `open`, closed → `completed`. Active and Waiting have none.
- `MANUAL_TRANSITIONS` — `new: [open, completed]`, `open: [new, completed]`. An overlay on `VALID_TRANSITIONS`, which stays a verbatim copy of cinna-core's table; `taskStatus.test.ts` asserts the manual-only pairs are absent from it.
- `isManualOnlyTransition`, `canTransitionManually(from, to, {bound})` — table, plus the overlay only when `bound` is false.
- `MANUAL_TARGET_STATUSES` (`new`, `open`, `completed`), `isManualSource(from)` (category backlog/ready/closed), `canMoveManually(from, to, {bound})` — the status half of the manual rule: from a user column, to a user column or `cancelled`, along `canTransitionManually`.
- `manualTargets(from, {bound})` — the user-column statuses reachable, `from` excluded. It never lists `cancelled`, which `canMoveManually` allows; the category board and a non-file task's moves never offer it. A folder board's Cancelled-category columns are droppable, and a file task's moves to them are judged by `canMoveManually` directly (`folderMoveTargets`).

## IPC Channels

| Channel | Request → response |
|---|---|
| `task:create` | payload → `TaskDto`. `parseTaskCreatePayload` rebuilds it field by field: `title` (required string), optional `goal`, `description`, `priority` (`isTaskPriority`), `status` (`new` or `open` only), `assignee` (`TaskAssigneeInput`), `customFields` (a plain object, else refused). Through `taskAuthoringService.createRouted`, which writes a bare agent's task into its folder ([Folder Tasks](../tasks/folder_tasks_tech.md)). Captures profile and settings scopes; marks device sync dirty |
| `task:update` | task id, payload → `TaskDto`. `parseTaskUpdatePayload`: `title`, `description` (string or null), `priority`, `router` (`TASK_ROUTERS`), `assignee`, `customFields` (object, or null to clear). Through `taskAuthoringService.update`; marks device sync dirty |
| `task:set-status` | task id, `TaskStatus`, optional folder word (`statusLabelInput`: a string ≤ 200 chars, or nothing) → `TaskDto`. Through `taskAuthoringService.setStatus`, which ends in `taskService.setStatus(…, {manual: true, bound, label})`; it is the only manual caller. Internal callers (runs, handovers, delegations) keep the plain table |
| `task:folder-board` | agent id → `TaskBoardColumn[]` or null (the agent's tasks are not kept in a folder). See [Folder Tasks](../tasks/folder_tasks_tech.md#ipc-channels) |

## Services & Key Methods

- `taskAuthoringService.createRouted(scope, input)` — `prepare` (the validation below), then `localHomeFor(agentId)` for an agent assignee: a local home's task goes to `taskSyncService.createInHome`, every other to `taskService.create`. `create` is the same without the routing. `setStatus(scope, taskId, status, label?)` sets `bound` from the bound adapter's `capabilities().transitionTable` (a file task moves by the unbound overlay) and checks a label against the agent's folder board before passing it on.
- `taskAuthoringService.prepare(scope, input)` — trims the title (required), defaults goal to the title, status `new`, router `direct`, origin `local`, executor `desktop`, then `taskService.create`. `update(scope, taskId, input)` resolves only the assignee and hands the rest to `taskService.update`. `resolveAssignee`: `null` or `{kind:'model'}` → `{kind:'model', agentId:null, name:null}`; an agent must be found by `agentService.findAgent` across settings and profile scopes and be enabled, the profile's `agentOverrideRepo` value winning over the row's. It is a separate module because `taskService` is imported by the app-sync apply path (`sync/collections.ts`), which must not pull the agent stack in behind it.
- `taskService.update` — `TaskFieldPatch` carries `assignee` (already resolved) and `customFields`. A custom-field edit of a bound task marks `customFields` dirty; the push drops it for a remote whose `writeFields` lack it. An assignee change is gated by `assigneeEditRefusal` (`deviceLocal`, chat, claim/executor, `remoteAdapter`, `router === 'script'`, `taskRuntimeRepo` / `scriptRuntimeRepo.owner`) and clears `assigneeRef`, since the portable descriptor is derived from the row.
- `taskService.setStatus(userId, taskId, status, {manual, bound?, label?})` — `bound` defaults to "has a remote adapter"; `label` is stored as `statusLabel` with the status. After `requireRunsHere`: `manualStatusRefusal` (worded from `canMoveManually`), then a runtime owner, then `activeChatRunId(task.chatId)`, then — for a manual-only close (`isManualOnlyTransition` + `isSettled`) — a linked job run still `pending`/`running`. All throw `TaskError('invalid_transition', …)` with category words (`statusLabel`, `manualRefusal`). Without `manual`, only the plain `canTransition` check applies.
- `taskService.create` validates `customFields` with `checkedCustomFields` (shared `validateTaskCustomFields`, then empty → null).
- `taskService.applyRemoteSnapshot` — a pulled `updatedAt` is taken only when it is not older than the row's own; otherwise the row keeps its time. Taken unconditionally, a pull carrying the remote's older time moved `updatedAt` back below the device-sync watermark, so a local-only edit to a bound task (custom fields, router) was never pushed to the user's other devices.
- `syncedCustomFields(plaintext)` in `sync/collections.ts` — absent key → `undefined` (keep), `null` → clear, a value → `validateTaskCustomFields`; a refused value → `undefined`, never half-applied.

## Renderer Components

- `TasksButton` — 29 px top-bar control, `aria-label="Tasks"`, `aria-pressed` while `activeView === 'tasks'`; renders nothing while `showTasksButton` is false. Mounted in `TopBar` between `SidebarButton` and `AgentStatusButton`, with `TOPBAR_BTN`, so it takes part in the header wave (`.ambient-header-button`).
- `TasksView` — `useTaskList({rootOnly: true})`, `useAgents`, `useFolderBoard(agentId)` while the board is filtered to one agent (the loading line until it answers), the header row (List | Board group, agent `<select>`, search, New task), the absolutely placed `role="alert"` move-error line, and loading / empty / no-match / error states. Owns `useCreateTask` with a hook-level `onCreated` that closes the dialog and opens the task, so a dialog that has unmounted cannot drop it. Scroller marked `data-tasks-scroll`.
- `TasksList` — one `TasksListSection` per `LIST_SECTION_ORDER` category, each through `useTaskRowsInPlace(tasks, page, '[data-tasks-scroll]')`; Done pages by 10. Rows are `TaskRow` with `showAssignee` while the filter is All agents.
- `TasksBoard` — five `BoardColumn`s (`data-board-column`), or, given `folderColumns`, one per folder word (`data-tasks-board="folder"`, `data-folder-column`, `data-droppable`; columns frozen during a drag; see [Folder Tasks](../tasks/folder_tasks_tech.md#renderer-components)), `BoardCard` (`data-task-card`, draggable only with targets) and `CardMenu` (`role="menu"`, **Move to {column}**). Drag data type `application/x-cinna-task`; a column that the dragged card cannot reach sets `dropEffect = 'none'`. Optimistic overrides are a `Map<taskId, {status, label?, seq, from}>`, cleared by a read showing the written status or any status other than `from`, and per move by `seq` on a refusal.
- `tasksViewModel.ts` — `taskAgentKey` / `agentFilterOptions` / `matchesTaskFilters` (filter value `all`, `none`, or `agent:<id>`; `none` matches every task without an agent or remote-agent assignee), `LIST_SECTION_ORDER`, `isUserColumn`, `boardMoveTargets` (empty unless `executor === 'desktop'`, `runsHere` and no `runtime`; then `manualTargets` with `bound = isTableBound(task)` — `remote` set and no `file` — mapped to other user columns), `folderMoveTargets` / `folderColumnIndex` (the folder board's rules), `taskStatusText` (a task's `statusLabel` as written, else `taskStatusLabel`), `taskFileName`, `customFieldText`, `taskStatusLabel` (the category words, closed split into Done/Failed/Cancelled, `Archived`; unknown strings printed as words), `isUnassigned` (`model` and no `chatId`).
- `TaskFormDialog.tsx` — `NewTaskDialog` (title + Enter; More options) and `EditTaskDialog` (opened from `TaskActionsMenu`'s **Edit task…**, which owns `useUpdateTask` and `useSetTaskStatus` because it outlives the dialog). `assigneeLockReason` and `statusLockReason` mirror main's refusals from the DTO to disable controls; main stays the authority. `editTargets` = `manualTargets` minus a status in the same category; for a file task `statusChoices` offers the folder board's targets with their words instead, and `ReadOnlyFields` lists the file's nested fields, which `fieldsFrom` carries through unchanged. New task's status options take the assignee folder's words (`newStatusWords`). `fieldsFrom` keeps a field's original typed value while its text is untouched, else stores the text; duplicate and empty names are refused before sending. `useDismiss` lets Escape/outside click close only an unchanged, idle form.
- `TaskAssigneeChip` — agent type icon (in its chosen color) and name; nothing for a task without an agent.
- `TaskView` — `customFieldEntries` under a `Fields` section in Details (`Detail asWritten`); for a file task the **File** row (name, Reveal, the changed-outside glyph) and **Blocked by**; assignee **Unassigned** via `isUnassigned`; the back arrow precedence is Parent task → **Back to Tasks** (when `taskOpenedFromTasks`) → Back to {job} → Back to the Inbox.
- `TaskStatusPill` / `TaskRow` — words from `taskStatusText`: a folder word as written (no small capitals), else `taskStatusLabel`.
- `useTasks.ts` — `useOpenTask` sets `taskOpenedFromTasks` from the view it is called in (`tasks`, or `task` while already set), so a parent/subtask hop keeps the way back. `useFolderBoard(agentId)` (`['tasks', 'folder-board', agentId]`, polled every 5 s). `useCreateTask`, `useUpdateTask`, `useSetTaskStatus` (a third `label` argument only when given) write the task's query and invalidate `['tasks']` (the last two also the Inbox).
- `ui.store.ts` — `ActiveView` includes `'tasks'`; `taskOpenedFromTasks`, `showTasksButton`, `tasksViewMode`. `setShowTasksButton(false)` while on the view switches to `'chat'`. `SidebarTabs`' `TABLESS_VIEWS` and `useSync`'s `SYNCED_VIEWS` include `'tasks'`.

## Configuration

- `localStorage['cinna-show-tasks-button']` — `'0'` hides the button; anything else (including absent) shows it. Machine-wide, not per profile; the `storage` listener in `ui.store.ts` applies a change from another window through `setShowTasksButton`.
- `localStorage['cinna-tasks-view-mode']` — `'board'`, else List.
- No `app_settings` key; the toggle is a renderer preference like Extra UI animation.

## Security

- Both `task:create` and `task:update` payloads are rebuilt field by field in `task.ipc.ts`, never spread; custom fields are re-validated in `taskService` and again on device-sync apply.
- The assignee is resolved and checked in main against the active profile and settings scopes; the renderer sends only an agent id.
- Manual status writes keep `requireRunsHere`, so the claim gates them as it gates every status write.
