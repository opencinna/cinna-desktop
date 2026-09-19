# Chat Row Summary: Technical Details

## File Locations

- Shared contract: `src/shared/chatListSummary.ts` — `ChatListSummary`.
- Main — database: `src/main/db/chats.ts` — `chatRepo.listMessageStats`, `listMessageAgentIds`, `listOnDemandAgentIds`, and the `listedChats(userId)` condition they join on.
- Main — services: `src/main/services/chatListSummary.ts:buildChatListSummaries()`, `src/main/services/chatService.ts:listSummaries()`, `src/main/services/agentTypeFields.ts:acpTransportOf()`.
- IPC and preload: `src/main/ipc/chat.ipc.ts`, `window.api.chat.listSummaries` in `src/preload/index.ts`.
- Renderer: `src/renderer/src/components/chat/ChatList.tsx`, `src/renderer/src/components/chat/ChatItem.tsx`, `src/renderer/src/components/chat/ChatItemTooltip.tsx`, `src/renderer/src/hooks/useChat.ts:useChatSummaries()`, `src/renderer/src/utils/chatSummaryFormat.ts`, `src/renderer/src/components/ui/usePopover.ts` (`'right'` placement), `HOVER_CLOSE_DELAY_MS` from `src/renderer/src/components/ui/useHoverPopover.ts`, `src/renderer/src/components/agents/AgentTypeIcon.tsx`, `src/renderer/src/constants/chatModeColors.ts`.

## Database Schema

No table, column or migration. Three reads over existing tables, each one statement for **all** listed chats of the user, none per chat:

- `listMessageStats` — per chat: `min`/`max` of `messages.created_at` over every row, and a count of `user` and `assistant` rows only.
- `listMessageAgentIds` — distinct `(chat, source_agent_id, tool_agent_id)` where either is set, ordered by the first `sort_order` each appears at.
- `listOnDemandAgentIds` — `chat_on_demand_agents` rows ordered by `created_at`, then agent id.

Each joins `chats` on `listedChats` — owned by the user, not deleted, not hidden from the list: the same condition as `chatRepo.list` — instead of taking an id list, so there is nothing to outgrow SQLite's bound-variable limit.

**Never call these from a polled path.** `idx_messages_chat_id` only finds row ids; every message row of every listed chat is still read, so the cost grows with the messages table. The comment on the three methods says so at the point someone would reach for them.

## IPC Channels

| Channel / preload method | Contract |
| --- | --- |
| `chat:list-summaries` / `chat.listSummaries()` | `Record<chatId, ChatListSummary>` for the active profile's listed chats. Requires activation; the profile is resolved in the handler. |

`chat:list` is unchanged and carries no summary: `useChatList` polls it every second. `src/main/services/chatService.setRouter.test.ts` asserts the list rows have no `summary` property, so the two cannot be merged by accident.

