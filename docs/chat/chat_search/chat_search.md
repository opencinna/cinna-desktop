# Chat Search

## Purpose

Find what was said. ⌘F (Ctrl+F elsewhere) searches the chat on screen; with no chat open, or from the search button in the Chats header, it searches every chat. A result takes the user to the message itself, scrolled into view and flashed, and the search gets out of the way.

## Core Concepts

- **This chat** — a frosted search bar where **Jump to latest** sits, just above the composer's drawn content (its notice panel included). While it is open it takes the pills' place. Matching user and assistant messages appear above the bar as one frosted card each, newest nearest the bar, and every match is also highlighted in the transcript itself.
- **All chats** — an overlay over the main area (right of a docked sidebar), a scrim, results grouped by chat, the bar at the bottom. Chats are ordered by their newest match, the newest nearest the bar; each shows its three newest matching messages, then a **N older in this chat** button.
- **Scope button** — in the bar, switches between the two and keeps the query. Disabled while no chat is open.
- **Agent chips** — All chats only. After a non-empty query, one chip per agent or chat mode the query found, with its match count; **All agents** clears them. Pressing is multi-select. A chat's heading carries its own chip, which toggles the same filter.
- **Result card** — role dot, "You" or the agent's name, time ("Today 09:26", "Yesterday 14:12", a weekday, "14 Oct"), "N matches", **Go to** on hover. The body is the message rendered as markdown, clipped to five lines and scrolled so the first match is the middle line; the fade at the top and bottom shows only where the text is cut. A chat with an agent the user gave a [colour](../../agents/agents/agent_colors.md) wears it as its cards' border.
- **Dot rail** — the lists have no scrollbar. One dot per result sits beside the list, lit while its result is on screen, with an extra gap between chats; clicking a dot scrolls to it. Where the column's margin is too narrow (under 800 px) the rail moves inside the column.

## User Stories / Flows

### Search the open chat

1. ⌘F opens the bar with the field focused. Typing changes nothing until a pause (see Rules); then the cards and the count ("12 matches", "No matches") appear.
2. ↑/↓ move the active card (the newest starts active), Enter or a click picks it: the transcript scrolls so the match sits at about 40 % of the viewport, the block holding it flashes, the match is marked for a moment, and the search closes.
3. Esc, the close button or a click on the scrim closes it without scrolling. Focus returns to what had it before, else the composer. Picking a result instead puts focus in the opened chat's composer.

### Search every chat

1. ⌘F with no chat open, or the Chats header's search button (shown with the grouping menu: hover or focus on the header). Same field, same keys.
2. Results appear grouped by chat. If the query found two or more agents the chip row appears; pressing chips narrows the results to those agents' chats.
3. A pick opens that chat, scrolls to the message and closes the search. **N older in this chat** opens the chat with its own in-chat search already running on the query.

### Coming back

The query and the pressed chips outlive a close, so ⌘F reopens where the user left off, until the window reloads. Opening another chat while a chat search is open closes it and clears its highlights.

## Business Rules

- **Whose words.** Only user and assistant messages are searched, never a tool block, a tool result, an attachment or an error row. All-chats search covers exactly the chats the Chats list shows: hidden chats (job runs) and other profiles' chats are out.
- **Results change only after a 300 ms pause in typing.** Results rewriting under a key still being pressed made the list shift while the user read it. While a newer query waits, the bar's search icon pulses; Enter then applies the query at once instead of opening a stale result. Likewise, results kept from an earlier query or filter while the new ones load are drawn but count as pending: Enter opens nothing.
- **Nothing moves while the user types.** The count has a fixed-width slot so "9" becoming "12" never shifts the buttons beside it, the chip row appears only after a query and does not reflow per keystroke (it follows the paused query), and the notice for truncation is a fixed line beside the bar rather than text inside the list.
- **All chats stops at 50 chats.** More than 50 matching chats shows "50+ chats" in the count and a line above the bar saying only the 50 chats with the newest matches are shown, so older ones are not silently missing. With chips pressed, main filters before it cuts: a pressed agent's chats past the newest 50 are still found. The chip counts, though, come from the unfiltered search, so they cover only those 50; a line says so when it applies.
- **This chat stops at 30 cards.** Each card is a rendered markdown snippet, so only the newest 30 are drawn, with a line saying how many older matches there are. The transcript highlights every match regardless.
- **The query is trimmed and cut at 200 characters;** a blank query finds nothing.
- **No mask on a results list.** A `mask-image` on the scrolling list makes it the backdrop root, and the cards' blur would then see only the list, not the transcript behind it: the glass goes flat. The only fade is on each card's snippet, inside the card.
- **Highlights never touch React's DOM.** They are painted with the CSS Custom Highlight API over text ranges; a search that edited the transcript's nodes would be undone by the next render. Where the API is missing, nothing is painted and search still works.
- **⌘F backs off under any dialog** and does nothing on the login or onboarding screens: a search opening behind a modal would take its focus. Pressed inside the search field it selects the query.
- **Only the chat view's transcript is searchable.** Dashboard panels and other embedded or hosted transcripts do not take ⌘F: with only one of those on screen, ⌘F opens All chats.

### Known limits

- Matching is a plain case-insensitive substring. In all-chats search SQLite's `LIKE` is case-insensitive for ASCII only; `é` does not match `É` there, though the in-chat search (JavaScript lowercasing) does match it. `%`, `_` and `\` in a query are taken literally.
- A match that spans formatting (half in bold, say) is counted from the message's source text but cannot be highlighted: highlights work inside single text nodes of the rendered message.
- All-chats search is a synchronous query in the main process with no index (a `%…%` pattern cannot use one): measured at about 170 ms on a 200 MB database, during which main does nothing else. It runs only on demand, never from a polled path.

### What it does not do

- It does not search tool output, files, notes or tasks, and does not rank: order is by time.
- It does not keep a search history; the last query lives for the window's session only.
- It does not follow new messages: results are what was found when the pause ended.

## Architecture Overview

```
⌘F ─ useChatSearchShortcut ─▶ chatSearch.store (scope: chat | all | null, query, agent keys, jump)
                                     │
   Chats header ─ search button ─────┤
                                     ├─▶ ChatSearchInChat (inside MessageStream; local, over loaded messages)
                                     └─▶ AllChatsSearch (App shell) ─ window.api.chat.search ─▶ chat:search ─▶ chatService.search
```

See [Chat Search technical details](chat_search_tech.md).

## Integration Points

- [Chats List Grouping](../chat_list_grouping/chat_list_grouping.md) — the header button, and `chatWho`, the grouping that decides which agent chip a chat carries.
- [Transcript Scrolling](../conversation_ui/scroll_following.md) — the bar takes the pills' place; a jump leaves the bottom first so a streaming chunk cannot pull the view back.
- [Chat Row Summary](../chat_row_summary/chat_row_summary.md) — the summaries that say who each chat is with, shared with the chip filter in main.
- [Agent Colors](../../agents/agents/agent_colors.md) — chosen colours tint a chat's result cards.
