# The `cinna://connect` Link — Technical Reference

Implementation companion to [connect_link.md](connect_link.md).

## File Locations

### Shared
- `src/shared/connectIntent.ts` — `ConnectIntent` (`serverUrl`, `receivedAt`), `CONNECT_INTENT_CHANNEL` (`'connect:intent'`), `CONNECT_SCHEME` (`'cinna'`), `CONNECT_INTENT_ARGV_FLAG` (`'--cinna-connect-intent='`)

### Main process
- `src/main/services/connectIntentService.ts` — `normalizeServerOrigin()`, `parseConnectUrl()`, `connectUrlFromArgv()`, `registerConnectScheme()`, and the `connectIntentService` object (`install`, `deliver`, `flush`, `getPending`, `consume`, `reset`); module constants `MAX_URL_LENGTH` (2048), `LOOPBACK_HOSTS`, `CONNECT_ACTION`
- `src/main/services/connectIntentService.test.ts` — the parser, the argv scan and the buffer
- `src/main/ipc/connect.ipc.ts` — `registerConnectHandlers()`
- `src/main/window/focus.ts` — `installWindowResolver()`, `focusMainWindow()`
- `src/main/index.ts` — the `cinna://` block at module scope: `registerConnectScheme()` (skipped when `CINNA_USER_DATA` is set), `requestSingleInstanceLock()`, the `second-instance` and `open-url` handlers, and the startup `connectUrlFromArgv(process.argv)` scan inside `startup()`
- `src/main/auth/cinna-oauth.ts` — `isCinnaOAuthInProgress()`
- `src/main/services/authService.ts` — `connectIntentService.flush()` in the `finally` of `registerCinna` and `reauthCinna`
- `electron-builder.yml` — the top-level `protocols:` block (`name: Cinna Desktop`, `schemes: [cinna]`)

### Preload
- `src/preload/index.ts` — the `connect` block: `getPending()`, `consume()`, `onIntent(handler) → unsubscribe`

### Renderer
- `src/renderer/src/stores/connectIntent.store.ts` — `useConnectIntentStore`
- `src/renderer/src/hooks/useConnectIntent.ts` — `useConnectIntent()`
- `src/renderer/src/components/auth/ConnectIntentPanel.tsx` — the panel and `ConnectIntentOutcome` (`'connected' | 'switched' | 'declined'`)
- `src/renderer/src/components/auth/ConnectIntentModal.tsx` — the past-first-run surface
- `src/renderer/src/components/auth/OnboardingScreen.tsx` — the `cinna-confirm` step, the `connectIntent` / `onConnectIntentDone` props, and the `receivedAt` ref that redirects only on a *new* intent
- `src/renderer/src/App.tsx` — `OnboardingGate` subscribes and routes; `<ConnectIntentModal />` is mounted inside the gate

## Database Schema

None. The intent is process memory in main and store state in the renderer; nothing about it is persisted. The only durable write on the confirmed path is whatever `auth:register` / `auth:login` already do, plus the `cinna-selfhosted-history` localStorage list shared with [onboarding](onboarding_tech.md).

## IPC Channels

| Channel | Signature | Notes |
|---|---|---|
| `connect:get-pending` | `() → ConnectIntent \| null` | **Deliberately not behind `userActivation.requireActivated()`**: the whole point is the *first* run, before any account exists, so a gate here would make the one case the feature is for the one case it cannot serve. Nothing is disclosed either way — the renderer is asking for a host the user's own click just supplied |
| `connect:consume` | `() → { success: true }` | Called for all three outcomes |
| `connect:intent` (push) | `ConnectIntent` | Main → renderer, sent by `flush()` after `focusMainWindow()` |

## Services & Key Methods

`normalizeServerOrigin(raw)` → `{ ok: true, origin }` or `{ ok: false, reason }`. The reason is a **log** string, never shown: a refused link has no UI. Checks in order — non-empty, ≤ `MAX_URL_LENGTH`, parses as a URL, no `username`/`password`, has a `hostname`, `http:` only for a `LOOPBACK_HOSTS` member and otherwise `https:`. Returns `url.origin`.

`parseConnectUrl(raw)` → `ConnectIntent | null`. Length guard, `URL` parse, `protocol === 'cinna:'`, then the action from `url.hostname || url.pathname.replace(/^\/+/, '').split('/')[0]`, lowercased, compared to `'connect'`. Then `searchParams.get('server')` through `normalizeServerOrigin`. Every rejection logs at warn and returns null.

