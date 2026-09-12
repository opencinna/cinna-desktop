# The Local Engine, Runtimes & Prompt Assembly — Technical Details

Implementation reference for [The Local Engine, Runtimes & Prompt Assembly](engine.md). Path convention as in that doc: `src/...` is this repository; `Local/<slug>/...`, `cinna-agent.json` and `app-data/...` are inside an agent folder; `<userData>/acp/...` and `<userData>/engine/...` are the app data directory.

The turn that uses all of this — the driver, the process pool, the session and the translator — is [The Agent Turn](agent_turn_tech.md). This document stops at the plan a launcher hands over.

## Read this first if you are working next to the engine

Four things here will produce a silent, green-suite failure if changed carelessly. Each is argued in [engine.md](engine.md); this is the index.

1. **The launch spec's `key` is the only thing that replaces a running process.** It digests the binary, the arguments, the generated config bytes and the credential map. Drop any one of them and a change the user made — a rotated key most sharply, which leaves the config bytes identical — reaches the agent only after the process happens to be reaped
2. **The digest is length-prefixed (`framed()`), not delimiter-joined.** A collision is a *false negative*: the key does not move, the process is not replaced, and the agent keeps running on the previous prompt with every test still passing
3. **The model is stated in the config's top-level `model` *and* on the session.** The agent entry's own `model` is ignored over ACP, so either statement alone lets a session start on whatever the engine picks first — silently
4. **Every model decision goes through `resolveRuntimeModel` in `src/shared/runtimeDefaults.ts`**, called by `runtimeService.resolve` *and* by the “Runs with” panel. A model derived in either caller alone is a label that predicts a runtime the engine will not build — and both sides keep passing their own tests while they disagree

## File Locations

### Shared
- `src/shared/engine.ts` — the wire contract. `EngineBinarySource`, `EngineBinaryState` (`unresolved | resolving | ready | failed`), `ENGINE_BINARY_CHANNEL` (`'engine:binary-state'`), `PINNED_ENGINE_VERSION` (`'1.18.27'`), `RuntimeSource`, `ResolvedRuntime` (with `engine`, `modelSource: ModelOrigin` and `replacedModelId`), `LocalAgentRuntimeInput`, and the `AgentEngine` axis itself (`isAgentEngine`, `DEFAULT_AGENT_ENGINE`, `claudeModelForComplexity`, `ClaudeApproval`). **`EngineStatus`, `EngineState` and `EngineSkips` are gone** — there is no server to have a status, and a skip list described one shared config. Type-only or plain constants; nothing key-shaped, no address
- `src/shared/agentDrivers.ts` — `AcpLauncherId` (`opencode | claude | gemini | codex`), `ACP_LAUNCHER_IDS`, `isAcpLauncherId`, `launcherConfig`, `launcherOfConfig`. The launcher lives here rather than beside the ACP code because it is a **stored row value** and the row model may not import the ACP SDK
- `src/shared/runtimeDefaults.ts` — `resolveRuntimeModel(input)` → `{modelId, origin, replaced}`, the one entry point both sides use; plus `inheritedModelId`, `defaultRuntimeModelId`, `modelBelongsElsewhere`, `COMPLEXITY_FLOOR` (`'medium'`) and the `ModelOrigin` union
- `src/shared/modelFamilies.ts` — the work-complexity classifier: `classifyModel`, `bestInTier`, `sameFamilyFallback`, the labels and hints. No network, no filesystem — the catalogue is always passed in
- `src/shared/runtimeMessages.ts` — `EngineSkipCode` and `describeEngineSkip`. Still a **code, not a sentence**, and still the words a refusal is rendered with; what changed is who renders it — the launcher returns the sentence as the turn's error instead of a screen completing a skip entry
- `src/shared/appSettings.ts` — `localAgentsEnginePath` and `localAgentsModelAdvanced`
- `src/shared/kit/manifest.ts` — `AgentRuntimeRef` (`engine`, `model`, `complexity`, `credential`, `permissions`, plus an index signature for the round-trip rule)

