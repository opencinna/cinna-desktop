# End-to-End Tests

## Purpose

Drive the *built* Electron app with Playwright so that user scenarios — the ones `plans/manual-test-session2.md` had to describe for a human — run as tests. The unit suite (1080+ tests) runs entirely against fakes; this suite is the only place a real `ipcMain.handle`, a real `dialog`, a real scaffolded folder and a real `uv` are observed.

## Core Concepts

- **Sandbox** — A throwaway directory per test holding a fresh `HOME` and a `userData`. The app derives its agents home from `homedir()` and refuses agent roots outside it, so both must point into the sandbox or the test is running against the developer's real `~/Documents/CinnaAgents`
- **The agents folder question** — Because `$HOME` is fresh, `$HOME/Documents/CinnaAgents` has never been created, so a spec that needs an agents home explicitly chooses **Set one up** then **Create folder** through `answerAgentsFolder(cinna)` after opening the Agents tab; opening the tab alone leaves external agents available without a home ([The Agents Folder Question](../../agents/local_agents/home_access.md)). It is a no-op where a spec adopted its own root or already made the home
- **`CINNA_USER_DATA`** — The profile seam: when set, `src/main/index.ts` calls `app.setPath('userData', …)` (and `sessionData`) before anything derives a path from it
- **`CINNA_BACKGROUND_WINDOW`** — The only other thing the suite tells the app. Set to `1` by the fixture: the window is shown but never brought forward, so a run does not take the machine over. Both are harness environment variables read once at startup, with no route into the app's own UI, and they are the app's only test-mode behaviour
- **Main window vs. tray panel** — `firstWindow()` is the tray panel; the fixture selects the window whose URL ends in `index.html`
- **Three ways to drive** — real UI via role/label locators for the step under test; `page.evaluate(() => window.api.…)` for arrange steps; `electronApp.evaluate(({dialog, app}) => …)` for main-process seams such as stubbing the OS directory picker
- **`@live`** — Specs that need a model read a key from `.env` (loaded only by the Playwright config, never by the app) and skip without one
- **Engine cache** — The pinned `opencode` build folder agents run on, held once per machine at `~/.cache/cinna-e2e/engine/opencode-<version>/` (override with `CINNA_E2E_ENGINE_CACHE`). The Playwright global setup fills it *through the app*: a throwaway profile downloads, SHA-verifies and publishes the release exactly as a real first run does, and the published tree is copied out. A spec that opts in with `test.use({ engine: true })` gets the tree copied into its sandbox's `userData/engine/` before launch, so the app resolves it as `managed` with no network. `CINNA_E2E_SKIP_ENGINE=1` skips the fill

## User Stories / Flows

