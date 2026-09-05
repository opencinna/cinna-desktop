# Local Development

## Purpose

Get one Cinna profile from "signed in" to "this machine can do agent work", without the user opening a terminal: a desktop-owned toolchain (uv, cinna-cli, Mutagen) under `<userData>/localdev`, a cinna-cli **account workspace** at `<AgentsHome>/Cloud/<host>/` bootstrapped from a setup token the desktop mints with its own OAuth bearer — which is what removes the second browser login — and the opencode engine pre-fetched, so the first turn does not begin with a download.

## What this is not

Naming the non-goals first, because the feature is easy to over-read from its name:

- **No agent is cloned.** First run prepares the machine; fetching an agent is a later, explicit action.
- **No Mutagen session is started.** Mutagen is installed and put on the spawn `PATH` so cinna-cli finds *this app's* copy rather than prompting to `brew install` one. Nothing syncs.
- **`cinna dev` is never run.** The desktop drives `cinna account setup`, `cinna account set-token`, `cinna account status` and `cinna account refresh-context`, and nothing else.
- **Nothing is reimplemented that cinna-cli owns.** The desktop is *installer and orchestrator*: it puts the right binaries somewhere it controls, mints a token, spawns cinna-cli in the right directory, and reads the exit code. Workspace layout, the token exchange, the context package and sync are cinna-cli's, and there is deliberately no desktop code that knows what a workspace contains.
- **The opencode engine is pre-fetched, not owned.** It is not part of the cinna-cli toolchain and this feature does not install it: it asks the engine's own resolver to make sure a usable binary exists. What is decided here is *when*, not *how* or *where*.
- **Nothing is written outside two places, ever.** `<userData>/localdev` for the toolchain, `<AgentsHome>/Cloud/<host>/` for the workspace (the engine's own binary directory is the engine's, and unchanged by this). Not Homebrew, not the system Python, not `~/.local/bin` — with one exception the user has to press a button for (see *Your terminal*).

## Core Concepts

| Term | Definition |
|------|-----------|
| **Reconciler** | `localDevService.reconcile(userId, force?)` — the **one** entry point. Idempotent, single-flight, and the only way any of this happens |
| **Managed toolchain** | uv, Mutagen and cinna-cli installed into `<userData>/localdev/`, version-stamped so an upgrade installs beside the old copy rather than swapping a running binary's file |
| **Pins** | The versions in play. uv is pinned by *this app*; cinna-cli and Mutagen versions arrive from the server's `local_dev` discovery block. The desktop pins the **bytes** of uv and Mutagen against digest tables in source |
| **Account workspace** | `<AgentsHome>/Cloud/<host>/` — a cinna-cli-owned directory holding the account token and the context package. `.cinna/account.json` is the one file the desktop looks for, and only to answer "has cinna-cli set this up" |
| **Setup command** | The single-use, fifteen-minute string the server returns from the setup-token mint. Passed to cinna-cli as one argv element and never logged |
| **Consent** | A per-host yes/no, remembered — including the no. Stored as JSON in the `localDevConsent` app setting |
| **Engine pre-fetch** | Making sure a usable `opencode` binary is on this machine before anyone needs one. Runs alongside the rest, resolves through the [engine](../local_agents/engine.md)'s own three sources, and is **best effort** — a failure is shown and `ready` is still reached |
| **Attention reason** | Which of four things is wrong (`token_expired`, `toolchain`, `workspace`, `network`), derived from a cinna-cli exit code or a typed toolchain error and never from a message string |

## The state union

`LocalDevState` (`src/shared/localDevState.ts`) is one process-global value, pushed on every transition and pulled by whoever mounts late — the same shape as `UpdaterState`. It is per profile only in the sense that switching accounts re-reconciles; one profile is active at a time, so there is only ever one state.

| Phase | What it means to a user |
|---|---|
| `idle` | Nothing has been checked. No Cinna profile is active, or the first reconcile has not answered yet |
| `unsupported` / `server` | This Cinna instance does not offer local development to desktops |
| `unsupported` / `role` | The account lacks the `agent-developer` / `admin` role. A supported state, not a failure — Settings names the role and says to ask an admin |
| `consent` | Waiting on the user, per host. Nothing downloaded, nothing written outside `userData` |
| `declined` | Asked, and the answer was no. Remembered |
| `installing` | Working. `step` is user-visible text straight from the installer or cinna-cli; `percent` is a coarse hint, not a byte count |
| `ready` | Carries `workspacePath`, `cliVersion`, `cinnaBinPath`, and the `protocol` the installed cinna-cli turned out to support |
| `attention` | Broken in a way the reconciler can be asked to fix, with a `reason` and a shown `detail` |

