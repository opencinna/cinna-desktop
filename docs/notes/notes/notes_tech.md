# Notes — Technical Details

## File Locations

### Main process

- `src/main/db/schema.ts` — `notes` (id, userId, title, body, `folderId`, `position`, `deletedAt`, timestamps) and `noteFolders` (id, userId, name, position, collapsed, timestamps) tables.
- `src/main/db/migrations/notes.ts` — `migrateNotes()` — inline-SQL `CREATE TABLE IF NOT EXISTS` for `notes` + `note_folders` with `idx_notes_user_id` + `idx_note_folders_user_id`. Idempotent `ALTER TABLE notes ADD COLUMN folder_id` guarded via `hasColumn`. Boot-time `DELETE FROM notes WHERE deleted_at IS NOT NULL AND deleted_at < <30d threshold>` mirrors the chats cleanup; the threshold is computed in Unix seconds because Drizzle's `mode: 'timestamp'` stores epoch-seconds (using `Date.now()` directly would wipe every trashed row).
- `src/main/db/client.ts` — `migrateNotes(sqlite)` invoked from `runMigrations()` after `migrateJobs` (notes is independent — no FKs to other tables).
- `src/main/db/notes.ts` — `notesRepo` (CRUD + soft delete + `minPositionInFolder` + `countOwned(userId, ids[])` + `reorderInGroup` transaction + trash ops `listTrash` / `restore` / `permanentDelete` / `emptyTrash`) and `noteFoldersRepo` (CRUD + `maxPosition` + `countOwned(userId, ids[])` + `reorder` transaction + `delete` transaction that detaches contained notes to root before dropping the folder row). New notes land at `position = min(position) - 1` of the root group so they appear at the top.
- `src/main/services/notesService.ts` — `notesService` — `list`, `getById`, `create`, `update` (validates title non-empty), `softDelete`, `listTrash`, `restore`, `permanentDelete`, `emptyTrash`, `listFolders`, `createFolder` (trims + validates name non-empty), `updateFolder` (filters patch keys, refetches row), `deleteFolder`, `reorderFolders` (uses `noteFoldersRepo.countOwned` for batch ownership check before delegating to repo; logs `note folders reordered { count }`), `reorderNotes` (validates target folder ownership when non-null, uses `notesRepo.countOwned` for single-query batch ownership check, then calls `notesRepo.reorderInGroup`; logs `notes reordered { targetFolderId, count }`).
- `src/main/ipc/note.ipc.ts` — `registerNoteHandlers()` — all `note:*` and `noteFolder:*` channels wrapped via `ipcHandle()`, each calls `userActivation.requireActivated()` then delegates to `notesService`.
- `src/main/ipc/index.ts` — `registerNoteHandlers()` registered in `registerAllIpcHandlers()` after `registerJobHandlers()`.
- `src/main/errors.ts` — `NoteError` + `NoteErrorCode` (`not_found | not_activated | invalid_input`).

### Shared

- `src/shared/notes.ts` — `NoteData` (carries `folderId: string | null` + `position: number`), `NoteCreateInputDto`, `NotePatchDto`, `NoteFolderData`, `NoteFolderCreateInputDto`, `NoteFolderPatchDto` — imported by both preload and renderer.

### Preload

- `src/preload/index.ts`:
  - `window.api.notes` — `list`, `get`, `create`, `update`, `delete`, `trashList`, `restore`, `permanentDelete`, `emptyTrash`, `reorder(targetFolderId, orderedNoteIds)`.
  - `window.api.noteFolders` — `list`, `create({ name })`, `update(folderId, { name?, collapsed? })`, `delete(folderId)`, `reorder(orderedIds)`.

### Renderer

- `src/renderer/src/components/chat/MessageContextMenu.tsx` — caller of `useSaveMessageNote`; captures the selected transcript text under the pointer. Only while its menu remains mounted does it open the returned note, calling `setSidebarTab('notes')` before `setActiveNoteId` and `setActiveView('note-detail')`.

