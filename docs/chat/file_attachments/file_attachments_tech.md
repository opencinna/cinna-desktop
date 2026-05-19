# File Attachments — Technical Details

## File Locations

### Shared (cross-process types)
- `src/shared/attachments.ts` — `MessageAttachment` (id, filename, size, mimeType) — single source of truth for the per-attachment record persisted on user messages and used by the renderer UI
- `src/shared/ipcPayloads.ts` — `AgentSendPayload.attachments?: MessageAttachment[]` field on the streaming agent-send payload

### Main Process
- `src/main/db/schema.ts` — `messages.attachments` JSON column (typed as `MessageAttachment[] | null`)
- `src/main/db/migrations/messages.ts` — `ALTER TABLE messages ADD COLUMN attachments TEXT` (idempotent via `hasColumn`)
- `src/main/db/messages.ts` — `messageRepo.saveUser({ attachments })` — writes the JSON array on user rows; treats empty arrays as `null`
- `src/main/services/cinnaFileService.ts` — owns all I/O against the user's Cinna backend:
  - `uploadFromPath(userId, filePath)` — single-file multipart POST; reads bytes via `fs/promises.readFile`, wraps in a `Blob`, POSTs to `/api/v1/files/upload`. Logs `durationMs` on success and on either failure branch
  - `uploadMany(userId, filePaths)` — sequential loop; partial failure surfaces uploaded ids on `CinnaFileError.detail` as JSON
  - `downloadToPath(userId, fileId, destPath)` — streams `GET /api/v1/files/{id}/download` to disk via `pipeline(Readable.fromWeb(response.body), createWriteStream(destPath))`; no full-file buffering
  - `deleteFile(userId, fileId)` — `DELETE /api/v1/files/{id}`; 404 treated as success (file already gone)
  - `CinnaFileError extends DomainError<CinnaFileErrorCode>` with codes `not_cinna_user`, `missing_server_url`, `reauth_required`, `upload_failed`, `delete_failed`, `download_failed`, `file_not_writable`, `file_not_readable`
- `src/main/services/messageRoutingService.ts` — `prepareAgentSend({ ..., attachments })` — persists attachments on the user row via `messageRepo.saveUser` and returns the `wireContent` unchanged; attachments don't enter the LLM-root path
- `src/main/services/a2aStreamingService.ts` — `streamToAgent({ ..., fileIds })` — when `fileIds.length > 0`, passes `metadata: { cinna_file_ids: fileIds }` to `buildSendParams`
- `src/main/agents/a2a-client.ts` — `buildSendParams(content, contextId?, taskId?, metadata?)` — fourth arg forwards as the A2A message-level `metadata` map; omitted entirely when no keys
- `src/main/ipc/files.ipc.ts` — registers three handlers:
  - `files:pick-and-upload` — opens `dialog.showOpenDialog` (multi-select), delegates to `cinnaFileService.uploadMany`
  - `files:remove` — soft-deletes a still-temporary file
  - `files:download` — opens `dialog.showSaveDialog` (default = `app.getPath('downloads')/<filename>`), streams via `cinnaFileService.downloadToPath`, then `shell.showItemInFolder(savedPath)` (best-effort; failure ignored)
- `src/main/ipc/agent_a2a.ipc.ts` — `agent:send-message` handler extracts `attachments` from payload, derives `fileIds = attachments?.map(a => a.id)`, threads both through `messageRoutingService.prepareAgentSend` and `a2aStreamingService.streamToAgent`

### Preload
- `src/preload/index.ts` — three additions:
  - `MessageData.attachments?: MessageAttachment[] | null` — surfaced on chat-detail messages so history bubbles render badges
  - `window.api.files.pickAndUpload()` / `.remove(fileId)` / `.download({ fileId, filename })` — all return discriminated `{ success, ... }` unions
  - `window.api.agents.sendMessage(..., extras?: { attachments?: MessageAttachment[] })` — fourth-arg extras now includes attachments alongside the existing catchup/rewrite fields

