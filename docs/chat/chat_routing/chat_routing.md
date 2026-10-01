# Chat Routing

## Purpose

Choose who answers the next message from one persisted router. A local runtime can answer directly or conduct attached specialists; a human-routed chat lets the user address agents without an intermediary.

## Core Concepts

- **Direct** — the bound agent answers. A rootless plain chat binds a chat-owned Default runtime before execution.
- **Human** — the user addresses one attached agent by a gesture — **Address Next Message** in its chip's menu, or the `@` picker; no intermediary model is required. An `@` token is removed by the picker, never parsed out of ordinary message text.
- **Coordinator** — the bound Local agent conducts; attached agents and MCP servers are its tools. A rootless legacy coordinator is normalized to a chat-owned runtime. The shared helper retains rootless model targets for compatibility, but execution has no adapter chat path.
- **Local** — a folder agent or stdio ACP command to which Desktop can inject tools. A2A, WebSocket ACP and Managed sessions remain participants. A command that invokes SSH still follows the existing stdio classification.
- **Catch-up** — an agent receives what it missed since its per-chat cursor; a replacement ACP session of the chat's answerer root additionally receives a full transcript replay.

## User Stories / Flows

1. In Settings → Features → AI Functions, choose **You route** or **AI routes** for Default multi-agent routing. The installation default is You route; changing it does not rewrite existing chats.
2. Pick one agent: it answers directly. Pick several without MCP: the preference determines human routing or coordination. Mix any agent with MCP: a conductor is required regardless of the preference.
3. Under AI routes, a first selected Local agent is Coordinator. If the first selected agent is remote, Default runtime is shown as a synthetic Coordinator and all selected agents remain Participants. Selecting a Local agent later does not move it ahead of the first selection.
4. In a human/direct chat, open the composer `[+]` menu and choose **Coordinate by <name>**. An eligible existing root continues; otherwise an eligible attached Local agent or the Default runtime conducts. The action disappears after coordination; there is no UI action back to human routing. A plain chat whose only root is its hidden Default runtime offers no such action: there is no agent to coordinate yet. In a new-chat draft the choice is not yet one-way — removing every picked agent resets it, because otherwise the next pick would be coordinated with no control on screen that says why or undoes it.
5. In a human chat, click an agent's chip and pick **Address Next Message**; the ring moves to that chip. The item is absent on the chip already addressed. With no explicit selection, the last user message's address wins, then the first attached agent. Only the actual answerer's readiness blocks Send.
6. To choose *which* agent coordinates, click or right-click its chip under the composer (or focus it and press Enter, Space, Shift+F10 or the ContextMenu key) and pick **Set as Coordinator**. A direct or human chat becomes coordinated with that agent as root; a coordinated chat hands the role over. On the new-chat screen the same item turns coordination on for the draft with that agent conducting. The menu also offers **Go to Agent** (absent for a disabled remote agent, which has no page to open) and, for an agent the folder scan lists, **Open Agent Folder**.

## Business Rules

