# Jobs

## Purpose

Let users save reusable units of work (title + description + prompt + execution config) they can execute repeatedly. Each execution becomes a Job Run with status tracking. A "diary book" tab strip stuck to the sidebar's left edge switches the list body between **Chats** and **Jobs**.

## Core Concepts

- **Job** — A profile-scoped saved spec (title, description, prompt, agents/mode/MCP attachments, color/icon). Two execution types, set once at creation and not editable afterwards:
  - **Local Job** — Runs against the user's local agents / chat mode / MCPs. A job can attach **any number of agents** plus MCPs (`job_agents` + `job_mcp_providers` join tables); at run time `newChatRouter(agentIds, mcpIds)` — the same helper the new-chat composer uses (`src/shared/chatRouting.ts`) — picks the spawned chat's router: one agent and no MCPs binds that agent (`direct`), several agents make a chat the user routes by hand (`human`), and agents mixed with MCP servers need the local model to coordinate (see [Chat Routing](../../chat/chat_routing/chat_routing.md) and [Orchestrated Agents](../../chat/orchestrated_agents/orchestrated_agents.md)). Each run spawns a new chat seeded with the job's prompt; the existing chat pipeline drives the conversation.
  - **Cinna Task Job** — Only available on Cinna-linked profiles. Each run creates a local task and hands it to the profile’s available remote adapter. The conversation lives on the service; the desktop keeps the task and its binding, with `cinnaTaskId` + `cinnaShortCode` retained on the run for its existing views.
- **Autonomous job definition** — A programmatically authored local job can store an explicit script/coordinator router, script and budget. Run admits these definitions in main; the current form has no script or autonomous-definition editor. See [Script Definitions](../tasks/script_definitions.md).
- **Scheduled Job** — [Local schedules](../tasks/local_schedules.md) creates a one-step script Job after explicit review. The Job may sync as a definition; device-local scheduling consent does not. Manual runs and historical generated Jobs participate in schedule overlap checks.
- **Job Run** — One execution of a job, with status `pending → running → succeeded | failed | cancelled`. Every new run links its durable task. The run keeps its original local/chat or remote/service provenance even if the task later changes executor. Refresh follows the current task binding; origin still determines historical conversation links and deletion disclosures. Active legacy remote runs without a task are adopted while the window is visible; terminal legacy history requires manual Refresh.
- **Job Folder** — A user-defined sidebar grouping for jobs (profile-scoped, name + collapsed-state + sort position). Folders are thin collapsible separators — they own ordering but no execution config. A job lives either in exactly one folder or at the root level.
- **Group** — A bucket the sidebar can address by drag-drop: either the root level (`folderId = null`) or a specific folder. Each group has its own job ordering.
- **Sidebar Tab Rail** — Two icon-only square tabs (Chats / Jobs) stuck to the sidebar's left edge like the bookmark tabs on a folder. The selected tab visually merges with the sidebar surface (no seam on its right edge); inactive tabs are smaller recessed blocks. Hidden in the settings view.
- **Run Status** — Local runs flip via the chat-stream completion hook (success when the first assistant turn finishes, failure when the stream errors, **cancelled when the user stops it**, and **failed when the turn is refused before either streaming service owns it**). Remote runs refresh the bound task through its adapter and derive their status from that task while non-terminal.

## User Stories / Flows

