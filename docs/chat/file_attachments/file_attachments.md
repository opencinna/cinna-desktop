# File Attachments

## Purpose

Lets a user attach local files to a chat message — images, PDFs, Office documents, code/text — for both LLM destinations (Anthropic, OpenAI, Gemini) and Cinna remote agents. Files arrive from the `[+]` menu, a drop, or a paste into the composer. They are stored in the right backing store based on destination, shown in the composer and under user bubbles — images as small thumbnails, everything else as badges — and can be previewed in place or downloaded back to disk.

## Core Concepts

- **Attachment** — A file attached to a single user turn. Persists on `messages.attachments` as a condensed DTO (id, filename, size, mimeType, source). Tracked in-app via `MessageAttachment`.
- **Source / Backing Store** — Where the bytes live. `cinna` (Cinna backend), `local` (`userData/files/<userId>/<chatId>/`), or `pending` (composer-only, paths on disk awaiting destination decision).
- **Pending Attachment** — New-chat composer state. Files the user picked, dropped or pasted but hasn't ingested yet because the chat row doesn't exist and the destination scope isn't known. Swapped for a real `cinna` / `local` attachment at send time.
- **Composer Attachment** — Union of `MessageAttachment` (already ingested) and `PendingAttachment` (deferred). Only the composer's pending list holds the union; everything downstream is narrowed to `MessageAttachment`.
- **Model Capability** — Per-model declaration of accepted MIME types, size envelope, and which of those are passed through natively (image bytes for all vision models, PDF for Anthropic + Gemini). Everything else routes through the text extractor.
- **Media Part** — Resolver output for the LLM stream loop. Three variants: `image` (raster bytes), `document` (native non-image bytes like PDF), `text` (UTF-8 string from extraction). Adapters translate to provider-native blocks.
- **Text Extractor** — Service that converts office docs (DOCX/XLSX/PPTX/ODT/…), PDFs (when the model has no native PDF support), and code/CSV/JSON files into UTF-8 text the LLM can read. Backed by `officeparser` for binary office formats.
- **Path Guard** — Allowlist of OS paths the renderer is permitted to reference. Populated by file dialogs, the `webUtils.getPathForFile` preload wrapper, and main's own clipboard read on a paste. Defense-in-depth against a compromised renderer.
- **Pasted Image** — An image on the clipboard with no file behind it (a screenshot, an image copied in a browser). Main writes it as `Pasted image <date> at <time>.png` under `<userData>/tmp/pasted/`, and from there it is an ordinary picked file. The folder is emptied at every start.
- **Thumbnail** — A fixed 64×64 px square standing in for an image attachment, in the composer, under a sent message and under an agent's reply. Thumbnails come before badges in the same row.
- **`[+]` Composer Menu** — The single left-side composer entry point (`ComposerPlusMenu`). Opens a small menu whose **Attach files** item triggers the picker described here; the same menu also hosts **Chat mode** and **Add agents / MCP**. Attachment gating below governs whether the **Attach files** item shows. Drag-and-drop is unchanged and independent of the menu.
- **`cinna_file_ids` Metadata** — A2A message metadata key carrying Cinna file UUIDs. Backend forwards bytes into the agent environment's `./uploads/` before the agent receives the message.

## User Stories / Flows

### Attaching a file in an active LLM chat

1. User is in a chat bound to an LLM provider (no remote agent active).
2. The `[+]` menu's **Attach files** item appears if the selected model declares any accepted MIME types.
3. User picks files via the menu or drags them onto the composer.
4. Bytes are copied into the per-user local store (`chat_files` table + `userData/files/...`). Badges appear in the composer.
5. User sends. The stream loop reads the persisted attachments, runs each through the text extractor or passes native bytes, and hands the adapter resolved `MediaPart[]`.
6. Adapter emits provider-native content blocks (image, document) or inlines extracted text as a `<file name="…" type="…">…</file>` prefix on the user message.

### Attaching a file in a chat bound to a Cinna remote agent

1. User is in a chat bound to a Cinna-source remote agent (direct A2A).
2. The `[+]` menu's **Attach files** item appears for Cinna users.
3. Picked/dropped files stream to the Cinna backend (`POST /api/v1/files/upload`).
4. On send, the A2A request carries `metadata.cinna_file_ids` — bytes are referenced, not retransmitted.

