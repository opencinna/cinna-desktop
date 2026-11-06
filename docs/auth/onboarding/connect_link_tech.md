# The `cinna://connect` Link — Technical Reference

Implementation companion to [connect_link.md](connect_link.md).

## File Locations

### Shared
- `src/shared/serverOrigin.ts` — `normalizeServerOrigin()` and `MAX_URL_LENGTH`, moved here from `connectIntentService` so the skill-link parser applies the same origin rule; `connectIntentService` re-exports both
- `src/shared/connectIntent.ts` — `ConnectIntent` (`serverUrl`, `receivedAt`), `CONNECT_INTENT_CHANNEL` (`'connect:intent'`), `CONNECT_SCHEME` (`'cinna'`), `CONNECT_INTENT_ARGV_FLAG` (`'--cinna-connect-intent='`)

### Main process
- `src/main/host/desktop/deepLinkService.ts` (+ `deepLinkService.test.ts`) — the funnel: `deepLinkActionOf(raw)`, `deepLinkUrlFromArgv` (the same scan as `connectUrlFromArgv`), and `deepLinkService.{install, deliver, flush}`. `index.ts` calls only this for `open-url`, `second-instance`, the startup argv scan and `authCompleted`; `skill` goes to `skillLinkIntentService.ts`, everything else to `connectIntentService`
- `src/main/host/desktop/connectIntentService.ts` — `normalizeServerOrigin()`, `parseConnectUrl()`, `connectUrlFromArgv()`, `registerConnectScheme()`, and the `connectIntentService` object (`install`, `deliver`, `flush`, `getPending`, `consume`, `installClipboardSource`, `checkClipboardOnce`, `reset`); module constants `MAX_URL_LENGTH` (2048, exported for the IPC layer), `LOOPBACK_HOSTS`, `CONNECT_ACTION`
- `src/main/services/connectIntentService.test.ts` — the parser, the argv scan, the buffer, `consume(receivedAt)`, `checkClipboardOnce` and the `paste` source
- `src/main/ipc/connect.ipc.ts` — `registerConnectHandlers()`
- `src/main/window/focus.ts` — `installWindowResolver()`, `focusMainWindow()`
- `src/main/index.ts` — the `cinna://` block at module scope: `registerConnectScheme()` (skipped when `CINNA_USER_DATA` is set), `requestSingleInstanceLock()`, the `second-instance` and `open-url` handlers (both `deepLinkService.deliver`), and the startup `deepLinkUrlFromArgv(process.argv)` scan inside `startup()`, and the `installClipboardSource(…)` call: `clipboard.readText` on Linux, nothing on macOS or Windows, and under `CINNA_USER_DATA` only the `CINNA_E2E_CLIPBOARD_TEXT` seam (or nothing)
- `src/main/auth/cinna-oauth.ts` — `isCinnaOAuthInProgress()`
- `src/main/services/authService.ts` — `desktopFeatures.authCompleted()` in the `finally` of `registerCinna` and `reauthCinna`, which `index.ts` wires to `focusMainWindow()` and `deepLinkService.flush()` (both slots)
- `electron-builder.yml` — the top-level `protocols:` block (`name: Cinna Desktop`, `schemes: [cinna]`)

### Preload
- `src/preload/index.ts` — the `connect` block: `getPending()`, `consume(receivedAt?)`, `checkClipboard()`, `deliverPasted(text)`, `onIntent(handler) → unsubscribe`

