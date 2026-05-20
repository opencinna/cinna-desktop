# File Attachments

## Purpose

Lets a user attach local files to a chat message — images, PDFs, Office documents, code/text — for both LLM destinations (Anthropic, OpenAI, Gemini) and Cinna remote agents. Files are stored in the right backing store based on destination, shown as badges in the composer and under user bubbles, and downloadable back to disk.

## Core Concepts

- **Attachment** — A file attached to a single user turn. Persists on `messages.attachments` as a condensed DTO (id, filename, size, mimeType, source). Tracked in-app via `MessageAttachment`.
- **Source / Backing Store** — Where the bytes live. `cinna` (Cinna backend), `local` (`userData/files/<userId>/<chatId>/`), or `pending` (composer-only, paths on disk awaiting destination decision).
- **Pending Attachment** — New-chat composer state. Files the user picked or dropped but hasn't ingested yet because the chat row doesn't exist and the destination scope isn't known. Swapped for a real `cinna` / `local` attachment at send time.
- **Composer Attachment** — Union of `MessageAttachment` (already ingested) and `PendingAttachment` (deferred). Only the composer's pending list holds the union; everything downstream is narrowed to `MessageAttachment`.
- **Model Capability** — Per-model declaration of accepted MIME types, size envelope, and which of those are passed through natively (image bytes for all vision models, PDF for Anthropic + Gemini). Everything else routes through the text extractor.
- **Media Part** — Resolver output for the LLM stream loop. Three variants: `image` (raster bytes), `document` (native non-image bytes like PDF), `text` (UTF-8 string from extraction). Adapters translate to provider-native blocks.
- **Text Extractor** — Service that converts office docs (DOCX/XLSX/PPTX/ODT/…), PDFs (when the model has no native PDF support), and code/CSV/JSON files into UTF-8 text the LLM can read. Backed by `officeparser` for binary office formats.
- **Path Guard** — Allowlist of OS paths the renderer is permitted to reference. Populated by file dialogs and the `webUtils.getPathForFile` preload wrapper. Defense-in-depth against a compromised renderer.
- **`cinna_file_ids` Metadata** — A2A message metadata key carrying Cinna file UUIDs. Backend forwards bytes into the agent environment's `./uploads/` before the agent receives the message.

## User Stories / Flows

### Attaching a file in an active LLM chat
1. User is in a chat bound to an LLM provider (no remote agent active).
2. `[+]` button appears if the selected model declares any accepted MIME types.
3. User picks files via the menu or drags them onto the composer.
4. Bytes are copied into the per-user local store (`chat_files` table + `userData/files/...`). Badges appear in the composer.
5. User sends. The stream loop reads the persisted attachments, runs each through the text extractor or passes native bytes, and hands the adapter resolved `MediaPart[]`.
6. Adapter emits provider-native content blocks (image, document) or inlines extracted text as a `<file name="…" type="…">…</file>` prefix on the user message.

### Attaching a file in a chat bound to a Cinna remote agent
1. User is in a chat whose bound or active agent is a Cinna-source remote agent.
2. `[+]` appears for Cinna users.
3. Picked/dropped files stream to the Cinna backend (`POST /api/v1/files/upload`).
4. On send, the A2A request carries `metadata.cinna_file_ids` — bytes are referenced, not retransmitted.

### Attaching on the new-chat screen
1. `[+]` appears when the user has any plausible destination — a Cinna account, or at least one enabled LLM provider with an API key.
2. Picked/dropped files do NOT upload yet — they're held as `pending` attachments whose `id` carries the absolute OS path.
3. Badges render from filename + size alone, immediately.
4. User picks an agent or chat mode and types a message.
5. On send, the new-chat flow creates the chat row, picks scope from destination (remote agent → cinna, LLM → local), and calls the ingest IPC to swap each `pending` for a real attachment. The first user turn carries the resolved attachments.
6. If any ingest fails (disk full, missing file, network error to Cinna): the error surfaces via the chat-store's `setSendError` and the orphaned chat row is deleted.

### Drag-and-drop
1. User drags files from Finder/Explorer onto the chat composer.
2. The composer container shows an accent-colored "Drop to attach" overlay while a file drag is hovering.
3. On drop, paths are resolved via `webUtils.getPathForFile` (each path is auto-tracked into the path-guard allowlist as a side-effect).
4. From there, the flow matches a normal pick — active chats ingest immediately, new-chat holds as pending.
5. Directory drops are rejected with an inline error (paths come back empty from `getPathForFile`).

