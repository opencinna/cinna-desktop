# Cinna Task Run View

## Purpose

A read-only view inside the desktop that surfaces a Cinna task's **comments** and **attachments** so the user can see results without leaving the app. Reached from the task page's ⋯ → **Open on the server**, or by clicking a `cinna_task` row whose task is gone in a job's Tasks history.

## Core Concepts

- **Cinna Task** — Remote work item created on cinna-core via `POST /api/v1/tasks/` when a Cinna-Task Job is executed. The desktop only stores a pointer (`cinnaTaskId` + `cinnaShortCode`).
- **Task Comment** — Authored content on a task. Cinna-core distinguishes several `comment_type` values: `message` and `result` are user/agent content; `status_change`, `assignment`, and `system` are platform-generated.
- **Activity** — UI-side grouping for the system-generated comment types. Rendered as a collapsible compact log separate from real comments.
- **Task Attachment** — A `TaskAttachment` record (distinct from the `FileUpload` rows handled by chat attachments). Lives under a task-scoped download endpoint. Can be standalone on the task or inline on a specific comment.

## User Stories / Flows

### Opening the task view
1. From the task page of a task a `cinna_task` run produced, user picks **⋯ → Open on the server**. A run whose task is gone — a legacy run that never had one, or one whose task was deleted — opens this view on its own row click in the job's **Tasks history**; both require `cinnaTaskId`.
2. Main area swaps to the **Cinna Task Run View**. The sidebar stays on the Jobs tab; the originating job stays highlighted.
3. The view fetches the task detail (`GET /api/v1/tasks/{id}/detail`) and renders.
4. Header shows: a "← Back to {job title}" link, the task title, a status pill, and the short code (or task id when no short code is set).
   - The status pill is now the **shared** `TaskStatusPill` (`src/renderer/src/components/tasks/TaskStatusPill.tsx`), the same component the task page uses, so a status cannot be amber on one screen and red on the next. It still takes the raw server string and prints an unrecognised value under a neutral tone rather than dropping or guessing at it. Two spellings changed with the move: `archived` is now muted rather than green — it is filed away, not succeeded — and `blocked` reads amber where it used to take the same in-progress info tone as every unrecognised value, because a task waiting on somebody is not a task quietly progressing.
5. Top-right action row: a Refresh icon (forces a re-fetch) and an "Open on Cinna" icon (deep-links to `{cinnaServerUrl}/tasks/{short_code}` in the default browser).

### Reading comments
1. Comments are rendered as cards in chronological order under a **Comments** heading with a count badge.
2. Each card shows author name + optional role (`author_role`), a Bot icon for agent posts (heuristic: `comment_type === 'result'`, `author_role` containing "agent", or author name matching agent/assistant/bot), a User icon otherwise, and a relative timestamp.
3. `result`-type comments get a green **RESULT** pill to mark them as the agent's final deliverable.
4. Comment **content is markdown**: rendered with GFM (tables, task lists, etc.) and syntax highlighting on fenced code blocks.
5. Inline attachments on a comment (i.e. files attached via `add_comment` with `file_paths`) appear as badges below the comment body.

### Reading activity
1. System-generated entries (status changes, assignments, platform notifications) collapse into an **Activity** section below Comments, hidden behind a toggle that defaults to expanded.
2. Each activity row is a single-line compact item: the content string + a relative timestamp.
3. Activity content is itself rendered as **inline markdown** so server messages like `Status changed from **new** to **in_progress** — Session started` show the bold spans correctly without breaking the one-line layout.

### Downloading attachments
1. The standalone (task-level) attachment list lives in its own **Attachments** section near the top, with a count badge.
2. Both task-level and comment-inline attachments use the same badge UI (`AttachmentList` shared with chat message bubbles).
3. Clicking a badge opens the OS save-as dialog, streams the file from cinna-core's task-scoped download endpoint to the chosen path, and reveals it in Finder/Explorer.
4. The clicked badge shows a spinner while in flight; concurrent downloads each tick their own spinner.
5. A failed download surfaces an inline dismissible error label below the list (only on the list that owns the failed attachment).

### Refreshing
1. The Refresh icon forces an immediate `GET /detail` and updates the cache.
2. While the task is non-terminal (anything other than `completed`/`succeeded`/`error`/`failed`/`cancelled`/`archived`), the view auto-refetches every 5 seconds in the background so new comments and status flips appear without action.