### Renderer
- `src/renderer/src/stores/connectIntent.store.ts` — `useConnectIntentStore`
- `src/renderer/src/hooks/useConnectIntent.ts` — `useConnectIntent()`
- `src/renderer/src/components/auth/ConnectIntentPanel.tsx` (+ `.test.tsx`) — the panel and `ConnectIntentOutcome` (`'connected' | 'switched' | 'declined'`)
- `src/renderer/src/components/localdev/LocalDevOptInRow.tsx` — the **Enable local development** checkbox the panel renders, under the URL box and left-aligned, its (?) anchored `above-left` so it cannot cover Connect; see [Local Development](../../agents/local_dev/local_dev_tech.md)
- `src/renderer/src/components/ui/usePopover.ts` — this is the hook's first **mid-dialog** trigger, and it exposed a real limitation: every placement anchors one horizontal side, so a 22rem popover two thirds of the way across a narrow window hung off the far side. The hook now clamps a popover back inside the window with a measured `translateX`; the mechanism and its three traps are in [App Shell](../../ui/app_shell/app_shell_tech.md#usepopover-usepopoverts)
- `src/renderer/src/components/auth/ConnectIntentModal.tsx` — the past-first-run surface
- `src/renderer/src/components/auth/OnboardingScreen.tsx` — the `cinna-confirm` step, the `connectIntent` / `onConnectIntentDone` props, the `receivedAt` ref that redirects only on a *new* intent, `handleServerUrlPaste` on the Server URL field, and the Welcome step's document `paste` listener (skips editable targets); both go through `deliverPastedLink`, which moves a refusal to the Server URL step. The error line shares the footer row with **Connect** (`role="alert"`, left of the button) so a refused paste, which fires with no submit, never moves the button
- `src/renderer/src/components/auth/OnboardingScreen.paste.test.tsx` — a pasted link goes to main and opens the confirm step without entering the field; a plain URL pastes normally; a refusal shows the error and leaves the field alone
- `src/renderer/src/components/auth/OnboardingGate.tsx` (+ `.test.tsx`) — `OnboardingGate` and `CLIPBOARD_WAIT_MS` (300). Subscribes and routes; runs the clipboard check; `<ConnectIntentModal />` is mounted inside it (in `App.tsx`)
- `src/renderer/src/App.tsx` — mounts `OnboardingGate`
- `e2e/bare-mac/specs/install-handoff.spec.ts` — see [Bare-Mac Tests](../../development/bare_mac/bare_mac.md)

## Database Schema

None. The intent is process memory in main and store state in the renderer; nothing about it is persisted. The only durable write on the confirmed path is whatever `auth:register` / `auth:login` already do, plus the `cinna-selfhosted-history` localStorage list shared with [onboarding](onboarding_tech.md).

## IPC Channels

| Channel | Signature | Notes |
|---|---|---|
| `connect:get-pending` | `() → ConnectIntent \| null` | **Deliberately not behind `userActivation.requireActivated()`**: the whole point is the *first* run, before any account exists, so a gate here would make the one case the feature is for the one case it cannot serve. Nothing is disclosed either way — the renderer is asking for a host the user's own click just supplied |
| `connect:consume` | `(receivedAt?: number) → { success: true }` | Called for all three outcomes. With a number, drops the buffer only if it still holds that intent; anything else is treated as no argument |
| `connect:check-clipboard` | `() → ConnectIntent \| null` | First-run onboarding, once. Ungated for the same reason as `get-pending`. The service enforces once-per-process and returns only an accepted origin, never clipboard text. Null when an intent was already pending |
| `connect:deliver-pasted` | `(text) → ConnectIntent \| null` | Ungated: the field is on the first-run screen. Non-strings and text over `MAX_URL_LENGTH` return null; otherwise `deliver(text.trim(), 'paste')`, which **does push**, so the accepted intent also arrives on `connect:intent` |
| `connect:intent` (push) | `ConnectIntent` | Main → renderer, sent by `flush()` after `focusMainWindow()` |

## Services & Key Methods

`normalizeServerOrigin(raw)` (now in `src/shared/serverOrigin.ts`) → `{ ok: true, origin }` or `{ ok: false, reason }`. The reason is a **log** string, never shown: a refused link has no UI. Checks in order — non-empty, ≤ `MAX_URL_LENGTH`, parses as a URL, no `username`/`password`, has a `hostname`, `http:` only for a `LOOPBACK_HOSTS` member and otherwise `https:`. Returns `url.origin`.

`parseConnectUrl(raw)` → `ConnectIntent | null`. Length guard, `URL` parse, `protocol === 'cinna:'`, then the action from `url.hostname || url.pathname.replace(/^\/+/, '').split('/')[0]`, lowercased, compared to `'connect'`. Then `searchParams.get('server')` through `normalizeServerOrigin`. Every rejection logs at warn and returns null.

