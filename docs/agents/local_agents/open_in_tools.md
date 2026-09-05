# Open in… (Local Agent Tools)

## Purpose

Hand a local agent's folder to the tools the user already has: run **Claude Code**, **Codex** or **OpenCode** in a terminal at the folder, open it as a project in **VS Code** or **Cursor**, reveal it in Finder / Explorer, or just open a terminal there. Only tools actually installed on the machine are offered.

This is the "develop your agent in your own assistant" half of Local Agents: the desktop creates and runs the folder, and any coding assistant can open the same folder and work on it.

## Core Concepts

- **Detected Tool** — A tool the desktop knows how to look for, with a stable id (`claude`, `codex`, `opencode`, `code`, `cursor`, `uv`, `git`, `make`, `python3`), a human label, an absolute path, and whether it was found
- **Tool Kind** — How a tool is offered: `cli-assistant` (launched in a terminal at the folder), `editor` (opens the folder as a project), or `runtime` (not launchable — its presence merely gates features, e.g. `uv`, `git`, `make`, `python3`)
- **Tool Source** — Where the executable was found: `path` (on the login-shell `PATH`) or `app-bundle` (a macOS `.app`, used when the CLI shim was never installed)
- **Open-In Action** — What the renderer asks for: `terminal-command`, `editor`, `reveal`, or `terminal`. For a tool the action follows its kind — `editor` for an editor, `terminal-command` for an assistant — and nothing else is ever sent for a tool
- **Default Tool** — The one `cli-assistant` or `editor` the agent page's **Open in** button launches in a single click, remembered in the `localAgentsDefaultTool` setting. Rewritten by the last pick from the Open-in menu or the New-agent flow's "Build it with…" step; set or cleared explicitly in Settings → Local Agents. Resolved against the detected list on every read, so a tool that was uninstalled after being chosen degrades to "ask"
- **Agents Root** — A registered folder that local agent folders live under. Every open-in target must resolve inside one — see [Path guard](#path-guard)

## User Stories / Flows

### Opening an agent folder in a CLI assistant
1. The agent page's header shows **Open in <default tool>** — a split button. Its primary launches the default tool; its chevron opens a menu of every installed assistant, then every installed editor, then Terminal and Reveal folder. With no usable default the whole button is the menu, labelled "Open in…"
2. User clicks the primary, or picks an assistant from the menu; the renderer sends the folder path, the tool id and the `terminal-command` action to the main process. A menu pick that differs from the current default **becomes** the default
3. Main validates the folder against the registered agents roots and confirms the tool is installed
4. A system terminal opens at the folder with the assistant already running: iTerm2 if it is installed, otherwise Terminal.app on macOS; Windows Terminal, else `cmd.exe`, on Windows; the first of `x-terminal-emulator`, `gnome-terminal`, `konsole`, `xterm` found on Linux

### Opening the folder in an editor
1. User picks VS Code or Cursor from the Open-in menu (or clicks the primary, when an editor is the default); the action sent is `editor`
2. If the CLI shim is on `PATH`, it is launched with the folder as its single argument
3. If only the macOS application bundle was found, LaunchServices is asked to open the folder with that bundle instead

### Revealing the folder / opening a bare terminal
- **Reveal** hands the resolved folder to the OS file manager
- **Terminal** opens the same terminal window as above, running nothing
- Both are offered from the Open-in menu and again from the page's ⋯ menu; neither ever becomes the default tool

### Building a new agent in a tool
1. The New-agent form creates the folder and then asks **Build it with…**: the same launchable list, the default marked and focused, plus Terminal, Reveal folder and Not now
2. Picking a tool launches it at the new folder and makes it the default. Ticking "Open new agents this way without asking" also sets `localAgentsAutoOpen`
3. With auto-open on and a default that resolves, the step never appears: Create reads "Create and open in <tool>" and the launch happens as the page opens. With the default unset or not installed, the step asks as before
4. The modal closes only on a **successful** launch. A refusal from main — `tool_unavailable`, `automation_denied`, a path-guard code — keeps (or, on the auto-open path, puts) the modal on the "Build it with…" step with the error under the choices, so the folder is never created-and-silently-not-opened
5. The rest of that flow — the name, the optional description, the draft — is [Agents Tab & Agent Page](agents_tab.md)'s

### Refreshing detection after installing a tool
1. User installs, say, Claude Code while the app is running
2. Settings → Local Agents → **Refresh** drops the cached `PATH` lookups and re-detects
3. Caveat: adding a *new* `PATH` entry to a shell profile still needs an app restart — see [Shell Environment Resolution](../../development/shell_environment/shell_environment.md)

## Business Rules

### Detection

- Detection runs **once per app lifetime** and is cached, because probing the filesystem on every render of the agent page would be wasteful. `Refresh` is the only invalidation
- Every binary is looked up on the **login-shell `PATH`**, not the app's own — a GUI-launched app on macOS otherwise cannot see Homebrew, mise, nvm, cargo or `~/.local/bin`
- On macOS, editors additionally fall back to their application bundle in `/Applications` and `~/Applications`. Many people drag VS Code or Cursor across and never run "Install 'code' command in PATH", so PATH-only detection would report an editor they can see in their Dock as missing
- A detection failure never poisons the cache: every tool is reported unavailable and the next call retries
- Only `available` tools of the right kind are ever offered in the UI

### One default tool, rewritten by the last pick

Most people build every agent with the same assistant. The button's primary action is that assistant, and the menu behind the chevron is for the exception.

- **A pick is a statement of the default.** Choosing a tool from the Open-in menu or from "Build it with…" rewrites `localAgentsDefaultTool` — the setting exists so the button says the right thing next time, and the pick is the clearest statement of what "right" is. Nobody should have to go to Settings to say so; Settings → Local Agents → **Open agents with** is there to set or clear it explicitly ("Ask each time")
- **Only a launchable kind can be the default.** Assistants and editors are launchable; a `runtime` tool (`uv`, `git`, `make`, `python3`) is detected for feature gating and never launched. Terminal and Reveal are actions, not tools, and never become the default
- **The setting is validated against the known ids, not against what is installed.** A tool can be uninstalled after being chosen, or the setting can predate this machine's `PATH`. The renderer resolves the id against the detected list on every read and falls back to "ask" — a button that fails after the click would be worse than a menu. The value check accepts any id in the tool table, runtimes included; the kind restriction is applied by that resolve, which only searches launchable tools, and again in main, where `requireTool` refuses a `runtime` for either open-in action — so a `git` written into the setting by hand degrades to "ask" and could not launch even if it reached the channel. An arbitrary string, though, is refused at the write — that string is exactly what `local-tools:open-in` would otherwise be asked to launch
- **Auto-open is subordinate to the default.** `localAgentsAutoOpen` means nothing without a resolved default: the Settings checkbox is disabled until one resolves, and the New-agent flow asks as before when the default is unset or missing. **Clearing the default also turns auto-open off.** "Ask each time" and "open automatically" contradict each other, and a cleared default that left auto-open armed would silently re-arm it the next time any tool was picked from the page menu — so `useSetDefaultTool(null)` writes both settings
- **A refusal moves nothing.** The Open-in button and the ⋯ menu report into one alert slot the agent page owns; the New-agent dialog's error line is a fixed-height slot on both steps. See [UX Rules](../../development/ui_guidelines/ux_rules.md)

### Path guard

Every open-in request re-validates its folder in the main process. A renderer compromised by XSS must not be able to hand over `~/.ssh` and get a terminal opened in it.

- The path must be a **string, absolute, at most 4096 characters, and free of control characters** (NUL, newlines, DEL — characters no legitimate folder path has and every launcher would have to escape)
- The path is resolved with **`realpath`** and must be a **directory**
- The **registered agents roots are `realpath`d too** — a root reached through a symlink (a `~/Documents` redirected to iCloud Drive) would otherwise never match. A root that no longer exists simply allows nothing
- The resolved path must be **at or under** one of the resolved roots, matched on a **separator boundary** — so `…/CinnaAgentsEvil` cannot match the root `…/CinnaAgents`. Comparison is case-insensitive on macOS and Windows, whose default filesystems are
- The **resolved** path is what gets launched, never the original string — validating one path and launching another would be a TOCTOU gap through a symlink
- **The guard is closed by default.** The roots provider starts empty, and until the Local Agents slice registers the real one (it does so once, at IPC registration, from the agents-home roots) **every open-in request is refused with `no_roots`**. That ordering is deliberate: nothing may open a folder before the roots are known, and a gap in the wiring fails safe rather than opening the filesystem. If open-in refuses everything with `no_roots`, either that registration has not run or the user has no agents root yet
- A refusal logs the root count and the path *length*, never the path — a hostile renderer must not be able to use the log as a filesystem-layout oracle

### Command construction

- **A path is never concatenated into a command line.** Linux and Windows launchers get the folder as the child's `cwd` or as its own argv element, so no quoting is involved at all
- macOS is the one exception: AppleScript's `do script` has no working-directory argument, so the folder must be embedded in a `cd`. There it is escaped **twice** — once for the POSIX shell running inside the terminal, then once for the AppleScript string literal carrying it
- The terminal command joins the `cd` and the tool with `&&`, not `;`, so a `cd` that fails (folder removed between validation and launch) cannot run the tool somewhere unexpected
- Terminal children are **detached** — quitting Cinna never takes the user's terminal window with it
- On Linux the launched command is followed by a login shell so the window stays open after the assistant exits and its final output stays readable

### Errors

Every failure is a typed, user-facing code: `invalid_folder`, `forbidden_path`, `no_roots`, `tool_unavailable`, `unsupported_action`, `no_terminal`, `automation_denied`, `launch_failed`.

### macOS automation (Apple Events)

- Driving Terminal or iTerm goes through `osascript`, which sends an **Apple Event** — governed by macOS's TCC automation permission (System Settings → Privacy & Security → Automation)
- The packaged app therefore ships the `com.apple.security.automation.apple-events` entitlement and an `NSAppleEventsUsageDescription`. Without them a hardened-runtime build is **refused outright with error `-1743`** rather than prompting the user
- `-1743` (and "Not authorized to send Apple events") is recognised specifically and surfaced as `automation_denied`, whose message points the user at the Automation pane. As a generic launch failure it would be a dead end
- **This path is untested.** It can only be confirmed by a signed, notarised build on a machine that has never granted Cinna automation access — a dev session inherits the terminal's own grants and passes either way

## Architecture Overview

```
Agent page (Open-in split button + ⋯ menu) · New-agent "Build it with…" · Settings (Open agents with)
  -> useLocalTools / useDefaultTool / useOpenIn   (window.api.localTools.*)
       |   useSetDefaultTool -> app-settings: localAgentsDefaultTool (allowlisted), localAgentsAutoOpen
       -> local-tools:list | local-tools:refresh | local-tools:open-in
            -> toolDetectionService  -> which() over the login-shell PATH
                                     -> macOS .app bundle fallback (editors)
            -> openInService
                 -> path guard: absolute -> realpath -> directory -> within roots
                 -> requireTool: installed, and of the right kind
                 -> launcher:
                      macOS    osascript (Terminal / iTerm)  |  open -a <bundle>
                      Windows  wt.exe -d <folder>            |  cmd.exe with cwd
                      Linux    <emulator> with cwd
                      reveal   OS file manager
```

## Integration Points

- [Shell Environment Resolution](../../development/shell_environment/shell_environment.md) — every binary lookup, and the `PATH` all of this depends on
- [Resource Activation](../../core/resource_activation/resource_activation.md) — all three IPC channels require an activated user session
- [Release & Distribution](../../development/distribution/release.md) — the macOS entitlement and usage description ship with the signed, notarised build
- [Logger](../../development/logger/logger.md) — the `local-tools` and `open-in` scopes carry the diagnostics above
- [UX Rules](../../development/ui_guidelines/ux_rules.md) — the rules the split button, the "Build it with…" step and their error reporting follow: remember the last choice with an explicit override and opt-in auto-use, errors close nothing and move nothing
- [Agents Tab & Agent Page](agents_tab.md) — the page that hosts the button and owns the alert slot it reports into
