# Provider Integration

## Purpose

Reference for how several different LLM APIs (Anthropic, OpenAI, Gemini, and a local Ollama) are made to behave like one to the rest of the app. Documents the unified surface, what each adapter must translate, and known per-provider quirks.

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

| Axis | Anthropic | OpenAI | Gemini | Ollama |
|------|-----------|--------|--------|--------|
| **SDK call** | `client.messages.stream()` | `client.chat.completions.create({ stream: true })` | `chat.sendMessageStream()` (built from `getGenerativeModel().startChat({ history })`) | `OpenAIAdapter.stream()` verbatim, against `<host>/v1` |
| **System prompt** | Top-level `system` field | First message with `role: 'system'` | `systemInstruction` on `getGenerativeModel()` | OpenAI's |
| **Tool definition** | `input_schema` accepts JSON Schema verbatim | `parameters` accepts JSON Schema verbatim | `parameters` is a proto `Schema` (OpenAPI-3 subset) — JSON Schema must be translated, see [Tool Schema Translation](./tool_schema_translation.md) | OpenAI's |
| **Tool-call extraction** | `contentBlock` event of type `tool_use` | Accumulate streamed `delta.tool_calls[i].function.arguments` JSON across chunks | `chunk.candidates[0].content.parts` of type `functionCall` | OpenAI's |
| **Tool-call ID** | Provider-supplied `block.id` | Provider-supplied `tool_call.id` | Provider does **not** emit IDs — adapter generates `gemini-<nanoid>` | OpenAI's |
| **Tool result back to model** | `role: 'user'` with `tool_result` content block referencing `tool_use_id` | `role: 'tool'` with `tool_call_id` | `role: 'function'` Content with `functionResponse` part (SDK validates role; `'user'` is rejected) | OpenAI's |
| **Result content shape** | String | String | Plain object — adapter wraps MCP `[{type:'text', text:...}]` arrays as `{ result: '<joined text>' }` | String |
| **Error parsing** | `status` on SDK `APIError`, with the sentence read from the error body's `error.message` — the SDK's own `message` is the body as JSON; `overloaded_error` matched by type, because a mid-stream overload has no status | `status` property on SDK `APIError`, with `insufficient_quota` matched by `code` **before** the status table — it is a 429 and would otherwise read as a rate limit, and mid-stream it carries no status | Status parsed from `[<code> <statusText>]` substring in message; safety reasons (`SAFETY`/`RECITATION`/`BLOCKED`) detected from response error string | Connection `code` (`ECONNREFUSED`/`ENOTFOUND`/…) and `TimeoutError` first — the failure is usually a process that isn't running, not an account |
| **Credential** | Encrypted API key | Encrypted API key | Encrypted API key | **None** — a host in `base_url`; the SDK is handed `KEYLESS_PLACEHOLDER_KEY`, which Ollama ignores |
| **Model listing** | `client.beta.models.list()` | `client.models.list()`, filtered | REST `v1beta/models` | Native `GET /api/tags`, **not** `/v1/models` — only the native listing returns `parameter_size`, and that is what a local model's Work Complexity tier is made of |

## Known Quirks

### Gemini: schema sanitization

`function_declarations[].parameters` is **not** JSON Schema — it's the `Schema` message of the v1beta API (a narrow OpenAPI-3.0 subset). Its proto JSON parser rejects the *whole request* on the first field it doesn't recognize, so one stray keyword from one MCP server kills every tool call in the chat:

```
[400 Bad Request] Invalid JSON payload received. Unknown name "const" at
'tools[0].function_declarations[1].parameters.properties[1].value': Cannot find field.
```

`geminiSchema.ts` therefore allowlists the 22 fields Gemini documents, translates the keywords that have an equivalent (`const` → single-value `enum`, `$ref` → inlined `$defs`, `oneOf` → `anyOf`, `allOf` → merge, tuple `items` → first position), and degrades what it can't express rather than throwing. Anthropic and OpenAI tolerate all of the above and pass `inputSchema` through verbatim.

Full rules, the translation table, known limitations, and how to re-derive the field list: [Tool Schema Translation](./tool_schema_translation.md).

