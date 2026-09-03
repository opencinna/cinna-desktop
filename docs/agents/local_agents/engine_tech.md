# The Local Engine, Runtimes & Prompt Assembly — Technical Details

Implementation reference for [The Local Engine, Runtimes & Prompt Assembly](engine.md). Path convention as in that doc: `src/...` is this repository; `Local/<slug>/...`, `cinna-agent.json` and `app-data/...` are inside an agent folder; `<userData>/engine/...` is the app data directory.

## Read this first if you are working next to the engine

Four things here will produce a silent, green-suite failure if changed carelessly. Each is argued in [engine.md](engine.md); this is the index.

1. **`turnLock.anyHeld()` gates every restart, never `turnLock.isLocked(agentId)`.** One process backs every folder agent — a per-agent check restarts the engine out from under a turn running in a *different* folder. Live Invariant 3 violation; already fixed once
2. **`GET /config` on the engine returns the RESOLVED config**, with `{env:…}` substituted — **its response contains live API keys.** Never log it, never put it in a stream part, never forward it to the renderer
3. **The digest is length-prefixed (`framed()`), not delimiter-joined.** A collision is a *false negative* — the engine keeps serving the old prompt while the app believes otherwise, with every test still passing. Do not simplify it back to a join
4. **`agentKey()` and `lastSkips()` answer from `RunningEngine.loaded`**, the record taken at spawn — not from the last generated config. Phase 6 binds engine sessions to `agentKey`

## File Locations

### Shared
- `src/shared/engine.ts` — the whole wire contract. `EngineBinarySource`, `EngineStatus`, `EngineState`, `EngineSkips`, `ENGINE_STATE_CHANNEL`, `PINNED_ENGINE_VERSION` (`'1.18.27'`), `RuntimeSource`, `ResolvedRuntime`, `LocalAgentRuntimeInput`. Type-only or plain constants; **nothing key-shaped, and no `baseUrl`**
- `src/shared/appSettings.ts` — `localAgentsEnginePath: string` on `AppSettingsSchema`
- `src/shared/kit/manifest.ts` — `AgentRuntimeRef` (`model`, `credential`, `permissions`, plus an index signature for the round-trip rule)

### Main process — `src/main/engine/`
- `binaryResolver.ts` — the three sources, `ENGINE_ASSETS` (six pinned `{file, sha256}` entries), `assetUrl()`, `resolveEngineBinaryWith(deps)`, `installPinned()`, `findBinary()`, `sha256File()`, `probeEngineVersion()`, `downloadToFile()`, `extractArchive()`, `engineRootDir()`, `realBinaryResolverDeps()`, `EngineBinaryError`, `BinaryResolverDeps`
- `engineManager.ts` — the process. `engineManager.{getState, onStateChange, ensureRunning, applyConfigChange, stop, agentKey, lastSkips, request}`, plus module-private `startEngine`, `spawnAttempt`, `halt`, `whatMoved`, `pickLoopbackPort`, `engineEnv`, `healthy`, `waitForHealth`, `killEngine`; exported `ENGINE_TIMEOUTS`, `registerEngineShutdown()`, `resetEngineStateForTests()`
- `configGenerator.ts` — `buildEngineConfig()` (pure), `digestEngineConfig()`, `writeEngineConfig()`, `CONVERSATION_PERMISSIONS`, `credentialEnvName()`, `engineAgentKey()`, `promptFileRef()`, and module-private `framed`, `mergePermissions`, `pruneStalePrompts`, `writeIfDifferent`
- `engineConfigSource.ts` — `collectEngineProviders()`, `collectEngineAgents(userId)`, `collectEngineConfigInput(userId, {refreshModels})`, `refreshModelCache()`. **The one place a decrypted API key is read**

