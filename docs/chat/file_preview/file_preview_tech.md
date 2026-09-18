# File Preview — Technical Details

## File Locations

### Shared (cross-process)
- `src/shared/filePreview.ts`:
  - `previewKindFor(filename, mimeType)` → `PreviewRenderKind | null`, and `isPreviewable(filename, mimeType)`.
  - The `PreviewRenderKind` type (`'markdown' | 'json' | 'csv' | 'text'`) and `MAX_PREVIEW_BYTES` (512 KB).
  - The extension table wins over the MIME table. The extension is parsed inline, without Node `path`, because the sandboxed renderer imports this file.
  - `decodePreviewText(bytes, truncated)` decodes UTF-8. When `truncated`, it decodes with `{ stream: true }` and skips the final flush, so a multi-byte sequence cut by the cap is dropped (no trailing `�`). Attachment reads and agent-file reads both use it.
- `src/shared/attachments.ts`:
  - `MessageAttachment` is the shape preview consumes: id, filename, size, mimeType, `source?`.
  - `agentFileToAttachment(file)` adapts an agent `MessagePartFile` into it; the preview/download click router reuses it.
- `src/shared/agentFiles.ts`: `agentFilePreviewKindFor`, `isCredentialFilePath`, `agentFileName`, and the `agent-files:*` result types. See [File References — Technical Details](../file_references/file_references_tech.md).

### Main process — services
- `src/main/services/fileService.ts`:
  - `readTextPreview({ userId, attachmentId, source, maxBytes })`: reads into memory, routed by source.
    - `local` = `chatFileRepo.getOwned` + `readFile`, then `subarray(0, maxBytes)`.
    - `cinna` = `cinnaFileService.readBytes`.

    Decodes with `decodePreviewText` and returns `{ text, truncated }`.
  - `assertFileScope(value)`: reused to narrow the renderer-supplied `'cinna' | 'local'`.
- `src/main/services/cinnaFileService.ts`:
  - `readBytes(userId, fileId, maxBytes)`: `net.fetch GET /api/v1/files/{fileId}/download` with the OAuth bearer. Reads `arrayBuffer()` and returns `{ bytes: Buffer (capped), truncated }`.
  - Logs a `read` success line (`fileId, bytes, truncated, durationMs`), and `logger.error` on a network failure or non-OK status.
  - In memory only; never writes to disk, unlike `downloadToPath`.
- `src/main/services/agentFiles/agentFileService.ts`: `readPreview()` reads an agent file, after the containment, consent and credential checks. Documented with [File References](../file_references/file_references_tech.md).

### Main process — DB (reused, no new tables)
- `src/main/db/chatFiles.ts`: `chatFileRepo.getOwned(userId, attachmentId)`, an ownership-scoped lookup for the `local` read path.

### Main process — IPC
- `src/main/ipc/files.ipc.ts`:
  - `files:read-preview`: a thin controller. Calls `userActivation.requireActivated()` → `getProfileScopeUserId()` → `assertFileScope` → `fileService.readTextPreview({ maxBytes: MAX_PREVIEW_BYTES })`. Returns `{ success, text, truncated }`, or `{ success: false, error, code }` via `ipcErrorShape`.
  - Reuses the existing `files:download` for the modal's Download button; there is no new download channel.
- `src/main/ipc/agent_files.ipc.ts`: the five `agent-files:*` channels an agent-file preview uses.

### Preload
- `src/preload/index.ts`:
  - `window.api.files.readPreview({ fileId, source? })` → `ipcRenderer.invoke('files:read-preview', …)`. The return type is the success/error union, inferred into `API = typeof api` and surfaced through `src/preload/index.d.ts`.
  - `window.api.agentFiles.*` serves agent files.

