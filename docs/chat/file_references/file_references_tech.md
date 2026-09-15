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
  - `agentFilePreviewKindFor(filename)`: `previewKindFor`, plus `AGENT_TEXT_EXTENSIONS` rendered as `text`.
  - `isCredentialFilePath(path, agentDir)`: the credential-name rule. Passing `agentDir` enables the `credentials/` clause.
  - `agentFileExtension` and `agentFileName`.
  - `BINARY_DOCUMENT_EXTENSIONS`, `TEXT_DOCUMENT_EXTENSIONS`, and `DEFAULT_APP_EXTENSIONS` (the union of the two).
  - Types: `AgentFileRef`, `AgentFileRefKind`, `AgentFileOpenStrategy`, `AgentFileErrorCode`, `AgentFileFailure`, and the IPC input and result types.
- `src/shared/filePreview.ts`: `decodePreviewText(bytes, truncated)`, the truncation-safe decode shared with attachment previews.

### Main process — services
- `src/main/services/agentFiles/agentFileService.ts`: `createAgentFileService(deps)`, with `resolve`, `authorize`, `readPreview`, `open` and `reveal`.
- `src/main/services/agentFiles/resolver.ts`: `resolveFileRefs`, `displayPathFor` and `homeDisplayPath`.
- `src/main/services/agentFiles/consent.ts`:
  - `createConsentRegistry`, `canApproveDirectory` and `consentDialogOptions`;
  - the `ConsentRequest`, `ConsentAnswer` and `ConsentPrompt` types.
- `src/main/services/agentFiles/canonicalPath.ts`: `createPathCanonicalizer` and `DARWIN_DATA_VOLUME`.
- `src/main/services/agentFiles/openStrategy.ts`: `chooseOpenStrategy` and `findDefaultEditor`.
- `src/main/services/agentFiles/index.ts`: the production wiring (`agentFileService`) and `nativeConsentPrompt(win)`.

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
- `src/main/ipc/agent_files.ipc.ts`: `registerAgentFileHandlers()`. Five thin controllers.
  - Each calls `userActivation.requireActivated()` and then the service.
  - `authorize` passes `nativeConsentPrompt(BrowserWindow.fromWebContents(event.sender))`.
- `src/main/ipc/index.ts`: registers the handlers after the local-agent handlers.

### Preload
- `src/preload/index.ts`: `window.api.agentFiles.{resolve, authorize, readPreview, open, reveal}`, each an `ipcRenderer.invoke`.

### Renderer
- `src/renderer/src/components/chat/fileRefs.tsx`: `FileRefContext`, `chatMarkdownComponents` (with `MarkdownPre` and `MarkdownCode`), `collectFileRefSources` and `FileRefResolver`.
- `src/renderer/src/hooks/useAgentFileRefs.ts`: `useAgentFileRefs(sources)`, `hashCandidates` and the `FileRefScope` type.
- `src/renderer/src/components/chat/MessageStream.tsx`: collects the sources, mounts the resolver, and provides each bubble's scope.
- `src/renderer/src/components/chat/MessageBubble.tsx`: renders with `chatMarkdownComponents`, and provides a null scope while streaming.
- `src/renderer/src/stores/filePreview.store.ts`: `openAgentFile`, `openAgentFileExternally`, `revealAgentFile`, and the error-copy helpers.
- `src/renderer/src/components/chat/FilePreviewModal.tsx`: the agent-file header and states. See [File Preview — Technical Details](../file_preview/file_preview_tech.md).
- `src/renderer/src/assets/main.css`: `.markdown-body code.file-ref`, inside `@layer base`.

### Tests
- `src/shared/agentFiles.test.ts`: extraction, the shape filter, credential names and preview kinds.
- `src/main/services/agentFiles/resolver.test.ts`, on tmp-dir fixtures:
  - direct resolution: relative, `../`, absolute, `~/`, a symlink escape, folders;
  - the base heuristic: a single match, an ambiguous match, earlier spans only, `..`;
  - caps;
  - guarded folders, including the real guard with mixed-case spellings;
  - data-volume spellings.
- `src/main/services/agentFiles/consent.test.ts`: the registry, refused folders and the dialog copy.
- `src/main/services/agentFiles/openStrategy.test.ts`: the strategy table.
- `src/main/services/agentFiles/canonicalPath.test.ts`: canonicalisation against an injected data volume.
- `src/main/services/agentFiles/agentFileService.test.ts`:
  - refusal without consent, and approvals kept per profile;
  - credential files;
  - a file swapped between the check and the read;
  - one shared dialog per path;
  - open and reveal.
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
| `agent-files:authorize` | `{ agentId, path }` | `{ success: true, approved: boolean }` or `AgentFileFailure`. May show the native dialog |
| `agent-files:read-preview` | `{ agentId, path }` | `{ success: true, text, truncated }` or `AgentFileFailure` |
| `agent-files:open` | `{ agentId, path }` | `{ success: true }` or `AgentFileFailure` |
| `agent-files:reveal` | `{ agentId, path }` | `{ success: true }` or `AgentFileFailure` |

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
| `credential_file` | Preview of a credential file | "Preview is off for credential files." |
| `not_previewable` | A type the modal cannot render | "No preview for this file type." |
| `not_a_file` | A folder where a file was needed | "That is a folder, not a file." |
| `read_failed` | The read threw | "Could not read the file." |
| `launch_failed` | The launch threw, or the path moved before launch | "Could not open the file." `shell.openPath` refusing gives "No app could open this file.", and a failed reveal gives "Could not show the file in its folder." |

