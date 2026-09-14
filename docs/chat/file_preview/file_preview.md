# File Preview

## Purpose

One read-only modal for looking at a text file **in place**, reached two ways.

**An attachment badge in a chat message.**
- **What previews:** `txt`, `csv`, `md`, `json`, `yaml`/`yml`. These open the modal instead of the save dialog.
- **Download stays:** the modal header keeps a **Download** button, so previewing never replaces saving the file.
- **Everything else downloads:** images, PDF, Office binaries, archives and the rest still go straight to the save dialog. Preview is an extra shortcut, not a new gate.
- **Both directions of attachment:**
  - **User attachments** under a sent user message ([File Attachments](../file_attachments/file_attachments.md)), `cinna` or `local` source.
  - **Agent attachments** under an assistant reply ([Agent Attachments](../agent_attachments/agent_attachments.md)), always `cinna` source.

**A [file reference](../file_references/file_references.md) in a folder agent's chat.** This is an inline code span that names a real file.
- **Open instead of Download:** the file is already on disk, so the header offers **Open folder** and **Open**.
- **More types:** code and config preview as plain text as well.

## Core Concepts

- **Previewable type**: a filename or MIME type the modal knows how to render.
  - `previewKindFor(filename, mimeType)` (`src/shared/filePreview.ts`) maps it to a `PreviewRenderKind` (`markdown`, `json`, `csv` or `text`), or `null` when it is not previewable and should download. The extension wins over the MIME type, because the stores' MIME type is only a best guess.
  - Agent files use `agentFilePreviewKindFor`, which adds code and config as `text` and leaves attachment behaviour unchanged.
- **Preview read path**: the IPC call that reads a file's bytes into memory and returns decoded UTF-8 plus a `truncated` flag.
  - Attachments use `files:read-preview`, and agent files use `agent-files:read-preview`.
  - Both are **capped at `MAX_PREVIEW_BYTES` (512 KB)** in main and use the same truncation-safe decode.
  - The preview read is separate from `files:download`, which writes the *full* file to a path the user chooses.
- **Preview target**: what is open, either an `attachment` or an `agentFile` (an agent id plus the resolved reference).
- **Single global modal**: one `FilePreviewModal` mounted at the app root, driven by `useFilePreviewStore`.
  - Opening a second preview replaces the first.
  - A monotonic `requestId` discards a stale fetch that finishes after the user opened another file or closed the modal.
  - `openSeq` changes on every open, so the entrance plays again.
- **Render kinds**:
  - `markdown` renders through the shared `react-markdown` stack, the same one used by chat bubbles and the note preview.
  - `json` is pretty-printed, falling back to raw text if it does not parse.
  - `csv`/`tsv` renders as a table: quoted fields are honoured (loosely following RFC 4180) and the first 500 rows are shown.
  - `text` (including yaml) is a wrapped `<pre>`.
- **Notice**: a body that is a sentence rather than content. For agent files it is either "Preview is off for credential files." or "No preview for this file type."
- **Header actions**:
  - Attachments get an icon-only Download.
  - Agent files get labelled **Open folder** and **Open** buttons, at the app-chrome type scale.
  - For `csv` only, a **Filter** toggle reveals per-column controls. It is hidden while a notice shows.
- **Entrance**: the card expands from the point the user clicked.
- **Exit**: closing plays the entrance backwards, towards the same point.
- **Header path**: an agent file's display path, beside its name. A click copies it.
- **CSV filter & sort**: when the filter toggle is on, two controls appear.
  - Each column header becomes a click-to-sort control. It cycles none → ascending → descending, and sorts numerically when the values are numbers.
  - A second header row adds a substring filter input per column.

  Filters combine with AND, and sorting applies after filtering. Both are view state in the renderer over the parsed rows; the file itself is never modified.

## User Stories / Flows

### Previewing a previewable attachment
1. The user clicks a `txt` / `csv` / `md` / `json` / `yaml` badge under any message, their own or an agent's.
2. `useAttachmentOpen` gets a non-null `previewKindFor` result, so it calls `useFilePreviewStore.openPreview(attachment, kind)` instead of downloading.
3. The store fetches `files:read-preview`. The modal expands from the badge and shows the rendered content.
4. The user clicks the **Download** icon in the header to save the full file. This is the standard `files:download` save-as flow, through the shared `useFileDownloadStore`, so the spinner and reveal behave exactly as a badge download does.

### Previewing a file an agent named
1. The user clicks a file reference in a folder agent's chat, and main authorizes the path. See [File References](../file_references/file_references.md).
2. The modal expands from the click. Its header shows the file name, its display path, **Open folder**, **Open** and Close. The content comes from `agent-files:read-preview`.
3. **Open** and **Open folder** hand the file to the operating system. A failure appears in a row under the header.
4. Clicking the path beside the file name copies it. A hint under the path says "Copied".

### Filtering & sorting a CSV preview
1. In a `csv`/`tsv` preview, the user clicks the **Filter** icon in the header. A sortable header and a row of filter inputs appear.
2. Typing in a column's input keeps only rows whose cell contains that text, ignoring case. Several column filters combine with AND.
3. Clicking a column header cycles its sort: none → ascending → descending. A column whose cells are all numbers sorts numerically; otherwise it sorts as locale strings.
4. Toggling the Filter icon off restores the raw row order. The controls reset when a different file is previewed.

