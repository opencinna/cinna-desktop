# File Attachments — Technical Details

## File Locations

### Shared (cross-process types)

- `src/shared/attachments.ts` — `MessageAttachment` (id, filename, size, mimeType, `source?: 'cinna' | 'local'`), `PendingAttachment` (id = absolute path, `source: 'pending'`), `ComposerAttachment` union, `isPendingAttachment` narrow
- `src/shared/ipcPayloads.ts` — `RunSendPayload.attachments?: MessageAttachment[]`
- `src/shared/filePreview.ts` — `FilesPasteFromClipboardResult`, and the image-read contract the thumbnails share with [File Preview](../file_preview/file_preview_tech.md) (`FilesReadImageInput`, `FilesReadImageResult`, `MAX_IMAGE_PREVIEW_BYTES`, `THUMBNAIL_MAX_SIDE`, `THUMBNAIL_ORIGINAL_MAX_BYTES`)

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
- `src/main/services/pastedFiles.ts` — what a paste attaches, without Electron:
  - `ClipboardFileSources` — the raw formats the desktop read (`fileUrl`, `filenamesPlist`, `uriList`, `fileNameW`)
  - `clipboardFilePaths(sources)` — the plist's paths, else `public.file-url`'s one, else the `text/uri-list`, else the `FileNameW` path; deduplicated. `parseFilenamesPlist`, `parseUriList`, `fileUrlToPath` (non-`file:` and malformed URLs → `null`)
  - `resolvePastedFiles({ sources, readImagePng, dir, now })` — references first (regular files kept, none left → `FileError('not_a_file', NOT_A_FILE_ERROR)`); only with no references is `readImagePng` called, and its bytes go through `writePastedImage`; neither → `[]`
  - `writePastedImage(dir, png, now)` — `mkdir` `0700`, `writeFile` with `flag: 'wx'`, mode `0600`, retrying `pastedImageName(now, attempt)` on `EEXIST` (up to 1000); other failures → `FileError('write_failed')`
  - `PASTED_DIR` (`tmp/pasted`), `pastedRoot(userData)`, `clearPastedFiles(userData)`
- `src/main/services/fileService.ts` — `readThumbnail(input)` for the inline thumbnails, and `pathPreview` for composer files read by path; both documented with [File Preview — Technical Details](../file_preview/file_preview_tech.md)
- `src/main/services/pathGuard.ts` — TTL-based allowlist (default 1h). `record(path) / recordMany(paths) / isAllowed(path) / filterAllowed(paths)`; lazy expiry on lookup; warn-logs rejected counts + extensions (never full paths)
- `src/main/services/cinnaFileService.ts` — Cinna backend I/O (unchanged from the v1 feature). `uploadFromPath / uploadMany / downloadToPath / downloadTaskAttachmentToPath / deleteFile`
- `src/main/services/messageRoutingService.ts` — `prepareAgentSend({ ..., attachments })` and `prepareLlmSend({ ..., attachments })` both persist attachments on the user row
- `src/main/services/acpAttachments.ts` — buildAcpPrompt maps owned files using negotiated ACP image/embeddedContext capabilities, with extracted text or explicit unavailable markers.
- `src/main/services/a2aStreamingService.ts` — `streamToAgent({ ..., fileIds })` injects `metadata: { cinna_file_ids: fileIds }` into `buildSendParams`
- `src/main/services/providerService.ts` — `getModelCapability(providerId, modelId)` wraps `getAdapter(...).modelCapability(...)`; returns `NO_FILE_SUPPORT` if the provider isn't registered

### Main process — LLM adapters

- `src/main/llm/types.ts` — `MediaPart` discriminated union (`image | document | text`); `ModelCapability` (`acceptedMimeTypes`, `nativeMimeTypes`, `maxFileSizeBytes`, `maxFilesPerMessage`); `NO_FILE_SUPPORT` constant; `renderTextPartsPrefix(media)` shared `<file>` block renderer
- `src/main/llm/capabilityMimes.ts` — `TEXT_EXTRACTABLE_MIMES` — universal list reused by all three adapters
- `src/main/llm/anthropic.ts` — Claude 3+: images (PNG/JPEG/GIF/WebP) + PDF native; legacy Claude 2 / Instant: text-only. `buildMediaBlocks` emits `image` and `document` content blocks
- `src/main/llm/openai.ts` — Vision models (`gpt-4*`, `o*`, `chatgpt-4*`): images native via `image_url` data URLs; PDF + office text-extracted. Non-vision: text-only
- `src/main/llm/gemini.ts` — Gemini 1.5+ / 2.x: images + PDF native via `inlineData`. Legacy Gemini Pro: text-only. `buildInlineDataParts` handles both image and document variants

