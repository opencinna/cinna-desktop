# LLM Adapters — Technical Details

## File Locations

### Main Process
- `src/main/llm/types.ts` — `LLMAdapter` interface, `ModelInfo`, `ChatMessage`, `ToolCallInfo`, `StreamResult`, `StreamParams`, `LLMError` types
- `src/main/llm/registry.ts` — In-memory `Map<providerId, LLMAdapter>`, `registerAdapter()`, `unregisterAdapter()`, `getAdapter()`, `clearAllAdapters()`, `getAllModels()`
- `src/main/llm/factory.ts` — `createAdapter(type, apiKey, providerId, opts)` + `isProviderType(type)` (extracted from `llm.ipc.ts`). `ProviderType` is `anthropic | openai | gemini | openai_compatible | ollama`
- `src/main/llm/anthropic.ts` — `AnthropicAdapter` (single-turn streamer, returns `StreamResult`)
- `src/main/llm/openai.ts` — `OpenAIAdapter` (single-turn streamer, returns `StreamResult`)
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

## Security

- API keys encrypted at rest via `safeStorage` (OS keychain), stored as blobs in `llm_providers.api_key_enc`
- Keys decrypted only in the main process when instantiating SDK clients
- Renderer never sees raw API keys — only `hasApiKey: boolean`. `baseUrl` is the one endpoint detail that does cross, because a keyless credential's host *is* the credential and is not a secret
- A renderer-supplied `baseUrl` is honoured only for keyless types, on `provider:upsert` and `provider:test-key` alike, and a credential's `type` is immutable after creation — the two together are what stop a stored key being sent to an address the renderer chose. See [Local Models Tech](../local_models/local_models_tech.md#security)
- `safeStorage.isEncryptionAvailable()` may return false on some Linux setups; keystore falls back to base64 (not secure, but functional)
