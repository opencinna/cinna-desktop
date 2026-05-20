# Cinna Task Run View — Technical Details

## File Locations

### Shared
- `src/shared/cinnaTaskView.ts` — `CinnaTaskAttachmentDto`, `CinnaTaskCommentDto`, `CinnaTaskCommentType`, `CinnaTaskViewDto`, `SYSTEM_COMMENT_TYPES`, `isContentComment(c)`. Single source of truth — imported by main service, preload, and renderer.

### Main process
- `src/main/services/cinnaApiService.ts` — `cinnaApiService.getTaskView(userId, taskId)`. Single `GET /api/v1/tasks/{id}/detail` call (`InputTaskDetailPublic` already embeds `comments` + `attachments`). Lenient `parseComment` / `parseAttachment` helpers tolerate snake_case + camelCase variants. Re-exports DTO types from the shared file.
- `src/main/services/cinnaFileService.ts` — `downloadTaskAttachmentToPath(userId, taskId, attachmentId, destPath)`. Streams `GET /api/v1/tasks/{taskId}/attachments/{id}/download` to disk via `pipeline(Readable.fromWeb(response.body), createWriteStream(destPath))`. Mirrors the upload/download streaming pattern used for `FileUpload` rows but on the task-scoped URL.
- `src/main/ipc/cinna.ipc.ts` — `cinna:get-task-view` handler — `userActivation.requireActivated()` then `cinnaApiService.getTaskView(getProfileScopeUserId(), taskId)`.
- `src/main/ipc/files.ipc.ts` — `files:download-task-attachment` handler — `showSaveDialog` (default path = `Downloads/{filename}`) → `cinnaFileService.downloadTaskAttachmentToPath` → `shell.showItemInFolder`. Returns the same `FilesDownloadResult` discriminator as `files:download`.

### Preload
- `src/preload/index.ts`:
  - `window.api.cinna.getTaskView(taskId): Promise<CinnaTaskViewDto>` — wraps `cinna:get-task-view`.
  - `window.api.files.downloadTaskAttachment({ taskId, attachmentId, filename })` — wraps `files:download-task-attachment`. Returns the discriminator: `{ success: true, savedPath } | { success: true, canceled: true } | { success: false, error, code }`.

### Renderer
- `src/renderer/src/hooks/useCinnaTaskView.ts` — `useCinnaTaskView(taskId, { polling? })`. `polling: true` (default) refetches every 5s while task status is non-terminal; `polling: false` disables the loop and uses `staleTime = 60_000` (used by row badges). Both variants share the query key `['cinna', 'task-view', taskId]`. Also exports `useInvalidateCinnaTaskView()`.
- `src/renderer/src/stores/taskAttachmentDownload.store.ts` — Zustand store with `downloadingIds: Set<string>`, `error`, `errorAttachmentId`, `download({ taskId, attachmentId, filename })`, `dismissError()`. Mirrors `fileDownload.store` shape. Logs failures via `createLogger('task-attachment-download')`.
- `src/renderer/src/hooks/useTaskAttachmentDownload.ts` — Façade hook over the store: `{ isDownloading, error, errorAttachmentId, download, dismissError }`.
- `src/renderer/src/utils/cinnaTime.ts` — `parseServerTimestamp(s)`, `formatRelativeFromServer(s, now)`, `formatRelativeFromDate(d, now)`. Naive ISO strings are tagged `Z` before `Date.parse` to correct cinna-core's TZ-less serialization.
- `src/renderer/src/utils/markdownComponents.tsx` — shared component map reused for comment-content markdown rendering.
- `src/renderer/src/stores/ui.store.ts` — `activeCinnaRunId: string | null` + `setActiveCinnaRunId`. `ActiveView` includes `'cinna-task-run'`.
- `src/renderer/src/components/jobs/CinnaTaskRunView.tsx` — The view itself. Reads `activeJobId` + `activeCinnaRunId` from `ui.store`, finds the run via `useJobRuns(activeJobId).data.find(...)`, resolves `cinnaTaskId`, drives `useCinnaTaskView`. Sub-components: `CommentCard` (markdown + author + result pill + inline attachments), `ActivityRow` (inline-markdown one-line row), `TaskAttachmentList` (consumes `useTaskAttachmentDownload`), `StatusPill`, `CountBadge`.
- `src/renderer/src/components/jobs/JobRunRow.tsx` — Now navigates to the view on cinna_task row click (`setActiveCinnaRunId(runId)` + `setActiveView('cinna-task-run')`). Pulls counts from `useCinnaTaskView(cinnaTaskId, { polling: false })` and renders MessageSquare + Paperclip pill badges before the action buttons.
- `src/renderer/src/components/layout/MainArea.tsx` — Routes `activeView === 'cinna-task-run'` to `<CinnaTaskRunView />`.
- `src/renderer/src/components/layout/SidebarTabs.tsx` — Tab-switch handler also calls `setActiveCinnaRunId(null)` so the view doesn't leak across tabs.
- `src/renderer/src/assets/main.css` — `.markdown-inline` class collapses `<p>` / `<ul>` / `<ol>` / `<li>` to `display: inline` for the single-line activity rows.

