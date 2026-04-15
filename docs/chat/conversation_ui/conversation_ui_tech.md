# Conversation UI — Technical Details

## File Locations

### Renderer

| File | Role |
|------|------|
| `src/renderer/src/components/chat/MessageStream.tsx` | Orchestrates the conversation: maps messages to bubbles, tool blocks, loading dots, and error boxes. Contains inline `SystemMessage` component. |
| `src/renderer/src/components/chat/MessageBubble.tsx` | Renders a single message. Branches on `role`: user -> right-aligned bubble; assistant -> full-width plain text. Supports streaming cursor and meta popup. |
| `src/renderer/src/components/chat/ToolCallBlock.tsx` | Collapsible tool-call row. Borderless when collapsed, bordered on hover/expand. Parses MCP content-block arrays and JSON for structured result display. |
| `src/renderer/src/assets/main.css` | CSS variable definitions (`--color-user-bubble`, `--color-border`, `--color-danger`, etc.) |

### State

| File | Role |
|------|------|
| `src/renderer/src/stores/chat.store.ts` | Zustand store holding `streamingBlocks`, `streamError`, `isStreaming` |
| `src/renderer/src/hooks/useChat.ts` | TanStack Query hook `useChatDetail(chatId)` — provides persisted messages |

## Renderer Components

### MessageBubble

- `src/renderer/src/components/chat/MessageBubble.tsx`
- **User path**: wraps content in a right-aligned `rounded-xl` div with `bg-[var(--color-user-bubble)]`, max 80% width. No icon.
- **Assistant path**: renders Markdown directly in a full-width div, no background. Appends a pulsing accent cursor when `isStreaming` is true.
- **Meta popup**: optional `MetaPopup` shown on hover (info icon) for assistant messages with metadata.

### ToolCallBlock

- `src/renderer/src/components/chat/ToolCallBlock.tsx`
- Outer container uses conditional border: `border-transparent` when collapsed, `border-[var(--color-border)]` on hover (`hover:border-...`) or when `expanded` state is true.
- Status icon (`Loader2` / `Check` / `X`) renders inline right after the tool name.
- Progress bar: a shimmer animation (`animate-[shimmer_...]`) at the top of the block while status is `pending`.
- Expand/collapse uses CSS grid row transition (`grid-template-rows: 0fr -> 1fr`).

### SystemMessage (inline in MessageStream)

- `src/renderer/src/components/chat/MessageStream.tsx:SystemMessage` <!-- nocheck -->
- Centered flex container with `border-[var(--color-danger)]/30` and `bg-[var(--color-danger)]/8`.
- `AlertTriangle` icon + short error text.
- Expandable detail section toggled by a `ChevronRight` button; detail renders in a `pre` block with max height and scroll.

### Loading indicator

- Inline in `MessageStream` — three `span` dots with staggered `animationDelay` and `animate-bounce`. No wrapper bubble or icon.
