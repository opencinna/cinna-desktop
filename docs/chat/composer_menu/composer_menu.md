# Composer `[+]` Menu

## Purpose

A single left-side `[+]` button on the chat composer that consolidates all chat-setup actions — attaching files, switching chat mode, and adding agents / MCP servers — into one mouse-driven menu. It is the visual counterpart to the `@` / `~` keyboard triggers and drives the exact same state changes.

## Core Concepts

- **`[+]` Composer Menu** — The single composer entry point (`ComposerPlusMenu`). Opens a small frosted popover with up to four rows: **Attach files**, **Chat mode** (sub-menu), **Add agents / MCP** (search modal), and **Coordinate by <conductor>** (a one-way action). Replaces the former separate chat-mode `+` button, agent dropdown, and right-side attach button.
- **Capability** — A polymorphic chat tool source: an **agent** or an **MCP server**. The picker treats both uniformly as selectable cards.
- **Capability Picker** — The card modal opened by **Add agents / MCP** (`AgentPickerModal` in `activeFirst` multi-select mode): an autofocused search box over a grid of agent + MCP cards.
- **Active-First Ordering** — On open, already-selected cards float to the top; they then hold position while the user toggles (a card never jumps under the cursor). The order snapshot re-sorts only on the next open or when the available capability set changes. Ported from the cinna-mobile picker.
- **Chat-mode Sub-menu** — An in-place sub-view of the `[+]` menu (back-navigable) listing the user's chat modes, mirroring the `~` shortcut popup.
- **Catalog Section** — A dedicated group at the bottom of the Capability Picker listing every cinna-server bundle the user hasn't installed yet. Each card carries an **Install** button (not a selection toggle); a one-click quick install runs inline, the card spins while installing, and on success the new agent is selected automatically. Cinna-only — empty for non-Cinna profiles. See [Bundles Catalog](../../agents/bundles_catalog/bundles_catalog.md).

## User Stories / Flows

### Opening the menu
1. User clicks the `[+]` button at the left of the composer.
2. A popover lists only the rows that apply in the current context (see Business Rules). If none apply, the `[+]` button is not rendered at all.

### Attach files
1. User clicks **Attach files** → the OS file picker opens (same flow as the old attach button). See [File Attachments](../file_attachments/file_attachments.md).
2. While an upload is in flight, the `[+]` button shows a small corner spinner (the row itself is disabled); the glyph stays a `+`.
3. Once the dialog closes (whether files were picked or it was cancelled), focus returns to the composer textarea so the user can keep typing without re-clicking. Same focus-return applies to drag-drop attaches.

### Switch chat mode
1. User clicks **Chat mode** → the menu swaps to a sub-view listing every chat mode (colored dot, name, model · MCP summary), with the active mode checkmarked.
2. Selecting a mode applies it; selecting the already-active mode deselects it. The composer border/background and the `[+]` button tint to the mode color. See [Chat Modes](../chat_modes/chat_modes.md).

### Add agents / MCP
1. User clicks **Add agents / MCP** → a centered modal opens with the search box focused.
2. Agents and MCP servers render as cards; currently-engaged ones appear selected and sorted to the top.
3. Clicking a card toggles it (the modal stays open for multiple picks); typing filters by name / description / protocol / transport.
4. Each toggle runs the same engage/detach action as an `@`-mention (see Business Rules). The footer capability chips and the new-chat comm-pattern badge update accordingly.

### Install from the Catalog (Cinna users)
1. Below the user's own agents/MCP, a **Catalog** group lists every visible cinna-server bundle the user hasn't installed.
2. User clicks **Install** on a catalog card → the card spins while a quick install runs (server install → remote-agent sync → local agent appears). Other Install buttons disable during the in-flight install.
3. On success the freshly-installed agent drops out of the Catalog group, appears as a normal capability card, and is auto-selected — ready to start the chat. If the install is missing credentials nothing extra happens here: the agent auto-replies "setup not complete" on the first message (handled by [Agents](../../agents/agents/agents.md)), so the in-chat flow stays one click.

## Business Rules

