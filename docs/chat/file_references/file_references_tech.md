# File References — Technical Details

## File Locations

### Shared (cross-process)
- `src/shared/agentFiles.ts`: imported by both processes, so it uses no Node `path`.
  - `fileRefCandidatePath(text)`: the shape filter. Returns the path with any `:line[:col]` suffix stripped, or null.
  - `extractInlineCodeSpans(markdown)`: a hand-written scanner.
    - Skips fenced and indented code blocks.
    - Matches CommonMark backtick runs within a paragraph.
    - Scans headings and table rows as standalone lines.
  - `extractFileRefCandidates(markdowns)`: spans across several documents, in order. Shape-filtered, de-duplicated (the first occurrence wins) and capped at `MAX_FILE_REF_CANDIDATES`.
  - `agentFilePreviewKindFor(filename)`: `previewKindFor`, plus `AGENT_TEXT_EXTENSIONS` rendered as `text`. `py` is not in that set: `previewKindFor` already maps it to `python`, which is highlighted.
  - `isCredentialFilePath(path, agentDir)`: the credential-name rule — dotenv names, `*.pem`/`*.key`, `SSH_PRIVATE_KEY_PREFIXES` (not `*.pub`), `CREDENTIAL_FILE_NAMES`, and `CREDENTIAL_PATH_SUFFIXES` matched on the lower-cased path. Passing `agentDir` enables the `credentials/` clause.
  - `isCredentialFileRef(ref)`: that rule for a resolved reference, without the agent folder. An inside ref is judged by `/<displayPath>` against a `/` root, so the `credentials/` clause still applies; an outside ref by its realpath. Used by the preview store and the right-click menu; main refuses regardless.
  - `agentFileContentKind(name)`: `text`, `binary` or `unknown`, from the name alone. `text` covers every preview kind, `TEXT_DOCUMENT_EXTENSIONS`, `log`/`out`/`err`, rotated logs (`.log.<n>`) and the conventional names in `TEXT_FILE_NAMES` (`Makefile`, `Dockerfile`, `.gitignore`, `LICENSE`, `.env.example`…); `binary` is `BINARY_DOCUMENT_EXTENSIONS`; anything else is `unknown`.
  - `agentFileExtension` and `agentFileName`.
  - `BINARY_DOCUMENT_EXTENSIONS`, `TEXT_DOCUMENT_EXTENSIONS`, and `DEFAULT_APP_EXTENSIONS` (the union of the two).
  - `AgentFileConsentPurpose` (`'show' | 'read'`) and `AuthorizeAgentFileInput` (`AgentFilePathInput` plus an optional `purpose`).
  - Types: `AgentFileRef`, `AgentFileRefKind`, `AgentFileOpenStrategy`, `AgentFileErrorCode`, `AgentFileFailure`, and the IPC input and result types.
- `src/shared/filePreview.ts`: `decodePreviewText(bytes, truncated)`, the truncation-safe decode shared with attachment previews.

### Main process — services
- `src/main/services/agentFiles/agentFileService.ts`: `createAgentFileService(deps)`, with `resolve`, `authorize`, `readPreview`, `readText`, `open`, `openInBrowser` and `reveal`, and the HTML preview frame's `htmlDocumentAccess`, `readHtmlDocument` and `readHtmlAsset` (documented with [File Preview — Technical Details](../file_preview/file_preview_tech.md)).
- `src/main/services/agentFiles/openInBrowser.ts`: `browserLaunchPlan` and `createBrowserLauncher`, the default-browser launch behind Open in browser.
- `src/main/services/agentFiles/resolver.ts`: `resolveFileRefs`, `displayPathFor` and `homeDisplayPath`.
- `src/main/services/agentFiles/consent.ts`:
  - `createConsentRegistry`, `canApproveDirectory` and `consentDialogOptions`;
  - the `ConsentRequest`, `ConsentAnswer` and `ConsentPrompt` types.
- `src/main/services/agentFiles/canonicalPath.ts`: `createPathCanonicalizer` and `DARWIN_DATA_VOLUME`.
- `src/main/services/agentFiles/openStrategy.ts`: `chooseOpenStrategy` and `findDefaultEditor`.
- `src/main/host/desktop/agentFiles.ts`: the production wiring (`agentFileService`, `openInBrowser`) and `nativeConsentPrompt(win)`.
- `src/main/host/desktop/clipboard.ts`: `writeClipboardText(text, write?)`, the main-side clipboard bridge behind `clipboard:write-text`. Refuses a non-string or anything over `MAX_CLIPBOARD_TEXT_LENGTH` (8M characters, above what a 4 MB UTF-8 file can decode to), and returns a thrown write as `{ success: false }`.

