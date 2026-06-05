# Conversation UI — Technical Details

## File Locations

### Renderer

| File | Role |
|------|------|
| `src/renderer/src/components/chat/MessageStream.tsx` | Orchestrates the conversation: maps messages to bubbles, thinking/tool narration/tool result cards, tool blocks, loading dots, and error boxes. For assistant messages with structured `parts[]`, renders one block per part keyed by `kind`. For streaming, routes each `streamingBlocks` entry to the matching block component. Contains inline `SystemMessage` component. Detects newly-sent messages via a `prevRef` (chatId + previous messageIds) to drive entry animations. |
| `src/renderer/src/components/chat/MessageBubble.tsx` | Renders a single message. Branches on `role`: user -> right-aligned bubble; assistant -> full-width text. Markdown goes through a memoized `MarkdownContent` subcomponent (`React.memo`) that skips `rehype-highlight` when `highlight={false}` — passed as `!isStreaming` on the assistant path so fenced code is highlighted only once the turn finalizes. Used by MessageStream for BOTH persisted and live-streaming assistant text. Supports streaming cursor, meta popup, and an `animate` prop that triggers the role-specific entry animation. |
| `src/renderer/src/components/chat/CollapsibleGroup.tsx` | The dots-group component plus the shared `RenderNode` type + `groupConsecutiveCollapsibles(nodes)` helper that folds runs of ≥2 consecutive collapsible nodes (thinking / tool / tool_result) into one expandable dots group. Used by `MessageStream` (main transcript) and `AgentContribution` (agent sub-thread) so both collapse auxiliary steps identically. |
| `src/renderer/src/components/chat/ThinkingBlock.tsx` | Collapsible dimmed card for `thinking`-kind parts. Brain icon header, italic markdown body. `isStreaming` prop adds a pulsing accent dot in the header and defaults the card to expanded; persisted thinking parts default to collapsed. |
| `src/renderer/src/components/chat/ToolNarrationBlock.tsx` | Collapsible dimmed card for `tool`-kind parts. Wrench icon header; markdown body. Header label is verbose-aware (see [Verbose Mode tech](../../ui/verbose_mode/verbose_mode_tech.md)): in compact mode reads `Tool: <toolName>` (toolName from `cinna.tool_name` metadata); in verbose mode renders `<ToolCallSummary>` inline when `cinna.tool_input` metadata is also present. Expanded body always shows the structured `<ToolCallSummary variant="block">` when input is present. Same expand/streaming behaviour as ThinkingBlock. |
| `src/renderer/src/components/chat/ToolResultBlock.tsx` | Collapsible card for `tool_result`-kind parts. Terminal icon + `Output` header for stdout; switches to `AlertTriangle` + `stderr` header and `--color-danger` colouring when `toolStream === 'stderr'`. Body is a `<pre>` with `font-mono`, `whitespace-pre-wrap`, `max-h-96 overflow-y-auto`. `defaultExpanded` falls back to `!!isStreaming` like ThinkingBlock — streaming callers (MessageStream) pass `defaultExpanded=true` in compact mode so the output the user is waiting on is visible without a click, while persisted reload uses the default-collapsed behaviour to keep long outputs from crowding scrollback. |
| `src/renderer/src/components/chat/ToolCallBlock.tsx` | Tool-call row (distinct from ToolNarrationBlock and ToolResultBlock). Borderless badge line (chevron + provider/tool badge + status icon); the detail card (method/input/result) renders in a rounded, bordered block **below** the badge line on expand. Icon: connector `Plug` + provider badge for MCP (provider present), `Wrench` fallback for a generic/local tool (e.g. `bash`). Parses MCP content-block arrays and JSON for structured result display. |
| `src/renderer/src/components/chat/AgentToolSubThread.tsx` / `AgentContribution.tsx` | Orchestrated agent-backed tool call rendered as an expandable nested sub-thread — see [Orchestrated Agents tech](../orchestrated_agents/orchestrated_agents_tech.md). |
| `src/renderer/src/assets/main.css` | CSS variable definitions (`--color-user-bubble`, `--color-border`, `--color-danger`, etc.) and entry-animation keyframes: `user-bubble-pop`, `user-bubble-content-in`, and `assistant-reveal` (mask-based block reveal used by `.anim-assistant-bubble`). (The per-delta `chunk-reveal` / `.anim-chunk` was removed when streaming text switched to the live-Markdown render.) |

### State

