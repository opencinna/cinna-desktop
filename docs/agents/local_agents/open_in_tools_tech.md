# Open in… (Local Agent Tools) — Technical Details

## File Locations

### Shared
- `src/shared/localTools.ts` — `LOCAL_TOOL_IDS` (the runtime list `LocalToolId` is derived from, so a setting can be validated against it without the two drifting), `isLocalToolId()`, `LocalToolKind` (`cli-assistant | editor | runtime`), `LAUNCHABLE_TOOL_KINDS` (`cli-assistant`, `editor` — the only kinds that may be the default), `actionForTool(tool)` (`editor` → `'editor'`, else `'terminal-command'`), `LocalToolSource`, `DetectedTool`, `OpenInAction`, `OpenInRequest`. Shared so preload, renderer and the main-process services see one set of shapes
- `src/shared/appSettings.ts` — `localAgentsDefaultTool: string` (a `LocalToolId` or `''`), `localAgentsAutoOpen: boolean`
- `src/shared/agentInitPrompt.ts` — `AGENT_INIT_ENTRY_FILES` (`AGENTS.md`, `CLAUDE.md`, `README.md`, in the order an assistant should be pointed at them), `AgentInitPromptInput` (`folder`, `name`, `entryFile | null`) and `buildAgentInitPrompt(input)`. Shared so the wording has one copy: main decides *which* entry document exists, this file decides what is said about it. The no-entry-document branch names `MANIFEST_FILE` and `LOCAL_AGENT_PROMPT_PATHS.workflow` rather than repeating either literal. **Rewording it is a two-file change:** `e2e/specs/agent-page.spec.ts` asserts the whole string, character for character, against both the real clipboard and `initPrompt`, so the prose is pinned by an E2E rather than merely by the service test's `toContain` checks — deliberate (a silent reword of a briefing an assistant acts on should not pass), but it means the spec literal has to move with it

### Main Process
- `src/main/services/localAgents/toolDetectionService.ts` — the tool table and the cached detection pass
- `src/main/services/localAgents/openInService.ts` — path guard, tool assertion and the platform launchers
- `src/main/services/localAgents/terminalCommand.ts` — pure command construction, quoting and the root-containment test. No Electron, no `node:fs`, so the escaping rules are directly unit tested
- `src/main/services/localAgents/terminalCommand.test.ts` — coverage for the quoting, argv building and containment rules
- `src/main/errors.ts` — `LocalToolsError` / `LocalToolsErrorCode`, a `DomainError` subclass, alongside the other domain error codes
- `src/main/services/appSettingsService.ts` — the `localAgentsDefaultTool` entry of `VALUE_CHECKS`: empty, or `isLocalToolId`, else `AppSettingsError('invalid_value')`. `localAgentsAutoOpen` has only the generic `typeof` gate against its `false` default (`src/main/db/appSettings.ts`)
- `src/main/services/appSettingsService.test.ts` — `codex` and `''` accepted, `vim` refused, the boolean round-trips
- `src/main/ipc/local_tools.ipc.ts` — the three thin handlers
- `src/main/services/localAgents/localAgentService.ts` — `initPrompt(userId, agentId)`, the briefing half of this feature. Lives with the other folder-resolving methods rather than in `openInService`, because it resolves an agent id through the index, not a folder path through the launch guard
- `src/main/ipc/local_agent.ipc.ts` — `local-agent:init-prompt`, registered with the rest of the `local-agent:*` family
- `src/main/shell/env.ts` — `which()` and the resolved `PATH`; see [Shell Environment Resolution](../../development/shell_environment/shell_environment_tech.md)

### Preload
- `src/preload/index.ts` — `window.api.localTools.list()`, `.refresh()`, `.openIn(request)`; `window.api.localAgents.initPrompt(agentId)`

