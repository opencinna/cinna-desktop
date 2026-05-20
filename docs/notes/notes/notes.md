# Notes

## Purpose

A lightweight personal note-taking surface inside the desktop client. Notes are profile-scoped markdown documents the user can create, organize into folders, and inline-edit without switching modes — title and body autosave as the user types. A third sidebar tab (alongside Chats and Jobs) houses the list, and notes follow the same soft-delete / 30-day trash lifecycle chats use.

## Core Concepts

- **Note** — A profile-scoped markdown document with a title, a body, optional folder placement, and a sort position. Storage is raw markdown; the UI renders it via the same `react-markdown` stack chat bubbles use (GFM, syntax highlighting, clickable links open externally).
- **Note Folder** — A user-defined sidebar grouping (profile-scoped, name + collapsed-state + sort position). Thin collapsible separator — owns ordering, not content. A note lives in exactly one folder or at the root.
- **Group** — A bucket the sidebar can address by drag-drop: either the root (`folderId = null`) or a specific folder. Each group keeps its own note ordering.
- **Inline Edit** — There is no edit-mode toggle and no Save button. The title is always an editable heading-styled input; the body shows rendered markdown by default and swaps to a textarea on click, returning to rendered mode on blur. Autosave fires on a 500ms debounce while typing and immediately on blur.
- **Trash** — Soft delete sets `deleted_at`; a note in trash is restorable from the Settings → Trash view alongside trashed chats. A boot-time migration permanently drops trashed notes whose `deleted_at` is older than 30 days, mirroring the chat cleanup.

## User Stories / Flows

### Switching to Notes
1. User clicks the **NotebookPen** icon on the sidebar's left edge tab rail.
2. The sidebar body swaps from Chats / Jobs to the notes list. `activeNoteId` is reset to `null`, and the main area lands on the **"Select a note to view."** empty state — auto-selecting the first note would be misleading when notes can live inside a collapsed folder.
3. Switching back to Chats or Jobs follows the same realignment contract as the Jobs tab.

### Creating a note
1. User clicks the `+` button in the Notes sidebar header.
2. A note is created with placeholder title `Untitled note` and empty body; the main area opens the **Note Detail** view for the new note.
3. The title input is focusable immediately; typing starts the autosave loop.

### Editing a note (inline)
1. From the sidebar, user clicks a note row. Main area renders the read-rendered detail view: title input on top, rendered markdown body below.
2. **Title.** The input is always editable. Each keystroke updates local state; after 500ms of inactivity, autosave persists. Blurring the input also flushes immediately. Whitespace-only titles are normalized to `Untitled note` before persisting (the user is never blocked, but the row stays addressable).
3. **Body.** Click anywhere on the rendered body → it swaps to a focused textarea showing raw markdown. Type. Click outside (or focus another input) → the textarea blurs, the latest body is flushed immediately, and the rendered view reappears with the new content.
4. **Switching notes mid-edit.** Selecting another note in the sidebar before the debounce fires flushes the pending change on the *previous* note before reseeding local state from the new one — unsaved edits cannot get stranded on the wrong row.

