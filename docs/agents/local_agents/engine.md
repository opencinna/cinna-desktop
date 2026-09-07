# The Local Engine, Runtimes & Prompt Assembly

> **The engine contract is verified against the real binary — see [The OpenCode Engine Contract](opencode_contract.md).** That document records what was actually watched against `opencode` 1.18.27, what is only assumed, and what was believed and proved false. **Read §9.5 before changing anything about the generated config:** the engine has two config readers, `OPENCODE_CONFIG` reaches only the older one, and the newer one — which decides what a session can run on and what system prompt it gets — substitutes neither `{env:…}` nor `{file:…}`. Three further things it settles matter to everything below: `session.idle` is **never emitted** and `POST …/wait` is **declared but unimplemented**, so the only turn-completion signal is `step.ended` with `finish === 'stop'`; and OpenCode's saved permission grants are **user-global** (`projectID` is always `"global"`), which is why *Always* is gated off.


## Purpose

What actually runs a folder agent: one desktop-managed `opencode serve` process bound to loopback, a generated OpenCode configuration derived from this machine's AI credentials and folder agents, the **runtime** (credential + model) each agent resolves to, and the per-agent system prompt assembled out of the agent's own files.

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
- **Runtime** — what an agent runs on, reduced to `{credential, model}` because the engine is always OpenCode
- **Default runtime** — the fallback runtime, derived from the user's default chat mode
- **Skip** — a folder agent the generated config deliberately left out, with a reason phrase the “Runs with” panel renders in its status line
- **Binary source** — where the running `opencode` came from: `configured` (a path in Settings), `path` (the user's own install, found on the login-shell PATH), or `managed` (the pinned version this app downloaded and verified)

## User Stories / Flows

### Starting the engine for the first time
1. The user opens Settings → Local Agents (or the “Runs with” panel on an agent page) and presses **Start**
2. If Settings names an engine path, that file is used — and an unusable one is an error, not a silent fallback. Otherwise `opencode` is looked for on the login-shell PATH
3. With neither, the pinned build for this platform is downloaded into `<userData>/engine/`, verified against a recorded SHA-256, unpacked and published. The status line says "Downloading the engine — this happens once and takes a minute"
4. The config is generated fresh (model lists refreshed), written, and a process is spawned on a freshly-picked loopback port
5. The engine answers `GET /api/health`; the status becomes `running` and the version line names the binary and where it came from

### Nothing starts it for you
1. A user who never opens the Agents tab never pays for a 50 MB download: **nothing starts the engine at app boot**
2. Starting is an explicit act — the Settings button, the panel's button, or (Phase 6) the first turn

### Adding a credential while the engine is running
1. The user adds an AI credential in Settings, or the background account-config sync materialises a managed provider on its timer
2. Nothing happens immediately, and nothing needs to: the next time anything asks the engine to be running, the config is re-derived and compared against what the process loaded
3. The config moved, no turn is streaming, so the engine is restarted and comes back knowing the new credential

### Rotating a key
1. The user replaces the API key on an existing credential
2. The config file is **byte for byte identical** — the key was never in it, only the *name* of the environment variable it travels in
3. The credential digest moved, so the reconcile restarts anyway. Without that second digest, every turn would 401 while the UI showed a valid credential and a healthy engine, until the app was quit

### Choosing a runtime
1. The “Runs with” panel on the agent page offers the credentials this app can actually call with, and the models the registry lists for the chosen one. Both pickers stay disabled until the model registry has loaded — a network round trip per credential — because until then the panel cannot tell a model that belongs to another catalogue from one the registry has simply not listed yet
2. The Model picker's `Default (…)` option names the model *this credential* would run, resolved through the same chain the engine uses (see [A model is lent only where it can run](#a-model-is-lent-only-where-it-can-actually-run)), not the default chat mode's model regardless of credential
3. Choosing writes a credential **name** and a model id into `cinna-agent.json` — never a key, never this app's internal provider id
4. **Changing the credential drops a model the registry attributes to a different catalogue**, and the status line says which model went and why. Keeping it would write a manifest the config turns into `openai/claude-sonnet-4-5`. A model the registry has never listed is *kept*: it is a hand-written id for a catalogue this app cannot see, so calling it wrong would be a guess
5. The write goes through the same stamped `local-agent:update-field` path as every other editable file, so an assistant editing the manifest cannot be clobbered
6. Clearing both removes the `runtime` block entirely and the agent falls back to the Default runtime
7. The save fires a reconcile, which is a no-op unless the generated bytes actually moved
8. **Which credential of a type it is has a consequence the panel does not show.** The first Anthropic credential becomes the engine's canonical `anthropic` entry and inherits the real context and reply windows of every model. A *second* one becomes a custom entry the engine has no catalog for, so the desktop has to declare those windows itself from a per-type floor — see [A second credential's models have to be told how big they are](#a-second-credentials-models-have-to-be-told-how-big-they-are). An agent on the second key is therefore capped at that floor rather than at what its model actually supports

### An agent that cannot run
1. An agent whose credential has no key, or whose runtime names no model, still appears everywhere — but the config generation **skips** it and records why
2. The panel's status line renders that reason: "The engine skipped this agent because its runtime credential is not available to the local engine." It sits below the panel's own messages, so the one skip reason that would restate a warning already on screen — "its runtime names no model" — never takes the line
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

**Per-site `applyConfigChange` calls are a latency optimisation, never the mechanism.** Two exist — after a successful `local-agent:update-field` and after a successful `local-agent:delete` — and each is fire-and-forget, never blocks the write it follows, and is a no-op unless the engine is running, the generated digest moved and no turn holds a lock; for `update-field` that is the common case, since most manifest fields the engine never reads. They are there so a runtime change or a removed agent is picked up before the next turn rather than at it. Do not add one in the belief that it is what keeps the engine correct: `ensureRunning` re-deriving the config at the moment of use is, and a site without a call is not a bug. (This paragraph used to say "do not add per-site calls" outright; the delete call was added under review with the reasoning above, and the sentence was reconciled with the code rather than the code with the sentence.)

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

### A second credential's models have to be told how big they are

A provider entry comes in two shapes, and only one of them gets anything for free. A **canonical** entry — the first Anthropic credential, the first OpenAI one — uses OpenCode's own key for that provider, so the engine already knows every model it has and how large its context and reply windows are. A **custom** entry does not exist in any catalog: it is a key the desktop invented for the *second* credential of a type, or for an OpenAI-compatible gateway, and the engine knows only what the generated config tells it.

**What it defaults to when told nothing is zero**, and zero is not "unset" — it travels to Anthropic as a maximum reply length of nothing, and the request is rejected. Every folder agent running on a second Anthropic credential failed on its first real turn for that reason, with a message about `max_tokens` that named nothing the user had ever configured.

So the generator declares a context and output ceiling for every model of a custom entry, from a small table in `modelLimits.ts` keyed by credential type. **Those numbers are floors, not facts about a particular model.** The desktop does not know how large any individual model's windows are — a runtime carries a model's name and id and nothing else — so each figure is the largest one valid across everything that type currently offers. The two ways of being wrong are not symmetrical: too high is rejected by the provider on the first turn and is therefore loud, while too low quietly shortens a long answer and nothing reports it. That is the one to watch for, and it is why the table says where real numbers would come from (each adapter's `listModels()` already asks the provider, and could return the windows it publishes).

A canonical entry is deliberately left alone. Emitting our floors over the top would replace true numbers with approximations — for Sonnet 4.6 it would have cut the reply ceiling from 128000 to 32000.

### A key is never written into the config

Every provider entry names the environment variable its key travels in (`env: ["CINNA_ENGINE_KEY_…"]`) and the value reaches the engine only as process environment (Invariant 4). **Naming the variable, rather than writing an `{env:…}` placeholder into `options.apiKey`, is load-bearing rather than stylistic:** the engine's v2 config reader performs no substitution, so the placeholder itself would be sent to the provider as the key and every turn would 401. The `env` form instead registers an integration whose connection the session runner resolves out of the process environment — for a canonical provider key and for a custom one alike. The config file sits at rest in the app data directory and is readable by anything that can read the user's home; writing keys there would make it a plaintext copy of every credential in the app — the thing `safeStorage` exists to prevent.

The environment variable name is derived from the provider id so it is stable across regenerations, and hash-suffixed so two ids that sanitise to the same string cannot silently hand one provider the other's key.

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

### Model lists refresh at start, never on a reconcile

`refreshModelCache()` calls every registered adapter's `listModels()` **in sequence**, and each is a real network round trip — Anthropic's SDK, OpenAI's SDK, a `fetch` for Gemini. So refreshing costs one round trip per configured credential, serially.

Stated precisely, because the flat version of the sentence is wrong:

- **A reconcile does not refresh** (`refreshModels: false`). Nothing refreshes for a turn that does not restart the engine
- **A start always refreshes.** A turn that *does* restart goes through `applyConfigChange` → `halt()` → `ensureRunning` → `startEngine`, which collects with `refreshModels: true` and does the full fan-out

Skipping the refresh on the reconcile path is safe rather than merely cheap. A running engine's cache was populated by the start that launched it, and the cache keeps its last good list when a refresh fails — so the reconcile compares against the same model list the running config was built from, instead of one that drops out whenever a gateway is briefly unreachable and takes the engine down for a restart it did not need.

If Phase 6 ever needs a model list newer than the running engine's, it must ask for one explicitly rather than turning the flag back on.

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

A credential is offered to the generator when it is enabled, has a stored key, and is not flagged `unsupported` (an Anthropic OAuth token is not an API key). Own **and** server-managed credentials both count — excluding managed ones would make an account-provisioned machine unable to run a local agent at all. A key the keystore refuses to decrypt is skipped with a warning rather than failing the whole start; the other credentials still work.

**`enabled` is not consulted, and this is an obligation on Phase 6.** A folder agent the user has toggled off still gets a config entry, an agent key and a written prompt file. That is consistent with what the config is — a catalogue of what *can* be addressed, not a decision about what runs — and with `enabled` meaning only the user's own choice, which survives every rescan (see [Agents Home, Scanner & Folder Index](folder_index.md)).

But the design only holds if the other half is built. **The gate does not exist yet.** The config does not enforce `enabled`, nothing else in this slice does either, and `agentKey()` will happily return a key for a disabled agent. If the Phase 6 runner routes a turn without checking `enabled` itself, an agent the user switched off is chattable — and the generated config will *look* as though it had been excluded, because a disabled agent is invisible in every list the user reads. **The runner must gate on `enabled`; the config does not.**

### Runtime resolution: manifest, then the Default runtime

A runtime is `{credential, model}` and it is resolved from two sources, in order: the manifest's own `runtime` block, then the **Default runtime** derived from the user's default chat mode.

**There is deliberately no third source for a credential.** A "first credential that happens to have a key" fallback would make an agent run on a credential the user never chose and never saw — a billing surprise at best.

The fallback is per-field rather than all-or-nothing:

- A manifest naming only a model borrows the default's credential
- A manifest naming a credential this machine does not have falls through to the default **for the credential** but keeps its own model — an agent that asked for a particular model asked for it regardless of which key pays for it — and carries a reason line naming what it asked for and what it got instead
- A manifest naming only a credential borrows a model through the chain below, which is **not** "the default's model, always"
- Only when neither source yields a credential (or a model) is the runtime unresolved, and the reason line says which is missing

The Default runtime reads through the same effective-default resolution `aiFunctions` uses, so it honours the local/account precedence toggle and a managed mode's per-profile model override. "What drafts my prompts" and "what runs my agent" cannot disagree. See [Account-Provisioned Providers & Chat Modes](../../llm/account_provisioning/account_provisioning.md) and [Chat Modes](../../chat/chat_modes/chat_modes.md).

#### A model is lent only where it can actually run

A model id means nothing on its own. The generated config names a runtime as `<credential>/<model>` verbatim, so an OpenAI credential paired with `claude-sonnet-4-5` is an entry that writes cleanly, passes every check this app makes, and fails on the agent's first turn. That pairing is exactly what a manifest naming only a credential used to be given: the default chat mode's model, whichever credential the user had chosen.

A runtime that names no model takes one from this chain, in order:

1. **The default runtime's model, when the chosen credential is the default's own row.** Same credential, so it is the choice the user already made once
2. **The chosen credential's own default model**, set in Settings → AI Credentials. It is the user's answer to "what should this key run", and it is also the step that covers a default chat mode left on *First available*, which names no model at all
3. **The default runtime's model again, when the two credentials share a provider *type*.** A model id belongs to a provider's catalogue, not to one row of ours: `claude-sonnet-4-5` is as valid on a second Anthropic key as on the first, so a personal key alongside an account-provisioned one keeps a working agent. **`openai_compatible` is excluded** — two gateways behind that type are two different catalogues that merely share a wire format
4. **Nothing**, and the agent is skipped with "its runtime names no model". Better than a model the credential cannot serve: a skip is a state the "Runs with" panel can name and the user can fix from that panel, while a wrong pairing only surfaces as a failed turn

**There is deliberately no "first model in the catalogue" step**, for the same reason there is no invented credential — it would run the agent on a model the user never chose.

The chain lives in `src/shared/runtimeDefaults.ts` (`inheritedModelId`) rather than inside this service, because the panel's `Default (…)` label has to name the same model. It did not: the label named the default chat mode's model whatever credential was selected, so the user read one runtime off the screen and the engine built another. One function, called from both sides, is what makes the label and the config unable to disagree.

The Default runtime runs the chain too, not only the manifest path. `resolveDefault`'s result is returned verbatim for a manifest with no `runtime` block — which is every freshly scaffolded agent — so a short-circuit there would be a divergence the panel cannot see and the engine reports as a skip.

### The manifest stores a reference, never a key — and a name, not an id

What the panel writes is the credential's **name**, because the file travels: it is committed to the user's git repository, opened by their assistant, and uploaded to a Cinna instance on publish. Our own row ids are nanoids that mean nothing outside this machine's database.

Reading a reference back tries three shapes, which is what makes a hand-written manifest work — an id (what an older desktop might have written), a name (what this one writes), and a provider type (`anthropic`, `openai` — what a person writing the file by hand would naturally put, and what the kit's schema documents). Name and type matching are case-insensitive and prefer a *usable* credential, because two rows can share a name (a managed `Anthropic` alongside the user's own) and picking the one with no key would strand an agent that is in fact runnable.

Two validations sit on the write, and neither is about type safety:

- **A key-shaped value is refused**, using the validator's own pattern, so the desktop can never write a manifest its own validator then flags as a leaked secret
- **Clearing both fields removes the `runtime` key entirely** rather than leaving `{}` behind, so "no choice made" reads the same in the file as in the UI, and a diff shows the choice going away

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

### The desktop context block, and the line that matters most

The appended block is the part only the desktop knows: that this is a conversation rather than a scheduled run, and what this machine's rules are — run scripts with `uv run`, write only under `app-data/`, never print or read a credential value, the user's locale and time zone, long output to a file with a summary in the reply.

The last line is load-bearing: **do not switch to the Builder role.** The same folder is also opened by a builder — an assistant developing the agent, and later this app's own building mode — whose job is to rewrite these very files. An agent that decides mid-conversation that it is the builder starts editing its own prompt while the user is talking to it.

### The permission profile

Reads are free, writes and edits are free **only under `app-data/`**, and bash is free only for the three command shapes the kit teaches (`uv run *`, `make *`, `python scripts/*`). Everything else asks. Three entries are not about convenience:

- **`'*': 'ask'` has to be there explicitly.** OpenCode's own base rule is allow-everything — verified by reading `GET /agent` back off a running engine — so a profile that only enumerates `read`/`edit`/`write`/`bash` leaves *every other tool* on allow, which is the opposite of the intent
- **`credentials/.env` is `deny`, not `ask`.** The desktop never reads credential values and neither should the agent it runs; the kit's own rule is that a value is read from inside a script and never printed. An `ask` here would put a one-click path to pasting the user's secrets into a transcript behind a dialog nobody reads carefully. `**/.env`, `**/*.pem` and `**/*.key` are denied the same way
- **`external_directory` is `ask`**, so a session bound to one agent folder cannot quietly wander into another agent's folder, or the rest of the disk, without the user seeing it

Answering these prompts and persisting "always" grants is Phase 6's; this phase only puts the right profile in the config.

**A manifest's `runtime.permissions` is merged shallowly, one permission name at a time** — replacing a whole entry rather than deep-merging its pattern map, so an override reads as an override instead of quietly widening `bash` from underneath. Its justification is that the folder is the user's own, so this is a legibility boundary rather than a trust one.

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
- [Agents Tab & Agent Page](agents_tab.md) — the “Runs with” panel (its layout, its one reserved status line and the jump rule behind it), the Settings → Local Agents engine controls, and the stamped `update-field` path a runtime write reuses
- [Kit Contract & Manifest Layer](kit_contract.md) — the `runtime` block in `cinna-agent.json`, the validator's secret pattern reused on the credential reference, and the templates whose HTML comments the prompt assembly strips
- [Account-Provisioned Providers & Chat Modes](../../llm/account_provisioning/account_provisioning.md) — managed credentials are usable runtimes, and the background sync is the config input with nowhere to put a hook
- [Chat Modes](../../chat/chat_modes/chat_modes.md) — the default chat mode *is* the Default runtime
- [Adapters](../../llm/adapters/adapters.md) — `listModels()` is the network call kept off the per-turn path; the registry supplies the model lists custom provider entries need
- [AI Functions](../../llm/ai_functions/ai_functions.md) — resolves its adapter from the same effective default mode, so drafting and running cannot disagree
- [Shell Environment Resolution](../../development/shell_environment/shell_environment.md) — the login-shell `PATH` that finds a user's own `opencode`, and `shellEnvForChild`, the same narrowing a stdio MCP server gets
- [Settings Scope](../../core/settings_scope/settings_scope.md) — the engine is machine-local; `localAgentsEnginePath` lives in the default scope
- [Resource Activation](../../core/resource_activation/resource_activation.md) — every engine channel requires an activated session
- [Main-Process Layering](../../development/main_layering/main_layering_llm.md) — thin IPC controllers; the engine's address and password never cross a boundary

Sub-doc: [Technical Details](engine_tech.md)
