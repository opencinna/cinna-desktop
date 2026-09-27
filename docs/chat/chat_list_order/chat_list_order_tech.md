# Chats List Order: Technical Details

## File Locations

- Main — db: `src/main/db/schema.ts` (`chats.pinnedRank`, `chats.sortKey`), `src/main/db/migrations/chats.ts:migrateChats()`, `src/main/db/chats.ts` (`chatRepo.rename`, `pin`, `unpin`, `setPinnedRank`, `setSortKey`).
- Main — service and IPC: `src/main/services/chatService.ts` (`rename`, `setPinned`, `move`), `src/main/ipc/chat.ipc.ts`, `src/main/errors.ts` (`ChatErrorCode` `invalid_value`).
- Preload: `src/preload/index.ts` — `window.api.chat.rename`, `setPinned`, `move`; `ChatData.pinnedRank` / `sortKey`.
- Renderer — pure logic: `src/renderer/src/components/chat/chatGroups.ts` (`listRank`, `dayRank`, `tieBreak`, `pinnedRank`, `pinnedChats`, `dropRank`, `rankBetween`, `PINNED_GROUP`; `groupChats` excludes pinned chats and sorts by rank).
- Renderer — components: `src/renderer/src/components/chat/ChatList.tsx` (Pinned block, drop handlers, failed-drop notice), `src/renderer/src/components/chat/ChatItem.tsx` (drag source and target, inline rename, menu host), `src/renderer/src/components/chat/ChatRowMenu.tsx`, `src/renderer/src/components/chat/chatDragContext.ts`.
- Renderer — hooks: `src/renderer/src/hooks/useChat.ts` (`useRenameChat`, `useSetChatPinned`, `useMoveChat`, the shared `patchListedChat`); `useOpenAgentPath` from `src/renderer/src/hooks/useLocalAgents.ts`.
- Shared with other surfaces: `MENU_ITEM` / `MENU_SURFACE` from `src/renderer/src/components/agents/local/OpenInMenu.tsx`, `ChatGroupHeader` for the Pinned header.

## Database Schema

Two nullable `REAL` columns on `chats`, added in place by `migrateChats()` when missing (no backfill; every existing chat starts unpinned and undragged):

- `pinned_rank` — the place in Pinned, higher first; null = not pinned. `REAL` because a drag inside Pinned writes a midpoint.
- `sort_key` — the dragged place inside the chat's list group, on the recency scale (epoch ms); null = never dragged.

`chatRepo.create()` writes both as null. `softDelete()` and `restore()` touch neither, which is why a restored chat returns pinned. No index: the list is sorted in the renderer. No write here touches `updated_at`, which is the point of `chatRepo.rename` existing beside `updateMeta`.

## IPC Channels

All three go through `ipcHandle`, require activation and are scoped by `getProfileScopeUserId()`. Failures are `ChatError`s, surfaced by `unwrapIpcError` in the renderer.

- `chat:rename(chatId, title)` → `{ success: true }`. Trimmed; empty → `invalid_value` ("A chat needs a title."); unowned → `not_found`.
- `chat:set-pinned(chatId, pinned)` → `{ pinnedRank: number | null }` — the new rank, or null once unpinned. Only a literal `true` pins.
- `chat:move(chatId, { list: 'pinned' | 'chats', rank })` → `{ success: true }`. A non-finite or non-number rank, an unknown `list`, or `pinned` for a chat that is not pinned → `invalid_value`. `chats` writes `sort_key`; `pinned` writes `pinned_rank` and never pins a chat as a side effect.

`chat:list` returns both columns on every row, so the polled list carries everything the renderer sorts by; no new read.

## Services & Key Methods

- `chatRepo.pin(owner, chatId, rankOwners)` — in one transaction, `max(pinned_rank)` over the other chats of `rankOwners` (trashed and hidden ones included) + 1, then written under the chat's owner. `chatService.setPinned` passes every owner the profile lists (`chatScopesFor`), so with shared local chats on the rank spans the profile and the guest profile. Re-pinning an already pinned chat moves it to the top. The first pin of a profile is rank 1.
- `chatRepo.setPinnedRank` — guarded by `pinned_rank IS NOT NULL`, so a race with an unpin cannot re-pin.
- `chatService.move` — `requireOwnedChat`, then validates `rank` and `list` as above. The renderer computed the rank; main does not check that it is between any neighbours.

### Rank arithmetic (`chatGroups.ts`)