### Clicking a non-previewable attachment
1. The user clicks a `png` / `pdf` / `zip` / … badge.
2. `previewKindFor` returns `null`, so `useAttachmentOpen` falls through to `download(attachment)`: the existing save dialog, unchanged.

### Large or non-UTF-8 file
1. **Large files:** a previewable file larger than 512 KB shows its first 512 KB, plus a notice under the content.
   - For an attachment: "Preview truncated — download the file to see the full content."
   - For an agent file: "…open the file to see the full content."
2. **Invalid bytes:** invalid byte sequences decode to the replacement character instead of failing, so the modal always shows *something*. Download or Open still gets the exact bytes.

### Closing
1. Escape, the X button, or a press outside the card closes the modal. A press outside within 500 ms of opening is ignored.
2. The card shrinks back towards where it opened while it and the backdrop fade out, as fast as they came in. The page under it takes clicks at once.
3. **Focus:** after a keyboard open, focus returns to whatever held it before, once the fade has ended. After a click open, focus is released and not returned.

## Business Rules

- **Only the attachment click decides preview versus download.** `useAttachmentOpen` is the one place that branches.
  - The shared badge component (`AttachmentBadge`) is unchanged: its tooltip still says "Download", and it knows nothing about preview.
  - This keeps correct the badges used elsewhere that always download, such as cinna task attachments.
- **Preview never modifies anything.** It is read-only: no write-back and no re-upload.
- **The byte cap is enforced in main.** The renderer cannot request more than `MAX_PREVIEW_BYTES`.
  - For attachments, the cap is applied in `fileService.readTextPreview` / `cinnaFileService.readBytes`.
  - For agent files, it is applied in `agentFileService.readPreview`.
- **Attachments have the same access control as download.**
  - `local` requires `chatFileRepo.getOwned`.
  - `cinna` calls `GET /api/v1/files/{id}/download` with the user's OAuth bearer.

  Preview shows no file the user could not already download. Agent files follow main's containment, consent and credential rules instead. See [File References](../file_references/file_references.md).
- **A slow fetch never replaces a newer preview.**
  - `requestId` changes on every open and on close. A finished fetch whose id no longer matches is dropped, so a slow load for file A cannot overwrite the modal now showing file B.
  - An agent-file open that is still waiting on its consent dialog is dropped too, when a newer open of either kind happens. An attachment opened after it is never replaced.

### The entrance
- **It expands from the click.**
  - The card scales from 0.92 to 1 while fading in, over 170 ms, with `transform-origin` at the click point relative to the card. The backdrop fades in with it.
  - A keyboard open grows from the centre.
  - Under reduced motion it only fades.
- **The origin is measured on the card the user will see.** The loading card is a fraction of the size of the loaded one, and an origin measured on it was wrong once the content landed.
  - So a new open keeps the card and backdrop invisible until the first settled state: content, a notice or an error. Only opacity changes; the layout is already final.
  - Then it measures the card and animates.
  - A load slower than 150 ms animates the loading card instead of leaving nothing on screen.
- **Attachments share the entrance.** A badge's click handler has no event to hand over, so the store records the last pointer-down anywhere in the window.
  - A pointer-down within the last second is used as the origin.
  - An older one means the open came from the keyboard.

### The exit
- **Closing plays the entrance backwards.**
  - The card scales from 1 to 0.92 towards the point it expanded from, fading out as it goes, and the backdrop fades with it.
  - It uses the entrance's 170 ms and easing, short enough never to be waited on, so closing is no slower than opening.
  - Under reduced motion it only fades.
- **The store closes at once; the modal holds a snapshot.** `close()` resets the store straight away, so a fetch still in flight is dropped and nothing reads a half-closed preview. The modal keeps rendering the last open preview until the fade ends, then unmounts.
- **A fading preview is already closed.** Clicks pass through it to the page, and Escape and outside presses no longer act on it.
- **A new open during the fade cancels the fade**, and the new preview plays its own entrance.
- **Focus comes back when the fade ends**, not at the press, and still only after a keyboard open.

### The card is pinned to the top
- **It sits a tenth of the viewport down**, at most 80% of the viewport tall, rather than centred.
- **Why:** the card only grows downward, so content landing, a notice or an error row appearing never moves the button the user just pressed. This applies to attachments and agent files alike.

### Focus
- **Focus moves into the card** once the entrance starts, so Tab reaches its buttons.
- **The scrolling body can be tabbed to**, and shows the accent focus ring rather than Chromium's default.
- **Focus goes back only after a keyboard open.** Once the close has faded out, it returns to the element that had it before the first open, as long as that element is still in the document. Replacing a preview keeps the original element.
- **After a click open, focus is released.** A link given focus back would show its focus-visible ring once the user closed with Escape, so the card's focus is simply released instead.
- **A backdrop press cannot take focus.** Its default is prevented, so closing does not pull focus onto the page after it was handed back.

