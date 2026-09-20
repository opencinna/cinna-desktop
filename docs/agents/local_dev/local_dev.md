# Local Development

## Purpose

Prepare a signed-in Cinna account for local agent development, then offer a one-click entry to a chat that builds through cinna-cli. Desktop owns tool installation and account-workspace orchestration; the selected local assistant performs the requested development with the actual workspace context and Cinna Core status checks.

[Account Build Sessions](build_sessions.md) covers the composer, guide, runtime settings and saved-session lifecycle; [Technical Reference](local_dev_tech.md) covers setup and reconciliation.

## Scope and non-goals

Setup prepares the machine; an explicit build prompt or Develop action performs later agent work. The following guarantees concern setup orchestration, not the commands an assistant may subsequently run:

- **No agent is cloned.** First run prepares the machine; fetching an agent is a later, explicit action.
- **No Mutagen session is started.** Mutagen is installed and put on the spawn `PATH` so cinna-cli finds *this app's* copy rather than prompting to `brew install` one. Nothing syncs.
- **Setup never runs `cinna dev`.** The reconciler drives `cinna account setup`, `cinna account set-token`, `cinna account status` and `cinna account refresh-context` for workspace setup and maintenance. Build-session tools and the separate Develop action have their own command flows.
- **Nothing is reimplemented that cinna-cli owns.** The desktop is *installer and orchestrator*: it puts the right binaries somewhere it controls, mints a token, spawns cinna-cli in the right directory, and reads the exit code. Workspace layout, the token exchange, the context package and sync are cinna-cli's, and the desktop reads only the defined CLI result contracts and a fixed set of public guide documents for the build briefing.
- **The opencode engine is pre-fetched, not owned.** It is not part of the cinna-cli toolchain and this feature does not install it: it asks the engine's own resolver to make sure a usable binary exists. What is decided here is *when*, not *how* or *where*.
- **The managed setup toolchain and workspace stay in two places.** `<userData>/localdev` for the toolchain, `<AgentsHome>/Cloud/<host>/` for the workspace (the engine's own binary directory is the engine's, and unchanged by this). Not Homebrew, not the system Python, not `~/.local/bin` — with one exception the user has to press a button for (see *Your terminal*).

## Core Concepts

| Term | Definition |
|------|-----------|
| **Reconciler** | `localDevService.reconcile(userId, force?)` — the **one setup** entry point. Idempotent and serialized; same-profile callers share a run, while another profile waits for the former run to drain |
| **Managed toolchain** | uv, Mutagen and cinna-cli installed into `<userData>/localdev/`. uv and Mutagen use versioned directories; cinna-cli uses a stable launcher and uv-managed environment that an update replaces in place |
| **Pins** | The versions in play. uv is pinned by *this app*; cinna-cli and Mutagen versions arrive from the server's `local_dev` discovery block. The desktop pins the **bytes** of uv and Mutagen against digest tables in source |
| **Account workspace** | `<AgentsHome>/Cloud/<host>/` — a cinna-cli-owned directory holding the account token and the context package. The reconciler checks `.cinna/account.json` for setup presence; the build guide separately reads a fixed allowlist of public Markdown documents |
| **Setup command** | The single-use, fifteen-minute string the server returns from the setup-token mint. Passed to cinna-cli as one argv element and never logged |
| **Consent** | A per-host yes/no, remembered — including the no. Stored as JSON in the `localDevConsent` app setting |
| **Engine pre-fetch** | Making sure a usable `opencode` binary is on this machine before anyone needs one. Runs alongside the rest, resolves through the [engine](../local_agents/engine.md)'s own three sources, and is **best effort** — a failure is shown and `ready` is still reached |
| **Build session** | A direct chat with an internal local builder bound to the active profile, account workspace and selected engine; see [Account Build Sessions](build_sessions.md) |
| **Attention reason** | Which of five things is wrong (`token_expired`, `toolchain`, `workspace`, `account_mismatch`, `network`), derived from a cinna-cli exit code, a typed toolchain error or a failed capability check, never by parsing a message string |
| **Reconnect** | `localDevService.reconnectWorkspace(userId)` — the only exit from `account_mismatch`: rename the workspace that belongs to another account aside, then reconcile. Not a second setup door; it ends in the same `reconcile(force)` |

## The state union

`LocalDevState` (`src/shared/localDevState.ts`) is one process-global value, pushed on every transition and pulled by whoever mounts late — the same shape as `UpdaterState`. It belongs to the active profile: every activation first clears it to `idle`, including a move to a local/default profile or logout. The previous profile loses permission to publish progress or readiness immediately, before the next profile reload awaits. Shared installed-tool information is a separate read and survives that reset.

