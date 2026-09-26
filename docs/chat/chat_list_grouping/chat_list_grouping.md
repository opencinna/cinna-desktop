# Chats List Grouping

## Purpose

The sidebar's Chats list can be grouped by who each chat is with, by the day of its last message, or both, with every group collapsible. A long list of similarly titled chats becomes a short list of agents and days, and each agent or mode group doubles as the quickest way to start another chat with it.

## Core Concepts

- **Group chats menu** — the list-icon button beside **+** in the Chats header, shown only while the pointer is on the header, the button has keyboard focus, or its menu is open (opacity only, so nothing shifts). Two independent switches, **Group by Agent** and **Group by Date**, each checked while on. Either, both or neither; neither is the flat list as it has always been. Both off is the default.
- **Who group** — one per counterpart, the same counterpart the [row summary](../chat_row_summary/chat_row_summary.md)'s who line names:
  - an **agent** — its type icon and name;
  - a **chat mode** — a chat icon in the mode's colour and the mode's name;
  - **Chat** — every chat with neither: plain chats with no mode, and chats whose agent or mode no longer exists. It is one group, not one per model.
- **Day group** — **Today**, **Yesterday**, **Last Week** (two to seven days ago) and **Previous chats**, always in that order, empty days omitted. Placed by the chat's **last message**, not by when the row was last touched.
- **Both on** — the day groups nest inside each who group, so "Today" appears once per agent that has a chat today.
- **Group header** — a who header shows its icon and name, with no chevron; a collapsed who group is dimmed until hovered or focused. A day header shows a chevron and its name. Day headers are a lighter, smaller label than who headers, so the two levels read as two levels.
- **Start-chat button** — at the end of a who group's header, shown while the pointer is on the header or the button has keyboard focus.

## User Stories / Flows

### Group the list

1. The user opens **Group chats** in the Chats header. The first switch takes focus; the arrow keys move between the two and Escape closes the menu and returns focus to the button.
2. The user turns on **Group by Agent**. The list regroups at once and the menu stays open, so **Group by Date** can be set in the same visit.
3. The choice is remembered across restarts.

### Collapse a group

1. The user clicks anywhere on a group header. The group closes; another click opens it.
2. Every group starts open except **Previous chats** when another day sits beside it: the older history stays out of the way until asked for. A Previous chats that is its parent's only day starts open, since it is all there is to see.
3. The user's own open or closed choice is remembered across restarts and overrides that default. A day group is collapsed **within its parent only**: closing "Today" under one agent leaves "Today" under another open.

### Start a chat from a group

1. The user points at an agent group's header. A chat button appears at its end.
2. Clicking it opens the main new-chat screen with that agent selected and its composer focused, moves the sidebar to Chats and does not toggle the group — the same thing the Agents list's chat shortcut does.
3. On a chat-mode group the button opens the new-chat screen in that mode, with no agents; on the **Chat** group, in no mode at all.

### A chat pointed at from elsewhere

1. A task page's **⋯ → Show in the Chats list** names a chat whose group is collapsed.
2. The groups around it open — the who group and, when grouping by date too, its day — and stay open; the row then scrolls into view and is outlined as usual ([Sidebar Session Status](../session_status/session_status.md#a-row-pointed-at-from-elsewhere)).

## Business Rules

- **Grouping reads what the summary resolved.** The who group comes from the chat row summary, resolved in main, because only main can tell a hidden chat-owned runtime from an agent the user chose. A plain chat bound to such a runtime sits under its **mode**, never under a group named after the runtime.
- **A row does not wait for its summary.** A chat created a moment ago has no summary yet; it is grouped from the renderer's own agent and mode lists (still never by a chat-owned runtime), and dated by the row itself. Without that, a new chat would be missing from the grouped list until the next summary read.
- **Who groups follow the list's own order.** The chats list is most recently updated first, and a group sits where its first chat does, so the most recent conversation's group leads. A group therefore moves when a background turn finishes in one of its chats — the same way a row does in the flat list.
- **Days are local calendar days.** A chat at 23:50 is "Yesterday" at 00:10, and a daylight-saving day of 23 or 25 hours still counts as one. A last message dated after now (a clock moved back) is Today. Inside a day, chats are sorted by the same last-message time that placed them there; the flat order sorts by the row's update time and the two can disagree.
- **Today rolls over by itself.** The list is re-read every second to follow running sessions, and the day boundaries are recomputed with each read, so a chat moves from Today to Yesterday at midnight without a restart.
- **The start button appears only where a chat can start.** For an agent it follows the Agents list's chat shortcut: the agent must still be listed and enabled, and a folder agent's manifest must not be invalid. A deleted, disabled or invalid agent's group keeps its count and has no button — a button that opens a composer the agent cannot answer in is worse than none. A chat mode or the plain **Chat** group can always start.
- **A pending agent pick beats a pending mode.** If both requests reach the new-chat screen together, the agent is selected and the mode request dropped; letting the mode run afterwards would clear the agents the pick had just selected. A mode deleted since the list was drawn is dropped too, without closing the chat that was open.
- **Nothing shifts under the pointer.** The start button has a fixed slot of its own; it is always rendered (invisible until hover or focus), so it is reachable by Tab and showing it moves nothing.
- **Revealing only opens.** A reveal expands the groups it needs and never collapses others; a chat that is not listed yet is found when the list is next read.
- **An open row summary closes when a group above it opens or closes**, because the row has moved; it is positioned once, on opening.
- **Preferences are per machine, not per profile.** The two switches and the open/closed choices live in the renderer's local storage. Group keys carry agent and mode ids, so a key from another profile simply matches nothing. Keys of groups that no longer exist are not pruned.

### What it does not do

- It does not filter or hide chats: every listed chat appears in exactly one group. Hidden chats (job runs) stay hidden as before.
- It does not group by model, by job or by folder, and there is no manual ordering of groups — that is what [Job folders](../../jobs/jobs/jobs.md) are for.
- It does not change what the row, its tooltip or its session status show.

## Architecture Overview

```
Group chats menu -> ui.store (chatGroupByAgent / chatGroupByDate, localStorage)
ChatList -> chats (polled) + summaries (unpolled) + agents / modes (fallback)
         -> groupChats() -> flat | who groups [-> day groups] | day groups
         -> ChatGroupHeader (collapse: ui.store.chatGroupCollapsed ?? chatGroupCollapsedByDefault)
                -> start button -> pendingAgentId | pendingModeId
                -> ChatWorkspace consumes the one-shot -> new-chat screen
revealChatId -> ChatList expands the chat's groups -> ChatItem scrolls and outlines
```

## Integration Points

- [Technical details](chat_list_grouping_tech.md) — keys, store fields, the pure grouping module and tests.
- [Chat Row Summary](../chat_row_summary/chat_row_summary.md) — supplies who each chat is with and its last message time; the header icon is the tooltip's who icon.
- [Sidebar Session Status](../session_status/session_status.md) — the rows inside the groups, and the reveal request that opens them.
- [Agents Tab & Agent Page](../../agents/local_agents/agents_tab.md) — the chat shortcut whose behaviour and availability the agent group's button copies.
- [Chat Modes](../chat_modes/chat_modes.md) — the modes a mode group names and starts a chat in.
- [App Shell](../../ui/app_shell/app_shell.md) — the sidebar and the UI store that carry the preferences and the one-shot requests.
