# LLM Adapters — Technical Details

## File Locations

### Main Process
- `src/main/llm/types.ts` — `LLMAdapter` interface, `ModelInfo`, `ChatMessage`, `ToolCallInfo`, `StreamResult`, `StreamParams`, `LLMError` types
- `src/main/llm/registry.ts` — In-memory `Map<providerId, LLMAdapter>`, `registerAdapter()`, `unregisterAdapter()`, `getAdapter()`, `clearAllAdapters()`, `getAllModels()`
- `src/main/llm/factory.ts` — `createAdapter(type, apiKey, providerId, opts)` + `isProviderType(type)` (extracted from `llm.ipc.ts`). `ProviderType` is `anthropic | openai | gemini | openai_compatible | ollama`
- `src/main/llm/anthropic.ts` — `AnthropicAdapter` (single-turn streamer, returns `StreamResult`). On `@anthropic-ai/sdk`, and unit-tested in `src/main/llm/anthropic.test.ts` against the SDK's real client rather than a mock of it — see [SDK versions, and one that moved for a reason outside this domain](#sdk-versions-and-one-that-moved-for-a-reason-outside-this-domain)
- `src/main/llm/openai.ts` — `OpenAIAdapter` (single-turn streamer, returns `StreamResult`). On `openai`, and unit-tested in `src/main/llm/openai.test.ts` against the SDK's real client rather than a mock of it — see [The OpenAI adapter, and the same hole in another SDK](#the-openai-adapter-and-the-same-hole-in-another-sdk). It backs **three** provider types: `openai`, `openai_compatible` (constructed with the gateway's base URL) and Ollama, whose `stream()` delegates to one built against the local host
- `src/main/llm/gemini.ts` — `GeminiAdapter` (single-turn streamer, returns `StreamResult`)
- `src/main/llm/ollama.ts` — `OllamaAdapter` (keyless; `stream()` delegates to `OpenAIAdapter` on `<host>/v1`, `listModels()` uses the native `/api/tags`) plus `fetchOllamaTags()` / `probeOllama()` — see [Local Models Tech](../local_models/local_models_tech.md)
- `src/main/services/ollamaService.ts` — `detect(host?)` / `isConfigured(host)`, behind `provider:detect-ollama`
- `src/shared/credentials.ts` — `isCredentialUsable`, `isCredentialActive`, `findCredentialByReference`, `requiresApiKey`, host normalisation, `KEYLESS_PLACEHOLDER_KEY`. Imported by main **and** renderer, so the two cannot disagree about which credentials are usable, which are active, or which row a stored credential *reference* resolves to
- `src/main/llm/geminiSchema.ts` — MCP JSON Schema → Gemini's v1beta `Schema` subset. `toGeminiParameters(schema, report)` is the call-site entry point (returns `undefined` for a no-argument tool); `sanitizeForGemini()` does the walk; `createReport()` collects `{ translated, dropped }` for the debug log. Pure/Electron-free, unit-tested in `src/main/llm/geminiSchema.test.ts` — see [Tool Schema Translation](./tool_schema_translation.md)
- `src/main/db/llmProviders.ts` — `llmProviderRepo` — `list/getOwned/upsert/delete`, all scoped by `userId`. Providers no longer carry a `is_default` flag; the "default" concept moved to chat modes (see [Chat Modes](../../chat/chat_modes/chat_modes.md)).
- `src/main/services/providerService.ts` — `providerService` — DTO mapping (`hasApiKey: boolean`, plus `baseUrl` for gateway/keyless rows), encryption via `encryptApiKey()`, registry sync on upsert/delete, `test()` and `testKey()` helpers, `listModels()` aggregator, and the two write-path guards (`type_immutable`, keyless-only `baseUrl`)
- `src/main/services/chatStreamingService.ts` — Drives the centralized tool-call loop via `getAdapter()` from the registry
- `src/main/ipc/llm.ipc.ts` — `llm:send-message` (MessagePort) delegates to `chatStreamingService.stream()`; `llm:cancel` delegates to `chatStreamingService.cancel()`
- `src/main/ipc/provider.ipc.ts` — Thin `provider:*` handlers wrapped by `ipcHandle()`, gated by `requireActivated()`, delegate to `providerService`. `provider:test` and `provider:test-key` catch errors and return `{ success: false, error }` for inline form display.
- `src/main/errors.ts` — `ProviderError` + `ProviderErrorCode` (`not_found`, `unsupported_type`, `missing_api_key`, `not_activated`, `read_only`, `list_models_failed`, `invalid_host`, `type_immutable`)
- `src/main/db/schema.ts` — `llmProviders` table definition
- `src/main/db/client.ts` — Migration for `llm_providers` table
- `src/main/security/keystore.ts` — `safeStorage` encrypt/decrypt wrapper for API keys
- `src/main/auth/reload.ts` — `reloadUserProviders()`: loads enabled credentials from the DB, decrypts keys where present, registers adapters

