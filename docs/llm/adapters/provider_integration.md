# Provider Integration

## Purpose

Reference for how three different LLM SDKs (Anthropic, OpenAI, Gemini) are made to behave like one to the rest of the app. Documents the unified surface, what each adapter must translate, and known per-provider quirks.

For the higher-level abstraction and configuration story see [Adapters](./adapters.md); for file paths and IPC channels see [Adapters Tech](./adapters_tech.md).

## Unified Surface vs Per-Adapter Translation

### Shared (lives in `chatStreamingService`)

- Tool-call loop (max 10 rounds, then bail)
- MCP tool aggregation and execution (`mcpManager.getToolsForProviders`, `mcpManager.callTool`)
- History load + replay from `messages` table
- Message persistence (assistant + tool_call rows saved per round)
- MessagePort streaming protocol (`request-id`, `delta`, `tool_use`, `tool_result`, `tool_error`, `done`, `error`)
- AbortController plumbing and cancel IPC
- Logging (`stream request`, `stream response`, `tool call`, `tool result`, `tool failed`)

### Per-adapter (lives in `src/main/llm/<provider>.ts`) <!-- nocheck -->

- `listModels()` — live fetch against the provider's models endpoint
- `stream({ model, messages, tools, onDelta, signal })` — single-turn streamer, returns `StreamResult { content, toolCalls }`
- `parseError(err)` — map SDK errors to `{ short, detail }`
- Five translations inside `stream()`:
  1. **Message history** — `ChatMessage[]` → provider's native conversation shape
  2. **Tool definitions** — JSON Schema `ToolDefinition[]` → provider's tool/function declaration shape
  3. **Tool-call extraction** — provider's streaming events → `ToolCallInfo[]`
  4. **Tool-result re-injection** — `ChatMessage { role: 'tool_call' }` → provider's tool-response shape
  5. **System prompt placement** — providers disagree on where it goes (top-level field vs first message)

## Per-Provider Translation Matrix

| Axis | Anthropic | OpenAI | Gemini |
|------|-----------|--------|--------|
| **SDK call** | `client.messages.stream()` | `client.chat.completions.create({ stream: true })` | `chat.sendMessageStream()` (built from `getGenerativeModel().startChat({ history })`) |
| **System prompt** | Top-level `system` field | First message with `role: 'system'` | `systemInstruction` on `getGenerativeModel()` |
| **Tool definition** | `input_schema` accepts JSON Schema verbatim | `parameters` accepts JSON Schema verbatim | `parameters` requires OpenAPI-3 subset — JSON Schema must be sanitized (see Quirks) |
| **Tool-call extraction** | `contentBlock` event of type `tool_use` | Accumulate streamed `delta.tool_calls[i].function.arguments` JSON across chunks | `chunk.candidates[0].content.parts` of type `functionCall` |
| **Tool-call ID** | Provider-supplied `block.id` | Provider-supplied `tool_call.id` | Provider does **not** emit IDs — adapter generates `gemini-<nanoid>` |
| **Tool result back to model** | `role: 'user'` with `tool_result` content block referencing `tool_use_id` | `role: 'tool'` with `tool_call_id` | `role: 'function'` Content with `functionResponse` part (SDK validates role; `'user'` is rejected) |
| **Result content shape** | String | String | Plain object — adapter wraps MCP `[{type:'text', text:...}]` arrays as `{ result: '<joined text>' }` |
| **Error parsing** | `status` property on SDK `APIError` | `status` property on SDK `APIError` | Status parsed from `[<code> <statusText>]` substring in message; safety reasons (`SAFETY`/`RECITATION`/`BLOCKED`) detected from response error string |

## Known Quirks

### Gemini: schema sanitization

Gemini's `function_declarations.parameters` accepts only a narrow OpenAPI-3 subset and hard-fails the entire request when it encounters standard JSON-Schema metadata that MCP servers commonly emit. `gemini.ts:sanitizeForGemini()` recursively strips:

- `$schema`
- `$id`
- `$ref`
- `$defs`
- `definitions`
- `additionalProperties`

