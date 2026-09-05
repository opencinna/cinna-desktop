# Local Development — Technical Reference

Implementation companion to [local_dev.md](local_dev.md).

## A note on paths

Three trees are discussed and they look alike, so they are written differently throughout — the same convention as [The Local Engine](../local_agents/engine.md):

| Written as | Means |
|---|---|
| `src/…`, `docs/…` | A file in **this repository** |
| `<userData>/localdev/…` | The managed toolchain, inside the app data directory |
| `<AgentsHome>/Cloud/<host>/…` | The cinna-cli account workspace, inside the user's own [Agents Home](../local_agents/folder_index.md) |

## File Locations

### Shared
- `src/shared/localDevState.ts` — the whole wire contract: `LocalDevState` (six phases), `LocalDevTaskId` (six ids, `'engine'` among them), `LocalDevAttentionReason`, `LOCAL_DEV_STATE_CHANNEL`, `CinnaLocalDev`. Type-only plus one channel constant; nothing key-shaped. `LocalDevTaskStatus` no longer claims at most one task is `active` — that stopped being true when the installs became concurrent
- `src/shared/appSettings.ts` — `localDevConsent: string` on `AppSettingsSchema`
- `src/shared/localTools.ts` — `LocalToolId` gains `'cinna'`; `LocalToolSource` gains `'managed'`

### Main process — `src/main/localdev/`
- `localDevService.ts` — the reconciler. `localDevService.{getState, reconcile, setConsent, resetConsent, consent, openWorkspace, addToPath, clear}`, plus `hostDirName`, `fromToolchainError` and `fromCliOutcome` — exported only so the failure→state mapping can be unit-tested, since the reconciler itself needs a database, a window and a server — and module-private `runReconcile`, `mintSetupCommand`, `createWorkspace`, `refreshAccountToken`, `readAccountStatus`, `protocolFlags`, `readConsent`, `writeConsent`, `workspacePathFor`, `accountConfigPath`, `setState`
- `toolchain.ts` — `PINNED_UV_VERSION`, `UV_ASSETS`, `MUTAGEN_ASSETS`, `uvAssetUrl()`, `mutagenAssetUrl()`, `createToolchain(deps)`, `toolchain` (the process-wide instance), `realToolchainDeps()`, `localDevRootDir()`, `runCapture()`, `parseVersion()`; types `ToolchainPins`, `ToolchainPaths`, `ToolchainProgress`, `ToolchainResult`, `ToolchainDeps`, `Toolchain`
- `cliRunner.ts` — `runCinnaCli(opts)`; types `CliRunOptions`, `CliRunOutcome`, `CliProgressLine`, `CliResultLine`
- `cliCapabilities.ts` — `probeCliCapabilities(bin, version, env)`, `clearCliCapabilityCache()`; type `CliCapabilities`

Progress plumbing, end to end: `downloadToFile(url, dest, onProgress?)` in `managedAsset.ts` reports `(received, total | null)` off the same counter that enforces `MAX_ARCHIVE_BYTES`, throttled to 150 ms; `installPinnedAsset` forwards it as `onDownloadProgress`; `toolchain.ts` reports a `ToolchainProgressUpdate` carrying `toolPercent` (within that tool alone), `toolStatus`, and — filled in by `aggregate()` — `percent` (overall), the weighted sum of the highest figure each tool has reported (`TOOL_WEIGHT` = uv 0.2, mutagen 0.35, cinna-cli 0.45), clamped non-decreasing. The two percentages answer different questions and deriving one from the other would make the UI re-implement the weighting. It replaced fixed `STAGES` ranges (uv 0–20, mutagen 20–55, cinna-cli 55–100), which cannot express concurrent progress without going backwards, and lands on the same numbers for a sequential run; `localDevService` scales that by `TOOLCHAIN_SHARE` (0.7) and maps cinna-cli's `step n of m` onto `WORKSPACE_FROM`–`WORKSPACE_TO` (70–97), so one monotonic bar covers the whole reconcile. `runCapture` gained an optional per-line stderr callback, which is how `uv tool install` — the one stage with no byte count — reports anything at all.
- `toolchain.test.ts`, `cliRunner.test.ts`, `cliCapabilities.test.ts`, `localDevService.test.ts`
- `localDevReconcile.test.ts` — the reconcile as the **renderer sees it**: everything below the service faked, toolchain included, asserting on the broadcast payloads rather than the return value. That every push carries the checklist, that concurrent components are both `active`, that a survivor of a failed run cannot narrate over the failure, and that the failure lands on the component the error names. It exists because the failures the pure-mapping tests cannot see are all of one kind — main knows exactly what is happening and the window never hears it