### Running the suite (`make help` lists everything)
1. `make e2e` builds `out/` and runs every spec, one Electron per worker, one worker; `make e2e-only` skips the build
2. `make e2e-one SPEC=blocked-job GREP="C5"` runs one spec or one test; `make e2e-live` runs only the model-backed specs; `make e2e-offline` runs with no key and no engine download
3. `make e2e-integration` runs the one cross-repo spec against a **running cinna-core**, with the real cinna-cli it installs itself — see [Cross-repo integration runs](#cross-repo-integration-runs)
4. `make e2e-engine` fills the per-machine engine cache once; `make e2e-ui` and `make e2e-trace TRACE=…` step through runs and failures
5. A failed test keeps its sandbox (path in the test annotations) plus a trace, screenshots and the aria snapshot at failure under `e2e/test-results/`
6. The suite is a manual, user-decided step — it is not wired into `npm test`. CI runs it on `macos-latest` (`.github/workflows/e2e.yml`)

### Adding a scenario
1. Ask for it: `/cinna-desktop.e2e.write <the user scenario>` launches the `e2e-test-writer` agent (`.claude/agents/e2e-test-writer.md`), which follows [Writing E2E Tests](e2e_llm.md)
2. Or write it by hand from that same guide: exact strings first, arrange over IPC, act through the UI, pass twice, run the whole suite

### Looking at a flow by hand

`make demo-localdev SERVER=<backend origin>` launches the app in a throwaway profile aimed at a running cinna-core, for reviewing the one-click onboarding UI. It is not a test and asserts nothing — it exists because a spec tears its window down in seconds, and some screens (the several-minute local-dev install) can only be judged while they are on screen. See [Local Development](../../agents/local_dev/local_dev_tech.md).

### Cross-repo integration runs

`make e2e-integration` is the only thing in this repository that talks to a running server. It exists because one-click onboarding is a contract between three programs — cinna-desktop, cinna-core and cinna-cli — and a suite that fakes two of them proves nothing about the contract itself. `cinna-integration.spec.ts` drives the whole path: a `cinna://connect` link, the real PKCE loopback OAuth flow, the toolchain really downloaded and digest-verified, cinna-cli really installed from PyPI at the version the *server* pinned, and `cinna account setup` really creating an account workspace from a really-minted single-use token.

Configure it in `.env` (see `.env.example`): `CINNA_E2E_SERVER_URL` is the **backend** origin — the one serving `/.well-known/cinna-desktop`, not the SPA dev server — plus `CINNA_E2E_EMAIL` and `CINNA_E2E_PASSWORD` for an account on that instance. Without all three the spec skips.

Two things are deliberate and worth knowing before it puzzles someone:

- **It is excluded from every other run.** `playwright.config.ts` ignores the file unless `CINNA_E2E_INTEGRATION=1`, which only the make target sets. Otherwise a developer who filled in `.env` once would get a multi-minute toolchain install as part of every `make e2e`.
- **One step is substituted, and only one.** The suite cannot click "Approve" in a browser window, so `approveDesktopAuth` in `e2e/fixtures/liveCinna.ts` performs exactly that — sign in, read the consent nonce cinna-core minted, approve it, request the loopback URL. Everything either side of it is the real flow. `shell.openExternal` is stubbed in the main process for the same reason: an unstubbed run would open a browser on the machine running the tests.

The run mints a **real** account CLI token on the instance, so it revokes it again in `afterEach` — by diffing the token list around the run rather than by machine name, because cinna-cli names a token after the machine and a name-based cleanup would revoke a real Cinna Desktop install on the same laptop.

`CINNA_E2E_CLI_SOURCE` points the run at a local cinna-cli checkout, installed with `uv tool install --editable` instead of the version the server pinned. That is how the run exercises the cinna-cli being developed alongside this app before it reaches PyPI; the desktop reads it as `CINNA_CLI_SOURCE` and logs a warning on every install, because the pin — cinna-cli's only supply-chain guarantee — does not apply while it is set.

`preflight()` runs before the app is touched, so a stack that cannot serve the run is a **skip naming the reason** rather than a failure four steps in. The reason it most often names is not a desktop problem at all: cinna-core builds its discovery endpoints from `BACKEND_BASE_URL`, so an instance answering perfectly well on `http://localhost:8000` can advertise an `authorization_endpoint` on a tunnel that is down. Point `BACKEND_BASE_URL` at the same origin as `CINNA_E2E_SERVER_URL` for local integration runs.

### Encoding a manual test
1. One `test()` per `###` item of the manual document, named with the ID (`A1 …`) so the two stay cross-referenced
2. "Capture the text verbatim" becomes an exact-string assertion
3. A ⚠️ expected-to-fail item becomes `test.fail()`, so the run fails when the defect stops reproducing
4. BLOCKED/SKIP conditions become `test.skip(condition, reason)` — no `uv`, no key. Section E of the manual plan (E1, E2) has no spec: both need a Cinna session, which is out of scope for now

### Getting a folder agent into a test
1. `homeDir(cinna, 'agents-root')` — a directory the path rules accept
2. `cinna.stubDirectoryPicker(dir)` then `window.api.localAgents.rootAdd()` — the handler takes the path from the (stubbed) picker, never from the renderer
3. `window.api.localAgents.create({rootId, name, description})` — the scaffold, through the real service

## Business Rules

- Never launch the built app in a test without the sandbox. A fresh profile activates the default user and goes looking for the real agents home — on macOS that means the run asking the developer for access to their own `~/Documents`, and on any platform a test writing into `~/Documents/CinnaAgents`. Isolation is asserted in `smoke.spec.ts`, not assumed
- The sandbox writes the test process's `PATH` into the sandbox's shell rc files, because the app probes the login shell for its environment (see [Shell Environment Resolution](../shell_environment/shell_environment.md)) and a bare home yields a `PATH` without `uv` or `opencode`
- `UV_CACHE_DIR` and `XDG_CACHE_HOME` point at the developer's real caches so `uv run` inside a test does not re-provision an interpreter per sandbox
- The app is launched with the repo root as its argument, not the entry file: `app.getAppPath()` follows the argument and the kit contract resolves as `<appPath>/resources/cinna-kit-contract`
- **A run stays in the background.** The suite launches a real app per test, and on macOS a real app that shows a window takes the foreground — repeatedly, for the length of a run, on the machine the developer is trying to work on. `CINNA_BACKGROUND_WINDOW=1` gives up the one thing Playwright does not use: it drives the renderer over CDP and never needs focus, and screenshots still render correctly. **Both halves are needed** — `app.setActivationPolicy('accessory')` before any window exists (an accessory app has no Dock tile and cannot become the active application) *and* `showInactive()` instead of `show()`, because `showInactive` alone still activates the app the first time it is called. `focusMainWindow()` does the same split: the visible half (restore, `showInactive`) and none of `app.focus({ steal: true })`
- **`make demo-localdev` does not set it**, and must not: it exists so a developer can *watch* a several-minute install, and a window that will not come forward is the opposite of that
- E2E never runs under vitest and is not part of `npm test`
- The app is launched with `--use-mock-keychain`: with `HOME` in the sandbox, macOS resolves the login keychain under it and `safeStorage.encryptString` fails with "A keychain cannot be found to store …". The mock keeps the real safeStorage path and never touches the user's keychain; `smoke.spec.ts` round-trips a string through it
- On the new-chat screen the composer accepts a send before the renderer's model list has loaded, and refuses it as "no chat mode configured"; `live.spec.ts` retries that one refusal rather than sleeping
- `cinna.page` is read at each use, never held in a local across `relaunch()`: it is a different window afterwards
- The agent index is rebuilt by a scan, not at startup: after a relaunch call `window.api.localAgents.rescan()` before asserting on anything derived from it (a job's `incompleteSetup`)
- A log row is six adjacent spans with no whitespace between them; filter rows by fragments, not by the spaced text the eye sees
- An agent seeded over IPC is invisible to the composer and the job picker until the renderer restarts: their agent query has a stale window and nothing invalidates it on a folder change. Seed, then `relaunch()`
- An MCP row seeded for a dependency test must be created with `enabled: false`; an enabled row spawns its command and the upsert waits on the connection attempt

## Architecture Overview

```
playwright test -> fixtures/app.ts -> electron.launch(repoRoot, HOME=sandbox, CINNA_USER_DATA=sandbox,
                                                      CINNA_BACKGROUND_WINDOW=1)
                                        -> out/main/index.js (real main process, real SQLite, real dialogs)
                                        -> main window (index.html)  <- page.getByRole / page.evaluate(window.api.*)
```

## File Locations

- `e2e/playwright.config.ts` — testDir, one worker, `.env` loading, trace on failure
- `e2e/fixtures/app.ts` — `test` with the `cinna` fixture: sandbox, launch, `relaunch()`, `stubDirectoryPicker()`, `skipOnboarding()`; the `engine`, `launchArgs` and `env` options; `homeDir()` helper
- `e2e/global.d.ts`, `e2e/tsconfig.json` — `window.api` typing from `src/preload/index.d.ts`; `npm run typecheck:e2e`
- `e2e/specs/agent-landing.spec.ts` — folder/A2A chat-first navigation, Settings controls, draft preservation, safe hover/focus connection details and confirmed direct-connection deletion without a disable option, plus actual dark-theme selected/unselected label colors.
- `e2e/specs/agent-sidebar-sections.spec.ts` — section toggle through real IPC, flat-list rendering, persistence across restart and text-label interaction.
- `e2e/specs/smoke.spec.ts` — onboarding, main shell, isolation assertions and top-bar Inbox access from collapsed-sidebar/Settings views
- `e2e/specs/window-state.spec.ts` — main-window size and the sidebar's open state across restarts: resized and collapsed while on Settings, Cmd+Q, back at that size, collapsed, on the new-chat screen; then expanded, resized and window-closed in one tick (so only the save on `close` can write the size — checked on disk), and back open at the last size
- `e2e/specs/ipc-wire.spec.ts` — section A of the manual plan: the observed IPC error wire string; and the single stream guard — a stubbed sender posts every `RunEvent` type interleaved with off-contract messages onto the real turn port, and generic `run.send` delivers exactly the eleven types (a wrong-payload `delta` included, since the guard reads the discriminator only) while each dropped message is warned about
- `e2e/specs/run-events.spec.ts` — a real fake-ACP process parks on permission/question requests; transcript answers work with the pending poll pinned empty and persist through restart. Always allow sends ACP's once outcome, writes the exact folder grant, and leaves the scoped durable ask answered with `remembered: true` after immediate turn completion and restart. Both permission and question replay are read-only and show the saved decision.
- `e2e/specs/file-refs.spec.ts` — clickable file references in a folder agent's chat, answered by the fake ACP agent. Real files, a folder, a base-heuristic short name and `~/` paths link, while a missing file and a fenced block stay plain. The csv previews as a table with Open / Open folder in its ⋯ menu, which Escape closes without closing the preview. `.env` and `.gz` show their notices. Both a double-click and a slower second press on the backdrop leave the preview open. A keyboard open focuses the card, and Tab walks the header to the ringed body. The consent dialog is stubbed in main: the spec asserts its folder and file wording in `~/` paths, that Cancel opens nothing, and that Show file previews without asking twice. `shell.showItemInFolder` is stubbed for the folder reveal. A file or folder deleted after the links rendered opens the modal with its own sentence.
- `e2e/specs/task-browsing.spec.ts` — remote root work with no ask/job opens from the Inbox's Recent tasks. Parent Subtasks discovers a completed child deliberately absent from active/delta results, opens active/finished child pages and returns through Parent task. Only the sandbox account is seeded; real HTTP discovery supplies all task rows and browsing sends GET only.
- `e2e/specs/task-start.spec.ts` — real remote discovery → task Take over → local agent Continue. The held A2A reply verifies one exact goal/description prompt, one new chat, the same task and no new job attempt. Stop is visible while held; releasing the response renders the final marker automatically and restores Send, without navigation or manual refresh.
- `e2e/specs/next-message-inbox.spec.ts` — local A2A next-message requests: a plain chat’s nonstreaming ask survives restart and a later ask gets a new address; a job’s streaming ask keeps its attempt open until the Inbox answer completes it. Both assert the saved protocol context and answer text, without a model credential or task/request seeding.
- `e2e/specs/inbox.spec.ts` — the Inbox: a job whose folder agent parks on a permission ask, run from the job screen's **Run** (an `execute` over IPC starts no stream and so raises no ask), the user leaving the chat for the top-bar Inbox, answering it there with the conversation closed — the answer reaching the agent as ACP's own `{outcome:{outcome:'selected',optionId:'once'}}` — and the run row leading to the **task** — whose page names the work, shows it `completed` with no banner, and carries the one way into the conversation, where the decision is waiting read-only. The task's whole trail is asserted, `in_progress → blocked → in_progress → completed`, made observable by a fake agent that works for a couple of seconds either side of its ask
- `e2e/fixtures/fakeAcpEngine.ts` — installs the scriptable fake ACP agent (`src/main/agents/drivers/acp/testSupport/fakeAcpAgent.mjs`, the one the driver's own contract suite drives) through the engine path setting, so the app spawns it as it would `opencode acp`; writes the JSON script into the sandbox and reads back the JSONL log of what the agent received and what the client answered it
- `e2e/specs/driver-readiness.spec.ts` — a closed-loopback A2A agent reports unreachable; its page Settings → Connection carries the reason. The Remote composer disables Send, retains the draft and creates no chat on Enter; Check again permits sending once the fake starts on the same port.
- `e2e/specs/llm-stop.spec.ts` — Stop pressed while an LLM reply is streaming: a keyless Ollama credential whose `/v1/chat/completions` fake sends two chunks and never finishes, so Stop lands mid-reply every time; the request is aborted, the composer offers Send again, and the partial reply is saved and survives a restart
- `e2e/specs/pending-messages.spec.ts` — messages sent while a command-line ACP agent (the scriptable fake, no folder or credential) is mid-turn: a steer lands between the output before and after it, live and after a restart, with `_session/steering` on the wire and one `session/prompt`; a queued message shows its `Queued` / `Cancel?` badge, drains as the next `session/prompt` when the turn completes and leaves exactly one copy; Esc Esc holds the queue and returns its text to the input; ArrowUp edits a queued message in place; and in the running composer typing puts Send in Stop's place and emptying the input brings Stop back
- `e2e/specs/scaffold.spec.ts` — scaffold through the app, sweep for leftover `{{TOKEN}}`s, run `uv run scripts/update_status.py` in the folder
- `e2e/specs/logger.spec.ts` — section B: live entries with the overlay open, the View → Toggle App Logs menu item, history hydration after a restart, `[REDACTED]` in expanded data
- `e2e/specs/blocked-job.spec.ts` — section C: a job bound to a folder agent, the folder moved *out of the root* while the app is quit (a rename inside `Local/` re-indexes the same manifest id), red marker, hover, detail panel a–h, refused `job:execute` with no run row, recovery; a switched-off agent's amber marker and the Set up → Default → Agents route
- `e2e/specs/custom-acp-agent.spec.ts` — adds an ACP command without a folder or credential through an explicit shell wrapper standing in for SSH. Test performs initialization only, displays identity/auth methods and closes the child; argv, local spawn cwd and remote session cwd stay distinct and captured stdout remains JSON-RPC. Real Allow once persists through restart; a refused Test preserves its draft and retries, then Always writes an external grant while sending ACP once and the saved editor revokes that grant. No real SSH or host authentication is exercised.
- `e2e/specs/managed-agent.spec.ts` — adds a Managed (Claude) agent without a local folder through real SDK workspace discovery, then creates its session and permission ask through HTTP/SSE. A held confirmation preserves the open durable ask until acknowledgment; Allow once persists through restart, the next turn reuses the same session, and remote budget refusal sends no new message. A lost acknowledgment disables retry and confirmed Stop sends one interrupt without resending the answer. The fixture uses a synthetic credential in its isolated DB and `ANTHROPIC_BASE_URL` pointing only to loopback.
- `e2e/specs/mcp-connection.spec.ts` — Settings creates a bearer Streamable HTTP provider through a real loopback server; a held 503 preserves one saved row, Reconnect discovers modern tools on that same row, and the disabled legacy transport editor still offers and saves `SSE (deprecated)`. Exact protocol methods and bearer delivery are asserted; OAuth/refresh/stdio/SSE protocol coverage lives in the real SDK manager peer tests.
- `e2e/specs/job-executor-refresh.spec.ts` — local-origin Job handed remote gains bound-task refresh without another dispatch; accepted script execution sends one ACP prompt and no renderer model prompt; a historical pointer-only run adopts one Task through actual adapter reads and keeps that identity across restart, without remote execute replay.
- `e2e/specs/agent-status-intents.spec.ts` — a real folder catalog command records exactly one manual refresh while batch/read/after_turn only reread STATUS.md; a real ACP permission turn preserves tool attribution and its answer through restart without executing the status command. Status list polling can also expose post-turn file changes; exact dispatch intent is covered by the live-watch unit tests.
- `e2e/specs/unsupported-driver.spec.ts` — an unknown driver seeded in the isolated database survives restart and stays visible in Settings; the composer refuses Send/Enter, and a direct public `run.start` records a persisted error without reaching the valid loopback A2A endpoint.
- `e2e/specs/folder-agent.spec.ts` — section D without a model: `#` example prompts after attaching via `@` (D1), the job picker's `Local` group and `LOCAL-FOLDER` tag (D3), the status overlay and tray panel on an empty profile (D4)
- `e2e/specs/agent-page.spec.ts` — the agent page: a name-only create → "Build it with…" → Not now → the page → Delete agent via ⋯ and the confirm dialog, with `shell.trashItem` stubbed in main so the sandbox folder never reaches the developer's Trash; and an IPC create with no description (the name stands in, readiness `ok`); and the Open-in menu's "Copy prompt for another tool" — the item confirms as "Copied" without closing the menu, reverts, and the text read back off the real clipboard is the briefing naming the folder and its `AGENTS.md`
- `e2e/specs/agent-permissions.spec.ts` — the agent page's Permissions tab: two grants seeded straight into the folder's `app-data/desktop.json` (main derives that path from the agent id, so there is no seeding IPC), the count badge on the unopened tab, both rules rendered in the user's words rather than the engine's, one row's × and then "Forget all" — each checked against the file on disk, because the mutations answer with the list they leave and the cache write alone would empty the card either way
- `e2e/specs/claude-approval.spec.ts` — the Permissions tab of an agent whose manifest names the Claude engine: the `Approvals` select on its default, "Ask every time" chosen through the UI, the "Always allowed" heading measured before and after (it must not move), the choice read off `app-data/desktop.json` and *not* off the manifest, and the select reading it again after a restart; then an OpenCode agent's tab as the contrast — the profile sentence and no select. No `claude` install is needed and none is spawned: the card branches on the manifest and the login probe is pinned
- `e2e/specs/bare-agent.spec.ts` — adopting a folder that already holds an `AGENT.md`: the + → the choice → the stubbed picker → the preview of what was found (three agents, then one), the sidebar group under the picked folder's name, a refusal that keeps the dialog open and names `AGENT.md`, `AGENTS.md` and `CLAUDE.md`, the bare agent's page (no Commands tab; the folder's `README.md` rendered read-only on Overview, `Instructions` alone on Prompts), and "Remove from the list only" — gone from the list and from the next rescan, folder untouched, put back from Settings. Every adopt test snapshots the folder tree before and after: the promise is that nothing is written into the user's own folder, and no screen in the flow would show it if something were
- `e2e/specs/agent-runtime.spec.ts` — the agent page's Settings → "Runs on" panel: two credentials whose catalogues are supplied by `stubLlmFetch` replacing `globalThis.fetch` in the isolated main process (real adapters and registry; no environment-based endpoint override), a folder agent declaring the Anthropic one, and the credential switched to the OpenAI one — the manifest on disk loses the model, the reserved status line names what it dropped, the Model select offers only the new credential's models, and the panel's height (so the tab strip's position) does not change. The agent pins a model, so the panel opens on the Advanced **model** picker rather than the Work complexity tier — the manifest decides which of the two is shown
- `e2e/specs/ollama-credential.spec.ts` — Ollama as a **keyless** credential: a fake Ollama on a port the spec owns, reached by pointing the app's `OLLAMA_HOST` at it through the fixture's `env` option, so the probe answers there and never falls back to whatever Ollama the developer's machine is running. Settings → AI Credentials offers it, one click adds it, the card's **Host** field carries the `baseUrl` that came back across the IPC boundary, the Add form then refuses a second credential for the same host (the detection cache having been invalidated by the write), and the same keyless credential is offered by *both* renderer pickers — the chat-mode form and Default → Agents' default AI credential. Only the **running** path: the probe falls back to `127.0.0.1:11434` regardless of `OLLAMA_HOST`, deliberately, so "not running" is not arrangeable in a sandbox and lives in `src/main/services/ollamaService.test.ts` instead
- `e2e/specs/live.spec.ts` — `@live`: onboarding through the real API-key screen, a one-turn chat round trip, and D2: a folder agent given a secret word in its prompt documents, attached with `@` inside a model chat, answering through the engine
- `e2e/specs/a2a-silent-stop.spec.ts` — a2a silent stop regression.
- `e2e/specs/chat-session-status.spec.ts` — seven real loopback A2A cases for background spinner/interrupt/delete with the current draft preserved; completed, needs-input and failed unread outcomes through restart and transcript opening; and foreground outcomes remaining read after navigation. Checks computed icon opacity/animation, real cancellation/abort and persisted results. See [Sidebar Session Status](../../chat/session_status/session_status.md).
- `e2e/specs/chat-row-tooltip.spec.ts` — the sidebar chat row's summary tooltip, seeded over IPC with no model: an agent chat names its agent, `with <other>`, Started and Lasted, 4px right of the row; the pointer crosses onto it and it stays past the closing delay, then goes when the pointer leaves; a mode chat shows exactly one tooltip tagged `chat mode`; an empty chat shows none; a click on a hovered row opens the chat and leaves no tooltip.
- `e2e/specs/agent-turn-failures.spec.ts` — agent turn failures regression.
- `e2e/specs/autonomous-task.spec.ts` — autonomous task regression.
- `e2e/specs/cinna-integration.spec.ts` — cinna integration regression.
- `e2e/specs/claude-engine.spec.ts` — claude engine regression.
- `e2e/specs/claude-logged-out.spec.ts` — claude logged out regression.
- `e2e/specs/connect-intent.spec.ts` — connect intent regression.
- `e2e/specs/credential-switch.spec.ts` — credential switch regression.
- `e2e/specs/forget-agent-root.spec.ts` — forget agent root regression.
- `e2e/specs/handover-flow.spec.ts` — a real `brief.md` written into an adopted bare folder (there is no seeding IPC and deliberately none): the watcher picks it up, the Inbox gate is answered through the real UI, a real turn runs on the scripted ACP agent with the brief's body in its prompt, the `report.md` the spec writes closes the task, and the return packet appears in the origin chat as a system row. Skip cancels the task and leaves the folder alone; and a case that writes an `in_progress` report before the brief is ever seen proves the claim that keeps the desktop from starting a second executor — no gate, no executor, nothing of Cinna's running at all.
- `e2e/specs/human-routing.spec.ts` — human routing regression.
- `e2e/specs/local-dev.spec.ts` — local dev regression.
- `e2e/specs/local-schedules.spec.ts` — local schedules regression.
- `e2e/specs/manifest-handback.spec.ts` — manifest handback regression.
- `e2e/specs/remote-inbox.spec.ts` — remote and local asks in one Inbox, including the partial-read states when the bound service cannot be read.
- `e2e/specs/script-runtime.spec.ts` — script runtime regression.
- `e2e/specs/task-handoff.spec.ts` — task handoff regression.
- `e2e/specs/task-live-attach.spec.ts` — task live attach regression.
- `e2e/specs/task-sync.spec.ts` — task sync regression.
- `e2e/fixtures/seed.ts` — `addAgentRoot`, `createFolderAgent`
- `e2e/fixtures/live.ts` — `OPENAI_API_KEY` and `requireLiveKey()`
- `e2e/fixtures/engine-cache.ts`, `e2e/global-setup.ts` — the engine cache and the one-time fill
- `.github/workflows/e2e.yml` — typecheck, unit and E2E on `macos-latest`; the key reaches the E2E step only for pushes to `main`; the engine cache is restored by `actions/cache`
- `Makefile` — the user-facing entry points (`make help`)
- `.claude/agents/e2e-test-writer.md`, `.claude/commands/cinna-desktop.e2e.write.md` — the agent that writes and debugs specs, and the command that launches it
- `src/main/index.ts` — the `CINNA_USER_DATA` seam, and the `accessory` activation policy plus `showInactive()` under a background run
- `src/main/window/focus.ts` — `BACKGROUND_WINDOW`, and the branch in `focusMainWindow()` that shows without stealing
- `src/main/services/localAgents/scaffoldService.test.ts` — the unit-level token sweep (no Electron needed)
- `.env.example` — the keys the suite reads

## Integration Points

- The observed wire string backs the fixtures around `src/renderer/src/utils/ipcError.ts` — see [Main-Process Layering](../main_layering/main_layering_llm.md)
- Scaffolding and roots: [Kit Contract](../../agents/local_agents/kit_contract.md) and [Commands](../../agents/local_agents/commands.md)
- Writing and debugging specs, for an agent or a person: [Writing E2E Tests](e2e_llm.md)
- Dropped for now: a fake or real Cinna server for E1/E2, and a mocked OpenAI server via `baseUrl` — the live specs use the real key instead (`plans/e2e-testing.md`, local)
