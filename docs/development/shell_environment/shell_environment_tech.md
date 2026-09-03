# Shell Environment Resolution — Technical Details

## File Locations

### Main Process
- `src/main/shell/env.ts` — the resolver itself. Owns the once-per-lifetime resolution, the `which` cache, and re-exports the merging helpers so callers need a single import from the shell layer
- `src/main/shell/pathWalk.ts` — pure PATH-walking rules (split, validate, candidate generation, first-match walk). Free of `node:fs` and of the Electron-bound logger so Windows semantics can be exercised from a POSIX host
- `src/main/shell/envMerge.ts` — the child inherit allowlist, the narrowing, the merge, and the dropped-names diagnostic. Electron-free for the same reason
- `src/main/shell/pathWalk.test.ts`, `src/main/shell/envMerge.test.ts` — unit coverage for both pure modules
- `src/main/mcp/manager.ts` — first consumer; see [MCP Connections — Technical Details](../../mcp/connections/connections_tech.md)
- `src/main/services/localAgents/toolDetectionService.ts` — second consumer; see [Open in Tools — Technical Details](../../agents/local_agents/open_in_tools_tech.md)

There is no database schema, no IPC channel and no renderer surface for this module — it is a main-process library.

## Key Functions

### `src/main/shell/env.ts`
- `getShellEnv()` — the resolved environment. Memoised in a module-level `resolved`; concurrent callers share a module-level `inFlight` promise. The promise chain is started from `Promise.resolve().then(...)` so a synchronous throw cannot run the `finally` before `inFlight` is assigned
- `getResolvedPath()` — convenience wrapper returning `env.PATH ?? ''`
- `which(bin)` — resolve a bare binary name against the resolved `PATH`. Refuses non-bare names via `isBareBinaryName`, de-dupes in-flight lookups per binary in `toolInFlight`, caches results (hits **and** misses) in `toolCache`, and returns `null` on any failure after a warning
- `clearToolCache()` — drops `toolCache` only. The resolved environment is intentionally kept
- `loginShell()` — `process.env.SHELL` when absolute, else `/bin/zsh` on darwin, `/bin/bash` elsewhere
- `resolveShellEnv()` — short-circuits `win32` to `process.env`; otherwise tries `['-ilc']` then `['-lc']`, merging the first parseable dump over `process.env`
- `probeShell(shell, args)` — spawns the probe with `stdio: ['ignore','pipe','ignore']`, `DISABLE_AUTO_UPDATE` / `ZSH_DISABLE_COMPFIX` set, a `RESOLVE_TIMEOUT_MS` (5 s) `SIGKILL` timer and a `MAX_OUTPUT_BYTES` (2 MB) accumulation cap. Resolves `null` rather than rejecting
- `parseEnvDump(stdout)` — finds the sentinel, discards everything up to and including its newline, then splits the remainder on `\0` and on the first `=` of each record. Returns `null` when the sentinel is absent or nothing parsed
- `isExecutableFile(candidate)` — `stat` must report a file; on POSIX an additional `access(…, X_OK)`; on Windows existence alone

Constants: `SENTINEL`, `RESOLVE_TIMEOUT_MS`, `MAX_OUTPUT_BYTES`, `PROBE_COMMAND` (`echo <sentinel>; env -0`).

### `src/main/shell/pathWalk.ts`
- `currentWalkPlatform()` — `'win32' | 'posix'`, injectable everywhere below so tests can exercise Windows rules on macOS
- `splitPathEntries(pathValue, platform)` — splits on `;`/`:`, trims, strips surrounding quotes on Windows, drops empties (the cwd-hijack guard) and duplicates
- `isBareBinaryName(bin)` — `^[A-Za-z0-9._+-]+$`, max 64 chars, and not `.`/`..`
- `executableCandidates(bin, entries, {platform, pathExt})` — absolute candidates in PATH order; on Windows adds one candidate per `PATHEXT` entry unless the name already ends with one. Non-absolute PATH entries are skipped. `DEFAULT_PATHEXT` is `.COM;.EXE;.BAT;.CMD`
- `findExecutable(bin, entries, isExecutable, options)` — first candidate the injected probe accepts, else `null`. The probe is injected so the walk is testable without touching disk

### `src/main/shell/envMerge.ts`
- `CHILD_ENV_ALLOWLIST` — `DEFAULT_INHERITED_ENV_VARS` (imported from `@modelcontextprotocol/sdk/client/stdio.js`, never copied) plus `EXTRA_INHERITED_ENV_VARS`
- `SESSION_ENV_VARS` — `SSH_AUTH_SOCK`, `DISPLAY`, `WAYLAND_DISPLAY`, `XAUTHORITY`, `DBUS_SESSION_BUS_ADDRESS`, `TMPDIR`
- `WINDOWS_EXTRA_ENV_VARS` — `['PATHEXT']` on win32, empty elsewhere. Kept a separate constant because its justification is *not* the session group's
- `REGRESSION_ONLY_ENV_VARS` — `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `ALL_PROXY`, their lowercase forms, and `NODE_EXTRA_CA_CERTS`. **Not** part of `CHILD_ENV_ALLOWLIST` — they are applied in a second pass from a different source
- `shellEnvForChild(base, allowlist?, processEnv?)` — pass 1 copies allowlisted string values from `base` (the shell environment), skipping any value starting with `()`; pass 2 copies `REGRESSION_ONLY_ENV_VARS` from `processEnv` under the same `()` filter. Because pass 2 runs last, `process.env` wins over the shell dump for those keys. Both extra parameters exist for testability
- `mergeEnv(base, overrides?)` — last-wins merge producing the `Record<string, string>` a child `env` option wants. **Does not narrow** — callers spawning a third-party binary must pass a base that has already been through `shellEnvForChild`
- `droppedChildEnvNames(base, overrides?, processEnv?)` — sorted names present in `base` but absent from the merged result. Names only, by hard rule

## Configuration

- No settings, no environment variables of its own. Behaviour is entirely derived from the user's shell and platform
- The probe's own child environment sets `DISABLE_AUTO_UPDATE=true` and `ZSH_DISABLE_COMPFIX=true`

## Security

- **The resolved environment is never logged.** `env.ts` logs the shell, the mode (`-ilc`/`-lc`) and `splitPathEntries(...).length` only
- **Narrowing before spawn is mandatory.** `mergeEnv` alone does not narrow; passing a raw `getShellEnv()` result to a third-party child hands over every exported secret in the user's profile
- **`()`-valued entries are dropped** at both passes of `shellEnvForChild` — the Shellshock encoding of exported bash functions, which a login-shell dump can contain and `process.env` effectively cannot
- **`droppedChildEnvNames` must never log values.** The dropped set is the secret-bearing half of the environment
- **Bare-name-only lookups.** `which` refuses anything containing a separator or `..`, and empty `PATH` entries are dropped so the app's cwd cannot supply a binary

## Testing Notes

- `src/main/shell/pathWalk.test.ts` — splitting, de-duping, bare-name validation, Windows `PATHEXT` candidate expansion, first-match ordering
- `src/main/shell/envMerge.test.ts` — allowlist membership (including that `TMPDIR` and the session group are inherited), the `()` filter, `process.env`-sourced proxy variables beating the shell dump, override precedence, and the dropped-names output
- `src/main/shell/env.ts` has no unit test of its own: the spawning half is exercised manually, which is why the rules worth testing were extracted into the two pure modules