### Renderer — store / hook
- `src/renderer/src/stores/filePreview.store.ts`: `useFilePreviewStore` (Zustand).
  - **What is open:**
    - `target`: `{ type: 'attachment', attachment }` or `{ type: 'agentFile', agentId, ref }`;
    - `attachment`: set for attachment targets only;
    - `kind`, `text`, `isLoading` and `truncated`.
  - **What went wrong:**
    - `error` and `errorCode`;
    - `failedStep`: `authorize`, `preview` or `reveal`;
    - `notice`: `credential` or `unsupported`.
  - **The entrance:** `origin` (`{x, y}`, or null for a keyboard open) and `openSeq`.
  - **Guards and actions:** `requestId`, `pendingAction` and `actionError`.
  - `openPreview(attachment, kind)`: the signature is unchanged.
    1. Takes `origin` from `recentPointer()`: the last `pointerdown` recorded by a window capture-phase listener, if it is at most `POINTER_ORIGIN_MAX_AGE_MS` old.
    2. Bumps `openSeq`, and bumps `agentOpenToken` so a pending agent-file open cannot replace it.
    3. Fetches under `requestId`.
  - `openAgentFile`, `openAgentFileExternally` and `revealAgentFile`: see [File References — Technical Details](../file_references/file_references_tech.md).
  - `agentFileErrorText`, `actionErrorText` and `actionErrorRepeatsBody`: the error copy the modal renders.
  - `close()`: resets to `closedState` and bumps `requestId`, so any fetch still in flight is discarded. The store closes at once; the fade-out belongs to the modal, which renders a snapshot.
- `src/renderer/src/hooks/useAttachmentOpen.ts`: `useAttachmentOpen()` returns `(attachment) => void`. It calls `previewKindFor`, then `openPreview` for a previewable file or `useFileDownloadStore.download` for everything else. This is the single branch point between preview and download.
- `src/renderer/src/stores/fileDownload.store.ts`: `useFileDownloadStore`, reused unchanged for the modal's Download button (shared spinner and error state).

### Renderer — components
- `src/renderer/src/components/chat/FilePreviewModal.tsx`: a single global modal, rendered with `createPortal` into `document.body`.
  - **Layout:**
    - the overlay is `items-start pt-[10vh]`;
    - a separate backdrop layer (`backdropRef`);
    - the card (`cardRef`, `tabIndex={-1}`, `max-h-[80vh]`).
  - **Header**, in order:
    1. the title icon (`FileText`, or `Folder` for a folder);
    2. the filename, with a `title`;
    3. `CopyablePath`: the agent file's display path, when it differs from the name;
    4. the CSV Filter toggle, not shown with a notice;
    5. for agent files, **Open folder** / **Open** (`HEADER_ACTION_CLASS`), disabled while `pendingAction` is set or while `fileGone` is true;
    6. for attachments, Download;
    7. Close.
  - **Action error row:** `role="alert"`, rendered unless `actionErrorRepeatsBody` says it would repeat the body.
  - **Body:** loading, then an error (`agentFileErrorText`, or "Couldn't load preview: …" for an attachment), then a notice, then `PreviewBody`. The truncation copy depends on the target.
  - `useCardEntrance({ cardRef, backdropRef, open, openSeq, settled })`:
    - **On each open:**
      - records whether the open came from the keyboard;
      - records the element to give focus back to (kept across a replaced preview);
      - hides the card and backdrop with inline `opacity: 0`, when `Element.animate` exists;
      - starts an `ENTRANCE_WAIT_MS` timer.

      A second layout effect calls `start()` once `settled` (`!isLoading`).
    - **`start()` runs once per open:**
      1. reads the card rect and sets `transform-origin` (or `center`);
      2. runs the WAAPI `ENTRANCE` animation (170 ms, `cubic-bezier(0.2, 0, 0, 1)`) on the card and backdrop, opacity only under `prefers-reduced-motion`;
      3. focuses the card with `preventScroll`.
    - **Cleanup** cancels running animations. The close cleanup gives focus back only after a keyboard open; it runs when the exit ends, not when the store closes.
  - **The exit**, in the modal body:
    - `lastOpen`: a ref to the store state, updated in a layout effect after every render that has a target.
    - `prevTarget` and `exitView`: state adjusted during render. When `target` goes from set to null, `exitView` takes `lastOpen.current`; any other change of `target` clears it.
    - `exiting`: the store is closed and `exitView` is set. The modal then reads every field from `exitView`, so it renders the last open preview.
    - That snapshot still has a target, so `useCardEntrance` still sees `open`. Its focus cleanup therefore waits for `exitView` to clear.
    - A layout effect on `exiting` runs the reverse keyframes on the card (scale 1 → 0.92 and opacity 1 → 0; opacity only under reduced motion) and on the backdrop.
      - It uses `ENTRANCE` plus `fill: 'forwards'`, so the last frame holds until unmount.
      - The card keeps the `transform-origin` the entrance set.
    - A timer of `ENTRANCE.duration` (0 when `Element.animate` is missing) clears `exitView`. The effect's cleanup cancels the timer and the animations; that is how a new open mid-fade cancels the fade.
    - The overlay gets `pointer-events-none` while `exiting`.
  - **Window listeners** for `keydown` (Escape) and `mousedown`, keyed on `targetKey` and `exiting`, and not attached while the modal fades out.
    - A press inside the card is ignored.
    - A press outside is ignored within `OPEN_PRESS_GUARD_MS` of `openedAt`, which is stamped per `openSeq`.
    - Otherwise `preventDefault` is called when the press is inside the overlay, and then `close()`.
  - `CopyablePath({ path })`: the header path.
    - A `<button>` with `title={path}`. A click awaits `navigator.clipboard.writeText(path)` and sets `result` to `copied`, or `failed` when it rejects.
    - State: `hovered` (mouse enter or focus), `result` and `suppressed`.
      - A `COPIED_HINT_MS` timer clears `result` and sets `suppressed`.
      - Mouse leave or blur clears `hovered` and `suppressed`.
      - The hint shows while `result` is set, or while `hovered` and not `suppressed`.
    - The hint is a `role="status"`, `aria-live="polite"` span: `absolute left-0 top-full`, `pointer-events-none`, shown and hidden by opacity with a 200 ms transition. A `shownHint` ref keeps the last visible text, so the words do not change while it fades.
  - **Also in this file:** `PreviewBody`, `MarkdownPreview` (`useFrontmatter(text)`, then the card above the `file-preview-markdown markdown-body` wrapper, whose `react-markdown` gets only `body`), `JsonPreview` (`useParsedJson(text)`, then `<JsonTreeBoundary key={text} fallback={raw}><JsonTree/></JsonTreeBoundary>`, or the raw text in a `<pre>` when it is `null`), `CsvPreview` (filter/sort), the `parseDelimited` / `compareCells` helpers, and the `MAX_PREVIEW_ROWS = 500` render cap.