- `listRank(chat)` = `sortKey ?? updatedAt ms + tieBreak(id)` — flat list and who groups.
- `dayRank(chat, summary)` = `sortKey ?? chatDate ms + tieBreak(id)` — inside a day, where the undragged order is by last message.
- `tieBreak(id)` — an FNV-1a hash of the id mapped into [0, 0.5) ms. Times are stored in whole seconds, so chats created in the same second tie exactly; a drop between two tied neighbours would get their own rank as the midpoint and not move. Below a millisecond it can only order ties, and does so identically on every poll.
- `pinnedRank(chat)` = `pinnedRank ?? 0`; `pinnedChats(chats)` = the pinned ones by it, highest first.
- `groupChats` — filters out pinned chats, sorts the rest by `listRank`, then groups. Who groups are sorted by the max of `updatedAt + tieBreak` over their chats — never `sortKey`, so a drop cannot reorder groups. The day bucket always comes from `chatDate`, never the rank. All sorts are stable.
- `dropRank(shown, rank, draggedId, targetId, place)` — the group as drawn, with the dragged chat removed; the insertion index is the target's (`before`) or the one after it (`after`). Same index as before → `'unchanged'`. Otherwise `rankBetween(above, below)`: the midpoint when both exist, `below + 1` at the top, `above - 1` at the bottom. A midpoint not strictly between its neighbours (the float ran out) → `'no-room'`. A group of one has no neighbours → `'unchanged'`.

How many drops fit in one gap is how many times it halves before reaching the float's spacing at that magnitude: around 2^-12 ms near today's epoch-ms values, so about 22 halvings from a one-second gap and about 11 from a same-second tie; Pinned ranks are small integers, with room for about 50. There is deliberately no renumbering pass.

## Renderer Components

### `ChatList`

- `pinnedChats(chats)` is drawn first, under `ChatGroupHeader label="Pinned"` (no `who`, so it is drawn like a day header). Its collapse key is `PINNED_GROUP` (`'pinned'`) in the same `chatGroupCollapsed` map as the group keys, default open. A reveal of a pinned chat expands `[PINNED_GROUP]` instead of `groupKeysOf`.
- Each row gets `dragGroup` — `FLAT_GROUP` (`'flat'`), the who key, the day key or `PINNED_GROUP` — and an `onDropChat` built by `dropInto(list, shown, rank)` with that group's drawn chats and its rank function (`listRank`, `dayRank` or `pinnedRank`), so the rank comes from exactly the neighbours on screen.
- `dropInto` → `'unchanged'` does nothing; `'no-room'` sets the notice `NO_ROOM` without a write; a number calls `useMoveChat().mutate`. A mutation error becomes the notice through `unwrapIpcError`.
- The notice is a `role="alert"` absolutely positioned at the bottom of a `relative` wrapper around the scroller, `pointer-events-none`, cleared after `MOVE_NOTICE_MS` (4 s).
- It owns the `ChatsDragContext` value. While a drag is live it also listens for `dragend` and `drop` on `document`: a row whose group changes mid-drag (a poll moved it into another day) remounts, and its own `dragend` fires on the detached element.
- `folderAgentOf(chat)` — `summary.with.agentId ?? chat.agentId`, if that id is in `useLocalAgents()`; passed to the row as `folderAgentId`.

### `ChatItem`

- Draggable when it has `dragGroup` and `onDropChat` and is not renaming. `dragstart` closes the tooltip and menu, sets `application/x-cinna-chat` data, paints the row's background (as `JobItem` does — a transparent row rasterises white corners into the drag image in the light theme) and publishes `{ id, group }` to the context.
- A row accepts `dragover` only when the context's drag has its `dragGroup` and is not itself; otherwise it neither calls `preventDefault` nor draws a line. The line (`data-drop-indicator="before" | "after"`) is an absolutely positioned 2 px accent bar at the row's top or bottom edge. `drop` recomputes the half from the pointer rather than trusting the line state, which a `dragleave` onto a child may have cleared.
- The dragged row is at 40% opacity. The row carries `data-chat-row={chat.id}`.
- Right-click (except while renaming) opens `ChatRowMenu` at `clientX/clientY`; while it is open the row keeps the hover background and the context's `menuOpen` is true. `showTooltip` also requires no own menu, no other row's menu and no drag, and `mouseenter` does nothing during either.
- Rename: an `input` `aria-label="Chat title"`, `h-4 leading-4` to match the title span, selected on focus. A `renameSettled` ref makes Enter-then-blur commit once. While the mutation is pending the span shows the new title, so the old one does not flash back before the list has it. The row's inline error shows `deleteChat.error ?? renameChat.error` when not running.
- Menu wiring: Pin → `useSetChatPinned().mutateAsync`, Open Folder → `useOpenAgentPath().mutateAsync({ agentId })` (main reveals the agent directory with `shell.showItemInFolder`), Delete → `useDeleteChat().mutate`, disabled while running, interrupting or deleting.

