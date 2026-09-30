# File Preview — Technical Details

## File Locations

### Shared (cross-process)
- `src/shared/filePreview.ts`:
  - `previewKindFor(filename, mimeType)` → `PreviewRenderKind | null`, and `isPreviewable(filename, mimeType)`.
  - The `PreviewRenderKind` type (`'markdown' | 'json' | 'csv' | 'python' | 'xml' | 'text' | 'html'`) and `MAX_PREVIEW_BYTES` (512 KB).
  - The extension table wins over the MIME table. The extension is parsed inline, without Node `path`, because the sandboxed renderer imports this file.
  - `decodePreviewText(bytes, truncated)` decodes UTF-8. When `truncated`, it decodes with `{ stream: true }` and skips the final flush, so a multi-byte sequence cut by the cap is dropped (no trailing `�`). Attachment reads and agent-file reads both use it.
- `src/shared/htmlPreview.ts`: the preview frame's IPC contract — `HtmlPreviewOpenInput` (`{ type: 'attachment', fileId, source?, filename, mimeType? }` or `{ type: 'agentFile', agentId, path }`), `HtmlPreviewOpenResult`, `FilesOpenInBrowserInput` / `FilesOpenInBrowserResult` — and `HTML_PREVIEW_SANDBOX`, the frame's `sandbox` tokens, so the renderer's `<iframe>` and the reasoning behind them live in one place.
- `src/shared/attachments.ts`:
  - `MessageAttachment` is the shape preview consumes: id, filename, size, mimeType, `source?`.
  - `agentFileToAttachment(file)` adapts an agent `MessagePartFile` into it; the preview/download click router reuses it.
- `src/shared/agentFiles.ts`: `agentFilePreviewKindFor`, `isCredentialFilePath`, `agentFileName`, and the `agent-files:*` result types. See [File References — Technical Details](../file_references/file_references_tech.md).

### Main process — services
- `src/main/services/fileService.ts`:
  - `readTextPreview({ userId, attachmentId, source, maxBytes })`: reads into memory, routed by source.
    - `local` = `chatFileRepo.getOwned` + `readFile`, then `subarray(0, maxBytes)`.
    - `cinna` = `cinnaFileService.readBytes`.

    Decodes the result of `readBytes` with `decodePreviewText` and returns `{ text, truncated }`.
  - `readBytes({ userId, attachmentId, source, maxBytes })` → `{ bytes, truncated }`: the capped, source-routed read itself, in memory. Shared by `readTextPreview` and the HTML preview server, so the frame reads an attachment through the same ownership and bearer gates as its text.
  - `assertFileScope(value)`: reused to narrow the renderer-supplied `'cinna' | 'local'`.
- `src/main/services/cinnaFileService.ts`:
  - `readBytes(userId, fileId, maxBytes)`: `net.fetch GET /api/v1/files/{fileId}/download` with the OAuth bearer. Reads `arrayBuffer()` and returns `{ bytes: Buffer (capped), truncated }`.
  - Logs a `read` success line (`fileId, bytes, truncated, durationMs`), and `logger.error` on a network failure or non-OK status.
  - In memory only; never writes to disk, unlike `downloadToPath`.
- `src/main/services/agentFiles/agentFileService.ts`: `readPreview()` reads an agent file, after the containment, consent and credential checks. Documented with [File References](../file_references/file_references_tech.md). For the HTML frame and Open in browser:
  - `htmlDocument(input)` (private): `permitted` (never asks), `not_a_file`, `credential_file`, and `not_previewable` unless `agentFilePreviewKindFor` of the requested name is `html`.
  - `readChecked(found, maxBytes)` (private): opens, compares dev/ino with the checked stat (`not_found` on a swap), refuses `too_large` over the cap — at the stat and again by reading one byte past it — rather than cutting.
  - `htmlDocumentAccess(input)`: `htmlDocument` as a yes/no, for `html-preview:open`.
  - `readHtmlDocument(input, maxBytes)`: `htmlDocument`, then `readChecked`.
  - `readHtmlAsset(input, segments, maxBytes)`: the document gate, then every segment through `isSafeAssetSegment`, `join` onto the document's real folder and `isWithin` it, `permitted` on that path (never asks), `isWithin` again on the asset's realpath (a symlink out is `not_found`), `not_a_file`, `credential_file`, `readChecked`.
  - `openInBrowser(input)`: `htmlDocument`, re-takes `paths.realpath(requested)` and returns `launch_failed` if it moved (as `open` does), then `deps.openInBrowser(real)`; a throw is `launch_failed`, "No browser could open this file."
  - `isSafeAssetSegment(segment)` (exported, pure): non-empty, no leading `.`, no `/`, `\`, `:` or NUL.
- `src/main/services/htmlPreview/htmlPreviewServer.ts`: `createHtmlPreviewServer(deps)`, the token registry and `cinna-preview:` request handler, without Electron.
  - `register(target)` → `{ token, url }`: a 24-byte random hex token (lower-case, because a standard scheme's host is lower-cased), the active profile's id, and the document name; `url` is `cinna-preview://<token>/<encoded name>`. Past `MAX_HTML_PREVIEW_TOKENS` the oldest entry is dropped.
  - `release(token)`: deletes the entry.
  - `handle(request)`: `GET`/`HEAD` only (else 405); the scheme and a live token (else 404); the profile that registered it must still be active, or the entry is deleted and 404; the path's segments are URL-decoded (a bad escape is 404). One segment equal to the document name serves the document (`readAttachment` or `readAgentDocument`); anything else is an asset, 404 for an attachment, `readAgentAsset` for an agent file. `too_large` or an attachment read that came back `truncated` is 413; any other refusal 404. HTML responses go through `injectPreviewLinkHelper`.
  - Response headers: `Content-Type` (the document is `text/html`, or `application/xhtml+xml` for `.xhtml`, whatever its name; assets by `htmlPreviewContentType`, `application/octet-stream` when unknown), `Access-Control-Allow-Origin: *` (the frame's origin is opaque, so its own `fetch('data.json')` is cross-origin; nothing is credentialed), `Cache-Control: no-store`, `Referrer-Policy: no-referrer` (the token stays out of the Referer of the page's remote requests), `X-Content-Type-Options: nosniff`.
- `src/main/services/htmlPreview/previewLinkHelper.ts`: `PREVIEW_LINK_HELPER_SCRIPT` and `injectPreviewLinkHelper(bytes)`. Puts `<base target="_top">` (unless the page has its own `<base>`) and the script right after `<head …>`, else `<html …>`, else after a leading doctype or XML declaration. The bytes are handled as latin1 so the page's encoding survives; a UTF-16 document (by BOM) is left untouched.
- `src/main/services/agentFiles/openInBrowser.ts`: `browserLaunchPlan(platform, browserPath, file)` (pure) and `createBrowserLauncher(deps)`. macOS `execFile('open', ['-a', browser, file])`, Windows the browser executable spawned detached with the file as its argument, Linux `execFile('xdg-open', [file])`; each followed by `shell.openPath` as the fallback, and the last failure thrown when nothing worked. The file is always its own argv element.

### Main process — DB (reused, no new tables)
- `src/main/db/chatFiles.ts`: `chatFileRepo.getOwned(userId, attachmentId)`, an ownership-scoped lookup for the `local` read path.

