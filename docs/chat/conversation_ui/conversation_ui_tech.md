# Conversation UI — Technical Details

## File Locations

### Renderer

| File | Role |
|------|------|
| `src/renderer/src/components/chat/MessageStream.tsx` | Orchestrates the conversation: maps messages to bubbles, thinking/tool narration cards, tool blocks, loading dots, and error boxes. For assistant messages with structured `parts[]`, renders one block per part keyed by `kind`. For streaming, routes each `streamingBlocks` entry to the matching block component. Contains inline `SystemMessage` component. Detects newly-sent messages via a `prevRef` (chatId + previous messageIds) to drive entry animations. |
| `src/renderer/src/components/chat/MessageBubble.tsx` | Renders a single message. Branches on `role`: user -> right-aligned bubble; assistant -> full-width plain text. Supports streaming cursor, meta popup, and an `animate` prop that triggers the role-specific entry animation. |
| `src/renderer/src/components/chat/ThinkingBlock.tsx` | Collapsible dimmed card for `thinking`-kind parts. Brain icon header, italic markdown body. `isStreaming` prop adds a pulsing accent dot in the header and defaults the card to expanded; persisted thinking parts default to collapsed. |
| `src/renderer/src/components/chat/ToolNarrationBlock.tsx` | Collapsible dimmed card for `tool`-kind parts. Wrench icon header, `Tool: <toolName>` label (toolName comes from `cinna.tool_name` metadata), markdown body. Same expand/streaming behaviour as ThinkingBlock. |
| `src/renderer/src/components/chat/ToolCallBlock.tsx` | Collapsible MCP tool-call row (distinct from ToolNarrationBlock). Borderless when collapsed, bordered on hover/expand. Parses MCP content-block arrays and JSON for structured result display. |
| `src/renderer/src/assets/main.css` | CSS variable definitions (`--color-user-bubble`, `--color-border`, `--color-danger`, etc.) and entry-animation keyframes (`user-bubble-pop`, `user-bubble-content-in`, `assistant-bubble-in`). |

### State

| File | Role |
|------|------|
| `src/renderer/src/stores/chat.store.ts` | Zustand store holding `streamingBlocks` (text blocks now carry `kind` and optional `toolName`), `isStreaming`. `appendDelta(text, kind?, toolName?)` merges into the last block only when `kind` AND `toolName` match — otherwise pushes a new block |
| `src/renderer/src/hooks/useChat.ts` | TanStack Query hook `useChatDetail(chatId)` — provides persisted messages (each may carry `parts[]` for structured rendering) |
| `src/renderer/src/hooks/useChatStream.ts` | `handleAgent` reads `event.kind` and `event.toolName` from the delta payload and forwards them to `appendDelta` |
| `src/shared/messageParts.ts` | Shared `ContentKind` and `MessagePart` types — single source of truth for both store and rendering |

## Renderer Components

### MessageBubble

- `src/renderer/src/components/chat/MessageBubble.tsx`
- **User path**: wraps content in a right-aligned `rounded-xl` div with `bg-[var(--color-user-bubble)]`, max 80% width. No icon. When the `animate` prop is true, the bubble div gets `anim-user-bubble-pop` (scale + border-radius from a small circle to the full bubble, `transform-origin: top right`) and an inner div wrapping the Markdown gets `anim-user-bubble-content` (delayed opacity fade so the bubble appears before the text).
- **Assistant path**: renders Markdown directly in a full-width div, no background. Appends a pulsing accent cursor when `isStreaming` is true. When the `animate` prop is true, the wrapping div gets `anim-assistant-bubble` (1s opacity + `filter: blur` fade applied to the whole block — markdown/HTML is never split).
- **Meta popup**: optional `MetaPopup` shown on hover (info icon) for assistant messages with metadata.

### Entry-animation triggering (in MessageStream)

- `prevRef` holds `{ chatId, messageIds }` from the previous render. A message is considered "new" only when `chatId` matches the previous render AND `messages.length === prev.messageIds.length + 1` AND the last message's id wasn't in the previous set. This skips initial loads, chat switches, and bulk re-fetches.
- For the messages list, `animate` is passed only when `msg.role === 'user' && msg.id === newMessageId` — saved assistant bubbles never animate, which prevents a flicker when the streaming bubble unmounts and the saved bubble mounts in its place.
- For streaming text blocks (rendered from `streamingBlocks`), `animate` is hard-coded to `true` so the assistant fade plays once when the streaming bubble mounts. Subsequent text deltas don't re-trigger the animation (CSS animations only run on mount unless the animation property changes).

### ThinkingBlock + ToolNarrationBlock

- `src/renderer/src/components/chat/ThinkingBlock.tsx` and `src/renderer/src/components/chat/ToolNarrationBlock.tsx`
- Shared **lightweight collapsible** pattern: outer `div` has `rounded-lg border transition-colors duration-200`. When `expanded` is false, border and background are `transparent` — the block is visually flat (just the header row). When `expanded` is true, border becomes `border-[var(--color-border)]/60` and background becomes `bg-[var(--color-bg-secondary)]/40`, fading in via the transition. Header is a button with chevron + icon (Brain / Wrench) + label, body is markdown rendered at `opacity-80–90`. Body shows when expanded via conditional render.
- `defaultExpanded` defaults to `!!isStreaming` — auto-expanded while streaming so the user sees content as it arrives, collapsed on rerender after persistence.
- `isStreaming` adds a small pulsing accent dot in the header.
- `ToolNarrationBlock`'s header reads `Tool: <toolName>` when `toolName` is provided, otherwise just `Tool`.

### Part-routing in MessageStream

For persisted assistant messages with `msg.parts`, `MessageStream` maps each `MessagePart` to a block via a switch on `part.kind` (`thinking` → ThinkingBlock, `tool` → ToolNarrationBlock, `text` → MessageBubble). Wrapped in a `space-y-2` container for visual separation. For streaming, the same routing happens against `streamingBlocks` entries — the `(kind, toolName)`-keyed merge logic in the store ensures consecutive deltas of the same kind/tool collapse into a single block while different kinds split into separate blocks.

### ToolCallBlock

- `src/renderer/src/components/chat/ToolCallBlock.tsx`
- Outer container uses conditional border: `border-transparent` when collapsed, `border-[var(--color-border)]` on hover (`hover:border-...`) or when `expanded` state is true.
- Status icon (`Loader2` / `Check` / `X`) renders inline right after the tool name.
- Progress bar: a shimmer animation (`animate-[shimmer_...]`) at the top of the block while status is `pending`.
- Expand/collapse uses CSS grid row transition (`grid-template-rows: 0fr -> 1fr`).

### SystemMessage (inline in MessageStream)

- `src/renderer/src/components/chat/MessageStream.tsx:SystemMessage` <!-- nocheck -->
- Rendered from DB-persisted `role: 'error'` messages (JSON content `{short, detail}`). Errors survive navigation — no transient state involved.
- Centered flex container with `border-[var(--color-danger)]/30` and `bg-[var(--color-danger)]/8`.
- `AlertTriangle` icon + short error text.
- Expandable detail section toggled by a `ChevronRight` button; detail renders in a `pre` block with max height and scroll.

### Loading indicator

- Inline in `MessageStream` — three `span` dots with staggered `animationDelay` and `animate-bounce`. No wrapper bubble or icon.