### Main process — reused from Local Agents
- `src/main/services/localAgents/localAgentService.ts`:
  - `locate(userId, agentId)` finds the agent folder;
  - `get()` supplies the agent name for the dialog;
  - `openInTextEditor(target)` is exported for **Open**.
- `src/main/services/localAgents/openInService.ts`: `launchEditor(tool, target, cwd)`, factored out of `openFolderInEditor` so a file and a folder launch the same way.
  - The service's agents-roots guard stays on folders.
  - Validating `target` is the caller's job.
- `src/main/services/localAgents/homePath.ts`: `isGuardedLocation(path, platform)`, which compares both sides lower-cased.
- `src/main/services/localAgents/pathRules.ts`: `isPlausiblePath` (absolute, no NUL, shorter than 4096 characters) and `isWithin`.
- `src/main/services/localAgents/toolDetectionService.ts`: `get(id)`, called through `findDefaultEditor`.

### Main process — IPC
- `src/main/ipc/agent_files.ipc.ts`: `registerAgentFileHandlers()`. Seven thin controllers.
  - Each calls `userActivation.requireActivated()` and then the service.
  - `authorize` passes `nativeConsentPrompt(BrowserWindow.fromWebContents(event.sender))`.
- `src/main/ipc/app.ipc.ts`: `clipboard:write-text` → `writeClipboardText`. Unlike the agent-file handlers it does not call `requireActivated()`.
- `src/main/ipc/index.ts`: registers the handlers after the local-agent handlers.

### Preload
- `src/preload/index.ts`:
  - `window.api.agentFiles.{resolve, authorize, readPreview, readText, open, reveal, openInBrowser}`, each an `ipcRenderer.invoke`;
  - `window.api.clipboard.writeText(text)` → `clipboard:write-text`.