- `src/renderer/src/components/chat/JsonTree.tsx`:
  - `JsonTree({ value })`, a `data-testid="json-tree"` block of plain rows with disclosure buttons (`aria-expanded` on each chevron) — deliberately not an ARIA `tree`, which needs focusable items and arrow-key navigation, and whose rows here hold buttons and links of their own. Fold state is a `Set` of container paths (`""` is the root, then `/` + each URI-encoded key or index), seeded once by `defaultCollapsed`; `JsonPreview` keys it by the file text, so new text remounts it with a fresh default instead of reusing stale paths.
  - `defaultCollapsed`: `countValues` (capped walk) above `EXPAND_ALL_LIMIT` (2000) → every container path at depth ≥ `FOLDED_DEPTH` (1); otherwise only those at depth ≥ `MAX_OPEN_DEPTH` (32). `containerPaths` and `countValues` are iterative: `JSON.parse` accepts nesting (5000 levels) that overflowed the first, recursive walk.
  - A container shows `CHILD_PAGE` (200) children, then a "Show N more of M" row; `shown` (`Map<path, count>`) grows it a page at a time. Folding alone cannot bound a huge root such as a 512 KB array of numbers.
  - `JsonTreeBoundary` (error boundary) shows the raw text if the tree throws — Alt-unfolding thousands of levels builds a component tree React's commit recurses through, and the renderer has no boundary of its own.
  - `JsonNode`: the chevron (and, when folded, the `{ … }` / `[ … ]` button) calls `toggle(path, node, e.altKey, row)`, where `row` is the node's `[data-json-row]` element (it survives the toggle; the `{ … }` button does not). Before the state change `JsonTree` records the row's top, the tree's height and the scroller's slack below the viewport; a `useLayoutEffect` on the fold state then sets the tree's `min-height` to `height − slack` when the folded tree would be shorter (so the scroller never clamps), and scrolls the nearest `overflow-y: auto` ancestor by any remaining shift of the row. The floor is recomputed on every toggle. Alt applies the fold or unfold to every container path in the branch (`containerPaths`). Folded rows show the `N keys` / `N items` count; empty containers get no chevron. The chevron is the only tab stop; the `{ … }` button is `tabIndex={-1}` + `aria-hidden`. Chevrons are named `Expand|Collapse <key>`, `… item <index>` for array items, `… root` for the root. Leaf rows use a `2ch` hanging indent.
  - Colours are the `main.css` classes: `hljs-name` keys, `hljs-string`, `hljs-number`, `hljs-literal`; punctuation and the fold count `--color-text-secondary` (muted read at about 2.6:1 in the light theme). Strings go through `linkifySegments` into `<a target="_blank" rel="noreferrer noopener">`.
  - `parseJsonForTree(text)` → `{ value }` or `null` on a parse error; `useParsedJson` memoises it.