Every phase also carries `tasks` — the per-step checklist the status modal renders — once a reconcile has run. It is empty before that, because there is nothing truthful to say about uv before anybody has looked.

**Six phases, not four.** The original design named `unsupported`, `installing`, `ready` and `attention`. `idle` and `declined` were added because each is a distinction the UI cannot make without them:

- `idle` vs `unsupported` — "we have not looked" and "this server does not offer it" produce the same empty screen but opposite answers to *why is there no Repair button*. A local profile is `idle`, and calling it `unsupported` would imply it could never be otherwise.
- `declined` vs `consent` — asked-and-declined vs never-asked. Settings has to offer "Set up local development" in one and the consent question in the other, and a screen that has to guess which it is looking at will eventually guess wrong. `declined` is also what keeps the onboarding step and the consent modal from re-asking every launch.

## User Stories / Flows

### First run on a server that offers it
1. The user connects a Cinna account through the ordinary Cinna Server path; activation fires `reconcile`
2. The onboarding screen advances to its `localdev` step, which waits for the reconciler's first answer
3. The reconciler discovers the instance's `local_dev` block, finds no recorded answer for this host, and lands on `consent`
4. The step renders the question: what will be installed, into the app's own data folder, and which folder will be created under the Agents Home — plus "Nothing is synced and no agent is downloaded"
5. **Set up** records consent and reconciles again. The same panel becomes the progress view rather than a second screen
6. uv, Mutagen and cinna-cli install — Mutagen alongside the other two rather than after them — while the opencode engine is fetched in the same wait; `cinna account setup` creates the workspace; the account token is checked
7. `ready`. The panel offers **Start using Cinna**

### First run from a `cinna://connect` link
1. The confirm screen for a [`cinna://connect` link](../../auth/onboarding/connect_link.md) carries **Enable local development** as a checkbox next to the **Connect** button, with a (?) showing the same "what gets installed" list the consent panel does
2. Connecting a server that offers local development is already most of that decision, so it rides along with the button that acts on it instead of becoming a screen of its own after sign-in
3. **It is ticked only for a host nobody has answered for.** An answer this machine already holds wins over the default, because the same panel is what an already-onboarded install shows and **Switch to it** can name a profile whose owner declined on purpose — re-ticking it for them would spend a few hundred megabytes reversing a deliberate decision. On a genuine first run the read simply finds nothing and the tick stands. What a stored answer never beats is the **user's own click**: once they have touched the box it is theirs, and a stored answer that resolves a moment later leaves it alone
4. Ticked or not, the answer is recorded for that host the moment the account exists, so the `localdev` step that follows has nothing left to ask: it shows the install running, or falls through
5. **Unticking is a real decline**, remembered for that host like any other — not a "remind me later". Settings → Local Development turns it back on

### First run where there is nothing to ask
1. `unsupported` (either reason) and `declined` both mean *nothing to ask*, and the onboarding step falls straight through to the app
2. Telling a new user about a feature they cannot have, on the screen whose job is to get out of the way, is an obstacle rather than information
3. If the reconciler has not answered within eight seconds the step gives up and lets the user in anyway. Local development is not required to use Cinna, and a server that never answers must not leave a first-run user watching a spinner

### An existing install that gains the feature
1. Either the user updates to a build that has it, or their server starts offering it
2. The next reconcile lands on `consent`, and `LocalDevConsentModal` asks — the only surface a running app has for a question the user did not go looking for
3. The modal shows for `consent` **and nothing else**. Progress, failure and readiness belong to the sidebar button and Settings; a modal that reappeared for each step would be an app that interrupts you to say it is busy
4. Escape and a backdrop click are deliberately *not* wired to a silent dismissal here (unlike the connect-intent modal): dismissing has to record an answer or the same modal returns on the next reconcile. **Skip is the dismissal**

### Declining, and changing your mind
1. **Skip** records `false` for that host. The prompt does not come back
2. Settings → Local Development shows the `declined` line and a **Set up** button
3. Pressing it calls `reconcile(force)`, which records `true` for that host and proceeds — pressing a button that says what it will do *is* the consent, and without recording it the press would loop straight back to the prompt
4. **Reset consent** forgets the answer entirely, so the next reconcile asks the question again

### Coming back to a machine that was ready
1. Activation, a re-auth and an OS resume each fire a reconcile
2. Every step checks whether it is already satisfied, so the common case is a discovery request, a stamp read and a token check
3. A token that expired overnight is refreshed in place with a fresh mint — not by recreating the workspace
4. A pinned version the server bumped, or a workspace folder the user deleted, is discovered here too

### Something went wrong
1. The sidebar footer shows a warning dot; clicking it runs Repair
2. Settings → Local Development shows the `detail` plus a per-reason hint saying what Repair will and will not do
3. The reason that earns real copy is `toolchain`: its commonest cause — a desktop older than the versions the server pinned — is the one thing Repair cannot fix, and a user left pressing the button would never find that out

