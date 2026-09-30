# Chats List: the Active Block

## Purpose

The chats that are working or have a result nobody has looked at yet are drawn together in an **Active** block at the very top of the sidebar's Chats list, so they can be found without opening every group. It is off by default and switched on from the **Chats list options** menu.

## Core Concepts

- **Active block** — an **Active** label with a lightning icon, then its rows, then a divider, above [Pinned](../chat_list_order/chat_list_order.md) and every [group](chat_list_grouping.md). Drawn only while it has a row. It has no chevron and cannot be collapsed: it exists to be seen, and the switch is how it goes away.
- **Active chat** — one that is **running** (main reports a run on it, or it is the open chat while its turn streams, before the list has polled the run) or holds an **unread result** — completed, needs input or failed, never a cancel. This is exactly the test the row's own spinner and result icon use ([Sidebar Session Status](../session_status/session_status.md)), so a row in the block always shows why it is there, and a row with an icon is never left out.
- **Show Active group** — the third switch in the **Chats list options** menu, below a separator from the two groupings. Checked while on.
- **The hold** — the block's membership changes only while the pointer is off the list, no row's right-click menu is open and no row is being renamed.

## User Stories / Flows

### See what needs attention

1. A chat starts a run in the background, or a finished run leaves an unread result. Once the pointer is off the list, the chat leaves its group (or Pinned) and appears at the top of **Active**.
2. The run ends: the row's spinner turns into its result icon in place; the row keeps its place in the block.
3. The user clicks the row. Opening the chat reads its result at once, but the row stays where it is while the pointer is still on the list.
4. The pointer leaves the list. The chat leaves the block, and since the user opened it from there, the groups around it open and its row scrolls into view, outlined for a moment and still selected — the same reveal as **Show in the Chats list** ([Chats List Grouping](chat_list_grouping.md#a-chat-pointed-at-from-elsewhere)). Without it the chat the user is reading would vanish into a collapsed group.

### A turn in the open chat

1. The user opens a chat from its group and sends a message. The chat is running, but it stays in its group: the chat on screen never joins the block, since its turn is already in front of the user and joining would move its row out and back on every message.
2. The user switches to another chat, a task page or Settings while the turn runs. The chat is no longer on screen, so it joins the block (once the pointer is off the list).
3. A chat that is in the block when the user opens it — opened from there — stays until it is no longer active, as in the flow above.

### Turn it on and off

1. The user opens **Chats list options** and checks **Show Active group** — it is off until then. The block appears at once with whatever is active; the menu stays open.
2. Unchecking it takes the block away at once, and its chats return to Pinned or their groups.
3. The choice is remembered across restarts.

## Business Rules

- **Each chat is drawn once.** A chat in the block is taken out of Pinned and out of its group while it is there. A group — or Pinned — whose every chat is active is not drawn.
- **Newcomers go on top; rows already there keep their order.** A run ending, or a result arriving on a row already in the block, never moves it inside the block: a list that reshuffles as runs finish is a list that cannot be read. Chats joining together are ordered among themselves as the flat list would order them (dragged place, else recency).
- **Nothing changes under the pointer.** Opening an unread chat reads it immediately, so without the hold the row would leave from under the click that opened it, and a newcomer would push the whole list down under the pointer. An open row menu holds the block because the menu belongs to its row; a rename holds it because moving the row remounts it and throws away the input and what was typed in it. Only membership waits: a row's spinner and result icon change in place during the hold.
- **Where the pointer is comes from every mouse move in the window**, not from the list's enter and leave events: a menu or tooltip that closes under a pointer that has not moved produces no leave at all, and the block would stay frozen. A move over a row's portaled menu or tooltip counts as on the list. The pointer leaving the window, or the window losing focus, counts as off.
- **The chat on screen does not join the block.** Its turn and its result are in front of the user already; joining would move its row to the top and back on every message. It joins once the user looks elsewhere. One already in the block when opened stays until it leaves.
- **A reveal on leaving is only for a chat opened from the block** (a click on its row there), and only if it is still the open chat when it leaves. A chat that joined while open behind a task page, or that was open when the list mounted, reveals nothing; revealing it would reopen groups the user had closed.
- **Active rows cannot be dragged, and do not accept a drop.** The block's order is not stored anywhere, so there is no place a drag could write. A chat is dragged in its group once it has left.
- **A reveal of a chat that is in the block** (from a task page) finds its row there; no group is opened.
- **The switch is per machine, not per profile**, stored in the renderer's local storage with the grouping switches. Off until it is switched on.

### Known limits

- Pinning or unpinning a chat that is in the block shows no change until it leaves; it then appears in or out of Pinned. The pin itself is saved at once: the row's menu offers **Unpin** the next time it opens.
- A result that arrives while the pointer rests on the list joins the block only when the pointer leaves. The row's icon shows it in place meanwhile.
- A chat that joined the block while the user was elsewhere and returns to a closed group when it is read is out of sight — deliberately, per the reveal rule above: it was not opened from the block.

### What it does not do

- It does not filter the list or hide anything, and it has no count or badge.
- It does not read or clear a result; opening the chat does, as before.
- It does not show job-run chats (they are hidden from the Chats list), tasks or Inbox items — only listed chats.
- It does not remember its order across restarts; the block is rebuilt from the list on launch.

## Architecture Overview

```
chat:list (polled: activeRunId, lastRunResult) + chat.store (open chat streaming)
  -> isActiveChat() per chat
  -> hold? (pointer on list | row menu open | renaming) -> keep current rows
  -> else settleActiveIds(current, active) -> newcomers on top, the rest in place
  -> Active block rows
  -> the rest -> pinnedChats() -> Pinned block
             -> groupChats() -> groups
Open chat leaves the block, and was opened from it -> revealChatId -> groups open, row scrolls and outlines
```

## Integration Points

- [Technical details](chat_list_grouping_tech.md#the-active-block) — the pure functions, the pointer tracking, the store field and the tests.
- [Chats List Grouping](chat_list_grouping.md) — the menu the switch lives in, the groups a chat leaves and returns to, and the reveal that opens them.
- [Chats List Order](../chat_list_order/chat_list_order.md) — Pinned, which the block sits above and takes chats out of; drag order, which does not apply inside it; the row menu and rename that hold it.
- [Sidebar Session Status](../session_status/session_status.md) — the running and unread-result state the block reads, and what counts as reading a result.
- [UX rules](../../development/ui_guidelines/ux_rules.md) — nothing moves under the pointer.