| Phase | What it means to a user |
|---|---|
| `idle` | Nothing has been checked. No Cinna profile is active, or the first reconcile has not answered yet |
| `unsupported` / `server` | This Cinna instance does not offer local development to desktops |
| `unsupported` / `role` | The account lacks the `agent-developer` / `admin` role. A supported state, not a failure — Settings names the role and says to ask an admin |
| `consent` | Waiting on the user, per host. Nothing downloaded, nothing written outside `userData` |
| `declined` | Asked, and the answer was no. Remembered |
| `installing` | Working. `step` is user-visible text straight from the installer or cinna-cli; `percent` is a coarse hint, not a byte count |
| `ready` | Carries `workspacePath`, `cliVersion`, `cinnaBinPath`, and the `protocol` the installed cinna-cli turned out to support |
| `attention` | Broken, with a `reason` and a shown `detail`. Four of the five reasons are what the reconciler can be asked to fix; `account_mismatch` is the one it cannot, and the surfaces offer Reconnect for it |

Every phase also carries `tasks` — the per-step checklist the build setup page renders — once a reconcile has run. It is empty before that, because there is nothing truthful to say about uv before anybody has looked.

**Idle, consent and declined are separate states.** The UI must distinguish a check that has not run from a question waiting for an answer and a remembered refusal:

- `idle` vs `unsupported` — "we have not looked" and "this server does not offer it" produce the same empty screen but opposite answers to *why is there no Repair button*. A local profile is `idle`, and calling it `unsupported` would imply it could never be otherwise.
- `declined` vs `consent` — asked-and-declined vs never-asked. Settings has to offer "Set up local development" in one and the consent question in the other, and a screen that has to guess which it is looking at will eventually guess wrong. `declined` is also what keeps the onboarding step and the consent modal from re-asking every launch.

## User Stories / Flows

### Start or resume a build conversation

1. Click the Local Development footer icon to open the build page. A healthy workspace proceeds to a focused input; unfinished setup or runtime prerequisites are explained on the same page.
2. Check the compact instance/account/runtime header, describe the agent, and press **Start building** below the input. Opening the page or choosing a suggestion sends nothing; the first message prepares an account-bound builder and starts an ordinary direct chat.
3. **Build guide** opens the actual session briefing and available workspace Markdown in a modal. **Settings** selects an inherited or separate build runtime and work complexity, defaulting to Complex (Claude Opus / Codex high effort).
4. A previous conversation waits for startup restoration before readiness is decided. Real problems use the shared warning above the input; a changed account/workspace/engine requires a new compatible build session.

See [Account Build Sessions](build_sessions.md) for complete flows, runtime rules, draft lifetime and cancellation limits.

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
5. **Unticking is a real decline**, remembered for that host like any other — not a "remind me later". Settings → Profile → Local Development turns it back on

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
2. Settings → Profile → Local Development shows the `declined` line and a **Set up** button
3. Pressing it calls `reconcile(force)`, which records `true` for that host and proceeds — pressing a button that says what it will do *is* the consent, and without recording it the press would loop straight back to the prompt
4. **Reset consent** forgets the answer entirely, so the next reconcile asks the question again

### Coming back to a machine that was ready
1. Activation, a re-auth and an OS resume each fire a reconcile
2. Every step checks whether it is already satisfied, so the common case is a discovery request, a stamp read and a token check
3. A token that expired overnight is refreshed in place with a fresh mint — not by recreating the workspace
4. A pinned version the server bumped, or a workspace folder the user deleted, is discovered here too

### Something went wrong
1. The sidebar footer shows a warning dot; clicking it opens the build setup page, whose notice offers up to three actions — **Reconnect workspace**, **Re-authenticate**, **Retry setup** — ordered and weighted by what actually ends the reason it is showing
2. Settings → Profile → Local Development shows the `detail` plus a per-reason hint saying what Repair will and will not do
3. Two reasons earn real copy, for the same reason: Repair cannot fix either, and a user left pressing the button would never find that out. `toolchain`'s commonest cause is a desktop older than the versions the server pinned; `account_mismatch` is a folder that belongs to another account, which is what Reconnect is for

### Reconnecting a workspace that belongs to another account

