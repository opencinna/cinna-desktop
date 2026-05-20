# Jobs

## Purpose

Let users save reusable units of work (title + description + prompt + execution config) they can execute repeatedly. Each execution becomes a Job Run with status tracking. A "diary book" tab strip stuck to the sidebar's left edge switches the list body between **Chats** and **Jobs**.

## Core Concepts

- **Job** — A profile-scoped saved spec (title, description, prompt, agent/mode/MCP attachments, color/icon). Two execution types, set once at creation and not editable afterwards:
  - **Local Job** — Runs against the user's local agent / chat mode / MCPs. Each run spawns a new chat seeded with the job's prompt; the existing chat pipeline drives the conversation.
  - **Cinna Task Job** — Only available on Cinna-linked profiles. Each run calls cinna-core's `POST /api/v1/tasks/`; the conversation lives on cinna-core and the desktop keeps a pointer (`cinnaTaskId` + `cinnaShortCode`).
- **Job Run** — One execution of a job. Local runs reference the spawned `chatId`; Cinna runs reference the remote task. Status moves through `pending → running → succeeded | failed | cancelled`.
- **Sidebar Tab Rail** — Two icon-only square tabs (Chats / Jobs) stuck to the sidebar's left edge like the bookmark tabs on a folder. The selected tab visually merges with the sidebar surface (no seam on its right edge); inactive tabs are smaller recessed blocks. Hidden in the settings view.
- **Run Status** — Local runs flip via the chat-stream completion hook (success when the first assistant turn finishes, failure when the stream errors). Cinna runs flip via polling cinna-core's task status while non-terminal.

## User Stories / Flows

### Switching between Chats and Jobs
1. User clicks the icon tab on the sidebar's left edge (speech bubble = Chats, briefcase = Jobs).
2. Sidebar body swaps from the chat list to the jobs list. The selected tab visually fuses with the sidebar (same surface, no border between them); the other sits as a separate recessed block.
3. **Main area realigns to the first item in the new list.** Switching to Chats opens the first chat (or lands on the New Chat screen when none exist); switching to Jobs opens the first job's detail page (or shows the "Select a job from the sidebar" empty state). This avoids the dissonance of seeing one domain's list while the central pane shows a different domain's content. `activeCinnaRunId` is cleared on every tab switch.
4. Settings view hides the tab rail entirely (it owns the full sidebar).

### Creating a job (non-Cinna profile)
1. User clicks the `+` button in the Jobs sidebar header.
2. A local job is created with placeholder title and prompt ("New Job" / "Describe the task here…"), and the Main area opens the **Job Edit** page (form) for the new job.
3. User fills in title / prompt / config and clicks **Save** — the page flushes any pending debounced changes and routes to the read-only **Job Detail** view.

### Creating a job (Cinna profile)
1. User clicks the `+` button in the Jobs sidebar header.
2. A modal popup appears (centered, with a darkened backdrop) styled like the onboarding welcome card: header icon + "New job" + "Pick how this job runs" + two card buttons.
3. User clicks **Local** or **Cinna Task** → the modal closes, the job is created with that type, and the **Job Edit** page opens for the new job.
4. User clicks **Save** to land on the read-only Job Detail view.
5. ESC, the `X` icon, or a click outside the picker card cancels without creating anything.