- `src/renderer/src/components/ui/FrontmatterTable.tsx`: shared with chat bubbles (`MarkdownContent` in `MessageBubble.tsx`) and notes (`NoteDetail.tsx`, `NotePreviewModal.tsx`).
  - `useFrontmatter(text, className?)` → `{ card, body }`: `splitFrontmatter` memoised on `text`; `card` is a `FrontmatterTable` or `null`, `body` is what to hand to `<Markdown>`. `className` sets the card's bottom margin (default `mb-5`; bubbles pass `mb-3`, notes `mb-4`), dropped when the body is empty so a frontmatter-only message has no trailing gap). The fill is `--color-text` at 5% so it tints the user bubble's colour instead of laying a grey slab on it; chips are outlined, not filled, so they do not read as clickable file-reference pills.
  - `FrontmatterTable({ frontmatter, className })`, the `data-testid="frontmatter"` card. Here it renders outside `.markdown-body` / `.file-preview-markdown`; in bubbles and notes it renders inside `.markdown-body`, so it is a `<dl>` grid (`grid-cols-[max-content_minmax(0,1fr)]`, each `dt`/`dd` pair in a `contents` wrapper), which no `.markdown-body` table, `pre` or `code` rule matches. `.markdown-body a` still colours its links there.
  - `entries` → the `<dl>`, keys in monospace `dt`; no entries → `null`.
  - Each value: `raw` → preformatted text; `list`, or `text` that `commaSeparatedItems` splits → chips; otherwise `whitespace-pre-wrap` text.
  - `Linkified` wraps every `linkifySegments` URL in `<a target="_blank" rel="noreferrer noopener">`, which reaches `setWindowOpenHandler` in `src/main/index.ts` and opens only `http(s)` externally.
- `src/renderer/src/components/chat/MessageBubble.tsx`: user-message badges use `AttachmentList onClick={(a) => openAttachment(a)}`.
- `src/renderer/src/components/chat/AgentAttachment.tsx`: agent-attachment badges use the same `openAttachment` routing.
- `src/renderer/src/App.tsx`: mounts `<FilePreviewModal />` once at the app root, beside the other global overlays and modals.

### Renderer — utils
- `src/renderer/src/utils/frontmatter.ts`:
  - `splitFrontmatter(text)` → `{ frontmatter: { entries } | null, body }`. Requires `---` on the first line (after an optional BOM), a closing `---` or `...`, a `KEY_LINE` as the first non-blank line inside (a `#` comment there fails it), and every later top-level line a `KEY_LINE`, blank or `#` comment (`parseEntries` returns `null` otherwise). `KEY_LINE` keys are identifiers — letters, digits, `_ $ @ . / -`, `:`-joined parts like `og:title` — or quoted; no spaces, no `*`. On any failure `frontmatter` is `null` and `body` is the untouched `text`, rendered as ordinary markdown. CRLF is accepted.
  - `entries` is `FrontmatterEntry[]` (`{ key, value }`, `value` of kind `text`, `list` or `raw`).
  - Handled: scalars (quoted, with `#` comments that follow whitespace stripped), `|`/`>` block scalars, multi-line plain scalars (folded), `[a, b]` flow lists, `- item` block lists (also at column 0 under the key). Anything nested stays `raw` as dedented source.
  - `commaSeparatedItems(text)`: a spaceless `a,b,c` with two or more non-empty parts → items, else `null`.
  - `linkifySegments(text)`: splits out `http(s)` URLs, leaving trailing sentence punctuation, a `*` (a URL in `**bold**`) and an unbalanced closing `)`/`]` to the prose. A comma followed by another `http(s)://` ends the URL, so `https://a,https://b` is two links.

### Renderer — styles
- `src/renderer/src/assets/main.css` (`@layer base`): the zebra rows, `.file-preview-table tbody tr:nth-child(odd) td` and `.file-preview-markdown tbody tr:nth-child(odd) td`. `CsvPreview` puts `file-preview-table` on its `<table>`, and `MarkdownPreview` puts `file-preview-markdown` on the markdown wrapper, beside `markdown-body`.

### Reused, unchanged
- `src/renderer/src/components/chat/AttachmentBadge.tsx`: `AttachmentList` / `AttachmentBadge`. Still source-agnostic, with the tooltip still "Download". Preview routing lives entirely in the `onClick` callers, not in the badge.

