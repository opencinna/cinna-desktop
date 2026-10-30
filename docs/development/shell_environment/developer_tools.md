# Developer Tools on a Bare Machine

## Purpose

Keep the app — and every engine, custom agent and MCP server it starts — working on a machine that has no developer tools: a Mac without Apple's Command Line Tools or Xcode, or a Linux without a `git` package. Two things go wrong there, and this aspect of [Shell Environment Resolution](shell_environment.md) handles both: on macOS, running a tool pops a system dialog instead of running anything; everywhere, the engines and the handover checks have no `git` to run.

## Core Concepts

- **Developer-tool stub** — On a Mac without the Command Line Tools, `/usr/bin/git`, `make`, `python3`, `clang` and about seventy other names are one small `xcrun` shim, hard-linked under each name. When the tools are absent, running any of them pops the system "install the command line developer tools" dialog, **every time**, and does nothing else. They are executable files on `PATH`, so a plain lookup reports them as installed
- **Tools state** — `installed`, `absent` or `unknown`, from `xcode-select -p`: the one probe that is not itself a stub and never pops the dialog. `unknown` means the probe itself failed (timed out, would not spawn). Always `installed` off macOS
- **Usable tool** — A lookup that treats a stub whose tools are absent as not there: the next match along `PATH` that is not a stub (a Homebrew git listed after `/usr/bin`), else — for `git` only — the managed git, else nothing
- **Tool shims** — `<userData>/tool-shims/`, one tiny script per name whose lookup lands on a stub, prepended to a child's `PATH` so nothing the child runs can reach the stub. Each says the tool is not available and exits 127, which the engines already treat as "command not found"
- **Managed git** — GitHub Desktop's relocatable git (`desktop/dugite-native`), pinned in [Runtime Pins](../runtime_pins/runtime_pins_llm.md) and downloaded in the background only when the machine has no usable git of its own. Run through a wrapper script, `<userData>/git-shim/git`, never by path

## User Stories / Flows

### A fresh Mac, nothing installed
1. The user opens a Codex or Claude folder agent and sends a message
2. The engine child starts with `tool-shims/` first on its `PATH`, so its `git` at session start reaches the stand-in, not `/usr/bin/git`: no dialog
3. Seeing no usable git, the app starts downloading the managed git in the background. Nothing waits for it; no UI reports it
4. Once it lands, the next child starts with `git-shim/` ahead of `tool-shims/`, and a child already running reaches the managed git through the `git` stand-in, which looks for it on every call
5. Tool detection (Settings → Default → Local Development → Developer Tools) lists `git` and `python3` as not installed rather than probing their versions, which would pop the dialog

### The user installs the Command Line Tools while the app runs
1. The user runs `xcode-select --install`
2. Within a minute (the tools-state answer is cached for 60 s), or at once after **Refresh** in Developer Tools, the tools read as installed
3. No shim is prepended any more. `PATH` changes, so every engine's launch key changes, and each running engine child is replaced on its next turn — now running the real git. The managed git is ignored, not deleted

### A Linux without git
1. No `git` on `PATH`: there are no stubs to shim, but the managed git is downloaded in the background the same way
2. Once installed, `git-shim/` is prepended to the engine, custom agent and MCP child `PATH`

## Business Rules

### Never execute a stub
- **Every caller about to execute a looked-up tool uses the usable-tool lookup, not `which()`.** Tool detection, the agent-folder git view and the handover git checks all do. `which()` keeps plain `PATH` semantics because the terminal and "Open in…" launch the user's own tools, and a stub there is the user's business
- **The handover check does not spawn a stub at all.** With no usable git it falls back as it does for a missing git — the static check for the handovers directory, `unknown` for a credential path — rather than popping a dialog per check
- **Only `/usr/bin` names on the fixed list are stubs, and only on macOS.** A Homebrew `git` is never one. The list is the 78 hard links of the `xcrun` shim on a real macOS 15 `/usr/bin`
- **An `unknown` tools state reads as absent for shimming, but never triggers a download.** Shimming a working git costs an agent a git; a wrong "installed" costs the user the dialog. Downloading 60 MB onto a machine that may well have a git is the one step that needs a real answer
- **A failed probe is never cached as an answer.** The last real answer stands for another minute, so a hanging `xcode-select` costs one five-second timeout a minute, not one per caller

