# Open in… (Local Agent Tools)

## Purpose

Hand a local agent's folder to the tools the user already has: run **Claude Code**, **Codex** or **OpenCode** in a terminal at the folder, open it as a project in **VS Code** or **Cursor**, reveal it in Finder / Explorer, or just open a terminal there. Only tools actually installed on the machine are offered.

There are two ways of handing it over, and they have different reach. The desktop can **launch** only the assistants detection finds and a launcher knows how to start. Everything else — an assistant already running in another window, one that lives in a browser, one nobody has written a launcher for — is reached by **briefing** it instead: **Copy prompt for another tool** puts a short paste-anywhere instruction on the clipboard that names the folder and the file to read first. Launching is bounded by what is installed and detectable; briefing is not, which is why the menu offers it even on a machine where nothing was detected at all.

This is the "develop your agent in your own assistant" half of Local Agents: the desktop creates and runs the folder, and any coding assistant can work on that same folder — launched from here, or simply told where to look.

## Core Concepts

- **Detected Tool** — A tool the desktop knows how to look for, with a stable id (`claude`, `codex`, `opencode`, `code`, `cursor`, `uv`, `git`, `make`, `python3`), a human label, an absolute path, and whether it was found
- **Tool Kind** — How a tool is offered: `cli-assistant` (launched in a terminal at the folder), `editor` (opens the folder as a project), or `runtime` (not launchable — its presence merely gates features, e.g. `uv`, `git`, `make`, `python3`)
- **Tool Source** — Where the executable was found: `path` (on the login-shell `PATH`) or `app-bundle` (a macOS `.app`, used when the CLI shim was never installed)
- **Open-In Action** — What the renderer asks for: `terminal-command`, `editor`, `reveal`, or `terminal`. For a tool the action follows its kind — `editor` for an editor, `terminal-command` for an assistant — and nothing else is ever sent for a tool
- **Default Tool** — The one `cli-assistant` or `editor` the agent page's **Open in** button launches in a single click, remembered in the `localAgentsDefaultTool` setting. Rewritten by the last pick from the Open-in menu or the New-agent flow's "Build it with…" step; set or cleared explicitly in Settings → Local Agents. Resolved against the detected list on every read, so a tool that was uninstalled after being chosen degrades to "ask"
- **Agents Root** — A registered folder that local agent folders live under. Every open-in target must resolve inside one — see [Path guard](#path-guard)
- **Init Prompt** — The paste-anywhere briefing for one agent folder: its absolute path, the agent's name, and the one file to read first. Built in the main process, copied to the clipboard by the menu; nothing is launched and nothing is written
- **Entry Document** — The file the init prompt points an assistant at: the first of `AGENTS.md`, `CLAUDE.md`, `README.md` the folder actually has. With none of them the prompt names `cinna-agent.json` and `Local/<slug>/docs/WORKFLOW_PROMPT.md` instead. A [bare](bare_agents.md) folder has its own two-file order — see the init-prompt rules below

## User Stories / Flows

### Opening an agent folder in a CLI assistant
1. The agent page's header shows **Open in <default tool>** — a split button. Its primary launches the default tool; its chevron opens a menu of every installed assistant, then every installed editor, then Terminal, Reveal folder and **Copy prompt for another tool**. With no usable default the whole button is the menu, labelled "Open in…"
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

### Handing the folder to an assistant the desktop cannot launch
1. User opens the Open-in menu and picks **Copy prompt for another tool**
2. Main builds the briefing for that agent id: the folder path, the agent's display name, and the first entry document the folder actually has. The renderer writes it to the clipboard
3. The menu **stays open** and the item itself becomes the confirmation — it reads "Copied" for about a second and a half, then reverts. Writing a clipboard changes nothing else on screen, so a menu that closed would leave the click looking like it did nothing
4. User pastes it into whatever assistant they are using — a chat window, a browser tab, a session already running elsewhere — and that assistant now knows where the folder is and what to read first
5. A failure (the folder is gone, the browser refused the clipboard) is shown at the bottom of the still-open menu, so the item is right there to retry from

### Building a new agent in a tool
1. The New-agent form creates the folder and then asks **Build it with…**: the same launchable list, the default marked and focused, plus Terminal, Reveal folder and Not now
2. Picking a tool launches it at the new folder and makes it the default. Ticking "Open new agents this way without asking" also sets `localAgentsAutoOpen`
3. With auto-open on and a default that resolves, the step never appears: Create reads "Create and open in <tool>" and the launch happens as the page opens. With the default unset or not installed, the step asks as before
4. The modal closes only on a **successful** launch. A refusal from main — `tool_unavailable`, `automation_denied`, a path-guard code — keeps (or, on the auto-open path, puts) the modal on the "Build it with…" step with the error under the choices, so the folder is never created-and-silently-not-opened
5. The rest of that flow — the name, the optional description, the draft — is [Agents Tab & Agent Page](agents_tab.md)'s

### Refreshing detection after installing a tool
1. User installs, say, Claude Code while the app is running
2. Settings → Local Agents → Developer Tools → **Refresh** (beside the section title) drops the cached `PATH` lookups and re-detects
3. Refresh also re-asks whether the detected `claude` is **logged in**, since somebody who has just installed it is about to log in too. **The Developer Tools table never shows that answer** — it has two columns, Tool and Version — so this is a side effect with no surface, and a deliberate one: the button means "look at this machine again", and fresh detection beside a stale login would be the inconsistency. The answer itself belongs to [The Claude Engine](claude_engine.md), which is also where it is displayed; a login column here was considered and refused, because the agent page already carries the fact and its own poll clears a stale alarm without anyone opening Settings
4. Caveat: adding a *new* `PATH` entry to a shell profile still needs an app restart — see [Shell Environment Resolution](../../development/shell_environment/shell_environment.md)

## Business Rules

### Detection

- Detection runs **once per app lifetime** and is cached, because probing the filesystem on every render of the agent page would be wasteful. `Refresh` is the only invalidation
- **Detection answers whether a tool exists, and nothing about its state.** Whether the `claude` it found is logged in is a different question with a different lifetime — it changes while the app is open — and is asked, cached and surfaced by [The Claude Engine](claude_engine.md) over its own channel. This feature must not grow a second meaning for "detected"
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

### The init prompt

The briefing exists because "Open in…" can only reach what the machine has and a launcher can start. It is the same handover in words, and it is what the menu offers when a launch is not possible at all.

- **It says where to work and what to read, and stops.** The folder path, the agent's name, one file to read first. The folder's own entry document is version-controlled with the agent and stays true as the kit changes; restating the folder layout in the prompt would give an assistant two descriptions that drift apart
- **A bare folder is briefed from `README.md`, then `AGENT.md`** — a different list, in a deliberate order. Those are the only two documents such a folder is known to have, and the README is the one written for whoever develops the agent: what it is, how to run it, what it needs. `AGENT.md` is the agent's own instructions, which read to a builder as a job description rather than as a briefing. This is the same agent-role / builder-role split that keeps `README.md` out of the [assembled system prompt](bare_agents.md#the-prompt-is-agentmd-and-nothing-else-the-folder-contains) — the two features read the same two files in opposite orders, on purpose
- **It names an entry document the folder actually has** — for a kit folder, the first of `AGENTS.md`, `CLAUDE.md`, `README.md`. `AGENTS.md` is the kit's own instructions-for-an-assistant file, `CLAUDE.md` points at it, and `README.md` is what a hand-made folder is likeliest to have. Pointing an assistant at a file that is not there is worse than not pointing at all, so a folder with none of the three gets the manifest (`cinna-agent.json`) and the agent's own workflow prompt (`Local/<slug>/docs/WORKFLOW_PROMPT.md`) instead — together they say what the agent is and what it does when it runs. Both are named agent-folder-relative, as the assistant will see them once it is in the folder
- **It always states the Builder role.** Its closing line opens "You are working *on* this agent, not running it" (before the sentence keeping changes inside the folder), because the folder's own `AGENTS.md` routes on a Builder-vs-Agent role and reads differently under each. The prompt is the "Open in…" menu expressed in words, so it is always the first of the two
- **Built in main, not in the renderer.** Two reasons. The folder comes from the index row for the given agent id, never from a string the renderer sent — the same rule every other path in this feature follows. And main is the only side that can see *which* entry document the folder has
- **The display name comes from the index row, not from a fresh read of the folder.** A fresh read would re-walk and re-validate the whole folder for one string the row already holds, and it would be the worse string: a folder whose manifest is momentarily unparseable — which happens every time an assistant saves it — scans as an unreadable agent whose name is the directory basename, while the row still carries the last good display name
- **The folder is confirmed to exist before anything is built.** Resolving the id proves the *row* exists, not the directory. Without that check an unmounted volume or a folder moved between rescans reads exactly like a hand-made folder with no entry document, and the user would copy a confident briefing for a dead path
- **Nothing is launched and nothing is written.** This is the one item in the menu that only reads directory entries, and the one that never becomes the default tool — like Terminal and Reveal, it is an action, not a tool

### Copying is the only action here that does not close the menu

Every other item in the menu produces something visible: a terminal, an editor window, a file manager. A clipboard write produces nothing, so the ordinary "act and dismiss" would make the click silent.

- **The item is the confirmation.** It flips to "Copied" for about a second and a half — the same dwell as the app's other copy buttons — then reverts, and reads "Copying…" in flight. All three states occupy the row the item already has, so the menu never changes height (UX rule 1). Dimming it unchanged would have read as *unavailable* rather than *working*
- **The confirmation is a clipboard icon, not the check mark.** Inside this menu an accent check already means "this is your default tool"; the two would otherwise stand at either end of the same list meaning different things (rule 8)
- **A failure is shown inside the menu**, in a ruled-off prose tail below every control and above the "no assistant found" note — the reason for the click that just failed must not sit under advice about something else. It cannot use the page's error slot the way the launchers do, because that slot is under the header, which this menu covers. Putting it after the controls means it appears without pushing anything the user is about to click (rules 1 and 6), and the item is still there to retry from
- **Both answers ask where the user is by the time they arrive.** A confirmation that lands after the menu has closed is **dropped** — it would otherwise re-arm on the next opening and describe a click from a session the user has left. A failure is **never** dropped: it goes to the page's error slot instead, which is not covered once the menu is gone, because the clipboard still holds whatever it held before and the user believes otherwise
- **A refused clipboard is a failure, not a silent success.** The prompt is fetched and written inside one operation, so a browser that refuses the write (a notification stealing focus mid-copy is enough) reports as failed rather than saying "Copied" over an empty clipboard. The refusal is reported in the app's own words — Chromium's "Document is not focused." explains nothing to the user

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

Every *launch* failure is a typed, user-facing code: `invalid_folder`, `forbidden_path`, `no_roots`, `tool_unavailable`, `unsupported_action`, `no_terminal`, `automation_denied`, `launch_failed`.

The init prompt is the exception, and deliberately so: it throws a local-agent `not_found` rather than returning an outcome object, because the renderer only prints its message and never branches on the code — the same treatment `:validate`, `:rescan` and `:read-doc` get. See [the outcome convention](agents_tab_tech.md#why-the-outcome-is-unwrapped-in-the-renderer).

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
       -> local-tools:list | local-tools:refresh | local-tools:open-in | local-tools:claude-auth
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

Agent page (Open-in menu -> "Copy prompt for another tool")
  -> useCopyAgentInitPrompt                        (window.api.localAgents.*)
       -> local-agent:init-prompt (agentId)
            -> localAgentService.initPrompt
                 -> locate(agentId) -> folder from the index row
                 -> folder still on disk?
                 -> first existing of AGENTS.md / CLAUDE.md / README.md
                    (bare folder: README.md, then AGENT.md)
                 -> buildAgentInitPrompt (shared wording)
       <- prompt string -> navigator.clipboard.writeText -> "Copied"
```

## Integration Points

- [Shell Environment Resolution](../../development/shell_environment/shell_environment.md) — every binary lookup, and the `PATH` all of this depends on
- [Resource Activation](../../core/resource_activation/resource_activation.md) — every channel here requires an activated user session: the four `local-tools:*` ones and `local-agent:init-prompt`
- [Agents Home, Scanner & Folder Index](folder_index.md) — the index row the init prompt takes its folder and its display name from, and the `local-agent:*` channel family it is registered with
- [Release & Distribution](../../development/distribution/release.md) — the macOS entitlement and usage description ship with the signed, notarised build
- [Logger](../../development/logger/logger.md) — the `local-tools` and `open-in` scopes carry the diagnostics above
- [UX Rules](../../development/ui_guidelines/ux_rules.md) — the rules the split button, the "Build it with…" step and their error reporting follow: remember the last choice with an explicit override and opt-in auto-use, errors close nothing and move nothing
- [Agents Tab & Agent Page](agents_tab.md) — the page that hosts the button and owns the alert slot it reports into
- [Bare Agents & External Roots](bare_agents.md) — an adopted folder is a registered root like any other, so it is an allowed area for this guard; and its init prompt reads the two files in the other order