### Preload
- `src/preload/index.ts` — Exposes `window.api.providers.*` methods via contextBridge

### Renderer
- `src/renderer/src/hooks/useProviders.ts` — useProviders, useUpsertProvider, useDeleteProvider, useTestProvider, useTestProviderKey, useOllamaDetection
- `src/renderer/src/hooks/useModels.ts` — useModels (aggregates from all providers)
- `src/renderer/src/components/settings/SettingsPage.tsx` — Settings page with LLM Providers tab
- `src/renderer/src/components/settings/LLMProviderCard.tsx` — Expandable card: enable/disable, edit key, test, select model, delete (no per-provider default flag — defaults live on chat modes). Switching **off** goes through `DisableCredentialDialog` when a chat mode or a folder agent depends on the credential; while it is off the card keeps a line counting what is inactive. See [Switching an AI Credential Off](credential_enablement.md)
- `src/renderer/src/components/settings/LLMProviderForm.tsx` — Add new provider form: type selector, key **or host** input, test, save
- `src/renderer/src/components/settings/LLMSettingsSection.tsx` — The credential list, the add-form toggle, and the detected-Ollama offer row

## Database Schema

| Table | Purpose | Key columns |
|-------|---------|-------------|
| `llm_providers` | AI credentials | id, type (anthropic\|openai\|gemini\|openai_compatible\|ollama), name, api_key_enc (encrypted blob; **null for a keyless row**), base_url (gateway endpoint, or an Ollama host), enabled, default_model_id |

## IPC Channels

| Channel | Type | Purpose |
|---------|------|---------|
| `provider:list` | invoke | List LLM providers (API keys masked, includes `defaultModelId`) |
| `provider:upsert` | invoke | Create/update provider (supports `defaultModelId` and `baseUrl`, no isDefault flag). The type of an existing row cannot be changed |
| `provider:delete` | invoke | Delete provider |
| `provider:test` | invoke | Test saved provider connection, return model list |
| `provider:test-key` | invoke | Test a credential before saving: `{type, apiKey?, baseUrl?}`. `baseUrl` is forwarded only for a keyless type |
| `provider:detect-ollama` | invoke | Probe for a local Ollama (`host?` → `{running, host, version, models, alreadyConfigured}`); resolves rather than rejecting when nothing answers |
| `provider:list-models` | invoke | Aggregate models from all active providers |

## Services & Key Methods