- `src/renderer/src/stores/ui.store.ts` — adds `'notes'` to `SidebarTab`, `'note-detail'` to `ActiveView`, `activeNoteId: string | null` + `setActiveNoteId`. Not persisted to localStorage at MVP.
- `src/renderer/src/hooks/useNotes.ts`:
  - Query/mutation hooks: `useNoteList`, `useNote(noteId)`, `useCreateNote` (defaults `title: 'Untitled note'`, `body: ''`; **navigates to `'note-detail'` on success** so the new row opens inline-editable immediately), `useUpdateNote`, `useDeleteNote` (soft-delete; clears `activeNoteId` when it matched), `useNotesTrash`, `useRestoreNote`, `usePermanentDeleteNote`, `useEmptyNotesTrash`.
  - `useSaveMessageNote` — captures the current profile synchronously at the user action, passes `{ text, profileId }` to its mutation, checks profile identity before create IPC and after completion, derives the excerpt title/body and invalidates the notes list. A changed profile returns no note; the caller owns whether to navigate. Uses existing `note:create`, without a new schema or channel.
  - Folder hooks: `useNoteFolders` (`['note-folders']` query), `useCreateNoteFolder`, `useUpdateNoteFolder` (also used for the collapse/expand toggle), `useDeleteNoteFolder` (invalidates both `['note-folders']` AND `['notes']` since contained notes detach to root), `useReorderNotes` ({ targetFolderId, orderedNoteIds }), `useReorderNoteFolders` (orderedIds[]).
  - **`useAutosaveNote(note)`** — encapsulates inline-edit state. Returns `{ title, body, setTitle, setBody, flushNow }`. Owns local state, the per-note `snapshotRef` (last-persisted title/body), and a `lastNoteIdRef` tracking which note id local state currently reflects. Two effects: a cross-note switch effect that flushes pending edits on the *previous* note (using the in-memory state) before reseeding from the new note's persisted content, and a debounced autosave effect (`AUTOSAVE_DEBOUNCE_MS = 500`) gated on `lastNoteIdRef.current === note.id` so an in-flight switch never fires a save against the wrong id. `flushNow` skips the debounce — used by input `onBlur` so the rendered view never lags behind. Whitespace-only titles are normalized to `FALLBACK_TITLE = 'Untitled note'` before persisting.
