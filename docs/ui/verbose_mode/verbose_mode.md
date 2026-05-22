# Verbose Mode

## Purpose

A global UI preference that toggles between a **compact** (default) chat view — no timestamps, no meta — and a **verbose** view that shows a subtle relative-time footer with an info icon beneath every message and keeps streaming reasoning blocks auto-expanded.

## Core Concepts

- **Compact mode** — The default reading experience. Message bubbles render with no footer, no timestamps, no metadata icons. Streaming `thinking` / `tool narration` blocks stay collapsed while the model is speaking. Tool narration headers fall back to the minimal `Tool: <name>` label even when the backend supplied structured tool input.
- **Verbose mode** — User-enabled display mode. Adds a small footer (`X minutes ago` + info button) below every message, restores the previous auto-expand behaviour for streaming `thinking` / `tool narration` blocks, surfaces structured tool input (`name(arg: value, …)`) inline in tool narration headers when the backend provides it, and exposes all available message metadata via a popup.
- **Meta footer** — A thin, muted row appearing under each persisted message in verbose mode. Shows a relative timestamp on the left (or right, matching the message alignment) plus an info icon that opens a popup listing every available field on the underlying message record.
- **Meta popup** — A small, absolutely-positioned card listing `id`, `role`, `createdAt`, `sortOrder`, `chatId`, content length, and any tool-related fields (`toolName`, `toolProvider`, `toolCallId`, `toolError`, `toolInput`) or structured-parts summary when present. Dismisses on outside click.
- **Shared clock tick** — A single app-wide 30-second tick that advances all relative timestamps together. Replaces per-footer timers so long conversations don't accumulate intervals.

## User Stories / Flows

### Enabling verbose mode

1. User clicks the eye / eye-off icon in the sidebar bottom bar, immediately to the left of the theme toggle
2. The button's active (filled) state indicates verbose is on; the tooltip flips between "Switch to verbose mode" and "Switch to compact mode"
3. Every already-rendered message immediately gains a footer; every streaming reasoning block re-applies the auto-expand rule on its next mount
4. The preference persists to `localStorage` and survives reloads

### Inspecting a message

1. With verbose mode on, user moves to a specific message
2. User clicks the small `(i)` info icon in its footer
3. A popup opens above the icon, aligned to the same side as the message (right for user messages, left for everything else)
4. User reads the full metadata — IDs, timestamps, tool details, parts summary
5. Clicking anywhere outside the popup dismisses it

### Streaming reasoning blocks

1. User sends a message that triggers a `thinking` or `tool`-kind stream
2. **Compact mode**: each streaming `ThinkingBlock` / `ToolNarrationBlock` mounts collapsed. User can click the header to expand manually. Content still streams in live behind the header; the pulsing accent dot indicates activity.
3. **Verbose mode**: the currently-last streaming block auto-expands so the user sees reasoning as it arrives (legacy behaviour). When the stream completes and the persisted message re-renders, the block collapses again.

### Agent notice rows (`agent_transition`)

1. The agent emits a `cinna.content_kind: 'notice'` part (e.g. "Starting up the agent environment…") — see [Agent Notices](../../chat/agent_notices/agent_notices.md)
2. **Live (both modes)**: the streaming notice renders as a left-aligned `Info`+text row so the user can see the in-flight ping
3. **Compact mode (persisted)**: once the stream completes and the row persists, the notice collapses to a small info-toned blue dot. Click expands to the same `Info`+text row.
4. **Verbose mode (persisted)**: the persisted notice row stays expanded inline, matching the rest of verbose mode's surfaced meta. Click still toggles back to the collapsed dot.

### Tool narration headers (A2A structured tool input)

1. The Cinna backend tags `tool`-kind parts with `cinna.tool_name` and (optionally) `cinna.tool_input` — see [A2A Streaming Pipeline](../../agents/agents/streaming_pipeline.md)
2. **Compact mode**: the always-visible `ToolNarrationBlock` header reads `Tool: <toolName>` — same minimal label used when structured input is unavailable. Clicking to expand still reveals the full structured input block underneath the narration text.
3. **Verbose mode**: the header replaces the minimal label with a compact one-line tool-call summary (`name(arg: value, …)`) rendered by `ToolCallSummary`. Expanded body is identical to compact mode.
4. Toggling verbose updates already-mounted headers immediately (the component subscribes to the store directly).

## Business Rules

- Compact mode is the default. Persistence key is `cinna-verbose-mode` in `localStorage` (`'1'` / `'0'`).
- The footer is rendered only when verbose mode is active. Streaming-only blocks (blocks that exist solely in the `streamingBlocks` buffer and have no persisted message yet) never get a footer — only persisted messages do.
- The footer alignment follows the message:
  - User messages → right-aligned footer, popup opens anchored to the right
  - Assistant / tool-call / error messages → left-aligned footer, popup opens anchored to the left
- Footer relative time re-renders at most once every 30 s, driven by a single shared tick. The absolute timestamp is always available in the `title` tooltip on the relative-time span.
- `ToolCallBlock` (actual MCP tool invocations) is not affected by the verbose / compact toggle — it is always collapsed by default regardless of mode and always shows the structured `ToolCallSummary` in its header. Only `ThinkingBlock` and `ToolNarrationBlock` change behaviour.
- `ToolResultBlock` (A2A `tool_result`-kind parts) intentionally diverges from `ThinkingBlock` / `ToolNarrationBlock` during streaming: it defaults to **expanded** in both modes because the output is the payload the user is waiting on (especially for `/run:*` CLI commands), not auxiliary narration. Persisted reload falls back to the default-collapsed behaviour to keep long stdout/stderr from crowding scrollback.
- The verbose / compact gate for streaming blocks only controls the **initial** expanded state on mount. Once a user manually toggles a block, that choice is preserved until the block unmounts (e.g., when streaming ends and the persisted message takes over).
- The structured-header gate inside `ToolNarrationBlock` is reactive — flipping verbose updates every mounted block's header on the next render. Only the always-visible header is gated; the expanded body always shows the structured `ToolCallSummary` block when `cinna.tool_input` is present.
- Meta popup contents are derived per-render from the message record — no caching. The popup omits tool fields when they are empty / undefined so compact messages don't show irrelevant keys.

## Architecture Overview

```
Sidebar (bottom bar)
  └── verbose toggle ─── toggleVerboseMode() ──► ui.store
                                                     │
                                                     ▼
                                              verboseMode: boolean
                                                     │
                     ┌───────────────────────────────┼──────────────────────────────┐
                     ▼                                                              ▼
        MessageStream (per persisted msg)                        MessageStream (streaming blocks)
                     │                                                              │
                     ▼                                                              ▼
     MessageMetaFooter (when verboseMode)            ThinkingBlock / ToolNarrationBlock
                     │                                   defaultExpanded = verboseMode
                     │                                                              │
       ┌─────────────┴──────────────┐                                               ▼
       ▼                            ▼                                   (auto-expand only in verbose)
  useRelativeNow()              MetaPopup (on info click)
  shared 30s tick
```

## Integration Points

- [Conversation UI](../../chat/conversation_ui/conversation_ui.md) — Verbose mode layers a footer beneath the existing bubble / thinking / tool narration / tool-call / system-message rendering without altering their core visuals
- [Settings](../settings/settings.md) — Preference lives in the same `ui.store` that backs settings navigation; it is exposed via a sidebar button rather than the settings screen because it is a one-click display toggle
- [Messaging](../../chat/messaging/messaging.md) — The meta popup surfaces the persisted message record produced by the chat messaging flow
