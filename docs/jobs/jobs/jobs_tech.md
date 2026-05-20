# Jobs — Technical Details

## File Locations

### Main process
- `src/main/db/schema.ts` — `jobs`, `jobMcpProviders`, `jobRuns` tables; `chats.originatingJobRunId` column
- `src/main/db/migrations/jobs.ts` — `migrateJobs()` — inline-SQL `CREATE TABLE IF NOT EXISTS` for the three job tables, indexes on `jobs.user_id` and `job_runs.job_id`, and the `originating_job_run_id` ALTER on `chats` (guarded via `hasColumn`)
- `src/main/db/client.ts` — `migrateJobs(sqlite)` invoked from `runMigrations()` after chats + mcp_providers + chat_modes (FK dependencies)
- `src/main/db/jobs.ts` — `jobsRepo` (CRUD + soft delete), `jobMcpRepo` (`listProviderIds`, `setProviderIds`), `jobRunsRepo` (`listByJob` — LEFT-joins `chats` and returns `JobRunRowWithMeta` with a derived `chatHidden` boolean —, `countInProgressByJob` — single `GROUP BY job_id` aggregate over rows with `status IN ('pending','running')`, used by the sidebar spinner —, `getById`, `getByLocalChatId`, `create`, `updateStatus`, `createLocalChatAndRun` transaction that sets `hiddenFromList = true` on the spawned chat)
- `src/main/db/chats.ts` — extended `chatRepo.create()` accepts `init?` (title/modelId/providerId/modeId/agentId/originatingJobRunId/`hiddenFromList`); `chatRepo.setOriginatingJobRunId(userId, chatId, runId)` back-pointer setter; `chatRepo.list(userId)` filters out hidden-from-list chats; `chatRepo.showInList(userId, chatId)` clears the flag (promotes a hidden chat to the main list)
- `src/main/services/jobService.ts` — `jobService` — `list` (returns `JobListItem[]` = `JobRow & { inProgressRunsCount: number }`, joining `jobRunsRepo.countInProgressByJob` so the sidebar can render a per-row spinner without a second IPC call), `getDetail`, `create`, `update`, `softDelete`, `setMcpProviders`, `listRuns`, `execute` (discriminated dispatcher), `executeLocal`, `executeCinnaTask`, `refreshCinnaRun`, `reportRunCompletion`, `setRunStatus`, `getCinnaServerUrl`. Private `mapCinnaStatus()` translates cinna-core status values into local `JobRunStatus`. Private `enrichRun(userId, run)` attaches the `chatHidden` boolean for single-row methods (`refreshCinnaRun`, `setRunStatus`) so every IPC return matches the same `JobRunRowWithMeta` shape as `listRuns`.
- `src/main/services/cinnaApiService.ts` — `cinnaApiService` — handwritten REST client for cinna-core: `listAgents`, `listTeams`, `createTask`, `getTaskDetail`, `getServerUrl`. Internal `cinnaFetch()` helper centralizes auth-header + `net.fetch` + error mapping; raises `CinnaApiError('reauth_required')` on 401/403.
- `src/main/services/chatStreamingService.ts` — `_runStreamLoop` calls `jobService.reportRunCompletion(chatId, 'succeeded' | 'failed', errorMessage?)` on `done` / catch path
- `src/main/services/a2aStreamingService.ts` — same hook at the agent stream's `done` / catch path
- `src/main/ipc/job.ipc.ts` — `registerJobHandlers()` — all `job:*` channels wrapped via `ipcHandle()`, each calls `userActivation.requireActivated()` then delegates to `jobService`
- `src/main/ipc/cinna.ipc.ts` — `registerCinnaHandlers()` — `cinna:list-agents`, `cinna:list-teams` delegating to `cinnaApiService`
- `src/main/ipc/app.ipc.ts` — `app:open-external` handler — restricts to `http:` / `https:` before `shell.openExternal`
- `src/main/ipc/index.ts` — `registerJobHandlers()` and `registerCinnaHandlers()` registered in `registerAllIpcHandlers()`
- `src/main/errors.ts` — `JobError` + `JobErrorCode` (`not_found | not_activated | unsupported_type | missing_dependency | invalid_input`); `CinnaApiError` + `CinnaApiErrorCode` (`not_cinna_user | missing_server_url | reauth_required | request_failed | invalid_response`)