### Main process — `src/main/engine/`
- `engineBinaryService.ts` — `engineBinaryService.{state, ensure, refresh, onChange}` and `createEngineBinaryService(deps)`. All that is left of `engineManager`. `ensure()` is **memoised per configured path**, shares one in-flight resolution between concurrent turns, and never caches a failure; `refresh()` is Settings' *Check again* and resolves the state rather than rejecting
- `binaryResolver.ts` — the three sources, `ENGINE_ASSETS` (six pinned `{file, sha256}` entries), `resolveEngineBinaryWith(deps)`, `configuredEnginePath()`, `probeEngineVersion()`, `engineRootDir()`, `realBinaryResolverDeps()`, `EngineBinaryError`
- `configGenerator.ts` — `buildEngineConfig()` (pure), `digestEngineConfig()`, `CONVERSATION_PERMISSIONS`, `credentialEnvName()`, `engineAgentKey()`, and module-private `framed`, `mergePermissions`. **The writer is gone**: no `writeEngineConfig`, no prompt files, no pruning
- `engineConfigSource.ts` — `collectEngineProviders()`, `collectEngineAgents(userId)`, `collectEngineConfigInput(userId, {refreshModels})`, `refreshModelCache()` (now returning whether it completed) and `resetModelCacheForTests()`. **The one place a decrypted API key is read**
- `modelTransports.ts`, `modelLimits.ts`, `modelCache.ts` — unchanged: which SDK packages the engine can build a transport from, the ceilings a custom entry's models are declared with, and the merge that never shrinks a provider to nothing
- **Gone:** `engineManager.ts` (and its test) — the process state machine, the loopback port, the Basic-auth password, `ensureRunning`, `applyConfigChange`, `agentKey`, `lastSkips`, `request`