- `src/shared/chatRouting.ts` owns routing for main and renderer. `direct` and `coordinator` both retain a non-null root; human routing detaches it into the attached set without deleting its session.
- No chat needs a model of its own: a non-human chat without a root is bound a runtime by the executor before dispatch (there is no `needsModel` flag on `ChatRouting`); a missing API provider alone does not block plain chat creation. Runtime installation, login and tool-policy requirements still apply.
- Adding a second agent applies the preference when a direct chat becomes multi-agent — unless the root is the chat's hidden chat-owned runtime. That runtime is never an agent the user picked, so it is never detached into a participant they would have to address: adding an agent to a plain chat makes it a coordinator chat with that runtime conducting, whatever the preference says. Main enforces this on the router change itself, so a caller that asked for human routing still gets coordination; the composer likewise does not address the arriving agent. Existing coordinator chats stay coordinated even after participants are removed.
- A remote root promoted to coordinator becomes a participant; a hidden chat-owned Local runtime becomes the root. Synthetic conductors remain resolvable by ID but are excluded from ordinary agent pickers/sidebar/job selection.
- The conductor's chip leads the row; the other chips keep selection order. On the new-chat screen a chip picked as coordinator moves to the front at once, where the bound chip will stand after the first send, so nothing reorders when the chat is created. The badge names the conductor, such as **Claude routes**; direct resolved agents retain Local/Remote connection details.
- Two chip marks, never meaning the same thing and neither changing a chip's size, so the chips beside it do not slide when either moves: the **coordinator** has its left and right sides one pixel heavier, drawn as an inset shadow in the chip's own colour (a wider border would widen the chip); the **addressed** agent in a human chat has a 2px ring in the foreground colour. The role is in the chip's title and accessible name, not in a visible label: `Agent “<name>” answers your next message` on the addressed chip, else `<name> — Coordinator` / `<name> — Participant` in a coordinated chat and `Agent "<name>" attached as a participant` elsewhere. A conductor the user picked keeps its own agent colour; only the hidden Default runtime, which has no identity to colour by, uses the accent.
- **A click on an agent chip opens its menu** — anywhere on it but its ×, and the same menu a right-click opens. A pointer opens it at the pointer; Enter or Space (and Shift+F10 / the ContextMenu key) open it at the chip and return focus there on close. A click therefore does the same thing whatever the router; addressing is a menu item, not the click itself. Chip names are labels, not text: they cannot be selected, so a drag across the row selects nothing.
- The menu lists what the chip does in this chat — **Address Next Message** (human chats only), **Set as Coordinator** — then a separator, then where the agent lives: **Go to Agent**, **Open Agent Folder**. The separator appears only when both groups have an item.
- **Set as Coordinator** is absent on the current conductor's chip and on the hidden Default runtime's (which has no menu at all). It is disabled with a reason shown under it — visible text, because the arrow keys skip a disabled item and a tooltip would be out of the keyboard's reach — when the agent cannot conduct ("Only a local agent can coordinate"), while a turn runs, or while an autonomous task holds the chat. A refused pick keeps the menu open with main's message in it.
- A routing update refreshes chat, attached-agent and agent caches. A freshly bound synthetic root must be visible immediately, rather than requiring a reload to show its identity.
- Attachment storage follows the actual answerer's capability: Local ACP uses local files; Cinna-backed uploads remain remote. Router alone cannot decide upload scope.
- Coordinators receive catch-up as well as human-addressed participants, including normal sends and resends. A resumed ACP session remembers its own turns but cannot know what a specialist said while it owned the task; handback must carry that missed answer before coordination continues.
- Catch-up cursors advance only after completed turns. The ordinary packet is capped at 4000 characters, excludes the recipient's own turns, and carries file names rather than bytes. Fresh-session replay is separate, preserves stored attachment content according to negotiated ACP capabilities, and applies only to the chat's answerer root: a participant's fresh session gets the catch-up packet alone, because replaying every past turn on top of it would hand a specialist the whole conversation twice.
- Router changes do not delete `(chat, agent)` sessions, and they release only what changed: each agent that left the chat, plus the old root when another agent now coordinates (its role changed, so it rejoins as a participant with a fresh session and catch-up). Everyone still in the chat keeps their session — in particular a root moved to the attached set by direct → human keeps answering. Release is per `(chat, agent)`, never per role. Releasing every agent on any router change is what once cut a running conductor's tools off when an agent was attached mid-turn ([Orchestrated Agents](../orchestrated_agents/orchestrated_agents.md)).
- A router change (and Set as Coordinator) is refused while a turn runs — "Interrupt the session before changing who answers." — because the turn holds the root's session and tool endpoint. That includes attaching an agent to a **direct** chat mid-turn, which needs a router change first; attaching to a human or coordinated chat does not, and works mid-turn. A change is also refused while an autonomous task holds the chat.
- The UI's one-way action does not remove internal routing transitions needed by the runner and chip cleanup.
- The Local Development builder flow retains its guarded, direct agent binding; it does not inherit a chat mode merely because the global preference changed.

## Architecture Overview

Composer selection → shared routing helper → chat update/normalization → main run executor → agent driver. Local ACP roots receive the chat's authenticated Cinna MCP endpoint; human-routed messages go to the addressed driver directly.

## Integration Points

- [Runtime orchestration](../orchestrated_agents/orchestrated_agents.md) — tool transport, child calls, Inbox and continuity.
- [Chat modes](../chat_modes/chat_modes.md) — runtime, instructions and no-native-tools policy.
- [Technical routing reference](chat_routing_tech.md) — state, IPC and caches.
- [File attachments](../file_attachments/file_attachments.md) — capability-driven storage and prompt conversion.
- [Autonomous tasks](../../jobs/tasks/autonomous_tasks.md) — runner-owned internal routing and control tools.