### Switching between Chats and Jobs
1. User clicks the icon tab on the sidebar's left edge (speech bubble = Chats, briefcase = Jobs).
2. Sidebar body swaps from the chat list to the jobs list. It has no task section: durable root work, including work with no job run or Inbox request, is listed under **Recent tasks** on the Inbox screen, and a job's run history still opens each attempt's task. See [Tasks](../tasks/tasks.md). The selected tab visually fuses with the sidebar (same surface, no border between them); the other sits as a separate recessed block.
3. **Main area realigns**. Switching to Chats from another tab reopens the chat that was open last when it is still in the list, and otherwise the first chat (or the New Chat screen when none exist). Opening the first chat instead sent a user who had left a chat, for instance by saving an excerpt to Notes, to a different conversation. Switching to Jobs lands on the **"Select a job to view." empty state** — auto-selecting the first job would be misleading when jobs can live inside a collapsed folder. `activeCinnaRunId` is cleared on every tab switch and `activeJobId` is reset to null.
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
2. The header shows the job's title, description, a type pill (`Local` / `Cinna Task`), an icon-only **Edit** (pencil) button, and a primary green **Run** button. When the job's manifest names an agent that does not resolve on this device, **Run is disabled** with the tooltip *"This job can't run on this device — incomplete setup"* (the tooltip hangs on a wrapper `<span>`, because a disabled button swallows its own mouse events), and a red **Incomplete setup** panel sits above the summary reading *"This job needs an agent that isn't available on this device, so it can't run here."* The panel gives no repair instruction, on purpose — see [Local Agents Are Not Synced](../../agents/local_agents/local_only.md).
3. Below the header, a summary card shows the prompt verbatim plus a strip of compact **chip-style badges** for *non-default* configuration only (same chip pattern used in the chat composer — `OnDemandAgentChips` / `ActiveMcpChips`):
   - Local: a **router badge** (`Direct` / `You route` / `Model routes`) previewing how the job will run, one agent chip per attached agent (Bot icon, accent border), a chat-mode chip (color dot tinted with the mode's preset), and one MCP chip per attached provider (Wrench icon). Each config chip only appears if the field is set; the badge always shows for local jobs.
   - Cinna Task: Cinna agent chip (Bot — red "No Cinna agent" chip if missing) and priority chip (Flag, only when not `normal`).
4. Below the summary, the **Run history** lists the job's runs newest-first; the section is empty when there are no runs.

### Editing a job
1. From the Job Detail view, user clicks **Edit** — Main area swaps to the **Job Edit** page (the same form used at creation).
2. Title, description, prompt, agent, mode (local jobs) or Cinna agent / priority (Cinna jobs) auto-save on a debounce (~600ms) when changed.
3. **Agents & Connectors (local jobs)** share one control: attached agents (Bot chips) and MCPs (Plug chips) render as a row of removable chips with a single **"Add"** button that opens the **"Agents & Connectors"** picker — one frosted, searchable modal listing agents (grouped My Agents / Shared with Me / People / Local) and a **Connectors** section for available MCPs. It is **multi-select** (click toggles a checkmark, the modal stays open). A live **router badge** above the chips previews which of the three routers the current selection would produce. The **Cinna Agent** field (Cinna jobs) keeps its single-select picker.
4. **Chat Mode (local jobs)** is a row of color **pills** — one per chat mode tinted with the mode's preset color, plus a "Default" pill — instead of a dropdown. Selecting a pill sets the mode.
5. Agent and MCP changes **persist immediately** (via `job:set-agents` / `job:set-mcp-providers`), not through the debounced patch. Auto-save of title/description/prompt/mode is a no-op while title or prompt are empty.
6. The header has a **← Back** link (returns to Job Detail; auto-save persistence is already in flight) and a primary **Save** button (flushes pending changes and navigates back to Job Detail).
7. The job type is fixed at creation — no in-form toggle. Field set switches based on the persisted `job.type`.

### Running a job from the sidebar (fire-and-forget)
0. **A blocked job offers no run-now button at all.** When `incompleteSetup` is set, the trailing slot holds a **red** warning marker (*"Incomplete setup — this job can't run on this device"*) shown **unconditionally**, and the Play pill is not rendered — main would refuse the run and the sidebar has no room to show the error. This differs from the **amber** "finish setup" marker, which is advisory and stays suppressed while hovering so resting rows stay clean.
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

This flow applies to ordinary jobs with null runtime fields. Explicit coordinator/script Jobs follow the main-owned flow below.

1. User clicks "Run" on the job detail view.
2. **Backend checks the manifest first.** If `jobs.sync_deps` names an agent — folder or remote — that resolves to nothing here, the run is refused before anything is created: `JobError('incomplete_setup', "This job can't run on this device. It needs an agent that isn't available here: <names>.")`. The renderer strips the IPC transport prefix (`unwrapIpcError`) so the alert shows that sentence and not our channel name.
3. Otherwise the backend reads the job's attached agents + MCPs, drops stale references, and runs `newChatRouter` to choose the spawned chat's router. It then atomically creates (one transaction): the chat seeded with title/mode/provider/model **and its `router`**, the `job_runs` row (`running`), and the `chat.originating_job_run_id` back-pointer. The spawned chat is marked `hidden_from_list = 1`:
   - **`direct`** (one agent, no MCPs): the chat is agent-rooted (`agent_id` set); no on-demand agent rows.
   - **`human`** (several agents, no MCPs): `agent_id = null`, every agent written to `chat_on_demand_agents` (`pending_announce = 1`), and **the first message is addressed to the first of them**. That first is stable but arbitrary — `job_agents` records no order, so `listAgentIds` sorts by id purely so the same job runs the same way twice. The doc says so rather than implying a user-meant order; a run is one prompt, so it has to pick somebody, and the user routes the rest in the spawned chat.
   - **`coordinator`** (agents mixed with MCPs): `agent_id = null`, agents and MCPs written to `chat_on_demand_agents` / `chat_on_demand_mcps` — matching the new-chat flow rather than the chat-mode baseline.
   - **MCP servers follow the *model*, not the router.** They are attached whenever the answerer is the local model, which includes a job with connectors and **no agent at all** (that chat is `direct`, to the model). Gating them on `coordinator` would have run such a job toolless and reported a success.
4. The `execute` result carries `agentId` — who the **first message** goes to, null when that is the local model. The renderer resolves provider/model the same way the new-chat flow does (falling back to the workspace's default chat mode when the job left `modeId` null), navigates into the spawned chat without leaving the Jobs sidebar tab, and fires `startRun` with that target so the run's agent gets the same post-turn status re-read a typed message would.
5. When the chat's stream finalizes (`done`), the run flips to `succeeded`; on stream error, it flips to `failed` with the error message. A turn that never reaches a stream at all — the chat, its model or its agent is gone by the time the user presses send — also flips it to `failed`, carrying the refusal's own sentence.

### Running an explicit autonomous Job

1. Press **Run** on a programmatically configured coordinator or script Job. The summary badge respects that explicit router; **Script routes** explains that dependencies choose the steps and only participating agents call models.
2. Main validates the definition, supported budget and required resources. Coordinator jobs resolve their explicit/effective-default model; scripts resolve all declared aliases without installing agents. Refusal leaves no partial attempt.
3. Main commits the chat, run, task and runtime checkpoint together before launch. Scripts also create isolated child tasks/conversations. The renderer may open the conversation but sends no prompt; main owns execution even if the user leaves the page.
4. Follow the task and Inbox for progress, questions, Stop or explicit Resume after interruption. Intermediate turns do not finish the Job attempt. See [autonomous coordination](../tasks/autonomous_tasks.md) and [script execution](../tasks/script_execution.md).

### Running a Cinna Task job
1. User (on a Cinna-linked profile) clicks "Run" on a job of type `cinna_task`.
2. Backend verifies the configured remote agent and an available service before creating a task. It then creates the task, hands it across the adapter seam, and records a run linked to that task. The executor changes only after the service accepts the handover.
3. Renderer stays on the Job Detail view. No local chat is spawned; the new run appears in history and its row opens the task page.
4. The profile task scheduler refreshes bound work and projects remote status into its matching active attempt. Jobs polls the saved rows while an attempt remains active. Only legacy remote runs without tasks need the visible-window adoption timer. A blocked task remains a running job attempt, since waiting for a person is not completion.
5. **On the service**, visible at rest, opens the service’s conversation inside the app. **Open on Cinna** opens the web task; **Refresh**, when the current binding or legacy-adoption mode permits it, requests a read even for terminal history.
6. A remote run created before tasks existed is adopted on refresh: reuse an existing binding or create a replica linked to its existing remote id. It does not create a second remote task.

### Viewing run history
1. Job Detail's history section lists runs newest-first with a colored status pill.
2. **The trailing action icons reveal on row hover** (the cluster is `opacity-0` and fades in via `group-hover`; `focus-within` keeps them reachable for keyboard users). The status pill, run label, timestamp, and the cinna comment/attachment count badges stay visible at all times.
3. Local runs:
   - The **entire row is a button**, and on a run that has a task it opens **the task**, not the conversation — *but the sidebar stays on the Jobs tab and the originating job stays highlighted*, exactly as when it opened a chat. The user is "still inside the job"; one click on the job row in the sidebar goes back to the job's detail. The task is what the row leads to because it is what survives: the spawned chat is hidden from the Chats list and is hard-deleted with the run, while the task outlives both.
   - The row's subject line reads **Task** on those rows, where it read "Local chat". A control that names the thing it no longer opens is worse than an unlabelled one — and the row is a `role="button"` with no `aria-label`, so that line is part of what a screen reader announces, not decoration. The tooltip says "Open the task" beside it.
   - **Chat** — a small labelled action shown **at rest**, just before the hover-revealed icons — opens the conversation the run happened in. It is at rest rather than in the hover cluster because it is now the only route from Run history into that chat, and a control whose only distinction appears on hover does not exist for anyone who has not already guessed it is there. It renders only on rows that lead somewhere else first: a run with no task needs no second control for what the row already does.
   - A run with **no task** keeps precisely the behaviour it had — the whole row opens the spawned chat, and no Chat action appears.
   - When the spawned chat was deleted (cascade-set-null leaves `localChatId` as null), the row gets a gray **`Deleted`** pill next to the status pill. A row with a task stays clickable — the task is exactly what outlived the chat — and only a row with neither goes non-interactive (no hover, no cursor change).
   - Trailing action icons (hover-revealed): **Inbox** ("Move this chat into the Chats list") — only when the chat is still hidden-from-list; clicking promotes it into the visible Chats list. **Trash** ("Delete run") — opens a confirmation that hard-deletes the run and its spawned chat together. Job-spawned chats are hidden from the main Chats list by default so the chat sidebar isn't flooded with every job run.
4. Cinna runs:
   - The **entire row is a button** when it has a task or `cinnaTaskId`. A task-linked row opens the task page; **On the service**, visible at rest, opens the [Cinna Task Run View](../cinna_task_view/cinna_task_view.md) with its conversation and attachments. A legacy row with no task still opens that service view directly. The sidebar stays on Jobs and the originating job stays highlighted. The local **Chat** control and **On the service** never appear together: each names the conversation for its run type.
   - Two compact pill badges sit just before the action icons (each only rendered when its count is > 0): a `MessageSquare` badge with the comment count (system/status-change/assignment entries excluded) and a `Paperclip` badge with the attachment count. Counts come from the same cinna-core fetch that powers the task view — opening the view warms the cache for the row and vice versa.
   - Trailing action icons (hover-revealed): **Refresh** (manual status pull when the current binding or legacy-adoption mode permits it, including terminal runs, with a minimum visible 500ms spin even when the IPC roundtrip is sub-frame); **Open on Cinna** (deep-link to `{cinnaServerUrl}/tasks/{short_code}`); **Trash** ("Delete run") — removes only the desktop's run record (the upstream cinna-core task stays on the server). Errored runs show the error message inline.

### Staying inside the jobs context
- Opening a run's chat (via the run row) or running a job (via the Run button) sets the chat view as the active main pane but **does not** swap the sidebar tab to Chats and **does not** clear `activeJobId`. The Jobs tab stays open in the sidebar with the job's row still highlighted.
- **Job-origin banner.** When the open chat was spawned by a local job run (`chats.originating_job_run_id` is set), a small slightly-transparent pill (`JobOriginBanner`) sits at the right of the title-bar band showing **"From job · {title}"**. Clicking it jumps to that job's detail page (`setActiveJobId(jobId)` + `setActiveView('job-detail')`). It resolves the run id → `{ jobId, title }` via the `job:run-origin` IPC (`jobService.getRunOrigin`), gates on `activeView === 'chat'`, and renders nothing if the chat wasn't job-spawned or the job was deleted. This is the in-chat counterpart to the sidebar highlight — it works even after the chat is promoted into the main Chats list (where the Jobs-tab highlight no longer applies). Two non-obvious placement constraints: (1) it is rendered as a child of the `TopBar` drag strip so a button nested in `.app-drag-strip` inherits `-webkit-app-region: no-drag` and stays clickable — an element that only *overlaps* the strip from another DOM subtree has its clicks eaten by the OS window-drag region; (2) it is right-aligned (`ml-auto`) rather than window-centered so it sits over the chat area regardless of the sidebar's width or collapsed state.
- The job's row also stays highlighted while viewing its detail and edit screens.
- Picking a chat from the main Chats list, starting a fresh chat from the top-bar `+`, or switching profiles drops the jobs anchor (`activeJobId` is cleared), so the highlight only sticks while the user is genuinely working inside that job.

## Business Rules

- **One dispatch owner.** Main selects the Job executor from the stored definition. Ordinary desktop preparation returns `renderer_turn`; the renderer resolves its existing chat defaults and sends once. Autonomous and remote work return `accepted`; the renderer may navigate but never sends another prompt. Unknown dispositions refuse dispatch. See [execution and refresh internals](execution_tech.md).
- **Preparation and acceptance have different failure boundaries.** Ordinary desktop chat/run/task preparation is atomic. Remote admission rechecks the Job and connection after availability; work already accepted by the service survives any later local bookkeeping failure and must not be run again as a retry.

- **Profile scope.** Jobs and job runs live in the active profile's `userId` scope — they don't follow the user across profile switches and are invisible from other profiles.
- **Validation.** `title` and `prompt` must be non-empty; `type` must be `local` or `cinna_task`. Updates that would null these out are rejected with `JobError('invalid_input', ...)`.
- **Type chosen once.** The picker only runs for Cinna users on the `+` click. Non-Cinna profiles skip the picker and always create a `local` job. Once stored, `job.type` is treated as immutable by the UI (the edit form has no toggle).
- **Delete always confirms.** There is no one-click delete from the sidebar — every delete goes through the `DeleteJobConfirm` modal.
- **Run routing.** `newChatRouter(agentIds, mcpIds)` (shared `src/shared/chatRouting.ts`, used by both the new-chat composer and `jobService.executeLocal`) picks the spawned chat's router. A job's attached MCPs are treated as **on-demand** (not chat-mode baseline) so they count toward the decision and the conductor unions them — a job with one agent + MCPs is coordinated, not direct. See [Chat Routing](../../chat/chat_routing/chat_routing.md).
- **Local job dependencies.** Running a local job validates that **every** attached agent and the chat mode still exist. A missing agent or mode throws `JobError('missing_dependency', ...)` and surfaces as an inline run error — no auto-fallback. (The edit form's `set-agents` save filters stale ids silently; a hard run is stricter.)
- **Any enabled agent can be attached, including a folder agent.** The picker filters on `enabled` and nothing else, and files a folder agent under **"Local"** — it is a property of this machine rather than of the signed-in account, which is also how the lookup scopes it. Its meta tag reads `LOCAL-FOLDER`, the protocol name upper-cased. See [Folder Agents as Counterparties](../../agents/local_agents/counterparty.md).
- **A dependency the manifest names but this device cannot supply is *reported*; an unresolvable **agent** is also *enforced*.** `getDependencyStatus` distinguishes `needs-setup` (a row is here and needs finishing — the "Set up →" button opens its configuration: MCP Providers for a connector, Default → Agents for a folder agent, and that A2A agent's page in Settings mode for a connection) from `unavailable` (nothing here to open). A folder agent whose workshop is absent is `unavailable`; there is no in-app repair, and the app deliberately does not suggest one — see [Local Agents Are Not Synced](../../agents/local_agents/local_only.md).
- **A job whose manifest names an agent that resolves to nothing here is blocked, not degraded.** `executeLocal` recomputes that set from `jobs.sync_deps` and throws `JobError('incomplete_setup', …)` naming the missing agents. This closed a defect, not a design choice: the join rows `executeLocal` reads are the *resolved* subset, so an absent agent left no row, the pre-existing `missing_dependency` check compared `[]` against `[]`, the router answered "a chat with the local model", and the job **ran as a plain-LLM chat with the agent silently absent and recorded a success**. A wrong run reported as a success is worse than a job that refuses to start.
- **The block covers agents only — MCPs and `source: 'local'` A2A agents are deliberately outside it.** Both auto-create a disabled shell the user finishes configuring in the app, so blocking them would break the ordinary sync-then-configure path. A present-but-disabled row is likewise outside it: that is a toggle with a working "Set up" button behind it, and `getDependencyStatus` calls it `needs-setup`. **Known and still open:** a `source: 'local'` shell the user later *deletes* reproduces the identical agentless-success failure, and is knowingly not covered (see [Folder Agents as Counterparties](../../agents/local_agents/counterparty.md)).
- **`incompleteSetup` is advisory in the renderer and authoritative in main.** `JobData.incompleteSetup` (on both `job:list` and `job:get`) disables the Run button, drives the red sidebar marker, and adds an "Agent unavailable" chip to the summary. It is deliberately **not** `needsSetup`, which is also true for a disabled MCP shell — gating "can't run here" on that would refuse jobs that run fine. The refusal itself is recomputed in `executeLocal`, so a renderer working from a stale job list still cannot start a run.
- **Stale MCP refs.** MCP provider IDs attached to a job that no longer exist are silently filtered before the chat is created (an MCP delete elsewhere shouldn't crash a run).
- **Atomic local execution.** Chat row (with `hidden_from_list = 1`), on-demand agent/MCP attachments, job_runs row, and the chat's `originating_job_run_id` back-pointer all write in one transaction. A crash mid-way leaves the DB unchanged.
- **Hidden-from-list chats.** Job-spawned chats are marked `hidden_from_list = 1` and excluded from `chatRepo.list` (the main Chats sidebar). The user opts each chat into the visible Chats list explicitly via the "Move to Chats" button on the run row, which clears the flag. Hidden chats are otherwise fully functional — they still appear in run-history rows, still receive streaming updates, and are not in the trash (only soft delete hides a chat from the trash filter, not from this flag).
- **Stream-completion hook.** Local runs are finalized by the chat streaming layer reading `chats.originating_job_run_id` and calling `jobService.reportRunCompletion(...)`. No renderer cooperation required; survives renderer restart. The same call records the outcome on the run's task, and that write is deliberately **best-effort**: a run that has genuinely finished must be recorded as finished even if the task write throws, or `countInProgressByJob` keeps the sidebar's busy badge lit for the life of the app — trading a visible wrong status for an invisible one.
- **A refused initial turn is an ending; an unaccepted answer remains retryable.** Streaming setup and the shared executor report ordinary refusals as failed job outcomes. When a next-message answer is refused before its message transaction is accepted, the pending request and job attempt are preserved so the user can retry. Activation refusal remains outside profile writes. There is still no general boot/unlock reaper for unrelated stale running attempts.
- **A next-message ask keeps the same attempt open.** Normal A2A turn completion does not succeed the job while a durable human request remains. An Inbox answer continues the same chat/task/job run and protocol context in main; sibling requests continue to block completion. The final turn with no pending continuation reports the outcome through the existing completion hook. See [Inbox continuation](../tasks/inbox.md#durable-continuation-and-refusal).
- **A stop is an ending, not a non-event.** Pressing Stop in a job-spawned chat finalizes the run as `cancelled` — with no error message, because a stop is not a failure — down **every** exit the stream can take, and there are four across the two streaming services. A run that already reached a terminal status is left alone, so a late stop cannot rewrite a recorded outcome. This is separate from `job:cancel-run`, which is the explicit action on a run row rather than a stop on the chat.
- **Finalizing a stop as `cancelled` changes the outcome and nothing else.** Every stopped turn posts `done` to the renderer and keeps what it streamed as the assistant's message: an agent-backed run because a cancelled runner returns what it streamed with no error, and one whose result also carries an error because it falls through to that same ending; an LLM run between tool rounds because every finished round is already saved, and mid-stream because the round's partial reply is saved before `done`. The run is recorded as cancelled beside an answer the user can read; stopping a turn is not undoing it.
- **A mid-stream stop on an LLM turn used to lose the last round's text and hang the chat.** The adapter rejects when its signal fires, so that round's assistant message had never been saved, and the abort branch returned without posting `done` — the chat sat in its streaming state until the user switched away, because the renderer's Stop clears nothing itself. The branch now saves the round's partial reply and then posts `done { stopReason: 'canceled' }`. The order matters: `done` refetches the chat and clears the live text, so a `done` without the save would have made the stopped reply vanish. On the agent path, a runner that throws after a stop has nothing to keep, and posts `done` too.
- **Two mistakes with one consequence, and the rule is one sentence each.** *Suppressing the error surface is not the same as reporting nothing*: both streaming paths were right to refuse to post or persist a cancel as a failure — the user asked for it — but each then returned, finalizing nothing, and the run stayed `running` for the life of the app; nothing reaps a stale run, and `countInProgressByJob` counts `pending` and `running`, so the job advertised itself as busy for ever. And *a stop that returns cleanly is not a success either* — **the usual case, and the one found last**. A cancelled runner returns what it streamed with **no error**; that is the `AgentTurnRunner` contract and both folder runners honour it, so a stopped turn does not reach an error branch at all. It leaves through the success line, which reported `succeeded`. That is the worse of the two: a stale `running` row at least looks unfinished, while a run recorded as finished invites no second look. Both success paths now finalize on the signal, and the same defect had a third instance in the OpenAI adapter, which resolved on abort so the turn was not even known to have been stopped — see [Provider Integration](../../llm/adapters/provider_integration.md#openai-an-abort-is-a-clean-end-of-stream-so-the-adapter-has-to-reject-itself).
- **Concurrent runs.** Running the same job multiple times in parallel is allowed — each invocation creates its own chat + run.
- **Soft delete.** Deleting a job sets `deleted_at`; existing job_runs rows are kept (no cascade) so history survives until a hard delete is added.
- **Remote run status follows its task.** Remote status updates affect only the matching active attempt, preserving terminal history and failure details. Confirmed loss of remote work fails that attempt but keeps the locally authored Task, its last-known status and executor. A temporary outage, account relink or desktop takeover is not confirmation that remote work was deleted.
- **Refresh follows ownership.** The profile task scheduler refreshes bound work; Jobs polls saved rows while attempts remain active. A separate visible-window timer only associates legacy remote runs that have no task, then stops. Manual Refresh is offered for a current remote binding or legacy adoption, including terminal history; an unresolved handoff must be reviewed on the Task page.
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
       -> useCinnaRunPoll  (visible-only legacy adoption; bound work uses taskSyncScheduler)

TopBar (always mounted)
  -> JobOriginBanner  (right-aligned no-drag pill; renders only when activeView==='chat'
                       and the active chat has originatingJobRunId)
       useChatDetail(activeChatId).originatingJobRunId
         -> useJobRunOrigin(runId) -> job:run-origin -> { jobId, title }
       click -> setActiveJobId(jobId) + setActiveView('job-detail')

MainArea (activeView === 'cinna-task-run')
  -> CinnaTaskRunView  (see docs/jobs/cinna_task_view/cinna_task_view.md)

MainArea (activeView === 'job-edit')
  -> JobEditPage  (full-page edit screen, opened via "Edit" or on create)
       -> header (Back chevron, "Edit job" title, icon-only Delete button, primary Save button)
       -> JobEditForm  (auto-save debounce; exposes `flush()` via ref so Save can persist before navigating)
       -> Delete -> DeleteJobConfirm modal -> useDeleteJob (cleanup routes back to chat view)
       -> on save success -> setActiveView('job-detail')

Execution and refresh
  Run -> activated job:execute -> jobService -> owning JobExecutor
    desktop ordinary -> atomic chat/run/task preparation -> renderer_turn -> one renderer send
    desktop autonomous -> coordinator/script prepare + post-commit launch -> accepted
    remote -> current Job/connection preflight -> durable task handoff -> accepted
  History row -> current Task; separate original Chat / On the service links remain
  Profile task scheduler -> bound task snapshots -> matching active attempt projection
  Visible legacy-adoption timer -> job:refresh-run -> associate missing Task once
  Manual Refresh -> job:refresh-run -> current bound task / eligible legacy adoption
  Confirmed remote loss -> unbind + fail matching active attempt; preserve local Task
```

## Integration Points

- [Tasks and the Inbox](../tasks/tasks.md) — each attempt has a durable work record; local and remote asks are answerable from the shared Inbox without opening the run conversation.

- [Messaging](../../chat/messaging/messaging.md) — Local runs spawn a chat that the existing send pipeline drives end-to-end.
- [Chat Routing](../../chat/chat_routing/chat_routing.md) — a job run makes the same `newChatRouter` decision the new-chat composer makes, and spawns a chat already on that router. `src/shared/chatRouting.ts` is shared by the composer, the job runner and main's send path.
- [Orchestrated Agents](../../chat/orchestrated_agents/orchestrated_agents.md) — a job that mixes agents with MCP servers spawns a coordinated chat that calls each agent/MCP as a tool.
- [Chat Modes](../../chat/chat_modes/chat_modes.md) — Local jobs reference a chat mode by id for provider/model/MCP defaults.
- [Agents](../../agents/agents/agents.md) — Local jobs can attach one or more agents; a single agent with no MCPs is bound as the chat's counterparty, several agents make a chat the user routes, and agents mixed with MCPs are exposed to the conductor as tools.
- [Connections](../../mcp/connections/connections.md) — Job MCP attachments are written to the spawned chat's `chat_on_demand_mcps` (on-demand, so they count toward the routing decision).
- [Cinna Accounts](../../auth/cinna_accounts/cinna_accounts.md) — Cinna Task jobs require an active Cinna OAuth session; reauth bubbles up as `JobError('reauth_required')`.
- [Cinna Task Run View](../cinna_task_view/cinna_task_view.md) — Read-only in-app view of a cinna_task run; reached by clicking a `cinna_task` row in this job's run history. Surfaces comments + attachments fetched from cinna-core.
- **The task page** (`src/renderer/src/components/tasks/TaskView.tsx`, `activeView: 'task'`) — where a local run row with a task lands. It renders the task, offers the way back to the job and to the conversation, and for a task that is `blocked` or `error` offers a re-run from the last message in that conversation. It belongs to no sidebar tab, so pressing the already-selected tab leaves it rather than deciding nothing changed. On a Cinna profile the same page also opens a task another of the user's devices is holding, and there it withholds the re-run and the Inbox link — neither would work on a run this device does not own — and offers **Take over** instead. See [A Task on the User's Other Devices](../tasks/cross_device.md).
- [The Handoff Note, Exported](../tasks/handoff_note_export.md) — every write to a task a job produced also keeps that task's handoff note in step as a file under `<userData>/tasks/`, when it has one.
- [App Shell](../../ui/app_shell/app_shell.md) — Sidebar gains the icon tab rail; settings view hides it.
- [Onboarding](../../auth/onboarding/onboarding.md) — JobTypePicker reuses the onboarding welcome-card visual treatment (Sparkles header + 2-card grid).