### The shims
- **Engine, custom-agent and stdio MCP children only — never `getShellEnv()`**, which the user's own terminal reads too
- **Applied last, to the environment that feeds the launch key**, so installing the tools or the managed git landing changes `PATH`, changes the key, and replaces the running child on its next turn. OpenCode's key now includes the inherited `PATH` for exactly this reason. A development agent's replaced `PATH` gets the shims put back in front
- **On an MCP server the shims go on the base environment**, before the server's own `env` map is merged, so a `PATH` the user set for that server still wins
- **Only names whose lookup lands on a stub are shimmed**, and a shim left over for a tool the user has since installed through Homebrew is deleted on the next write, so it cannot shadow it
- **The `git` stand-in's content never changes.** It runs the first real `git` further along the caller's `PATH` (skipping Cinna's own directories and `/usr/bin`), else the managed git's wrapper when it exists, else says git is not available and exits 127. So a long-lived child — an MCP server started before the managed git landed, whose `PATH` has `tool-shims/` but not `git-shim/` — still reaches whichever git exists now, and never the stub
- **Never throws.** A shim directory that cannot be written costs the user the dialog, not the turn
- **The managed uv is appended last, by the same entry point.** `withDeveloperToolShims` finishes by adding the directory of Cinna's own uv to the end of `PATH` (see [The managed uv](#the-managed-uv)). Because the shims prepend and the uv appends, the order is always shims, then the user's `PATH`, then the managed uv, and "does any uv resolve?" is judged on the `PATH` the child will actually get

### The managed git
- **Any real git wins.** Command Line Tools, Xcode, Homebrew, a distro package: the managed git is used only when none is usable, and is left on disk, unused, once one appears
- **macOS and Linux only.** The wrapper is a POSIX shell script, and Windows git ships as its own installer; there is no Windows pin
- **Why a wrapper, and why its own directory.** The tree runs from anywhere only with the environment dugite sets (`GIT_EXEC_PATH`, `GIT_TEMPLATE_DIR`, `GIT_CONFIG_SYSTEM`, and on Linux `PREFIX` and `GIT_SSL_CAINFO`): without them https fails and every `init` warns. Put into a child's environment, they would break a git the user installs later. So they live in the wrapper, which leaves a user's own `GIT_CONFIG_SYSTEM` and `GIT_SSL_CAINFO` alone. The wrapper sits in `git-shim/` rather than in `tool-shims/` because the launch key digests `PATH`: rewriting the stand-in's content would leave `PATH` — and every running session's key — unchanged
- **Nothing waits for it.** At most one install per app run; after a failure, no retry until the next start, and only a log warning
- **Nothing unverified is published.** The same staged, digest-checked, atomically renamed install the engines use (see [The Local Engine](../../agents/local_agents/engine.md#binary-resolution-and-what-verified-means)); the unpacked `bin/git` must also answer `git --version` with exactly the pin, run from staging with the wrapper's environment
- **A tree that verifies but will not run here is never downloaded again.** It would fail the same way on every start, so it leaves a marker, `<userData>/runtimes/.git-<version>-unsupported`; a new pin has a new marker name. A network or checksum failure leaves none
- **Swept like an engine runtime.** It installs into the same `runtimes/` root, and a fresh install removes superseded `git-<version>` directories not used for a week; the wrapper re-stamps its tree as used at most hourly
- **`CINNA_GIT_DOWNLOAD=off` turns the download off**, which the E2E fixture does on every launch

### The managed uv
- **Why.** A kit agent's commands are `uv run …`, and a fresh Mac has no uv. Cinna already downloads a pinned, checksummed uv for MCP servers and Local Development; the same copy is the last place a local-agent child looks. Without it, the first `/run:status` on a bare machine failed with "exited with code 127"
- **Appended, never prepended.** A uv the user installed always wins; Homebrew or a distro package installed later takes over with no setting. The directory is added whether or not the download has landed, so a long-lived engine process finds uv the moment the install finishes
- **Reaches every local-agent child:** the engine children and the other hosts of the shims (custom agents, stdio MCP servers), and also `/run:` commands, schedules and clickable chat scripts, which do not go through the shims and apply the same append themselves
- **No `UV_*` directory variables.** uv uses its default cache and Python directories, the ones a later user-installed uv shares, so nothing is downloaded twice and the toolchain's own tools directory (the Cinna CLI) stays invisible to agent code
- **One exception: `UV_PYTHON_PREFERENCE=only-managed`, only when no other uv resolves and the environment does not already set it.** On a Mac without the Command Line Tools, uv probing `/usr/bin/python3` pops the install dialog. A user with their own uv keeps their own preference
- **Pre-warm.** When an agent is scaffolded, and once at profile-ready when this computer has a local agent, Cinna installs the managed uv and runs `uv python install` with the same environment a run gets, so the interpreter lands where runs look. Nothing waits for it and a scaffold never fails on it. One install at a time; a failure is remembered, never thrown, and a `uv …` command that cannot start starts another, so "run it again" is true. Child installs are killed when the app quits. `CINNA_UV_PREWARM=off` turns it off, which the E2E fixture does on every launch; the bare-Mac suite leaves it on
- **When uv still cannot start,** a `/run:` command, a scheduled command and a Run Script window say so in one sentence instead of an exit code, chosen by what the pre-warm recorded: Cinna could not download its copy (with the reason, check the network), Cinna has no uv build for this platform (install uv), or Cinna is still installing it (try again in a moment). A scheduled run ends as an execution error, so no inspect task is opened for a failure no agent could fix. Exit 127 alone is not taken as proof, because `uv run` passes its script's exit code through: it counts only when the shell said `uv` was not found, or no uv resolves on the child's `PATH`. The same failure starts a new pre-warm, so "run it again" holds — unless one is installing, the platform has no uv build, or the last install failed under five minutes ago, so a once-a-minute schedule while offline does not download uv every minute. A quit during the uv download spawns no Python install afterwards. Engine bash tools are out of reach; the kit prose covers them
- **Tool detection** reports uv with source `managed` when only Cinna's copy exists. The Developer Tools list no longer has a Make row: the kit no longer uses `make`

## Architecture Overview

```
Caller about to exec a tool (tool detection, git view, handover check)
  -> usableTool(bin)
       -> which(bin) -> not a stub, or tools installed -> that path
       -> stub + tools absent -> next non-stub match on PATH
       -> git only -> managed git wrapper | start background install -> null

Engine / custom agent / stdio MCP child env
  -> withDeveloperToolShims(env)
       -> tools installed and git present -> env unchanged
       -> PATH = [git-shim/ if managed git needed and installed]
                 + [tool-shims/ if any name lands on a stub] + rest
       -> withManagedUvFallback: + managed uv dir last (+ UV_PYTHON_PREFERENCE when no other uv)
```

## Integration Points

- [Shell Environment Resolution](shell_environment.md) — `which()` and the login-shell `PATH` this builds on; `clearToolCache()` (Settings **Refresh**) also drops the tools-state answer
- [Runtime Pins](../runtime_pins/runtime_pins_llm.md) — the `git` pin
- [The Local Engine](../../agents/local_agents/engine.md#binary-resolution-and-what-verified-means) — the shared managed install and sweep; engine launch keys
- [Custom Agents](../../agents/custom_agents/custom_agents.md), [MCP Connections](../../mcp/connections/connections.md) — the other children that get the shims
- [Open in Tools](../../agents/local_agents/open_in_tools.md) — tool detection reads a stub as not installed
- [E2E](../e2e/e2e_llm.md) — `CINNA_GIT_DOWNLOAD=off`, `CINNA_UV_PREWARM=off`
- [Local Agent Commands](../../agents/local_agents/commands.md) — the commands the managed uv exists for
- [Bare-Mac Tests](../bare_mac/bare_mac.md) — [A fresh Mac, nothing installed](#a-fresh-mac-nothing-installed) on a real VM with no developer tools, failing on any system dialog: startup, the managed git download and tool detection (steps 3 and 5), and step 2 for Codex and OpenCode, whose children start a session in the agent folder. A Claude or Antigravity agent with no login spawns no child, so theirs is not reached

Technical detail: [developer_tools_tech.md](developer_tools_tech.md).
