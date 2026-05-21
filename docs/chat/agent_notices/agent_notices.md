# Agent Notices

## Purpose

Renders agent-side system messages — startup pings, environment transitions, and other status-style updates the agent itself emits during a turn — as muted system messages inside the chat transcript, distinct from the agent's actual answer bubbles. Notices are excluded from catch-up replay and from the LLM history rebuild so they never feed back into the model.

## Core Concepts

- **Notice** — A TextPart sent by a Cinna agent with `metadata['cinna.content_kind'] = 'notice'`. Unlike `text` / `thinking` / `tool` / `tool_result` parts, notices do NOT join the assistant message's `parts[]` — they land on their own `agent_transition` row.
- **`agent_transition` row** — A `messages.role` value reserved for agent-emitted system notices. Excluded by role from the LLM history rebuild and from the catch-up packet builder.
- **Streaming notice block** — The live counterpart of an `agent_transition` row. While a stream is in flight, notice deltas flow into `chat.store.streamingBlocks` as `text`-type blocks with `kind: 'notice'` and render as muted system messages. Once the stream completes and the chat re-fetches, the streaming block is cleared and the persisted `agent_transition` row takes its place — no visual gap.
- **Notice persistence ordering** — Each unique `(messageId | artifactId, partIndex)` produces one persisted notice row. Notices are saved before the assistant message they preceded on the wire, so transcript order matches stream order.

## User Stories / Flows

1. User sends a message to a Cinna agent that needs to spin up an execution environment
2. Agent immediately emits a notice TextPart: "Starting up the agent environment, this may take a moment…"
3. Desktop streams the notice live as a muted system message centred between the user bubble and the (yet-to-arrive) answer
4. Agent finishes startup and streams the actual answer as ordinary `text`-kind parts
5. Stream completes — desktop persists the notice as an `agent_transition` row, then the assistant message as a normal `assistant` row
6. On reload (and after the post-stream cache refetch), the user sees the same muted system message above the agent's answer, identical to the live view
7. If the user later sends another message to the same agent, the catch-up packet built for that agent does **not** include the prior notice — only user/assistant turns count

## Business Rules

### Wire format

- Notices are recognised by `metadata['cinna.content_kind'] === 'notice'` on an A2A TextPart. No other signal is used — non-Cinna agents that don't set the metadata never trigger notice routing.
- A notice part may stream as deltas like any other part; per-`(messageId|artifactId, partIndex)` keying handles both chunk-style and snapshot-style emissions.
- Notices may appear at any point in the stream; they are persisted in arrival order. The common case is a single notice emitted before the answer begins.

### Persistence

- Each distinct notice part becomes one `agent_transition` row. Two notice parts in the same stream produce two rows, in the order they were first seen.
- Notice rows carry `source_agent_id` (the agent that emitted them) so the transcript can attribute them if needed; they do not carry `parts[]`.
- Notices are persisted **before** the assistant message of the same turn so `sort_order` matches wire chronology.

### Exclusion from agent inputs

- The catch-up replay packet built when the user re-engages an agent (`multiAgentService.buildCatchupPacket`) walks user/assistant rows only. `agent_transition` rows are skipped — the agent never re-receives its own startup ping as part of a replay window.
- The LLM history rebuild (`chatStreamingService._runStreamLoop`) skips `agent_transition` rows for the same reason. An LLM chat that previously was an agent chat will never see notice text in its conversation history.
- The `(chat, agent)` catch-up cursor still advances past notice rows naturally because the cursor tracks the latest user message, not assistant turns.

### Rendering

- Notices render via the `SystemMessage` component with `tone="notice"`: centred pill, muted border, `Info` icon, `--color-text-muted` text. Visually distinct from the danger-styled error system message (`tone="error"`) used for `role: 'error'` rows.
- Streaming and persisted notices share the same component — there is no UX seam between the live view and the post-refetch view.
- Notices are not collapsible and do not participate in the `CollapsibleGroup` run-merging used for `thinking` / `tool` / `tool_result` parts.

### Verbose mode

- Verbose mode does not change notice rendering — notices are always shown, never gated.
- Notice rows do not carry a `MessageMetaFooter` (no timestamp / kind label) because they are not authored content.

### Legacy compatibility

- Earlier builds reserved `role: 'agent_transition'` but never wrote it. Any legacy rows that survived in user DBs from that period will now render with the same muted-system-message treatment.
- Agents that don't tag with `cinna.content_kind: 'notice'` continue to produce normal `text` parts on the assistant message — there is no heuristic fallback that promotes plain text to a notice.

## Architecture Overview

```
Cinna agent → A2A TextPart with cinna.content_kind=notice
  └─ Main: StreamPartsAccumulator.ingest()
       ├─ notice parts → notices Map (NOT parts[] / answer)
       └─ port.postMessage({type:'delta', kind:'notice', text})
            ↓
Renderer:
  useChatStream.handleAgent → chat.store.appendDelta(text, 'notice')
    └─ streamingBlocks: TextBlock{ kind:'notice' }
         ↓
  MessageStream → SystemMessage tone='notice' (live)

Stream completes:
  Main: a2aStreamingService.streamToAgent
    ├─ for each notice → messageRepo.saveTransition()  (role='agent_transition')
    └─ messageRepo.saveAssistant() for the actual answer
         ↓
  Renderer: 'done' → invalidate ['chat', chatId] → clearStreamingBlocks
    └─ MessageStream renders agent_transition row via SystemMessage tone='notice' (persisted)
```

## Integration Points

- [A2A Streaming Pipeline](../../agents/agents/streaming_pipeline.md) — Owns the `cinna.content_kind` metadata contract, the per-part delta keying, and the accumulator that separates notices from message parts.
- [Messaging](../messaging/messaging.md) — Defines the `messages` table that backs `agent_transition` rows.
- [Multi-Agent Chats](../multi_agent/multi_agent.md) — Catch-up replay excludes `agent_transition` rows so notices from one engagement do not leak into the next.
- [Conversation UI](../conversation_ui/conversation_ui.md) — Hosts the `SystemMessage` component (`tone="error"` for `role: 'error'` rows, `tone="notice"` for `agent_transition` rows) and the surrounding transcript renderer.
- [CLI Commands](../cli_commands/cli_commands.md) — Notices commonly precede `/run:*` CLI command output when the agent is bootstrapping its environment before executing the shell command.
