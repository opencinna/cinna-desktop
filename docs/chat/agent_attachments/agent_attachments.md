# Agent Attachments

## Purpose

Lets a remote Cinna agent attach files it produced to its reply, and renders
them in the desktop transcript as downloadable badges — the mirror image of a
user attaching a file to their own message ([File Attachments](../file_attachments/file_attachments.md)).
The agent declares a file with a `<cinna_attach>` tag; the Cinna backend
materialises the bytes into durable storage and delivers the reference to the
desktop as a native **A2A `FilePart`** carrying `cinna.content_kind: 'file'` and
`cinna.file_*` metadata. The desktop turns that into a `file`-kind
`MessagePart`, persists it on the assistant message, and renders an attachment
badge under the reply. Clicking the badge previews text types in place or
downloads other types via the user's OAuth bearer session — no signed URL.

The FilePart is delivered **live at finalize** (the backend yields it into the
A2A stream after the reply text), so on desktop the badge lands at the **end**
of the turn — not spliced at the tag's textual position the way the web renders
it from the persisted trace.

Text-based attachments (`txt`/`csv`/`md`/`json`/`yaml`) now open an in-app
read-only preview on click — see [File Preview](../file_preview/file_preview.md).
Image / PDF / binary attachments still download on click.

## Core Concepts

- **Agent Attachment** — A file authored by a remote agent and delivered over
  A2A as a `FilePart`. Distinct from a user [Attachment](../file_attachments/file_attachments.md)
  (which the user uploads to a message) — this is the reverse direction.
- **`file` Content Kind** — `metadata['cinna.content_kind'] = 'file'` on a
  FilePart. Routed to a `file`-kind `MessagePart` (`{ kind: 'file', text: '',
  file }`). The part's `text` is always empty; the payload is the `file` field.
- **`MessagePartFile`** — `{ fileId, filename, mimeType, size }` extracted from
  the `cinna.file_*` metadata. `fileId` is the Cinna backend file UUID.
- **OAuth download path** — The badge downloads via `GET /api/v1/files/{fileId}/download`
  with `Authorization: Bearer <oauth_access_token>` (no `?token=`). Reuses the
  exact `cinna`-source download already used for user attachments.

## User Stories / Flows

### Viewing an agent attachment in a direct-A2A chat
1. The agent finalises a reply that includes one or more `<cinna_attach>` tags.
2. At finalize the backend materialises each file, strips the tags from its
   stored copy, and **yields** an A2A `FilePart(FileWithUri)` per file into the
   live stream — `cinna.content_kind: 'file'` plus `cinna.file_id` /
   `cinna.file_name` / `cinna.file_mime` / `cinna.file_size`.
3. The desktop's `StreamPartsAccumulator` reads each FilePart, builds a
   `MessagePartFile`, and appends a `file` part (deduped by `file_id`).
4. A `file` delta posts over the stream port → a download badge renders live
   below the reply text (the FilePart arrives after the text at finalize).
5. On stream completion the `file` parts persist in `messages.parts`; the
   post-`done` refetch replaces the live badge with the persisted one (no visual
   change).
6. The user clicks the badge → OS save dialog → the file streams from the Cinna
   backend to disk and is revealed in the file manager.

### Viewing an agent attachment in an orchestrated sub-thread
1. An orchestrated agent-as-tool turn produces a `FilePart` in its sub-stream.
2. The file delta arrives as a `tool_subevent` → accumulates into the tool
   call's `subParts` and persists on the `tool_call` row's `parts`.
3. `AgentContribution` renders the badge inside the expandable
   `AgentToolSubThread`.

### Download failure
1. A failed download (expired session, network, revoked permission) surfaces a
   small dismissible error label under the offending badge, scoped by
   `errorFileId` so only that badge shows it.

## Business Rules

### Routing & dedup
- Only FileParts with a `cinna.file_id` are surfaced — without it the renderer
  can't route to the OAuth download path, so the part is skipped. A bare signed
  URI is never surfaced.
- A given `file_id` is attached exactly once per message. The backend may emit
  the same attachment twice (same path declared twice → one `file_id`) and
  history replay re-sends parts; `StreamPartsAccumulator.seenFileIds` dedups.
- `file` parts never merge with neighbours (two attachments stay two badges) and
  contribute nothing to `answerText()` (chat preview / title / search).

### Download access control (OAuth, not signed URL)
- The download builds a `cinna`-sourced `MessageAttachment` (`id = fileId`) and
  goes through the standard `files:download` IPC → `cinnaFileService.downloadToPath`
  → `GET /api/v1/files/{fileId}/download` with the user's auto-refreshed OAuth
  access token. The backend gates on the user's actual download permission
  (owner OR session participant).
- The signed `file_download` token embedded in the FilePart's `uri` is **ignored**.
  No bearer secret in the URL (URLs leak via logs/history); lifecycle is tied to
  the user's revocable session, not a standalone 1h grant. Because the file_id is
  persisted, expiry is a non-issue — reload re-downloads with a fresh token.

### `<cinna_attach>` tag stripping (client-side)
- The backend streams the agent's reply **tokens raw, with the `<cinna_attach>`
  tag inline**, and only strips the tag from its *own* stored copy at finalize.
  The desktop accumulates the live stream into its own persisted message, so it
  must strip the tag itself — otherwise the literal
  `<cinna_attach>…</cinna_attach>` shows in the assistant bubble.
