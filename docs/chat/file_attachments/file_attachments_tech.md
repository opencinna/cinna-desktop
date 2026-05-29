# File Attachments — Technical Details

## File Locations

### Shared (cross-process types)
- `src/shared/attachments.ts` — `MessageAttachment` (id, filename, size, mimeType, `source?: 'cinna' | 'local'`), `PendingAttachment` (id = absolute path, `source: 'pending'`), `ComposerAttachment` union, `isPendingAttachment` narrow
- `src/shared/ipcPayloads.ts` — `AgentSendPayload.attachments?: MessageAttachment[]`, `LlmSendPayload.attachments?: MessageAttachment[]`

### Main process — DB
- `src/main/db/schema.ts` — `messages.attachments` JSON column (`MessageAttachment[] | null`); `chatFiles` table (local-store metadata)
- `src/main/db/migrations/messages.ts` — adds `attachments` column (idempotent via `hasColumn`)
- `src/main/db/migrations/chat-files.ts` — creates `chat_files` table + index, registered in `client.ts:runMigrations()`
- `src/main/db/chatFiles.ts` — `chatFileRepo` with `insert / getOwned / delete` (userId-scoped)
- `src/main/db/messages.ts` — `messageRepo.saveUser({ attachments })` writes the JSON array; treats empty arrays as `null`

### Main process — services
- `src/main/services/fileService.ts` — single chokepoint:
  - `resolvePaths(paths)` — `stat()` + MIME guess; returns `PendingAttachment[]`. No upload, no chat-id needed
  - `ingest({ userId, scope, chatId, filePaths })` — verifies chat ownership for local scope; dispatches to `localFileStore.ingest` or `cinnaFileService.uploadMany`; stamps `source` on Cinna results
  - `remove({ userId, attachmentId, source })` — dispatches on source; idempotent
  - `downloadToPath({ userId, attachmentId, source, destPath })` — local = `pipeline(createReadStream, createWriteStream)`; cinna = `cinnaFileService.downloadToPath`
  - `assertFileScope(value)` — type-narrows renderer-supplied `'cinna' | 'local'` strings; throws `FileError('invalid_scope')`
- `src/main/services/fileStore.ts` — `FileStore` interface; `LocalFileStore` (`ingest / read / remove` over `userData/files/<userId>/<chatId>/<uuid><ext>` + `chatFileRepo`); `attachmentToMediaPart(att, { userId, capability })` — MIME-routed branching that returns `MediaPart | null` for the stream loop; `guessLocalMime(filename)` reused by `fileService.resolvePaths`
- `src/main/services/textExtractor.ts` — `extractText(bytes, mime, filename)` — UTF-8 decode for `text/*` + structured data + code formats; `parseOffice(bytes).toText()` for binary office and PDF; soft 256KB cap with inline truncation marker; logs `durationMs / bytesIn / charsOut` on office success
- `src/main/services/pathGuard.ts` — TTL-based allowlist (default 1h). `record(path) / recordMany(paths) / isAllowed(path) / filterAllowed(paths)`; lazy expiry on lookup; warn-logs rejected counts + extensions (never full paths)
- `src/main/services/cinnaFileService.ts` — Cinna backend I/O (unchanged from the v1 feature). `uploadFromPath / uploadMany / downloadToPath / downloadTaskAttachmentToPath / deleteFile`
- `src/main/services/messageRoutingService.ts` — `prepareAgentSend({ ..., attachments })` and `prepareLlmSend({ ..., attachments })` both persist attachments on the user row
- `src/main/services/chatStreamingService.ts` — `_runStreamLoop` reads `adapter.modelCapability(modelId)` then maps each persisted attachment to a `MediaPart` via `attachmentToMediaPart`; logs `media resolution { resolved, dropped }`
- `src/main/services/a2aStreamingService.ts` — `streamToAgent({ ..., fileIds })` injects `metadata: { cinna_file_ids: fileIds }` into `buildSendParams`
- `src/main/services/providerService.ts` — `getModelCapability(providerId, modelId)` wraps `getAdapter(...).modelCapability(...)`; returns `NO_FILE_SUPPORT` if the provider isn't registered

