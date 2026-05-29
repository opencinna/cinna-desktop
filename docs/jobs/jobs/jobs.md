# Jobs

## Purpose

Let users save reusable units of work (title + description + prompt + execution config) they can execute repeatedly. Each execution becomes a Job Run with status tracking. A "diary book" tab strip stuck to the sidebar's left edge switches the list body between **Chats** and **Jobs**.

## Core Concepts

- **Job** — A profile-scoped saved spec (title, description, prompt, agents/mode/MCP attachments, color/icon). Two execution types, set once at creation and not editable afterwards:
  - **Local Job** — Runs against the user's local agents / chat mode / MCPs. A job can attach **any number of agents** plus MCPs (`job_agents` + `job_mcp_providers` join tables); at run time `derivePattern(agentIds, mcpIds)` — the same helper the new-chat composer uses (`src/shared/commPattern.ts`) — decides routing: exactly one agent and no MCPs spawns a **direct-A2A** chat, anything else spawns an **orchestrated** LLM-root chat that calls each agent/MCP as a tool (see [Orchestrated Agents](../../chat/orchestrated_agents/orchestrated_agents.md)). Each run spawns a new chat seeded with the job's prompt; the existing chat pipeline drives the conversation.
  - **Cinna Task Job** — Only available on Cinna-linked profiles. Each run calls cinna-core's `POST /api/v1/tasks/`; the conversation lives on cinna-core and the desktop keeps a pointer (`cinnaTaskId` + `cinnaShortCode`).
- **Job Run** — One execution of a job. Local runs reference the spawned `chatId`; Cinna runs reference the remote task. Status moves through `pending → running → succeeded | failed | cancelled`.
- **Job Folder** — A user-defined sidebar grouping for jobs (profile-scoped, name + collapsed-state + sort position). Folders are thin collapsible separators — they own ordering but no execution config. A job lives either in exactly one folder or at the root level.
- **Group** — A bucket the sidebar can address by drag-drop: either the root level (`folderId = null`) or a specific folder. Each group has its own job ordering.
- **Sidebar Tab Rail** — Two icon-only square tabs (Chats / Jobs) stuck to the sidebar's left edge like the bookmark tabs on a folder. The selected tab visually merges with the sidebar surface (no seam on its right edge); inactive tabs are smaller recessed blocks. Hidden in the settings view.
- **Run Status** — Local runs flip via the chat-stream completion hook (success when the first assistant turn finishes, failure when the stream errors). Cinna runs flip via polling cinna-core's task status while non-terminal.

## User Stories / Flows

