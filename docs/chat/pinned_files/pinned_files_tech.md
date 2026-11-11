# Pinned Files — Technical Details

Behaviour and rules: [Pinned Files](pinned_files.md).

## File Locations

### Shared
- `src/shared/agentFiles.ts` — `PinnedAgentFile` (`path` absolute, `displayPath`, `inside`, `rank`, `exists`), `ListPinnedAgentFilesInput/Result`, `SetPinnedAgentFileInput/Result` (`{ success: true, pinned }`), `MovePinnedAgentFileInput`. Failures are `AgentFileFailure` data.

### Main process
- `src/main/db/schema.ts` — `agentPinnedFiles`; `src/main/db/migrations/agent-pinned-files.ts` — `migrateAgentPinnedFiles`, registered in `src/main/db/migrations/index.ts`.
- `src/main/db/agents.ts` — `agentPinnedFileRepo` (`list`, `add`, `remove`, `move`, `deleteForAgent`); `agentRepo.rekeyFolderRow` moves the rows to the new id.
- `src/main/db/users.ts` — `userRepo.deleteWithCascade` drops a profile's rows.
- `src/main/services/agentService.ts` — delete removes the agent's pins in every profile.
- `src/main/services/agentFiles/pinnedFileService.ts` — `createPinnedFileService` (dependencies injected, unit-tested); `agentPinnedFiles.ts` — production wiring.
- `src/main/services/agentFiles/resolver.ts` — `guardedProbeRule`, extracted from `resolveFileRefs` so the list and the resolver share one "do not probe this" rule.
- `src/main/ipc/agent_files.ipc.ts` — the three handlers.

### Preload
- `src/preload/index.ts` — `window.api.agentFiles.listPins`, `setPin`, `movePin`.

### Renderer
- `src/renderer/src/hooks/usePinnedFiles.ts`, `components/chat/PinnedFilesCard.tsx`, `components/chat/MessageContextMenu.tsx`, `components/chat/FileActionsMenu.tsx`, `components/chat/FilePreviewModal.tsx`, `components/chat/RunScriptModal.tsx`, `components/layout/ChatWorkspace.tsx`, `components/chat/MessageStream.tsx`, `components/chat/transcriptAnchor.ts`, `hooks/useLiveRunWatch.ts`, `stores/ui.store.ts`, `stores/filePreview.store.ts`.

## Database Schema
- `agent_pinned_files`: primary key (`user_id`, `agent_id`, `path`); `inside` (boolean), `rank` (real), `created_at`. No foreign key to `agents.id`, for the reason `agent_colors` has none: sync may drop and recreate a row under the same id. Creation only, no data migration. `path` is relative (POSIX separators) when `inside`, else absolute.

## IPC Channels
All require user activation and return failures as data (a thrown `DomainError.code` does not survive IPC).

| Channel | Input | Result |
|---|---|---|
| `agent-files:pins-list` | `{ agentId }` | `{ success: true, pins }` in rank order, or failure |
| `agent-files:pins-set` | `{ agentId, path, pinned }` | `{ success: true, pinned }` or failure (`invalid_input`, `agent_not_found`, `not_found`, `not_a_file`) |
| `agent-files:pins-move` | `{ agentId, path, rank }` | `{ success: true }` or `not_found` ("That file is not pinned.") |

## Services & Key Methods
- `pinnedFileService.ts:list()` — folder from the index row (`locateAgent`), never from the renderer; each row resolved against the folder's current realpath; `stat` only, skipped (reads as present) for guarded locations.
- `pinnedFileService.ts:set()` — unpin removes the path as named, else its realpath, with no file needed; pin stores the realpath once, refuses a folder.
- `pinnedFileService.ts:move()` — identifies the row by stored form.
- `agentPinnedFileRepo.add()` — insert-if-absent in a transaction, rank = max + 1.
- Pins are scoped to the active profile (`getProfileScopeUserId`); the folder agent lookup uses the settings scope.