### Main process — LLM adapters
- `src/main/llm/types.ts` — `MediaPart` discriminated union (`image | document | text`); `ModelCapability` (`acceptedMimeTypes`, `nativeMimeTypes`, `maxFileSizeBytes`, `maxFilesPerMessage`); `NO_FILE_SUPPORT` constant; `renderTextPartsPrefix(media)` shared `<file>` block renderer
- `src/main/llm/capabilityMimes.ts` — `TEXT_EXTRACTABLE_MIMES` — universal list reused by all three adapters
- `src/main/llm/anthropic.ts` — Claude 3+: images (PNG/JPEG/GIF/WebP) + PDF native; legacy Claude 2 / Instant: text-only. `buildMediaBlocks` emits `image` and `document` content blocks
- `src/main/llm/openai.ts` — Vision models (`gpt-4*`, `o*`, `chatgpt-4*`): images native via `image_url` data URLs; PDF + office text-extracted. Non-vision: text-only
- `src/main/llm/gemini.ts` — Gemini 1.5+ / 2.x: images + PDF native via `inlineData`. Legacy Gemini Pro: text-only. `buildInlineDataParts` handles both image and document variants

### Main process — IPC
- `src/main/ipc/files.ipc.ts` — thin controllers, all delegating to `fileService`:
  - `files:track-path` (`ipcMain.on`) — preload-side path tracking, records into `pathGuard`
  - `files:pick-and-upload` — opens dialog, records paths, delegates to `fileService.ingest`
  - `files:pick-paths` — opens dialog, records paths, delegates to `fileService.resolvePaths` (new-chat deferred picker)
  - `files:resolve-paths` — filters paths via `pathGuard.filterAllowed`, delegates to `fileService.resolvePaths` (drag-drop deferred path)
  - `files:ingest-paths` — filters via `pathGuard.filterAllowed`, delegates to `fileService.ingest`
  - `files:remove` — accepts string (legacy Cinna-only) or `{ id, source }` (modern); delegates to `fileService.remove`
  - `files:download` — `basename(filename)` strips traversal; delegates to `fileService.downloadToPath`; `shell.showItemInFolder` after save
  - `files:download-task-attachment` — task-scoped Cinna download (unchanged)
- `src/main/ipc/llm.ipc.ts` — `llm:send-message` forwards `attachments` to `prepareLlmSend`; `llm:get-model-capability` delegates to `providerService.getModelCapability`
- `src/main/ipc/agent_a2a.ipc.ts` — `agent:send-message` derives `fileIds = attachments?.map(a => a.id)` and threads through `prepareAgentSend` + `streamToAgent`

### Preload
- `src/preload/index.ts`:
  - `MessageData.attachments?: MessageAttachment[] | null`
  - `window.api.files.pickAndUpload({ scope?, chatId? })`
  - `window.api.files.pickPaths()` — returns `PendingAttachment[]` (deferred)
  - `window.api.files.resolvePaths({ paths })` — returns `PendingAttachment[]` (deferred)
  - `window.api.files.ingestPaths({ scope?, chatId?, paths })`
  - `window.api.files.remove(string | { id, source })`
  - `window.api.files.download({ fileId, filename, source? })`
  - `window.api.files.getPathForFile(file)` — wraps `webUtils.getPathForFile`; fire-and-forget `ipcRenderer.send('files:track-path', path)` as a side-effect so the path-guard allowlist auto-populates
  - `window.api.llm.getModelCapability({ providerId, modelId })`
  - `window.api.llm.sendMessage(..., extras?: { attachments? })`

