# Writing Bare-Mac Specs (LLM reference)

Rules for adding or debugging a spec under `e2e/bare-mac/specs/`. Product context: [Bare-Mac Tests](bare_mac.md). The general Playwright rules in [Writing E2E Tests](../e2e/e2e_llm.md) still apply where they do not depend on `electronApp` or the sandbox.

## Commands

| Command | Does |
|---|---|
| `make bare-mac SPEC=<file>` | Package the working tree, then one spec. Fails early without `tart` or the base image |
| `make bare-mac APP=dist/bare-mac/cinna-bare.zip SPEC=<file>` | Same, no rebuild. **Repackage after any `src/` change** — the guest runs the zip |
| `CINNA_BARE_KEEP=1 make bare-mac …` | Keep a failed test's VM running for a look — a nag or a failed window poll counts as a failure |
| `make bare-mac-clean` | Delete leftover `cinna-bare-run-*` VMs |
| `npm run typecheck:e2e` | Types for the specs and fixture |

Run one spec at a time while writing one; each boots its own VM. A spec takes one to two minutes (the whole suite about 3.5, plus packaging). The test timeout is 15 minutes, as headroom for a slow download; `actionTimeout` is 60 s, so a click on a control that is not there fails in a minute instead of hanging to the test timeout — keep it that way rather than passing a longer timeout to a click.

## Anatomy of a spec

- Import `test`, `expect` (and `q` when quoting for the guest shell) from `../fixtures/vm`.
- The `vm` fixture: `vm.page` (main window, already on the first screen), `vm.step(label)`, `vm.sh(command, timeoutMs?)` (zsh as `admin`, rejects on non-zero exit), `vm.pollWindows()`, `vm.nags()`, `vm.userData` (`/Users/admin/Library/Application Support/cinna-desktop`), `vm.name`, `vm.ip`.
- **Call `vm.step('<user action>')` before each action.** A nag is reported against the step current when it first appeared; a spec without steps reports every dialog as `first screen`. The fixture sets `boot`, `install`, `launch`, `first screen` and `end of test` itself.
- There is no nag assertion to write: the fixture throws after teardown when any nag was seen. A spec asserts only on the app.
- Versions come from `RUNTIME_PINS` (`src/shared/runtimePins.ts`), never a literal.

## What a spec can and cannot do

- **No `electronApp`** — CDP only. No stubbing a dialog or anything else in main. Arrange through `page.evaluate(() => window.api.…)` or the UI.
- **A `window.api` write bypasses the renderer's caches.** The renderer reads the Default runtime and the agents home at startup, and a direct `window.api.settings.set` skips the invalidation the UI would do. Do every such write in one `page.evaluate`, then `page.reload()`, as a reopen would. `first-agent-session` sets `localAgentsHome` and `localAgentsDefaultEngine` and calls `window.api.localAgents.homeGrant()` (the Agents tab's "Create folder") that way, then goes through the UI only from Agents → Add an agent.
- **Never walk into an expected system prompt.** Nothing in the guest can click it, so the test stalls and then fails on the nag. Choose the path that avoids it — `localAgentsHome` is set to `/Users/admin/CinnaAgents`, not the default under `~/Documents`, and granted by `homeGrant()` rather than the UI.
- **No login, no engine child.** A folder-agent message ends at the login refusal (`that Claude Code install is not logged in`); a spec cannot reach an engine's session start. A new agent opens on its own page with the composer already addressed to it — there is no separate chat to start.
- No cinna-core is reachable from the guest; local development cannot be tested yet.
- Waits on downloads poll the guest's disk with `expect.poll` and `vm.sh('test -x …')` — the managed git under `vm.userData/runtimes/git-<pin>/`, Claude Code under `vm.userData/runtimes/`.

## Gotchas

- `/usr/bin/python3` is itself a developer-tool stub in the guest — never call it from `vm.sh`. That is why the window listing is JXA (`osascript -l JavaScript`).
- Window owner names need no Screen Recording grant; window titles would. The check works on owners only, so a nag is identified by owner, pid, size and layer.
- A new allowed window belongs in `EXPECTED_OWNERS` or `isExpectedWindow()` in `fixtures/vm.ts` only when it is on every bare Mac and asks nothing. Widening it to make a spec pass hides the defect the suite exists for. The one exception there now, Gatekeeper's Verifying bar, is matched on owner (`CoreServicesUIAgent`), layer 3 **and** height at most 100 points: owner and layer alone would also pass any taller panel that agent might put at that layer.
- **Check every selector against the running app, never from memory or a code summary.** An earlier mapping of the UI, written from reading the code, had a "Start chat" button that does not exist and a Git row reading `git version 2.53.0` where the app shows the bare `2.53.0` (`RUNTIME_PINS.git.cli`); both would have failed only in the VM, minutes in. Take names and text from what is on screen in a run: the trace's screenshots (under `resources/` in the trace zip) kept for a failed test, or `app.png`, the screen at the end of every test (below).
- The app's accessible names are the main suite's: see its [Known accessible names](../e2e/e2e_llm.md#known-accessible-names). Settings → Local Development appears twice (Default and Profile); take `.first()`.

## Debugging a failure

1. The error lists each nag: `owner (pid, size, layer) at +Ns during "<step>"`. The step names the action that raised it.
2. Attachments under `e2e/test-results/bare-mac/<test>/`: `app.png`, `app.log` (the app's stdout and stderr in the guest), `windows.txt` (every new window as it appeared, then what was on screen at the end), and the trace.
3. A `gatekeeper` annotation carries the `spctl` assessment on a DMG run.
4. With `CINNA_BARE_KEEP=1` the annotation `vm kept` names the VM and its IP: `ssh admin@<ip>` (password `admin`), then `osascript -l JavaScript /tmp/windows.js` to list windows again. Delete it with `make bare-mac-clean`.
5. A keychain prompt from `SecurityAgent` on a VM you reused is not an app bug — always start from a fresh clone.

## Done means

`npm run typecheck:e2e` clean · the spec passes on a fresh clone · no fixed sleeps beyond a deliberate idle window · no local absolute host paths in the spec.
