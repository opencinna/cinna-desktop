# Chat Routing

## Purpose

Choose who answers the next message from one persisted router. A local runtime can answer directly or conduct attached specialists; a human-routed chat lets the user address agents without an intermediary.

## Core Concepts

- **Direct** — the bound agent answers. A rootless plain chat binds a chat-owned Default runtime before execution.
- **Human** — the user addresses one attached agent by chip or picker gesture; no intermediary model is required. An `@` token is removed by the picker, never parsed out of ordinary message text.
- **Coordinator** — the bound Local agent conducts; attached agents and MCP servers are its tools. A rootless legacy coordinator is normalized to a chat-owned runtime. The shared helper retains rootless model targets for compatibility, but execution has no adapter chat path.
- **Local** — a folder agent or stdio ACP command to which Desktop can inject tools. A2A, WebSocket ACP and Managed sessions remain participants. A command that invokes SSH still follows the existing stdio classification.
- **Catch-up** — an agent receives what it missed since its per-chat cursor; a replacement ACP session of the chat's answerer root additionally receives a full transcript replay.

## User Stories / Flows

1. In Settings → Features → AI Functions, choose **You route** or **AI routes** for Default multi-agent routing. The installation default is You route; changing it does not rewrite existing chats.
2. Pick one agent: it answers directly. Pick several without MCP: the preference determines human routing or coordination. Mix any agent with MCP: a conductor is required regardless of the preference.
3. Under AI routes, a first selected Local agent is Coordinator. If the first selected agent is remote, Default runtime is shown as a synthetic Coordinator and all selected agents remain Participants. Selecting a Local agent later does not move it ahead of the first selection.
4. In a human/direct chat, open the badge's keyboard-reachable details or the composer `[+]` menu and choose **Coordinate by <name>**. An eligible existing root continues; otherwise an eligible attached Local agent or the Default runtime conducts. The action disappears after coordination; there is no UI action back to human routing. A plain chat whose only root is its hidden Default runtime offers no such action: there is no agent to coordinate yet. In a new-chat draft the choice is not yet one-way — removing every picked agent resets it, because otherwise the next pick would be coordinated with no control on screen that says why or undoes it.
5. In a human chat, selecting a chip addresses that agent. With no explicit selection, the last user message's address wins, then the first attached agent. Only the actual answerer's readiness blocks Send.

## Business Rules

- `src/shared/chatRouting.ts` owns routing for main and renderer. `direct` and `coordinator` both retain a non-null root; human routing detaches it into the attached set without deleting its session.
- `needsModel` is true only for a non-human chat without a root. The executor binds a runtime before dispatch; a missing API provider alone does not block plain chat creation. Runtime installation, login and tool-policy requirements still apply.
- Adding a second agent applies the preference when a direct chat becomes multi-agent — unless the root is the chat's hidden chat-owned runtime. That runtime is never an agent the user picked, so it is never detached into a participant they would have to address: adding an agent to a plain chat makes it a coordinator chat with that runtime conducting, whatever the preference says. Main enforces this on the router change itself, so a caller that asked for human routing still gets coordination; the composer likewise does not address the arriving agent. Existing coordinator chats stay coordinated even after participants are removed.
- A remote root promoted to coordinator becomes a participant; a hidden chat-owned Local runtime becomes the root. Synthetic conductors remain resolvable by ID but are excluded from ordinary agent pickers/sidebar/job selection.
- Role chips add rings/labels without reordering selected agents. The badge names the conductor, such as **Claude routes**; direct resolved agents retain Local/Remote connection details.
- A routing update refreshes chat, attached-agent and agent caches. A freshly bound synthetic root must be visible immediately, rather than requiring a reload to show its identity.
- Attachment storage follows the actual answerer's capability: Local ACP uses local files; Cinna-backed uploads remain remote. Router alone cannot decide upload scope.
- Coordinators receive catch-up as well as human-addressed participants, including normal sends and resends. A resumed ACP session remembers its own turns but cannot know what a specialist said while it owned the task; handback must carry that missed answer before coordination continues.
- Catch-up cursors advance only after completed turns. The ordinary packet is capped at 4000 characters, excludes the recipient's own turns, and carries file names rather than bytes. Fresh-session replay is separate, preserves stored attachment content according to negotiated ACP capabilities, and applies only to the chat's answerer root: a participant's fresh session gets the catch-up packet alone, because replaying every past turn on top of it would hand a specialist the whole conversation twice.
- Router changes do not delete `(chat, agent)` sessions. The UI's one-way action does not remove internal routing transitions needed by the runner and chip cleanup.
- The Local Development builder flow retains its guarded, direct agent binding; it does not inherit a chat mode merely because the global preference changed.

## Architecture Overview

Composer selection → shared routing helper → chat update/normalization → main run executor → agent driver. Local ACP roots receive the chat's authenticated Cinna MCP endpoint; human-routed messages go to the addressed driver directly.

## Integration Points

- [Runtime orchestration](../orchestrated_agents/orchestrated_agents.md) — tool transport, child calls, Inbox and continuity.
- [Chat modes](../chat_modes/chat_modes.md) — runtime, instructions and no-native-tools policy.
- [Technical routing reference](chat_routing_tech.md) — state, IPC and caches.
- [File attachments](../file_attachments/file_attachments.md) — capability-driven storage and prompt conversion.
- [Autonomous tasks](../../jobs/tasks/autonomous_tasks.md) — runner-owned internal routing and control tools.