| File | Role |
|------|------|
| `src/renderer/src/stores/chat.store.ts` | Zustand store holding `streamingBlocks` (text blocks carry `kind`, optional `toolName`/`toolInput`/`toolId`/`toolStream`, and the joined `content`), `isStreaming`, and `streamedIncrementallyChatId` (chat ID of the most recent stream that produced gradual deltas — consumed by MessageStream to suppress block-level re-animation on DB arrival). `appendDelta(text, kind?, toolName?, toolInput?, toolId?, toolStream?)` merges into the last block by kind-specific rules: `text`/`thinking` merge on kind; `tool` merges on kind + toolName; `tool_result` merges on kind + toolId + toolStream (preserves interleaved stdout/stderr chronology as separate blocks). Otherwise pushes a new block. (The former per-delta `segments` array was dropped when streaming text moved to the live-Markdown render — only the joined `content` is needed now.) `addToolCall` and `appendDelta` both set `streamedIncrementallyChatId` to the current `activeChatId`; it is reset to `null` on `startStreaming`, `setActiveChatId`, `stopStreaming`, and `reset`. Also holds `pendingUserMessage: { content, baselineUserCount } \| null` — the optimistic user bubble shown until its persisted row lands (count-keyed handoff; see the optimistic user-message lifecycle in [Messaging tech](../messaging/messaging_tech.md)). |
| `src/renderer/src/hooks/useChat.ts` | TanStack Query hook `useChatDetail(chatId)` — provides persisted messages (each may carry `parts[]` for structured rendering) |
| `src/renderer/src/hooks/useChatStream.ts` | `handleAgent` reads `event.kind`, `event.toolName`, `event.toolInput`, `event.toolId`, `event.toolStream` from the delta payload and forwards them to `appendDelta`. Note: the LLM-side `'tool_result'` MessagePort event handled by `handleLlm` is a tool-use-id resolver — unrelated to the A2A `tool_result` content kind streamed through `handleAgent`. |
| `src/shared/messageParts.ts` | Shared `ContentKind` (`text`, `thinking`, `tool`, `tool_result`), `ToolStream` (`stdout`/`stderr`), and `MessagePart` types — single source of truth for both store and rendering |

## Renderer Components

### MessageBubble

- `src/renderer/src/components/chat/MessageBubble.tsx`
- **User path**: wraps content in a right-aligned `rounded-xl` div with `bg-[var(--color-user-bubble)]`, max 80% width. No icon. When the `animate` prop is true, the bubble div gets `anim-user-bubble-pop` (scale + border-radius from a small circle to the full bubble, `transform-origin: top right`) and an inner div wrapping the Markdown gets `anim-user-bubble-content` (delayed opacity fade so the bubble appears before the text).
- **Assistant path**: renders Markdown (via the memoized `MarkdownContent`) in a full-width div, no background. Appends a pulsing accent cursor when `isStreaming` is true. When the `animate` prop is true, the wrapping div gets `anim-assistant-bubble` (700ms `mask-image` reveal from top to bottom — markdown/HTML is never split). MessageStream uses this path for BOTH persisted and live-streaming assistant text (see the Streaming-text section below).
- **`MarkdownContent` (memoized)**: a `React.memo` subcomponent rendering `<Markdown remarkPlugins={[remarkGfm]} rehypePlugins={highlight ? [rehypeHighlight] : []} components={markdownComponents}>`. `React.memo` skips re-parsing when the transcript re-renders but this bubble's `content` is unchanged; `highlight` is `!isStreaming` on the assistant path (and always true for user bubbles) so fenced code is highlighted once per turn rather than on every streamed token.
- **Meta popup**: optional `MetaPopup` shown on hover (info icon) for assistant messages with metadata.

### Entry-animation triggering (in MessageStream)

- `prevRef` holds `{ chatId, messageIds }` from the previous render. A message is considered "new" only when `chatId` matches the previous render AND `messages.length === prev.messageIds.length + 1` AND the last message's id wasn't in the previous set. This skips initial loads, chat switches, and bulk re-fetches.
- For the messages list, `shouldAnimate` is computed as `msg.id === newMessageId && !suppressStreamReanimation`, where `suppressStreamReanimation = msg.role === 'assistant' && streamedIncrementallyChatId === chatId`. This means a saved assistant message for the chat that just streamed will NOT re-animate (chunks already animated individually), while a saved assistant message that did not come from incremental streaming — or a new user message — animates normally.
- For streaming plain-text blocks (`kind: 'text'` in `streamingBlocks`), MessageStream renders `<MessageBubble role="assistant" content={block.content} isStreaming={isStreaming && isLastBlock} />` — the same component as the persisted message, so Markdown formats live and there's no raw→formatted snap (or newline-handling shift) on the streaming→saved swap. `MessageBubble` defers `rehype-highlight` while `isStreaming`. There is no per-delta span animation.
- Streaming `thinking`, `tool`, and `tool_result` kinds still use `ThinkingBlock` / `ToolNarrationBlock` / `ToolResultBlock` with their joined `content` (block-level fade; `tool_result` uses a `<pre>` body instead of Markdown).

