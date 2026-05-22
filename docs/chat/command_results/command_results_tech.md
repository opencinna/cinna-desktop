# Command Results — Technical Details

## File Locations

### Shared

| File | Role |
|------|------|
| `src/shared/messageParts.ts` | `ContentKind` union includes `'command_result'`. `MessagePart` exposes `commandInvocation?: string` so the verbatim slash slug survives the wire → store → DB round-trip. Type-only; imported from both Electron processes and the renderer. |

### Main Process

| File | Role |
|------|------|
| `src/main/agents/streamPartsAccumulator.ts` | `StreamPartsAccumulator` recognises `'command_result'` in `VALID_KINDS`. The kind flows through the same `appendToList` path as `text` / `thinking`: consecutive parts merge on kind alone (no tool-id discriminator). `answer` accumulates both `text` and `command_result` deltas, so `answerText()` returns the command output as part of the message preview / title / search seed (see [Auto Chat Titles](../auto_titles/auto_titles.md)). Also extracts `cinna.command_invocation` via `partCommandInvocationOf(part)` and propagates it on every kind (always set for `command_result`; set on `tool` / `tool_result` only when the pair wraps a `/run:*` execution) — both onto the persisted `MessagePart.commandInvocation` and onto the `delta` IPC event. |
| `src/main/services/a2aStreamingService.ts` | No command_result-specific branches — the accumulator handles routing; the streaming service persists the assistant row via `messageRepo.saveAssistant({ content: answerText, parts })` exactly as for any other A2A assistant turn. |
| `src/main/db/messages.ts` | No new role or column. `command_result` lives inside the existing `assistant` row's `parts` JSON. `messages.content` (the flat preview) is populated by `answerText()` and includes command_result text. |

### Preload

| File | Role |
|------|------|
| `src/preload/index.ts` | No new bridge surface. The existing `agents.sendMessage` MessagePort stream carries `{type:'delta', kind:'command_result', text}` events alongside other deltas; `MessagePart` types in the preload already use the shared `ContentKind` union so consumers see the new kind without changes. |

### Renderer

| File | Role |
|------|------|
| `src/renderer/src/hooks/useChatStream.ts` | `handleAgent` forwards every `delta` event to `chat.store.appendDelta` regardless of `kind`. `AgentEvent.kind` is typed as `ContentKind` (which now includes `'command_result'`) — no per-kind branching in the hook. |
| `src/renderer/src/stores/chat.store.ts` | `appendDelta` accepts `kind: 'command_result'` and stores it in `streamingBlocks` as a `TextBlock { kind: 'command_result' }`. The standard merge rule (sameKind + matching `toolName` — both `undefined` for command_result) groups consecutive deltas into one block. |
| `src/renderer/src/components/chat/CommandResultBlock.tsx` | Bordered card with `Terminal` icon, "Command: <invocation>" header (driven by the optional `commandInvocation` prop; falls back to "Command output" when absent), and a `react-markdown` + `remark-gfm` + `rehype-highlight` body using the shared `markdownComponents`. Default-expanded; body caps at `max-h-[60vh]` with `overflow-y-auto`. `isStreaming` adds a pulsing accent dot in the header during the in-flight render. |
| `src/renderer/src/components/chat/CommandToolFrame.tsx` | Outer wrapper for a `/run:*` tool/tool_result pair carrying `cinna.command_invocation`. Same visual contract as `CommandResultBlock` (bordered card, `Terminal` icon, "Command: <invocation>" header) but the body is a collapsible `children` slot. `defaultExpanded` (with `isStreaming` fallback) controls initial state — `MessageStream` passes `true` in verbose mode and during streaming, leaves it `false` (collapsed) for the persisted compact view. |
| `src/renderer/src/components/chat/ToolNarrationBlock.tsx` | Accepts optional `commandInvocation` and suppresses its markdown text body when the body equals that string (with a regex `^\s*/[\w:.\-]+\s*$` fallback for historic parts persisted before the metadata existed). Keeps the structured `toolName` / `toolInput` summary intact — only the redundant slash-echo text is hidden. |
| `src/renderer/src/components/chat/MessageStream.tsx` | Module-level `pairCommandTools()` helper matches each `tool` part (with `commandInvocation`) to its paired `tool_result` (by `toolId`) and returns a "consumed result indices" set. Used by all three render sites: (1) verbose-mode persisted parts loop, (2) compact-mode persisted parts loop, (3) streaming-blocks loop. In each loop the `tool` part renders as a `<CommandToolFrame>` wrapping `<ToolNarrationBlock>` + the paired `<ToolResultBlock>`, and the standalone `tool_result` render is skipped via the consumed set. `command_result` parts pass `commandInvocation` through to `CommandResultBlock`. All wrapper renders are `slot: 'plain'` (not collapsible-grouped — slash-command output IS the answer). |

## Database Schema

No migration required. `command_result` joins the existing `assistant`-role row's `parts` JSON column (`MessagePart[]`). `messages.content` carries the flat preview string assembled by `accumulator.answerText()` — text + command_result deltas, in order — so chat-list snippets, [Auto Chat Titles](../auto_titles/auto_titles.md), and full-text search work for slash-command turns without any chat-table changes.

## IPC Channels

No new channels. The existing `agent:send-message` MessagePort stream carries command_result deltas with this shape:

| Field | Value |
|-------|-------|
| `type` | `'delta'` |
| `kind` | `'command_result'` |
| `text` | The delta string |
| `toolName` / `toolInput` / `toolId` / `toolStream` | `undefined` for command_result (the accumulator deliberately omits these so the renderer's merge rule treats consecutive deltas as the same streaming block) |
| `commandInvocation` | Verbatim slash invocation from `cinna.command_invocation`. Always present on `command_result` deltas. Also present on `tool` / `tool_result` deltas when the pair was synthesized to wrap a `/run:*` execution — the renderer uses it to fold those deltas into a `CommandToolFrame` instead of bare tool blocks |

The stream typically ends right after the command_result event arrives: the A2A wire frame carries `state: "completed"`, `final: true`, and no further frames follow. The desktop client doesn't inspect those flags directly — the per-part metadata is the authoritative discriminator and the stream's natural termination drives the `done` event.

## Services & Key Methods

- `src/main/agents/streamPartsAccumulator.ts::StreamPartsAccumulator.ingest()` — Classifies the part via `partKindOf(part)`; the `command_result` branch falls into the normal `appendToList` call (no early short-circuit unlike `notice`), so command_result deltas join `parts[]` and contribute to `answer`.
- `src/main/agents/streamPartsAccumulator.ts::StreamPartsAccumulator.appendToList()` — Merge rule for command_result: `sameKind && last.toolName === toolName` — both are `undefined` for command_result, so consecutive same-kind deltas always merge. Same rule as `text` / `thinking`.
- `src/main/agents/streamPartsAccumulator.ts::StreamPartsAccumulator.answerText()` — Returns the concat of every `text` and `command_result` delta seen during the stream, in arrival order. Used as the `messages.content` fallback.
- `src/main/services/a2aStreamingService.ts::streamToAgent()` — No command_result-specific code. After the loop completes, `accumulator.snapshotParts()` returns the structured list (including any command_result parts) and `accumulator.answerText()` returns the preview string. Persists via `messageRepo.saveAssistant({ content: answerText, parts, sourceAgentId })`.

## Renderer Components

- `src/renderer/src/components/chat/CommandResultBlock.tsx` — `CommandResultBlock({ content, commandInvocation?, isStreaming?, animate?, animateDelay? })`. Bordered card (`border-[var(--color-border)]/60`, `bg-[var(--color-bg-secondary)]/50`), `Terminal` icon (`lucide-react`), "Command: <invocation>" header (drops to "Command output" if invocation is absent). Body renders `content` through `react-markdown` with `remark-gfm` + `rehype-highlight` + the shared `markdownComponents`. `max-h-[60vh] overflow-y-auto` so long outputs scroll inside the card instead of pushing the conversation off-screen. No internal expand/collapse state — always expanded.
- `src/renderer/src/components/chat/CommandToolFrame.tsx` — `CommandToolFrame({ commandInvocation, children, isStreaming?, defaultExpanded?, animate?, animateDelay? })`. Same outer card styling as `CommandResultBlock`; chevron-toggle header (`"Command: <invocation>"` + `Terminal` icon + pulsing dot when `isStreaming`). Body slot holds the paired `ToolNarrationBlock` + `ToolResultBlock` and is gated by the local `expanded` state. Initial state: `defaultExpanded ?? !!isStreaming` — so persisted compact view starts collapsed, persisted verbose view and the live stream start expanded.
- `src/renderer/src/components/chat/ToolNarrationBlock.tsx` — Accepts an optional `commandInvocation`; when the text body equals it (or matches the bare-slug regex fallback), suppresses the body markdown to avoid double-printing the invocation already shown in the wrapper header.
- `src/renderer/src/components/chat/MessageStream.tsx` — Module-level `pairCommandTools(items)` returns `{ pairResultIdx, consumed }`: maps each command-tool index to its paired tool_result index by `toolId`. Used in all three render sites:
  - Verbose-mode persisted parts loop — wraps the pair inside the `space-y-2` parts container so the per-message `MessageMetaFooter` stays attached; pair frame `defaultExpanded`; inner `ToolResultBlock` `defaultExpanded`.
  - Compact-mode persisted parts loop — pushed as `slot: 'plain'` (not collapsible-grouped — slash-command output IS the substantive answer); pair frame collapsed by default.
  - Streaming-blocks loop — pairs live `tool` + `tool_result` blocks (same `pairCommandTools` helper, with `commandInvocation` carried on the streaming `TextBlock`). Frame defaults expanded with `isStreaming` rolling up from "either side of the pair is still receiving deltas"; post-stream the cache refetch swaps in the persisted render.
  - Outside the pair flow, `command_result` parts pass `commandInvocation` through to `CommandResultBlock` for the header.

## Configuration

No settings, env vars, or feature flags. The contract is purely two metadata keys on inbound A2A TextParts: `cinna.content_kind` (`'command_result' | 'tool' | 'tool_result'`) drives part routing, and `cinna.command_invocation` (verbatim slash slug) drives the slash-command UI wrapper — always present for `command_result`, present on `tool` / `tool_result` only when the pair was synthesized to wrap a `/run:*` execution.

## Security

- Command output is treated as untrusted text from the platform — same trust boundary as ordinary `text` parts. Rendered through the shared `markdownComponents` pipeline (`react-markdown` sanitises by default; no `dangerouslySetInnerHTML`). Code highlighting via `rehype-highlight` operates on tokenised text, not executable strings.
- Command results don't bypass the LLM history rebuild — they ARE the assistant turn, so they're persisted and replayed exactly as any other assistant message would be. This is intentional: a follow-up LLM-channel send in the same chat needs to see what the slash-command produced for context.

## Backend Coordination

This is the desktop half of the contract. The Cinna backend (`a2a_event_mapper.py`) must set `metadata['cinna.content_kind'] = 'command_result'` on TextParts produced by its slash-command executor. Without the tag the part falls back to `kind: 'text'` (unknown-kind fallback in `partKindOf`) and renders as a normal assistant bubble — functional, but loses the terminal-style visual cue.

See the [A2A Streaming Pipeline](../../agents/agents/streaming_pipeline.md) `Cinna Metadata Contract` table for the full per-key reference and the rendering routing table.