### Renderer
- `src/renderer/src/stores/fileDownload.store.ts` — `useFileDownloadStore` — global Zustand store. Holds `downloadingIds: Set<string>` for concurrent spinners, `error` + `errorFileId` for bubble-scoped error rendering. `download(attachment)` no-ops if the id is already in flight
- `src/renderer/src/hooks/useChatAttachments.ts` — `useChatAttachments(chatId)` — composer-local buffer (`attachments`, `isUploading`, `error`), wraps `window.api.files.pickAndUpload` / `remove`. Uses a `generationRef` bumped on chatId change and on `clear()` so stale upload resolutions from a previous chat are dropped. Exposes `setError` so consumers (ChatInput's new-chat send-guard) can surface validation errors through the same slot
- `src/renderer/src/hooks/useFileDownload.ts` — Thin façade over the store; exposes `isDownloading(fileId)` predicate, `error`, `errorFileId`, `download`, `dismissError`
- `src/renderer/src/components/chat/AttachmentBadge.tsx` — `AttachmentBadge` (single chip; renders as `<button>` when `onClick` set, `<span>` otherwise; `Loader2` spinner when `isLoading`; remove button uses `stopPropagation` so it never collides with a click-download); `AttachmentList` (flex-wrap container, accepts `isLoading: (id) => boolean` predicate so the list supports concurrent in-flight downloads)
- `src/renderer/src/components/chat/AttachMenuPopup.tsx` — Small right-anchored action menu floating above the `[+]` button. Outside-click + Escape dismissal; `role="menu"` / `role="menuitem"`. Accepts `AttachMenuItem[]` with `{ id, label, icon, onSelect }` so new entries are one-liner additions
- `src/renderer/src/components/chat/ChatInput.tsx` — Owns the `[+]` button rendering (gated by `canShowAttachButton`), the menu popup open state (`attachMenuOpen`), and the send-time guard ("Pick a Cinna agent…"). Two gates derived from agent state:
  - `canShowAttachButton` — visibility: `isCinnaUser && (chatId ? targetIsRemote : true)`. Lenient on new-chat
  - `targetSupportsAttachments` — delivery: drives the auto-clear effect and the `attachmentsToSend` selection in `handleSend`
- `src/renderer/src/components/chat/MessageBubble.tsx` — User bubbles render `AttachmentList` with `onClick={(a) => void download(a)}` and `isLoading={isDownloading}`. Surfaces `useFileDownload.error` only when `errorFileId` matches one of the bubble's attachments — keeps unrelated bubbles clean
- `src/renderer/src/components/chat/MessageStream.tsx` — Passes `msg.attachments` to `MessageBubble` for user-role rows only
- `src/renderer/src/hooks/useChatComposer.ts` — `submit(input, attachments?)`, `dispatchToAgent(..., attachments?)`, `dispatchToRoot(text, attachments?)`; `PendingRewrite.attachments` preserves files across the Smart Rewrite confirm step so they replay on the second Enter
- `src/renderer/src/hooks/useChatStream.ts` — `StartAgentOptions.attachments?` — passed through to `window.api.agents.sendMessage` extras
- `src/renderer/src/hooks/useNewChatFlow.ts` — `NewChatOptions.attachments?` — forwarded to `startAgent` after chat creation; LLM-only new chats silently drop attachments
- `src/renderer/src/components/layout/MainArea.tsx` — `handleNewChat(message, attachments?)` accepts the second arg from `ChatInput` and forwards into `startNewChat`

## Database Schema

| Table | Column | Type | Purpose |
|-------|--------|------|---------|
| `messages` | `attachments` | TEXT (JSON, nullable) | `MessageAttachment[]` for user-role rows; null on every other role |

Migration is additive only — no backfill needed. Existing user messages return `null` and render no badges.

## IPC Channels

| Channel | Direction | Payload | Returns |
|---------|-----------|---------|---------|
| `files:pick-and-upload` | renderer → main | (none) | `{ success: true, files: MessageAttachment[] }` / `{ success: true, canceled: true, files: [] }` / `{ success: false, error, code? }` |
| `files:remove` | renderer → main | `fileId: string` | `{ success: true }` / `{ success: false, error, code? }` |
| `files:download` | renderer → main | `{ fileId, filename }` | `{ success: true, savedPath }` / `{ success: true, canceled: true }` / `{ success: false, error, code? }` |
| `agent:send-message` | renderer → main (MessagePort) | `AgentSendPayload` (now includes `attachments?`) | streaming events via port |

## Services & Key Methods

- `src/main/services/cinnaFileService.ts:uploadFromPath()` — multipart POST with bearer auth; durationMs on every log line
- `src/main/services/cinnaFileService.ts:uploadMany()` — sequential loop; partial-failure ids on `CinnaFileError.detail`
- `src/main/services/cinnaFileService.ts:downloadToPath()` — streams response body to disk via `pipeline(Readable.fromWeb(response.body), createWriteStream(destPath))`; uses `writeStream.bytesWritten` to tag failure as `download_failed` (network) vs. `file_not_writable` (disk)
- `src/main/services/cinnaFileService.ts:deleteFile()` — soft-delete; 404 is success
- `src/main/services/messageRoutingService.ts:prepareAgentSend()` — persists `attachments` on the user row alongside `addressedAgentId`, `rewrittenText`, `originalText`
- `src/main/services/a2aStreamingService.ts:streamToAgent()` — when `fileIds` non-empty, threads `metadata: { cinna_file_ids: fileIds }` into `buildSendParams` for both the streaming and non-streaming branches
- `src/main/agents/a2a-client.ts:buildSendParams()` — adds the metadata map only when at least one key is present (forward-compatible)

## Renderer State

- `useFileDownloadStore` (Zustand) — single download state:
  - `downloadingIds: ReadonlySet<string>` — used by every `MessageBubble` to determine `isLoading` for its badges
  - `error: string | null` — last failure message (decorated with filename)
  - `errorFileId: string | null` — id of the failed attachment; bubbles compare against their own attachment ids before rendering the error label
  - `download(attachment)` — no-ops if the id is already in flight; clears stale errors for the same id on retry
- `useChatAttachments(chatId)` (local hook) — composer buffer; not Zustand because the state is per-composer-instance, not global

## Configuration

No desktop-side config. All file limits and MIME whitelisting live on the Cinna backend:
- `UPLOAD_MAX_FILE_SIZE_MB` — per-file cap (100MB default)
- `UPLOAD_MAX_USER_STORAGE_GB` — per-user quota (10GB default)
- `UPLOAD_ALLOWED_MIME_TYPES` — whitelist; the desktop's extension-based `guessMimeType` only sets the Content-Type — the backend has final say

## Security

- The user's Cinna access token is resolved only inside the main process via `getCinnaAccessToken(userId)`; never crosses to the renderer
- File bytes never traverse the renderer — `dialog.showOpenDialog` returns paths, the main process reads from disk and POSTs upstream
- Backend enforces row-level ownership on every endpoint via the bearer token; the desktop never includes a user id in the URL
- `shell.showItemInFolder` is used to reveal downloads (safe — points at a path the OS already trusts), `shell.openPath` is intentionally NOT used (would execute the file)
- The save dialog forces the user to choose the destination — no silent writes to arbitrary paths

## Observability

- All external calls scoped to logger `'cinna-files'`
- Every upload/delete/download logs `durationMs` on both success and failure
- Successful uploads log `{ fileId, filename, size }`; downloads log `{ fileId, destPath, bytes }`
- Failures include URL, status, response body (truncated to 200-500 chars), and durationMs
- No tokens, no full request bodies in logs