### Shared
- `src/shared/jobs.ts` — `JobData`, `JobRunData`, `JobDetailData`, `JobCreateInputDto`, `JobPatchDto`, `JobType`, `JobRunStatus` — imported by both preload and renderer (the preload `.ts` is not exposed to the renderer compiler, so DTOs live in `shared/`)

### Preload
- `src/preload/index.ts`:
  - `window.api.jobs` — `list`, `get`, `create`, `update`, `delete`, `setMcpProviders`, `listRuns`, `execute` (returns discriminated union `{ type: 'local' | 'cinna_task', ... }`), `cancelRun`, `refreshRun`, `cinnaServerUrl`
  - `window.api.cinna` — `listAgents`, `listTeams`
  - `window.api.system.openExternal(url)` — wraps `app:open-external` IPC

### Renderer
- `src/renderer/src/stores/ui.store.ts` — adds `sidebarTab: 'chats' | 'jobs'`, `activeJobId: string | null`, and `'job-detail' | 'job-edit'` to `ActiveView` (split view vs. edit). Setters: `setSidebarTab`, `setActiveJobId`. Not persisted to localStorage at MVP.
- `src/renderer/src/hooks/useJobs.ts` — `useJobList`, `useJob(jobId)`, `useJobRuns(jobId)`, `useCreateJob` (accepts an optional `Partial<JobCreateInputDto>`; defaults `type` to `'local'`; **navigates to `'job-edit'` on success** so new jobs land on the form), `useUpdateJob`, `useDeleteJob`, `useDeleteJobRun` (hard-delete a run; on success invalidates `['jobs', jobId, 'runs']` and, if the response says the originating chat was hard-deleted too, `['chats']` + `['trash']` + clears `activeChatId` when it matched), `useSetJobMcps`, `useExecuteJob` (`useMutation` — variables are `ExecuteJobInput = { jobId, navigate?: boolean = true }`; wraps `window.api.jobs.execute`, branches on returned type; **does not** swap the sidebar to `'chats'` so the user stays in the jobs context; when `navigate === false` it skips the `setActiveChatId/setActiveView('chat')` calls so the sidebar "run now" button can fire-and-forget without leaving the jobs list; always invalidates `['jobs']` after success so the sidebar `inProgressRunsCount` ticks up immediately), `useOpenChatFromRun` (navigation helper; preserves both `sidebarTab` and `activeJobId` so the originating job stays highlighted while its chat is open). `useDeleteJob.onSuccess` reads `useUIStore.getState().activeJobId` at completion time and resets the view only if it was on `'job-detail'` or `'job-edit'`. `useExecuteJob` falls back to `useDefaultChatMode` when the job left `modeId` null (otherwise the spawned chat has no provider/model and the stream rejects it).
- `src/renderer/src/hooks/useChat.ts` — adds `useShowChatInList()` mutation wrapping `window.api.chat.showInList(chatId)`; on success invalidates `['chats']` (so the chat shows up in the sidebar) and `['jobs']` (so the run row's `chatHidden` flips and the "Move to Chats" button disappears).
- `src/renderer/src/hooks/useStartNewChat.ts` / `src/renderer/src/components/chat/ChatItem.tsx` — both clear `activeJobId` when entering a non-job navigation (new chat from the top-bar `+`, or picking a chat from the Chats list) so the job-highlight only persists while the user is genuinely inside the job's context.
- `src/renderer/src/hooks/useCinna.ts` — `useCinnaAgents`, `useCinnaTeams`, `useRefreshCinnaRun`, `useCinnaServerUrl`. All gated on `useAuthStore((s) => s.currentUser?.type === 'cinna_user')`.
- `src/renderer/src/hooks/useCinnaRunPoll.ts` — `useCinnaRunPoll(runs)`. Memoizes the non-terminal id set, uses a `ref` for the active id snapshot, registers a single `setInterval` (5s focused / 10s hidden, swapped on `visibilitychange`) and clears it when the active set empties.
- `src/renderer/src/components/layout/SidebarTabs.tsx` — Icon-only book-tab rail (`MessageSquare` for Chats, `Briefcase` for Jobs). Buttons carry `aria-pressed` for the active-tab CSS hook.
- `src/renderer/src/components/layout/Sidebar.tsx` — Renders `<SidebarTabs />` as an absolute sibling of the sidebar card (in the chat-view branch only); the sidebar card itself is inset by `var(--sidebar-tab-rail)` so the rail sits outside its left edge. Hidden in the settings branch.
- `src/renderer/src/components/layout/MainArea.tsx` — Routes `activeView === 'job-detail'` to `<JobDetail />` and `activeView === 'job-edit'` to `<JobEditPage />` before the chat branch
- `src/renderer/src/components/jobs/JobsList.tsx` — Sidebar Jobs list: header (`px-3 pt-1` so top padding matches the `px-3` left padding), `useJobList` data, `+` button opens `<JobTypePicker />` for Cinna users or fires `useCreateJob({ type: 'local' })` directly otherwise, empty-state placeholder
- `src/renderer/src/components/jobs/JobTypePicker.tsx` — Modal portal styled like the onboarding welcome card (`max-w-[28rem]` rounded panel, Sparkles accent icon, two card buttons). ESC + click-outside dismiss. Calls `useCreateJob({ type })` on pick.
- `src/renderer/src/components/jobs/JobItem.tsx` — Single row. Active state is `activeJobId === job.id && (activeView === 'job-detail' || 'job-edit' || 'chat')` — also highlights while the user is viewing one of this job's spawned chats (because the open-chat flows preserve `activeJobId`). **No delete button** — delete now lives on the edit screen. Hover shows a small **green Play-icon pill** (`bg-[var(--color-success)] text-white w-4 h-4 rounded`) that fires `useExecuteJob({ jobId, navigate: false })` so the user can kick off multiple jobs without leaving the sidebar. While `executeJob.isPending || job.inProgressRunsCount > 0` the pill is replaced by a `Loader2` spinner tinted with `text-[var(--color-success)]`, shown **unconditionally** (not gated on hover). Both icons are pinned to `w-4 h-4` so the row height never shifts between idle, hover, and running states. `DeleteJobConfirm` is still defined and exported from this file (consumed by `JobEditPage`).
- `src/renderer/src/components/jobs/JobDetail.tsx` — Read-only view: header (title + type pill + **icon-only Edit pencil** + **green Run pill**), `<JobSummary>` (private subcomponent: prompt block + flex-wrap chip strip for non-default config), run-history section. Run uses `bg-[var(--color-success)] hover:brightness-110 text-white` (matches the sidebar's run pill / spinner); Edit is a square outlined icon-only button (`p-1.5`, Pencil glyph, `title="Edit job"`) that fires `setActiveView('job-edit')`. `useCinnaRunPoll(runs)` keeps cinna statuses fresh while the view is open. `JobSummary` resolves names via `useAgents` / `useChatModes` / `useMcpProviders` / `useCinnaAgents` / `useCinnaTeams`; the `CINNA_DEFAULT_PRIORITY = 'normal'` constant gates whether the priority chip is shown. Chips reuse the chat composer's pill pattern via a local `<Chip>` primitive (`pl-1.5 pr-2.5 py-1 rounded-lg border` with `neutral | accent | danger` tones); typed wrappers `AgentChip` (Bot, accent), `ModeChip` (color dot via `getPreset(colorPreset)`), `McpChip` (Wrench), `TeamChip` (Users), `NodeChip` (GitBranch), `PriorityChip` (Flag), `MissingChip` (danger tone for "No Cinna agent").
- `src/renderer/src/components/jobs/JobEditPage.tsx` — Full-page edit screen routed by `activeView === 'job-edit'`. Header: Back chevron (sets view back to `'job-detail'`), "Edit job" title, **icon-only Trash button immediately left of Save** that opens `<DeleteJobConfirm />` (imported from `./JobItem`), primary Save button. Save calls `formRef.current.flush()` and only navigates back to `'job-detail'` on `{ ok: true }`; validation failures (empty title / prompt) and update errors surface in an inline `role="alert"` banner. Delete uses `useDeleteJob` — its `onSuccess` clears `activeJobId` and routes back to the chat view when the deleted job was active. Form wrapped in the same `bg-[var(--color-bg-secondary)]` card the old single-screen JobDetail used.
- `src/renderer/src/components/jobs/JobEditForm.tsx` — Controlled form. Single `useEffect` debounces (`DEBOUNCE_MS = 600`) `useUpdateJob` against a `snapshotRef`; MCP toggles call `useSetJobMcps` immediately. No type selector — `type` is read-only from `job.type`; field set switches based on it (local vs. cinna_task). Exported via `forwardRef<JobEditFormHandle, JobEditFormProps>`; the handle's `flush()` builds the same patch the debounce would, validates title/prompt non-empty, and `await`s `updateJob.mutateAsync` so callers (i.e. `JobEditPage`'s Save button) can navigate only after persistence. Returns `{ ok: true } | { ok: false; error }`.
- `src/renderer/src/components/jobs/JobRunRow.tsx` — Status pill + relative timestamp. **Local runs**: the whole `<div role="button">` is clickable (keyboard: Enter/Space) and fires `useOpenChatFromRun(localChatId)` — opens the chat in the main area *without* swapping the sidebar tab or clearing `activeJobId`. When `localChatId` is null (cascade-set-null after the chat was deleted), the row is non-interactive (no `role`, no hover, no cursor) AND renders a gray **`Deleted`** pill (Trash2 icon) next to the status pill so the user can tell the run's chat is gone. **Trailing-icon hover behavior**: when the row is at rest, the trailing slot shows a decorative `MessageSquare` (local) or the cinna icon buttons (refresh + open external). On hover those step aside and the actionable icons appear — **Inbox** "Move this chat into the Chats list" (only when `run.chatHidden === true`, calls `useShowChatInList`) and **Trash2** "Delete run" (always available, opens the inline `DeleteRunConfirm` modal → `useDeleteJobRun`, which hard-deletes the run AND the originating chat for local runs). All action button onClicks `stopPropagation()` to avoid bubbling into the row-click. **Cinna runs**: row is not clickable; the idle Refresh/Open-on-Cinna buttons swap to the Trash2 delete button on hover.
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
- `deleted_at` INTEGER — soft delete timestamp
- `created_at`, `updated_at` INTEGER NOT NULL
- Index: `idx_jobs_user_id`

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
- `job:refresh-run(runId)` — `JobRunData`. Polls cinna-core for the latest status of a `cinna_task` run; no-op for local / terminal runs.
- `job:cinna-server-url` — Resolved Cinna server URL for the active profile (used to build `/tasks/{short_code}` deep links).
- `cinna:list-agents` — `CinnaAgentDto[]` (id, name, description, team_id)
- `cinna:list-teams` — `CinnaTeamDto[]` (id, name, task_prefix, nodes[])
- `chat:show-in-list(chatId)` — `{ success: true }`. Promotes a hidden (job-spawned) chat into the main Chats list by clearing `chats.hidden_from_list`.
- `app:open-external(url)` — `{ success: true } | { success: false, error: 'unsupported_protocol' | 'invalid_url' }`. Restricted to `http:` / `https:`.

## Services & Key Methods

- `src/main/db/jobs.ts`:
  - `jobsRepo.list/getById/create/update/touch/softDelete` — CRUD with `userId` in WHERE
  - `jobRunsRepo.createLocalChatAndRun(input)` — single `db.transaction(...)` inserts chat row, `chat_mcp_providers` rows, `job_runs` row, and back-fills `chats.originating_job_run_id` atomically. Returns `{ chatId, runId }`.
  - `jobMcpRepo.listProviderIds(jobId)` / `setProviderIds(jobId, ids)` — `setProviderIds` is a transaction (delete-all then insert).
  - `jobRunsRepo.listByJob/getById/create/updateStatus` — standard repo shape.
  - `jobRunsRepo.getByLocalChatId(chatId)` — lookup used by `reportRunCompletion`. Not scoped by user — the caller (stream layer) already has chat-level authorization.
- `src/main/services/jobService.ts`:
  - `execute(userId, jobId)` — discriminated dispatcher; the IPC handler is a one-liner.
  - `executeLocal(userId, jobId)` — validates agent + mode existence, filters stale MCP ids, calls `jobRunsRepo.createLocalChatAndRun`. Returns `{ chatId, runId, prompt, agentId, modeId }`.
  - `executeCinnaTask(userId, jobId)` — asserts `cinnaAgentId`, calls `cinnaApiService.createTask`, persists run row.
  - `refreshCinnaRun(userId, runId)` — no-op for non-cinna / terminal runs; otherwise `getTaskDetail` + `mapCinnaStatus` + `updateStatus` if changed.
  - `reportRunCompletion(chatId, outcome, errorMessage?)` — looks up the run by chat id, flips status if still non-terminal. Called from both streaming services.
  - `setRunStatus(userId, runId, status, errorMessage?)` — manual cancel path.
- `src/main/services/cinnaApiService.ts`:
  - Internal `cinnaFetch<T>(userId, path, opts)` — bearer auth header, JSON encode/decode, 401/403 → `CinnaApiError('reauth_required', ...)`, network errors → `'request_failed'`, non-JSON → `'invalid_response'`.
  - `listAgents` / `listTeams` — throw `CinnaApiError('invalid_response', ...)` if the response is not an array.

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
  - Local: "Open chat" navigates via `useOpenChatFromRun` (also switches the sidebar back to `Chats`).
  - Cinna: "Refresh" (`useRefreshCinnaRun`), "Open on Cinna" (`useCinnaServerUrl` resolves base URL + `window.api.system.openExternal`). Open errors surface inline.

## Configuration

- Polling intervals: `ACTIVE_INTERVAL_MS = 5000`, `BACKGROUND_INTERVAL_MS = 10000` in `useCinnaRunPoll.ts`. Switched on `visibilitychange`.
- Auto-save debounce: `DEBOUNCE_MS = 600` in `JobEditForm.tsx`.
- Recent runs limit: `RECENT_RUNS_LIMIT = 10` returned by `jobService.getDetail` (history view uses the full `listRuns`).
- Cinna server URL query stale time: `5 * 60_000` in `useCinnaServerUrl`.

## Security

- **Profile scope.** Every `jobsRepo` / `jobRunsRepo` query filters by `userId` (the active profile). Cross-profile access requires guessing both `jobId` AND owning the right session — defense-in-depth even though `jobId` is already opaque.
- **Cinna tokens.** `cinnaApiService` resolves tokens inside the main process via `getCinnaAccessToken(userId)`; the renderer never sees them. `CinnaReauthRequired` is mapped to `CinnaApiError('reauth_required', ...)` so the IPC boundary carries a stable code.
- **External URL open.** `app:open-external` validates `protocol === 'http:' || 'https:'` before invoking `shell.openExternal`, mirroring the renderer's `setWindowOpenHandler` policy.
- **Logger discipline.** `createLogger('job')` and `createLogger('cinna-api')`. Prompts and Cinna task bodies are NOT logged; only IDs, status, and timing. Network errors include URL + status code, not response bodies beyond the first 200 chars.
- **Transactional execution.** Local run creation is a single `db.transaction(...)`; a crash mid-way leaves no half-set state for the stream-completion hook to misinterpret.