### Running `cinna` yourself
1. Settings → Local Development → **Add to PATH** symlinks the managed `cinna` into `~/.local/bin`
2. **Opt-in, never automatic.** The app's copy exists so the desktop can drive it; a developer's terminal is theirs, and silently shadowing (or being shadowed by) a `cinna` they installed is the kind of surprise that costs an afternoon
3. An existing link that already points into the managed toolchain is refreshed — that is a version bump. **Any other file at that path is left strictly alone and reported**: it is someone's real install
4. Everything the desktop spawns is unaffected either way; it always goes through the toolchain environment

## Business Rules

### One entry point

`reconcile` is the only door. There is deliberately no `install()`, no `createWorkspace()` and no `repair()` that does something different — a second door into a state machine is a second place for it to be entered halfway. Repair *is* `reconcile(force)`.

It is **idempotent**: every step checks whether it is already satisfied and skips itself. And it is **single-flight**: a second caller joins the run in flight, because activation, an OS resume and a Repair click can easily land together and two simultaneous `uv tool install`s into the same directory is not a race worth having. **A `force` call that lands during an ordinary run joins it rather than restarting** — the case is a user pressing Repair during a long download, where finishing the download is what they want and a restart would throw away the bytes already on disk while looking identical from the outside.

Reconcile is triggered from exactly four places:

| Trigger | Where |
|---|---|
| A Cinna user activates | `src/main/auth/activation.ts` — on **every** activation, not only the first |
| A re-auth succeeds | `src/main/services/authService.ts:reauthCinna()` — non-blocking; a toolchain check must not make a successful re-auth report failure |
| The machine wakes | `powerMonitor.on('resume')` in `src/main/index.ts` |
| The user presses Repair / Set up | `localdev:repair`, and `localdev:consent` after recording an answer |

Sign-out and profile switch call `clear()`, which resets to `idle` — the state names a host and a folder belonging to the profile that is going away.

### The order of steps

1. **Discover.** No usable `local_dev` block in `/.well-known/cinna-desktop` → `unsupported/server`, and the end of it. The desktop must not go looking for endpoints an instance did not publish
2. **Consent.** Nothing is downloaded and nothing is written outside `userData` before the user has agreed, per host
3. **Toolchain.** uv, Mutagen and cinna-cli into `<userData>/localdev`, with the parts that do not need each other running at once
4. **Workspace.** `cinna account setup` with a minted setup command, into `<AgentsHome>/Cloud/<host>/`, unless `.cinna/account.json` is already there
5. **Token.** `cinna account status`; an `expired` token gets a fresh mint through `cinna account set-token`, and the status is re-read
6. **Engine pre-fetch**, started at step 3 and awaited here: `ready` is the point at which everything between the user and a first turn is in place, so it is the one thing worth waiting for at the end. It has usually finished long before
7. **Context package**, best effort: a `behind` package is refreshed, and a failure is logged and ignored. A stale context package is a worse copy of the platform docs, not a broken workspace, and failing readiness over it would make an offline moment look like a setup failure

A workspace someone created from a terminal at the same path is simply **adopted** at step 5 — it is the same thing cinna-cli would have made.

### Consent

- **Per host.** One desktop can hold accounts on several instances, and agreeing to install a toolchain and create a folder for one says nothing about another
- **`false` is a real answer**, stored, and is what keeps the prompt from reappearing on every launch. Absent means never asked
- Stored in the **default-scoped** `localDevConsent` app setting as a JSON `{ "<host>": boolean }` object. A string rather than a nested object because that store is one flat key-value table validated by `typeof` — so the shape is checked once in `appSettingsService` rather than defended at every read, since the value is also reachable through the generic `settings:set` channel
- A corrupt value reads as "nobody has been asked". The worst case is asking once more; never acting without an answer
- **`force` is the one thing that skips the question**, because the only ways to pass it are Repair and Settings' **Set up** — a button whose copy says what it will do. Any other reconcile stops at `consent` or `declined`
- **Where it is asked depends on how the account arrived.** A `cinna://connect` link asks it as a checkbox on the confirm screen, ticked unless this machine already holds an answer for that host; the ordinary Cinna Server path asks it as the `localdev` onboarding step; an install that gains the feature later is asked by the consent modal. All three render one explainer component, so no two of them can describe the same install differently
- **Recording an answer waits for the reconcile already in flight.** The connect screen answers within moments of activation, and the run that activation started read the consent *before* this one wrote it — joining that run, which is what a single-flight `reconcile` does, would answer "still waiting on the user" and quietly drop the answer just given. One discovery round trip is what an accept that always takes effect costs
- **The renderer remembers which hosts *this window* has answered.** Until main's reconcile has moved off `consent` the broadcast state still says "waiting on the user", which is how a screen that has just taken the answer asks it again for half a second. Only the surfaces that ask consult that list — it is a fact about the window, not about the machine — and Settings' **Reset consent** is the one thing that clears it, since otherwise the prompt it just re-armed would never appear