Anthropic and OpenAI tolerate all of the above and pass `inputSchema` through verbatim. When the sanitizer drops anything it emits `logger.debug('schema sanitized', { tool, dropped })` so unexpected loss is traceable in the `⌘\`` log.

### Gemini: `function` role for tool responses

The SDK's `VALID_PARTS_PER_ROLE` table maps `functionResponse` to `role: 'function'` only — `role: 'user'` is rejected with `"Content with role 'user' can't contain 'functionResponse' part"`. History entries for `tool_call` messages must be pushed as `role: 'function'`. The `sendMessageStream` last-message path auto-assigns the role via the SDK's `assignRoleToPartsAndValidateSendMessageRequest`, so only history insertion needs explicit handling.

### Gemini: response wrapping

MCP servers return content as `[{ type: 'text', text: '...' }, ...]` arrays. Gemini's `functionResponse.response` requires a plain object. The adapter joins text blocks and wraps as `{ result: '<joined>' }`; structured JSON results are passed through if already an object.

### OpenAI: streamed tool argument accumulation

`delta.tool_calls[i].function.arguments` arrives as JSON-string fragments across chunks indexed by `delta.tool_calls[i].index`. The adapter accumulates per index, then JSON-parses the assembled string at stream end.

### Anthropic: dynamic model list via beta endpoint

`client.beta.models.list()` is the source of truth — no hardcoded fallback. Errors propagate so a bad test key surfaces the real cause rather than a stale picker.

### OpenAI: model filtering

`client.models.list()` returns embeddings, audio, image, moderation, and instruct models alongside chat models. The adapter filters to `gpt-*`, `o<digit>-*`, `chatgpt-*` and excludes embeddings/audio/realtime/image/whisper/tts/dall-e/moderation/instruct/fine-tunes, sorted newest first.

## Tool-Call Loop Contract

The adapter is a **single-turn streamer**. `chatStreamingService` owns iteration:

```
for round in 0..MAX_TOOL_ROUNDS:
  StreamResult = adapter.stream({ messages, tools, ... })
  save assistant message (with toolCalls if any)
  if no toolCalls: break
  for tc in toolCalls:
    result = mcpManager.callTool(tc.mcpProviderId, tc.name, tc.input)
    save tool_call message
    append tool_call message to history
  loop continues with updated history
```

An adapter must not call MCP, must not loop, must not persist. It receives history, emits one round, returns.

## Why a Custom Layer Instead of a Framework

- **No JS framework covers all three providers well** — Google ADK is Python-first (LiteLLM same); Vercel AI SDK covers them but reshapes streaming and tool-call models in ways that conflict with our MessagePort + SQLite persistence design.
- **Per-provider quirks (above) are real** — any abstraction still has to translate JSON Schema → Gemini's OpenAPI subset, and assign `role: 'function'` for Gemini tool responses. Owning the translation directly keeps these visible and fixable.
- **Narrow scope** — only chat + tool calling. Agent orchestration, planning, retrieval pipelines are out of scope, so a framework's surface area is mostly dead weight.

## Adding a Fourth Provider

1. Create `src/main/llm/<provider>.ts` implementing `LLMAdapter`. <!-- nocheck -->
2. Fill in the five translations in `stream()` using the matrix above as a checklist.
3. Check the provider's tool-schema acceptance before passing `inputSchema` through. If it's stricter than JSON Schema (like Gemini), add a sanitizer function in the adapter file — keep it local, not shared, until a second provider needs the same fix.
4. Implement `parseError()` covering rate limit (429), auth (401/403), not found (404), 5xx, and any provider-specific safety/content blocks.
5. Add the type to `createAdapter()` in `src/main/llm/factory.ts` and the `ProviderType` union + `isProviderType` predicate.
6. Update [Adapters](./adapters.md) "Current Adapters" and this matrix.

## Integration Points

- [Adapters](./adapters.md) — High-level abstraction, configuration UX, registry lifecycle
- [Adapters Tech](./adapters_tech.md) — File paths, IPC channels, DB schema
- [Chat Messaging](../../chat/messaging/messaging.md) — The tool-call loop in `chatStreamingService` that drives every adapter
- [MCP Connections](../../mcp/connections/connections.md) — Source of `ToolDefinition[]` with raw MCP `inputSchema`