### Renderer
- `src/renderer/src/hooks/useLocalTools.ts` — `useLocalTools()`, `useAvailableTools(kind)`, `useRefreshLocalTools()`, `useOpenIn()`, `useDefaultTool()`, `useSetDefaultTool()`
- `src/renderer/src/hooks/useLocalAgents.ts` — `useCopyAgentInitPrompt()`: fetch and clipboard write in **one** `mutationFn`, so a refused clipboard is a failed mutation rather than a "Copied" over an empty clipboard
- `src/renderer/src/utils/localAgents.ts` — `launchableTools(tools)` (available assistants, then available editors, detection order within each) and `resolveDefaultTool(launchable, settingId)` (`null` for `''` or an id not in the launchable list); pure, tested in `localAgents.test.ts`
- `src/renderer/src/components/agents/local/OpenInMenu.tsx` — the split button and its menu; `OpenInMenu.test.tsx`
- `src/renderer/src/components/agents/local/AgentActionsMenu.tsx` — Reveal and Terminal again, from the ⋯ menu
- `src/renderer/src/components/agents/local/NewLocalAgentModal.tsx` — the "Build it with…" step
- `src/renderer/src/components/settings/LocalAgentsSettingsSection.tsx` — the **Open agents with** select and the auto-open checkbox in the Developer tools card

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
| `local-agent:init-prompt` | invoke | `(agentId) → string` — the briefing for one folder. Throws `LocalAgentError('not_found')`; **not** a `LocalAgentOutcome`, because no renderer branch reads the code |

All three `local-tools:*` handlers call `userActivation.requireActivated()` and are wrapped by `ipcHandle()`; they hold no logic beyond that — validation of the folder and the tool id lives in the service. Registration goes through `registerLocalToolsHandlers()` from `src/main/ipc/index.ts` (enforced by `src/main/ipc/registration.test.ts`).

`local-agent:init-prompt` belongs to this feature by behaviour and to the `local-agent:*` family by registration (`registerLocalAgentHandlers()`), because it takes an **agent id** and resolves the folder from the index — a launch channel takes a path and re-validates it against the roots, and this one must not accept a path at all. It is activation-gated and scoped with `getSettingsScopeUserId()` like its siblings, and is listed again in the channel tables of [Folder Index — Technical Details](folder_index_tech.md) and [Agents Tab — Technical Details](agents_tab_tech.md).

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

### `src/main/services/localAgents/localAgentService.ts`
- `initPrompt(userId, agentId)` — `locate()` for the folder, an `existsSync` on it, `agentRepo.getOwned()` for the display name, the first existing of `AGENT_INIT_ENTRY_FILES`, then `buildAgentInitPrompt`. Reads directory entries and nothing else. Three of its four lines are decisions:
  - **`existsSync(agentDir)` before anything is built.** `locate()` proves the row exists, not the directory. Every launching sibling re-validates the path before acting; without this one an unmounted volume is indistinguishable from a folder with no entry document, and the user copies a confident briefing for a dead path. The refusal is `LocalAgentError('not_found', 'That agent folder is no longer there.')`
  - **The name comes from `agentRepo.getOwned()`, not from `get()`.** `get()` re-walks and re-validates the whole folder — the cost `list()` grew `scanRootCached` to avoid — for one string the row already holds, and the row's copy is the better one: a folder whose manifest is briefly unparseable scans as `unreadableAgent`, whose `name` is the directory basename. `basename(agentDir)` is only the fallback for a missing row
  - **No path guard, because no path arrives.** The launch channels take a folder and re-validate it against the roots; this one takes an id, so the folder can only ever be the one the index holds
- `localAgentService.test.ts` → `describe('initPrompt')` — the entry-document ladder driven by deleting each candidate in turn, the unparseable-manifest name, the missing-directory refusal, an id that is not in the index

## Renderer