### Renderer
- `src/renderer/src/stores/fileDownload.store.ts` — `useFileDownloadStore`: `downloadingIds: Set<string>`, `error`, `errorFileId`, `download(attachment)`. Passes `attachment.source ?? 'cinna'` to the download IPC
- `src/renderer/src/hooks/useChatAttachments.ts` — composer buffer keyed by chatId. Returns `ComposerAttachment[]`. Deferred mode (`chatId === null`) routes to `files:pick-paths` / `files:resolve-paths` instead of immediate ingest. `remove(attachment)` skips the IPC for `source === 'pending'`. Generation counter for staleness
- `src/renderer/src/hooks/useModelCapability.ts` — React Query hook over `llm:get-model-capability`. 5-min stale time. Returns `NO_FILE_SUPPORT` shape while loading or when ids are absent
- `src/renderer/src/hooks/useChatComposer.ts` — `submit(input, attachments?: MessageAttachment[])` reads the chat snapshot and forwards attachments to `startAgent` (direct A2A) or `startLlm` (orchestrator)
- `src/renderer/src/hooks/useChatStream.ts` — `StartLlmOptions.attachments?: MessageAttachment[]`, `StartAgentOptions.attachments?: MessageAttachment[]`; types unified on shared `MessageAttachment`
- `src/renderer/src/hooks/useNewChatFlow.ts` — `NewChatOptions.attachments?: ComposerAttachment[]`. `resolvePendingAttachments(chatId, scope, attachments)` ingests pending entries via `files:ingest-paths`, preserves order, throws on failure. Outer try/catch surfaces error via `useChatStore.setSendError` and deletes the orphan chat via `window.api.chat.delete`
- `src/renderer/src/components/chat/AttachmentBadge.tsx` — `AttachmentBadgeData` is the visual subset (no `source`). `AttachmentList<T extends AttachmentBadgeData>` is generic so callers retain their concrete type through `onClick`
- `src/renderer/src/components/chat/AttachMenuPopup.tsx` — Right-anchored action menu over `[+]`; `AttachMenuItem[]` for extensibility
- `src/renderer/src/components/chat/ChatInput.tsx` — Owns the attach button gating + scope decision:
  - `modelCapability = useModelCapability(chatData?.providerId, chatData?.modelId)`
  - `attachScope` = `'cinna'` on new-chat or active remote-agent target; `'local'` on active LLM target
  - `canShowAttachButton` (active): `(isCinnaUser && targetIsRemote) || (chatId && !attachmentTargetAgent && modelSupportsMedia)`
  - `canShowAttachButton` (new-chat): `hasAnyDestination = isCinnaUser || providers.some(p => p.enabled && p.hasApiKey)`
  - Drop handlers: `dragenter / dragover / dragleave / drop` with depth counter, `dataTransfer.types.includes('Files')` filter, `pointer-events-none` overlay
  - Active-chat narrow: `attachmentsToSend.filter((a): a is MessageAttachment => a.source !== 'pending')` before `composer.submit` (pending impossible by gating but the narrow keeps types honest)
- `src/renderer/src/components/chat/MessageBubble.tsx` — Renders `AttachmentList` with `onClick={(a) => void download(a)}`; surfaces `useFileDownload.error` only when `errorFileId` matches a badge
- `src/renderer/src/components/chat/MessageStream.tsx` — Passes `msg.attachments` to `MessageBubble` for user rows only
- `src/renderer/src/components/layout/MainArea.tsx` — `handleNewChat(message, attachments?: ComposerAttachment[])` forwards to `startNewChat`

## Database Schema

| Table | Column | Type | Purpose |
|-------|--------|------|---------|
| `messages` | `attachments` | TEXT (JSON, nullable) | `MessageAttachment[]` on user rows; null elsewhere |
| `chat_files` | `id` | TEXT PK | Local-store row id (renderer-visible as `attachment.id` with `source: 'local'`) |
| `chat_files` | `user_id` | TEXT NOT NULL | Userid scoping; every lookup filters by this |
| `chat_files` | `chat_id` | TEXT NOT NULL FK → `chats.id` ON DELETE CASCADE | Chat row that owns the file |
| `chat_files` | `storage_path` | TEXT NOT NULL | Absolute path under `userData/files/<userId>/<chatId>/<uuid><ext>` |
| `chat_files` | `mime_type` | TEXT NOT NULL | Best-effort MIME from extension at ingest time |
| `chat_files` | `size` | INTEGER NOT NULL | Bytes (from `stat()`) |
| `chat_files` | `filename` | TEXT NOT NULL | Original filename (badge display + download default) |
| `chat_files` | `created_at` | INTEGER NOT NULL | Unix epoch ms |

Index: `idx_chat_files_chat_id ON chat_files(chat_id)`. Migration is additive — no backfill.

## IPC Channels

| Channel | Direction | Payload | Returns |
|---------|-----------|---------|---------|
| `files:track-path` | renderer → main (send) | `path: string` | (none — fire-and-forget) |
| `files:pick-and-upload` | renderer → main | `{ scope?, chatId? }` | `{ success: true, files: MessageAttachment[] }` / `canceled: true` / `{ success: false, error, code? }` |
| `files:pick-paths` | renderer → main | (none) | `{ success: true, files: PendingAttachment[] }` / `canceled: true` / `{ success: false, error, code? }` |
| `files:resolve-paths` | renderer → main | `{ paths: string[] }` | `{ success: true, files: PendingAttachment[] }` / `{ success: false, error, code? }` |
| `files:ingest-paths` | renderer → main | `{ scope?, chatId?, paths }` | `{ success: true, files: MessageAttachment[] }` / `{ success: false, error, code? }` |
| `files:remove` | renderer → main | `string | { id, source }` | `{ success: true }` / `{ success: false, error, code? }` |
| `files:download` | renderer → main | `{ fileId, filename, source? }` | `{ success: true, savedPath }` / `canceled: true` / `{ success: false, error, code? }` |
| `files:download-task-attachment` | renderer → main | `{ taskId, attachmentId, filename }` | (same shape) |
| `llm:get-model-capability` | renderer → main | `{ providerId, modelId }` | `ModelCapability` |
| `llm:send-message` | renderer → main (MessagePort) | `LlmSendPayload` (incl. `attachments?`) | stream events via port |
| `agent:send-message` | renderer → main (MessagePort) | `AgentSendPayload` (incl. `attachments?`) | stream events via port |

