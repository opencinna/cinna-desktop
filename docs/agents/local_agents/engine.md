# The Local Engine, Runtimes & Prompt Assembly

> **The engine contract is verified against the real binary — see [The OpenCode Engine Contract](opencode_contract.md).** That document records what was actually watched against `opencode` 1.18.27, what is only assumed, and what was believed and proved false. **Read §9.5 before changing anything about the generated config:** the engine has two config readers, `OPENCODE_CONFIG` reaches only the older one, and the newer one — which decides what a session can run on and what system prompt it gets — substitutes neither `{env:…}` nor `{file:…}`. Three further things it settles matter to everything below: `session.idle` is **never emitted** and `POST …/wait` is **declared but unimplemented**, so the only turn-completion signal is `step.ended` with `finish === 'stop'`; and OpenCode's saved permission grants are **user-global** (`projectID` is always `"global"`), which is why the desktop holds its own — see [Local Agent Permissions](permissions.md). §2 also records how a pattern in the generated `permission` block is actually matched, and which rule wins when two match; **read it before editing that block**, because a pattern that misses fails open.


## Purpose

What actually runs a folder agent: one desktop-managed `opencode serve` process bound to loopback, a generated OpenCode configuration derived from this machine's AI credentials and folder agents, the **runtime** (credential + model) each agent resolves to — from a model the manifest names, a work complexity it names instead, or the defaults below it — and the per-agent system prompt assembled out of the agent's own files.

Phase 5 of Local Agents. It builds the machinery a turn will need and stops one step short of a turn: nothing here sends a message. The **runner** — sessions, streaming, permission prompts — is Phase 6, and the seam it attaches to is `engineManager.ensureRunning()` plus `engineManager.agentKey()`.

## A note on paths

Three trees are discussed and their paths look alike, so they are written differently throughout — the same convention as [Agents Home, Scanner & Folder Index](folder_index.md) and [Agents Tab & Agent Page](agents_tab.md):

| Written as | Means |
|---|---|
| `src/...`, `docs/...` | A file in **this repository** |
| `Local/<slug>/...`, `cinna-agent.json`, `credentials/.env`, `app-data/...` | Inside an **agent folder** |
| `<userData>/engine/...` | Inside the app data directory — the engine's own tree, which **no agent folder ever contains** |

The distinction is a rule, not a formatting habit: the generated config and every generated prompt file live under `<userData>/engine/`, never in the user's folders (Invariant 2). See [Nothing generated is written into an agent folder](#nothing-generated-is-written-into-an-agent-folder).

## The governing principle

**One `opencode serve` backs every folder agent, and the manager records facts about the process it started rather than beliefs about the config it generated.**

Both halves are load-bearing, and both were bugs before they were properties.

*One process* means the blast radius of a restart is the whole app: restarting the engine to pick up agent A's new manifest ends agent B's streaming reply. Every guard in this slice that looks over-broad is over-broad on purpose.

*Facts, not beliefs* means "does the engine need restarting" is answered by comparing what we would generate now against a record taken from the process at spawn — not against a stored "a restart is owed" flag, and not against the bytes on disk. A flag nothing reconciles gets paid twice; a comparison of config bytes cannot see a rotated API key, because a key is never in those bytes.

## Core Concepts