- `src/main/llm/factory.ts:createAdapter(type, apiKey, providerId, opts)` — Factory: instantiates the correct adapter based on provider type; `opts.baseUrl` carries a gateway endpoint or an Ollama host, and a keyless type ignores `apiKey` entirely. `isProviderType(type)` narrows to the supported union.
- `src/main/llm/registry.ts` — `registerAdapter(providerId, adapter)`, `unregisterAdapter(providerId)`, `getAdapter(providerId)`, `clearAllAdapters()`, `getAllModels()`
- `src/main/services/providerService.ts:upsert()` — Validates the type, refuses to change an existing row's type, normalises `baseUrl` for keyless types and drops it for keyed ones, encrypts the API key, calls `llmProviderRepo.upsert()`, then registers or unregisters the adapter based on `enabled` + `isCredentialUsable` (a keyless credential registers with no key, and the row's `baseUrl` is passed to the factory).
- `src/main/services/providerService.ts:test()` — Looks up owned provider, decrypts key, instantiates adapter via factory, calls `adapter.listModels()`.
- `src/main/services/providerService.ts:testKey({type, apiKey?, baseUrl?})` — Probe with a temporary `__probe__` provider id; not registered. Failures from both `test()` and `testKey()` are translated through the adapter's own `parseError()` into a `list_models_failed` `ProviderError`, so the screen shows the provider's real sentence rather than `fetch failed`.
- `src/main/auth/reload.ts:reloadUserProviders()` — On user activation: loads enabled credentials from the DB, decrypts a key where there is one, creates adapters via the factory and registers them. A keyless credential registers on `enabled` alone; requiring a stored key here left a saved Ollama absent from the model picker on every launch until it was re-saved.
- `src/main/security/keystore.ts` — `encrypt(plaintext)`, `decrypt(blob)` using `safeStorage`

## Renderer Components