### The toolchain

Everything lives under `<userData>/localdev/`:

| Path | What |
|---|---|
| `uv-<version>/uv` | The pinned uv, plus its `uvx` sibling |
| `mutagen-<version>/` | The pinned Mutagen, plus the agent bundle it refuses to start a session without |
| `bin/` | `UV_TOOL_BIN_DIR` — `cinna` lands here |
| `uv-tools/` | `UV_TOOL_DIR` — the cinna-cli virtualenv |
| `python/` | `UV_PYTHON_INSTALL_DIR` — uv's own CPython |
| `uv-cache/` | `UV_CACHE_DIR` |
| `state.json` | What was installed, so a no-op ensure is cheap |

- **Version-stamped directory names are what make an upgrade safe**: a new pin installs beside the old one and no running process has its binary swapped underneath it. Reaping the old directory is deliberately not the installer's job
- **A desktop app that mutates a developer's machine outside its own data directory is a support problem forever.** Uninstalling Cinna should take the toolchain with it — and a pin only means something if this app owns the file, since a shared install is a version somebody else can move
- The spawn environment leads `PATH` with the toolchain's `bin/` and the pinned Mutagen directory, then **appends** the login-shell `PATH` rather than dropping it: the user's `git`, `ssh` and `docker` still have to resolve. The base is the user's full [login-shell environment](../../development/shell_environment/shell_environment.md), not the narrowed child-inherit allowlist used for MCP servers — every process here is uv or our own CLI, and `cinna` spawned by the desktop should behave exactly as it does in the user's terminal, proxy settings and CA bundle included
- **The parts that do not need each other install at once.** The only real dependency is `uv tool install cinna-cli` needing uv, so Mutagen's tens of megabytes download alongside uv's install and then alongside the cinna-cli one — arriving inside a wait that was happening anyway instead of after it. They write to different directories and publish through the same atomic rename, so concurrency costs nothing in safety; staging directory names carry a counter, because a pid and a millisecond cannot tell two installs started together apart
- **A failure does not stop its siblings.** The run reports it at once and whatever else was downloading keeps going in the background, rather than throwing away bytes the user has already paid for — the next run joins that download instead of starting the megabytes again. Which is why the sweep of abandoned staging directories now **exempts the ones this process is still using**: a pass that swept before joining deleted the directory of the very download it was about to wait on, and the download then died at its own checksum with a missing-file error that reads like a corrupt release. What the survivor also costs is a late progress report from a run that has already failed, which the reconciler ignores — see *The status checklist*
- `state.json` is **only ever trusted to skip work**. It is written after a verified install and re-derived by an actual `--version` probe the moment it disagrees, so a stale or hand-edited file costs one probe and never a wrong answer. A `cinna` installed by an older build — or by a run that died before writing the stamp — is adopted if it reports the pinned version

### The engine, pre-fetched

The last thing standing between a synced agent and its first turn is the [opencode engine](../local_agents/engine.md), and left alone it arrives **lazily** — at the moment somebody presses send. That is the worst time for a 46 MB download and the one time the user is certainly watching. So a reconcile makes sure a usable binary exists while it is already waiting on other things, and the checklist gets a row for it: **opencode engine**, between cinna-cli and the account workspace.

Two rules keep that honest.

- **It resolves through the engine's ordinary three sources**, in the ordinary order: a path configured in Settings, an `opencode` on the login-shell `PATH`, and only then the pinned, digest-verified download. So a developer who already has one has the row answered in milliseconds, with nothing downloaded and the detail saying *Already on this machine*. **Pre-caching must never mean acquiring a second copy of a tool the user already installed** — this feature decides *when*, never *how* or *where*.
- **It is best effort, and `ready` does not depend on it.** The reconcile carries on to `ready` — because local development genuinely is ready without it, and nothing is worse than before this existed; the lazy fetch is exactly the behaviour that was always there. A pre-fetch that did not happen leaves the row **`pending`**, not `failed`, reading *Not cached — … It will be fetched the first time you run an agent*. **Nothing is broken, so nothing should be red**: a failed row would sit under a green "ready" for the rest of the session, contradicted by an app that works, and nothing ever revisits it when the engine does arrive at first use. Not-yet-done is the truth.

It is started with the toolchain and awaited just before `ready`, so it shares a wait rather than adding one. On a warm machine it is finished long before that line; when it is not, it is the only row still moving — and it moves the overall bar itself, because by then nothing else is reporting.