### ThinkingBlock + ToolNarrationBlock

- `src/renderer/src/components/chat/ThinkingBlock.tsx` and `src/renderer/src/components/chat/ToolNarrationBlock.tsx`
- Shared **lightweight collapsible** pattern: outer `div` has `rounded-lg border transition-colors duration-200`. When `expanded` is false, border and background are `transparent` — the block is visually flat (just the header row). When `expanded` is true, border becomes `border-[var(--color-border)]/60` and background becomes `bg-[var(--color-bg-secondary)]/40`, fading in via the transition. Header is a button with chevron + icon (Brain / Wrench) + label, body is markdown rendered at `opacity-80–90`. Body shows when expanded via conditional render.
- `defaultExpanded` defaults to `!!isStreaming` — auto-expanded while streaming so the user sees content as it arrives, collapsed on rerender after persistence.
- `isStreaming` adds a small pulsing accent dot in the header.
- `ToolNarrationBlock`'s header reads `Tool: <toolName>` when `toolName` is provided, otherwise just `Tool`. When verbose mode is on AND `toolInput` is also provided (`cinna.tool_input` metadata), the header swaps in the `<ToolCallSummary variant="inline">` rendering — `name(arg: value, …)` — instead of the bare label. The expanded body always renders the structured summary block when `toolInput` is present, regardless of verbose mode.
- `ToolNarrationBlock` reads `useUIStore((s) => s.verboseMode)` directly for the header decision (no prop-drilling). The `defaultExpanded` prop is still owned by `MessageStream` because it represents the initial-mount expansion state, not a reactive flag.

### Part-routing in MessageStream

For persisted assistant messages with `msg.parts`, `MessageStream` maps each `MessagePart` to a block via a switch on `part.kind` (`thinking` → ThinkingBlock, `tool` → ToolNarrationBlock, `tool_result` → ToolResultBlock, `text` → MessageBubble). Wrapped in a `space-y-2` container for visual separation. For streaming, the same routing happens against `streamingBlocks` entries — the kind-specific merge logic in the store (text/thinking on kind, tool on kind+toolName, tool_result on kind+toolId+toolStream) ensures consecutive deltas collapse into a single block where appropriate while different kinds — and stdout vs. stderr chunks — split into separate blocks.

### ToolCallBlock

- `src/renderer/src/components/chat/ToolCallBlock.tsx`
- **Badge line above, card below.** The clickable header (chevron + badge + status icon) is a borderless row with a left→right gradient hover (`hover:bg-gradient-to-r hover:from-[var(--color-bg-hover)] hover:to-transparent`). The detail (method/input/result) renders in a separate rounded, bordered card (`mt-1 rounded-lg border bg-[var(--color-bg-secondary)]`) **below** the badge line, revealed on expand.
- **Icon convention:** MCP tool calls (a `provider` name is present) show a connector `Plug` (size 10) inside an accent pill badge; a tool with no provider (generic/local, e.g. `bash`) shows a `Wrench` (size 11). `Wrench` is reserved for generic/local tools across the app; `Plug` denotes MCP everywhere (matches the Sidebar "MCP Providers" nav and on-demand-MCP chips).
- Status icon (`Loader2` while pending, `X` on error) renders inline right after the badge. (The old top shimmer progress bar was dropped with the restructure; the spinning `Loader2` carries the pending affordance.)
- Expand/collapse uses CSS grid row transition (`grid-template-rows: 0fr -> 1fr`).
- `AgentToolSubThread` mirrors this badge-line/card structure for orchestrated agent-backed tool calls.

### SystemMessage (inline in MessageStream)

- `src/renderer/src/components/chat/MessageStream.tsx:SystemMessage` <!-- nocheck -->
- Rendered from DB-persisted `role: 'error'` messages (JSON content `{short, detail}`). Errors survive navigation — no transient state involved.
- Centered flex container with `border-[var(--color-danger)]/30` and `bg-[var(--color-danger)]/8`.
- `AlertTriangle` icon + short error text.
- Expandable detail section toggled by a `ChevronRight` button; detail renders in a `pre` block with max height and scroll.

### Loading indicator

- Inline in `MessageStream` — three `span` dots with staggered `animationDelay` and `animate-bounce`. No wrapper bubble or icon.