### Tests
- `src/renderer/src/components/chat/FilePreviewModal.test.tsx`:
  - the entrance: waiting for settled content, the 150 ms fallback, and opens that are already settled;
  - pinning the card to the top;
  - focus moving in and back out;
  - the press guard;
  - the agent-file header and error states.
  - markdown frontmatter: the card sits outside `.markdown-body`, a URL value is a `_blank` link, and the body renders without a stray rule or setext heading.
- `src/renderer/src/components/chat/JsonTree.test.tsx`: the palette classes, chevron fold with count, Alt-click branch fold, a large document opening with only its top level unfolded, the exact 2000-value boundary, paging a huge container, 5000-level nesting (fails against a recursive walk), a small deep document folded at depth 32, the scroll shift and the `min-height` floor after a fold, array labels and the braces out of the tab order, and `parseJsonForTree` declining non-JSON. `FilePreviewModal.test.tsx` covers the tree for parsed text and the raw `<pre>` for truncated JSON.
- `src/renderer/src/components/chat/MessageBubble.frontmatter.test.tsx`: user and assistant bubbles show the card and a link, no stray rule, and keep the unsplit text as `data-message-markdown`; a leading rule alone makes no card.
- `src/renderer/src/utils/frontmatter.test.ts`: `splitFrontmatter` value shapes, nested values kept as source, CRLF/BOM/empty blocks; documents that are not frontmatter (prose or `**Summary**:` between rules, a `#` comment first, a non-key line after a key, no closing rule) left untouched; `commaSeparatedItems`; `linkifySegments`, including `**url**` and comma-joined URLs.
- `src/renderer/src/components/notes/NoteDetail.test.tsx` and `src/renderer/src/components/agents/local/InlineFileEditor.test.tsx`: the card renders above the document, a click on a link in it does not start editing, and the textarea a click elsewhere opens holds the raw text, frontmatter included.
- `src/renderer/src/stores/filePreview.store.test.ts`: agent-file opens, header actions, error copy and attachment previews.

## IPC Channels