There are now **two things that can ask for the engine** — this pre-fetch, and a turn resolving the binary as it starts — and they overlap in the obvious case: a user who sends a message while first-run setup is still going. A second download is *safe* (the loser publishes nothing), but safe is not the point when the whole purpose is to spend the bandwidth once, so the install is shared: the second asker joins the download already running rather than starting its own, and still sees it move.

### Two pin tables, and one deliberate gap

- **uv** is the desktop's own pin: one version, one digest table, nothing on the server has an opinion about it
- **Mutagen's version** is the one pin the desktop does not choose. It arrives as `local_dev.mutagen_version` because the sync sessions have to interoperate with what cinna-core expects. The server pins the *version*; the desktop's table pins the *bytes*
- **A Mutagen version absent from the table is a typed failure, never an unverified download.** The visible cost is real: a server that bumps its pin ahead of a desktop release leaves those users with "update Cinna Desktop" until a build ships with the new digests. The alternative — take the version *and* the URL from the server and run whatever comes back — would make every verification in the module decoration, since an attacker who can name the version can name the bytes. Being occasionally behind is the cheaper failure
- Both tables are resolved **before any work starts**, so a version with no digest is discovered before a user's bandwidth is spent on an install that cannot complete
- **cinna-cli is not hash-pinned.** It is `uv tool install cinna-cli==<version>` from PyPI, so the trust chain is TLS plus PyPI's own integrity. This is the weakest link and it is accepted knowingly — the alternatives (`--require-hashes` against a lock file the server would have to publish and keep in step, or serving a wheel from cinna-core) are real answers that belong to a later change
- What a digest buys, and what it does not, is the same story as the engine's: see [Binary resolution, and what "verified" means](../local_agents/engine.md#binary-resolution-and-what-verified-means). The mechanism is now literally shared — `src/main/managed/managedAsset.ts`

### The setup token and the role gate

- The desktop mints the setup command with **its own OAuth bearer** at the endpoint the instance publishes in `local_dev.setup_token_endpoint`, falling back to `/api/v1/cli/account/setup-tokens`. The instance naming its own endpoint matters on a split-host deployment where the API is not on the origin the user typed
- **The single-use token is the thing that removes the second browser login.** Without it, a user who has just authorized the desktop in a browser would have to authorize cinna-cli in a browser again
- **cinna-core restricts account setup tokens to `agent-developer` and `admin`.** A `403` is therefore *not* a dead session: it is mapped to `unsupported/role`, a supported state the UI explains and offers nothing to press. An `agent-user` gets everything else the desktop offers and this one thing they cannot have. (A `401` on the same call *is* a dead session and maps to `attention/token_expired`.)
- **`setup_command` is argv-only.** It goes from the HTTP response into an argv array and nowhere else — never into a log, never into an error `detail`, never into a state the renderer can read. `runCinnaCli` takes a separate `logArgs` with the secret already replaced, so logging a command is a decision someone has to take rather than a default someone can forget. `spawn` without a shell is what makes the argv promise real: no quoting, nothing for a token containing a shell metacharacter to escape into

### The division of labour with cinna-cli

The desktop installs and orchestrates. cinna-cli owns setup, the token exchange, the workspace layout, the context package and sync. The seam between them is a subprocess and an exit code:

- With `--json`, cinna-cli writes one JSON object per line to stdout and nothing else: progress lines, then a final `{"result":…}` line. `--json` implies `--no-input`, so a prompt can never stall a spawn with no terminal attached
- A stray non-JSON line is dropped rather than failing the run (capped, and logged) — that is cinna-cli's bug or a library printing over it, not a reason to fail a setup that may well have worked
- **Exit codes are the contract, not the text.** Messages are written for people and will change, so no message-string match is load-bearing

| Exit | Means | Becomes |
|---|---|---|
| `0` | ok | continue |
| `10` | the setup token was rejected (invalid, expired, already used) | `attention/token_expired` — almost always a token that expired between minting and use, and re-running mints a new one, so Repair is a real fix rather than a dead end |
| `11` | the token belongs to a different account than the workspace | `attention/workspace`, with copy saying to move the folder aside. Repair tries again, but no retry fixes this one |
| `12` | the platform could not be reached | `attention/network` |
| `2` | the desktop called cinna-cli wrongly | `attention/workspace` (the default branch) |
| `1` | everything else | `attention/workspace` |
| killed | the run overstayed its timeout | `attention/network` |

A run that exits non-zero is an **outcome, not a rejection**: `runCinnaCli` never rejects, because a rejection would drop the exit code that says which outcome it is.

### The desktop asks the cinna-cli it was given what it can do

