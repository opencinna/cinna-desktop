# The Local Engine, Runtimes & Prompt Assembly

> **What the engines actually do is verified against the real binaries — see [The ACP Engine Contract](acp_contract.md).** That document records what was watched against `opencode` 1.18.27 over `opencode acp`, and against `@agentclientprotocol/claude-agent-acp` 0.76.0 driving the user's own `claude`; what is only assumed; and what was believed and proved false. **Read §OpenCode/config before changing anything about the generated config:** the engine has two config readers, `OPENCODE_CONFIG` reaches only the older one, and the newer one — which decides what a session can run on and what system prompt it gets — substitutes neither `{env:…}` nor `{file:…}`. Two further findings shape everything below: the agent entry's own `model` is **ignored over ACP**, so the model is stated in the config *and* on the session; and OpenCode's saved permission grants are **user-global**, which is why the desktop holds its own — see [Local Agent Permissions](permissions.md). The contract also records how a pattern in the generated `permission` block is actually matched, and which rule wins when two match; **read it before editing that block**, because a pattern that misses fails open.

## Purpose

What runs a folder agent: a **child process per agent**, spawned by the turn that needs it and spoken to over the [Agent Client Protocol](../drivers/drivers.md); the generated OpenCode configuration derived from this machine's AI credentials and that one agent; the **runtime** (engine + credential + model) each agent resolves to — from a model the manifest names, a work complexity it names instead, or the defaults below it — and the per-agent system prompt assembled out of the agent's own files.

**Three engines, and the agent's runtime says which.** OpenCode uses desktop AI credentials; [Claude Code](claude_engine.md) and [Codex](codex_engine.md) run a pinned CLI Cinna verifies for itself, under the login the user already saved with that tool. An agent without an explicit engine follows the machine default unless it declares a credential or model, which preserves OpenCode. All run through one driver over one protocol, so the engine is no longer an identity — it is a **launcher**: the thing that knows what command to spawn, what to declare at `initialize`, and what has to be said to the session before the first prompt. Folder prompt assembly is shared; the credential/model ladder and generated profile below are OpenCode-specific. Codex supplies the assembled prompt as developer instructions and preserves its CLI configuration.

**There is no server.** Until phase 3 of the agent runtime plan one desktop-managed `opencode serve` sat on loopback behind a password and backed every folder agent at once, with a state machine around it — resolve, download, spawn, health-check, reconcile, restart, stop at quit. It is gone, and with it every rule that existed because the process was shared: the global lock predicate that gated a restart, the deferral of a config change while any turn streamed, the two digests compared against a running process, and the *skip* list a screen read to explain an agent. What replaced them is smaller and is described here: one process per agent, one config per agent, and a refusal at the top of the turn that belongs to the agent it refuses.

## A note on paths

Three trees are discussed and their paths look alike, so they are written differently throughout — the same convention as [Agents Home, Scanner & Folder Index](folder_index.md) and [Agents Tab & Agent Page](agents_tab.md):

| Written as | Means |
|---|---|
| `src/...`, `docs/...` | A file in **this repository** |
| `Local/<slug>/...`, `cinna-agent.json`, `credentials/.env`, `app-data/...` | Inside an **agent folder** |
| `<userData>/acp/...`, `<userData>/engine/...` | Inside the app data directory — the desktop's own tree, which **no agent folder ever contains** |

The distinction is a rule, not a formatting habit: every generated config lives under `<userData>`, never in the user's folders (Invariant 2). See [Nothing generated is written into an agent folder](#nothing-generated-is-written-into-an-agent-folder).

## The governing principle

**A process belongs to one agent, and the folder decides which engine starts it.**

Both halves are load-bearing.

*One process per agent* is what makes every guard local. A shared server meant the blast radius of a restart was the whole app — restarting to pick up agent A's new manifest ended agent B's streaming reply — so the old design needed `turnLock.anyHeld()`, a deferral, and a promise never to write a config while anyone was streaming. None of that survives, because agent A's config is agent A's process's, and the change reaches it when *that* agent next takes a turn.

*The folder decides* means the stored engine is a cache, never the answer. `agents.driver` is `acp` for every folder agent and `driver_config.launcher` names the engine, but that column holds what the last scan read. A turn re-reads the folder, picks the launcher from what it says now, and a stale row cannot send a Claude agent to OpenCode — a defect the two folder drivers had to hand turns to each other to avoid.

## Core Concepts

