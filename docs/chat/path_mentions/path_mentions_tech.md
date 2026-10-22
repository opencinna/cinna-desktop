# Path Mentions: Technical Details

## File Locations

Shared
- `src/shared/pathMentions.ts`: `ComposerPathRef`, `PathMentionTake`, `PATH_MENTION_CHANNEL`, `PATH_MENTION_ARGV_FLAG`, `MAX_MENTION_PATH_LENGTH`, `mentionPathProblem`, `mergePathRefs`, `codeSpan`, `pathRefLine`, `splitPathRefs`, `pathRefLabel`, `withPathRefs`.
- `src/shared/finderQuickAction.ts`: `FinderQuickActionStatus`, `FinderQuickActionResult`, `APP_BUNDLE_ID` (equals `appId` in `electron-builder.yml`; a unit test holds them together).
- `src/shared/chatTitle.ts`: `deriveTitleFromMessage` strips reference lines.

Main
- `src/main/index.ts`: `app.on('open-file')` at module scope (a cold launch delivers before `ready`) and the startup argv scan for the test flag.
- `src/main/host/desktop/pathMentionIntentService.ts`: validation, buffer, settle timer, window raise, `take()`.
- `src/main/services/localAgents/pathMentionService.ts`: `resolve(paths, profileUserId)`, `matchFolderAgent`, `eligibleFolderAgents`.
- `src/main/host/desktop/finderQuickAction.ts`: install, update, uninstall, status of the workflow.
- `src/main/ipc/path_mention.ipc.ts`: `registerPathMentionHandlers()`, registered in `src/main/ipc/index.ts`.
- `resources/finder/Mention in Cinna.workflow/`: the template (`Contents/Info.plist`, `Contents/document.wflow`).
- `electron-builder.yml`: `resources/finder` excluded from the asar and shipped as mac `extraResources` (`Resources/finder/`).

Preload: `src/preload/index.ts` exposes `pathMention` and `finderQuickAction`.

Renderer
- `src/renderer/src/hooks/usePathMentions.ts`: `usePathMentions()` (mounted in `Shell` in `App.tsx`), `takePathMentions()`, `addedToNewChatMessage()`.
- `src/renderer/src/hooks/useFinderQuickAction.ts`: status query (prefetched in `App.tsx`), install/uninstall mutation.
- `src/renderer/src/utils/startAgentChat.ts`: `startAgentChat(agentId | null, { draft?, pathRefs?, agentMatch? })`, `addToNewChat(agentId, pathRefs, agentMatch?)`.
- `src/renderer/src/stores/composerDraft.store.ts`: `ComposerDraft.pathRefs`.
- `src/renderer/src/components/chat/PathRefBadge.tsx`: `PathRefBadge`, `PathRefBadgeList`.
- `src/renderer/src/components/chat/ChatInput.tsx`: renders the chips, sends them.
- `src/renderer/src/components/chat/MessageContextMenu.tsx`: `referenceChip(ref)` (replaces `referenceDraft`).
- `src/renderer/src/components/settings/FinderQuickActionSection.tsx`, mounted last in `FeaturesSettingsSection.tsx`.
- `src/renderer/src/components/settings/SettingsLayout.tsx` and `src/renderer/src/components/ui/usePopover.ts`: see Related change.

Tests: a `.test.ts(x)` beside each of the above; `e2e/bare-mac/specs/finder-mention.spec.ts` (see Testing).

## Database Schema

None. Chips live in the renderer's in-memory composer draft; the buffer lives in main memory and is lost on quit.

## IPC Channels

- `path-mention:take` (invoke) → `PathMentionTake { refs: ComposerPathRef[]; agentId: string | null; agentMatch: 'folder' | 'recent' | null }`; `agentMatch` says whether `agentId` is a folder match or the recent fallback. Before a profile is activated it returns empty and leaves the buffer alone.
- `path-mention:pending` (main → renderer, no payload): paths are waiting. Sent after the settle delay, and again from `pathMentionIntentService.profileReady()` when the buffer is not empty, so a renderer that asked too early asks once more. `index.ts` (`startup()`) subscribes that to `userActivation.onProfileReady`, beside the `--cinna-mention-path=` argv scan; the service module subscribes to nothing on load.
- `finder-quick-action:status | install | uninstall` (invoke) → status or `{ success, error?, status }`. Failures are data; a thrown error across IPC loses its code.

Preload: `window.api.pathMention.take()`, `.onPending(handler)` (returns unsubscribe), `window.api.finderQuickAction.status/install/uninstall`.

## Services & Key Methods

