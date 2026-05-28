# On-Demand MCP Connections

## Purpose

Let users engage an MCP server inside a specific chat *only when they need it*, without permanently adding it to a chat mode. Keeps the default chat's token budget lean: MCP tool schemas are only sent to the LLM when the user explicitly opts in by `@-mention`ing the MCP from the chat input.

## Core Concepts

- **Baseline MCPs** — The chat-mode-driven MCP set tracked in `chat_mcp_providers`. Available for every send unless the chat mode is changed.
- **On-Demand MCP** — An MCP server the user `@-mentions` inside the chat composer. Attached to the chat in a separate table (`chat_on_demand_mcps`) so the user's per-chat engagements don't tangle with the chat mode's baseline.
- **Engagement** — Picking an MCP from the `@` popup. Persists for the rest of the chat session until the user removes it via the chip.
- **Pending Announce** — Per-engagement flag that marks an MCP as "user just engaged this — tell the LLM once". The stream loop consumes the flag on the next send and prepends a silent system note; the flag flips to false so follow-up turns don't repeat the announcement.
- **MCP Chip** — A removable pill rendered next to the active-agent chip below the composer. One per on-demand MCP; clicking the `×` detaches that MCP from the chat.
- **`@` Popup MCP Section** — The agent-mention popup grows a second section labelled "MCP" inside active chats; selecting an MCP row engages it instead of switching the active agent.

## User Stories / Flows

### Pre-engaging an MCP from the new-chat screen

1. User is on the default new-chat screen (no chat exists yet). They want their first message to use the GitHub MCP.
2. User types `@gith` in the composer. The popup opens with an "MCP" section containing the matching GitHub MCP entry alongside any agents.
3. User selects the entry. The `@gith` token disappears and a "GitHub" chip (connector/`Plug` icon, fixed accent color) appears next to whichever other selectors (agent picker, chat-mode chip) are visible.
4. User types their first message and presses Enter.
5. `useNewChatFlow.startNewChat` creates the chat row, flushes the buffered MCP onto it via `chat:on-demand-mcp-add` (which sets `pendingAnnounce = true`), then kicks off the stream as usual. The LLM sees the silent announce prefix on this very first send.
6. The buffer is cleared so a return trip to the new-chat screen starts fresh.

### Engaging an MCP mid-chat

1. User is in a regular chat (LLM root, no MCP attached) and realises they need GitHub access for the next message.
2. User types `@gith` in the composer. The popup opens with an "MCP" section containing the matching GitHub MCP entry.
3. User selects the entry with Enter / click. The `@gith` token disappears from the composer; a "GitHub" chip appears next to the active-agent chip.
4. User types `list my pull requests` and presses Enter.
5. The LLM stream loop attaches the GitHub MCP tools to this send AND silently prepends `[System note: For this message the user specifically enabled the MCP server "GitHub"...]` to the user content so the model understands why the new tools are present.
6. The LLM uses the new tools to answer. The GitHub chip stays in place for follow-up turns — the announce prefix is *not* re-sent.

### Detaching an MCP

1. User clicks the `×` on the GitHub chip below the composer.
2. The chip disappears immediately and the chat's on-demand row is deleted.
3. The next send no longer includes GitHub's tools.

### Re-engaging after detach

1. User detaches GitHub, then later decides they need it again.
2. User `@-mentions` GitHub from the popup. The chip reappears with `pendingAnnounce = true`, so the next send re-fires the silent announcement.

### Engaging an MCP that's also in the chat mode baseline

1. The current chat mode already includes the GitHub MCP. The user `@-mentions` GitHub anyway.
2. The on-demand row is inserted with `pendingAnnounce = true`. The next send doesn't gain extra tools (GitHub was already attached via the baseline) but the LLM still receives the silent announcement that the user just emphasised this server. The chip appears next to the active-agent chip alongside the baseline.

### Engaging an MCP that's disconnected

1. User selects an MCP whose connection status isn't `connected` (e.g. OAuth pending, errored).
2. The chip keeps its fixed color but grows a small **red status dot** after the name; hovering the dot shows a card with the specifics (the connection error, or `not connected ({status})`). The MCP is still attached to the chat, but the stream loop won't be able to pull any tools from it until the connection recovers — the LLM simply won't see new tools for that send. The dot clears live when the connection recovers.