### Row visibility
- **Attach files** — shown when the current target accepts attachments (`canShowAttachButton`) and no stream is in flight. Gating rules: see [File Attachments](../file_attachments/file_attachments.md) → Destination gating.
- **Chat mode** — shown when chat modes exist AND mode selection applies here: always on the new-chat screen, and on active chats that were created with a mode. (Mode-less active chats keep their manual model + MCP controls instead.)
- **Add agents / MCP** — shown when at least one enabled agent or MCP server exists.
- **Coordinate by <conductor>** — shown when coordination is available and has not already been chosen; hidden for coordinator chats.
- The `[+]` button is hidden entirely when none of the rows apply.

### Choosing coordination
- Coordinate by <conductor> is a menuitem action, also available in the routing badge's details popover.
- It moves the chat to coordinator and disappears after success. There is no uncheck/back-to-human action.
- The candidate is an eligible Local root/participant or Default runtime; promotion does not require an API provider merely to choose a conductor.
- Pending/error handling uses the existing mutation and chat error surface. See [Chat Routing](../chat_routing/chat_routing.md).

### Capability selection & routing (mirrors `@`)
- **New chat**: toggles buffer in the renderer-only pending lists (`pendingAgentIds`, `pendingMcpIds`) owned by `ChatWorkspace`; flushed onto the chat row at creation. The router is derived at send time from the whole selection — one agent with no MCPs binds it directly, several agents follow Default multi-agent routing; agents mixed with MCPs require a Local conductor.
- **Active chat**: toggles hit the on-demand DB tables. Engaging an agent moves the chat onto the router that shape needs — a direct agent chat becoming multi-agent follows the routing preference; a plain runtime chat can keep its root as conductor — and then adds the on-demand row; engaging an MCP adds it to the on-demand set. Detaching removes the on-demand row.
- **Bound root agent**: in an active chat, the chat's root agent shows as selected and is non-removable from the picker — same constraint as the `@` popup.
- **Chat-mode baseline MCPs**: shown selected and locked too (toggling is a no-op), so the picker states what the chat actually has rather than only what the user added on top. They're detached by editing the chat mode, not here. Shown for every chat, moded or not: there is no other per-chat surface for the baseline.
- Selected state in the picker = mode-owned baseline MCPs (locked) + on-demand agents + on-demand MCPs + bound root agent (active chat), or the selected mode's MCPs (locked) + the pending buffers (new chat).

### Keyboard equivalents
- The `@` (agents + MCP), `~` (chat mode), and `#` / `/` / `?` triggers are retained as fast-path shortcuts. The `[+]` menu does not replace them — both entry points drive the same logic. See [Mention Popups](../mention_popups/mention_popups.md).

## Architecture Overview

```
User clicks [+]  ->  ChatInput  ->  ComposerPlusMenu
   ├─ "Attach files"      -> pickAttachments()            (file picker)
   ├─ "Chat mode"         -> inline sub-menu -> onSelectMode(mode|null)
   │                          (ChatWorkspace: handleSelectMode / handleActiveChatModeChange)
   ├─ "Add agents / MCP"  -> AgentPickerModal (activeFirst, multiSelect)
   │                          -> useCapabilityPicker.toggle(id)
   │                               new chat  -> pending buffers (ChatWorkspace)
   │                               active    -> chat:on-demand-* IPC (engage/detach)
   └─ "Coordinate by <conductor>" -> chat:set-router 'coordinator'
                                    (off -> 'human' with agents, 'direct' without;
                                     a refusal lands in the send-error banner)
```

## Integration Points

- [File Attachments](../file_attachments/file_attachments.md) — the **Attach files** row reuses the existing pick/drag-drop pipeline and destination gating.
- [Chat Modes](../chat_modes/chat_modes.md) — the **Chat mode** sub-menu replaces the old `ChatConfigMenu` `+` button; selection applies a mode's provider/model/MCPs.
- [Mention Popups](../mention_popups/mention_popups.md) — the `[+]` menu is the mouse-driven sibling of the `@` / `~` keyboard triggers.
- [On-Demand MCP](../../mcp/on_demand/on_demand.md) — active-chat MCP toggles engage/detach the same on-demand set as the `@` popup.
- [Chat Routing](../chat_routing/chat_routing.md) — the **Coordinate by <conductor>** row is the one deliberate router switch; adding a capability through the picker moves the chat onto the router that shape needs.
- [Orchestrated Agents](../orchestrated_agents/orchestrated_agents.md) — what a coordinated chat does once it is on that router.
- [Technical details](composer_menu_tech.md) — files, hook, and component references.