- `stripCinnaAttachTags` (`src/shared/cinnaAttach.ts`) removes the tag in two
  places: the accumulator cleans `answerText()` (→ `messages.content`) and the
  text of `text`-kind `parts[]` (source of truth); `MessageBubble` strips at
  render for the **live streaming** blocks (which bypass the accumulator
  snapshot), with a streaming-only pass that also hides a not-yet-closed or
  partially-arrived tag so no fragment flashes mid-stream.
- The file rides a separate `file` part / FilePart, so the badge renders even
  though the tag text is gone. On the desktop the badge lands at the **end** of
  the turn (the FilePart arrives at finalize), not spliced at the tag's textual
  position the way the web renders it.

### Empty-content assistant rows
- An assistant turn that attaches a file but writes no text has empty
  `messages.content` and a non-empty `parts[]`. `MessageStream` skips empty
  assistant rows **only** when they also have no parts, so a file-only turn still
  renders its badge.

### Persistence
- `file` parts live on the `messages.parts` JSON column alongside text/tool
  parts — no schema change. Reload renders from the local SQLite row (the
  desktop does not depend on the backend `message.files` fallback used by web).

## Architecture Overview

```
A2A stream (direct or orchestrated):
  sendMessageStream() emits status-update / artifact-update with FileParts
    → StreamPartsAccumulator.ingest()
        kind === 'file' → ingestFilePart()
          partFileOf(part)  [cinna.file_* → MessagePartFile, file_id required]
          dedup by file_id
          parts.push({ kind: 'file', text: '', file })
          port.postMessage({ type: 'delta', kind: 'file', file })
    → on completion: messageRepo.saveAssistant({ parts })  [or tool_call.parts]

Renderer:
  handleAgent('delta') → chat.store.appendDelta(..., file)   [direct]
    or appendToolSubEvent → appendAgentDeltaPart(..., file)  [orchestrated]
  MessageStream / AgentContribution: kind === 'file' → <AgentAttachment file>
    → AttachmentList (badge) onClick → useFileDownload.download(att)

Download:
  useFileDownload.download({ id: fileId, source: 'cinna' })
    → window.api.files.download
    → files:download IPC → fileService.downloadToPath (source: 'cinna')
    → cinnaFileService.downloadToPath → GET /files/{id}/download (Bearer OAuth)
    → shell.showItemInFolder
```

## File References

- Accumulator: `src/main/agents/streamPartsAccumulator.ts` (`ingestFilePart`, `partFileOf`, `FILE_*_METADATA_KEY`)
- Shared types: `src/shared/messageParts.ts` (`'file'` kind, `MessagePartFile`), `src/shared/agentStreamEvents.ts` (`AgentDeltaEvent.file`)
- Tag stripping: `src/shared/cinnaAttach.ts` (`stripCinnaAttachTags`), applied in the accumulator + `MessageBubble`
- Renderer store: `src/renderer/src/stores/chat.store.ts` (`appendDelta`, `appendAgentDeltaPart`)
- Badge component: `src/renderer/src/components/chat/AgentAttachment.tsx`
- Rendering: `src/renderer/src/components/chat/MessageStream.tsx`, `src/renderer/src/components/chat/AgentContribution.tsx`
- Download: `src/main/services/cinnaFileService.ts:downloadToPath` <!-- nocheck -->, `src/main/ipc/files.ipc.ts` (`files:download`)

## Integration Points

- [A2A Streaming Pipeline](../../agents/agents/streaming_pipeline.md) — Owns the FilePart → `file`-part conversion and the metadata contract.
- [File Attachments](../file_attachments/file_attachments.md) — Reuses the `cinna`-source download path, `AttachmentBadge` / `AttachmentList`, and `useFileDownload`. This is the reverse (agent→user) direction.
- [Cinna Accounts](../../auth/cinna_accounts/cinna_accounts.md) — Downloads use the user's auto-refreshed OAuth access token.
- [Orchestrated Agents](../orchestrated_agents/orchestrated_agents.md) — Agent attachments inside an agent-as-tool sub-turn render in the sub-thread via `AgentContribution`.

## Backend Dependency

Surfaced only for Cinna remote agents that emit attachment `FilePart`s with
`cinna.file_id` metadata (see `backend/app/services/a2a/a2a_event_mapper.py`).
Local A2A agents and non-Cinna servers that send FileParts without a
`cinna.file_id` are silently skipped — there is no usable download route for
them.

The desktop consumes the **live** A2A stream and persists its own copy; it does
not replay history via `getTask`. So it depends on the backend **yielding** the
attachment `FilePart` into the live stream at finalize (cinna-core
`MessageService._process_attachments` → the stream generator), not only emitting
it to the web Socket.IO room or splicing it into the persisted `streaming_events`
trace (which would surface the file on web and on A2A replay, but never on the
desktop's live stream).

## Future Enhancements (Out of Scope)

- **Inline preview for image/PDF** — image and PDF preview modal (text preview
  shipped via [File Preview](../file_preview/file_preview.md); image/PDF still
  download).
- **`FileWithBytes` inline transport** — fully offline fetch without a backend round-trip.
- **Non-Cinna FilePart support** — downloading via the FilePart `uri` for agents
  that don't carry a `cinna.file_id`.

---

*Last updated: 2026-06-07*