- **Engine** — the one desktop-managed `opencode serve` process. Loopback-only, on a port the desktop picks, behind a per-start Basic-auth password. Shared by every folder agent
- **Engine config** — the OpenCode configuration this app generates into `<userData>/engine/opencode.json`: one provider entry per usable AI credential, one agent entry per runnable folder agent, and a permission profile
- **Generated prompt** — the per-agent system prompt assembled from the agent's own files. It is **inlined into the agent's config entry**, because the engine's v2 config reader resolves no `{file:…}` reference and would hand the model the placeholder in place of the prompt. A copy is still written to `<userData>/engine/prompts/<agentKey>.md` as the readable artefact the user's own assistant opens; the engine does not read it
- **Agent key** — the OpenCode agent-entry name a folder agent becomes (`<slug>-<hash of agent id>`). Stable for the life of the agent, and what Phase 6 binds engine sessions to
- **Loaded config** — the record carried on the running process: a digest of its config-and-prompt bytes, a digest of its credential environment, and the agent keys and skips **that process actually loaded**. Dies with the process
- **Reconcile** — what `ensureRunning` does when the engine is already up: re-derive the config from current state and restart only if the running process no longer matches
- **Runtime** — what an agent runs on, reduced to `{credential, model}` because the engine is always OpenCode. The manifest reaches that model two ways: by naming it, or by naming a **work complexity** the desktop resolves against the credential's own catalogue
- **Work complexity** — `simple` | `medium` | `complex`, written into `cinna-agent.json` in place of a model id. It says how hard the agent's work is and lets the host pick; a model id is the least portable thing that file can carry
- **Default runtime** — the fallback runtime, derived from the user's default chat mode
- **Medium floor** — the last step of model resolution: an agent that would otherwise have no model at all runs on the Medium tier of the credential it was already given
- **Skip** — a folder agent the generated config deliberately left out, with a reason phrase the “Runs with” panel renders in its status line
- **Binary source** — where the running `opencode` came from: `configured` (a path in Settings), `path` (the user's own install, found on the login-shell PATH), or `managed` (the pinned version this app downloaded and verified)

## User Stories / Flows

### Starting the engine for the first time
1. The user opens Settings → Local Agents (or the “Runs with” panel on an agent page) and presses **Start engine** — the button on the **Local engine** row that leads the Engine Settings section, directly above the engine-path field it may need next
2. If Settings names an engine path, that file is used — and an unusable one is an error, not a silent fallback. Otherwise `opencode` is looked for on the login-shell PATH
3. With neither, the pinned build for this platform is downloaded into `<userData>/engine/`, verified against a recorded SHA-256, unpacked and published. The Local engine row says "Downloading the engine. This happens once and takes about a minute."
4. The config is generated fresh (model lists refreshed), written, and a process is spawned on a freshly-picked loopback port
5. The engine answers `GET /api/health`; the status becomes `running` and the version line names the binary and where it came from

### Nothing starts it for you
1. A user who never opens the Agents tab never pays for a 50 MB download: **nothing starts the engine at app boot**
2. Starting is an explicit act — the Settings button, the panel's button, or the first local turn, which calls `ensureEngineRunning` itself
3. So a stopped engine is **not a warning**. The Local engine row reports it with a muted dot and a line opening “Not running — chatting with a folder agent starts it”, and the amber triangle is kept for `failed`. An alarm over a state that resolves itself on the next turn is the healthy state wearing an alarm, and it teaches the user to skip the triangle for the case that does need them ([UX Rules](../../development/ui_guidelines/ux_rules.md), rules 2 and 12)

### Adding a credential while the engine is running
1. The user adds an AI credential in Settings, or the background account-config sync materialises a managed provider on its timer
2. Nothing happens immediately, and nothing needs to: the next time anything asks the engine to be running, the config is re-derived and compared against what the process loaded
3. The config moved, no turn is streaming, so the engine is restarted and comes back knowing the new credential

### Rotating a key
1. The user replaces the API key on an existing credential
2. The config file is **byte for byte identical** — the key was never in it, only the *name* of the environment variable it travels in
3. The credential digest moved, so the reconcile restarts anyway. Without that second digest, every turn would 401 while the UI showed a valid credential and a healthy engine, until the app was quit

### Choosing a runtime
1. The “Runs with” panel on the agent page offers the credentials this app can actually call with, and — by default — **how hard the work is** rather than which model does it: Simple, Medium or Complex. The line under the picker names the model the chosen tier resolves to on the chosen credential, because the user is picking what gets billed
2. **Advanced** swaps the tier for the raw model list. It is remembered, but it is a preference and not a mode: the agent's *own runtime* decides which picker it opens on, since a panel showing a tier over a runtime that pins a model would misreport what the agent runs on. So the checkbox **converts** — a model becomes the tier it belongs to, a tier becomes the model it currently resolves to — and says in the status line what it did, because it is rewriting the runtime behind a control that only claims to change the view. A conversion with nothing to write still moves the view (the file keeps its tier and the line says which); a model that matches no complexity at all — a gateway's hand-written id — leaves the checkbox **ticked and disabled** with a standing line saying why, rather than a control that springs back under the pointer that just used it
3. Both pickers stay disabled until the model registry has loaded — a network round trip per credential — because until then the panel cannot tell a model that belongs to another catalogue from one the registry has simply not listed yet, and cannot say what a tier resolves to at all
4. The `Default (…)` option names the model *this credential* would run, resolved through the same chain the engine uses (see [A model is lent only where it can run](#a-model-is-lent-only-where-it-can-actually-run)), not the default chat mode's model regardless of credential
5. Choosing writes a credential **name** and *either* a model id *or* a tier — never a key, never this app's internal provider id, and never both at once. Into `cinna-agent.json` for a kit agent; into that agent's state under `<userData>` for a bare one, whose folder is never written into. `runtimeService.validate` is the same check on both paths, so the key-shaped-credential and model-and-tier refusals are not something the second writer can quietly skip
6. **Changing the credential drops a model the registry attributes to a different catalogue**, and the status line says which model went and why. Keeping it would write a manifest the config turns into `openai/claude-sonnet-4-5`. A model the registry has never listed is *kept*: it is a hand-written id for a catalogue this app cannot see, so calling it wrong would be a guess. **A tier is never dropped** — that is the whole point of one: `medium` means the same thing on the new key, and a key that lists nothing in that tier produces a warning in the status line rather than a choice quietly disappearing. A credential change carries what the manifest actually holds, and only the one manifest that arrives carrying *both* a model and a tier loses one — the key not on screen — because writing both is a refusal and dropping the unseen one silently is how a tier disappeared while the user was following the panel's own advice
7. A kit agent's write goes through the same stamped `local-agent:update-field` path as every other editable file, so an assistant editing the manifest cannot be clobbered. A bare agent's goes through `local-agent:set-runtime` with **no stamp** — there is no file in the folder for anyone else to have changed, so a stamp there would guard nothing
8. Clearing the choice removes the `runtime` block entirely — `null` in a bare agent's state, the key gone from the manifest — rather than leaving `{}` behind, so "no choice made" reads the same in storage as it does in the UI, and the agent falls back to the Default runtime and below that to the Medium floor
9. The save fires a reconcile, which is a no-op unless the generated bytes actually moved
10. **Which credential of a type it is has a consequence the panel does not show.** The first Anthropic credential becomes the engine's canonical `anthropic` entry and inherits the real context and reply windows of every model. A *second* one becomes a custom entry the engine has no catalog for, so the desktop has to declare those windows itself from a per-type floor — see [A second credential's models have to be told how big they are](#a-second-credentials-models-have-to-be-told-how-big-they-are). An agent on the second key is therefore capped at that floor rather than at what its model actually supports

### An agent that cannot run
1. An agent whose credential has no key, or whose runtime names no model, still appears everywhere — but the config generation **skips** it and records why
2. The panel's status line renders that reason: "The engine skipped this agent because its runtime credential is not available to the local engine." It sits below the panel's own warnings, so the one skip reason that would restate a warning already on screen — "its runtime names no model" — never takes the line
3. Without it the only symptom would be an agent that does nothing when chatted with, which is indistinguishable from a bug in this app

### Editing an agent while another one is answering
1. The user edits agent A's workflow prompt. The save succeeds and fires a reconcile
2. Agent B is mid-reply, so a lock is held. The reconcile logs "the engine config changed while a turn is streaming; deferring" and **returns having written nothing at all**
3. When B's turn ends, the next `ensureRunning` asks the same question of the same process, gets the same answer, and restarts — writing the config and prompts on the way through

## Business Rules

### One engine, so the guards are global

`turnLock.anyHeld()` — not the per-agent `turnLock.isLocked(agentId)` — is the predicate that gates an engine restart. This is the single most consequence-laden rule in the phase, and the wrong version of it **looks correct**: the caller that fires a reconcile is `local-agent:update-field`, which already refuses to write while *that* agent holds a turn, so guarding the restart the same way reads as consistent. It is a live Invariant 3 violation. Editing agent A's manifest would end agent B's reply, because one process serves both.

That defect was in the tree before this phase and was found and fixed here. `anyHeld()` exists for exactly this one caller and says so in its own doc comment.

### `ensureRunning` is the config choke point

When the engine is already running, `ensureRunning` **reconciles instead of returning early**: it re-derives the whole config from current state and restarts only if the running process no longer matches.

That is deliberately not the obvious design. The obvious design is a hook at each site that invalidates a config, and the reason it loses is that the list is incomplete by construction. There are at least five ways to invalidate a generated config today:

1. an AI credential added, deleted or rotated
2. the **background account-config sync** materialising managed providers on a timer — **with no IPC call to hook at all**
3. a managed chat mode's model changing
4. the default chat mode changing (which the Default runtime falls back to)
5. a per-agent runtime written from the “Runs with” panel

Only two of those have a natural place to put a hook. A sixth input — and this feature has eight more phases — would silently defeat a list. Deriving from current state at the moment the engine is about to be used is correct for inputs nobody has thought of yet.

**Per-site `applyConfigChange` calls are a latency optimisation, never the mechanism.** Every channel that can change *which agents exist or what they run on* has one — `local-agent:update-field`, `:delete`, `:folder-add`, `:rename`, `:set-runtime`, `:root-restore-hidden` and `:git-update` — and each is fire-and-forget, never blocks the write it follows, and is a no-op unless the engine is running, the generated digest moved and no turn holds a lock; for `update-field` that is the common case, since most manifest fields the engine never reads. They are there so a runtime change or a removed agent is picked up before the next turn rather than at it. Do not add one in the belief that it is what keeps the engine correct: `ensureRunning` re-deriving the config at the moment of use is, and a site without a call is not a bug. (This paragraph used to say "do not add per-site calls" outright; the delete call was added under review with the reasoning above, and the sentence was reconciled with the code rather than the code with the sentence — a reconciliation the list above has since needed twice more.)

### A changed config never restarts a busy engine, and a deferred change writes nothing

`applyConfigChange` restarts only when the running process's record no longer matches what we would generate. When any turn holds a lock, it returns having done **nothing at all**: nothing written, nothing pruned, no state moved, and no debt recorded.

There is no debt to record because the next `ensureRunning` asks the same question of the same running process and gets the same answer for as long as it stays true — and stops getting it the moment a restart makes it false, whoever caused that restart. A stored `configRestartDeferred` flag existed and was deleted: it survived a restart that had already loaded the change, buying one spurious restart at a turn boundary and ending every other agent's engine session.

**Writing nothing is what closes the finer hazard.** Because change detection is an in-memory digest comparison rather than a compare-against-disk, a change that is going to be deferred is discovered *before* anything is written. That matters because `writeEngineConfig` also deletes the generated prompt file of an agent that is no longer in the set, and rewrites the config a running engine may re-read. Not writing makes the question moot — and it never had to be answered against the real binary. (The prompt-file half of it has since gone away for a different reason: the prompt is inlined in the config, so no file reference is resolved at any time.) The restart regenerates everything from scratch, which it already did.

### Facts about the process, not beliefs about it

Everything the manager knows about *the engine that is running* is recorded on the process object and dies with it: the config-and-prompt digest, the credential-environment digest, and the agent keys and skips that spawn was built from.

Two consequences are contract, not detail:

- **`agentKey(agentId)` answers from the loaded record, never from the last generated config.** Null means "this agent cannot be addressed right now", covering all three ways that happens: the engine is not running, the generation that produced it skipped the agent, or the agent was added or fixed after this process started and the restart that would load it is still waiting on a streaming turn. **Phase 6 binds engine sessions to `agentKey`**, so answering from the last generation would hand back a real-looking key for an entry the engine has never heard of
- **`lastSkips()` describes the running engine's config**, not the last generation's. An agent whose credential was deleted a moment ago is still being served perfectly well until the restart lands, and a reason line saying it cannot run would be describing a config nothing has loaded. It follows that the value only moves when the process moves — and every one of those transitions pushes an engine-state change, which is exactly the signal the renderer re-reads it on

### The agent key never moves

An agent's OpenCode key is `<slug>-<short hash of the agent id>`, **always suffixed, even when the slug is unique**. The tempting alternative — bare slug when unique, suffixed on collision — makes an existing agent's key depend on which *other* agents exist, so creating a second `assistant` in another root would rename the first one's entry. Phase 6 binds sessions to this key, so a key that moves is a conversation that loses its agent. The user never types it.

### Two digests, because the two halves travel by different routes

The record is split into a config digest and a credential digest, and they are separate because the change each one sees is invisible to the other:

| Digest | Covers | Sees |
|---|---|---|
| `config` | the serialised config object **and** every prompt file written beside it | a new agent, a reworded `WORKFLOW_PROMPT.md`, a changed model, a provider added or removed |
| `env` | the `CINNA_ENGINE_KEY_…` name→value map and nothing else | a **rotated key**, which leaves the config bytes identical |

The credential digest is taken over `built.env` specifically, and not over the environment the child is actually spawned with. That environment carries a fresh 32-byte password per spawn plus the whole login shell, so a digest of it would differ on every single comparison — and, since one process backs every agent, that would restart the engine and end every streaming turn on every reconcile.

Neither digest is ever logged. `whatMoved()` reports the words "config", "credentials" or both; key material has no safe representation in a log, digested or not.

### The digest is length-prefixed, not delimiter-joined

Each piece fed into the digest is prefixed with its length. This is not ceremony, and **the direction of the failure is why**: a delimiter collision here does not cause a spurious restart, it causes a *false negative* — two genuinely different configs digesting equal, so the reconcile concludes nothing moved and never restarts. The engine keeps serving the previous prompt while the app believes it is serving the new one, and **every test still passes**, because a false negative is invisible to anything not looking for it.

The prompt bodies are the one input that is arbitrary user-controlled text — the user's own `WORKFLOW_PROMPT.md` — which makes the collision reachable rather than theoretical. Same shape as the two `isIgnoredPath` defects in `src/main/kit/validator.ts`: both false negatives in a secret check, both survivors of a green suite. Do not simplify it back to a join.

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

**A consequence Phase 6 must respect: OpenCode's v1 `/config` endpoint returns the *resolved* configuration, with `{env:…}` already substituted.** Nothing we generate carries a placeholder any more, but that response can still resolve one out of the user's own config, so it must never be logged, echoed into a stream part, or forwarded to the renderer.

### The engine is on loopback, behind a password, on a port we picked

- **The port is chosen by the desktop**, by binding a throwaway server to `127.0.0.1:0` and reading what the OS gave. `--port 0` is not "any free port" to OpenCode: verified against v1.18.27 it falls back to the default 4096. Worse, a second `serve` against a taken 4096 does **not** die — it comes up silently on an unpredictable port, so the collision would be quiet and an engine we never intended to talk to would be reachable at an address we could not guess
- There is an unavoidable race between closing the probe socket and spawning. It is made harmless rather than eliminated: a start that loses it fails its health check and is retried on a fresh port
- **`--hostname 127.0.0.1`, always.** This is an LLM with a shell tool; its bind address is an attack surface in its own right. `--mdns` must never be passed — it defaults the hostname to `0.0.0.0` and advertises the server on the local network. The exposure is one word away rather than present, which is why the command line is asserted in a test rather than described in a comment
- **A fresh 32-byte password per start**, never written to disk, never logged, never sent to the renderer. Without one the server is unsecured, and any process on the machine could drive a loopback server that runs bash
- **No IPC channel returns the base URL or the password.** They stay inside `engineManager`, which is what keeps "everything talks to the engine through the runner" true by construction rather than by convention

### The engine's environment is narrowed, not inherited

The engine gets **the same narrowed environment a third-party stdio MCP server gets** — `shellEnvForChild` over the resolved login-shell environment — plus an enumerated set of variables added explicitly (`OPENCODE_CONFIG` **and `OPENCODE_CONFIG_DIR`** — the engine has two config readers and they honour different variables, see [the contract](opencode_contract.md) §9.5.3 — the server username and password, `OPENCODE_DISABLE_AUTOUPDATE=1`, and the credential map).

The instinct is that this should be looser, since the engine is our own binary rather than a third party's. It is the opposite: the thing that *runs inside* the engine is a language model with a bash tool, driven by whatever text arrives in a conversation, and its output goes on screen and into the database. A shell environment handed to it is one prompt injection away from being read aloud, and `ANTHROPIC_API_KEY`, `GITHUB_TOKEN` and `AWS_*` live in exactly the `.zshrc` this app is deliberately sourcing. The narrowing applies with *more* force here than for an MCP server, whose tools at least have fixed schemas.

It also costs nothing: every credential the engine legitimately needs is injected by name from our own keystore, and the agent's own secrets stay in `credentials/.env` where its scripts read them. The login shell is consulted for `PATH` — so `uv`, `make` and `python` resolve — and for nothing else. See [Shell Environment Resolution](../../development/shell_environment/shell_environment.md).

`OPENCODE_DISABLE_AUTOUPDATE=1` is part of the same rule: we pin and verify the binary, and an engine that replaces itself underneath that pin is exactly what the checksum exists to prevent.

### The cloud model lists refresh at start; the local ones refresh on every reconcile

`refreshModelCache(scope)` calls registered adapters' `listModels()` **in sequence**. For a cloud credential each call is a real network round trip — Anthropic's SDK, OpenAI's SDK, a `fetch` for Gemini — so a full refresh costs one round trip per configured credential, serially.

Stated precisely, because the flat version of the sentence is wrong:

- **A start refreshes everything** (`scope: 'all'`). A turn that restarts goes through `applyConfigChange` → `halt()` → `ensureRunning` → `startEngine`, which collects with `refreshModels: true` and does the full fan-out
- **A reconcile refreshes the local credentials only** (`scope: 'local'` — the keyless ones). No cloud provider is re-asked for a turn that does not restart the engine

Skipping the cloud refresh on the reconcile path is safe rather than merely cheap. A running engine's cache was populated by the start that launched it, and the cache keeps its last good list when a refresh fails — so the reconcile compares against the same model list the running config was built from, instead of one that drops out whenever a gateway is briefly unreachable and takes the engine down for a restart it did not need.

**The local exception is there because a local catalogue is not a vendor's line-up.** It is the set of models on this machine, which the user changes with `ollama pull` between one turn and the next, and which is *empty* whenever the local server happened not to be running at the moment the engine started. A custom entry whose `models` map is empty can address nothing, and the resulting failure reaches no engine event at all — so starting Cinna before Ollama meant every folder agent on it hung on its first turn until the desktop's own twenty-minute ceiling expired. The call is loopback and costs about a millisecond, which is why the reason the cloud fan-out is excluded does not apply to it.

**A refresh never shrinks a provider to nothing** (`src/main/engine/modelCache.ts`). `getAllModels` swallows a per-adapter failure and omits that provider, so "the server was down for this one call" and "this credential has no models" arrive identically; a provider that reported nothing therefore keeps what it last reported, while one that *did* answer is replaced outright so a removed model still disappears. The merge is also handed the live credential ids, because that rule cannot otherwise tell silence from **deletion** — and the cache is read as a global ownership index when deciding whether a model belongs to another credential, so a ghost row is an owner. An **empty** live list evicts nothing: it comes from the credential database while the models come from the adapter registry, and before a profile's scopes resolve those two legitimately disagree — treating that as "every credential was deleted" would empty every custom entry at once, which is the same twenty-minute hang.

If Phase 6 ever needs a cloud model list newer than the running engine's, it must ask for one explicitly rather than widening the reconcile's scope.

### A failed start is a state, not an exception

Nothing in this slice throws at the renderer. `ensureRunning` never rejects; a failed start sets `status: 'failed'` with one sentence, and `engine:start` returns that state. Every caller — the readiness strip, a turn about to run — has to render the failure either way, and `ipcMain.handle` would drop the code off a thrown error regardless (see [Agents Tab & Agent Page](agents_tab.md) on that boundary).

The process dying unexpectedly is handled the same way. Nothing polls the engine, so the `exit` handler is what moves the state to `failed` with the exit code; the next caller starts a new process rather than talking to a closed socket.

### A stop the user asked for cannot be undone by a restart we issued

Stops are counted, not flagged. A start captures the count when it begins and treats any later value as "somebody asked for a stop after I started"; an internal restart takes the engine down through a private `halt()` that does **not** bump the count, so it cannot cancel itself — and, symmetrically, cannot hide a user's Stop that lands while it runs.

A boolean could not do this: `ensureRunning` cleared it unconditionally on its way into a start, so a Stop pressed — or a `will-quit` fired — while a reconcile was restarting was erased by the restart it was meant to cancel. The quit variant is the one that reproduces: an `opencode serve` spawning *during* shutdown and left running with no window to stop it from.

Quit is synchronous for the same reason. `will-quit` handlers are not awaited and a spawned child is not reaped when its parent exits, so the handler bumps the epoch and signals the child inside its own body rather than scheduling an async stop.

### Nothing generated is written into an agent folder

The config and every generated prompt file live under `<userData>/engine/`. The agent folder belongs to the user — an assistant may have it open, it is very often a git repository, and Invariant 2 says exactly one file inside it is the desktop's (`app-data/desktop.json`). A generated prompt written into the folder would also travel to the cloud on publish.

The one delete in this slice is scoped hard: stale prompt pruning only ever touches `<userData>/engine/prompts/`, only `.md` files directly inside it, and never a directory — no agent folder is reachable from it even if a key were malformed. A file it cannot remove is skipped rather than thrown, because a stale prompt is untidy and failing the config write over one would take the engine down.

### Which agents get an entry, and which do not

Three different outcomes, and only the middle one is visible as a "skip":

| Situation | Result | Where the user learns why |
|---|---|---|
| Readiness `invalid` or `contract_too_new` | **Not offered to the generator at all.** A folder that does not validate has no business being handed to a model: its prompt files may be half-written and its manifest may say anything | The readiness strip on the agent page |
| Runtime resolves to no credential the engine can use, or to no model | **Skipped**, with a reason recorded on the generated config | The “Runs with” panel's status line |
| Everything resolves | An agent entry with its model, prompt file reference and permission profile | — |

A credential is offered to the generator when the user has it switched **on** and `isCredentialUsable` says it can make a call at all: it is not flagged `unsupported` (an Anthropic OAuth token is not an API key) and it either has a stored key or is of a **keyless** type, which needs none. The two terms are `isCredentialActive`'s, and this collector spells them out separately rather than calling it, because each refusal carries its own reasoning. That predicate is shared with the "Runs with" panel and every picker on purpose — a hand-written `hasApiKey` here would have made the panel offer a local credential the generator then silently skipped. Own **and** server-managed credentials both count — excluding managed ones would make an account-provisioned machine unable to run a local agent at all. A key the keystore refuses to decrypt is skipped with a warning rather than failing the whole start; the other credentials still work.

**A credential the user has switched off is left out, and that is a decision about spending rather than about cataloguing.** `collectEngineProviders` skips a row whose `enabled` is false before it asks anything else, so a folder agent pinned to it has nothing to run on and is reported as a skip with a reason. The check was missing for as long as the collector existed, and it was worst where it mattered most: a *canonical* type carried a real, decryptable key into the config, so an agent kept running — and kept billing — after the user turned that credential off in Settings. A *custom* entry was inert by accident rather than by design, its `models` map coming from the adapter registry, which no longer holds an unregistered credential. The alternative position is the one the paragraph below takes for an **agent**'s own `enabled` — the config is a catalogue of what *can* be addressed and the runner decides what runs — and it was considered and rejected here: a user who switches a credential off has said something about **spending**, and there is no runner gate anywhere that would honour it. See [Switching an AI Credential Off](../../llm/adapters/credential_enablement.md).

**`enabled` is not consulted, and this is an obligation on Phase 6.** A folder agent the user has toggled off still gets a config entry, an agent key and a written prompt file. That is consistent with what the config is — a catalogue of what *can* be addressed, not a decision about what runs — and with `enabled` meaning only the user's own choice, which survives every rescan (see [Agents Home, Scanner & Folder Index](folder_index.md)).

But the design only holds if the other half is built. **The gate does not exist yet.** The config does not enforce `enabled`, nothing else in this slice does either, and `agentKey()` will happily return a key for a disabled agent. If the Phase 6 runner routes a turn without checking `enabled` itself, an agent the user switched off is chattable — and the generated config will *look* as though it had been excluded, because a disabled agent is invisible in every list the user reads. **The runner must gate on `enabled`; the config does not.**

### Runtime resolution: the agent's own runtime, then the Default runtime

A runtime is `{credential, model}` and it is resolved from two sources, in order: the agent's own declared runtime, then the **Default runtime** derived from the user's default chat mode. It may name the model outright (`runtime.model`) or name a work complexity instead (`runtime.complexity`); both arrive at a model through the one chain below.

**Where that declaration is *stored* is not this service's business.** A kit agent states it in its manifest's `runtime` block; a [bare agent](bare_agents.md#a-bare-agent-picks-its-own-runtime-and-the-answer-is-kept-where-the-folder-is-not) has no manifest and states it in that agent's state under `<userData>`, because the desktop writes nothing into an adopted folder. The scanner puts both on `LocalAgentDto.runtime`, so `runtimeService.resolve` and `engineConfigSource` read one field and neither has a branch for the second kind. Everything below therefore says "the agent's runtime" where it used to say "the manifest", and the sentences about a **file the user commits** are true of the kit half only.

**There is deliberately no third source for a credential.** A "first credential that happens to have a key" fallback would make an agent run on a credential the user never chose and never saw — a billing surprise at best.

The fallback is per-field rather than all-or-nothing:

- A manifest naming only a model borrows the default's credential
- A manifest naming a credential this machine does not have falls through to the default **for the credential** but keeps its own model — an agent that asked for a particular model asked for it regardless of which key pays for it — and carries a reason line naming what it asked for and what it got instead. A manifest naming a *tier* keeps the tier and resolves it against the credential it actually got, which is the only catalogue there is to resolve against; resolving it against the catalogue of the credential the file names would label a model no key on this machine can serve
- A manifest naming only a credential borrows a model through the chain below, which is **not** "the default's model, always"
- Only when neither source yields a credential (or a model) is the runtime unresolved, and the reason line says which is missing

The Default runtime reads through the same effective-default resolution `aiFunctions` uses, so it honours the local/account precedence toggle and a managed mode's per-profile model override. "What drafts my prompts" and "what runs my agent" cannot disagree. See [Account-Provisioned Providers & Chat Modes](../../llm/account_provisioning/account_provisioning.md) and [Chat Modes](../../chat/chat_modes/chat_modes.md).

**A Default runtime that cannot run says which half is wrong.** Both branches — this machine's pinned agent credential, and the user's default chat mode — once reported only a *missing key*, so an agent that declared no credential of its own said nothing at all when the default's credential was switched off: the panel claimed it was fine and the first turn failed. The sentence now names whichever setting chose the credential, so the user knows whether they are being told about a machine-wide pin or about their default chat mode, and it distinguishes "no API key" from "switched off" because the two want different remedies. A pinned credential that cannot run is still reported *as* the runtime rather than falling through to the chat mode — re-pointing an agent at another key without being asked is the billing surprise this service refuses.

**A credential reference is resolved by one shared function**, `findCredentialByReference` in `src/shared/credentials.ts`: an id, then a name, then a provider type, with name and type matched case-insensitively. Where two rows answer one name — a managed `Anthropic` beside the user's own — the tie-break prefers one that can run, then one that merely has a key, then whatever matched; a reference matching only unusable rows still resolves, so the panel can say *why* rather than calling the credential absent. It lives in `shared/` because the "Runs with" panel resolves the same reference on the other side of the bridge, and the two copies drifted the moment this one learned to prefer a credential that is switched on. See [Switching an AI Credential Off](../../llm/adapters/credential_enablement.md).

#### A model is lent only where it can actually run

A model id means nothing on its own. The generated config names a runtime as `<credential>/<model>` verbatim, so an OpenAI credential paired with `claude-sonnet-4-5` is an entry that writes cleanly, passes every check this app makes, and fails on the agent's first turn. That pairing is exactly what a manifest naming only a credential used to be given: the default chat mode's model, whichever credential the user had chosen.

A runtime that names no model takes one from this chain, in order:

1. **The default runtime's model, when the chosen credential is the default's own row.** Same credential, so it is the choice the user already made once
2. **The chosen credential's own default model**, set in Settings → AI Credentials. It is the user's answer to "what should this key run", and it is also the step that covers a default chat mode left on *First available*, which names no model at all
3. **The default runtime's model again, when the two credentials share a provider *type*.** A model id belongs to a provider's catalogue, not to one row of ours: `claude-sonnet-4-5` is as valid on a second Anthropic key as on the first, so a personal key alongside an account-provisioned one keeps a working agent. **`openai_compatible` and `ollama` are excluded** — two gateways behind that type are two different catalogues that merely share a wire format, and two Ollama hosts are the sharper case still: a catalogue there is literally the set of models pulled onto one machine
4. **The Medium tier of the chosen credential** — the *Medium floor*. The tier a user who expressed no preference would have picked, resolved against the credential they did choose, and never drifting upward into Complex. Medium and not Simple either: an agent silently downgraded to the cheapest model does poor work and gives no clue why, which costs more to diagnose than the tier saves; the mirror-image failure at the top is a bill
5. **Nothing**, and the agent is skipped with "its runtime names no model". Better than a model the credential cannot serve: a skip is a state the "Runs with" panel can name and the user can fix from that panel, while a wrong pairing only surfaces as a failed turn

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
5. A handover block, from the manifest's declared sibling delegations
6. The desktop context block

Four rules shape it:

- **HTML comments are stripped.** The kit's templates carry their author guidance in `<!-- … -->` blocks addressed to *the person writing the agent*. Markdown hides them, so authors leave them in place while filling the sections around them; fed to the model verbatim they read as instructions, which is how a freshly scaffolded agent ends up answering with the template's worked example about invoices. Stripping them is reading the kit's own convention correctly, not taking a liberty with the user's text. An unterminated `<!--` is tolerated — a half-written comment is a state a file is genuinely in while someone types
- **Knowledge is listed, not inlined.** Knowledge is reference material the agent reads when it needs it; inlining a folder of business rules into every turn's system prompt spends the context window before the conversation starts. `knowledge/README.md` is excluded — it explains the folder to a human author, and listing it sends the agent to read about itself
- **An empty workflow prompt never produces a promptless agent.** A stand-in section says plainly that `Local/<slug>/docs/WORKFLOW_PROMPT.md` is empty and suggests opening the agent in an assistant. Without it the model gets only the appendices and answers as a generic assistant, which looks like the agent "not working" rather than like an empty file
- **The result is deterministic given a folder and a context**, which is what makes the snapshot test worth having: the interesting failures here are *omissions* — a section that silently disappears when a file is missing — and a snapshot catches those where an "it contains the workflow prompt" assertion does not

### A bare agent's prompt is one file, and deliberately not the folder

A [bare agent](bare_agents.md) has no manifest, so `collectEngineAgents` branches to `assembleBareAgentPrompt`: `AGENT.md`, comments stripped, plus a desktop context block, and **nothing else the folder contains**.

The asymmetry with the assembler above is the whole design. A kit folder has a known shape, so reaching into `scripts/`, `credentials/` and `knowledge/` is safe. A bare folder is somebody's repository, and concatenating whatever `.md` files happen to be in it would put a changelog, a licence or another agent's notes into the system prompt as instructions.

- **`README.md` is excluded on purpose.** It is written for whoever develops the agent — how to install it, how to run it, what it needs — and a model reads "run `uv sync` first" as a step it should take. It is the *builder's* document, and where it is used is the init prompt
- **Three of the context block's rules are dropped rather than reworded** — `uv run`, "write only under `app-data/`", and the `credentials/.env` rule — because each describes a folder convention this folder never agreed to, and stating a rule about a file that does not exist is how a model ends up refusing ordinary work. One line replaces them: follow whatever the instructions above say about running this folder's own tools, because the desktop imposes no convention here
- **The Builder line survives verbatim**, for exactly the reason below: a bare folder's `AGENT.md` and `README.md` are precisely what a builder opens the folder to rewrite
- **An empty `AGENT.md` gets the same stand-in** the kit path gives an empty workflow prompt, and for the same reason
- **`runtime` is `null`**, so `runtimeService.resolve` falls straight through to the Default runtime. There is no manifest to name a credential or a tier, and the rule against a third credential fallback is untouched

### The desktop context block, and the line that matters most

The appended block is the part only the desktop knows: that this is a conversation rather than a scheduled run, and what this machine's rules are — run scripts with `uv run`, write only under `app-data/`, never print or read a credential value, the user's locale and time zone, long output to a file with a summary in the reply.

The last line is load-bearing: **do not switch to the Builder role.** The same folder is also opened by a builder — an assistant developing the agent, and later this app's own building mode — whose job is to rewrite these very files. An agent that decides mid-conversation that it is the builder starts editing its own prompt while the user is talking to it.

### The permission profile

**An agent works freely inside its own folder.** A session's `location.directory` *is* the agent folder, so `read`, `edit`, `write` and `bash` are `allow`; what still asks is what the folder boundary does not cover — `external_directory`, `webfetch`, the agent's own manifest and workflow prompt, secret files, and `sudo` / `rm -r`. This replaced a profile that allowed writes only under `app-data/` and only three shapes of command, which asked about nearly every step of ordinary work: **a permission prompt that fires constantly is not a control, it is a thing users learn to click through.**

The whole profile, each entry with the failure it exists for, plus the matcher rules every pattern in it depends on, is [Local Agent Permissions](permissions.md#business-rules). Two things belong here because they are about generating the config rather than about the policy:

- **`'*': 'ask'` has to be there explicitly.** OpenCode's own base rule is allow-everything — verified by reading `GET /agent` back off a running engine — so a profile that only enumerates `read`/`edit`/`write`/`bash` leaves *every other tool* on allow, which is the opposite of the intent
- **Order inside an entry is the mechanism, not a style choice.** The engine resolves a permission with a `findLast` over the concatenated rules, so `'*': 'allow'` is written first and the narrow shapes after it. Write them the other way round and every narrow entry is dead — and dead in the direction of allow

Answering these prompts is the [runner's](agent_turn.md); a user's *Always allow* is recorded per agent in that folder's `app-data/desktop.json` and never sent to the engine.

**A manifest's `runtime.permissions` is merged shallowly, one permission name at a time** — replacing a whole entry rather than deep-merging its pattern map, so an override reads as an override instead of quietly widening `bash` from underneath. Its justification is that the folder is the user's own, so this is a legibility boundary rather than a trust one. Where a manifest does override something, the agent page's Permissions tab names which permissions were replaced, because the fixed description it shows above the list is no longer the whole truth.

> **Flagged for Phase 9.** That justification stops being true the moment a folder is installed from the cloud into a shell-capable engine. A manifest can replace `bash` and the `'*': 'ask'` catch-all outright. Revisit before cloud install lands.

### Binary resolution, and what "verified" means

Three sources, in order: a configured path, the login-shell PATH, the pinned download.

> **The staging, verifying and atomic publishing described below is no longer the engine's own.** It now lives in `src/main/managed/managedAsset.ts` and is shared with the [local-development toolchain](../local_dev/local_dev.md), which installs uv and Mutagen the same way — a second copy of that logic would be a second place for "nothing partial is ever published" to be got wrong. `binaryResolver.ts` keeps what is genuinely about the engine: the pin table, the three sources and their precedence, and the `--version` probe. Every guarantee in this section is unchanged, and `EngineBinaryError` still widens the shared `ManagedAssetError` codes with its two "your configured path is wrong" cases.

- **A configured path that is not a runnable file is an error, not a silent fallback.** The user pointed at something specific; quietly running a different engine than the one they named is worse than saying the path is wrong. No version pin is applied to it — the point of setting it is to run the one you named
- **A `which` hit that will not run is not fatal** — it falls through to the managed copy rather than stranding the user on a broken install
- **The pinned download is verified against a recorded SHA-256 before anything is unpacked.** The digests pin *those exact bytes*: a re-tagged release, a compromised CDN edge or a truncated transfer all fail and nothing is unpacked. They are **not** a signature — they establish that what arrives is what was pinned, not that what was pinned is trustworthy. Bumping the version means recomputing all six
- **A failed verification leaves nothing a later run could mistake for a good install.** Everything happens under a per-attempt staging directory and only a fully downloaded, verified, unpacked tree is renamed into place — so the presence of `<userData>/engine/opencode-<version>/opencode` *is* the proof that its bytes were checked. A crash mid-download leaves a `.staging-*` directory: junk, but junk no code path treats as an install
- **Two callers racing resolve to one install.** Whoever renames first wins; the loser keeps the published tree, which passed the same digest check
- The resolved binary is **cached across starts** — the download is 46 MB — and invalidated when the configured path in Settings changes. Without that invalidation the user would keep running the old binary until the app restarted, while the Settings field described something else
- A platform absent from the pin table is not a crash: the error says plainly that the user has to install `opencode` themselves, and source 2 then finds it. musl-only distributions (Alpine) are the known gap

Bundling per-platform binaries inside the signed app is deliberately deferred — it needs an `extraResources` block that does not exist yet, proof that a Bun single-file executable launches from a notarised macOS bundle, and a fourth resolution branch. Until then a bundled copy would be a large untested asset in every installer.

### The engine contract, verified against the real binary

Verified against real `opencode` **1.18.27**, not inferred: the asset SHA-256s, `tar -xf` reading a `.zip` (bsdtar does; that is why one command handles both archive shapes), the binary at the archive root on macOS and Windows, the `--port` / `--hostname` spellings, `GET /api/health` returning exactly `{"healthy":true}`, Basic auth via `OPENCODE_SERVER_USERNAME` / `OPENCODE_SERVER_PASSWORD`, `OPENCODE_CONFIG` pointing the engine at our generated file, and loopback binding confirmed with `lsof`.

Two behaviours recorded because they are counter-intuitive and cost time to establish: **`--port 0` binds 4096** rather than asking the OS for a port, and **a second `serve` against a taken 4096 does not fail** — it comes up silently on an unpredictable port.

## Known gaps

Carried honestly rather than implied as passing. Nothing here blocks Phase 6, but each is a place to look first if something behaves oddly.

- **The download *sequence* has only run against fakes.** Every piece is hand-verified against the real binary — the digests, `tar -xf` on a `.zip`, the archive layout, `--version` — but `downloadToFile` → `extractArchive` → `chmod` → `rename` as the app runs it, including the staging rename and the lost-race branch, has never executed end to end
- **The engine's own renderer surfaces are typechecked and bundled but never rendered.** The engine-path field and the Start/Stop button went in on the compiler's word alone. The “Runs with” panel is no longer in that list — `RuntimePanel.test.tsx` renders it — but that test pins the engine to `running`, so the panel's own Start button is never on screen in it either
- **`writeIfDifferent`'s atomicity under interruption is untested.** The observable consequence is covered (no `.tmp` survives), but not the property that matters: a writer killed between the write and the rename must leave the previous config intact. That needs a crash, not a mock
- **Three pieces of correct-but-unpinned code**, named in the test file's own header rather than implied as covered: `await pending` in `halt()`, the **narrow** window the stop epoch guards, and `resetEngineStateForTests()`. The two tests that read as if they pinned the epoch actually pin the **post-await re-read of `running`** — deleting that re-read in the belief the epoch covers it is the mistake their comments warn against. None of these is known-broken behaviour
- **The `knowledge/` topic sort is unpinned** — pre-existing; `readdirSync` already returns name order on APFS, so removing the sort passes everything
- **The reconcile's cost is reasoned, not measured.** Per turn it does a keychain decrypt per credential and a full prompt re-assembly per agent (several file reads plus the `knowledge/` walk, since only the folder *scan* is cached). Believed to be a few milliseconds; unproven. **If Phase 6 sees turn latency it cannot explain, look here first**
- **Whether a restart between two turns of the same chat loses engine session state is not settled here.** That is session continuity, which Phase 6 owns. Invariant 3 is satisfied at engine granularity by the deferral; the finer question is open

## Architecture Overview

```
Settings → Local Agents          Agent page → “Runs with” panel
   │  Start / Stop / engine path      │  credential + model pickers, engine line, status line
   ▼                                  ▼
useEngine  (useEngineState / useEngineWatch / useEngineSkips / useStart|StopEngine)
   │            ▲ engine:state push (nothing polls)
   ▼            │
engine:status | :start | :stop | :skips          local-agent:update-field
   │                                                    │ (fire-and-forget reconcile)
   ▼                                                    ▼
                        engineManager
   ┌──────────────────────────┴───────────────────────────┐
   │  ensureRunning ─ running? ─ yes ─► applyConfigChange  │
   │        │                              │ turn held? ──► defer, write nothing
   │        no                             ▼
   │        ▼                        digest ≠ loaded? ──► halt() ─► start
   │   startEngine (refreshModels: true)
   └──────────────────────────┬───────────────────────────┘
                              ▼
   binaryResolver          engineConfigSource ──► configGenerator
   configured │ PATH │      providerService          providers  (keys → env: [NAME])
   pinned download          runtimeService           agent entries + permissions
   (SHA-256 verified)       promptAssembly           prompts, digest, key maps
                              │
                              ▼
                    <userData>/engine/opencode.json
                    <userData>/engine/prompts/<agentKey>.md
                              │
                              ▼
        spawn: opencode serve --port <picked> --hostname 127.0.0.1
        env  = narrowed login shell + OPENCODE_CONFIG + OPENCODE_CONFIG_DIR
               + Basic-auth password
               + OPENCODE_DISABLE_AUTOUPDATE + CINNA_ENGINE_KEY_* (the keys)
                              │
                              ▼
        RunningEngine { child, baseUrl, authHeader, port,
                        loaded: { digest, agentKeys, agentModels, skippedAgents } }
                        ▲ never leaves engineManager (no baseUrl on any IPC channel)
```

## Integration Points

- [Agents Home, Scanner & Folder Index](folder_index.md) — the folder agents the config is generated from, the readiness that decides which are offered at all, and the `turnLock` whose `anyHeld()` gates every restart
- [Local Agent Permissions](permissions.md) — the profile this generator writes, entry by entry, and the desktop-held grants that answer an ask it produces
- [Agents Tab & Agent Page](agents_tab.md) — the “Runs with” panel (its layout, its one reserved status line and the jump rule behind it), the Settings → Local Agents engine controls, and the stamped `update-field` path a runtime write reuses
- [Kit Contract & Manifest Layer](kit_contract.md) — the `runtime` block in `cinna-agent.json`, the validator's secret pattern reused on the credential reference, and the templates whose HTML comments the prompt assembly strips
- [Account-Provisioned Providers & Chat Modes](../../llm/account_provisioning/account_provisioning.md) — managed credentials are usable runtimes, and the background sync is the config input with nowhere to put a hook
- [Chat Modes](../../chat/chat_modes/chat_modes.md) — the default chat mode *is* the Default runtime
- [Adapters](../../llm/adapters/adapters.md) — `listModels()` is the network call kept off the per-turn path; the registry supplies the model lists custom provider entries need
- [Local Models & Keyless Credentials](../../llm/local_models/local_models.md) — the credential type with no key, its host, the `/v1` suffix a custom entry gets, and the local-only model refresh
- [Switching an AI Credential Off](../../llm/adapters/credential_enablement.md) — why a disabled credential is excluded here, the shared reference resolver, and every surface that reports the consequence
- [AI Functions](../../llm/ai_functions/ai_functions.md) — resolves its adapter from the same effective default mode, so drafting and running cannot disagree
- [Shell Environment Resolution](../../development/shell_environment/shell_environment.md) — the login-shell `PATH` that finds a user's own `opencode`, and `shellEnvForChild`, the same narrowing a stdio MCP server gets
- [Settings Scope](../../core/settings_scope/settings_scope.md) — the engine is machine-local; `localAgentsEnginePath` lives in the default scope
- [Resource Activation](../../core/resource_activation/resource_activation.md) — every engine channel requires an activated session
- [Main-Process Layering](../../development/main_layering/main_layering_llm.md) — thin IPC controllers; the engine's address and password never cross a boundary

Sub-doc: [Technical Details](engine_tech.md)
