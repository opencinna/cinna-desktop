# File Preview — Technical Details

## File Locations

### Shared (cross-process)
- `src/shared/filePreview.ts` — `previewKindFor(filename, mimeType)` → `PreviewRenderKind | null`; `isPreviewable(filename, mimeType)`; `PreviewRenderKind` type (`'markdown' | 'json' | 'csv' | 'text'`); `MAX_PREVIEW_BYTES` (512 KB). Extension table wins over MIME table; inline extension parse (no Node `path` — imported by the sandboxed renderer)
- `src/shared/attachments.ts` — `MessageAttachment` is the shape preview consumes (id, filename, size, mimeType, `source?`); `agentFileToAttachment(file)` adapts an agent `MessagePartFile` into it (reused by the preview/download click router)

### Main process — services
- `src/main/services/fileService.ts`:
  - `readTextPreview({ userId, attachmentId, source, maxBytes })` — source-routed read into memory; `local` = `chatFileRepo.getOwned` + `readFile` then `subarray(0, maxBytes)`; `cinna` = `cinnaFileService.readBytes`. Decodes via `TextDecoder('utf-8')`; when `truncated`, decodes with `{ stream: true }` and skips the final flush so a severed multi-byte sequence is dropped (no trailing `�`). Returns `{ text, truncated }`
  - `assertFileScope(value)` — reused to narrow the renderer-supplied `'cinna' | 'local'`
- `src/main/services/cinnaFileService.ts`:
  - `readBytes(userId, fileId, maxBytes)` — `net.fetch GET /api/v1/files/{fileId}/download` with OAuth bearer; reads `arrayBuffer()`, returns `{ bytes: Buffer (capped), truncated }`. Logs `read` success (`fileId, bytes, truncated, durationMs`) and `logger.error` on network / non-OK status. In-memory only — never writes to disk (distinct from `downloadToPath`)

### Main process — DB (reused, no new tables)
- `src/main/db/chatFiles.ts` — `chatFileRepo.getOwned(userId, attachmentId)` provides ownership-scoped lookup for the `local` read path

### Main process — IPC
- `src/main/ipc/files.ipc.ts`:
  - `files:read-preview` — thin controller: `userActivation.requireActivated()` → `getProfileScopeUserId()` → `assertFileScope` → `fileService.readTextPreview({ maxBytes: MAX_PREVIEW_BYTES })`; returns `{ success, text, truncated }` or `{ success: false, error, code }` via `ipcErrorShape`
  - Reuses the existing `files:download` for the modal's Download button (no new download channel)

### Preload
- `src/preload/index.ts` — `window.api.files.readPreview({ fileId, source? })` → `ipcRenderer.invoke('files:read-preview', …)`; return type is the success/error union (inferred into `API = typeof api`, surfaced through `src/preload/index.d.ts`)

### Renderer — store / hook
- `src/renderer/src/stores/filePreview.store.ts` — `useFilePreviewStore` (Zustand): `{ attachment, kind, text, isLoading, truncated, error, requestId }`; `openPreview(attachment, kind)` fetches `files.readPreview` and guards staleness via monotonic `requestId`; `close()` bumps `requestId` to discard any in-flight fetch
- `src/renderer/src/hooks/useAttachmentOpen.ts` — `useAttachmentOpen()` returns `(attachment) => void`; calls `previewKindFor` → `openPreview` (previewable) or `useFileDownloadStore.download` (everything else). Single branch point for preview-vs-download
- `src/renderer/src/stores/fileDownload.store.ts` — `useFileDownloadStore` reused unchanged for the modal's Download button (shared spinner/error state)

### Renderer — components
- `src/renderer/src/components/chat/FilePreviewModal.tsx` — single global modal (`createPortal` to `document.body`); header = filename + (CSV-only) Filter toggle + icon-only Download + Close; body dispatches by `kind`. Contains `PreviewBody`, `JsonPreview` (pretty-print with raw fallback), `CsvPreview` (filter/sort), and the `parseDelimited` / `compareCells` helpers. `MAX_PREVIEW_ROWS = 500` render cap
- `src/renderer/src/components/chat/MessageBubble.tsx` — user-message badges: `AttachmentList onClick={(a) => openAttachment(a)}` (was `download`)
- `src/renderer/src/components/chat/AgentAttachment.tsx` — agent-attachment badges: same `openAttachment` routing
- `src/renderer/src/App.tsx` — mounts `<FilePreviewModal />` once at the app root (alongside the other global overlays/modals)

