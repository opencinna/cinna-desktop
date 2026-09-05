# Writing E2E Tests (LLM reference)

Concise rules for adding a Playwright spec under `e2e/` that drives the built Cinna Desktop app. Product context: [End-to-End Tests](e2e.md). Read both before writing.

## Commands

| Command | Does |
|---|---|
| `make e2e` | `electron-vite build` then every spec. Run this before declaring done |
| `make e2e-one SPEC=<file stem> GREP="<title fragment>"` | One spec / one test against the existing `out/` |
| `make e2e-only` | Every spec, no rebuild. **Rebuild after any `src/` change** — specs run `out/`, not `src/` |
| `make e2e-live` | Only `live.spec.ts`; needs `OPENAI_API_KEY` in `.env` |
| `make e2e-integration` | Only `cinna-integration.spec.ts`: a **running cinna-core** plus the real cinna-cli. Needs `CINNA_E2E_SERVER_URL` / `_EMAIL` / `_PASSWORD` in `.env`. Excluded from every other run by `testIgnore` unless `CINNA_E2E_INTEGRATION=1`, because it really installs a toolchain and really creates an account workspace |
| `make e2e-ui` / `make e2e-trace TRACE=…` | Step through a run / open a failure's trace |
| `npm run typecheck:e2e` | Types for `e2e/**` (includes `window.api` from `src/preload/index.d.ts`) |

Filter noisy output: `2>&1 | grep -v "Electron Security\|Debugger\|nodejs.org"`.

## Anatomy of a spec