### Main process — desktop host

- `src/main/host/desktop/clipboard.ts` — `readClipboardFileSources(platform?, cb?)` (macOS `public.file-url` + `NSFilenamesPboardType`, Windows `FileNameW` via `readBuffer`, else `text/uri-list`; a throwing read counts as absent), `readClipboardImagePng(cb?)` (`readImage().toPNG()`, `null` when empty or on a throw), `clipboardHasFileRefs()`, `clearPastedFilesAtStart()` (from `startup()` in `src/main/index.ts`, not awaited, logged on failure)
- `src/main/host/desktop/imageThumbnails.ts` — `nativeImageThumbnail(bytes, maxSide)`, the desktop host's `images.thumbnail` (see [File Preview — Technical Details](../file_preview/file_preview_tech.md))

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
  - `files:clipboard-has-file-refs` (`ipcMain.on`, answered through `event.returnValue`) — `clipboardHasFileRefs()`; a throw answers `false`. No activation check and no paths: it returns one boolean, and it must answer inside the renderer's paste event
  - `files:paste-from-clipboard` — `requireActivated()`, `resolvePastedFiles` over the desktop's clipboard reads and `pastedRoot(userData)`, then `pathGuard.recordMany(paths)`; failures as data via `ipcErrorShape`
  - `files:read-thumbnail`, `files:read-image`, `files:read-preview-path` — the composer's and the transcript's image and path reads; see [File Preview — Technical Details](../file_preview/file_preview_tech.md#ipc-channels)
- src/main/services/runExecutionService.ts forwards attachments into the model admission path; src/main/ipc/llm.ipc.ts retains model capability lookup.
- runExecutionService prepares agent attachments, resolves file IDs and invokes the driver through streamToAgent; capability checks decide the permitted scope.

### Preload

- `src/preload/index.ts`:
  - `MessageData.attachments?: MessageAttachment[] | null`
  - `window.api.files.pickAndUpload({ scope?, chatId? })`
  - `window.api.files.pickPaths()` — returns `PendingAttachment[]` (deferred)
  - `window.api.files.resolvePaths({ paths })` — returns `PendingAttachment[]` (deferred)
  - `window.api.files.ingestPaths({ scope?, chatId?, paths })`
  - `window.api.files.remove(string | { id, source })`
  - `window.api.files.download({ fileId, filename, source? })`
  - `window.api.files.clipboardHasFileRefs()` — `ipcRenderer.sendSync('files:clipboard-has-file-refs') === true`
  - `window.api.files.pasteFromClipboard()` — `files:paste-from-clipboard`
  - `window.api.files.readThumbnail(input)`, `readImage(input)`, `readPreviewPath({ path })` — see [File Preview](../file_preview/file_preview_tech.md)
  - `window.api.files.getPathForFile(file)` — wraps `webUtils.getPathForFile`; fire-and-forget `ipcRenderer.send('files:track-path', path)` as a side-effect so the path-guard allowlist auto-populates
  - `window.api.llm.getModelCapability({ providerId, modelId })`
  - `window.api.run.start({ ..., attachments })`; the lower-level `run.send` accepts the same payload

### Renderer

- `src/renderer/src/stores/composerDraft.store.ts`, `src/renderer/src/hooks/useComposerDraft.ts` — per-profile/surface session buffer, upload/error/token state and send preparation lock. Lifecycle and dispatch outcomes are specified in [Draft ownership](../conversation_ui/conversation_ui_tech.md#draft-ownership).

- `src/renderer/src/stores/fileDownload.store.ts` — `useFileDownloadStore`: `downloadingIds: Set<string>`, `error`, `errorFileId`, `download(attachment)`. Passes `attachment.source ?? 'cinna'` to the download IPC
- `src/renderer/src/hooks/useChatAttachments.ts` — session draft buffer keyed by profile and composer. Returns `ComposerAttachment[]`. Deferred mode (`chatId === null`) routes to `files:pick-paths` / `files:resolve-paths` instead of immediate ingest. `remove(attachment)` skips the IPC for `source === 'pending'`. Draft-owned upload token prevents cleared results from returning; navigation keeps the token so completion updates the originating draft. `upload(paths?)` loops: paths that arrive while the draft is `uploading` are appended to the module-level `queuedPaths` map (per draft key) and uploaded in one batch after `uploadOnce` ends; a picker open (`paths` undefined) during an upload is ignored. `clear()` deletes the draft's queue.
- `src/renderer/src/hooks/useModelCapability.ts` — React Query hook over `llm:get-model-capability`. 5-min stale time. Returns `NO_FILE_SUPPORT` shape while loading or when ids are absent
- `src/renderer/src/hooks/useChatComposer.ts` — `submit(input, attachments?: MessageAttachment[])` forwards attachments to `startRun` on the one send channel; the upload **scope** comes from `routingOf(chat).attachmentTarget` (see [Chat Routing](../chat_routing/chat_routing_tech.md)) — `cinna` when an agent answers, `local` when the local model does
- `src/renderer/src/hooks/useChatStream.ts` — `StartLlmOptions.attachments?: MessageAttachment[]`, `StartAgentOptions.attachments?: MessageAttachment[]`; types unified on shared `MessageAttachment`
- `src/renderer/src/hooks/useNewChatFlow.ts` — `NewChatOptions.attachments?: ComposerAttachment[]`. `resolvePendingAttachments(chatId, scope, attachments)` ingests pending entries via `files:ingest-paths`, preserves order, throws on failure, and calls `carryIngestedImages(pending, result.files)` so the sent message starts from the composer's thumbnails. Outer try/catch surfaces error via `useChatStore.setSendError` and deletes the orphan chat via `window.api.chat.delete`
- `src/renderer/src/components/chat/AttachmentBadge.tsx` — `AttachmentBadgeData` is the visual subset (no `source`). `AttachmentList<T extends AttachmentBadgeData>` is generic so callers retain their concrete type through `onClick`.
  - `thumbnailFor(a)` → `ImageRef | null`: when given, an attachment whose `previewKindFor` is `image` renders as an `AttachmentThumbnail`; thumbnails are ordered first, and the row is `items-end`
  - `canClick(a)`: which badges take `onClick` (all when omitted); the composer passes `composerCanPreview`
  - A badge with both `onClick` and `onRemove` (a previewable composer file) is a chip holding two sibling buttons, name and `[x]`, never one nested in the other. Both variants fill with `--color-bg-secondary`; the `--color-bg-elevated` they used before is not defined in `main.css`, so the badges had no fill
  - `formatSize` is exported for the thumbnail's tooltip
- `src/renderer/src/components/chat/AttachmentThumbnail.tsx` — `AttachmentThumbnail({ attachment, imageRef, onClick?, onRemove? })`, `THUMBNAIL_SIZE` (64). `useImage(imageRef, 'thumbnail')`; `data-state` `loading` / `ready` / `failed`; an `<img>` `onError` marks that data URL broken. With `onClick` it is a `Preview <name>` button, else `role="img"`; `onRemove` adds an absolutely positioned `Remove <name>` button beside it
- `src/renderer/src/utils/imageDataCache.ts` — `ImageRef` (`attachment` by `fileId` + `source`, or `path`), `attachmentImageRef(a)` (`pending` → path), `imageRefKey(ref)` (prefixed with the active profile's id from `useAuthStore`), `loadImage(ref, size)` / `peekImage` / `useImage` over two LRUs (`thumbnail` 300, `full` 20) with in-flight de-duplication, `MAX_THUMBNAIL_READS` (4) as a semaphore on thumbnail reads only whose waiters are released last-in first-out, failures returned but not kept; `carryImage(from, to)` and `carryIngestedImages(pending, ingested)` (by position when the lengths match, else a unique filename + size match)
- `src/renderer/src/utils/composerPaste.ts` — `pasteIntent(types, hasFileRefs)` and the error strings `PASTE_NOT_ACCEPTED`, `PASTE_NEEDS_DESTINATION`, `PASTE_WHILE_STREAMING`, `PASTE_NOTHING_USABLE`
- `src/renderer/src/hooks/useAttachmentOpen.ts` — `useComposerAttachmentOpen()` (pending → `openPathPreview`, ingested → `openPreview(…, { composer: true })`; never downloads) and `composerCanPreview(a)`
- `src/renderer/src/components/chat/ComposerPlusMenu.tsx` — The left-side `[+]` composer menu; its **Attach files** row (`canAttachFiles` / `onAttachFiles`) is what the old right-anchored `AttachMenuPopup` became. See [Composer Menu](../composer_menu/composer_menu.md)
- `src/renderer/src/components/chat/ChatInput.tsx` — Owns the attach button gating + scope decision:
  - `modelCapability = useModelCapability(chatData?.providerId, chatData?.modelId)`
  - `attachScope` = `'cinna'` on new-chat or active remote-agent target; `'local'` on active LLM target
  - `canShowAttachButton` (active): `(isCinnaUser && targetIsRemote) || (chatId && !attachmentTargetAgent && modelSupportsMedia)`
  - `canShowAttachButton` (new-chat): `hasAnyDestination = isCinnaUser || providers.some(isCredentialActive)` (`useHasAttachDestination`) — the shared predicate rather than `hasApiKey`, so a keyless credential (Ollama) counts as a destination and a managed OAuth row that cannot call does not. `isCredentialActive` is the named form of `enabled && isCredentialUsable`, which this call site used to spell out
  - Drop handlers: `dragenter / dragover / dragleave / drop` with depth counter, `dataTransfer.types.includes('Files')` filter, `pointer-events-none` overlay
  - `handlePaste` on the textarea: returns (native paste) without `Files`; when `!canShowAttachButton || isStreaming`, lets text through or `preventDefault` + one of the `PASTE_*` errors; otherwise `pasteIntent`, then `preventDefault`, `pasteFromClipboard()` → `pickAttachmentsFromPaths(paths)` (the drop's path), `PASTE_NOTHING_USABLE` for an empty result, main's `error` for a refusal, and `focusComposer` at the end
  - The composer's `AttachmentList` gets `onClick={useComposerAttachmentOpen()}`, `canClick={composerCanPreview}`, `previewsOnClick` and `thumbnailFor={attachmentImageRef}`
  - `attachError` renders in the toolbar row between the left cluster and Send: a `flex-1 min-w-0 truncate` slot, `role="alert"` and `title` while it holds text, empty otherwise
  - Active-chat narrow: `attachmentsToSend.filter((a): a is MessageAttachment => a.source !== 'pending')` before `composer.submit` (pending impossible by gating but the narrow keeps types honest)
- `src/renderer/src/components/chat/MessageBubble.tsx` — Renders `AttachmentList` with `onClick={(a) => openAttachment(a)}` (`useAttachmentOpen`: preview or download), `previewsOnClick` and `thumbnailFor={attachmentImageRef}`; surfaces `useFileDownload.error` only when `errorFileId` matches a badge
- `src/renderer/src/components/chat/MessageStream.tsx` — Passes `msg.attachments` to `MessageBubble` for user rows only
- `src/renderer/src/components/layout/ChatWorkspace.tsx` — `handleNewChat(message, attachments?: ComposerAttachment[])` forwards to `startNewChat`

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
| `files:clipboard-has-file-refs` | renderer → main (`sendSync`) | (none) | `boolean` as `event.returnValue` |
| `files:paste-from-clipboard` | renderer → main | (none) | `{ success: true, paths: string[] }` (empty when the clipboard holds neither files nor an image) / `{ success: false, error, code? }` (`not_a_file`, `write_failed`, …) |
| `files:read-thumbnail` | renderer → main | `{ fileId, source? }` or `{ path }` | `{ success: true, dataUrl, mimeType }` / `{ success: false, error, code? }`. Gates and caps in [File Preview](../file_preview/file_preview_tech.md#ipc-channels) |
| `llm:get-model-capability` | renderer → main | `{ providerId, modelId }` | `ModelCapability` |
| run:start | renderer → main invoke | RunSendPayload including attachments | `RunStartResult`; output via independent run:watch. Attachments are refused while the chat has a turn running — see [Pending Messages](../pending_messages/pending_messages.md) |
| run:send | renderer → main MessagePort | Same RunSendPayload | lower-level event port |

## Services & Key Methods

- `src/renderer/src/hooks/useNewChatFlow.ts:resolvePendingAttachments()` — deferred ingest must return one file for every pending path. A shorter successful result throws the unavailable-files error rather than dispatching with omissions. `startNewChat` returns false after failure and best-effort orphan cleanup, true after run dispatch; the caller consumes the source draft only on true.
- `src/renderer/src/hooks/useChatComposer.ts:submit()` — returns whether an active-chat dispatch occurred; attachment-only content is valid, missing chat cache is false. `ChatInput` retains selected files when no dispatch occurred.

- `src/main/services/fileService.ts:ingest()` — ownership-checked dispatch + uniform `MessageAttachment[]` return; logs per-scope ingest counts
- `src/main/services/fileService.ts:resolvePaths()` — `stat()` + `guessLocalMime`; returns `PendingAttachment[]`; logs `{ in, out }` per call
- `src/main/services/fileService.ts:downloadToPath()` — disk-to-disk for local, HTTP-streamed for Cinna
- `src/main/services/fileStore.ts:attachmentToMediaPart()` — capability-aware MIME router; returns `null` to drop with a warn log on failure; never throws
- `src/main/services/fileStore.ts` — `LocalFileStore.ingest`: `mkdir -p` + `writeFile` + `chatFileRepo.insert`
- `src/main/services/textExtractor.ts:extractText()` — branch on `isUtf8DecodableMime / isOfficeExtractableMime`; soft cap via `capText` with truncation marker
- `src/main/services/pathGuard.ts:filterAllowed()` — partitions into `allowed` / `rejected`; warns on rejected count + ext sample only
- `src/main/services/pastedFiles.ts:resolvePastedFiles()` — references before image; regular files only; image written under `tmp/pasted`
- `src/main/services/providerService.ts:getModelCapability()` — pure pass-through to the adapter
- `src/main/services/acpAttachments.ts` — buildAcpPrompt maps owned files using negotiated ACP image/embeddedContext capabilities, with extracted text or explicit unavailable markers.

## Renderer State

- `useFileDownloadStore` (Zustand) — concurrent download spinners + bubble-scoped error
- `useChatAttachments(chatId, scope, draftKey?)` — session draft buffer; deferred mode when `chatId === null`. A synchronous per-draft upload guard prevents concurrent ingestion; paths arriving meanwhile wait in `queuedPaths` (module state, per draft key) and a second picker open is dropped. Completion targets the captured key/token after navigation; clearing replaces file state and invalidates that token. Removal is source-scoped and pending paths need no backend delete
- `useModelCapability(providerId, modelId)` (React Query) — drives `[+]` gating and picker filters
- `imageDataCache` module state — thumbnail and full-image LRUs, in-flight reads, the thumbnail read semaphore; renderer-session only

## Configuration

- Local store path: `app.getPath('userData') + /files/<userId>/<chatId>/`
- Text extraction soft cap: 256 KB (`MAX_EXTRACTED_CHARS` in `textExtractor.ts`)
- Path-guard TTL: 1 hour (`PATH_TTL_MS` in `pathGuard.ts`)
- Pasted images: `<userData>/tmp/pasted/` (`PASTED_DIR`), emptied at every start
- Thumbnails: `THUMBNAIL_SIZE` 64 px box (`AttachmentThumbnail.tsx`); `THUMBNAIL_MAX_SIDE` 160 px and `THUMBNAIL_ORIGINAL_MAX_BYTES` 256 KB (`src/shared/filePreview.ts`); `MAX_THUMBNAIL_READS` 4 and LRU sizes 300 / 20 (`imageDataCache.ts`); main's cache 200 (`THUMBNAIL_CACHE_ENTRIES`, `fileService.ts`)
- Per-adapter caps (in each adapter file):
  - Anthropic: 32 MB / 20 files
  - OpenAI: 20 MB / 10 files
  - Gemini: 20 MB / 16 files
- Cinna backend (server-side): `UPLOAD_MAX_FILE_SIZE_MB` (100MB default), `UPLOAD_MAX_USER_STORAGE_GB` (10GB), `UPLOAD_ALLOWED_MIME_TYPES`

## Security

- Cinna access tokens decrypt only in main via `getCinnaAccessToken(userId)`; never reach the renderer
- File bytes never traverse the renderer for ingest — paths come from a native dialog, `webUtils.getPathForFile` or main's own clipboard read, and main reads from disk and either uploads (Cinna) or copies into the local store. The only bytes the renderer receives are images as `data:` URLs (thumbnails and the preview) and preview text, both capped in main
- A paste's paths never come from the renderer: `files:paste-from-clipboard` reads the clipboard in main and records what it returns in the path guard. `files:clipboard-has-file-refs` answers a boolean only
- Pasted images live in a `0700` folder as `0600` files, written with `wx` so a name collision never overwrites, and are removed at every start
- Renderer-supplied paths must clear three gates before any I/O: `isAbsolute(p)` (no relative paths), `pathGuard.isAllowed(p)` (must have been surfaced via dialog or drop), `assertFileScope(scope)` (typed union narrow)
- Local-scope ingest verifies `visibleChat(userId, chatId)` (`src/main/auth/chatScope.ts`) and stores under the chat's owner, so a compromised renderer can't pollute another user's chat directory; reads and removes resolve rows through `visibleChatFile`
- `basename(filename)` strips any `..` from save-dialog default paths
- `shell.showItemInFolder` (not `shell.openPath`) — reveals, never executes
- `chat_files.ON DELETE CASCADE` purges file metadata when a chat is deleted; orphan on-disk blobs are removed by `LocalFileStore.remove` (called from `fileService.remove`)

## Tests

- `src/main/services/pastedFiles.test.ts` — URL and plist parsing, plist before `public.file-url`, the dated name and its counter, references before the image, mixed copies, a copied folder refused, no overwrite, the clear at start
- `src/main/host/desktop/clipboard.test.ts` — per-platform formats read, throwing reads as absent, the PNG read
- `src/renderer/src/utils/composerPaste.test.ts` — `pasteIntent`'s three cases
- `src/renderer/src/components/chat/ChatInput.paste.test.tsx` — image-only and Finder pastes attach, plain text and an Excel copy paste natively, the new-chat destination error, text let through when files cannot be taken, two back-to-back pastes, main's folder refusal
- `src/renderer/src/hooks/useChatAttachments.queue.test.tsx` — the queue uploads after the running upload in one batch and is dropped with the draft
- `src/renderer/src/components/chat/AttachmentBadge.test.tsx` — thumbnails (fixed box in every state, first in the row, the thumbnail read not the full one, the failed box, cache reuse, a composer path with a sibling remove button, carry-over after ingest, none for task attachments) and composer badges (preview and remove as sibling buttons, a non-previewable one not clickable)
- `src/renderer/src/utils/imageDataCache.test.ts` — at most four thumbnail reads at once, one shared read per image

## Observability

- `logger('cinna-files')` — Cinna upload/download/delete + `durationMs` on every line
- `logger('file-store')` — local ingest size/mime, attachment-drop reasons (mime not accepted, oversize, read failed)
- `logger('file-service')` — scope-aware ingest counts, `resolvePaths` in/out
- `logger('text-extractor')` — UTF-8 decode failures, office extraction `durationMs / bytesIn / charsOut / truncated`, parser errors
- `logger('path-guard')` — rejected-path count + extension sample only (never logs full paths)
- `logger('pasted-files')` — `pasted file references { refs, files }`, `pasted image saved { bytes }`; `logger('clipboard')` — a failed clear at start, by error name. Never a path
- `logger('LLM')` — `media resolution { resolved, dropped }` per turn
- All errors include the operation context; no tokens, no full request bodies, no full attacker-supplied paths

`src/main/services/conductorTranscript.ts` calls the same attachment converter for saved history on a fresh runtime session. `useNewChatFlow` reads the normalized root and agent capability before pending-file ingestion; `ChatInput` applies the same Local capability override to active chats. The converter uses profile ownership and a 20 MiB file limit.