- `src/renderer/src/components/notes/dragContext.ts` — `NotesDragContext` + `useNotesDrag`, carrying `{ kind: 'note' | 'folder', id } | null`. Set on `dragstart`, cleared on `dragend` / `drop`. Distinct from `JobsDragContext` so the two sidebars can't cross-pollinate.
- `src/renderer/src/components/notes/NotesList.tsx` — Sidebar Notes list. Header holds two icon buttons: `FolderPlus` (creates a "New folder" then opens the rename modal via `NoteFolderEditModal` so the user names it immediately) and `Plus` (fires `useCreateNote()`). Reads `useNoteList` + `useNoteFolders`; groups notes client-side into a `{ root: NoteData[], byFolder: Map<folderId, NoteData[]> }` ordered by the server's `position`. Renders `NoteFolderRow[]` followed by a root drop zone that accepts "move out of folder" drops. Provides `NotesDragContext` for child rows.
- `src/renderer/src/components/notes/NoteItem.tsx` — Single row. Active state is `activeNoteId === note.id && activeView === 'note-detail'`. When the row is active and `ui.store.revealNoteId` names its note, an effect calls `scrollIntoView({ block: 'nearest' })` and clears `revealNoteId`. Save to Notes sets that one-shot intent, whose row would otherwise sit below the folders; the row may render only after the list refetch, which the effect covers on mount. An active row remounting without the intent, as in a re-expanded folder, does not scroll (tested in `NoteItem.test.tsx`). Hover reveals a small **Trash2** button that calls `useDeleteNote.mutate(note.id)` (soft-delete to trash) — no confirm modal, mirrors the chat row pattern since trash restore is one click away. Row is `draggable` (drag source for reorder/move); accepts drops of kind `note` from a different row via an optional `onDropNote(draggedNoteId, beforeNoteId)` callback that the parent (NotesList for root, NoteFolderRow for folder bodies) wires up. Drag uses MIME type `application/x-cinna-note`. Source row gets `opacity-40` while it's the active drag; drop target gets `ring-1 ring-inset ring-[var(--color-accent)]`.
- `src/renderer/src/components/notes/NoteFolderRow.tsx` — Collapsible folder row. Header is `draggable` (folder reorder source, MIME `application/x-cinna-note-folder`); accepts drops of kind `note` (moves note into folder; `onDropNoteInto`) or kind `folder` (reorders folder list; `onReorderFolder`). Body shows nested `NoteItem`s when expanded; empty body becomes a dashed "Drop a note here" zone while a `note` drag is in flight. Trailing slot: note count when idle, `Settings` (gear) on hover/menu-open opening an inline Edit/Delete dropdown (Pencil → `NoteFolderEditModal`; Trash2 → frosted-glass confirm modal → `useDeleteNoteFolder`). Single click on the header toggles collapse via `useUpdateNoteFolder.mutate({ collapsed: !folder.collapsed })`.
- `src/renderer/src/components/notes/NoteFolderEditModal.tsx` — Portal-rendered rename modal matching the Jobs version. ESC + click-outside dismiss, Enter submits, auto-focus + select on open. Save calls `useUpdateNoteFolder.mutate({ name })`; no-op if the trimmed name matches.
- `src/renderer/src/components/notes/NoteDetail.tsx` — Inline editor (no edit-mode toggle, no Save button). Reads `useNote(activeNoteId)`, drives `useAutosaveNote(note)` for state. Title is an always-on heading-styled `<input>` (`text-2xl font-semibold`, transparent background, no border). Local `hideDefaultTitle` state gates a **first-focus clear**: `onFocus` flips it on when `title === FALLBACK_TITLE` (imported from `useNotes.ts`); while on, the input's `value` is rendered as `''` even though the underlying `title` state stays `'Untitled note'` (visual-only — no autosave fires, no extra DB write). The flag clears on the first `onChange`, on `onBlur`, and via a `useEffect([activeNoteId])` reset when the user switches notes (re-arms the behavior for each new untitled note). Body has two visual states gated by local `editingBody` state: rendered markdown by default (via `react-markdown` + `remark-gfm` + `rehype-highlight` + the shared `markdownComponents`), with a leading frontmatter block split off by `useFrontmatter(body, 'mb-4')` (`components/ui/FrontmatterTable.tsx`) and rendered as a card inside the `.markdown-body` wrapper, above `<Markdown>` — `NotePreviewModal.tsx` does the same; click on the rendered surface (except on a link, which only opens externally; both pinned in `NoteDetail.test.tsx`) → `setEditingBody(true)` + `requestAnimationFrame` focus + select-to-end on the textarea; `onBlur` → `setEditingBody(false)` + `flushNow()` so the next render shows the freshly-persisted markdown. Empty body falls back to a "Click to start writing…" placeholder. No header actions — delete lives on the sidebar row.
- `src/renderer/src/utils/noteFormat/` — the shared note format, pure and renderer-only (each file has a test beside it):
  - `tags.ts` — port of the read side of cinna-mobile `src/notes/tags.ts`: `findTagsInLine`, `extractTags`, `isValidTag`, `fencedLineMask`, `tagMatchesFilter`. <!-- nocheck -->
  - `tasks.ts` — port of the read side of cinna-mobile `src/notes/tasks.ts`: `TASK`, `TOKEN`, `parseTasks`, `findDueTokens`, `stripTaskTokens`, `formatDueLabel`, `localDateKey`. <!-- nocheck -->
  - `noteIndex.ts` — `isMemoryNote`, `splitNotes`, `noteTags` (frontmatter `tags` then inline), and the mobile-port `tagFilterChips` / `noteIdsForTag`. `memoryInfo` (frontmatter `memory_type`/`summary`) exists and is tested but no surface reads it yet.
  - `remarkNoteFormat.ts` — the remark plugin that draws tag pills and due chips (below).
  - `lineEndings.ts` — `toTextareaValue`, `keepLineEndings`.
