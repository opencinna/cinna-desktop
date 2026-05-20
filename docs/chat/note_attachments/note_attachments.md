# Note Attachments

## Purpose

Attach existing profile notes to a chat message via the composer's `?` mention popup. Selected notes ride into the message as synthetic `.md` file attachments, so the LLM / remote agent receives them through the same attachment plumbing as any other file — no new "note" type leaks past the composer.

## Core Concepts

- **`?` trigger** — Fourth mention trigger character alongside `@`, `#`, `/`. Opens the note picker when typed at the start of the chat input or directly after whitespace.
- **Note picker** — Floating listbox showing profile notes, filtered by **title only** as the user keeps typing. Same shared `MentionPopup<T>` primitive used by the agent / example-prompt / CLI-command pickers.
- **Pending note** — Composer-local reference (id + title) the user has selected but not yet sent. Visually distinct from a file attachment: accent-tinted pill, `NotebookPen` icon, no size column.
- **Note badge** — The pending-note pill itself. Click anywhere to open the preview; trailing X removes it.
- **Note preview modal** — Read-only modal that renders the note's markdown without leaving the chat. Closes on Esc / outside click / X.
- **Synthetic .md** — At send time, each pending note's current body is materialized as a `<safe-title>.md` file routed through the standard file ingest pipeline. The note's *live* body at send time is used, so edits between picking and sending are reflected.

## User Stories / Flows

### Attaching a note

1. User types `?` at the start of the input or after a space. The note picker opens above the textarea (same anchoring as `@` / `#` / `/`).
2. User continues typing to filter the list — only the note **title** is matched; body content is ignored.
3. Arrow Up / Down navigates; Enter or Tab applies the highlighted row, drops the `?token` from the input, and inserts a note badge into the composer's attachment row.
4. Picking the same note again is a silent no-op — duplicates are dropped.
5. Esc closes without applying. Backspacing past the `?` also closes the popup.

### Previewing a note

1. User clicks anywhere on a note badge.
2. A read-only modal opens centered over the current view, showing the note's title and rendered markdown body (same react-markdown stack as chat bubbles).
3. Closes on Esc, outside click, or the X button. The chat composer's pending list is untouched.

### Sending notes with a message

1. With one or more note badges present, the user types text and hits Enter / Send.
2. **Active chat:** each pending note's current body is fetched on the main side, written as `<safe-title>.md` into a fresh tempdir, and routed through `fileService.ingest` under the chat's destination scope. The resulting `MessageAttachment[]` is merged with any file attachments and dispatched.
3. **New chat:** the note ids are deferred alongside file attachments. After the chat row is created and the destination scope is decided, the same materialization runs.
4. After a successful send (or a "Send Anyway" out of a failed rewrite), both note badges and file attachment badges clear from the composer.
5. On a `rewrite-failed` outcome, the badges stay so the user can adjust and retry; on `rewrite-pending`, they clear (the materialized attachments are owned by the pending-rewrite state at that point).

### Removing a note

- Trailing X on the badge drops it from the pending list. No backend call — pending notes are purely composer-local until send time.
- Switching chats wipes the composer's pending notes (mirrors file-attachment behavior).

## Business Rules

- **Trigger gating.** `?` opens the popup only when the profile has at least one note. The trigger respects the same boundary rule as other mentions — start of input or directly after whitespace; `?` in the middle of a word is a literal character.
- **Filter scope.** The popup matches the typed filter against note titles only — body content is not searched, so a common word inside notes doesn't balloon the list.
- **Dedup on add.** Selecting a note that's already pending is a silent no-op; the existing badge is preserved.
- **Late binding to body.** Note title is captured at attach-time (for badge / filename). Note body is fetched on the main side at send time, so edits to the source note between attach and send are reflected in the materialized `.md`.
- **Ownership.** `notesService.materializeAsAttachments` fetches each note via `requireNote`, which enforces profile ownership and rejects deleted notes. A single missing or cross-profile id aborts the whole call before any temp file is created.
- **Empty notes are valid.** A note with an empty body still attaches as an empty `.md`. The user is in control.
- **Filename safety.** Note titles are sanitized to `<allowlist>.md` (alphanumerics, space, dash, underscore, dot) and capped at 80 characters; empty results fall back to `note.md`. `basename()` is re-applied inside `fileService.ingestSyntheticContent` as defense in depth.
- **Scope routing.** Scope mirrors the chat's destination: Cinna-uploaded for any chat with a bound or active remote agent, local-store for raw LLM chats. The new-chat composer defers the decision until the chat row exists.
- **Clearing on success.** Pending notes are cleared on the same outcomes as pending file attachments: `sent`, `rewrite-pending`, the rewrite-confirm second-Enter, and `Send Anyway`. On `rewrite-failed` they remain so the user can retry.
- **No retroactive editing.** The attached `.md` is a frozen snapshot of the note's body at send time. Later edits to the original note do not propagate to messages that already carry the attachment.
- **No persistence of pending notes.** Refreshing or switching chats discards the pending list — they aren't stored on the message row until materialization at send.

## Architecture Overview

```
User types `?` in ChatInput
  -> findTriggerToken detects `?` + filter substring
  -> NoteMentionPopup (filtered by title)
       -> selectNote -> useChatNotes.add({ id, title })

Composer renders NoteBadgeList alongside AttachmentList
  -> Click badge -> NotePreviewModal (read-only markdown render)
  -> X -> useChatNotes.remove(id)

Send pressed
  Active chat:
    useAttachNotesAsFiles.mutateAsync({ chatId, scope, noteIds })
      -> note:attach-as-files IPC
           -> notesService.materializeAsAttachments
                -> requireNote (per id, ownership-checked)
                -> safeNoteFilename(title)
                -> fileService.ingestSyntheticContent(items)
                     -> mkdtemp -> writeFile -> fileService.ingest
      -> noteAttachments concat with file attachments
      -> composer.submit(text, mergedAttachments)

  New chat:
    onNewChat carries noteIds up to startNewChat
      -> createChat -> scope decided
      -> ingestPendingNotes -> same attach IPC
      -> concat with resolved file attachments
      -> startLlm / startAgent
```

## Integration Points

- [Mention Popups](../mention_popups/mention_popups.md) — Adds `?` as a fourth trigger character. Reuses the shared `MentionPopup<T>` primitive and the boundary-rule trigger token detector.
- [Notes](../../notes/notes/notes.md) — Source domain. `notesService` owns ownership checks, the `safeNoteFilename` helper, and the `materializeAsAttachments` entry point.
- [File Attachments](../file_attachments/file_attachments.md) — Sink pipeline. Notes ride the same `MessageAttachment` shape, the same per-scope routing (`local` vs `cinna`), and the same post-send render path; the rest of the chat / adapter stack never sees a "note" type.
- [Messaging](../messaging/messaging.md) — Final send. The composer hook receives notes as ordinary file attachments and routes them via the existing LLM / agent dispatch.

See [Note Attachments — Technical Details](note_attachments_tech.md) for file paths, IPC signatures, service methods, and security notes.
