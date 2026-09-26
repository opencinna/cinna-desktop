# Chats List Grouping: Technical Details

## File Locations

- Shared contract: `src/shared/chatListSummary.ts` — `ChatListSummary.with.modeId`, the one field grouping added to the summary.
- Main: `src/main/services/chatListSummary.ts:buildChatListSummaries()` — sets `modeId` on the `mode` variant.
- Renderer — pure logic: `src/renderer/src/components/chat/chatGroups.ts`.
- Renderer — components: `src/renderer/src/components/chat/ChatList.tsx` (`ChatList`, `GroupChatsMenu`), `src/renderer/src/components/chat/ChatGroupHeader.tsx` (`ChatGroupHeader`, `StartChatButton`), `WhoIcon` exported from `src/renderer/src/components/chat/ChatItemTooltip.tsx`.
- Renderer — state: `src/renderer/src/stores/ui.store.ts`; the one-shot consumer in `src/renderer/src/components/layout/ChatWorkspace.tsx`.
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
- `groupChats(chats, summaries, fallback, { byAgent, byDate }, now)` — `ChatGrouping`: `flat`, `date` (day groups under the parent key `DATE_ONLY_PARENT` = `all`) or `who` (insertion-ordered map over the list order, each with `dates` when `byDate`).
- `groupKeysOf(grouping, chatId)` — the keys that must be open to show a chat, outermost first.
- `canStartChat(who, agents, folderAgents)` — true for `mode` and `none`; for an agent, a non-conductor row in `agents` that is `enabled`, and whose `folderAgents` entry, if any, is not `readiness === 'invalid'`. It deliberately never reads the agent's `source`: a folder row is always enabled and only folder agents are in `folderAgents`, and a branch on `source` would trip the kind-branch ratchet.

### Group keys

| Group | Key |
| --- | --- |
| Agent | `agent:<agentId>` |
| Chat mode | `mode:<modeId>` |
| Plain | `none` |
| Day | `<parentKey>\|<bucket>` — `all\|today` with no who level, `agent:a1\|yesterday` inside one |

Open/closed state is a map from these keys to the user's choice (`true` = closed), which is why a day collapses per parent. A key with no entry follows `chatGroupCollapsedByDefault(group, siblings)`: closed only for the `previous` bucket with more than one day at its level. A click stores the opposite of what is drawn, so it overrides the default either way.

## Renderer Components

- `ChatList` — computes `groupChats` in a `useMemo` over the list, summaries, fallback lists and both switches, with `new Date()` taken inside it. The memo is not a cache in practice: every one-second poll yields a new `chats` array (its `Date` fields defeat TanStack's structural sharing), which is also what moves Today at midnight. Rows get a running `index` in drawn order, so a group opening or closing above a row changes its index and closes its open tooltip (see [ChatItem](../chat_row_summary/chat_row_summary_tech.md#chatitem)). Collapsed groups render their header only.
- Reveal — an effect on `revealChatId` and the grouping calls `expandChatGroups(groupKeysOf(...))`. It does not clear the request; the `ChatItem` that shows itself does, as before.
- `GroupChatsMenu` — its trigger is `opacity-0` unless the Chats header (`group/chats-header`) is hovered, it has `focus-visible`, or the menu is open. `usePopover('right')`, portaled to `body`, `role="menu"` with two `menuitemcheckbox` items. A pick toggles without closing. Keyboard: the first item is focused once the popover is positioned, ArrowUp/ArrowDown wrap, Escape closes and refocuses the trigger.
- `ChatGroupHeader` — the whole row toggles on click; an inner `button[data-chat-group]` carries `aria-expanded` and is named by its visible label. There is no count. A who group has a fixed 16 px trailing slot holding the `StartChatButton` when `available`; the button is always in the DOM at `opacity-0`, shown by `group-hover/header` or `focus-visible`. A day group has no slot.
- `StartChatButton` — stops propagation (no toggle), then `setActiveView('chat')`, `setPendingAgentId(agentId)` for an agent or `setPendingModeId(modeId ?? NO_CHAT_MODE)` otherwise, `setSidebarTab('chats')`, `setActiveJobId(null)`.
- `WhoIcon` — exported with a `className` prop (default `mt-0.5`, the tooltip's alignment) so the header and the tooltip draw the same icon.

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
| `chatGroupCollapsed` | `cinna-chat-groups-collapsed` | JSON object of group key → boolean (`true` = closed); non-booleans dropped, an array or unparsable value reads as `{}` |

Actions: `toggleChatGroupByAgent`, `toggleChatGroupByDate`, `setChatGroupCollapsed(key, collapsed)`, `expandChatGroups(keys)` (writes an explicit `false`, so it also opens a group closed only by default; returns the same state when every key is already `false`), `setPendingModeId`. `pendingModeId` itself is not persisted.

## Security

Nothing new crosses IPC but the chat mode id, which the renderer already holds.

## Verification

- `src/renderer/src/components/chat/chatGroups.test.ts` — `chatGroupCollapsedByDefault` (Previous chats closed only beside another day); calendar days rather than 24-hour spans, day 7 vs 8, future dates; flat when off, last-message dating and empty days omitted, sort inside a day, who order with nested days, the no-summary fallback that skips a conductor; `canStartChat` for a folder agent valid, invalid and not yet in the local list, enabled/disabled, a conductor, an unlisted agent, mode and plain.
- `src/renderer/src/components/chat/ChatList.test.tsx` (`grouping`) — the menu's checked state and persistence, group headers, no button for an agent that cannot chat, the agent and mode start buttons, collapse persistence, date groups and nesting, menu keyboard, reveal opening a collapsed group.
- `src/renderer/src/components/layout/ChatWorkspace.drafts.test.tsx` — a mode request and `NO_CHAT_MODE` open the new-chat screen once with no agents; a pending agent wins and the mode request is dropped.
- `src/main/services/chatListSummary.test.ts` — `modeId` on the mode variant, including a conductor-bound chat.
- Not covered by a test: the daylight-saving rounding in `dateBucket`, the hover-only visibility of the start button (CSS), and the midnight rollover in a running app.
