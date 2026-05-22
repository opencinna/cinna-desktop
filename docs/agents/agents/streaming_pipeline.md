# A2A Streaming Pipeline

## Purpose

How A2A streaming events from a remote agent become structured, kind-routed message parts in the UI and DB. Focused on the per-part delta computation, the `cinna.content_kind` / `cinna.tool_name` / `cinna.tool_input` metadata contract with the Cinna backend, and the persisted `parts[]` shape.

## Core Concepts

| Term | Definition |
|------|-----------|
| **TextPart** | A2A protocol text fragment inside a `Message` or `Artifact`. May carry arbitrary `metadata` |
| **Content Kind** | Value of `metadata['cinna.content_kind']` on a TextPart: `'text'`, `'thinking'`, `'tool'`, `'tool_result'`, `'notice'`, or `'command_result'`. Defaults to `'text'` when absent (and when an unknown future kind arrives, for forward compatibility) |
| **Notice** | A `'notice'`-kind TextPart — an agent-side system message (e.g. the startup ping "Starting up the agent environment, this may take a moment…"). Never persisted as part of the assistant message — the streaming service saves each notice as its own `role: 'agent_transition'` row so it renders as a muted system message and is excluded from catch-up replay + LLM history rebuilds |
| **Command Result** | A `'command_result'`-kind TextPart — the synchronous output of a platform slash-command (`/files`, `/agent-status`, `/run:<name>`, …). Source is the platform's slash-command executor, not the LLM; the agent stream did not run. Joins the assistant message's `parts[]` and contributes to `answerText()` (chat preview / title / search source) because it IS the substantive answer for that turn. Rendered in a terminal-style block to signal "platform output, not LLM voice" |
| **Tool Name** | Value of `metadata['cinna.tool_name']` on a `tool`-kind part — names the tool the agent is narrating about |
| **Tool Input** | Value of `metadata['cinna.tool_input']` on a `tool`-kind part — structured arguments object (e.g. `{ command: "ls -la" }` for Bash). Used by `ToolNarrationBlock` to render the inline `<ToolCallSummary>` header in verbose mode |
| **Tool ID** | Value of `metadata['cinna.tool_id']` — pairing key set on `'tool'` parts (identifies the call) and on `'tool_result'` parts (matches them back to the originating call). For CLI commands this is the backend `exec_id`; for LLM tools it is the provider tool-call id |
| **Tool Stream** | Value of `metadata['cinna.tool_stream']` on `'tool_result'` parts: `'stdout'` or `'stderr'`. Defaults to `'stdout'` when absent — unknown values are coerced server-side |
| **Per-part delta** | The new substring appended to a TextPart since the last seen snapshot of that part. Keyed by `(messageId, partIndex)` |
| **Structured parts** | `MessagePart[]` — flat in-order list of `{ kind, text, toolName?, toolInput?, toolId?, toolStream? }` entries persisted on the assistant message row |
| **Answer text** | Concatenation of `text`-kind parts only — stored in `messages.content` for previews/search/title generation |

## Cinna Metadata Contract (with the backend)

The Cinna backend (`a2a_event_mapper.py`) tags every emitted A2A `TextPart` with metadata that the desktop client uses to route and render the fragment. This is a Cinna-specific convention layered on top of the standard A2A protocol.

