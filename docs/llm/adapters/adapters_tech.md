# LLM Adapters — Technical Details

## File Locations

### Main Process
- `src/main/llm/types.ts` — `LLMAdapter` interface, `ModelInfo`, `ChatMessage`, `ToolCallInfo`, `StreamResult`, `StreamParams`, `LLMError` types
- `src/main/llm/registry.ts` — In-memory `Map<providerId, LLMAdapter>`, `getAllModels()`
- `src/main/llm/anthropic.ts` — `AnthropicAdapter` (single-turn streamer, returns `StreamResult`)
- `src/main/llm/openai.ts` — `OpenAIAdapter` (single-turn streamer, returns `StreamResult`)
- `src/main/llm/gemini.ts` — `GeminiAdapter` (single-turn streamer, returns `StreamResult`)
- `src/main/ipc/llm.ipc.ts` — Streaming handler, centralized tool-call loop, `createAdapter()` factory
- `src/main/ipc/provider.ipc.ts` — Provider CRUD: list, upsert, delete, test, test-key, list-models
- `src/main/db/schema.ts` — `llmProviders` table definition
- `src/main/db/client.ts` — Migration for `llm_providers` table
- `src/main/security/keystore.ts` — `safeStorage` encrypt/decrypt wrapper for API keys
- `src/main/index.ts` — `initLLMProviders()`: loads enabled providers from DB, decrypts keys, registers adapters

### Preload
- `src/preload/index.ts` — Exposes `window.api.providers.*` methods via contextBridge

### Renderer
- `src/renderer/src/hooks/useProviders.ts` — useProviders, useUpsertProvider, useDeleteProvider, useTestProvider
- `src/renderer/src/hooks/useModels.ts` — useModels (aggregates from all providers)
- `src/renderer/src/components/settings/SettingsPage.tsx` — Settings page with LLM Providers tab
- `src/renderer/src/components/settings/LLMProviderCard.tsx` — Expandable card: enable/disable, default star, edit key, test, select model, delete
- `src/renderer/src/components/settings/LLMProviderForm.tsx` — Add new provider form: type selector, key input, test, save

## Database Schema

| Table | Purpose | Key columns |
|-------|---------|-------------|
| `llm_providers` | API credentials | id, type (anthropic\|openai\|gemini), name, api_key_enc (encrypted blob), enabled, is_default, default_model_id |

## IPC Channels

| Channel | Type | Purpose |
|---------|------|---------|
| `provider:list` | invoke | List LLM providers (API keys masked, includes isDefault, defaultModelId) |
| `provider:upsert` | invoke | Create/update provider (supports isDefault, defaultModelId) |
| `provider:delete` | invoke | Delete provider |
| `provider:test` | invoke | Test saved provider connection, return model list |
| `provider:test-key` | invoke | Test an API key before saving (takes type + apiKey) |
| `provider:list-models` | invoke | Aggregate models from all active providers |

## Services & Key Methods

- `src/main/ipc/llm.ipc.ts:createAdapter()` — Factory: instantiates the correct adapter based on provider type
- `src/main/llm/registry.ts` — `registerAdapter(providerId, adapter)`, `getAdapter(providerId)`, `getAllModels()`
- `src/main/index.ts:initLLMProviders()` — On app start: loads all enabled providers from DB, decrypts keys, creates adapters, registers them
- `src/main/security/keystore.ts` — `encrypt(plaintext)`, `decrypt(blob)` using `safeStorage`

## Renderer Components

- `src/renderer/src/components/settings/LLMProviderCard.tsx` — Expandable provider card with: enable/disable toggle, default star (only one at a time), API key field (masked), test connection button, model selector dropdown (fetches models on demand via `provider:test`), delete button
- `src/renderer/src/components/settings/LLMProviderForm.tsx` — New provider form: type selector with search filter, API key input, test before save

## Security

- API keys encrypted at rest via `safeStorage` (OS keychain), stored as blobs in `llm_providers.api_key_enc`
- Keys decrypted only in the main process when instantiating SDK clients
- Renderer never sees raw API keys — only `hasApiKey: boolean`
- `safeStorage.isEncryptionAvailable()` may return false on some Linux setups; keystore falls back to base64 (not secure, but functional)