The desktop does not choose the cinna-cli version — the server does, through `local_dev.cinna_cli_version` — so it can legitimately be handed one older than the surface this app prefers. That is not hypothetical: cinna-cli **0.3.0**, the version a real cinna-core pins today, has no `--json`, no `--no-input` and no `cinna account set-token`, and passing it those flags is a usage error that fails before the command does any work.

So before the first real invocation the desktop runs `--help` and reads what is there. `--help` and not a trial run, because 0.3.0 answers `1` to an unknown option, a missing workspace and a network failure alike — an exit code cannot tell "that flag does not exist" from "that would have worked".

Two surfaces result, and `ready` says which one it settled on:

| | `json` | `legacy` |
|---|---|---|
| Progress | a step per stage, from cinna-cli's own output | one step |
| Account token state | read from `cinna account status` | not visible; the desktop learns only that cinna-cli could read the workspace |
| An expired token | refreshed in place with a fresh mint | needs **Repair**, which sets the workspace up again |

Everything else works identically, and a `legacy` install really does create a real workspace. This is reported rather than hidden: Settings shows the one sentence about what the older cinna-cli cannot do, next to the version. A working badge that quietly could not refresh a token would be the worse failure.

### Progress is measured, not implied

The first run downloads a few hundred megabytes, and on an ordinary connection that is minutes. A spinner and a fixed label are indistinguishable from a hang for the whole of it, which is how a working install gets force-quit.

So every part of the wait that *can* be measured is:

- **The uv and Mutagen downloads** report real bytes. The byte counter that enforces the size limit is the same one that feeds the bar, so the two can never disagree, and the label carries `12.4 of 47.1 MB` because a percentage alone still cannot distinguish "slow" from "stuck".
- **`uv tool install`** has no byte count — it resolves and builds a dependency tree — so uv's own narration stands in. Each recognised line (`Resolved 41 packages`, `Prepared`, `Installed`) closes some of the remaining gap asymptotically, so the bar always advances and never arrives early.
- **`cinna account setup`** reports `step n of m` over the JSON protocol, which is real: each line is a step actually beginning.

The three toolchain components are weighted by how long they really take rather than split evenly — an even split would sit at 66% for most of the wait, which is exactly the "is it stuck?" the bar exists to answer — and the whole reconcile is scaled onto **one** monotonic 0–100. A bar that went backwards when the toolchain finished and the workspace began would read as a restart, which is worse than no bar.

Those weights are an **aggregation, not a set of ranges**. Each component reports its own 0–100, and the overall figure is the weighted sum of the highest each has reported, never allowed to fall. Fixed ranges — uv 0–20, Mutagen 20–55, cinna-cli 55–100 — were the first shape, and they stopped being expressible the moment the installs stopped happening in that order: Mutagen finishing while cinna-cli is halfway through has no honest answer on a range-based bar. The numbers are unchanged for a run that *does* happen sequentially: uv alone finishing is still 20%, uv and Mutagen still 55%. A component that is already installed reports 100 straight away, so a warm run starts where the finished work leaves it instead of pretending to redo the downloads.

The engine pre-fetch is the one part that cannot have a range, because it is not in the sequence — it runs beside everything else. It is a **share** instead: 15% of the bar, added to whatever the sequential part has reached. Without that the bar would sit at 97% for the length of a 46 MB download, which is the one shape a progress bar exists to avoid. 15% because it is a single download against a toolchain that is several, and because it is very often already satisfied — a developer with their own `opencode` reports 100 at once and simply starts the bar at 15.

**The engine has to be able to move that bar by itself.** A share that is only recomputed when something *sequential* reports is frozen for exactly the stretch it was added for: a warm toolchain and a warm workspace reach the token check in seconds and then wait on a cold download, with nothing sequential left to report. So the engine re-emits the blend as its bytes arrive, and the headline step shows its download line the way every other component's does while it works.

**And the published figure is clamped to never fall.** Both inputs to the blend only move forward, but the *sequence of steps* does not: the token check publishes 97, and a token that turns out to be expired sends the refresh back to 70. That is not new behaviour — it is what the bar always did on that path — and a bar that jumps back reads as a restart, which is worse than no bar. The clamp is held with the blend rather than at the one call site that needs it today, the same shape as the toolchain's own aggregation.

Where the server sends no `content-length`, the number counts up and the bar holds: a denominator that was invented is worse than one that is absent.

### Every component at once, not one at a time

The install shows a **list**: uv, Mutagen, cinna-cli, the opencode engine, the account workspace, the account token — all six from the start, each `pending`, `active`, `done` or `failed`, and each measurable one carrying its own bar.