### Main process — elsewhere
- `src/main/ipc/engine.ipc.ts` — `registerEngineHandlers()`; four channels plus the state push. Calls `registerEngineShutdown()`
- `src/main/ipc/index.ts` — `registerEngineHandlers()` in `registerAllIpcHandlers()` (required by the registration guard, seam 15)
- `src/main/ipc/local_agent.ipc.ts:114-119` — the one per-site reconcile: a successful `update-field` fires `void engineManager.applyConfigChange(...)`, fire-and-forget
- `src/main/services/localAgents/runtimeService.ts` — `runtimeService.{resolveDefault, resolve, applyToManifest}`, exported `findCredential()`, module-private `normaliseRef`, `isUsable`
- `src/main/services/localAgents/promptAssembly.ts` — `assembleAgentPrompt()`, `resolveDesktopPromptContext()`, `stripHtmlComments()`, `listKnowledgeTopics()`, module-private `readTextFile`, `handoverSection`, `desktopContextSection`
- `src/main/services/localAgents/turnLock.ts` — `turnLock.anyHeld()` (added for the engine; the rest is Phase 2)
- `src/main/services/appSettingsService.ts:95` — the `localAgentsEnginePath` value check (absolute or empty; existence deliberately unchecked)
- `src/main/db/appSettings.ts:25` — the default (`''`)

### Preload
- `src/preload/index.ts:1088` — `window.api.engine.{status, start, stop, skips, onState}`. **No `baseUrl` and no password, by design.** Typed by inference

### Renderer
- `src/renderer/src/hooks/useEngine.ts` — `ENGINE_STATE_KEY`, `ENGINE_SKIPS_KEY`, `useEngineState`, `useEngineWatch`, `useEngineSkips`, `useStartEngine`, `useStopEngine`
- `src/renderer/src/components/agents/local/RuntimeCard.tsx` — the credential and model pickers, the module-private `EngineLine` and `EngineSkipLine`
- `src/renderer/src/components/settings/LocalAgentsSettingsSection.tsx` — the readiness "Local engine" line, Start/Stop, and the engine-path field
- `src/renderer/src/App.tsx:103` — `useEngineWatch()` mounted once in `Shell`, beside `useLocalAgentWatch()`