### Viewing & downloading sent attachments
1. User bubbles render their `attachments[]` as right-aligned badges with file-type icon, truncated filename, and size.
2. Clicking a badge opens the OS save dialog (default = Downloads / original filename, with `basename(filename)` applied to strip any traversal).
3. The file streams from the right store (Cinna backend or local disk) to the chosen path.
4. The OS file manager reveals the saved file.

### Removing a pending attachment
1. `[x]` on a composer badge drops it from the pending list immediately.
2. Backend cleanup (Cinna soft-delete) fires fire-and-forget for `cinna` source; nothing to clean for `local` (still pending) or `pending` (never uploaded).

## Business Rules

### Destination gating
- **Active chat with remote agent active**: `[+]` available for Cinna users. Scope = `cinna`.
- **Active LLM chat** (no agent): `[+]` available when the selected model's capability has at least one accepted MIME type. Scope = `local`.
- **Active chat with local-A2A agent**: `[+]` hidden. No backend can receive the files.
- **New-chat screen**: `[+]` available when the user has a Cinna account OR any enabled LLM provider with an API key. Scope decision deferred to send time.
- Pending attachments auto-clear when the user pivots to a target whose scope differs from the queued scope.

### Capability-driven adapter routing
- Each adapter declares `acceptedMimeTypes`, `nativeMimeTypes`, `maxFileSizeBytes`, `maxFilesPerMessage` per model.
- `acceptedMimeTypes` is the union the model can take after upstream transformation; `nativeMimeTypes` is the subset whose bytes pass through unchanged.
- Resolver branches on MIME: image → `image` part; native non-image → `document` part; everything else extractable → `text` part. Anything else: dropped with a warning log.
- Anthropic Claude 3+: images + PDF native; everything else text-extracted. Legacy Claude 2 / Instant: text-only.
- OpenAI vision models (`gpt-4*`, `o*`, `chatgpt-4*`): images native; PDF + office text-extracted. Non-vision: text-only.
- Gemini 1.5+ / 2.x: images + PDF native; everything else text-extracted. Legacy Gemini Pro: text-only.

### Local store
- Local files live at `userData/files/<userId>/<chatId>/<uuid><ext>`. Metadata in the `chat_files` table.
- `chat_files` has `ON DELETE CASCADE` to `chats` — deleting a chat purges its file rows.
- Chat ownership is verified before any local ingest: `chatRepo.getOwned(userId, chatId)` runs in `fileService.ingest` before disk writes or row inserts.

### Path-guard allowlist
- Renderer-supplied paths (`files:ingest-paths`, `files:resolve-paths`) must be in the allowlist to be accepted.
- Allowlist is populated by: native picker dialog results, the `webUtils.getPathForFile` preload wrapper, and explicit `files:track-path` events.
- Paths expire 1 hour after recording. Rejected paths are filtered silently (and logged with truncated metadata, no full path).
- The `files:pick-and-upload` and `files:pick-paths` handlers automatically record their dialog results.

### Text extraction
- UTF-8 decode for `text/*`, JSON, XML, YAML, CSV, code formats.
- `officeparser` for office binaries (DOCX/XLSX/PPTX/ODT/ODS/ODP/RTF) and PDFs.
- Soft cap at 256 KB of extracted text per attachment. Truncation appends an inline marker the LLM can read.
- Extraction failures (malformed file, parser error) drop the part with a warn log — the turn continues with the user's text alone.

### Wire format
- **LLM**: `MediaPart[]` resolved at send time, never persisted. Image / document parts become provider-native blocks. Text parts become a `<file name="…" type="…">…</file>` prefix shared across all three adapters.
- **A2A**: `message.metadata.cinna_file_ids` carries Cinna file UUIDs. No bytes on the wire.

### Persistence
- The `attachments` JSON column on `messages` stores the condensed `MessageAttachment[]` for user-role rows only.
- Pending attachments never reach persistence — they're swapped for real attachments before the first user message is saved.
- Legacy attachments (pre-feature) read with `source` undefined and route through the Cinna download path.

### Error handling on new-chat send
- Ingest failure after chat creation throws and is caught by the outer try/catch in `useNewChatFlow.startNewChat`.
- Error message surfaces via `useChatStore.setSendError`.
- Orphaned chat row is deleted best-effort.

