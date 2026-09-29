# Developer Tools on a Bare Machine — Technical Details

Implementation companion to [developer_tools.md](developer_tools.md). All three modules are Hub core: no Electron import, paths through `runtimeHost`.

## File Locations

### Main Process
- `src/main/shell/macDeveloperTools.ts` — the stub list, the tools-state probe, and `createUsableTool()`
- `src/main/shell/developerToolShims.ts` — `tool-shims/` and the child-`PATH` plan; `withDeveloperToolShims(env)`
- `src/main/shell/managedGit.ts` — the managed git's install, wrapper and fallback
- `src/main/shell/env.ts` — `usableTool(bin)`, `whichPastStub(bin)`; `clearToolCache()` and `resetShellEnv()` also call `macDeveloperTools.clear()`
- `src/main/managed/managedAsset.ts` — `sweepSuperseded()` and `markUsed()` moved here from `engine/binaryResolver.ts` (which re-exports `markUsed`) so the managed git can use them without importing the resolver; `installPinnedAsset` gained `publishDir`
- `src/shared/runtimePins.ts` — `RUNTIME_PINS.git`

### Callers
- `usableTool`: `services/localAgents/toolDetectionService.ts:detect()`, `services/localAgents/gitService.ts:resolveGit()`, `services/handoverGit.ts` (`resolveGit` dep; a null git returns the no-git answer without spawning)
- `withDeveloperToolShims`: `agents/drivers/index.ts` (Claude and Codex launch env and login probes, OpenCode `childEnv`, and the development-agent `PATH` override), `services/customAgentService.ts` (custom ACP `childEnv`), `mcp/manager.ts` (stdio base env, before `mergeEnv` with `config.env`)
- `agents/drivers/acp/acpLaunchers.ts` — OpenCode's spec key now digests `env.PATH`; Claude's and Codex's keys already covered their env

## Services & Key Methods

### `macDeveloperTools.ts`
- `MAC_DEVELOPER_TOOL_STUBS` — the 78 `/usr/bin` names that are hard links of the `xcrun` shim (read off macOS 15)
- `createMacDeveloperTools(deps)` → `isStub(path)` (darwin, `dirname === '/usr/bin'`, name in the set), `state()` → `DeveloperToolsState`, `installed()`, `clear()`
- `state()`: `/usr/bin/xcode-select -p` (5 s timeout). Non-zero exit → absent; a directory → installed only if `<dir>/usr/bin/git` exists (a selected-then-deleted Xcode reads absent); a timeout or spawn error → the last real answer, re-stamped for another TTL, else `unknown` uncached. `DEVELOPER_TOOLS_TTL_MS` 60 s; one in-flight probe shared; a `generation` counter stops a probe spanning `clear()` from caching. Logs only on change
- `createUsableTool({which, tools, pastStub, fallback})` — `which` hit that is not a stub → it; stub with tools `installed` → it; else `pastStub(bin)`; else `fallback(bin, {install: state !== 'unknown'})`. A `which` miss → `fallback(bin, {install: true})`

### `env.ts`
- `usableTool` — `createUsableTool` over `which`, `macDeveloperTools`, `whichPastStub`, and `managedGit.fallback` for `git` only
- `whichPastStub(bin)` — `findExecutable` over the login-shell `PATH` with a probe that rejects stubs. Uncached: asked only after `which` landed on a stub

### `developerToolShims.ts`
- `SHIM_DIR_NAME` `'tool-shims'`; `shimScript(name, git?)` — `#!/bin/sh`, message to stderr, `exit 127`. The `git` variant first walks `$PATH` (with `set -f; IFS=:`), skipping `tool-shims/`, `git-shim/`, `/usr/bin` and empty entries, and `exec`s the first executable `git`; then `exec`s the managed wrapper if it is executable
- `plan()` — darwin: `installed` → `[]`; otherwise `which` every stub name, shim those that land on a stub; `gitMissing` unless `whichPastStub('git')` finds a real one. Linux: `gitMissing` = `which('git') === null`. When `gitMissing`: the wrapper's directory if `managedGit.wrapperPath()` answers, else `ensureInstalled()` (not awaited; not when the state is `unknown`). Returns `[git-shim?, tool-shims?]`
- `sync(dir, names)` — writes each script via temp + rename only when its content differs, re-`chmod`s, deletes any non-dot entry not in `names`. Serialised through one promise queue
- `apply(env)` — darwin/linux only; strips earlier copies of either directory, prepends the plan, never throws (logs `could not shim the developer-tool stubs`)

### `managedGit.ts`
- `createManagedGit(deps)` — `root()` = `<runtimes>/git-<version>`; `installed()` = `bin/git` is a file; `ensureInstalled()` (single-flight, once per run, returns null when failed/off/unsupported/marked); `wrapperPath()` writes the wrapper (temp + rename, only on change) when installed and `markUsed(root)` at most every `MARK_USED_INTERVAL_MS` (1 h); `wrapperLocation()` without looking; `fallback({install})`; `supported()`
- `install()` — `sweepStaging` then `installPinnedAsset` with `locate` = `bin/git` exists **and** `probeVersion` (run with `managedGitEnv(unpacked)`) equals `versionOutput`, `publishDir` = the tree root. A `locate` rejection writes `unsupportedMarkerName(version)` (`.git-<v>-unsupported`, dot-prefixed so neither sweep takes it). A fresh publish runs `sweepSuperseded(runtimes, 'git', …)`
- `managedGitEnv(root, platform)`, `gitWrapperScript(root, platform, version)`, `shellQuote(value)`

## Configuration

- `CINNA_GIT_DOWNLOAD=off` — `managedGit.ensureInstalled()` does nothing. Set by `e2e/fixtures/app.ts` on every launch, after a spec's own variables
- On disk: `<userData>/tool-shims/<name>`, `<userData>/git-shim/git`, `<userData>/runtimes/git-<version>/{bin,libexec,share,etc}`, `<userData>/runtimes/.git-<version>-unsupported`
- No setting, no IPC channel, no renderer surface

## Security

- The shims and wrapper are written by the app into `userData`; each name comes from the fixed stub list and every path in a script is single-quoted by `shellQuote`
- The managed git is published only after its archive digest matches the pin and its `bin/git` reports the pinned version
- dugite's variables live in the wrapper, never in a child's environment, and the wrapper sets `GIT_CONFIG_SYSTEM` / `GIT_SSL_CAINFO` only when the caller has none

## Testing Notes

- `macDeveloperTools.test.ts` — stub identification, the TTL, `unknown` versus absent, one probe per burst, `clear()`, and `createUsableTool`'s order (including no install when the state is unknown)
- `developerToolShims.test.ts` — the `PATH` plan, idempotence, stale-shim removal, never throwing, and the `git` stand-in's delegation, run through `/bin/sh`
- `managedGit.test.ts` — publish, checksum and version failures, the unsupported marker surviving a sweep, single-flight, `CINNA_GIT_DOWNLOAD=off`, the wrapper's environment and quoting
- `toolDetectionService.test.ts` — stubs read as not installed and are never run
- `handoverGit.test.ts`, `acpLaunchers.test.ts`, `mcp/manager.peer.test.ts` — the no-git handover answer, OpenCode's key following `PATH`, and the MCP child's `PATH`
- Every test runs on fakes — injected `xcode-select` answers, scripted `git` trees packed with `tar` — so none of them proves the real dialog stays shut or that the real dugite archive installs and runs
