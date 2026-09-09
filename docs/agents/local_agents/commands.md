# `/run:<name>` — running a folder agent's catalog commands

## Purpose

Let a folder agent's own `docs/CLI_COMMANDS.yaml` commands run without going through a model turn at all: a `/run:<name>` message executes the named script as a subprocess in the agent's folder and streams its output back as one command result, the same way a synchronous platform slash-command already does for a remote agent. <!-- nocheck -->

Phase 7a of Local Agents. Phase 3 already listed the catalog on the agent page; this slice is what makes **Run** actually run something.

## Core Concepts

- **Command Catalog** — `docs/CLI_COMMANDS.yaml`, a flat list of `{name, description, command}` entries the agent's author wrote cloud-first, i.e. as the command runs on a cinna-core-managed host <!-- nocheck -->
- **`/run:<name>` reference** — the exact invocation grammar (`RUN_REFERENCE_PATTERN`) both the validator and this slice share: a bare `/run:` followed by a catalog name and nothing else. It is what the composer's `/` picker inserts, what the manifest's `status_refresh_command` can name, and what this slice intercepts
- **Localisation** — rewriting a catalog entry's cloud-written command for this machine before it runs, e.g. `python …` → `uv run …` when the folder has a `pyproject.toml`. Not new to this slice — see [Business Rules](#not-net-new-the-catalog-the-localisation-the-part-kind)
- **Command owner** — the turn-lock owner name (`'command'`) a `/run:<name>` execution takes, alongside `'turn'` (a model turn) and `'editor'` (a page save). See [Agents Home, Scanner & Folder Index](folder_index.md) for the lock itself
- **Command Result** — the existing part kind a synchronous command's output rides; see [Command Results](../../chat/command_results/command_results.md), unchanged by this slice

## User Stories / Flows

### Running a command from the agent page
1. The user opens a folder agent's page and presses **Run** on one of the Commands card's entries
2. The screen switches to the chat view and a new chat is started, bound directly to this agent, with `/run:<name>` as the first message — the same entry point a remote agent's card-derived commands already use for a bound chat. The sidebar moves to **Chats** with it: a run leaves the user in a conversation, and an agents list beside one relates to nothing on screen — the same landing both **Start chat** buttons make ([Agents Tab & Agent Page](agents_tab.md#a-chat-from-the-row-without-opening-the-page))
3. The command streams in as a bordered command-output block, exactly like any other synchronous platform command

### Running a command from the chat composer
1. The user types `/` in a chat already bound to (or about to bind to) a folder agent
2. The existing `/`-trigger popup opens, now populated from this agent's own catalog file instead of coming back empty
3. Picking an entry inserts `/run:<name>` into the composer, same as it always has for a remote agent's card-derived commands
4. Sending the message runs it

### A command that fails
1. The name isn't in the catalog, the folder is gone, the kit contract can't be read, the localised binary isn't on the machine's `PATH`, the script exits non-zero, or it runs past its own ceiling
2. Whatever output the process produced before failing is kept and shown
3. The failure renders through the ordinary turn-error banner — expandable to the captured output — not a second error surface built for this case

### Cancelling a running command
1. The user presses stop while a command is streaming
2. The subprocess and everything it forked are killed, not just signalled
3. The turn lock releases immediately rather than waiting out the command's own timeout
4. The outcome is recorded as cancelled, not as a failure of the command — the chat shows no error banner for a cancel, and anything else that runs a command directly can tell the two apart

## Business Rules

### Not net-new: the catalog, the localisation, the part kind

Three of the four pieces this feature needs already existed before this slice: the catalog reader (`readCommandCatalog`), the cloud-to-local command rewrite (`layout.localizeCommand`, contract-driven — `python`/`python3` → `uv run` when a `pyproject.toml` is present), and the `command_result` message-part kind the chat pipeline already renders as a terminal-style block. **Only execution and dispatch are new.** This slice does not invent a second rendering path, a second catalog format, or a second localisation rule — it wires a subprocess into machinery that was already built and already tested for other callers.

### The dispatch point is deliberately outside the runner

`/run:<name>` is recognised in `agent_a2a.ipc.ts`, right after the message's wire content is known and before `a2aStreamingService.streamToAgent` is called — never inside `resolveTurnRunner` or `LocalAgentTurnRunner`. A command is not a model turn: it never touches the local engine, never opens an engine session, and has nothing in common with the streaming lifecycle that seam exists to run. Routing it there would also mean editing the one seam Phase 6's mutation audit spent a dedicated pass hardening, for a feature that doesn't need anything that seam provides. So the interception happens one layer up, and `resolveTurnRunner`'s dispatch — one function, on `agents.source`, used by both call sites — stays exactly as Phase 6 left it.

A remote agent never reaches this interception at all: for a remote agent, `/run:<name>` is still sent as ordinary chat text and the remote agent's own server recognises it. Nothing in this slice changes that path.

### The message has to be exactly a reference

A chat message is treated as a command invocation only when it is, after trimming, nothing but `/run:<name>`. `/run:check please` is chat text that happens to start with a reference, not an invocation — it falls straight through to the engine unchanged. This is the identical grammar the manifest validator already holds `status_refresh_command` to, so a message a user can type and a reference a manifest can declare mean the same thing.

### A command takes the same lock a model turn does

