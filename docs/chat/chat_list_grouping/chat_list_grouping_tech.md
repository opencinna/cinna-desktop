# Chats List Grouping: Technical Details

## File Locations

- Shared contract: `src/shared/chatListSummary.ts` — `ChatListSummary.with.modeId`, the one field grouping added to the summary.
- Main: `src/main/services/chatListSummary.ts:buildChatListSummaries()` — sets `modeId` on the `mode` variant.
- Renderer — pure logic: `src/renderer/src/components/chat/chatGroups.ts`; the Active block's test reuses `unreadResultIndicator` from `src/renderer/src/components/ui/runResultIndicators.ts`.
- Renderer — components: `src/renderer/src/components/chat/ChatList.tsx` (`ChatList`, `GroupChatsMenu`, `usePointerOnList`), `src/renderer/src/components/chat/ChatGroupHeader.tsx` (`ChatGroupHeader`, `StartChatButton`), `WhoIcon` exported from `src/renderer/src/components/chat/ChatItemTooltip.tsx`.
- Renderer — state: `src/renderer/src/stores/ui.store.ts`; `src/renderer/src/stores/chat.store.ts` (`activeChatId`, `isStreaming`) for the Active block; the `renaming` flag in `src/renderer/src/components/chat/chatDragContext.ts`; the one-shot consumer in `src/renderer/src/components/layout/ChatWorkspace.tsx`.
- Shared with other surfaces: `usePopover('right')` from `src/renderer/src/components/ui/usePopover.ts`, `MENU_ITEM` from `src/renderer/src/components/agents/local/OpenInMenu.tsx`.

## Database Schema

None. Grouping is computed in the renderer from the chat list, the summaries and the agent and mode lists.

## IPC Channels

