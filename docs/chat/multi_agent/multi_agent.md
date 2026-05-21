# Multi-Agent Chats

> **Status:** implemented. This document reflects the shipped behavior; where it diverges from the original design discussion, the rationale is called out inline.

## Purpose

Let a single chat fluidly involve more than one agent without leaving the conversation. The user can `@-mention` any enabled agent mid-chat to switch the chat's active routing target; subsequent messages stick to that agent until the user switches back to the chat's root counterparty (or to yet another agent). The app handles cross-agent context handoff so each agent gets enough background to make sense of what's being asked.

## Core Concepts

- **Root counterparty** — Who the chat was originally created with. Either the chat's bound agent (agent chats) or the chat-mode LLM (LLM chats). "Switch back" always returns to this.
- **Active agent** — The participant the next message will be routed to. Sticky — does not change after a single message; the user must `@-mention` someone else or click "Switch back" to change it. Persisted on the chat row (`chats.active_agent_id`).
- **Popup-select switch** — Picking an agent from the `@` popup *immediately* switches the chat's active agent (fires `multiAgent:set-active-agent`). The `@token` is dropped from the composer; the user then types their message normally. This differs from the original design discussion which had the switch happen at send time — the immediate-switch model lets the user see which agent they're talking to before they commit to a message.
- **Smart Rewrite** — When an agent is being addressed for the first time in a chat that has prior history, the user's message is rephrased by an LLM into a self-contained prompt that does not rely on prior conversation. The rewrite LLM may also decide the message is *already* self-contained and emit a keep-original signal — in that case the original text dispatches immediately, skipping the double-send confirmation. Fires only at the agent's *join* moment; same-agent follow-ups pass through unchanged.
- **Keep-original sentinel** — The rewrite LLM is instructed to emit a fixed token (`__KEEP_ORIGINAL__`) instead of a rewrite when the user's message already stands on its own (no unresolved pronouns, no implicit references to prior turns). The service detects the sentinel and signals the composer to send the original as-is.
- **Double-send** — UX mechanism for confirming rewrites. First Enter triggers the rewrite and replaces the composer text with the rewritten version; the second Enter actually sends. The user can edit the rewritten text or press Esc to revert. Clearing the composer entirely also abandons the pending rewrite. The keep-original sentinel bypasses the double-send entirely — the dispatch happens on the first Enter.
- **Catch-up replay packet** — When an agent is re-engaged after another agent's turns happened in between, a literal turn-by-turn transcript of the missing period is prepended to the next routed message. No LLM rephrasing, no tool payloads — plain transcript only. **Not** sent on the agent's first engagement — Smart Rewrite already encapsulates the necessary context, so doubling it up wastes tokens.
- **Smart-assist disable** — Per-chat flag (`chats.smart_assist_disabled`) that turns off the rewrite step (and only the rewrite step). Offered after a rewrite failure modal. Routing and catch-up replay continue working. One-way for the first ship — manual re-enable is a follow-up.
- **Switch-back button** — Inline text button rendered next to the active-agent chip below the composer. Shows "Switch back to `<root>`" when the active agent isn't the root. Single source of truth for the user's routing context.

## User Stories / Flows

### Bringing a second agent into an existing chat

