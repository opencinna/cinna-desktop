# Open in… (Local Agent Tools) — Technical Details

## File Locations

### Shared
- `src/shared/localTools.ts` — `LocalToolId`, `LocalToolKind` (`cli-assistant | editor | runtime`), `LocalToolSource` (`path | app-bundle`), `DetectedTool`, `OpenInAction`, `OpenInRequest`. Shared so preload, renderer and the main-process services see one set of shapes

### Main Process
- `src/main/services/localAgents/toolDetectionService.ts` — the tool table and the cached detection pass
- `src/main/services/localAgents/openInService.ts` — path guard, tool assertion and the platform launchers
- `src/main/services/localAgents/terminalCommand.ts` — pure command construction, quoting and the root-containment test. No Electron, no `node:fs`, so the escaping rules are directly unit tested
- `src/main/services/localAgents/terminalCommand.test.ts` — coverage for the quoting, argv building and containment rules
- `src/main/errors.ts` — `LocalToolsError` / `LocalToolsErrorCode`, a `DomainError` subclass, alongside the other domain error codes
- `src/main/ipc/local_tools.ipc.ts` — the three thin handlers
- `src/main/shell/env.ts` — `which()` and the resolved `PATH`; see [Shell Environment Resolution](../../development/shell_environment/shell_environment_tech.md)

### Preload
- `src/preload/index.ts` — `window.api.localTools.list()`, `.refresh()`, `.openIn(request)`

### Renderer
- `src/renderer/src/hooks/useLocalTools.ts` — `useLocalTools()`, `useAvailableTools(kind)`, `useRefreshLocalTools()`, `useOpenIn()`

### Packaging
- `build/entitlements.mac.plist` — `com.apple.security.automation.apple-events`
- `electron-builder.yml` — `mac.extendInfo` → `NSAppleEventsUsageDescription`

No database schema: detection is a runtime probe and nothing about it is persisted.

## IPC Channels

| Channel | Type | Purpose |
|---------|------|---------|
| `local-tools:list` | invoke | The detected tools (cached in main for the app lifetime) → `DetectedTool[]` |
| `local-tools:refresh` | invoke | Drop the PATH-lookup cache, re-detect → `DetectedTool[]` |
| `local-tools:open-in` | invoke | Perform an `OpenInRequest` → `{ success: true }`, or a `LocalToolsError` |

All three call `userActivation.requireActivated()` and are wrapped by `ipcHandle()`; the handlers hold no logic beyond that — validation of the folder and the tool id lives in the service. Registration goes through `registerLocalToolsHandlers()` from `src/main/ipc/index.ts` (enforced by `src/main/ipc/registration.test.ts`).

## Services & Key Methods

### `src/main/services/localAgents/toolDetectionService.ts`
- `TOOL_SPECS` — the ordered table: id, kind, label, binary name, and optional `macBundles`. `code` → `/Applications/Visual Studio Code.app`, `cursor` → `/Applications/Cursor.app`; each bundle is also probed under `~/Applications`
- `list()` — memoised `detectAll()`. On failure the memo is cleared and a fully-unavailable list is returned, so the next call retries
- `refresh()` — `clearToolCache()` then re-run `list()`
- `get(id)` — a single tool, `undefined` for an unknown id (the id allowlist the IPC layer relies on)
- `detect(spec)` — `which(spec.bin)` first (`source: 'path'`), then the macOS bundle candidates (`source: 'app-bundle'`), else unavailable

### `src/main/services/localAgents/openInService.ts`
- `createOpenInService(deps)` — factory taking `getAllowedRoots: () => string[]`, so the guard is real from day one and registering the roots is the only thing that changes
- `setAllowedRootsProvider(provider)` — the registration hook. The module-level default returns `[]`, so until it is called `openInService` refuses everything with `no_roots`. `src/main/services/localAgents/localAgentService.ts:configure()` supplies the real provider (`agentsHomeService.rootPaths(userId)`) once, from the IPC registrar; ordering matters, since nothing may open a folder before the roots are known
- `resolveAllowedFolder(folder)` — `isLaunchablePath` → non-empty roots → `realpath` → `isDirectory` → `realpath` each root → `isPathWithinRoots`. Returns the **resolved** path, which is what every launcher then uses
- `requireTool(toolId, kinds)` — looks the id up through `toolDetectionService.get`, asserts `available` and a matching kind
- `launchTerminal(folder, commandPath)` — macOS: prefer an iTerm bundle, build the AppleScript, run `osascript -e <script>` (one argv element, so nothing is interpreted by a shell on the way); Windows: `buildWindowsLaunch` after probing `which('wt')`; Linux: first of `LINUX_TERMINALS` that `which` resolves, launched detached with the folder as `cwd`
- `asAutomationDenial(err)` — matches `-1743` / "Not authorized to send Apple events" and rewraps as `LocalToolsError('automation_denied', …)`
- `launchDetached(file, args, cwd)` — `spawn` with `detached: true`, `stdio: 'ignore'`; the error event gets one tick before `unref()`
- `runToCompletion(file, args)` — `execFile` with a 15 s timeout, surfacing `stderr`; used for `osascript` and `open -a`
- `guardLaunch(what, run)` — passes `LocalToolsError` through, wraps anything else as `launch_failed`
- Public surface: `openInTerminalWithCommand`, `openFolderInEditor`, `revealInFileManager`, `openTerminalAt`, and `openIn(request)` — the single entry point the IPC layer calls, which switches on `request.action` and rejects an unknown one with `unsupported_action`

