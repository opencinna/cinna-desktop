# A2A Streaming Pipeline

## Purpose

How A2A streaming events from a remote agent become structured, kind-routed message parts in the UI and DB. Focused on the per-part delta computation, the `cinna.content_kind` / `cinna.tool_name` / `cinna.tool_input` metadata contract with the Cinna backend, and the persisted `parts[]` shape.

## Durable Input Requests

A2A status-update, streamed task and nonstreaming task responses all emit normalized status and input-request events. An input-required response with no text becomes **What should the agent do next?**; auth-required uses its status text or the existing sign-in fallback. The main executor observes these before optional renderer forwarding and the Inbox stores a durable next-message occurrence separately from transcript parts. Normal turn completion and restart preserve it. Answering starts a new message on the same A2A task/context; it does not attempt to reply to a vanished park. See [Inbox continuation](../../jobs/tasks/inbox.md#durable-continuation-and-refusal).

## Desktop Live Attachment

The main executor publishes these normalized events through the shared [live-run hub](../../chat/messaging/live_runs.md), independently of the original sender. Reopening a running agent chat hydrates retained output and then follows new events. The watch layer owns bounded replay, persisted-row deduplication and terminal transcript settlement; the A2A accumulator and session-checkpoint rules below remain transport-owned.

## Core Concepts

| Term | Definition |
|------|-----------|
| **TextPart** | A2A protocol text fragment inside a `Message` or `Artifact`. May carry arbitrary `metadata` |
| **FilePart** | A2A protocol file segment (`kind: 'file'`) inside a `Message` or `Artifact` — an agent-authored attachment. Carries a `FileWithUri` and `cinna.file_*` metadata; routed to a `file`-kind `MessagePart`. See [Agent Attachments](../../chat/agent_attachments/agent_attachments.md) |
| **Content Kind** | Value of `metadata['cinna.content_kind']`: `'text'`, `'thinking'`, `'tool'`, `'tool_result'`, `'notice'`, `'command_result'` (on TextParts), or `'file'` (on FileParts). Defaults to `'text'` when absent (and when an unknown future kind arrives, for forward compatibility) |
| **Notice** | A `'notice'`-kind TextPart — an agent-side system message (e.g. the startup ping "Starting up the agent environment, this may take a moment…"). Never persisted as part of the assistant message — the streaming service saves each notice as its own `role: 'agent_transition'` row so it renders as a muted system message and is excluded from LLM history rebuilds |
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
| `cinna.file_id` | string | Always on `file` parts (FileParts) | Cinna backend file UUID for an agent-attached file. The renderer builds a `cinna`-sourced `MessageAttachment` from it and downloads via the OAuth bearer path; the signed `?token=` download URI on the FilePart is ignored. See [Agent Attachments](../../chat/agent_attachments/agent_attachments.md) |
| `cinna.file_name` / `cinna.file_mime` / `cinna.file_size` | string / string / int | On `file` parts (each optional) | Display name, MIME type, byte size for the attachment badge. Fall back to the FilePart's `file.name` / `file.mimeType`, then to `attachment` / `application/octet-stream` / `0` |

When metadata is absent (non-Cinna A2A servers), parts default to `kind: 'text'` — backward-compatible plain rendering.

The same convention applies to history replay: the backend expands a single `SessionMessage` into N TextParts (one per persisted streaming event), each carrying its original metadata, so a client calling `getTask()` sees the same structured breakdown as a live stream.

## Streaming Flow

```
A2A SDK sendMessageStream() emits events
  ↓
For each event (status-update | artifact-update | message | task):
  - Extract message and/or artifacts
  - StreamPartsAccumulator.ingestMessage / ingestArtifact:
      For each FilePart in parts[] (kind === 'file'):
        file = partFileOf(part)   # reads cinna.file_id/name/mime/size
        if no file_id -> skip
        if file_id already seen -> skip (dedup; never merge file parts)
        append { kind: 'file', text: '', file } to internal parts[]
        port.postMessage({ type: 'delta', kind: 'file', text: '', file })
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
        append to internal parts[] (merge with last only if continuesPart():
          - text/thinking/command_result: same kind + toolName (both unset)
          - tool: same kind + toolName, and not two different toolIds
          - tool_result: same kind + toolId + toolStream)
        port.postMessage({ type: 'delta', kind, text: delta, toolName, toolInput, toolId, toolStream, commandInvocation })
        if first time we see (toolName, toolInput) for this part -> opts.onToolCall({...})
  - Update latestContextId / latestTaskId / latestTaskState from the event
  - status-update only: post `{ type: 'status', state: toRunState(state), taskId, contextId }`
      input-required / auth-required -> state 'needs_input', then
      `{ type: 'needs_input', requestId: taskId, request, resume: 'next_message' }`
      (request = a2aInputRequestOf: one open question from the status message's
       text parts, or { kind: 'auth', message } for auth-required)
  ↓
On stream completion (the runner):
  - parts   = accumulator.snapshotParts()
  - answer  = accumulator.answerText()    # concat of 'text'-kind parts
  - notices = accumulator.snapshotNotices()  # one entry per distinct notice part
  - agentSessionRepo.upsert(...) whenever the stream completes, a failed task state included; a throw skips it
  - return { text: answer, parts, notices, ... }
  ↓
The direct-chat wrapper (streamToAgent):
  - persistTurn past its cursor:
    - For each notice not yet saved: messageRepo.saveTransition({ chatId, content, sourceAgentId })
    - messageRepo.saveAssistant({ chatId, content: answer, parts })   # split around steers
    - messageRepo.touchChat(chatId)
  - on failure only: messageRepo.saveError(...) after the rows,
    then port.postMessage({ type: 'error', ... }) and return        # no 'done'
  - otherwise: port.postMessage({ type: 'done', stopReason })   # 'canceled' if stopped, 'budget' on a budget ending, else 'end_turn'

Notices are persisted *before* the assistant message so transcript ordering
matches the on-the-wire order — startup pings sit above the answer they
preceded. Notices never appear in `messages.parts[]`; they live on their own
`role: 'agent_transition'` rows.
```

## Terminal Outcome

`runAgentTurn` treats nonstream JSON-RPC error envelopes and failed/rejected/unfinished A2A task endings as failures. The direct wrapper never turns a failure into an empty success: it persists what the turn streamed, its steered user messages in place, and then the error row under the output it ended. A turn that ran for minutes and then failed would otherwise leave only the error.

A task that ends `failed` (or `rejected`, or any other unfinished state) carries its own answer as the error text. When the error text equals the turn's `text` and the turn has parts, the wrapper replaces it with "The agent reported that its task failed." in two places: the error row and the `error` event posted to the port. The answer is already a row above the error, and repeating it would show the agent's words twice. The outcome passed to `finish()`, which the job run records, keeps the agent's own reason, because the run has no transcript row above it to carry that reason. Input-required/auth-required report `needs_input`; canceled reports `canceled`. Its once-only `onFinished` callback runs after persistence and before close, with standalone job reporting as the default when no callback is supplied. The executor owns the final result and explicit runner completion policy; see [turn outcomes](../../chat/messaging/turn_completion.md).

## Cancellation and session checkpoints

Stop aborts the underlying card/message fetch, including body reads and silent SSE waits. Checking only after a received frame once left a stopped turn waiting indefinitely when the server went silent. The driver also stops waiting for endpoint/token pre-flight without cancelling shared credential refresh work. [Driver implementation](../drivers/drivers_tech.md#the-a2a-driver) owns the legacy SDK fetch seam and the independent cancellation request.

Task identity reaches the driver before any message or artifact can emit its first delta. The event sink checks abort before and after forwarding, while the accumulator records the current part first. A Stop triggered inside that callback therefore keeps the part just shown and prevents subsequent events.

A pump that throws — aborted or not — returns accumulated text, parts and notices alongside an error, so a connection that drops mid-turn keeps what streamed above its error row. Neither returns a newly learned session checkpoint or upserts the session row. A previous checkpoint is preserved, and a fresh stopped turn leaves none. The direct-chat wrapper persists partial output, emits a canceled terminal event and releases its active request when the turn returns — `cancel()` only aborts, and leaves the entry in place so a turn still unwinding when the app quits is found by the quit flush below; it skips completed-only bookkeeping. Tool callers retain the error-bearing result. Remote `tasks/cancel` is best effort and does not delay local completion, so local Stop is not confirmation of remote cancellation.

## What a direct turn keeps when it never returns

The wrapper writes a turn's rows when the runner returns, and at quit some never do: Electron does not await `will-quit`, and the process kills that follow end a turn parked on a question or minutes into its tool calls. So `will-quit` calls `a2aStreamingService.saveInFlight()` **first and synchronously** — ahead of the scheduler stops and `acpProcessPool.shutdown()`, and ahead of any `await` — and it persists what every active request has streamed so far. SQLite writes are synchronous, which is what lets the flush complete inside a handler nobody waits for.

- **The flush reads a snapshot the driver offers.** `RunInput.registerSnapshot` hands the wrapper a function returning a shallow copy of the turn's parts, notices and steers lists — read and written in the same synchronous pass. Text parts are read in streaming mode, so an attach tag that has opened but not closed is left out rather than saved half-written. All three drivers register one: ACP from its accumulator (steers included), A2A from `runAgentTurn`'s accumulator (forwarded by the A2A driver), and Managed from its push-only parts list. A remote A2A task or Managed session keeps running after the app closes; what is saved is what had reached the desktop. A `/run:` command never registers, and the agent tool a coordinator calls has no wrapper to flush it
- **Only rows, not an outcome.** The flush records no turn result. A parked ask left open is expired by the boot cleanup (`taskInputRequestRepo.expireOpen`), which is acceptable because the question itself is now in the transcript
- **Each turn has a persist cursor** — parts and steers saved so far by count, notices by `partKey`. Notices are tracked by key rather than position because `snapshotNotices` skips a notice whose text is still empty, so positions shift when it fills in. Every path that keeps output (the normal end, a failure, a throw, the quit flush) saves only what lies past the cursor, so a killed run that still returns does not write its turn twice. The cursor moves with each write, so a write that throws leaves it on what actually reached the transcript
- **The cursor counts whole parts.** Any part the killed process adds to after the flush keeps the text it had then — usually the last one, but a tool part matched by its `toolId` can be an earlier one — and the addition is not saved. The cost is clipped text at quit, never a duplicate. A row saved past the cursor takes its `content` from its own slice, not from the turn's full `text`
- **A runner that throws** has its snapshot flushed before the error row, so it keeps what it offered. A runner that registered no snapshot keeps nothing on a throw
- **A flush that fails is logged, never thrown**, so one broken turn does not stop the rest of the quit handler

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
| `file` | `{ fileId, filename, mimeType, size }` \| undefined | Set only when `kind === 'file'`. The complete attachment descriptor (no incremental assembly — one delta per file). `text` is empty for file deltas |

For `kind: 'notice'` deltas, only `text` and `kind` are populated; all `tool*` fields are `undefined`. The renderer appends them as `notice` text blocks in `chat.store.streamingBlocks`, rendered as muted system messages. After the stream completes they're persisted as `role: 'agent_transition'` rows and the streaming block is cleared.

## Persisted Shape (`messages.parts`)

Stored as JSON on the `messages` row:

```
[
  { "kind": "thinking", "text": "**Considering user request**\n\nI think..." },
  { "kind": "tool", "text": "Calling search...", "toolName": "web_search", "toolInput": { "query": "weather paris" }, "toolId": "exec_123" },
  { "kind": "tool_result", "text": "Found 3 results...", "toolId": "exec_123", "toolStream": "stdout" },
  { "kind": "text", "text": "Here is the answer..." },
  { "kind": "file", "text": "", "file": { "fileId": "uuid", "filename": "report.pdf", "mimeType": "application/pdf", "size": 20480 } }
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
- `kind: 'file'` → `AgentAttachment` (downloadable badge via `AttachmentList`, left-aligned). The FilePart arrives at finalize, so the badge renders below the reply text (end of the turn) — the mirror of how a user's own attachments render under their message. Click downloads via the Cinna OAuth bearer path. See [Agent Attachments](../../chat/agent_attachments/agent_attachments.md)
- `kind: 'notice'` → live during streaming via a `notice` block in `chat.store.streamingBlocks`, rendered through `NoticeBlock` with `live` (left-aligned `Info`+text row, no collapse). Persisted as a `role: 'agent_transition'` row that also renders through `NoticeBlock`, with `defaultExpanded={verboseMode}` — compact mode collapses to a small info-toned dot the user clicks to read; verbose mode keeps the row expanded inline. Notices never appear in an assistant message's `parts[]`

Streaming blocks merge consecutive deltas with **the** rule the main-process accumulator persists with — one function, `continuesPart` in `src/shared/partMerge.ts`, called by the accumulator, `chat.store.appendDelta` and the orchestrated sub-thread's `appendAgentDeltaPart`. They used to be three hand-kept copies, and a transcript that streams one way and reloads another is exactly what three copies drift into. The rule:

- Different kinds never merge, and `file` never merges: two attachments are two badges
- `tool_result` merges only when both `toolId` AND `toolStream` match, so interleaved stdout/stderr keep their chronology
- Everything else merges on `toolName` — and a `tool` part also refuses to merge when both sides name **different** `toolId`s. Two calls to one tool are two calls. Before this clause, two back-to-back permission asks (the same reserved tool name, different `per_` ids) folded into one block, and the second ask's id — the address its answer is posted to — never reached the renderer, leaving that ask parked until its timeout
- A fragment with no `toolId` still continues the part before it, because a backend may send `cinna.tool_id` on a part's first frame only

## File References

- Pipeline implementation: `src/main/agents/streamPartsAccumulator.ts`
- Shared types: `src/shared/messageParts.ts`, `src/shared/runEvents.ts` (the `delta` event), `src/shared/partMerge.ts` (the merge rule)
- IPC integration: `src/main/ipc/agent_a2a.ipc.ts:registerA2AHandlers` <!-- nocheck -->
- Persistence: `src/main/db/messages.ts:messageRepo.saveAssistant` <!-- nocheck -->, `src/main/db/messages.ts:messageRepo.saveTransition` <!-- nocheck -->
- DB column: `src/main/db/migrations/messages.ts` (`parts` JSON column)
- Renderer store: `src/renderer/src/stores/chat.store.ts:appendDelta` <!-- nocheck -->
- Renderer hook: `src/renderer/src/hooks/useChatStream.ts:handleRun` <!-- nocheck -->
- Renderer routing: `src/renderer/src/components/chat/MessageStream.tsx`
- Characterization: `src/renderer/src/hooks/useChatStream.events.test.tsx` pins what each event does to the chat store, and the per-runner golden streams pin what reaches it. See [Characterization tests](../local_agents/agent_turn_tech.md#characterization-tests)
- Block components: `src/renderer/src/components/chat/ThinkingBlock.tsx`, `src/renderer/src/components/chat/ToolNarrationBlock.tsx`, `src/renderer/src/components/chat/ToolResultBlock.tsx`, `src/renderer/src/components/chat/CommandResultBlock.tsx`, `src/renderer/src/components/chat/AgentAttachment.tsx` (`file` kind), `src/renderer/src/components/chat/NoticeBlock.tsx`. Both live and persisted notices route through `NoticeBlock` (live: forced-expanded row; persisted: collapsed dot or expanded row per verbose mode)

## Backward Compatibility

- Messages with no `parts` (LLM chats, pre-existing agent chats) render via the existing `MessageBubble` path using `content`
- A2A servers that don't set `cinna.content_kind` get `kind: 'text'` for every part — identical to pre-pipeline behavior
- The `content` column is still populated with the concatenated answer text, so chat previews, titles, and search work unchanged
- Older persisted assistant messages may have `tool` parts without `toolId` — pairing degrades gracefully (each `tool_result` renders on its own; orphaned `tool_result` parts also render in place without crashing)

## Integration Points

- [Agents](agents.md) — Owns the broader A2A integration; this doc is its streaming-pipeline aspect
- [Agent Attachments](../../chat/agent_attachments/agent_attachments.md) — The `file`-kind aspect: FilePart → downloadable badge, OAuth download path
- [Conversation UI](../../chat/conversation_ui/conversation_ui.md) — Visual treatment of `thinking` and `tool` blocks
- [Messaging](../../chat/messaging/messaging.md) — Underlying streaming infrastructure (MessagePort, `chat.store`)