## Business Rules

- On-demand MCPs apply to LLM-channel sends only. A2A agent turns have their own tool set and bypass `chatStreamingService` — the on-demand list does not affect them. (Picks made on the new-chat screen still persist onto the chat row, so a later "switch back to LLM root" in a multi-agent chat picks them up.)
- The on-demand set is persisted per chat (`chat_on_demand_mcps`) and survives reload, app restart, and chat reopen. It is intentionally *not* per-message.
- New-chat screen picks live in a renderer-only buffer until the chat is created. `useNewChatFlow.startNewChat` flushes the buffer via `chat:on-demand-mcp-add` *before* the first send dispatches, so the announce prefix fires on the very first turn.
- Detaching an on-demand MCP removes the row outright; there is no "soft disable" intermediate state.
- The silent announcement is built once per engagement: the moment the user picks the MCP, `pendingAnnounce = true`; the next stream consumes it and flips it false; only re-adding the MCP (via the popup) re-arms it.
- The popup's "MCP" section is hidden outside active chats — the new-chat agent picker is unaffected.
- Only MCPs with `enabled = true` in settings appear in the popup. Disabled MCPs can't connect and would just engage a dead chip.
- The chip color is **fixed** (accent, matching the in-transcript MCP tool badge) — it no longer encodes connection status. Connection health is surfaced separately and only when there's a problem: a red status dot (with hover detail) after the name for any non-`connected` status.
- The stream loop unions the baseline set with the on-demand set and de-duplicates by provider id, so a chat mode that already includes the MCP doesn't double-list tools.
- The `@` popup keyboard nav indexes the flattened agent-then-MCP list: ArrowUp/Down moves across both sections; Enter / Tab selects the highlighted row regardless of section.

## Architecture Overview

```
User types '@' in any chat context
  -> ChatInput trigger -> AgentMcpMentionPopup
       (combined agents + MCPs, single selectedIndex)
  -> User picks an MCP row
       Active chat:
         -> useAddOnDemandMcp -> chat:on-demand-mcp-add
              -> chatService.addOnDemandMcp
                   -> chatOnDemandMcpRepo.add (pendingAnnounce=true)
         -> OnDemandMcpChips reads DB via React Query, renders the chip
       New chat (no chatId yet):
         -> onTogglePendingMcp pushes id into MainArea's buffer
         -> OnDemandMcpChips (pending mode) reads the buffer, renders the chip

User presses Enter
  Active chat:
    -> llm:send-message -> chatStreamingService.stream
  New chat:
    -> useNewChatFlow.startNewChat
         -> chat:create
         -> chat:on-demand-mcp-add per buffered id (BEFORE startLlm)
         -> startLlm -> llm:send-message -> chatStreamingService.stream

chatStreamingService.stream:
  -> baseline MCP ids (chat_mcp_providers)
  -> on-demand MCP ids (chat_on_demand_mcps)
  -> mcpManager.getToolsForProviders(union)
  -> chatOnDemandMcpRepo.peekPending(chatId)
       -> resolves names -> "[System note: ...]" prefix
  -> wireContent = prefix + userContent
  -> _runStreamLoop: on first successful adapter response,
     chatOnDemandMcpRepo.clearPending(chatId, ids)

User clicks × on a chip
  Active chat: useRemoveOnDemandMcp -> chat:on-demand-mcp-remove
  New chat:    onRemovePendingMcp removes from MainArea buffer
```

## Integration Points

- [MCP Connections](../connections/connections.md) — Owns the MCP connection lifecycle; on-demand engagement reuses the live connection rather than opening a fresh one.
- [Messaging](../../chat/messaging/messaging.md) — `chatStreamingService` is the chokepoint that unions the on-demand set with the baseline and emits the announce prefix.
- [Mention Popups](../../chat/mention_popups/mention_popups.md) — The `@` popup gains an "MCP" section inside active chats; the new-chat agent picker is unchanged.
- [Chat Modes](../../chat/chat_modes/chat_modes.md) — Baseline MCPs come from the active chat mode; on-demand engagements layer on top without mutating the mode.
