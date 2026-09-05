# The `cinna://connect` Link

## Purpose

A landing page on a self-hosted cinna-core instance can hand a freshly installed desktop the one thing the download itself cannot carry: **which server it was downloaded for**. The link fires `cinna://connect?server=<origin>`, the app validates and buffers it, and shows a confirmation naming the host. Only if the user says yes does the ordinary desktop OAuth flow run — unchanged.

## Core Concepts

| Term | Definition |
|------|-----------|
| **Connect intent** | The whole payload: `{ serverUrl, receivedAt }`. An origin and when it arrived. No token, no path, no query |
| **The funnel** | `connectIntentService.deliver(rawUrl, source)` — the single place every delivery path lands in, so no caller can skip the validation, the buffer or the push |
| **Source** | Which path delivered it: `open-url` (macOS), `second-instance` (a link click while the app runs), `argv` (a cold launch on Linux/Windows), `test-argv` (the E2E flag) |
| **Confirm step** | `ConnectIntentPanel` — the one screen a link is allowed to reach, and **the feature's security boundary** |
| **Buffer** | One pending intent held in main until someone asks for it. A second link replaces the first |

## User Stories / Flows

### A brand-new install, launched from a link
1. The user clicks the landing page's button. The OS launches the freshly installed app with the URL
2. On macOS `open-url` fires **before** the app is ready; on Linux and Windows the URL arrives appended to argv. Either way it lands in the funnel and is buffered
3. The window opens; `OnboardingGate` reads the buffered intent and opens `OnboardingScreen` on its `cinna-confirm` step instead of the welcome step — the user clicked a button that named a server, and asking them to choose between "API key" and "Cinna Server" first would be asking a question they have already answered
4. The panel shows **"Connect to cinna.acme.com?"**, the full origin unabbreviated, and two buttons: **Not now** and **Connect**
5. **Connect** runs the ordinary self-hosted `auth:register` OAuth flow against that origin. The waiting state and its Cancel button are the same ones the typed-URL path uses
6. On success the origin is written into the shared self-hosted history — the same history a typed URL populates, so the deep link and the paste fallback build one list rather than two
7. The screen advances to the [`localdev`](../../agents/local_dev/local_dev.md) step

### A link while the app is already running
1. The second launch is stopped by the single-instance lock; the primary instance receives the argv through `second-instance`
2. Past first run, the confirmation is a **modal over the app** (`ConnectIntentModal`), not a resurrected onboarding screen: the user has an account and a workspace they are looking at, and replacing it with a first-run screen to answer one yes/no question would be a bigger interruption than the question
3. Escape and a backdrop click both mean "not now" — declining a link the user did not expect must be the easiest thing on the screen

### A server this machine already has
1. The panel matches the intent's origin against the local profiles' `cinnaServerUrl` (compared without a trailing slash)
2. On a match the heading becomes **"Open cinna.acme.com?"** and the primary action becomes **Switch to it** — re-running OAuth would work, but it sends the user through the browser to arrive at an account they already have on this machine
3. Switching is **never automatic**: the same link that could connect a server it should not could also flip the user into a different profile without them noticing
4. A password-locked profile is not given a second password prompt here; the panel says to switch from the account menu, rather than growing a second prompt that has to keep up with the first one

### A link that arrives mid-OAuth
1. The intent is still buffered but **not pushed**: raising the confirm step over a browser round trip the user is in the middle of would either lose the flow or connect the wrong server
2. `authService` calls `connectIntentService.flush()` in the `finally` of both `registerCinna` and `reauthCinna`, so the held link is released whichever way the flow settled

### A link the app refuses
1. Nothing happens, visibly. A rejected deep link has no UI, because a link the app refuses should look to the user exactly like a link nobody sent
2. The reason is logged. An accepted one is logged at info with its host, because "why did nothing happen when I clicked the button" is a real support question and that line is the answer

### The scheme could not be registered
1. A Linux AppImage without AppImageLauncher simply cannot claim a URL scheme. Registration is best-effort and a failure is a warning, not an error
2. The landing page's **paste-the-URL fallback** exists for exactly that case, and lands in the ordinary Cinna Server step of onboarding — which is why that step's history is shared with this one

## Business Rules

### The confirm step is the security boundary; validation is not

Anything on the machine can ask the OS to open a `cinna://` URL — a web page through a browser prompt, another app, a shortcut a user was mailed. So:

- The service **never starts an OAuth flow and never opens a browser** on its own. It buffers one intent and shows it to the user, who reads the host and decides
- `ConnectIntentPanel` renders the origin **large and unabbreviated**, offers **no "remember this"** affordance, and makes declining a plain always-available button rather than a corner ×
- A link that silently connected an app to a server would be a phishing primitive no amount of parsing would fix
- The panel is shared by the onboarding step and the modal, so "the link never connects anything without a confirmation" is one component's property rather than two screens' habit

### Origin-only validation, and each rule's reason

The URL is parsed as untrusted input and reduced to the one field the flow needs.

| Rule | Reason |
|---|---|
| Refuse anything over 2048 characters, before parsing | An origin is tens of characters; a megabyte argv entry is not worth handing to `new URL` |
| Scheme must be `cinna:` | Anything else is not ours |
| Action must be `connect`, read from **either** the authority (`cinna://connect?…`) or the first path segment (`cinna:///connect?…`) | Which of the two the OS hands over has depended on the platform and on how the link was written. Both spellings mean the same thing and neither is worth failing on |
| Reject embedded credentials (`user:pass@`) | Nothing legitimate carries them |
| Require `https`, except for loopback hosts (`localhost`, `127.0.0.1`, `[::1]`, `::1`), which may use `http` | A developer has to be able to point the app at their own dev server |
| **Keep `url.origin` — the parse, not a substring** | Path, query, fragment and credentials cannot survive into it. This is the load-bearing step: `discoverCinnaEndpoints` appends `/.well-known/cinna-desktop` to whatever it is given and then follows the endpoints in the response, so a URL carrying a path or a query would widen what a link can aim the app at for no benefit. The landing page only ever needs to say *which host* |