No new channel. `chat:list` (polled) and `chat:list-summaries` (unpolled) as in [Chat Row Summary](../chat_row_summary/chat_row_summary_tech.md#ipc-channels); `modeId` rides on the latter. The fallback lists come from the existing `useAgents`, `useChatModes` and `useLocalAgents` queries.

## Services & Key Methods

`chatGroups.ts` is pure — `now` is a parameter — so the sidebar only renders its result.

- `dateBucket(date, now)` — local-midnight difference, rounded (DST), `<= 0` today, `1` yesterday, `<= 7` last week, else previous.
- `chatWho(chat, summary, fallback)` — `{ key, who }`. With a summary: `agent:<agentId>`, `mode:<modeId ?? name>`, else `none` with the name "Chat". Without one: the chat's `agentId` in `fallback.agents` unless that row is a `conductor`, then its `modeId` in `fallback.modes`, then `none`. The `?? name` is reachable only for a mode summary without an id, which main no longer produces.
- `chatDate(chat, summary)` — `summary.lastMessageAt`, else the row's `updatedAt`.
- `groupChats(chats, summaries, fallback, { byAgent, byDate }, now)` — `ChatGrouping`: `flat`, `date` (day groups under the parent key `DATE_ONLY_PARENT` = `all`) or `who` (each with `dates` when `byDate`). Pinned chats are dropped first — `pinnedChats()` draws them — and the rest sorted by `listRank` (dragged place, else `updatedAt`); inside a day by `dayRank` (dragged place, else `chatDate`). Who groups are then sorted by their most recent chat's `updatedAt`, ignoring dragged places; days keep their fixed order and the bucket always comes from `chatDate`. The rank functions are in [Chats List Order](../chat_list_order/chat_list_order_tech.md#rank-arithmetic-chatgroupsts).
- `groupKeysOf(grouping, chatId)` — the keys that must be open to show a chat, outermost first.
- `canStartChat(who, agents, folderAgents)` — true for `mode` and `none`; for an agent, a non-conductor row in `agents` that is `enabled`, and whose `folderAgents` entry, if any, is not `readiness === 'invalid'`. It deliberately never reads the agent's `source`: a folder row is always enabled and only folder agents are in `folderAgents`, and a branch on `source` would trip the kind-branch ratchet.

### Group keys

| Group | Key |
| --- | --- |
| Agent | `agent:<agentId>` |
| Chat mode | `mode:<modeId>` |
| Plain | `none` |
| Day | `<parentKey>\|<bucket>` — `all\|today` with no who level, `agent:a1\|yesterday` inside one |
| Pinned block | `pinned` (`PINNED_GROUP`), default open |

Open/closed state is a map from these keys to the user's choice (`true` = closed), which is why a day collapses per parent. A key with no entry follows `chatGroupCollapsedByDefault(group, siblings)`: closed only for the `previous` bucket with more than one day at its level. A click stores the opposite of what is drawn, so it overrides the default either way.

## Renderer Components

- `ChatList` — computes `groupChats` in a `useMemo` over the list, summaries, fallback lists and both switches, with `new Date()` taken inside it. The memo is not a cache in practice: every one-second poll yields a new `chats` array (its `Date` fields defeat TanStack's structural sharing), which is also what moves Today at midnight. Pinned is drawn before the grouping, and each row also gets its innermost group key and a drop handler ([Chats List Order](../chat_list_order/chat_list_order_tech.md#chatlist)). Rows get a running `index` in drawn order, so a group opening or closing above a row changes its index and closes its open tooltip (see [ChatItem](../chat_row_summary/chat_row_summary_tech.md#chatitem)). Collapsed groups render their header only.
- Reveal — an effect on `revealChatId` and the grouping calls `expandChatGroups(groupKeysOf(...))`, or `[PINNED_GROUP]` for a pinned chat. It does not clear the request; the `ChatItem` that shows itself does, as before.
- `GroupChatsMenu` — its trigger is `opacity-0` unless the Chats header (`group/chats-header`) is hovered, it has `focus-visible`, or the menu is open. `usePopover('right')`, portaled to `body`, `role="menu"` with three `menuitemcheckbox` items — Group by Agent, Group by Date, then a `role="separator"` and Show Active group. A pick toggles without closing. Keyboard: the first item is focused once the popover is positioned, ArrowUp/ArrowDown wrap over all three, Escape closes and refocuses the trigger.
- `ChatGroupHeader` — the whole row toggles on click; an inner `button[data-chat-group]` carries `aria-expanded` and is named by its visible label. There is no count. A who group has a fixed 16 px trailing slot holding the `StartChatButton` when `available`; the button is always in the DOM at `opacity-0`, shown by `group-hover/header` or `focus-visible`. A day group has no slot.
- `StartChatButton` — stops propagation (no toggle), then `setActiveView('chat')`, `setPendingAgentId(agentId)` for an agent or `setPendingModeId(modeId ?? NO_CHAT_MODE)` otherwise, `setSidebarTab('chats')`, `setActiveJobId(null)`.
- `WhoIcon` — exported with a `className` prop (default `mt-0.5`, the tooltip's alignment) so the header and the tooltip draw the same icon.

### The Active block

Described in [the Active block](active_block.md). All in `ChatList`, with the membership test and ordering pure in `chatGroups.ts`:

- `isActiveChat(chat, streamingChatId)` — `activeRunId` set, or `chat.id === streamingChatId` (the chat store's `activeChatId` while `isStreaming`), or `unreadResultIndicator(lastRunResult, running)` non-null. The row computes its icon from the same two inputs (`ChatItem`: `isRunning`, `unreadResultIndicator`), which is what keeps block and icon in agreement; change one and change the other. `ActivityChat` is `GroupableChat` plus the two optional list fields.
- `settleActiveIds(shown, active)` — ids still active keep their order; the rest are sorted by `listRank` and put in front.
- `activeIds` is component state, recomputed **during render** — `settleActiveIds` over `chats.filter(isActiveChat)` minus the chat on screen (`activeChatId` while `activeView === 'chat'`) unless it is already in `activeIds`, or `[]` while `chatShowActive` is off — and set only when the result differs, and only when `!pointerIn.inside && !menuOpen && !renaming`. While any of the three holds, the previous ids stand. `activeRows` maps the ids back to current chat objects (so icons stay live and a deleted chat simply drops out); `listed` is `chats` minus those, and it is `listed`, not `chats`, that feeds `groupChats` and `pinnedChats`.
- `usePointerOnList()` — `inside` is set by a document `mousemove` listener: true only when that very native event was the last one the scroller's React `onMouseMove` recorded. React events bubble through portals, so a row's portaled `ChatRowMenu` or tooltip counts as on the list. `mouseout` with no `relatedTarget` (leaving the window) and window `blur` set it false. Enter/leave on the list was not used: an element unmounting under a still pointer fires no leave — the same reasoning as `useSidebarHoverDock` ([App Shell](../../ui/app_shell/app_shell_tech.md#sidebar-docking)).
- Rename hold — `ChatItem` sets the context's `renaming` true while its own rename input is open (effect with cleanup). `menuOpen` is the existing row-menu flag from [Chats List Order](../chat_list_order/chat_list_order_tech.md#chatdragcontextts).
- Rows — `role="group"` `aria-label="Active"`, a `Zap` icon and a 10 px label, rows indented `pl-3`, a bottom border. `ChatItem` gets `summary`, `index` (counted first, so the running `position` covers it) and `folderAgentId`, but no `dragGroup` or `onDropChat`, which makes it neither a drag source nor a drop target.
- Reveal on leaving — a click on an Active row records `openedFromActive` through `ChatItem`'s `onOpen` prop, just before it selects the chat. An effect on `selectedChatId` clears the ref whenever the selected chat is not the recorded one, so any other open (a row below, a task page, the list mounting over an already open chat, e.g. back from Settings) is not counted. An effect on `activeIds` compares with the previous ids: if `openedFromActive` just left, is still the chat store's `activeChatId` and is still in `chats`, it clears the ref and calls `setRevealChatId`; the existing reveal effect then expands `groupKeysOf` (or Pinned) and the row scrolls and outlines itself. A chat selected from its group is never recorded, so its own turn passing through the block reveals nothing. Switching the block off counts as leaving.
- Reveal into the block — the reveal effect finds an active chat in neither `pinned` nor `grouping`, so it expands nothing; the row in the block consumes the request.

### The `pendingModeId` one-shot (`ChatWorkspace`)

The mode twin of `pendingAgentId`, consumed only by the non-embedded workspace:

- `pendingAgentId` set → clear `pendingModeId` and do nothing else. The agent effect has already selected its agent; applying the mode after it would reset the pending agents to none.
- A real mode id waits for `chatModes` to load, and is cleared without effect if the mode is not in it.
- Otherwise: `setActiveChatId(null)`, no pending agents, `setModeSelection({ id })` — or `'none'` for `NO_CHAT_MODE` (`'__none__'`) — clear the request, focus the input on the next frame.

## Configuration

`ui.store.ts`, all read at store creation:

| Field | localStorage key | Value |
| --- | --- | --- |
| `chatGroupByAgent` | `cinna-chat-group-by-agent` | `1` on, anything else off |
| `chatGroupByDate` | `cinna-chat-group-by-date` | `1` on, anything else off |
| `chatShowActive` | `cinna-chat-show-active` | `1` on, anything else (including absent) off |
| `chatGroupCollapsed` | `cinna-chat-groups-collapsed` | JSON object of group key → boolean (`true` = closed); non-booleans dropped, an array or unparsable value reads as `{}` |

Actions: `toggleChatGroupByAgent`, `toggleChatGroupByDate`, `toggleChatShowActive`, `setChatGroupCollapsed(key, collapsed)`, `expandChatGroups(keys)` (writes an explicit `false`, so it also opens a group closed only by default; returns the same state when every key is already `false`), `setPendingModeId`. `pendingModeId` itself is not persisted.

## Security

Nothing new crosses IPC but the chat mode id, which the renderer already holds.

## Verification

- `src/renderer/src/components/chat/chatGroups.test.ts` — `chatGroupCollapsedByDefault` (Previous chats closed only beside another day); calendar days rather than 24-hour spans, day 7 vs 8, future dates; flat when off, last-message dating and empty days omitted, sort inside a day, who order with nested days, the no-summary fallback that skips a conductor; `canStartChat` for a folder agent valid, invalid and not yet in the local list, enabled/disabled, a conductor, an unlisted agent, mode and plain.
- `src/renderer/src/components/chat/ChatList.test.tsx` (`grouping`) — the menu's checked state and persistence, group headers, no button for an agent that cannot chat, the agent and mode start buttons, collapse persistence, date groups and nesting, menu keyboard over all three items, reveal opening a collapsed group.
- `src/renderer/src/components/chat/chatGroups.test.ts` (`the Active block`) — `isActiveChat` for a running chat, the streaming open chat, unread needs-input and failed, and not a read result or a cancel; `settleActiveIds` keeping rows in place and putting newcomers on top.
- `src/renderer/src/components/chat/ChatList.test.tsx` (`the Active block`) — the block above Pinned with each chat once (a Pinned block whose only chat is active is not drawn); no block with nothing active or with the switch off, and its persistence; the hold under the pointer, released by a move elsewhere; the chat on screen kept out through its own turn and joining once the view moves elsewhere, a chat opened from the block revealed on leaving, one not open not revealed, a chat opened elsewhere (behind a task page, in the block at mount) not counted as opened from the block; the hold during a rename keeping the input and its text.
- `src/renderer/src/components/layout/ChatWorkspace.drafts.test.tsx` — a mode request and `NO_CHAT_MODE` open the new-chat screen once with no agents; a pending agent wins and the mode request is dropped.
- `src/main/services/chatListSummary.test.ts` — `modeId` on the mode variant, including a conductor-bound chat.
- Not covered by a test: the daylight-saving rounding in `dateBucket`, the hover-only visibility of the start button (CSS), and the midnight rollover in a running app.