### Viewing a job
1. User opens a job from the sidebar — Main area renders the read-only **Job Detail** view.
2. The header shows the job's title, description, a type pill (`Local` / `Cinna Task`), an icon-only **Edit** (pencil) button, and a primary green **Run** button.
3. Below the header, a summary card shows the prompt verbatim plus a strip of compact **chip-style badges** for *non-default* configuration only (same chip pattern used in the chat composer — `ActiveAgentChip` / `OnDemandMcpChips`):
   - Local: agent chip (Bot icon, accent border), chat-mode chip (color dot tinted with the mode's preset), one MCP chip per attached provider (Wrench icon). Each chip only appears if the field is set.
   - Cinna Task: Cinna agent chip (Bot — red "No Cinna agent" chip if missing) and priority chip (Flag, only when not `normal`).
4. Below the summary, the **Run history** lists the job's runs newest-first; the section is empty when there are no runs.

### Editing a job
1. From the Job Detail view, user clicks **Edit** — Main area swaps to the **Job Edit** page (the same form used at creation).
2. Title, description, prompt, agent, mode (local jobs) or Cinna agent / priority (Cinna jobs) auto-save on a debounce (~600ms) when changed.
3. The **Agent** field (local jobs) and **Cinna Agent** field (Cinna jobs) open a modal `AgentPickerModal` — frosted accent-tinted panel matching the chat agent popup, with a focused search input that filters cards by name/description/type, and the selected card highlighted with the accent gradient. Local picker groups agents by source (My Agents / Shared with Me / People / Local) and includes a "No agent (send to LLM)" card; Cinna picker shows a flat list of Cinna agents tagged "Cinna".
4. MCP toggles save immediately on click. Auto-save is a no-op while title or prompt are empty.
5. The header has a **← Back** link (returns to Job Detail; auto-save persistence is already in flight) and a primary **Save** button (flushes pending changes and navigates back to Job Detail).
6. The job type is fixed at creation — no in-form toggle. Field set switches based on the persisted `job.type`.

### Running a job from the sidebar (fire-and-forget)
1. User hovers a job row in the sidebar — a small **green Play-icon pill** appears on the right of the row.
2. Click the Play pill → fires the job immediately. The user is **not** redirected to the spawned chat — they stay in the Jobs sidebar so they can kick off multiple jobs in sequence.
3. While the run is in progress (any non-terminal `pending` / `running` row exists for the job), the Play pill is replaced by a small **green spinner** that is shown **unconditionally** (i.e. not gated on hover). This lets the user scan the sidebar at a glance and tell which jobs are still working.
4. When the run finalizes, the chat-stream `done` hook invalidates `['jobs']`, the spinner disappears, and the row returns to its idle state.
5. The user can step into the job at any time to inspect the latest run via the run-history list.
6. Both the Play pill and the spinner are pinned to the same 16×16 footprint (matching the row's text line-height) so hover/run state changes never shift the row's height.

### Deleting a job (always confirmed)
1. From the **Edit** screen, the header has a small icon-only **Trash** button immediately to the left of "Save".
2. Click Trash → a confirmation modal appears (frosted-glass card, AlertTriangle header, red "Delete" button, light backdrop).
3. ESC, click-outside, or the Cancel button dismisses without deleting.
4. Confirming soft-deletes the job (`deleted_at`). The row disappears; if the deleted job was the active one, Main area returns to the chat view.
5. There is **no delete from the sidebar** — sidebar hover surfaces only the run-now button, so accidental deletes from a misclick on a row can't happen.

### Running a local job
1. User clicks "Run" on the job detail view.
2. Backend atomically creates: a chat seeded with title/mode/agent/provider/model, the job's MCP attachments, and a `job_runs` row with status `running` linked to the chat. The spawned chat is marked `hidden_from_list = 1` so it does not appear in the main Chats list.
3. Renderer resolves provider/model the same way the new-chat flow does (falling back to the workspace's default chat mode when the job left `modeId` null), navigates into the spawned chat without leaving the Jobs sidebar tab, and kicks off the existing LLM / agent stream pipeline with the prompt.
4. When the chat's stream finalizes (`done`), the run flips to `succeeded`; on stream error, it flips to `failed` with the error message.

### Running a Cinna Task job
1. User (on a Cinna-linked profile) clicks "Run" on a job of type `cinna_task`.
2. Backend calls `POST /api/v1/tasks/` on cinna-core with `auto_execute: true`; persists a `job_runs` row containing `cinnaTaskId` + `cinnaShortCode` with status mapped from cinna-core's initial status (typically `running`).
3. Renderer stays on the Job Detail view (no chat is spawned). The run row appears in the history list.
4. While any non-terminal `cinna_task` run is visible, the renderer polls cinna-core every 5s (10s when the window is hidden). Each tick refreshes status; terminal status stops polling.
5. User can click "Open on Cinna" on a run row to launch the default browser to `{cinnaServerUrl}/tasks/{short_code}`; "Refresh" forces an immediate status pull.

### Viewing run history
1. Job Detail's history section lists runs newest-first with a colored status pill.
2. **All action icons on a run row are static** (no hover-gating). This lets the user scan a job's history and act on any row without first hovering it.
3. Local runs:
   - The **entire row is a button** — clicking it opens the spawned chat in the chat view *but the sidebar stays on the Jobs tab and the originating job stays highlighted*. The user is "still inside the job"; one click on the job row in the sidebar goes back to the job's detail.
   - When the spawned chat was deleted (cascade-set-null leaves `localChatId` as null), the row gets a gray **`Deleted`** pill next to the status pill and becomes non-interactive (no hover, no cursor change).
   - Trailing action icons (static): **Inbox** ("Move this chat into the Chats list") — only when the chat is still hidden-from-list; clicking promotes it into the visible Chats list. **Trash** ("Delete run") — opens a confirmation that hard-deletes the run and its spawned chat together. Job-spawned chats are hidden from the main Chats list by default so the chat sidebar isn't flooded with every job run.
4. Cinna runs:
   - The **entire row is a button** when `cinnaTaskId` is set — clicking it opens the [Cinna Task Run View](../cinna_task_view/cinna_task_view.md) (comments + attachments fetched from cinna-core). The sidebar stays on the Jobs tab and the originating job stays highlighted.
   - Two compact pill badges sit just before the action icons (each only rendered when its count is > 0): a `MessageSquare` badge with the comment count (system/status-change/assignment entries excluded) and a `Paperclip` badge with the attachment count. Counts come from the same cinna-core fetch that powers the task view — opening the view warms the cache for the row and vice versa.
   - Trailing action icons (static): **Refresh** (manual status pull — always hits the network even on terminal runs, with a minimum visible 500ms spin even when the IPC roundtrip is sub-frame); **Open on Cinna** (deep-link to `{cinnaServerUrl}/tasks/{short_code}`); **Trash** ("Delete run") — removes only the desktop's run record (the upstream cinna-core task stays on the server). Errored runs show the error message inline.

### Staying inside the jobs context
- Opening a run's chat (via the run row) or running a job (via the Run button) sets the chat view as the active main pane but **does not** swap the sidebar tab to Chats and **does not** clear `activeJobId`. The Jobs tab stays open in the sidebar with the job's row still highlighted.
- The job's row also stays highlighted while viewing its detail and edit screens.
- Picking a chat from the main Chats list, starting a fresh chat from the top-bar `+`, or switching profiles drops the jobs anchor (`activeJobId` is cleared), so the highlight only sticks while the user is genuinely working inside that job.

## Business Rules

- **Profile scope.** Jobs and job runs live in the active profile's `userId` scope — they don't follow the user across profile switches and are invisible from other profiles.
- **Validation.** `title` and `prompt` must be non-empty; `type` must be `local` or `cinna_task`. Updates that would null these out are rejected with `JobError('invalid_input', ...)`.
- **Type chosen once.** The picker only runs for Cinna users on the `+` click. Non-Cinna profiles skip the picker and always create a `local` job. Once stored, `job.type` is treated as immutable by the UI (the edit form has no toggle).
- **Delete always confirms.** There is no one-click delete from the sidebar — every delete goes through the `DeleteJobConfirm` modal.
- **Local job dependencies.** Running a local job validates that any referenced agent / chat mode still exists. Missing references throw `JobError('missing_dependency', ...)` and surface as an inline run error — no auto-fallback.
- **Stale MCP refs.** MCP provider IDs attached to a job that no longer exist are silently filtered before the chat is created (an MCP delete elsewhere shouldn't crash a run).
- **Atomic local execution.** Chat row (with `hidden_from_list = 1`), MCP attachments, job_runs row, and the chat's `originating_job_run_id` back-pointer all write in one transaction. A crash mid-way leaves the DB unchanged.
- **Hidden-from-list chats.** Job-spawned chats are marked `hidden_from_list = 1` and excluded from `chatRepo.list` (the main Chats sidebar). The user opts each chat into the visible Chats list explicitly via the "Move to Chats" button on the run row, which clears the flag. Hidden chats are otherwise fully functional — they still appear in run-history rows, still receive streaming updates, and are not in the trash (only soft delete hides a chat from the trash filter, not from this flag).
- **Stream-completion hook.** Local runs are finalized by the chat streaming layer reading `chats.originating_job_run_id` and calling `jobService.reportRunCompletion(...)`. No renderer cooperation required; survives renderer restart.
- **Concurrent runs.** Running the same job multiple times in parallel is allowed — each invocation creates its own chat + run.
- **Soft delete.** Deleting a job sets `deleted_at`; existing job_runs rows are kept (no cascade) so history survives until a hard delete is added.
- **Cinna status mapping.** cinna-core `completed | archived → succeeded`, `error → failed`, `cancelled → cancelled`, `new | pending → pending`, everything else (`refining`, `open`, `in_progress`, `blocked`, etc.) → `running`.
- **Cinna run polling.** Polls every 5s when the window is focused, 10s when hidden. Stops automatically when the active set of non-terminal cinna runs becomes empty. Network failures during polling are silent.
- **External URL safety.** `app:open-external` only forwards `http:`/`https:` URLs (mirrors the renderer's `setWindowOpenHandler` policy).

## Architecture Overview

```
Sidebar
  -> SidebarTabs (icon book-tabs stuck to the left edge of the sidebar card)
  -> ChatList OR JobsList

JobsList
  -> JobItem -> useUIStore.setActiveJobId + setActiveView('job-detail')
  -> + button -> JobTypePicker modal (Cinna users)  OR  direct useCreateJob (local users)
  -> JobItem hover green Play pill -> useExecuteJob({ jobId, navigate: false })  (fire-and-forget run from sidebar)
  -> JobItem spinner (green Loader2) shown unconditionally while `inProgressRunsCount > 0` (read off JobData from job:list)

MainArea (activeView === 'job-detail')
  -> JobDetail  (read-only view)
       -> header (title, type pill, Edit button, Run button)
       -> JobSummary  (prompt + non-default config rows)
       -> JobRunRow[]
            local  : row click → useOpenChatFromRun
            cinna  : row click → setActiveCinnaRunId + setActiveView('cinna-task-run')
            cinna  : count badges via useCinnaTaskView(taskId, { polling: false })
            (all action icons are static: Refresh / Open-external / Inbox / Trash as applicable)
       -> useCinnaRunPoll  (5s focused / 10s hidden tick while non-terminal cinna runs exist)

MainArea (activeView === 'cinna-task-run')
  -> CinnaTaskRunView  (see docs/jobs/cinna_task_view/cinna_task_view.md)

MainArea (activeView === 'job-edit')
  -> JobEditPage  (full-page edit screen, opened via "Edit" or on create)
       -> header (Back chevron, "Edit job" title, icon-only Delete button, primary Save button)
       -> JobEditForm  (auto-save debounce; exposes `flush()` via ref so Save can persist before navigating)
       -> Delete -> DeleteJobConfirm modal -> useDeleteJob (cleanup routes back to chat view)
       -> on save success -> setActiveView('job-detail')

Run flow (local)
  Run button -> useExecuteJob -> window.api.jobs.execute(jobId)
     -> jobService.execute() -> executeLocal()
        -> jobRunsRepo.createLocalChatAndRun() [single transaction]
              chat + chat_mcp_providers + job_runs + chat.originating_job_run_id
  -> renderer resolves provider/model, navigates, fires LLM / agent stream
  -> chatStreamingService / a2aStreamingService -> jobService.reportRunCompletion()

Run flow (cinna_task)
  Run button -> useExecuteJob -> jobService.execute() -> executeCinnaTask()
     -> cinnaApiService.createTask() POST /api/v1/tasks/
     -> jobRunsRepo.create({ type: 'cinna_task', cinnaTaskId, cinnaShortCode, status })
  Polling loop -> useCinnaRunPoll -> window.api.jobs.refreshRun(runId)
     -> jobService.refreshCinnaRun() -> cinnaApiService.getTaskDetail()
     -> mapCinnaStatus() -> jobRunsRepo.updateStatus()
```

## Integration Points

- [Messaging](../../chat/messaging/messaging.md) — Local runs spawn a chat that the existing send pipeline drives end-to-end.
- [Chat Modes](../../chat/chat_modes/chat_modes.md) — Local jobs reference a chat mode by id for provider/model/MCP defaults.
- [Agents](../../agents/agents/agents.md) — Local jobs can pin an agent so the run uses A2A streaming instead of the LLM path.
- [Connections](../../mcp/connections/connections.md) — Job MCP attachments are copied onto the spawned chat's `chat_mcp_providers`.
- [Cinna Accounts](../../auth/cinna_accounts/cinna_accounts.md) — Cinna Task jobs require an active Cinna OAuth session; reauth bubbles up as `JobError('reauth_required')`.
- [Cinna Task Run View](../cinna_task_view/cinna_task_view.md) — Read-only in-app view of a cinna_task run; reached by clicking a `cinna_task` row in this job's run history. Surfaces comments + attachments fetched from cinna-core.
- [App Shell](../../ui/app_shell/app_shell.md) — Sidebar gains the icon tab rail; settings view hides it.
- [Onboarding](../../auth/onboarding/onboarding.md) — JobTypePicker reuses the onboarding welcome-card visual treatment (Sparkles header + 2-card grid).