- `pathMentionIntentService.deliver(raw, source)`: the one funnel for `open-file` and `test-argv`; chained so a burst keeps its arrival order. `validateMentionPath(raw, fs)` returns the realpath and kind or null. Constants `MAX_BUFFERED_PATHS = 20`, `DEBOUNCE_MS = 150`. `mentionPathsFromArgv(argv)` reads `--cinna-mention-path=` (repeatable; test only).
- `flush()`: raises the window through `ensureMainWindow()` + `focusMainWindow()` (recreates a closed window), then sends the channel. Skipped before `app.isReady()`; the first take after login picks the buffer up.
- `pathMentionService.resolve`: realpath and stat each path again (it may have gone), drop refused names, dedup, compute `displayPath` with `homeDisplayPath`, then `matchFolderAgent(firstPath, agents, recentAgentIds)` → `{ agentId, agentMatch }` (`folder` for the deepest containing folder, `recent` for the first of the recents that is an eligible folder agent, else null) where recents are the agent ids of the profile's chats, most recent first. Containment is `isWithin` from `pathRules`.
- `finderQuickAction`: `status()` is `outdated` when the installed `CinnaQuickActionVersion` (Info.plist) differs from the template's, or the installed `COMMAND_STRING` differs from the current command. `install()` reads the template's `document.wflow`, replaces `__CINNA_COMMAND__` with the XML-escaped command, removes any existing bundle, copies the template, writes the substituted document, then runs `pbs -update` (best effort, 10 s). `quickActionCommand`: packaged `open -b io.opencinna.desktop "$@"`; dev (`process.defaultApp`) `open -a '<Electron.app>' "$@"`. `quickActionErrorMessage` maps `EEXIST/ENOTDIR/EACCES/EPERM` to a sentence without paths; the raw error is only logged. `os.homedir()`, not Electron's `home`, so the E2E sandbox's `HOME` is respected.
- `withPathRefs(text, refs)` / `splitPathRefs(message)`: the line format `Referenced file|folder: <code span>`. `codeSpan` lengthens the backtick fence past any run inside the path and pads per CommonMark, so a path containing backticks round-trips. `splitPathRefs` only recognises reference lines in the last blank-line-separated block; if any line there is not a reference line, the message is returned untouched. Its line pattern matches the path with `[\s\S]*`, so a U+2028/U+2029 (refused by `mentionPathProblem`, which also refuses C0 controls and DEL) could not cut a path short.
- `startAgentChat` with `agentId` null does not set a pending agent and clears the active chat instead (`ChatWorkspace` only leaves an open chat for a pending agent). `addToNewChat` writes `pathRefs` merged by path and, with an agent, `pendingAgentIds: [agentId]` into the draft keyed `composerDraftKey(profile, NEW_CHAT_DRAFT_SURFACE)`, without navigating. In both, an `agentMatch` of `recent` is treated as no agent when that draft's `pendingAgentIds` is non-empty (read before the chips are added), so the fallback never replaces the user's pick; `folder` and an omitted match (every other caller) apply the agent as before.

## Renderer Components

- `usePathMentions` subscribes to `onPending` and takes once on mount. `takePathMentions`: empty take → nothing; `busyElsewhere()` (an `[aria-modal="true"]` element, or `activeView !== 'chat'`) → `addToNewChat(agentId, refs, agentMatch)` + toast with `link: null`; otherwise `startAgentChat(agentId, { pathRefs, agentMatch })`.
- `ChatInput` reads `pathRefs` via `useComposerDraftField(draftKey, 'pathRefs')`; the chips share the attachment row with attachments and note badges (`align="right"`). `hasContent`, the Send-disabled and Stop-versus-Send conditions all count chips. `outgoing = withPathRefs(trimmed, pathRefs)` is what goes to `onNewChat` or `composer.submit`. `clearComposer` filters out sent paths rather than comparing array identity.
- `PathRefBadge` truncates the label with `truncateFilename` (exported from `AttachmentBadge.tsx`) so an extension survives.
- `FinderQuickActionSection` returns null unless `status.supported`; the "older Cinna" and error rows render only while true, below the switch, so nothing above moves. The status refetches on window focus because the user can delete the workflow in Finder.

## Configuration

No setting is stored: the switch is whether the workflow exists. `--cinna-mention-path=<abs path>` on the command line is a test seam into the same funnel; emitting `open-file` on `app` is the other. `e2e/specs/path-mentions.spec.ts` uses both; `live-path-mentions.spec.ts` emits `open-file` against real Claude Code.

## Security

- Paths are untrusted input; see the validation rule in [the business doc](path_mentions.md). Only realpath and kind reach the renderer; the renderer reads nothing from them.
- Entry is `open-file`, never a URL scheme.
- The workflow's only command is `open` with `"$@"`; the substituted command is XML-escaped and the dev path is single-quoted.
- Uninstall touches one exact directory after an `lstat`.

## Testing and verified behaviour

- Verified on a packaged, ad-hoc signed build: `open -a <app> <folder> <file>` delivers both a folder and a file through `open-file`, to a running app and on a cold launch, with no `CFBundleDocumentTypes` declared. The shipped workflow run through `automator -i <path>` delivers to the app. `codesign --verify --deep --strict` stays valid with the `.workflow` in `Resources/`.
- `NSPerformService` from `osascript` does **not** trigger the workflow: it returns true and nothing runs. Exercise it with `automator -i`.
- `e2e/bare-mac/specs/finder-mention.spec.ts`: in a fresh VM, installs the Quick Action from Settings → Features, then runs the installed workflow with `automator -i` on a folder (a Finder right-click cannot be driven over SSH without an Accessibility grant) and on a second folder in `~/Documents`, a guarded location, failing on any system dialog. See [Bare Mac](../../development/bare_mac/bare_mac.md).

## Related change

`SettingsInfoTip` now opens above its (?) when the tip does not fit below (`usePopover(..., { flipWhenNoRoom: true })`): the Finder row is the last on the Features tab, so its tip would open past the window's bottom edge. The decision is made once per open in a layout effect, so it never flips back and forth.