### Leaving the view
1. Back link returns to **Job Detail** (`activeView = 'job-detail'`) and clears `activeCinnaRunId`.
2. Switching the sidebar tab away from Jobs also clears `activeCinnaRunId` (see [App Shell](../../ui/app_shell/app_shell.md)).
3. Pressing the **already-selected** tab now leaves the view too. This screen belongs to no tab, and while one such view fills the centre the tab press has to realign the centre rather than decide nothing changed — previously the press was a no-op, so the one gesture that looks like "take me back to my jobs" was the one that did nothing. `activeCinnaRunId` is deliberately left set on that path, so the tab's own selection is kept.

## Business Rules

- **Cinna-only.** The view requires a `cinna_task` run with a non-null `cinnaTaskId`. Every new run has a local task, which its row opens; that task page's ⋯ → **Open on the server** preserves access to this conversation. A remote row whose task is gone opens this view directly — a legacy one until the visible-window timer adopts it, if it is still active. Local runs reach their conversation through the task page instead, and a local row whose task is gone still opens its chat. See [Jobs](../jobs/jobs.md).
- **Single API call.** Comments + standalone attachments come from `/api/v1/tasks/{id}/detail` — one round-trip, not three.
- **System entries are activity, not comments.** `status_change | assignment | system` are split out of the Comments list into the Activity log, so the Comments count is the number of authored comments.
- **Timezone correction.** cinna-core serializes `datetime` columns from Python without a `Z`, but the values are UTC. The view parses timestamps with explicit UTC tagging so relative times don't drift by the user's offset.
- **No editing.** The view is strictly read-only — no posting comments, no uploading attachments, no status changes. Those happen on cinna-core's web UI (reachable via the "Open on Cinna" icon).
- **One cache key.** The query key is `['cinna', 'task-view', taskId]`; the view polls it every 5s while non-terminal. The history rows used to read the same key for count badges and no longer do: a service read per visible row bought two numbers the task page does not need.
- **Attachment endpoint is task-scoped.** `TaskAttachment` files use `GET /api/v1/tasks/{taskId}/attachments/{id}/download` — NOT the standard `/api/v1/files/{id}/download`. The desktop has a separate IPC + service path for this.

## Architecture Overview

```
TaskActionsMenu (task page ⋯, a task a cinna_task run produced) / JobRunRow (orphaned cinna_task run)
  -> setActiveCinnaRunId(runId) + setActiveView('cinna-task-run')

MainArea (activeView === 'cinna-task-run')
  -> CinnaTaskRunView
       -> useCinnaTaskView(taskId)                  // polls every 5s while non-terminal
       -> useCinnaServerUrl()                       // for deep-link
       -> useTaskAttachmentDownload()               // store-backed download state
       -> renders: header, attachments, comments, activity

useCinnaTaskView(taskId)
  -> window.api.cinna.getTaskView(taskId)
     -> IPC 'cinna:get-task-view'
       -> cinnaApiService.getTaskView(userId, taskId)
          -> GET /api/v1/tasks/{taskId}/detail      // InputTaskDetailPublic
          -> parseComment / parseAttachment (lenient field-name parsers)
          -> CinnaTaskViewDto { task, comments, attachments }

useTaskAttachmentDownload().download({ taskId, attachmentId, filename })
  -> window.api.files.downloadTaskAttachment(...)
     -> IPC 'files:download-task-attachment'
       -> save dialog -> cinnaFileService.downloadTaskAttachmentToPath(...)
          -> GET /api/v1/tasks/{taskId}/attachments/{id}/download
          -> pipeline stream to disk -> shell.showItemInFolder
```

## Integration Points

- [Tasks and the Inbox](../tasks/tasks.md) — the task page owns work status and takeover; the Inbox answers enumerated remote questions, while this service view retains conversation and attachment browsing.

- [Jobs](../jobs/jobs.md) — Cinna-task runs originate from a Cinna Task Job's `Run` button. The task view is reached from a run's task page, or from a history row whose task is gone.
- [Cinna Accounts](../../auth/cinna_accounts/cinna_accounts.md) — All cinna-core HTTP requests use the active Cinna OAuth bearer token; 401/403 raises `CinnaApiError('reauth_required')`.
- [File Attachments](../../chat/file_attachments/file_attachments.md) — Reuses the `AttachmentList` badge UI but with a separate download path; `TaskAttachment` ≠ `FileUpload`.
- [App Shell](../../ui/app_shell/app_shell.md) — Routed as `activeView === 'cinna-task-run'`; switching sidebar tabs clears `activeCinnaRunId`.
- cinna-core reference (read-only, for parser maintainers): `workflow-runner-core/docs/application/input_tasks/input_tasks_tech.md` — authoritative `TaskCommentPublic` / `TaskAttachmentPublic` shapes and `comment_type` enumeration.