## DTO Schema

### `CinnaTaskViewDto`
- `task: { id, short_code, status, title }` — `CinnaTaskDetail`
- `comments: CinnaTaskCommentDto[]`
- `attachments: CinnaTaskAttachmentDto[]` — task-level (standalone), not inline

### `CinnaTaskCommentDto`
- `id` — comment uuid
- `commentType: 'message' | 'result' | 'status_change' | 'assignment' | 'system' | string`
- `authorName: string | null` / `authorRole: string | null` — server-resolved via `TaskCommentService._to_public`
- `authorId: string | null` — user_id or agent_id depending on author kind
- `content: string` — markdown body
- `createdAt: string | null` — ISO timestamp (UTC, may be naive — see `parseServerTimestamp`)
- `attachments: CinnaTaskAttachmentDto[]` — inline (server's `inline_attachments` field)

### `CinnaTaskAttachmentDto`
- `id` — attachment uuid (NOT a `FileUpload.id` — they're disjoint stores)
- `filename` — from server's `file_name`
- `size: number | null` — bytes, from `file_size`
- `mimeType: string | null` — from `content_type`
- `url: string | null` — optional pre-resolved URL (typically null; desktop builds the task-scoped path)

### `SYSTEM_COMMENT_TYPES`
`ReadonlySet<CinnaTaskCommentType>` = `{ 'status_change', 'assignment', 'system' }`. `isContentComment(c)` returns the inverse — used by both the detail view (Comments vs. Activity split) and the run-row badge counter.

## IPC Channels

- `cinna:get-task-view(taskId): CinnaTaskViewDto` — Single round-trip to cinna-core for one task's comments + attachments.
- `files:download-task-attachment({ taskId, attachmentId, filename }): FilesDownloadResult` — Save-as for a `TaskAttachment`. Distinct from `files:download` because the URL is task-scoped.

## Services & Key Methods

- `cinnaApiService.getTaskView(userId, taskId)`:
  - One `cinnaFetch` to `/api/v1/tasks/{id}/detail`.
  - `parseComment(raw)` reads `id`, `comment_type`, `author_name`/`author_role`, `content`, `created_at`, `inline_attachments` (fallback: `attachments` / `files`).
  - `parseAttachment(raw)` reads `id`, `file_name` (fallback: `filename`/`name`), `file_size`, `content_type`.
  - Logs `fetching cinna task view` (entry) and `cinna task view loaded` (counts).
- `cinnaFileService.downloadTaskAttachmentToPath(userId, taskId, attachmentId, destPath)`:
  - Bearer-auth `net.fetch` to `/api/v1/tasks/{taskId}/attachments/{attachmentId}/download`.
  - `pipeline(Readable.fromWeb(response.body), createWriteStream(destPath))` — never holds the full file in memory.
  - On stream error: throws `CinnaFileError('download_failed' | 'file_not_writable', ...)` depending on `writeStream.bytesWritten`.
  - Logs `task-attachment download → URL`, error paths (network/HTTP), and `task attachment downloaded` with bytes + duration.

## Renderer Components

- `CinnaTaskRunView`:
  - Three empty-state branches: `!activeCinnaRunId` ("No task selected"), run not found / not cinna ("This run is not available"), no `cinnaTaskId` ("nothing to load"). Each carries a "Back to job" link.
  - Header pulls task title from the fetched data (falls back to `job.title` while loading).
  - `taskView.isFetching` drives the Refresh icon's spin animation.
  - `data.comments` partitioned with `isContentComment` into `contentComments` (cards) + `systemComments` (Activity log).
  - Activity toggle initial state: `useState(true)` (expanded by default).
- `CommentCard`:
  - Author detection: `comment_type === 'result'` OR `authorRole` contains "agent" OR regex on `authorName` for `agent|assistant|bot`.
  - `content` → `<Markdown>` with `remarkGfm` + `rehypeHighlight` + `markdownComponents`. Wrapped in `markdown-body` class for layout.
  - Inline attachments → nested `<TaskAttachmentList>` so per-comment download spinners work the same way.
- `ActivityRow`:
  - Renders `comment.content` (or `commentType` as fallback) via `<Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>` inside a span with `markdown-body markdown-inline` classes.
  - `markdown-inline` (defined in `main.css`) collapses block elements to inline so the flex layout stays single-line.
- `TaskAttachmentList`:
  - Adapts `CinnaTaskAttachmentDto[]` to the `AttachmentList` (chat) data shape; nulls default to `size: 0` / `mimeType: 'application/octet-stream'`.
  - Filters the global error to only show on the list that owns the failed attachment id.
  - Dismiss button calls `dismissError()` on the store.
- `CountBadge`:
  - Reusable pill (`rounded-full`, accent-neutral border, `--color-text-muted` text) for section-header counters.

## Configuration

- Polling interval: `ACTIVE_REFETCH_MS = 5_000` in `useCinnaTaskView.ts`. Applied only when `polling: true` AND the task status is non-terminal.
- Badge stale time: `BADGE_STALE_MS = 60_000` in `useCinnaTaskView.ts`. Applied when `polling: false`.
- Minimum visible refresh-spin (in `JobRunRow`): `MIN_SPIN_MS = 500` — prevents the icon from never appearing to spin when the IPC roundtrip is sub-frame.

## Security

- **Profile scope.** Every cinna IPC handler calls `userActivation.requireActivated()` and resolves the user id via `getProfileScopeUserId()`. cinna-core enforces task-level access via the OAuth bearer (owner OR session participant). The desktop never accepts a `taskId` from the renderer without first proving the user is activated.
- **Bearer token isolation.** `cinnaApiService.cinnaFetch` resolves the bearer in the main process via `getCinnaAccessToken(userId)`. The renderer never sees it. `CinnaReauthRequired` is mapped to `CinnaApiError('reauth_required')`.
- **External URL open.** "Open on Cinna" routes through `app:open-external` which restricts to `http:` / `https:`.
- **Markdown rendering.** react-markdown is HTML-escape-by-default. No `rehype-raw` is wired in, so server-controlled comment/activity content cannot inject raw HTML. `rehypeHighlight` only adds syntax-highlight class names — no DOM injection. If a future change adds `rehype-raw`, add `rehype-sanitize` first.
- **Logger discipline.** `createLogger('cinna-api')` (main) and `createLogger('cinna-task-view')` / `createLogger('task-attachment-download')` / `createLogger('job-run-row')` (renderer). Comment bodies + attachment filenames are NOT logged; only ids, counts, status, and timings. Network errors include URL + status + first 200 chars of the response body for diagnostics.

## Known Limitations / Future Work

- **No write actions.** Posting a comment, uploading an attachment, or changing task status all require the cinna-core web UI today. The "Open on Cinna" button bridges the gap.
- **No pagination.** `/api/v1/tasks/{id}/detail` returns the full lists. Long-running tasks with hundreds of comments are not currently truncated. If this becomes a problem, switch the comments fetch to the dedicated `/comments/` endpoint with `skip`/`limit`.
- **Counts re-fetch on row mount.** Row badges fire one `/detail` call per row on first render (then cached for 60s). For a job with many cinna runs the initial burst could be reduced by hoisting the fetches into the parent and batching.