### Outside presses straight after an open
- **Ignored for 500 ms after every open**, including an open in an error state. Such a press neither closes the modal nor moves focus.
- **Why:** the second press of a double-click on a link lands on the overlay the first click just opened, and closed it again.
- **The cost:** it also swallows a deliberate dismiss in that half-second, which is accepted.

### Agent-file states
- **The body** shows one of: loading, content, a notice (credential or unsupported), or an error.
- **Error copy:**
  - a failed read: "Couldn't load preview: …";
  - a file that has gone: "That file is no longer there.";
  - a folder that has gone: "That folder is no longer there.";
  - a failed folder reveal: "Couldn't show it in its folder: …", or main's own sentence when that already names the action.
- **A folder reaches the modal only when showing it failed.** It shows a folder icon, its name and path, and no file actions.
- **Open and Open folder are disabled while the body says the file has gone.** They could only fail, and their error would repeat the body, so a click would look like it did nothing.
- **A failed header action** is named in a row under the header: "Couldn't open it: …", "Couldn't show it in its folder: …", or main's own sentence when that names the action already.
  - It closes nothing ([UX rule 6](../../development/ui_guidelines/ux_rules.md)).
  - The row is hidden when the body already shows the same failure.

### The header path
- **The display path** next to the file name is left out when it equals the name, as it does for a file at the top of the agent folder. The name and the path each have a tooltip for when they are cut off.
- **A click copies the path exactly as shown**: agent-relative inside the agent folder, `~/…` or absolute outside it. Only an agent file has a path; an attachment's header shows none.
- **A hint under the path says what a click does.**
  - Hovering or focusing the path shows "Click to copy".
  - A click turns it into "Copied", or "Couldn't copy" when the clipboard refuses. It fades out 1.2 s later.
- **After a copy, the hint stays hidden until the pointer leaves** or focus moves away. It would otherwise flip straight back to "Click to copy" under a pointer that has not moved. Its words hold while it fades.
- **The hint floats.** It is absolutely positioned under the path, over whatever is below, so showing it moves nothing ([UX rule 1](../../development/ui_guidelines/ux_rules.md)).

### Tables
- **Preview tables have zebra rows.** A CSV table, and any table inside a previewed markdown file, shade every other body row a step darker than the card, starting with the first row. Chat tables are not striped.
- **The stripes follow the rows on screen**, not their order in the file, so filtering or sorting a CSV keeps them alternating.
- **Header rows are not striped**, the CSV filter row included.

## Architecture Overview

```
Badge click (MessageBubble user badge | AgentAttachment):
  AttachmentList onClick → useAttachmentOpen(attachment)
    previewKindFor(filename, mime)
      → null     → useFileDownloadStore.download(attachment)   [save-as]
      → kind     → useFilePreviewStore.openPreview(attachment, kind)   origin = last pointer-down (≤ 1 s)
                     → window.api.files.readPreview({ fileId, source })
                        → files:read-preview IPC
                           → fileService.readTextPreview (cap = MAX_PREVIEW_BYTES)
                              local : chatFileRepo.getOwned + readFile (capped)
                              cinna : cinnaFileService.readBytes (GET /files/{id}/download, capped)
                           → decodePreviewText → { text, truncated }
                     → FilePreviewModal renders by kind (markdown|json|csv|text)
                        header Download → useFileDownloadStore.download (full file)

File reference click (folder agent chat):
  useFilePreviewStore.openAgentFile(agentId, ref, click point)
    → agent-files:authorize → agent-files:read-preview → FilePreviewModal
       header Open folder → agent-files:reveal · Open → agent-files:open

FilePreviewModal (both):
  hidden until settled (≤ 150 ms) → measure card → expand from origin → focus card
  close: Escape | X | outside press (after 500 ms)
    → store closed at once → last open state plays the entrance backwards (170 ms, clicks reach the page)
    → unmount → focus back only after a keyboard open
```

For file paths, IPC signatures and method-level detail see [File Preview — Technical Details](file_preview_tech.md).

## Integration Points

- [File Attachments](../file_attachments/file_attachments.md): user-uploaded badges route through `useAttachmentOpen`, and preview reuses the same `cinna`/`local` source split.
- [Agent Attachments](../agent_attachments/agent_attachments.md): agent-attached badges preview too; they used to be download-only.
- [File References](../file_references/file_references.md): the second way into this modal. It covers resolution, consent, credential files and the Open strategy.
- [Note Attachments](../note_attachments/note_attachments.md): a separate preview surface, `NotePreviewModal`, which shows a live note body at the composer stage. This feature previews files already sent or on disk.

## Future Enhancements (Out of Scope)

- **Image / PDF preview**: render image bytes and PDF pages inline. Today they download, or open in their system app for an agent file.
- **Syntax highlighting for code** (`.py`, `.ts`, …): code attachments still download, and agent files show code as plain text.
- **Copying the file's content** from the preview modal: only an agent file's header path copies today.
- **A dialog role and a focus trap**: today, Shift+Tab from the card walks back into the page.

---

*Last updated: 2026-09-14*