- Import `test`, `expect` from `../fixtures/app` — never from `@playwright/test` directly (the `cinna` fixture is what launches the app).
- One `test()` per scenario, titled with the manual-plan ID when there is one: `test('C5 blocked really means blocked', …)`. Multi-step scenarios use `test.step`.
- The `cinna` fixture (`e2e/fixtures/app.ts`): `cinna.page` (main window), `cinna.electronApp`, `cinna.sandbox` (`root`, `home`, `userData`), `relaunch()`, `stubDirectoryPicker(dir)`, `skipOnboarding()`. Options: `test.use({ engine: true })` when a folder agent must *answer*; `test.use({ launchArgs: [...] })` for argv the app reads at startup (the `cinna://` deep link). `relaunch(extraArgs?)` starts *without* `launchArgs` unless given its own — a restart is not a second link click.
- Arrange helpers: `e2e/fixtures/seed.ts` (`addAgentRoot`, `createFolderAgent`), `e2e/fixtures/live.ts` (`requireLiveKey`, `OPENAI_API_KEY`), `seedOpenAiDefaultMode` and `sendFirstMessage` in `live.spec.ts`.
- Cross-repo helpers: `e2e/fixtures/liveCinna.ts` — `requireLiveCinna()` (skip without `.env`), `preflight()` (checks the instance can serve the run and names what is wrong when it cannot), `approveDesktopAuth()` (does over the API the one thing a human does in a browser: approve the desktop's authorization).
- Sandbox is deleted after a pass and kept after a failure (path in the test's annotations).

## Procedure for a new scenario

1. **Pin the observable.** Write down the exact user-visible strings the scenario is about. Find them in `src/renderer/src/**` (`grep -rn "aria-label=\|title=\|placeholder=" …` or the literal text). Zero `data-testid` exist; use roles, names, placeholders, text. Prefer fixing an `aria-label` in the product over adding a test id.
2. **Arrange over IPC, act through the UI.** Seed state with `page.evaluate(() => window.api.…)` — same code path the UI uses, seconds instead of click choreography. Drive only the step under test through the UI. Main-process seams via `electronApp.evaluate(({ dialog, app, Menu, safeStorage }) => …)`.
3. **Assert exact text** with `toHaveText` / `toBe`. Expected-to-fail defects: `test.fail()`. Not reachable yet: `test.fixme(true, reason)`. Missing prerequisites: `test.skip(cond, reason)`.
4. **Run it twice** (`make e2e-one …`), then the full suite. If the spec guards a fix, revert the fix temporarily and confirm the spec fails (copy the file aside first; never `git checkout` an uncommitted fix).

## IPC catalogue for arranging

| Need | Call |
|---|---|
| Agents root under sandbox `$HOME` | `addAgentRoot(cinna)` (stubs the OS picker; roots outside `$HOME` are refused) |
| Folder agent | `createFolderAgent(cinna, root, name)` → `LocalAgentDto` (`id = folder:<uuid>`, `path`) |
| Edit a manifest field | `localAgents.get(id)` → `.value.stamps['cinna-agent.json']` → `localAgents.updateField({ agentId, update: { field, value }, expectedStamp })`; both return `{ ok, value | message }` |
| Edit a prompt document | `localAgents.readDoc({ agentId, prompt: 'workflow' \| 'entrypoint' \| 'refiner' })` → `.stamp` → `updateField({ …, update: { field: 'prompt', prompt, value } })` |
| Re-index from disk | `localAgents.rescan()` — startup does **not** scan; call it after a relaunch before asserting on anything derived from the index |
| Switch an agent off | `agents.setEnabled(id, false)` |
| Job bound to an agent | `jobs.create({ type: 'local', title, prompt })` then `jobs.setAgents(job.id, [agentId])` (`agentId` on create is ignored) |
| MCP dependency | `mcp.upsert({ name, transportType: 'stdio', command, args: [], enabled: false })` — **`enabled: false`**, or the upsert spawns the command and waits; then `jobs.setMcpProviders(jobId, [id])` |
| Run a job / see runs | `jobs.execute(id)` (rejects when blocked) · `jobs.listRuns(id)` |
| Provider + default mode | see `seedOpenAiDefaultMode` — model must come from `providers.listModels()`, not from the live probe |
| A log entry with a payload | `logger.log({ level, scope, message, data })` — goes through redaction and the live broadcast |
| Engine | `engine.start()` → `{ status, binarySource, error }` · `engine.skips()` |
| A `cinna://` deep link | `test.use({ launchArgs: ['--cinna-connect-intent=cinna://connect?server=https://host'] })` — the test-only argv form (`src/shared/connectIntent.ts`); `open-url` cannot be raised from Playwright. Inspect/clear the buffer with `connect.getPending()` / `connect.consume()`. Never click **Connect**: it opens a real browser |
| Local development state | `localDev.getState()` (`{ phase: 'idle' }` for a non-Cinna profile) · `localDev.consent(host, false)` / `getConsent()` / `resetConsent(host)` — persisted in the `localDevConsent` app setting, so they survive `relaunch()` |

## Known accessible names

Sidebar tabs `Chats` `Jobs` `Notes` `Agents` (use `exact: true`) · onboarding `Skip for now`, `API key…`, `OpenAI…`, `Test`, `Save & start` · composer: textbox by **placeholder** `Type a message...` (no accessible name), send with `press('Enter')` (the button is unlabelled), `[+]` = `Add to chat` · popups: listbox `Agents and MCP servers`, listbox `Example prompts` · footer `Interface` → `App logs (⌘`)`, `Agent status` · logger: heading `App Logs`, `Clear logs`, `Expand data`, filter by placeholder `Filter by scope, message, source...`, rows `[data-log-index]` · jobs: row = title text (a div, not a button), marker `getByLabel('Incomplete setup')` / `getByLabel('Needs setup')`, `Run this job` (row, on hover), `Run` (detail), `Edit job`, `Save`, `Add` (agent picker), dialog `Agents & Connectors`, `Set up` · settings heading = section title (`Local Agents`, `Local Development`); Settings itself is reached through the footer user menu, whose trigger is named by the profile's **generated** display name — read it with `auth.getCurrent()`, never hardcode it — then `Settings` · connect deep link: `Connect to <host>?` (a div, not a heading), the `Server` label above the full origin, buttons `Not now` / `Connect` / `Switch to it`, modal dialog `Connect to a Cinna server` · local dev footer: `Setting up local development` / `Local development needs attention` (both absent in every other phase).

## Gotchas that have already cost time

- **Never hold `page` across `relaunch()`** — read `cinna.page` at each use. A destructured `page` targets a closed window and every assertion after it silently fails.
- **`firstWindow()` is the tray panel**; the fixture already picks `index.html`. The tray window is `electronApp.windows().find(w => w.url().endsWith('trayPanel.html'))`.
- **Agents seeded over IPC are invisible to the composer and the job picker** until `relaunch()` — their query is stale and nothing invalidates it.
- **A folder renamed inside `Local/` is the same agent** (identity is the manifest id). To make an agent *missing*, move the folder out of the root while the app is closed.
- **Log rows are six adjacent spans with no whitespace**; filter `[data-log-index]` by fragments, not by the spaced text.
- **Startup race on the new-chat screen**: a send in the first moment after launch is refused with "no chat mode configured"; use `sendFirstMessage` (retries that one refusal). No other `waitForTimeout` in the suite — every wait is a web-first `expect`.
- **`getByText` matches concatenated text content**, and `getByRole('alert')` may match more than one banner. Scope to a container.
- **Keychain**: the fixture passes `--use-mock-keychain`; do not remove it. Without it `safeStorage` fails under a sandboxed `HOME`.
- **`uv`, `opencode` on PATH inside the app** come from the sandbox's rc files the fixture writes; the test process's `PATH` is what the app sees.
- **The welcome step already says "Connect to a Cinna instance…"**, so a "no confirm panel" assertion must use the panel's own exact strings (`Connect to <host>?`, `A link asked Cinna to connect to this Cinna server. Only continue if you recognise it.`), not `/^Connect to /`.
- **A Cinna account cannot be arranged**: `auth.register({ accountType: 'cinna' })` runs a browser OAuth round trip against a real instance. Everything gated on `user.type === 'cinna_user'` (the local-dev reconciler past `idle`, sync, account config) is `test.fixme` territory for an ordinary spec — the answer is a real instance supplied out of band, never a product-side test hook.
- **Live specs**: `test.beforeEach(() => requireLiveKey())`, one model turn, `test.setTimeout` generously, a question whose expected answer is **not** in the prompt text (`12 times 12` → `144`).

## Debugging a failure

1. `e2e/test-results/<test>/error-context.md` — the aria snapshot at failure, with the failing locator. Read this first; it usually answers "what did the screen actually show".
2. `test-failed-*.png` — one per window (main and tray).
3. `make e2e-trace TRACE=e2e/test-results/<test>/trace.zip` — every step with DOM snapshots and console.
4. `[main] …` lines in the run output are the main process's stderr — IPC handler failures log there with `code`, `message`, `detail`.
5. Temporary `console.log(JSON.stringify(await page.evaluate(() => window.api.…)))` to see what main believes; **remove before finishing**.
6. The sandbox of a failed test is kept — inspect `userData/cinna.db` and the agents root on disk.

## Done means

`npm run typecheck:e2e` clean · the spec passes twice · `make e2e` green (live specs skipped is fine) · no leftover diagnostics or fixed sleeps · new strings/gotchas added to this file · `e2e/test-results` removed.
