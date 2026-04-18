# A2A Streaming Pipeline

## Purpose

How A2A streaming events from a remote agent become structured, kind-routed message parts in the UI and DB. Focused on the per-part delta computation, the `cinna.content_kind` / `cinna.tool_name` metadata contract with the Cinna backend, and the persisted `parts[]` shape.

## Core Concepts

| Term | Definition |
|------|-----------|
| **TextPart** | A2A protocol text fragment inside a `Message` or `Artifact`. May carry arbitrary `metadata` |
| **Content Kind** | Value of `metadata['cinna.content_kind']` on a TextPart: `'text'`, `'thinking'`, or `'tool'`. Defaults to `'text'` when absent |
| **Tool Name** | Value of `metadata['cinna.tool_name']` on a `tool`-kind part — names the tool the agent is narrating about |
| **Per-part delta** | The new substring appended to a TextPart since the last seen snapshot of that part. Keyed by `(messageId, partIndex)` |
| **Structured parts** | `MessagePart[]` — flat in-order list of `{ kind, text, toolName? }` entries persisted on the assistant message row |
| **Answer text** | Concatenation of `text`-kind parts only — stored in `messages.content` for previews/search/title generation |

## Cinna Metadata Contract (with the backend)

The Cinna backend (`a2a_event_mapper.py`) tags every emitted A2A `TextPart` with metadata that the desktop client uses to route and render the fragment. This is a Cinna-specific convention layered on top of the standard A2A protocol.

| Metadata key | Type | When set | Purpose |
|--------------|------|----------|---------|
| `cinna.content_kind` | `'text' \| 'thinking' \| 'tool'` | Every part | Tells client which block to render this fragment in |
| `cinna.tool_name` | string | Only on `tool`-kind parts | Names the tool being narrated about |

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
        toolName = (kind === 'tool') ? metadata['cinna.tool_name'] : undefined
        append to internal parts[] (merge with last only if same kind+toolName)
        port.postMessage({ type: 'delta', kind, text: delta, toolName })
  - Update latestContextId / latestTaskId / latestTaskState from the event
  - Forward `{ type: 'status', state, taskId, contextId }` to the renderer
  ↓
On stream completion:
  - parts = accumulator.snapshotParts()
  - answer = accumulator.answerText()    # concat of 'text'-kind parts
  - messageRepo.saveAssistant({ chatId, content: answer, parts })
  - a2aSessionRepo.upsert(...)
  - port.postMessage({ type: 'done' })
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
| `kind` | `ContentKind` | `'text' \| 'thinking' \| 'tool'` |
| `text` | string | The fragment to append (already a delta — renderer does not need to dedupe) |
| `toolName` | string \| undefined | Set only when `kind === 'tool'` |

## Persisted Shape (`messages.parts`)

Stored as JSON on the `messages` row:

```
[
  { "kind": "thinking", "text": "**Considering user request**\n\nI think..." },
  { "kind": "tool", "text": "Calling search...", "toolName": "web_search" },
  { "kind": "text", "text": "Here is the answer..." }
]
```

Renderer prefers `parts[]` when present; falls back to `messages.content` (the flat answer text) for legacy/LLM messages with no parts.

## Renderer Routing

For both live streaming blocks and persisted parts, the renderer routes by `kind`:

- `kind: 'text'` → `MessageBubble` (assistant role, full-width markdown, no border)
- `kind: 'thinking'` → `ThinkingBlock` (collapsible dimmed card with brain icon, italic markdown body)
- `kind: 'tool'` → `ToolNarrationBlock` (collapsible card with wrench icon + `Tool: <toolName>` header)

Streaming blocks merge consecutive deltas only when both `kind` AND `toolName` match — same merge rule as the main-process accumulator.

## File References

- Pipeline implementation: `src/main/agents/streamPartsAccumulator.ts`
- Shared types: `src/shared/messageParts.ts`
- IPC integration: `src/main/ipc/agent_a2a.ipc.ts:registerA2AHandlers` <!-- nocheck -->
- Persistence: `src/main/db/messages.ts:messageRepo.saveAssistant` <!-- nocheck -->
- DB column: `src/main/db/migrations/messages.ts` (`parts` JSON column)
- Renderer store: `src/renderer/src/stores/chat.store.ts:appendDelta` <!-- nocheck -->
- Renderer hook: `src/renderer/src/hooks/useChatStream.ts:handleAgent` <!-- nocheck -->
- Renderer routing: `src/renderer/src/components/chat/MessageStream.tsx`
- Block components: `src/renderer/src/components/chat/ThinkingBlock.tsx`, `src/renderer/src/components/chat/ToolNarrationBlock.tsx`

## Backward Compatibility

- Messages with no `parts` (LLM chats, pre-existing agent chats) render via the existing `MessageBubble` path using `content`
- A2A servers that don't set `cinna.content_kind` get `kind: 'text'` for every part — identical to pre-pipeline behavior
- The `content` column is still populated with the concatenated answer text, so chat previews, titles, and search work unchanged

## Integration Points

- [Agents](agents.md) — Owns the broader A2A integration; this doc is its streaming-pipeline aspect
- [Conversation UI](../../chat/conversation_ui/conversation_ui.md) — Visual treatment of `thinking` and `tool` blocks
- [Messaging](../../chat/messaging/messaging.md) — Underlying streaming infrastructure (MessagePort, `chat.store`)