| Channel | Direction | Payload | Returns |
|---------|-----------|---------|---------|
| `files:read-preview` | renderer → main | `{ fileId: string, source?: 'cinna' \| 'local' }` | `{ success: true, text: string, truncated: boolean }` / `{ success: false, error, code? }` |
| `files:download` | renderer → main | `{ fileId, filename, source? }` | Reused for the modal Download button. See [File Attachments](../file_attachments/file_attachments_tech.md) |
| `agent-files:read-preview`, `agent-files:authorize`, `agent-files:open`, `agent-files:reveal` | renderer → main | `{ agentId, path }` | See [File References — Technical Details](../file_references/file_references_tech.md#ipc-channels) |

## Services & Key Methods

- `src/main/services/fileService.ts:readTextPreview()`: a capped read routed by source, decoded with `decodePreviewText`. Throws `FileError('not_found' | 'read_failed')`.
- `src/main/services/cinnaFileService.ts:readBytes()`: a fetch into memory with the OAuth bearer. Logs timing and errors; throws `CinnaFileError('download_failed')`.
- `src/main/db/chatFiles.ts`: `chatFileRepo.getOwned(userId, attachmentId)`, the ownership-scoped lookup for local rows (reused).

## Renderer State

- `useFilePreviewStore` (Zustand) holds, for one preview at a time:
  - the target and its content;
  - loading, truncated, error and notice state;
  - `origin` and `openSeq` for the entrance;
  - the `requestId` guard against stale fetches;
  - `pendingAction` and `actionError` for the header actions.
- Module state in `filePreview.store.ts`:
  - `lastPointer`: the last window pointer-down, the origin for attachment opens;
  - `agentOpenToken`: the newest-open guard across an agent file's consent dialog.
- `useFileDownloadStore` (Zustand): reused for the modal's Download button.
- `CsvPreview` local `useState`:
  - `filters: Record<number, string>`, a substring per column;
  - `sort: { col, dir } | null`.

  Both reset per file through `key={targetKey}` on `PreviewBody`, where `targetKey` is `attachment:<id>` or `agent-file:<agentId>:<path>`.
- `filtersEnabled` lives one level up, in `FilePreviewModal`, because the header toggle and the table must agree. It resets when `targetKey` changes.
- In `useCardEntrance`, refs hold the entrance state (started, timer, animations), the element focus goes back to, and whether the latest open came from the keyboard. `openedAt` in the modal is used by the press guard.
- In `FilePreviewModal`, the `lastOpen` ref and the `prevTarget` / `exitView` state hold the snapshot a closing preview fades out with.
- `CopyablePath` local state: `hovered`, `result` and `suppressed`, plus refs for the hint timer and `shownHint`.

## CSV Parsing & Sorting

- `parseDelimited(text, delimiter)`: a single quote-aware pass.
  - A `""` escape becomes a quote, and a delimiter or `\n` inside quotes stays in the cell.
  - `\r\n` and `\r` are normalised.
  - The trailing record is flushed, and the caller drops fully blank records.
  - The delimiter is auto-detected: tab when the text has tabs and no commas, otherwise comma.
- `compareCells(a, b)`: compares numerically when both cells are non-empty finite numbers, otherwise with `localeCompare`.
- Each header click cycles the sort: none → asc → desc → none. Filtering runs before sorting, and both apply only while `filtersEnabled` is on.
- Render cap: the first `MAX_PREVIEW_ROWS` (500) records, with a "Showing first N rows" notice when rows are cut.
- Zebra rows: odd body rows get a `color-mix` of `--color-bg-secondary` (the card fill) with `black 18%`, or `black 2.5%` under `[data-theme="light"]`. `:nth-child` counts rows as rendered, so the stripes keep alternating after filtering and sorting. The same rule stripes tables in a previewed markdown file; chat tables carry neither class and stay unstriped.

## Configuration

- `MAX_PREVIEW_BYTES` = 512 KB (`src/shared/filePreview.ts`): the read cap in main, for both attachments and agent files.
- `MAX_PREVIEW_ROWS` = 500 (`FilePreviewModal.tsx`): the CSV table render cap.
- `ENTRANCE_WAIT_MS` = 150 (`FilePreviewModal.tsx`): how long the card stays hidden waiting for a settled state.
- `ENTRANCE` = 170 ms, `cubic-bezier(0.2, 0, 0, 1)`. The exit uses the same options, with `fill: 'forwards'`.
- `COPIED_HINT_MS` = 1200 (`FilePreviewModal.tsx`): how long "Copied" or "Couldn't copy" stands before the hint fades.
- `OPEN_PRESS_GUARD_MS` = 500 (`FilePreviewModal.tsx`): how long after an open an outside press is ignored.
- `POINTER_ORIGIN_MAX_AGE_MS` = 1000 (`filePreview.store.ts`): the oldest pointer-down an attachment open may grow from.
- Previewable extensions and MIME types:
  - attachments: the tables in `src/shared/filePreview.ts` (`txt`, `log`, `md`, `markdown`, `json`, `csv`, `tsv`, `yaml`, `yml`);
  - agent files add `AGENT_TEXT_EXTENSIONS` from `src/shared/agentFiles.ts`.

## Security

- **The attachment byte cap is enforced in main**, in `fileService.readTextPreview`, which the IPC handler passes `MAX_PREVIEW_BYTES`. The renderer cannot request more.
- **Attachments have the same access control as download.**
  - `local` is gated by `chatFileRepo.getOwned(userId, …)`.
  - `cinna` is gated by the backend on the OAuth bearer: the owner or a session participant.

  Preview exposes no file the user could not already download.
- **Agent files** are gated by containment or consent and by the credential rule. See [File References — Technical Details](../file_references/file_references_tech.md#security).
- **Bytes stay in main.** File bytes are read only in the main process. For attachments, the renderer receives decoded text over IPC, never a path or a raw handle.
- **No injection surface.**
  - `text` and unparseable `json` render inside `<pre>{text}</pre>`, the JSON tree renders keys and values as React text, and CSV cells render as `{cell}`, all escaped by React. Links in the tree are `http(s)` only, like frontmatter's.
  - Markdown uses the existing `react-markdown` stack without `rehype-raw`, the same trust boundary chat bubbles already use.
  - Frontmatter values render as React text; the only links it makes are `http(s)` URLs, and the main process's window-open handler refuses any other scheme anyway.

## Observability

- `logger('cinna-files')`: a `read` success line (`fileId, bytes, truncated, durationMs`), plus `logger.error` on a network failure or non-OK status. This mirrors `downloadToPath`.
- Renderer `createLogger('file-preview')`: warns with the failure code when an agent file cannot be authorized or revealed.
- **Errors reach the modal as data:**
  - Attachment errors cross IPC as `{ success: false, error, code }` via `ipcErrorShape`, and the store shows `error` in the modal.
  - The Download button keeps its own `useFileDownloadStore` error path.
  - Agent-file failures arrive with their code and decide the body copy.
