# The Local Engine, Runtimes & Prompt Assembly — Technical Details

Implementation reference for [The Local Engine, Runtimes & Prompt Assembly](engine.md). Path convention as in that doc: `src/...` is this repository; `Local/<slug>/...`, `cinna-agent.json` and `app-data/...` are inside an agent folder; `<userData>/engine/...` is the app data directory.

## Read this first if you are working next to the engine

Five things here will produce a silent, green-suite failure if changed carelessly. Each is argued in [engine.md](engine.md); this is the index.

1. **`turnLock.anyHeld()` gates every restart, never `turnLock.isLocked(agentId)`.** One process backs every folder agent — a per-agent check restarts the engine out from under a turn running in a *different* folder. Live Invariant 3 violation; already fixed once
2. **`GET /config` on the engine returns the RESOLVED config**, with `{env:…}` substituted — **its response contains live API keys.** Never log it, never put it in a stream part, never forward it to the renderer
3. **The digest is length-prefixed (`framed()`), not delimiter-joined.** A collision is a *false negative* — the engine keeps serving the old prompt while the app believes otherwise, with every test still passing. Do not simplify it back to a join
4. **`agentKey()` and `lastSkips()` answer from `RunningEngine.loaded`**, the record taken at spawn — not from the last generated config. Phase 6 binds engine sessions to `agentKey`
5. **Every model decision goes through `resolveRuntimeModel` in `src/shared/runtimeDefaults.ts`**, called by `runtimeService.resolve` *and* by the “Runs with” panel. A model derived in either caller alone is a label that predicts a runtime the engine will not build — and both sides keep passing their own tests while they disagree

## File Locations