`connectUrlFromArgv(argv)` → the first argument starting with `CONNECT_INTENT_ARGV_FLAG` (its value) or with `cinna://` (itself), else null.

`connectIntentService.deliver(rawUrl, source)` — parse; null → return null. Otherwise log at **info** with `{ source, serverUrl }` (the host is not a secret and the intent carries nothing else), set `pending`, and either hold (when `isCinnaOAuthInProgress()`) or `flush()`.

`installClipboardSource(fn | null)` — set once by `index.ts`; null means never read. `reset()` clears it.

`checkClipboardOnce()` — async since Electron 44 made the clipboard asynchronous (the source may return a string or a Promise; `connect:check-clipboard` awaits it). Sets its once flag **first**, so a throwing or empty read still uses the one read. Returns null without reading when an intent is pending or no source is installed, and null after the read if a link arrived while it was in flight (the clicked link wins). Reads, requires a string, trims, and requires `/^cinna:\/\/\/?connect([/?#]|$)/i` and length ≤ `MAX_URL_LENGTH` before anything is parsed or logged; then `deliver(text, 'clipboard', { push: false })`. `deliver`'s `push: false` option buffers and returns before the OAuth-hold and `flush()` steps.

`consume(receivedAt?)` — with an argument, a no-op unless `pending.receivedAt` equals it.

`flush()` — no-op without a pending intent, during an OAuth flow, or with no live window. Otherwise `focusMainWindow()` then `win.webContents.send(CONNECT_INTENT_CHANNEL, pending)`.

`registerConnectScheme()` — `process.defaultApp && process.argv.length >= 2` → `setAsDefaultProtocolClient(scheme, process.execPath, [resolve(process.argv[1])])`, else the one-argument form. Wrapped in try/catch; a falsy return is a warn.

`focusMainWindow()` — restore if minimized, `show()`, `focus()`, then `app.focus({ steal: true })` on darwin and `app.focus()` elsewhere. **Never throws**: a failure to focus is cosmetic and must not take down the flow that asked for it. The window getter is *installed* by `index.ts` rather than imported from it, because importing the app entry from a service pulls the whole startup graph into anything that touches focus, unit tests included.

## Renderer Components

| Component / hook | Renders / manages |
|---|---|
| `useConnectIntentStore` | One intent for the whole renderer. A store rather than a hook's own state because two very different surfaces read the same value and exactly one must show; two independent subscriptions would race to render two confirmations of the same link. `subscribed` is set **before** the first `await` so StrictMode's double-invoked mount effect cannot register two IPC listeners. A push that lands while `getPending()` is in flight wins, because it is newer |
| `useConnectIntent()` | Subscribes on mount and stays subscribed for the app's lifetime |
| `ConnectIntentPanel` | Three states: the question, the OAuth waiting view (with Cancel → `auth:cinna-oauth-abort`), and inline errors. `existing` is found by comparing `cinnaServerUrl` to `intent.serverUrl` with trailing slashes stripped from both. Also holds the local-development checkbox: local state seeded from `localDev.getConsent()[host]` and falling back to ticked when this machine holds no answer (otherwise **Switch to it**, and the already-onboarded modal, silently reversed a deliberate decline and started a few-hundred-MB install; the read is gated on an activated profile, so a genuine first run just keeps the default). A `localDevTouched` ref makes the user's own toggle final — the seeding effect re-runs when the profile list resolves, and a stored answer arriving a moment late would otherwise flip a box they had just clicked. Recorded through `useLocalDevStore.consent(host, checked)` on both the connect and switch paths — **not awaited**, because an accept makes main install a toolchain and blocking the screen on that would turn "connect" into "connect and wait for a download". The Agents Home in the (?) copy comes from `useAgentsHomeHint()`, and its absence just omits the workspace line. That hook **reads the path and does not create it**: it went through the roots list until the folder question shipped, so a panel that merely *names* the agents folder created it, and on macOS the Documents-folder prompt arrived on the confirm screen ([The Agents Folder Question](../../agents/local_agents/home_access.md)) |
| `ConnectIntentModal` | Escape and backdrop click both `consume()`. No mid-flight lock-out — the panel takes over its own surface once the browser round trip starts |
| `OnboardingScreen` | `useState<Step>(connectIntent ? 'cinna-confirm' : 'welcome')`, plus a `lastIntentAt` ref so only an intent with a *new* `receivedAt` re-enters the step |
| `useConnectIntentStore.offer(intent)` | Holds an intent the renderer fetched itself (clipboard answer, pasted link) **only when the store holds none**: a pushed or pending link is the one already on its way to the screen |
| `OnboardingGate` | Calls `useConnectIntent()` and passes `intent` / `consume` down. The modal below it reads the same store. Runs the clipboard check when first run is decided true and not forced: skips it if the store already holds an intent; otherwise starts a 300 ms timer and `connect:check-clipboard`, whichever settles first lets the screen paint. An in-time answer is `offer`ed; a late one is consumed in main by `receivedAt` unless a link reached the store meanwhile. A guarding ref, not the effect cleanup, makes it a single call under StrictMode |