### Tests
- `src/main/engine/engineManager.test.ts` — **spawns real subprocesses**, binds real loopback ports, speaks real HTTP. The stand-in engine is a small node script implementing the two things the manager depends on (`--version`, and `GET /api/health` behind Basic auth). Each spawn dumps `{env, argv, pid}` beside the config it was pointed at, because the port, the hostname and the subcommand are only visible on the command line. See [Testing notes](#testing-notes)
- `src/main/engine/configGenerator.test.ts`, `binaryResolver.test.ts`, `engineConfigSource.test.ts`
- `src/main/services/localAgents/runtimeService.test.ts`, `promptAssembly.test.ts` + `__snapshots__/promptAssembly.test.ts.snap`
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
interface LoadedConfig  { digest: EngineConfigDigest, agentKeys: Map, skippedAgents: SkippedAgent[] }
```

`loaded` is carried **on the process object** rather than in a module variable so it cannot outlive the thing it describes: when the process dies the record goes with it, and there is no window in which a stale record claims to describe a running engine.

| Method | Behaviour |
|---|---|
| `ensureRunning(userId)` | Running → **reconcile** via `applyConfigChange`, shared through `reconcileInFlight`. Not running → `startEngine` behind `startInFlight`. Captures the stop epoch **synchronously**, before the deferring `Promise.resolve().then(...)`, so a `stop()` issued in between is not mistaken for one that happened earlier |
| `applyConfigChange(userId)` | Rebuild (`refreshModels: false`) → **re-read `running` after the await** → `whatMoved(engine.loaded.digest, digestEngineConfig(built))` → nothing moved: return; `turnLock.anyHeld()`: log and return, **writing nothing**; else `await halt()`, re-check the epoch, `ensureRunning`. **Never starts an engine** |
| `stop()` | `stopEpoch += 1`, then `halt()` |
| `halt()` (private) | `stop()` minus the epoch bump. Awaits `startInFlight`, kills, sets `stopped`. An internal restart uses this so it cannot cancel itself, nor hide a user's Stop |
| `agentKey(agentId)` | `running?.loaded.agentKeys.get(agentId) ?? null` |
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

`engineEnv(configPath, password, credentials)` = `shellEnvForChild(await getShellEnv())` + `OPENCODE_CONFIG`, `OPENCODE_SERVER_PASSWORD`, `OPENCODE_SERVER_USERNAME`, `OPENCODE_DISABLE_AUTOUPDATE='1'`, then the `CINNA_ENGINE_KEY_*` map. See [Shell Environment Resolution](../../development/shell_environment/shell_environment.md).

### `src/main/engine/configGenerator.ts`

`buildEngineConfig(input) → BuiltEngineConfig` is **pure** — no filesystem, no clock, no `app`. That is what makes "does a key ever reach the config" a question a test answers directly rather than by reading.

```
BuiltEngineConfig { config, env, providerKeys, agentKeys, prompts,
                    skippedProviders, skippedAgents }
```

- Providers and agents are **sorted by id** before iteration. The same set must always produce the same bytes, or "did the config change" — which decides whether the engine restarts — would be answered by map iteration order
- Provider keys: `CANONICAL_PROVIDER_KEY` maps `anthropic→anthropic`, `openai→openai`, `gemini→google` (**`google` is OpenCode's, `gemini` is ours**). A canonical key gets the models.dev catalog for free. The **second** credential of a type, and every `openai_compatible` gateway, gets `<sanitised>-<hash>` plus an explicit `npm` package (`PROVIDER_NPM`), `name` and full `models` map — a custom entry has no catalog
- Skips: no stored key; a type with no `npm` entry; an `openai_compatible` credential with no base URL
- `credentialEnvName(providerId)` = `CINNA_ENGINE_KEY_<sanitised, ≤40>_<SHA-256[0:8] upper>`. The hash suffix stops two ids that sanitise alike (`a-b`, `a_b`) from silently swapping keys
- `engineAgentKey(agentId, slug)` = `<sanitised slug, ≤40 or 'agent'>-<SHA-256[0:8]>` — **always suffixed**, so a key never depends on which other agents exist
- Agent entry: `{description, mode: 'primary', model: '<providerKey>/<modelId>', prompt: promptFileRef(key), permission: mergePermissions(agent.permissions)}`. `promptFileRef(key)` = `{file:./prompts/<key>.md}`, resolved by OpenCode **relative to the config file**, which is why the whole generated set moves together
- Agent skips: the runtime's credential is not among the emitted providers; or the runtime names no model

`digestEngineConfig(built) → {config, env}`, two SHA-256 hex digests:
- `config` — the serialised config (`JSON.stringify(config, null, 2) + '\n'`, exactly what is written) then every `(key, promptText)` pair, sorted
- `env` — the `built.env` name→value pairs, sorted. **Not** the environment the child is spawned with, which carries a per-spawn password and the whole login shell and would therefore differ on every comparison
- Every piece goes through `framed(v)` = `` `${v.length}:${v}` ``. See item 3 of [Read this first](#read-this-first-if-you-are-working-next-to-the-engine)
- Entries are sorted here rather than trusting `buildEngineConfig`'s sort to stay put — this is the input to a restart decision and should not be one refactor away from restarting on map order

`writeEngineConfig(dir, built) → WrittenEngineConfig` — `opencode.json` plus `prompts/<key>.md` for each agent, each through `writeIfDifferent` (read-compare, then `writeFileSync(temp, {mode: 0o600})` + `renameSync`, temp removed on failure), then `pruneStalePrompts`. Logs **counts only**, never the config object. Its `changed` flag is now informational: the restart decision is made in `engineManager` against the loaded digest, before this is ever called.

`pruneStalePrompts(promptDir, prompts)` — only `<userData>/engine/prompts/`, only `.md` files directly inside it, never a directory; a file it cannot delete is warned about and skipped rather than thrown, because failing the config write over a stale prompt would take the engine down for it.

`CONVERSATION_PERMISSIONS` — `'*': 'ask'` first (OpenCode's base rule is allow-everything, so an enumerated profile without this leaves every other tool on allow), then `read` (`*` allow; `credentials/.env`, `**/.env`, `**/*.pem`, `**/*.key` **deny**), `edit`/`write` (`*` ask, `app-data/**` allow), `bash` (`*` ask; `uv run *`, `make *`, `python scripts/*` allow), `webfetch: 'ask'`, `external_directory: 'ask'`.

`mergePermissions(overrides)` — **shallow**, one permission name at a time. Deep-merging the pattern maps would let a manifest add `"*": "allow"` underneath our `bash` rules and quietly widen them. **Design flag for Phase 9** (`configGenerator.ts:359`): a manifest can replace `bash` and the `'*': 'ask'` catch-all outright; the "the folder is the user's own" justification stops holding when Phase 9 installs a folder from the cloud into a shell-capable engine.

### `src/main/engine/engineConfigSource.ts`

Sits between `engineManager` (processes) and `configGenerator` (OpenCode's config shape) so neither knows about `providerService`, `localAgentService` or the manifest — which is what lets `engineManager` be driven in a test by a three-line fake supplier instead of a database.

- `collectEngineProviders()` — `providerService.listMerged()` filtered to `hasApiKey && !unsupported`, joined to `llmProviderRepo.listByUserIds(getManagedResourceScopes())` for the ciphertext and `baseUrl`, decrypted with `decryptApiKey`. A key that will not decrypt is **skipped with a warning naming only the provider id**, not a failed start
- `modelsByProvider()` / `cachedModels` / `refreshModelCache()` — `getAllModels()` is awaited explicitly *before* a build rather than from inside the synchronous collector, so a start cannot block on an unreachable gateway. A failed refresh **keeps the last good list**
- `collectEngineAgents(userId)` — `localAgentService.list(userId).agents`, skipping readiness `invalid` and `contract_too_new` outright; each remaining agent gets `runtimeService.resolve(agent.runtime, providers)` and `assembleAgentPrompt(agent.path, agent.manifest, context)`. An agent whose runtime resolves to nothing **is still emitted**, so `configGenerator` can report it as a skip with a reason rather than the agent merely being absent. `enabled` is not consulted
- `collectEngineConfigInput(userId, {refreshModels})` — the only entry point. `refreshModels` defaults to **true**; `applyConfigChange` is the only caller that passes `false`

`getAllModels()` (`src/main/llm/registry.ts`) loops adapters **serially** and awaits `listModels()` on each — a real network round trip per configured credential (Anthropic's SDK paginates, OpenAI's SDK, a `fetch` for Gemini).

### `src/main/services/localAgents/runtimeService.ts`

- `resolveDefault(providers?)` — via `chatModeService.resolveEffectiveDefault()`, so it honours the local/account precedence toggle and a managed mode's per-profile model override. Returns `source: 'none'` with a sentence when there is no default mode, or when the mode points at a credential this machine no longer has
- `resolve(runtime, providers?)` — manifest first, then the default. Per-field fallback: a manifest model survives a credential fallback; an unknown credential reference produces `credentialRef` + a reason naming what it asked for and what it got. `source` is `'manifest' | 'default' | 'none'`
- `findCredential(providers, reference)` — id, then name, then provider type; name and type case-insensitive and **preferring a usable row**, because a managed `Anthropic` and the user's own can share a name
- `applyToManifest(manifest, input)` — validates and mutates in place. Refuses a key-shaped credential using the validator's own `SECRET_LOOKALIKE` (`src/main/kit/validator.ts`); caps at 200 chars each; deletes `manifest.runtime` entirely when both fields clear **and** no unknown keys remain; preserves `permissions` and anything else a newer contract adds. Throws `LocalAgentError('invalid_input')` — the same `DomainError` family the rest of the local-agents surface uses
- **No filesystem access.** The write goes through `localAgentService.updateField` → `manifestIo.writeIfUnchanged`, the same stamped path as every other card

### `src/main/services/localAgents/promptAssembly.ts`

`assembleAgentPrompt(agentDir, manifest, context)` joins its sections with `\n\n---\n\n` and appends a trailing newline. Order: workflow prompt (or the "no instructions yet" stand-in) → `## Your scripts` → `## Your credentials` (preceded by the never-read-the-secret-files rule) → `## Your knowledge` → `## Handing over` → `## How you are running now`.

- `readTextFile` returns null for missing / unreadable / non-file, and truncates at `MAX_SECTION_BYTES` (64 KB) with an ellipsis
- `stripHtmlComments` removes `<!-- … -->`, then a **trailing unterminated `<!--` and everything after it** (a half-written comment is a real state a file is in while someone types; leaving the opener would put the document's tail into the prompt as an instruction), then collapses blank runs and trims
- `listKnowledgeTopics(agentDir)` walks `Local/<slug>/knowledge/` to `KNOWLEDGE_MAX_DEPTH` (3), name-sorted, dotfiles skipped, `.md` only, `MAX_KNOWLEDGE_TOPICS` (200) ceiling, root-level `README.md` excluded. Returns agent-relative POSIX paths. **The list, never the contents**
- `handoverSection` reads `manifest.handovers[]`, keeping entries with a non-empty `target_slug`
- `desktopContextSection` — conversation mode, `uv run scripts/<name>.py`, write only under `app-data/`, never read or print a credential, locale + time zone, long output to `app-data/storage/`, and **do not switch to the Builder role**
- `resolveDesktopPromptContext()` — `Intl.DateTimeFormat().resolvedOptions()`, falling back to `en-US` / `UTC`, never throwing
- Both `readdirSync` call sites annotate `Dirent<string>[]` explicitly: `ReturnType<typeof readdirSync>` resolves to the Buffer overload, which types `entry.name` as a Buffer and produces type errors pointing nowhere near the cause. Same note in `binaryResolver.findBinary`

### `src/main/engine/binaryResolver.ts`

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
| `RuntimeCard` | Credential `<select>` (usable providers, by **name**), model `<select>` (registry models for the effective provider), `EngineLine`, `EngineSkipLine`, the not-editable notes. Writes via `useSetLocalAgentRuntime` → `local-agent:update-field` with the manifest stamp |
| `EngineLine` (private) | One line of engine status plus a Start button; hidden when running |
| `EngineSkipLine` (private) | "The engine skipped this agent because …" for this agent id |
| `LocalAgentsSettingsSection` | The "Local engine" readiness line (status, version, which source), Start/Stop, and the engine-path field |

Renderer rules that are decisions, not styling:

- **A model the manifest names but the registry has never listed is still rendered as an option.** Without it, opening the card would silently reset the agent's model to the default the moment the user touched the credential picker
- **The model select stays enabled with an empty list plus a hint.** `useModels` is the aggregate registry, and a credential it has nothing for is not a credential that cannot run
- **The engine-path field follows the saved value until the user types in it.** The settings query has not resolved on first render, so without the effect a user with a path already set sees a blank box and reasonably concludes nothing is configured
- **A saved engine path takes effect on the *next* start** — the resolved binary is cached and the running process is the old one either way — and the section says so rather than leaving the user to wonder why the version line did not move
- `canEdit = stamp !== null && readiness !== 'contract_too_new'`; a stale-write refusal renders the reload sentence via `isStaleWriteError`

## Configuration

| Setting | Scope | Meaning |
|---|---|---|
| `localAgentsEnginePath` | `app_settings`, **default (machine-local)** | Absolute path to an `opencode` executable, or `''` for "resolve one". Validated as *absolute or empty only* — whether it exists and runs is answered by `binaryResolver` and surfaced as engine **state**, not as a rejected save |

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
- **Every renderer change in this phase.** `vitest.config.ts` runs `environment: 'node'`; there is no jsdom or testing-library in the repo, so `RuntimeCard`, the engine-path field, the Start/Stop button and the skip line are typechecked and bundled but **never rendered**
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
| `OPENCODE_CONFIG` points the engine at our generated file | Run |
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
- `engineManager.request(path, init)` — the only way to reach the engine. Keeping the base URL and password inside the module is what makes "everything goes through the runner" structural
- `engineManager.lastSkips()` — why an agent is not addressable
- **`refreshModels: false` stays false on the reconcile path.** If a newer model list is needed, ask for it explicitly
- Whether a restart between two turns of the same chat loses engine session state is **open**, and belongs to Phase 6 with session continuity (seam 9). Invariant 3 is satisfied here only at engine granularity