1. User is in a chat with `@email-agent` (the chat's root, bound at create time) with a few prior turns of history.
2. User types `@` — the agent popup appears under the cursor.
3. User selects `@erp-agent` from the popup. The `@token` disappears from the composer; the chip below the input flips to "ERP Agent" and a "Switch back to Email Agent" button appears next to it. The chat's `active_agent_id` is now `erp-agent`.
4. User types `give me details about him` and presses Enter.
5. The composer enters a "rewriting…" state. The app sends the chat history + `@erp-agent` description + the typed message to the rewrite LLM (resolved from the chat's chat mode, falling back to the user's default chat mode).
6. The rewrite LLM returns a self-contained prompt, e.g. `Provide details about contact with email client@example.com`. The composer text is replaced with this rewritten version and the hint line *"Rewritten. Press Enter to send, Esc to revert, or edit before sending."* appears above the textarea.
7. User reviews the rewritten text. They can edit it freely or press Esc to revert to their original.
8. User presses Enter again. The rewritten message is sent to `@erp-agent` *without* a catch-up replay packet — the rewrite is the context handoff on the join moment.
9. The user bubble in the transcript shows the rewritten text. The original is preserved in the DB (`messages.original_text`) for future improvements (self-learning, audit).
10. `@erp-agent` replies; its assistant bubble is labelled with the agent's name and a hash-derived color.

### Continuing with the new agent

1. User types a follow-up without any `@-mention`. The message routes to `@erp-agent` (still active).
2. No rewrite happens (same agent, already participated).
3. No catch-up replay (the agent has been participating since its last turn — its catch-up cursor points to its most recent user message).

### Switching back to the root

1. User clicks "Switch back to Email Agent" next to the chip (or `@-mentions` `@email-agent` explicitly from the popup).
2. The active agent flips to `@email-agent`. The chip updates immediately; the "Switch back…" button disappears (active == root).
3. User's next message is routed to `@email-agent`. Because `@email-agent` missed the `@erp-agent` exchange, a catch-up replay packet is prepended summarizing that period.
4. No rewrite happens — the user's message is sent as-is. Rewrite only triggers at the *join* point, not the re-engagement point.

### Smart Rewrite skips a self-contained message

1. User in a chat with prior history picks `@new-agent` from the `@` popup and types a message that already spells out its own context — e.g. *"Send a reminder email to client@example.com about the Friday meeting at 3pm"*.
2. User presses Enter. The composer enters its "rewriting…" state and the rewrite LLM is invoked exactly as in the regular flow.
3. The LLM judges the message already self-contained and emits the keep-original sentinel.
4. The service detects the sentinel and returns `null` to the renderer. The composer dispatches the user's original text to `@new-agent` immediately — no second-Enter confirmation, no hint line, no composer-text replacement.
5. The user bubble appears in the transcript with the original text. `original_text` / `rewritten_text` stay null (same shape as a same-agent follow-up).
6. From the user's perspective: the typical join-moment delay still happens (rewrite LLM round-trip), but no extra keypress is required.

### Editing the rewritten text

1. User presses Enter; rewrite completes and replaces composer text.
2. User notices the rewrite assumed the wrong email. They edit the rewritten text manually.
3. User presses Enter again. The edited version is sent (no re-rewrite).

### Rewrite failure

1. User presses Enter to engage a new agent. The rewrite LLM call fails (network, missing chat-mode credentials, or LLM error).
2. A modal dialog opens with the title *"Couldn't introduce `<agent name>`"*, a friendly explanation of what Smart Rewrite tries to do, a per-error-code line describing the specific cause, and a collapsible *Technical details* disclosure with the raw error message.
3. Three buttons: **Cancel** (dismiss, keep composer), **Disable Smart Rewrite** (sets the per-chat flag, dismisses), **Send anyway** (sends the user's original text to the target agent without rewrite).
4. If the user disables: the per-chat flag is set. From then on, `@-mentions` and active-agent switches route directly without rewrite. The user is responsible for writing self-contained prompts. Catch-up replay continues to work.
5. If the user sends anyway: the original text is sent. Smart-assist remains enabled for the next message.

### Receiving-agent failure

1. Rewrite succeeded; message was sent to `@erp-agent`. The agent errors or times out.
2. The error is rendered as a `role: 'error'` message in the transcript (same as existing LLM/agent error handling).
3. The transcript stays intact; the user can send another message — either retrying by `@-mention`-ing the agent again, or moving on.

### Bringing an agent into a regular (LLM) chat

1. User is in an LLM chat (no agent ever attached, root is the chat-mode LLM) with a few turns of history.
2. User picks `@erp-agent` from the `@` popup — same flow as bringing a second agent into an agent chat.
3. The root label for the switch-back button reads the chat mode's name (or `model` when no chat mode is set).

## Business Rules

### Rewrite triggering

- Rewrite fires when: the target agent is non-root AND the chat already has at least one user/assistant message AND that agent has not yet participated in this chat (no entry in `chat_agent_sessions` for the pair). This is the agent's *join* moment.
- Even when triggered, the rewrite LLM may short-circuit by emitting the keep-original sentinel — the composer then dispatches the original text immediately, skipping the double-send confirmation. The pre-flight (catch-up build + active-agent flip + persistence) still runs identically; only the confirmation UX is skipped. From the persistence layer's perspective this looks the same as routing without rewrite: `original_text` / `rewritten_text` are not populated.
- Rewrite does NOT fire on:
  - The first message in a brand-new chat (no prior history to incorporate).
  - Same-agent follow-ups (the agent's cursor already exists).
  - Re-engagement of an agent that participated before — catch-up replay covers it instead.
  - "Switch back" to the root counterparty.
  - CLI command sends (`/run:<slug>` — see [CLI Commands](../cli_commands/cli_commands.md)). The invocation has a rigid syntax the backend parses literally; rewriting it into natural language would destroy it.
- Per-chat smart-assist disable bypasses rewrite entirely.

### Routing precedence

- Selecting an agent from the popup switches the chat's `active_agent_id` immediately (separate from sending a message).
- On send: an explicit leading `@<slug>` in the composer text is a per-send override (power-user). With no leading mention, the message routes to the current active agent. If there's no active agent (LLM chat with `active_agent_id = null`), the message routes to the LLM root.
- Mentioning or switching to the chat's bound root agent is a "switch back" — uses the agent channel for agent chats, the LLM channel for LLM chats.

### Catch-up replay

- Catch-up is built per (chat, agent) using a cursor stored in `chat_agent_sessions.last_replayed_message_id`. The cursor points to the most recent user message routed to that agent.
- First engagement: cursor does not exist → empty packet (rewrite carries the context).
- Subsequent engagements: walk messages from the row after the cursor forward; include only user/assistant rows; cap by a sliding window (currently 20 turns); format as a literal transcript.
- After each successful send to an agent, the cursor advances to the just-persisted user message.
- The catch-up build is rendered server-side (`buildCatchupPacket`) and prepended to the user content on the wire — not persisted as a separate row, not visible in the transcript.
- **CLI commands bypass catch-up.** `/run:<slug>` invocations are literal strings the agent backend interprets server-side without an LLM turn (see [CLI Commands](../cli_commands/cli_commands.md)). Prepending a catch-up transcript would shift the invocation off the start of the wire content and break the backend's `/run:*` detection — so the composer skips the catch-up build entirely when the user message is a CLI command. The (chat, agent) cursor still advances so the next non-CLI engagement picks up the right window.

### Bubble display and persistence

- A user bubble shows the text the user actually confirmed via the second Enter — the rewritten text when rewrite fired, the original when it didn't.
- The original (pre-rewrite) text is preserved in `messages.original_text` even when not displayed.
- An assistant bubble shows the agent's name as a small color-coded label above the content when the turn came from a non-root agent. Color is derived from a hash of the agent id so the same agent reads in the same color across all of its bubbles in the chat.

### Active-agent state surface (UI)

- Two affordances live below the textarea:
  1. **Active-agent chip** — `🤖 <agent name>` for the current routing target. Shown whenever the chat has any active agent (root or otherwise).
  2. **Switch-back button** — text + ↺ icon, "Switch back to `<root label>`", rendered next to the chip *only* when the active agent isn't the root.
- There is no participation strip. Routing state lives entirely on the chip + switch-back button above the input. (Earlier builds also dropped *routing* transition rows from the transcript; only agent-side system notices — `cinna.content_kind: 'notice'` parts persisted as `agent_transition` rows, e.g. "Starting up the agent environment…" — appear inline now, rendered as muted system messages. See [A2A Streaming Pipeline](../../agents/agents/streaming_pipeline.md).)

### Smart-assist disable

- Disables only the rewrite step. Routing, sticky-active-agent, the chip, the switch-back button, and catch-up replay all continue working.
- Set per-chat after a rewrite failure if the user opts in via the modal. Manual re-enable is out of scope for the first ship — disable is one-way for now.

### Concurrency

- The composer is not locked while a previous turn is streaming. If the user sends to a different agent mid-stream, both turns run in parallel. The user accepts the risk of out-of-order turns; the system does not attempt to serialize them.

### Failure modes

- Rewrite failure → modal dialog with Send anyway / Disable Smart Rewrite / Cancel.
- Receiving-agent failure → standard `role: 'error'` message in the transcript; chat stays intact.
- Catch-up build failure → fall back to sending the message without catch-up; the agent will see only its own A2A session state.

## Architecture Overview

```
User types '@' in active chat
  -> Popup shows enabled agents
  -> Select agent
       -> composer.switchActiveAgent(agentId)
       -> multiAgent:set-active-agent (optimistic cache update)
       -> Chat row's active_agent_id flips; chip in ChatInput updates immediately

User types message, presses Enter
  -> ChatInput.handleSend
       -> composer.submit(text)
            (reads chat + agents snapshot from React Query cache at call time)
            (parses optional power-user @slug override)
            (resolves target agent: mention || activeAgent)
            (decides root vs agent channel)
            (decides whether Smart Rewrite is needed)
            -> If rewrite needed:
                 -> multiAgent:rewrite  (aiFunctions.runSingleShot)
                 -> LLM emits keep-original sentinel? -> service returns null
                      -> Composer dispatches original immediately (skip 2nd Enter)
                 -> Else returns rewritten text
                      -> Composer enters 'confirming' state, awaits 2nd Enter
            -> Else: dispatch directly

Dispatch (composer.confirmRewrite or direct):
  -> multiAgent:build-catchup (empty on first engagement)
  -> multiAgent:set-active-agent if not already active
  -> agent:send-message { agentId, chatId, content, rewrittenText?, originalText?, catchupPacket? }
     OR
     llm:send-message   { chatId, content, catchupPacket? }
  -> messageRoutingService.prepareAgentSend / prepareLlmSend
     (single chokepoint: persists user message with addressed_agent_id /
      rewritten_text / original_text, assembles wireContent, advances the
      chat_agent_sessions cursor for the agent path)
  -> a2aStreamingService.streamToAgent  OR  chatStreamingService.stream
  -> Stream events back via MessagePort
```

## Integration Points

- [Messaging](../messaging/messaging.md) — Routing tap-in: `composer.submit()` picks between the LLM and agent channels and threads catchup/rewrite metadata through. The LLM stream loop excludes `agent_transition` rows (agent-side system notices) when rebuilding history.
- [Agents](../../agents/agents/agents.md) — Sub-agent invocations reuse the A2A client and `a2a_sessions` table. Each (chat, agent) pair has its own A2A session; the catch-up packet is sent as part of the user message text on re-engagement.
- [Chat Modes](../chat_modes/chat_modes.md) — Provides the LLM credentials used by the rewrite step. Resolution order: chat's own chat mode, then the user's default chat mode, then (LLM chats) the chat's own bound provider/model.
- [Mention Popups](../mention_popups/mention_popups.md) — Reused for the in-chat `@-mention` popup. The popup is now available in active chats as well as new chats; selection in active chats fires the immediate-switch action instead of binding an agent to a new chat.
- [Conversation UI](../conversation_ui/conversation_ui.md) — New agent label/coloring on assistant bubbles.
- [AI Functions](../../llm/ai_functions/ai_functions.md) — Smart Rewrite is built on the generic `aiFunctions.runSingleShot` primitive; future features (chat-title generation, chat summaries) compose the same primitive.
