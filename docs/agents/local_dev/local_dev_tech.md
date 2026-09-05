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
- `src/shared/localDevState.ts` — the whole wire contract: `LocalDevState` (six phases), `LocalDevAttentionReason`, `LOCAL_DEV_STATE_CHANNEL`, `CinnaLocalDev`. Type-only plus one channel constant; nothing key-shaped
- `src/shared/appSettings.ts` — `localDevConsent: string` on `AppSettingsSchema`
- `src/shared/localTools.ts` — `LocalToolId` gains `'cinna'`; `LocalToolSource` gains `'managed'`

### Main process — `src/main/localdev/`
- `localDevService.ts` — the reconciler. `localDevService.{getState, reconcile, setConsent, resetConsent, consent, openWorkspace, addToPath, clear}`, plus `hostDirName`, `fromToolchainError` and `fromCliOutcome` — exported only so the failure→state mapping can be unit-tested, since the reconciler itself needs a database, a window and a server — and module-private `runReconcile`, `mintSetupCommand`, `createWorkspace`, `refreshAccountToken`, `readAccountStatus`, `protocolFlags`, `readConsent`, `writeConsent`, `workspacePathFor`, `accountConfigPath`, `setState`
- `toolchain.ts` — `PINNED_UV_VERSION`, `UV_ASSETS`, `MUTAGEN_ASSETS`, `uvAssetUrl()`, `mutagenAssetUrl()`, `createToolchain(deps)`, `toolchain` (the process-wide instance), `realToolchainDeps()`, `localDevRootDir()`, `runCapture()`, `parseVersion()`; types `ToolchainPins`, `ToolchainPaths`, `ToolchainProgress`, `ToolchainResult`, `ToolchainDeps`, `Toolchain`
- `cliRunner.ts` — `runCinnaCli(opts)`; types `CliRunOptions`, `CliRunOutcome`, `CliProgressLine`, `CliResultLine`
- `cliCapabilities.ts` — `probeCliCapabilities(bin, version, env)`, `clearCliCapabilityCache()`; type `CliCapabilities`
- `toolchain.test.ts`, `cliRunner.test.ts`, `cliCapabilities.test.ts`, `localDevService.test.ts`

### Main process — `src/main/managed/`
- `managedAsset.ts` — the staged, verified, atomically published install, extracted from `engine/binaryResolver.ts` and shared with it. `installPinnedAsset()`, `downloadToFile()`, `extractArchive()`, `sha256File()`, `findNamedFile()`, `sweepStaging()`, `isFile()`, `ManagedAssetError`, `ManagedAssetErrorCode`, `PinnedAsset`, `InstallPinnedAssetOptions`
- `managedAsset.test.ts`

### Main process — elsewhere
- `src/main/ipc/localdev.ipc.ts` — `registerLocalDevHandlers()`; seven channels, no state push of its own (the service broadcasts)
- `src/main/errors.ts` — `ToolchainErrorCode`, `ToolchainError`
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
- `src/renderer/src/stores/localDev.store.ts` — `useLocalDevStore`: `state`, `subscribed`, `subscribe()`, `set()`, `consent()`, `resetConsent()`, `repair()`, `openWorkspace()`
- `src/renderer/src/hooks/useLocalDev.ts` — `useLocalDev()`, subscribes on mount
- `src/renderer/src/components/localdev/LocalDevConsentPanel.tsx` — the shared question/progress/failure/ready panel
- `src/renderer/src/components/localdev/LocalDevOnboardingStep.tsx` — the `localdev` onboarding step
- `src/renderer/src/components/localdev/LocalDevConsentModal.tsx` — the same panel over an app that is past first run
- `src/renderer/src/components/localdev/LocalDevStatusButton.tsx` — the sidebar-footer indicator
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
| `localdev:get-consent` | `() → Record<string, boolean>` | For Settings |
| `localdev:open-workspace` | `() → { ok: boolean }` | `shell.openPath` on `state.workspacePath`; `ok: false` unless `ready` |
| `localdev:add-to-path` | `() → { ok: boolean; path?: string; reason?: string }` | The `~/.local/bin/cinna` symlink |
| `localdev:state` (push) | `LocalDevState` | Main → renderer, on every transition, to every live window |

Two rules hold across all of them:

- **Every verb resolves the active profile itself** (`getProfileScopeUserId()`), and there is no `userId` parameter. The reconciler mints setup tokens with that profile's OAuth bearer and writes into that profile's agents home, so a renderer-supplied id would be a confused deputy — the same rule `authService.reauthCinna` follows
- **Nothing throws for an ordinary failure.** A refused install, a rejected token and a missing role all come back as `LocalDevState`, because a thrown `DomainError`'s code does not survive the IPC boundary and every one of these is something the UI renders rather than catches

