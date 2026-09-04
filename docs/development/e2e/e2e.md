# End-to-End Tests

## Purpose

Drive the *built* Electron app with Playwright so that user scenarios — the ones `plans/manual-test-session2.md` had to describe for a human — run as tests. The unit suite (1080+ tests) runs entirely against fakes; this suite is the only place a real `ipcMain.handle`, a real `dialog`, a real scaffolded folder and a real `uv` are observed.

## Core Concepts

- **Sandbox** — A throwaway directory per test holding a fresh `HOME` and a `userData`. The app derives its agents home from `homedir()` and refuses agent roots outside it, so both must point into the sandbox or the test is running against the developer's real `~/Documents/CinnaAgents`
- **`CINNA_USER_DATA`** — The one seam in the app: when set, `src/main/index.ts` calls `app.setPath('userData', …)` (and `sessionData`) before anything derives a path from it. The app has no other test-mode behaviour
- **Main window vs. tray panel** — `firstWindow()` is the tray panel; the fixture selects the window whose URL ends in `index.html`
- **Three ways to drive** — real UI via role/label locators for the step under test; `page.evaluate(() => window.api.…)` for arrange steps; `electronApp.evaluate(({dialog, app}) => …)` for main-process seams such as stubbing the OS directory picker
- **`@live`** — Specs that need a model read a key from `.env` (loaded only by the Playwright config, never by the app) and skip without one
- **Engine cache** — The pinned `opencode` build folder agents run on, held once per machine at `~/.cache/cinna-e2e/engine/opencode-<version>/` (override with `CINNA_E2E_ENGINE_CACHE`). The Playwright global setup fills it *through the app*: a throwaway profile downloads, SHA-verifies and publishes the release exactly as a real first run does, and the published tree is copied out. A spec that opts in with `test.use({ engine: true })` gets the tree copied into its sandbox's `userData/engine/` before launch, so the app resolves it as `managed` with no network. `CINNA_E2E_SKIP_ENGINE=1` skips the fill

## User Stories / Flows

### Running the suite (`make help` lists everything)
1. `make e2e` builds `out/` and runs every spec, one Electron per worker, one worker; `make e2e-only` skips the build
2. `make e2e-one SPEC=blocked-job GREP="C5"` runs one spec or one test; `make e2e-live` runs only the model-backed specs; `make e2e-offline` runs with no key and no engine download
3. `make e2e-engine` fills the per-machine engine cache once; `make e2e-ui` and `make e2e-trace TRACE=…` step through runs and failures
4. A failed test keeps its sandbox (path in the test annotations) plus a trace, screenshots and the aria snapshot at failure under `e2e/test-results/`
5. The suite is a manual, user-decided step — it is not wired into `npm test`. CI runs it on `macos-latest` (`.github/workflows/e2e.yml`)

### Adding a scenario
1. Ask for it: `/cinna-desktop.e2e.write <the user scenario>` launches the `e2e-test-writer` agent (`.claude/agents/e2e-test-writer.md`), which follows [Writing E2E Tests](e2e_llm.md)
2. Or write it by hand from that same guide: exact strings first, arrange over IPC, act through the UI, pass twice, run the whole suite

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

- Never launch the built app in a test without the sandbox. A fresh profile activates the default user and registers the real agents home; isolation is asserted in `smoke.spec.ts`, not assumed
- The sandbox writes the test process's `PATH` into the sandbox's shell rc files, because the app probes the login shell for its environment (see [Shell Environment Resolution](../shell_environment/shell_environment.md)) and a bare home yields a `PATH` without `uv` or `opencode`
- `UV_CACHE_DIR` and `XDG_CACHE_HOME` point at the developer's real caches so `uv run` inside a test does not re-provision an interpreter per sandbox
- The app is launched with the repo root as its argument, not the entry file: `app.getAppPath()` follows the argument and the kit contract resolves as `<appPath>/resources/cinna-kit-contract`
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
playwright test -> fixtures/app.ts -> electron.launch(repoRoot, HOME=sandbox, CINNA_USER_DATA=sandbox)
                                        -> out/main/index.js (real main process, real SQLite, real dialogs)
                                        -> main window (index.html)  <- page.getByRole / page.evaluate(window.api.*)
```

## File Locations

- `e2e/playwright.config.ts` — testDir, one worker, `.env` loading, trace on failure
- `e2e/fixtures/app.ts` — `test` with the `cinna` fixture: sandbox, launch, `relaunch()`, `stubDirectoryPicker()`, `skipOnboarding()`; `homeDir()` helper
- `e2e/global.d.ts`, `e2e/tsconfig.json` — `window.api` typing from `src/preload/index.d.ts`; `npm run typecheck:e2e`
- `e2e/specs/smoke.spec.ts` — onboarding, main shell, isolation assertions
- `e2e/specs/ipc-wire.spec.ts` — section A of the manual plan: the observed IPC error wire string
- `e2e/specs/scaffold.spec.ts` — scaffold through the app, sweep for leftover `{{TOKEN}}`s, run `uv run scripts/update_status.py` in the folder
- `e2e/specs/logger.spec.ts` — section B: live entries with the overlay open, the View → Toggle App Logs menu item, history hydration after a restart, `[REDACTED]` in expanded data
- `e2e/specs/blocked-job.spec.ts` — section C: a job bound to a folder agent, the folder moved *out of the root* while the app is quit (a rename inside `Local/` re-indexes the same manifest id), red marker, hover, detail panel a–h, refused `job:execute` with no run row, recovery; a switched-off agent's amber marker and the Set up → Local Agents route
- `e2e/specs/folder-agent.spec.ts` — section D without a model: `#` example prompts after attaching via `@` (D1), the job picker's `Local` group and `LOCAL-FOLDER` tag (D3), the status overlay and tray panel on an empty profile (D4)
- `e2e/specs/live.spec.ts` — `@live`: onboarding through the real API-key screen, a one-turn chat round trip, and D2: a folder agent given a secret word in its prompt documents, attached with `@` inside a model chat, answering through the engine
- `e2e/fixtures/seed.ts` — `addAgentRoot`, `createFolderAgent`
- `e2e/fixtures/live.ts` — `OPENAI_API_KEY` and `requireLiveKey()`
- `e2e/fixtures/engine-cache.ts`, `e2e/global-setup.ts` — the engine cache and the one-time fill
- `.github/workflows/e2e.yml` — typecheck, unit and E2E on `macos-latest`; the key reaches the E2E step only for pushes to `main`; the engine cache is restored by `actions/cache`
- `Makefile` — the user-facing entry points (`make help`)
- `.claude/agents/e2e-test-writer.md`, `.claude/commands/cinna-desktop.e2e.write.md` — the agent that writes and debugs specs, and the command that launches it
- `src/main/index.ts` — the `CINNA_USER_DATA` seam
- `src/main/services/localAgents/scaffoldService.test.ts` — the unit-level token sweep (no Electron needed)
- `.env.example` — the keys the suite reads

## Integration Points

- The observed wire string backs the fixtures around `src/renderer/src/utils/ipcError.ts` — see [Main-Process Layering](../main_layering/main_layering_llm.md)
- Scaffolding and roots: [Kit Contract](../../agents/local_agents/kit_contract.md) and [Commands](../../agents/local_agents/commands.md)
- Writing and debugging specs, for an agent or a person: [Writing E2E Tests](e2e_llm.md)
- Dropped for now: a fake or real Cinna server for E1/E2, and a mocked OpenAI server via `baseUrl` — the live specs use the real key instead (`plans/e2e-testing.md`, local)