## Services & Key Methods

### `src/main/services/agentFiles/agentFileService.ts`
- `createAgentFileService(deps)`: every external dependency is injected:
  - agent lookup: `locateAgent`, `agentName`;
  - consent: `getConsentUserId`, `consent`;
  - platform and paths: `platform`, `isGuardedLocation`, `paths`, `home`, `maxPreviewBytes`. `isGuardedLocation` is required, so no wiring can forget it.
  - launching: `getDefaultEditor`, `launchEditor`, `openPath`, `openInTextEditor`, `showItemInFolder`.
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
  - Otherwise there is one in-flight promise per `userId\0realpath` in the `asking` map, so an overlapping call shares the first dialog and that dialog's window.
  - On approval it records the file, and also the folder when the checkbox was ticked and `canApproveDirectory` allows it.
- `readPreview(input)`:
  1. checks, in order, `permitted`, `not_a_file`, `credential_file` and `not_previewable`;
  2. opens the file with `open()` and compares `handle.stat()` dev/ino with the checked stat;
  3. reads at most `maxPreviewBytes` and decodes with `decodePreviewText`.
- `open(input)`:
  1. `permitted`;
  2. looks up the default editor (files only);
  3. `chooseOpenStrategy`;
  4. re-takes `paths.realpath(requested)` and returns `launch_failed` if it differs;
  5. launches.
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
  - Button 0 shows and button 1 cancels.
  - The message and button text depend on the kind.
  - Detail lines: the display path; the read notice for a previewable file that is not a credential file; `Folder: <dir>` when it differs from the path.
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

### `src/main/services/agentFiles/index.ts`
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
     - checks the credential name (for an inside ref, `displayPath` against a `/` agent root; otherwise the realpath);
     - runs `agentFilePreviewKindFor`;
     - either shows a notice without reading, or calls `readPreview` under the `requestId` guard.

     `credential_file` and `not_previewable` map to notices; any other failure becomes a `preview`-step error.
- `openAgentFileExternally()` and `revealAgentFile()` both call `runAction(action)`:
  - files only, and one action at a time (`pendingAction`);
  - authorize again, then `open` or `reveal`;
  - a failure sets `actionError {action, code, reason}`;
  - a result for a target no longer shown is dropped.
- `agentFileErrorText(ref, step, code, reason)`, `actionErrorText(actionError)` and `actionErrorRepeatsBody(state)`: the body and action-row copy.

### `src/renderer/src/assets/main.css`
- `.markdown-body code.file-ref`:
  - no background of its own: the fill is the `--color-bg-hover` of `.markdown-body code`;
  - an inset 1px `box-shadow` edge in `--file-ref-edge`, a `color-mix` of `--color-bg-hover`:
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
- Resolve `staleTime` = 30 s (`useAgentFileRefs.ts`).
- `localAgentsDefaultTool`: the Default Tool setting **Open** consults.
- `DARWIN_DATA_VOLUME` and `VOLUME_ROOT_DEPTH`: the data-volume prefix, and mount depths for volume roots.

## Security

- **The agent folder** comes from the index row (`locate`), never from the renderer. Renderer-supplied paths must be absolute.
- **Containment or approval** is re-checked by `permitted` on every read, open and reveal.
  - `authorize` is the only way to an approval.
  - Only main's dialog can grant one.
- **The consent registry** is in memory and keyed by the profile-scope user. Folder approvals are refused for the home folder, anything containing it, `/` and volume roots, under both spellings.
- **Credential files:** `readPreview` applies the credential rule to the realpath and to the requested spelling, and `chooseOpenStrategy` keeps credential names away from the system app.
- **Canonical paths:** every realpath goes through `createPathCanonicalizer`.
- **Guarded folders:** the resolver never probes a guarded location other than the one the agent itself lives in, and `isGuardedLocation` lower-cases both sides.
- **Check, then use:**
  - `readPreview` compares dev/ino;
  - `open` re-takes the realpath;
  - `reveal` does neither, since selecting a file in the file manager executes nothing.
- **Launches:**
  - `launchEditor` passes the target as its own argv element (`code <file>`, or `open -a <bundle> <file>`).
  - `openInTextEditor` is `execFile('open', ['-t', file])`.
  - `shell.openPath` is used only for `DEFAULT_APP_EXTENSIONS`.
  - `shell.openExternal` is never used.
- **The preview body** renders through the same escaped React and `react-markdown` stack as attachments.

## Observability

- `createLogger('agent-files')` never logs a path, only its length:
  - `resolved file refs`, at debug level: candidate and ref counts.
  - `refused an outside path without approval`: `pathLength`.
  - `asked about a path outside an agent folder`: `pathLength`, `approved` and `rememberDir`.
  - `an agent file changed between its check and its read`: `pathLength`.
  - `…its launch`: `strategy`.
  - `opened an agent file`: `strategy` and `inside`.
  - `revealed an agent file`: `inside`.
  - Failures: the error's `name` only, because `execFile`'s message quotes its argv.
- `createLogger('file-preview')` in the renderer warns with the failure code only.