`connectUrlFromArgv(argv)` → the first argument starting with `CONNECT_INTENT_ARGV_FLAG` (its value) or with `cinna://` (itself), else null.

`connectIntentService.deliver(rawUrl, source)` — parse; null → return null. Otherwise log at **info** with `{ source, serverUrl }` (the host is not a secret and the intent carries nothing else), set `pending`, and either hold (when `isCinnaOAuthInProgress()`) or `flush()`.

`flush()` — no-op without a pending intent, during an OAuth flow, or with no live window. Otherwise `focusMainWindow()` then `win.webContents.send(CONNECT_INTENT_CHANNEL, pending)`.

`registerConnectScheme()` — `process.defaultApp && process.argv.length >= 2` → `setAsDefaultProtocolClient(scheme, process.execPath, [resolve(process.argv[1])])`, else the one-argument form. Wrapped in try/catch; a falsy return is a warn.

`focusMainWindow()` — restore if minimized, `show()`, `focus()`, then `app.focus({ steal: true })` on darwin and `app.focus()` elsewhere. **Never throws**: a failure to focus is cosmetic and must not take down the flow that asked for it. The window getter is *installed* by `index.ts` rather than imported from it, because importing the app entry from a service pulls the whole startup graph into anything that touches focus, unit tests included.

## Renderer Components

| Component / hook | Renders / manages |
|---|---|
| `useConnectIntentStore` | One intent for the whole renderer. A store rather than a hook's own state because two very different surfaces read the same value and exactly one must show; two independent subscriptions would race to render two confirmations of the same link. `subscribed` is set **before** the first `await` so StrictMode's double-invoked mount effect cannot register two IPC listeners. A push that lands while `getPending()` is in flight wins, because it is newer |
| `useConnectIntent()` | Subscribes on mount and stays subscribed for the app's lifetime |
| `ConnectIntentPanel` | Three states: the question, the OAuth waiting view (with Cancel → `auth:cinna-oauth-abort`), and inline errors. `existing` is found by comparing `cinnaServerUrl` to `intent.serverUrl` with trailing slashes stripped from both |
| `ConnectIntentModal` | Escape and backdrop click both `consume()`. No mid-flight lock-out — the panel takes over its own surface once the browser round trip starts |
| `OnboardingScreen` | `useState<Step>(connectIntent ? 'cinna-confirm' : 'welcome')`, plus a `lastIntentAt` ref so only an intent with a *new* `receivedAt` re-enters the step |
| `OnboardingGate` | Calls `useConnectIntent()` and passes `intent` / `consume` down. The modal below it reads the same store |

## Configuration

| Where | What |
|---|---|
| `electron-builder.yml` → `protocols:` | Registers `cinna` in the built bundle (macOS `CFBundleURLTypes`, Linux `.desktop` `MimeType`) |
| `CINNA_USER_DATA` env var | Set by the E2E harness. Its presence **skips** scheme registration |
| `CONNECT_INTENT_ARGV_FLAG` | `--cinna-connect-intent=<url>` — the test-only delivery path into the same funnel |

## Security

- **The confirm step, not the validation, is the guarantee.** Validation reduces what a link can express; the human reading the host is what decides whether it is acted on
- The payload carries **no token, path or query**, by construction: `url.origin` is a parse result, not a substring of the input
- `https` is required except for loopback, so a link cannot aim the app at a plaintext host
- Main **never opens a browser** for an intent on its own, and the preload surface exposes no method that could authorize against a link-supplied server without the panel
- An intent arriving mid-OAuth is held, so a link cannot interleave itself with a flow already in progress
- Scheme registration is a mutation of the developer's OS and is therefore skipped for the throwaway E2E profile

## Verified

`connectIntentService.test.ts` covers `normalizeServerOrigin` (including the credential, scheme and loopback rules), both action spellings, a URL-encoded `server` parameter, the argv scan in both forms and with no link at all, and the buffer's four properties: an accepted intent is buffered for a renderer that is not there yet, a refused one is not, a second intent **replaces** rather than queues, and the buffer survives until `consume()`.

Not covered by a unit test: the OS hooks themselves (`open-url`, `second-instance`, the single-instance lock), scheme registration, and `focusMainWindow`. The argv flag exists so the E2E suite can drive everything below the OS hook against the built app.