- `src/renderer/src/hooks/useNotes.ts:useNoteCollections()` — `useNoteList` split into `regular` and `memory` (memoised on the list); the one hook every notes-listing surface reads (`NotesList`, the `?` picker in `ChatInput.tsx`, `useHintContext.ts`), so a memory note cannot leak into one of them. `NoteMentionPopup.tsx` takes its snippet from `splitFrontmatter(body).body`.
- `src/renderer/src/components/notes/MemoryNotesSection.tsx` — the collapsible **Assistant memory** row and its `NoteItem`s (`draggable={false}`). Expansion is local state, so it is collapsed on every mount. Renders nothing for an empty list.
- `src/renderer/src/components/notes/NoteTagFilter.tsx` — `NoteTagFilterButton` (the `#` menu: `usePopover`, portal, `menuitemradio` rows, arrow/Home/End/Escape handling, nested tags indented under their parent) and `NoteTagFilterRow` (the active-filter chip with clear). `NotesList.tsx` leads the header buttons with the filter so the others do not move when it appears.
- `src/renderer/src/stores/ui.store.ts` (`notesTagFilter` / `setNotesTagFilter`) — the filter as a tag key (a parent key matches nested tags) or null. Survives sidebar tab switches, never persisted. `useAuth.ts` clears it on login, register, logout and user deletion: tag keys belong to the previous profile's notes.
- `src/renderer/src/components/layout/SidebarTabs.tsx` — adds Notes tab (NotebookPen icon) alongside Chats / Jobs. Switching to Notes clears `activeNoteId` and routes to `'note-detail'` (empty pane). `padding-top: 36px` on `.app-sidebar-tabs` keeps the three icons visually inset from the top-bar.
- `src/renderer/src/components/layout/Sidebar.tsx` — Renders `<NotesList />` when `sidebarTab === 'notes'`.
- `src/renderer/src/components/layout/MainArea.tsx` — Routes `activeView === 'note-detail'` to `<NoteDetail />`.
- `src/renderer/src/components/settings/TrashSection.tsx` — Extended to merge chats and notes into a single chronological list (ordered by `deletedAt` desc). Per-row kind icon (`MessageSquare` / `NotebookPen`); restore/permanent-delete use the matching hooks (`useRestoreChat`/`useRestoreNote`, `usePermanentDeleteChat`/`usePermanentDeleteNote`). The **Empty Trash** button empties both chat trash and notes trash for the active profile.

## Shared note format in the read view