### `ChatRowMenu`

Portaled to `body`, `role="menu"` `aria-label="Chat actions"`, `position: fixed` at the pointer and clamped 8 px inside the viewport after measuring (re-clamped when an error line grows it). The first enabled item takes focus; ArrowUp/ArrowDown wrap over enabled items; Tab and Escape close. Closes on outside `pointerdown`, a capture-phase `scroll` whose target contains the row (the streaming transcript does not count), `resize` and `blur`. Async picks (Pin, Open Folder) run through `run()`: busy-disables every item, closes on success, stays open with a `role="alert"` line on failure. Rename and Delete close at once; their outcome shows in the row.

### `chatDragContext.ts`

`ChatsDragContext` — `drag: { id, group } | null` and `menuOpen`, with setters. Shared state only, provided by `ChatList`; the default value is inert. A row without `dragGroup` and `onDropChat` is neither a drag source nor a target.

### Hooks (`useChat.ts`)

- `patchListedChat` — cancels an in-flight `['chats']` query (`exact: true`; an old poll landing would bring the old row back), writes one row of the cached list, and returns the previous list for rollback.
- `useRenameChat` — optimistic title; rolls back on error; invalidates `['chats']` exactly (a title is not in the summary, so the message-scanning summaries are not re-read) and `['chat', chatId]`.
- `useMoveChat` — optimistic `pinnedRank` or `sortKey`; rolls back on error; invalidates `['chats']` exactly.
- `useSetChatPinned` — not optimistic: the rank comes from main, written into the cached row on success, then `['chats']` is invalidated exactly. None of the three refetches `['chats', 'summaries']`: nothing they change is in a summary.

## Configuration

None. The Pinned block's open/closed state is the `pinned` key of `cinna-chat-groups-collapsed` in localStorage ([grouping configuration](../chat_list_grouping/chat_list_grouping_tech.md#configuration)); pins and dragged places are in the database.

## Security

Every write is `WHERE id = ? AND user_id = ?` under the chat's owner, after `requireOwnedChat` found the chat visible to the active profile — its own, or the guest's while shared local chats are on (`src/main/auth/chatScope.ts:visibleChat()`). The rank is a number the renderer chose; main accepts any finite value, since the worst a wrong one does is misplace the user's own chat.

## Verification

- `src/main/services/chatService.listOrder.test.ts` — against a real database: rename trims and keeps `updatedAt`, refuses empty and another profile's chat; pinning puts a new pin above the others, re-pinning after a drag goes back on top, unpinning keeps `updatedAt`, ranks count the owner's pins only (`chatService.sharedChats.test.ts` covers the rank spanning a shared chat and the profile's own); `move` writes `sort_key` without touching `updatedAt`, refuses non-finite ranks, an unknown list and a chat not pinned, and never pins.
- `src/main/db/migrations/migrations.test.ts` — both columns added as nullable `REAL` to an install without them, rows kept, replay-safe.
- `src/renderer/src/components/chat/chatGroups.test.ts` (`drag order and Pinned`, `tieBreak`, `dropRank`) — dragged place else recency; a dragged chat holding against newer activity; a sort key never changing the day; day sort; who groups ordered by activity; pinned chats out of the grouping; tie ordering under a millisecond; midpoint, ends, unchanged, no-room, a group of one.
- `src/renderer/src/components/chat/ChatList.test.tsx` (`Pinned, the row menu and drag order`) — Pinned drawn first; the menu's items and Open Folder only for a folder agent; pin/unpin; rename commit, Escape and unchanged; Delete disabled while running; a drop within a group and inside Pinned; rename failure and pending title; no-room notice with no write; drop placement after a `dragleave`; a document-level drag end; no tooltip while a menu is open; a drop from another group refused.
- `e2e/specs/chat-list-order.spec.ts` — the built app: the menu's items with and without a folder agent, Delete to the Trash, Pinned flat under both groupings with the newest pin on top, Unpin, inline rename keeping `updated_at` and its place, Escape, and a real HTML5 drag inside the flat list and a mode group holding across list polls, a drop onto another group's row refused.
- Not covered: how many drops a real gap takes before `no-room`, and Open Folder's reveal itself (the item is asserted, never clicked).
