# Plan: Proper Message History Abstraction

## Problem

- Only user + final assistant text are saved to DB — tool interactions are lost on reload
- `ChatMessage` is too flat: can't represent assistant turns with tool calls
- Tool-call loop is duplicated across 3 adapters (Anthropic, OpenAI, Gemini)
- No universal message format — each adapter has its own internal representation

## Architecture Change

**Move the tool-call loop out of adapters into `llm.ipc.ts`.** Adapters become single-turn streamers. The IPC handler owns the loop, DB saves, and renderer notifications.

## Universal Message Format

```typescript
// types.ts
interface ToolCallInfo {
  id: string
  name: string
  input: Record<string, unknown>
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool_call'
  content: string
  toolCalls?: ToolCallInfo[]   // on assistant messages that invoked tools
  toolCallId?: string          // on tool_call — links back to the assistant turn
  toolName?: string            // on tool_call — for display
  toolInput?: Record<string, unknown>  // on tool_call — for display
  toolError?: boolean          // on tool_call — whether execution failed
}
```

A conversation with tools looks like:

| # | role | content | toolCalls | toolCallId |
|---|------|---------|-----------|------------|
| 1 | user | "search for X" | — | — |
| 2 | assistant | "Let me check..." | `[{id:"tc1", name:"search", input:{...}}]` | — |
| 3 | tool_call | `"result text"` | — | `"tc1"` |
| 4 | assistant | "Here's what I found..." | — | — |

Each `tool_call` row is self-contained: it has the tool name, input, result (content), error flag, and a link back to the assistant turn that triggered it.

## Tasks (7 steps)

### 1. `types.ts` — New message types, simplify adapter interface

- Add `ToolCallInfo` type
- Update `ChatMessage` with `toolCalls` array, `toolError` flag, role `'tool_call'`
- Replace `StreamParams` callbacks: remove `onToolUse`, `onDone`, `onError`
- Adapter `stream()` returns `Promise<StreamResult>` (`{content, toolCalls}`) and throws on error
- Keep only `onDelta` callback for streaming text to renderer

```typescript
interface StreamResult {
  content: string
  toolCalls: ToolCallInfo[]
}

interface StreamParams {
  model: string
  messages: ChatMessage[]
  tools?: ToolDefinition[]
  signal?: AbortSignal
  onDelta: (text: string) => void
}
```

### 2. `schema.ts` + `client.ts` — DB migration

- Add `tool_calls` JSON column to `messages` table
- Add `tool_error` integer/boolean column to `messages` table
- Drizzle schema:
  ```typescript
  toolCalls: text('tool_calls', { mode: 'json' }).$type<ToolCallInfo[]>()
  toolError: integer('tool_error', { mode: 'boolean' })
  ```
- Migration SQL:
  ```sql
  ALTER TABLE messages ADD COLUMN tool_calls TEXT;
  ALTER TABLE messages ADD COLUMN tool_error INTEGER;
  UPDATE messages SET role = 'tool_call' WHERE role = 'tool';
  ```

### 3. Simplify all 3 adapters (anthropic, openai, gemini)

- **Remove** the tool-call loop from each adapter
- `stream()` does a single LLM turn: stream deltas, collect tool calls, return `StreamResult`
- **Update `convertMessages()`** to handle the new `ChatMessage` format:
  - **Anthropic**: assistant with `toolCalls` -> `{role:'assistant', content: [text_block, ...tool_use_blocks]}`; `tool_call` -> `{role:'user', content: [{type:'tool_result', tool_use_id, content}]}`
  - **OpenAI**: assistant with `toolCalls` -> `{role:'assistant', content, tool_calls: [...]}`; `tool_call` -> `{role:'tool', tool_call_id, content}`
  - **Gemini**: assistant with `toolCalls` -> `{role:'model', parts: [text, ...functionCall_parts]}`; `tool_call` -> `{role:'user', parts: [{functionResponse: {name, response}}]}` (response must be a plain object, not array — normalize MCP content blocks)

### 4. `llm.ipc.ts` — Tool-call loop + incremental DB saves

Single tool loop (replaces 3 adapter loops):

```
for round in 0..MAX_TOOL_ROUNDS:
  result = await adapter.stream(currentMessages, {onDelta})
  save assistant message to DB (with toolCalls if any)
  if no toolCalls -> done
  for each toolCall:
    notify renderer (tool_use event)
    execute via mcpManager.callTool()
    notify renderer (tool_result / tool_error)
    save tool_call message to DB (with toolCallId, toolName, toolInput, content, toolError)
  append assistant + tool_call messages to currentMessages
```

Every message is saved as it happens — reload preserves full history.

Helper to get next sort order:
```typescript
function getNextSortOrder(db, chatId): number {
  const last = db.select({sortOrder: messages.sortOrder})
    .from(messages).where(eq(messages.chatId, chatId))
    .orderBy(desc(messages.sortOrder)).limit(1).get()
  return last ? last.sortOrder + 1 : 0
}
```

### 5. `MessageStream.tsx` — Render rich history from DB

- `user` messages: `MessageBubble` (right-aligned)
- `assistant` messages with content: `MessageBubble` (left-aligned); skip rendering if content is empty (tool-only turn)
- `tool_call` messages: `ToolCallBlock` with name (`toolName`), input (`toolInput`), result (`content`), status derived from `toolError` flag
- Streaming blocks (live) work as-is from `chat.store.ts`

### 6. `chat.store.ts` — Clear blocks on stop

- `stopStreaming()` clears `streamingBlocks` so there's no duplication when DB messages load after refetch

```typescript
stopStreaming: () =>
  set({ isStreaming: false, streamingBlocks: [], activeRequestId: null }),
```

### 7. Validate end-to-end

- Build: `npx electron-vite build`
- Type-check renderer: `npx tsc --noEmit --project tsconfig.web.json`
- Manual test:
  - Send message with MCP tool -> verify tool calls render during streaming (spinner, name, expanding details)
  - Wait for response -> verify final text appears after tool calls
  - Reload chat -> verify full history renders with tool calls (expandable, showing input/result)
  - Test multi-round tool loop (LLM calls tool, gets result, calls another tool)
  - Test tool error scenario

## Key Design Decisions

- **Tool loop in IPC, not adapters** — single place for DB saves and renderer notifications; adapters stay simple (one turn, no side effects)
- **`tool_call` rows are self-contained** — each stores `toolName`, `toolInput`, `toolCallId`, `content`, `toolError` so it can render without looking up the parent assistant message
- **Streaming blocks are ephemeral** — cleared when streaming ends; DB history is the source of truth after that
- **`tool_call` not `tool_result`** — the row represents the whole tool call event (invocation + result), not just the response

## Files Changed

| File | Change |
|------|--------|
| `src/main/llm/types.ts` | New types (`ToolCallInfo`, `StreamResult`), simplified adapter interface |
| `src/main/db/schema.ts` | Add `toolCalls`, `toolError` columns |
| `src/main/db/client.ts` | Migration for new columns + role rename |
| `src/main/llm/anthropic.ts` | Remove loop, simplify `stream()`, update `convertMessages()` |
| `src/main/llm/openai.ts` | Same |
| `src/main/llm/gemini.ts` | Same |
| `src/main/ipc/llm.ipc.ts` | Add tool loop, incremental DB saves |
| `src/renderer/src/components/chat/MessageStream.tsx` | Render `tool_call` from DB history |
| `src/renderer/src/stores/chat.store.ts` | Clear blocks on `stopStreaming` |
