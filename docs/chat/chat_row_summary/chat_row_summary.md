# Chat Row Summary

## Purpose

Hovering a conversation in the sidebar's Chats list shows, beside the row, who that chat is with and when it happened. Titles are generated and often alike; the summary is what tells two similarly named chats apart without opening either.

## Core Concepts

- **Summary** — per listed chat: who it is with, which other agents took part, when it started, and how long it lasted over how many messages. Resolved in the main process and fixed for a given state of the chat; nothing arrives after the tooltip opens.
- **Who line** — the first line. One of three things, or absent:
  - an **agent** — its type icon (the same one the Agents list draws) and its name;
  - a **chat mode** — a chat icon tinted with the mode's colour, the mode's name, and a small "chat mode" tag;
  - a **model id** — for a chat with neither, with an untinted chat icon;
  - nothing, when the chat has no model either.
- **Primary** — the agent the who line names: the chat's bound agent, or, for a `human`-routed chat with nothing bound, the first agent attached to it.
- **Others** — every other agent that took part, shown as "with A, B, C +2": agents attached on demand, together with agents that produced a turn or a tool call in the transcript, minus the primary. Never more than three names; the rest is a count.
- **Started** — the time of the chat's first message row, or the chat's creation time when it has none. "Today 14:32", "Yesterday 09:05", then a date, with the year only when it differs from this one. Today and yesterday are calendar days, not 24-hour spans: 23:50 last night is yesterday at 00:10.
- **Lasted** — first to last message row, then the message count: "25 min · 14 messages". The span covers every row, so a session that ended in tool work lasts until it; the count is user and assistant messages only.

## User Stories / Flows

### Tell two chats apart

1. The user moves the pointer onto a chat row. The summary opens at once, 4 px to the right of the row, top edges level — beside the row, so it covers neither that row nor the ones the pointer moves on to.
2. The row stays lit for as long as its summary is open, including while the pointer is on the summary.
3. The user moves down the list. Each row's summary replaces the last; two are never open together.
4. The user moves the pointer off the list. The summary closes 200 ms after the pointer has left both the row and the summary.

### Rest the pointer on the summary

1. The user moves from the row onto the summary, crossing the row's trailing action button and the 4 px gap. It stays open throughout.
2. While it is open, the action button's own native tooltip is held back — two tooltips at once say two things. The button keeps its accessible name.
3. A press or click inside the summary neither opens the chat nor closes the summary.
4. Moving straight back onto the row keeps it open.

### Open the chat

1. The user presses the row. The summary closes on the press, and the click opens the chat as before.

## Business Rules

- **A summary that would show only Started shows no tooltip.** A chat with no who line, no others and fewer than two messages has nothing to say that the list's order has not already said. Hovering such a row still closes another row's summary, which is no longer about the row under the pointer.
- **Lasted needs two ends.** Under two messages there is no span, and the line is absent rather than "under a minute · 1 messages".
- **A hidden chat-owned runtime is never named.** A plain chat is bound to a hidden runtime row before it runs ([Chat Routing](../chat_routing/chat_routing.md)); that row is an implementation of "a plain chat", not someone the user chose. Such a chat names its chat mode, and chat-owned runtimes are dropped from Others as well. This is why the summary is resolved in main: the renderer cannot tell that row from a chosen agent.
- **An agent that no longer exists is not named** — not as primary, not among Others. A chat whose bound agent was deleted falls through to its mode or model line; it does not promote an attached agent, which is the rule for a `human` chat with nothing bound only.
- **No fallback to the default chat mode.** The chat page resolves a chat's mode from the chat's own mode and shows none when that is empty. The row must not name a mode the page it opens does not.
- **Others are stable.** Attached agents come first, in the order they were attached — the same order that picks the primary of a `human` chat — then agents in order of first appearance in the transcript. Deduplicated by name.
- **It opens complete or not at all.** A row whose summary has not loaded has no tooltip; the rows themselves never wait for summaries. Content arriving in an open tooltip would move it under the pointer.
- **It opens immediately, with no hover delay,** and is measured in the frame it opens, so sweeping down the list never paints a frame of nothing between one row's summary and the next.
- **One at a time.** Each row closes on a delay so the pointer can reach the summary; without a single shared "the open one", a sweep down the list would leave the last row's summary up beside the next row's.
- **It is positioned once, on opening, so anything that moves the row closes it.** A scroll of any container holding the row (or of the window) closes it; so does the list reordering the row, as a background turn finishing does. A scroll elsewhere does not: the transcript scrolls continuously while a turn streams, and that must not take the summary away.
- **Near the bottom of the window it is lifted to stay inside**, keeping 8 px from the edge. When it cannot fit at all, the top edge wins: the first line says who.
- **Summaries are never fetched on a timer.** The chat list is re-read every second to follow running sessions; building summaries reads every message row of every listed chat, a cost that grows with the whole messages table. They are read once, and again whenever the list is known to have changed (a chat created, deleted, renamed, a turn ending in the open chat) or a background session is seen to stop running.
- **It looks like the app's other floating panels, and sometimes glows.** The same translucent, blurred panel as the routing badge's popover. With [Extra UI animation](../../ui/appearance/appearance.md) on, about one opening in three gets a single pass of the secondary buttons' border glow from a random corner — decided when it opens, so a sweep down the list is not a row of lights; off, or under reduced motion, it never glows.
- **Profile-scoped.** Only the active profile's listed chats are summarized; hidden and deleted chats are not.
- **It is a tooltip, not a menu.** It holds no controls today and is announced as a description of the row. The day a control goes in, it becomes a non-modal dialog, and the limits below start to matter.

### Known, accepted limits

- **It can cover the composer's left edge** for as long as the pointer rests on a row or on the summary. It is 240 px wide and sits over the main area; it goes when the pointer leaves.
- **Aiming diagonally at its lower part can be stolen by the next row.** The pointer crosses the row below on the way, and that row's summary replaces this one. Harmless while the summary is read-only; it starts to matter once there is something in it to click.
- **There is no keyboard path.** Chat rows are not keyboard-focusable, so the summary is pointer-only. Nothing in it is unavailable elsewhere: the chat page shows the agent, mode and transcript.

## Architecture Overview

```
Pointer on row -> ChatItem (open / hold / close timing, one open at a time)
                    -> usePopover('right') -> ChatItemTooltip (portaled to body)

ChatList -> useChatSummaries ['chats','summaries'] (not polled)
         -> chat:list-summaries -> chatService.listSummaries
         -> buildChatListSummaries -> three grouped reads over listed chats
                                    + agent rows (both scopes) + chat modes

ChatList -> polled list: a row that was running and no longer is
         -> invalidate ['chats','summaries']
```

## Integration Points

- [Technical details](chat_row_summary_tech.md) — channel, queries, refresh triggers, pointer handling and tests.
- [Sidebar Session Status](../session_status/session_status.md) — the same row's spinner, result icon and interrupt/delete action; the polled list that notices a background session ending.
- [Chat Routing](../chat_routing/chat_routing.md) and [Orchestrated Agents](../orchestrated_agents/orchestrated_agents.md) — the router values, on-demand agents and the hidden chat-owned runtime the summary refuses to name.
- [Chat Modes](../chat_modes/chat_modes.md) — the mode name and colour preset on the who line.
- [App Shell](../../ui/app_shell/app_shell.md) — the sidebar the list lives in, and the shared popover positioning ([technical](../../ui/app_shell/app_shell_tech.md#usepopover-usepopoverts)).
- [Session Activity](../../agents/session_activity/session_activity.md) — the other hoverable popover, whose close delay this one shares and whose click-to-pin behaviour it deliberately does not.
