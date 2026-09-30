# Chats List Order: Pinned, Dragging and the Row Menu

## Purpose

The user decides where a chat sits in the sidebar's Chats list instead of leaving it to recency alone: important chats are pinned into a block at the top, and any chat can be dragged to another place inside its group. A right-click on a row offers the chat's everyday actions — pin, rename, open its agent's folder, delete — without opening it.

## Core Concepts

- **Row menu** — the right-click menu of a Chats row, opened at the pointer: **Pin** (or **Unpin**), **Rename**, **Open Folder** (only when the chat's agent is a local folder agent), a separator, then **Delete**.
- **Pinned block** — a **Pinned** header at the top of the list, above every group — only the [Active block](../chat_list_grouping/active_block.md) sits higher — holding the pinned chats in the order the user gave them. It is drawn only while something pinned is not in Active, and collapses like a day group. Not to be confused with the transcript's "pinned to the bottom" ([Transcript Scrolling](../conversation_ui/scroll_following.md)).
- **Pinned rank** — a pinned chat's place inside Pinned, higher first; none means not pinned.
- **Dragged place** — the place a user dragged a chat to inside its group. A chat never dragged has none and sorts by recency. One chat has one dragged place, used in every grouping.
- **Innermost group** — the group a row is drawn in: the flat list, one agent or mode group, one day group (inside a who group when both groupings are on), or Pinned. A row in the Active block is in no innermost group, so it cannot be dragged. See [Chats List Grouping](../chat_list_grouping/chat_list_grouping.md).

## User Stories / Flows

### Pin a chat

1. The user right-clicks a row and picks **Pin**. The chat leaves its group and appears at the top of **Pinned**; the menu closes.
2. **Unpin** from the same menu puts it back into its group, at its dragged place if it has one, otherwise by recency.
3. If pinning fails, the menu stays open with the reason under its items.

### Rename a chat

1. The user picks **Rename**. The title becomes an input of the same height, with the text selected.
2. Enter, or leaving the field, saves the trimmed title; Escape cancels. An empty or unchanged title saves nothing.
3. The row shows the new title at once. A rename that fails puts the old title back and shows the error in the row, where a failed delete shows.

### Drag a chat to another place

1. The user drags a row. It fades while dragged, and an accent line appears above or below the row under the pointer, by which half of it the pointer is on.
2. The line appears only on rows of the same innermost group; anywhere else the drop is not accepted.
3. On drop the chat moves between its new neighbours and stays there — it does not snap back while the change is saved.
4. If the move cannot be saved, the chat returns to where it was and a notice appears over the bottom of the list for a few seconds.

### Open the agent's folder, or delete

1. **Open Folder** reveals the local folder agent's directory in the system file manager, selected in its parent. It is offered only when the chat's agent — the one its [summary](../chat_row_summary/chat_row_summary.md) names, else the agent the chat is bound to — is a folder agent listed on this machine. A failure stays in the menu.
2. **Delete** moves the chat to the Trash, like the row's trash button. It is disabled while the chat is running, with the hint to interrupt the session first.

## Business Rules

- **A dragged chat keeps its place.** New activity does not move it; the chats around it that were never dragged keep sorting by recency. This is deliberate: the user put it there, and a chat that slides away on its next reply makes the drag pointless. The consequence is accepted: a chat dragged long ago and active today can sit low in Today.
- **The dragged place is on the same scale as recency.** A drop takes the midpoint between its new neighbours' ranks, where a never-dragged neighbour's rank is its time. That is how a dragged chat can sit among undragged ones that keep moving past it.
- **A drag never moves a chat into another group.** Which day a chat is in comes from its last message, and which agent group from who it is with — never from the dragged place. A row only accepts a drop from its own innermost group, so a chat cannot be dragged into another day or to another agent.
- **Groups are ordered by recency, ignoring drags.** A who group sits by its most recently updated unpinned chat. Otherwise dropping a chat could move the whole group under the pointer; days keep their fixed order.
- **One dragged place per chat, across groupings.** A drag made while grouped by date is the place the chat has in the flat list too; the rank was computed from the neighbours the user saw, so under another grouping it may sit somewhere the user did not choose.
- **A newly pinned chat goes to the top of Pinned**, above every chat already there. It can then be dragged inside Pinned.
- **Grouping has no effect inside Pinned.** Pinned is flat and ordered only by the user; its chats appear in no group below. A who group whose chats are all pinned is not drawn.
- **A running or unread pinned chat is shown in Active, not Pinned**, while the [Active block](../chat_list_grouping/active_block.md) is on; it returns to its pinned place when it leaves. Pinning or unpinning a chat that is in Active therefore shows nothing until it leaves, and a drag cannot start or land on an Active row.
- **Pinning and the dragged place are separate.** Unpinning returns the chat to the place it had in its group before, not to wherever Pinned had it.
- **Rename, pin and move are not activity.** None of them changes when the chat was last updated; otherwise renaming a chat would throw it to the top of a list sorted by recency.
- **A drop that changes nothing writes nothing.** Dropping a chat back where it was, or next to itself, is not saved.
- **A gap has limited room, and the list refuses rather than renumbers.** Each drop into the same gap halves it. After enough of them — about twenty for two chats updated a second apart, fewer for chats created in the same second, many more in Pinned — no number lies between the neighbours. The drop is then refused with the notice "Couldn't place the chat there — try another spot" and nothing is written; no other chat is renumbered to make room. Dropping elsewhere and back opens a wider gap.
- **Notices never move a row.** The failed-drop notice is drawn over the bottom of the list, not in it, and the drop line is drawn over the row edge; neither pushes anything while the user is dragging.
- **A trashed chat keeps its pin and its dragged place.** Restored from the Trash, it comes back pinned where it was.
- **A row menu or a drag holds tooltips back.** While any row's menu is open, or a drag is in progress, no row opens its [summary tooltip](../chat_row_summary/chat_row_summary.md) over it.
- **The row menu closes** on Escape, Tab, an outside click, a scroll that moves the row, a window resize or losing focus, and after a pick that succeeds. A pick that fails keeps it open with the reason. It opens at the pointer and is kept inside the window.
- **While renaming, the row is a text field.** It cannot be dragged, a click does not open the chat, and right-click gives the text field's own menu.
- **Stored on the chat.** Pins and dragged places belong to the chat, so they travel with it: a profile's own chats keep theirs in that profile, and a chat shared from the guest profile ([Settings Scope](../../core/settings_scope/settings_scope.md#shared-local-chats)) shows the same pin and place in every profile that lists it.
- **A new pin is ranked against every chat in the list the user sees**, the profile's own and the shared ones together. Ranked per owner, a shared chat and one of the profile's would get the same rank and tie in Pinned, and the newest pin would not reliably land on top.

### What it does not do

- It does not reorder groups or days, or move a chat between them. Grouping is described in [Chats List Grouping](../chat_list_grouping/chat_list_grouping.md).
- It does not offer a "reset to recency" for a dragged chat; dragging it again is the only way to move it.
- It has no keyboard reordering; the menu is reachable only by right-click.
- It does not apply to Jobs, Notes or Agents lists, which have their own ordering.

## Architecture Overview

```
Right-click row -> ChatRowMenu -> Pin / Rename (inline) / Open Folder / Delete
      -> chat:set-pinned | chat:rename | localAgents open path | chat:delete

Drag row -> same innermost group? -> dropRank(neighbours as drawn)
      -> unchanged | no-room (notice, nothing written) | rank
      -> optimistic list row -> chat:move { list: pinned | chats, rank }
      -> chats.pinned_rank | chats.sort_key  (updated_at untouched)

chat:list -> Active block (running / unread; taken out of what follows)
          -> pinnedChats() -> Pinned block
          -> groupChats() (unpinned only, by sort_key ?? recency) -> groups
```

## Integration Points

- [Technical details](chat_list_order_tech.md) — columns, channels, the rank arithmetic and tests.
- [Chats List Grouping](../chat_list_grouping/chat_list_grouping.md) — the groups a drag stays inside and Pinned sits above; [the Active block](../chat_list_grouping/active_block.md) above Pinned, which an open row menu or a rename holds still.
- [Chat Row Summary](../chat_row_summary/chat_row_summary.md) — the tooltip held back while a menu or drag is on.
- [Sidebar Session Status](../session_status/session_status.md) — the row's running state that disables Delete, and the reveal that opens Pinned when its chat is pinned.
- [Local Agents](../../agents/local_agents/agents_tab.md) — the folder agents Open Folder applies to.
- [Messaging](../messaging/messaging.md) — the chat rows, soft delete and the Trash.
