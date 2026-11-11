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
- `src/renderer/src/hooks/usePinnedFiles.ts`, `components/chat/PinnedFilesCard.tsx`, `components/chat/MessageContextMenu.tsx`, `components/chat/FileActionsMenu.tsx`, `components/chat/FilePreviewModal.tsx`, `components/chat/RunScriptModal.tsx`, `components/layout/ChatWorkspace.tsx`, `components/layout/TopBar.tsx`, `hooks/useLiveRunWatch.ts`, `stores/ui.store.ts`, `stores/filePreview.store.ts`.

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
- `PinnedFilesCard.tsx` — `PinnedFilesCard` (mounted in `ChatWorkspace`; off for Minimal view, no chat, no agent), `GutterCard`, `PinnedFilesList` (rows, drag, per-row menu), `PinnedFilesChip` (mounted in the top bar), `usePinnedFilesChipStore` (hand-off from chat area to chip), `gutterFits`, `pinDropRank` (reuses the chat list's `dropRank` on negated ranks), `middleEllipsisParts`. The card is 224 px wide with a 20 px right margin and 12 px kept clear of the 768 px column.
- `ChatWorkspace.tsx` — passes the root agent (`activeChatData.agentId`) only when it has `capabilities.cwd` and the view is neither `embedded` nor `hosted`.
- `MessageContextMenu.tsx` — `messageMenuItems(file, options)` (options object: `canPublish`, `command`, `saveToNotes`, `pinnable`, `missing`); `pin` is its own first group for a file of a folder agent; `missing` leaves `pin` and `copy-path`. `useFileRefContextMenu(chatId)` opens the same menu for a card row. The pin item waits (dimmed) until the list has loaded.
- `FileActionsMenu.tsx` / `FilePreviewModal.tsx` — `PinnableFileActionsMenu`; Pin file is disabled for a gone, unpinned file; failure goes to the preview's `actionError` with action `pin`.
- `useLiveRunWatch.ts` — invalidates the root agent's pins at turn end (all agents' if the chat is uncached).
- `ui.store.ts` — `pinnedFilesCollapsed`, persisted in `localStorage` (`cinna-pinned-files-collapsed`).
- `RunScriptModal.tsx:previewRef()` — resolves the script path through `agentFiles.resolve` before opening the preview.

## Configuration
- None, except the collapsed flag above.

## Security
- The renderer names only `{ agentId, path }`; main finds the folder and decides inside/outside itself. A path must be plausible (`isPlausiblePath`). The list never reads content and never probes a guarded folder. Opening a pin takes the ordinary authorize/read path, so an outside file still needs consent. Paths outside the folder are logged only as inside/outside, not by name.

## Tests
- `pinnedFileService.test.ts`, `agentService.pinnedFiles.test.ts`, `usePinnedFiles.test.tsx`, `PinnedFilesCard.test.tsx`, `FilePreviewModal.pin.test.tsx`, `ChatWorkspace.pinnedFiles.test.tsx`, `MessageContextMenu.fileRefs.test.tsx`.
