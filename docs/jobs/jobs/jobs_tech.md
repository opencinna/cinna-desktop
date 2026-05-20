# Jobs — Technical Details

## File Locations

### Main process
- `src/main/db/schema.ts` — `jobs` (with `folderId` / `position` columns), `jobFolders`, `jobMcpProviders`, `jobRuns` tables; `chats.originatingJobRunId` column
- `src/main/db/migrations/jobs.ts` — `migrateJobs()` — inline-SQL `CREATE TABLE IF NOT EXISTS` for the four job tables (`jobs`, `job_folders`, `job_mcp_providers`, `job_runs`), indexes on `jobs.user_id`, `job_folders.user_id` and `job_runs.job_id`, plus idempotent `ALTER TABLE` adds for `chats.originating_job_run_id`, `chats.hidden_from_list`, `jobs.folder_id`, and `jobs.position` (all guarded via `hasColumn`)
- `src/main/db/client.ts` — `migrateJobs(sqlite)` invoked from `runMigrations()` after chats + mcp_providers + chat_modes (FK dependencies)
- `src/main/db/jobs.ts` — `jobsRepo` (CRUD + soft delete + `minPositionInFolder` + `reorderInGroup` transaction that rewrites every passed id with the target group's `folderId` and a fresh `position = index`), `jobFoldersRepo` (CRUD + `reorder` transaction + `delete` transaction that detaches contained jobs to root before dropping the folder row), `jobMcpRepo` (`listProviderIds`, `setProviderIds`), `jobRunsRepo` (`listByJob` — LEFT-joins `chats` and returns `JobRunRowWithMeta` with a derived `chatHidden` boolean —, `countInProgressByJob` — single `GROUP BY job_id` aggregate over rows with `status IN ('pending','running')`, used by the sidebar spinner —, `getById`, `getByLocalChatId`, `create`, `updateStatus`, `createLocalChatAndRun` transaction that sets `hiddenFromList = true` on the spawned chat). New jobs land at `position = min(position) - 1` of the root group so they appear at the top of the ungrouped list.
- `src/main/db/chats.ts` — extended `chatRepo.create()` accepts `init?` (title/modelId/providerId/modeId/agentId/originatingJobRunId/`hiddenFromList`); `chatRepo.setOriginatingJobRunId(userId, chatId, runId)` back-pointer setter; `chatRepo.list(userId)` filters out hidden-from-list chats; `chatRepo.showInList(userId, chatId)` clears the flag (promotes a hidden chat to the main list)
- `src/main/services/jobService.ts` — `jobService` — `list` (returns `JobListItem[]` = `JobRow & { inProgressRunsCount: number }`, joining `jobRunsRepo.countInProgressByJob` so the sidebar can render a per-row spinner without a second IPC call), `getDetail`, `create`, `update`, `softDelete`, `setMcpProviders`, `listRuns`, `execute` (discriminated dispatcher), `executeLocal`, `executeCinnaTask`, `refreshCinnaRun`, `reportRunCompletion`, `setRunStatus`, `getCinnaServerUrl`, `listFolders`, `createFolder` (trims + validates name non-empty), `updateFolder` (validates + filters patch keys, refetches the row to return), `deleteFolder`, `reorderFolders` (logs `folders reordered { count }`), `reorderJobs` (validates target folder ownership when non-null, walks `orderedJobIds` and asserts every id maps to a non-deleted job in the active scope, then calls `jobsRepo.reorderInGroup`; logs `jobs reordered { targetFolderId, count }`). Private `mapCinnaStatus()` translates cinna-core status values into local `JobRunStatus`. Private `enrichRun(userId, run)` attaches the `chatHidden` boolean for single-row methods (`refreshCinnaRun`, `setRunStatus`) so every IPC return matches the same `JobRunRowWithMeta` shape as `listRuns`.
- `src/main/services/cinnaApiService.ts` — `cinnaApiService` — handwritten REST client for cinna-core: `listAgents`, `createTask`, `getTaskDetail`, `getTaskView` (full `InputTaskDetailPublic` with comments + attachments — see [Cinna Task Run View tech](../cinna_task_view/cinna_task_view_tech.md)), `getServerUrl`. Internal `cinnaFetch()` helper centralizes auth-header + `net.fetch` + error mapping; raises `CinnaApiError('reauth_required')` on 401/403.
- `src/main/services/chatStreamingService.ts` — `_runStreamLoop` calls `jobService.reportRunCompletion(chatId, 'succeeded' | 'failed', errorMessage?)` on `done` / catch path
- `src/main/services/a2aStreamingService.ts` — same hook at the agent stream's `done` / catch path
- `src/main/ipc/job.ipc.ts` — `registerJobHandlers()` — all `job:*` and `jobFolder:*` channels wrapped via `ipcHandle()`, each calls `userActivation.requireActivated()` then delegates to `jobService`. Channels added for folders: `jobFolder:list/create/update/delete/reorder` and `job:reorder` (for moving + reordering jobs across groups).
- `src/main/ipc/cinna.ipc.ts` — `registerCinnaHandlers()` — `cinna:list-agents`, `cinna:get-task-view` delegating to `cinnaApiService`
- `src/main/ipc/app.ipc.ts` — `app:open-external` handler — restricts to `http:` / `https:` before `shell.openExternal`
- `src/main/ipc/index.ts` — `registerJobHandlers()` and `registerCinnaHandlers()` registered in `registerAllIpcHandlers()`
- `src/main/errors.ts` — `JobError` + `JobErrorCode` (`not_found | not_activated | unsupported_type | missing_dependency | invalid_input`); `CinnaApiError` + `CinnaApiErrorCode` (`not_cinna_user | missing_server_url | reauth_required | request_failed | invalid_response`)

### Shared
- `src/shared/jobs.ts` — `JobData` (now carries `folderId: string | null` + `position: number`), `JobRunData`, `JobDetailData`, `JobCreateInputDto`, `JobPatchDto`, `JobType`, `JobRunStatus`, `JobFolderData`, `JobFolderCreateInputDto`, `JobFolderPatchDto` — imported by both preload and renderer (the preload `.ts` is not exposed to the renderer compiler, so DTOs live in `shared/`)

### Preload
- `src/preload/index.ts`:
  - `window.api.jobs` — `list`, `get`, `create`, `update`, `delete`, `setMcpProviders`, `listRuns`, `execute` (returns discriminated union `{ type: 'local' | 'cinna_task', ... }`), `cancelRun`, `refreshRun(runId, options?: { force?: boolean })`, `cinnaServerUrl`, `reorder(targetFolderId, orderedJobIds)`
  - `window.api.jobFolders` — `list`, `create({ name })`, `update(folderId, { name?, collapsed? })`, `delete(folderId)`, `reorder(orderedIds)`
  - `window.api.cinna` — `listAgents`, `getTaskView(taskId)` (see [Cinna Task Run View tech](../cinna_task_view/cinna_task_view_tech.md))
  - `window.api.files.downloadTaskAttachment({ taskId, attachmentId, filename })` — task-scoped download path used by the run view's attachment badges
  - `window.api.system.openExternal(url)` — wraps `app:open-external` IPC

### Renderer
- `src/renderer/src/stores/ui.store.ts` — adds `sidebarTab: 'chats' | 'jobs'`, `activeJobId: string | null`, `activeCinnaRunId: string | null` (run currently open in the task view), and `'job-detail' | 'job-edit' | 'cinna-task-run'` to `ActiveView`. Setters: `setSidebarTab`, `setActiveJobId`, `setActiveCinnaRunId`. Not persisted to localStorage at MVP.
- `src/renderer/src/hooks/useJobs.ts` — `useJobList`, `useJob(jobId)`, `useJobRuns(jobId)`, `useCreateJob` (accepts an optional `Partial<JobCreateInputDto>`; defaults `type` to `'local'`; **navigates to `'job-edit'` on success** so new jobs land on the form), `useUpdateJob`, `useDeleteJob`, `useDeleteJobRun` (hard-delete a run; on success invalidates `['jobs', jobId, 'runs']` and, if the response says the originating chat was hard-deleted too, `['chats']` + `['trash']` + clears `activeChatId` when it matched), `useSetJobMcps`, `useExecuteJob` (`useMutation` — variables are `ExecuteJobInput = { jobId, navigate?: boolean = true }`; wraps `window.api.jobs.execute`, branches on returned type; **does not** swap the sidebar to `'chats'` so the user stays in the jobs context; when `navigate === false` it skips the `setActiveChatId/setActiveView('chat')` calls so the sidebar "run now" button can fire-and-forget without leaving the jobs list; always invalidates `['jobs']` after success so the sidebar `inProgressRunsCount` ticks up immediately), `useOpenChatFromRun` (navigation helper; preserves both `sidebarTab` and `activeJobId` so the originating job stays highlighted while its chat is open). Folder hooks: `useJobFolders` (`['job-folders']` query), `useCreateJobFolder`, `useUpdateJobFolder` (also used for the collapse/expand toggle), `useDeleteJobFolder` (invalidates both `['job-folders']` AND `['jobs']` since contained jobs detach to root), `useReorderJobs` ({ targetFolderId, orderedJobIds }), `useReorderJobFolders` (orderedIds[]). `useDeleteJob.onSuccess` reads `useUIStore.getState().activeJobId` at completion time and resets the view only if it was on `'job-detail'` or `'job-edit'`. `useExecuteJob` falls back to `useDefaultChatMode` when the job left `modeId` null (otherwise the spawned chat has no provider/model and the stream rejects it).
- `src/renderer/src/hooks/useChat.ts` — adds `useShowChatInList()` mutation wrapping `window.api.chat.showInList(chatId)`; on success invalidates `['chats']` (so the chat shows up in the sidebar) and `['jobs']` (so the run row's `chatHidden` flips and the "Move to Chats" button disappears).
- `src/renderer/src/hooks/useStartNewChat.ts` / `src/renderer/src/components/chat/ChatItem.tsx` — both clear `activeJobId` when entering a non-job navigation (new chat from the top-bar `+`, or picking a chat from the Chats list) so the job-highlight only persists while the user is genuinely inside the job's context.
- `src/renderer/src/hooks/useCinna.ts` — `useCinnaAgents`, `useRefreshCinnaRun` (variables: `{ runId, force? }` — force=true is passed by the manual button so terminal runs still hit the network), `useCinnaServerUrl`. All gated on `useAuthStore((s) => s.currentUser?.type === 'cinna_user')`.
- `src/renderer/src/hooks/useCinnaTaskView.ts` — `useCinnaTaskView(taskId, { polling? })` (5s background refetch while non-terminal when `polling: true`; `staleTime = 60_000` and no auto-refetch when `polling: false`, used by the row badges so visible cinna_task rows don't each fan out a poll). Shared query key with the detail view: `['cinna', 'task-view', taskId]`. Also exports `useInvalidateCinnaTaskView()` for the manual refresh button.
- `src/renderer/src/hooks/useTaskAttachmentDownload.ts` — façade over `taskAttachmentDownload.store`. See [Cinna Task Run View tech](../cinna_task_view/cinna_task_view_tech.md) for the store + IPC details.
- `src/renderer/src/hooks/useCinnaRunPoll.ts` — `useCinnaRunPoll(runs)`. Memoizes the non-terminal id set, uses a `ref` for the active id snapshot, registers a single `setInterval` (5s focused / 10s hidden, swapped on `visibilitychange`) and clears it when the active set empties.
- `src/renderer/src/components/layout/SidebarTabs.tsx` — Icon-only book-tab rail (`MessageSquare` for Chats, `Briefcase` for Jobs). Buttons carry `aria-pressed` for the active-tab CSS hook. Tab-switch handler realigns the main area: for Chats, reads `useChatList` and sets `activeChatId` to the first chat (or null when empty), switching `activeView` to `'chat'`. **For Jobs, intentionally clears `activeJobId` and routes to `'job-detail'` — the empty pane** (auto-selecting the first job is misleading when jobs can sit inside a collapsed folder). Clears `activeCinnaRunId` on every switch. Re-clicking the active tab is a no-op.
- `src/renderer/src/components/layout/Sidebar.tsx` — Renders `<SidebarTabs />` as an absolute sibling of the sidebar card (in the chat-view branch only); the sidebar card itself is inset by `var(--sidebar-tab-rail)` so the rail sits outside its left edge. Hidden in the settings branch.
- `src/renderer/src/components/layout/MainArea.tsx` — Routes `activeView === 'job-detail'` to `<JobDetail />`, `'job-edit'` to `<JobEditPage />`, and `'cinna-task-run'` to `<CinnaTaskRunView />` before the chat branch
- `src/renderer/src/components/jobs/JobsList.tsx` — Sidebar Jobs list. Header (`px-3 pt-1` so top padding matches the `px-3` left padding) holds two icon buttons: `FolderPlus` (creates a "New folder" then opens the rename modal via `JobFolderEditModal` so the user can name it immediately) and `Plus` (opens `<JobTypePicker />` for Cinna users or fires `useCreateJob({ type: 'local' })`). Reads `useJobList` + `useJobFolders`; groups the jobs client-side into a `{ root: JobData[], byFolder: Map<folderId, JobData[]> }` structure ordered by the server-side `position`. Renders `JobFolderRow[]` followed by a root section that lists ungrouped jobs and acts as a drop target for "move out of folder." Provides `JobsDragContext` for child rows so drop-target highlighting only fires for compatible drag kinds. Reorder helpers: `reorderWithinGroup(folderId | null, draggedJobId, beforeJobId | null)` constructs the new full ordering of the destination group (insert-before) and posts via `useReorderJobs`; `moveJobToFolder(folderId | null, draggedJobId)` is the same with `beforeJobId = null` (append); `reorderFolderList(draggedFolderId, beforeFolderId | null)` rebuilds the folder ordering and posts via `useReorderJobFolders`.
- `src/renderer/src/components/jobs/dragContext.ts` — Tiny React Context (`JobsDragContext`, `useJobsDrag`) carrying the in-flight drag descriptor `{ kind: 'job' | 'folder', id } | null`. Set on `dragstart`, cleared on `dragend` / `drop`. Pure UI state, not server state — lives outside React Query / Zustand on purpose.
- `src/renderer/src/components/jobs/JobFolderRow.tsx` — Collapsible folder row. Header is `draggable` (folder reorder source); accepts drops of kind `job` (moves job into folder; `onDropJobInto`) or kind `folder` (reorders folder list; `onReorderFolder`). Body shows nested `JobItem`s when expanded; the empty body becomes a dashed "Drop a job here" zone while a `job` drag is in flight. Trailing slot: job count when idle, `Settings` (gear) on hover/menu-open opening an inline Edit/Delete dropdown (Pencil → `JobFolderEditModal`; Trash2 → frosted-glass confirm modal → `useDeleteJobFolder`). Single click on the header toggles collapse via `useUpdateJobFolder.mutate({ collapsed: !folder.collapsed })`. Visual accent feedback: `ring-1 ring-inset ring-[var(--color-accent)]` while accepting a job, `border-t-2 border-[var(--color-accent)]` while accepting a folder reorder, `opacity-40` while the header itself is the drag source.
- `src/renderer/src/components/jobs/JobFolderEditModal.tsx` — Portal-rendered rename modal (matches `JobTypePicker` styling — `bg-[var(--color-bg-secondary)]` rounded card, ESC + click-outside dismiss, Enter submits). Auto-focuses and selects the current name. Save calls `useUpdateJobFolder.mutate({ name })` and closes; no-op if the trimmed name matches the existing one.
- `src/renderer/src/components/jobs/JobTypePicker.tsx` — Modal portal styled like the onboarding welcome card (`max-w-[28rem]` rounded panel, Sparkles accent icon, two card buttons). ESC + click-outside dismiss. Calls `useCreateJob({ type })` on pick.
- `src/renderer/src/components/jobs/JobItem.tsx` — Single row. Active state is `activeJobId === job.id && (activeView === 'job-detail' || 'job-edit' || 'chat')` — also highlights while the user is viewing one of this job's spawned chats (because the open-chat flows preserve `activeJobId`). **No delete button** — delete now lives on the edit screen. Hover shows a small **green Play-icon pill** (`bg-[var(--color-success)] text-white w-4 h-4 rounded`) that fires `useExecuteJob({ jobId, navigate: false })` so the user can kick off multiple jobs without leaving the sidebar. While `executeJob.isPending || job.inProgressRunsCount > 0` the pill is replaced by a `Loader2` spinner tinted with `text-[var(--color-success)]`, shown **unconditionally** (not gated on hover). Both icons are pinned to `w-4 h-4` so the row height never shifts between idle, hover, and running states. Row is also `draggable` (drag source for job reorder/move); accepts drops of kind `job` from a different row via an optional `onDropJob(draggedJobId, beforeJobId)` callback that the parent (JobsList for root, JobFolderRow for folder bodies) wires up. While dragging, `dragstart` sets the row's inline `backgroundColor` to `var(--color-bg-secondary)` so the browser's drag preview rasterizes against the sidebar surface instead of painting white corners outside the rounded radius; `dragend` clears the inline style. Source row also gets `opacity-40` while it's the active drag, drop target gets `ring-1 ring-inset ring-[var(--color-accent)]`. `DeleteJobConfirm` is still defined and exported from this file (consumed by `JobEditPage`).
- `src/renderer/src/components/jobs/JobDetail.tsx` — Read-only view: header (title + type pill + **icon-only Edit pencil** + **green Run pill**), `<JobSummary>` (private subcomponent: prompt block + flex-wrap chip strip for non-default config), run-history section. Run uses `bg-[var(--color-success)] hover:brightness-110 text-white` (matches the sidebar's run pill / spinner); Edit is a square outlined icon-only button (`p-1.5`, Pencil glyph, `title="Edit job"`) that fires `setActiveView('job-edit')`. `useCinnaRunPoll(runs)` keeps cinna statuses fresh while the view is open. `JobSummary` resolves names via `useAgents` / `useChatModes` / `useMcpProviders` / `useCinnaAgents` / `useCinnaTeams`; the `CINNA_DEFAULT_PRIORITY = 'normal'` constant gates whether the priority chip is shown. Chips reuse the chat composer's pill pattern via a local `<Chip>` primitive (`pl-1.5 pr-2.5 py-1 rounded-lg border` with `neutral | accent | danger` tones); typed wrappers `AgentChip` (Bot, accent), `ModeChip` (color dot via `getPreset(colorPreset)`), `McpChip` (Wrench), `TeamChip` (Users), `NodeChip` (GitBranch), `PriorityChip` (Flag), `MissingChip` (danger tone for "No Cinna agent").
- `src/renderer/src/components/jobs/JobEditPage.tsx` — Full-page edit screen routed by `activeView === 'job-edit'`. Header: Back chevron (sets view back to `'job-detail'`), "Edit job" title, **icon-only Trash button immediately left of Save** that opens `<DeleteJobConfirm />` (imported from `./JobItem`), primary Save button. Save calls `formRef.current.flush()` and only navigates back to `'job-detail'` on `{ ok: true }`; validation failures (empty title / prompt) and update errors surface in an inline `role="alert"` banner. Delete uses `useDeleteJob` — its `onSuccess` clears `activeJobId` and routes back to the chat view when the deleted job was active. Form wrapped in the same `bg-[var(--color-bg-secondary)]` card the old single-screen JobDetail used.
- `src/renderer/src/components/jobs/JobEditForm.tsx` — Controlled form. Single `useEffect` debounces (`DEBOUNCE_MS = 600`) `useUpdateJob` against a `snapshotRef`; MCP toggles call `useSetJobMcps` immediately. No type selector — `type` is read-only from `job.type`; field set switches based on it (local vs. cinna_task). Exported via `forwardRef<JobEditFormHandle, JobEditFormProps>`; the handle's `flush()` builds the same patch the debounce would, validates title/prompt non-empty, and `await`s `updateJob.mutateAsync` so callers (i.e. `JobEditPage`'s Save button) can navigate only after persistence. Returns `{ ok: true } | { ok: false; error }`. **Agent + Cinna Agent fields** open `<AgentPickerModal>` (see below) — `<select>` was retired so the user gets a searchable card list with the chat agent popup's accent-tinted backdrop. The picker items are built locally: local agents are tagged with `protocol` and grouped by `source/remoteTargetType` (My Agents / Shared with Me / People / Local); Cinna agents are flat with a "Cinna" meta tag.
- `src/renderer/src/components/agents/AgentPickerModal.tsx` — Generic modal-based agent picker (`{ items: AgentPickerItem[], selectedId, onSelect, onClose, allowNone?, noneLabel?, noneDescription?, searchPlaceholder?, emptyLabel? }`). Reused by the Job Edit form's two agent fields and intended for any future "pick an agent" surface. Fixed `34rem × 32rem` size so filtering doesn't reflow the modal. Frosted accent-tinted panel matching the chat agent popup (`bg-[var(--color-accent)]/10 backdrop-blur-xl border border-[var(--color-accent)]/25`); cards sit on an opaque `--color-bg-secondary` base with an accent gradient overlay on active/selected. Keyboard nav: ↑/↓/←/→ navigate, Enter selects, Esc closes. Search input auto-focuses on open, filters by name/description/meta.
- `src/renderer/src/components/jobs/JobRunRow.tsx` — Status pill + relative timestamp via `formatRelativeFromDate(createdAt, now)` (`src/renderer/src/utils/cinnaTime.ts`). **All action icons are static** — no hover gate, no decorative idle icon. Action button onClicks `stopPropagation()` to avoid bubbling into the row-click. Renders a `createLogger('job-run-row')` trace on every manual cinna refresh + on its failure path.
  - **Local runs**: the whole `<div role="button">` is clickable (keyboard: Enter/Space) and fires `useOpenChatFromRun(localChatId)` — opens the chat in the main area *without* swapping the sidebar tab or clearing `activeJobId`. When `localChatId` is null the row is non-interactive AND renders a gray **`Deleted`** pill next to the status pill. Trailing icons: **Inbox** "Move this chat into the Chats list" (only when `run.chatHidden === true`, calls `useShowChatInList`) and **Trash2** "Delete run" (opens `DeleteRunConfirm` → `useDeleteJobRun`, which hard-deletes the run AND the originating chat).
  - **Cinna runs**: the whole row is clickable when `cinnaTaskId` is set — fires `setActiveCinnaRunId(run.id)` + `setActiveView('cinna-task-run')` to open the Cinna Task Run View. Tooltip says "Open task view". Two pill **count badges** sit just before the action icons (each rendered only when count > 0): `MessageSquare` with content-comment count (`isContentComment` filter from `src/shared/cinnaTaskView.ts`) and `Paperclip` with attachment count. Counts come from `useCinnaTaskView(cinnaTaskId, { polling: false })` so visible rows reuse the cache without fanning polls. Trailing icons (static): **Refresh** (calls `useRefreshCinnaRun.mutate({ runId, force: true })` so terminal runs still hit the network; held at minimum `MIN_SPIN_MS = 500` so the animation is always visible), **ExternalLink** ("Open on Cinna" — uses `useCinnaServerUrl` + `window.api.system.openExternal`), **Trash2** "Delete run" — removes only the desktop's run record.
- `src/renderer/src/hooks/useChatStream.ts` — `done` invalidation list extended to also invalidate `['jobs']` so the spawned-chat's run row reflects status without a manual refresh.
- `src/renderer/src/assets/main.css`:
  - `--sidebar-page-width: 240px`, `--sidebar-tab-rail: 28px`, `--sidebar-width = page + rail`
  - `.app-sidebar-tabs` — absolute-positioned column, `z-index: 1` so the active tab can paint over the sidebar's left border
  - `.sidebar-tab` — small rounded-left block, `--color-bg-tertiary` background (recessed)
  - `.sidebar-tab[aria-pressed='true']` — same surface as the sidebar card, no right border / no right radius; a borderless `::after` extends 7px past the right edge to paint over the sidebar's 1px left border so the tab merges seamlessly with the page

## Database Schema

### `jobs` table
- `id` TEXT PK
- `user_id` TEXT NOT NULL — profile scope key (per-account)
- `type` TEXT NOT NULL DEFAULT `'local'` — `'local' | 'cinna_task'`
- `title` TEXT NOT NULL
- `description` TEXT
- `prompt` TEXT NOT NULL
- `agent_id` TEXT — optional local agent reference (no FK, scope spans default + profile)
- `mode_id` TEXT — optional chat-mode reference (no FK)
- `cinna_agent_id`, `cinna_team_id`, `cinna_assigned_node_id`, `cinna_priority` TEXT — populated for `cinna_task` jobs only
- `color_preset`, `icon_name` TEXT — visual customization (reserved; not wired into the sidebar yet)
- `folder_id` TEXT — optional sidebar folder reference (no FK; folder delete sets this to null manually in the same transaction). Null = job sits at the root level.
- `position` INTEGER NOT NULL DEFAULT 0 — sort key within the parent group (folder or root). Lower = top. New jobs land at `min(position) - 1` of the root group; drag-drop rewrites every id in the affected group with `position = index`.
- `deleted_at` INTEGER — soft delete timestamp
- `created_at`, `updated_at` INTEGER NOT NULL
- Index: `idx_jobs_user_id`

### `job_folders` table
- `id` TEXT PK
- `user_id` TEXT NOT NULL — profile scope key (per-account)
- `name` TEXT NOT NULL — trimmed, non-empty (validated in the service)
- `position` INTEGER NOT NULL DEFAULT 0 — sort key for the folder list. New folders land at `max(position) + 1`.
- `collapsed` INTEGER NOT NULL DEFAULT 0 — persisted expand/collapse state, toggled by a single click on the folder header.
- `created_at`, `updated_at` INTEGER NOT NULL
- Index: `idx_job_folders_user_id`
- **No FK from `jobs.folder_id`**: folder delete detaches contained jobs by SQL UPDATE inside the same transaction as the folder drop (see `jobFoldersRepo.delete`), so adding a FK would only constrain the cleanup the service is already doing explicitly.

### `job_mcp_providers` table
- `job_id` TEXT NOT NULL → `jobs(id)` ON DELETE CASCADE
- `mcp_provider_id` TEXT NOT NULL → `mcp_providers(id)` ON DELETE CASCADE
- PRIMARY KEY (`job_id`, `mcp_provider_id`)

### `job_runs` table
- `id` TEXT PK
- `job_id` TEXT NOT NULL → `jobs(id)` ON DELETE CASCADE
- `user_id` TEXT NOT NULL — included for scope filtering even though `job_id` is sufficient
- `type` TEXT NOT NULL — `'local' | 'cinna_task'`
- `local_chat_id` TEXT → `chats(id)` ON DELETE SET NULL — spawned chat, only for local runs
- `cinna_task_id` TEXT — remote task UUID, only for cinna runs
- `cinna_short_code` TEXT — remote task short code, only for cinna runs
- `status` TEXT NOT NULL DEFAULT `'pending'` — `'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'`
- `error_message` TEXT
- `started_at`, `finished_at`, `created_at` INTEGER (`created_at` NOT NULL)
- Index: `idx_job_runs_job_id`

### `chats` table additions
- `originating_job_run_id` TEXT — set by `jobRunsRepo.createLocalChatAndRun` so the stream completion hook can resolve back to its run without renderer cooperation
- `hidden_from_list` INTEGER NOT NULL DEFAULT 0 — when `1`, the chat is excluded from `chatRepo.list` (the main Chats sidebar). Set to `1` for every job-spawned chat; cleared by `chatRepo.showInList` when the user clicks "Move to Chats" on a run row. Migration is an idempotent `ALTER TABLE chats ADD COLUMN hidden_from_list INTEGER NOT NULL DEFAULT 0` guarded by `hasColumn`.

## IPC Channels

- `job:list` — `JobData[]` for the active profile (excludes soft-deleted). Each row carries `inProgressRunsCount` (count of `pending` + `running` job_runs) so the sidebar can render a per-row spinner without a follow-up call.
- `job:get(jobId)` — `JobDetailData` (job + `mcpProviderIds` + last 10 runs)
- `job:create(input)` — Returns the new `JobData`. Renderer defaults: `type: 'local'`, `title: 'New Job'`, `prompt: 'Describe the task here…'`.
- `job:update(jobId, patch)` — Returns the updated `JobData`. Patch is a partial DTO.
- `job:delete(jobId)` — `{ success: true }`. Soft delete.
- `job:set-mcp-providers(jobId, mcpProviderIds[])` — `{ success: true }`. Replaces the job's MCP attachments.
- `job:list-runs(jobId)` — `JobRunData[]` newest-first.
- `job:execute(jobId)` — Discriminated union:
  - `{ type: 'local', chatId, runId, prompt, agentId, modeId }` — renderer resolves provider/model, navigates, fires stream
  - `{ type: 'cinna_task', runId, cinnaTaskId, cinnaShortCode }` — renderer stays on the Job Detail view
- `job:cancel-run(runId)` — Flips a run to `'cancelled'` (MVP: pending-only is meaningful; running local runs are also cancelled via the chat-level cancel)
- `job:delete-run(runId)` — Hard-deletes a run row. For local runs, the originating chat is hard-deleted alongside via the same transaction so neither orphans. Response: `{ success: true, chatDeleted: boolean, chatId: string | null }` — the renderer uses `chatDeleted` + `chatId` to invalidate `['chats']` / `['trash']` and reset `activeChatId` when the deleted chat was open.
- `job:refresh-run(runId, options?: { force?: boolean })` — `JobRunData`. Polls cinna-core for the latest status of a `cinna_task` run; no-op for local runs. When `force: true` (manual button), bypasses the terminal-status short-circuit so the user gets a real network call even on completed runs.
- `job:cinna-server-url` — Resolved Cinna server URL for the active profile (used to build `/tasks/{short_code}` deep links).
- `job:reorder(targetFolderId: string | null, orderedJobIds: string[])` — `{ success: true }`. Rewrites the destination group's `(folderId, position)` pairs in a single transaction. Pre-validates ownership of the target folder (when non-null) and every submitted job id. Logs `jobs reordered { targetFolderId, count }`.
- `jobFolder:list` — `JobFolderData[]` for the active profile, ordered by `(position ASC, createdAt ASC)`.
- `jobFolder:create({ name })` — `JobFolderData`. New folder lands at the bottom of the folder list (`position = max + 1`).
- `jobFolder:update(folderId, { name?, collapsed? })` — `JobFolderData`. Trims name; either field may be patched independently (e.g. the collapse toggle only sends `collapsed`).
- `jobFolder:delete(folderId)` — `{ success: true }`. Detaches contained jobs to root (`folderId = null`) in the same transaction as the folder drop — no orphan rows on crash.
- `jobFolder:reorder(orderedIds: string[])` — `{ success: true }`. Rewrites folder positions in a single transaction. Logs `folders reordered { count }`.
- `cinna:list-agents` — `CinnaAgentDto[]` (id, name, description)
- `cinna:get-task-view(taskId)` — `CinnaTaskViewDto` (task detail + comments + standalone attachments) — see [Cinna Task Run View tech](../cinna_task_view/cinna_task_view_tech.md)
- `files:download-task-attachment({ taskId, attachmentId, filename })` — save-as for a `TaskAttachment`; distinct from `files:download` because the URL is task-scoped
- `chat:show-in-list(chatId)` — `{ success: true }`. Promotes a hidden (job-spawned) chat into the main Chats list by clearing `chats.hidden_from_list`.
- `app:open-external(url)` — `{ success: true } | { success: false, error: 'unsupported_protocol' | 'invalid_url' }`. Restricted to `http:` / `https:`.

## Services & Key Methods

- `src/main/db/jobs.ts`:
  - `jobsRepo.list/getById/create/update/touch/softDelete` — CRUD with `userId` in WHERE. `list` orders by `(position ASC, updatedAt DESC)` so legacy rows with identical zeros still sort sensibly.
  - `jobsRepo.minPositionInFolder(userId, folderId | null)` — `SELECT min(position)` filtered by group; used by `create` to land new jobs at the top of the root group with `position = min - 1`.
  - `jobsRepo.reorderInGroup(userId, targetFolderId, orderedJobIds)` — single transaction; writes every passed id with `folderId = targetFolderId` and `position = index`. Caller must submit the full ordering of the destination group.
  - `jobFoldersRepo.list/getById/create/update/delete/maxPosition/reorder` — CRUD with `userId` in WHERE. `delete` is a transaction: detach contained jobs (`UPDATE jobs SET folder_id = NULL WHERE folder_id = ?`) → drop the folder row. `reorder` rewrites `position = index` for every id in a single transaction.
  - `jobRunsRepo.createLocalChatAndRun(input)` — single `db.transaction(...)` inserts chat row, `chat_mcp_providers` rows, `job_runs` row, and back-fills `chats.originating_job_run_id` atomically. Returns `{ chatId, runId }`.
  - `jobMcpRepo.listProviderIds(jobId)` / `setProviderIds(jobId, ids)` — `setProviderIds` is a transaction (delete-all then insert).
  - `jobRunsRepo.listByJob/getById/create/updateStatus` — standard repo shape.
  - `jobRunsRepo.getByLocalChatId(chatId)` — lookup used by `reportRunCompletion`. Not scoped by user — the caller (stream layer) already has chat-level authorization.
- `src/main/services/jobService.ts`:
  - `listFolders(userId)` / `createFolder(userId, { name })` / `updateFolder(userId, folderId, patch)` / `deleteFolder(userId, folderId)` / `reorderFolders(userId, orderedIds)` — folder CRUD + reorder. All raise `JobError('not_found' | 'invalid_input', ...)` on validation failures. Mutating ops log via `createLogger('job')`.
  - `reorderJobs(userId, targetFolderId, orderedJobIds)` — validates target folder ownership (when non-null) and pre-walks `orderedJobIds` asserting each maps to a non-deleted job in scope (raises `JobError('not_found', 'Job not found: ' + id)` on the first bad id, before any write). Calls `jobsRepo.reorderInGroup`. Logs `jobs reordered { targetFolderId, count }`.
  - `execute(userId, jobId)` — discriminated dispatcher; the IPC handler is a one-liner.
  - `executeLocal(userId, jobId)` — validates agent + mode existence, filters stale MCP ids, calls `jobRunsRepo.createLocalChatAndRun`. Returns `{ chatId, runId, prompt, agentId, modeId }`.
  - `executeCinnaTask(userId, jobId)` — asserts `cinnaAgentId`, calls `cinnaApiService.createTask`, persists run row.
  - `refreshCinnaRun(userId, runId, options?: { force?: boolean })` — no-op for non-cinna runs; for terminal runs short-circuits unless `force: true` (manual refresh). Calls `getTaskDetail` + `mapCinnaStatus` + `updateStatus` if changed. Logs entry (with `force` + `prevStatus`) and outcome (`remoteStatus` + `newStatus`).
  - `reportRunCompletion(chatId, outcome, errorMessage?)` — looks up the run by chat id, flips status if still non-terminal. Called from both streaming services.
  - `setRunStatus(userId, runId, status, errorMessage?)` — manual cancel path.
- `src/main/services/cinnaApiService.ts`:
  - Internal `cinnaFetch<T>(userId, path, opts)` — bearer auth header, JSON encode/decode, 401/403 → `CinnaApiError('reauth_required', ...)`, network errors → `'request_failed'`, non-JSON → `'invalid_response'`.
  - `listAgents` — paginated response unwrapper; throws `CinnaApiError('invalid_response', ...)` if the response shape is unexpected.
  - `getTaskView(userId, taskId)` — single `GET /api/v1/tasks/{id}/detail` call; tolerant parsers map `TaskCommentPublic` and `TaskAttachmentPublic` to the desktop's `CinnaTaskCommentDto` / `CinnaTaskAttachmentDto`. See [Cinna Task Run View tech](../cinna_task_view/cinna_task_view_tech.md).

## Renderer Components

- `SidebarTabs` — Two icon buttons (MessageSquare for Chats, Briefcase for Jobs). Active tab gets `aria-pressed="true"` which triggers the "merge into sidebar" CSS treatment.
- `JobsList`:
  - Header `px-3 pt-1 pb-1` so top space matches left space.
  - `+` button: for Cinna users, opens `<JobTypePicker />` modal; otherwise calls `useCreateJob({ type: 'local' })` directly.
  - Empty state: "No jobs yet — click + to create one".
- `JobTypePicker` — Portal-rendered modal styled like the onboarding welcome card. `bg-black/25` backdrop, `max-w-[28rem]` rounded card, Sparkles accent icon, two-card grid (Local / Cinna Task). Each card click fires `useCreateJob({ type })` and closes the modal; the existing `onSuccess` in `useCreateJob` navigates to the new job's detail view. ESC + click-outside dismiss.
- `JobItem`:
  - Active when `activeJobId === job.id && activeView === 'job-detail'`.
  - Hover-revealed trash opens `<DeleteJobConfirm />` instead of deleting immediately.
  - `DeleteJobConfirm` is also exported from this file (other surfaces can reuse the same modal).
- `DeleteJobConfirm` — Portal modal. `bg-black/25` backdrop, frosted `app-popover-surface` card, AlertTriangle red header, body text uses `--color-text-secondary` for contrast against the light frosted surface, red "Delete" button.
- `JobDetail`:
  - Header with `Run` button (renders `Loader2` while `executeJob.isPending`); inline error banner sourced from `useExecuteJob().error`.
  - Form lives inside a `bg-[var(--color-bg-secondary)]` card so the `bg-[var(--color-bg)]` inputs contrast properly (matches the settings forms' surface treatment).
  - Run history sorted newest-first via `useJobRuns`.
- `JobEditForm`:
  - Local state for every editable field; one `useEffect` debounces all scalar field changes into a single `update` call.
  - `useEffect` keyed on `job.id` refreshes the snapshot ref so cross-job navigation doesn't trigger spurious saves.
  - MCP toggles call `setJobMcps.mutate` synchronously (no debounce) and optimistically update local set.
  - No type toggle — `type` is read from `job.type` and branches the rendered field set.
  - `selectedTeam` (`useMemo`) narrows the assigned-node selector to that team's nodes only.
- `JobRunRow`:
  - Status pill colors from `--color-severity-*` CSS variables.
  - All trailing action icons are static (no hover gate).
  - Local: row click navigates via `useOpenChatFromRun` and keeps `activeJobId` so the sidebar highlight survives.
  - Cinna: row click opens the [Cinna Task Run View](../cinna_task_view/cinna_task_view.md) (`setActiveCinnaRunId` + `setActiveView('cinna-task-run')`). Two count pill badges (comments / attachments) render before the action buttons; counts come from `useCinnaTaskView(taskId, { polling: false })` which shares the query cache with the detail view. Refresh button uses `force: true` and holds a `MIN_SPIN_MS = 500` minimum spin time; "Open on Cinna" uses `useCinnaServerUrl` + `window.api.system.openExternal`. Open errors surface inline.

## Configuration

- Polling intervals: `ACTIVE_INTERVAL_MS = 5000`, `BACKGROUND_INTERVAL_MS = 10000` in `useCinnaRunPoll.ts`. Switched on `visibilitychange`.
- Auto-save debounce: `DEBOUNCE_MS = 600` in `JobEditForm.tsx`.
- Recent runs limit: `RECENT_RUNS_LIMIT = 10` returned by `jobService.getDetail` (history view uses the full `listRuns`).
- Cinna server URL query stale time: `5 * 60_000` in `useCinnaServerUrl`.
- Minimum refresh-spin animation: `MIN_SPIN_MS = 500` in `JobRunRow.tsx` — keeps the spinner visible even when the cinna refresh IPC roundtrip resolves sub-frame.
- Task-view polling: `ACTIVE_REFETCH_MS = 5_000`, badge stale time: `BADGE_STALE_MS = 60_000` in `useCinnaTaskView.ts`.

## Security

- **Profile scope.** Every `jobsRepo` / `jobFoldersRepo` / `jobRunsRepo` query filters by `userId` (the active profile). Cross-profile access requires guessing both the entity id AND owning the right session — defense-in-depth even though all ids are already opaque.
- **Reorder authorization.** `jobService.reorderJobs` walks the submitted `orderedJobIds` and refuses the batch if any id is missing from the active profile or soft-deleted — a malicious renderer can't trip the transaction into touching another user's row even by guessing an id.
- **Cinna tokens.** `cinnaApiService` resolves tokens inside the main process via `getCinnaAccessToken(userId)`; the renderer never sees them. `CinnaReauthRequired` is mapped to `CinnaApiError('reauth_required', ...)` so the IPC boundary carries a stable code.
- **External URL open.** `app:open-external` validates `protocol === 'http:' || 'https:'` before invoking `shell.openExternal`, mirroring the renderer's `setWindowOpenHandler` policy.
- **Logger discipline.** `createLogger('job')` and `createLogger('cinna-api')`. Prompts and Cinna task bodies are NOT logged; only IDs, status, and timing. Network errors include URL + status code, not response bodies beyond the first 200 chars.
- **Transactional execution.** Local run creation is a single `db.transaction(...)`; a crash mid-way leaves no half-set state for the stream-completion hook to misinterpret.