Showing only the current step was the first attempt and it was not enough. "Installing Mutagen…" says something is happening; it does not say what is already finished, what is still ahead, or how much of *this* piece is left — so a user four minutes into a first run cannot tell whether they are two steps from the end or ten. The list is the answer to "what else is pending while this downloads".

Three rules keep it readable:

- **More than one row can be `active` at once.** The installs genuinely run together, so two spinners is the list working rather than a glitch — and it is why a row's completion is reported by whoever finished the work rather than inferred from a later row having started. It is also why **every** stopping failure goes through the one path that names a row and drops the others back to pending: a failure that only set the phase left the engine row spinning beside a red error, which is precisely the “and this part is fine” that path exists to prevent.
- **A measurable row keeps its bar for its whole life**: empty while pending, filling while active, full behind the tick once done, and stopped where it stopped — in the danger colour — when it failed. A row that is pending is not always empty either: one that was downloading when a *different* component failed keeps the bytes it really fetched, drawn muted rather than in the accent, because accent beside a row saying the run stopped reads as "still working". The track is in the same place from the first frame to the last, so the list does not reflow under someone who is reading how much is left. Only the **number** belongs to the moving row: a column of `0%` and `100%` buries the one figure the eye is looking for.
- **A component with nothing honest to measure gets no bar.** The account-token check is a single round trip; a bar for it would be decoration, and a bar that never moves is precisely what this list exists to remove.
- **Reaching `ready` does not tick off a row that did not happen** — a failed one, or the engine row when its pre-fetch was skipped. The run can succeed while one row did not, and painting it green on the way past would erase the only notice the user gets that the first turn will still fetch the engine.

The same list renders in the onboarding/progress panel and in the status modal, from one component, so the two cannot describe the same install differently. Above it sits one overall bar for the whole reconcile.

### The status checklist

The sidebar button opens the same checklist over a running app. It answers the two questions a single progress line cannot: how much is left, and *which part* broke.

**Completion is reported, not inferred.** Naming the current step used to be enough to tick off everything above it, because the reconciler could not reach the workspace without having installed the toolchain. Concurrency ends that: "a later component started" is no longer evidence that an earlier one finished, and ticking Mutagen off because cinna-cli began is exactly the lie a per-component checklist exists to make impossible. So each component says when it is done and the reconciler ticks that row and no other. The component id travels with the report rather than being parsed out of the step text, so renaming a user-facing label cannot silently stop the list advancing.

**A failure names its component**, and the error is what names it. Asking which row happens to be active stopped being an answer once several are — a cinna-cli failure was landing on Mutagen's row, accusing a download that was proceeding perfectly well — so the component travels on the error itself rather than being inferred, or read out of a `detail` that carries a stderr tail or a path exactly when it matters most. The rows still in flight drop back to `pending` rather than keeping their spinners: their work may well still be running, but a spinner beside a failure reads as "and this part is fine", which is not something the run can claim.

Only the **current** reconcile is allowed to narrate, and that claim is released when a run *ends* rather than when the next one starts — the window that matters is after a failure, while a sibling download is still going. The survivor keeps reporting for as long as it takes to finish, and without this its next cheerful line would replace the `attention` the user is looking at with a bar nothing will ever complete, leaving the failure true and invisible.

The button is now shown when everything is `ready` too, quietly and without a dot. That is a change from hiding it on success: clicking it is the only way to see which cinna-cli is installed and where the workspace went, and a control that vanishes when things work is a control nobody learns exists. The dot, not the icon, distinguishes "fine" from "wants you". It stays hidden for `idle`, `unsupported`, `consent` and `declined` — the consent question has its own surface, and the rest have nothing to report.

### Toolchain failures are not all "try again"

`download_failed` is the only toolchain failure that is really about the network, and it is the only one mapped to `attention/network`. Everything else — a platform with no pinned build, a Mutagen version shipped after this release, bytes that did not match — is about *this app* and maps to `attention/toolchain`. Lumping them together would offer "try again" for conditions no amount of trying fixes.

### Repair

`reconcile(force)` differs from an ordinary run in three ways:

- **It clears the discovery cache first.** Discovery is cached for the session, which is right for a check that runs on every activation and wrong for a button whose whole point is "look again" — a server that has just started offering local development, or bumped a pin, is exactly what the user is pressing about
- **It records consent and proceeds.** Repair and Settings' **Set up** are the only ways to pass `force`, and pressing a button whose copy says what it will do *is* the consent
- **It reinstalls the toolchain only when the toolchain is what broke** — that is, when the state Repair was pressed on was `attention/toolchain`, decided before the first `setState` overwrites the reason. Repair is one button for every failure and reinstalling uv, a Python and the cinna-cli dependency tree takes minutes; doing that because an account token expired overnight would turn a two-second fix into a coffee break. Everything else Repair does — look the server up again, re-check the token, re-read the workspace — happens either way