### Main process — `src/main/managed/`
- `managedAsset.ts` — the staged, verified, atomically published install, extracted from `engine/binaryResolver.ts` and shared with it. `installPinnedAsset()`, `downloadToFile()`, `extractArchive()`, `sha256File()`, `findNamedFile()`, `sweepStaging()`, `isFile()`, `ManagedAssetError`, `ManagedAssetErrorCode`, `PinnedAsset`, `InstallPinnedAssetOptions`
- `managedAsset.test.ts`

### Main process — elsewhere
- `src/main/ipc/localdev.ipc.ts` — `registerLocalDevHandlers()`; seven channels, no state push of its own (the service broadcasts)
- `src/main/engine/binaryResolver.ts` — `resolveEngineBinaryWith(deps, onDownloadProgress?)` (the callback is new, and reports bytes only for the third source), `configuredEnginePath()` and `prefetchEngineBinary(onProgress?)`. The pinned install is deduped behind `installInFlight` with an `installReport` slot — the same reporter-slot shape as the toolchain's, so a caller that *joins* a download still sees it move. There are two askers now (local development pre-fetching, and a turn resolving the binary as it starts) and they overlap when a user sends a message during first-run setup, or when a failed reconcile is retried while its engine download is still in flight; `installPinnedAsset` makes a second download *safe*, but the pre-fetch exists to spend the bandwidth once. `BinaryResolverDeps.download` now declares the optional progress parameter `installPinnedAsset` was always passing it
- `src/main/engine/engineManager.ts` — imports `configuredEnginePath` rather than reading the setting itself, so `localAgentsEnginePath` has one home
- `src/main/errors.ts` — `ToolchainErrorCode`, `ToolchainError` (which carries `tool?: string` — the component it failed in, typed as a string so this module imports nothing from the installer that imports it)
- `src/main/auth/activation.ts` — `reconcile(userId)` on activation, `clear()` on deactivation
- `src/main/services/authService.ts` — `reconcile(userId)` after a successful `reauthCinna`
- `src/main/index.ts` — `reconcile(getCurrentUserId())` on `powerMonitor` resume
- `src/main/auth/cinna-oauth.ts` — `CinnaDiscovery.local_dev?: CinnaLocalDev`, read through and left alone by the three-required-field validation; `clearEndpointCache()` is what `force` calls before re-discovering
- `src/main/services/cinna-http.ts` — `resolveUrl()` (accepts an absolute URL for a discovery-published endpoint, refusing non-TLS non-loopback); `CinnaApiError('reauth_required')` now carries the **status** in `detail`
- `src/main/services/appSettingsService.ts` — the `localDevConsent` value check (JSON object of booleans)
- `src/main/db/appSettings.ts` — `localDevConsent: ''` default
- `src/main/services/localAgents/toolDetectionService.ts` — the `cinna` spec, its `managed` thunk, and the `managed` fallback after PATH and `.app` bundles

### Preload
- `src/preload/index.ts` — the `localDev` block. No `userId` parameter on any verb, deliberately