### Main process — desktop host
- `src/main/host/desktop/htmlPreview.ts`: the Electron side.
  - `registerHtmlPreviewScheme()`: `protocol.registerSchemesAsPrivileged` for `cinna-preview` (`standard`, `secure`, `supportFetchAPI`, `corsEnabled`, `stream`). Called from `src/main/index.ts` before `app` is ready; the app's only call, since a second would replace the first's list.
  - `htmlPreviewServer`: the production server, wired to `getProfileScopeUserId`, `fileService.readBytes`, `agentFileService.readHtmlDocument` and `readHtmlAsset`.
  - `installHtmlPreviewSession(ses = session.defaultSession)`: once per session, from `startup()` — `ses.protocol.handle`, the permission request and check handlers, and the `will-download` canceller.
  - `guardPreviewFrames(win, appUrl)`: from `createWindow()`, the `will-frame-navigate` and `will-navigate` listeners on the main window, and a `createExternalOpenGate` fed by the window's `blur` and `focus`.
  - `openAttachmentInBrowser({ userId, attachmentId, source, filename })`: `safeHtmlFilename` (else `FileError('not_previewable')`), `prepareOpenInBrowserDir`, `fileService.downloadToPath` (the whole file, through the download's own gates), then `openInBrowser`; a launch throw becomes `FileError('launch_failed', 'No browser could open this file.')`.
  - `clearOpenInBrowserCopiesAtStart()`: from `startup()`, not awaited; a failure is logged.
- `src/main/host/desktop/htmlPreviewGuards.ts`: the pure rules, tested without Electron — `mainFrameNavigation`, `previewFrameNavigation`, `isAppPermissionRequester`, `isPreviewDownloadUrl`, `safeHtmlFilename` and `createExternalOpenGate` (with `ACTIVATION_WINDOW_MS`). See [Security](#html-preview-frame).
- `src/main/host/desktop/openInBrowserCopies.ts`: `OPEN_IN_BROWSER_DIR` (`html-open-in-browser`), `openInBrowserRoot(userData)`, `prepareOpenInBrowserDir(userData, userId, attachmentId)` and `clearOpenInBrowserCopies(userData)`.
- `src/main/host/desktop/agentFiles.ts`: `openInBrowser`, the production `createBrowserLauncher` (the browser from `app.getApplicationInfoForProtocol('https://')`, `shell.openPath` as the fallback), handed to `agentFileService` and used by `openAttachmentInBrowser`.
- `src/main/index.ts`: `nodeIntegrationInSubFrames: false` stated on the main window, `guardPreviewFrames(mainWindow, appUrl)` with the dev server's URL or the packaged `file://` index, and the three calls above.
- `src/main/errors.ts`: `FileErrorCode` gains `not_previewable` and `launch_failed`.

### Main process — IPC
- `src/main/ipc/files.ipc.ts`:
  - `files:read-preview`: a thin controller. Calls `userActivation.requireActivated()` → `getProfileScopeUserId()` → `assertFileScope` → `fileService.readTextPreview({ maxBytes: MAX_PREVIEW_BYTES })`. Returns `{ success, text, truncated }`, or `{ success: false, error, code }` via `ipcErrorShape`.
  - Reuses the existing `files:download` for the modal's Download button; there is no new download channel.
  - `files:open-in-browser`: the same gates as `files:read-preview` (activation, profile, `assertFileScope`), a string `fileId` and `filename` (else `invalid_input`), then `openAttachmentInBrowser`. Failures return as data via `ipcErrorShape`.
- `src/main/ipc/agent_files.ipc.ts`: the `agent-files:*` channels an agent-file preview uses: `authorize`, `read-preview`, `open`, `open-in-browser` and `reveal`.
- `src/main/ipc/html_preview.ipc.ts`: `registerHtmlPreviewHandlers()`, registered after the agent-file handlers.
  - `html-preview:open`: `requireActivated()`; for an agent file, `agentFileService.htmlDocumentAccess` (a refusal is returned as is); for an attachment, `assertFileScope`, a non-empty `fileId`, a string `filename`, and `previewKindFor(filename, mimeType) === 'html'`; then `htmlPreviewServer.register`. Anything else is `invalid_input`, "Nothing to preview."
  - `html-preview:release`: `htmlPreviewServer.release(token)`; always `{ success: true }`.

### Preload
- `src/preload/index.ts`:
  - `window.api.files.readPreview({ fileId, source? })` → `ipcRenderer.invoke('files:read-preview', …)`. The return type is the success/error union, inferred into `API = typeof api` and surfaced through `src/preload/index.d.ts`.
  - `window.api.files.openInBrowser({ fileId, filename, source? })` → `files:open-in-browser`.
  - `window.api.agentFiles.*` serves agent files, `openInBrowser(input)` → `agent-files:open-in-browser` included.
  - `window.api.htmlPreview.{ open(input), release(token) }` → `html-preview:open` / `html-preview:release`.

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
  - `openInBrowser()`: for an agent file, `runAction('browser')` (the Open / Open folder path, `window.api.agentFiles.openInBrowser`); for an attachment, its own `pendingAction: 'browser'` run of `window.api.files.openInBrowser`, dropped if the target changed meanwhile. A failure is an `actionError` with `action: 'browser'`, `code: 'launch_failed'` only when main said so.
  - `PreviewAction` (`'open' | 'reveal' | 'browser'`) types `pendingAction` and `actionError.action`; `actionErrorText` words `browser` as "Couldn't open it in the browser: …", and `launch_failed` as main's own sentence.
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
    5. the **Contents** toggle (`HEADER_ACTION_CLASS`, accent-tinted while open), only while `showContents`: loaded (not loading, no error, no notice) and `toc.show`, where `toc` is `markdownToc` for markdown or `pythonOutline` for python. `aria-expanded` and `aria-controls={CONTENTS_PANEL_ID}`;
    6. for agent files, `FileActionsMenu` (`key={targetKey}`, `dismissed={exiting}`), given `pendingAction`, `fileGone`, `openAgentFileExternally` and `revealAgentFile`;
    7. for attachments, Download;
    8. Close.
  - **Also in the header**: for `kind === 'html'` with no body error or notice, a `role="group"` `aria-label="View"` pair of `aria-pressed` buttons, **Rendered** / **Source**; for an HTML attachment, an icon-only Open in browser (`Globe`, `aria-label="Open <name> in browser"`, `Loader2` while `pendingAction === 'browser'`, disabled while any action runs) before Download. `FileActionsMenu` gets `onOpenInBrowser` only for `html`.
  - **Action error row:** `role="alert"`, for attachments too now (Open in browser), rendered for an agent file unless `actionErrorRepeatsBody` says it would repeat the body.
  - **HTML view:** `htmlViewFor` (`{ openSeq, view }`) — a view chosen for another open reads as `rendered`, so every open starts Rendered. `htmlRendered` (html, Rendered, loaded, no error or notice) drops the body's padding and scroll (`overflow-hidden`) and hides the truncation notice. The card is `max-w-6xl h-[80vh]` for `html` in every state, `max-w-3xl` otherwise.
  - **XML:** the modal parses once, `parseXml(text)` memoised on `kind` and `text`, and hands the result to both `xmlOutline` (the `toc`) and `XmlPreview`. `xmlReveal` (a ref `XmlTree` fills) is passed to `FilePreviewContents` as `onBeforeGo` for `xml`.
  - **Markdown split:** the modal, not `MarkdownPreview`, calls `useFrontmatter(kind === 'markdown' ? text : '')` and memoises `markdownToc(markdown.body)`, because the header's Contents button needs the verdict too. `MarkdownPreview({ card, body })` renders what it is handed; `PreviewBody` no longer handles `markdown`.
  - **Body and panel:** the body sits in a `relative flex` row. While `showContents`, the body gets an explicit `width: closedWidth - CARD_BORDER_X` and `flex: none`, so it never reflows. `FilePreviewContents` (`key={targetKey}`, `overlay={!sideBySide}`, `left={closedWidth - CARD_BORDER_X}`) renders while `panelOpen`, or while a side-by-side close is animating (`closingFor === openSeq`, `animateWidth`, not reduced motion).
  - `contentsGeometry(windowWidth, rem)` → `{ closedWidth, sideBySide, shift }`, exported and pure.
    - `closedWidth` = `min(48rem, window − 2rem)`, the `max-w-3xl` card in the overlay's `px-4`.
    - `sideBySide` when `closedWidth + CONTENTS_PANEL_WIDTH` fits in `window − 2rem`.
    - `shift` = `clamp(0, CONTENTS_PANEL_WIDTH / 2, roomRight)`, where `roomRight` is the gap left to `window − WINDOW_MARGIN` by the wide card centred. The card is centred by flex, so a shift of half the panel width keeps its left edge where it was.
    - `rem` is read from the root's computed `font-size` on each render, because the Tailwind widths are in rem.
  - **Card style** while `showContents`: an explicit pixel `width` (`closedWidth`, or `+ CONTENTS_PANEL_WIDTH` when `widened`), `maxWidth: none`, `flexShrink: 0`, `left: shift` when widened (the card is `relative`), `overflow: hidden` to clip the panel mid-animation, and a `width`/`left` transition of the entrance's timing only when `animateWidth` and not reduced motion. Explicit widths are what let the toggle animate between two pixel values.
  - **Width state:**
    - `windowWidth`: a `resize` listener for the modal's whole lifetime, not only while open. A stale value would widen the next preview by the wrong amount, and the entrance measures its origin before a correction could land. A resize also clears `animateWidthFor`.
    - `animateWidthFor` (`openSeq` of the toggle): set by `toggleContents`. Keyed to the open so a new preview never inherits it.
    - `closingFor`: set to `openSeq` when a toggle closes the panel; cleared after `ENTRANCE.duration`.
    - `slowOpenFor`: set to `openSeq` when `isLoading` outlasts `ENTRANCE_WAIT_MS`. While it matches, `sideBySide` is forced false. `toggleContents` clears it.
    - `toggledAt`: a ref stamped by `toggleContents`, for the press guard.
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
  - **Window listeners** for `keydown` (Escape) and `mousedown` (capture phase), keyed on `targetKey` and `exiting`, and not attached while the modal fades out. The `mousedown` handler returns early, in order:
    1. for a press inside the card;
    2. for a press inside an element carrying `PREVIEW_POPOVER_ATTR` (the portaled ⋯ menu);
    3. while a `[role="menu"][data-file-preview-popover]` is in the document. The capture-phase `window` listener runs before `usePopover`'s `document` listener, so the menu is certainly still mounted; the press is left to the menu, which closes only itself;
    4. within `OPEN_PRESS_GUARD_MS` of `openedAt`, which is stamped per `openSeq`;
    5. within `OPEN_PRESS_GUARD_MS` of `toggledAt`.

    Otherwise `preventDefault` is called when the press is inside the overlay, and then `close()`. Escape never reaches the modal's listener while the menu is open; see `FileActionsMenu`.
  - `CopyablePath({ path })`: the header path.
    - A `<button>` with `title={path}`. A click awaits `navigator.clipboard.writeText(path)` and sets `result` to `copied`, or `failed` when it rejects.
    - State: `hovered` (mouse enter or focus), `result` and `suppressed`.
      - A `COPIED_HINT_MS` timer clears `result` and sets `suppressed`.
      - Mouse leave or blur clears `hovered` and `suppressed`.
      - The hint shows while `result` is set, or while `hovered` and not `suppressed`.
    - The hint is a `role="status"`, `aria-live="polite"` span: `absolute left-0 top-full`, `pointer-events-none`, shown and hidden by opacity with a 200 ms transition. A `shownHint` ref keeps the last visible text, so the words do not change while it fades.
  - `XmlPreview({ text, parsed, truncated, revealRef })`: `XmlTree` inside `JsonTreeBoundary` (fallback: the source) when `parsed`; otherwise a note — "The preview is cut at 512 KB, so it is shown as source." when `truncated`, else "This XML could not be parsed, so it is shown as source." — above `CodePreview language="xml"`.
  - **Also in this file:** `PreviewBody`, `MarkdownPreview` (the modal's frontmatter card above the `file-preview-markdown markdown-body` wrapper, whose `react-markdown` gets only `body` and `previewMarkdownComponents`), `JsonPreview` (`useParsedJson(text)`, then `<JsonTreeBoundary key={text} fallback={raw}><JsonTree/></JsonTreeBoundary>`, or the raw text in a `<pre>` when it is `null`), `CsvPreview` (filter/sort), the `parseDelimited` / `compareCells` helpers, and the `MAX_PREVIEW_ROWS = 500` render cap.
- `src/renderer/src/components/chat/FileActionsMenu.tsx`: `FileActionsMenu({ pendingAction, fileGone, onOpen, onReveal, dismissed })`, the ⋯ menu.
  - `usePopover('below-right')`; the menu is portaled to `document.body` with `role="menu"`, `aria-label="File actions"`, the shared `MENU_SURFACE` / `MENU_ITEM` classes from `agents/local/OpenInMenu.tsx`, and `PREVIEW_POPOVER_ATTR` (`data-file-preview-popover`), which the modal's outside-press handler treats as inside the card.
  - The trigger is named "More file actions", never disabled, and shows `Loader2` while `pendingAction` is set. Both `menuitem`s (Open, then Open folder) are disabled while `pendingAction !== null || fileGone`.
  - Once positioned, focuses the first enabled item. A `window` capture-phase `keydown` listener, attached while open, handles Escape and Tab (`preventDefault` + `stopPropagation`, close, focus the trigger), which is what keeps the modal's own Escape listener from closing the preview, and ArrowUp/ArrowDown/Home/End over the enabled items, wrapping.
  - `run(fn)` closes the menu and refocuses the trigger before calling the action. `dismissed` closes an open menu when the preview starts its exit.
  - `onOpenInBrowser` adds **Open in browser** (`Globe`) between Open and Open folder, under the same disabled rule; `pendingAction` may be `'browser'`.
  - While open, a `window` `blur` closes the menu when, a tick later, `document.activeElement` is an `HTMLIFrameElement`. A press inside the HTML frame lands in the frame's document, so no outside-press handler sees it; focus moving into the frame is the only signal. A blur to another app leaves the menu open.
- `src/renderer/src/components/chat/FilePreviewContents.tsx`:
  - `CONTENTS_PANEL_WIDTH` (240), `CONTENTS_PANEL_ID`, `FULL_TITLE_DELAY_MS` (250).
  - `previewMarkdownComponents`: `markdownComponents` with `h1`–`h6` replaced by `anchoredHeading(tag)`, which renders the same tag with `data-heading-line` from the mdast node's `position.start.line`. Chat rendering keeps `markdownComponents`.
  - `FilePreviewContents({ entries, bodyRef, overlay, left })`: a `<nav id={CONTENTS_PANEL_ID} aria-label="Contents">`, absolutely positioned at full body height and scrolling on its own. Side by side it is placed at `left`, just right of the body, so the widening card uncovers it instead of sliding it over the body; as an overlay it is `right-0` with a left shadow.
    - Entries are buttons with `data-toc-line`, `aria-current="location"` on the current one, and `paddingLeft` of 8 px plus 12 px per level below `minDepth`.
    - `compute()`: the last listed `[data-heading-line]` whose top is at or above the body's top + `ACTIVE_OFFSET` (16), else the first entry. Runs in a layout effect and, `requestAnimationFrame`-throttled, on the body's `scroll`. Skipped while `pinned` holds a clicked line; `wheel`, `touchstart`, `keydown` and `pointerdown` on the body clear `pinned`.
    - `onBeforeGo(line)`, when given, runs inside `flushSync` before the heading is looked up, so the XML tree's unfolding and paging are committed and the row exists.
    - An entry with `note` renders as a muted italic `<li>` (with `noteTag` in mono as ` <tag>`), not a button; notes are left out of the `listed` set `compute()` tracks.
    - `go(line)`: pins the line, then `body.scrollTo` the heading's offset minus `HEADING_SCROLL_MARGIN` (8), smooth unless reduced motion. Never `scrollIntoView`, which scrolls every scrollable ancestor.
    - An effect adjusts `nav.scrollTop` to keep the current entry in view.
    - Full-title hint: on `mouseenter`, only when `scrollWidth > clientWidth`, a `FULL_TITLE_DELAY_MS` timer sets `fullTitle` from the button's rect. It renders a `fixed`, `pointer-events-none`, `aria-hidden` box portaled to `document.body`, right-aligned under the entry. Mouse leave, a panel scroll and unmount clear it.
- `src/renderer/src/components/chat/JsonTree.tsx`:
  - `JsonTree({ value })`, a `data-testid="json-tree"` block of plain rows with disclosure buttons (`aria-expanded` on each chevron) — deliberately not an ARIA `tree`, which needs focusable items and arrow-key navigation, and whose rows here hold buttons and links of their own. Fold state is a `Set` of container paths (`""` is the root, then `/` + each URI-encoded key or index), seeded once by `defaultCollapsed`; `JsonPreview` keys it by the file text, so new text remounts it with a fresh default instead of reusing stale paths.
  - `defaultCollapsed`: `countValues` (capped walk) above `EXPAND_ALL_LIMIT` (2000) → every container path at depth ≥ `FOLDED_DEPTH` (1); otherwise only those at depth ≥ `MAX_OPEN_DEPTH` (32). `containerPaths` and `countValues` are iterative: `JSON.parse` accepts nesting (5000 levels) that overflowed the first, recursive walk.
  - A container shows `CHILD_PAGE` (200) children, then a "Show N more of M" row; `shown` (`Map<path, count>`) grows it a page at a time. Folding alone cannot bound a huge root such as a 512 KB array of numbers.
  - `JsonTreeBoundary` (error boundary) shows the raw text if the tree throws — Alt-unfolding thousands of levels builds a component tree React's commit recurses through, and the renderer has no boundary of its own.
  - `JsonNode`: the chevron (and, when folded, the `{ … }` / `[ … ]` button) calls `toggle(path, node, e.altKey, row)`, where `row` is the node's `[data-json-row]` element (it survives the toggle; the `{ … }` button does not). Before the state change `JsonTree` records the row's top, the tree's height and the scroller's slack below the viewport; a `useLayoutEffect` on the fold state then sets the tree's `min-height` to `height − slack` when the folded tree would be shorter (so the scroller never clamps), and scrolls the nearest `overflow-y: auto` ancestor by any remaining shift of the row. The floor is recomputed on every toggle. Alt applies the fold or unfold to every container path in the branch (`containerPaths`). Folded rows show the `N keys` / `N items` count; empty containers get no chevron. The chevron is the only tab stop; the `{ … }` button is `tabIndex={-1}` + `aria-hidden`. Chevrons are named `Expand|Collapse <key>`, `… item <index>` for array items, `… root` for the root. Leaf rows use a `2ch` hanging indent.
  - Colours are the `main.css` classes: `hljs-name` keys, `hljs-string`, `hljs-number`, `hljs-literal`; punctuation and the fold count `--color-text-secondary` (muted read at about 2.6:1 in the light theme). Strings go through `linkifySegments` into `<a target="_blank" rel="noreferrer noopener">`.
  - `parseJsonForTree(text)` → `{ value }` or `null` on a parse error; `useParsedJson` memoises it.
- `src/renderer/src/components/chat/XmlTree.tsx`: `XmlTree({ doc, revealRef })`, a `data-testid="xml-tree"` block built like `JsonTree` (plain rows with disclosure buttons, not an ARIA tree), reusing its `CHILD_PAGE` (200) and `EXPAND_ALL_LIMIT` (2000).
  - Fold state is a `Set` of element ids, seeded by `defaultCollapsed`: above `EXPAND_ALL_LIMIT` document nodes plus children, every foldable element at depth ≥ `FOLDED_DEPTH` (1), else those at depth ≥ `MAX_OPEN_DEPTH` (32). `shown` pages long child lists.
  - `ElementView`: no children → a self-closing row; `inlineText` → one row `<a>text</a>`; otherwise a chevron (`aria-expanded`, `Expand|Collapse <tag>`, Alt-click → `foldableIds` of the branch), a folded `…` button out of the tab order, `N child(ren)` when folded, and a bordered child column. The first row of every element carries `data-heading-line={id}`.
  - `LeafView`: text, `<!--comment-->` (`hljs-comment`), CDATA, processing instructions and the doctype (`hljs-meta`).
  - `reveal(id)`, published through `revealRef`: removes every folded ancestor from `collapsed` and raises each ancestor's `shown` to the page holding the child on the path.
  - The fold keeps the clicked row still with the JSON tree's `min-height` floor and scroll correction.
- `src/renderer/src/components/chat/HtmlPreview.tsx`: `HtmlPreview({ input, inputKey, view, text, title })`. Rendered: `HtmlFrame` in an `h-full` wrapper, kept mounted (`hidden`) while `view === 'source'`; Source: `CodePreview language="xml"` over the text the modal read.
  - `HtmlFrame`: on each `inputKey`, `window.api.htmlPreview.open(input)`; a failure renders "Couldn't render the page: …", loading "Loading page…". A token that arrives after cleanup is released at once; cleanup (the preview closing, or `key={targetKey}` changing) releases the live one.
  - The `<iframe data-testid="html-preview-frame" sandbox={HTML_PREVIEW_SANDBOX} referrerPolicy="no-referrer">` sits on `--color-html-page`.
- `src/renderer/src/components/chat/CodePreview.tsx`:
  - `CodePreview({ text, language, anchorLines })`, a `data-testid="code-preview"` wrapped `<pre>`; `PreviewBody` renders it for `kind === 'python'`, with the modal's `toc.entries` lines. `language` is `'python' | 'xml'`: `XmlPreview`'s fallback and HTML Source use `xml`, highlight.js's grammar for HTML too.
  - `insertLineAnchors(tree, lines)`: walks the hast in document order counting newlines, splitting text nodes where needed, and puts an empty `<span data-heading-line={n}>` at the start of each wanted line — the marker `FilePreviewContents` scrolls to and tracks, as markdown headings carry it.
- `src/renderer/src/utils/pythonOutline.ts`: `pythonOutline(source)` → `MarkdownToc`. A line scan, not a parser: skips lines inside triple-quoted strings and comments; a column-0 `def`/`class` (optionally `async`) is depth 1, a `def` at a class's member indent is depth 2, and any other column-0 line ends the class. `line` is the keyword's line, not the decorator's. `show` when there is more than one entry.
  - A module-level `createLowlight` with `python`, `xml`, and `css` and `javascript` so an HTML file's `<style>` and `<script>` are coloured as such: the grammars the preview kinds need, not lowlight's `common` set. `lowlight.highlight` returns hast, which `toJsxRuntime` (`hast-util-to-jsx-runtime`) turns into React elements with `react/jsx-runtime`, so spans carry the `main.css` `hljs-*` classes. Both packages are direct dependencies; `rehype-highlight` uses the same engine but is not called here.
  - Memoised on `text` and `language`; any throw falls back to the raw text.
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
- `src/renderer/src/utils/markdownToc.ts`: `markdownToc(markdown)` → `{ entries: TocEntry[], show }`.
  - Parses with `unified().use(remarkParse).use(remarkGfm)`, the parser side of what `react-markdown` renders the preview with, so its `position.start.line` matches the rendered heading's `data-heading-line`. The caller must pass exactly the string handed to `<Markdown>`, the body after the frontmatter split, or the lines drift.
  - `collectHeadings` walks the whole tree, so headings inside blockquotes and lists count.
  - `show` is `h1 > 1 || h2 > 1`. `entries` are depth 1–4, skipping the H1 when there is exactly one.
  - `TocEntry` also carries the optional `note` (a line standing for left-out entries: no heading carries its `line`, which is negative for XML) and `noteTag`, used by `xmlOutline`.
  - `flattenText(node)`: text and inline code values, image alt text, recursively; whitespace is collapsed. `mdast-util-to-string` is only a transitive dependency, so it is not imported.
- `src/renderer/src/utils/xmlDocument.ts`: `parseXml(text)` → `ParsedXml | null`. `DOMParser` with `application/xml`; `null` when a `<parsererror>` appears (Chromium's XHTML or jsdom's Mozilla namespace) or there is no root. Walks the DOM iteratively into plain `XmlElement` (`id` in document order, `name`, `attrs`, `children`, `parent`, `index`, `depth`) and `XmlLeaf` (trimmed non-empty text, comment, CDATA, PI, doctype) nodes, plus the XML declaration from a regex, since the DOM keeps none. `inlineText(el)` (one text child, ≤ `INLINE_TEXT_MAX` 80 characters, no newline) and `isFoldable(el)`.
- `src/renderer/src/utils/xmlOutline.ts`: `xmlOutline(doc)` → `MarkdownToc`. Iterative pre-order over elements that have element children, from depth 1 to `MAX_DEPTH` (4); `line` is the element id. Per parent the first `OUTLINE_PER_PARENT` (50) are listed and the rest become a `note` entry (`… N more`, `line: -1 - parent.id`, `noteTag` when all share a tag) after their siblings' subtrees. `xmlElementLabel(el)`: `tag · value` from the first of `id`, `name`, `key`, `title` attributes, else a `<name>` or `<title>` child's `inlineText`, whitespace collapsed, cut at 60 characters. `show` when at least two non-note entries.
- `src/renderer/src/utils/frontmatter.ts`:
  - `splitFrontmatter(text)` → `{ frontmatter: { entries } | null, body }`. Requires `---` on the first line (after an optional BOM), a closing `---` or `...`, a `KEY_LINE` as the first non-blank line inside (a `#` comment there fails it), and every later top-level line a `KEY_LINE`, blank or `#` comment (`parseEntries` returns `null` otherwise). `KEY_LINE` keys are identifiers — letters, digits, `_ $ @ . / -`, `:`-joined parts like `og:title` — or quoted; no spaces, no `*`. On any failure `frontmatter` is `null` and `body` is the untouched `text`, rendered as ordinary markdown. CRLF is accepted.
  - `entries` is `FrontmatterEntry[]` (`{ key, value }`, `value` of kind `text`, `list` or `raw`).
  - Handled: scalars (quoted, with `#` comments that follow whitespace stripped), `|`/`>` block scalars, multi-line plain scalars (folded), `[a, b]` flow lists, `- item` block lists (also at column 0 under the key). Anything nested stays `raw` as dedented source.
  - `commaSeparatedItems(text)`: a spaceless `a,b,c` with two or more non-empty parts → items, else `null`.
  - `linkifySegments(text)`: splits out `http(s)` URLs, leaving trailing sentence punctuation, a `*` (a URL in `**bold**`) and an unbalanced closing `)`/`]` to the prose. A comma followed by another `http(s)://` ends the URL, so `https://a,https://b` is two links.

### Renderer — page and styles
- `src/renderer/index.html`: the app's CSP adds `frame-src cinna-preview:`. `default-src 'self'` would otherwise refuse the frame, and nothing else may be framed.
- `src/renderer/src/assets/main.css`: `--color-html-page` (`#ffffff`, one value for both themes), the canvas behind a previewed page.
- `src/renderer/src/assets/main.css` (`@layer base`): the zebra rows, `.file-preview-table tbody tr:nth-child(odd) td` and `.file-preview-markdown tbody tr:nth-child(odd) td`. `CsvPreview` puts `file-preview-table` on its `<table>`, and `MarkdownPreview` puts `file-preview-markdown` on the markdown wrapper, beside `markdown-body`.

### Attachment badge names
- `src/renderer/src/components/chat/AttachmentBadge.tsx`: `AttachmentList` / `AttachmentBadge`, still source-agnostic. Preview routing lives entirely in the `onClick` callers. `previewsOnClick` (passed through `AttachmentList`) only changes the words: with it, a badge whose `previewKindFor(filename, mimeType)` is non-null is titled and named "Preview <name>", every other one "Download <name>". `MessageBubble.tsx` and `AgentAttachment.tsx` pass it; lists whose click always downloads do not.

### Tests
- `src/renderer/src/components/chat/FilePreviewModal.test.tsx`:
  - the entrance: waiting for settled content, the 150 ms fallback, and opens that are already settled;
  - pinning the card to the top;
  - focus moving in and back out;
  - the press guard;
  - the agent-file header and error states, including Open and Open folder disabled inside the ⋯ menu when the file has gone.
  - markdown frontmatter: the card sits outside `.markdown-body`, a URL value is a `_blank` link, and the body renders without a stray rule or setext heading.
  - python: highlighted tokens with the text intact, no Contents for a single definition, and a `data-heading-line` marker on each listed definition (not on a `def` inside a docstring).
- `src/renderer/src/utils/pythonOutline.test.ts`: depth 1 and 2 entries, decorators, `async`, nested functions and classes left out, docstrings and comments skipped, no panel for one definition.
- `FilePreviewModal.test.tsx`, `the Contents panel`: offered for long markdown and open by default, not for short markdown, non-markdown or an attachment csv, frontmatter not counted, the full-title hint after the delay and never for an entry that fits, a click scrolling the body and marking the entry current, the closed state persisted to `localStorage`, widening to the right with the body at the closed width, widening with a partial left shift when the right is short, the press guard after a toggle, the overlay after a slow load until a toggle, the root font size, a resize while no preview was open, and the overlay in a narrow window.
- `FilePreviewModal.test.tsx`, `the ⋯ menu`: item order, running an action without closing the preview, an outside press and Escape taken by the menu first, arrow-key movement, the spinning trigger with disabled items, and no menu for an attachment. `contentsGeometry` is exported for these tests.
- `src/renderer/src/utils/markdownToc.test.ts`: the `show` threshold (lone H1 with H2s, two H1s, H2s without an H1, one H1 and one H2, no headings), `#` in a code fence, setext headings, a split-off frontmatter body, H5/H6 excluded, distinct lines for repeated texts, and flattened inline markup.
- `src/renderer/src/components/chat/JsonTree.test.tsx`: the palette classes, chevron fold with count, Alt-click branch fold, a large document opening with only its top level unfolded, the exact 2000-value boundary, paging a huge container, 5000-level nesting (fails against a recursive walk), a small deep document folded at depth 32, the scroll shift and the `min-height` floor after a fold, array labels and the braces out of the tab order, and `parseJsonForTree` declining non-JSON. `FilePreviewModal.test.tsx` covers the tree for parsed text and the raw `<pre>` for truncated JSON.
- `src/renderer/src/components/chat/MessageBubble.frontmatter.test.tsx`: user and assistant bubbles show the card and a link, no stray rule, and keep the unsplit text as `data-message-markdown`; a leading rule alone makes no card.
- `src/renderer/src/utils/frontmatter.test.ts`: `splitFrontmatter` value shapes, nested values kept as source, CRLF/BOM/empty blocks; documents that are not frontmatter (prose or `**Summary**:` between rules, a `#` comment first, a non-key line after a key, no closing rule) left untouched; `commaSeparatedItems`; `linkifySegments`, including `**url**` and comma-joined URLs.
- `src/renderer/src/components/notes/NoteDetail.test.tsx` and `src/renderer/src/components/agents/local/InlineFileEditor.test.tsx`: the card renders above the document, a click on a link in it does not start editing, and the textarea a click elsewhere opens holds the raw text, frontmatter included.
- `src/renderer/src/stores/filePreview.store.test.ts`: agent-file opens, header actions (Open in browser included), error copy and attachment previews.
- `src/shared/filePreview.test.ts`: xml and its dialects, and `html`/`htm`/`xhtml`, by extension then MIME, for attachments and agent files.
- `src/renderer/src/components/chat/XmlTree.test.tsx` and `src/renderer/src/utils/xmlOutline.test.ts`: every node type rendered, chevron and Alt-click folds, a large document folded below the root, paging, row ids, `reveal` through folded ancestors and past the page cutoff; outline depth, ids, labels, the 50-per-parent note and its place, leaves left out, the two-entry threshold, and nothing for malformed text. `FilePreviewModal.test.tsx`, `xml`: the tree with Contents, a note entry that is not a button, the source fallback and its two notes, and a Contents click unfolding before it scrolls.
- `src/renderer/src/components/chat/FilePreviewModal.html.test.tsx`: the frame's URL and exact sandbox, token release on close, on another file and after a late answer, main's refusal in the body, the wide fixed-height card; Rendered/Source (the frame kept loaded, the truncation notice on Source only, Rendered again on the next open, not offered for other kinds); Open in browser in the ⋯ menu and as an attachment header button, its error row, and the ⋯ menu closing when the frame takes focus.
- `src/renderer/src/components/chat/AttachmentBadge.test.tsx`: "Preview" versus "Download" names, with and without `previewsOnClick`.
- `src/main/services/htmlPreview/htmlPreviewServer.test.ts`: token shape and URL, headers, assets typed by extension and a sibling page given the helper, 404 for unknown/released tokens and refused assets, encoded traversal reaching the gate as one segment, an attachment serving only its document, 413 over the cap, another profile served nothing (and the token forgotten), `GET`/`HEAD` only, the token cap.
- `src/main/services/htmlPreview/previewLinkHelper.test.ts`: where the helper goes (after `<head>`, not `<header>`; after a doctype or XML declaration), a page's own `<base>`, encodings and UTF-16 left alone, XHTML-safe; and in jsdom, web links retargeted to `_top`, fragments and sibling pages kept in the frame, `window.open` of a web URL turned into a top navigation.
- `src/main/host/desktop/htmlPreviewGuards.test.ts`: the main-frame and subframe navigation verdicts, the permission requester rule, preview download URLs, `safeHtmlFilename`, a preview never navigating the window to the app's own page, and the external-open gate (one open per activation window, and at once again after the user left the app and came back). The Electron wiring itself (`htmlPreview.ts`) and Chromium's sandbox enforcement have no automated test.
- `src/main/host/desktop/openInBrowserCopies.test.ts`, `src/main/services/agentFiles/openInBrowser.test.ts`: the `0700` copy folders, one per profile and attachment, cleared at start; the per-platform launch plan and its fallback.
- `src/main/services/agentFiles/agentFileService.test.ts`, `the HTML preview frame` and `openInBrowser`: the document and assets served whole, refusals without asking, the cap, climbs out however spelled, dotfiles and dot-folders, symlinks out, credential files, what a single-file versus folder approval covers; the browser launch and its refusals.

## IPC Channels

| Channel | Direction | Payload | Returns |
|---------|-----------|---------|---------|
| `files:read-preview` | renderer → main | `{ fileId: string, source?: 'cinna' \| 'local' }` | `{ success: true, text: string, truncated: boolean }` / `{ success: false, error, code? }` |
| `files:download` | renderer → main | `{ fileId, filename, source? }` | Reused for the modal Download button. See [File Attachments](../file_attachments/file_attachments_tech.md) |
| `agent-files:read-preview`, `agent-files:authorize`, `agent-files:open`, `agent-files:open-in-browser`, `agent-files:reveal` | renderer → main | `{ agentId, path }` | See [File References — Technical Details](../file_references/file_references_tech.md#ipc-channels) |
| `files:open-in-browser` | renderer → main | `{ fileId, filename, source? }` | `{ success: true }` / `{ success: false, error, code? }` (`not_previewable`, `launch_failed`, `invalid_input`, …) |
| `html-preview:open` | renderer → main | `HtmlPreviewOpenInput` | `{ success: true, token, url }` / `{ success: false, error, code? }`. Never asks for consent |
| `html-preview:release` | renderer → main | `token: string` | `{ success: true }` |

The `cinna-preview:` scheme is not IPC: the frame's requests reach `htmlPreviewServer.handle` through `session.protocol.handle`, and file bytes never cross to the renderer.

## Services & Key Methods

- `src/main/services/fileService.ts:readTextPreview()`: a capped read routed by source, decoded with `decodePreviewText`. Throws `FileError('not_found' | 'read_failed')`.
- `src/main/services/fileService.ts:readBytes()`: the same read without the decode, for the HTML frame.
- `src/main/services/htmlPreview/htmlPreviewServer.ts:createHtmlPreviewServer()`: `register`, `release`, `handle`.
- `src/main/services/agentFiles/agentFileService.ts`: `htmlDocumentAccess()`, `readHtmlDocument()`, `readHtmlAsset()`, `openInBrowser()`.
- `src/main/host/desktop/htmlPreview.ts:openAttachmentInBrowser()`: copy, then launch.
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
- `useUIStore.previewContentsOpen` / `togglePreviewContents()` (`src/renderer/src/stores/ui.store.ts`): whether the Contents panel shows, global across previews, persisted to `localStorage` key `cinna-preview-contents-open` (`'0'` closed; anything else, including absent, open).
- In `FilePreviewModal`: `windowWidth`, `animateWidthFor`, `closingFor` and `slowOpenFor` state and the `toggledAt` ref, for where the Contents panel goes and the press guard after a toggle.
- In `FilePreviewContents`: `active` state, the `pinned` ref for a clicked entry, and `fullTitle` state with its timer ref.
- `CsvPreview` local `useState`:
  - `filters: Record<number, string>`, a substring per column;
  - `sort: { col, dir } | null`.

  Both reset per file through `key={targetKey}` on `PreviewBody`, where `targetKey` is `attachment:<id>` or `agent-file:<agentId>:<path>`.
- `filtersEnabled` lives one level up, in `FilePreviewModal`, because the header toggle and the table must agree. It resets when `targetKey` changes.
- In `useCardEntrance`, refs hold the entrance state (started, timer, animations), the element focus goes back to, and whether the latest open came from the keyboard. `openedAt` in the modal is used by the press guard.
- In `FilePreviewModal`, the `lastOpen` ref and the `prevTarget` / `exitView` state hold the snapshot a closing preview fades out with.
- `CopyablePath` local state: `hovered`, `result` and `suppressed`, plus refs for the hint timer and `shownHint`.
- In `FilePreviewModal`: `htmlViewFor` (`{ openSeq, view }`), the Rendered/Source choice for one open; the `xmlReveal` ref `XmlTree` fills.
- In `HtmlFrame`: `loading` / `ready` (the URL) / `failed` state, and the live token in the effect's closure.
- In `XmlTree`: `collapsed` (element ids), `shown` (children per id), and the fold anchor ref.
- In `FileActionsMenu`: the iframe-focus `blur` timer.

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
- `OPEN_PRESS_GUARD_MS` = 500 (`FilePreviewModal.tsx`): how long after an open, or after a Contents toggle, an outside press is ignored.
- `CONTENTS_PANEL_WIDTH` = 240 (`FilePreviewContents.tsx`): the panel's width, and what the card widens by.
- `WINDOW_MARGIN` = 16, `CARD_MAX_WIDTH_REM` = 48, `OVERLAY_PADDING_X_REM` = 2, `CARD_BORDER_X` = 2 (`FilePreviewModal.tsx`): the inputs to `contentsGeometry` and the body's pinned width.
- `FULL_TITLE_DELAY_MS` = 250 (`FilePreviewContents.tsx`): how long the pointer rests on a cut-off entry before its full text shows.
- `cinna-preview-contents-open` (`localStorage`, `ui.store.ts`): the Contents panel's remembered state.
- `POINTER_ORIGIN_MAX_AGE_MS` = 1000 (`filePreview.store.ts`): the oldest pointer-down an attachment open may grow from.
- `MAX_HTML_PREVIEW_BYTES` = 20 MB (`htmlPreviewServer.ts`): the most a document or asset served to the frame may weigh; over it is 413, never a cut.
- `MAX_HTML_PREVIEW_TOKENS` = 16 (`htmlPreviewServer.ts`): live tokens; past it the oldest is dropped.
- `HTML_PREVIEW_SANDBOX` (`src/shared/htmlPreview.ts`): `allow-scripts allow-forms allow-modals allow-top-navigation-by-user-activation`.
- `OUTLINE_PER_PARENT` = 50, `MAX_DEPTH` = 4 (`xmlOutline.ts`); `INLINE_TEXT_MAX` = 80 (`xmlDocument.ts`).
- `<userData>/html-open-in-browser/` (`OPEN_IN_BROWSER_DIR`): Open in browser's attachment copies.
- Previewable extensions and MIME types:
  - attachments: the tables in `src/shared/filePreview.ts` (`txt`, `log`, `md`, `markdown`, `json`, `csv`, `tsv`, `yaml`, `yml`, and `py`/`pyi` plus MIME `text/x-python` / `text/x-script.python` as `python`; `xml`, `xsd`, `xsl`, `xslt`, `plist`, `rss`, `atom`, `kml`, `gpx`, `csproj`, `xaml` plus `application/xml` / `text/xml` as `xml`; `html`, `htm`, `xhtml` plus `text/html` / `application/xhtml+xml` as `html`);
  - agent files add `AGENT_TEXT_EXTENSIONS` from `src/shared/agentFiles.ts`.

## Security

- **The attachment byte cap is enforced in main**, in `fileService.readTextPreview`, which the IPC handler passes `MAX_PREVIEW_BYTES`. The renderer cannot request more.
- **Attachments have the same access control as download.**
  - `local` is gated by `chatFileRepo.getOwned(userId, …)`.
  - `cinna` is gated by the backend on the OAuth bearer: the owner or a session participant.

  Preview exposes no file the user could not already download.
- **Agent files** are gated by containment or consent and by the credential rule. See [File References — Technical Details](../file_references/file_references_tech.md#security).
- **Bytes stay in main.** File bytes are read only in the main process. For attachments, the renderer receives decoded text over IPC, never a path or a raw handle. An HTML page's bytes go to its frame over `cinna-preview:`, never over IPC; the renderer holds only the token URL.
- **No injection surface.**
  - `text` and unparseable `json` render inside `<pre>{text}</pre>`; `python` renders the hast lowlight builds from the text, as React elements (no `innerHTML`), the JSON tree renders keys and values as React text, and CSV cells render as `{cell}`, all escaped by React. Links in the tree are `http(s)` only, like frontmatter's.
  - Markdown uses the existing `react-markdown` stack without `rehype-raw`, the same trust boundary chat bubbles already use.
  - Frontmatter values render as React text; the only links it makes are `http(s)` URLs, and the main process's window-open handler refuses any other scheme anyway.
  - The XML tree renders names, attributes and text as React text. `DOMParser` fetches no external entity or DTD.
  - HTML is the one kind that runs. It is never put into the app's document: it runs in the frame below, and its Source view is the same escaped `CodePreview` as Python.

### HTML preview frame
The page runs its own scripts and loads remote content, by the user's decision. Everything below is what keeps it inside its frame; what it is still allowed to do is listed in [Known limits and accepted risks](file_preview.md#known-limits-and-accepted-risks).

- **The sandbox is `allow-scripts allow-forms allow-modals allow-top-navigation-by-user-activation`** (`HTML_PREVIEW_SANDBOX`).
  - **No `allow-same-origin`.** The page gets an opaque origin (`null`) instead of its `cinna-preview://<token>` one, so it cannot reach the app (`window.parent`'s DOM, `window.api`), keeps no storage or cookies of its own between opens, and every request it makes — its own `data.json` included — is cross-origin, hence the `*` CORS header below.
  - **No `allow-popups`.** A script could open a window without any click, and a popup would be a new window to guard. `window.open` and `target=_blank` therefore do nothing on their own; the link helper maps them to a top navigation.
  - `nodeIntegrationInSubFrames: false` is stated on the main window, so the preload and `window.api` never load into a subframe.
- **Top navigation happens only inside a user activation, and never lands.**
  - `allow-top-navigation-by-user-activation` lets the frame navigate the app window's main frame only while handling a click; Chromium enforces the gesture, so a script on its own cannot.
  - `guardPreviewFrames` → `will-navigate` → `mainFrameNavigation` asks first whether the initiating frame, or one of its ancestors, is a `cinna-preview:` document. If so the navigation is never allowed, not even to the app's own URL: an `http(s)` target is prevented and handed to `shell.openExternal`, anything else is blocked. In development the app page is itself `http`, and a preview click could otherwise reload the app or load another dev-server page (`trayPanel.html`) into the window. Only a navigation no preview started may go to the app's own URL (a reload; the packaged `file://` index by path, the dev server by origin); everything else is prevented. The main frame never leaves the app.
  - **One external open per click** (`createExternalOpenGate`). Chromium does not use up a frame's user activation on a top navigation, so for about five seconds after one click a page could keep navigating the top frame and open a tab each time — about five from one click. After an open, the gate refuses the next for `ACTIVATION_WINDOW_MS` (5 s), unless the window has since blurred and been focused again: the user left the app (following the link does exactly that) and came back, so a second link clicked on return is never refused.
- **The link helper is a convenience, not a guard.** It goes into every `text/html` or `application/xhtml+xml` response the scheme serves — the entry document and any sibling page reached by a relative link — so links keep working after the frame moves to another page. `injectPreviewLinkHelper` adds `<base target="_top">` and a capture-phase click listener that retargets a web link to `_top` and keeps a `#fragment` or a sibling page in the frame (`_self`), and replaces `window.open` with a `top.location` assignment (which Chromium allows only inside a click). Without it a web link would navigate the frame itself, which is blocked. A page that removes or overrides it breaks only its own links; nothing is enforced by it.
- **Subframes go only where `previewFrameNavigation` allows** (`will-frame-navigate`, main frame excluded):
  - any subframe may load `cinna-preview:` and `about:blank` / `about:srcdoc`;
  - the preview document itself may not leave for `http(s)` — a form, a script, a link the helper did not retarget — so the frame never becomes a web browser inside the app. Chromium reports no gesture there, so nothing is sent to the browser from it;
  - a frame the page embeds (anything below a preview document) may load `http(s)`, `data:` and `blob:`, and inherits the preview's sandbox;
  - anything else — `file:`, the app's origin, another custom scheme, a subframe outside any preview — is blocked.
- **Permissions:** `setPermissionRequestHandler` and `setPermissionCheckHandler` on the default session refuse every request or check from a subframe, from a `cinna-preview:` URL, or from origin `null`. The main frame keeps Electron's default, which grants. Before these handlers existed the default applied to every frame; the app has no subframes of its own, so only a preview is affected.
- **Downloads:** `will-download` cancels any download from `cinna-preview:`, `blob:null/…`, `blob:cinna-preview:…` or `data:`. The app's own downloads are blobs of its own origin and pass.
- **CSP:** `frame-src cinna-preview:` in `index.html` is the only frame source; `default-src 'self'` still covers everything else the app loads.
- **The token registry** (`htmlPreviewServer`): a token is 24 random bytes, issued by `html-preview:open` after the text preview's checks, and serves one document. It is profile-scoped — the profile that asked must be the active one on every request, and a mismatch deletes the token. At most 16 are live, the oldest dropped. `HtmlFrame` releases its token on unmount (close, or another file), and releases at once a token that arrives after unmount. `GET` and `HEAD` only; no listings, no writes.
- **Every request is re-checked.** The document goes through `readHtmlDocument` (containment or approval, a file, not a credential file, the html kind, dev/ino) or the attachment's own ownership and bearer read, each time; nothing is cached (`no-store`).
- **Asset confinement** (`readHtmlAsset`), for an agent file only — an attachment serves its document and nothing else:
  - the document's folder and its subtree, on the lexical join and again on the asset's realpath, so neither `..` nor a symlink leaves it;
  - no dot segments: every decoded segment is non-empty, starts with no `.` (so no `.`/`..`, and no dotfile or dot-folder: `.env*`, `.git`, `.ssh`, `.claude`), and has no `/`, `\`, `:` or NUL. The URL parser folds a literal `..` at the root; an encoded `%2F` stays inside one segment and is refused here;
  - no credential files, by the same rule as every agent-file read;
  - consent without a prompt: the asset must be inside the agent folder or under an approval already given. A page cannot raise the consent dialog. A single-file approval covers only that file, so an outside page approved that way renders without its assets;
  - at most 20 MB, refused (413) rather than cut, as the document is.
- **Response headers:** `Access-Control-Allow-Origin: *` for the opaque origin's own fetches (no credentials are involved), `Referrer-Policy: no-referrer` so the token never reaches a remote server in a Referer, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`.

### Open in browser
- **An agent file** passes the preview's gate (`htmlDocument`) and has its realpath re-taken right before the launch. It is opened where it is.
- **An attachment** is copied to `<userData>/html-open-in-browser/<id>/<name>`, where `<id>` is the first 32 hex characters of SHA-256 over the profile id and attachment id. The root and the folder are `chmod 0700` explicitly (a `mkdir` mode goes through the umask), the folder is emptied before each copy, and the whole root is removed at every start. It lives under the profile's `userData` rather than the system temp folder, which on Linux every user shares. `safeHtmlFilename` keeps the last path segment, replaces anything but letters, digits, space and `. - _ ( )`, strips a leading dot, cuts to 120 characters keeping the extension, and refuses a result that is not `.html`/`.htm`/`.xhtml`. The bytes come from `fileService.downloadToPath`, the download's own gates.
- **The launch** passes the file as its own argv element (`open -a <browser> <file>`, the browser executable, `xdg-open <file>`). Its last resort is `shell.openPath` on the `.html` file: a type outside `DEFAULT_APP_EXTENSIONS`, reached only after the browser launch failed and only for a file of the html kind, never one that could execute.

## Observability

- `logger('cinna-files')`: a `read` success line (`fileId, bytes, truncated, durationMs`), plus `logger.error` on a network failure or non-OK status. This mirrors `downloadToPath`.
- Renderer `createLogger('file-preview')`: warns with the failure code when an agent file cannot be authorized or revealed.
- `createLogger('html-preview')` in main: a refused permission (by name), a cancelled preview download, a blocked frame or main-frame navigation (the verdict only), a link sent to the browser, a refused request (`kind`, `status`), a served one at debug (`kind`, `bytes`, `durationMs`), and a failed launch or copy cleanup by error name. Never a path or a URL.
- `createLogger('agent-files')`: `refused a preview asset outside its document folder` (`pathLength`), and `opened an agent file` with `strategy: 'browser'`.
- **Errors reach the modal as data:**
  - Attachment errors cross IPC as `{ success: false, error, code }` via `ipcErrorShape`, and the store shows `error` in the modal.
  - The Download button keeps its own `useFileDownloadStore` error path.
  - Agent-file failures arrive with their code and decide the body copy.