### Buffer and replace

- The OS can deliver a URL before there is a window to show it in, so an intent is **held until someone asks**. The renderer pulls it with `connect:get-pending` on mount and also subscribes to the push, so a link that arrives either side of mount is handled
- **A second link replaces the first.** The user's most recent click is what they meant, and a queue of stale hosts is not something anyone wants to confirm one by one
- `flush()` is idempotent and safe with no window
- The buffer is dropped by `connect:consume`, which the renderer calls for **all three** outcomes — connected, switched, declined
- A *new* intent arriving while the onboarding screen is open redirects it back to the confirm step. It is matched on `receivedAt`, so the intent the confirm step just consumed cannot bounce a user who declined straight back into it

### Exactly one surface confirms

`OnboardingGate` subscribes to the intent itself rather than leaving it to the modal, because the gate is what decides *which* surface confirms. The store dedupes, so the modal reading the same value costs nothing. `ConnectIntentModal` is mounted **inside** the gate: its children render only once first run is over, which is exactly when the modal rather than the onboarding step is the right surface. Outside the gate, both would show the same intent at once.

### Scheme registration

- In a packaged app, one `app.setAsDefaultProtocolClient('cinna')` call. Under `npm run dev` the running binary is Electron itself and the app is a script argument, so both are passed — otherwise the OS would register plain Electron as the handler for every project on the machine
- **The single-instance lock is what makes the running-app case work at all.** Without it a second click launches a second copy of Cinna, which registers nothing, shows its own window, and leaves the user's real profile behind the new one. With it, the second process `app.exit(0)`s and the first receives the URL
- A second launch with **no** link is still the user asking for the app — typically a Dock click while the window is behind something — so it focuses the window instead
- All of this lives at module scope, before `whenReady`. A handler installed inside `startup()` would miss the one delivery the feature exists for. Buffering makes being early free
- **Registration is skipped when `CINNA_USER_DATA` is set** — the E2E sandbox profile. Claiming the machine's `cinna://` handler is a change to the developer's OS, and a test that leaves it pointing at a temporary sandbox has broken the machine it ran on

### The test-only argv form

`--cinna-connect-intent=<url>` enters the **same funnel** as `open-url` and the argv scan. A real `open-url` event cannot be raised from Playwright — macOS delivers it through Launch Services and there is no supported way to fake that against a running app — so a spec using the flag exercises every line below the OS hook: the validation, the buffer, the push and the whole confirm step. Argv is **scanned**, not read at a fixed position, because the app already launches with other arguments (`--use-mock-keychain`, the app path in dev) and Chromium adds its own.

### Focus

Both flows that hand the user to their browser and expect them back — this confirm step and every re-auth — call `focusMainWindow()`. On macOS the app that *loses* focus does not get it back when the browser finishes, so without it the user completes the sign-in, sees "you can close this tab", and has to find Cinna in the Dock. `app.focus({ steal: true })` is what actually raises the application; stealing focus is normally rude and is right here for exactly one reason: the user just finished an interaction they started in this app and is waiting for it to react. The same call fires when an intent is pushed, so a link clicked while Cinna is behind another window brings it forward.

## Architecture Overview

```
landing page  ──►  cinna://connect?server=https://cinna.acme.com
                          │
      ┌───────────────────┼────────────────────┬──────────────────┐
   open-url        second-instance          argv scan        --cinna-connect-intent=
   (macOS)         (running app)          (cold launch)          (E2E only)
      └───────────────────┴────────────────────┴──────────────────┘
                          ▼
        connectIntentService.deliver()   parse → origin-only → buffer
                          │
                 OAuth in flight? ── yes ─► hold, until authService flush()
                          │ no
                          ▼
        focusMainWindow() + send 'connect:intent'
                          │
                          ▼
   connectIntent.store ◄── connect:get-pending (on mount)
        │
        ├─ first run  → OnboardingScreen step 'cinna-confirm' ─┐
        └─ past it    → ConnectIntentModal ────────────────────┴─► ConnectIntentPanel
                                                                    ├─ Connect  → auth:register (OAuth)
                                                                    ├─ Switch to it → auth:login
                                                                    └─ Not now
                                                                          │
                                                                    connect:consume
```

## Integration Points

- [Onboarding](onboarding.md) — `cinna-confirm` is a step of the onboarding screen, reached only by arriving
- [Cinna Accounts](../cinna_accounts/cinna_accounts.md) — **Connect** runs the unchanged self-hosted OAuth flow; the intent carries no credential of any kind
- [Cinna Re-authentication](../cinna_accounts/reauthentication.md) — shares `focusMainWindow()`, and releases a held intent in its own `finally`
- [User Accounts](../user_accounts/user_accounts.md) — **Switch to it** is the ordinary `auth:login`, and a password-locked profile is deferred to the account menu
- [Local Development](../../agents/local_dev/local_dev.md) — where a confirmed connection goes next
- [Release & Distribution](../../development/distribution/release.md) — `protocols:` in `electron-builder.yml` is what puts the scheme in the installed bundle

## Technical Reference

See [connect_link_tech.md](connect_link_tech.md).