### Download
- One save-as flow per badge click. Concurrent downloads across different ids are allowed; the same id can't be double-clicked into two parallel saves.
- Failures are surfaced under the bubble that owns the failed attachment, scoped by `errorFileId`.
- `defaultPath = join(downloads, basename(filename))` — `basename` strips any `..` from a renderer-supplied filename.
- Reveal-in-folder after save; never auto-open the file.

### Staleness on chat switch
- The composer's pending list is scoped to a chat. Switching chats while an upload is in flight drops the resolving file via a generation counter in `useChatAttachments`.
- Switching scopes mid-chat (e.g., active agent flips from remote to LLM) clears already-queued attachments.

## Architecture Overview

```
Active chat — pick or drag-drop:
  ChatInput → useChatAttachments.pick() / pickFromPaths(paths)
    → window.api.files.pickAndUpload({ scope, chatId })
       or .ingestPaths({ scope, chatId, paths })
    → files:* IPC
       → assertFileScope(scope)
       → pathGuard.filterAllowed(paths)         [drop/ingest-paths only]
       → fileService.ingest({ userId, scope, chatId, filePaths })
          ├─ scope === 'local':
          │    chatRepo.getOwned(userId, chatId)  [ownership check]
          │    localFileStore.ingest()           [copy bytes, insert chat_files row]
          └─ scope === 'cinna':
               cinnaFileService.uploadMany()    [multipart POST]
    → MessageAttachment[] back to renderer

New-chat — pick or drag-drop:
  ChatInput → useChatAttachments deferred mode
    → files:pick-paths / files:resolve-paths
       → pathGuard records dialog or drop paths
       → fileService.resolvePaths()             [stat + MIME guess]
    → PendingAttachment[] (id = absolute path)
  Send:
  MainArea.handleNewChat → useNewChatFlow.startNewChat
    → createChat / updateChat / mcp flush
    → resolvePendingAttachments(chatId, scope, attachments)
       → files:ingest-paths                     [swaps pending for real]
    → startAgent / startLlm with real attachments

Send → LLM stream loop:
  chatStreamingService._runStreamLoop
    → adapter.modelCapability(modelId)
    → for each user message:
        attachmentToMediaPart(att, { capability, userId })
          ├─ image MIME            → MediaPart.image
          ├─ native non-image MIME → MediaPart.document
          ├─ text/office/code     → textExtractor.extractText → MediaPart.text
          └─ otherwise              → drop
    → adapter.stream({ messages, … })
       → renderTextPartsPrefix(media) for `text` parts
       → provider-native blocks for `image` / `document` parts

Send → A2A:
  messageRoutingService.prepareAgentSend({ attachments })
    → messageRepo.saveUser({ attachments })
  a2aStreamingService.streamToAgent({ fileIds: attachments.map(a => a.id) })
    → buildSendParams(..., { metadata: { cinna_file_ids } })

Download:
  MessageBubble → useFileDownloadStore.download(attachment)
    → window.api.files.download({ fileId, filename, source })
    → files:download IPC → fileService.downloadToPath
       ├─ source === 'local':  pipeline(createReadStream, createWriteStream)
       └─ source === 'cinna':  cinnaFileService.downloadToPath
    → shell.showItemInFolder
```

## Integration Points

- [Messaging](../messaging/messaging.md) — Attachments piggy-back on user-message persistence. `messageRoutingService.prepareAgentSend` and `prepareLlmSend` are the persistence chokepoints.
- [LLM Adapters](../../llm/adapters/adapters.md) — Each adapter declares `modelCapability(modelId)` + translates `MediaPart[]` to provider-native content blocks.
- [Provider Integration](../../llm/adapters/provider_integration.md) — Per-provider MIME and capability matrix (native PDF support, image MIMEs, size envelopes).
- [Agents](../../agents/agents/agents.md) — A2A streaming + endpoint resolution for Cinna-scoped attachments.
- [A2A Streaming Pipeline](../../agents/agents/streaming_pipeline.md) — `buildSendParams` forwards `cinna_file_ids` as message metadata.
- [Cinna Accounts](../../auth/cinna_accounts/cinna_accounts.md) — Cinna uploads use the user's auto-refreshed access token.
- [Multi-Agent Chats](../multi_agent/multi_agent.md) — Attach button + scope re-evaluate when the composer's `activeAgent` changes.

## Backend Dependency

Cinna-scoped attachments reach the agent environment only when the Cinna backend reads `metadata.cinna_file_ids` from the inbound A2A message and forwards them to `SessionService.send_session_message` as `file_ids`. Local-scoped attachments are entirely self-contained — no backend involvement.
