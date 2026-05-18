# LLM Adapters

## Purpose

Unified abstraction layer over multiple LLM provider SDKs (Anthropic, OpenAI, Gemini), enabling the chat system to stream responses and handle tool calls without knowing which provider is being used.

## Core Concepts

- **LLMAdapter** — Interface that all provider adapters implement: `listModels()`, `stream()` (returns `StreamResult`), `parseError()`
- **Provider** — A configured LLM service with an encrypted API key, stored in the database
- **Registry** — In-memory map of provider ID to instantiated adapter, populated on app startup
- **Model** — A specific LLM model offered by a provider (e.g., Claude Sonnet 4, GPT-4o)

## User Stories / Flows

### Adding a new LLM provider
1. User goes to Settings > LLM Providers
2. Clicks "Add Provider", selects type (Anthropic/OpenAI/Gemini)
3. Enters API key, clicks "Test Connection" — system validates by calling `listModels()`
4. On success, provider is saved with encrypted key; user can set it as default and pick a default model

### Switching models mid-session
1. User opens model dropdown in the chat controls
2. Dropdown shows models from all enabled providers, grouped by provider
3. Selecting a model updates the chat's provider + model binding

## Business Rules

- Each provider type has its own SDK, streaming protocol, tool-calling format, and error handling
- API keys are encrypted via `safeStorage` and never leave the main process
- Only one provider can be marked as default at a time (setting one clears others)
- Each provider can have a default model; used when creating new chats
- Adapters are single-turn streamers: they translate ChatMessage[] to native format, stream text deltas via `onDelta`, collect tool calls, and return a `StreamResult` (`{content, toolCalls}`)
- Adapters do NOT own the tool-call loop — `chatStreamingService` runs the loop, executes tools, and calls the adapter again for each round
- Shared concerns (tool execution, MCP aggregation, message persistence, tool loop orchestration) live in `chatStreamingService`

## Why a Custom Abstraction Over a Framework

- **No framework covers all providers well** — Google ADK-JS only ships Gemini adapters; others have similar gaps or lag behind SDK releases
- **Electron constraints** — Frameworks pull in server dependencies (Express, ORM, telemetry) that bloat the app and conflict with Electron's process model
- **Narrow scope** — We only need chat + tool calling; agent orchestration and planning loops are out of scope
- **Full control** — MessagePort streaming, SQLite persistence, and MCP integration are tightly coupled to Electron's IPC model

## Architecture Overview

```
chatStreamingService -> getAdapter(providerId) [from registry]
  -> AnthropicAdapter / OpenAIAdapter / GeminiAdapter
  -> adapter.stream(params) -> streams deltas via onDelta, returns StreamResult {content, toolCalls}
  -> chatStreamingService owns the tool-call loop: executes tools, saves to DB, calls adapter again
  -> Results streamed back via MessagePort

providerService -> createAdapter(type, apiKey, providerId) [llm/factory.ts]
  -> register/unregister in the registry on upsert/delete
```

## Current Adapters

- **Anthropic** — `client.messages.stream()`, dynamic model list via `client.beta.models.list()` (no hardcoded fallback — propagates errors so test-key surfaces them), collects `tool_use` content blocks into `StreamResult.toolCalls`
- **OpenAI** — `client.chat.completions.create({ stream: true })`, dynamic model list via `client.models.list()` filtered to chat-capable IDs (`gpt-*`, `o<digit>-*`, `chatgpt-*`; excludes embeddings/audio/realtime/image/whisper/tts/dall-e/moderation/instruct/fine-tunes), sorted newest first, display name humanized from the id; accumulates partial tool call args during streaming, returns them in `StreamResult`
- **Gemini** — `chat.sendMessageStream()`, dynamic model list via the REST `v1beta/models` endpoint filtered to `supportedGenerationMethods.includes('generateContent')` (SDK doesn't expose list-models); collects `functionCall` parts into `StreamResult.toolCalls`

No adapter hardcodes versioned model IDs anywhere — listing is always live against the provider's API. If listing fails (network, invalid key, region restriction) the error surfaces through `providerService.testKey()` so the user sees the real cause rather than a stale picker.

## Adding a New Provider

1. Create `src/main/llm/<provider>.ts` implementing `LLMAdapter` <!-- nocheck -->
2. Add the provider type to the `type` union in the DB schema and TypeScript types
3. Implement `listModels()` (fetch dynamically or hardcode)
4. Implement `stream()` as a single-turn streamer: stream deltas via `onDelta`, return `StreamResult` — no tool-call loop needed
5. Implement `parseError()` to map SDK errors to `{ short, detail }`
6. Register in `createAdapter()` in `src/main/llm/factory.ts` (and add to the `ProviderType` union + `isProviderType` predicate)

## Integration Points

- [Chat Messaging](../../chat/messaging/messaging.md) — Adapters are called by the streaming IPC handler
- [MCP Connections](../../mcp/connections/connections.md) — MCP tools are converted to each provider's tool schema format
- Database — Provider configs (with encrypted API keys) stored in `llm_providers` table