A `/run:<name>` script can write anywhere under the agent's folder — the catalog's own worked example is a status updater touching `app-data/storage/STATUS.md` — so it is exactly the kind of writer Invariant 3 exists to serialize against. Running it under the per-agent turn lock (owner `'command'`) means: a second command for the same agent refuses immediately rather than racing it, a page-editor save refuses while the command runs rather than landing mid-script, and the folder watcher defers its rescan until the command's writes have settled. A command never touches `turnLock.anyHeld()` — the engine-wide restart guard — because it never touches the shared engine process; there is nothing engine-level to serialize against here, only this one agent's folder.

### The whole subprocess tree is killed, not just the shell

A command runs under a shell (`sh -c`), and killing only that shell process on cancel or timeout leaves whatever it already forked — the real script a pipeline or `&&` sequence launches — orphaned and still running, still holding the lock via the pipes it inherited. This was a real defect, found by running the code rather than reasoning about it: a killed shell still let its child finish before the promise this feature returns actually settled, silently defeating both the cancel button and the timeout. Cancelling now kills the whole process group.

### Output is bounded, and a hang has its own ceiling

Combined stdout+stderr is capped so a runaway script can't grow a chat message without bound; past the cap the output is truncated with a visible marker rather than silently cut. The cap is enforced as output arrives, not after the script ends — a script that prints gigabytes before the ceiling stops it cannot grow the desktop's memory to match, because nothing past the cap is ever kept (the pipes are still drained so the script itself never stalls). A command also carries its own timeout, shorter than a model turn's — a catalog command is a script, not something waiting on an LLM, so a much tighter ceiling is still generous for anything meant to be a one-click Run button, while keeping a hung script from holding the folder's lock for the life of the app.

### Success and failure both become the shape the pipeline already knows

A successful run becomes one `command_result` part — the exact convention [Command Results](../../chat/command_results/command_results.md) already renders — with the invocation string set so the header reads `/run:<name>`. A failure of any kind (not in the catalog, folder gone, binary not found, non-zero exit, timed out, couldn't even spawn) becomes a turn error carrying the captured output as detail, which renders through the same error banner every other turn failure already uses. Neither path invents new UI.

### A leftover from Phase 6, closed here, not new scope

The agent page's **Start chat** button had been hard-coded disabled since Phase 3, unflipped when Phase 6 shipped a runner able to serve a folder-agent turn — nothing in the renderer could reach a chat bound to a folder agent at all until this slice turned it on, reusing the exact mechanism the remote-agent status overlay's own "Start chat" already used. This closes debt Phase 6 left behind; it is not a feature this phase set out to build.

## Architecture Overview

```
Agent page — Commands card "Run"          Chat composer "/" popup
  │ startNewChat({message:'/run:<name>'})    │ useCliCommands(agentId)
  ▼                                          ▼
                          window.api.agents.*
                                  │
Renderer ── window.api ──▶ ipcMain.on('agent:send-message')
                              │ persist user message (shared path)
                              │ resolveTurnRunner(agent)         ── on agents.source, unchanged
                              │ resolveCommandRunner(isFolder, wireContent, …, fallback)
                              │   │ not a folder agent, or not a bare /run:<name> → fallback unchanged
                              │   └ folder agent + /run:<name>  → commandService-backed runner
                              ▼
                        a2aStreamingService.streamToAgent(effectiveRunner, …)
                              ▼
                        commandService.run()
                              │ readCommandCatalog(agentDir)  → entry, or "no such command"
                              │ layout.localizeCommand(entry.command)
                              │ turnLock.withLock(agentId, 'command', …)
                              │   spawn(localCommand, {cwd: agentDir, shell:true, detached})
                              │   captured stdout+stderr, capped, killed as a tree on abort/timeout
                              ▼
                        RunAgentTurnResult { parts:[{kind:'command_result', …}] } | { error }
                              │ persisted + posted exactly like any other turn result
                              ▼
                        CommandResultBlock  (existing, unchanged)
```

## Integration Points

- [The Agent Turn Runner](agent_turn.md) — the dispatch point (`resolveTurnRunner`) this slice deliberately sits beside rather than inside, and the mutation-audited seam it leaves untouched
- [Agents Home, Scanner & Folder Index](folder_index.md) — the turn lock a command takes under the `'command'` owner, alongside `'turn'` and `'editor'`
- [Command Results](../../chat/command_results/command_results.md) — the `command_result` part kind and its rendering, reused verbatim
- [CLI Commands](../../chat/cli_commands/cli_commands.md) — the `/`-trigger picker, now reachable for a folder agent through the same `useCliCommands` hook that already served remote agents
- [Agents Tab & Agent Page](agents_tab.md) — the Commands card and the Start chat button this slice wires up
- [The OpenCode Engine Contract](opencode_contract.md) / [The Local Engine](engine.md) — not touched by this slice; a command never starts, reconciles, or talks to the engine

## What is not verified

This project's honesty convention applies: coverage is named, not implied.

- **Nobody has driven this through `npm run dev` in a live browser.** Every claim above is unit/component-test and code-inspection verified only
- **`ChatInput.tsx` deriving `promptSourceAgent` and calling `useCliCommands` with a folder agent's id at the right moment is verified by code inspection only**, not a mounted-component test. The hook itself, `useCliCommands`, is tested and proven agent-id-agnostic — what is unverified is only the composer wiring above it
- **`killTree`'s win32 path (`taskkill /pid <pid> /T /F`) has never run on real Windows**

See [Technical Details](commands_tech.md) for what each test file actually covers.
