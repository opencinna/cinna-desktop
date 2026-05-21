# Note Attachments — Technical Details

## File Locations

### Main process
- `src/main/ipc/note.ipc.ts` — `note:attach-as-files` IPC handler (thin controller)
- `src/main/services/notesService.ts` — `materializeAsAttachments`, `safeNoteFilename` helper
- `src/main/services/fileService.ts` — `ingestSyntheticContent` (temp-file orchestration + ingest delegation)
- `src/main/services/fileStore.ts` — `localFileStore.ingest` (final write path for local scope)
- `src/main/services/cinnaFileService.ts` — `uploadMany` (final upload path for Cinna scope)
- `src/main/db/notes.ts` — `notesRepo.getById` (ownership-filtered fetch consumed by `requireNote`)

### Shared
- `src/shared/notes.ts` — `NoteAttachAsFilesInputDto`, `NoteAttachAsFilesResultDto`
- `src/shared/attachments.ts` — `MessageAttachment` (the shape produced by the ingest)

### Preload
- `src/preload/index.ts` — `window.api.notes.attachAsFiles(data)` bridge

### Renderer
- `src/renderer/src/components/chat/NoteMentionPopup.tsx` — `?` trigger popup (wraps shared `MentionPopup<NoteData>`)
- `src/renderer/src/components/chat/NoteBadge.tsx` — `NoteBadge`, `NoteBadgeList`
- `src/renderer/src/components/notes/NotePreviewModal.tsx` — portal-rendered read-only modal (`react-markdown` + `remarkGfm` + `rehypeHighlight`)
- `src/renderer/src/components/chat/ChatInput.tsx` — trigger plumbing, badge rendering, send-time materialization, rewrite-path clearing
- `src/renderer/src/hooks/useNotes.ts` — `useAttachNotesAsFiles` (`useMutation` wrapping the attach IPC), `useFetchNote` (imperative single-note fetcher used by the double-Enter expansion)
- `src/renderer/src/hooks/useChatNotes.ts` — composer-local note buffer keyed by chatId (mirrors `useChatAttachments`)
- `src/renderer/src/hooks/useNewChatFlow.ts` — `ingestPendingNotes` (deferred materialize on chat creation)

## Database Schema

No new tables. The feature reads from the existing `notes` table (see [Notes — Technical Details](../../notes/notes/notes_tech.md)) and writes through the existing file-attachment stores — `chat_files` for local scope, the Cinna backend's file API for remote scope.

## IPC Channels

- `note:attach-as-files` — Materialize a list of notes as real attachments.
  - Input: `NoteAttachAsFilesInputDto` = `{ chatId: string | null; scope: 'cinna' | 'local'; noteIds: string[] }`
  - Output: `NoteAttachAsFilesResultDto` = `{ success: true; files: MessageAttachment[] } | { success: false; error: string; code?: string }`

## Services & Key Methods

- `src/main/ipc/note.ipc.ts:registerNoteHandlers()` — Wires every `note:*` handler including `note:attach-as-files`. The handler itself is a thin controller: `requireActivated → assertFileScope → notesService.materializeAsAttachments → return`.
- `src/main/services/notesService.ts:materializeAsAttachments(userId, { chatId, scope, noteIds })` — Per-id `requireNote(userId, id)` (rejects missing / deleted / cross-profile) before any I/O, maps to `{ filename, content }` items, delegates to `fileService.ingestSyntheticContent`. Emits a `materializing notes as attachments` log line with scope / chatId / count.
- `src/main/services/notesService.ts:safeNoteFilename(title)` — `<allowed>.md` sanitizer; collapses spaces, caps at 80 characters, falls back to `note.md` for empty input.
- `src/main/services/fileService.ts:ingestSyntheticContent(opts)` — Pre-checks `scope === 'local'` requires `chatId`, creates a `cinna-synth-*` tempdir via `mkdtemp`, writes each item, calls `this.ingest`, removes the tempdir in `finally`. Logs `synthetic content ingested` with scope / chatId / count / durationMs.
- `src/main/services/fileService.ts:ingest(input)` — Existing entry point. Local scope verifies `chatRepo.getOwned`; Cinna scope delegates to `cinnaFileService.uploadMany`.

## Renderer Components