### Renderer
- `src/renderer/src/stores/localDev.store.ts` — `useLocalDevStore`: `state`, `subscribed`, `answeredHosts`, `subscribe()`, `set()`, `consent()`, `resetConsent()`, `repair()`, `openWorkspace()`
- `src/renderer/src/hooks/useLocalDev.ts` — `useLocalDev()`, subscribes on mount
- `src/renderer/src/hooks/useAgentsHomeHint.ts` — `useAgentsHomeHint(enabled?)`: `<AgentsHome>/Cloud` for the consent copy, from `localAgents.rootsList()`. One hook because three surfaces ask the same question and all three only use the answer to fill in a sentence; `''` until known and on failure, so a caller with no path leaves the line out rather than promising a folder it cannot name
- `src/renderer/src/components/localdev/LocalDevConsentPanel.tsx` — the shared question/progress/failure/ready panel
- `src/renderer/src/components/localdev/LocalDevOnboardingStep.tsx` — the `localdev` onboarding step
- `src/renderer/src/components/localdev/LocalDevConsentModal.tsx` — the same panel over an app that is past first run
- `src/renderer/src/components/localdev/LocalDevStatusButton.tsx` — the sidebar-footer indicator, and the only way into the detail modal
- `src/renderer/src/components/localdev/LocalDevDetailModal.tsx` — the checklist over a running app, opened from that button. Rendered through a **portal to `document.body`**: the sidebar establishes a containing block for `position: fixed` (`.app-sidebar-wrap` has `will-change: transform`, and in dark theme `.app-sidebar` has a `backdrop-filter`), so a plain `fixed inset-0` fills the sidebar card instead of the window
- `src/renderer/src/components/localdev/LocalDevTaskList.tsx` — the one component that renders `state.tasks`, shared by the modal and the progress panel
- `src/renderer/src/components/localdev/LocalDevExplainer.tsx` — the one copy of the "what gets installed" list, rendered by the consent panel, the consent modal and the (?) popover
- `src/renderer/src/components/localdev/LocalDevOptInRow.tsx` — the **Enable local development** checkbox plus its (?) popover (portalled to `document.body`, since the connect panel's cards establish their own containing block)
- `src/renderer/src/components/auth/ConnectIntentPanel.tsx` (+ `.test.tsx`) — hosts that checkbox, seeds it from `localDev.getConsent()[host]`, and calls `useLocalDevStore.consent(host, accepted)` once the account exists. A local-dev surface owned by [the connect link](../../auth/onboarding/connect_link_tech.md)
- `src/renderer/src/components/settings/LocalDevSettingsSection.tsx` (+ `.test.tsx`) — Settings → Local Development
- `src/renderer/src/components/settings/SettingsPage.tsx`, `src/renderer/src/components/layout/Sidebar.tsx`, `src/renderer/src/stores/ui.store.ts` — the `'local-dev'` settings tab
- `src/renderer/src/App.tsx` — `<LocalDevConsentModal />`, mounted **inside** `OnboardingGate` so it and the onboarding step never ask the same question at once

## Database Schema

No new tables and no migration. One new key in the existing installation-global `app_settings` store:

| Key | Scope | Value |
|---|---|---|
| `localDevConsent` | default (install-wide) | JSON `{"<host>": boolean}`, or `''` for "nobody has been asked". Validated in `appSettingsService` because the generic `settings:set` channel can reach it |

## IPC Channels

| Channel | Signature | Notes |
|---|---|---|
| `localdev:get-state` | `() → LocalDevState` | The one channel **not** behind `requireActivated()`; the state is `idle` until a Cinna profile is active anyway |
| `localdev:consent` | `(host: string, accepted: boolean) → LocalDevState` | Records the answer, then reconciles. Returns the next state |
| `localdev:reset-consent` | `(host: string) → LocalDevState` | Forgets the answer, then reconciles |
| `localdev:repair` | `() → LocalDevState` | `reconcile(force = true)` |
| `localdev:get-consent` | `() → Record<string, boolean>` | For Settings, and for seeding the connect panel's checkbox from an answer this machine already holds |
| `localdev:open-workspace` | `() → { ok: boolean }` | `shell.openPath` on `state.workspacePath`; `ok: false` unless `ready` |
| `localdev:add-to-path` | `() → { ok: boolean; path?: string; reason?: string }` | The `~/.local/bin/cinna` symlink |
| `localdev:state` (push) | `LocalDevState` | Main → renderer, on every transition, to every live window |

Two rules hold across all of them:

- **Every verb resolves the active profile itself** (`getProfileScopeUserId()`), and there is no `userId` parameter. The reconciler mints setup tokens with that profile's OAuth bearer and writes into that profile's agents home, so a renderer-supplied id would be a confused deputy — the same rule `authService.reauthCinna` follows
- **Nothing throws for an ordinary failure.** A refused install, a rejected token and a missing role all come back as `LocalDevState`, because a thrown `DomainError`'s code does not survive the IPC boundary and every one of these is something the UI renders rather than catches

## Services & Key Methods

### `src/main/localdev/localDevService.ts`

`runReconcile(userId, force)` in order (`prefetchEngine(generation)` is started just before step 6 and awaited just before step 11):

1. `userRepo.get(userId)` — not a `cinna_user` with a `cinnaServerUrl` → `idle` and return
2. `force` → `clearEndpointCache()`
3. `discoverCinnaEndpoints(user.cinnaServerUrl)` → `.local_dev`; a throw is `attention/network`
4. Missing `cinna_cli_version` **or** `mutagen_version` → `unsupported/server`. (The absence of the whole block and a half-filled block are the same answer)
5. `host = new URL(serverUrl).host`; consent lookup. Without `force`: `undefined` → `consent`, `false` → `declined`. With `force` and anything but `true`: write `true` and continue
6. `toolchain.ensure(pins, onProgress)`, or `.repair(…)` when `reinstallToolchain` — `force && state.phase === 'attention' && state.reason === 'toolchain'`, captured **before the first `setState`** overwrites the reason the run was started. Then `toolchain.toolchainEnv(pins)`. A `ToolchainError` goes through `fromToolchainError`
7. `mkdir(dirname(workspacePath))` — only the **`Cloud/` parent**. `ensureHome` does not create `Cloud/`; it appears on demand here, the first time a server needs one. cinna-cli creates the workspace directory itself and refuses one that already holds a `.cinna/account.json`, so the split is "the app owns the shape of the agents home, cinna-cli owns the workspace"
8. `.cinna/account.json` absent → `createWorkspace`
9. `readAccountStatus` (60 s ceiling). `token === 'expired'` → `refreshAccountToken` and re-read; `token === 'unreachable'` → `attention/network`, because the workspace is fine and calling it a workspace problem sends the user looking in the wrong place
10. `context_package.state === 'behind'` → `cinna account refresh-context` (5 min ceiling), failure logged only
11. `await engine`, then `ready { workspacePath, cliVersion, cinnaBinPath }`

`reconcile` wraps that in the single-flight promise and a `.catch` that turns a thrown bug into `attention/workspace` — the user still needs a state they can act on rather than a spinner that never resolves.

**Every stopping failure calls `markFailed` before `setState`**, so the checklist and the phase always agree. The `mkdir(dirname(workspacePath))` branch at step 7 was the one that did not, and set `attention` with the engine row still spinning beside it; it now goes through `markFailed(detail, 'workspace')` like the toolchain and cinna-cli branches.

`setConsent(userId, host, accepted)` writes the answer, then **awaits `inFlight` before reconciling**. The answer now arrives from the connect screen moments after activation, and the run activation started read the consent before this one wrote it — joining it would return `consent` and drop the answer.

`setState(next)` attaches `tasks` and then **broadcasts `state`, not `next`**. Sending `next` published a task-less object on every transition, so the per-component checklist existed in main and never survived a single push — the UI fell back to one "Installing…" line for a whole multi-part install, and the whole per-row feature was invisible behind it.

The checklist helpers, all operating on the module-level `tasks` array: `resetTasks()` (six rows from `TASK_LABELS` in `TASK_ORDER` — `uv`, `mutagen`, `cinna-cli`, `engine` "opencode engine", `workspace`, `token`; a measurable row starts at `percent: 0` so its empty track is on screen from the first frame; `token` is the one row with `measurable: false` and therefore no `percent` at all), `markActive(id, detail?, percent?)` — which now says nothing about the rows around it — `markDone(id, detail?)`, `markAllDone(detail?)`, and `markFailed(detail, id?)`, which fails the named row (or the first still in flight) and drops every other `active` row back to `pending`.

`ToolchainError` (`src/main/errors.ts`) carries an explicit `tool?: string` — spelled as a string so `errors.ts` stays free of imports from the installer that imports it — set by every throw site in `toolchain.ts`, and `taskForTool()` maps it onto a row by **membership test** rather than a cast. Neither the fallback nor `detail` could do this job: `detail` carries a stderr tail or a path in exactly the cases that matter most, and "the first active row" stopped meaning anything once several rows are active at once, so a cinna-cli failure was landing on Mutagen's row.

`activeRun` (with `runGeneration` as the counter) is the reconcile whose progress reports are worth listening to; `progressFor(generation)` drops any report that is not its. It is cleared in a `finally` when a run **ends**, not only when the next one starts, because the window that matters is after a failure: `Promise.all` rejects while a sibling download is still going, and that survivor keeps reporting for as long as it takes to finish. Left un-cleared, its next line replaces the `attention` the user is looking at with a bar nothing will complete.

`prefetchEngine(generation)` calls `prefetchEngineBinary` with a byte reporter and ticks the `engine` row. Each byte report re-emits `{ phase: 'installing', step, percent: overall(sequentialPercent) }` while the phase is `installing` — the download's own line as the step, because for the last stretch of a run this is the only thing happening and every other component narrates while it works. `markDone('engine', …)` carries *Already on this machine* unless the source was `managed`, since a bare tick reads like a 46 MB download flashed past. A pre-fetch that failed sets `engineSkipped` and `patchTask`s the row back to `pending` at 0 with a *Not cached — …* detail rather than `failed`: nothing is broken, so a red row would sit under a green `ready` for the session and nothing revisits it when the engine arrives at first use. `prefetchEngineBinary` never throws, so there is no error branch.

**It imports `binaryResolver`, not `engineManager`, and that is structural.** `engineManager`'s import graph reaches the app entry point (engineManager → engineConfigSource → localAgentService → watcherService → `src/main/index.ts`), so a static import from the reconciler would drag the whole entry into every consumer and its tests. `binaryResolver` is a leaf, and acquiring a binary is its job anyway — which is also why `configuredEnginePath()` moved there, with `engineManager` importing it back.

`ENGINE_SHARE` (0.15) and `overall(sequential)`: the engine cannot have a *range* like the toolchain (`TOOLCHAIN_SHARE`) or the workspace (`WORKSPACE_FROM`–`WORKSPACE_TO`) because it is concurrent, so its own percentage is weighted in on top of whatever the sequential part has reached. Without it the bar sat at 97% for the length of the download.

`overall()` also records its input in **`sequentialPercent`**, which is what lets the engine move the bar with nothing else running — the case the share exists for. Re-broadcasting a frozen `state.percent` recomputed nothing, so a warm toolchain and warm workspace left the bar at the token check's number for the whole download. It must be the **raw** figure: re-blending an already-blended percentage folds the engine's share in twice and moves the bar backwards.

`overall()` clamps what it returns against **`publishedPercent`**, the highest figure published this run (reset with the checklist). Each input moves forward on its own, but the sequence of sequential figures does not: `WORKSPACE_TO` (97) for the token check, then `WORKSPACE_FROM` (70) when `refreshAccountToken` runs on an expired token. Pre-existing, and exposed rather than introduced by routing those call sites through `overall()`. The clamp is here rather than at that one site, matching the toolchain's own aggregation.

`markAllDone` skips a `failed` row **and** the engine row when `engineSkipped`, so reaching `ready` cannot paint over either.

`mintSetupCommand` — `POST` to `localDev.setup_token_endpoint || '/api/v1/cli/account/setup-tokens'` via `cinnaFetch`. Branches: no `setup_command` in the response → `attention/workspace`; `CinnaApiError('reauth_required')` with `detail === '403'` → **`unsupported/role`**; any other `reauth_required` → `attention/token_expired`; anything else → `attention/network`.

`workspacePathFor(userId, host)` — `agentsHomeService.ensureHome(userId).path` + `getLayout(home).workshop.cloud_dir` + `hostDirName(host)`. `Cloud` is read from the kit contract's layout, never spelled as a literal here. `hostDirName` replaces `:` only (a hostname cannot contain a path separator).

`addToPath()` — `lstat` the target; a symlink already pointing inside `toolchain.root()` is unlinked and recreated (a version bump); **anything else is refused with a reason naming the path**.

cinna-cli invocations, all with `--no-input --json`:

| Call | argv | `logArgs` | cwd |
|---|---|---|---|
| create | `account setup <setup-command> --dir <path> --name <hostname()>` | `<setup-command>` replaced | `dirname(workspacePath)` |
| re-token | `account set-token <setup-command>` | `<setup-command>` replaced | workspace |
| status | `account status` | verbatim | workspace |
| context | `account refresh-context` | verbatim | workspace |

### `src/main/localdev/toolchain.ts`

`ToolchainDeps` (`root`, `platformKey`, `uvVersion`, `uvAssets`, `mutagenAssets`, `download`, `extract`, `shellEnv`, `run`) is **injected rather than module-mocked**, for the same reason `BinaryResolverDeps` is: the interesting cases are failures — an unknown Mutagen version, a digest mismatch, a `uv tool install` that exits non-zero, a `cinna` that will not run — and a test that cannot produce a mismatch is not testing verification.

- `requireAssets(pins)` resolves **both** tables before any work, raising `unsupported_platform` / `unknown_mutagen_version` up front
- `once(key, work)` de-duplicates concurrent installs keyed by tool, version **and** the reinstall flag. Entries are dropped when they settle rather than memoised — memoising would make the app confidently wrong about a directory the user has since deleted, which is the state Repair exists to recover from
- `run()` does `mkdir(root)` → `sweepStaging(root)` once per pass (sweeping per asset would race a sibling install's directory) → optional repair `rm`s → `Promise.all([uv → cinna-cli, Mutagen])`. Only `uv tool install` needs uv; nothing needs Mutagen. A rejection surfaces at once and the sibling keeps running in the background — deliberately, since killing an in-flight download to report a failure faster throws away bytes already paid for, and `once()` means the next reconcile joins that same promise rather than starting a second
- `TOOL_WEIGHT` (`uv` 0.2, `mutagen` 0.35, `cinna-cli` 0.45) plus `aggregate(onProgress)` replace the old fixed `STAGES` ranges and the `at(stage, fraction)` helper. `aggregate` keeps the highest `toolPercent` seen per tool, hands the caller the weighted sum, and clamps both the per-tool figure and the overall one to be non-decreasing — a range-based bar cannot express concurrent progress without jumping backwards. A skipped component reports `toolPercent: 100` immediately
- Progress goes to a mutable **`report` slot** that `run()` re-points at its own `aggregate()`, not to a callback threaded through each `ensure*`. `once()` makes a second run *join* an install already under way, and that install is a closure the first run created: with a captured argument it would keep reporting to a caller that has gone, leaving the run actually waiting on it with a row pending at 0% for the whole download and "Toolchain ready" aggregating to 65%. The latest run is always the one that wants to hear, and `reconcile` guarantees there is only one
- Every progress update carries `toolStatus: 'active' | 'done'`, so a caller can no longer infer completion from a later component starting. Each `ensure*` emits a closing `{ step: '<tool> installed', toolPercent: 100, toolStatus: 'done' }`, and a cheap-path skip emits the same `done` at once
- `ensureCli` cheap path: `state.json` stamp matches **and** `cinnaBin` is a file → return. Otherwise probe `cinna --version` and adopt it if it reports the pinned version. Otherwise `uv tool install [--reinstall] cinna-cli==<version>`, then probe again and refuse an install whose `cinna` will not run
- A failing `uv tool install` reports the **tail** of stderr (500 chars): a resolver failure is hundreds of lines and the last few say why
- Ceilings: `PROBE_TIMEOUT_MS` 30 s, `INSTALL_TIMEOUT_MS` 15 min (a cold profile downloads a CPython build *and* resolves the cinna-cli dependency tree)
- `toolchainEnv` = login-shell env + the four `UV_*` variables + `PATH` of `[binDir, mutagenDir, …inherited]`
- `asToolchainError` maps a `ManagedAssetError` to a `ToolchainError` **keeping the code string identical** — the overlap is the point, so a reason does not change its name on the way up — while changing the type so the reconciler can catch one family, and adding the tool's label to the message

### `src/main/localdev/cliRunner.ts`

`spawn` with `stdio: ['ignore', 'pipe', 'pipe']` and **no shell**. Line-buffered stdout; the trailing partial buffer is consumed in `finish`, because the final `{"result":…}` line arrives that way when the process exits promptly after writing it. A line with a string `result` becomes `outcome.result`; a line with `status` + `message` goes to `onProgress`; anything else is dropped, and non-JSON noise is logged up to `MAX_NOISE_LINES` (20). stderr is captured to 8 KB and trimmed to 2000 chars **for a log line, never for a decision**. Default ceiling `DEFAULT_TIMEOUT_MS` 10 min; a timeout `SIGKILL`s and resolves with `timedOut: true` and `exitCode: null`. A spawn that throws resolves with `code: 'spawn_failed'`. **It never rejects.**

### `src/main/localdev/cliCapabilities.ts`

`probeCliCapabilities(bin, version, env)` → `{ json, accountSetToken }`, cached per **(binary, version)** — the path `<localdev>/bin/cinna` is rewritten in place by an upgrade, so caching on the path alone would hand a new binary the old answer. `clearCliCapabilityCache()` is called on a forced reconcile, which may install a different version.

It reads `cinna account setup --help` for `--json` and `cinna account --help` for a `set-token` line (anchored `/^\s*set-token\b/m`, so prose mentioning the command does not match). A probe that cannot run at all answers the *smaller* surface: a reduced install still works, whereas assuming `--json` on a cinna-cli without it fails every command before it starts.

`protocolFlags(caps)` in `localDevService` is the single place that decides whether `--no-input --json` is appended. In `legacy` mode `readAccountStatus` returns no `{"result":…}` line, so the token-state and context-package branches are simply not taken, and `refreshAccountToken` returns `attention/token_expired` with copy naming the cause rather than running a command that does not exist.

### `src/main/managed/managedAsset.ts`

`installPinnedAsset` sequence: `isInstalled()` short-circuit → `.staging-<pid>-<now>-<seq>/` (the module-level counter is what keeps two concurrent installs — the toolchain downloads uv and Mutagen together — from picking the same directory inside one millisecond), added to the module-level `liveStaging` set for its lifetime → `download(url, archive)` → `sha256File` compared against the pin (**mismatch publishes nothing and retries nothing**) → `extract` → `locate(unpacked)` → `chmod 0o755` on the located file (non-Windows) → `rename` of **`dirname(found)`** into `installDir` — the directory holding the located file, not the staging tree, so the final layout is the same however the archive nested it and `installDir` never contains the archive it came from — tolerated on failure **only when `isInstalled()` is now true** (another caller published first, having passed the same check) → `rm(staging)` in a `finally`. Ceilings: `DOWNLOAD_TIMEOUT_MS` 10 min, `EXTRACT_TIMEOUT_MS` 5 min, `MAX_ARCHIVE_BYTES` 200 MB.

`sweepStaging(root)` skips any directory in `liveStaging`. An install can outlive the pass that started it — the toolchain deliberately leaves a download running when a concurrent sibling fails, so the next pass can join it rather than re-fetch the megabytes — and that next pass sweeps *before* it joins. Without the exemption it deleted the staging directory of the very download it was about to wait on, which then died at its own checksum with an ENOENT that reads like a corrupt release. A second *process* is still swept, as before: that race is survivable and probing pid liveness is more machinery than it justifies.

`ManagedAssetError` is generic over its code so `EngineBinaryError` can widen it with the two "your configured path is wrong" cases while `instanceof ManagedAssetError` still catches both families.

## Renderer Components

| Component / hook | Renders / manages |
|---|---|
| `useLocalDev()` | Subscribes once and returns `LocalDevState`. Mounted where the app is, not where a card is — the transitions that matter happen while nobody is looking at a particular screen |
| `useLocalDevStore` | One store for the whole renderer. Three surfaces read it and must agree; a spinner in the footer while Settings says "ready" is the contradiction that makes a user distrust both. **It renders state, never derives it** — every verb returns the next state, so there is no optimistic flip and no window where the UI shows a decision that has not been recorded. The one exception is `answeredHosts`, a renderer-only list of hosts *this window* has answered, set **before** the `consent()` call rather than after (the point is to cover the window while main is still working the answer through a reconcile), **rolled back and logged if that call rejects** — the channel is gated on an activated profile, and a rejection would otherwise suppress the question in both surfaces for the life of the window, with nothing setting local development up until a restart — and otherwise cleared only by `resetConsent()`. Only the surfaces that ask the question may read it |
| `LocalDevOnboardingStep` | Waits for the first answer, falls through on `unsupported` / `declined` (and on a `consent` for a host already in `answeredHosts`, which is what the deep-link route leaves behind), and gives up after `IDLE_GRACE_MS` (8 s) — `onDone` is held in a ref, because callers pass an inline arrow whose identity changes every render, and as an effect dependency that would restart the grace timer each time and could keep it from ever firing. Takes the Agents Home hint from `useAgentsHomeHint()` |
| `LocalDevConsentPanel` | Question → progress → (`ready` \| `attention`), in **one** component: two would mean the user clicking Set up and watching the screen change under them for no reason. "Continue in the background" is always available during `installing` — the reconciler runs in main and keeps going |
| `LocalDevConsentModal` | Renders **only** for `consent`, and only past first run, and not for a host in `answeredHosts`. No Escape/backdrop dismissal: dismissing has to record an answer. Closes itself once answered so `installing` does not keep it up |
| `LocalDevStatusButton` | Renders for `installing`, `attention` and `ready`; nothing for `idle`, `unsupported`, `consent` and `declined`. Clicking opens `LocalDevDetailModal` — it never starts work itself, so a mis-click on a footer glyph cannot trigger a reinstall. The **dot**, not the icon, marks `attention` |
| `LocalDevDetailModal` | The checklist (`state.tasks`), the current step and percentage, and Repair — hidden while `installing`, so a click cannot restart a running job. Renders what main reports and derives nothing locally. Portalled to `document.body` |
| `LocalDevTaskList` | One row per component, all six always present, and more than one may be `active`. A track on **every** row carrying a `percent`, whatever its status — filling in the accent while active, drawn full on `done` regardless of the last fraction reported, left where it stopped in `--color-danger` on `failed`, and in `--color-text-muted` while `pending`, since a pending row is not always empty: one that was downloading when a *different* component failed keeps the bytes it really fetched, and accent there would read as "still working" beside a row saying the run stopped. The `percent` **number** is still only on the `active` row. A row with no `percent` (the account token) shows no track at all |
| `LocalDevExplainer` | The single "what gets installed" list. The workspace bullet is omitted when the caller has not resolved the agents home, rather than saying "creates a folder somewhere" |
| `LocalDevOptInRow` | The **Enable local development** checkbox and its (?) popover, on the connect-confirm screen. Ticked is the default only for a host with no stored answer; unticked records a decline for that host |
| `LocalDevSettingsSection` | The only surface that shows every phase. `host` comes from the state for `consent`/`declined`, from the profile's `cinnaServerUrl` for `ready`, and is `null` otherwise — with no host the Consent card is left out rather than resetting a guess |

Both StrictMode-sensitive subscriptions (`localDev.store`, `connectIntent.store`) set `subscribed: true` **before** their first `await`, because a mount effect is double-invoked in development and two runs would attach two IPC listeners.

## Configuration

| Setting / constant | Where | Meaning |
|---|---|---|
| `localDevConsent` | `app_settings`, default scope | `{"<host>": boolean}` JSON. Absent host = never asked |
| `PINNED_UV_VERSION` | `toolchain.ts` | `'0.12.10'`. Bumping it means recomputing all four digests |
| `UV_ASSETS` | `toolchain.ts` | `${platform}-${arch}` → `{file, sha256}`. Four rows: `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64` |
| `MUTAGEN_ASSETS` | `toolchain.ts` | version → platform → `{file, sha256}`. Today `'0.18.1'`. **Adding a version means adding a whole platform row**, not one entry |
| `local_dev.cinna_cli_version` | server discovery | The cinna-cli version `uv tool install` pins to |
| `CINNA_CLI_SOURCE` | process environment | An absolute path to a local cinna-cli checkout, installed `--editable` **instead of** the pinned release. Set only by the cross-repo E2E run; a relative value is refused and ignored. While set the version pin does not apply, the install is never stamped (a working tree changes underneath), and every install logs a warning saying so |
| `local_dev.mutagen_version` | server discovery | Must exist in `MUTAGEN_ASSETS` or the answer is "update Cinna Desktop" |
| `local_dev.setup_token_endpoint` | server discovery | Absolute or path-relative; empty falls back to `/api/v1/cli/account/setup-tokens` |

## Looking at it by hand

`make demo-localdev SERVER=http://localhost:8000` builds and launches the app in a throwaway profile, opening on the connect-confirm step through the same argv funnel the OS uses for `cinna://`. Everything after that is the real flow, browser authorization included.

It exists because the E2E suite cannot serve this purpose: it proves the flow works and then tears the window down in seconds, while the part worth *looking* at — several minutes of per-component progress — only exists during a cold install. `make demo-clean` deletes the sandbox it prints for another cold run; keep it to land straight in `ready`.

The sandbox is a fresh `HOME` and `userData`, so the agents home and the account workspace never touch `~/Documents`. Both hold state a rerun reuses: the toolchain and the consent answer in `userData/`, the workspace under `home/Documents/CinnaAgents/Cloud/`. `SANDBOX=<path>` on either target picks a different profile, so a cold and a warm one can sit side by side. `scripts/demo-localdev.sh` says why each environment variable is set.

## Security

- **The setup command never leaves argv.** `runCinnaCli` requires a separate `logArgs`; the two calls that carry a secret pass `<setup-command>` in its place. No shell, so nothing can re-parse a token containing a metacharacter
- **The OAuth bearer never reaches the renderer**, and no local-dev verb takes a `userId` — the active profile is resolved in main
- `cinnaFetch` will follow an **absolute** endpoint URL from the discovery document (needed for split-host deployments, and already how `token_endpoint` / `userinfo_endpoint` work) but **refuses to send credentials over a non-TLS, non-loopback URL**
- **A 403 is not a session failure.** The status travels in `CinnaApiError.detail` so the local-dev reconciler can tell the role gate from a dead token; callers that only care about "the session is gone" keep switching on the code and never look at it
- **Nothing is downloaded or written outside `userData` before consent**, per host
- Digests are pinned **in source**, next to a note on how they were computed — a digest fetched alongside the bytes verifies nothing. They are not signatures: they establish that what arrived is what somebody at this repo verified once
- The `~/.local/bin/cinna` symlink is opt-in, refuses to replace anything that is not already a link into the managed root, and changes nothing about what the desktop itself spawns