### `src/main/services/localAgents/terminalCommand.ts`
- `shellQuote(value)` — POSIX single-quoting with the `'\''` close-escape-reopen dance
- `appleScriptQuote(value)` — AppleScript string literal; backslash doubled before the quote escaping
- `buildTerminalShellCommand(folder, commandPath)` — `cd <folder>` joined to the tool with `&&`
- `buildTerminalAppleScript` / `buildITermAppleScript` — Terminal.app `do script` and iTerm2 `write text` variants
- `LINUX_TERMINALS` — `x-terminal-emulator`, `gnome-terminal`, `konsole`, `xterm`, in preference order
- `buildLinuxTerminalArgv(terminal, commandPath)` — `[flag, 'bash', '-lc', "<tool>; exec bash -l"]`, where `flag` is `--` for `gnome-terminal` (which deprecated `-e`) and `-e` otherwise. Returns `[]` when there is no command — the folder is the child's `cwd` and never appears here
- `buildWindowsLaunch(folder, commandPath, hasWindowsTerminal)` — Windows Terminal takes the folder as a discrete `-d` argument (spawned directly, so `cmd`'s `%VAR%` expansion never sees it); the `cmd.exe` fallback gets the folder as `cwd` and keeps it off the command line entirely
- `isPathWithinRoots(folder, roots, platform)` — normalises, strips trailing separators, lowercases on win32/darwin, then matches equality or a `base + sep` prefix. Both sides must already be absolute and `realpath`d
- `isLaunchablePath(folder, platform)` — non-empty, ≤ 4096 chars, no `U+0000`–`U+001F` or `U+007F`, and absolute for the platform

## Renderer

- `useLocalTools()` — TanStack Query over `local-tools:list` with `staleTime: Infinity`; the main-process cache makes it cheap after the first call and `useRefreshLocalTools` is the only invalidation
- `useAvailableTools(kind)` — filters to `available && kind === …`, which is what the Open-in row renders
- `useRefreshLocalTools()` — mutation over `local-tools:refresh`, writing the result straight into the query cache
- `useOpenIn()` — mutation over `local-tools:open-in`. Main re-validates the folder, so a rejection here is expected and must be surfaced, not swallowed

## Configuration

- `build/entitlements.mac.plist` — `com.apple.security.automation.apple-events` (required for `osascript` to drive Terminal/iTerm under the hardened runtime)
- `electron-builder.yml` — `NSAppleEventsUsageDescription` in `mac.extendInfo`, the string macOS shows in the Automation prompt
- `OSASCRIPT_TIMEOUT_MS` — 15 s, the ceiling on `osascript` and `open`

## Security

- **Path guard** — absolute, control-character-free, `realpath`d, must be a directory at or under a `realpath`d registered root, separator-boundary matched; the resolved path is what is launched. See the business rules in [Open in Tools](open_in_tools.md)
- **Closed by default** — with no roots provider registered the guard refuses everything, so a gap in wiring fails safe rather than opening the filesystem
- **No path is concatenated into a command line** except in the macOS AppleScript, where it is shell-quoted and then AppleScript-quoted
- **`open -a`, never `shell.openExternal`** for the bundle-launch path — nothing user-influenced is ever parsed as a URL, and both operands stay discrete arguments
- **Refusals log no paths** — root count and path length only, so the log cannot serve as a filesystem oracle
- **Tool ids are an allowlist** — `toolDetectionService.get` returns `undefined` for anything not in `TOOL_SPECS`, and only an absolute path the detector itself found is ever executed
- Every IPC channel is behind `requireActivated()`