- `useLocalTools()` — TanStack Query over `local-tools:list` with `staleTime: Infinity`; the main-process cache makes it cheap after the first call and `useRefreshLocalTools` is the only invalidation
- `useAvailableTools(kind)` — filters to `available && kind === …`; the Settings tools card's list
- `useRefreshLocalTools()` — mutation over `local-tools:refresh`, writing the result straight into the query cache
- `useOpenIn()` — mutation over `local-tools:open-in`. Main re-validates the folder, so a rejection here is expected and must be surfaced, not swallowed
- `useDefaultTool()` — `{tool, launchable, autoOpen}`, memoised over the tools query and the app-settings query. `tool` is `null` when the setting is empty **or** names a tool that is not currently launchable; `autoOpen` is true only when `tool` resolved and `localAgentsAutoOpen` is on. This is where an uninstalled default degrades to "ask"
- `useCopyAgentInitPrompt()` — mutation over `local-agent:init-prompt` **plus** `navigator.clipboard.writeText`, both inside the `mutationFn`. A rejected clipboard write is re-thrown as an app-authored `Error`, never the `DOMException`: it *is* an `Error`, so `unwrapIpcError` would take its message verbatim and show the user Chromium's own words ("Document is not focused." — what a notification stealing focus mid-copy produces)
- `OpenInMenu` owns the copy's presentation, not this hook: `copied` / `copyError` state, a `COPIED_REVERT_MS = 1500` timer cleared on unmount, and a `menuOpen` ref the mutation callbacks read because they resolve after the click that started them and cannot see the `menu.open` their closure captured. Closing the menu clears both `copied` and `copyError`; `onSuccess` returns early when the menu has since closed, `onError` routes to the page's `onError` slot in that case
- `useSetDefaultTool()` — `(toolId | null) => void` over `useSetAppSetting`; `null` writes `''` **and** `localAgentsAutoOpen: false`, since "ask each time" with auto-open armed would re-arm it on the next pick. Called by the Open-in menu and the "Build it with…" step on a pick that differs from the current default, and by the Settings select. Pinned by `src/renderer/src/hooks/useLocalTools.test.tsx`

## Configuration

- `build/entitlements.mac.plist` — `com.apple.security.automation.apple-events` (required for `osascript` to drive Terminal/iTerm under the hardened runtime)
- `electron-builder.yml` — `NSAppleEventsUsageDescription` in `mac.extendInfo`, the string macOS shows in the Automation prompt
- `OSASCRIPT_TIMEOUT_MS` — 15 s, the ceiling on `osascript` and `open`
- `localAgentsDefaultTool` (`app_settings`, default `''`) — the default tool's id, or empty for "ask". Validated on write against `LOCAL_TOOL_IDS` (any known id, runtimes included), resolved on read against the launchable list
- `localAgentsAutoOpen` (`app_settings`, default `false`) — launch the default at a freshly created folder without the "Build it with…" step

## Security

- **Path guard** — absolute, control-character-free, `realpath`d, must be a directory at or under a `realpath`d registered root, separator-boundary matched; the resolved path is what is launched. See the business rules in [Open in Tools](open_in_tools.md)
- **Closed by default** — with no roots provider registered the guard refuses everything, so a gap in wiring fails safe rather than opening the filesystem
- **No path is concatenated into a command line** except in the macOS AppleScript, where it is shell-quoted and then AppleScript-quoted
- **`open -a`, never `shell.openExternal`** for the bundle-launch path — nothing user-influenced is ever parsed as a URL, and both operands stay discrete arguments
- **Refusals log no paths** — root count and path length only, so the log cannot serve as a filesystem oracle
- **Tool ids are an allowlist** — `toolDetectionService.get` returns `undefined` for anything not in `TOOL_SPECS`, and only an absolute path the detector itself found is ever executed. The default-tool setting is held to the same list on write (`isLocalToolId`), so a value that reaches `open-in` from persistence was never an arbitrary string
- **The init prompt takes an id, never a path**, so the folder it names can only be one the index already holds — the rule stated in `src/main/ipc/local_agent.ipc.ts`'s file header. It is also read-only: it opens no process and writes no file, so the launch guard's TOCTOU and quoting concerns do not arise for it at all
- Every IPC channel is behind `requireActivated()`
