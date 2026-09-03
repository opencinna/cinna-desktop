# Shell Environment Resolution

## Purpose

Recover the user's **login-shell environment** — above all its `PATH` — inside a GUI-launched Electron app, and be the single place every main-process child spawn draws its environment from. Without it the app cannot see anything the user installed through Homebrew, mise, nvm, pyenv, cargo or `~/.local/bin`, even though those tools are plainly installed.

This is general infrastructure, not agent-specific. Installed-tool detection, the "Open in…" launchers and the stdio MCP spawn all sit on top of it, and **future spawn sites must use it rather than reaching for `process.env`**.

## Core Concepts

- **Login-shell environment** — What the user's shell produces after sourcing its profile (`.zshrc`, `.bashrc`, `.zprofile`, version-manager hooks). A macOS app started from the Dock is launched by `launchd` and inherits none of it: a bare `PATH` of `/usr/bin:/bin:/usr/sbin:/sbin`, plus `HOME`, `USER`, `SHELL` and `XPC_*`. This is why a command works in Terminal but "cannot be found" by the app
- **Resolved environment** — The parsed shell dump merged **over** `process.env`, so Electron's own variables survive and the shell's values win where both define a key. Resolved at most once per app lifetime
- **Executable lookup** (`which`) — Resolving a bare binary name against the resolved `PATH` by walking its directories directly, with per-binary caching of both hits and misses
- **Child inherit set** — The narrowed environment a *third-party* child process is given. Deliberately much smaller than the resolved environment (see [Child-Process Environment Rule](#child-process-environment-rule))
- **Regression-only variables** — Proxy and CA variables inherited from `process.env` **only**, never from the shell dump, so the app never grants a capability the platform did not already grant
- **Dropped-names diagnostic** — A debug log line naming (never valuing) the variables the narrowing removed, so a "my server stopped working" report is diagnosable

## User Stories / Flows

### The app needs a tool the user installed
1. Something asks for a tool (tool detection, a launcher, a future engine spawn)
2. The resolver spawns the user's login shell once, asks it for its environment, parses the dump
3. The binary name is walked against the resolved `PATH`; the absolute path (or a definitive miss) is cached
4. The user sees `claude`, `uv`, `opencode` … detected exactly as their terminal sees them

### The user installs a tool while the app is running
1. User installs, say, Claude Code, then hits **Refresh** (Settings → Local Agents)
2. The executable-lookup cache is dropped and every tool is probed again
3. **The resolved environment itself is not re-resolved.** An install into a directory already on `PATH` (the normal Homebrew / npm / cargo case) is picked up by re-walking alone; editing the shell profile to add a *new* `PATH` entry still needs an app restart

### A stdio MCP server connects
1. The manager asks the resolver for the login-shell environment
2. That environment is narrowed to the child inherit set, then the server's own `env` map is merged on top
3. The narrowed-away variable names are logged once at debug
4. The server process starts with a `PATH` that reflects the user's shell — so `npx`, `uvx` and friends resolve — but not with the user's shell secrets

## Business Rules

### Resolution

- Runs **at most once per app lifetime**. Concurrent callers share one in-flight resolution
- **Never throws.** A failed, timed-out or unparseable probe logs a warning and hands back `process.env` unchanged, so a wedged shell profile can degrade the app but cannot break it
- **Windows short-circuits.** A Windows process already inherits the full user environment from Explorer, so `process.env` is returned as-is and no shell is spawned
- An **interactive** login shell (`-ilc`) is tried first, because a great deal of real-world `PATH` setup lives in `.zshrc` / `.bashrc` rather than the login files; a non-interactive login shell (`-lc`) is the fallback for shells that misbehave without a tty
- The login shell comes from `SHELL` when it is an absolute path, else `/bin/zsh` on macOS and `/bin/bash` elsewhere
- The probe prints a **sentinel line** before dumping the environment; everything before it (motd banners, `nvm` warnings, version-manager chatter) is discarded, so shell noise can never be parsed as a variable
- The dump is **NUL-separated** (`env -0`), so a value containing newlines — a multi-line `LS_COLORS`, a pasted key — cannot be misread as the start of the next variable
- Hard limits: a 5-second timeout (the child is `SIGKILL`ed), a 2 MB output cap, and no stdin (an interactive shell blocking on a read would otherwise stall until the timeout)
- Auto-update and compfix hooks are disabled for the probe so a profile framework does not do network work on the app's behalf
- The resolved environment is **merged over `process.env`** — shell values win, Electron's own variables survive
- **The environment is never logged.** Only the `PATH` entry count and the shell/mode are recorded; the dump carries API keys and tokens

### Executable lookup

- Only **bare binary names** are resolvable — anything with a path separator or a `..` segment is refused outright, since every caller looks up names from a fixed list
- PATH directories are walked and probed directly rather than shelling out to `which`/`where` per lookup: one spawn per tool would be a visible cost on a cold start, and spawning also means quoting a name into a command line for no gain
- **Empty `PATH` entries are dropped.** POSIX reads an empty entry as "the current directory"; honouring that would let the app's cwd hijack a tool resolution
- Duplicate entries are collapsed; on Windows entries are additionally de-quoted
- On POSIX a candidate must be a regular file with the executable bit set; on Windows existence is the test, and each directory yields the bare name plus one candidate per `PATHEXT` extension (defaulting to `.COM;.EXE;.BAT;.CMD`) unless the name already carries one
- Results are cached **including misses**, so a missing tool is not re-walked on every render

### Child-Process Environment Rule

This is the rule the rest of this document exists for. It governs what a *third-party* binary spawned by the app can read.

**One rule, no per-caller asymmetry: the MCP SDK's inherit-allowlist, valued from the login-shell environment rather than the app's launchd environment, plus three named additions, with the caller's own `env` map merged on top — the caller's map always wins.**

- **Why not the whole shell environment.** `getShellEnv()` exists precisely to source `.zshrc` / `.bashrc`, which is exactly where `ANTHROPIC_API_KEY`, `GITHUB_TOKEN` and `AWS_SECRET_ACCESS_KEY` live. Passing that wholesale to a third-party child would be a material widening of every one of those secrets' blast radius. The resolver's job is a better `PATH`, not a bigger environment
- **The allowlist is imported from the SDK, not copied**, so it cannot drift. On POSIX it is exactly `HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `USER`

The three additions are **separate constants because each has a different justification** — a future contributor extending one of them must not assume the others' reasoning applies:

1. **`PATHEXT` (win32 only)** — a *deliberate addition, not SDK parity*. The SDK's Windows list omits it, but without it a child cannot resolve the `.cmd` shims `npm` and `uv` install — the very resolution failure this module exists to fix
2. **Session variables** — `SSH_AUTH_SOCK`, `DISPLAY`, `WAYLAND_DISPLAY`, `XAUTHORITY`, `DBUS_SESSION_BUS_ADDRESS`, `TMPDIR`. The admission test is *"does its absence break something that works today?"*. `launchd` (and the Linux session manager) put these in the app's own environment, so a server declaring an `env` map receives them right now; narrowing to the SDK's six keys alone would take them away — a real regression, not a hypothetical one. **`SSH_AUTH_SOCK` is the sharp case**: a git-over-SSH server would silently lose agent auth on private repos. None of these carries a credential itself — `SSH_AUTH_SOCK` is a socket path already governed by filesystem permissions, and a child that can reach the agent could equally have run `ssh` itself
3. **Regression-only proxy / CA variables** — `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `ALL_PROXY` (and their lowercase forms) plus `NODE_EXTRA_CA_CERTS`, sourced from **`process.env`, never from the shell dump**. These carry real risk: a proxy URL routinely embeds credentials (`http://user:pass@proxy:8080`), and `NODE_EXTRA_CA_CERTS` changes TLS trust for a third-party child. Inheriting them only where the GUI process *already had them* makes this a regression fix rather than a new capability — Windows inherits the full user environment from Explorer (where corporate IT and MDM push exactly these) and Linux gets `/etc/environment` from the display manager, so on both a server receives them today. On macOS they reach a process only as a shell export, so reading them from `process.env` means **a `.zshrc` export cannot introduce them**; that user puts them in the server's own `env` map, explicitly. Where a variable exists in both sources, `process.env` wins — a shell profile can never overwrite the trusted value

Deliberately **excluded**, and not to be added:

- `NODE_PATH` and `npm_config_*` — shell exports on every platform, so omitting them regresses nothing, and they redirect where a child resolves its code

Two further rules:

- **The `()`-prefix value filter.** Any value starting with `()` is dropped. That is bash's `BASH_FUNC_name%%=() { … }` encoding of an exported shell function — the Shellshock (CVE-2014-6271) surface. The filter matters *more* here than in the SDK: the SDK reads `process.env`, where a GUI app almost never has exported functions, whereas this code dumps an interactive login shell, which will contain them if the user's profile `export -f`s anything. It is also load-bearing on its own: while the allowlist held only the SDK's six keys, every `()`-valued name was also a non-allowlisted one and the key check alone would have caught it — but with `SSH_AUTH_SOCK` and the session group allowlisted, a `()`-valued `SSH_AUTH_SOCK` passes the key check and *only* this filter stops it. Reproducing the SDK's filter, and not merely its key list, is what makes that safe
- **The escape hatch is the caller's own `env` map.** Anything outside the inherited set is opted into per variable, per server — a discoverable, explicit, per-consumer grant rather than a global toggle
- **The dropped-names debug log.** Because this rule *narrows* what a child can read, somewhere a consumer will lose a variable it silently relied on, and the failure will not look like it came from here. One line per spawn names what disappeared. **Names only, never values** — the dropped set is by definition the secret-bearing half of the environment, so logging a value would recreate the very leak the rule prevents, in the log buffer instead of the child process

## Architecture Overview

```
Caller (tool detection / launcher / MCP stdio spawn)
  -> getShellEnv()
       -> once per app lifetime, non-win32:
            spawn $SHELL -ilc "echo <sentinel>; env -0"   (fallback: -lc)
            parse after sentinel  ->  merge over process.env
       -> on failure / win32: process.env
  -> which(bin)          -> walk resolved PATH  -> cached absolute path | null
  -> shellEnvForChild()  -> SDK allowlist + session vars + PATHEXT(win32)
                            + proxy/CA vars taken from process.env
                            - values starting with "()"
  -> mergeEnv(narrowed, callerEnv)   // caller's map wins
  -> droppedChildEnvNames(...)       // debug log, names only
```

## Integration Points

- [MCP Connections](../../mcp/connections/connections.md) — the stdio transport spawn is the first consumer and the one whose behaviour changed; see its **Stdio environment** rules for the user-visible consequence
- [Open in Tools](../../agents/local_agents/open_in_tools.md) — installed-tool detection and the terminal/editor launchers resolve every binary through `which`
- [Setup](../setup/setup.md) — general dev environment and gotchas
- [Logger](../logger/logger.md) — the `shell-env`, `local-tools` and `open-in` scopes carry the diagnostics described here
