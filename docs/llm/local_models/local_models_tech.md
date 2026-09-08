# Local Models & Keyless Credentials — Technical Details

Business rules and the reasoning behind them: [Local Models & Keyless Credentials](./local_models.md).

## File Locations

### Shared (imported by both processes)
- `src/shared/credentials.ts` — `KEYLESS_PROVIDER_TYPES`, `requiresApiKey(type)`, `isCredentialUsable(provider)`, `isCredentialActive(provider)` (`enabled && usable`), `findCredentialByReference(providers, reference)` (id → name → type, tie-broken toward a credential that can run; shared with `runtimeService`), `OLLAMA_DEFAULT_HOST`, `normaliseOllamaHost(value)`, `storableOllamaHost(value)`, `KEYLESS_PLACEHOLDER_KEY`, `ollamaOpenAIBaseUrl(host)`. Pure, no Electron, unit-tested in `src/shared/credentials.test.ts`
- `src/shared/modelFamilies.ts` — the `local-large` / `local-mid` / `local-small` / `local` rules and the `PARAMS_*` patterns; `FamilyRule.catchAll` and the `KNOWN_TYPES` entry for `ollama`
- `src/shared/runtimeDefaults.ts` — `PER_ROW_CATALOGUE` is now a `Set` holding `openai_compatible` and `ollama`; read by `inheritedModelId` and `modelBelongsElsewhere`

### Main Process
- `src/main/llm/ollama.ts` — `OllamaAdapter` (`listModels()` native, `stream()` delegated to `OpenAIAdapter`, `modelCapability()`, `parseError()`), plus the two free functions `fetchOllamaTags(host)` and `probeOllama(host)` used before any credential exists. `LIST_TIMEOUT_MS` 1500, `PROBE_TIMEOUT_MS` 5000
- `src/main/services/ollamaService.ts` — `detect(host?)`, `isConfigured(host)`, and the private `candidateHosts()` (`OLLAMA_HOST` then the default, deduped)
- `src/main/llm/factory.ts` — `ProviderType` gains `ollama`; `createAdapter` builds an `OllamaAdapter` from `opts.baseUrl || OLLAMA_DEFAULT_HOST` and ignores `apiKey`
- `src/main/services/providerService.ts` — `ProviderDto.baseUrl`, `UpsertProviderInput.baseUrl`, the type-immutability and keyless-only-`baseUrl` guards in `upsert()`, `testKey(input)` taking an object, and `parseError` translation in `test()` / `testKey()`
- `src/main/ipc/provider.ipc.ts` — `provider:detect-ollama`; `baseUrl` on `provider:upsert` and `provider:test-key`
- `src/main/errors.ts` — `ProviderErrorCode` gains `invalid_host` and `type_immutable`
- `src/main/auth/reload.ts` — `reloadUserProviders()` registers a keyless credential on `enabled` alone
- `src/main/services/aiFunctionsService.ts` — `tryResolve()` no longer skips a credential for having no key when its type needs none
- `src/main/engine/modelCache.ts` — `mergeModelCache(previous, fresh, known)`, `CachedModel`, `ModelRefreshScope` (`'all' | 'local'`). Pure, tested in `modelCache.test.ts`
- `src/main/engine/engineConfigSource.ts` — `collectEngineProviders()` on `dto.enabled` then `isCredentialUsable`, `refreshModelCache(scope)`, the private `listLocalModels()` / `localProviderIds()`, and `collectEngineConfigInput`'s `'local'` refresh on the reconcile path
- `src/main/engine/configGenerator.ts` — `PROVIDER_NPM.ollama` (`@ai-sdk/openai-compatible`), `PROVIDER_BASE_URL.ollama`, the private `engineBaseUrl(type, credentialBaseUrl)`, the keyless branches of the empty-key skip and of the `env` map
- `src/main/engine/modelLimits.ts` — `EngineProviderType` gains `ollama`; `CUSTOM_MODEL_LIMITS.ollama = {context: 32768, output: 4096}`
- `src/main/services/localAgents/runtimeService.ts` — `isUsable()` delegates to `isCredentialUsable`; `findCredential()` delegates to `findCredentialByReference`

### Preload
- `src/preload/index.ts` — `ProviderData.baseUrl`, `OllamaDetectionData`, `providers.detectOllama(host?)`, `baseUrl` on `providers.upsert` and `providers.testKey` (whose `apiKey` is now optional)

### Renderer
- `src/renderer/src/hooks/useProviders.ts` — `useOllamaDetection({enabled, host})`; `useUpsertProvider` / `useDeleteProvider` also invalidate `['ollama-detection']`
- `src/renderer/src/components/settings/LLMSettingsSection.tsx` — the detection offer row and its one-click add
- `src/renderer/src/components/settings/LLMProviderForm.tsx` — the Ollama type entry, the Host field, the fixed-height status slot, the persistent Default Model row
- `src/renderer/src/components/settings/LLMProviderCard.tsx` — the keyless card branch (Host field, no key controls, usability-based status dot, full-width error lines)
- `src/renderer/src/components/settings/ChatModeCard.tsx`, `ChatModeForm.tsx`, `LocalAgentsSettingsSection.tsx`, `agents/local/RuntimePanel.tsx`, `hooks/useAttachDestination.ts` — all now call the shared predicates instead of restating them. The four that mean "can this run right now" call `isCredentialActive`; `RuntimePanel` still calls `isCredentialUsable`, because its picker must list a switched-off credential for an agent pointing at one to say so

## Database Schema

No migration. A keyless credential is an ordinary `llm_providers` row:

| Column | For an Ollama row |
|--------|-------------------|
| `type` | `'ollama'` |
| `api_key_enc` | null — nothing is encrypted, and `hasApiKey` is false in the DTO |
| `base_url` | the normalised origin (`http://127.0.0.1:11434`), the same column an `openai_compatible` gateway's endpoint uses |
| `enabled`, `default_model_id`, `name` | as for any other credential |

`ProviderDto.baseUrl` is the one per-credential endpoint detail that crosses to the renderer, because for a keyless row it *is* the credential and it is not a secret.

## IPC Channels

| Channel | Type | Purpose |
|---------|------|---------|
| `provider:detect-ollama` | invoke | `(host?: string \| null) → OllamaDetectionData`. Resolves either way; "nothing is running" is `running: false`, not a rejection |
| `provider:upsert` | invoke | Now also takes `baseUrl?: string \| null` — kept for keyless types, dropped (and logged) for keyed ones, `undefined` leaves the stored value alone |
| `provider:test-key` | invoke | Now `{type, apiKey?, baseUrl?}`. `baseUrl` is forwarded only for a keyless type; `apiKey` is required for every other |

## Services & Key Methods

- `src/main/services/ollamaService.ts:detect(host?)` — normalises the asked-for host; an unparseable *explicit* host reports `running: false` against the string the user typed rather than falling through to the candidates. Probes each candidate's `/api/version`, then lists `/api/tags`; a host that answers the first but not the second is still `running: true` with an empty model list and a warning
- `src/main/services/ollamaService.ts:isConfigured(host)` — compares normalised origins against the user's own scope, so `http://localhost:11434` and `http://127.0.0.1:11434` are one server
- `src/main/llm/ollama.ts:fetchOllamaTags(host)` — `/api/tags` → `{id, family, parameterSize, quantization}[]`, filtered by `isChatCapableModelId` and the Ollama-specific embedding pattern, sorted alphabetically (what `ollama list` prints)
- `src/main/llm/ollama.ts:probeOllama(host)` — `/api/version` → version string, `''` when it answers without one, `null` when nothing answers. Never throws
- `src/main/services/providerService.ts:upsert(input)` — `type_immutable` guard → `baseUrl` accepted only for keyless types (`storableOllamaHost`, `invalid_host` on failure) → repo write → register/unregister, now passing `{baseUrl: row.baseUrl}` to `createAdapter` (which an `openai_compatible` row saved through this path previously lost)
- `src/main/services/providerService.ts:testKey({type, apiKey?, baseUrl?})` — object argument, because what identifies a credential is no longer always a key
- `src/main/engine/modelCache.ts:mergeModelCache(previous, fresh, known)` — a provider that answered is replaced; one that did not keeps its last list; ids absent from `known` are evicted, and an **empty** `known` evicts nothing
- `src/main/engine/engineConfigSource.ts:refreshModelCache(scope)` — `'all'` fans out over `getAllModels()`; `'local'` calls `listModels()` directly on the adapters of keyless credentials only

## Renderer Components

- `LLMSettingsSection` — `useOllamaDetection()` on mount; offer row when `running && !alreadyConfigured`, i.e. suppressed **by host** rather than by "the user has an Ollama credential of some kind", which would have let one saved against a mistyped port hide the offer for the real server permanently. Rendered last in the section
- `LLMProviderForm` — `keyless = !requiresApiKey(selectedType)`; `probeHost` is set on selection and on Test only, never per keystroke; `hostTouched` stops detection overwriting a user-typed host; `showModelRow = selectedType !== null`, so the Default Model row is permanent for every provider type and only its contents change; `chosenModelId` is derived by intersecting the selection with the list on screen, so the control and the value Save writes cannot disagree while the raw selection survives a list that empties and refills; the status slot is `aria-live="polite"`
- `LLMProviderCard` — `host` state seeded from `provider.baseUrl`; Save sends `baseUrl` for a keyless row and `apiKey` otherwise; `hostInvalid` disables Save on a string `normaliseOllamaHost` rejects; the header's type sub-line renders only when it differs from the credential's name, since a credential created from the picker takes the provider's display name and the line otherwise read "Ollama Ollama"
- Error text on all three surfaces goes through `src/renderer/src/utils/ipcError.ts:unwrapIpcError()`, so a `ProviderError`'s sentence reaches the user instead of `String(err)`

## Configuration

- `OLLAMA_HOST` — read by `candidateHosts()` from the main process environment, in the scheme-less form Ollama's CLI uses. Best-effort: a Dock-launched macOS app does not inherit the user's shell environment, so the default host is always tried as well
- Query cache: `['ollama-detection', host]`, `staleTime` 15 s, `retry: false`, `placeholderData: keepPreviousData`, and **`refetchOnWindowFocus: true`** — the one query in the app that overrides the global `false`, because the fact it reports changes in a terminal while the user is looking elsewhere. `useUpsertProvider` / `useDeleteProvider` invalidate the key, which is what retires the offer row the moment its own button has worked

## Security

- A keyless credential has nothing at rest to protect; `safeStorage` is not involved, and `decryptApiKey` is called only when `api_key_enc` is present
- `baseUrl` from the renderer is honoured only for keyless types, on both `provider:upsert` and `provider:test-key`. See [the rule and what it prevents](./local_models.md#baseurl-is-accepted-only-for-a-keyless-type)
- A credential's `type` cannot be changed after creation (`type_immutable`), which is what stops a stored key being spent under another type's transport
- `normaliseOllamaHost` accepts `http:`/`https:` only and returns `protocol + host`, dropping userinfo — a pasted `http://user:pass@host:11434` cannot put a credential into a column that is logged and rendered
- The detection probe's reply carries no status code, body, headers or timing, and runs only in response to a user action
- `KEYLESS_PLACEHOLDER_KEY` (`'keyless'`) is a fixed public literal, deliberately not random: it is recognisable in a proxy log, and a random value would suggest to a reader that it mattered