## Services & Key Methods

### `src/main/localdev/localDevService.ts`

`runReconcile(userId, force)` in order:

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
11. `ready { workspacePath, cliVersion, cinnaBinPath }`

`reconcile` wraps that in the single-flight promise and a `.catch` that turns a thrown bug into `attention/workspace` — the user still needs a state they can act on rather than a spinner that never resolves.

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
- `run()` does `mkdir(root)` → `sweepStaging(root)` once per pass (sweeping per asset would race a sibling install's directory) → optional repair `rm`s → uv → Mutagen → cinna-cli
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

`installPinnedAsset` sequence: `isInstalled()` short-circuit → `.staging-<pid>-<now>/` → `download(url, archive)` → `sha256File` compared against the pin (**mismatch publishes nothing and retries nothing**) → `extract` → `locate(unpacked)` → `chmod 0o755` on the located file (non-Windows) → `rename` of **`dirname(found)`** into `installDir` — the directory holding the located file, not the staging tree, so the final layout is the same however the archive nested it and `installDir` never contains the archive it came from — tolerated on failure **only when `isInstalled()` is now true** (another caller published first, having passed the same check) → `rm(staging)` in a `finally`. Ceilings: `DOWNLOAD_TIMEOUT_MS` 10 min, `EXTRACT_TIMEOUT_MS` 5 min, `MAX_ARCHIVE_BYTES` 200 MB.

`ManagedAssetError` is generic over its code so `EngineBinaryError` can widen it with the two "your configured path is wrong" cases while `instanceof ManagedAssetError` still catches both families.

## Renderer Components

| Component / hook | Renders / manages |
|---|---|
| `useLocalDev()` | Subscribes once and returns `LocalDevState`. Mounted where the app is, not where a card is — the transitions that matter happen while nobody is looking at a particular screen |
| `useLocalDevStore` | One store for the whole renderer. Three surfaces read it and must agree; a spinner in the footer while Settings says "ready" is the contradiction that makes a user distrust both. **It renders state, never derives it** — every verb returns the next state, so there is no optimistic flip and no window where the UI shows a decision that has not been recorded |
| `LocalDevOnboardingStep` | Waits for the first answer, falls through on `unsupported` / `declined`, and gives up after `IDLE_GRACE_MS` (8 s) — `onDone` is held in a ref, because callers pass an inline arrow whose identity changes every render, and as an effect dependency that would restart the grace timer each time and could keep it from ever firing. Reads the Agents Home from `localAgents.rootsList()` purely for the consent copy |
| `LocalDevConsentPanel` | Question → progress → (`ready` \| `attention`), in **one** component: two would mean the user clicking Set up and watching the screen change under them for no reason. "Continue in the background" is always available during `installing` — the reconciler runs in main and keeps going |
| `LocalDevConsentModal` | Renders **only** for `consent`, and only past first run. No Escape/backdrop dismissal: dismissing has to record an answer. Closes itself once answered so `installing` does not keep it up |
| `LocalDevStatusButton` | Renders **nothing** for `idle`, `unsupported`, `consent`, `declined` **and `ready`**. Two visible states only: working, and needs you. A permanent tick for "the thing you never asked about is fine" is footer noise |
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

## Security

- **The setup command never leaves argv.** `runCinnaCli` requires a separate `logArgs`; the two calls that carry a secret pass `<setup-command>` in its place. No shell, so nothing can re-parse a token containing a metacharacter
- **The OAuth bearer never reaches the renderer**, and no local-dev verb takes a `userId` — the active profile is resolved in main
- `cinnaFetch` will follow an **absolute** endpoint URL from the discovery document (needed for split-host deployments, and already how `token_endpoint` / `userinfo_endpoint` work) but **refuses to send credentials over a non-TLS, non-loopback URL**
- **A 403 is not a session failure.** The status travels in `CinnaApiError.detail` so the local-dev reconciler can tell the role gate from a dead token; callers that only care about "the session is gone" keep switching on the code and never look at it
- **Nothing is downloaded or written outside `userData` before consent**, per host
- Digests are pinned **in source**, next to a note on how they were computed — a digest fetched alongside the bytes verifies nothing. They are not signatures: they establish that what arrived is what somebody at this repo verified once
- The `~/.local/bin/cinna` symlink is opt-in, refuses to replace anything that is not already a link into the managed root, and changes nothing about what the desktop itself spawns
