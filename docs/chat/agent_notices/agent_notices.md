# Agent Notices

## Purpose

Renders agent-side system messages — startup pings, environment transitions, and other status-style updates the agent itself emits during a turn — as muted system messages inside the chat transcript, distinct from the agent's actual answer bubbles. Notices are excluded from catch-up replay and from the LLM history rebuild so they never feed back into the model.

## Core Concepts

- **Notice** — A TextPart sent by a Cinna agent with `metadata['cinna.content_kind'] = 'notice'`. Unlike `text` / `thinking` / `tool` / `tool_result` parts, notices do NOT join the assistant message's `parts[]` — they land on their own `agent_transition` row.
- **`agent_transition` row** — A `messages.role` value reserved for agent-emitted system notices. Excluded by role from the LLM history rebuild and from the catch-up packet builder.
- **Streaming notice block** — The live counterpart of an `agent_transition` row. While a stream is in flight, notice deltas flow into `chat.store.streamingBlocks` as `text`-type blocks with `kind: 'notice'` and render as the expanded muted system-message pill. Once the stream completes and the chat re-fetches, the streaming block is cleared and the persisted `agent_transition` row takes its place — rendered by `NoticeBlock` as a collapsed accent-coloured dot (expand on click).
- **Collapsed dot** — The persisted-notice visual: a single small accent-coloured dot centred in the transcript. Clicking it expands to the original notice text in a muted system-message pill (same look as the live streaming view). The dot exists so the notice survives reload for inspection without permanently consuming vertical space, since after the in-flight ping has served its purpose the user mostly wants their answer to be the visible content.
- **Notice persistence ordering** — Each unique `(messageId | artifactId, partIndex)` produces one persisted notice row. Notices are saved before the assistant message they preceded on the wire, so transcript order matches stream order.

## User Stories / Flows

1. User sends a message to a Cinna agent that needs to spin up an execution environment
2. Agent immediately emits a notice TextPart: "Starting up the agent environment, this may take a moment…"
3. Desktop streams the notice live as a muted system message centred between the user bubble and the (yet-to-arrive) answer — the user can see exactly why the answer is taking time
4. Agent finishes startup and streams the actual answer as ordinary `text`-kind parts
5. Stream completes — desktop persists the notice as an `agent_transition` row, then the assistant message as a normal `assistant` row
6. The post-stream cache refetch swaps the live notice for the persisted row. The persisted row renders as a small accent-coloured dot above the answer — the notice has done its job, so it stops eating transcript space
7. On reload the user sees the same dot above the agent's answer. Clicking it expands to the original notice text (same muted system-message pill as the live view) so the context is never lost
8. If the user later sends another message to the same agent, the catch-up packet built for that agent does **not** include the prior notice — only user/assistant turns count

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

- Live (streaming) notices render via the `SystemMessage` component with `tone="notice"`: centred pill, muted border, `Info` icon, `--color-text-muted` text. Visually distinct from the danger-styled error system message (`tone="error"`) used for `role: 'error'` rows.
- Persisted (post-stream) notices render via `NoticeBlock`: a small centred info-toned dot (`--color-severity-info` at 70% opacity, brightens on hover — blue in both light and dark themes) that expands on click into the same muted system-message pill the live view used. Hovering the collapsed dot exposes a 120-char preview via the native `title` attribute; the click affordance owns the full read.
- The swap from streaming pill to collapsed dot happens when the chat detail query invalidates after stream `done` — `clearStreamingBlocks()` removes the live block on the next frame, and the now-saved `agent_transition` row renders via `NoticeBlock`.
- Notices do not participate in the `CollapsibleGroup` run-merging used for `thinking` / `tool` / `tool_result` parts; each notice owns its own dot so the user can disambiguate individual notices when there are multiple in a turn.

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
    └─ MessageStream renders agent_transition row via NoticeBlock
        (collapsed accent-dot by default; click expands to muted pill)
```

## Integration Points

- [A2A Streaming Pipeline](../../agents/agents/streaming_pipeline.md) — Owns the `cinna.content_kind` metadata contract, the per-part delta keying, and the accumulator that separates notices from message parts.
- [Messaging](../messaging/messaging.md) — Defines the `messages` table that backs `agent_transition` rows.
- [Multi-Agent Chats](../multi_agent/multi_agent.md) — Catch-up replay excludes `agent_transition` rows so notices from one engagement do not leak into the next.
- [Conversation UI](../conversation_ui/conversation_ui.md) — Hosts the `SystemMessage` component (`tone="error"` for `role: 'error'` rows, `tone="notice"` for `agent_transition` rows) and the surrounding transcript renderer.
- [CLI Commands](../cli_commands/cli_commands.md) — Notices commonly precede `/run:*` CLI command output when the agent is bootstrapping its environment before executing the shell command.
