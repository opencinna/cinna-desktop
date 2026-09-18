# The Claude Engine — a folder agent on Claude Code, under the user's own login

> **What this engine actually does is recorded in [The ACP Engine Contract](acp_contract.md) — the live one — and, for everything measured about Claude Code itself, in [The Claude Engine Contract](claude_contract.md).** The latter is what was watched against `claude` 2.1.266 and `@anthropic-ai/claude-agent-sdk` 0.3.266 — what is verified, what is only assumed, and what was believed and proved false. This document does not restate it. Eight of its findings shape rules below and none of them is visible in the SDK's types: `USER` must be in the child environment or the CLI reports *"Not logged in"* on a logged-in machine; `settingSources: []` does **not** detach the user's MCP connectors, so `strictMcpConfig` and an empty `mcpServers` travel with it — and it **does** hide the folder's own `.claude/agents/`, which are handed back through `options.agents` (all three are the **isolated** branch: kit folders and Cinna's own build session — an adopted bare folder is deliberately run on the folder's own setup instead); a bare tool name in `allowedTools` shadows `canUseTool` entirely, so none is passed; SDK failures arrive as **thrown exceptions**, not as messages; read-only tools never reach the permission callback at all; a string `prompt` **closes the CLI's stdin at the first `result`**, under a background subagent that has not finished, so the prompt is an iterable the runner holds open; and in the CLI's **auto** permission mode the ask-callback was **never reached** across seven probes that included a force push, so the desktop's permission block is a backstop there and every surface that describes the setting says so. Where this document and the contract disagree, the contract is right — it was watched, and this was written.

## Purpose

Let a folder agent run on **Claude Code** instead of on `opencode`: one pinned version of the `claude` CLI, verified before it runs, under the login the user already has.