### Renderer
- `src/renderer/src/components/chat/fileRefs.tsx`: `FileRefContext`, `chatMarkdownComponents` (with `MarkdownPre` and `MarkdownCode`), `collectFileRefSources` and `FileRefResolver`.
- `src/renderer/src/hooks/useAgentFileRefs.ts`: `useAgentFileRefs(sources)`, `hashCandidates` and the `FileRefScope` type.
- `src/renderer/src/components/chat/MessageStream.tsx`: collects the sources, mounts the resolver, and provides each bubble's scope.
- `src/renderer/src/components/chat/MessageBubble.tsx`: renders with `chatMarkdownComponents`, and provides a null scope while streaming.
- `src/renderer/src/stores/filePreview.store.ts`: `openAgentFile`, `openAgentFileExternally`, `revealAgentFile`, and the error-copy helpers.
- `src/renderer/src/utils/agentFileAccess.ts`: `authorizeAgentFile(input)` (shared by the preview store and the menu) and `readAgentFileText(agentId, ref, { onAuthorize? })`.
- `src/renderer/src/components/chat/MessageContextMenu.tsx`: the reference items (`messageMenuItems`, `referenceDraft` and the file actions). `messageMenuItems` puts `open-in-browser` in a group of its own, first, when `previewKindFor(ref.path) === 'html'` and the file is not path-only; its action runs `authorizeAgentFile` under `consentPending` (so the dialog's blur keeps the menu), closes on a decline, then `window.api.agentFiles.openInBrowser`. Its text half belongs to [Conversation UI tech](../conversation_ui/conversation_ui_tech.md#message-context-actions).
- `src/renderer/src/utils/fileNote.ts`: `fileNoteFromContents(path, text)` and `fenceLanguageFor(fileName)`.
- `src/renderer/src/utils/startAgentChat.ts`: `startAgentChat(agentId, { draft? })` and `unavailableAgentMessage(agents, agentId, missing)`, shared with the chat-starting shortcuts.
- `src/renderer/src/components/chat/FilePreviewModal.tsx`: the agent-file header and states. See [File Preview — Technical Details](../file_preview/file_preview_tech.md).
- `src/renderer/src/assets/main.css`: `.markdown-body code.file-ref`, inside `@layer base`.

### Tests
- `src/shared/agentFiles.test.ts`: extraction, the shape filter, credential names (SSH keys and their `.pub`, tool stores, path endings as whole segments, and resolved refs), preview kinds and content kinds.
- `src/main/services/agentFiles/resolver.test.ts`, on tmp-dir fixtures:
  - direct resolution: relative, `../`, absolute, `~/`, a symlink escape, folders;
  - the base heuristic: a single match, an ambiguous match, earlier spans only, `..`;
  - caps;
  - guarded folders, including the real guard with mixed-case spellings;
  - data-volume spellings.
- `src/main/services/agentFiles/consent.test.ts`: the registry, refused folders and the dialog copy, `show` and `read`.
- `src/main/services/agentFiles/openStrategy.test.ts`: the strategy table.
- `src/main/services/agentFiles/canonicalPath.test.ts`: canonicalisation against an injected data volume.
- `src/main/services/agentFiles/agentFileService.test.ts`:
  - refusal without consent, and approvals kept per profile;
  - credential files;
  - a file swapped between the check and the read;
  - one shared dialog per path;
  - `authorize` asking in `read` words only for exactly `'read'`;
  - `readText`: whole and untruncated, outside only after approval, credential files, binary types and folders refused unread, the cap exact and one byte over, NUL and invalid UTF-8, a swap between check and read;
  - open and reveal;
  - Open in browser (html only, outside only after approval, a failed launch), and the HTML frame's document and asset gate (see [File Preview — Technical Details](../file_preview/file_preview_tech.md#tests)).
- `src/main/services/agentFiles/openInBrowser.test.ts`: the per-platform launch plan and its fallback.
- `src/main/host/desktop/clipboard.test.ts`: the write, and refusal of a non-string, an oversized payload and a throwing write.
- `src/renderer/src/components/chat/MessageContextMenu.fileRefs.test.tsx`: the items per reference kind, a selection inside a path, keyboard across the divider; copy through main's clipboard after authorizing, main's reason kept in the open menu, the menu surviving the consent dialog, a decline reading nothing, and a blur after the consent call closing it; the running item's spinner, `aria-disabled` items and focus back on a failed item; top- versus bottom-anchored placement with the error row reserved; notes titled by heading or name and fenced code; the path copied without asking; the new-chat landing, a draft appended on a new line, and a disabled agent; Open in browser first for an HTML file, after authorizing, with main's failure in the menu and nothing opened on a decline.
- `src/renderer/src/utils/fileNote.test.ts`: title order (frontmatter, H1, any heading, name; headings in fences ignored), raw versus fenced bodies, fence length and `fenceLanguageFor`.
- `src/main/services/localAgents/homeAccessService.test.ts`: guarded folders spelled in another case.
- `src/renderer/src/components/chat/fileRefs.test.tsx`: the `code` override and `collectFileRefSources`.
- `src/renderer/src/components/chat/MessageStream.fileRefs.test.tsx`: links in the transcript, and none in a streaming bubble.
- `src/renderer/src/hooks/useAgentFileRefs.test.tsx`: keeping the previous links, stable identity, and a failed resolve.
- `src/renderer/src/stores/filePreview.store.test.ts`: agent-file opens, header actions and error copy.
- `src/renderer/src/components/chat/FilePreviewModal.test.tsx`: entrance, focus, the press guard, and the agent-file header and errors.
- `src/renderer/src/assets/fileRef.css.test.ts`: the link CSS, asserted as text because jsdom does not lay out.

## Database Schema

None.
- Approvals are an in-memory map inside `createConsentRegistry`.
- Resolved references live in the TanStack Query cache.

## IPC Channels

| Channel | Payload | Returns |
|---------|---------|---------|
| `agent-files:resolve` | `{ agentId, candidates: string[] }` | `{ success: true, refs: AgentFileRef[] }` or `AgentFileFailure` |
| `agent-files:authorize` | `{ agentId, path, purpose? }` (`'show'` default, or `'read'`) | `{ success: true, approved: boolean }` or `AgentFileFailure`. May show the native dialog, worded by `purpose` |
| `agent-files:read-preview` | `{ agentId, path }` | `{ success: true, text, truncated }` or `AgentFileFailure` |
| `agent-files:read-text` | `{ agentId, path }` | `{ success: true, text }` (the whole file) or `AgentFileFailure` |
| `agent-files:open` | `{ agentId, path }` | `{ success: true }` or `AgentFileFailure` |
| `agent-files:open-in-browser` | `{ agentId, path }` | `{ success: true }` or `AgentFileFailure`. HTML only; never asks |
| `agent-files:reveal` | `{ agentId, path }` | `{ success: true }` or `AgentFileFailure` |
| `clipboard:write-text` | `text: string` | `{ success: boolean }`. Registered in `app.ipc.ts`; not agent-file specific |

- **Failures are returned, not thrown.** Every failure is `{ success: false, code, error }`. `ipcHandle` rethrows a `DomainError` as a plain `Error`, and the code does not survive `contextBridge`.
  - The exception is `requireActivated()`, which throws before the service runs.
  - The store turns a thrown call into a message with `unwrapIpcError`.
- **Every payload is re-validated.** The service treats each payload as `unknown`.
  - `path` must pass `isPlausiblePath`.
  - `candidates` must be an array, and is cut to 2000 entries before the walk.

### Error codes

| Code | When | Message |
|------|------|---------|
| `invalid_input` | Malformed request | "Nothing to open." |
| `agent_not_found` | No folder agent with that id, or its folder cannot be realpathed | `locate`'s message, else "That agent is no longer in your agents folder." |
| `not_found` | The path is missing, is neither a file nor a folder, or was swapped between the check and the read | "That file is no longer there." |
| `needs_consent` | Outside the agent folder and not approved | "Cinna needs your approval to use a file outside the agent folder." |
| `credential_file` | Preview or whole-file read of a credential file | "Preview is off for credential files." (preview); "Cinna does not read credential files." (`readText`) |
| `not_previewable` | A type the modal cannot render, or a non-HTML file given to the HTML frame or Open in browser | "No preview for this file type." |
| `not_a_file` | A folder where a file was needed | "That is a folder, not a file." |
| `read_failed` | The read threw | "Could not read the file." |
| `too_large` | A whole-file read over `MAX_AGENT_FILE_TEXT_BYTES`, or an HTML frame document or asset over `MAX_HTML_PREVIEW_BYTES`, at the stat or at the read | "This file is over 4 MB.", the figure computed from the cap; "This file is too large to show." for the frame (served as 413) |
| `not_text` | A whole-file read of a `binary` content kind (refused unread), or bytes with a NUL or invalid UTF-8 | "This isn't a text file." |
| `launch_failed` | The launch threw, or the path moved before launch | "Could not open the file." `shell.openPath` refusing gives "No app could open this file.", a failed reveal "Could not show the file in its folder.", and a failed Open in browser "No browser could open this file." |

## Services & Key Methods

### `src/main/services/agentFiles/agentFileService.ts`
- `createAgentFileService(deps)`: every external dependency is injected:
  - agent lookup: `locateAgent`, `agentName`;
  - consent: `getConsentUserId`, `consent`;
  - platform and paths: `platform`, `isGuardedLocation`, `paths`, `home`, `maxPreviewBytes`, `maxTextBytes`. `isGuardedLocation` is required, so no wiring can forget it.
  - launching: `getDefaultEditor`, `launchEditor`, `openPath`, `openInTextEditor`, `showItemInFolder`, `openInBrowser`.
- `target(input)` (private):
  1. validates the input;
  2. locates the agent folder;
  3. realpaths the folder and the path through the canonicaliser;
  4. stats the path.

  It records the kind, `{dev, ino}`, `inside` (decided on realpaths) and the profile user.
- `permitted(input)` (private): `target`, then inside or `consent.isApproved`. Otherwise returns `needs_consent` and logs the path length.
- `isCredential(found)` (private): the credential rule, applied to the canonical realpath and to the lexical spelling of the requested path.
- `resolve(input)`: `resolveFileRefs` over the located folder.
- `authorize(input, prompt)`:
  - An inside or already approved path returns `approved: true` with no dialog.
  - Otherwise there is one in-flight promise per `userId\0realpath` in the `asking` map, so an overlapping call shares the first dialog, that dialog's window and its wording. The key has no purpose in it, because an approval does not either.
  - `purpose` is read off the untrusted input: exactly `'read'` is `read`, anything else `show`.
  - On approval it records the file, and also the folder when the checkbox was ticked and `canApproveDirectory` allows it.
- `readPreview(input)`:
  1. checks, in order, `permitted`, `not_a_file`, `credential_file` and `not_previewable`;
  2. opens the file with `open()` and compares `handle.stat()` dev/ino with the checked stat;
  3. reads at most `maxPreviewBytes` and decodes with `decodePreviewText`.
- `readText(input)`: the whole file, for Copy contents and Save to Notes.
  1. checks, in order, `permitted`, `not_a_file`, `credential_file` and, by `agentFileContentKind` of the realpath's name, `not_text` for a `binary` kind;
  2. opens the file and compares dev/ino, as `readPreview` does;
  3. refuses `too_large` when the opened size is over `maxTextBytes` (default `MAX_AGENT_FILE_TEXT_BYTES`);
  4. reads into a buffer one byte past the cap, so a file that grew since the stat is refused rather than cut short;
  5. refuses `not_text` for a NUL byte, or when a `fatal` `TextDecoder('utf-8')` throws.

  Logs the byte count and `inside`, never the path.
- `open(input)`:
  1. `permitted`;
  2. looks up the default editor (files only);
  3. `chooseOpenStrategy`;
  4. re-takes `paths.realpath(requested)` and returns `launch_failed` if it differs;
  5. launches.
- `openInBrowser(input)`: `permitted`, `not_a_file`, `credential_file`, `not_previewable` unless the name is of the html kind; re-takes the realpath and returns `launch_failed` if it moved; then `deps.openInBrowser(real)`.
- `reveal(input)`: `permitted`, then `showItemInFolder(real)`.

### `src/main/services/agentFiles/resolver.ts`
- `resolveFileRefs(agentDir, candidates, options)`. The options are `home`, `maxCandidates`, `maxBases`, `isGuarded` (required) and `paths`. It:
  - realpaths the agent folder (a missing folder means no refs) and the home folder;
  - uses `probe(path)`, which caches one stat per distinct path per call;
  - uses `guardedRootOf`, which walks a lexical spelling up to its outermost guarded ancestor;
  - treats a path as `offLimits` when its guarded root contains neither spelling of the agent folder;
  - grows the bases from each hit: an inside hit adds its own folder and ancestors inside the agent folder; an outside hit adds only its own folder; an off-limits hit adds nothing.
- `displayPathFor(real, realAgentDir, realHome)` and `homeDisplayPath(real, realHome)`: return an agent-relative path (`.` for the agent folder itself), `~`, `~/…`, or an absolute path.

### `src/main/services/agentFiles/consent.ts`
- `createConsentRegistry({ homeDirs?, paths? })`: per-user `{files, dirs}` sets of canonical paths.
  - Methods: `isApproved`, `approvePath`, `approveDirectory` and `canApproveDirectory`.
  - `approveDirectory` returns false and approves nothing for a refused folder.
- `canApproveDirectory(dir, homeDirs, paths)`: checks both the canonical and the lexical spelling, and refuses when either:
  - contains any home spelling (the home as given, its realpath, or either canonicalised);
  - is a filesystem root;
  - is at or above a volume root, per `VOLUME_ROOT_DEPTH`.
- `consentDialogOptions(request, platform)`: builds `MessageBoxOptions`.
  - Button 0 shows (or reads) and button 1 cancels.
  - The message and button text depend on the kind and on `purpose`: `read` on a file gives "Let Cinna read a file outside <agent>'s folder?" and **Read file**.
  - Detail lines: the display path; for `read`, "Cinna reads it to copy it or save it to Notes.", otherwise the preview notice for a previewable file that is not a credential file; `Folder: <dir>` when it differs from the path.
  - The checkbox appears only when `offerDir` is set.

### `src/main/services/agentFiles/canonicalPath.ts`
- `createPathCanonicalizer({ platform, dataVolume, stat, statSync })`:
  - On darwin, it strips a leading `/System/Volumes/Data` when both spellings stat to the same dev/ino. Anywhere else, or when the stat fails, the path comes back unchanged.
  - `lexical` strips the prefix without touching the disk.
  - `canonical` and `canonicalSync` strip it only when both spellings stat to the same file.
  - `realpath` is `fs.realpath` followed by `canonical`.

### `src/main/services/agentFiles/openStrategy.ts`
- `chooseOpenStrategy({ kind, filename, platform, hasDefaultEditor })`: pure. It checks, in order:
  1. a folder → `reveal`;
  2. a credential name → `editor`, else `text-editor` on darwin, else `reveal`;
  3. a binary document → `default-app`;
  4. a default editor → `editor`;
  5. a text document → `default-app`;
  6. darwin → `text-editor`;
  7. otherwise → `reveal`.
- `findDefaultEditor(setting, getTool)`: returns the `localAgentsDefaultTool` tool only when it is a known id, available, has a path, and is of kind `editor`. Otherwise null.

### `src/main/host/desktop/agentFiles.ts`
- `agentFileService`: the production wiring.
  - `locateAgent` goes through `localAgentService.locate(getSettingsScopeUserId(), …)`, since folder agents are settings-scoped.
  - `agentName` goes through `localAgentService.get`, falling back to "this agent".
  - `getConsentUserId` is `getProfileScopeUserId`.
  - `openPath` and `showItemInFolder` are Electron's `shell`.
- `nativeConsentPrompt(win)`: calls `dialog.showMessageBox(win, options)`, attached to the window that asked. When the sender has no window, the dialog is app-modal. `approved` is button 0, and `rememberDir` is the checkbox.

## Renderer Components

### `src/renderer/src/components/chat/fileRefs.tsx`
- `FileRefContext`: the `FileRefScope` (`{agentId, refs: Map<text, AgentFileRef>}`) for the bubble being rendered. It is null outside a folder agent's chat and while streaming.
- `MarkdownPre`: provides `InsidePreContext`, because react-markdown 10 has no `inline` prop to tell a block's `code` from inline code.
- `fileRefTargetOf(element)`: the `FileRefTarget` (`{ agentId, ref }`) a rendered reference stands for, else null. Backed by a module-level `WeakMap` that `MarkdownCode`'s ref callback fills on mount and clears on unmount; it is how the context menu, which starts from a DOM node, learns what a right-clicked span names.
- `MarkdownCode`:
  - **Links only when** it is not inside `pre`, a scope exists, its children are plain text, and that text is a key.
  - **Adds** `file-ref`, `role="button"`, `tabIndex=0`, `aria-label` and `title`.
  - **On click**, calls `openAgentFile(agentId, ref, {x, y})`, unless text is selected or `event.detail > 1`.
  - **Keyboard**: a keyboard-generated click (`detail === 0`), Enter or Space passes a null origin.
- `chatMarkdownComponents`: `markdownComponents` plus the two overrides. It is defined at module level, so the memoized `MarkdownContent` never sees a new identity.
- `collectFileRefSources(messages, agents, rootAgentId)`: returns `Map<agentId, markdown[]>` in transcript order.
  - User rows go under `addressedAgentId ?? rootAgentId`, using their content with nested code fences repaired.
  - Assistant rows go under `sourceAgentId ?? rootAgentId`, using their `text` and `notice` parts (or their content when there are no parts), with `<cinna_attach>` tags stripped and then nested code fences repaired.
  - Both repairs call `repairNestedFences` (`src/renderer/src/utils/nestedFences.ts`) the way `MessageBubble` does, so the scanner reads the text the bubble renders; see [Conversation UI tech](../conversation_ui/conversation_ui_tech.md#nested-code-fences).
  - Only agents with `capabilities.cwd === true` are included.
- `FileRefResolver({sources, onChange})`: renders nothing.
  - It runs the hook, reports scopes upward, and reports an empty map on unmount.
  - It is a sibling of the transcript rather than a wrapper, so mounting it when the first folder agent appears never remounts the bubbles.

### `src/renderer/src/hooks/useAgentFileRefs.ts`
- `useAgentFileRefs(sources)`: `useQueries`, with one query per agent.
  - Key: `['agent-file-refs', agentId, hashCandidates(candidates)]`.
  - `staleTime` 30 s and `retry: false`.
  - An empty candidate list skips IPC, and a failed call resolves to `[]`.
- `lastAnswer` ref: each agent's last data, returned while its current query has none. See the business rule on flicker.
- **Stable identity:** the returned map keeps its identity while no agent's data has changed, so the bubbles' context does not churn on every render.
- `hashCandidates(candidates)`: FNV-1a over the ordered list, prefixed with the list's length.

### `src/renderer/src/components/chat/MessageStream.tsx`
- `fileRefSources`: `collectFileRefSources(chatData.messages, agents, rootAgentId)`, memoized.
- `<FileRefResolver key={chatId}>`: mounted only when some folder agent has sources. It is keyed by chat, because the hook's remembered answers belong to one transcript.
- `fileRefScopeFor(agentId)`: wraps each `MessageBubble` in a `FileRefContext.Provider`.
  - Both part-rendering paths use `sourceAgentId ?? rootAgentId`.
  - The plain message path uses `addressedAgentId ?? rootAgentId` for user rows.

### `src/renderer/src/components/chat/MessageBubble.tsx`
- Reads `FileRefContext`, and provides `null` in its place around the user and assistant `MarkdownContent` while `isStreaming`.

### `src/renderer/src/stores/filePreview.store.ts` (agent-file half)
- `openAgentFile(agentId, ref, origin)`:
  1. `agentOpenToken` guards the whole sequence across the dialog, so a newer open (agent file or attachment) wins.
  2. Calls `authorize`, for inside paths too.
     - Denied: return.
     - A failure or a throw: `openFailed('authorize')`.
  3. For a folder, calls `reveal`. A failure calls `openFailed('reveal')`.
  4. For a file:
     - checks the credential name with `isCredentialFileRef`;
     - runs `agentFilePreviewKindFor`;
     - either shows a notice without reading, or calls `readPreview` under the `requestId` guard.

     `credential_file` and `not_previewable` map to notices; any other failure becomes a `preview`-step error.
- `openAgentFileExternally()` and `revealAgentFile()` both call `runAction(action)`:
  - files only, and one action at a time (`pendingAction`);
  - authorize again, then `open` or `reveal`;
  - a failure sets `actionError {action, code, reason}`;
  - a result for a target no longer shown is dropped.
- `agentFileErrorText(ref, step, code, reason)`, `actionErrorText(actionError)` and `actionErrorRepeatsBody(state)`: the body and action-row copy.

### `src/renderer/src/components/chat/MessageContextMenu.tsx` (reference half)
- `useMessageContextMenu`: when no selection is under the pointer and the code target is a `CODE` element, `fileRefTargetOf` supplies `MenuState.file`. A block (`pre`) never has one.
- `messageMenuItems(file)`: the groups, decided once per opening. No file → `[copy-text, save-text]`. A `dir`, `isCredentialFileRef`, or a `binary` `agentFileContentKind` of `ref.path` → `[copy-path, reference]` only; otherwise `[copy-contents, save-contents]` then `[copy-path, reference]`, with a `role="separator"` between groups, which the arrow keys skip. The menu widens from `w-48` to `w-56` for a file.
- `referenceDraft(ref)`: "The file \`<path>\` " or "The folder \`<path>\` ", with a trailing space.
- Actions all go through `run(item, action, fallback)`: the single in-flight guard (`acting` ref), `busyItem` state for the running item, and a `fail(reason)` callback; a throw becomes `unwrapIpcError(err, fallback)`. After a failure, focus returns to the item's `[data-menu-item]` button. The running item shows a `Loader2` spinner (`aria-busy`); the others dim. Items take `aria-disabled` while anything runs, not `disabled`, so focus never falls out of the menu and the arrow keys still move:
  - `copy-contents`: `readAgentFileText`, then `window.api.clipboard.writeText`; `success: false` → "Could not copy the file.";
  - `save-contents`: `readAgentFileText`, `fileNoteFromContents`, then the shared `saveNote(body, title)` (`useSaveMessageNote` plus the Notes navigation);
  - `copy-path`: `navigator.clipboard.writeText(ref.path)`, no authorize;
  - `reference`: `fetchQuery(['agents'])`, `startableAgent`, then `startAgentChat(agent.id, { draft: referenceDraft(ref) })`; otherwise a toast from `unavailableAgentMessage(..., 'That agent is no longer available')`. Closes the menu either way.
- `fileText(target, fail)`: a `denied` outcome closes the menu; a `failed` one reports main's sentence through `fail`. It passes `onAuthorize` to set the `consentPending` ref.
- The window `blur` listener closes the menu only while `consentPending` is false — the authorize call, not the whole action — so the consent dialog does not dismiss it, and a real switch away during the read or the note still does.
- Placement is decided once, at open, in a layout effect: when the menu plus `ERROR_ROW_RESERVE` (48 px) and an 8 px margin fits below the pointer, it is top-anchored with the error row under the items; otherwise it is bottom-anchored (`MenuPosition.bottom`) with the error row above them. An error then grows the menu away from the pointer, and no item moves under it.

### `src/renderer/src/utils/agentFileAccess.ts`
- `authorizeAgentFile(input)`: always main's answer, inside refs included (see the business rule on re-checking inside references).
- `readAgentFileText(agentId, ref, { onAuthorize })`: authorize with `purpose: 'read'`, then `readText`. `onAuthorize(true)` before the authorize call and `onAuthorize(false)` after it, in a `finally`, bracket the only time main may be showing a dialog. Never throws; returns `{status: 'text', text}`, `{status: 'denied'}`, or `{status: 'failed', code, error}` (`code` null when a call threw).

### `src/renderer/src/utils/fileNote.ts`
- `fileNoteFromContents(path, text)`: title from `markdownTitle` for `md`/`markdown` — frontmatter `title:` (via `splitFrontmatter`, text values only), else the first level-1 heading, else the first heading; ATX and setext, fenced blocks skipped; cut to 80 characters — else the file name. `md`, `markdown` and `txt` bodies are raw; anything else is fenced with a run of backticks longer than any inside (at least three) and `fenceLanguageFor`'s tag.
- `fenceLanguageFor(fileName)`: `LANGUAGE_BY_NAME` (`Makefile`, `Dockerfile`…) then `LANGUAGE_BY_EXTENSION`, else `''`.

### `src/renderer/src/utils/startAgentChat.ts`
- `startAgentChat(agentId, { draft })`: with a draft, updates the composer draft keyed by `composerDraftKey(profile, NEW_CHAT_DRAFT_SURFACE)` — the draft alone, or the existing text with trailing newlines trimmed, a newline, then the draft — before setting `activeJobId` null, `pendingAgentId`, `activeView: 'chat'` and `sidebarTab: 'chats'`. Writing first means the text is there when `ChatWorkspace` mounts.
- `NEW_CHAT_DRAFT_SURFACE` (`composerDraft.store.ts`) is `'dashboard'`, the surface `useComposerDraftKey` uses with no chat and no agent page; naming it keeps the two in step.

### `src/renderer/src/assets/main.css`
- `.markdown-body code.file-ref`:
  - a `--file-ref-fill` background, `--color-bg-hover` mixed with `--color-accent` (orange on dark, blue on light):
    - `12%` by default (dark);
    - `14%` under `[data-theme="light"]`;
  - an inset 1px `box-shadow` edge in `--file-ref-edge`, a `color-mix` of `--file-ref-fill`:
    - with `white 10%` by default (dark);
    - with `black 6%` under `[data-theme="light"]`;
  - `:hover` switches to `--file-ref-edge-hover` (`white 18%` / `black 12%`), with a 120 ms `box-shadow` transition;
  - a `:focus-visible` 2px accent outline with a 1px offset;
  - no border and no `box-decoration-break`.

## Configuration

- `MAX_FILE_REF_CANDIDATES` = 500 (`src/shared/agentFiles.ts`): per agent per call, applied in the renderer and again in the resolver.
- `MAX_FILE_REF_BASES` = 200 (`src/shared/agentFiles.ts`).
- `MAX_RAW_CANDIDATES` = 2000 (`agentFileService.ts`): a longer list from the renderer is cut before it is walked.
- Span length 2–512 characters (`MIN_SPAN_LENGTH`, `MAX_SPAN_LENGTH`).
- `MAX_PREVIEW_BYTES` = 512 KB (`src/shared/filePreview.ts`).
- `MAX_AGENT_FILE_TEXT_BYTES` = 4 MB (`src/shared/agentFiles.ts`): the whole-file read cap; the `too_large` message is built from it.
- `MAX_CLIPBOARD_TEXT_LENGTH` = 8M characters (`src/main/host/desktop/clipboard.ts`); keep it above the text cap.
- Resolve `staleTime` = 30 s (`useAgentFileRefs.ts`).
- `localAgentsDefaultTool`: the Default Tool setting **Open** consults.
- `DARWIN_DATA_VOLUME` and `VOLUME_ROOT_DEPTH`: the data-volume prefix, and mount depths for volume roots.

## Security

- **The agent folder** comes from the index row (`locate`), never from the renderer. Renderer-supplied paths must be absolute.
- **Containment or approval** is re-checked by `permitted` on every read, open and reveal.
  - `authorize` is the only way to an approval.
  - Only main's dialog can grant one.
- **The consent registry** is in memory and keyed by the profile-scope user. Folder approvals are refused for the home folder, anything containing it, `/` and volume roots, under both spellings.
- **Credential files:** `readPreview` and `readText` apply the credential rule to the realpath and to the requested spelling, and `chooseOpenStrategy` keeps credential names away from the system app. The renderer's `isCredentialFileRef` only hides menu items.
- **Canonical paths:** every realpath goes through `createPathCanonicalizer`.
- **Guarded folders:** the resolver never probes a guarded location other than the one the agent itself lives in, and `isGuardedLocation` lower-cases both sides.
- **Check, then use:**
  - `readPreview` and `readText` compare dev/ino;
  - `open` re-takes the realpath;
  - `reveal` does neither, since selecting a file in the file manager executes nothing.
- **Launches:**
  - `launchEditor` passes the target as its own argv element (`code <file>`, or `open -a <bundle> <file>`).
  - `openInTextEditor` is `execFile('open', ['-t', file])`.
  - `shell.openPath` is used by **Open** only for `DEFAULT_APP_EXTENSIONS`. Open in browser also ends with it, on an `.html` file only, after the browser launch (`open -a <browser> <file>`, the browser executable, `xdg-open <file>`, the file its own argv element) failed.
  - `shell.openExternal` is never used on an agent file. (The HTML preview frame's link guard uses it for `http(s)` URLs; see [File Preview — Technical Details](../file_preview/file_preview_tech.md#html-preview-frame).)
- **The HTML frame's assets** go through `permitted` without asking, stay inside the document's folder on the lexical path and the realpath, refuse dot segments and credential files, and are capped at 20 MB. See [File Preview — Technical Details](../file_preview/file_preview_tech.md#html-preview-frame).
- **The preview body** renders through the same escaped React and `react-markdown` stack as attachments.

## Observability

- `createLogger('agent-files')` never logs a path, only its length:
  - `resolved file refs`, at debug level: candidate and ref counts.
  - `refused an outside path without approval`: `pathLength`.
  - `asked about a path outside an agent folder`: `pathLength`, `approved` and `rememberDir`.
  - `an agent file changed between its check and its read`: `pathLength`.
  - `…its launch`: `strategy`.
  - `opened an agent file`: `strategy` and `inside`.
  - `read an agent file as text`: `bytes` and `inside`.
  - `revealed an agent file`: `inside`.
  - `refused a preview asset outside its document folder`: `pathLength`.
  - `opening an agent file in the browser failed`: the error name.
  - Failures: the error's `name` only, because `execFile`'s message quotes its argv.
- `createLogger('file-preview')` in the renderer warns with the failure code only.
