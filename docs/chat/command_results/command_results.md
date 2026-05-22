# Command Results

## Purpose

Renders the synchronous output of a platform slash-command (`/files`, `/agent-status`, `/session-recover`, `/rebuild-env`, future `/run:<name>` variants, …) as a terminal-style block inline in the conversation. The command result IS the assistant turn for that user message — the LLM/agent stream did not run — so it persists like an answer and shows up in chat previews, but renders distinctly enough that the user can tell they're looking at platform output, not an LLM voice.

## Core Concepts

- **Command result** — A2A TextPart with `metadata['cinna.content_kind'] = 'command_result'`. Produced by the Cinna platform's slash-command executor, not the LLM. One event per `SendStreamingMessage` call: `status.state = "completed"`, `status.final = true`. The stream ends with this event — no assistant/tool/done frames follow.
- **Slash-command turn** — A user message whose wire content matches a platform slash command. The platform handles it synchronously and replies with a single command_result TextPart; the agent stream never starts. The desktop sends the message via the normal A2A path and sees the result come back through the same stream pipeline as any other agent response.
- **Command output block** — `CommandResultBlock` renders the part: bordered card, `Terminal` icon, "Command output" header, markdown-rendered body (so `/files`' file list and `/agent-status`' markdown report read naturally). Default-expanded inline; body caps at 60vh and scrolls.
- **Terminal vs. tool result** — Distinct from a `tool_result`-kind part. `tool_result` is stdout/stderr emitted during a tool invocation while the agent is reasoning (paired to a `tool` part via `cinna.tool_id`, rendered in a collapsible monospace card). `command_result` is the entire reply to a slash-command turn — no companion `tool` part, no LLM activity, terminal stream state.

## User Stories / Flows

1. User types a platform slash-command (e.g. `/files`) in the chat input and sends
2. Desktop sends the message to the agent via the normal A2A pipeline
3. Platform recognises the slash-command and bypasses the LLM — synchronously runs the command and emits one `status-update` event with `state: "completed"`, `final: true`, and a single `command_result`-kind TextPart carrying the output
4. Desktop's stream accumulator routes the part into the assistant message's `parts[]` (not into a `notice` row or a `tool_result` block)
5. `CommandResultBlock` renders inline beneath the user bubble — bordered card with `Terminal` icon, "Command output" header, markdown body
6. The stream terminates with no further frames; persistence runs the same path as a normal agent reply (assistant row, `parts: [{kind: 'command_result', text: …}]`, `content` set so chat previews/titles/search work)
7. On reload the same `CommandResultBlock` renders from the persisted `parts[]` — survives indefinitely as conversation history

## Business Rules

### Wire detection

- A `command_result` part is recognised solely by `metadata['cinna.content_kind'] === 'command_result'`. No other heuristic is applied — non-Cinna A2A servers that don't set the metadata never trigger this rendering.
- Status hints from the surrounding `status-update` (`state: "completed"`, `final: true`) are informational and not required by the desktop — the per-part metadata is the authoritative discriminator. The detection priority recommended by the cinna-core contract (`state` first, then `content_kind`) is satisfied implicitly: when state is `completed && final` and the part carries `command_result`, the renderer treats it as platform output; without the metadata it falls back to the existing "end-of-agent-turn" path.

### Persistence

- Each `command_result` delta joins the assistant message's `parts[]` like a `text` part. Consecutive `command_result` deltas merge into a single part (same kind, no tool-id discriminator).
- The accumulator also concatenates `command_result` deltas into `answerText()` so `messages.content` is non-empty after the turn. This is what feeds chat-list snippets, [Auto Chat Titles](../auto_titles/auto_titles.md), and full-text search — a slash-command turn shows up the same way as any other answer in the sidebar.
- No new `messages.role` or new column — command_result lives inside the existing `assistant` row's `parts[]`.

### Rendering

- `CommandResultBlock` is default-expanded — the command output IS the answer, not auxiliary narration. It is not part of the [Conversation UI](../conversation_ui/conversation_ui.md) "lightweight collapsible" pattern used for thinking/tool blocks.
- The body is rendered through the same `react-markdown` + `remark-gfm` + `rehype-highlight` + `markdownComponents` stack as `MessageBubble`, so markdown structure (lists, headers, code, tables) in `/files` / `/agent-status` output reads naturally.
- The body caps at `max-h-[60vh]` and scrolls — a `/files` result in a large repo doesn't push the rest of the transcript off-screen.
- Visual contract: bordered card + `Terminal` icon + "Command output" header. Distinct enough from a normal assistant bubble that the user knows it's platform output, not LLM voice; subtle enough that it doesn't dominate the conversation.

### Verbose mode

- Verbose mode does not change `CommandResultBlock` rendering — the block is already inline and not collapsible.
- The per-message `MessageMetaFooter` (timestamps / meta popup) still wraps the parts list when verbose mode is on, same as any other assistant row.

### Backward compatibility

- Pre-existing assistant messages with no `parts` (or with `parts` lacking `command_result`) are unaffected — the legacy `MessageBubble` path still handles them via `messages.content`.
- A2A servers that don't emit `cinna.content_kind` continue to produce `text`-kind parts and render as normal assistant bubbles — the new rendering is dormant until the server marks the part.
- Unknown future content kinds fall back to plain `text` rendering (same compatibility guarantee as the rest of the streaming pipeline).

## Architecture Overview

```
Cinna platform slash-command executor
  └─ A2A status-update event (state=completed, final=true)
       └─ TextPart with cinna.content_kind=command_result
           ↓
Main: StreamPartsAccumulator.ingest()
  ├─ command_result parts → parts[] (merge on kind)
  ├─ contribute to answerText() → messages.content
  └─ port.postMessage({type:'delta', kind:'command_result', text})
       ↓
Renderer:
  useChatStream.handleAgent → chat.store.appendDelta(text, 'command_result')
    └─ streamingBlocks: TextBlock{ kind:'command_result' }
         ↓
  MessageStream → CommandResultBlock (live, default-expanded, scrollable body)

Stream completes:
  Main: messageRepo.saveAssistant({ chatId, content: answerText, parts })
       ↓
  Renderer: 'done' → invalidate ['chat', chatId] → clearStreamingBlocks
    └─ MessageStream renders persisted command_result part via CommandResultBlock
```

## Integration Points

- [A2A Streaming Pipeline](../../agents/agents/streaming_pipeline.md) — Owns the `cinna.content_kind` metadata contract, the accumulator merge rules, and the structured `parts[]` shape that command_result joins.
- [CLI Commands](../cli_commands/cli_commands.md) — The send-side companion: `/` picker that surfaces an agent's `cinna.run.*` skills and inserts `/run:<slug>` invocations into the composer. The desktop dispatches them unchanged; the backend may reply with either `command_result` (synchronous, agent stream never runs) or `tool_result` (when a `/run:<name>` actually executes a shell command inside the agent's session) depending on the command kind.
- [Conversation UI](../conversation_ui/conversation_ui.md) — Hosts the visual hierarchy that `CommandResultBlock` slots into; documents how it differs from the `MessageBubble` / `ThinkingBlock` / `ToolResultBlock` treatments.
- [Auto Chat Titles](../auto_titles/auto_titles.md) — Consumes `messages.content` for the title-generation seed; command_result turns title naturally because their text is included in `answerText()`.
- [Agent Notices](../agent_notices/agent_notices.md) — Sibling content-kind branch on the same pipeline. Notices ALSO bypass the LLM but persist into a separate `agent_transition` row and render as a collapsed dot; command_results persist into the assistant message itself and render as an inline terminal block.