Since phase 3 of the agent runtime plan the Agent SDK is no longer embedded in this process: the turn spawns `@agentclientprotocol/claude-agent-acp`, which runs the SDK in a child process and speaks the [Agent Client Protocol](acp_contract.md) back. The launcher names the pinned `claude` through `CLAUDE_CODE_EXECUTABLE` — see [Which `claude` runs](#which-claude-runs) — and the login is the user's whichever file that is, because the login follows the home directory and not the binary. The isolation for a kit folder is unchanged. What changed with the transport is that the SDK's stdin belongs to a process of its own, which is what fixed the background-subagent bug below.

What it buys the user: the Claude Code harness — its tools, subagents and context management — for agents whose work OpenCode's loop does poorly, and inference paid for by their own Claude plan rather than by an API key this app holds.

## A note on paths

Same convention as [The Local Engine](engine.md) and [The Agent Turn Runner](agent_turn.md), with one row added:

| Written as | Means |
|---|---|
| `src/...`, `docs/...` | A file in **this repository** |
| `Local/<slug>/...`, `cinna-agent.json`, `app-data/desktop.json` | Inside an **agent folder** |
| `~/.claude/...` | The user's **own** Claude Code configuration and login |
| `<userData>/runtimes/claude-<version>/` | The Claude Code **Cinna downloaded and verified** for itself |

The third row is a rule, not a formatting habit: **the desktop reads nothing and writes nothing under `~/.claude/`.** Everything it wants from the user's Claude Code it gets by spawning the binary and reading what that process reports.

## The governing principle

**The desktop is an orchestrator. It never becomes an authentication provider.**

Cinna spawns an unmodified `claude` — the vendor's own bytes, the user's install or a verified download of the same release — in an environment where that binary resolves the credentials the user already has. Supplying the executable is not supplying the login: the file is fetched from the vendor's release bucket and checked, and everything about who is authenticated stays under the user's home directory, untouched. It implements no login, stores no token, brokers no session and resells no capacity. That is the whole basis on which the feature is permitted, and it is one environment variable away from being false **in either direction**:

- put an auth variable in, and the turn silently bills the user's **API account** while the panel says it ran on their Claude plan — no error, no failed turn, a bill at the end of the month; or
- leave the wrong one out, and the CLI reports *"Not logged in"* on a machine whose `claude` is perfectly logged in, sending the user to re-authenticate a tool that was already fine with nothing pointing at this app as the cause.

Both were live hazards and the second is the one that actually bit. The child environment is therefore **constructed** — see [The child environment is constructed, never inherited](#the-child-environment-is-constructed-never-inherited).

## Core Concepts

- **Engine** — what actually runs an agent's turn. OpenCode, Claude Code and [Codex](codex_engine.md) share the ACP driver. An explicit engine wins; otherwise a declared credential/model retains OpenCode, or the machine default applies. Each is a child process speaking ACP; the engine is a field on the runtime, and in the row it is the ACP driver's **launcher**
- **Engine axis** — the second dimension dispatch gains. It is `source` **then** `engine`: a folder agent on Claude and a folder agent on OpenCode are the same `source`, and since phase 3 the same **driver** — the engine decides only which launcher starts the process
- **Pinned Claude Code** — the one version of the `claude` CLI every Cinna-spawned Claude session runs on: folder agents, chat runtimes, AI Functions, the build session and the login probe alike. The version lives in `src/shared/runtimePins.ts` and is the one the [interface contract](contracts/claude_interface.md) was run against, which is the point — the CLI that was tested is the CLI that runs
- **Managed copy** — that version as Cinna fetched it: the vendor's bare executable (about 215–232 MB, by platform) downloaded from Anthropic's own release bucket into `<userData>/runtimes/`, compared with a recorded SHA-256, and made to report the pinned version before its directory is published
- **Your install** (`path-pinned`) — the `claude` on the user's PATH, used **only when it reports exactly the pinned version**. It saves the download and nothing else: any other version on PATH is ignored for spawned sessions and stays what **Open in Claude Code** launches
- **Claude Path** — an explicit executable in **Settings → Local Development → Developer Tools**. It replaces both of the above, is run as-is with no version gate, and every surface labels it **unverified**. It exists for a platform Cinna has no pinned build for (Windows today), and for trying a newer Claude Code before it becomes the pin
- **Native auth** — the credential the spawned `claude` resolves for itself. The desktop never sees it, never names it and never stores it
- **Reported login** — what the agent *says* it authenticated with: `authStatus.kind` on the adapter's `_auth/status_update`, `'account'` for a subscription case. This is a fact read off the running process, not a belief derived from the config we generated
- **Engine credential** — for `engine: 'claude'` there is not one. The runtime carries an engine and a tier, and no credential row and no API key at all
- **Model alias** — `haiku` / `sonnet` / `opus`, which is how a plan is addressed. Not a catalogue id, because on this path there is no credential and therefore no catalogue to hold one
- **Translator** — the fold from the agent's `session/update` stream into the A2A-shaped message every consumer downstream already reads. Shared with OpenCode since phase 3 (`acpMessages.ts`); what remains Claude-specific is where a tool's real name is read from
- **Background task** — work the CLI runs after the model has ended its own turn: a subagent launched with `run_in_background`, a long shell command. The model's `result` does not wait for it. Over ACP the adapter reports each one, and each subagent, when the client advertises the AIR capabilities, and the desktop shows them under the composer ([Session Activity](../session_activity/session_activity.md))
- **Holding task** — a background task whose completion a turn waits for. A subagent holds; a background shell does not. **The desktop no longer decides this**: the adapter runs the CLI in its own process and `session/prompt` returns when the CLI's own idle rule says the turn is over. Kept as a concept because the distinction still explains why an answer can be followed by more work in the same turn
- **Folder subagent** — a `.claude/agents/*.md` definition inside the agent's folder, which a terminal `claude` would offer to the model as a `subagent_type`. The desktop reads the file and hands the SDK the fields that *describe* a subagent, never the ones that would move a permission decision
- **Approvals** — who answers this agent's permission asks *before* the desktop does. Two settings and no third: **Automatic** (the default) puts Claude Code's own reviewer in front — the same classifier a terminal `claude` runs with auto mode on — and **Ask every time** brings every command, edit, write and fetch to the desktop's permission block. A per-agent choice made on the Permissions tab, kept in the agent's desktop state beside its grants and never in a manifest. The SDK's `bypassPermissions` and `dontAsk` are not settings here and cannot be reached
- **Approval fallback** — the CLI running *Ask every time* after being asked for *Automatic*, because the model has no reviewer. Observed with `haiku`; reported by the CLI only on its init message, and by the desktop as a notice in the transcript

## User Stories / Flows

### Putting an agent on Claude
1. Open the agent and select **Settings**. The **Runs with** panel's first control is **Runs on**: it offers Claude Agent and Codex under their own headings, and the AI credentials below them
2. The Claude option is **always listed**. Whether a `claude` is on the PATH stopped being a fact about whether an agent can run — Cinna fetches its own — so the only state with nothing to run is an install that *failed*, and there the option stays and says why: *Claude Agent (install failed)*, or *(path not usable)* when a Claude Path is saved. It used to vanish, which made this select and the Settings picker — which keeps its button and reads *Unavailable* — disagree about whether the runtime exists
3. Choosing it writes `runtime.engine: "claude"` and **clears the credential**, because that path spends none. A concrete model is dropped too, and the status line says which model went and why: an id from a provider's catalogue means nothing to a plan addressed by alias
4. The **work complexity** survives the move in both directions. `medium` means the same thing on either engine, so a change of runtime must not silently discard the user's answer to "how hard is this work"
5. The **Advanced** raw-model picker is not shown on this engine — there is no catalogue to list. It is removed from inside a fixed-height row rather than disabled, so the panel keeps its footprint and the page's tab strip does not move out from under the pointer that just used the select
6. The third column stops reporting the OpenCode engine and reports the Claude Code that will run instead — `Claude Code <pin> managed`, `<pin> (your install)`, `<version> unverified` for a Claude Path, or `Install failed` / `Path not usable` — **with no Start button**, because this app starts nothing there. The cell's tooltip is the binary's path

### Chatting with an agent on Claude
1. The user sends a message in a chat bound to the agent. Everything up to the driver is the shared path: same composer, same persistence, same transcript, same cancel button
2. The ACP driver reads the folder, sees `claude`, and asks that launcher to plan the turn
3. Readiness is answered **before** the turn, on both rungs and for free: a Claude Code that could not be installed, and one that is not logged in, are each a sentence naming the remedy rather than a turn that fails with the CLI's own words. A Claude Code that simply has not been fetched yet refuses nothing — the first turn fetches it, and waits for it
4. The per-agent turn lock is taken, so "this agent is busy in another chat" behaves exactly as it does on the other engine
5. The adapter is spawned in the agent's folder, a session is created or loaded — a kit folder's with its whole assembled system prompt, an adopted bare folder's with the engine's own preset and the desktop's context appended — the **Approvals** setting is applied with `session/set_mode`, and the answer streams into the transcript token by token — text, thinking, tool calls and their results, as the same part kinds every other agent produces
6. The session id the CLI reports is remembered for this (chat, agent), so tomorrow's message continues the same conversation
7. When the agent hands work to a subagent in the background and answers "I'll report back", the turn does not end there. The adapter keeps the CLI running in its own process, the subagent's tool calls and permission asks keep arriving in the same turn, and the agent's follow-up report streams in before `session/prompt` returns. The subagent's work stays **inline**, under the agent's `Agent` call, and a **Subagents** badge under the composer names what is running. That badge is what explains a long silence with the streaming indicator on, which the in-process runner used to explain with a notice
8. When the agent leaves a **shell** running in the background, the turn *does* end: `session/prompt` returns while the shell runs, and a **Background** badge shows it, with a Stop control. When the shell finishes, Claude starts a turn of its own to read the output and act on it. That turn streams into the chat as a new assistant message and is saved like any other ([follow-up turns](agent_turn.md#a-turn-the-agent-starts-on-its-own-is-a-follow-up-turn)). Until the desktop listened between turns, that whole turn was dropped. An agent that said "I'll merge once CI passes" merged, and the chat never showed it

### Being asked for permission
1. Mid-turn the agent wants to write a file, run a command, fetch a URL or start a subagent. Who is asked first is the agent's **Approvals** setting on its Permissions tab
2. On **Automatic** — the default — Claude Code's own reviewer decides, the way a terminal `claude` with auto mode on does: it approves what it judges routine for what the user asked, and only what it declines would reach this app. **It was not seen to decline anything.** Across seven probes it approved a force push, a rewrite of the global git config, a write under the home directory, and — with the user asking only *"What files are in this folder?"* — two commands the *system prompt* had told the model to run first; the desktop's callback never fired, and the one refusal came from the model itself before any tool call ([the contract, §10](claude_contract.md#10-auto-mode--the-classifier-in-front-of-canusetool-and-what-it-approved)). So on this setting the permission block is a **backstop the reviewer was not seen to reach**, and the Permissions tab says so in those words, because a card that promised *"asks for anything unusual"* would describe a gate that was not seen to close
3. On **Ask every time**, the agent asks this app for every command, edit, write and fetch — the session mode `default`, and what every Claude agent ran before the setting existed
4. Whichever setting asked, if a standing grant for this agent already covers it, it is allowed **silently** — nothing is written to the transcript, exactly as on the other engine. A block that appeared and answered itself milliseconds later is a widget the user cannot act on
5. Otherwise a permission block appears inside the streaming answer, naming the action as a phrase — "Permission needed to run a command: …" — and the turn blocks on the answer
6. The decision is recorded beside the ask: *Allowed once*, *Allowed, and remembered for this agent*, *Denied*, or *No answer — the request expired*
7. **Read-only tools never ask, on either setting.** With no `allowedTools`, a `Read` runs with no ask at all. The grants govern the mutating surface, not the whole tool surface, and this is a limit of the mechanism rather than a policy
8. **When the model has no reviewer, the CLI asks every time anyway and says so nowhere the user looks.** Asked for *Automatic* on `haiku`, the CLI ran *Ask every time* and reported it only on its init message. The transcript therefore carries a notice — *"Automatic approvals are not available on `<model>`, so this turn asked before each action instead."* — on every exit the turn can take, because a user whose setting says Automatic and who was just asked about `ls` has no other way to tell the setting from a bug. A CLI that reports no mode at all is read as no fallback, not as one

### Claude Code is there but not logged in
1. Whether the user is *logged in* is a separate question from whether there is a binary, and it is asked **for free**: `claude auth status` runs no turn and bills nothing. It is asked of the binary the sessions run on, never of whichever `claude` happens to be on the PATH
2. The panel's status line says so before anything is spent — *"Run `claude` in a terminal: that Claude Code install is not logged in."* The remedy leads, because that line is measured to clip at the 800 px minimum window and the half that survives has to be the half naming the action
3. A turn asked for anyway is **refused before the SDK is called**: *"This agent runs on Claude, and that Claude Code install is not logged in. Run `claude` in a terminal."* Nothing is spawned and nothing is billed
   - The second half is **word for word the panel's**, because a user meets this condition on two surfaces and two paraphrases of one instruction read as two instructions. The panel's wording is what the skip reason moved to match, not the other way round — that line is measured to the pixel and cannot afford *installation*. The opening clause stays only because a turn error in a transcript has nothing around it naming the engine, while the panel says so two rows up
4. The remedy is named and nothing offers to perform it. Logging in is something only the user can do, in their own terminal, against their own account
5. The user goes and does it — which is the reason the panel keeps asking while the answer is *logged out*. Coming back to a red alarm about a machine that is now fine is the failure that rule exists to prevent

### Choosing who approves
1. On a Claude agent's **Settings → Permissions** tab, the paragraph describing the OpenCode profile is not shown — it describes rules that are not in force on this engine. In its place: a sentence that the agent runs on Claude Code **under the user's own login** — not "on your own Claude Code install", which the card can no longer promise — and that reading and searching never ask, then one paragraph describing **both** settings before the control rather than whichever is chosen under it, so the card does not resize on every toggle and a user choosing reads both anyway
2. The description of *Automatic* is deliberately blunt — that in testing it approved everything it was shown, including a force push and a change to the global git config, so treat it as running the agent without a gate and give it work you would run yourself. *Ask every time* is described as bringing every command, edit and fetch to a permission block in the chat, where **Always allow** remembers it in the list below
3. An **Approvals** select offers *Automatic* and *Ask every time*. No choice made reads as *Automatic*, never as a blank option. A change saves at once and the control holds the picked value for the whole round trip — main re-scans the folder before it answers, and rendering the stored value alone snapped the select back to the old setting until the answer landed, then flipped it
4. A refused save — the agent is mid-turn in another chat — leaves the control on the stored value and puts one line under it: *"Nothing was changed — that agent is busy in a chat."* One line, truncated with the full text on hover, in a slot that is always rendered, because the turn-lock sentence wrapped at the 800 px minimum and moved the grants list down by a line
5. The footnote under the grants, which on OpenCode says a moved folder starts a new agent *which is asked again*, here says it starts one *on the default setting* — that is Automatic, which the paragraph above has just said approves what it is shown, and "asked again" would promise an ask that setting never makes

## Business Rules

### The engine is a field on the runtime, never a synthetic credential

A runtime is now `{engine, credential, model}`. The tempting alternative — a fake credential row labelled "Claude Agent", so the picker and every consumer stay uniform — is rejected, and the reason is that `isCredentialUsable`, `findCredentialByReference`, the enabled/disabled ladder and every skip reason are written about a row that has a key, an `enabled` flag and a catalogue behind it. A synthetic row satisfies none of those and would lie to each of them differently. It lies worst at *"the user switched this credential off"*, which has no meaning at all for an engine that bills nobody's key.

*Which* engine and *where the choice came from* also stay separate questions: the engine is a new field, and the existing runtime **source** (`manifest` / `default` / `none`) is untouched.

### The Claude path resolves nothing about credentials, because it has none

Runtime resolution returns early for this engine instead of threading a null credential through a ladder written about credential rows. Run it through them and a perfectly healthy agent is explained with *"your default chat mode uses a credential that is switched off"* — a sentence about a key it was never going to spend, and one the user would act on by changing something that cannot help.

The early return sits **above** the Default-runtime lookup, and that order is load-bearing rather than tidy: that lookup reads the user's default chat mode and this machine's credential override, and a throw in either store used to turn a Claude agent into an OpenCode one at the dispatch point, silently — after which the agent answered *"this agent is not available in the running engine yet"* for ever.

### A tier resolves to an alias, not through the model classifier

Work complexity becomes `haiku` / `sonnet` / `opus` by a small table, deliberately **not** through the family classifier the other engine uses. That module classifies a live catalogue against a credential's own model list, and here there is no credential and no catalogue: a plan serves what the plan serves, addressed by alias. Resolving a tier through a classifier with nothing to classify would produce nothing for every agent.

The **Medium floor** still applies in spirit — an agent that names no tier runs on `sonnet`. A model the manifest names explicitly still wins over a tier, matching the other path's precedence, so the two cannot disagree about which of the pair the user meant.

### An agent on another engine has no entry in the OpenCode config

Config generation skips it. Without that it still gets an entry, the generator skips it as *credential unavailable* — because a Claude runtime resolves to no credential — and the Runs-with panel explains a healthy agent with a sentence about a key it does not spend.

It is not merely cosmetic either: the generated config names a model as `<credential>/<model>`, and a Claude runtime's model is an alias no OpenCode provider lists.

### The child environment is constructed, never inherited

The SDK's own documentation is explicit that the environment option **replaces** the child's environment entirely rather than merging it. Neither of its defaults is correct here, and inheriting is the dangerous one, because it fails by reporting success: `ANTHROPIC_API_KEY` lives in exactly the shell profile [this app deliberately sources](../../development/shell_environment/shell_environment.md), so the obvious implementation authenticates against the user's API account with nothing anywhere looking wrong.

So the environment is built by **narrowing with the helper the app already has, then stripping, then adding one variable**:

| Included | Why |
|---|---|
| the login-shell `PATH` | the agent's own tools — `git`, `make`, `uv` — must resolve, exactly as they must for the other engine |
| `HOME` | the CLI's credentials live under it. The one deliberate widening of the narrowing rule, and it is safe because the alternative is not "narrower", it is "authenticates as nobody" |
| `USER` | without it the CLI reports *"Not logged in"* on a logged-in machine. It comes for free from starting at the shared allowlist; the hand-assembled dictionary that preceded it is what left it out |
| a client-app identifier | `cinna-desktop/<version>`, so the CLI's User-Agent says who asked. An orchestrator should say who it is |

| Excluded, by name | Why |
|---|---|
| `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` | each re-authenticates or redirects the turn away from the user's own plan |
| `CLAUDE_CODE_USE_BEDROCK` / `_VERTEX` / `_FOUNDRY` / `_ANTHROPIC_AWS` | each routes the turn to a provider the user did not choose in this panel |
| every `CINNA_ENGINE_KEY_*` | the local engine's credential map. There is no credential on this path, and its presence would be a second way to pay |

Most of the excluded names would not survive the narrowing anyway. They are stripped **by name regardless**, because the list is the statement of intent: a future widening of the shared allowlist must not quietly restore the billing trap.

The built environment is then **audited before it is handed over**, and a leak is logged loudly by name — never by value, since logging the value of a key to explain that it leaked recreates the leak in the log. It is checked on the value actually being passed rather than trusted to the function that produced it, because the environment is the one input here whose corruption is invisible in the result: a turn billed to the wrong account looks exactly like a turn billed to the right one.

### Which `claude` runs

Every `claude` Cinna spawns — a folder agent's session, a chat runtime, an AI Function, the build session, the login probe — is resolved the same way, in this order:

1. **The Claude Path**, when one is saved. Run as-is: no version gate, no checksum, labelled *unverified* everywhere. A saved path that is not a runnable file is an **error, never a silent fall back** to the pinned copy — the user named something specific, and quietly running a different Claude Code than the one they named is worse than saying the path is wrong
2. **The user's own install, when it reports exactly the pinned version.** Consulted only while Cinna has no managed copy of its own — once there is one, that is a single `stat` and it cannot change under a running app the way a self-updating install can. It is **version-gated, not checksummed**: what was compared is the `--version` line, and the surfaces that name it say *your own install, the tested version* and no more
3. **The managed copy**, downloaded on first use. The vendor ships a bare executable rather than an archive, so nothing is unpacked: the downloaded file is compared with its recorded SHA-256, moved into place under the tool's name, and must then report exactly the pinned version before its directory is renamed into `<userData>/runtimes/`. The digest proves these are the pinned bytes; the version proves the pinned bytes are what the manifest says they are. Either failure leaves nothing on disk a later run could mistake for an install

This engine used to run whatever `claude` the PATH held. That made the version under every agent something nobody had tested and nobody chose on purpose: it moved whenever the vendor's updater ran, and an adapter release verified against one CLI silently drove another. The contract this engine rests on is now checked against one version, and that version is the one that runs.

**The user's install is run from its real path, not from the PATH entry.** `~/.local/bin/claude` is a symlink the vendor's updater retargets, and a pooled adapter process keeps the path it was handed for every later spawn — handed the symlink, its next spawn after an update would run a version that never passed the gate. The file that was probed is the file that is named, its identity (real path, size, modification time) is remembered, and each turn re-checks that identity for the cost of two syscalls. An install that has updated itself is "gone" in the way that matters: the next turn resolves again, and downloads if the version moved.

**A Cinna-spawned `claude` never updates anything.** `DISABLE_AUTOUPDATER=1` is set on every one of them — sessions and the login probe alike — because a session may be running on the user's own install, and that install's background updater replaces the binary and retargets the symlink from inside whichever process happens to be running. A desktop session must never be the thing that moves the user's `claude` to another version, nor move the version under a pooled adapter to one that was never gated. The user's own terminal sessions are untouched and update as they always did; Cinna's copy moves only when an app release moves the pin.

**The login is the user's whichever file runs.** It follows the home directory, not the binary: a second Claude Code binary under the user's real `HOME` and `USER` reported the same subscription login as their own install, with no Keychain prompt (verified by hand, 2026-09-18). Nothing needs logging into twice, and nothing about the managed copy is an authentication step.

**Windows has no managed build.** The launcher's child-environment rules and the login probe are POSIX-verified only, so there is no pinned row for it and a Windows user sets a Claude Path — the answer any unlisted platform gets. Linux rows are the glibc builds.

How the resolver, the download and the sweep of superseded versions work is shared with Codex and OpenCode and lives in [The Local Engine](engine.md#binary-resolution-and-what-verified-means); what is specific here is only the precedence above and the updater switch.

### Readiness is answered before the turn, and the login is free to ask

Two facts decide whether this engine can run an agent, and **both are knowable without spending anything**:

- **Is there a Claude Code to run** — the binary service's look, which never downloads: the Claude Path, a managed copy from an earlier run, or an exact-version install of the user's own. It costs at most one `--version`, shared with the settings row and the login probe
- **Is the user logged in** — `claude auth status`, asked of that binary, which runs no turn and bills nothing

The second used to cost a turn. The runner learned *Not logged in* from a **thrown turn error** and told it apart from other failures by matching the CLI's own words. That works, and it is the wrong shape: the user asks a question, waits a turn's worth of latency, and gets back an error about authentication.

The two are asked **in that order**, and both **before the per-agent turn lock** — there is nothing to ask about a login when there is no binary, and a failed install must not queue behind another chat's turn.

**"Not here yet" refuses nothing; only a failed install does.** The pinned CLI is fetched by the first turn that needs it, so readiness that refused while the CLI was merely on its way would block the one action that fetches it. The turn itself resolves the binary first — the step that may download — and asks the login *of that binary* afterwards. A failure there is a sentence (*Claude Code could not be installed. Try again in Settings → Agents → Runtime.*) and is not remembered: the next turn simply tries again.

**"There was nothing to ask" is not an answer worth keeping.** Before the first install the probe has no binary and answers `unknown` — and does not cache it. Held for the whole cache window, an `unknown` taken a moment before the install would let the turn that installed the CLI skip the logged-out refusal. For the same reason saving or clearing the Claude Path drops the remembered login verdict without asking again: the answer belonged to the previous binary, and the new one may still be resolving.

**Only a definite `logged_out` refuses a turn.** `unknown` is a first-class answer and never blocks: a probe that timed out, could not spawn, or met an output shape it did not recognise is not evidence of a logged-out install, and the thrown-error fallback is still there as the second line. A readiness check that can refuse a working engine on its own uncertainty is worse than no readiness check.

**The probe runs in the same constructed child environment the turn will.** This is not tidiness — it is the `USER` finding applied to the check itself. The binary answers differently depending on its child environment, so a probe run under the full login-shell environment would cheerfully report a login for a child that then cannot authenticate, and readiness would be answering about a different process than the one the turn spawns.

**Settings → Default → Local Development → Developer Tools → Refresh re-asks the login too, and nothing on that screen says so.** That table has two columns, Tool and Version, so the one control in the app that deliberately re-checks the login sits on a screen that never displays it. It is recorded here as a decision rather than left to be found as a bug: the button means *"go and look at this machine again"*, and after it a stale login answer beside fresh detection would be the inconsistency — most of all on the machine the button exists for, where Claude Code has just been installed and is about to be logged into. A **login column is deliberately not added** to that table. It would be a second surface for a fact the agent page already carries, and it is not needed as a recovery path: the panel's own poll clears a stale alarm within about ten seconds, without the user going to Settings at all.

The answer is **cached for a short window, not for the app's lifetime**. Whether a binary exists barely changes while the app is open; whether it is logged in changes precisely *because* the app has just told the user to go and log in. A permanently cached "no" would leave them staring at the alarm they had already fixed. One probe is shared by the turn path and the panel, so a render and a turn starting together spawn one child rather than two.

### The account behind that login is never read

`claude auth status` answers with the account's **email**, **organisation id** and organisation name alongside the login state. The two organisation fields are not lifted out of the CLI's JSON — not into the returned shape, not into a log line, not across IPC to the renderer.

**That is the defence, and it is deliberately not a rule about logging.** A field that is never read cannot leak from a debug line somebody adds six months from now; a rule saying "do not log the account" is one careless edit from being untrue. What survives is who *pays* rather than who they are: the authentication method as the CLI words it, and the plan tier when it names one. Same reasoning as the engine config's Invariant 4, applied to somebody else's login.

### A kit folder is sealed; a bare folder runs on its own setup

**The session options fork on one field, `runtimeMode`, and everything below about isolation is the sealed half of that fork.** A kit folder is a harness the desktop scaffolded, so its session stays sealed. A bare folder is somebody's own repository, adopted for its instructions file alone, and it gets what a terminal `claude` in that folder gets.

| | **Isolated** — kit folders, and Cinna's own build session | **Native** — adopted bare folders |
|---|---|---|
| `settingSources` | `[]` | `['user', 'project', 'local']` |
| `strictMcpConfig` / `mcpServers` | `true` / `{}` | not sent — either would take the folder's servers back out |
| System prompt | the assembled document, **replacing** the `claude_code` preset | the preset, with the desktop's context **appended** |
| `.claude/agents` | read by the desktop and handed back through `options.agents` | loaded from settings; the shim is not even asked for |
| Approvals | `session/set_mode` after every `new` and `load` | the same, unchanged |

**The mode is derived once, where the folder view is built, and a launcher never asks what kind of folder it has.** That is not tidiness: Cinna's own local-development build session presents as a bare folder because its synced workspace has no manifest, and a rule written as `kind === 'bare'` would have handed the desktop's own build session whatever `.claude/settings.json` that workspace happened to carry. One field, decided in one place, is what makes the folder whose kind lies harmless.

**What the folder now brings with it was watched on the wire** on 2026-09-17, against `claude` 2.1.274 and adapter 0.76.0: the folder's `CLAUDE.md` answered from memory with no tool call, a `SessionStart` and a `PreToolUse` hook both fired, a project `.mcp.json` server was attached, and a `.claude/agents/` definition appeared as a `subagent_type` with no shim passed. On the isolated branch, in the same folder, the `CLAUDE.md` was not in context and the hook did not fire.

**The trade-off, stated plainly rather than discovered.** On a bare folder the user's own MCP connectors attach — Gmail, Drive, Calendar, whatever they have — and so does the folder's `.mcp.json` and the folder's `defaultMode`. Three consequences follow, and the third is the one to design against:

- **A bare folder's `.claude/settings*.json` `defaultMode` decides the mode the session opens in.** `session/set_mode` is what corrects it, and that is the *only* thing that does — see [the mode is set, never requested](#the-mode-is-set-never-requested-and-permissionmode-is-inert).
- **A bare folder's `.mcp.json` starts with no trust step.** The interactive CLI asks before enabling a project MCP server; the SDK path this adapter uses does not. The server's command runs on **any** turn in that folder, including a user-typed one — not only an unattended one. Anything that can land a commit in that repository can therefore choose a process that starts the next time the user chats with that agent.
- **So a handover that runs unattended in a bare folder is a security boundary, not a convenience.** The per-agent auto-run setting, and its refusal while `.cinna/handovers` is tracked by git, exist because of the two rules above and not in spite of them.

If a per-agent opt-out is wanted later — a bare folder the user wants sealed — it is a desktop-state setting beside the runtime, not a change to this default.

### The desktop's boundary must not be redefined by files it did not write

**This rule is the isolated branch.** It governs kit folders and Cinna's own build session; a bare folder is the case above.

`settingSources: []` keeps the user's own settings files, `CLAUDE.md`, project skills and plugins from redefining what a Cinna agent may do — a stray `CLAUDE.md` two directories up rewriting an agent's behaviour is invisible in every surface the user reads.

**That option is not the whole boundary**, and believing it was would have shipped as a defect. It does not detach the user's own MCP connectors: a probe run with it still had the user's Gmail, Drive and Calendar attached, so a folder agent would have been handed tools reaching the user's mail with no Cinna surface saying so. `strictMcpConfig` with an empty server map is the actual fix and travels with it.

This has a cost worth stating rather than discovering: the user's own skills, `CLAUDE.md`, commands and plugins **do not load**. "Use my whole local setup" and "the desktop decides what this agent is" are in genuine tension, and this resolves it toward the second, because a folder agent's system prompt is assembled from the folder's own files. If a per-agent opt-in is wanted later it is a manifest flag, not a default.

**The option is also wider than the boundary it was drawn for.** It hides the folder's own `.claude/agents/` — the agent's specialists, which are not the user's configuration but part of what the agent *is* — and an agent built as a lead with three of them ran in the desktop with none, improvising a `general-purpose` subagent with the specialist's job pasted into its prompt. Those are handed back by another route; see [the next rule](#the-folders-own-subagents-are-handed-over-and-the-boundary-stays-the-desktops).

The system prompt is that assembled prompt as a plain string, never the SDK's coding-assistant preset — the preset would talk over the folder, which already says what this agent is.

### The folder's own subagents are handed over, and the boundary stays the desktop's

**This rule is the isolated branch too.** A native session loads `.claude/agents/` from the settings it keeps enabled — watched, 2026-09-17 — so the launcher does not read them and does not pass the option; handing them over as well would state every definition twice.

A terminal `claude` discovers `.claude/agents/*.md` in its working directory and offers each as a `subagent_type`. Under `settingSources: []` it does not, so on that branch the desktop **reads the files itself** and passes what a terminal would have found through the SDK's `agents` option — the programmatic route to the same registry, which does not reopen the settings boundary. Read fresh each time a turn is planned, like the system prompt, and with the same limit: both travel in the session's `_meta`, which the adapter ignores when it reuses a session still live in its process. An edit reaches a new chat at once, and an existing chat once its idle process is reaped — see [The Local Engine](engine.md#the-desktop-context-block-and-building-mode). A folder without the directory passes no option at all, so it hands the SDK exactly what it did before the option existed.

**Read, not trusted.** The fields carried across are the ones that *describe* a subagent — description, prompt, tools, disallowed tools, model, max turns, skills, effort, whether it runs in the background. The ones that would move a permission decision away from the desktop are dropped whatever the file says:

| Dropped | Why |
|---|---|
| `permissionMode` | one frontmatter line of `bypassPermissions` would run every tool without the desktop's permission request ever being raised — the grants, the permission block and the audit trail all bypassed by a text file in the folder |
| `mcpServers` | the same reason `strictMcpConfig` is set: the desktop hands the CLI an empty connector list, and a subagent must not reopen it |
| `memory` | writes outside the transcript, under `~/.claude/agent-memory/` or the folder, and nothing in Cinna shows or clears it |
| `observer`, `observerMessage`, `criticalSystemReminder_EXPERIMENTAL`, `initialPrompt` | experimental or side-channel fields with no desktop surface |

**A file the reader cannot represent is skipped, not read as best it can.** The kit's YAML reader turns a block scalar into the literal `"|"` and truncates an unquoted line at its `#` — plausible values, both wrong — and a subagent described to the model as `"|"` is worse than one it is not offered. The file is left out, the reason is logged with the line the reader objected to, and every other file in the directory is still read. The same rule refuses a file with no description (the model would never pick it) and one with no prompt below the frontmatter.

### The turn ends when the agent says it has stopped

**This is the rule the ACP move simplified, and the failure it came from is worth keeping.** In
process, the SDK treated a string prompt as a single user turn and **closed the CLI's stdin at the
first `result`** — so a subagent the model had launched in the background outlived the stdin it
needed, and its permission asks came back to the user as *"Stream closed"* denials. The fix was a
prompt iterable held open past that first result, with the desktop deciding from the CLI's own
background-task set when the turn was really over.

Over ACP the adapter owns the CLI's stdin in its own process, for its own lifetime, and the turn ends
when `session/prompt` returns a stop reason. Re-run against the real binary: a background subagent's
ask arrived **after** the parent's reply, was allowed, and the subagent completed — no "Stream
closed" anywhere. What the desktop keeps from that episode is a named regression case in the driver's
suite, so the sequence cannot come back unnoticed.

Which background work holds the prompt is the CLI's decision now, not the desktop's. Watched with
`claude` 2.1.273: a background subagent holds it, and so does the turn the subagent's completion
triggers; a background shell does not. What the desktop owns is everything around that:

- **It reports both kinds** ([Session Activity](../session_activity/session_activity.md))
- **It keeps the process alive while a shell runs.** The reaper waits, for up to 30 quiet minutes
- **It shows the turn Claude starts when the shell finishes.** That turn ends on the `usage_update`
  that carries `cost`, because Claude ends every turn with one, including the ones it starts itself

The eighty-minute ceiling is what covers a turn that never ends at all — see [The Agent
Turn](agent_turn.md#a-turn-always-settles).

### A subagent's work stays inline, though the adapter no longer announces it

The launcher advertises `nativeSubagentSessions`, so the adapter reports each subagent's start and
end. That comes at a price: the parent session **no longer receives the `Agent` tool call**, and the
subagent's own frames arrive under a session id of its own ([the contract](acp_contract.md#subagents-nativesubagentsessions)).
The desktop puts both back:

- the child session is routed to whoever hears the parent
- the missing `Agent` call is written into the stream from what `subagent_spawned` said, ahead of the
  first frame that needs it, and closed from the subagent's own end

A transcript therefore reads as it did before the capability, with one exception. **A background
subagent's launch text is missing**, because the CLI writes it and it is not on the wire. A subagent
that ends with its call still open is closed with a line saying how it ended ("Subagent failed.",
"Subagent stopped.", "Subagent disconnected.").

**Inline means under its call, not mixed into the agent's words.** The child's frames carry
`_meta.claudeCode.parentToolUseId`, and the translator files them as a *lane* of that `Agent` call
([The Agent Turn](agent_turn.md#the-translator-maintains-a-cumulative-message-the-accumulator-computes-the-delta)):

- the agent's own paragraph stays one part while the subagent's tool calls stream beside it. Before
  lanes, the first child tool call cut the agent's sentence mid-word
- the subagent's text is its report to the agent, so it is never the turn's answer, the chat preview
  or the title source
- the transcript draws the lane as a nested sub-thread under the `Agent` call, named by the call's
  `description`, with its `prompt` as the ask line; a subagent's permission ask or question is
  answered there, and holds the thread open until it is
  ([Conversation UI](../../chat/conversation_ui/conversation_ui.md#subagent-work-in-the-transcript))

### A message sent mid-turn goes into the running turn, between tool calls

The adapter advertises the ACP steering extension, so a message the user sends to this agent while its turn runs is taken into that turn instead of waiting for it to end, and it is saved in the transcript where it landed. The desktop asks with `idleBehavior: promptRequired` — with no turn running, start nothing — which is the only idle behaviour the adapter accepts.

**Not while a tool runs.** The adapter delivers a steered message at the CLI's `now` priority, and the CLI aborts whatever it is executing to take it. A message sent during a `Bash` command killed the command, and the agent answered the message instead of finishing the work. So a message sent while a tool call runs is queued as a visible bubble, and main hands it to the turn once the call ends.

Whether a message is steered at all is decided in [Pending Messages](../../chat/pending_messages/pending_messages.md); the window it can arrive in is [The Agent Turn](agent_turn.md#a-message-sent-mid-turn-is-taken-only-while-the-prompt-is-in-flight-and-no-tool-is-running); why the priority is not changed in the adapter is [the ACP contract](acp_contract.md#the-steering-extension). No live steer against the real CLI has been recorded yet ([the ACP contract](acp_contract.md#the-steering-extension)).

### No tool is pre-approved, because pre-approving one bypasses the asking

A bare tool name in `allowedTools` auto-approves that tool *before* the permission request reaches the desktop — the SDK says so itself at runtime — so the two mechanisms cancel rather than compose. **No `allowedTools` is passed at all.** This is the half that has to be true before the desktop's grants mean anything.

### Automatic is the default, and the block is a backstop there

A Claude agent that has not been told otherwise runs with the CLI's own reviewer in front of the desktop — the session mode `auto`. Before the setting existed every agent ran `default`, which asks for every `Bash`, `Edit` and `Write`; a user whose terminal `claude` runs in auto mode never saw those prompts there, `settingSources: []` keeps their `~/.claude/settings.json` out of the desktop's turns, and an agent that was quiet in the terminal asked for `ls` in the desktop. It read as a bug in the desktop, and it was one.

The default is *Automatic* and not *Ask every time* for that reason, and the cost is said out loud rather than softened: on *Automatic* the desktop was never asked across seven probes, so the grants and the block are the backstop for whatever the reviewer declines, and the reviewer was not seen to decline. `canUseTool` is passed on **both** settings — *Automatic* is a classifier in front of the desktop, not instead of it.

### The mode is set, never requested, and `permissionMode` is inert

`session/set_mode` after every `session/new` **and** every `session/load` is not belt-and-braces. It is the entire mechanism, on both branches of the fork, and the SDK option that looks like it should do the same job does nothing at all.

**Watched on 2026-09-17, `claude` 2.1.274 / adapter 0.76.0:** `_meta.claudeCode.options.permissionMode` was sent as `default` and the session came up in `acceptEdits`, taken from the project's `.claude/settings.local.json`. The same folder reported `acceptEdits` under `settingSources: []` as well — the setting sources do not govern `defaultMode` either. After `session/set_mode {modeId: 'default'}` the session reported `default` and the next file write raised a `session/request_permission`.

So a change that "simplified" the setup call into the `session/new` options would hand every bare folder its own permission mode, silently, with the desktop's approval setting still displayed in the panel. A failed setup call refuses the turn rather than warning, for the same reason.

### The choice is two-valued, and the other modes are unreachable

`ClaudeApproval` is `auto | ask`, mapped onto the session modes `auto` and `default` in one place — the launcher, which sets it with `session/set_mode` after every `session/new` **and** every `session/load`, because the adapter otherwise honours a `defaultMode` from the user's own settings, bypass included. It is deliberately not the SDK's `PermissionMode`, which has six members: `bypassPermissions` and `dontAsk` would each remove `canUseTool` from the decision, and with it the grants, the block and the transcript's record of what was allowed. A value from that vocabulary written into the state file by hand reads as *no choice* — the default — never as the more permissive setting by accident, and the setter refuses it outright.

### The setting is the desktop's, kept beside the grants and never in a manifest

Which engine and model run an agent is what the agent *is* and travels in a kit manifest; how far this machine trusts it is the same kind of fact as a standing grant. So the choice lives in the agent's desktop state — `app-data/desktop.json` in a kit folder, the file under `<userData>` for a bare one — for **either** kind of folder, through one unstamped path that touches no file the folder publishes. Null is a real value meaning *no choice made*, stored as null rather than as today's default, so an agent that never chose follows a future default. The write takes the per-agent turn lock, because the runner writes the same file to record a session and a mid-turn write to a file it is reading is the race the lock exists for.

### A fallback the CLI reports only at init is said in the transcript

The CLI honours `auto` only on a model that carries a reviewer. On one that does not it runs `default` and reports the mode it is actually in on its init message — `haiku` is the observed case; `sonnet` and `opus` held `auto`. The runner reads that field, and when the agent asked for *Automatic* and the CLI ran anything else, the turn ends with a notice naming the model the CLI reported. It is attached on **every** exit — completion, error, cancel and ceiling — for the reason the billing notice is: the observation is made at init, so the path a turn happens to leave by cannot decide whether the user is told. An init message with no mode on it is read as no fallback, so an older CLI is not accused of one.

### *Always allow* stays the desktop's, across folder engines

The SDK offers a way to persist an allow into Claude Code's **own** rules. It is never used. Such a rule would be user-global, shared with the user's personal Claude Code, and would authorise agents this app has nothing to do with — the same reason the other engine's `always` is never forwarded to it. A remembered decision is a row in that agent's desktop state, and what the CLI is told is a plain allow; the transcript records which of the two actually happened.

### Claude's tool vocabulary stays Claude's

A grant is stored under the action **the engine that raised it actually named** — `Bash`, not `bash` — so a rule written on one engine never silently authorises the other. What the two share is only the sentence the user reads: one describer knows both vocabularies, because "The agent is asking to Bash" is not English, and because the block on screen must not be able to disagree with the block the transcript replays.

The grant key gains no engine segment. A grant is already scoped to a folder, and an agent does not change engines between one ask and the next often enough to justify a migration.

### The manifest gains a key, additively — read tolerantly, written strictly

`runtime.engine` is contract **1.2.0**, exactly as `runtime.complexity` was 1.1.0. See [Kit Contract & Manifest Layer](kit_contract.md).

- **An unrecognised engine value reads as no engine**, and the agent falls to the host default. It does not fail validation and does not brick the folder, because a folder written by a newer tool must keep running. The schema deliberately does not close the value set with an enum: engines are expected to grow
- **`engine: "claude"` with a `credential` is refused on write** and, on read, is a warning with the credential ignored. They are not meaningful together: a manifest naming one would make the panel report a key that pays for nothing
- The validator **warns rather than errors** on both cases, because an error there marks the folder invalid and drops it from the engine entirely — which is the exact brick the additive promise exists to prevent

The tolerant read is applied again at the last place it could be forgotten: dispatch. An engine value this build does not know sends the turn to the default runner.

### An unreadable folder falls back to the default engine

Dispatch reads the agent's manifest on the turn path, so it is guarded rather than trusted — the row may be gone, its folder may have moved, and a manifest is briefly unparseable every time an assistant saves it. **Falling back to the default engine is the safe direction**: the OpenCode runner already renders every one of those states as a readable turn error, whereas dispatching to the Claude runner on a folder that could not be read would replace all of them with *"no Claude Code was found"*.

### The turn never throws, and that is harder here

A failed turn is a result carrying an error, never an exception, for the same reason as everywhere else: an exception crossing IPC loses its code. It is harder on this path because **the SDK reports failure by throwing out of its async iterator** rather than by yielding a result — observed for both "Not logged in" and a stale resume, the two most likely first-run failures. So the whole iteration is wrapped, and the only discriminator between failure kinds is the message text.

**Cancellation is also a throw**, and its name is not `AbortError`. A stop is told apart from a real failure by the turn's own signal and by nothing else. A cancelled turn is not an error anywhere: it keeps whatever streamed and reports no failure, and the abort check comes before the failure branch so that a stop landing mid-turn is never reported to the user as an error for something they did on purpose.

A stop that lands **before** the turn starts is checked for explicitly, because a listener added to an already-aborted signal never fires and everything before it can await — detection walks the `PATH` and the shell environment may source a profile. A cancellation in that window used to be dropped entirely: the child ran the whole turn, the user's plan paid for a turn they had cancelled, and the result was still reported, correctly, as not an error.

### A remembered session is verified by use, not by a probe

There is no endpoint to ask whether a session still exists. A resume against a session the CLI has forgotten throws, and the right response is to start a fresh one and carry on without explaining — the user asked a question, not to be told about our bookkeeping.

Three guards keep that retry from becoming a second billed turn:

- only for **the observed wording** of a forgotten session. Matching any error that merely mentions a session id let a rate-limit or state error re-run a whole turn for a failure that had nothing to do with continuity
- **never once the turn has already streamed something.** The retry reuses this turn's accumulator, so a second pass arrives under fresh message ids and is *appended* rather than replacing — the user reads the answer twice, for two billed turns. A turn that streamed had no forgotten session to blame anyway
- never after a cancel, and never when there was no remembered session to blame in the first place

### A turn that did not run on the user's own login says so, where the user is

The **observed** fact is what the agent reports it authenticated with — over ACP the adapter's `_auth/status_update`, whose `authStatus.kind` is `'account'` for a subscription login (the in-process SDK called the same thing `apiKeySource`, where the subscription case was `'none'`). Anything else means something reached the child that the environment construction intended to strip, and the person is being billed on an account they did not pick in the Runs-with panel.

**That failure otherwise looks exactly like success**, which is why a log line is not a surface: nobody reads the log until they already suspect something, and here there is nothing to suspect. So a completed turn that reports anything but `'none'` also carries a **notice** — *"This turn did not run on your Claude Code login — the CLI reported …. It may be billed to that account instead."*

A notice and not a panel line, because notices are the existing channel for agent-side system messages and land in the transcript **beside the turn they describe**. A panel would say it once, about whichever turn ran last, on a screen the user may not be looking at.

**On every exit, not only the successful one.** The observation is made when the agent reports it, so the exit path a turn happens to take cannot decide whether the user is told: a turn that reported the wrong account and then failed, or was cancelled, or ran to the twenty-minute ceiling has been billed to that account regardless — and the ceiling is the most expensive way to get it wrong.

**Silent when the agent reported a subscription, or reported nothing.** This app never *asserts* a subscription — asserting one because a variable was stripped would be a claim about an environment it does not fully control — it only reports when the CLI says otherwise. A turn that failed before the CLI said anything has no observation to report, and inventing one is the exact assertion this rule exists against. The turn itself still succeeds: this is a warning about billing, not a failure, and blanking a good answer would help nobody.

### What the panel says, and what it still will not claim

The panel now reports the login, because the login became free to ask. The reserved status line names it in one of three shapes: *runs on your own Claude Code login*, with the plan in brackets when the CLI reported one; the weaker *runs on Claude Code* when the probe answered `unknown` — it used to say *your own Claude Code install*, which stopped being a thing this app can assert once the file may be Cinna's copy; and the logged-out remedy, which **leads with the action** — *"Run `claude` in a terminal: …"* — because at the 800 px minimum window this line is measured to clip, and the surviving half has to be the half the user can act on.

What is still never asserted is a **subscription the CLI did not name**. The plan is passed through, capitalised and no further; a lookup table here would blank out a plan this app had not heard of on the one line meant to say who pays, and inferring one because an environment variable was stripped would be a claim about an environment this app does not fully control.

Two states are silence rather than reassurance, and they are different states:

- **The binary state has not answered.** Claiming an install before main has said what it found is the same false claim in the other direction, and the slot is reserved, so saying nothing costs no movement. (When the panel still asked PATH detection, the full red not-installed alarm appeared for half a second on machines that *did* have Claude Code — the default first visit for every agent on this engine)
- **The login probe has not answered.** Filling the slot with the reassuring install sentence meant a logged-out machine read healthy in muted grey and was contradicted in red about a tenth of a second later (measured at t=891 ms and t=996 ms). Nothing moves either way — the line is reserved — so what a retraction costs is that the *next* reassuring sentence here is worth less. An answer of `unknown` is not this case: it is an answer, and the plain *runs on Claude Code* sentence is the true thing to say about it

The **Engine column names the binary and never the login** — it is fixed at 219 px and does not widen with the window, so it holds the shortest true thing and the line that can grow carries the meaning. Its **dot** does move, once: `--color-warning` for a definite `logged_out`, which is the type scale's *"Awaiting auth"* case, and warning rather than danger because the install is fine and one command fixes it. The reserved line below was turning red while the one glanceable indicator in the row stayed neutral about a state the app had just gone and found out.

Everything else about that dot is unchanged, and one rule in particular: it is **never the success colour**. One option away in that exact slot a green dot means *the process is running*, so a green here would be one indicator, in one position, meaning two things — and the weaker claim read as the stronger. `unknown`, in-flight and `logged_in` all stay muted; only a failed install or an unusable Claude Path is danger.

**A failure is one of two different failures, and the copy branches on which.** With a Claude Path saved nothing was installing — main only stats that file and runs its `--version` — so *Install failed… could not be installed* described something that never happened and sent the user to a *Try again* that re-checks the same path. There the badge reads *Path not usable* and the line names Settings → Local Development; *not usable* rather than *not found*, because the file may exist and refuse to run. Without a path it is *Install failed*, and the line names Settings → Agents → Runtime, where **Try again** lives. The retry is not offered on this panel: it is a viewer over one agent's runtime, and a machine-wide install button on it would be a second place one fact is acted on.

The panel says nothing about which account paid for a turn either, and **that is a choice of channel rather than silence** — the observation goes into the transcript instead. See below.

## What this deliberately does not do

- **It shares its transport with OpenCode and Codex, and no longer shares a process with the desktop.** Folder engines are child processes speaking ACP, so there is one driver, one translator and one permission path; what is Claude-specific is a **launcher** — the command, `CLAUDE_CODE_EXECUTABLE`, the declared `elicitation.form` capability, the `_meta.claudeCode.options` and the session mode. The SDK is no longer an async iterator inside this process, and the stdin hazard that came with that is gone
- **It gates nothing global.** The per-agent lock is still taken, so busy-in-another-chat is unchanged; there is no shared engine left for any turn to defer or be ended by, on either engine
- **It reports no cost and no token counts, and both omissions are deliberate.** Cost on a subscription is a shadow price — three probe turns reported dollar figures against a plan that charged nothing — and no wording available in a notice line makes that informative, so it is dropped outright. Token counts are a different argument and land in the same place: the contract says they *may* stay, which is permission rather than instruction, and a token figure in every transcript is noise for a number nobody asked for. The SDK's final message carries both and the translator folds them; nothing reads them, on purpose. The one thing a turn does report about itself is the account that paid for it, and only when that is not the expected one
- **It does not switch background work off.** `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` in the child environment would make the CLI drop `run_in_background` from the `Agent` and `Bash` schemas and offer only synchronous subagents, and a string prompt would then have been correct. It is rejected: the point of this engine is the Claude Code harness as the user has it, and an agent that behaves differently under the desktop than in a terminal is the kind of difference nobody can see from the transcript
- **It never writes into `~/.claude/`** — no settings, no rules, no credentials, no `apiKeyHelper`
- **It offers no way to run without the callback.** `bypassPermissions` and `dontAsk` are not on the Approvals select, not accepted by the setter and not read from the state file. Either would take the desktop's grants and the transcript's record out of the decision, and a turn that ran that way would look identical to one that did not
- **It does not hand the reviewer the user's own environment context.** The `autoMode.environment` lines in `~/.claude/settings.json` are what `settingSources: []` withholds, nothing in the SDK's options carries that block on its own, and the reviewer was seen running with `repoVisibility: unknown` and nothing else. The desktop does not try to pass it: doing so would mean reading a file under `~/.claude/`, which this engine never does
- **It ships no Claude Code inside the app, and never runs the adapter's.** The SDK pulls a bundled ~190 MB binary per platform, and the ACP adapter pins its own nested copy of the same thing; the installer excludes both, and `CLAUDE_CODE_EXECUTABLE` is what makes the exclusion safe. The objection to that copy was never that it is a second Claude Code — Cinna's managed copy is one too — but that it was an *accidental* one: at whatever version a dependency happened to nest, checked by nobody, named on no screen. The managed copy is chosen in one manifest, verified before it runs, shown with its path in Settings, replaceable by a Claude Path, and moved by app releases
- **It never updates the user's Claude Code, and never lets a session do so.** See [Which `claude` runs](#which-claude-runs)
- **It makes no claim about Windows.** `PATH` resolution and credential storage differ there and none of it was verified, which is why there is no pinned Windows build: a Windows user sets a Claude Path and runs unverified
- **The engine axis is two-valued on purpose.** Nothing here is built to accommodate a third engine and it should not be until there is one — the abstraction that fits two is not reliably the one that fits three

## Known gaps, carried honestly

These are open:

- **The Keychain question is largely closed, and it was the wrong question.** This entry used to say the path had never been exercised. It had been all along: the probe machine's credentials *file* had been expired for a month while every probe succeeded, so the live credential was the Keychain item throughout — see [the contract, §1](claude_contract.md). The remaining half was then measured directly: a Developer ID-signed `node` under `--options runtime` carrying **this app's own entitlements**, none of them Keychain-related, spawned `claude auth status` with the credentials file moved aside and got a logged-in answer with **no consent prompt**. What that does not cover is written out in [§8 item 1](claude_contract.md#8-still-unverified--and-one-of-these-can-still-kill-the-feature) and must not be read as covered: the parent was a signed `node`, not the packaged `.app` with its `entitlementsInherit` chain; nothing was notarized, quarantined or launched past Gatekeeper; only the native installer's `claude` was the accessing binary; and "no prompt" is on a machine where `claude` has been run interactively many times
- **A real spawn against a genuinely logged-out install is still untested.** The readiness probe is verified against a logged-out *environment* rather than a logged-out *machine* (`USER` withheld, and an empty `HOME`), and the thrown-error fallback below it is still driven by matching the CLI's error text
- **Whether an API key in the environment actually shadows an OAuth login is not proven.** The stripping rule rests on the SDK documenting the two as distinct credential sources, which is strong but is not observation
- **Only one install shape was tested** — the native installer, whose bytes are the same bare executable the managed copy is. That matters less than it did, since a PATH copy now runs only at the pinned version and everything else runs Cinna's download; it still applies to a Claude Path. The SDK branches on the executable path's extension, so an npm shim and a Homebrew wrapper take different code paths — and they are also *different binaries* to the Keychain, so the item's ACL is evaluated afresh for each and the no-prompt result above does not carry over
- **The installer exclusion is verified on `darwin-arm64` only.** The other seven platform packages are not built here
- **The Anthropic API SDK moved 0.89 → 0.93** to satisfy the Agent SDK's peer requirement, and the bump lands on the ordinary Anthropic chat adapter, `src/main/llm/anthropic.ts`, not on anything here. That adapter is covered — `src/main/llm/anthropic.test.ts` runs the SDK's real client against a stubbed wire — but nothing in this feature exercises it, so a further bump forced from here is verified there, not here; see [LLM Adapters — Technical Details](../../llm/adapters/adapters_tech.md#sdk-versions-and-one-that-moved-for-a-reason-outside-this-domain)
- **Out-of-plan usage has no good surface.** It arrives mid-turn as an error from the CLI and its message is passed through, which is honest but not helpful. We do not know the user's limits and inventing a sentence about them would be worse than the CLI's own
- **Background work has been watched in single probes, not over time.** One run each, on `haiku`: a background subagent, a synchronous one, a background shell, and a stopped task ([the contract](acp_contract.md#between-turn-traffic)). A shell left running when the model answers was measured there: the prompt returned 24 s before the shell ended, and the turn Claude started afterwards ended on a costed `usage_update`. A failed task, a subagent that fails or disconnects, and an ask raised between turns have not been watched
- **Automatic mode may refuse a `haiku` turn under `claude` 2.1.273.** On that CLI, `session/set_mode auto` itself fails on `haiku`, and the driver refuses a turn whose setup failed. This is read from the code and was not run in the app ([the contract](acp_contract.md#on-automatic-the-clis-own-reviewer-answers-first--and-it-declined-nothing))
- **The reviewer handing an ask on to the desktop was never observed.** The SDK's own documentation implies it can; seven probes, chosen to be declined, were all approved. Everything the block does on *Automatic* is therefore verified only on *Ask every time*, and the description of *Automatic* is written from what was watched rather than from what the SDK says. Which models carry a reviewer is not the desktop's to know either — `haiku` is the one observed to fall back, and the notice is driven by what the CLI reports, not by a list
- **No automated test runs a turn on a real login.** The E2E scenarios drive the *choice* — the option, the manifest rewritten in both directions, the panel's geometry — and the readiness ladder, which is reachable there because the probe is free and the sandbox `HOME` makes a real binary read as logged out; they name their binary through the Claude Path, because the fixture switches the managed download off. They stop there, because spawning a `claude` **turn** bills a real person's subscription on every developer's machine and in CI. What does run real turns is the [interface contract](contracts/claude_interface.md): the pinned binary and the real adapter against a loopback fake Anthropic endpoint, in a scratch `HOME`, with every connection the CLI routes through its proxy settings recorded and refused. That covers the interfaces, not the login — the entries that need a real subscription (the login following `HOME`, a subscription usage limit, the background updater) are marked **Live only** and skipped rather than faked

## Architecture Overview

```
Agent page → Settings → "Runs with" panel
   │  Runs on: [ On this machine: Claude Agent | AI credentials: … ]
   │  tier picker, status line, Engine column (the binary that will run)
   ▼
local-agent:update-field  (kit, stamped)  /  local-agent:set-runtime  (bare)
   │  runtime.engine written to cinna-agent.json or to Desktop State
   │
   │  Permissions tab → Approvals select
   │    local-agent:set-claude-approval  (either kind, unstamped)
   │    claudeApproval written beside the grants in Desktop State
   ▼
runtimeService.resolve ──► ResolvedRuntime { engine, credential?, model }
   │                        engine = claude → no credential, model = alias
   ▼
driverFor(agent) ──► the ACP driver          dispatch: agents.driver = 'acp'
   │                                          (the engine lives in driver_config.launcher,
   │                                           and the turn re-reads the folder anyway)
   ▼
launcherOfFolder(runtime) = 'claude' ──► ClaudeLauncher.plan()
   │
   readiness — before the lock, before any turn:
     claudeBinaryService.peek → install `failed` ──► refused, nothing spawned
       (not fetched yet is NOT a refusal: plan() runs ensure(), which may download)
     claudeAuthProbe      → `logged_out` ──► refused, nothing billed
       `claude auth status` asked of the binary the sessions run on, cached,
       in the same constructed environment the turn will use; `unknown` never blocks
     the panel asks the same probe: useClaudeAuth → local-tools:claude-auth
   │
   ▼
spawn: <this app, ELECTRON_RUN_AS_NODE=1> <claude-agent-acp>/dist/index.js
   cwd  = the agent folder
   env  = buildClaudeEnv (constructed, stripped, audited)
          + DISABLE_AUTOUPDATER=1
          + CLAUDE_CODE_EXECUTABLE = Claude Path │ the user's install at exactly the pin
                                     (its real path) │ <userData>/runtimes/claude-<pin>/claude
   │
   ├─ initialize   clientCapabilities = { elicitation: { form: {} },
   │                   _meta.jetbrains.air: [asyncTasks, nativeSubagentSessions] }
   │                 └ elicitation enables the adapter's AskUserQuestion tool;
   │                   AIR makes it report background work and subagents
   ├─ session/new | session/load
   │    _meta.claudeCode.options, forked on folder.runtimeMode:
   │      isolated (kit, build session) = { systemPrompt (the folder's own),
   │                                 model (a plan alias), settingSources: [],
   │                                 strictMcpConfig, mcpServers: {},
   │                                 agents (the folder's .claude/agents/*.md) }
   │      native (adopted bare folder) = { systemPrompt: {type:'preset',
   │                                 preset:'claude_code', append: desktop context},
   │                                 model, settingSources:['user','project','local'] }
   │                                 — no MCP override, no agents shim
   │    NO allowedTools — a bare name there shadows the permission request
   ├─ session/set_mode  auto | default, from the Approvals setting
   │    after EVERY new and load, on BOTH branches: a user's or a folder's
   │    defaultMode wins otherwise, and options.permissionMode is ignored
   └─ session/prompt
        session/update ─────────► acpMessages ──► parts   (a child session's frames: a lane of their Agent call)
        session/request_permission ──► standing grants
        │                              └ covered → allow_once, silently
        │                              └ else → parked block → answered
        elicitation/create ──────► question block  (this engine only)
        │                            └ filed beside its AskUserQuestion call,
        │                              whose restating result is folded into it
        current_mode_update ≠ asked ──► notice in the transcript
        async_task_* / subagent_* ──► session activity (badges); child session aliased to the parent
        → stopReason
   after it: the session stays observed; an unprompted turn → follow-up turn → ends on costed usage_update
   │
   ▼
RunAgentTurnResult { text, parts, notices, contextId }
   │
   ▼
parts accumulator → message repository → renderer   (all unchanged)
```

## Integration Points

- [The Claude Engine Contract](claude_contract.md) — what was watched against the real binary and the SDK, and the authority for every "why does the code do this" question here
- [The Agent Turn Runner](agent_turn.md) — the seam this is the third implementation of, and every rule about never throwing, the lock and the ceiling
- [The Local Engine, Runtimes & Prompt Assembly](engine.md) — the runtime resolution this extends, the prompt assembly it reuses verbatim, and the environment narrowing rule it widens by exactly one variable
- [Session Activity](../session_activity/session_activity.md) — the background shells and subagents this engine reports, and the Stop control
- [Local Agent Permissions](permissions.md) — the standing grants the permission callback consults, the Approvals setting that decides whether the CLI's reviewer stands in front of them, and why *Always* is never written into a tool's own store
- [Kit Contract & Manifest Layer](kit_contract.md) — `runtime.engine` as an additive 1.2.0 field, and the tolerant-read rule that keeps a newer folder running
- [Agents Tab & Agent Page](agents_tab.md) — the "Runs with" panel and its one reserved status line
- [Open in… (Local Agent Tools)](open_in_tools.md) — the tool detection that finds the `claude` on the PATH. That copy is what **Open in Claude Code** launches and a first-launch hint for the Default runtime; it no longer decides whether an agent can run. The login probe still rides the same `local-tools:*` surface (`local-tools:claude-auth`), so pressing **Refresh** in Settings re-asks it
- [Claude Code Interface Contract](contracts/claude_interface.md) — the generated index of every CLI and adapter interface relied on, each tested against the real pinned binary
- [Runtime Pins](../../development/runtime_pins/runtime_pins_llm.md) — where the pinned version and its checksums live, and how to move them
- [Shell Environment Resolution](../../development/shell_environment/shell_environment.md) — the login-shell environment and the child allowlist the constructed environment starts from
- [UX Rules](../../development/ui_guidelines/ux_rules.md) — rule 1 in particular, for a picker that changes which controls exist beneath it
- Technical details: [The Claude Engine (tech)](claude_engine_tech.md)