### Shared
- `src/shared/engine.ts` — the whole wire contract. `EngineBinarySource`, `EngineStatus`, `EngineState`, `EngineSkips`, `ENGINE_STATE_CHANNEL`, `PINNED_ENGINE_VERSION` (`'1.18.27'`), `RuntimeSource`, `ResolvedRuntime` (with `modelSource: ModelOrigin` and `replacedModelId`), `LocalAgentRuntimeInput` (`credential`, `modelId`, `complexity`). Type-only or plain constants; **nothing key-shaped, and no `baseUrl`**
- `src/shared/runtimeDefaults.ts` — `resolveRuntimeModel(input)` → `{modelId, origin, replaced}`, the one entry point both sides use; plus `inheritedModelId(chosen, fallback)` (steps 1–3 of the chain), `defaultRuntimeModelId(fallbackProvider, modeModelId)` (the Default runtime's model, flattened once), `modelBelongsElsewhere(modelId, chosen, models, providers)`, `COMPLEXITY_FLOOR` (`'medium'`), the `ModelOrigin` union (`declared` / `substituted` / `tier` / `inherited` / `floor` / `none`), and the `RuntimeCredential` / `RuntimeFallback` / `RuntimeModelInput` shapes. Imported by `runtimeService` (main) **and** `RuntimePanel` (renderer): the file exists so the `Default (…)` label and the generated config cannot state different models
- `src/shared/modelFamilies.ts` — the work-complexity classifier. `WorkComplexity`, `WORK_COMPLEXITIES`, `WORK_COMPLEXITY_LABELS`, `WORK_COMPLEXITY_HINTS`, `isWorkComplexity()`, `classifyModel(modelId, providerType)`, `bestInTier(tier, models, providerType)`, `sameFamilyFallback(modelId, models, providerType)`, plus module-private `RULES`, `token()`, `versionOf()`, `compareClassified()`. **No network, no filesystem** — the catalogue is always passed in, because a tier only means something against what one credential actually lists. Excludes non-chat and access-gated ids through `src/shared/modelDefaults.ts` (`isChatCapableModelId`, `isDefaultEligibleModelId`), the same pair the chat-mode default uses
- `src/shared/appSettings.ts` — `localAgentsEnginePath: string` and `localAgentsModelAdvanced: boolean` on `AppSettingsSchema`
- `src/shared/kit/manifest.ts` — `AgentRuntimeRef` (`model`, `complexity`, `credential`, `permissions`, plus an index signature for the round-trip rule)

### Main process — `src/main/engine/`
- `binaryResolver.ts` — the three sources, `ENGINE_ASSETS` (six pinned `{file, sha256}` entries), `assetUrl()`, `resolveEngineBinaryWith(deps)`, `installPinned()`, `findBinary()`, `sha256File()`, `probeEngineVersion()`, `downloadToFile()`, `extractArchive()`, `engineRootDir()`, `realBinaryResolverDeps()`, `EngineBinaryError`, `BinaryResolverDeps`
- `modelTransports.ts` — `SUPPORTED_MODEL_PACKAGES`, `GEMINI_OPENAI_BASE_URL`, `unsupportedModelApi()`. The three `api.package` values `SessionRunnerModel` can build a model from, and the endpoint a `gemini` credential is routed to because `@ai-sdk/google` is not one of them
- `modelLimits.ts` — `CUSTOM_MODEL_LIMITS`, `EngineProviderType`, `EngineModelLimit`, `isEngineProviderType()`. The context/output ceilings a **custom** provider entry's models are declared with, and the union every provider-keyed table in `configGenerator` is exhaustive over
- `engineManager.ts` — the process. `engineManager.{getState, onStateChange, ensureRunning, applyConfigChange, stop, agentKey, lastSkips, request}`, plus module-private `startEngine`, `spawnAttempt`, `halt`, `whatMoved`, `pickLoopbackPort`, `engineEnv`, `healthy`, `waitForHealth`, `killEngine`; exported `ENGINE_TIMEOUTS`, `registerEngineShutdown()`, `resetEngineStateForTests()`
- `configGenerator.ts` — `buildEngineConfig()` (pure), `digestEngineConfig()`, `writeEngineConfig()`, `CONVERSATION_PERMISSIONS`, `credentialEnvName()`, `engineAgentKey()`, `promptFileRef()`, and module-private `framed`, `mergePermissions`, `pruneStalePrompts`, `writeIfDifferent`
- `engineConfigSource.ts` — `collectEngineProviders()`, `collectEngineAgents(userId)`, `collectEngineConfigInput(userId, {refreshModels})`, `refreshModelCache()`. **The one place a decrypted API key is read**

### Main process — elsewhere
- `src/main/ipc/engine.ipc.ts` — `registerEngineHandlers()`; four channels plus the state push. Calls `registerEngineShutdown()`
- `src/main/ipc/index.ts` — `registerEngineHandlers()` in `registerAllIpcHandlers()` (required by the registration guard, seam 15)
- `src/main/ipc/local_agent.ipc.ts` — the per-site reconciles, every one a fire-and-forget `void engineManager.applyConfigChange(...)` on success: `update-field`, `delete`, `folder-add`, `rename`, `set-runtime`, `root-restore-hidden` and `git-update`. The channels that can change which agents exist or what they run on, and no others
- `src/main/services/localAgents/runtimeService.ts` — `runtimeService.{resolveDefault, resolve, applyToManifest}`, exported `findCredential()` (a delegate to `findCredentialByReference` in `src/shared/credentials.ts`), module-private `normaliseRef`, `isUsable`, `defaultCredentialProblem`, `catalogueFor`, `declaredComplexity`. Every model decision goes through `resolveRuntimeModel` (`src/shared/runtimeDefaults.ts`); `resolveDefault` flattens its own model with `defaultRuntimeModelId`
- `src/main/kit/validator.ts` — `checkRuntime()` also reports `manifest.runtime.complexity`, as a **warning** in both its cases (unrecognised value; `model` and `complexity` both set). Never an error — see [Reading is tolerant, writing is strict](kit_contract.md#reading-is-tolerant-writing-is-strict)
- `src/main/services/localAgents/promptAssembly.ts` — `assembleAgentPrompt()`, `assembleBareAgentPrompt()`, `resolveDesktopPromptContext()`, `stripHtmlComments()`, `listKnowledgeTopics()`, module-private `readTextFile`, `handoverSection`, `desktopContextSection`, `bareDesktopContextSection`
- `src/main/services/localAgents/turnLock.ts` — `turnLock.anyHeld()` (added for the engine; the rest is Phase 2)
- `src/main/services/appSettingsService.ts:95` — the `localAgentsEnginePath` value check (absolute or empty; existence deliberately unchecked)
- `src/main/db/appSettings.ts:25` — the default (`''`)

### Preload
- `src/preload/index.ts:1088` — `window.api.engine.{status, start, stop, skips, onState}`. **No `baseUrl` and no password, by design.** Typed by inference

### Renderer
- `src/renderer/src/hooks/useEngine.ts` — `ENGINE_STATE_KEY`, `ENGINE_SKIPS_KEY`, `useEngineState`, `useEngineWatch`, `useEngineSkips`, `useStartEngine`, `useStopEngine`
- `src/renderer/src/components/agents/local/RuntimePanel.tsx` — the "Runs with" panel: the credential picker, the work-complexity / model picker and its **Advanced** checkbox, the one reserved status line, and the module-private `EngineStatus` and `SecretsLine`. Calls `resolveRuntimeModel`, `defaultRuntimeModelId` and `modelBelongsElsewhere` from `src/shared/runtimeDefaults.ts`, and `bestInTier` / `classifyModel` / the label and hint tables from `src/shared/modelFamilies.ts`. Replaced `RuntimeCard.tsx` when the agent page was reorganised around its controls (see [Agents Tab & Agent Page](agents_tab.md))
- `src/renderer/src/components/settings/LocalAgentsSettingsSection.tsx` — the **Engine Settings** section: the "Local engine" status row carrying Start/Stop, and the engine-path card below it
- `src/renderer/src/App.tsx:103` — `useEngineWatch()` mounted once in `Shell`, beside `useLocalAgentWatch()`

### Tests
- `src/main/engine/engineManager.test.ts` — **spawns real subprocesses**, binds real loopback ports, speaks real HTTP. The stand-in engine is a small node script implementing the two things the manager depends on (`--version`, and `GET /api/health` behind Basic auth). Each spawn dumps `{env, argv, pid}` beside the config it was pointed at, because the port, the hostname and the subcommand are only visible on the command line. See [Testing notes](#testing-notes)
- `src/main/engine/configGenerator.test.ts`, `binaryResolver.test.ts`, `engineConfigSource.test.ts`
- `src/main/services/localAgents/runtimeService.test.ts`, `promptAssembly.test.ts` + `__snapshots__/promptAssembly.test.ts.snap`
- `src/shared/modelFamilies.test.ts` — the classifier on its own: a table of ids per provider type, the version ranking (hyphenated minor, two-digit minor, a pinned date read as a snapshot and not as a version), preview losing to a stable older model, a wholly-preview tier still resolving, the gated tier never auto-selected, non-chat ids dropped, and `sameFamilyFallback` moving up before down and never crossing a family
- `src/renderer/src/components/agents/local/RuntimePanel.test.tsx` — the panel rendered in the jsdom project with its **six** hook modules mocked (`useLocalAgents`, `useChatModes`, `useModels`, `useProviders`, `useEngine`, `useAppSettings` — the sixth arrived with the remembered Advanced preference). Pins the pairing rules from the user's side: a credential change drops a foreign model and keeps a hand-written one, `Default (…)` names what would run for *this* credential, a foreign model already in the file is called out on open, and the pickers are disabled while the registry loads. It also pins the whole Advanced contract — which picker the manifest opens on, the two conversions and their status lines, the tier that cannot be converted (view moves, file does not), the model that cannot be converted (checkbox unavailable rather than springy, overriding even a sticky view, and released again once the model is cleared), the snapshot round trip, what a credential change forwards from a single-field and from a both-set manifest, and the fact that a refused write moves nothing. The two sides of `runtimeDefaults` are covered here and in `runtimeService.test.ts` rather than by a test of their own — the point of the module is that the two callers agree, which a direct unit test cannot observe
- `src/main/services/appSettingsService.test.ts` — the engine-path check

## Database Schema

**None.** This slice adds no table and no column. Its only persisted state is the `localAgentsEnginePath` row in `app_settings` (default scope) and the files under `<userData>/engine/`. Everything else lives in module state that dies with the process — deliberately, see `RunningEngine` below.

## IPC Channels

Every handler is activation-gated (`userActivation.requireActivated()`) and scoped with `getSettingsScopeUserId()` — the engine is machine-local.

| Channel | Signature | Notes |
|---|---|---|
| `engine:status` | `() → EngineState` | Synchronous read of module state |
| `engine:start` | `() → Promise<EngineState>` | `ensureRunning`. **Never rejects** — a failed start is the returned state, error sentence included. Can run for a minute (download) |
| `engine:stop` | `() → Promise<EngineState>` | Bumps the stop epoch, then halts |
| `engine:skips` | `() → EngineSkips` | The **running** config's skips. Read on demand, not pushed |
| `engine:state` | main → renderer push | Fires on every `EngineState` transition |

Three things are deliberately absent:

- **No channel returns the base URL or the auth password.** They stay inside `engineManager` so a component cannot be written that talks to the engine directly and routes around the Phase 6 runner
- **Nothing starts the engine at boot.** `registerEngineHandlers()` registers the shutdown hook and the state forwarder only
- **No channel exposes `engineManager.request()`.** It is a main-process seam for Phase 6

## Services & Key Methods

### `src/main/engine/engineManager.ts`

Module state: `state: EngineState`, `running: RunningEngine | null`, `startInFlight`, `reconcileInFlight`, `stopEpoch: number`, `binary`, `binaryResolvedFor`, `listeners`.

```
interface RunningEngine { child, baseUrl, authHeader, port, loaded }
interface LoadedConfig  { digest: EngineConfigDigest, agentKeys: Map, agentModels: Map, skippedAgents: SkippedAgent[] }
```

`loaded` is carried **on the process object** rather than in a module variable so it cannot outlive the thing it describes: when the process dies the record goes with it, and there is no window in which a stale record claims to describe a running engine.

| Method | Behaviour |
|---|---|
| `ensureRunning(userId)` | Running → **reconcile** via `applyConfigChange`, shared through `reconcileInFlight`. Not running → `startEngine` behind `startInFlight`. Captures the stop epoch **synchronously**, before the deferring `Promise.resolve().then(...)`, so a `stop()` issued in between is not mistaken for one that happened earlier |
| `applyConfigChange(userId)` | Rebuild (`refreshModels: false`) → **re-read `running` after the await** → `whatMoved(engine.loaded.digest, digestEngineConfig(built))` → nothing moved: return; `turnLock.anyHeld()`: log and return, **writing nothing**; else `await halt()`, re-check the epoch, `ensureRunning`. **Never starts an engine** |
| `stop()` | `stopEpoch += 1`, then `halt()` |
| `halt()` (private) | `stop()` minus the epoch bump. Awaits `startInFlight`, kills, sets `stopped`. An internal restart uses this so it cannot cancel itself, nor hide a user's Stop |
| `agentKey(agentId)` | `running?.loaded.agentKeys.get(agentId) ?? null` |
| `agentModel(agentId)` | `running?.loaded.agentModels.get(agentId) ?? null` — `{providerID, id}`, the split form `POST /api/session` takes |
| `lastSkips()` | `{agents: running?.loaded.skippedAgents ?? []}` |
| `request(path, init)` | Adds the Basic-auth header and fetches `${baseUrl}${path}`. Throws when not running. The Phase 6 seam |
| `getState()` / `onStateChange(fn)` | State + a listener set; a throwing listener is caught and warned, never allowed to break a transition |

`startEngine(userId, epoch)` is the only place that generates with `refreshModels: true` and the only place that writes: resolve binary (cache invalidated when the configured path changes) → `installing` → `starting` → `buildEngineConfig(await collectEngineConfigInput(userId, {refreshModels: true}))` → `writeEngineConfig(engineRootDir(), built)` → up to `START_ATTEMPTS` (2) `spawnAttempt`s. `cancelled(epoch)` is checked before the binary step, between attempts, and after a successful spawn.

`spawnAttempt(binaryPath, configPath, built, epoch)`:
- `pickLoopbackPort()` — bind `127.0.0.1:0`, read the port, close. The close→spawn race is made harmless by the retry, not eliminated
- `randomBytes(32).toString('hex')` password, fresh per spawn
- `spawn(binaryPath, ['serve', '--port', String(port), '--hostname', '127.0.0.1'], {cwd: engineRootDir(), env, stdio: ['ignore','pipe','pipe']})`
- **`logger.info('spawning the engine')` fires *before* the spawn**, not after a successful one: the transition most worth a record is an engine starting when nothing should have started one, and a line written only on success is exactly the line that would be missing then
- The `RunningEngine` is built here, including `loaded` — the only honest moment to record what a process read is the moment the bytes are handed over
- `child.on('exit')` moves the state to `failed` (guarded by `running?.child !== child`). Nothing polls, so this handler is the only thing that notices a dead engine
- `waitForHealth` polls `GET /api/health` every `pollMs`, aborting each request at `requestMs`, and **returns early when the child has exited** — without that, a crashed engine is indistinguishable from a slow one and the caller waits the full 45 s for a process that died in 200 ms

`ENGINE_TIMEOUTS` is a mutable object rather than four `const`s so a test can shorten the health window; production never writes to it. `healthMs: 45_000`, `pollMs: 250`, `requestMs: 3_000`, `stopGraceMs: 3_000`. `STDERR_KEEP = 4_000`, `ENGINE_USERNAME = 'opencode'`.

`stopEngineNow()` (on `will-quit`) is **synchronous**: bump the epoch, null `running`, `SIGTERM` inside the handler body. `will-quit` handlers are not awaited and a child is not reaped when its parent exits, so an async stop would leave an `opencode serve` running with no window to stop it from.

`engineEnv(configPath, password, credentials)` = `shellEnvForChild(await getShellEnv())` + `OPENCODE_CONFIG`, **`OPENCODE_CONFIG_DIR` (`dirname(configPath)`)**, `OPENCODE_SERVER_PASSWORD`, `OPENCODE_SERVER_USERNAME`, `OPENCODE_DISABLE_AUTOUPDATE='1'`, then the `CINNA_ENGINE_KEY_*` map.

**Both config variables, and the second is the one that matters.** `OPENCODE_CONFIG` is read by OpenCode's v1 config service. The v2 service — the one behind `model.available()`, and therefore behind every session's model resolution and every agent's system prompt — never reads it: it takes the *global config directory* (`OPENCODE_CONFIG_DIR ?? ~/.config/opencode`) plus a walk up from the **session's own `location.directory`**. A folder agent's session is located in the user's folder, nowhere near `<userData>/engine`, so without `OPENCODE_CONFIG_DIR` the engine resolved every turn against a catalog that had never heard of our providers — `ModelUnavailableError`, reported on no event at all. Verified as the single sufficient variable: [the contract](opencode_contract.md) §9.5.3. See [Shell Environment Resolution](../../development/shell_environment/shell_environment.md).

### `src/main/engine/configGenerator.ts`

`buildEngineConfig(input) → BuiltEngineConfig` is **pure** — no filesystem, no clock, no `app`. That is what makes "does a key ever reach the config" a question a test answers directly rather than by reading.

```
BuiltEngineConfig { config, env, providerKeys, agentKeys, agentModels, prompts,
                    skippedProviders, skippedAgents }
```

- Providers and agents are **sorted by id** before iteration. The same set must always produce the same bytes, or "did the config change" — which decides whether the engine restarts — would be answered by map iteration order
- Provider keys: `CANONICAL_PROVIDER_KEY` maps `anthropic→anthropic` and `openai→openai`. **`gemini` is deliberately absent**: OpenCode's canonical `google` key catalogues the Gemini models under `@ai-sdk/google`, which `SessionRunnerModel` cannot build a transport for, so every turn hung with `UnsupportedApiError` and no event ([contract](opencode_contract.md) §9.5.10). A `gemini` credential takes the custom path with `npm: '@ai-sdk/openai-compatible'` and `options.baseURL` = `GEMINI_OPENAI_BASE_URL`, verified on the wire as `POST /v1beta/openai/chat/completions` with `Authorization: Bearer <key>`, a bare `gemini-2.5-flash` model id and 12 tools (§9.5.11). A canonical key gets the models.dev catalog for free. The **second** credential of a type, and every `openai_compatible` gateway, gets `<sanitised>-<hash>` plus an explicit `npm` package (`PROVIDER_NPM`), `name` and full `models` map — a custom entry has no catalog. **Every model in that map also carries a `limit: {context, output}` from `CUSTOM_MODEL_LIMITS`, keyed by provider type**: without one the engine defaults the model to `{context: 0, output: 0}` and the Anthropic transport sends that as `max_tokens`, which the provider rejects with `400 "stream cannot be true when max_tokens is 0"` ([contract](opencode_contract.md) §9.5.9). The values are floors valid across each type's current line-up, not per-model truth — the desktop has no per-model metadata to be truthful with — and a **canonical** entry deliberately gets no `models` map at all, so models.dev's real windows are not overwritten with our approximations
- Skips: no stored key **for a type that needs one** (a keyless credential has none by construction, and skipping it here is how a local agent on a local model would have been dropped from the config with no symptom beyond an agent that does nothing); a type with no `npm` entry; an `openai_compatible` credential with no base URL
- `ollama` takes the custom path too, `npm: '@ai-sdk/openai-compatible'`, and never the canonical `ollama` key — models.dev's catalogue for it is what Ollama offers for *download*, not what this machine has pulled. `engineBaseUrl()` converts the credential's stored origin to `<host>/v1` (`ollamaOpenAIBaseUrl`), so the database keeps one spelling of the host and one place knows about the suffix; `PROVIDER_BASE_URL.ollama` covers only a row saved with no host at all. `CUSTOM_MODEL_LIMITS.ollama` is `{context: 32768, output: 4096}`. **No `tool_call` flag is emitted**: a custom entry's models report `capabilities.tools: false`, but a proxy between engine and Ollama showed the session runner sending the agent's full 12 tools anyway (8 Sep 2026, opencode 1.18.27) — it is catalogue metadata, not a gate, and declaring it true would assert tool-calling about every model of every custom entry
- `credentialEnvName(providerId)` = `CINNA_ENGINE_KEY_<sanitised, ≤40>_<SHA-256[0:8] upper>`. The hash suffix stops two ids that sanitise alike (`a-b`, `a_b`) from silently swapping keys
- `engineAgentKey(agentId, slug)` = `<sanitised slug, ≤40 or 'agent'>-<SHA-256[0:8]>` — **always suffixed**, so a key never depends on which other agents exist
- Provider credential: the entry carries **`env: ['CINNA_ENGINE_KEY_…']`** — the *name* of the variable, never the value and never an `{env:…}` placeholder. A **keyless** credential names one too, valued `KEYLESS_PLACEHOLDER_KEY` (`'keyless'`): omitting `env` would leave the entry on the availability filter's last branch (`integrationID === undefined && !integration`), which the contract records as transiently false for ~160 ms, where naming it takes the `connections.length` branch every working entry takes. Verified live: the entry is available and Ollama ignores the `Authorization: Bearer keyless` it receives. The v2 config reader performs no substitution, so a placeholder would be sent to the provider as the key itself; naming the variable instead registers an integration whose connection the session runner resolves out of the process environment, for canonical and custom entries alike. `options` exists only to carry an `openai_compatible` gateway's `baseURL`, and is omitted entirely when there is none
- Agent entry: `{description, mode: 'primary', model: '<providerKey>/<modelId>', prompt: <the assembled text, inline>, permission: mergePermissions(agent.permissions)}`. **Inline, not `{file:./prompts/<key>.md}`** — the v2 reader resolves no file reference and hands the literal placeholder to the model in place of the system prompt ([contract](opencode_contract.md) §9.5.4). `<providerKey>/<modelId>` in the entry is not what a turn runs on either; the session's own `model` is (§9.2), which is what `agentModels` carries
- `agentModels`: agent id → `{providerID, id}`, the same pair the entry's `model` string names, split the way `POST /api/session` takes it. Split here rather than at the runner because a model id may itself contain a slash
- Agent skips: the runtime's credential is not among the emitted providers; or the runtime names no model

`digestEngineConfig(built) → {config, env}`, two SHA-256 hex digests:
- `config` — the serialised config (`JSON.stringify(config, null, 2) + '\n'`, exactly what is written) then every `(key, promptText)` pair, sorted
- `env` — the `built.env` name→value pairs, sorted. **Not** the environment the child is spawned with, which carries a per-spawn password and the whole login shell and would therefore differ on every comparison
- Every piece goes through `framed(v)` = `` `${v.length}:${v}` ``. See item 3 of [Read this first](#read-this-first-if-you-are-working-next-to-the-engine)
- Entries are sorted here rather than trusting `buildEngineConfig`'s sort to stay put — this is the input to a restart decision and should not be one refactor away from restarting on map order

`writeEngineConfig(dir, built) → WrittenEngineConfig` — `opencode.json` plus `prompts/<key>.md` for each agent (**the engine no longer reads those files** — the prompt is inlined in the config; they remain as the readable copy the user's own assistant opens), each through `writeIfDifferent` (read-compare, then `writeFileSync(temp, {mode: 0o600})` + `renameSync`, temp removed on failure), then `pruneStalePrompts`. Logs **counts only**, never the config object. Its `changed` flag is **vestigial**: it *was* the restart decision, before that moved in-memory to the digest comparison in `engineManager`, which now happens before this is ever called. `startEngine` ignores the return value. It is a leftover, not a hook to build on — the question it answers ("do the bytes on disk differ?") is the one that cannot see a rotated key.

`pruneStalePrompts(promptDir, prompts)` — only `<userData>/engine/prompts/`, only `.md` files directly inside it, never a directory; a file it cannot delete is warned about and skipped rather than thrown, because failing the config write over a stale prompt would take the engine down for it.

`CONVERSATION_PERMISSIONS` (`:244`) — `'*': 'ask'` first (OpenCode's base rule is allow-everything, so an enumerated profile without this leaves every other tool on allow), then `read` (`*` allow + `SECRET_FILES`), `edit`/`write` (`*` allow + `IDENTITY_FILES` + `SECRET_FILES`), `bash` (`*` allow, then the `.env` accident guards and `sudo *` / `rm -r *` / `rm -rf *` / `rm -fr *` on ask), `webfetch: 'ask'`, `external_directory: 'ask'`. `SECRET_FILES` (`:218`) is `credentials/.env`, `*.env`, `*.pem`, `*.key` → **deny**; `IDENTITY_FILES` (`:239`) is `cinna-agent.json`, `docs/WORKFLOW_PROMPT.md` → **ask**. <!-- nocheck -->

Two spelling rules, both load-bearing and both explained in [permissions.md](permissions.md#the-pattern-language-is-not-a-glob-and-a-missed-pattern-fails-open): **never write `**`** (the matcher is not a glob, and `**/.env` never matches a root-level `.env` — a missed pattern fails open), and **write `'*'` first inside an entry** (resolution is `findLast`, so narrow shapes above the catch-all are dead). `configGenerator.test.ts` asserts both. The full profile with the reason for each entry is [Local Agent Permissions](permissions.md).

`mergePermissions(overrides)` — **shallow**, one permission name at a time. Deep-merging the pattern maps would let a manifest add `"*": "allow"` underneath our `bash` rules and quietly widen them. **Design flag for Phase 9**: a manifest can replace `bash` and the `'*': 'ask'` catch-all outright; the "the folder is the user's own" justification stops holding when Phase 9 installs a folder from the cloud into a shell-capable engine.

### `src/main/engine/engineConfigSource.ts`

Sits between `engineManager` (processes) and `configGenerator` (OpenCode's config shape) so neither knows about `providerService`, `localAgentService` or the manifest — which is what lets `engineManager` be driven in a test by a three-line fake supplier instead of a database.

- `collectEngineProviders()` — `providerService.listMerged()` filtered by `dto.enabled` **and** `isCredentialUsable` (`src/shared/credentials.ts`; the two terms of `isCredentialActive`, spelled out separately because each refusal carries its own reasoning), joined to `llmProviderRepo.listByUserIds(getManagedResourceScopes())` for the ciphertext and `baseUrl`. Decryption is now **conditional** rather than a precondition: a keyless row has no ciphertext and is collected with `apiKey: ''`, while a keyed row with no ciphertext is still skipped. A key that will not decrypt is **skipped with a warning naming only the provider id**, not a failed start
- `modelsByProvider()` / `cachedModels` / `refreshModelCache(scope)` — `getAllModels()` is awaited explicitly *before* a build rather than from inside the synchronous collector, so a start cannot block on an unreachable gateway. `scope: 'all'` fans out over every adapter; `scope: 'local'` calls `listModels()` directly on the adapters of keyless credentials (`listLocalModels()` / `localProviderIds()`), which is loopback and costs about a millisecond. Both fold into the cache through `mergeModelCache(previous, fresh, known)` in `src/main/engine/modelCache.ts`: a provider that answered is replaced, one that was silent **keeps its last good list**, ids missing from `known` are evicted, and an **empty** `known` evicts nothing (the credential DB and the adapter registry disagree for a moment before a profile's scopes resolve, and mass eviction there empties every custom entry)
- `collectEngineAgents(userId)` — `localAgentService.list(userId).agents`, skipping readiness `invalid` and `contract_too_new` outright; each remaining agent gets `runtimeService.resolve(agent.runtime, providers, cachedModels)` and `assembleAgentPrompt(agent.path, agent.manifest, context)` — or `assembleBareAgentPrompt(agent.path, agent.name, context)` where `agent.kind === 'bare'`, the one branch [bare agents](bare_agents.md) add to this module. The **cached** catalogue is handed in deliberately, not a fresh fetch: a work-complexity tier resolves against what a credential lists, and comparing a reconcile against a list that drops out whenever a gateway is briefly unreachable would restart the engine for a change nobody made. An agent whose runtime resolves to nothing **is still emitted**, so `configGenerator` can report it as a skip with a reason rather than the agent merely being absent. **`enabled` is not consulted** — a disabled agent gets an entry, a key and a prompt file. That is deliberate (the config is a catalogue of what can be addressed), but it means **the Phase 6 runner must gate on `enabled` itself**; nothing in this slice does, and `agentKey()` returns a key for a disabled agent
- `collectEngineConfigInput(userId, {refreshModels})` — the only entry point. `refreshModels` defaults to **true** (→ `'all'`); `applyConfigChange` is the only caller that passes `false`, which now means `'local'` rather than no refresh at all: a local catalogue is empty whenever the server was down at engine start, and a custom entry with no models can address none — the failure reaches no engine event, so every agent on it hung for the desktop's twenty-minute ceiling

`getAllModels()` (`src/main/llm/registry.ts`) loops adapters **serially** and awaits `listModels()` on each — a real network round trip per configured credential (Anthropic's SDK paginates, OpenAI's SDK, a `fetch` for Gemini).

### `src/main/services/localAgents/runtimeService.ts`

- `resolveDefault(providers?)` — via `chatModeService.resolveEffectiveDefault()`, so it honours the local/account precedence toggle and a managed mode's per-profile model override. Returns `source: 'none'` with a sentence when there is no default mode, or when the mode points at a credential this machine no longer has. Both live branches — the machine-wide pin (`localAgentsDefaultCredentialId`) and the default chat mode — build their reason through `defaultCredentialProblem(provider, lead)`, which ranks *no usable key* above *switched off* and prefixes whichever setting chose the credential. They previously tested `isUsable` alone, so the whole Default runtime — the path every agent that declares no credential takes — said nothing when its credential was switched off. Its `modelId` goes through `defaultRuntimeModelId`, **not** `mode.modelId` raw: a mode on *First available* names no model and the credential's own default is the answer. The Medium floor is deliberately **not** applied here — the floor belongs to resolving one agent, and applying it twice would floor against the *default* credential's catalogue and then lend that model to an agent on a different key
- `resolve(runtime, providers?, models?)` — three arguments now; `models` is the aggregate `{id, providerId}` registry, narrowed by module-private `catalogueFor()` to the **chosen** credential's rows. Manifest first, then the default. Every model decision — a declared id, a tier, the inheritance chain, the Medium floor — comes back from one `resolveRuntimeModel` call, whose `origin` and `replaced` land on the result as `modelSource` / `replacedModelId`. The old early return for a manifest with no `runtime` block is **gone**: such an agent is resolved like any other so the floor can reach it, and `source` is still reported as `'default'` (or `'none'` when there is no fallback credential at all). An unknown credential reference produces `credentialRef` + a reason naming what it asked for and what it got, and now resolves its model against the credential it actually got. See [A model is lent only where it can actually run](engine.md#a-model-is-lent-only-where-it-can-actually-run). `source` is `'manifest' | 'default' | 'none'`
- `reason` is ordered **credential problems before model problems** — a model cannot be fixed while the key it would run on cannot make a call, and a switched-off credential is not handed to the engine at all, so no model choice under it can run — and an agent borrowing the Default runtime inherits that runtime's own complaint, which returning `fallback` verbatim used to do for an empty manifest and never did for a manifest naming only a model. The model-less sentences distinguish three states: an empty tier on a credential that *did* list models ("Pick another complexity or another credential — X lists no model for Complex work" — remedy first, since the line truncates at the 800px minimum, and the tier capitalised through the `WORK_COMPLEXITY_LABELS` table the panel uses too, so the two sentences cannot drift), a tier with **no catalogue read at all** (the registry has not loaded — claiming a list is empty when nobody read one is an assertion, not a report), and no model declared anywhere
- The "nothing to run on" reason lines name the **“Runs with” panel** as the place to fix it, matching the panel's own `aria-label`. A reason that names a surface the app does not have sends the user looking for it
- `credentialUsable` and `credentialEnabled` are **two facts on `RuntimeFacts`**, not one. `describeCredential` (`src/shared/runtimeMessages.ts`) ranks *not configured* → *no credential at all* → *no usable key* → *switched off*, and the switched-off sentence is the only one that does not name the credential (it is the longest in the ladder, the panel truncates, and the name is already in the select above). Where the agent declares no credential of its own, both facts are read from the **row** the Default runtime resolved to rather than from `fallback.credentialId !== null`: a `ResolvedRuntime` carries neither field, so on the branch that does not reuse `fallback.reason` verbatim — a manifest declaring a model or a tier but no credential — a runtime that could not run was reported as healthy
- `findCredential(providers, reference)` — a delegate to `findCredentialByReference` (`src/shared/credentials.ts`). Id, then name, then provider type; name and type case-insensitive, with the tie-break ranked **active, then merely usable, then whatever matched**, because a managed `Anthropic` and the user's own can share a name. The name stays exported here because that is where callers and tests look for it and a `ProviderDto`-shaped signature is what they pass; the resolution moved because the "Runs with" panel had a hand-written copy that drifted the moment this side learned to prefer an enabled row
- `applyToManifest(manifest, input)` — validates and mutates in place. Refuses a key-shaped credential using the validator's own `SECRET_LOOKALIKE` (`src/main/kit/validator.ts`); refuses a complexity outside the three the contract defines; refuses `modelId` **and** `complexity` together rather than inventing a precedence; caps at 200 chars each; writes one of `model` / `complexity` and deletes the other, so a manifest that arrived carrying both leaves with one; deletes `manifest.runtime` entirely when all three fields clear **and** no unknown keys remain; preserves `permissions` and anything else a newer contract adds. Throws `LocalAgentError('invalid_input')` — the same `DomainError` family the rest of the local-agents surface uses
- **No filesystem access.** The write goes through `localAgentService.updateField` → `manifestIo.writeIfUnchanged`, the same stamped path as every other editable file

### `src/main/services/localAgents/promptAssembly.ts`

`assembleAgentPrompt(agentDir, manifest, context)` joins its sections with `\n\n---\n\n` and appends a trailing newline. Order: workflow prompt (or the "no instructions yet" stand-in) → `## Your scripts` → `## Your credentials` (preceded by the never-read-the-secret-files rule) → `## Your knowledge` → `## Handing over` → `## How you are running now`.

- `readTextFile` returns null for missing / unreadable / non-file, and truncates at `MAX_SECTION_BYTES` (64 KB) with an ellipsis
- `stripHtmlComments` removes `<!-- … -->`, then a **trailing unterminated `<!--` and everything after it** (a half-written comment is a real state a file is in while someone types; leaving the opener would put the document's tail into the prompt as an instruction), then collapses blank runs and trims
- `listKnowledgeTopics(agentDir)` walks `Local/<slug>/knowledge/` to `KNOWLEDGE_MAX_DEPTH` (3), name-sorted, dotfiles skipped, `.md` only, `MAX_KNOWLEDGE_TOPICS` (200) ceiling, root-level `README.md` excluded. Returns agent-relative POSIX paths. **The list, never the contents**
- `handoverSection` reads `manifest.handovers[]`, keeping entries with a non-empty `target_slug`
- `desktopContextSection` — conversation mode, `uv run scripts/<name>.py`, write only under `app-data/`, never read or print a credential, locale + time zone, long output to `app-data/storage/`, and **do not switch to the Builder role**
- `assembleBareAgentPrompt(agentDir, name, context)` — `AGENT.md` (comment-stripped, or the empty-file stand-in) → `bareDesktopContextSection`, and nothing else. `README.md` is **not** read here; it belongs to the init prompt. See [Bare Agents & External Roots](bare_agents.md#the-prompt-is-agentmd-and-nothing-else-the-folder-contains)
- `bareDesktopContextSection` — the same block minus the three folder-convention rules (`uv run`, write-only-under-`app-data/`, `credentials/.env`), plus one line deferring to the folder's own instructions. The never-print-a-credential rule, the locale line, the long-output rule and the Builder line are all kept
- `resolveDesktopPromptContext()` — `Intl.DateTimeFormat().resolvedOptions()`, falling back to `en-US` / `UTC`, never throwing
- Both `readdirSync` call sites annotate `Dirent<string>[]` explicitly: `ReturnType<typeof readdirSync>` resolves to the Buffer overload, which types `entry.name` as a Buffer and produces type errors pointing nowhere near the cause. Same note in `binaryResolver.findBinary`

### `src/main/engine/binaryResolver.ts`

**The download/verify/publish machinery was extracted to `src/main/managed/managedAsset.ts`** (`installPinnedAsset()`, `downloadToFile()`, `extractArchive()`, `sha256File()`, `findNamedFile()`, `sweepStaging()`, `isFile()`, `ManagedAssetError`, `PinnedAsset`) and is shared with `src/main/localdev/toolchain.ts` — see [Local Development](../local_dev/local_dev_tech.md#srcmainmanagedmanagedassetts). `binaryResolver.ts` re-exports `downloadToFile`, `extractArchive` and `sha256File` for existing callers, aliases `EngineAsset = PinnedAsset`, and `EngineBinaryError extends ManagedAssetError<EngineBinaryErrorCode>`. The sequence below is `installPinnedAsset`'s and is unchanged.

`BinaryResolverDeps` (`configuredPath`, `which`, `engineRoot`, `download`, `extract`, `probeVersion`, `platformKey`, `assets`, `version`) is **injected rather than module-mocked** because the interesting cases are failures — a digest mismatch, an extraction with no binary, a dead download — and each must be reproducible without a network. `assets` is injected too, so a test can pin a digest it computed itself; a test that cannot produce a mismatch is not testing verification.

`installPinned` sequence: `mkdir(root)` → `.staging-<pid>-<now>/` → `download(assetUrl(version, file), archive)` → `sha256File(archive)` compared against the pin (**mismatch is loud, nothing is unpacked, nothing survives**) → `extract` → `findBinary(unpacked, depth 2)` → `chmod 0o755` (non-Windows) → `rename(dirname(found), installDir)`, whose failure is tolerated **only when `installed` now exists** (another caller published first, having passed the same check) → `rm(staging)` in a `finally`.

Timeouts and ceilings: `VERSION_TIMEOUT_MS` 10 s, `DOWNLOAD_TIMEOUT_MS` 10 min, `EXTRACT_TIMEOUT_MS` 5 min, `MAX_ARCHIVE_BYTES` 200 MB (checked against `content-length` **and** enforced by a counting `TransformStream`, because a redirect that streams forever would otherwise fill the disk before the digest was ever computed).

`extractArchive` shells out to `tar -xf`. macOS's `/usr/bin/tar` and Windows 10 1803+'s `tar.exe` are **bsdtar**, which reads zip as well as tar.gz; Linux only ever gets a tar.gz. One command covers both shapes, and no unzip dependency was added. `EngineBinaryError` codes: `unsupported_platform`, `configured_missing`, `configured_unusable`, `checksum_mismatch`, `extract_failed`, `download_failed`.

Bundling binaries as `extraResources` is deferred with a `TODO(packaging)` in the module header: it needs an `extraResources` block (none exists — seam 14), proof that a Bun single-file executable launches from a notarised macOS bundle, and a fourth resolution branch preferring `process.resourcesPath`.

## Renderer Components

| Component / hook | Renders / manages |
|---|---|
| `useEngineState` | `['engine-state']`, seeded from `engine:status`. **Nothing polls** |
| `useEngineWatch` | One `engine:state` subscription for the app's lifetime; writes the pushed state straight into the cache and invalidates `['engine-skips']`. Mounted in `Shell` |
| `useEngineSkips` | `['engine-skips']` from `engine:skips`. Only ever recomputed by a config generation, and every generation moves the state — so the push *is* the staleness signal |
| `useStartEngine` / `useStopEngine` | Mutations that write the returned state into the cache. `isPending` covers the download. **A failed start resolves**, so callers render `data.error`, not a mutation error |
| `RuntimePanel` | Credential `<select>` (usable providers, by **name**, a switched-off one suffixed `— inactive` through `credentialOptionLabel`; the list deliberately includes credentials that cannot run, which is what lets an agent pointing at one say so rather than reading as unconfigured), then **one** of three controls in a single slot: the work-complexity `<select>` (the three tiers, `(none listed)` appended to one this credential cannot serve), the model `<select>` (registry models for the effective provider; `Default (…)` from `resolveRuntimeModel`), or a disabled `Loading…` placeholder while neither the manifest nor the remembered preference can yet say which picker this agent gets. An **Advanced** checkbox sits on the label row and is rendered in both views, so switching cannot change the panel's height. Then `EngineStatus`, `SecretsLine`, the not-editable note, and **one fixed-height status line** that carries every message the panel has — including the engine's skip reason, which has no component of its own. Reads `useEngineSkips` directly. Writes via `useSetLocalAgentRuntime` → `local-agent:update-field` with the manifest stamp, sending `{credential, modelId, complexity}` |
| `EngineStatus` (private) | The engine's state as a dot and a word, plus a Start button shown whenever it is not running |
| `LocalAgentsSettingsSection` | The **Engine Settings** section. A `SettingsStatusRow` for the engine — status, version, which source — with Start/Stop as its `action`, so the state and the control that changes it are one row; its tone is `ok` when `running`, `warning` only when `failed`, and `neutral` otherwise, because a turn starts the engine by itself. Below it the engine-path card: label, hint, input, and a reserved `min-h-[1.125rem]` slot for the save error or the pending-restart note |

Renderer rules that are decisions, not styling:

- **A model the manifest names but the registry has never listed is still rendered as an option**, and a credential change keeps it. Without that, opening the panel would silently reset the agent's model to the default the moment the user touched the credential picker, and a hand-written id for a gateway catalogue this app cannot see would be treated as a mistake
- **A credential change *does* clear a model the registry attributes to another catalogue**, and says so in the status line. The pair would otherwise be written into a manifest the generator turns into `openai/claude-sonnet-4-5` — a config that saves and fails at the agent's first turn. `modelBelongsElsewhere` decides, and it declines in exactly the cases `inheritedModelId` declines to guess in, so the panel can never lend a model in the select while calling it foreign in the warning
- **The pickers are disabled until `useModels` resolves** (or fails). It is a network round trip per credential, so on a cold page it lands after the provider list — and before it does, a model that belongs elsewhere is indistinguishable from one the registry has not listed yet. The status line says which of the two states it is in
- **The model select stays enabled with an empty list plus a note once the registry has loaded.** `useModels` is the aggregate registry, and a credential it has nothing for is not a credential that cannot run
- **The two `Default (…)` labels are lookups, not guesses.** The credential picker's names the resolved Default runtime's credential, looked up across *all* providers rather than the usable ones — `resolveDefault` does the same, and a default mode pointing at a credential with no stored key has to read here as it does to the engine. The model picker's names `resolveRuntimeModel`'s answer for the *chosen* credential, by registry name where there is one and by id otherwise. The panel resolves the manifest's credential reference with the **same function** the engine does, `findCredentialByReference` in `src/shared/credentials.ts` — id, name, then type, across *all* providers — because searching only the usable ones sent the catalogue lookup for a credential with no stored key to the **default** credential instead. It was a hand-written mirror until main's tie-break learned to prefer a credential that is switched on, at which point two rows sharing a name resolved differently on the two sides: the engine ran one and this panel described the other
- **The manifest decides which picker opens; the remembered preference only breaks a tie.** The view is `true` for an agent that names a model, `false` for one that names a tier, and `localAgentsModelAdvanced` only for one that names neither. After first render it is **sticky per agent** (`{agentId, advanced}`), because both pickers have choices that leave the manifest declaring nothing — selecting `Default`, or moving to a credential that drops the model — and deriving the view from the manifest alone would answer each of those by swapping the control the user is working in
- **Neither picker is claimed until one is known.** `settings?.x === true` reads `false` in flight, so a user whose preference is Advanced would watch the tier select render and then be replaced. The disabled `Loading…` select holds the same footprint and makes no claim
- **Two Advanced outcomes reach the toggle, and the third state never does.** A conversion that writes moves the view in the mutation's `onSuccess`, so a refused write never leaves the panel showing a control the file does not back. A conversion with nothing to write — a tier this credential lists no model for — moves the view **immediately**, because it succeeded and simply had nothing to write; routing it through the mutation would spring the checkbox back under the pointer that clicked it. The question separating the two is whether the picker the user asked for can represent this file honestly: a model select sitting on `Default` over a file that still names a tier is not lying, while a tier select sitting on `Default` over a live pinned model would be
- **A model no family recognises disables the checkbox rather than refusing the click.** `unconvertible` — a declared model `classifyModel` returns null for, the ordinary case for a gateway's `my-private-llm-7b` — forces `advanced` true, **overriding both the sticky per-agent view and the remembered preference**, and disables the control behind a standing status line (`Advanced stays on — “…” matches no work complexity.`, consequence first so the clause explaining the dead control survives the 800px truncation whatever the length of the id, which is the user’s and not ours). A control that snaps back to its old value tells the user nothing and invites the same click again; a disabled one with the reason beside it is a state that can be read once and acted on, and clearing the model re-enables it without anyone being told to retype a hand-written id. `toggleAdvanced` still returns without writing when no tier can be derived — the guarantee is "never convert what cannot be converted", and one that lived only in whether a control is clickable would be one line of JSX from being lost
- **The model a tier was converted from is remembered** (per agent) and restored when the tier has not moved since. `bestInTier` prefers a stable alias, so re-deriving would trade a deliberately pinned dated snapshot for a floating one — through a control that only claims to change the view
- **A credential change forwards what the *manifest* holds, and the view breaks only a genuine collision.** Sending both keys of a manifest that legally carries both (a newer tool wrote it; the validator only warns) makes `applyToManifest` throw `A runtime names a model or a work complexity, not both` — a refusal about a key the user cannot see, from a control that has nothing to do with it. Sending only the *visible view's* field went too far the other way and **deleted the other one**, which is reachable and cruel: an agent whose tier resolves to nothing shows the Model picker over a manifest that still says `complexity: complex`, having just advised "pick another complexity or another credential" — and taking the second half of that advice here destroyed the tier. So a single-field manifest keeps its field whichever picker is showing, and only a both-set manifest loses one: the one not on screen. "The desktop never writes both" stays true by construction rather than by a throw at the far end
- **The engine-path field follows the saved value until the user types in it.** The settings query has not resolved on first render, so without the effect a user with a path already set sees a blank box and reasonably concludes nothing is configured
- **A saved engine path takes effect on the *next* start** — the resolved binary is cached and the running process is the old one either way — and the section says so rather than leaving the user to wonder why the version line did not move. That note and the save error share one always-present slot **below** the input, with the explanatory hint moved **above** it, so a message arriving after a blur moves nothing the user is about to click
- **The field's placeholder is the path alone** (`/usr/local/bin/opencode`). It used to carry the "leave empty to let Cinna find one" half too; at the settings type scale that sentence measured 462px in a 399px box at the 800px minimum window, and the half that got cut was the instruction. It lives in the hint instead
- `canEdit = stamp !== null && readiness !== 'contract_too_new'`; a stale-write refusal renders the reload sentence via `isStaleWriteError`

## Configuration

| Setting | Scope | Meaning |
|---|---|---|
| `localAgentsEnginePath` | `app_settings`, **default (machine-local)** | Absolute path to an `opencode` executable, or `''` for "resolve one". Validated as *absolute or empty only* — whether it exists and runs is answered by `binaryResolver` and surfaced as engine **state**, not as a rejected save |
| `localAgentsModelAdvanced` | `app_settings`, **default (machine-local)** | `false` (work complexity) or `true` (the raw model list): which picker the “Runs with” panel opens on for an agent whose manifest names **neither**. Written only by the panel — from the Advanced checkbox and from a conversion — and there is no Settings control for it. A `typeof` is the whole validation |

Constants worth knowing: `PINNED_ENGINE_VERSION = '1.18.27'` (`src/shared/engine.ts`); `ENGINE_ASSETS` — six platform entries, `linux-*` on glibc (musl/Alpine is the known gap); release root `assetUrl(version, file)`.

Generated files, none of which is ever inside an agent folder:

```
<userData>/engine/opencode.json
<userData>/engine/prompts/<agentKey>.md
<userData>/engine/opencode-<version>/opencode        (managed install)
<userData>/engine/.staging-<pid>-<ts>/               (transient; junk after a crash, never an install)
```

`cwd` for the spawned process is `<userData>/engine/`.

## Security

- **Invariant 4, mechanically.** A key exists in exactly two places: `built.env` (a map handed to `spawn`) and the child's environment. The config file carries `{env:CINNA_ENGINE_KEY_…}` references. `engineConfigSource` is the only module that calls `decryptApiKey`, and it hands the value straight to `buildEngineConfig`
- **`GET /config` on the engine returns keys.** OpenCode resolves `{env:…}` in that response. Never log, echo or forward it
- **Loopback only.** `--hostname 127.0.0.1`, a port the desktop picked, Basic auth with a fresh `randomBytes(32)` hex password per spawn — never written to disk, never logged, never sent to the renderer. **`--mdns` must never be passed**: it defaults the hostname to `0.0.0.0` and advertises the server. A test asserts the argv, because nothing else in the suite looks at the command line
- **The address never crosses a boundary.** No IPC channel, no preload method, no field on `EngineState`
- **The child's environment is narrowed**, not inherited: `shellEnvForChild(await getShellEnv())` — the same allowlist a third-party stdio MCP server gets — plus four named variables and the credential map. The thing running inside is a model with a bash tool, so a leaked `.zshrc` is one prompt injection from being read aloud
- **`OPENCODE_DISABLE_AUTOUPDATE=1`.** A pinned, checksum-verified binary that replaces itself is exactly what the checksum exists to prevent
- **Logs never carry key material.** `whatMoved()` returns the words "config" / "credentials"; `writeEngineConfig` logs counts; a refused decrypt logs the provider id only; digests are never logged, digested or not
- **`credentials/.env` is `deny` in the permission profile**, not `ask` — see [engine.md](engine.md#the-permission-profile)
- **The download is verified before it is unpacked**, and only a verified tree is published. The digests pin bytes, not provenance: they are not a signature
- **Nothing renderer-supplied becomes a path.** The engine path is an `app_settings` value validated as absolute; every other path here is derived from `app.getPath('userData')`

## Testing notes

**Mutation-checked and pinned:** the loopback hostname and `serve` subcommand (replacing the port picker with a hard-coded 4096 and `--hostname 0.0.0.0` both used to leave the file green); the per-start password; that a key reaches the process environment and never the config on disk (`engineConfigSource.test.ts` drives it end to end, keystore to disk); the deterministic byte-for-byte config output under reordered input; the stable agent key across a same-slug sibling; env-name collision resistance; the checksum-mismatch, no-executable and failed-download branches each leaving nothing behind; the model-refresh flag on both paths.

**Named gaps, deliberately left rather than faked** (all three are in the `engineManager.test.ts` header, and all three are *correct code that happens to be unexercised* — not known-broken behaviour):

1. **The stop epoch is not pinned by the two tests that read as if it were.** Removing the post-`halt()` `cancelled(epoch)` check and the `stopEpoch += 1` in `stopEngineNow` leaves the file green. What actually fails "does not undo an explicit stop…" and "spawns no engine when the app quits…" is the **re-read of `running` after the await** — the fakes park the reconcile before that re-read. Do not delete the re-read believing the epoch covers it. The epoch guards the narrower window (a stop landing *during* `await halt()`), which these fakes cannot open
2. **`await pending` in `halt()` is not pinned.** `void pending` leaves the whole suite green. Reaching it needs a start parked between its last checkpoint and the `spawn`, i.e. a hold inside `getShellEnv` rather than inside config generation — and even then the observable is a race between continuations
3. **`resetEngineStateForTests()` is belt-and-braces.** Emptying its body leaves the file green, because every `beforeEach` points the engine path at a fresh temp dir and the production `binaryResolvedFor !== configured` guard already forces re-resolution

**Not covered at all:**

- The download **sequence** (`downloadToFile` → `extractArchive` → `chmod` → `rename`, including the lost-race branch). Every piece is hand-verified against the real binary; the sequence has only run against fakes
- `writeIfDifferent`'s atomicity under interruption — a writer killed between write and rename must leave the previous config intact. Needs a crash, not a mock. The visible consequence (no surviving `.tmp`) *is* tested
- The `knowledge/` topic sort (pre-existing: `readdirSync` already returns name order on APFS)
- **The engine controls in Settings.** The engine-path field and the Start/Stop button are typechecked and bundled but **never rendered** by a test. `RuntimePanel` is not among them: `RuntimePanel.test.tsx` renders it directly, which the page test cannot — it mocks the panel to a marker. What that suite does not reach is `EngineStatus`, since it pins the engine to `running` and the Start button only exists when it is not
- The reconcile's cost. Per turn it does a keychain decrypt per credential and a full prompt re-assembly per agent — file reads plus the `knowledge/` walk, since `scannerService.scanRootCached` caches only the folder *scan*. Reasoned to be a few milliseconds, never measured. **If Phase 6 sees unexplained turn latency, look here first**

**Test conventions specific to this slice:**

- `engineManager.test.ts` spawns real processes because every question worth asking — does the health check notice a dead process, does an external `kill` get seen, do two concurrent starts produce one engine — is a question about processes, and a mocked `spawn` answers all of them "yes" by construction
- **Never assert absence by asking the child.** It is SIGTERM'd within a millisecond of a stop, well before a node process finishes booting, so "no dump file appeared" is also satisfied by a process that *was* spawned and died early. Absence is asserted on artefacts the **parent** writes — the generated `opencode.json` — which is synchronous and cannot race

## The engine contract, as verified

Against real `opencode` **1.18.27**:

| Fact | How it was established |
|---|---|
| Asset SHA-256 for all six platforms | Downloaded and hashed |
| `tar -xf` reads the `.zip` assets; binary at archive root on macOS/Windows | Unpacked and run |
| `--port` / `--hostname` spellings; `serve` subcommand | Run |
| `GET /api/health` → exactly `{"healthy":true}` | Requested |
| Basic auth via `OPENCODE_SERVER_USERNAME` / `OPENCODE_SERVER_PASSWORD` | Requested with and without |
| `CUSTOM_MODEL_LIMITS.anthropic` | `modelLimits.ts` | `{context: 200000, output: 32000}` | A custom entry has no models.dev catalog, so the engine defaults its models to `{0, 0}` and the Anthropic transport sends `output` as `max_tokens` — zero is a provider-side 400. A floor valid across the type's current line-up, **not** per-model truth; a value too high is rejected on the first turn, one too low silently truncates a long answer ([contract](opencode_contract.md) §9.5.9) |
| `CUSTOM_MODEL_LIMITS.openai` | `modelLimits.ts` | `{context: 128000, output: 16384}` | as above |
| `CUSTOM_MODEL_LIMITS.gemini` | `modelLimits.ts` | `{context: 1048576, output: 65536}` | as above |
| `CUSTOM_MODEL_LIMITS.openai_compatible` | `modelLimits.ts` | `{context: 128000, output: 8192}` | as above; a gateway is whatever the user pointed it at, so the cautious pair |
| `CUSTOM_MODEL_LIMITS.ollama` | `modelLimits.ts` | `{context: 32768, output: 4096}` | a local window is a property of the weights and of `num_ctx`, unknowable from the tag; over-claiming here does **not** fail loudly — Ollama truncates the context silently — so the pair is small enough to be true almost everywhere. `/api/show` would give the real figure per model |
| `OPENCODE_CONFIG` points the v1 config reader at our generated file | Run |
| `OPENCODE_CONFIG_DIR` points the **v2** reader at it, for every session location | Contract §9.5.3 |
| Loopback binding | `lsof` |
| OpenCode's base permission rule is allow-everything | `GET /agent` read back off a running engine |
| **`--port 0` binds 4096**, not an OS-assigned port | Run |
| **A second `serve` against a taken 4096 does not fail** — it comes up silently on an unpredictable port | Run, 3 Sep 2026 |

The last two are why the port is picked here rather than delegated. An earlier note claimed the second instance dies on a SQLite `CREATE TABLE`; that did **not** reproduce, though the re-check shared one config and data directory and did not capture the engine's own logs, so a logged error may still exist.

`GET /config` returning the resolved (key-bearing) config is recorded from OpenCode's documented behaviour and the `{env:…}` substitution the config relies on — it is the one contract item in this table not confirmed by a request in this phase, and Phase 6 should treat it as true until it proves otherwise, not the reverse.

## Phase 6 seam

What Phase 6 attaches to, and the two rules that come with it:

- `engineManager.ensureRunning(userId)` — **call it before the turn, outside the turn lock.** Calling it after the runner has taken the lock is not unsafe, merely useless: the change is written and then deferred past the very turn that asked for it, landing one turn later
- `engineManager.agentKey(agentId)` — the OpenCode agent entry to open a session against. Null means "not addressable right now"; do not synthesise one
- `engineManager.agentModel(agentId)` — the `{providerID, id}` to open it *with*. The engine reads a session's model from the session alone; an agent entry's `model` is not consulted on that path
- `engineManager.request(path, init)` — the only way to reach the engine. Keeping the base URL and password inside the module is what makes "everything goes through the runner" structural
- `engineManager.lastSkips()` — why an agent is not addressable
- **Gate on `enabled` in the runner.** The generated config ignores it, so a disabled folder agent has a config entry and a live `agentKey`. Nothing below the runner will refuse the turn
- **`refreshModels: false` stays false on the reconcile path.** If a newer model list is needed, ask for it explicitly
- Whether a restart between two turns of the same chat loses engine session state is **open**, and belongs to Phase 6 with session continuity (seam 9). Invariant 3 is satisfied here only at engine granularity