| Metadata key | Type | When set | Purpose |
|--------------|------|----------|---------|
| `cinna.content_kind` | `'text' \| 'thinking' \| 'tool' \| 'tool_result' \| 'notice' \| 'command_result'` | Every part | Tells client which block to render this fragment in. `'notice'` parts are routed to a separate `agent_transition` row instead of joining the assistant message. `'command_result'` parts join the assistant message's `parts[]` (the agent stream did not run — the command output IS the answer) and render in a terminal-style block. Unknown future kinds fall back to plain `text` rendering |
| `cinna.tool_name` | string | Only on `tool`-kind parts | Names the tool being narrated about |
| `cinna.tool_input` | object | Optional, only on `tool`-kind parts | Structured arguments for the tool call (e.g. `{ command, description }` for Bash). When present, the renderer can show a compact `<ToolCallSummary>` inline header in verbose mode and a structured argument block in the expanded body |
| `cinna.tool_id` | string | On `tool` and `tool_result` parts | Pairing key: same value on a `tool` part and every `tool_result` chunk that belongs to it. Backend uses `exec_id` for CLI commands and the provider tool-call id for LLM tools |
| `cinna.tool_stream` | `'stdout' \| 'stderr'` | Only on `tool_result` parts | Stream label for command output. Renderer styles `stderr` chunks in danger color. Unknown/absent values default to `'stdout'` (backend coerces server-side) |
| `cinna.command_invocation` | string | Always on `command_result`; on `tool` / `tool_result` only when the pair was synthesized to wrap a `/run:*` execution | Verbatim slash invocation (`/files`, `/agent-status`, `/run:rotate_status`, …). Marks the part as originating from a cinna-core slash command (absent → LLM-initiated tool call). Renderer wraps the affected blocks in a "Command: <invocation>" frame so both flows (synchronous `command_result` and tool-pair `/run:*`) read as a single slash-command UI. See [Command Results](../../chat/command_results/command_results.md) |

When metadata is absent (non-Cinna A2A servers), parts default to `kind: 'text'` — backward-compatible plain rendering.

The same convention applies to history replay: the backend expands a single `SessionMessage` into N TextParts (one per persisted streaming event), each carrying its original metadata, so a client calling `getTask()` sees the same structured breakdown as a live stream.

## Streaming Flow

```
A2A SDK sendMessageStream() emits events
  ↓
For each event (status-update | artifact-update | message | task):
  - Extract message and/or artifacts
  - StreamPartsAccumulator.ingestMessage / ingestArtifact:
      For each TextPart in parts[]:
        key = `${idPrefix}:${partIndex}`              # idPrefix = msg:<id> | art:<id>
        prior = seenPartText.get(key) ?? ''
        delta = text.startsWith(prior) ? text.slice(prior.length) : text
        if no delta -> skip
        seenPartText.set(key, text)
        kind = metadata['cinna.content_kind'] ?? 'text'
        toolName   = (kind === 'tool')                                 ? metadata['cinna.tool_name']   : undefined
        toolInput  = (kind === 'tool')                                 ? metadata['cinna.tool_input']  : undefined
        toolId     = (kind === 'tool' || kind === 'tool_result')       ? metadata['cinna.tool_id']     : undefined
        toolStream = (kind === 'tool_result')                          ? metadata['cinna.tool_stream'] ?? 'stdout' : undefined
        commandInvocation = metadata['cinna.command_invocation']  # any kind; present iff cinna-core slash command
        append to internal parts[] (merge with last only if:
          - text/thinking/command_result: same kind
          - tool: same kind + toolName
          - tool_result: same kind + toolId + toolStream)
        port.postMessage({ type: 'delta', kind, text: delta, toolName, toolInput, toolId, toolStream, commandInvocation })
        if first time we see (toolName, toolInput) for this part -> opts.onToolCall({...})
  - Update latestContextId / latestTaskId / latestTaskState from the event
  - Forward `{ type: 'status', state, taskId, contextId }` to the renderer
  ↓
On stream completion:
  - parts   = accumulator.snapshotParts()
  - answer  = accumulator.answerText()    # concat of 'text'-kind parts
  - notices = accumulator.snapshotNotices()  # one entry per distinct notice part
  - For each notice: messageRepo.saveTransition({ chatId, content, sourceAgentId })
  - messageRepo.saveAssistant({ chatId, content: answer, parts })
  - a2aSessionRepo.upsert(...)
  - port.postMessage({ type: 'done' })

Notices are persisted *before* the assistant message so transcript ordering
matches the on-the-wire order — startup pings sit above the answer they
preceded. Notices never appear in `messages.parts[]`; they live on their own
`role: 'agent_transition'` rows.
```