1. The user signs in as a different Cinna account on a machine whose `<AgentsHome>/Cloud/<host>/` was set up by the previous one. cinna-cli refuses the setup token with exit `11`, and the reconcile lands on `attention/account_mismatch`
2. The build page shows cinna-cli's own detail, which typically ends by telling the user to run `cinna account setup` in a new directory (the desktop's fallback sentence, used when cinna-cli sent no detail, only names the cause). Under it are three sentences that close the loops that advice leaves open: no terminal is needed, **Retry setup cannot fix this one** because it asks the server for the same account again, and agents opened with Develop keep pointing at the old folder until they are Developed again
3. **Reconnect workspace** carries the accent, because it is the only action that ends this state. **Re-authenticate** sits beside it for the user who meant to be signed in as the other account, and **Retry setup** stays last — still the escape hatch if the reason was misread
4. Reconnect renames `<host>/` to `<host>.old-<UTC stamp>` beside it and reconciles with `force`, so setup runs from scratch into a fresh `<host>/`. The old folder is never deleted
5. Settings → Profile → Local Development shows the same pair for this reason: Reconnect is the primary button and Repair is demoted beside it rather than removed

**Only the action that was pressed says it is running**, and it says so with a spinner on its own icon rather than a changed label: the row wraps, and a button that widened into "Reconnecting…" would re-flow it and move the composer under the user's pointer. Everything else in the row disables while a short local action runs — but **never behind a re-authentication**, which waits on a browser tab the user may simply have closed, and ten minutes of dead buttons is a trap rather than a safeguard.

### Running `cinna` yourself
1. Settings → Default → Local Development → **Add to PATH** symlinks the managed `cinna` into `~/.local/bin`
2. **Opt-in, never automatic.** The app's copy exists so the desktop can drive it; a developer's terminal is theirs, and silently shadowing (or being shadowed by) a `cinna` they installed is the kind of surprise that costs an afternoon
3. A link is refreshed only when its normalized destination is exactly the managed `bin/cinna` launcher. **Other files and links are left alone and reported**, including similarly named directories and paths that escape the managed root
4. Linking requires an installed managed CLI, not a ready account workspace; unsupported or local profiles do not hide a shared installation. The IPC still requires an activated session. Everything the desktop spawns uses the toolchain environment independently of the link

### Develop a Remote Agent

1. Open a Cinna-synced agent from the Agents sidebar. When Local Development is ready and the agent passes development eligibility, its header offers **Develop**.
2. Desktop asks the managed CLI for the account status and reuses the agent workspace reported there. Only a missing workspace triggers `agent sync`; Desktop then asks for status again. Existing local work is not force-resynced each time.
3. Desktop resolves both paths to real paths and requires the reported agent directory to be strictly inside the account workspace. The account root itself and paths escaping through symlinks are refused.
4. Desktop creates or reuses a **Develop <agent name>** command-line ACP connection running OpenCode inside that directory, with managed Cinna/Mutagen tools on its PATH. Preparation opens that connection's chat landing page without sending a prompt.

Eligibility requires a remote `agent` target and target ID, excludes explicit `can_build: false` and foreign installs, and excludes consumer bundles while allowing publisher working copies. These metadata checks are not independent proof of developer-role entitlement; CLI/server access controls remain authoritative. Main rechecks profile, cached target identity and eligibility after asynchronous preparation stages. Concurrent calls for the same profile/agent share one preparation; failures remain on the source page.

The header visibility check accepts any `ready` phase, but preparation additionally requires the CLI's **JSON workspace protocol**. A legacy-ready installation can show Develop and then receive an update/setup error; the service cannot safely infer paths from a CLI that does not report them. Reusing a connection is based on its generated name and exact canonical workspace directory, not a persisted remote-to-local mapping.

### Inspecting shared desktop tools