- **Nothing stored.** No table, column, IPC channel or sync collection was added for memory, tags or due dates; they are functions of `body`.
- **Tags in a body.** `noteTags(body)` splits the frontmatter off first, then reads frontmatter `tags` (a list, or a text scalar split on commas and whitespace; a leading `#` and trailing `/` dropped, invalid items skipped) and inline tags from the body below the frontmatter, de-duplicated by lower-cased key with the first-seen casing. Reading frontmatter `tags` is a desktop addition (see [Cross-app Note Format](../../sync/data_sync/cross_app_alignment.md#where-the-desktop-differs)).
- **Filter list.** `NotesList.tsx` builds tag rows from the regular notes only (memory notes carry no chips), `tagFilterChips` makes the menu, `noteIdsForTag` the matching set. A filtered view is flat and its rows are not draggable; the memory section is not shown while a filter is set. The open note that matched keeps its row through a `keptOpenRef` while it stays open.
- **The remark plugin** (`remarkNoteFormat.ts`, run after `remark-gfm` in `NoteDetail.tsx` with `tagLinks: true` and in `NotePreviewModal.tsx` without) must agree exactly with the parsers in `tags.ts` / `tasks.ts`, which read raw lines. So it does not re-parse the text nodes: it scans the **raw source** line by line with those parsers (skipping fenced lines, ignoring a trailing `\r`), producing absolute source ranges for tags and strip tokens, and then maps the ranges onto mdast `text` nodes through their `position.offset`s. Pills and chips are mdast nodes with `data.hName: 'span'` and `hProperties` (class names, `data-note-tag`, `data-note-due`, title and aria label), so no rehype plugin is needed. A pill with links on carries `role="button"`, a tab stop and a title; in `NoteDetail` a click or Enter/Space on it sets `notesTagFilter`, switches the sidebar to Notes and reveals a collapsed sidebar (`revealSidebar`), without entering edit mode.
- **Mapping a text node back to the source** (`offsetMap`): if the node's value equals its source slice the map is the identity; otherwise it follows the value through backslash escapes, character references (numeric, hex, named via the browser), and what remark drops from a paragraph's text (spaces before a soft break, indentation and `>` markers after one). It stops at the first character it cannot place. The part of the node past that point is left unformatted.
- **Limits.** A range that is not wholly inside one text node (a tag split by emphasis marks, link text, anything in `code`, `inlineCode`, `html`, `math`) is left as written. Task lines are only formatted when remark also reads them as a task item (`checked` is boolean at the same start line), and a due chip is added only if its token's strip range was actually applied, so a date is never hidden without its chip or shown twice. The chip is appended to the item's first paragraph (or put first in a tight item without one). The plugin returns early when the source has neither `#` nor `[`. A named character reference is decoded through a `textarea` element, so outside a DOM it counts as unplaceable.
- **Today** is the device's local day (`localDateKey`), overridable by the plugin's `today` option for tests; overdue means a date before it on an unchecked task. The overdue chip uses `--color-severity-warning-strong-text` (light `#854d0e`, at least 4.5:1 on the chip's amber tint over any light surface; dark `#fbbf24`), a darker sibling of `--color-severity-warning-text` that brand themes set through the same `status.warning.text` role.
- **Editing.** `NoteDetail.tsx` shows `toTextareaValue(body)` in the textarea and calls `setBody(keepLineEndings(body, next))`. A CRLF body keeps every untouched byte; newlines typed into the edited region take CRLF when the body uses it. The autosave hook is unchanged and still sees the stored body.

## Database Schema

### `notes` table

- `id` TEXT PK
- `user_id` TEXT NOT NULL — profile scope key (per-account)
- `title` TEXT NOT NULL DEFAULT `'Untitled note'`
- `body` TEXT NOT NULL DEFAULT `''` — raw markdown
- `folder_id` TEXT — optional sidebar folder reference (no FK; folder delete sets this to null manually in the same transaction). Null = note sits at the root level.
- `position` INTEGER NOT NULL DEFAULT 0 — sort key within the parent group (folder or root). Lower = top. New notes land at `min(position) - 1` of the root group; drag-drop rewrites every id in the affected group with `position = index`.
- `deleted_at` INTEGER — soft delete timestamp (Unix seconds). Boot-time migration drops rows older than 30 days.
- `created_at`, `updated_at` INTEGER NOT NULL
- Index: `idx_notes_user_id`

### `note_folders` table

- `id` TEXT PK
- `user_id` TEXT NOT NULL — profile scope key (per-account)
- `name` TEXT NOT NULL — trimmed, non-empty (validated in the service)
- `position` INTEGER NOT NULL DEFAULT 0 — sort key for the folder list. New folders land at `max(position) + 1`.
- `collapsed` INTEGER NOT NULL DEFAULT 0 — persisted expand/collapse state, toggled by a single click on the folder header.
- `created_at`, `updated_at` INTEGER NOT NULL
- Index: `idx_note_folders_user_id`
- **No FK from `notes.folder_id`**: folder delete detaches contained notes by SQL UPDATE inside the same transaction as the folder drop (see `noteFoldersRepo.delete`), so adding a FK would only constrain the cleanup the service is already doing explicitly.

## IPC Channels

- `note:list` — `NoteData[]` for the active profile (excludes soft-deleted), ordered by `(position ASC, updatedAt DESC)`.
- `note:get(noteId)` — `NoteData`. Raises `NoteError('not_found')` if missing or trashed.
- `note:create(input?)` — Returns the new `NoteData`. Defaults: `title: 'Untitled note'`, `body: ''`. Lands at the top of the root group.
- `note:update(noteId, patch)` — Returns the updated `NoteData`. `title` (when present) must be non-empty after trim; the renderer normalizes whitespace-only titles before sending.
- `note:delete(noteId)` — `{ success: true }`. Soft delete (sets `deleted_at`).
- `note:trash-list` — `NoteData[]` of trashed notes for the active profile, ordered by `(deleted_at DESC)`.
- `note:restore(noteId)` — `{ success: true }`. Clears `deleted_at`.
- `note:permanent-delete(noteId)` — `{ success: true }`. Hard delete.
- `note:empty-trash` — `{ success: true }`. Hard-deletes all trashed notes for the active profile.
- `note:reorder(targetFolderId: string | null, orderedNoteIds: string[])` — `{ success: true }`. Rewrites the destination group's `(folderId, position)` pairs in a single transaction. Pre-validates ownership of the target folder (when non-null) AND every submitted note id via a single `notesRepo.countOwned` query. Logs `notes reordered { targetFolderId, count }`.
- `noteFolder:list` — `NoteFolderData[]` for the active profile, ordered by `(position ASC, createdAt ASC)`.
- `noteFolder:create({ name })` — `NoteFolderData`. New folder lands at the bottom of the folder list (`position = max + 1`).
- `noteFolder:update(folderId, { name?, collapsed? })` — `NoteFolderData`. Trims name; either field may be patched independently (e.g. the collapse toggle only sends `collapsed`).
- `noteFolder:delete(folderId)` — `{ success: true }`. Detaches contained notes to root (`folderId = null`) in the same transaction as the folder drop — no orphan rows on crash.
- `noteFolder:reorder(orderedIds: string[])` — `{ success: true }`. Pre-validates batch ownership via `noteFoldersRepo.countOwned`, then rewrites positions in a single transaction. Logs `note folders reordered { count }`.

## Services & Key Methods

- `src/renderer/src/hooks/useNotes.ts:useSaveMessageNote()` — `(text, title?)`: a given non-blank title is used as is (a file reference's, from `src/renderer/src/utils/fileNote.ts`); otherwise first nonempty trimmed line, leading Markdown heading removal, 80-character title cap and Chat excerpt fallback. Stored body is captured text verbatim. [Context actions](../../chat/conversation_ui/conversation_ui_tech.md#message-context-actions) define selection and menu lifecycle.

- `src/main/db/notes.ts`:
  - `notesRepo.list/getById/create/update/softDelete` — CRUD with `userId` in WHERE.
  - `notesRepo.minPositionInFolder(userId, folderId | null)` — `SELECT min(position)` filtered by group; used by `create` to land new notes at the top of the root group with `position = min - 1`.
  - `notesRepo.countOwned(userId, ids[])` — single `SELECT count(*) WHERE userId AND id IN (...) AND deleted_at IS NULL`. Used by the service as a batch ownership check before reorder (replaces what would otherwise be an N+1 read loop).
  - `notesRepo.reorderInGroup(userId, targetFolderId, orderedNoteIds)` — single transaction; writes every passed id with `folderId = targetFolderId` and `position = index`. Caller must submit the full ordering of the destination group.
  - `notesRepo.listTrash/restore/permanentDelete/emptyTrash` — trash ops with `userId` in WHERE.
  - `noteFoldersRepo.list/getById/create/update/delete/maxPosition/reorder` — CRUD with `userId` in WHERE. `delete` is a transaction: detach contained notes (`UPDATE notes SET folder_id = NULL WHERE folder_id = ?`) → drop the folder row. `reorder` rewrites `position = index` for every id in a single transaction.
  - `noteFoldersRepo.countOwned(userId, ids[])` — single-query ownership check for folder batches; used by `notesService.reorderFolders`.
- `src/main/services/notesService.ts`:
  - `softDelete(userId, noteId)` — soft delete + log `note moved to trash`.
  - `restore` / `permanentDelete` / `emptyTrash` — trash ops with logger info on each.
  - `reorderNotes(userId, targetFolderId, orderedNoteIds)` — validates target folder ownership (when non-null), then uses `notesRepo.countOwned` to assert every submitted id belongs to the active profile in one query. Raises `NoteError('not_found', 'One or more notes not found')` on mismatch. Logs `notes reordered { targetFolderId, count }`.
  - `reorderFolders(userId, orderedIds)` — symmetric folder reorder; uses `noteFoldersRepo.countOwned` for batch ownership check before delegating to repo. Raises `NoteError('not_found', 'One or more folders not found')` on mismatch.

## Configuration

- Trash retention: 30 days. Cleanup runs on every app start in `migrateNotes()`.
- Autosave debounce: `AUTOSAVE_DEBOUNCE_MS = 500` in `useNotes.ts`.
- Empty-title fallback: `FALLBACK_TITLE = 'Untitled note'` exported from `useNotes.ts` (applied by `useAutosaveNote` before persisting; also imported by `NoteDetail.tsx` for the first-focus clear check so the visual blank and the autosave normalization can never drift).

## Security

- **Excerpt action lifetime.** The profile is captured before React Query schedules the mutation; checks before and after IPC prevent a queued old-profile action from creating under a new profile or changing its cache. Main still resolves and authorizes the active profile. Dismissing a menu does not cancel an already requested note write.

- **Profile scope.** Every `notesRepo` / `noteFoldersRepo` query filters by `userId` (the active profile). Notes and note folders never cross profiles.
- **Reorder authorization.** Both `reorderNotes` and `reorderFolders` use single-query `countOwned` ownership checks before any write — a malicious renderer can't trip the transaction into touching another user's row even by guessing an id.
- **Inline editor.** The renderer never sends an empty title — `useAutosaveNote` normalizes whitespace-only titles to `'Untitled note'` before mutating. The service still enforces non-empty title on PATCH so out-of-band API callers can't bypass it.
- **Logger discipline.** `createLogger('note')`. Logs state transitions (create / soft-delete / restore / permanent delete / empty trash / folder ops) with ids only. Title and body content are NOT logged.
- **No credentials.** Notes are plain markdown — no encryption layer needed; nothing in `notes` or `note_folders` requires `safeStorage`.
- **Trash retention.** Boot-time cleanup is bounded by an absolute timestamp comparison (`deleted_at < now - 30d`), not by row count or paging — no opportunity for a malformed dataset to skip cleanup.
