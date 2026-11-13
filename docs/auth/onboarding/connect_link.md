# The `cinna://connect` Link

## Purpose

A landing page on a self-hosted cinna-core instance can hand a freshly installed desktop the one thing the download itself cannot carry: **which server it was downloaded for**. The link fires `cinna://connect?server=<origin>`, the app validates and buffers it, and shows a confirmation naming the host. Only if the user says yes does the ordinary desktop OAuth flow run — unchanged.

## Core Concepts

| Term | Definition |
|------|-----------|
| **Connect intent** | The whole payload: `{ serverUrl, receivedAt }`. An origin and when it arrived. No token, no path, no query |
| **The funnel** | `deepLinkService.deliver(rawUrl, source)` — the single place every OS or test delivery lands in; it reads the link's action and hands it to that action's service, so no caller can skip the validation, the buffer or the push. A connect link then lands in `connectIntentService.deliver`, which a paste and the clipboard check call directly |
| **Source** | Which path delivered it: `open-url` (macOS), `second-instance` (a link click while the app runs), `argv` (a cold launch on Linux/Windows), `test-argv` (the E2E flag), `clipboard` (the first-run clipboard check, Linux only), `paste` (a link pasted into onboarding's Server URL field) |
| **Confirm step** | `ConnectIntentPanel` — the one screen a link is allowed to reach, and **the feature's security boundary** |
| **Buffer** | One pending intent held in main until someone asks for it. A second link replaces the first |
| **Install handoff** | The download page copies the link to the clipboard; the freshly installed app picks it up on first run (Linux) or the user pastes it into Server URL (every platform). A way to *deliver* the link without a click, not a second confirmation path: both end on the same confirm step |

## User Stories / Flows

### A brand-new install, launched from a link
1. The user clicks the landing page's button. The OS launches the freshly installed app with the URL
2. On macOS `open-url` fires **before** the app is ready; on Linux and Windows the URL arrives appended to argv. Either way it lands in the funnel and is buffered
3. The window opens; `OnboardingGate` reads the buffered intent and opens `OnboardingScreen` on its `cinna-confirm` step instead of the welcome step — the user clicked a button that named a server, and asking them to choose between "API key" and "Cinna Server" first would be asking a question they have already answered
4. In order: **"Connect to cinna.acme.com?"**, the full origin unabbreviated in its own box, an **Enable local development** checkbox directly under it and left-aligned — it is a setting for *this connection*, not a second action competing with the button — then **Connect** centred, then **Not now** as quiet text. The checkbox is ticked unless this machine already holds an answer for that host, and its (?) opens **upward**, so reading what will be installed never means covering the button that installs it
5. **Connect** runs the ordinary self-hosted `auth:register` OAuth flow against that origin. The waiting state and its Cancel button are the same ones the typed-URL path uses
6. On success the origin is written into the shared self-hosted history — the same history a typed URL populates, so the deep link and the paste fallback build one list rather than two — and the checkbox's answer is recorded for that host, ticked or not
7. Onboarding finishes and the app opens. A ticked box installs [local development](../../agents/local_dev/local_dev.md) in the background, with progress on the sidebar's Local development icon and no modal; an unticked one is a remembered decline that icon can reverse

### A brand-new install on Linux, launched from the icon
An AppImage without AppImageLauncher cannot claim the scheme, so there the Open button does nothing and the user starts the app by hand. The download page has already copied the link, so:
1. At first-run onboarding the renderer asks main once (`connect:check-clipboard`); main reads the clipboard, and if it holds a `cinna://connect` link, runs it through the funnel with source `clipboard` and **buffers it without a push**
2. `OnboardingGate` keeps its blank placeholder for at most 300 ms while that answer is in flight, then opens the screen on `cinna-confirm` exactly as for a clicked link. The check is a local round trip of milliseconds; the cap only bounds a main process still busy with startup
3. An answer later than the cap is **dropped**: the welcome card is already on screen and nothing may move under the user. The gate also tells main to forget that intent (`connect:consume` with its `receivedAt`), so a link nobody will show is not left waiting for the next mount
4. Nothing on the clipboard, an unrelated clipboard, a failed read: welcome, as if the check had not existed

### A brand-new install on macOS
The app **never reads the clipboard on macOS**. With Apple's pasteboard privacy on (opt-in on macOS 15, meant to become the default), a program that reads the pasteboard without a user paste raises an **"Allow Paste?"** `NSAlert` modal, owned by the app. The bare-Mac probe on the Sequoia image (2026-10-30) showed the main thread parked inside `NSPasteboard stringForType:` behind that modal at first launch, frozen until someone answered. So a Mac user either clicks the page's Open button (the `open-url` path) or pastes the link, which is a user paste the privacy check allows.

### A link pasted into Server URL, or on Welcome
1. On the Cinna Server step, pasting text that starts with `cinna://` into **Server URL** does not put it in the field. The paste is cancelled and the text goes to main (`connect:deliver-pasted`), which parses it through the funnel with source `paste`
2. The same paste on the **Welcome** card works too, with nothing to click first: the download page's note says *"Paste it into the Server URL field"*, and a person who has just installed the app presses Cmd+V on the first screen they see. Edit → Paste with no field focused fires at the page body, where Welcome listens; a paste into an editable element is left to that element. A real Cmd+V is a user paste, so macOS asks nothing
3. An accepted link opens the confirm step like any other. A refused one shows **"That link has no server Cinna can use."** in the footer row of the Server URL step, left of **Connect** (a refusal on Welcome moves to that step to say so); the field is untouched
4. This works on every platform and is the fallback that exists for the Mac and for a Linux user whose clipboard was overwritten before the first run

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
1. Nothing happens, visibly. A rejected deep link has no UI, because a link the app refuses should look to the user exactly like a link nobody sent. **The one exception is a pasted link**: the user just acted, and a paste that silently did nothing would read as a broken field, so the Server URL step says the link has no usable server. A clipboard read is not an exception — nobody asked for it, so a refused or absent clipboard link stays invisible
2. The reason is logged. An accepted one is logged at info with its host, because "why did nothing happen when I clicked the button" is a real support question and that line is the answer

### The scheme could not be registered
1. A Linux AppImage without AppImageLauncher simply cannot claim a URL scheme. Registration is best-effort and a failure is a warning, not an error
2. The landing page's **paste-the-URL fallback** exists for exactly that case, and lands in the ordinary Cinna Server step of onboarding — which is why that step's history is shared with this one

## Business Rules

### The confirm step is the security boundary; validation is not

Anything on the machine can ask the OS to open a `cinna://` URL — a web page through a browser prompt, another app, a shortcut a user was mailed. So:

- The service **never starts an OAuth flow and never opens a browser** on its own. It buffers one intent and shows it to the user, who reads the host and decides
- `ConnectIntentPanel` renders the origin **large and unabbreviated** — with no caption above it, which only pushed it further from the button that acts on it — and offers **no "remember this"** affordance
- **Declining stays a real, always-available button**, never a corner ×. It is quieter than the action the user came here for, and that is the whole of the difference
- The panel carries **one** extra decision, the local-development checkbox, and it is about this machine rather than about the link. It changes nothing the panel guarantees: the origin is still what the user reads, and Connect is still the only thing that starts an OAuth flow
- **A stored answer beats the default tick.** This panel is also the surface an already-onboarded install shows, and **Switch to it** can name a profile whose owner declined local development deliberately; a box that re-ticked itself would reverse that decision and spend a few hundred megabytes doing it. A link must not be able to undo a choice the user has already made on this machine
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
- `connect:consume` may name an intent by its `receivedAt`; main then drops it only if that is still the pending one. The gate uses it for a late clipboard answer, so discarding that answer cannot take a link clicked a moment later with it
- A *new* intent arriving while the onboarding screen is open redirects it back to the confirm step. It is matched on `receivedAt`, so the intent the confirm step just consumed cannot bounce a user who declined straight back into it

### One funnel, two slots

The `cinna://` scheme carries more than one action, so the OS hooks no longer call `connectIntentService` directly. `deepLinkService.deliver` reads the action (the authority, or the first path segment, as above) and routes it:

- `skill` goes to `skillLinkIntentService` (`cinna://skill/<package_id>[?server=<origin>]`, see [Adding a skill from a link](../../agents/local_agents/skills.md#adding-a-skill-from-a-link)).
- `oauth-done` (`cinna://oauth-done?credential_id=<uuid>` or `?status=error`) is Core's Google sign-in end page handing the user back. It has **no buffer and no panel**: main brings the window forward (opening it again if it was closed; before `ready`, startup shows the first one) and tells the waiting Google connects to poll Core now (`serviceCredentialService.nudgeOAuthFlows`). Nothing in the link is believed beyond "poll now"; an error or an id that is not a UUID polls every waiting connect, and what Core's list says decides, as on any tick. See [Google OAuth credentials](../../agents/service_credentials/README.md#google-oauth-credentials).
- Anything else goes to `connectIntentService` exactly as before: `connect` is accepted there, and an unknown action is refused and logged there.

Each *buffered* action (connect, skill) has **its own one-intent buffer**, and that is the point. A single shared slot would let a skill link evict a connect intent the person is reading in its confirm step, and the confirm step's later `consume` would drop whichever intent happened to be pending. Everything else is shared in shape, not in state: a second link of the same action replaces the first, nothing is pushed while an OAuth flow is in flight, and `flush()` (called when the flow settles) pushes whatever each slot holds. The skill slot has its own channels (`skill-link:*`) and no confirm panel of its own: the composer's offer is its confirm step.

### The clipboard read is narrow on purpose

The clipboard is the user's private data, and the feature reads it only to look for one kind of text.

- **At most one read per process**, on first-run onboarding only: not past first run, not on forced onboarding (a test path on a configured install, where a stray link would only confuse whoever is testing), and not when an intent is already pending or in the store — a clicked link is newer and more deliberate than a copied one, and main does not read at all in that case. Nothing may turn it into a clipboard watcher
- **Linux only.** macOS is excluded for the reason above; Windows is not read either
- Only text starting `cinna://connect` (either spelling, case-insensitive, trimmed, at most 2048 characters) is parsed. Anything else is dropped **unlogged**: the parser logs the action of a `cinna://` URL it refuses, and for clipboard text that would be a piece of whatever the user copied. A failed read logs the error's class and message, nothing else
- The clipboard is never written or cleared
- Buffered without a push, and the call returns only an intent *this read* delivered. A clicked link already pending reaches the renderer through `connect:get-pending`; returning it here would let the gate's late-answer consume drop it
- **Under the E2E sandbox (`CINNA_USER_DATA`) the real pasteboard is never read**: a `cinna://` link the developer happened to copy would hijack whichever first-run spec ran next. The sandbox reads only `CINNA_E2E_CLIPBOARD_TEXT`, on any platform so the renderer path stays testable, and reads nothing without it. The variable is ignored outside the sandbox

### Exactly one surface confirms

`OnboardingGate` subscribes to the intent itself rather than leaving it to the modal, because the gate is what decides *which* surface confirms. The store dedupes, so the modal reading the same value costs nothing. `ConnectIntentModal` is mounted **inside** the gate: its children render only once first run is over, which is exactly when the modal rather than the onboarding step is the right surface. Outside the gate, both would show the same intent at once.

### Scheme registration

- In a packaged app, one `app.setAsDefaultProtocolClient('cinna')` call. Under `npm run dev` the running binary is Electron itself and the app is a script argument, so both are passed — otherwise the OS would register plain Electron as the handler for every project on the machine
- **The single-instance lock is what makes the running-app case work at all.** Without it a second click launches a second copy of Cinna, which registers nothing, shows its own window, and leaves the user's real profile behind the new one. With it, the second process `app.exit(0)`s and the first receives the URL
- A second launch with **no** link is still the user asking for the app — typically a Dock click while the window is behind something — so it focuses the window instead
- All of this lives at module scope, before `whenReady`. A handler installed inside `startup()` would miss the one delivery the feature exists for. Buffering makes being early free
- **Registration is skipped when `CINNA_USER_DATA` is set** — the E2E sandbox profile. Claiming the machine's `cinna://` handler is a change to the developer's OS, and a test that leaves it pointing at a temporary sandbox has broken the machine it ran on

### The test-only argv form

`--cinna-connect-intent=<url>` enters the **same funnel** as `open-url` and the argv scan, and carries a `cinna://skill/…` link as well as a connect one (the flag's name is older than the second action). A real `open-url` event cannot be raised from Playwright — macOS delivers it through Launch Services and there is no supported way to fake that against a running app — so a spec using the flag exercises every line below the OS hook: the validation, the buffer, the push and the whole confirm step. Argv is **scanned**, not read at a fixed position, because the app already launches with other arguments (`--use-mock-keychain`, the app path in dev) and Chromium adds its own.

### Focus

Both flows that hand the user to their browser and expect them back — this confirm step and every re-auth — call `focusMainWindow()`. On macOS the app that *loses* focus does not get it back when the browser finishes, so without it the user completes the sign-in, sees "you can close this tab", and has to find Cinna in the Dock. `app.focus({ steal: true })` is what actually raises the application; stealing focus is normally rude and is right here for exactly one reason: the user just finished an interaction they started in this app and is waiting for it to react. The same call fires when an intent is pushed, so a link clicked while Cinna is behind another window brings it forward.

## Architecture Overview

```
landing page  ──►  cinna://connect?server=https://cinna.acme.com
                          │
      ┌───────────────────┼────────────────────┬──────────────────┐
   open-url        second-instance          argv scan        --cinna-connect-intent=
   (macOS)         (running app)          (cold launch)          (E2E only)
      │                   │                    │                  │
      │   clipboard (Linux, first run, once, no push)    paste in Server URL
      │      connect:check-clipboard                    connect:deliver-pasted
      └───────────────────┴────────────────────┴──────────────────┘
                          ▼
        deepLinkService.deliver()  ── action? ──► skill: skillLinkIntentService (own slot, skill-link:*)
                          │ connect (or unknown)
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
                                                                    ├─ [x] Enable local development
                                                                    │        seeded from localdev:get-consent
                                                                    │        → localdev:consent(host, checked)
                                                                    └─ Not now
                                                                          │
                                                                    connect:consume
```

## Integration Points

- [Onboarding](onboarding.md) — `cinna-confirm` is a step of the onboarding screen, reached only by arriving; its Server URL field is where a link is pasted
- [Bare-Mac Tests](../../development/bare_mac/bare_mac.md) — the `install-handoff` spec is where the macOS clipboard decision was probed and is kept honest
- [Cinna Accounts](../cinna_accounts/cinna_accounts.md) — **Connect** runs the unchanged self-hosted OAuth flow; the intent carries no credential of any kind
- [Cinna Re-authentication](../cinna_accounts/reauthentication.md) — shares `focusMainWindow()`, and releases a held intent in its own `finally`
- [User Accounts](../user_accounts/user_accounts.md) — **Switch to it** is the ordinary `auth:login`, and a password-locked profile is deferred to the account menu
- [Local Development](../../agents/local_dev/local_dev.md) — where a confirmed connection goes next, and whose per-host consent this panel's checkbox answers so nothing asks again after sign-in
- [Release & Distribution](../../development/distribution/release.md) — `protocols:` in `electron-builder.yml` is what puts the scheme in the installed bundle

## Technical Reference

See [connect_link_tech.md](connect_link_tech.md).