When the heavy path *is* taken, it deliberately **destroys the proof of a good install before rebuilding it**: the point of Repair is that the files may be there and still wrong. It removes the install directories and `state.json` but keeps the uv cache and the downloaded Python, which is the difference between a repair that takes seconds and one that re-downloads a hundred megabytes.

## Architecture Overview

```
activation / reauth / resume / Repair
        │
        ▼
localDevService.reconcile(userId, force)      ← single-flight, idempotent
        │
        ├─ discoverCinnaEndpoints ─────────► /.well-known/cinna-desktop → local_dev
        ├─ consent (localDevConsent setting, per host)
        ├─ toolchain.ensure / .repair ─────► managedAsset: stage → verify → publish
        │                                     uv · Mutagen · (uv tool install cinna-cli)
        ├─ cinnaFetch POST setup-tokens ───► cinna-core (OAuth bearer; 403 = role gate)
        ├─ prefetchEngineBinary ──────────► the engine's own three sources
        │     (alongside the above, awaited before `ready`; never throws)
        └─ runCinnaCli ───────────────────► cinna account setup / set-token / status
                                             in <AgentsHome>/Cloud/<host>/
        │
        ▼
  LocalDevState ──localdev:state──► renderer store
                                      ├─ LocalDevOnboardingStep  (first run)
                                      ├─ LocalDevConsentModal    (consent, after first run)
                                      ├─ LocalDevStatusButton    (installing / attention)
                                      └─ LocalDevSettingsSection (every phase)

  ConnectIntentPanel ──consent(host, accepted)──► localdev:consent
    (the opt-in checkbox on the cinna://connect confirm screen,
     seeded from any answer this machine already holds)
```

## Integration Points

- [Cinna Accounts](../../auth/cinna_accounts/cinna_accounts.md) — the OAuth session whose bearer mints setup tokens; local development exists only for a `cinna_user` profile
- [Cinna Re-authentication](../../auth/cinna_accounts/reauthentication.md) — a successful re-auth fires a reconcile, because a dead session is the usual reason the workspace's account token went stale too
- [Onboarding](../../auth/onboarding/onboarding.md) — the `localdev` step is the last step of the Cinna path
- [The `cinna://connect` Link](../../auth/onboarding/connect_link.md) — the other route in, and the one that answers the consent question on its confirm screen rather than in a step of its own
- [Agents Home, Scanner & Folder Index](../local_agents/folder_index.md) — the account workspace is created under the Agents Home, and `Cloud/` is the [kit contract](../local_agents/kit_contract.md)'s `workshop.cloud_dir` rather than a literal in this feature's code
- [The Local Engine](../local_agents/engine.md) — shares `managedAsset.ts`, is the other consumer of the "the directory existing is the proof its bytes were verified" invariant, and owns the binary this feature pre-fetches: the resolution order, the pin and the digest are all the engine's, unchanged
- [Shell Environment Resolution](../../development/shell_environment/shell_environment.md) — the base every spawned tool's environment is built from
- [Settings Scope](../../core/settings_scope/settings_scope.md) — `localDevConsent` is default-scoped (an install-wide setting keyed by host), not profile-scoped
- [Local Agents Are Not Synced](../local_agents/local_only.md) — the account workspace is a machine-local folder like any other; nothing here changes that

## Known gaps

Carried honestly rather than implied as passing.

- **The reconciler's *sequence* is not unit-tested.** `localDevService.test.ts` covers the part that is a contract — how a toolchain code and a cinna-cli exit code become what the user is told — but the ordering itself, the 403 role branch, the token-refresh branch and the single-flight collapse are exercised only through `cinna-integration.spec.ts` and through their parts. A reconciler test needs a database, a window and a server, which is why it was left to the live run
- **Three branches have never executed anywhere.** The `unsupported/role` 403 (the account used for the live run is an admin), the expired-token refresh (no expired token to hand), and `addToPath` (no test at all)
- **Windows is absent from both pin tables**, because the desktop does not build for it. A musl-only Linux distribution is the same known gap the engine has
- **The context-package refresh is fire-and-forget.** A repeated failure is logged and never surfaced anywhere the user can see
- **The OS `open-url` hook and the packaged scheme registration are untested.** Playwright cannot raise a Launch Services event, so the E2E specs enter the funnel through the test-only argv flag and everything below the hook is real — but that a *packaged* build actually claims `cinna://` has only been asserted by the `protocols:` block in `electron-builder.yml`, never by installing a DMG and clicking a link
- **`localDevConsent` is installation-global, not per profile.** Two Cinna profiles on the same host share one consent answer. The host is the key because the toolchain and the workspace are per host too, but a second profile on the same instance inherits the first's decision without being asked
