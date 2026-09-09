# LLM Adapters

## Purpose

Unified abstraction layer over multiple LLM provider SDKs (Anthropic, OpenAI, Gemini, OpenAI-compatible gateways, and a local Ollama server), enabling the chat system to stream responses and handle tool calls without knowing which provider is being used.

## Core Concepts

- **LLMAdapter** — Interface that all provider adapters implement: `listModels()`, `stream()` (returns `StreamResult`), `parseError()`
- **Provider** — A configured LLM service, stored in the database. Usually that means an encrypted API key; a **keyless** type (Ollama) is identified by a host in `base_url` and has no key at all. What every layer asks instead of testing for a key is `isCredentialUsable` in `src/shared/credentials.ts` — see [Local Models & Keyless Credentials](../local_models/local_models.md)
- **Registry** — In-memory map of provider ID to instantiated adapter, populated on app startup
- **Model** — A specific LLM model offered by a provider (e.g., Claude Sonnet 4, GPT-4o)

## User Stories / Flows

### Adding a new LLM provider
1. User goes to Settings > AI Credentials
2. Clicks "Add AI Credentials", selects type (Anthropic/OpenAI/Gemini/Ollama)
3. Enters an API key — or, for Ollama, a **host**, pre-filled from a detection probe — and clicks "Test", which validates by calling `listModels()`
4. On success, the credential is saved (key encrypted, or host stored in `base_url`); the user can pick a default model

### Switching models mid-session
1. User opens model dropdown in the chat controls
2. Dropdown shows models from all enabled providers, grouped by provider
3. Selecting a model updates the chat's provider + model binding

## Business Rules

- Each provider type has its own SDK, streaming protocol, tool-calling format, and error handling
- API keys are encrypted via `safeStorage` and never leave the main process
- **A key is not what makes a credential usable — `isCredentialUsable` is.** A keyless credential registers an adapter on `enabled` alone; requiring a key would leave a saved Ollama invisible to the model picker forever. Any layer that tests `hasApiKey` by hand is a layer that can disagree with the one beside it
- **`enabled` means off everywhere, including for the local engine.** Disabling a credential unregisters its adapter, so a chat on it fails with "Provider adapter not available" rather than falling back to another key — and `collectEngineProviders` leaves it out of the generated engine config, so folder agents running on it stop too. Every surface that named it says what stopped: see [Switching an AI Credential Off](credential_enablement.md). The predicate for "enabled *and* usable" is `isCredentialActive`
- **A renderer-supplied `baseUrl` is honoured only for keyless types.** Pointing a row that holds a real key at an arbitrary URL would send that key wherever the renderer said; a gateway's endpoint is written by account-config sync instead. A credential's `type` is likewise fixed at creation, since re-typing a row would keep its stored key and spend it under another transport
- **The credential row decides where a request goes and who it is billed to — the shell never does.** Each vendor SDK fills options the caller leaves unset from the process environment: a base URL, an auth token, custom headers, an organisation or project id. The app inherits a login shell's environment whenever it is launched from a terminal, so every adapter names those options explicitly instead of letting the client default them. Anthropic's are the widest (a custom-header line could replace the stored key outright); OpenAI's reach a host and two billing headers, and it has no custom-header variable at all. Both are pinned by tests that set the variables and assert nothing about the request moves
- **A cancelled turn must reject, not resolve.** A stop that comes back as a normal return is indistinguishable from a finished answer: the partial text is saved as the assistant's message and the job run behind it is recorded as a success. The OpenAI SDK's stream reader swallows the abort and ends the loop cleanly, so that adapter raises the abort itself — see [Provider Integration](provider_integration.md#openai-an-abort-is-a-clean-end-of-stream-so-the-adapter-has-to-reject-itself)
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
  -> AnthropicAdapter / OpenAIAdapter / GeminiAdapter / OllamaAdapter
  -> adapter.stream(params) -> streams deltas via onDelta, returns StreamResult {content, toolCalls}
  -> chatStreamingService owns the tool-call loop: executes tools, saves to DB, calls adapter again
  -> Results streamed back via MessagePort

providerService -> createAdapter(type, apiKey, providerId, {baseUrl, fallbackModels}) [llm/factory.ts]
  -> register/unregister in the registry on upsert/delete
```

## Current Adapters

- **Anthropic** — `client.messages.stream()`, dynamic model list via `client.beta.models.list()` (no hardcoded fallback — propagates errors so test-key surfaces them), collects `tool_use` content blocks into `StreamResult.toolCalls`
- **OpenAI** — `client.chat.completions.create({ stream: true })`, dynamic model list via `client.models.list()` filtered to chat-capable IDs (`gpt-*`, `o<digit>-*`, `chatgpt-*`; excludes embeddings/audio/realtime/image/whisper/tts/dall-e/moderation/instruct/fine-tunes), sorted newest first, display name humanized from the id; accumulates partial tool call args during streaming, returns them in `StreamResult`
- **Gemini** — `chat.sendMessageStream()`, dynamic model list via the REST `v1beta/models` endpoint filtered to `supportedGenerationMethods.includes('generateContent')` (SDK doesn't expose list-models); collects `functionCall` parts into `StreamResult.toolCalls`
- **Ollama** — the odd one out: no key, and two protocols. `stream()` **is** the OpenAI adapter's, delegated to verbatim against `<host>/v1`, because that surface already carries streaming and tool calls in the shape the app handles and a second copy of that conversion would be a second place for a tool-call bug to live. `listModels()` uses the native `/api/tags` instead of `/v1/models`, because only the native listing returns the parameter size a local model's Work Complexity tier is decided by. `parseError()` speaks about a process and a disk ("start it with `ollama serve`", "run `ollama pull` for it first") rather than about an account. See [Local Models & Keyless Credentials](../local_models/local_models.md)

No adapter hardcodes versioned model IDs anywhere — listing is always live against the provider's API. If listing fails (network, invalid key, region restriction) the error surfaces through `providerService.testKey()` so the user sees the real cause rather than a stale picker.

## Adding a New Provider

1. Create `src/main/llm/<provider>.ts` implementing `LLMAdapter` <!-- nocheck -->
2. Add the provider type to the `type` union in the DB schema and TypeScript types
3. Implement `listModels()` (fetch dynamically or hardcode)
4. Implement `stream()` as a single-turn streamer: stream deltas via `onDelta`, return `StreamResult` — no tool-call loop needed
5. Implement `parseError()` to map SDK errors to `{ short, detail }`
6. Register in `createAdapter()` in `src/main/llm/factory.ts` (and add to the `ProviderType` union + `isProviderType` predicate)
7. If it authenticates with nothing, add it to `KEYLESS_PROVIDER_TYPES` in `src/shared/credentials.ts` — that one line is what makes every layer (registry registration, chat-mode picker, AI functions, engine config, "Runs with" panel) accept it, and the reason none of them tests for a key by hand

## Integration Points

- [Chat Messaging](../../chat/messaging/messaging.md) — Adapters are called by the streaming IPC handler
- [MCP Connections](../../mcp/connections/connections.md) — MCP tools are converted to each provider's tool schema format
- [Local Models & Keyless Credentials](../local_models/local_models.md) — the Ollama adapter, host detection, and the shared usability predicate
- [Switching an AI Credential Off](credential_enablement.md) — what `enabled` stops, the confirm that names it, and the shared credential-reference resolver
- Database — Provider configs stored in `llm_providers`: an encrypted API key, or a host in `base_url` for a keyless credential
