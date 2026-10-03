# Folder Tasks: Technical Details

## File Locations

| Layer | Files |
|---|---|
| Shared (pure) | `src/shared/folderTasks.ts` — constants, the status vocabulary, `_board.yaml`, the board columns, the parser and the line-level patcher; `src/shared/frontmatter.ts` — the frontmatter subset shared with `handovers.ts`; `src/shared/tasks.ts` — `TaskFileRef`, `TaskLocalFile`, `TaskDto.statusLabel` / `file` / `fromOutside` |
| Adapter | `src/main/tasks/adapters/folderTaskAdapter.ts` (`createFolderTaskAdapter(world)`, `FOLDER_ADAPTER_ID`, `FOLDER_ABSENCE_GRACE_MS`, `FolderFs`, `FolderTaskWorld`), `folderTaskAdapter.wiring.ts` (the production world), `folderTaskFs.ts` (the real filesystem), `statusWords.ts` (the synchronous status-word seam), `index.ts` (`registerAdapter(folderTaskAdapter)`, `localHomeFor`) |
| Services | `src/main/services/taskSyncService.ts` (`createInHome`, `removeTask`, `folderBoard`, the device-local push hook, `dropConfirmedMissing`, `busyHere`), `taskAuthoringService.ts` (`createRouted`, `setStatus`), `taskService.ts` (`statusWordPatch`, `setStatus` `label` / `bound`, `applyRemoteSnapshot`, `applySyncedTask` refusal, `assigneeEditRefusal`) |
| Watcher | `src/main/services/localAgents/watcherService.ts` (`tasks` target), `localAgentService.ts` (`onTasks` wiring) |
| Database | `src/main/db/schema.ts`, `src/main/db/migrations/tasks.ts`, `src/main/db/tasks.ts` |
| IPC / preload | `src/main/ipc/task.ipc.ts` (`task:create`, `task:set-status`, `task:folder-board`, `task:delete`, `statusLabelInput`), `src/preload/index.ts` (`tasks.setStatus(taskId, status, label?)`, `tasks.folderBoard(agentId)`) |
| Renderer | `src/renderer/src/components/tasks/TasksBoard.tsx`, `TasksView.tsx`, `TaskView.tsx` (`TaskFileValue`, `BlockedByValue`), `TaskFormDialog.tsx` (`statusChoices`, `heldReason`, `ReadOnlyFields`, `newStatusWords`), `TaskStatusPill.tsx`, `TaskRow.tsx`, `tasksViewModel.ts` (`folderMoveTargets`, `folderColumnIndex`, `isTableBound`, `taskStatusText`, `taskFileName`), `src/renderer/src/hooks/useTasks.ts` (`useFolderBoard`, `FOLDER_BOARD_QUERY_KEY`, `useSetTaskStatus`) |
| Tests | `src/shared/folderTasks.test.ts`, `src/main/tasks/adapters/folderTaskAdapter.test.ts`, `src/main/tasks/adapters/adapterContract.test.ts` (the folder subject), `src/main/services/taskSyncService.folder.test.ts`, `src/main/sync/taskCollection.test.ts` (device-local), `src/main/services/localAgents/watcherService.test.ts`, `src/main/ipc/task.ipc.test.ts`, `src/renderer/src/components/tasks/TasksView.test.tsx`, `TaskView.test.tsx` |

## Database Schema

Four columns on `tasks`, added idempotently by `migrateTasks` (`src/main/db/migrations/tasks.ts`); null/false on every older row:

- `status_label` (text) — the home's word for the status. Written with the status, never apart from it.
- `device_local` (integer boolean, default 0) — set at creation only (`TaskCreateInput.deviceLocal`), never by a patch. Excluded from `taskRepo.listChangedSince` and guarded by `setWhere: eq(tasks.deviceLocal, false)` on the sync upsert.
- `trusted_digest` (text) — sha256 of content Cinna wrote. Never synced.
- `local_file` (JSON `TaskLocalFile`: `path`, `digest`, `readOnlyFields`, `blockedBy`) — the file as last read. Never synced. The DTO's `file` drops the digest; `fromOutside` is `!!localFile && localFile.digest !== trustedDigest` (`toTaskDto`).

The binding's opaque `remote_state` holds `FolderState`: `file` (current name — a rename keeps the id), `readDigest`, `writtenDigest?`, `stamp`, `base` (`title`, `description`, `priority`, `status`, `custom` as JSON strings). Binding `id` is `<agentId>:<fileId>`, `key` the file id, `url` null.

## IPC Channels