### Main process — the launcher that consumes all of it
- `src/main/agents/drivers/acp/acpLaunchers.ts` — `createOpencodeLauncher(deps)` and `createClaudeLauncher(deps)`. The OpenCode half is what turns everything above into a process: `deps.binary()` → `deps.configInput(userId)` → `buildEngineConfig({providers: [the one this agent uses], agents: [this agent]})` → temp-file write and `renameSync` → `digestEngineConfig` → `specKey`. Also `newSessionParams`, `isRefusal`, and module-private `configDirName` (a SHA-256 of the agent id, because `folder:<uuid>` is not a path component), `specKey`, `envDigest`, `safely`
- `src/main/agents/drivers/index.ts` — the production wiring: `binary: () => engineBinaryService.ensure()`, `configInput: (userId) => collectEngineConfigInput(userId, {refreshModels: false})`, `configRoot: () => join(app.getPath('userData'), 'acp')`, `childEnv: shellEnvForChild(await getShellEnv())`, and the Claude launcher's own deps
- `src/main/ipc/engine.ipc.ts` — `registerEngineHandlers()`: **two** channels and one push, and it registers no shutdown hook (the pool's is fired from `will-quit` in `src/main/index.ts`)
- `src/main/services/localAgents/runtimeService.ts` — unchanged: `{resolveDefault, resolve, validate, toRuntimeRef, applyToManifest}`. `resolve` still returns early for the Claude engine, above `resolveDefault`, because a credential lookup means nothing on a path with no credential
- `src/main/services/localAgents/promptAssembly.ts` — `assembleAgentPrompt()`, `assembleBareAgentPrompt()`, `resolveDesktopPromptContext()`, `stripHtmlComments()`, `listKnowledgeTopics()`
- `src/main/kit/validator.ts` — `checkRuntime()` reports `runtime.complexity` and `runtime.engine` as **warnings** in every case

### Preload
- `src/preload/index.ts` — `window.api.engine.{binary, resolve, onState}`. **No address, no handle, and nothing to start or stop.** Typed by inference

### Renderer
- `src/renderer/src/hooks/useEngine.ts` — `ENGINE_BINARY_KEY`, `useEngineBinary`, `useEngineWatch`, `useResolveEngineBinary`. `useEngineState`, `useEngineSkips` and `useStartEngine` are gone (there was never a `useStopEngine` to remove — Settings' Stop button had already gone)
- `src/renderer/src/components/agents/local/RuntimePanel.tsx` — the "Runs with" panel: the `Runs on` picker (credentials *and* the Claude engine), the work-complexity / model picker and its **Advanced** checkbox, the one reserved status line, and the module-private `EngineRow`, `EngineStatus`, `ClaudeStatus`, `SecretsLine`. `EngineStatus` now reports the **binary** — `opencode <version>` / `Downloading…` / `Not available` / `On the first message` — with no Start button and no `Running`
- `src/renderer/src/components/settings/LocalAgentsSettingsSection.tsx` — the **Engine Settings** section: the binary status row (`Ready — opencode <version>, your own installation` / `, the path set under Engine path below` / `, downloaded by Cinna`), *Try again* on `failed` only, and the engine-path card below it
- `src/renderer/src/App.tsx` — `useEngineWatch()` mounted once in `Shell`, beside `useLocalAgentWatch()`

### Tests
- `src/main/engine/engineBinaryService.test.ts` — that reading resolves nothing, the shared in-flight resolution, the memo and the path that moves it, the uncached failure, a refresh overtaking a failing resolution, and the pushes (including a listener that throws)
- `src/main/agents/drivers/acp/acpLaunchers.test.ts` — what the OpenCode launcher writes and refuses, and what the Claude launcher declares and sets
- `src/main/engine/configGenerator.test.ts`, `binaryResolver.test.ts`, `engineConfigSource.test.ts`
- `src/main/services/localAgents/runtimeService.test.ts`, `promptAssembly.test.ts` + `__snapshots__/`
- `src/shared/modelFamilies.test.ts`
- `src/renderer/src/components/agents/local/RuntimePanel.test.tsx` — the panel in the jsdom project with its hook modules mocked, including `useEngine`

## Database Schema

**None.** The only persisted state is `localAgentsEnginePath` in `app_settings` (default scope) and the files under `<userData>`. Which engine an agent runs on is a row value, but it belongs to the drivers — `agents.driver = 'acp'` with `driver_config = {"launcher": …}`; see [Agent Drivers](../drivers/drivers_tech.md).

## IPC Channels

Both handlers are activation-gated (`userActivation.requireActivated()`). The engine is machine-local.

| Channel | Signature | Notes |
|---|---|---|
| `engine:binary` | `() → EngineBinaryState` | Synchronous read of module state. **Never resolves anything** — opening Settings must not start a 46 MB download |
| `engine:resolve` | `() → Promise<EngineBinaryState>` | `refresh()`. **Never rejects** — a failed resolution is the returned state, sentence included. Can run for a minute |
| `engine:binary-state` | main → renderer push | Fires on every transition, forwarded from `engineBinaryService.onChange` |

Deliberately absent: `engine:start`, `engine:stop`, `engine:skips`, and anything returning a base URL or a password. There is no server to start, and the per-agent processes are the turn's business. Nothing resolves the binary at boot.

## Services & Key Methods

### `src/main/engine/engineBinaryService.ts`

Module state: `state: EngineBinaryState`, `pending: Promise<ResolvedEngineBinary> | null`, `pendingFor: string | null | undefined`, `listeners`.

| Method | Behaviour |
|---|---|
| `state()` | The current `EngineBinaryState`. Free, never starts anything |
| `ensure()` | `pending` when it was started for the *current* configured path, else a fresh resolution. The turn path's entry point |
| `refresh()` | Drops the memo and resolves again, returning the resulting state — including `failed`. Settings' *Check again* |
| `onChange(fn)` | A listener set; a throwing listener is caught and warned, never allowed to break a transition |

Two rules the tests pin because both were bugs in the shape that preceded them:

- **The memo is keyed on the configured path.** An unkeyed memo kept handing out the old binary until the app restarted after a user pointed Settings at another `opencode` — and because the path feeds the launch spec's key, the running children were not replaced either, so the setting appeared to do nothing at all
- **A failure clears the slot only if that resolution still owns it.** The two failures that happen are a mistyped path and an unreachable network, both fixed by trying again — but a `refresh()` that overtook a failing resolution has already put a newer promise in the slot, and dropping it would cost the caller waiting on it a second resolution for nothing

The service holds no Electron dependency: `engine.ipc.ts` subscribes once for the app's lifetime and forwards each transition to whatever window is open.

### `src/main/agents/drivers/acp/acpLaunchers.ts` — the OpenCode half

`plan(ctx)` in order, and every step is a refusal rather than a throw:

1. `deps.binary()` — `engineBinaryService.ensure()`. `EngineBinaryError`'s messages are already user-facing sentences naming the remedy, so they are passed through rather than replaced
2. `deps.configInput(userId)` — `collectEngineConfigInput(userId, {refreshModels: false})`
3. Find this agent in `input.agents`. Absent means the collector and the driver disagree, which happens for the length of one save while a manifest is being rewritten → *"This agent's runtime changed while the turn was starting. Try again in a moment."*
4. `buildEngineConfig({providers: input.providers.filter(p => p.id === mine.providerId), agents: [mine]})`
5. `built.skippedAgents` → `describeEngineSkip(code)` as the refusal
6. `agentKey` / `agentModel` missing where nothing was skipped is logged as an error and refused — the alternative is a session that silently runs OpenCode's own `build` agent in the user's folder
7. `{...built.config, model: '<providerKey>/<modelId>'}` written to `<userData>/acp/opencode/<sha256(agentId).slice(0,16)>/opencode.json` via `${configPath}.tmp` + `renameSync`
8. The spec: `command = binary.path`, `args = ['acp']`, `cwd = the agent folder`, `env = childEnv + OPENCODE_CONFIG + OPENCODE_CONFIG_DIR + OPENCODE_DISABLE_AUTOUPDATE + built.env`, `key = specKey([binary.path, binary.version, 'acp', digest.config, digest.env, configPath])`
9. `init.clientCapabilities = {}` — no `fs`, no `terminal` (both removed in draft v2, so a client that never declared them is forward-compatible), and **no `elicitation`**
10. `setup.configOptions = [{configId: 'mode', value: agentKey}, {configId: 'model', value: modelRef, optional: true}]`

Two of those carry a measurement:

- **`mode` is mandatory, `model` is optional.** OpenCode populates its model catalogue asynchronously after start, so a `model` set issued milliseconds after `session/new` can be refused — *"Invalid params: model not found"* — for a model the session has **already** selected from the config's top-level `model` (`session/new` reports it as `configOptions.model.currentValue`). Refusing the turn there would refuse it over a race about something already true. A missing `mode`, by contrast, runs the engine's stock coding agent in the user's folder
- **Neither `OPENCODE_CLIENT` nor `OPENCODE_ENABLE_QUESTION_TOOL` is set, and that is a decision.** `opencode acp` sets `OPENCODE_CLIENT=acp` itself, and the `question` tool is registered only for `app`/`cli`/`desktop` clients or behind that flag. Turning it on hands the model a tool whose answer has no channel over ACP: the probe's question hung for 150 s and had to be cancelled. A model that asks in prose is a degradation; a tool that hangs the turn is a defect

The Claude half is documented with the engine it launches — [The Claude Engine (technical)](claude_engine_tech.md).
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

**There is no writer here any more.** `writeEngineConfig` and `pruneStalePrompts` went with the shared server: the OpenCode launcher writes its own one-agent config (temp file + `renameSync`) into `<userData>/acp/opencode/<hash>/opencode.json`, and no prompt file is written anywhere. `built.prompts` survives only as an input to the digest — the prompt itself is inlined in the agent entry, because the v2 reader resolves no `{file:…}`.

`CONVERSATION_PERMISSIONS` (`:244`) — `'*': 'ask'` first (OpenCode's base rule is allow-everything, so an enumerated profile without this leaves every other tool on allow), then `read` (`*` allow + `SECRET_FILES`), `edit`/`write` (`*` allow + `IDENTITY_FILES` + `SECRET_FILES`), `bash` (`*` allow, then the `.env` accident guards and `sudo *` / `rm -r *` / `rm -rf *` / `rm -fr *` on ask), `webfetch: 'ask'`, `external_directory: 'ask'`. `SECRET_FILES` (`:218`) is `credentials/.env`, `*.env`, `*.pem`, `*.key` → **deny**; `IDENTITY_FILES` (`:239`) is `cinna-agent.json`, `docs/WORKFLOW_PROMPT.md` → **ask**. <!-- nocheck -->

Two spelling rules, both load-bearing and both explained in [permissions.md](permissions.md#the-pattern-language-is-not-a-glob-and-a-missed-pattern-fails-open): **never write `**`** (the matcher is not a glob, and `**/.env` never matches a root-level `.env` — a missed pattern fails open), and **write `'*'` first inside an entry** (resolution is `findLast`, so narrow shapes above the catch-all are dead). `configGenerator.test.ts` asserts both. The full profile with the reason for each entry is [Local Agent Permissions](permissions.md).

`mergePermissions(overrides)` — **shallow**, one permission name at a time. Deep-merging the pattern maps would let a manifest add `"*": "allow"` underneath our `bash` rules and quietly widen them. **Design flag for Phase 9**: a manifest can replace `bash` and the `'*': 'ask'` catch-all outright; the "the folder is the user's own" justification stops holding when Phase 9 installs a folder from the cloud into a shell-capable engine.

### `src/main/engine/engineConfigSource.ts`

Sits between the OpenCode launcher (which spawns one process for one agent) and `configGenerator` (OpenCode's config shape) so neither knows about `providerService`, `localAgentService` or the manifest — which is what lets the launcher be driven in a test by a three-line fake supplying the same shape.

- `collectEngineProviders()` — `providerService.listMerged()` filtered by `dto.enabled` **and** `isCredentialUsable` (`src/shared/credentials.ts`; the two terms of `isCredentialActive`, spelled out separately because each refusal carries its own reasoning), joined to `llmProviderRepo.listByUserIds(getManagedResourceScopes())` for the ciphertext and `baseUrl`. Decryption is now **conditional** rather than a precondition: a keyless row has no ciphertext and is collected with `apiKey: ''`, while a keyed row with no ciphertext is still skipped. A key that will not decrypt is **skipped with a warning naming only the provider id**, not a failed start
- `modelsByProvider()` / `cachedModels` / `refreshModelCache(scope)` — `getAllModels()` is awaited explicitly *before* a build rather than from inside the synchronous collector, so a start cannot block on an unreachable gateway. `scope: 'all'` fans out over every adapter; `scope: 'local'` calls `listModels()` directly on the adapters of keyless credentials (`listLocalModels()` / `localProviderIds()`), which is loopback and costs about a millisecond. Both fold into the cache through `mergeModelCache(previous, fresh, known)` in `src/main/engine/modelCache.ts`: a provider that answered is replaced, one that was silent **keeps its last good list**, ids missing from `known` are evicted, and an **empty** `known` evicts nothing (the credential DB and the adapter registry disagree for a moment before a profile's scopes resolve, and mass eviction there empties every custom entry)
- `collectEngineAgents(userId)` — `localAgentService.list(userId).agents`, skipping readiness `invalid` and `contract_too_new` outright, and collecting an agent whichever engine it names (the caller is a launcher chosen from the folder, so it is never asked about an agent on another engine); each remaining agent gets `runtimeService.resolve(agent.runtime, providers, cachedModels)` and `assembleAgentPrompt(agent.path, agent.manifest, context)` — or `assembleBareAgentPrompt(agent.path, agent.name, context)` where `agent.kind === 'bare'`, the one branch [bare agents](bare_agents.md) add to this module. The **cached** catalogue is handed in deliberately, not a fresh fetch: a work-complexity tier resolves against what a credential lists, and comparing a reconcile against a list that drops out whenever a gateway is briefly unreachable would restart the engine for a change nobody made. An agent whose runtime resolves to nothing **is still emitted**, so `configGenerator` can report it as a skip with a reason rather than the agent merely being absent. **`enabled` is not consulted** — a disabled agent gets an entry, a key and a prompt file. That is deliberate (the config is a catalogue of what can be addressed), but it means **the Phase 6 runner must gate on `enabled` itself**; nothing in this slice does, and `agentKey()` returns a key for a disabled agent
- `collectEngineConfigInput(userId, {refreshModels})` — the only entry point, and since phase 3 it has exactly one production caller: the OpenCode launcher, once per turn, with `refreshModels: false`. That resolves to scope `'all'` for the **first** collection of a session and `'local'` after it, gated on a module flag set only by a refresh that **completed** — so an offline machine tries again next turn instead of running the session on an empty cloud catalogue. `refreshModelCache(scope)` returns that boolean; `resetModelCacheForTests()` clears the flag and the cache

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
- `handoverSection` keeps absent-kind sibling hints separate from the exact coordinator target_kind/target_slug pair. Only the latter renders conditional `/handback <note>` guidance; unknown kinds render no coordinator instructions. Main-only eligibility and ACP result checks are described in [manifest handback](../../jobs/tasks/manifest_handback_tech.md).
- Kit and bare desktop context allow human or unattended requests and direct agents to available question/permission mechanisms without assuming someone is watching. Shared prompt context does not store task IDs or grant per-turn authority.
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
| `useEngineBinary` | `['engine-binary']`, seeded from `engine:binary`. **Nothing polls** |
| `useEngineWatch` | One `engine:binary-state` subscription for the app's lifetime; writes the pushed state straight into the cache. Mounted once, in `Shell` |
| `useResolveEngineBinary` | The mutation behind *Try again*. Writes the returned state into the cache; **a failed resolution resolves**, so callers render `data.error` rather than a mutation error. `isPending` covers the download |
| `RuntimePanel` | The `Runs on` `<select>` carrying two `optgroup`s (credentials on this machine, and the Claude engine), the tier / model picker, the Advanced checkbox, and one reserved status line. **A binary that could not be resolved outranks every question about which model** in that line, above the credential ladder: with no engine, "your default chat mode uses a switched-off credential" is a true sentence about something that would not help — and it is what the Engine cell is showing in red at that moment. It replaces the shared config's *skip* entry that used to fill this slot; `credential_unavailable` and `no_model` are not lost, because the rungs below say the same things from **this** agent's resolved runtime rather than echoing what one global generation left out |
| `EngineStatus` (private) | Which `opencode` this agent will run on, and nothing about a process: `opencode <version>` / `Downloading…` / `Not available` / `On the first message`, with the path or the failure sentence in `title`. **One light per state**: muted for everything but `failed`, which is danger for both the dot and the text — an amber dot over red text is two claims about one fact. `ready` stays muted here and is a green tick in Settings for the same fact, because this cell's vocabulary is shared with the Claude rung beside it, where muted means *a binary was found*. Rendered only for an agent on that engine |
| `ClaudeStatus` (private) | The Claude branch of the same fixed-height row — the binary, its version, and the login. See [The Claude Engine (technical)](claude_engine_tech.md) |
| `LocalAgentsSettingsSection` | The **Engine Settings** section: a `SettingsStatusRow` for the binary — tone `ok` when `ready`, `warning` on `failed`, **neutral** when nothing has looked yet — with *Try again* only on `failed`, and the engine-path card below it |

Two UX rules are load-bearing here and both are argued in the components themselves:

- **A binary nobody has resolved yet is neutral, not a warning.** It resolves itself the moment anyone chats with a folder agent; an amber triangle over it is the healthy state wearing an alarm, and it teaches the user to skip the triangle for `failed`, which is the one that needs them (ux_rules 2 and 12)
- **A status row that can be amber must carry the control that clears it, and must keep carrying it while it works.** *Try again* retries the *resolution*; a condition naming only `failed` **unmounted the button on click**, because pressing it moves the state to `resolving` — so the user pressed a control that vanished, and for up to a minute of downloading the only feedback was a line of text changing. There is no Start, and nothing on either screen starts or stops anything

## Configuration

| Setting | Scope | Meaning |
|---|---|---|
| `localAgentsEnginePath` | `app_settings`, **default (machine-local)** | Absolute path to an `opencode` executable, or `''` for "resolve one". Validated as *absolute or empty only* — whether the file exists is deliberately the resolver's question, at the moment it is used |
| `localAgentsModelAdvanced` | `app_settings`, **default (machine-local)** | `false` (work complexity) or `true` (the raw model list): which picker the “Runs with” panel opens on for an agent whose runtime does not decide |

A saved engine path takes effect **the next time something asks for a binary** — the next turn, or *Try again* — because the resolution is memoised per configured path. Settings says so in place rather than leaving the user to wonder why the version line did not move; the running children are replaced on their own next turns, because the path feeds the spec key.

Constants worth knowing: `PINNED_ENGINE_VERSION = '1.18.27'` (`src/shared/engine.ts`); `ENGINE_ASSETS` — six platform entries, `linux-*` on glibc (musl/Alpine is the known gap); `ACP_IDLE_REAP_MS`, `ACP_START_TIMEOUT_MS` and `ACP_TURN_CEILING_MS` belong to the turn, in `src/main/agents/drivers/acp/types.ts` and `acpDriver.ts`.

Generated files, none of which is ever inside an agent folder:

```
<userData>/acp/opencode/<hash of agent id>/opencode.json      (one agent, written temp + rename)
<userData>/engine/opencode-<version>/opencode                 (managed install)
<userData>/engine/.staging-<pid>-<ts>/                        (transient; junk after a crash, never an install)
```

`cwd` for a spawned OpenCode process is **the agent's folder**, not the engine directory — that is what makes the session's `location.directory` the folder the permission profile is written about.

## Security

- **Invariant 4, mechanically.** A key exists in exactly two places: `built.env` (a map handed to `spawn`) and the child's environment. The config file carries `env: ["CINNA_ENGINE_KEY_…"]` references and never a value
- **The spec key is a digest of the environment, never the environment.** It is logged by the pool and compared on every acquire; `envDigest` is what keeps it safe to hold
- **Nothing is inherited.** The launcher builds the child's whole environment and `spawn` is handed it verbatim — no `process.env` spread anywhere in the ACP code. This main process holds decrypted provider keys and the user's shell environment, and what a coding agent can see of them is a decision, not a default
- **The child leads its own process group**, so the whole tree can be signalled; the pool's `shutdown()` runs from `will-quit`
- **`OPENCODE_DISABLE_AUTOUPDATE=1`.** A pinned, checksum-verified binary that replaces itself is exactly what the checksum exists to prevent
- **Logs never carry key material.** A refused decrypt logs the provider id only; digests are never logged as values; no engine response is logged wholesale
- **`credentials/.env` is `deny` in the permission profile**, not `ask` — see [engine.md](engine.md#the-permission-profile)
- **The download is verified before it is unpacked**, and only a verified tree is published. The digests pin bytes, not provenance: they are not a signature
- **Nothing renderer-supplied becomes a path.** The engine path is an `app_settings` value validated as absolute; every other path here is derived from `app.getPath('userData')`
- **No address, no password, no handle crosses the bridge.** There is no longer an address to hide, which removes the class rather than guarding it

## Testing notes

**What is covered:** the binary service on its own; `buildEngineConfig` as a pure function (which is what makes "can a key reach the config" a question a test answers directly); the collectors; runtime resolution on both sides of `runtimeDefaults`; prompt assembly by snapshot, because the interesting failures there are *omissions*; and the launcher — what it writes for a fixture agent, which refusals it produces for which inputs, and that the spec key moves when the config, the credential map or the binary path moves.

**Not covered:**

- The download **sequence** (`downloadToFile` → `extractArchive` → `chmod` → `rename`, including the lost-race branch). Every piece is hand-verified against the real binary; the sequence has never run end to end
- The config write's atomicity under interruption — a writer killed between write and rename must leave the previous config intact. Needs a crash, not a mock
- The `knowledge/` topic sort (pre-existing: `readdirSync` already returns name order on APFS)
- **The engine-path field in Settings.** Typechecked and bundled, never rendered by a test. The binary row beside it is exercised by the e2e UX pass rather than by a unit test
- The per-turn cost of generating a config

**Gone with the server, and worth knowing if you are looking for it:** `engineManager.test.ts` spawned real subprocesses, bound real loopback ports and spoke real HTTP, because every question worth asking about a shared server needed one. The equivalent for the ACP era is `acpConnection.test.ts` and the driver's own suite, which drive a scriptable fake ACP agent over real stdio — see [The Agent Turn (technical)](agent_turn_tech.md).
