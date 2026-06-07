# File Preview

## Purpose

Lets the user inspect a small set of text-based attachments **in place** —
without a save-as round-trip — by clicking the attachment badge in a chat
message. Supported formats (`txt`, `csv`, `md`, `json`, `yaml`/`yml`) open a
read-only modal that renders the decoded content; the modal header keeps a
**Download** button so previewing never replaces the ability to save the file.
Any other format (images, PDF, Office binaries, archives, …) still goes
straight to the save dialog on click — preview is an additive shortcut, not a
new gate.

This applies symmetrically to both directions of attachment:

- **User attachments** under a sent user message ([File Attachments](../file_attachments/file_attachments.md)) —
  `cinna` or `local` source.
- **Agent attachments** under an assistant reply ([Agent Attachments](../agent_attachments/agent_attachments.md)) —
  always `cinna` source.

## Core Concepts

- **Previewable type** — A filename/MIME the modal knows how to render.
  `previewKindFor(filename, mimeType)` (`src/shared/filePreview.ts`) maps to a
  `PreviewRenderKind` (`markdown` | `json` | `csv` | `text`) or `null`
  (not previewable → download). Extension wins over MIME because the stores'
  MIME is a best-effort guess.
- **Preview read path** — A separate IPC (`files:read-preview`) that streams the
  attachment's bytes into memory **capped at `MAX_PREVIEW_BYTES` (512 KB)** and
  returns decoded UTF-8 + a `truncated` flag. Distinct from `files:download`,
  which writes the *full* file to a user-chosen path. Same source routing
  (`cinna` backend bearer fetch vs. `local` disk read) and same access control.
- **Single global modal** — One `FilePreviewModal` mounted at the app root,
  driven by `useFilePreviewStore`. Opening a second preview replaces the first;
  a monotonic `requestId` discards a stale fetch that resolves after the user
  reopened a different file or closed the modal.
- **Render kinds** — `markdown` renders through the shared `react-markdown`
  stack (same as chat bubbles / note preview); `json` pretty-prints (falls back
  to raw text if it doesn't parse); `csv`/`tsv` renders an RFC-4180-ish table
  (quoted fields honored, first 500 rows); `text` (incl. yaml) is a wrapped
  `<pre>`.
- **Header actions** — Icon-only buttons. Download (always) reuses the standard
  save-as flow. For `csv` only, a **Filter** toggle (left of Download) reveals
  per-column controls.
- **CSV filter & sort** — When the filter toggle is on, each column header
  becomes a click-to-sort control (cycles none → asc → desc, numeric-aware) and
  a second header row exposes a per-column substring filter input. Filters AND
  together; sorting applies after filtering. Both are client-only view state
  over the parsed rows — the underlying file is never modified.

## User Stories / Flows

### Previewing a previewable attachment
1. The user clicks a `txt` / `csv` / `md` / `json` / `yaml` badge under any
   message (their own or an agent's).
2. `useAttachmentOpen` resolves `previewKindFor` → non-null, so it calls
   `useFilePreviewStore.openPreview(attachment, kind)` instead of downloading.
3. The store fetches `files:read-preview`; the modal shows a loading state,
   then the rendered content. Esc / outside-click / X closes it.
4. The user clicks the **Download** icon in the header to save the full file —
   the standard `files:download` save-as flow (shared `useFileDownloadStore`),
   so the spinner and reveal behave exactly like a badge download.

### Filtering & sorting a CSV preview
1. In a `csv`/`tsv` preview the user clicks the **Filter** icon (header, left of
   Download). Per-column controls appear: a sortable header + a filter input row.
2. Typing in a column's input filters rows to those whose cell contains the
   substring (case-insensitive); multiple column filters AND together.
3. Clicking a column header cycles its sort none → ascending → descending
   (numeric when the column's cells are all numbers, otherwise locale string).
4. Toggling the Filter icon off restores the raw row order; the controls reset
   when a different file is previewed.

### Clicking a non-previewable attachment
1. The user clicks a `png` / `pdf` / `zip` / … badge.
2. `previewKindFor` → `null`, so `useAttachmentOpen` falls through to
   `download(attachment)` — the existing save dialog, unchanged.

### Large or non-UTF-8 file
1. A previewable file larger than 512 KB previews its first 512 KB; the modal
   shows a "Preview truncated — download for the full content" notice.
2. Invalid byte sequences decode to the replacement character rather than
   erroring, so the modal always shows *something*; Download still gets the
   exact bytes.

## Business Rules

- **Routing decision is purely client-side** — `useAttachmentOpen` is the only
  place that branches preview-vs-download. The shared badge component
  (`AttachmentBadge`) is unchanged and still labels its tooltip "Download"; it
  doesn't know about preview. This keeps badges used elsewhere that download
  unconditionally (e.g. cinna task attachments) correct.
- **Preview never mutates** — read-only. No write-back, no re-upload.
- **Byte cap is enforced main-side** — the renderer can't request more than
  `MAX_PREVIEW_BYTES`; the cap is applied in `fileService.readTextPreview` /
  `cinnaFileService.readBytes`, not trusted from the renderer.
- **Same access control as download** — `local` requires `chatFileRepo.getOwned`;
  `cinna` hits `GET /api/v1/files/{id}/download` with the user's OAuth bearer.
  Preview surfaces no file the user couldn't already download.
- **Stale-fetch guard** — `requestId` bumps on every open and on close; a
  resolved fetch whose id no longer matches is dropped, so a slow load for file
  A can't clobber the modal now showing file B.

## Architecture Overview

```
Badge click (MessageBubble user badge | AgentAttachment):
  AttachmentList onClick → useAttachmentOpen(attachment)
    previewKindFor(filename, mime)
      → null     → useFileDownloadStore.download(attachment)   [save-as]
      → kind     → useFilePreviewStore.openPreview(attachment, kind)
                     → window.api.files.readPreview({ fileId, source })
                        → files:read-preview IPC
                           → fileService.readTextPreview (cap = MAX_PREVIEW_BYTES)
                              local : chatFileRepo.getOwned + readFile (capped)
                              cinna : cinnaFileService.readBytes (GET /files/{id}/download, capped)
                           → TextDecoder('utf-8') → { text, truncated }
                     → FilePreviewModal renders by kind (markdown|json|csv|text)
                        header Download → useFileDownloadStore.download (full file)
```

For file paths, IPC signatures, and method-level detail see
[File Preview — Technical Details](file_preview_tech.md).

## Integration Points

- [File Attachments](../file_attachments/file_attachments.md) — User-uploaded badges now route through `useAttachmentOpen`; preview reuses the same `cinna`/`local` source split.
- [Agent Attachments](../agent_attachments/agent_attachments.md) — Agent-attached badges preview too (previously download-only).
- [Note Attachments](../note_attachments/note_attachments.md) — Independent preview surface (composer-stage `NotePreviewModal` over a live note body); this feature previews *sent* file attachments by reading stored bytes.

## Future Enhancements (Out of Scope)

- **Image / PDF preview** — render image bytes and PDF pages inline (today they
  download).
- **Syntax highlighting for code attachments** (`.py`, `.ts`, …) — currently
  download-only; could join the `text` kind with a highlighter.
- **Copy-to-clipboard** from the preview modal.

---

*Last updated: 2026-06-07*