## Renderer Components
- `usePinnedFiles.ts` — `usePinnedFiles(agentId)` (query key `['agent-pinned-files', agentId]`; a failure reads as no pins), `useIsFilePinned` (undefined until loaded; compared on canonical absolute path), `useTogglePinnedFile`, `togglePinnedFile(queryClient, input)` (the same mutation built in the client's mutation cache, for callers that unmount on the click), `useMovePinnedFile`. Optimistic with rollback.
- `PinnedFilesCard.tsx` — `PinnedFilesCard` (mounted in `ChatWorkspace`; off for Minimal view, no chat, no agent; `onReserveChange`), `PinnedFilesBlock` (`section` labelled by its `h2`; `data-pinned-files-placement` `side` or `top`), `PinnedFilesList` (rows, drag, per-row menu), `gutterFits(areaWidth, remPx)`, `pinnedFilesMode(areaWidth, remPx)` → `gutter` | `reserve` | `top` (640 px threshold, `PINNED_FILES_RESERVE_MIN_PX`), `PinnedFilesReserve`, `pinDropRank` (reuses the chat list's `dropRank` on negated ranks), `middleEllipsisParts`. The block is 224 px wide with a 20 px right margin, set inline in px; the app's root font size is 17 px, so Tailwind's `w-56`/`right-5` would be 238/21 px, and the column (`max-w-3xl`, 48 rem) is 816 px. The mode is computed from the chat area's width and the root font size, never from the column's measured box: the reserve moves the column, and measuring it would flip the mode. The reserve is reported from a layout effect, so no frame paints the block over a message, and reset to null when the block stops showing or unmounts.
- `MessageStream.tsx` — `reserve` prop. `right`: the scroller's right padding becomes `PINNED_FILES_GUTTER_PX` (256 px); `top`: `--transcript-pt` becomes 12 px (the block is a flow sibling above, `order-first`) and `--sticky-table-top` the fade. Applied imperatively in a layout effect, not through the style prop, so `keepAnchor` reads the reader's place before the change; skipped while pinned to the bottom (`useStickToBottom`'s observer sticks).
- `transcriptAnchor.ts:keepAnchor()` — one-step anchor: first top-level node below the top padding, put back at its offset after a reflow.
- `ChatWorkspace.tsx` — holds the reserve state between the block and `MessageStream`; passes the root agent (`activeChatData.agentId`) only when it has `capabilities.cwd` and the view is neither `embedded` nor `hosted`.
- `MessageContextMenu.tsx` — `messageMenuItems(file, options)` (options object: `canPublish`, `command`, `saveToNotes`, `pinnable`, `missing`); `pin` is its own first group for a file of a folder agent; `missing` leaves `pin` and `copy-path`. `useFileRefContextMenu(chatId)` opens the same menu for a block row. The pin item waits (dimmed) until the list has loaded.
- `FileActionsMenu.tsx` / `FilePreviewModal.tsx` — `PinnableFileActionsMenu`; Pin file is disabled for a gone, unpinned file; failure goes to the preview's `actionError` with action `pin`.
- `useLiveRunWatch.ts` — invalidates the root agent's pins at turn end (all agents' if the chat is uncached).
- `RunScriptModal.tsx:previewRef()` — resolves the script path through `agentFiles.resolve` before opening the preview.

## Configuration
- None. (A `cinna-pinned-files-collapsed` key left in `localStorage` by an earlier build is no longer read.)

## Security
- The renderer names only `{ agentId, path }`; main finds the folder and decides inside/outside itself. A path must be plausible (`isPlausiblePath`). The list never reads content and never probes a guarded folder. Opening a pin takes the ordinary authorize/read path, so an outside file still needs consent. Paths outside the folder are logged only as inside/outside, not by name.

## Tests
- `pinnedFileService.test.ts`, `agentService.pinnedFiles.test.ts`, `usePinnedFiles.test.tsx`, `PinnedFilesCard.test.tsx`, `MessageStream.pinnedReserve.test.tsx`, `transcriptAnchor.test.ts`, `FilePreviewModal.pin.test.tsx`, `ChatWorkspace.pinnedFiles.test.tsx`, `MessageContextMenu.fileRefs.test.tsx`.