| Channel | Signature / behaviour |
|---|---|
| `task:create` | Now `taskAuthoringService.createRouted`: an `agent` assignee that `localHomeFor` accepts goes to `taskSyncService.createInHome`; everything else `taskService.create` as before |
| `task:set-status` | `(taskId, status, label?)`. `statusLabelInput` accepts null/undefined or a string ≤ 200 chars. Routed through `taskAuthoringService.setStatus`, which asks the bound adapter's `capabilities().transitionTable` for `bound`, and refuses a label unless the task is `deviceLocal` with an agent and the label's column (or, with no such column, the default table) means that status |
| `task:folder-board` | `(agentId) → TaskBoardColumn[] \| null`. `taskSyncService.folderBoard`; null when no local home accepts the agent. Columns rebuilt field by field: `label`, `category`, `status`, `droppable` |
| `task:delete` | Now `taskSyncService.removeTask`: `removeWithJobRun`, then `localHome.discard` for a task bound to a local home |

## The Adapter Seam

The parts of `src/main/tasks/adapters/adapter.ts` a local home uses, and what the folder adapter answers:

- **Capabilities** — `clearHandoffNote?` (the note's place can be emptied: `putHandoffNote(…, null)`), `handoffTarget` (may be chosen by `preferredAdapter` / named by a hand-off), `transitionTable` (pushes walk `taskStatusPath`; manual moves keep the remote table). Folder: `create`, `writeStatus`, `archive`, `writeFields: [title, description, priority, customFields]`, `handoffNote`, `clearHandoffNote`, `subtasks` true; `assigneeDirectory`, `comments`, `execute`, `asks`, `handoffTarget`, `transitionTable` false; no artifact kinds. cinna and the fakes say `handoffTarget: true, transitionTable: true`; the null adapter `false` / `true`.
- **`RemoteWritableField`** gains `customFields` (also in `REMOTE_DIRTY_FIELDS`, `RemoteTaskFields.customFields`). `taskService.update` now marks it on any bound task; `pushOne` drops it for a remote whose `writeFields` lack it (cinna).
- **`RemoteTaskSnapshot`** gains optional `statusLabel`, `customFields` and `file` (`RemoteLocalFile`: `path`, `digest`, `ours`, `readOnlyFields`, `blockedBy`). A snapshot with `file` makes the replica device-local on insert (`upsert`: `executor: 'desktop'`, `deviceLocal: true`); `file.ours` sets `trustedDigest`.
- **`putHandoffNote(userId, binding, note: string | null)`** returns `RemoteBinding | void`; a returned binding replaces the one the push carries, so the new `writtenDigest` is stored.
- **`pushStatus(…, reason?, options?: RemoteStatusOptions)`** — `options.label` is the person's word or the task's current label. `pushOne` sends the destination directly with `{label: row.statusLabel}` when `transitionTable` is false.
- **`localHome?: RemoteLocalHome`** — `accepts(agentId)`, `board(userId, agentId, shown: RemoteBoardTask[])`, `statusWord(remoteId, status, current)` (synchronous, from the folder as last read; undefined before a read), `discard(userId, binding)`. Callers find it by `localHomeFor(agentId)`, never by id.
- **`stateWhileOwed?(stored, incoming, owed)`** — the binding state a pull stores on a row that still owes fields. Folder: the incoming state with `base` of each owed field kept from the stored one. Applied by `owedStateOf` in `patchFrom` whenever the target row is passed (`upsert`, `dropMissing`, `pullSingleTask`, `createInHome`).
- **`statusWords.ts`** — `installStatusWordResolver(adapterId, resolver)` (called by `registerAdapter` for every adapter with a `localHome`) and `homeStatusWord(task, status)`. A seam rather than an import because `taskService` sits under the registry and must not load it. `taskService.statusPatch` uses it via `statusWordPatch` on every status change.

## Services & Key Methods

### `folderTaskAdapter.ts`

- `readFolder(agent)` — one `fs.list`; `_board.yaml` and each task file re-read only when the `mtimeNs:size` stamp moved (`cache`, `boards`). Null for a missing or symlinked directory (`forgetAbsences`, `lastRead.delete`); a listing that throws is `unavailable`. A file that fails to read or parse falls back to its cached item, else goes in `unparsed`. A second file claiming an id is skipped. Records `lastRead` for `statusWord`.
- `snapshotOf` — `subtaskCount` / `subtaskCompletedCount` from the same pass's `folder.items`: files whose `parent` is this id, completed when `folderStatusOf` gives `completed`. The task DTO's own counts still come from the child rows (`taskRepo.subtaskCounts`).
- `list(userId)` — every enabled bare agent; one failing folder is logged and skipped, all failing throws. `writtenDigest` comes from `world.states(userId)` (the stored bindings), so `ours` survives a restart.
- `fetch` → `current(binding, true)` → `confirmGone`: `not_ours` only on a second absence ≥ `FOLDER_ABSENCE_GRACE_MS` (30 s) after the first, never for a name in `unparsed`. `absentSince` is in memory.
- `locate(binding)` — an agent that is disabled or removed is `unavailable`, not `not_ours`.
- `forWrite(binding)` — fresh `fs.read` of the listed path, re-parse, id check; anything off is `unavailable`. `write()` patches with `patchFolderTaskFile`, skips an unchanged text, publishes with `fs.replace`, returns the binding with the new `writtenDigest`.
- `pushFields` — the merge: `title` / `description` / `priority` skipped when `base[key]` differs from the file; `customPatch` does the same per custom key, never touches a read-only key, and removes an editable key the task no longer has.
- `pushStatus` refuses `archived` (`archive()` writes it), and merges as `pushFields` does: when `base.status` differs from the file's word it writes nothing and returns `bindingFor` the file read now, so the marker clears and the next pull applies the file's word (`stateWhileOwed` keeps `base.status` while `status` is owed). `archive()` does not merge. `wordFor` honours a label that `folderLabelMapsTo` the status, else `folderWordForStatus`.
- `create` — `ensureDir`, parent must be a binding in the same folder, `folderTaskId` (8 random bytes → `t-` + base32) until unused, `renderFolderTaskFile`, then `fs.create` on `<slug>.md`, `-2` … up to 100 attempts (`rejected` after).
- `localHome.board` — `folderBoardColumns(board, inUse + shown words, occupied categories of shown tasks without a word)`. `localHome.discard` — reads the listed file now and removes it only when it still parses to this id.
- `asRemoteError` — `EACCES`/`EPERM`/`EROFS`/`ELOOP`/`EISDIR` → `rejected`; anything else `unavailable`.

### `folderTaskFs.ts`

`list` refuses a non-real directory at both `.cinna` and `tasks`; `read` opens with `O_NOFOLLOW`; `replace` lstat-checks then temp (`O_EXCL | O_NOFOLLOW`, `.<name>.<uuid>.tmp`) + `rename`; `create` temp + `link` (null on `EEXIST`); `remove` refuses a non-regular file and ignores `ENOENT`. Every write goes through `redactCredentialText`.

### `folderTasks.ts` (pure)

`FOLDER_TASKS_DIR`, `FOLDER_BOARD_FILE`, `HANDOFF_OPEN` / `HANDOFF_CLOSE`, `FOLDER_TASK_OWNED_KEYS`, `isFolderTaskFileName`; `FolderStatusCategory`, `FOLDER_CATEGORY_STATUS`, `DEFAULT_FOLDER_STATUS_WORDS`, `folderCategoryForStatus`, `normalizeStatusWord`, `parseFolderBoard`, `folderCategoryOf`, `folderStatusOf`, `folderLabelMapsTo`, `folderBoardColumns` (`TaskBoardColumn`, droppable = `new | open | completed | cancelled`), `folderWordForStatus`; `parseFolderTaskFile(text, stem)` → `ParsedFolderTask` (custom fields failing `TASK_CUSTOM_FIELD_KEY` or in `TASK_RESERVED_FIELD_KEYS` are left out of the task, so a later field edit cannot fail on a key the user never touched; capped at `TASK_CUSTOM_FIELDS_MAX`), `folderCustomFields`; `patchFolderTaskFile(text, FolderTaskPatch)` (owned scalars, one-line custom keys, `description`, `handoffNote`; throws on no frontmatter); `renderFolderTaskFile`, `formatFolderValue`, `folderTaskSlug`, `folderTaskFileName`, `folderTaskId`.

### `taskSyncService.ts`

- `createInHome(userId, adapter, input)` — `taskService.create({…, deviceLocal: true})`, `unboundCreates` held for the adapter's cursor key during `adapter.create` and `bindRemote` (so a pull in between does not index the file), row removed on a create failure (`TaskError('invalid_input', …)`), `localHome.discard` when `bindRemote` fails, then one `fetch` + `applyRemoteSnapshot`; a failed read-back is only a warning.
- `removeTask(userId, taskId)` — `removeWithJobRun` first, awaits `pushesInFlight` for the task, then `localHome.discard`; a discard failure is logged.
- `folderBoard(userId, agentId)` — `localHomeFor`, then `board()` with every row assigned to the agent.
- `dropMissing(…, deviceLocalOnly)` — device-local rows are confirmed whatever their origin and status; on a non-reconcile pass, `pullRemoteTasks` runs it with `deviceLocalOnly` when the adapter has any device-local row. `dropConfirmedMissing` keeps a device-local row while `busyHere` (task runtime, script runtime owner, active run or runner in its chat, open input request), else unbinds and removes it (`origin === 'remote' || deviceLocal`). `pullSingleTask` takes the same route for a device-local row and sets a refresh error while it is kept.
- `preferredAdapter` skips `handoffTarget: false`; `performHandoff` refuses it with `unsupported`.
- The `installTaskRunnerHooks(…, 'device-local-push')` listener at the foot of the module: on `taskChanged`, coalesced per task with `setImmediate`, pushes a non-deleted `deviceLocal` row with a remote adapter and owed markers, unless a push is in flight. Keyed on `deviceLocal`, never on the adapter id; kept out of `taskService` because the device-sync apply path imports it.

### Others

- `taskAuthoringService.prepare` — the validation shared by `create` and `createRouted`. The sync stack is imported lazily.
- `taskService.setStatus` — `opts.bound` overrides "has a remote adapter" for the manual check; `opts.label` is stored after `statusPatch`. `applyRemoteSnapshot` takes `statusLabel` with the status (skipped while `status` is owed), `customFields` unless owed, `localFile`, `trustedDigest`. `applySyncedTask` returns null for a local `deviceLocal` row.
- `watcherService.classifyExternalEvent` — `{kind: 'tasks', agentDir}` for any path holding the `.cinna` + `tasks` pair, checked after `handovers` and before the dot-entry rule; `flush` calls `deps.onTasks` once per window. `localAgentService` wires it to `taskSyncScheduler.refresh()` (dynamic import).

## Renderer Components

- `TasksView` — with the board and an `agent:<id>` filter, `useFolderBoard(agentId)`; shows the loading line until it answers (no five-column flash), falls back to categories on failure or null.
- `TasksBoard` — `folderColumns` prop. `ColumnSpec` per column (`key` = normalized word, `drop` only when `droppable`); `data-tasks-board="folder"`, `data-folder-column`, `data-droppable`. `heldColumns` freezes the columns during a drag. `targetsOf` uses `folderMoveTargets`; the drop sends `label` only for a task with `file`. Optimistic `moved` entries carry the label so the card shows the dropped word.
- `tasksViewModel.ts` — `isTableBound(task)` (`remote && !file`) used by `boardMoveTargets` and the edit dialog; `folderMoveTargets`, `folderColumnIndex`, `taskStatusText` (label else category words), `taskFileName`.
- `TaskStatusPill` (`label` prop, as-written without small capitals), `TaskRow` (accessible name via `taskStatusText`).
- `TaskView` — pill and tooltip show `statusLabel`; the remote key row is hidden for a file task; **File** row (`TaskFileValue`: file name in mono, full path on hover, `data-task-file`, **Reveal** through `window.api.agentFiles.reveal({agentId, path})`, which re-checks containment in main; a refusal replaces the name for 6 s on the same line; `fromOutside` → a `PenLine` glyph, `data-task-from-outside`, "Changed outside Cinna"); **Blocked by** row (`BlockedByValue`: an id matching the `remote.key` of another root file task of the same agent links to it, else the id as written).
- `TaskFormDialog` — New task: `newStatusWords(useFolderBoard(assignee))` renames the Backlog/Ready options. Edit task: `assigneeLockReason` locks a file task; `heldReason` says "Set in the task file by its agent." for a file task in progress or blocked; `statusChoices` offers the folder board's targets with their word (select disabled while the board is pending); `ReadOnlyFields` lists `file.readOnlyFields` under a tip, and `fieldsFrom` carries them through unchanged and refuses a row reusing their name.
- `useTasks.ts` — `useFolderBoard` (`['tasks', 'folder-board', agentId]`, polled every 5 s, `retry: 1`); `useSetTaskStatus` sends a third argument only when a label is given.

## Configuration

None. Folder tasks are on for every enabled bare agent; switching an agent off keeps its tasks (unavailable) and stops reading its folder.

## Security

- **No symlink followed** at `.cinna`, `tasks` or a file (`folderTaskFs`), the same rule as [file handovers](file_handovers_tech.md#security).
- **Atomic publish, no clobber on create**; credentials redacted from every write.
- **The renderer never sees the digest** or the binding state; `file` is display facts, `fromOutside` a boolean. Payloads to `task:set-status` and `task:folder-board` are type-checked; columns are rebuilt field by field.
- **Reveal** goes through `agent-files:reveal`, where main resolves the agent folder from its own index and re-checks the realpath.
- **Outside content is recorded, not gated** — `trusted_digest` and `fromOutside` are display facts; no code path reads them for a decision.