- `src/renderer/src/components/chat/NoteMentionPopup.tsx` — Thin wrapper around `MentionPopup<NoteData>` with header `Notes`, `NotebookPen` icon, `w-80` width, title as primary, truncated body (140-char) as secondary with 2-line clamp.
- `src/renderer/src/components/chat/NoteBadge.tsx` — Accent-tinted compact pill; click opens the preview, trailing X removes. Renders `NotebookPen` icon and truncated title (no size — distinguishes from file badges visually).
- `src/renderer/src/components/notes/NotePreviewModal.tsx` — Portal-rendered modal (`max-w-2xl`, `max-h-80vh`); loads the note via `useNote(noteId)` so previewing reflects the latest body. Renders with the same `Markdown` + `remarkGfm` + `rehypeHighlight` + `markdownComponents` stack used by chat bubbles. Closes on Esc, outside click, or X.
- `src/renderer/src/components/chat/ChatInput.tsx`:
  - `findTriggerToken` extended to recognize `?` alongside `@`, `#`, `/`.
  - `useChatNotes(chatId)` provides the composer-local buffer; `useAttachNotesAsFiles()` provides the mutation.
  - `selectNote` drops the `?token` from the textarea, calls `addPendingNote`, and arms `pendingExpansionNoteId` for the double-Enter shortcut.
  - `pendingExpansionNoteId` is a single-id local state cleared by typing (`handleInput`), removing the targeted badge (`handleRemovePendingNote`), chat switch (the same `useEffect` that resets `previewNoteId`), or the expansion itself.
  - `handleSend`: first branch is the double-Enter check — when `pendingExpansionNoteId` is armed, `trimmed.length === 0`, and `rewriteUX.state === 'idle'`, **disarms the id and removes the note from the pending buffer synchronously** (so a re-entrant Enter during the fetch can't fall through to the attachment-only send path), then awaits `fetchNote(id)`, calls `setInput(note.body)`, refocuses + resizes the textarea, and returns early. On fetch failure the error surfaces via `setAttachError('Note: …')` and the user can re-attach via `?`. Otherwise on active chat it awaits `attachNotesAsync` then concats results into `mergedAttachments` before `composer.submit`; on new chat, threads `noteIds` through `onNewChat`.
  - `handleSendAnyway`, the rewrite-confirm branch, and the `'sent' | 'rewrite-pending'` success branches all call `clearPendingNotes()` alongside `clearPendingAttachments()`.
- `src/renderer/src/hooks/useNotes.ts:useAttachNotesAsFiles()` — `useMutation` wrapping `window.api.notes.attachAsFiles`. Rejects with `Error(result.error)` on `success: false` so callers can `try/await`.
- `src/renderer/src/hooks/useNotes.ts:useFetchNote()` — Imperative single-note fetcher for event handlers. Returns a `(noteId) => Promise<NoteData>` callback that delegates to `queryClient.fetchQuery` against the same `['notes', id]` cache key as `useNote`, so a recently previewed note hits cache. Used by the composer's double-Enter expansion.
- `src/renderer/src/hooks/useChatNotes.ts:useChatNotes(chatId)` — Mirrors `useChatAttachments` structurally: `{ notes, add, remove, clear }`. `useEffect([chatId])` wipes the buffer on chat switch. `add` dedups by id.
- `src/renderer/src/hooks/useNewChatFlow.ts:ingestPendingNotes()` — Calls the same `attachNotesAsync` mutation, concatenated with resolved file attachments before `startLlm` / `startAgent`.

## Configuration

- No new settings. The feature follows the chat's existing destination-scope logic (Cinna vs local) — see [File Attachments](../file_attachments/file_attachments.md).
- Synthetic tempdirs live at `${os.tmpdir()}/cinna-synth-*`, created and removed per call. No persistent cleanup task is needed because the directory is always removed in `ingestSyntheticContent`'s `finally`.

## Security

- **Ownership chain.** Renderer supplies only `noteIds`. The main process enforces in order:
  1. `userActivation.requireActivated()` at handler entry.
  2. `notesService.materializeAsAttachments` runs `requireNote(userId, id)` per id — fails fast on missing / soft-deleted / cross-profile.
  3. `fileService.ingest` runs `chatRepo.getOwned(userId, chatId)` for local scope.
- **No renderer path injection.** Synthetic file paths are generated inside `fileService.ingestSyntheticContent` via `mkdtemp` — the renderer never supplies a path, so the `pathGuard` allowlist is intentionally bypassed.
- **Filename sanitization.** `safeNoteFilename` strips path separators and shell-hostile characters; `fileService.ingestSyntheticContent` re-applies `basename()` before writing as defense in depth.
- **Attach pipeline keeps body in main.** When notes are materialized as `.md` attachments, body bytes travel SQLite → main-process tempfile → ingest pipeline. The renderer only sees the resulting `MessageAttachment` (id, filename, size, mimeType, source) — never the body via that path. The body *is* fetched into the renderer for two intentional flows (`useNote` for the preview modal, `useFetchNote` for the double-Enter inline expansion), both gated by `notesService.requireNote`'s ownership check at the `note:get` IPC.
- **Tempdir lifecycle.** A failure mid-write still triggers the `finally rm(dir, { recursive: true, force: true })`, so no synthetic bytes persist on disk after an error.