### Switching between Chats and Jobs
1. User clicks the icon tab on the sidebar's left edge (speech bubble = Chats, briefcase = Jobs).
2. Sidebar body swaps from the chat list to the jobs list. The selected tab visually fuses with the sidebar (same surface, no border between them); the other sits as a separate recessed block.
3. **Main area realigns**. Switching to Chats opens the first chat (or lands on the New Chat screen when none exist). Switching to Jobs lands on the **"Select a job to view." empty state** — auto-selecting the first job would be misleading when jobs can live inside a collapsed folder. `activeCinnaRunId` is cleared on every tab switch and `activeJobId` is reset to null.
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
3. Below the header, a summary card shows the prompt verbatim plus a strip of compact **chip-style badges** for *non-default* configuration only (same chip pattern used in the chat composer — `OnDemandAgentChips` / `OnDemandMcpChips`):
   - Local: a **CommPattern badge** (`A2A` / `AI`) previewing how the job will run, one agent chip per attached agent (Bot icon, accent border), a chat-mode chip (color dot tinted with the mode's preset), and one MCP chip per attached provider (Wrench icon). Each config chip only appears if the field is set; the badge always shows for local jobs.
   - Cinna Task: Cinna agent chip (Bot — red "No Cinna agent" chip if missing) and priority chip (Flag, only when not `normal`).
4. Below the summary, the **Run history** lists the job's runs newest-first; the section is empty when there are no runs.

### Editing a job
1. From the Job Detail view, user clicks **Edit** — Main area swaps to the **Job Edit** page (the same form used at creation).
2. Title, description, prompt, agent, mode (local jobs) or Cinna agent / priority (Cinna jobs) auto-save on a debounce (~600ms) when changed.
3. **Agents & Connectors (local jobs)** share one control: attached agents (Bot chips) and MCPs (Plug chips) render as a row of removable chips with a single **"Add"** button that opens the **"Agents & Connectors"** picker — one frosted, searchable modal listing agents (grouped My Agents / Shared with Me / People / Local) and a **Connectors** section for available MCPs. It is **multi-select** (click toggles a checkmark, the modal stays open). A live **CommPattern badge** above the chips previews `A2A` vs `AI`. The **Cinna Agent** field (Cinna jobs) keeps its single-select picker.
4. **Chat Mode (local jobs)** is a row of color **pills** — one per chat mode tinted with the mode's preset color, plus a "Default" pill — instead of a dropdown. Selecting a pill sets the mode.
5. Agent and MCP changes **persist immediately** (via `job:set-agents` / `job:set-mcp-providers`), not through the debounced patch. Auto-save of title/description/prompt/mode is a no-op while title or prompt are empty.
6. The header has a **← Back** link (returns to Job Detail; auto-save persistence is already in flight) and a primary **Save** button (flushes pending changes and navigates back to Job Detail).
7. The job type is fixed at creation — no in-form toggle. Field set switches based on the persisted `job.type`.

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

### Organising jobs into folders
1. The Jobs sidebar header has two icon buttons: **FolderPlus** (new folder) and **Plus** (new job).
2. Clicking FolderPlus creates a folder named "New folder" at the bottom of the folder list and immediately opens the **rename modal** so the user can type a real name and confirm (Enter / Save). ESC / click-outside / Cancel keep the placeholder name.
3. Each folder row is a thin header with a chevron (▶ collapsed / ▼ expanded), the folder name, and a trailing slot.
4. The trailing slot shows the **count of jobs inside** when idle; on hover (or while the action menu is open) the count is replaced by a **gear** icon. Clicking the gear opens an inline dropdown anchored to the right edge with two items: **Edit** (opens the rename modal) and **Delete** (red, opens a confirmation modal).
5. **Single click on the header toggles collapse / expand**; the choice persists across launches (stored as `collapsed` on the folder row).
6. **Deleting a folder is always confirmed**. On confirm, the folder row disappears and any jobs that lived inside are **detached back to the root group** — they are not deleted. The confirmation copy spells this out.

### Reordering and moving by drag-and-drop
1. Job rows and folder headers are both drag sources.
2. **Dragging a job** can drop:
   - **Onto another job row** → reorders within the target's group (inserts before the drop-target row). If the source and target are in different groups, the job's `folderId` changes to match the target group.
   - **Onto a folder header (or its empty body)** → moves the job INTO that folder, appended to the end.
   - **Onto the root area** (the section under the folder list that holds ungrouped jobs) → detaches the job from any folder, appended to the end of the root group. Only highlighted when the dragged job currently lives in a folder.
3. **Dragging a folder header** onto another folder header → reorders folders (inserts the dragged folder before the target).
4. Visual feedback while dragging:
   - The drag source row dims to `opacity-40` so the user sees which row they're carrying.
   - Compatible drop targets get an accent `ring-1 ring-inset`. The folder header gains a top accent border when it's about to accept a folder reorder, distinguishing it from "drop a job here."
   - Empty folder bodies render a dashed accent outline plus a "Drop a job here" hint when expanded and a job drag is in flight.
5. The renderer constructs the new ordering of the affected group and posts it to the server in one IPC call (`job:reorder` or `jobFolder:reorder`); the server rewrites positions in a single transaction. The job list / folder list refetches automatically afterwards.

### Running a local job
1. User clicks "Run" on the job detail view.
2. Backend reads the job's attached agents + MCPs, drops stale references, and runs `derivePattern` to choose the routing. It then atomically creates (one transaction): the chat seeded with title/mode/provider/model, the `job_runs` row (`running`), and the `chat.originating_job_run_id` back-pointer. The spawned chat is marked `hidden_from_list = 1`. Depending on the pattern:
   - **Direct A2A** (one agent, no MCPs): the chat is agent-rooted (`agent_id` set, `orchestrated = 0`); no on-demand rows.
   - **Orchestrated / plain-LLM** (everything else): the chat is LLM-rooted (`agent_id = null`), `orchestrated` is set when ≥1 agent is attached, and the agents/MCPs are written to `chat_on_demand_agents` / `chat_on_demand_mcps` (with `pending_announce = 1`) — matching the new-chat flow rather than the chat-mode baseline.
3. The `execute` result carries `agentId` (non-null ⇒ A2A, null ⇒ orchestrated/LLM), so the renderer dispatches `startAgent` vs `startLlm` with the existing logic. For the LLM path it resolves provider/model the same way the new-chat flow does (falling back to the workspace's default chat mode when the job left `modeId` null), then navigates into the spawned chat without leaving the Jobs sidebar tab and kicks off the stream with the prompt.
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
- **Run routing.** `derivePattern(agentIds, mcpIds)` (shared `src/shared/commPattern.ts`, used by both the new-chat composer and `jobService.executeLocal`) decides A2A vs orchestrated. A job's attached MCPs are treated as **on-demand** (not chat-mode baseline) so they count toward the decision and the orchestrator unions them — a job with one agent + MCPs is orchestrated, not direct A2A.
- **Local job dependencies.** Running a local job validates that **every** attached agent and the chat mode still exist. A missing agent or mode throws `JobError('missing_dependency', ...)` and surfaces as an inline run error — no auto-fallback. (The edit form's `set-agents` save filters stale ids silently; a hard run is stricter.)
- **Stale MCP refs.** MCP provider IDs attached to a job that no longer exist are silently filtered before the chat is created (an MCP delete elsewhere shouldn't crash a run).
- **Atomic local execution.** Chat row (with `hidden_from_list = 1`), on-demand agent/MCP attachments, job_runs row, and the chat's `originating_job_run_id` back-pointer all write in one transaction. A crash mid-way leaves the DB unchanged.
- **Hidden-from-list chats.** Job-spawned chats are marked `hidden_from_list = 1` and excluded from `chatRepo.list` (the main Chats sidebar). The user opts each chat into the visible Chats list explicitly via the "Move to Chats" button on the run row, which clears the flag. Hidden chats are otherwise fully functional — they still appear in run-history rows, still receive streaming updates, and are not in the trash (only soft delete hides a chat from the trash filter, not from this flag).
- **Stream-completion hook.** Local runs are finalized by the chat streaming layer reading `chats.originating_job_run_id` and calling `jobService.reportRunCompletion(...)`. No renderer cooperation required; survives renderer restart.
- **Concurrent runs.** Running the same job multiple times in parallel is allowed — each invocation creates its own chat + run.
- **Soft delete.** Deleting a job sets `deleted_at`; existing job_runs rows are kept (no cascade) so history survives until a hard delete is added.
- **Cinna status mapping.** cinna-core `completed | archived → succeeded`, `error → failed`, `cancelled → cancelled`, `new | pending → pending`, everything else (`refining`, `open`, `in_progress`, `blocked`, etc.) → `running`.
- **Cinna run polling.** Polls every 5s when the window is focused, 10s when hidden. Stops automatically when the active set of non-terminal cinna runs becomes empty. Network failures during polling are silent.
- **External URL safety.** `app:open-external` only forwards `http:`/`https:` URLs (mirrors the renderer's `setWindowOpenHandler` policy).
- **Folder scope.** Folders are profile-scoped (per-account); they don't follow the user across profile switches.
- **Folder name.** `name` must be non-empty after trim — both at create and rename. Empty names raise `JobError('invalid_input', 'Folder name is required')`.
- **Folder delete preserves jobs.** Deleting a folder detaches its jobs back to the root group (`folderId = null`) in the **same transaction** as the folder row drop — folder deletion can never lose jobs even on crash. Job `position` values on the orphaned jobs are left untouched (they keep their previous order; the user can re-tidy via drag-drop).
- **Group ordering contract.** `jobsRepo.reorderInGroup(userId, targetFolderId, orderedJobIds)` rewrites every id in the list with `folderId = targetFolderId` and `position = index` in a single transaction. The caller is expected to submit the **full new ordering** of the destination group; partial lists would leave the omitted jobs with stale positions. Folder reorder is symmetric.
- **Reorder ownership.** `jobService.reorderJobs` pre-validates every submitted job id against the active profile before any write, and verifies the target folder belongs to the profile when `targetFolderId !== null`. A stale or cross-profile id raises `JobError('not_found')` and aborts the batch.
- **Jobs tab empty state.** Switching to the Jobs sidebar tab clears `activeJobId` and lands the main pane on a "Select a job to view." pane — auto-selecting the first job would be misleading when the first job can be inside a collapsed folder.

## Architecture Overview

```
Sidebar
  -> SidebarTabs (icon book-tabs stuck to the left edge of the sidebar card)
       jobs tab click -> setActiveJobId(null) + setActiveView('job-detail')  (empty pane on tab switch)
  -> ChatList OR JobsList

JobsList
  -> Header: FolderPlus (new folder) + Plus (new job)
  -> useJobList + useJobFolders, groups jobs by folder client-side
  -> JobFolderRow[] (folders + their jobs)
  -> root drop zone (ungrouped jobs)
  -> JobsDragContext provider — sets `{ kind, id }` while a drag is in flight so drop targets only highlight for compatible drags
  -> JobItem -> useUIStore.setActiveJobId + setActiveView('job-detail')
  -> JobItem (draggable; drop target → reorder within group via parent callback)
  -> + button -> JobTypePicker modal (Cinna users)  OR  direct useCreateJob (local users)
  -> JobItem hover green Play pill -> useExecuteJob({ jobId, navigate: false })  (fire-and-forget run from sidebar)
  -> JobItem spinner (green Loader2) shown unconditionally while `inProgressRunsCount > 0` (read off JobData from job:list)

JobFolderRow
  -> draggable header (folder reorder source / target)
  -> header drop target: job  → onDropJobInto  (append job to folder, parent posts new ordering)
                       folder → onReorderFolder (parent rewrites folder positions)
  -> single click → useUpdateJobFolder({ collapsed: !collapsed })
  -> trailing slot: job count (idle) or Settings gear (hover / menu open)
       gear menu: Edit → JobFolderEditModal, Delete → confirm modal → useDeleteJobFolder
  -> empty body (when expanded + empty) accepts a job drop with "Drop a job here" hint

Reorder posting paths
  job moved/reordered  → useReorderJobs.mutate({ targetFolderId, orderedJobIds })  -> jobs:reorder
  folder reordered     → useReorderJobFolders.mutate(orderedIds)                  -> jobFolder:reorder

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
        -> read job_agents + job_mcp_providers, drop stale refs
        -> derivePattern(agentIds, mcpIds) -> A2A | AI
        -> jobRunsRepo.createLocalChatAndRun() [single transaction]
              A2A : chat(agent_id=rootAgent, orchestrated=0)
              AI  : chat(agent_id=null, orchestrated=agents>0)
                    + chat_on_demand_agents + chat_on_demand_mcps
              + job_runs + chat.originating_job_run_id
  -> execute result.agentId  (non-null=A2A, null=AI) drives renderer dispatch
  -> renderer (AI) resolves provider/model, navigates, fires startLlm
     renderer (A2A) navigates, fires startAgent
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
- [Orchestrated Agents](../../chat/orchestrated_agents/orchestrated_agents.md) — A job's agents+MCPs route through the same `derivePattern` decision and on-demand-attachment model; a multi-counterparty job spawns an orchestrated LLM-root chat that calls each agent/MCP as a tool. `derivePattern` lives in `src/shared/commPattern.ts`, shared by the composer and the job runner.
- [Chat Modes](../../chat/chat_modes/chat_modes.md) — Local jobs reference a chat mode by id for provider/model/MCP defaults.
- [Agents](../../agents/agents/agents.md) — Local jobs can attach one or more agents; a single agent with no MCPs runs over direct A2A, otherwise agents are exposed to the orchestrator as tools.
- [Connections](../../mcp/connections/connections.md) — Job MCP attachments are written to the spawned chat's `chat_on_demand_mcps` (on-demand, so they count toward the routing decision).
- [Cinna Accounts](../../auth/cinna_accounts/cinna_accounts.md) — Cinna Task jobs require an active Cinna OAuth session; reauth bubbles up as `JobError('reauth_required')`.
- [Cinna Task Run View](../cinna_task_view/cinna_task_view.md) — Read-only in-app view of a cinna_task run; reached by clicking a `cinna_task` row in this job's run history. Surfaces comments + attachments fetched from cinna-core.
- [App Shell](../../ui/app_shell/app_shell.md) — Sidebar gains the icon tab rail; settings view hides it.
- [Onboarding](../../auth/onboarding/onboarding.md) — JobTypePicker reuses the onboarding welcome-card visual treatment (Sparkles header + 2-card grid).