## Services & Key Methods

- `src/main/services/fileService.ts:ingest()` — ownership-checked dispatch + uniform `MessageAttachment[]` return; logs per-scope ingest counts
- `src/main/services/fileService.ts:resolvePaths()` — `stat()` + `guessLocalMime`; returns `PendingAttachment[]`; logs `{ in, out }` per call
- `src/main/services/fileService.ts:downloadToPath()` — disk-to-disk for local, HTTP-streamed for Cinna
- `src/main/services/fileStore.ts:attachmentToMediaPart()` — capability-aware MIME router; returns `null` to drop with a warn log on failure; never throws
- `src/main/services/fileStore.ts` — `LocalFileStore.ingest`: `mkdir -p` + `writeFile` + `chatFileRepo.insert`
- `src/main/services/textExtractor.ts:extractText()` — branch on `isUtf8DecodableMime / isOfficeExtractableMime`; soft cap via `capText` with truncation marker
- `src/main/services/pathGuard.ts:filterAllowed()` — partitions into `allowed` / `rejected`; warns on rejected count + ext sample only
- `src/main/services/providerService.ts:getModelCapability()` — pure pass-through to the adapter
- `src/main/services/chatStreamingService.ts:_runStreamLoop()` — capability read once per turn, applied as filter when mapping persisted attachments to `MediaPart[]`

## Renderer State

- `useFileDownloadStore` (Zustand) — concurrent download spinners + bubble-scoped error
- `useChatAttachments(chatId, scope)` (local hook) — composer buffer; deferred mode when `chatId === null`
- `useModelCapability(providerId, modelId)` (React Query) — drives `[+]` gating and picker filters

## Configuration

- Local store path: `app.getPath('userData') + /files/<userId>/<chatId>/`
- Text extraction soft cap: 256 KB (`MAX_EXTRACTED_CHARS` in `textExtractor.ts`)
- Path-guard TTL: 1 hour (`PATH_TTL_MS` in `pathGuard.ts`)
- Per-adapter caps (in each adapter file):
  - Anthropic: 32 MB / 20 files
  - OpenAI: 20 MB / 10 files
  - Gemini: 20 MB / 16 files
- Cinna backend (server-side): `UPLOAD_MAX_FILE_SIZE_MB` (100MB default), `UPLOAD_MAX_USER_STORAGE_GB` (10GB), `UPLOAD_ALLOWED_MIME_TYPES`

## Security

- Cinna access tokens decrypt only in main via `getCinnaAccessToken(userId)`; never reach the renderer
- File bytes never traverse the renderer — paths come from native dialog or `webUtils.getPathForFile`, main reads from disk and either uploads (Cinna) or copies into the local store
- Renderer-supplied paths must clear three gates before any I/O: `isAbsolute(p)` (no relative paths), `pathGuard.isAllowed(p)` (must have been surfaced via dialog or drop), `assertFileScope(scope)` (typed union narrow)
- Local-scope ingest verifies `chatRepo.getOwned(userId, chatId)` so a compromised renderer can't pollute another user's chat directory
- `basename(filename)` strips any `..` from save-dialog default paths
- `shell.showItemInFolder` (not `shell.openPath`) — reveals, never executes
- `chat_files.ON DELETE CASCADE` purges file metadata when a chat is deleted; orphan on-disk blobs are removed by `LocalFileStore.remove` (called from `fileService.remove`)

## Observability

- `logger('cinna-files')` — Cinna upload/download/delete + `durationMs` on every line
- `logger('file-store')` — local ingest size/mime, attachment-drop reasons (mime not accepted, oversize, read failed)
- `logger('file-service')` — scope-aware ingest counts, `resolvePaths` in/out
- `logger('text-extractor')` — UTF-8 decode failures, office extraction `durationMs / bytesIn / charsOut / truncated`, parser errors
- `logger('path-guard')` — rejected-path count + extension sample only (never logs full paths)
- `logger('LLM')` — `media resolution { resolved, dropped }` per turn
- All errors include the operation context; no tokens, no full request bodies, no full attacker-supplied paths