## Why per-`(messageId, partIndex)` keying

A2A v0.3 servers may emit fragments two ways:
1. **Chunk style** — each event has a new `messageId` carrying just the new fragment (Cinna backend default)
2. **Snapshot style** — successive events reuse the same `messageId` with growing `text`

Keying the seen-text map by `(messageId, partIndex)` and computing `delta = text.slice(prior.length)` handles both cases identically. The `text.startsWith(prior)` guard falls back to "treat full text as new" if the snapshot ever shrinks/diverges (defensive).

## Delta Event Payload (over MessagePort)

| Field | Type | Notes |
|-------|------|-------|
| `type` | `'delta'` | Discriminator |
| `kind` | `ContentKind` | `'text' \| 'thinking' \| 'tool' \| 'tool_result'` |
| `text` | string | The fragment to append (already a delta — renderer does not need to dedupe) |
| `toolName` | string \| undefined | Set only when `kind === 'tool'` and `cinna.tool_name` was present |
| `toolInput` | object \| undefined | Set only when `kind === 'tool'` and `cinna.tool_input` was a plain object. Carried through `appendDelta` and merged onto the in-flight streaming block so `ToolNarrationBlock` can render the inline tool-call summary as soon as it arrives |
| `toolId` | string \| undefined | Pairing key from `cinna.tool_id`. Set on `tool` and `tool_result` deltas |
| `toolStream` | `'stdout' \| 'stderr' \| undefined` | Set only when `kind === 'tool_result'`. Defaulted to `'stdout'` if metadata was absent |
| `commandInvocation` | string \| undefined | Verbatim slash invocation from `cinna.command_invocation`. Always set for `kind: 'command_result'`; set on `kind: 'tool' \| 'tool_result'` only when the pair was synthesized to wrap a `/run:*` execution. Absent → LLM-initiated tool call |

For `kind: 'notice'` deltas, only `text` and `kind` are populated; all `tool*` fields are `undefined`. The renderer appends them as `notice` text blocks in `chat.store.streamingBlocks`, rendered as muted system messages. After the stream completes they're persisted as `role: 'agent_transition'` rows and the streaming block is cleared.

## Persisted Shape (`messages.parts`)

Stored as JSON on the `messages` row:

```
[
  { "kind": "thinking", "text": "**Considering user request**\n\nI think..." },
  { "kind": "tool", "text": "Calling search...", "toolName": "web_search", "toolInput": { "query": "weather paris" }, "toolId": "exec_123" },
  { "kind": "tool_result", "text": "Found 3 results...", "toolId": "exec_123", "toolStream": "stdout" },
  { "kind": "text", "text": "Here is the answer..." }
]
```

For a slash-command turn (`/files`, `/run:check`, …) the entire assistant message is just the command output:

```
[
  { "kind": "command_result", "text": "- docs/\n- src/\n- package.json\n" }
]
```

`toolInput`, `toolId`, and `toolStream` are optional — older parts and any backend that doesn't emit the matching metadata simply omit the field. Pairing between a `tool` part and its `tool_result` part(s) is done by matching `toolId`; interleaved `stdout`/`stderr` chunks keep their chronology because the merge rule requires both `toolId` AND `toolStream` to match.

Renderer prefers `parts[]` when present; falls back to `messages.content` (the flat answer text) for legacy/LLM messages with no parts.

## Renderer Routing

For both live streaming blocks and persisted parts, the renderer routes by `kind`:

- `kind: 'text'` → `MessageBubble` (assistant role, full-width markdown, no border)
- `kind: 'thinking'` → `ThinkingBlock` (collapsible dimmed card with brain icon, italic markdown body)
- `kind: 'tool'` → `ToolNarrationBlock` (collapsible card with wrench icon). Header is `Tool: <toolName>` in compact mode; in verbose mode and when `toolInput` is present, the header renders an inline `<ToolCallSummary>` (`name(arg: value, …)`). Expanded body always shows the structured `<ToolCallSummary>` block when `toolInput` is present. See [Verbose Mode](../../ui/verbose_mode/verbose_mode.md) for the gating rules
- `kind: 'tool_result'` → `ToolResultBlock` (collapsible monospace card with terminal icon). Renders the raw stdout/stderr emitted by a tool execution; `stderr` chunks switch to danger-color styling. The block is shown immediately under its originating `tool` part — the in-order parts list places them adjacent naturally, no explicit lookup needed
- `kind: 'command_result'` → `CommandResultBlock` (bordered card with terminal icon and `Command output` header, markdown-rendered body). Default-expanded inline because it IS the assistant turn (the agent stream did not run), not auxiliary narration. Visually distinct from the assistant text bubble so the user can see they're looking at platform output, not an LLM voice
- `kind: 'notice'` → live during streaming via a `notice` block in `chat.store.streamingBlocks`, rendered through `NoticeBlock` with `live` (left-aligned `Info`+text row, no collapse). Persisted as a `role: 'agent_transition'` row that also renders through `NoticeBlock`, with `defaultExpanded={verboseMode}` — compact mode collapses to a small info-toned dot the user clicks to read; verbose mode keeps the row expanded inline. Notices never appear in an assistant message's `parts[]`

Streaming blocks merge consecutive deltas with the same merge rule as the main-process accumulator: `text` / `thinking` / `command_result` merge by kind; `tool` adds `toolName`; `tool_result` requires both `toolId` AND `toolStream` to match.

## File References

- Pipeline implementation: `src/main/agents/streamPartsAccumulator.ts`
- Shared types: `src/shared/messageParts.ts`
- IPC integration: `src/main/ipc/agent_a2a.ipc.ts:registerA2AHandlers` <!-- nocheck -->
- Persistence: `src/main/db/messages.ts:messageRepo.saveAssistant` <!-- nocheck -->, `src/main/db/messages.ts:messageRepo.saveTransition` <!-- nocheck -->
- DB column: `src/main/db/migrations/messages.ts` (`parts` JSON column)
- Renderer store: `src/renderer/src/stores/chat.store.ts:appendDelta` <!-- nocheck -->
- Renderer hook: `src/renderer/src/hooks/useChatStream.ts:handleAgent` <!-- nocheck -->
- Renderer routing: `src/renderer/src/components/chat/MessageStream.tsx`
- Block components: `src/renderer/src/components/chat/ThinkingBlock.tsx`, `src/renderer/src/components/chat/ToolNarrationBlock.tsx`, `src/renderer/src/components/chat/ToolResultBlock.tsx`, `src/renderer/src/components/chat/CommandResultBlock.tsx`, `src/renderer/src/components/chat/NoticeBlock.tsx`. Both live and persisted notices route through `NoticeBlock` (live: forced-expanded row; persisted: collapsed dot or expanded row per verbose mode)

## Backward Compatibility

- Messages with no `parts` (LLM chats, pre-existing agent chats) render via the existing `MessageBubble` path using `content`
- A2A servers that don't set `cinna.content_kind` get `kind: 'text'` for every part — identical to pre-pipeline behavior
- The `content` column is still populated with the concatenated answer text, so chat previews, titles, and search work unchanged
- Older persisted assistant messages may have `tool` parts without `toolId` — pairing degrades gracefully (each `tool_result` renders on its own; orphaned `tool_result` parts also render in place without crashing)

## Integration Points

- [Agents](agents.md) — Owns the broader A2A integration; this doc is its streaming-pipeline aspect
- [Conversation UI](../../chat/conversation_ui/conversation_ui.md) — Visual treatment of `thinking` and `tool` blocks
- [Messaging](../../chat/messaging/messaging.md) — Underlying streaming infrastructure (MessagePort, `chat.store`)
