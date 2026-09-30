# Bare-Mac Tests

## Purpose

Install the packaged app on a Mac with nothing installed — no Command Line Tools, no Homebrew, no `uv`, no `node` — and fail on any system dialog it raises. A developer's machine has all of those, and the [E2E suite](../e2e/e2e.md) runs on it, so a first run that pops the "install the command line developer tools" dialog passes every other check we have. This suite is the only one that sees what a new user's Mac sees.

## Core Concepts

- **Base image** — `cinna-bare-sequoia` (override with `CINNA_BARE_IMAGE`), a [Tart](https://github.com/cirruslabs/tart) VM built once by `make bare-mac-image` from Cirrus Labs' `macos-sequoia-vanilla` image (override with `CINNA_BARE_SOURCE`)
- **"Vanilla" is not bare** — the Cirrus image ships the full Command Line Tools (a working `/usr/bin/git`) and has Gatekeeper switched off: exactly the two things that hide first-run problems. `build-image.sh` removes the tools (Apple's documented uninstall), re-enables Gatekeeper, and verifies that `xcode-select -p` fails, the tools directory is gone, assessments are enabled and `brew`, `uv`, `node` are absent. Some CLTools `pkgutil` receipts survive in a SIP-protected store; that is harmless, because detection — the app's and the check's — uses `xcode-select`, not receipts
- **Run VM** — every test gets a fresh APFS clone of the base image (instant), named `cinna-bare-run-…`, deleted after the test
- **Nag** — any on-screen guest window whose owner is not the app (`Cinna Desktop`) or the desktop (`Window Server`, `Dock`, `Control Center`, `Spotlight`, `Finder`). Polled every 2 s from app launch to the end of the test; each one is recorded with the `vm.step` label current when it first appeared and the seconds since launch, and any nag fails the test
- **The Verifying bar** — Gatekeeper's "Verifying “Cinna Desktop”…" panel, owned by `CoreServicesUIAgent` at window layer 3 and no taller than 100 points (it measures 400x70), which every downloaded app shows once and which asks nothing. It is the one allowed exception; every other `CoreServicesUIAgent` window (the "downloaded from the Internet" confirmation, a rejection) is layer 0 and still a nag
- **No guest agent** — the image has no Tart guest agent, so `tart exec` fails. Everything goes over SSH as `admin`/`admin`, the password supplied by `scripts/bare-mac/askpass.sh` through `SSH_ASKPASS` (no `sshpass` on the host)

## User Stories / Flows

### Setting up once (Apple silicon only)
1. Install Tart from the [GitHub release](https://github.com/cirruslabs/tart/releases) tarball: `tart.app` into `~/Applications`, and its binary (`tart.app/Contents/MacOS/tart`) symlinked onto `PATH`. The cirruslabs Homebrew tap formula is broken on current Homebrew. Tart is Fair Source licensed — free on a personal workstation
2. `make bare-mac-image` — about 55 GB of disk (the ~30 GB pulled image plus the ~25 GB base), and about 50 minutes for the first pull. `FORCE=1` rebuilds an existing base. The image is built as `<name>-building` and renamed only once its checks pass, so a failed build leaves the previous base (or none), never a half-stripped one

### Running
1. `make bare-mac` packages the working tree (`scripts/bare-mac/package-app.sh`: unsigned arm64, ad-hoc signed, zipped to `dist/bare-mac/cinna-bare.zip`) and runs every spec
2. `make bare-mac APP=dist/bare-mac/cinna-bare.zip` reruns against that zip without rebuilding; `SPEC=<file>` runs one spec
3. `make bare-mac APP=dist/cinna-desktop-<v>-arm64.dmg` tests what a user downloads — see the DMG rule below. `APP` also takes a `.app`
4. A failure lists every nag as `owner (pid, size, layer) at +Ns during "<step>"`, and attaches a screenshot, the app's stdout/stderr and a window log under `e2e/test-results/bare-mac/`
5. `CINNA_BARE_KEEP=1` keeps a failed test's VM running (`tart ip <name>`, then `ssh admin@<ip>`, password `admin`); `make bare-mac-clean` deletes run VMs a kept or killed run left behind, keeping the base

### The specs
- `first-launch` (~1.7 min) — the Welcome card, then a minute idle on it while startup work runs
- `developer-tools` (~1 min) — Settings → Local Development → Developer Tools reads `make` and `python3` as not found, then, once the managed git has downloaded, shows its pinned version for Git. Steps 3 and 5 of [A fresh Mac, nothing installed](../shell_environment/developer_tools.md#a-fresh-mac-nothing-installed); step 2, the engine child's `git`, is out of reach (below)
- `first-agent-session` (~1 min) — create a Claude folder agent and send it a message: the app downloads its pinned Claude Code (~215 MB) and says the install is not logged in. The agents home, the Claude default runtime and the home folder itself are arranged through `window.api` before the UI flow (below), so the spec clicks only through Agents → Add an agent → New agent

The whole suite takes about 3.5 minutes on Apple silicon, plus packaging. The 15-minute test timeout is headroom for a slow download, not an expected duration

## Business Rules

- **The suite proved itself both ways.** Release 0.5.1, built before the developer-tool fix (`2c2d916`), fails `first-launch`: the "Install Command Line Developer Tools" dialog appears within seconds of `launch` (+5 s on one run, +8 s on another), with no user action, because startup tool detection executed the `/usr/bin/git` stub. Current `main` passes all three specs
- **Always a fresh clone.** Reusing one VM after a differently signed build produced a SecurityAgent keychain prompt that looked like an app bug. A clone is instant, so there is no reason to reuse
- **One VM at a time.** Apple's licence allows two macOS guests per host, and a boot is most of a test's cost; one worker keeps the host usable
- **The DMG is installed as a download.** It is copied into `~/Downloads` with a Safari quarantine flag, mounted, and copied to `/Applications`; `spctl` must then assess the app as accepted (a notarized Developer ID), or the test fails. The quarantine flag is removed before launch, because the one "downloaded from the Internet" confirmation cannot be clicked over SSH — the assessment behind it is what is checked instead. The default zip carries no quarantine flag, so Gatekeeper never sees it
- **Nothing in the guest can click a system dialog.** There are no Accessibility or Screen Recording grants, so a spec never walks into a prompt that is expected. That is why `first-agent-session` sets `localAgentsHome` to `~/CinnaAgents` and creates it with `window.api.localAgents.homeGrant()` (what the Agents tab's "Create folder" does): the default `~/Documents/CinnaAgents` meets the macOS Documents access prompt — expected, and explained by the app first ([The Agents Folder Question](../../agents/local_agents/home_access.md)) — and the flow would stall on it
- Manual and user-decided, like `make e2e`; not part of `npm test`

## What it does not cover

- **Main-process stubbing.** Playwright connects over CDP through an SSH tunnel; there is no `electronApp`. A spec can do what a user can, plus `window.api` calls from the page
- **An engine's session start.** Without a login no engine child is spawned — the launcher downloads the pinned Claude Code, then refuses on the login check — so the session-start `git` of a real engine never runs here
- **Local development** (`uv`, mutagen, cinna-cli) — it needs a reachable cinna-core, which the guest does not have yet

## Architecture Overview

```
make bare-mac -> package-app.sh (or APP=) -> playwright -c e2e/bare-mac/playwright.config.ts
  fixtures/vm.ts: tart clone <base> -> tart run -> ssh admin@<ip> (ControlMaster, askpass)
    install (.zip | .app | quarantined .dmg + spctl) -> open -a … --remote-debugging-port=9222
    every 2 s: osascript -l JavaScript windows.js  -> nags, labelled by vm.step
    ssh -L <host port>:localhost:9222 -> chromium.connectOverCDP -> main window (index.html)
  after: artifacts -> tart stop / delete (unless CINNA_BARE_KEEP=1 and failed, a nag counting as a failure)
         -> throw on any nag, or on any failed window poll (an unwatched stretch)
```

## File Locations

- `Makefile` — `bare-mac-image`, `bare-mac`, `bare-mac-clean`
- `scripts/bare-mac/build-image.sh` — builds and verifies the base image
- `scripts/bare-mac/package-app.sh` — the unsigned, ad-hoc signed arm64 zip; prints its path
- `scripts/bare-mac/askpass.sh` — the `admin` password for `ssh`
- `scripts/bare-mac/windows.js` — JXA window listing (owner, pid, layer, size)
- `e2e/bare-mac/playwright.config.ts` — one worker, no retries, 15-minute test timeout, 1-minute action timeout (a missing control fails in a minute, not at the test timeout)
- `e2e/bare-mac/fixtures/vm.ts` — the `vm` fixture: clone, install, launch, nag watch, teardown
- `e2e/bare-mac/specs/` — `first-launch`, `developer-tools`, `first-agent-session`

## Integration Points

- [Developer Tools on a Bare Machine](../shell_environment/developer_tools.md) — the behaviour this suite checks
- [End-to-End Tests](../e2e/e2e.md) — the sandboxed suite on the developer's own machine
- [Release & Distribution](../distribution/release.md) — the DMG the `APP=` run installs
- Writing and debugging specs: [Writing Bare-Mac Specs](bare_mac_llm.md)