### Gemini: `function` role for tool responses

The SDK's `VALID_PARTS_PER_ROLE` table maps `functionResponse` to `role: 'function'` only — `role: 'user'` is rejected with `"Content with role 'user' can't contain 'functionResponse' part"`. History entries for `tool_call` messages must be pushed as `role: 'function'`. The `sendMessageStream` last-message path auto-assigns the role via the SDK's `assignRoleToPartsAndValidateSendMessageRequest`, so only history insertion needs explicit handling.

### Gemini: response wrapping

MCP servers return content as `[{ type: 'text', text: '...' }, ...]` arrays. Gemini's `functionResponse.response` requires a plain object. The adapter joins text blocks and wraps as `{ result: '<joined>' }`; structured JSON results are passed through if already an object.

### OpenAI: streamed tool argument accumulation

`delta.tool_calls[i].function.arguments` arrives as JSON-string fragments across chunks indexed by `delta.tool_calls[i].index`. The adapter accumulates per index, then JSON-parses the assembled string at stream end.

### Anthropic: dynamic model list via beta endpoint

`client.beta.models.list()` is the source of truth — no hardcoded fallback. Errors propagate so a bad test key surfaces the real cause rather than a stale picker.

### Anthropic: the SDK's error message is the JSON body

The API's error body is `{type:'error', error:{type, message}}` — no top-level `message` — so the SDK builds `APIError.message` as the status followed by the whole body serialised as JSON, and the sentence the API wrote sits one level down at `error.error.message`. `parseError()` reads it from there and keeps the status prefix. Until it did, every `detail` the user was shown was that envelope, and an overload arriving inside an open stream — an SSE `error` event, which the SDK throws as an `APIError` with **no HTTP status** and the API's `type` on the error — missed the status table and put the envelope, truncated at 120 characters, on the `short` line as well. The mid-stream case is matched on `type === 'overloaded_error'`; it is the same failure a 529 is outside a stream and reads the same way. Both behaviours are the SDK's since at least 0.89 — the defect was found by `src/main/llm/anthropic.test.ts`, written for the 0.93 bump, not caused by the bump.

### OpenAI: an abort is a clean end of stream, so the adapter has to reject itself