1. **Default → Local Development** shows the managed cinna-cli executable path and the version that executable reports. An editable checkout can differ from a server pin or an older installation stamp; the readout must describe the executable, not the stamp. Missing installation and an installed executable with an unknown version are distinct states.
2. **Developer Tools** on that page reports detected tools and the bundled kit contract. When the managed Cinna CLI is installed, its row uses that executable's version and path and says **(managed)**; a newer shell `cinna` must not make the desktop appear compatible. Without a managed installation the row retains the detected tool result. OpenCode reports the engine resolver's actual binary, including a configured or downloaded copy.
3. **OpenCode Path** below the table changes the installation-wide executable override. Runtime selection and Open agents with remain under Default → Agents → Runtime. See [engine configuration](../local_agents/engine_tech.md#configuration).
4. **Profile → Local Development** renders workspace status, setup/repair, Open folder and the server's consent. It remounts on account changes so pending page controls do not carry over. The profile page never uses shared CLI presence as proof that this account's workspace is ready.

### Updating the managed Cinna CLI

1. Open **Settings → Default → Local Development → Developer Tools**. The Cinna CLI row shows the installed executable version and **Required by server** when the connected account's discovery advertises a target. **Refresh** rereads the managed executable, detected tools and current server target.
2. **Update** is offered only when both managed and advertised versions are recognized and the advertised version is newer. The target is the connected server's release, not the latest PyPI release. Equal/older targets, unknown/missing installed versions, a local profile without a Cinna server, and an editable CLI checkout do not offer Update.
3. Press Update to update the shared managed tooling. The disabled **Updating…** button spins and a status line remains visible; Refresh and another Update cannot overlap it. This is stage feedback, not a measured download percentage. Completion refreshes the readouts and says **Cinna CLI updated.** Discovery or installation errors stay inline, with Refresh or a later Update available to retry.
4. Updating tools does not answer setup consent, prepare the Agents Home, create an account workspace or mint/refresh an account token. An unanswered or declined setup remains so. Setup and Repair retain their own explicit account actions under **Profile → Local Development**.
5. An already-ready workspace is temporarily marked installing, then receives the updated CLI version/path/protocol. Failure instead marks the affected tool and requires toolchain attention; Repair can reinstall it. A profile switch prevents the old operation from publishing readiness to the new profile, while an already-started tool install may finish.

## Business Rules

### One setup entry point

`reconcile` is the only door into workspace setup. There is deliberately no `install()`, no `createWorkspace()` and no `repair()` that does something different — a second door into a state machine is a second place for it to be entered halfway. Repair *is* `reconcile(force)`.

It is **idempotent**: every step checks whether it is already satisfied. Concurrent calls for the **same profile** share one run, including Repair during an ordinary install. A different profile immediately retires the former state and waits for the previous run to drain before starting its own account work. Requests queued for a profile that has since been replaced are skipped. Running downloads and subprocesses are not cancelled; they may finish, but cannot publish old results or start a later account step.

Both toolchain branches finish before an install failure returns. uv/cinna-cli and Mutagen write into shared installation state; returning while a sibling still writes would allow the next account's different pins to overlap it. Engine prefetch has its own shared resolver and may outlive a failed reconcile, but its old progress and completion cannot change the new profile's state.

Reconcile is triggered by account lifecycle and explicit recovery; a saved builder also joins it when startup is idle/installing:

| Trigger | Where |
|---|---|
| A Cinna user activates | `src/main/auth/activation.ts` — on **every** activation, not only the first |
| A re-auth succeeds | `src/main/services/authService.ts:reauthCinna()` — non-blocking, only when the reauthenticated account is still current and activated; an OAuth flow may finish after a switch |
| The machine wakes | `powerMonitor.on('resume')` in `src/main/index.ts` |
| The user presses Repair / Set up | `localdev:repair`, and `localdev:consent` after recording an answer |
| The user presses Reconnect workspace | `localdev:reconnect-workspace`, after the old workspace has been renamed aside |
| A saved builder resumes during startup | `restoreDevelopmentContext` joins reconciliation before readiness/turn preparation; settled failures are not automatically retried |

Every activation begins with `clear()` synchronously, and deactivation also clears. Login and logout can call activation directly, so clearing only during deactivation would leave a former Cinna workspace visible while a local/default profile loads. A cleared state has no checklist or openable workspace.

### The order of steps

1. **Discover.** No usable `local_dev` block in `/.well-known/cinna-desktop` → `unsupported/server`, and the end of it. The desktop must not go looking for endpoints an instance did not publish
2. **Consent.** Nothing is downloaded and nothing is written outside `userData` before the user has agreed, per host
3. **Toolchain.** uv, Mutagen and cinna-cli into `<userData>/localdev`, with the parts that do not need each other running at once
4. **Workspace.** `cinna account setup` with a minted setup command, into `<AgentsHome>/Cloud/<host>/`, unless `.cinna/account.json` is already there
5. **Token.** `cinna account status`; an `expired` token gets a fresh mint through `cinna account set-token`, and the status is re-read
6. **Engine pre-fetch**, started at step 3 and awaited here: `ready` completes workspace setup; the build page separately checks the selected runtime before enabling its composer. It has usually finished long before
7. **Context package**, best effort: a `behind` package is refreshed, and a failure is logged and ignored. A stale context package is a worse copy of the platform docs, not a broken workspace, and failing readiness over it would make an offline moment look like a setup failure

A workspace someone created from a terminal at the same path is simply **adopted** at step 5 — it is the same thing cinna-cli would have made.

### Consent

- **Per host, installation-wide.** Accounts on the same server share the answer, including a decline. Moving the controls to Profile settings does not migrate consent to per-user storage. Agreeing for one instance says nothing about another
- **`false` is a real answer**, stored, and is what keeps the prompt from reappearing on every launch. Absent means never asked
- Stored in the **default-scoped** `localDevConsent` app setting as a JSON `{ "<host>": boolean }` object. A string rather than a nested object because that store is one flat key-value table validated by `typeof` — so the shape is checked once in `appSettingsService` rather than defended at every read, since the value is also reachable through the generic `settings:set` channel
- A corrupt value reads as "nobody has been asked". The worst case is asking once more; never acting without an answer
- **`force` is the one thing that skips the question**, because the only ways to pass it are Repair and Settings' **Set up** — a button whose copy says what it will do. Any other reconcile stops at `consent` or `declined`
- **Where it is asked depends on how the account arrived.** A `cinna://connect` link asks it as a checkbox on the confirm screen, ticked unless this machine already holds an answer for that host; the ordinary Cinna Server path asks it as the `localdev` onboarding step; an install that gains the feature later is asked by the consent modal. All three render one explainer component, so no two of them can describe the same install differently
- **Recording an answer waits for the reconcile already in flight.** The connect screen answers within moments of activation, and the run that activation started read the consent *before* this one wrote it — joining that run, which is what a single-flight `reconcile` does, would answer "still waiting on the user" and quietly drop the answer just given. The waiting answer captures its profile before the wait; if that profile is replaced, it does not restart its setup afterward
- **The renderer remembers which hosts *this window* has answered.** Until main's reconcile has moved off `consent` the broadcast state still says "waiting on the user", which is how a screen that has just taken the answer asks it again for half a second. Only the surfaces that ask consult that list — it is a fact about the window, not about the machine — and **Reset consent** clears that host. An `idle` profile reset clears every temporary marker, so an earlier profile cannot suppress the next question; a late rejection from the earlier profile cannot erase a newer same-host answer

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

- **uv and Mutagen use versioned directories**: a new pin installs beside their old copies; reaping old directories is deliberately not the installer's job. cinna-cli instead uses the stable `bin/cinna` launcher and `uv-tools/` environment, which `uv tool install` updates in place. The shared operation queue prevents setup and Update from mutating the toolchain together; it does not promise isolation for a CLI process already using that installation
- **A desktop app that mutates a developer's machine outside its own data directory is a support problem forever.** Uninstalling Cinna should take the toolchain with it — and a pin only means something if this app owns the file, since a shared install is a version somebody else can move
- The spawn environment leads `PATH` with the toolchain's `bin/` and the pinned Mutagen directory, then **appends** the login-shell `PATH` rather than dropping it: the user's `git`, `ssh` and `docker` still have to resolve. The base is the user's full [login-shell environment](../../development/shell_environment/shell_environment.md), not the narrowed child-inherit allowlist used for MCP servers — every process here is uv or our own CLI, and `cinna` spawned by the desktop should behave exactly as it does in the user's terminal, proxy settings and CA bundle included
- **The parts that do not need each other install at once.** The only real dependency is `uv tool install cinna-cli` needing uv, so Mutagen's tens of megabytes download alongside uv's install and then alongside the cinna-cli one — arriving inside a wait that was happening anyway instead of after it. They write to different directories and publish through the same atomic rename, so concurrency costs nothing in safety; staging directory names carry a counter, because a pid and a millisecond cannot tell two installs started together apart
- **A failed toolchain branch does not cancel its sibling, and the installer waits for both before returning the failure.** The uv/cinna-cli branch and Mutagen branch drain together, so the next queued Update or reconcile cannot start writing or sweeping their shared toolchain root while either is still installing. Completed downloads remain available to the next run. The staging sweep also exempts directories this process is actively using: deleting a live staging directory previously made its download fail at checksum with a missing-file error that looked like a corrupt release. The separate best-effort engine prefetch can outlive a failed reconcile; its late progress is ignored once that run retires, and another engine caller can join its shared download — see *The engine, pre-fetched* and *The status checklist*
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
| `11` | the token belongs to a different account than the workspace | `attention/account_mismatch` — its own reason rather than a `workspace` failure, because no retry fixes it: every Repair mints another token for the same account and is refused identically. Having its own reason is what lets the surfaces offer Reconnect, which does fix it |
| `12` | the platform could not be reached | `attention/network` |
| `2` | the desktop called cinna-cli wrongly | `attention/workspace` (the default branch) |
| `1` | everything else | `attention/workspace` |
| killed | the run overstayed its timeout | `attention/network` |

A run that exits non-zero is an **outcome, not a rejection**: `runCinnaCli` never rejects, because a rejection would drop the exit code that says which outcome it is.

A reason exists so a surface can offer the button that ends it. What each one is answered with:

| Reason | What ends it |
|---|---|
| `token_expired` | **Retry setup** / Repair, which mints a fresh token. **Re-authenticate** as well, since a dead desktop session is the usual reason the account token went stale with it |
| `toolchain` | **Retry setup** / Repair, which reinstalls — except for its commonest cause, a desktop older than the versions the server pinned, which no button here fixes |
| `workspace` | **Retry setup** / Repair |
| `account_mismatch` | **Reconnect workspace**, and only that. Repair mints another token for the same account and is refused identically; Re-authenticate is offered beside it for the user who meant to be signed in as the other account |
| `network` | **Retry setup** / Repair. Nothing is wrong; try again |

### The desktop asks the cinna-cli it was given what it can do

The desktop does not choose the cinna-cli version — the server does, through `local_dev.cinna_cli_version` — so it can legitimately be handed one older than the surface this app prefers. That is not hypothetical: cinna-cli **0.3.0**, previously pinned by a real cinna-core deployment, has no `--json`, no `--no-input` and no `cinna account set-token`, and passing it those flags is a usage error that fails before the command does any work.

The released JSON workspace protocol starts at **Cinna CLI 0.4.0**. Compatibility guidance names that minimum, the installed version (or that it is unknown), and **Default → Local Development**. If the server still advertises an older version, its administrator must advance that pin; reinstalling the same old release cannot add JSON support. The version is guidance: successful capability probes remain authoritative, including for editable builds.

So before the first real invocation the desktop runs `--help` and reads what is there. `--help` and not a trial run, because 0.3.0 answers `1` to an unknown option, a missing workspace and a network failure alike — an exit code cannot tell "that flag does not exist" from "that would have worked".

Each help probe runs in a disposable writable temporary directory. cinna-cli initializes a log even for help; inheriting `/` from a Finder launch previously made a modern CLI fail and look legacy. Both help processes must finish before the directory is removed. A timeout, failed start, nonzero exit or empty help response is a failed check, not evidence that flags are absent, and failures are never cached. During setup this marks cinna-cli failed with toolchain attention, so **Repair** reinstalls rather than repeatedly trusting the same broken installation.

**Check again** on the build page or its runtime details rereads the managed executable and bypasses the capability cache. It does not install tools or change consent. The button says **Checking…**, spins and blocks duplicate clicks for the check's duration, with a short minimum so immediate results register; errors retain the page and draft. Successful checks refresh the displayed CLI/protocol and build prerequisites. A failed explicit check reports its error without claiming a new protocol.

Two successfully probed surfaces result, and `ready` says which one it settled on:

| | `json` | `legacy` |
|---|---|---|
| Progress | a step per stage, from cinna-cli's own output | one step |
| Account token state | read from `cinna account status` | not visible; the desktop learns only that cinna-cli could read the workspace |
| An expired token | refreshed in place with a fresh mint | needs **Repair**, which sets the workspace up again |

A `legacy` install really does create a workspace; both account build sessions and the explicit Develop action additionally require JSON workspace reporting. This is reported rather than hidden: Profile → Local Development shows what the older cinna-cli cannot do beside workspace readiness; Default → Local Development shows the actual managed executable version. A working badge that quietly could not refresh a token would be the worse failure.

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

The same list renders in the onboarding/progress panel and in the build setup page, from one component, so the two cannot describe the same install differently. Setup progress surfaces can also show the overall reconcile percentage; the build page renders the current step and per-component checklist.

### The status checklist

While setup is incomplete, the sidebar button opens a build page with this checklist. It answers the two questions a single progress line cannot: how much is left, and *which part* broke.

**Completion is reported, not inferred.** Naming the current step used to be enough to tick off everything above it, because the reconciler could not reach the workspace without having installed the toolchain. Concurrency ends that: "a later component started" is no longer evidence that an earlier one finished, and ticking Mutagen off because cinna-cli began is exactly the lie a per-component checklist exists to make impossible. So each component says when it is done and the reconciler ticks that row and no other. The component id travels with the report rather than being parsed out of the step text, so renaming a user-facing label cannot silently stop the list advancing.

**A failure names its component**, and the error is what names it. Asking which row happens to be active stopped being an answer once several are — a cinna-cli failure was landing on Mutagen's row, accusing a download that was proceeding perfectly well — so the component travels on the error itself rather than being inferred, or read out of a `detail` that carries a stderr tail or a path exactly when it matters most. The rows still in flight drop back to `pending` rather than keeping their spinners: their work may well still be running, but a spinner beside a failure reads as "and this part is fine", which is not something the run can claim.

Only the **current** reconcile may publish progress or completion. Ownership ends both when the run finishes and when its profile is invalidated. An old engine prefetch or subprocess callback previously could restore an old progress bar after a failure or switch; generation checks now leave the current state intact.

The button is now shown when everything is `ready` too, quietly and without a dot. That is a change from hiding it on success: clicking it opens the build composer; the settings pages also expose the managed CLI and workspace, and a control that vanishes when things work is a control nobody learns exists. The dot, not the icon, distinguishes "fine" from "wants you". It stays hidden for `idle`, `unsupported`, `consent` and `declined` — the consent question has its own surface, and the rest have nothing to report.

### Toolchain failures are not all "try again"

`download_failed` is the only toolchain failure that is really about the network, and it is the only one mapped to `attention/network`. Everything else — a platform with no pinned build, a Mutagen version shipped after this release, bytes that did not match — is about *this app* and maps to `attention/toolchain`. Lumping them together would offer "try again" for conditions no amount of trying fixes.

### Repair

`reconcile(force)` differs from an ordinary run in three ways:

- **It clears the discovery cache first.** Discovery is cached for the session, which is right for a check that runs on every activation and wrong for a button whose whole point is "look again" — a server that has just started offering local development, or bumped a pin, is exactly what the user is pressing about
- **It records consent and proceeds.** Repair and Settings' **Set up** are the only ways to pass `force`, and pressing a button whose copy says what it will do *is* the consent
- **It reinstalls the toolchain only when the toolchain is what broke** — that is, when the state Repair was pressed on was `attention/toolchain`, decided before the first `setState` overwrites the reason. Repair is one button for every failure and reinstalling uv, a Python and the cinna-cli dependency tree takes minutes; doing that because an account token expired overnight would turn a two-second fix into a coffee break. Everything else Repair does — look the server up again, re-check the token, re-read the workspace — happens either way

When the heavy path *is* taken, it deliberately **destroys the proof of a good install before rebuilding it**: the point of Repair is that the files may be there and still wrong. It removes the install directories and `state.json` but keeps the uv cache and the downloaded Python, which is the difference between a repair that takes seconds and one that re-downloads a hundred megabytes.

### Reconnect

The one failure Repair provably cannot clear, and therefore the one verb beside it. It is not a second setup door: it renames one directory and then calls `reconcile(force)`, so everything about setup still happens in one place.

- **Renamed, never deleted.** The old workspace holds a context package and whatever else its owner put there, and an app that removes a folder from the user's own agents home to fix its own setup has chosen the wrong trade. `<host>.old-<UTC stamp>` lands beside the new one inside `Cloud/`, which the agent scanner never walks — it only reads `Local/` — so nothing adopts it and the user deletes it whenever they like. The stamp is UTC and free of colons, because that folder lives in a directory that syncs to machines whose filesystems disagree about what a filename may contain, and a name that sorts is what makes a row of archives readable. Two reconnects inside the same second get `-2`, `-3`… rather than an `ENOTEMPTY` where the honest answer is "pick another name"
- **It waits on the shared operation chain**, like recording consent does, rather than merely on whatever was in flight when the click arrived. A reconcile started in the gap — a power resume, an activation, the re-authentication the button beside it just finished — would be spawning `cinna account status` with its cwd inside the directory about to be renamed out from under it
- **It re-reads the state after that wait.** The queue ahead of it can be a whole toolchain install, and the run that just drained may have reached `ready`; archiving a workspace that now works would throw away exactly what the user was trying to get back. If the state is no longer `attention/account_mismatch` it falls through to a plain forced reconcile
- **A rename the filesystem refused comes back as a state, not a throw** — `attention/account_mismatch` again, with the refusal in its `detail`. The reason stays what it was on purpose: it is still true, and it is what keeps Reconnect on screen to press again once the folder is free. Every other verb on this service answers with a state, and the surfaces that call it have no catch

**What it does not fix:** a **Develop <agent name>** connection stores an absolute working directory under the old workspace, so after a reconnect it points into the archived copy until the user runs Develop again. The page says so in the same breath as the offer, because it is the one consequence a user would otherwise meet as a surprise.

## Architecture Overview

```
activation / reauth / resume / Repair
        │
        │   Reconnect ─► localDevService.reconnectWorkspace(userId)
        │                  └─ rename <AgentsHome>/Cloud/<host>/ → <host>.old-<stamp>
        │                     (on the shared operation chain, then force)
        ▼
localDevService.reconcile(userId, force)      ← serialized, same-profile dedupe
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
                                      ├─ LocalDevStatusButton    (installing / attention / ready)
                                      ├─ LocalDevelopmentPage (setup → composer / guide / build settings)
                                      └─ ProfileLocalDevSettingsSection (every phase)

  ConnectIntentPanel ──consent(host, accepted)──► localdev:consent
    (the opt-in checkbox on the cinna://connect confirm screen,
     seeded from any answer this machine already holds)
```

## Integration Points

- [Account Build Sessions](build_sessions.md) — one-click composer, inspectable guide, separate runtime settings and account-bound saved chats; [build-session technical details](build_sessions_tech.md)

- [Cinna Accounts](../../auth/cinna_accounts/cinna_accounts.md) — the OAuth session whose bearer mints setup tokens; local development exists only for a `cinna_user` profile
- [Cinna Re-authentication](../../auth/cinna_accounts/reauthentication.md) — a successful re-auth fires a reconcile only while that account is current and activated, because a dead session is the usual reason the workspace's account token went stale too. The build page's attention notice can start that same round trip in place for `token_expired` and `account_mismatch`, so the notice moves on by itself when it succeeds and a mismatched sign-in is reported on the page rather than nowhere
- [Onboarding](../../auth/onboarding/onboarding.md) — the `localdev` step is the last step of the Cinna path
- [The `cinna://connect` Link](../../auth/onboarding/connect_link.md) — the other route in, and the one that answers the consent question on its confirm screen rather than in a step of its own
- [Agents Home, Scanner & Folder Index](../local_agents/folder_index.md) — the account workspace is created under the Agents Home, and `Cloud/` is the [kit contract](../local_agents/kit_contract.md)'s `workshop.cloud_dir` rather than a literal in this feature's code
- [The Agents Folder Question](../local_agents/home_access.md) — the reconciler creates the Agents Home itself, and treats it as already explained because the consent screen the user just read named it: two modals about one folder is worse than one. A home it cannot create stops the run at `attention/workspace` with the folder and the fix named. The consent surfaces themselves only ever *read* the path — a hint that created the folder is what raised the macOS Documents prompt mid sign-in
- [The Local Engine](../local_agents/engine.md) — shares `managedAsset.ts`, is the other consumer of the "the directory existing is the proof its bytes were verified" invariant, and owns the binary this feature pre-fetches: the resolution order, the pin and the digest are all the engine's, unchanged
- [Shell Environment Resolution](../../development/shell_environment/shell_environment.md) — the base every spawned tool's environment is built from
- [Settings Scope](../../core/settings_scope/settings_scope.md) — `localDevConsent` is default-scoped (an install-wide setting keyed by host), not profile-scoped
- [Local Agents Are Not Synced](../local_agents/local_only.md) — the account workspace is a machine-local folder like any other; nothing here changes that

## Known gaps

Carried honestly rather than implied as passing. Build-session validation and live-build limits are recorded [separately](build_sessions.md#validation-and-limits).

- **Lifecycle coverage uses mocked boundaries.** `localDevReconcile.test.ts` covers profile serialization, stale progress/mint/setup completion, consent waits and same-profile deduplication; `activation.test.ts` covers switching to local/default profiles without deactivation. These do not replace a live account/server lifecycle run.
- **PATH ownership is covered with real temporary symlinks**, including lookalike and escaping destinations; component tests cover returned refusals and rejected IPC calls. They do not prove a user's login shell includes `~/.local/bin`.
- **Windows is absent from both pin tables**, because the desktop does not build for it. A musl-only Linux distribution is the same known gap the engine has
- **The context-package refresh is fire-and-forget.** A repeated failure is logged and never surfaced anywhere the user can see
- **The OS `open-url` hook and the packaged scheme registration are untested.** Playwright cannot raise a Launch Services event, so the E2E specs enter the funnel through the test-only argv flag and everything below the hook is real — but that a *packaged* build actually claims `cinna://` has only been asserted by the `protocols:` block in `electron-builder.yml`, never by installing a DMG and clicking a link
- **Two profiles on the same host share a workspace location and consent.** A workspace belonging to another account is still refused by CLI identity checks; Reconnect resolves that refusal by archiving one account's workspace and setting the other up in its place, which is a way out rather than coexistence. Separating per-account workspace folders remains outside this change, so switching back and forth between two accounts on one host archives a workspace each time.
- **A Develop connection does not follow a reconnect.** Its saved working directory is absolute and under the old workspace, so it keeps pointing into the archived copy until the user runs Develop again. The page's copy says so; nothing rewrites the saved path.
- **Archived workspaces are never reaped.** `<host>.old-<stamp>` folders accumulate in `Cloud/` until the user deletes them, and nothing in the app lists or counts them.