`ChatListSummary.with` carries `kind` (`agent` | `mode` | `none`), `name`, `color` (a chat mode's colour preset id, otherwise null) and, for agents only, `agentId`, `source`, `driver`, `protocol` and `acpTransport` — the fields `AgentTypeIcon` draws from. For `none`, `name` is the chat's model id or empty; empty means no first line. `others` is names only. Dates cross IPC as `Date`.

## Services & Key Methods

- `chatService.listSummaries(userId)` — passes the settings-scope user id, the profile user id and `chatRepo.list(userId)` to the builder; returns a plain object.
- `buildChatListSummaries(settingsUserId, profileUserId, chats)` — a fixed number of reads whatever the list length: the three grouped queries, one `agentRepo.list` per distinct scope (hand-added and folder agents live in the default scope, remote agents and chat-owned runtimes in the profile's), and one `chatModeService.findMerged` per distinct mode id, memoized. An empty list returns before any read.
  - `realAgent(id)` — the row if it exists and `isChatConductor` (`src/main/services/chatConductorService.ts`) is false. Used for the primary and for every participant, which is what keeps a hidden runtime and a deleted agent out of both.
  - Participants per chat: on-demand agents first, then `sourceAgentId` and `toolAgentId` of each message group, first occurrence kept.
  - Primary: `realAgent(chat.agentId)`; only when `chat.agentId` is null and `router === 'human'`, the first real participant.
  - Otherwise `chat.modeId` through `findMerged` gives `mode`; else `none` with `chat.modelId`. There is deliberately no default-mode fallback.
- `acpTransportOf(row)` — `stdio` | `websocket` for a custom-launcher ACP row, otherwise undefined. Extracted from `agentService`'s DTO mapping so the agent DTO and the summary derive an agent's type from one function and the icon cannot differ between the Agents list and the tooltip.

## Renderer Components

### Data

- `useChatSummaries` — query key `['chats', 'summaries']`, no `refetchInterval`. Sitting under the `['chats']` prefix is the refresh mechanism: every existing `invalidateQueries({ queryKey: ['chats'] })` (create, delete, title update, turn end in the open chat, show-in-list, …) refetches it too. The list's own optimistic writes in `useLiveRunWatch` and `useReadChatResult` use `exact: true` and `setQueryData(['chats'])`, so they neither cancel nor disturb it.
- `ChatList` covers the one case no invalidation reaches. Only the open chat's turn end invalidates `['chats']`; a background turn ends silently and is noticed only by the polled list. A ref holds the set of chat ids with an `activeRunId` from the previous list result; when any id in it is absent from the current set, `['chats', 'summaries']` is invalidated — once per result however many rows ended, never on the first result, and not when a run starts.
- `ChatList` passes each row `summary={summaries?.[chat.id]}` and its `index`.

### ChatItem

- `hasChatSummaryContent` gates everything: a loaded summary with no name, no others and no Lasted line is treated as absent.
- Uses `usePopover('right')` directly, **not `useHoverPopover`**: that hook pins the popover open on click, and a click here navigates.
- `openTooltip` / `closeTooltip` / `closeTooltipSoon` / `holdTooltip` around one timer ref. Open is immediate; `closeTooltipSoon` waits `HOVER_CLOSE_DELAY_MS` (200 ms).
- **One open at a time** is a module-level `closeOpenTooltip` handle: opening closes whichever other row registered itself, and a row clears the handle only if it still owns it (on close and on unmount). A row with no summary calls it on `mouseenter` too.
- The tooltip is portaled but remains the row's React child, so its mouse events bubble to the row's handlers. Two consequences handled explicitly:
  - `ChatItemTooltip` stops propagation of `click` and `mousedown`, or a click inside would navigate and a press would close it.
  - Moving from the tooltip straight back onto the row fires neither the row's leave nor its enter (React treats the row as the common ancestor), so nothing would cancel the close timer. The tooltip's `onMouseLeave` ignores a `relatedTarget` inside the row.
- Closes on row `mousedown`; on a capture-phase `window` `scroll` whose target contains the row (scroll does not bubble; a scroller that does not hold the row, such as the streaming transcript, is ignored); and on a change of `index`.
- While shown: `aria-describedby` on the row points at the tooltip id, the row gets the hover background explicitly (the portaled tooltip is not a DOM child, so `:hover` ends on the way onto it), and the action button's `title` is withheld. `aria-label` on the button is untouched.
- Rendered only when open, a summary exists and `usePopover` has produced a style.

### ChatItemTooltip

- `createPortal` to `document.body`; `role="tooltip"`, `z-50`, fixed 240 px wide, `--color-*` variables throughout.
- Who line: `AgentTypeIcon` at 12 px for an agent; otherwise `MessageSquare` coloured with `getPreset(color).border` for a mode, `--color-text-muted` for a model id. The name clamps to two lines; "chat mode" tag for `mode` only. Omitted when `name` is empty.
- "with …" through `formatChatOthers`, clamped to two lines. Started falls back from `firstMessageAt` to the row's `createdAt`, then `updatedAt`. Lasted is omitted when `formatChatLasted` returns null.
- `chatSummaryFormat.ts` is pure: `now` and the locale are parameters. Day difference is computed between local midnights and rounded, because a DST change makes a day 23 or 25 hours long. Durations floor within a unit ("2 h 5 min") and round at days.

### usePopover — the `'right'` placement

- `{ left: trigger.right + RIGHT_GAP, top: trigger.top }` with `RIGHT_GAP = 4`: close enough for the pointer to cross onto a hoverable popover.
- A second layout effect clamps **vertically, for `'right'` only** — the one placement that hangs down beside its trigger. Same construction as the horizontal clamp: measured with the current shift applied, whole pixels, zero-height rect returns early, `EDGE = 8`. When both edges cannot be kept, the top wins. The other placements grow away from the edge they were designed against and are untouched.
- Position measurement moved from `useEffect` to `useLayoutEffect` for every placement, so a popover is positioned in the frame it opens.
- The style's transform is `translate(x, y)` when a vertical shift exists, otherwise the previous `translateX(x)` or none.
- General description of the hook: [App Shell](../../ui/app_shell/app_shell_tech.md#usepopover-usepopoverts).

## Configuration

None. No setting, no environment variable. `HOVER_CLOSE_DELAY_MS` (200 ms) is shared with `useHoverPopover`; `RIGHT_GAP` (4 px) and `EDGE` (8 px) live in `usePopover.ts`.

## Security

Reads are scoped by `listedChats(userId)` with the profile user id resolved in main; the renderer passes no id. The payload carries agent and mode names, agent type fields, model id, two timestamps and a count — no message text, credentials, endpoints or driver configuration.

## Verification

- `src/main/services/chatListSummary.test.ts` — bound agent and its type fields, profile-scope agent, mode with colour, conductor-bound chat naming its mode, model and empty fallbacks, first attached agent of a `human` chat, Others without the primary or a deleted agent, count vs span, empty chat, profile isolation.
- `src/main/services/chatService.setRouter.test.ts` — summaries absent from list rows, keyed by chat id, per owner.
- `src/renderer/src/components/chat/ChatItem.test.tsx` — immediate open and close on leave, mode tag, model/no first line, staying open across the action button with its title withheld, tooltip→row and row→tooltip crossings, one at a time, no navigation or close from inside, click still navigates, the three scroll cases, no summary, reorder.
- `src/renderer/src/components/chat/ChatList.test.tsx` — rows before summaries, never polled, refreshed by prefix invalidation and untouched by exact-key writes, one refresh when background turns end.
- `src/renderer/src/utils/chatSummaryFormat.test.ts` and `src/renderer/src/components/ui/usePopover.test.tsx` — formats; `'right'` position, bottom lift that settles, top-edge priority, no vertical clamp elsewhere.
- `e2e/specs/chat-row-tooltip.spec.ts` — the built app: an agent chat's tooltip beside its row, staying open while the pointer moves onto it, a mode chat, no tooltip for an empty chat, and a click that still opens the chat.
- Layout is unmeasurable in jsdom (every rect is zero), so the `usePopover` tests stub the rects they assert against; where the tooltip actually lands beside a row is only observable in the built app.