- `src/renderer/src/components/settings/DisableCredentialDialog.tsx` — the confirm in front of that toggle, plus `describeDependents()`, which the card's standing line shares so the dialog's names and the card's count cannot disagree about what a dependent is
- `src/renderer/src/components/settings/LLMProviderCard.tsx` — Expandable provider card with: enable/disable toggle (`aria-label` **Switch on / Switch off**, the words the dialog uses), API key field (masked) — or, for a keyless credential, a plain **Host** field seeded from the stored value — test connection button, model selector dropdown (fetches models on demand via `provider:test`), delete button. No per-provider default flag — the "default" concept now lives on chat modes.
- `src/renderer/src/components/settings/LLMProviderForm.tsx` — New provider form: type selector with search filter, API key **or** host input, test before save. The Ollama branch and its layout rules are documented in [Local Models](../local_models/local_models.md#what-the-ui-must-not-do)

## SDK versions, and one that moved for a reason outside this domain

Each adapter is a thin wrapper over its vendor's own SDK: `@anthropic-ai/sdk`, `openai`, `@google/generative-ai`. Versions are in `package.json`; only one of them is worth a paragraph.

**`@anthropic-ai/sdk` was moved `^0.89.0` → `^0.93.0` by a change in a different feature.** [The Claude Engine](../../agents/local_agents/claude_engine.md) adds `@anthropic-ai/claude-agent-sdk`, which peer-requires `>= 0.93`, so the bump was forced rather than chosen — and it lands on `anthropic.ts`, a **shipping chat provider used by every Anthropic credential in the app**.

**`AnthropicAdapter` is tested against the SDK's real client, not a mock of it.** A typecheck cannot see a renamed streaming event, a tool input no longer parsed out of partial JSON, an error whose status moved, or an abort that stops reaching the request — and a mock at the SDK boundary is faithful only to what its author believed about the previous version. So `src/main/llm/anthropic.test.ts` keeps the SDK in the loop: the global `fetch` is stubbed to answer with what the Messages API puts on the wire — SSE frames, JSON error envelopes, a paged models list — and every assertion is on what the adapter handed the app or on what left it in the request. The client captures `fetch` at construction, so the stub is installed before the adapter is built; and it reads `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` and `ANTHROPIC_PROFILE` when the caller leaves them unset, so the file clears all four around every test — a developer's own shell must not decide where a test's request goes or what credential it carries.

What is pinned there:

- **The request** — `x-api-key` is the only credential on the wire, and it goes to `api.anthropic.com` whatever the process environment says. The client fills `authToken` and `baseURL` from `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL` when the caller leaves them unset, and sends *both* credentials when it holds both — so with a token in the shell, `new Anthropic({ apiKey })` put the stored key and a `Bearer` header on the same request, and with a base URL there it sent the stored key to that host; and `ANTHROPIC_CUSTOM_HEADERS` is merged *over* the client's own auth headers, so a shell's `x-api-key:` line replaced the stored key outright. All three are SDK defaults older than 0.93. The constructor passes `authToken: null`, the default host, and `defaultHeaders` naming the stored key and a `null` (deleted) `authorization` — explicit values win over the environment on every one of those paths; the test that pins it sets all three variables and asserts nothing changes. Also pinned: `system` messages lifted into the top-level `system` field, history and tool results and media rendered as the API's blocks, tools declared under `input_schema` and the `tools` key absent without them
- **The response** — text delivered per delta rather than as the cumulative snapshot (the SDK's `text` event carries both, and the wrong one renders as stuttering), tool inputs assembled from `input_json_delta` pieces, thinking blocks never surfaced, pings ignored, and a stream cut before `message_stop` failing rather than returning an empty success
- **Cancellation** — a mid-turn abort reaches the request's own signal and rejects, because a cancelled turn that keeps streaming is a turn the user still pays for; a turn aborted before it starts sends nothing
- **Failures, as they reach `parseError`** — a 429 retried twice by the client and then mapped, a 401 not retried, a 529, an `overloaded_error` inside an open stream, a billing refusal on a 400 the status table does not name; plus `listModels` paging by `after_id` and `modelCapability`

Writing those tests found two defects, both older than the bump. The first is the environment hole above, an SDK default since long before 0.89. The second is in `parseError()`, and predates the bump too: 0.89.0's `core/error.js` and `core/streaming.js` were fetched and are identical on the point. **The SDK's `APIError.message` is not the API's sentence — it is the status plus the whole error body as JSON**, because the body `{type:'error', error:{type, message}}` has no top-level `message`. Every `detail` the user was shown had been that envelope, and an overload arriving *inside* an open stream — an SSE `error` event, which the SDK throws with no HTTP status — fell past the status table and put the envelope, truncated at 120 characters, on the `short` line too. `parseError()` now reads the sentence from the error body and matches `overloaded_error` by type. The quirk itself is recorded with the others in [Provider Integration](provider_integration.md#anthropic-the-sdks-error-message-is-the-json-body).

Anyone touching this adapter, or bumping the SDK again, runs that file first; it is the only check that sees past the types. The bump's own record is in the Claude engine's contract, [§5a](../../agents/local_agents/claude_contract.md#the-sdk-also-drags-the-anthropic-api-sdk-forward).

## The OpenAI adapter, and the same hole in another SDK

The environment defect found in `anthropic.ts` is a **class of defect, not one adapter's bug**: an SDK client fills options the caller left unset from the process environment, and the app reaches that environment whenever it is launched from a terminal — which is how a developer launches it. `openai` 6.34.0 has its own version of it, and `src/main/llm/openai.test.ts` is the same kind of file as `anthropic.test.ts`: the real client against a stubbed global `fetch`, every assertion on what the adapter handed the app or on what left it in the request, and the environment variables the client reads cleared around every test so a developer's own shell cannot decide where a test's request goes.

**What the client reads, and what the constructor now pins.** `baseURL` comes from `OPENAI_BASE_URL`, and `organization` / `project` from `OPENAI_ORG_ID` / `OPENAI_PROJECT_ID` — the latter two ride on **every** request as `OpenAI-Organization` and `OpenAI-Project`. So a shell could send the stored key to a host the user never configured, or attribute the request to an organisation they did not choose. `OpenAIAdapter`'s constructor passes `organization: null`, `project: null`, and a base URL — and the credential row is the only thing that decides where a request goes and who it is billed to.

**The base URL is pinned as a *default*, `opts.baseURL ?? OPENAI_DEFAULT_BASE_URL`, and not as a constant.** This class is also what an `openai_compatible` gateway and the Ollama adapter are built from (`factory.ts`), each with a real base URL of its own; a constant would point all three at `api.openai.com`. What the default replaces is only the case where the caller named nothing — where the SDK would otherwise consult the shell.

**There is no `OPENAI_CUSTOM_HEADERS` equivalent, and that is worth stating rather than leaving as an absence.** Every environment read in the package is `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID`, `OPENAI_WEBHOOK_SECRET` and `OPENAI_LOG`, plus the Azure client's own three, which this app never constructs. So the worst of the Anthropic holes — a shell's `x-api-key:` line merged *over* the client's auth headers, replacing the stored key outright — has no counterpart here. `OPENAI_API_KEY` is cleared in the tests anyway, so a stale one in the environment can never stand in for a missing argument.

Writing those tests found two further defects, neither of them about the environment:

- **A cancelled turn resolved as a successful one.** The SDK's SSE reader treats an abort as a clean end of stream — `Stream`'s iterator catches the `AbortError` and *returns* — so the adapter's loop simply ended and `stream()` resolved with whatever text had arrived. The caller could not tell that from a finished turn: it saved the partial text as the assistant's message, posted `done`, and reported the job run **succeeded**. `stream()` now throws `APIUserAbortError` when its signal is aborted, which is what the other two adapters always did. The stale-run half of the same failure is in [Jobs](../../jobs/jobs/jobs.md#business-rules)
- **An exhausted quota read as a rate limit.** `insufficient_quota` arrives as HTTP **429**, so the status table matched it before the quota branch below and told the user to wait and retry for a state that waiting never clears. The quota check now sits **above** the table, which also catches the mid-stream form the SDK builds with no HTTP status at all — unreachable from inside the table either way

What is pinned in `openai.test.ts`: the request (bearer key, chat-completions endpoint, no organisation or project header, and none of that moved by the environment — for a first-party credential *and* for a gateway); system messages left in place, history with tool calls on the assistant turn and results as `tool` turns, a null content for a tool-only assistant turn, images as data URLs with what Chat Completions cannot take dropped, tools declared under `parameters` and no `tools` key without them; the response (per-delta text, tool arguments assembled from fragments across interleaved indices, unparseable arguments as an empty input rather than a failed turn, a usage-only chunk ignored); cancellation both mid-turn and before the turn starts; the failure table through `parseError`, including the two defects above; `listModels` filtering and the gateway fallback; and `modelCapability`.

## Security

- API keys encrypted at rest via `safeStorage` (OS keychain), stored as blobs in `llm_providers.api_key_enc`
- Keys decrypted only in the main process when instantiating SDK clients
- Renderer never sees raw API keys — only `hasApiKey: boolean`. `baseUrl` is the one endpoint detail that does cross, because a keyless credential's host *is* the credential and is not a secret
- A renderer-supplied `baseUrl` is honoured only for keyless types, on `provider:upsert` and `provider:test-key` alike, and a credential's `type` is immutable after creation — the two together are what stop a stored key being sent to an address the renderer chose. See [Local Models Tech](../local_models/local_models_tech.md#security)
- The same rule holds for `OpenAIAdapter`, in the narrower form that SDK's defaults allow. The client fills `baseURL` from `OPENAI_BASE_URL` and `organization` / `project` from `OPENAI_ORG_ID` / `OPENAI_PROJECT_ID` — headers on every request — so the constructor passes `organization: null`, `project: null` and a base URL that **defaults** to the API's own host while still honouring a gateway's or Ollama's, since those construct the same class. There is **no `OPENAI_CUSTOM_HEADERS`**: the package's only environment reads are the key, the base URL, the two ids, `OPENAI_WEBHOOK_SECRET`, `OPENAI_LOG` and the Azure client's, so the header-replacement path that existed for Anthropic does not exist here. Pinned in `src/main/llm/openai.test.ts`
- The same rule holds against the **process environment**. `AnthropicAdapter` constructs its client with `authToken: null`, `baseURL` set to the API's own host, and `defaultHeaders` that name the stored key and delete `authorization`, because the SDK otherwise reads `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` and `ANTHROPIC_CUSTOM_HEADERS` — the last merged over its own auth headers — and would send the stored key alongside a shell's bearer token, replace it with a shell's, or send it to a host the user never configured in the app. The credential row is the only thing that decides what is sent and where. The exposure was narrow — `src/main/shell/envMerge.ts` merges the login-shell dump for child processes only, never into `process.env`, so it reached a terminal launch or `npm run dev` rather than the Dock — but a key exfiltrated from a developer's build is still exfiltrated. Pinned in `src/main/llm/anthropic.test.ts`
- `safeStorage.isEncryptionAvailable()` may return false on some Linux setups; keystore falls back to base64 (not secure, but functional)