### Deleting / restoring a note
1. Hovering a note row in the sidebar reveals a small trash icon on the right. Clicking it soft-deletes the note (sets `deleted_at`) and removes it from the list. There is no confirm modal — the action is reversible from Trash, same as chats.
2. If the deleted note was the active one, `activeNoteId` is cleared; the main area falls back to the "Select a note to view." pane.
3. **Trash** (Settings → Trash) lists trashed chats and notes interleaved in a single chronological view, each row tagged with its kind icon (MessageSquare / NotebookPen). Restore returns the note to the sidebar in its prior folder/position (the row's `deletedAt` is cleared); Permanent Delete hard-removes it. **Empty Trash** drops both chats and notes for the profile.
4. On boot, the notes migration permanently drops any note whose `deleted_at` is older than 30 days.

### Organising notes into folders
1. The Notes sidebar header has two icon buttons: **FolderPlus** (new folder) and **Plus** (new note).
2. Clicking FolderPlus creates a folder named `New folder` at the bottom of the folder list and immediately opens the rename modal so the user can type a real name and confirm.
3. Each folder row is a thin header with a chevron (▶ collapsed / ▼ expanded), the folder name, and a trailing slot showing the count of notes inside when idle. On hover (or while the gear menu is open) the count is replaced by a **gear** icon; the gear menu has **Edit** (rename modal) and **Delete** (confirm modal).
4. **Single click on the header** toggles collapse/expand; the choice persists across launches (`collapsed` on the folder row).
5. **Deleting a folder** is always confirmed. On confirm, the folder row disappears and any notes that lived inside are detached back to the root group (their `folderId` is set to null). Notes are never lost.

### Reordering and moving by drag-and-drop
1. Note rows and folder headers are both drag sources, mirroring the Jobs behavior.
2. **Dragging a note** can drop:
   - **Onto another note row** → reorders within the target's group (inserts before the drop target). Cross-group drops carry the note into the target's folder.
   - **Onto a folder header (or its empty body)** → moves the note INTO that folder, appended to the end.
   - **Onto the root area** (the section under the folder list) → detaches the note from any folder. Only highlighted when the dragged note currently lives in a folder.
3. **Dragging a folder header** onto another folder header → reorders folders (inserts the dragged folder before the target).
4. The renderer constructs the new ordering of the affected group and posts it to the server in one IPC call (`note:reorder` or `noteFolder:reorder`); the server rewrites positions in a single transaction. The list refetches afterwards.

## Business Rules

- **Profile scope.** Notes and note folders live in the active profile's `userId` scope — they don't follow the user across profile switches and are invisible from other profiles.
- **Validation.** `title` must be non-empty on PATCH. The renderer normalizes whitespace-only titles to `Untitled note` before sending, so the user is never blocked while typing. Updates that would null out the title are rejected with `NoteError('invalid_input', ...)`.
- **Inline-edit autosave contract.** Local state lives in `useAutosaveNote`. The hook tracks (a) the last-persisted snapshot per active note id and (b) the note id local state currently reflects. When the user switches notes, the *previous* note id is flushed using the still-in-memory local state before the new note's content is loaded — pending edits cannot leak across notes.
- **Soft delete.** Deleting a note sets `deleted_at`. The note disappears from the sidebar list but remains visible in Trash for 30 days. Restoring clears `deleted_at`.
- **30-day cleanup.** On every app start, the notes migration permanently drops rows with `deleted_at < now - 30 days`. Matches the chat trash retention.
- **Folder delete preserves notes.** Deleting a folder detaches its notes back to the root group (`folderId = null`) in the **same transaction** as the folder row drop — folder deletion can never lose notes even on crash. Note `position` values on the orphaned notes are left untouched (they keep their previous order; the user can re-tidy via drag-drop).
- **Group ordering contract.** `notesRepo.reorderInGroup(userId, targetFolderId, orderedNoteIds)` rewrites every id in the list with `folderId = targetFolderId` and `position = index` in a single transaction. The caller is expected to submit the **full new ordering** of the destination group; partial lists would leave the omitted notes with stale positions. Folder reorder is symmetric.
- **Reorder ownership.** Both `notesService.reorderNotes` and `notesService.reorderFolders` use `notesRepo.countOwned` / `noteFoldersRepo.countOwned` to verify in a single COUNT query that every submitted id belongs to the active profile. A mismatch raises `NoteError('not_found')` before any write.

## Architecture Overview

```
Sidebar
  -> SidebarTabs (notes tab → NotebookPen icon)
       notes tab click -> setActiveNoteId(null) + setActiveView('note-detail')
  -> NotesList

NotesList
  -> Header: FolderPlus (new folder) + Plus (new note)
  -> useNoteList + useNoteFolders, groups notes by folder client-side
  -> NoteFolderRow[] (folders + their notes)
  -> root drop zone (ungrouped notes)
  -> NotesDragContext provider — drag kind/id while a drag is in flight
  -> NoteItem -> useUIStore.setActiveNoteId + setActiveView('note-detail')
  -> NoteItem hover trash -> useDeleteNote (soft-delete)

NoteFolderRow
  -> draggable header (folder reorder source / target)
  -> header drop target: note  → onDropNoteInto  (append note to folder, parent posts new ordering)
                         folder → onReorderFolder (parent rewrites folder positions)
  -> single click → useUpdateNoteFolder({ collapsed: !collapsed })
  -> trailing slot: note count (idle) or Settings gear (hover / menu open)
       gear menu: Edit → NoteFolderEditModal, Delete → confirm modal → useDeleteNoteFolder
  -> empty body (when expanded + empty) accepts a note drop with "Drop a note here" hint

Reorder posting paths
  note moved/reordered  → useReorderNotes.mutate({ targetFolderId, orderedNoteIds })  -> note:reorder
  folder reordered      → useReorderNoteFolders.mutate(orderedIds)                    -> noteFolder:reorder

MainArea (activeView === 'note-detail')
  -> NoteDetail (inline editor)
       -> title input (always editable, autosave on debounce + blur)
       -> body: rendered markdown by default; click → textarea, blur → render
       -> useAutosaveNote owns title/body state, snapshot, cross-note flush

Trash (Settings → Trash)
  -> TrashSection merges useTrashList (chats) + useNotesTrash (notes), sorted by deletedAt desc
  -> per-row Restore + Permanent Delete (kind-aware)
  -> Empty Trash empties both chat trash and notes trash
```

See [Notes — Technical Details](notes_tech.md) for file paths, IPC channel signatures, schema fields, and configuration constants.

## Integration Points

- [App Shell](../../ui/app_shell/app_shell.md) — Sidebar tab rail gains the Notes (NotebookPen) tab alongside Chats and Jobs.
- [Messaging](../../chat/messaging/messaging.md) — Notes reuse the chat trash retention contract (30-day permanent delete) and share the Settings → Trash view.
- [Jobs](../../jobs/jobs/jobs.md) — Folder/drag-drop UX (FolderPlus header button, gear menu, root drop zone, accepting-state visuals) mirrors the Jobs sidebar exactly, including the `application/x-cinna-*` MIME-namespace pattern to keep drags from cross-pollinating between tabs.
- [Note Attachments](../../chat/note_attachments/note_attachments.md) — Notes are also addressable from the chat composer via the `?` mention popup. The chat-side feature owns the composer state and materialization; `notesService.materializeAsAttachments` is the entry point.
- [Settings](../../ui/settings/settings.md) — `TrashSection` is extended to render both chats and notes; the empty-state copy mentions both. No new settings tab — Trash is unchanged from the user's perspective.