### Attaching on the new-chat screen

1. The `[+]` menu's **Attach files** item appears when the user has any plausible destination — a Cinna account, or at least one enabled LLM provider with an API key.
2. Picked/dropped files do NOT upload yet — they're held as `pending` attachments whose `id` carries the absolute OS path.
3. Badges render from filename + size alone, immediately.
4. User picks an agent or chat mode and types a message.
5. On send, the new-chat flow creates the chat row, picks scope from destination (remote agent → cinna, LLM → local), and calls the ingest IPC to swap each `pending` for a real attachment. The first user turn carries the resolved attachments.
6. If ingest fails or returns fewer files than the selected pending paths, the message is not dispatched. The error surfaces via the chat-store's `setSendError`, the orphaned chat row is deleted best-effort and the source draft keeps its selections. For unavailable files, remove and reattach them before retrying; an incomplete result must not silently send text without the promised files.

### Drag-and-drop

1. User drags files from Finder/Explorer onto the chat composer.
2. The composer container shows an accent-colored "Drop to attach" overlay while a file drag is hovering.
3. On drop, paths are resolved via `webUtils.getPathForFile` (each path is auto-tracked into the path-guard allowlist as a side-effect).
4. From there, the flow matches a normal pick — active chats ingest immediately, new-chat holds as pending.
5. Directory drops are rejected with an inline error (paths come back empty from `getPathForFile`).
6. After the pick/drop resolves, focus returns to the composer textarea (shared `focusComposer` helper in `ChatInput`, used by both the `[+]` menu's **Attach files** and drag-drop).

### Pasting files or an image

1. The user pastes into the composer's text box (Cmd/Ctrl+V or the Edit menu) while it can take files — the same condition as a drop: the **Attach files** item would show and no reply is running.
2. Plain text pastes natively, untouched. The composer looks at the clipboard's types first and only claims the paste when it carries files.
3. **Files copied in Finder / Explorer attach** — every file of a multi-file copy on macOS, a `text/uri-list` on Linux, one file on Windows. The file's own icon, which the clipboard also carries as an image, is ignored: the user copied the file, not its icon.
4. **An image with no file behind it attaches as a PNG** named like a macOS screenshot, `Pasted image 2026-09-30 at 14.05.33.png`; a second paste in the same second gets ` (2)`.
5. **A copy from Excel, Word or a web page pastes as text.** Those put a picture of the selection on the clipboard beside its text; the text wins over a picture of itself.
6. From there the flow matches a drop — active chats ingest immediately, the new-chat screen holds the files as pending — and focus returns to the composer.
7. **When the composer cannot take files**, a paste that also carries text pastes the text with no complaint. A paste with nothing to fall back on says why, in the toolbar: "Files can be attached once the reply finishes.", "Files can't be attached in this chat.", or on the new-chat screen "Add an AI provider or sign in to attach files."
8. **A copied folder is refused** with the drop's sentence, "Folders and unresolved files cannot be attached"; a copy of files and folders keeps the files. A clipboard that turned out to hold nothing usable says "Nothing on the clipboard could be attached."

### Viewing sent attachments

1. User bubbles render their `attachments[]` right-aligned: an image the preview can show (`png`, `jpg`/`jpeg`, `gif`, `webp`, `bmp`, `svg`) as a 64×64 thumbnail, first, and every other file as a badge with file-type icon, truncated filename and size. The optimistic user bubble (shown while the persisted row is still in flight) carries the turn's already-ingested attachments too, so they appear instantly on send rather than only after the chat refetches — see the optimistic user-message lifecycle in [Messaging tech](../messaging/messaging_tech.md).
2. Clicking a thumbnail, or the badge of a type [File Preview](../file_preview/file_preview.md) shows, opens the preview modal; its header keeps a **Download** button.
3. Clicking any other badge downloads: the OS save dialog opens (default = Downloads / original filename, with `basename(filename)` applied to strip any traversal), the file streams from the right store (Cinna backend or local disk) to the chosen path, and the OS file manager reveals the saved file.

### Previewing a file still in the composer

1. An image in the composer shows as a thumbnail with an `[x]` in its corner; any other file the preview can show has a badge whose name is a button.
2. Clicking either opens the same preview modal a sent file opens, with **no Download** — the file is the user's own and has not been sent.
3. A new-chat file is read from its path on disk; a file already ingested into an open chat is read as the attachment it now is.
4. A badge the preview cannot show (a PDF, a zip) is not clickable; it only has its `[x]`.

### Removing a pending attachment

1. `[x]` on a composer badge or thumbnail drops it from the pending list immediately. It is a sibling of the preview button, never nested inside it.
2. Backend cleanup (Cinna soft-delete) fires fire-and-forget for `cinna` source; nothing to clean for `local` (still pending) or `pending` (never uploaded).

## Business Rules

### Destination gating

(Governs the **Attach files** item in the `[+]` menu — `canShowAttachButton` in `ChatInput`.)
- **Active chat with remote agent active**: available for Cinna users. Scope = `cinna`.
- **Active LLM chat** (no agent): available when the selected model's capability has at least one accepted MIME type. Scope = `local`.
- **Active chat with local-A2A agent**: hidden. No backend can receive the files.
- **New-chat screen**: available when the user has a Cinna account OR any enabled LLM provider with an API key. Scope decision deferred to send time.
- Pending attachments stay in the draft when the destination changes. Sending files from a different scope asks the user to remove and reattach them.

### Capability-driven adapter routing

- Each adapter declares `acceptedMimeTypes`, `nativeMimeTypes`, `maxFileSizeBytes`, `maxFilesPerMessage` per model.
- `acceptedMimeTypes` is the union the model can take after upstream transformation; `nativeMimeTypes` is the subset whose bytes pass through unchanged.
- Resolver branches on MIME: image → `image` part; native non-image → `document` part; everything else extractable → `text` part. Anything else: dropped with a warning log.
- Anthropic Claude 3+: images + PDF native; everything else text-extracted. Legacy Claude 2 / Instant: text-only.
- OpenAI vision models (`gpt-4*`, `o*`, `chatgpt-4*`): images native; PDF + office text-extracted. Non-vision: text-only.
- Gemini 1.5+ / 2.x: images + PDF native; everything else text-extracted. Legacy Gemini Pro: text-only.

### Local store

- Local files live at `userData/files/<owner>/<chatId>/<uuid><ext>`, where `<owner>` is the chat's owner — the guest profile for a chat shared across profiles, whoever attaches. Metadata in the `chat_files` table, under the same owner, so every profile that sees the chat sees the same files.
- `chat_files` has `ON DELETE CASCADE` to `chats` — deleting a chat purges its file rows.
- Chat visibility is verified before any local ingest: `visibleChat(userId, chatId)` runs in `fileService.ingest` before disk writes or row inserts.

### Path-guard allowlist

- Renderer-supplied paths (`files:ingest-paths`, `files:resolve-paths`) must be in the allowlist to be accepted.
- Allowlist is populated by: native picker dialog results, the `webUtils.getPathForFile` preload wrapper, and explicit `files:track-path` events.
- Paths expire 1 hour after recording. Rejected paths are filtered silently (and logged with truncated metadata, no full path).
- The `files:pick-and-upload` and `files:pick-paths` handlers automatically record their dialog results, and `files:paste-from-clipboard` records the paths it returns. The renderer never names a pasted path: main reads the clipboard itself, so a paste cannot smuggle in a path the user did not copy.
- The composer's previews read by path (`files:read-image`, `files:read-thumbnail`, `files:read-preview-path`) only for a path in the allowlist. Once it expires the preview says "This file is no longer available to preview. Attach it again."

### Paste

- **The decision is made inside the paste event, from the clipboard's types.** Deferring it would mean cancelling the native paste and re-inserting text by hand, losing undo, the selection and the input's own handling of the paste.
  - No `Files` type: text, and main is not asked.
  - `Files` and no `text/plain`: files — a screenshot, a browser image.
  - Both: a Finder copy (the file plus its name) and an Excel or Word copy (the text plus a picture of it) look identical here, so the renderer asks main, synchronously, whether the clipboard references files. References attach; otherwise the text pastes.
- **File references win over an image.** Main reads the references first and reads the image only when there are none.
- **Main reads the clipboard, not the renderer.** The renderer's clipboard gives it no paths; main parses the platform formats (macOS `NSFilenamesPboardType`, then `public.file-url`; Linux `text/uri-list`; Windows `FileNameW`, first file only) and returns absolute paths already in the path guard.
- **Only regular files attach.** Each reference is `stat`ed; folders and vanished paths are dropped, and a copy that leaves none is refused.
- **Pasted images are temporary.** `<userData>/tmp/pasted/` is created `0700`, each PNG `0600` and never over an earlier one, and the whole folder is removed at every start (not awaited; a failure only costs disk space). Ingest copies or uploads the bytes, so a sent image does not depend on the file surviving.
- **A paste while an upload is running waits its turn.** Paths dropped or pasted during an upload queue per draft and upload together as soon as it ends, into the same draft; two quick pastes both attach. A second `[+]` picker open during an upload is still ignored. Clearing the draft drops the queue.
- **An attach error sits in the toolbar's empty middle, on one line** (truncated, full text in the tooltip), between the `[+]` cluster and Send. It used to be a line under the composer; showing it there grew the composer and moved Send ([UX rule 1](../../development/ui_guidelines/ux_rules.md)). The next upload clears it.

### Thumbnails

- **The box is 64×64 from the first paint, in every state** — an image placeholder while loading, the image (cropped to fill), or a broken-image icon when there is none. A thumbnail that loaded late or failed would otherwise move the badges beside it and the transcript under the reader.
- **A thumbnail is a small image, not the file.** Main scales it to fit 160 px (PNG stays PNG, anything else becomes JPEG) and the preview reads the full image separately. An SVG, or a format the platform cannot decode, is sent as it is up to 256 KB and otherwise has no thumbnail.
- **A failed thumbnail stays a thumbnail.** Main's refusal (over 25 MB, not an image, gone) or bytes that do not decode show the broken-image icon, with "— no thumbnail for this image" in the tooltip. A click still opens the preview, which says why, and for a sent file offers Download.
- **Nothing is read twice.** Thumbnails are cached per session in the renderer (300, oldest out first) and in main (200, keyed by attachment, or by path, size and modification time), and at most four thumbnail reads are in flight at once, so opening a chat full of images does not read them all together. Waiting reads are served newest first: the chat the user just opened is not stuck behind the one they just left. The renderer's cache is keyed by profile too, so an image one profile loaded is never shown to another without main's ownership check. A failure is not cached; the next mount asks again.
- **Sending does not flash placeholders.** A new chat's images, loaded by path in the composer, are carried over to the attachment ids ingest returns, so the sent message shows them at once.
- **Task attachments keep badges.** Only the user's message, the agent's reply and the composer ask for thumbnails.

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
- An ingest success containing fewer results than pending paths is also a preparation failure. `startNewChat` returns false, the source draft is retained and the orphaned chat row is deleted best-effort. A true result means dispatch, not successful completion of the reply.

### Download

- One save-as flow per badge click. Concurrent downloads across different ids are allowed; the same id can't be double-clicked into two parallel saves.
- Failures are surfaced under the bubble that owns the failed attachment, scoped by `errorFileId`.
- `defaultPath = join(downloads, basename(filename))` — `basename` strips any `..` from a renderer-supplied filename.
- Reveal-in-folder after save; never auto-open the file.

### Drafts across navigation

- Pending files belong to a profile and composer (dashboard, individual agent start screen or existing chat). Navigation restores that draft; an in-flight picker or upload finishes into its originating draft even after unmount.
- Pending path references and upload status are renderer-session state, not saved draft files; renderer refresh/restart discards that buffer. Dispatched attachments retain their normal storage lifecycle.
- Explicitly clearing a draft invalidates pending upload results and drops paths queued behind a running upload. Destination changes or loading never silently delete queued files; incompatible files block sending with an explanation.

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
          │    visibleChat(userId, chatId)       [visibility check]
          │    localFileStore.ingest(chat owner) [copy bytes, insert chat_files row]
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
  ChatWorkspace.handleNewChat → useNewChatFlow.startNewChat
    → createChat / updateChat / mcp flush
    → resolvePendingAttachments(chatId, scope, attachments)
       → files:ingest-paths                     [swaps pending for real]
    → startRun with real attachments

Send → LLM stream loop:
  ACP buildAcpPrompt: negotiated prompt capabilities → image/resource/text blocks
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

Paste (either screen):
  ChatInput onPaste → pasteIntent(clipboardData.types, files:clipboard-has-file-refs [sync, only when Files + text])
    → 'text' → native paste
    → 'files' → files:paste-from-clipboard
       → clipboard file references → stat, regular files only
         or clipboard image → PNG under <userData>/tmp/pasted/
       → pathGuard.recordMany(paths)
    → pickAttachmentsFromPaths(paths)            [the drop's path from here]

Thumbnails and composer preview:
  AttachmentList thumbnailFor → AttachmentThumbnail → imageDataCache (≤ 4 reads)
    → files:read-thumbnail { fileId, source } | { path }   [path must be in the path guard]
  composer click → useComposerAttachmentOpen
    → pending: openPathPreview (files:read-preview-path / files:read-image { path })
    → ingested: openPreview(attachment, { composer: true })   [no Download]

Download:
  MessageBubble → useAttachmentOpen → not previewable → useFileDownloadStore.download(attachment)
    → window.api.files.download({ fileId, filename, source })
    → files:download IPC → fileService.downloadToPath
       ├─ source === 'local':  pipeline(createReadStream, createWriteStream)
       └─ source === 'cinna':  cinnaFileService.downloadToPath
    → shell.showItemInFolder
```

## Integration Points

- [Conversation UI](../conversation_ui/conversation_ui.md#leaving-and-returning-to-a-draft) — profile/surface draft retention, end-caret restoration and conditional consumption after dispatch.

- [Messaging](../messaging/messaging.md) — Attachments piggy-back on user-message persistence. `messageRoutingService.prepareAgentSend` and `prepareLlmSend` are the persistence chokepoints.
- [File Preview](../file_preview/file_preview.md) — Clicking a sent attachment's thumbnail or badge previews images and text types in place (png/jpg/gif/webp/bmp/svg, txt/csv/md/json/yaml/py, XML and its dialects, and HTML rendered in a sandboxed frame) instead of always downloading, and the badge is then named "Preview *name*"; reuses the same `cinna`/`local` source routing. Composer files preview too, by path before a new chat exists, with no Download.
- [LLM Adapters](../../llm/adapters/adapters.md) — Each adapter declares `modelCapability(modelId)` + translates `MediaPart[]` to provider-native content blocks.
- [Provider Integration](../../llm/adapters/provider_integration.md) — Per-provider MIME and capability matrix (native PDF support, image MIMEs, size envelopes).
- [Agents](../../agents/agents/agents.md) — A2A streaming + endpoint resolution for Cinna-scoped attachments.
- [A2A Streaming Pipeline](../../agents/agents/streaming_pipeline.md) — `buildSendParams` forwards `cinna_file_ids` as message metadata.
- [Cinna Accounts](../../auth/cinna_accounts/cinna_accounts.md) — Cinna uploads use the user's auto-refreshed access token.
- [Orchestrated Agents](../orchestrated_agents/orchestrated_agents.md) — Promoting a direct-A2A chat to orchestrated flips the upload scope (Cinna → local); the attach button + scope re-evaluate when the chat's `agentId`/`orchestrated` state changes.

## Backend Dependency

Cinna-scoped attachments reach the agent environment only when the Cinna backend reads `metadata.cinna_file_ids` from the inbound A2A message and forwards them to `SessionService.send_session_message` as `file_ids`. Local-scoped attachments are entirely self-contained — no backend involvement.

## Runtime conversation transport

Local ACP answerers ingest into the local store even when the router is coordinator. `promptCapabilities.image` permits native image blocks; embeddedContext permits embedded resources. Unsupported native formats use the existing extracted-text path (including PDFs where extraction is available), and unreadable media contributes an explicit attachment-unavailable marker. The runtime owns its format limits; an API adapter's model capability is no longer the conversational authority. Fresh-session recovery replays historical attachments through the same conversion, not just their file names. Remote Cinna agents retain their upload/file-ID path.