The SDK's SSE reader treats a cancellation as the stream simply finishing — `Stream`'s iterator catches the `AbortError` and **returns** — so the adapter's `for await` loop ended normally and `stream()` resolved with whatever text had arrived. Nothing downstream could tell that from a completed turn: the partial text was saved as the assistant's message, `done` went to the renderer, and the job run was recorded as a success. The adapter now checks its own signal after the loop and throws `APIUserAbortError`, which is what Anthropic and Gemini did all along. The stale-`running` half of that failure is documented in [Jobs](../../jobs/jobs/jobs.md#business-rules).

### OpenAI: `insufficient_quota` is a 429, and must be matched before the status table

An exhausted quota comes back as HTTP **429** with `code: 'insufficient_quota'`, so a status table checked first calls it a rate limit and sends the user off to wait and retry — for a state that waiting never clears. The check therefore sits **above** the table in `parseError()`. Position also buys the mid-stream case: arriving inside an open stream the SDK builds the error with no HTTP status at all, which the table cannot reach either.

### OpenAI: the client fills its own base URL, organisation and project from the environment

`baseURL` from `OPENAI_BASE_URL`, `organization` / `project` from `OPENAI_ORG_ID` / `OPENAI_PROJECT_ID` — the last two sent as `OpenAI-Organization` and `OpenAI-Project` headers on every request. The constructor pins all three, with the base URL as a **default** rather than a constant because `openai_compatible` and Ollama construct the same adapter with a real base URL. Unlike the Anthropic SDK there is no custom-headers variable, so nothing in a shell can replace the stored key itself. See [LLM Adapters — Technical Details](adapters_tech.md#the-openai-adapter-and-the-same-hole-in-another-sdk).

### OpenAI: model filtering

`client.models.list()` returns embeddings, audio, image, moderation, and instruct models alongside chat models. The adapter filters to `gpt-*`, `o<digit>-*`, `chatgpt-*` and excludes embeddings/audio/realtime/image/whisper/tts/dall-e/moderation/instruct/fine-tunes, sorted newest first.

### Ollama: two protocols, and why the listing is the native one

`/v1` is complete enough for generation — streaming and tool calls arrive in the OpenAI wire format — so `stream()` is `OpenAIAdapter`'s, delegated to rather than reimplemented. `/v1/models`, though, returns bare ids. `/api/tags` returns the family, the parameter size and the quantisation, and the parameter size is the whole basis of a local model's Work Complexity tier: `deepseek-r1:latest` is a 7B and says so nowhere in its name.

### Ollama: embedding models the shared filter misses

The shared `isChatCapableModelId` looks for `embedding`, and the Ollama registry almost never spells it that way — `nomic-embed-text`, `mxbai-embed-large`, `snowflake-arctic-embed2`, `all-minilm`, `bge-m3`. The adapter adds a pattern matching `embed` as its own token plus the families that name themselves after the architecture. Without it every one of them appeared in the model picker as something to chat with and answered the first turn with a 400.

### Ollama: a tag is user-controlled, so capability matching is loose

The same weights can be `llava:13b`, `llava:latest`, or whatever a `Modelfile` called them, so vision support is matched against a list of **families** with open version ranges. Wrong in the permissive direction costs an attach button that produces a confused answer; wrong in the strict direction hides the button on a model that would have worked, which is harder to diagnose because nothing appears at all.

### Ollama: two timeouts, because the two calls sit on different paths

Listing gets 1.5 s because `getAllModels()` walks the adapters sequentially with no cache, before every engine start and on every `provider:list-models` — a loopback server that is down refuses instantly, but a powered-off box on the LAN hangs. Probing gets 5 s because it is a foreground action the user asked for and its whole job is to wait long enough to be believed: a false "nothing answered" about a slow LAN host sends the user to fix something that is not broken.

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

## Adding Another Provider

1. Create `src/main/llm/<provider>.ts` implementing `LLMAdapter`. <!-- nocheck -->
2. Fill in the five translations in `stream()` using the matrix above as a checklist.
3. Check the provider's tool-schema acceptance before passing `inputSchema` through. If it's stricter than JSON Schema (like Gemini), add a sanitizer function in the adapter file — keep it local, not shared, until a second provider needs the same fix.
4. Implement `parseError()` covering rate limit (429), auth (401/403), not found (404), 5xx, and any provider-specific safety/content blocks. Do not assume a status: an error raised inside an open stream can carry none, and it must still map to a sentence rather than fall through to the raw message — see the Anthropic quirk above.
5. Add the type to `createAdapter()` in `src/main/llm/factory.ts` and the `ProviderType` union + `isProviderType` predicate.
6. If it needs no credential, add it to `KEYLESS_PROVIDER_TYPES` in `src/shared/credentials.ts` rather than teaching any call site about it — see [Local Models & Keyless Credentials](../local_models/local_models.md).
7. If a folder agent should be able to run on it, it also needs an `EngineProviderType`, a `PROVIDER_NPM` package and a `CUSTOM_MODEL_LIMITS` row — see [The Local Engine](../../agents/local_agents/engine.md).
8. Update [Adapters](./adapters.md) "Current Adapters" and this matrix.

## Integration Points

- [Adapters](./adapters.md) — High-level abstraction, configuration UX, registry lifecycle
- [Local Models & Keyless Credentials](../local_models/local_models.md) — the Ollama adapter's host, detection probe and tiering rules
- [Adapters Tech](./adapters_tech.md) — File paths, IPC channels, DB schema
- [Tool Schema Translation](./tool_schema_translation.md) — MCP JSON Schema → each provider's tool-definition shape, and what Gemini's subset costs
- [Chat Messaging](../../chat/messaging/messaging.md) — The tool-call loop in `chatStreamingService` that drives every adapter
- [MCP Connections](../../mcp/connections/connections.md) — Source of `ToolDefinition[]` with raw MCP `inputSchema`