### Reused, unchanged
- `src/renderer/src/components/chat/AttachmentBadge.tsx` — `AttachmentList` / `AttachmentBadge`; still source-agnostic, tooltip still "Download". Preview routing is entirely in the `onClick` callers, not the badge

## IPC Channels

| Channel | Direction | Payload | Returns |
|---------|-----------|---------|---------|
| `files:read-preview` | renderer → main | `{ fileId: string, source?: 'cinna' \| 'local' }` | `{ success: true, text: string, truncated: boolean }` / `{ success: false, error, code? }` |
| `files:download` | renderer → main | `{ fileId, filename, source? }` | (reused for the modal Download button — see [File Attachments](../file_attachments/file_attachments_tech.md)) |

## Services & Key Methods

- `src/main/services/fileService.ts:readTextPreview()` — source-routed capped read + UTF-8 decode (stream-decode trims a severed codepoint on truncation); throws `FileError('not_found' | 'read_failed')`
- `src/main/services/cinnaFileService.ts:readBytes()` — bearer-authenticated in-memory fetch; logs timing/error; throws `CinnaFileError('download_failed')`
- `src/main/db/chatFiles.ts` — `chatFileRepo.getOwned(userId, attachmentId)` ownership-scoped local-row lookup (reused)

## Renderer State

- `useFilePreviewStore` (Zustand) — the open preview (attachment + kind + text + loading/truncated/error) with a `requestId` staleness guard. One preview at a time
- `useFileDownloadStore` (Zustand) — reused for the modal's Download button
- `CsvPreview` local `useState` — `filters: Record<number, string>` (per-column substring) and `sort: { col, dir } | null`; reset per file via `key={attachment.id}` on `PreviewBody`. `filtersEnabled` lives one level up in `FilePreviewModal` (header toggle ↔ table must agree) and resets on `attachment.id` change

## CSV Parsing & Sorting

- `parseDelimited(text, delimiter)` — single-pass, quote-aware (`""` escape, delimiter and embedded `\n` inside quotes stay in-cell); normalizes `\r\n`/`\r`; flushes the trailing record; caller drops fully-blank records. Delimiter auto-detect: tab when the text has tabs and no commas, else comma
- `compareCells(a, b)` — numeric compare when both cells are non-empty finite numbers, else `localeCompare`
- Sort cycles per header click: none → asc → desc → none. Filtering runs before sorting; both gated on `filtersEnabled`
- Render cap: first `MAX_PREVIEW_ROWS` (500) records; a "Showing first N rows" notice when clipped

## Configuration

- `MAX_PREVIEW_BYTES` = 512 KB (`src/shared/filePreview.ts`) — main-side read cap
- `MAX_PREVIEW_ROWS` = 500 (`FilePreviewModal.tsx`) — CSV table render cap
- Previewable extensions / MIMEs: tables in `src/shared/filePreview.ts` (`txt`, `log`, `md`, `markdown`, `json`, `csv`, `tsv`, `yaml`, `yml`)

## Security

- Byte cap enforced main-side in `fileService.readTextPreview` (passed `MAX_PREVIEW_BYTES` by the IPC handler); the renderer cannot request more
- Same access control as download — `local` gated by `chatFileRepo.getOwned(userId, …)`; `cinna` gated by the backend on the OAuth bearer (owner OR session participant). Preview exposes no file the user couldn't already download
- File bytes are read only in the main process; the renderer receives decoded text over IPC, never a path or raw handle
- No injection surface — `text`/`json` render inside `<pre>{text}</pre>` and CSV cells as `{cell}` (React-escaped); markdown uses the existing `react-markdown` stack (no `rehype-raw`), the same trust boundary already used for chat bubbles

## Observability

- `logger('cinna-files')` — `read` success line (`fileId, bytes, truncated, durationMs`) + `logger.error` on network / non-OK status (mirrors `downloadToPath`)
- Errors cross IPC as `{ success: false, error, code }` via `ipcErrorShape`; the store surfaces `error` in the modal, the Download button keeps its own `useFileDownloadStore` error path