- **Engine** — what runs a folder agent's turn: `opencode`, `claude` or `codex`, each spawned through an ACP launcher
- **Launcher** — the engine, as the turn path sees it: what command to spawn, what environment it gets, what the client declares at `initialize`, what `session/new` carries, and what must be set on the session before the first prompt. `opencode`, `claude` and `codex` are implemented; `gemini` remains a recognized name without a launcher and is refused in words
- **Launch spec** — one process's command, arguments, whole environment, cwd, and a `key` that moves whenever any of those do. The key is a **digest, never the values** — the environment carries API keys, and the pool logs the key
- **Process pool** — one process per ordinary agent, or per compatible synthetic chat-runtime group: started by the first turn that needs it, held for the length of a turn, reaped after two minutes idle (later while its background work runs), replaced when its spec key moved, killed at app quit. It never restarts a process on its own
- **Engine config** — the OpenCode configuration this app generates for **one agent**, into `<userData>/acp/opencode/<hash of agent id>/opencode.json`: the provider entry for that agent's credential, that agent's entry with its inlined system prompt, the permission profile, and a top-level `model`
- **Generated prompt** — the per-agent system prompt assembled from the agent's own files. **Inlined into the agent's config entry**, because the engine's v2 config reader resolves no `{file:…}` reference and would hand the model the placeholder in place of the prompt
- **Agent key** — the OpenCode agent-entry name a folder agent becomes (`<slug>-<hash of agent id>`). Selected on the session as the `mode` config option, which is what makes the turn run *that* agent rather than OpenCode's stock coding assistant
- **Engine binary state** — whether this machine has a usable `opencode` and where it came from (`unresolved` / `resolving` / `ready` / `failed`). All that is left of "the engine" as state a screen shows: it is about a file, not a process
- **Binary source** — where the resolved `opencode` came from: `configured` (a path in Settings), `path` (the user's own install, found on the login-shell PATH), or `managed` (the pinned version this app downloaded and verified)
- **Runtime** — what an agent runs on: `{engine, credential, model}`. On OpenCode the credential and the model are the whole of it, and the manifest reaches that model two ways: by naming it, or by naming a **work complexity** the desktop resolves against the credential's own catalogue. An agent on `claude` or `codex` has no desktop credential or generated OpenCode config
- **Work complexity** — `simple` | `medium` | `complex`, written into `cinna-agent.json` in place of a model id. It says how hard the agent's work is and lets the host pick; a model id is the least portable thing that file can carry
- **Default runtime** — the machine engine selection in Settings. On OpenCode, the credential/model fallback comes from the machine credential override or effective default chat mode; CLI engines use their own login/configuration
- **Medium floor** — the last step of model resolution: an agent that would otherwise have no model at all runs on the Medium tier of the credential it was already given
- **Refusal** — the sentence a launcher answers with instead of a plan when the agent cannot run: no binary, no credential, no model, no Claude Code, not logged in. It is produced **before the turn lock is taken and before anything is spawned**

## User Stories / Flows

### The first message to a folder agent on a machine with no `opencode`
1. The user sends a message. Nothing has been started in advance, and nothing was started at app boot
2. The turn reads the folder, sees `opencode`, and asks the launcher to plan. The binary is resolved: a path from Settings, else the user's own install on the login-shell PATH, else the pinned build for this platform, downloaded into `<userData>/engine/`, verified against a recorded SHA-256, unpacked and published. Settings and the "Runs with" panel say *Downloading…* while it happens, because the state is pushed
3. The config for this one agent is generated and written, the process is spawned with `opencode acp` in the agent's folder, and `initialize` completes
4. A session is created, the agent key and the model are set on it, the prompt is sent, and text starts arriving
5. Two minutes after the turn ends, with nothing else asking for it, the process is stopped

### Nothing resolves it for you
1. A user who never chats with a folder agent never pays for a 46 MB download: **nothing resolves the binary at app boot**, and the state reads `unresolved` until something looks
2. So an unresolved binary is **not a warning**. Settings shows it with a muted dot and a line opening "Not resolved yet — chatting with a folder agent resolves it", and the amber triangle is kept for `failed`, which is the state only the user can fix (a path they typed that does not work). An alarm over a state that resolves itself on the next turn is the healthy state wearing an alarm ([UX Rules](../../development/ui_guidelines/ux_rules.md), rules 2 and 12)
3. **There is no Start button, and no "Running".** There is nothing to start: the per-agent processes appear when a message is sent and disappear two minutes later, so a status light for one would be true for a couple of minutes at a time and describe an implementation detail the user has no action for

### Adding a credential, or rotating a key
1. The user adds a credential in Settings, or rotates the key on one, or the background account-config sync materialises a managed provider on its timer
2. Nothing is pushed anywhere and nothing needs to be. The next turn for an agent on that credential generates its config from current state, and the launch spec's key is a digest of exactly those bytes plus the credential environment
3. A key moved, so the key moved: the pool retires that agent's process and starts a fresh one before the prompt. A rotation is invisible in the config bytes — the key was never in them, only the name of the environment variable it travels in — which is why the credential environment is digested into the key as well
4. An agent that is *mid-turn* keeps the process it started with. That is the same guarantee the old deferral bought, now free: a running turn holds its process, and the replacement happens at the next one

### Choosing a runtime
1. Open the agent from the sidebar and select **Settings**. The “Runs with” panel offers the credentials this app can actually call with, and — by default — **how hard the work is** rather than which model does it: Simple, Medium or Complex. The line under the picker names the model the chosen tier resolves to on the chosen credential, because the user is picking what gets billed
2. **Advanced** swaps the tier for the raw model list. It is remembered, but it is a preference and not a mode: the agent's *own runtime* decides which picker it opens on, since a panel showing a tier over a runtime that pins a model would misreport what the agent runs on. So the checkbox **converts** — a model becomes the tier it belongs to, a tier becomes the model it currently resolves to — and says in the status line what it did, because it is rewriting the runtime behind a control that only claims to change the view. A conversion with nothing to write still moves the view (the file keeps its tier and the line says which); a model that matches no complexity at all — a gateway's hand-written id — leaves the checkbox **ticked and disabled** with a standing line saying why, rather than a control that springs back under the pointer that just used it
3. Both pickers stay disabled until the model registry has loaded — a network round trip per credential — because until then the panel cannot tell a model that belongs to another catalogue from one the registry has simply not listed yet, and cannot say what a tier resolves to at all
4. The `Default (…)` option names the model *this credential* would run, resolved through the same chain the engine uses (see [A model is lent only where it can run](#a-model-is-lent-only-where-it-can-actually-run)), not the default chat mode's model regardless of credential
5. Choosing writes a credential **name** and *either* a model id *or* a tier — never a key, never this app's internal provider id, and never both at once. Into `cinna-agent.json` for a kit agent; into that agent's state under `<userData>` for a bare one, whose folder is never written into. `runtimeService.validate` is the same check on both paths, so the key-shaped-credential and model-and-tier refusals are not something the second writer can quietly skip
6. **Changing the credential drops a model the registry attributes to a different catalogue**, and the status line says which model went and why. Keeping it would write a manifest the config turns into `openai/claude-sonnet-4-5`. A model the registry has never listed is *kept*: it is a hand-written id for a catalogue this app cannot see, so calling it wrong would be a guess. **A tier is never dropped** — that is the whole point of one: `medium` means the same thing on the new key, and a key that lists nothing in that tier produces a warning in the status line rather than a choice quietly disappearing. A credential change carries what the manifest actually holds, and only the one manifest that arrives carrying *both* a model and a tier loses one — the key not on screen — because writing both is a refusal and dropping the unseen one silently is how a tier disappeared while the user was following the panel's own advice
7. A kit agent's write goes through the same stamped `local-agent:update-field` path as every other editable file, so an assistant editing the manifest cannot be clobbered. A bare agent's goes through `local-agent:set-runtime` with **no stamp** — there is no file in the folder for anyone else to have changed, so a stamp there would guard nothing
8. Clearing the choice removes the `runtime` block entirely — `null` in a bare agent's state, the key gone from the manifest — rather than leaving `{}` behind, so "no choice made" reads the same in storage as it does in the UI, and the agent falls back to the Default runtime and below that to the Medium floor
9. The save pushes nothing at any engine. The agent's next turn generates its config from what the file now says, and the process it had is replaced because the spec key moved
10. **Which credential of a type it is has a consequence the panel does not show.** The first Anthropic credential becomes the engine's canonical `anthropic` entry and inherits the real context and reply windows of every model. A *second* one becomes a custom entry the engine has no catalog for, so the desktop has to declare those windows itself from a per-type floor — see [A second credential's models have to be told how big they are](#a-second-credentials-models-have-to-be-told-how-big-they-are). An agent on the second key is therefore capped at that floor rather than at what its model actually supports


### An agent that cannot run
1. An agent whose credential has no key, or whose runtime names no model, still appears everywhere — and the turn is **refused before anything is spawned**, in a sentence naming what is missing
2. The refusal is the turn's own error in the chat, and the same fact is on the "Runs with" panel before the user sends anything. It is not a list some global config generation left behind: it belongs to the agent, it is computed for that agent's turn, and there is no window in which it describes what a *shared* process happens to have loaded
3. Without it the only symptom would be an agent that does nothing when chatted with, which is indistinguishable from a bug in this app

### Editing an agent while another one is answering
1. The user edits agent A's workflow prompt. The save succeeds
2. Agent B is mid-reply. **Nothing about that is anyone's concern any more**: B's process was started for B, and A's edit reaches A's own process the next time A takes a turn
3. This used to be the sharpest constraint in the feature — one process served both, so a restart for A ended B's reply, and every write path had to defer behind a global lock predicate

## Business Rules

### The machine default is selected once, and explicit agents keep their choice

`localAgentsDefaultEngine` accepts `opencode`, `claude` and `codex`. When unset, the first settling pass preserves an installation already holding folder agents on OpenCode; a fresh installation prefers an installed Claude, then Codex, then OpenCode. This is an installation check, not a login check. The result is saved, and a user choice made during detection wins. Installing another CLI later cannot silently move an agent onto a different login or permission system.

A recognized `runtime.engine` wins. Without one, a concrete credential or model retains OpenCode; an empty runtime or a complexity-only runtime follows the machine default. Unknown future engine names use that tolerant fallback; a recognized but unimplemented launcher such as Gemini is explicitly refused at dispatch. Kit and bare runtime storage follow the same precedence.

CLI engines leave the desktop credential ladder before its first lookup. Claude maps complexity to a model alias; Codex maps it to reasoning effort and keeps its CLI default model unless one is declared. See [Codex](codex_engine.md) for configuration ownership, approvals and readiness.

[Account build sessions](../local_dev/build_sessions.md) use these same launchers and credential/model resolver, with separate installation-wide settings. Default Runtime inherits this machine engine, while build complexity is independently Complex by default (Claude Opus, Codex high effort, OpenCode Complex tier). Builder settings do not rewrite folder manifests or the local-agent default.

### Process ownership, startup and idle reaping

The pool starts a process on the first turn that needs it and keeps it while turns keep coming. Both ends of that are measured rather than assumed:

- **Idle is expensive.** An idle `opencode acp` holding one session is **311 MB of physical footprint** (499 MB RSS, of which the 144 MB binary is mapped). The Claude adapter is lighter — ~100 MB idle, ~400 MB once its `claude` child is up. A dozen folder agents started at boot would be gigabytes of a user's machine spent on nothing, which is why nothing starts at boot and why the reap window is two minutes rather than the five the plan first assumed
- **A cold start is about a second.** Spawn to `initialize` is 631–695 ms for OpenCode and 181–284 ms for the Claude adapter, plus roughly 300 ms to `session/new`. That second is paid by the turn that asked for it, which can afford it; an idle app holding a gigabyte cannot

Two refusals of the obvious follow:

- **Nothing is respawned automatically.** A process that exits stays exited and shows as `exited` on the agent page; the *next* turn starts a fresh one. An agent that crashes on start would otherwise be a respawn loop burning CPU on a machine whose owner is not even looking at it
- **Reaping is time-based, so a turn takes a hold rather than being inferred.** A turn can be quiet for minutes — a long command, a model thinking, a permission ask parked waiting for a human — so idle time is the wrong signal for "in use". The clock starts when the last hold is released
- **Background work defers the reap, up to a ceiling.** With no turn holding it, a process can still be running a background shell or a subagent that the user is waiting for, and a reap would kill that work with it. So while [session activity](../session_activity/session_activity.md) shows running work for the agent, the reap is looked at again after another window. After 30 minutes with no change to that work and no turn, the process is stopped anyway, and the work is shown as lost. A process whose background task never reports again must not stay up forever

**The whole tree is killed, not the child.** An ACP agent is rarely one process: the Claude adapter spawns `claude`, which spawns whatever the model asks for, and `opencode acp` forks its own workers. Each child is spawned as a process-group leader so the group can be signalled. Without that, quitting mid-turn left a ~260 MB `claude` running in its own process group with nothing left that knew it existed.

**Quit kills every live process before it yields, because nobody awaits the shutdown.** Electron does not await a `will-quit` handler, so anything the pool does *after* its first `await` may simply not happen — a single pass that waited on each in-flight start before killing anything left every already-running agent alive too, since the loop yielded on the first entry and the app was gone. So the running processes are disposed first, synchronously as far as the kill; only then are the starts in flight waited out, because a process that finishes starting after the app is gone is an orphan holding a session open. **That second half is the one an unawaited quit can lose** — about a second per agent that happened to be starting — and it is written down rather than papered over: refusing to start a process while quitting would need a flag the pool does not have.

### The launch spec's `key` is what "the config changed" means now

A running process froze its binary, its arguments, its environment and any config file it read at start. The launcher summarises all of that into one digest, and the pool replaces a process whose key moved before the next turn starts.

That single mechanism replaces the whole reconcile apparatus: two digests compared against a record taken from a running server, an `ensureRunning` choke point, seven fire-and-forget `applyConfigChange` calls, and a rule about never restarting while a turn streams. The properties survive, by construction rather than by discipline:

| Old mechanism | What replaces it |
|---|---|
| Config digest compared against the running process | The config bytes are digested into the spec key |
| Credential digest, because a rotated key leaves the config identical | The credential map is digested into the same key |
| `turnLock.anyHeld()` gating every restart | A turn holds its own process; the replacement happens at the next turn |
| Deferring a config change while any turn streams, writing nothing | There is nothing global to write |
| Per-site `applyConfigChange` calls on seven channels | Nothing to call: the config is generated at the top of the turn that uses it |

**The key is a digest and never the values.** The environment behind it carries decrypted API keys; the pool logs the key. `types.ts` promises it holds no secret, and `specKey` is what keeps that promise.

### A config per agent, written where the user's folder is not

The generated config is the shared server's config **minus the server, and minus every other agent**: `buildEngineConfig` is reused verbatim for the provider and agent entries, so a folder agent's prompt, model and permission profile are byte-for-byte what the HTTP engine loaded. What changed is the scope — one file, holding one agent and only the provider that agent uses, under `<userData>/acp/opencode/<hash of agent id>/`.

- **One agent per file** because a process that serves one agent has no reason to be told about the others, and because the config feeds the spec key: a file that changed whenever an unrelated agent was edited would retire this agent's process for nothing
- **The directory name is a hash of the agent id**, not a sanitised form of it. An agent id is `folder:<uuid>` and not a path component, and two ids differing only in a character the filesystem folds must not share a directory and hand one agent the other's prompt — the same reasoning as the agent key's hash suffix
- **Written to a temp file and renamed.** The engine reads the file at start, and a process that died halfway through a plain write would leave a truncated config for the next turn to spawn an agent on. The rename is atomic within the directory, so a reader sees either the old file or the whole new one
- **The model is stated twice**, in the config's top-level `model` and again on the session. The agent entry's own `model` is ignored over ACP — verified: selecting a mode never moved the session's model, and an agent pointing at a non-existent model still ran on the session default — so either statement alone is a way for a turn to run on a model the user did not choose

### Which agents get an entry, and which are refused

| Situation | Result | Where the user learns why |
|---|---|---|
| Readiness `invalid` or `contract_too_new` | **Refused before the launcher is asked at all.** A folder that does not validate has no business being handed to a model: its prompt files may be half-written and its manifest may say anything | The turn error, and the readiness strip on the agent page |
| The agent is switched off | **Refused**, in the same place. `enabled` is the user's own choice and the turn is the one gate on it | The turn error |
| The runtime names an engine this build cannot run (`gemini`) | **Refused in words** — "This agent runs on an engine this version of Cinna does not support." A launcher that does not exist is never guessed at, and the row's value is never read as the default | The turn error |
| Runtime resolves to no credential the engine can use, or to no model | **Refused by the OpenCode launcher**, using the same code the config generator produces (`credential_unavailable`, `no_model`) | The turn error, and the "Runs with" panel's status line |
| No `opencode` could be resolved, or the selected `claude` / `codex` is missing or definitely logged out | **Refused by the launcher**, in a sentence naming the remedy | The turn error; Settings and the panel say the same thing standing |
| Everything resolves | OpenCode gets one generated agent config; Claude/Codex get their launcher-specific instruction and approval setup | — |

A credential is offered to the generator when the user has it switched **on** and `isCredentialUsable` says it can make a call at all: it is not flagged `unsupported` (an Anthropic OAuth token is not an API key) and it either has a stored key or is of a **keyless** type, which needs none. That predicate is shared with the "Runs with" panel and every picker on purpose — a hand-written `hasApiKey` here would have made the panel offer a credential the generator then silently refused. Own **and** server-managed credentials both count. A key the keystore refuses to decrypt is skipped with a warning rather than failing the whole plan; the other credentials still work.

**A credential the user has switched off is left out, and that is a decision about spending rather than about cataloguing.** The check was missing for as long as the collector existed, and it was worst where it mattered most: a *canonical* type carried a real, decryptable key into the config, so an agent kept running — and kept billing — after the user turned that credential off in Settings. See [Switching an AI Credential Off](../../llm/adapters/credential_enablement.md).

**Every folder agent is collected now, whichever engine it names.** The collector used to drop everything but OpenCode, because one shared config served every agent at once and a Claude runtime resolves to no credential — so the generator would have reported a healthy agent as "its credential is not available to it", a sentence about a key it does not spend. The caller is now the OpenCode launcher planning one turn for one agent it was chosen for, and it is chosen by reading the folder, so it is never asked about an agent on another engine; filtering here would only decide what a question nobody asks gets answered with.

### `enabled` is the turn's gate, and it exists

The generated config still does not consult `enabled` — a switched-off agent would get an entry if one were generated for it. What changed is that the obligation is discharged: the ACP driver refuses a disabled agent *before* it plans a launch, in the runners' own sentence ("… is switched off. Turn it back on to chat with it."), so the config never gets the chance to be generated. The gate is in one place; deleting it makes a switched-off agent chattable.
### A Gemini credential does not become OpenCode's `google` provider

Every other credential type maps onto the engine's own name for that provider, or onto a custom entry when the canonical name is taken. Gemini is the exception, and the reason is a hard limit rather than a preference: **the engine can build a working model out of three SDK packages, and Google's is not one of them.**

Emitted under the canonical `google` key, a Gemini credential looks entirely healthy right up to the moment it is used. The models appear in the engine's catalogue, they count as available, the “Runs with” panel offers them, a session opens against one — and then the turn fails inside the engine with `UnsupportedApiError` and **no event at all**, so the desktop sits in its streaming state until its own twenty-minute ceiling. Nothing on the way in warns anybody, which is what makes it worth a rule rather than a comment.

So a `gemini` credential is emitted as an **OpenAI-compatible entry pointed at Google's own OpenAI-shaped endpoint** for the Gemini models. Same key, same models, a transport the engine can actually drive. The canonical `google` entry is not emitted at all — there is no value in offering the user a provider whose every turn would hang, and leaving it in place would also let the “Runs with” panel present two ways to reach the same credential, one of which never works.

Two consequences worth knowing. Gemini's models arrive with no models.dev catalogue behind them, so they are declared with the same per-type ceilings every custom entry uses (below). And the compatible transport sends no `max_tokens` at all, so on this route that ceiling shapes nothing in the request — Google applies its own.

**An Ollama credential is never emitted under the canonical `ollama` key either, for the opposite reason.** models.dev publishes one, and its model list is real — but it is the catalogue of what Ollama offers for *download*, not what this machine has pulled. A canonical entry would therefore offer dozens of models that 404 the first time an agent is pointed at one. The custom entry declares exactly the tags `ollama list` reports, against the host's OpenAI-compatible `/v1`. See [Local Models & Keyless Credentials](../../llm/local_models/local_models.md).

### A second credential's models have to be told how big they are

A provider entry comes in two shapes, and only one of them gets anything for free. A **canonical** entry — the first Anthropic credential, the first OpenAI one — uses OpenCode's own key for that provider, so the engine already knows every model it has and how large its context and reply windows are. A **custom** entry does not exist in any catalog: it is a key the desktop invented for the *second* credential of a type, or for an OpenAI-compatible gateway, and the engine knows only what the generated config tells it.

**What it defaults to when told nothing is zero**, and zero is not "unset" — it travels to Anthropic as a maximum reply length of nothing, and the request is rejected. Every folder agent running on a second Anthropic credential failed on its first real turn for that reason, with a message about `max_tokens` that named nothing the user had ever configured.

So the generator declares a context and output ceiling for every model of a custom entry, from a small table in `modelLimits.ts` keyed by credential type. **Those numbers are floors, not facts about a particular model.** The desktop does not know how large any individual model's windows are — a runtime carries a model's name and id and nothing else — so each figure is the largest one valid across everything that type currently offers. The two ways of being wrong are not symmetrical: too high is rejected by the provider on the first turn and is therefore loud, while too low quietly shortens a long answer and nothing reports it. That is the one to watch for, and it is why the table says where real numbers would come from (each adapter's `listModels()` already asks the provider, and could return the windows it publishes).

A canonical entry is deliberately left alone. Emitting our floors over the top would replace true numbers with approximations — for Sonnet 4.6 it would have cut the reply ceiling from 128000 to 32000.

The Ollama row of that table is the one where the cautious direction is genuinely ambiguous. A local model's true window is a property of the weights and of the `num_ctx` the server was built with — commonly 4k, sometimes 128k, unknowable from the tag — and claiming too much does **not** fail loudly the way an oversized `max_tokens` does: Ollama truncates the context silently. So the pair is small enough to be true almost everywhere (`32768` / `4096`) rather than large enough to be useful somewhere. It is also the one provider where the truth is available for the asking — `/api/show` returns the per-model context length — which is why threading real windows through `listModels()` would pay off here first.

**A custom entry's models report `capabilities.tools: false`, and that does not mean what it looks like.** Ours is the only entry in a 32-model catalogue that reports it, and the obvious reading is that a folder agent on a custom entry gets no tools. It is wrong: measured on 8 Sep 2026 against opencode 1.18.27 and a real Ollama, with a logging proxy in between, the session runner sent the agent's full set of **12 tools** regardless. The flag is catalogue metadata, not a gate on what a turn is given. Nothing therefore emits `tool_call: true` to "fix" it — doing so would change nothing about tool use while asserting tool-calling about every model of every custom entry, including small local models that genuinely cannot do it, turning a graceful degradation into a 400.

### A key is never written into the config

Every provider entry names the environment variable its key travels in (`env: ["CINNA_ENGINE_KEY_…"]`) and the value reaches the engine only as process environment (Invariant 4). **Naming the variable, rather than writing an `{env:…}` placeholder into `options.apiKey`, is load-bearing rather than stylistic:** the engine's v2 config reader performs no substitution, so the placeholder itself would be sent to the provider as the key and every turn would 401. The `env` form instead registers an integration whose connection the session runner resolves out of the process environment — for a canonical provider key and for a custom one alike. The config file sits at rest in the app data directory and is readable by anything that can read the user's home; writing keys there would make it a plaintext copy of every credential in the app — the thing `safeStorage` exists to prevent.

The environment variable name is derived from the provider id so it is stable across regenerations, and hash-suffixed so two ids that sanitise to the same string cannot silently hand one provider the other's key.

**A keyless credential names a variable too, carrying the literal `keyless`, and this does not weaken the invariant** — there is no key involved anywhere on that path, and the placeholder is public by construction (Ollama accepts any bearer token and validates none). It is emitted rather than omitted because of the availability filter rather than tidiness: `env: [...]` is what registers an integration with a live connection, which is the branch every working entry in this config takes, while an entry with **no** `env` would have to fall through to a branch the contract records as transiently false for ~160 ms while the integration list populates. Verified rather than assumed — the entry comes up available, and Ollama receives `Authorization: Bearer keyless` and ignores it.

**That endpoint is gone with the server, and the rule it produced is not.** OpenCode's v1 `/config` returned the *resolved* configuration with `{env:…}` already substituted, which made its response a live copy of every key the engine held; nothing reads it now, because nothing speaks HTTP to an engine at all. What survives is the habit: no engine response is logged wholesale, because the next one to carry a resolved secret will not announce itself either.

### The engine's environment is narrowed, not inherited

An OpenCode process gets **the same narrowed environment a third-party stdio MCP server gets** — `shellEnvForChild` over the resolved login-shell environment — plus an enumerated set of variables added explicitly (`OPENCODE_CONFIG` **and `OPENCODE_CONFIG_DIR`** — the engine has two config readers and they honour different variables, see [the contract](acp_contract.md) — `OPENCODE_DISABLE_AUTOUPDATE=1`, and the credential map). There is no server password to add any more, and nothing is inherited: `spawn` is handed the whole environment the launcher built, never `process.env` with additions.

A Claude process gets a *narrower* one still — `buildClaudeEnv`, which strips every API key, auth token, base URL and third-party-provider switch by name before it hands anything over, so a turn cannot be billed to an account the user did not choose. See [The Claude Engine](claude_engine.md). Codex uses the shared narrowed environment plus `CODEX_HOME`; it excludes shell API keys and adapter overrides while preserving normal CLI user/project configuration. See [The Codex Engine](codex_engine.md).

The instinct is that this should be looser, since the engine is our own binary rather than a third party's. It is the opposite: the thing that *runs inside* the engine is a language model with a bash tool, driven by whatever text arrives in a conversation, and its output goes on screen and into the database. A shell environment handed to it is one prompt injection away from being read aloud, and `ANTHROPIC_API_KEY`, `GITHUB_TOKEN` and `AWS_*` live in exactly the `.zshrc` this app is deliberately sourcing. The narrowing applies with *more* force here than for an MCP server, whose tools at least have fixed schemas.

It also costs nothing: every credential the engine legitimately needs is injected by name from our own keystore, and the agent's own secrets stay in `credentials/.env` where its scripts read them. The login shell is consulted for `PATH` — so `uv`, `make` and `python` resolve — and for nothing else. See [Shell Environment Resolution](../../development/shell_environment/shell_environment.md).

`OPENCODE_DISABLE_AUTOUPDATE=1` is part of the same rule: we pin and verify the binary, and an engine that replaces itself underneath that pin is exactly what the checksum exists to prevent.


### Nothing generated is written into an agent folder

The generated config lives under `<userData>/acp/`. The agent folder belongs to the user — an assistant may have it open, it is very often a git repository, and Invariant 2 says exactly one file inside it is the desktop's (`app-data/desktop.json`). A generated prompt written into the folder would also travel to the cloud on publish.

**The readable prompt artefact is gone with the server, and nothing replaced it.** The shared engine wrote each agent's assembled prompt to `<userData>/engine/prompts/<agentKey>.md` — not for the engine, which reads the copy inlined in the config, but as the file a user's own assistant could open. Per-agent configs carry the prompt inline and write no such file, so the assembled prompt is now visible only in the generated `opencode.json`. The stale-prompt pruning that came with those files went too, and with it the only delete this feature ever performed.

### The cloud catalogue is asked for once a session; the local one, every turn

Every OpenCode turn generates its config from current state, so the model catalogue is consulted once per message. The **first** collection of a session asks every configured credential (`refreshModels` defaults to a full refresh); after that, `refreshModels: false` re-asks the **local** credentials only.

The two halves have different reasons, and stating them separately is what keeps the rule from being simplified into a wrong one:

- **A vendor's line-up is stable and expensive to ask about.** Each `listModels()` is a real network round trip, in sequence, one per configured credential — so asking on every turn would put that latency in front of every message the user sends
- **A local catalogue is not a line-up at all.** It is the set of models on this machine, which the user changes with `ollama pull` between one turn and the next, and which is empty whenever the local server happened not to be running a moment ago. The call is loopback and costs about a millisecond. Without it, starting Cinna before Ollama meant every folder agent on it hung on its first turn until the desktop's own ceiling expired

**"Once" is a completed refresh, not an attempt.** The flag is set only when a full refresh finished, so a machine that was offline at the wrong moment asks again on its next turn rather than running the rest of the session on nothing.

That precision is written down because losing it broke agents in a way nothing reported. Under the shared server the full refresh happened at engine start and only the reconcile asked for local models; when the server went, so did the only caller that ever asked for everything — leaving a cache with no cloud models in it at all. An agent whose manifest names a **Work Complexity** tier on a cloud credential then resolved that tier against an empty catalogue, took the `no_model` skip and was refused every single turn with "its runtime names no model", while its credential and its key were perfectly fine.

**A refresh never shrinks a provider to nothing.** `getAllModels` swallows a per-adapter failure and omits that provider, so "the server was down for this one call" and "this credential has no models" arrive identically; a provider that reported nothing keeps what it last reported, while one that *did* answer is replaced outright so a removed model still disappears. An **empty** live credential list evicts nothing either — before a profile's scopes resolve, the credential database and the adapter registry legitimately disagree.

### Binary resolution, and what "verified" means

**One resolver installs every runtime Cinna manages, and what differs between them is a spec, not a second resolver.** The sources, the staging, the digest check and the single-flight are the same for OpenCode, for [Codex](codex_engine.md) and for [Claude Code](claude_engine.md#which-claude-runs); what differs is a name, a download URL, whether and how the user's PATH counts, whether the installed binary must report the pinned version, whether the asset is an archive or the executable itself, and the sentences a user reads when it fails. The invariant worth having exactly one copy of is *nothing unverified is ever published*, and a second resolver would have been a second place to get it wrong.

| | OpenCode | Codex | Claude Code |
|---|---|---|---|
| Sources, in order | configured path → login-shell PATH → pinned download | configured path → PATH copy **at exactly the pinned version** → pinned download | the same as Codex |
| PATH copy | used at any version: a developer's own install is a fine engine | used only when it reports exactly the pin (`path-pinned`); any other version is ignored and stays what "Open in…" launches | the same, and run from its **real path** because the PATH entry is a symlink the vendor's updater retargets |
| Version gate | none | the binary must print exactly the pinned version — a download that does not is discarded before it is published, a PATH copy that does not is passed over | the same |
| Asset | archive | archive, holding `codex-<target triple>` | the bare executable: nothing is unpacked, the verified file is moved into place under the tool's name |
| Installed under | `<userData>/engine/opencode-<version>/` | `<userData>/runtimes/codex-<version>/` | `<userData>/runtimes/claude-<version>/` |
| Download progress | not reported — about a minute, and the row says so | reported in bytes: about 90 MB is a wait somebody watches | reported in bytes: 215–232 MB by platform |
| Override | OpenCode Path | Codex Path, labelled **unverified** wherever it shows | Claude Path, labelled the same way |

The versions, checksums and byte sizes of all three come from one manifest, `src/shared/runtimePins.ts` — see [Runtime Pins](../../development/runtime_pins/runtime_pins_llm.md).

**The exact-version PATH copy is a saving, not a second trust model.** It passes the same version gate a managed install passes, so the version under test is still the version that runs; all it spares an up-to-date user is the download. It is **version-gated, not checksummed**, and the surfaces that name it say so (*your own install, the tested version*). It is consulted only while there is no managed copy: once Cinna has its own verified file that is one `stat`, and it cannot change under a running app the way a self-updating install can. Because the user's copy *can* change, its identity — real path, size, modification time — is remembered with it, and a remembered binary whose identity has moved is resolved again: the version is gated afresh, and a download follows if it no longer matches.

Set or clear an override in **Default → Local Development → Developer Tools**, as **OpenCode Path**, **Codex Path** or **Claude Path**. The table above it reports the engine resolver's actual version and path; opening the page only reads that state. Runtime choice and a failed-runtime retry remain under Default → Agents → Runtime.

> The staging, verifying and atomic publishing described below lives in `src/main/managed/managedAsset.ts` and is shared with the [local-development toolchain](../local_dev/local_dev.md), which installs uv and Mutagen the same way. `binaryResolver.ts` keeps what is genuinely about a runtime binary: the per-tool specs, the sources and their precedence, and the `--version` probe. `EngineBinaryError` widens the shared `ManagedAssetError` codes with its two "your configured path is wrong" cases and `version_mismatch`, for a verified archive whose binary then reported a version other than the pin.

- **A configured path that is not a runnable file is an error, not a silent fallback.** The user pointed at something specific; quietly running a different engine than the one they named is worse than saying the path is wrong. No version pin is applied to it, for either tool — the point of setting it is to run the one you named, and the UI labels a configured Codex unverified rather than refusing it. **All three tools say it the same short way, and in two wordings by where it is read.** Everywhere else — a chat error, the Runs-with panel's reserved line (414px at the 800px minimum), the Runtime row — it names where the fix is: *"OpenCode path is not a file — fix it in Local Development."* Under the tool's own Path field and in the Local Development tab's table it reads *"… — fix or clear it."*, because sending the user to the tab they are already on is a redirect to nowhere. OpenCode's used to be a longer remedy-first sentence (*"Fix the engine path in Settings, or clear it: …"*) sized for the panel line; it now takes the Codex and Claude form, which fits that line with the remedy intact (ux_rules rule 7). The unsupported-platform sentence has the same two wordings: *"Set a Codex path in Settings → Local Development: …"* elsewhere, *"Set a Codex path: …"* under the field
- **A `which` hit that will not run is not fatal** (OpenCode only; for Codex and Claude a PATH copy that will not run, or reports another version, is simply passed over) — it falls through to the managed copy rather than stranding the user on a broken install
- **The pinned download is verified against a recorded SHA-256 before anything is unpacked.** The digests pin *those exact bytes*: a re-tagged release, a compromised CDN edge or a truncated transfer all fail and nothing is unpacked. They are **not** a signature. Bumping a version means recomputing every row for it, from bytes downloaded from the vendor's own release and never from a listing
- **A failed verification leaves nothing a later run could mistake for a good install.** Everything happens under a per-attempt staging directory and only a fully downloaded, verified, unpacked tree is renamed into place — so the presence of `<userData>/engine/opencode-<version>/opencode` *is* the proof its bytes were checked
- **For Codex and Claude Code the digest is not the last check.** The unpacked binary is renamed from its target-triple name to `codex` *inside staging*, so what gets published has one name on every platform (Claude's bare executable is moved to `claude` the same way), and is then asked its version before the publishing rename. The digest proves these are the pinned bytes; the version proves the pinned bytes are what the manifest says they are. A wrong answer publishes nothing and is reported as a version mismatch, not as a missing binary
- **A successful install removes what it supersedes — once the new copy has answered, and never a version used this week.** That tool's other version directories, and any staging directory no install in this process is using, are deleted after a fresh install whose binary then ran its `--version` — never on "already there", which keeps the everyday resolution at one `stat`, and only directories named `<tool>-<digit>…`, so OpenCode's own config beside them is not a candidate. *After it answers*, because a fresh install that will not run must not cost the user the older version that does. *Not within seven days of use*, because two builds with different pins sharing one `userData` — a dev build beside a release — deleted each other's copy on every install and downloaded it again on the next launch. "Used" is the version directory's modification time, stamped by every successful managed resolution and re-stamped at most hourly while an app left open keeps answering from memory; an unreadable directory counts as recent. The price is at most one stale generation on disk until the first fresh install after it has sat idle a week. Nothing did this before: a pin bump left the previous tree in `userData` for good, and a download killed by a quit left its staging directory beside it. Best-effort throughout, because a tree that will not delete costs disk while failing the install over it would cost the user their runtime
- **Two callers racing resolve to one install**, per tool: an OpenCode install and a Codex install are different downloads and neither joins nor reports progress for the other. Whoever renames first wins; the loser keeps the published tree, which passed the same digest check
- **The resolution is memoised per configured path, and a failure is never cached.** Two turns starting together share one resolution rather than downloading the same 46 MB archive twice into the same directory; a path the user has just changed in Settings is resolved **when it is saved**, for all three tools, so the status row follows the save by itself (see [The Codex Engine](codex_engine.md#recover-installation-or-login-readiness)). For OpenCode that is recent: its path used to take effect only on the next turn or *Try again*, and the field carried a warning line — *"Used from the next agent run. The status above is still the old path."* — to explain a version line that had not moved. Clearing the path resolves at once too, so it can start the managed download straight away. **A remembered binary is checked against the disk before it is handed out**: the memo lasts the whole run, and an install directory can be deleted under it — by the user, by a cleaner, by a newer install sweeping old versions — after which answering from memory spawned a path that was not there, for every turn until a restart. One stat per turn; a missing file is resolved again, and two turns that notice together share that resolution. Because the resolved path feeds the launch spec's key, correcting it also replaces the running children — under the shared server this was the difference between a setting that took effect and one that appeared to do nothing
- A platform absent from the pin table is not a crash: the error says plainly that the user has to install `opencode` themselves, and source 2 then finds it. musl-only distributions (Alpine) are the known gap. For Codex the unlisted platform is Windows — its release archive is several executables, not one — and for Claude Code it is Windows too, where the launcher's environment rules and the login probe were never verified; each sentence points at that tool's path setting instead, since a PATH copy counts only at the pinned version
- **A download is abandoned after 60 seconds without a byte, not after a fixed time for the whole transfer.** The timer restarts on every chunk, so a slow link that is still delivering is never cut off. The old whole-transfer limit of ten minutes was sized for tens of megabytes: a 215 MB Claude Code could not meet it on anything under about 3 Mbit/s, and since a failed download keeps nothing, every retry started from zero and failed the same way. An absolute ceiling remains only to catch a server that trickles for ever — the time the expected bytes would take at 32 KB/s, never less than ten minutes, just under two hours for Claude Code. The pin row's recorded size is also the download's size ceiling (exact for a pinned file, and what lets a 215 MB executable past a guard sized for archives without loosening it for everything else) and the progress denominator when the server declares no length. An abort reads as why it happened — *stalled* or *took too long* — not as an abort
- **One log line per resolution names the tool, the source, the version and the path.** The reuse sources — a configured path, a PATH copy — used to leave no trace, so a log could not say which file a session had actually run

### The binary state is about a file, not a process

`EngineBinaryState` is `unresolved | resolving | ready | failed`, and it is the whole of what the UI knows about "the engine". The managed Codex and Claude Code CLIs use the same shape, each on its own channel, so Settings renders every row from one vocabulary and none can be painted with another's state; `resolving` carries `received` / `total` only while bytes are arriving and only for a resolution that reports them, and their absence means "looking", not "0%" — which is why a row in that state reads *Checking…* and not *Installing… about 215 MB*: an exact-version install of the user's own resolves on a `--version` alone, and no byte may ever arrive. `unresolved` and `resolving` also carry `assetBytes`, the exact size of **this platform's** pinned asset, so "about N MB" before the download and "of N MB" during it are one number; it comes from main because only main knows the host. It carries the resolved path as **text** for Settings to show, the source, and the version; it carries no handle, no address and no pid, exactly as the old `EngineState` did not. Two rules keep it honest:

- **Reading it never starts a resolution.** `engine:binary` answers from memory and says `unresolved` until something has actually looked, so opening Settings cannot trigger a download. The Codex and Claude reads go through the service's `peek`, which looks **without downloading**, because unresolved *in this run* is not "not installed": a managed copy from an earlier run is on disk, and an exact-version install of the user's own would be reused, and a row reading "installs on first use" above either would be a false claim. **One look, shared**: a hit becomes the service's `ready` state, so the settings row, readiness and the login probe all read one answer and cost one `--version` between them; a miss is believed for a minute. A disk-only look used to leave a user on their own install with a login reading `unknown` beside a row that had probed PATH and said all was well. It seeds the *state* only — the first turn still resolves properly, which is where a configured path is actually run and a managed copy is stamped as used
- **A failed resolution is a state, not an exception.** `engine:resolve` returns the failed state with its sentence rather than rejecting — every caller has to render the failure either way, and `ipcMain.handle` would drop the code off a rejection

### What went away with the server, and what took its place

Named plainly, because a reader who knew the old design will look for these:

| Gone | Because |
|---|---|
| `engineManager` — spawn, health check, reconcile, stop epoch, request door | There is no shared process to manage |
| `engine:start`, `engine:stop`, `engine:skips` | Nothing to start or stop; a skip list described a config one shared process had loaded |
| Loopback port, `--hostname 127.0.0.1`, the per-start Basic-auth password | An ACP process talks over its own stdio and listens on nothing |
| `writeEngineConfig`, the prompt files and their pruning | A per-agent config is written by its launcher, with the prompt inline |
| `turnLock.anyHeld()` as an engine guard, and the deferral it protected | A turn holds its own agent's process |
| The `EngineSkips` list and its IPC channel | A refusal belongs to the turn that was refused, and is worded where it happens |

The one thing that did *not* change is the invariant every one of them existed to serve: an agent never runs on a key, a model or a prompt other than the one the user chose, and a running turn is never disturbed by a change the user made elsewhere.
### Runtime resolution: the agent's own runtime, then the Default runtime

A runtime is `{engine, credential, model}`. The credential and the model are resolved from two sources, in order: the agent's own declared runtime, then the **Default runtime** derived from the user's default chat mode. (A runtime naming the Claude engine leaves this ladder before its first step — it has no credential, and running it through branches written about credential rows reports a healthy agent as broken. See [The Claude Engine](claude_engine.md).) It may name the model outright (`runtime.model`) or name a work complexity instead (`runtime.complexity`); both arrive at a model through the one chain below.

**Where that declaration is *stored* is not this service's business.** A kit agent states it in its manifest's `runtime` block; a [bare agent](bare_agents.md#a-bare-agent-picks-its-own-runtime-and-the-answer-is-kept-where-the-folder-is-not) has no manifest and states it in that agent's state under `<userData>`, because the desktop writes nothing into an adopted folder. The scanner puts both on `LocalAgentDto.runtime`, so `runtimeService.resolve` and `engineConfigSource` read one field and neither has a branch for the second kind. Everything below therefore says "the agent's runtime" where it used to say "the manifest", and the sentences about a **file the user commits** are true of the kit half only.

**There is deliberately no third source for a credential.** A "first credential that happens to have a key" fallback would make an agent run on a credential the user never chose and never saw — a billing surprise at best.

The fallback is per-field rather than all-or-nothing:

- A manifest naming only a model borrows the default's credential
- A manifest naming a credential this machine does not have falls through to the default **for the credential** but keeps its own model — an agent that asked for a particular model asked for it regardless of which key pays for it — and carries a reason line naming what it asked for and what it got instead. A manifest naming a *tier* keeps the tier and resolves it against the credential it actually got, which is the only catalogue there is to resolve against; resolving it against the catalogue of the credential the file names would label a model no key on this machine can serve
- A manifest naming only a credential borrows a model through the chain below, which is **not** "the default's model, always"
- Only when neither source yields a credential (or a model) is the runtime unresolved, and the reason line says which is missing

The Default runtime honors the local/account mode precedence and managed per-profile model override. AI Functions has its own Features credential/model binding; drafting and execution may deliberately differ. See [Account-Provisioned Providers & Chat Modes](../../llm/account_provisioning/account_provisioning.md) and [Chat Modes](../../chat/chat_modes/chat_modes.md).

**A Default runtime that cannot run says which half is wrong.** Both branches — this machine's pinned agent credential, and the user's default chat mode — once reported only a *missing key*, so an agent that declared no credential of its own said nothing at all when the default's credential was switched off: the panel claimed it was fine and the first turn failed. The sentence now names whichever setting chose the credential, so the user knows whether they are being told about a machine-wide pin or about their default chat mode, and it distinguishes "no API key" from "switched off" because the two want different remedies. A pinned credential that cannot run is still reported *as* the runtime rather than falling through to the chat mode — re-pointing an agent at another key without being asked is the billing surprise this service refuses.

**A credential reference is resolved by one shared function**, `findCredentialByReference` in `src/shared/credentials.ts`: an id, then a name, then a provider type, with name and type matched case-insensitively. Where two rows answer one name — a managed `Anthropic` beside the user's own — the tie-break prefers one that can run, then one that merely has a key, then whatever matched; a reference matching only unusable rows still resolves, so the panel can say *why* rather than calling the credential absent. It lives in `shared/` because the "Runs with" panel resolves the same reference on the other side of the bridge, and the two copies drifted the moment this one learned to prefer a credential that is switched on. See [Switching an AI Credential Off](../../llm/adapters/credential_enablement.md).

#### A model is lent only where it can actually run

A model id means nothing on its own. The generated config names a runtime as `<credential>/<model>` verbatim, so an OpenAI credential paired with `claude-sonnet-4-5` is an entry that writes cleanly, passes every check this app makes, and fails on the agent's first turn. That pairing is exactly what a manifest naming only a credential used to be given: the default chat mode's model, whichever credential the user had chosen.

A runtime that names no model takes one from this chain, in order:

1. **The default runtime's model, when the chosen credential is the default's own row.** Same credential, so it is the choice the user already made once
2. **The chosen credential's own default model**, set in Settings → AI Credentials. It is the user's answer to "what should this key run", and it is also the step that covers a default chat mode left on *First available*, which names no model at all
3. **The default runtime's model again, when the two credentials share a provider *type*.** A model id belongs to a provider's catalogue, not to one row of ours: `claude-sonnet-4-5` is as valid on a second Anthropic key as on the first, so a personal key alongside an account-provisioned one keeps a working agent. **`openai_compatible` and `ollama` are excluded** — two gateways behind that type are two different catalogues that merely share a wire format, and two Ollama hosts are the sharper case still: a catalogue there is literally the set of models pulled onto one machine
4. **The Medium tier of the chosen credential** — the *Medium floor*. The tier a user who expressed no preference would have picked, resolved against the credential they did choose, and never drifting upward into Complex. Medium and not Simple either: an agent silently downgraded to the cheapest model does poor work and gives no clue why, which costs more to diagnose than the tier saves; the mirror-image failure at the top is a bill
5. **Nothing**, and the turn is refused with "its runtime names no model". Better than a model the credential cannot serve: a refusal is a sentence the user reads in the chat, and a state the "Runs with" panel names before they ever send one, while a wrong pairing only surfaces as a failed turn

**There is still deliberately no "first model in the catalogue" step, and the floor is not one.** This chain used to end at *nothing*, on the reasoning that an agent must never run on a model the user did not choose — the same reasoning that keeps the service from inventing a *credential*. Work complexity changes what "choose" can mean: a **tier** is a class a user can hold an opinion about, it stays true across model releases, and the desktop can resolve one against any catalogue. So the floor is Medium, resolved against a credential the user *did* pick. What it replaces is a dead end — an agent that named no model at all, could not run, and said so only on a panel the user had to go and find.

**The credential is untouched by all of this.** Inventing one would be a billing surprise on a key the user never chose; running the middle model of a key they already chose is not.

The chain lives in `src/shared/runtimeDefaults.ts` (`resolveRuntimeModel`, which still uses `inheritedModelId` for steps 1–3) rather than inside this service, because the panel's `Default (…)` label has to name the same model. It did not: the label named the default chat mode's model whatever credential was selected, so the user read one runtime off the screen and the engine built another. One function, called from both sides, is what makes the label and the config unable to disagree. That invariant is not a one-off repair — building the floor on top of it turned up three more places the two sides had drifted apart, and each is recorded under [The panel and the engine must answer with one function](#the-panel-and-the-engine-must-answer-with-one-function).

The Default runtime runs the chain too, not only the manifest path: its own model goes through the same flattening, because a default chat mode left on *First available* names no model and the credential's own default is the answer. But a manifest with no `runtime` block is **no longer short-circuited to that result verbatim**. That early return had to go with the floor: with it in place the commonest agent there is — a freshly scaffolded one, which declares no runtime at all — was the one agent the floor could never reach. The floor is deliberately *not* applied to the Default runtime itself, either; flooring there would resolve Medium against the *default* credential's catalogue and then lend that model to an agent running on a different key.

#### How a tier becomes a model

`simple` / `medium` / `complex` are resolved against the **live catalogue of the chosen credential**, by model *family*, in `src/shared/modelFamilies.ts`. Not against a table of model ids: a table is out of date the week a provider ships something, and the whole reason a tier is written into the manifest instead of an id is that it does not go out of date. `claude-sonnet-6` classifies as Medium the day it appears, with no app update, and the same machinery answers the neighbouring question — what to run when the id an agent is pinned to is no longer listed.

The rules that are not obvious from the outside:

- **The family patterns are boundary-anchored.** `gemini` contains the substring `mini`, so a bare match would file every Gemini model under Simple. Order matters too: `nano` is tested before `mini` so a `-mini-nano` id cannot be read as a mini, while `mini` is the one preferred at equal version
- **A credential of an unrecognised type is matched against every family**, not against one provider's — every family *except* the catch-alls. An `openai_compatible` gateway proxies other people's models, so the id is the only evidence there is about what it is, and a rule that matches everything is not evidence: without that exemption, adding a catch-all for local models would silently have given every unrecognised gateway model a tier it never had
- **A local model is tiered by its parameter count, not by a product name.** A vendor's line-up is a product decision — Haiku is the cheap one because Anthropic says so — and Ollama has no line-up, only whatever the user pulled, tagged `name:size`. `qwen2.5-coder:1.5b` and `qwen2.5-coder:32b` are the same product in different tiers, which no name-based rule can express. Under 5B is Simple, 5–19B Medium, 20B and up Complex: a statement about *time* on this machine, the same axis Work Complexity means by "fastest" and "slowest". Those rules sit last, so a gateway proxying `claude-3-5-sonnet` still reads as a Sonnet while the same gateway proxying `llama-3.1-8b-instruct` gets sized. An **unsized** tag (`llama3:latest`) falls to a catch-all that resolves to Medium rather than to nothing — Ollama's default tag is almost always the 7–8B build, and null would leave every tier empty on a machine that pulled only defaults, which is an agent with no model at all. Details: [Local Models & Keyless Credentials](../../llm/local_models/local_models.md#a-local-models-tier-is-its-parameter-count)
- **Preview loses to version.** A stable `gemini-2.0-flash` is a better thing to run an agent on unattended than a `gemini-2.5-flash-preview`, which may be withdrawn. A tier whose whole membership is preview still resolves to its best preview. After that the order is newest, then the preferred family at equal version, then a stable alias over a dated snapshot of it, then the id itself — so the answer is deterministic and a test can pin it
- **Access-gated and non-chat models are classified but never chosen for the user.** Anthropic lists its gated top tiers to accounts that cannot call them, and a provider's catalogue mixes in embeddings and voices; auto-selecting either produces a failure on the agent's first turn rather than an error anyone can act on. Both stay selectable by hand in the Advanced picker — the exclusion is about what may be chosen *on the user's behalf*
- **An empty catalogue never overrides an explicit choice.** A gateway that does not implement `/models` lists nothing, and "nothing lists it" would otherwise mean "substitute it" for every model on that credential. So a declared model with no catalogue to check against stays declared, and a declared tier with no catalogue falls through to the Default runtime rather than resolving to null
- **A tier that resolves to nothing stays nothing.** When the credential lists models but none in the chosen tier, the answer is no model, and the panel says which tier on which credential came up empty. Quietly borrowing the Default runtime's model would run the agent on a tier the user did not ask for — the exact failure work complexity exists to remove
- **A retired model id resolves to its nearest surviving sibling**, same family, preferring the version *above* (an id is retired because something replaced it). The agent runs, the panel says which model it is actually running, and **the manifest is not rewritten** — the file keeps saying what the user wrote. A substitution is reported separately from a failure, so a caller that tests "is there a reason" does not read a working agent as a broken one. The access gate above does *not* apply here: gating is about what may be chosen on the user's behalf, and a user who pinned a model in that family already chose it — the honest substitute for one gated model is the next one in its own line

#### The panel and the engine must answer with one function

This is the invariant the whole area exists for: the “Runs with” panel must never predict a runtime the engine will not build. Both sides call `resolveRuntimeModel`, with the same inputs, and neither derives a model of its own.

Adding a floor is what made three latent divergences consequential, and each is worth naming because all three were survivable right up until they were not:

- The panel built its fallback model from the **raw default chat mode** while the service flattened it through the inheritance chain first. They disagreed for exactly one shape — a second credential of the same provider type, where the service lends the default credential's own default model and the panel lent nothing. Two ways of showing the same emptiness, until the emptiness became a floor the panel would then name a different model for
- The panel resolved a manifest's credential reference against **usable credentials only**, so a configured credential with no stored key fell through to the *default* credential — and with it, the catalogue a tier is resolved against. The panel would have labelled the picker from a catalogue belonging to a credential the agent does not name
- The service handled "the manifest names a credential this machine does not have" in a **branch of its own**, which is how it came to keep its own model while the panel resolved against the fallback. It now runs the same resolution as every other path, against the same credential the panel falls back to

The rule to keep: a new model decision goes into `src/shared/runtimeDefaults.ts` and is called from both sides. A decision made in either caller is a decision the other one cannot see.

### The manifest stores a reference, never a key — and a name, not an id

What the panel writes is the credential's **name**, because the file travels: it is committed to the user's git repository, opened by their assistant, and uploaded to a Cinna instance on publish. Our own row ids are nanoids that mean nothing outside this machine's database.

Reading a reference back tries three shapes, which is what makes a hand-written manifest work — an id (what an older desktop might have written), a name (what this one writes), and a provider type (`anthropic`, `openai` — what a person writing the file by hand would naturally put, and what the kit's schema documents). Name and type matching are case-insensitive and prefer a *usable* credential, because two rows can share a name (a managed `Anthropic` alongside the user's own) and picking the one with no key would strand an agent that is in fact runnable.

Three validations sit on the write, and none is about type safety:

- **A key-shaped value is refused**, using the validator's own pattern, so the desktop can never write a manifest its own validator then flags as a leaked secret
- **A model and a work complexity together are refused**, rather than resolved by a precedence nobody would remember. The contract says the two are mutually exclusive, so writing both would be writing a file this app's own validator then complains about
- **Clearing the fields removes the `runtime` key entirely** rather than leaving `{}` behind, so "no choice made" reads the same in the file as in the UI, and a diff shows the choice going away

**Reading is tolerant where writing is strict**, and the asymmetry is deliberate: a manifest that carries both keys still runs (the model wins), and an unrecognised complexity reads as no complexity at all. Refusing to run such a folder would brick one written by a newer 1.x tool, which is exactly what the contract's "minor bumps are additive and safe to ignore" promises against — see [Kit Contract & Manifest Layer](kit_contract.md#validation-severity).

Unknown keys inside an existing `runtime` block — `permissions`, or something a newer contract adds — survive the round trip.

### The assembled prompt is the folder, read back to the model

The folder already contains everything the agent needs to know; it is just spread across the files the kit teaches an author to write. The generated prompt concatenates them, in this order, `---`-separated:

1. `Local/<slug>/docs/WORKFLOW_PROMPT.md` — the agent itself
2. `Local/<slug>/scripts/README.md`, under "Your scripts"
3. `Local/<slug>/credentials/README.md`, under "Your credentials", preceded by the never-read-the-secret-files rule
4. The **list** of `.md` topics under `Local/<slug>/knowledge/`
5. A handover block separating legacy sibling hints from explicit [task-coordinator handback](../../jobs/tasks/manifest_handback.md) guidance. Main grants eligibility only to the current handed-off task owner; prompt text alone grants none
6. The desktop context block

Four rules shape it:

- **HTML comments are stripped.** The kit's templates carry their author guidance in `<!-- … -->` blocks addressed to *the person writing the agent*. Markdown hides them, so authors leave them in place while filling the sections around them; fed to the model verbatim they read as instructions, which is how a freshly scaffolded agent ends up answering with the template's worked example about invoices. Stripping them is reading the kit's own convention correctly, not taking a liberty with the user's text. An unterminated `<!--` is tolerated — a half-written comment is a state a file is genuinely in while someone types
- **Knowledge is listed, not inlined.** Knowledge is reference material the agent reads when it needs it; inlining a folder of business rules into every turn's system prompt spends the context window before the conversation starts. `knowledge/README.md` is excluded — it explains the folder to a human author, and listing it sends the agent to read about itself
- **An empty workflow prompt never produces a promptless agent.** A stand-in section says plainly that `Local/<slug>/docs/WORKFLOW_PROMPT.md` is empty and suggests the person tell the agent what it should do, so it can write the file in building mode. Without it the model gets only the appendices and answers as a generic assistant, which looks like the agent "not working" rather than like an empty file
- **The result is deterministic given a folder and a context**, which is what makes the snapshot test worth having: the interesting failures here are *omissions* — a section that silently disappears when a file is missing — and a snapshot catches those where an "it contains the workflow prompt" assertion does not

### A bare agent's prompt is one file, and deliberately not the folder

A [bare agent](bare_agents.md) has no manifest, and which document it runs on depends on whether its session is **isolated** or **native** — one field decided where the folder view for a turn is built, never re-derived from the folder's kind.

- **Isolated** — OpenCode today, through the generated engine config: `assembleBareAgentPrompt`, the whole document — the folder's instructions file, comments stripped, plus a desktop context block, and **nothing else the folder contains** — replacing the engine's own preset. Cinna's own build session is isolated too, but on a different document again: it runs on the instructions its development context assembled, which is why `folderSystemPrompt` answers that before it ever asks what kind of folder this is.
- **Native** (an adopted bare folder on Claude or Codex): `assembleBareNativePrompt`, which is *appended* to the engine's preset and carries only what the desktop knows. The engine has already loaded the folder's setup for itself, so the instructions file is pasted in only when the engine running this turn would not read it — `AGENTS.md` and `AGENT.md` for Claude, `AGENT.md` and `CLAUDE.md` for Codex ([Bare Agents](bare_agents.md#the-instructions-file-is-pasted-in-only-for-the-engine-that-would-not-read-it)).

Both paths resolve the instructions file the same way the scan does — the first of `AGENT.md`, `AGENTS.md`, `CLAUDE.md` the folder has — and both share the building-mode wording and the empty-file stand-in, so the two cannot drift apart.

The asymmetry with the assembler above is the whole design. A kit folder has a known shape, so reaching into `scripts/`, `credentials/` and `knowledge/` is safe. A bare folder is somebody's repository, and concatenating whatever `.md` files happen to be in it would put a changelog, a licence or another agent's notes into the system prompt as instructions.

- **`README.md` is excluded on purpose.** It is written for whoever develops the agent — how to install it, how to run it, what it needs — and a model reads "run `uv sync` first" as a step it should take. It is the *builder's* document: the init prompt briefs an outside assistant from it, and building mode names it for the agent to read once the person has asked for a change
- **Three of the context block's rules are dropped rather than reworded** — `uv run`, "write only under `app-data/`", and the `credentials/.env` rule — because each describes a folder convention this folder never agreed to, and stating a rule about a file that does not exist is how a model ends up refusing ordinary work. One line replaces them: follow whatever the instructions above say about running this folder's own tools, because the desktop imposes no convention here
- **Building mode is kept, pointed at this shape's own guide**: `README.md` where the folder has one, read as background rather than followed as steps, and otherwise the instructions file alone. Named, never inlined, so the exclusion above still holds
- **An empty instructions file gets the same stand-in** the kit path gives an empty workflow prompt, and for the same reason. The stand-in names that file; a folder with none of the three gets one listing them, and building mode is pointed at `AGENT.md`, the file it would write
- **The engine reading the file itself is now the design, not a gap — on the native path.** Claude loads `CLAUDE.md` and Codex loads `AGENTS.md`, so the native prompt leaves out exactly the file that engine reads. It stays a gap on the **isolated** path, where the whole document is inlined and OpenCode's own project-rules loading is not switched off, so an `AGENTS.md` or `CLAUDE.md` may reach the model a second time. Recorded in [Bare Agents — Known gaps](bare_agents.md#known-gaps)
- **The bare runtime comes from Desktop State**, or is null when no choice exists. It follows the same machine-engine and credential/model precedence as a kit runtime; adopting a folder adds no new credential fallback

### The desktop context block, and building mode

The appended block is the part only the desktop knows: that the agent starts in **conversation mode**, that a request may come from a person or from an unattended task, and what this machine's rules are — run scripts with `uv run`, write only under `app-data/` while in conversation mode, never print or read a credential value, the user's locale and time zone, long output to a file with a summary in the reply.

**A native bare folder's block is shorter, and says one extra thing.** Everything the folder already states reaches the engine through the engine's own loading, so the block drops to the desktop-only rules — and it says plainly that the runtime *is* the folder's own, naming per engine what that means (for Claude: its settings, hooks, skills and MCP servers, and the user's too; for Codex: its `AGENTS.md`, the user's `~/.codex/config.toml` and this project's trust decision). An agent that assumes a sandbox behaves differently from one that knows its hooks and MCP servers are live, and naming a capability an engine does not have is how a turn ends in a tool that never runs. Building mode's last rule changes wording with it: there is no "instructions above" on the native path, so it says the instructions were loaded when the session started.

It ends with a **Building mode** section. Both folder shapes get the same four rules:

- **A person's explicit request to change how the agent works switches it**: correcting an answer for next time, adding a step or a trigger, fixing a script. It asks for no confirmation and does not send the person to another tool. A local agent is built and used by the same person, so "you got that wrong, add it to your workflow" is the ordinary next message after a wrong answer, and the request *is* the decision. The rule this replaced told the agent never to switch "even if the user asks" and pointed the user at their own assistant or at a "Build with AI" that did not exist. A user asked a local agent to improve itself and it refused
- **The switch lasts the rest of the conversation**, because refining an agent takes several rounds of change and try
- **Only a person's request switches it.** Never on the agent's own initiative, and never for an unattended or handed-over task, where nobody is there to see the change. That is the case the old rule existed for, and the half of it that stays
- **The guide is named only when the folder has one, and never inlined.** A kit folder with an `AGENTS.md` is told to read and follow it: the kit template's own file, which already routes to a Builder role when the user asks to change the agent. Without one, the agent gets a coherence rule over its own definition: `docs/WORKFLOW_PROMPT.md` is what it does, `scripts/README.md` lists every script, and `cinna-agent.json` describes it truthfully. A bare folder is told to read `README.md` for how the agent is organised and developed, **as background and not as setup steps to run**. A repository README is install instructions as much as guidance, and a model told to *follow* it runs `make install` before making a one-line change to its instructions file. Without a README, the agent works from its instructions file alone. A rule that names a missing file is how a model ends up refusing the work <!-- nocheck -->

Building a kit agent may edit whatever in the folder the change needs, such as `docs/`, `scripts/`, `knowledge/`, `config/`, `cinna-agent.json`, the `Makefile` or `pyproject.toml`. It never edits `app-data/desktop.json`, which belongs to the desktop. That is why the `app-data/` rule is limited to conversation mode: building a kit agent means editing everything outside that folder. A kit agent gets one more rule: **keep `cinna-agent.json` and `docs/CLI_COMMANDS.yaml` valid.** If the manifest or command catalog fails validation, the scanner marks the folder `invalid`, and the driver refuses every turn on an invalid folder. A broken edit is therefore one the person cannot ask the same chat to repair. <!-- nocheck --> A bare agent may edit its instructions file, its README where there is one, and whatever else the change needs. The empty-prompt stand-ins point the same way: they tell the person to say what the agent should do.

**Only OpenCode enforces the limit; everywhere else it is text.** On OpenCode the identity files still `ask` ([Local Agent Permissions](permissions.md#the-agents-own-identity-files-ask)). An agent that talks itself into building therefore hits a dialog before it can rewrite its own prompt. So does an edit the person *did* ask for, until *Always allow* is chosen. On [Claude](claude_engine.md) and [Codex](codex_engine.md) nothing singles those files out: their approval settings govern every edit alike, and the prompt text is the only barrier. That is a known, accepted gap. Do not read this section as describing a control.

**An edit reaches the running prompt at different times on each engine.** The prompt is assembled before the turn, so within a turn the agent's own edits are newer than its instructions. What happens on the next turn depends on the engine:

- **OpenCode** regenerates its config every turn with the prompt inline, and the spec key is a digest of that config. A changed prompt therefore replaces the process, and the next turn runs on the new prompt
- **Codex** carries the prompt as `developer_instructions` inside `CODEX_CONFIG` in the process environment, which its spec key hashes, so the same holds
- **Claude does not pick it up in the same chat.** Its spec key leaves the prompt out. The desktop calls `session/load` every turn, and the adapter returns an already-live session unchanged whenever `cwd` and the MCP server list match. The prompt travels in `_meta`, which that comparison ignores. So the chat keeps its old system prompt for as long as the adapter process lives, which is until two idle minutes reap it. A person refining the agent turn after turn may never leave a gap that long. A new chat gets the new prompt at once, because `session/new` reads `_meta` afresh

The last building-mode line exists for that window: when asked for its actual job, the agent is to follow its edited files, because the instructions above were read before its edits. It narrows the gap. It does not close it.

### The permission profile

This generated profile and `runtime.permissions` overrides apply to OpenCode. [Claude](claude_engine.md) and [Codex](codex_engine.md) use their own approval mechanisms; the desktop standing-grant store is shared.

**An agent works freely inside its own folder.** A session's `location.directory` *is* the agent folder, so `read`, `edit`, `write` and `bash` are `allow`; what still asks is what the folder boundary does not cover — `external_directory`, `webfetch`, the agent's own manifest and workflow prompt, secret files, and `sudo` / `rm -r`. This replaced a profile that allowed writes only under `app-data/` and only three shapes of command, which asked about nearly every step of ordinary work: **a permission prompt that fires constantly is not a control, it is a thing users learn to click through.**

The whole profile, each entry with the failure it exists for, plus the matcher rules every pattern in it depends on, is [Local Agent Permissions](permissions.md#business-rules). Two things belong here because they are about generating the config rather than about the policy:

- **`'*': 'ask'` has to be there explicitly.** OpenCode's own base rule is allow-everything — verified by reading `GET /agent` back off the engine while it still had an HTTP API — so a profile that only enumerates `read`/`edit`/`write`/`bash` leaves *every other tool* on allow, which is the opposite of the intent
- **Order inside an entry is the mechanism, not a style choice.** The engine resolves a permission with a `findLast` over the concatenated rules, so `'*': 'allow'` is written first and the narrow shapes after it. Write them the other way round and every narrow entry is dead — and dead in the direction of allow

Answering these prompts belongs to [the turn](agent_turn.md); a user's *Always allow* is recorded per agent in that folder's `app-data/desktop.json` and never sent to the engine.

**A manifest's `runtime.permissions` is merged shallowly, one permission name at a time** — replacing a whole entry rather than deep-merging its pattern map, so an override reads as an override instead of quietly widening `bash` from underneath. Its justification is that the folder is the user's own, so this is a legibility boundary rather than a trust one. Where a manifest does override something, the agent page's Permissions tab names which permissions were replaced, because the fixed description it shows above the list is no longer the whole truth.

> **Flagged for Phase 9.** That justification stops being true the moment a folder is installed from the cloud into a shell-capable engine. A manifest can replace `bash` and the `'*': 'ask'` catch-all outright. Revisit before cloud install lands.


## Known gaps

Carried honestly rather than implied as passing.

- **The download *sequence* has only ever run against fakes.** Every piece is hand-verified against the real binary — the digests, `tar -xf` on a `.zip`, the archive layout, `--version` — but the staging rename and the lost-race branch have never executed end to end
- **The `knowledge/` topic sort is unpinned** — pre-existing; `readdirSync` already returns name order on APFS, so removing the sort passes everything
- **The per-turn cost of generating a config is reasoned, not measured.** Every turn does a keychain decrypt per credential and a full prompt re-assembly (several file reads plus the `knowledge/` walk), and now does it on the turn path unconditionally rather than only when a reconcile ran. Believed to be a few milliseconds; unproven
- **Building mode's limit is enforced only on OpenCode.** On Claude and Codex, the prompt text is all that keeps an agent from editing itself without being asked. Accepted, not pending. See [The desktop context block, and building mode](#the-desktop-context-block-and-building-mode)
- **A Claude chat keeps its old system prompt after the agent edits itself**, until the adapter process is reaped after two idle minutes, because the adapter reuses a live session across `session/load`. Mitigated by the prompt's last building-mode line, not fixed
- **Gemini has no launcher.** It is a recognized unsupported runtime. Codex is implemented and tested with the actual pinned adapter against a scripted app-server peer; real paid-model turns, automatic-review decisions and native sandbox enforcement remain unverified here. See [Codex verification](codex_engine_tech.md#verification-and-limits)

## Architecture Overview

```
Agent page → Settings → “Runs with” panel        Settings → Agents
  credential + model pickers,           Runtime status line; OpenCode path under Local Development
  engine row (binary, not process)      Try again on `failed`
        │                                       │
        ▼                                       ▼
   useEngineBinary / useEngineWatch / useResolveEngineBinary
        │  ▲ engine:binary-state push (nothing polls)
        ▼  │
   engine:binary | engine:resolve  ──▶ engineBinaryService
                                        state · peek() · ensure() · refresh()
                                        (memoised per configured path)
                                              │
A turn (see agent_turn.md)                     │
   driver reads the folder → launcherOfFolder  │
        │                                      ▼
        ├── claude ──▶ ClaudeLauncher      binaryResolver (one spec per tool)
        │                 buildClaudeEnv    configured │ PATH (OpenCode: any; CLIs: the exact pin) │ pinned download
        │                 systemPrompt                  (SHA-256 verified; Codex, Claude: version too)
        │                 model alias + approval mode
        │
        └── opencode ─▶ OpencodeLauncher
                          engineConfigSource ──▶ configGenerator (buildEngineConfig)
                            providers (keys → env: [NAME])   agent entry + inlined prompt
                            runtimeService                    permission profile
                            promptAssembly                    digest → spec key
                                    │
                                    ▼
                    <userData>/acp/opencode/<hash>/opencode.json   (temp + rename)
                                    │
                                    ▼
        spawn: <opencode> acp        cwd = the agent folder
        env  = narrowed login shell + OPENCODE_CONFIG + OPENCODE_CONFIG_DIR
               + OPENCODE_DISABLE_AUTOUPDATE + CINNA_ENGINE_KEY_*
                                    │
                                    ▼
                    acpProcessPool: one per agent, hold while a turn runs,
                    reap after 2 min idle, replace when the spec key moves,
                    kill the tree at will-quit
```

## Integration Points

- [The Agent Turn](agent_turn.md) — the turn that plans a launch, takes the lock, opens the session and translates what comes back
- [The ACP Engine Contract](acp_contract.md) — what was actually watched per launcher, with separate Codex adapter/native-CLI evidence limits, and what is still unverified
- [Agent Drivers & Readiness](../drivers/drivers.md) — the one driver behind all folder engines, the launcher recorded in `driver_config`, and the readiness a list shows
- [The Codex Engine](codex_engine.md) — CLI-owned login/configuration, reasoning effort, sandboxed approvals and adapter packaging
- [The Claude Engine](claude_engine.md) — the sibling launcher: no credential, no generated config, the user's own login, and the approval mode set on every session
- [Agents Home, Scanner & Folder Index](folder_index.md) — the folder agents a config is generated from, the readiness that refuses one, the launcher the scanner records, and the per-agent turn lock
- [Local Agent Permissions](permissions.md) — the profile this generator writes, entry by entry, and the desktop-held grants that answer an ask it produces
- [Agents Tab & Agent Page](agents_tab.md) — the “Runs with” panel, the Settings → Agents engine row, and the stamped `update-field` path a runtime write reuses
- [Kit Contract & Manifest Layer](kit_contract.md) — the `runtime` block in `cinna-agent.json`, the validator's secret pattern reused on the credential reference, and the templates whose HTML comments the prompt assembly strips
- [Account-Provisioned Providers & Chat Modes](../../llm/account_provisioning/account_provisioning.md) — managed credentials are usable runtimes, and the background sync changes what a turn will generate with no hook anywhere
- [Chat Modes](../../chat/chat_modes/chat_modes.md) — the effective default chat mode supplies the OpenCode credential/model fallback
- [Adapters](../../llm/adapters/adapters.md) — `listModels()` is the network call kept off the per-turn path; the registry supplies the model lists custom provider entries need
- [Local Models & Keyless Credentials](../../llm/local_models/local_models.md) — the credential type with no key, its host, the `/v1` suffix a custom entry gets, and the local-only model refresh
- [Switching an AI Credential Off](../../llm/adapters/credential_enablement.md) — why a disabled credential is excluded here, the shared reference resolver, and every surface that reports the consequence
- [AI Functions](../../llm/ai_functions/ai_functions.md) — independent one-shot binding, with a no-tools Default runtime fallback
- [Shell Environment Resolution](../../development/shell_environment/shell_environment.md) — the login-shell `PATH` that finds a user's own `opencode`, and `shellEnvForChild`, the same narrowing a stdio MCP server gets
- [Settings Scope](../../core/settings_scope/settings_scope.md) — the engine is machine-local; `localAgentsEnginePath` lives in the default scope
- [Resource Activation](../../core/resource_activation/resource_activation.md) — every engine channel requires an activated session
- [Main-Process Layering](../../development/main_layering/main_layering_llm.md) — thin IPC controllers; nothing a renderer could execute crosses the bridge

Sub-doc: [Technical Details](engine_tech.md)

## Chat-owned runtimes

Plain chats bind a hidden, profile-owned ACP agent with instructions under userData/chat-conductors. Compatible synthetic profiles share a process keyed by user, engine, credential, model, instructions and tool policy, while each chat retains an independent session/cwd/tool endpoint. This avoids one idle process per identical chat without sharing conversational context. The pool accounts for all owners before reaping or retiring a process.

A synthetic profile cannot read files or run shell commands through native tools. Claude restricts native tools/settings; OpenCode denies native tools and permits attached Cinna MCP tools when its policy allows them. Codex uses a restricted catalog plus startup/session tool restrictions on its exact verified CLI version and POSIX platforms; unsupported configurations fail closed. The adapter's read-only label alone is not this boundary. See [Codex chat policy](codex_engine_tech.md#restricted-chat-and-ai-function-policy). This does not prohibit ordinary folder Codex agents from conducting. See [runtime orchestration](../../chat/orchestrated_agents/orchestrated_agents.md) and [ACP evidence](acp_contract.md).

Catalogs in chat-mode CLI selectors are memory-only snapshots from real session metadata, not a new live model probe. Empty snapshots use explicit model entry and supported fallback aliases. Endpoint/config fingerprints force fresh-session transcript replay when the app restarts or the captured runtime changes.