## Configuration

| Where | What |
|---|---|
| `electron-builder.yml` → `protocols:` | Registers `cinna` in the built bundle (macOS `CFBundleURLTypes`, Linux `.desktop` `MimeType`) |
| `CINNA_USER_DATA` env var | Set by the E2E harness. Its presence **skips** scheme registration |
| `CINNA_E2E_CLIPBOARD_TEXT` env var | Honoured only with `CINNA_USER_DATA` set; the text `checkClipboardOnce` reads instead of the pasteboard, on any platform |
| `CONNECT_INTENT_ARGV_FLAG` | `--cinna-connect-intent=<url>` — the test-only delivery path into the same funnel |

## Security

- **The confirm step, not the validation, is the guarantee.** Validation reduces what a link can express; the human reading the host is what decides whether it is acted on
- The payload carries **no token, path or query**, by construction: `url.origin` is a parse result, not a substring of the input
- `https` is required except for loopback, so a link cannot aim the app at a plaintext host
- Main **never opens a browser** for an intent on its own, and the preload surface exposes no method that could authorize against a link-supplied server without the panel
- An intent arriving mid-OAuth is held, so a link cannot interleave itself with a flow already in progress
- The clipboard is read at most once per process, on Linux, on first run, and nothing but an accepted origin leaves main; non-link text is neither parsed nor logged
- A pasted link goes through main and the same funnel; the renderer never parses it. The paste handler claims any text starting `cinna://`, so a malformed one is refused with the error line rather than landing in the field
- Scheme registration is a mutation of the developer's OS and is therefore skipped for the throwaway E2E profile

## Verified

`connectIntentService.test.ts` covers `normalizeServerOrigin` (including the credential, scheme and loopback rules), both action spellings, a URL-encoded `server` parameter, the argv scan in both forms and with no link at all, and the buffer's four properties: an accepted intent is buffered for a renderer that is not there yet, a refused one is not, a second intent **replaces** rather than queues, and the buffer survives until `consume()`, `consume(receivedAt)` dropping only the named intent. For the clipboard it covers once-per-process, no read over a pending intent, non-link and oversized text ignored without a log line, both spellings, no push, no source, a throwing source, and `reset`.

`OnboardingGate.test.tsx` covers the check opening the confirm step, one call under StrictMode, the blank placeholder while it is in flight, welcome on no link or a failed check, the 300 ms cap with a late answer dropped and consumed in main, no consume when a link reached the store meanwhile, and no check on forced onboarding, past first run (providers or dismissed flag) or with a link already in the store. `OnboardingScreen.paste.test.tsx` covers the three paste cases above.

The `install-handoff` bare-Mac spec runs both macOS cases against a real guest with the pasteboard-privacy preview on. Not covered by a unit test: the OS hooks themselves (`open-url`, `second-instance`, the single-instance lock), scheme registration, and `focusMainWindow`. The argv flag exists so the E2E suite can drive everything below the OS hook against the built app.
