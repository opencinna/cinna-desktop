# Cinna Token Lifecycle — Technical Details

## File Locations

### Main Process

| Layer | File | Purpose |
|-------|------|---------|
| Tokens | `src/main/auth/cinna-tokens.ts` | `getCinnaAccessToken` (expiry check, session-scoped dedup, rotation store), `storeCinnaTokens`, `clearCinnaTokens`, `decodeAccessTokenSubject` |
| Session identity | `src/main/auth/cinna-session.ts` | Process-local per-user credential-replacement generation; read by refresh and shared HTTP transport |
| OAuth | `src/main/auth/cinna-oauth.ts` | `refreshCinnaTokens` — POST `grant_type=refresh_token`; maps 400/401 (`error` or FastAPI `detail`) to `CinnaReauthRequired` |
| Sync service | `src/main/services/syncService.ts` | Owns the periodic + inbox timers and the suspend/resume hook (`setSystemSuspended`) |
| API client | `src/main/services/cinnaApiService.ts` | `cinnaApiFetch` — shared Bearer wrapper; calls `getCinnaAccessToken` on every request, so all sync/inbox traffic is a potential refresh trigger |
| Power wiring | `src/main/index.ts` | `powerMonitor.on('suspend'|'resume', …)` → `syncService.setSystemSuspended()` in the post-`whenReady` `startup()` |
| Keystore | `src/main/security/keystore.ts` | `encryptApiKey`/`decryptApiKey` around the stored token pair |

### Renderer

| Layer | File | Purpose |
|-------|------|---------|
| Hook | `src/renderer/src/hooks/useCinnaRunPoll.ts` | Foreground-only 5 s poll of in-flight `cinna_task` runs; pauses on `document.hidden`, immediate catch-up tick on re-show |
| Hook | `src/renderer/src/hooks/useCinna.ts` | `useRefreshCinnaRun` mutation the poll calls per pending run id |

## Refresh Dedup Mutex

`src/main/auth/cinna-tokens.ts`

- `refreshInProgress` is keyed by userId and stores `{ generation, state, promise }`. A caller joins only when its generation and captured server URL, client id and encrypted refresh-token bytes match. A prior user-only promise could return an old login’s result after credentials were replaced; a global promise could cross accounts entirely
- `getCinnaAccessToken(userId)` flow:
  1. Load token state and session generation; throw `CinnaReauthRequired` if no tokens stored
  2. `needsRefresh = Date.now() > expiresAt - 60_000` — return decrypted access token early when false
  3. Join `refreshInProgress.get(userId)` only if its generation and session state still match
  4. Otherwise register a new captured-session refresh; its `finally` removes the entry only if the entry still owns that promise, so an old refresh cannot remove a replacement’s mutex
- The refresh body is wrapped in `Promise.resolve().then(async () => …)` so the `refreshInProgress.set` always runs before the body's `finally`. Without the microtask defer, a **synchronous** throw in the body (e.g. `decryptApiKey` on a corrupt blob / unavailable keychain) would run `finally`'s `delete` before the entry was ever set, leaving a permanently-rejected promise that poisons every later caller for that user
- Recheck generation and session state before the deferred body starts and after the OAuth request resolves. A stale refresh rejects with `CinnaSessionChanged` without persisting its response; even an old session’s revocation is normalized to that retryable operation error. On terminal rejection, clear tokens only when that captured session is still current; a revoked old login must not clear a new one. Other errors (network/5xx) propagate without clearing tokens.
- `storeCinnaTokens` is a credential replacement and increments the per-user generation before writing. `clearCinnaTokens` increments it before clearing. Successful silent rotation calls private `persistTokens` instead, keeping the generation stable so ordinary callers waiting for a refreshed token remain valid. The generation is process-local and is not the active-profile generation or an authentication credential.

## HTTP Credential Preparation Guard

`cinnaApiService.cinnaFetch` captures the normalized server base URL and `cinnaSessionGeneration(userId)` before awaiting the bearer token. It resolves the base again and compares both after the await, before constructing and dispatching the HTTP request. A replaced login or changed server rejects with `CinnaSessionChanged` and makes no fetch; normal token rotation keeps the session generation and proceeds. This prevents combining a captured old server with newly replaced credentials, including on task mutations. `CinnaSessionChanged` is an ordinary Error, not `CinnaReauthRequired` or a `reauth_required` code: `ipcHandle` must not broadcast a new sign-in request for healthy replacement credentials. Genuine expiry still follows the re-auth broadcast path. This guard does not cancel a request already dispatched or replace the task coordinator’s response-generation guards.

Tests: `src/main/auth/cinna-tokens.test.ts` covers same-session coalescing/rotation, replacement success/revocation, replacement mutex ownership and replacement before deferred refresh begins. `src/main/services/cinnaApiService.http.test.ts` checks that a changed generation or server during token resolution dispatches no HTTP request, and exercises the actual `ipcHandle` wrapper to distinguish stale-operation errors from genuine expiry notifications.

## Suspend / Resume Timer Management

`src/main/services/syncService.ts`

### State

| Symbol | Type | Purpose |
|--------|------|---------|
| `periodicTimers` | `Map<string, NodeJS.Timeout>` | The **live** per-profile 60 s sync timers (`PERIODIC_MS`) |
| `periodicArmed` | `Set<string>` | Source of truth for which profiles *should* poll — independent of whether a live timer currently exists. Survives suspend so resume re-arms with no lost intent |
| `systemSuspended` | `boolean` | True between `suspend` and `resume`; while set, no authed timer may start |
| `inboxPollTimer` | `NodeJS.Timeout \| null` | The focus-gated 5 s pairing-inbox poll (`INBOX_POLL_MS`) |
| `windowFocused` | `boolean` | Last focus state from `setWindowFocused`; lets `resume` restart inbox polling without waiting for an OS focus event (which may not re-fire on wake) |

### Timer helpers

- `startPeriodicTimer(userId)` — creates the live interval; early-returns if `systemSuspended` or a timer already exists; `unref()`s it
- `stopPeriodicTimer(userId)` — clears + deletes the live timer, **leaves `periodicArmed` intact**
- `armPeriodic(userId)` — adds to `periodicArmed`, then `startPeriodicTimer` (called from `ensureActivated`)
- `disarmPeriodic(userId)` — removes from `periodicArmed` + stops the timer (called from device revoke / teardown)
- `startInboxPolling()` — early-returns if `systemSuspended`; otherwise fires one immediate `pollInboxOnce` then sets the 5 s interval
- `stopInboxPolling()` — clears the inbox timer

### `setSystemSuspended(suspended)`

- Guard `if (suspended === systemSuspended) return` makes coalesced/repeated OS signals no-ops (idempotent)
- **Suspend**: set the flag, `stopPeriodicTimer` for every `periodicArmed` profile, `stopInboxPolling()`
- **Resume**: clear the flag, then for every `periodicArmed` profile `startPeriodicTimer` + one immediate `runCycleNow` catch-up; `startInboxPolling()` only if `windowFocused`
- `teardownAll()` also clears `periodicArmed` alongside the timer maps

### Power wiring — `src/main/index.ts`

- `powerMonitor.on('suspend', () => syncService.setSystemSuspended(true))`
- `powerMonitor.on('resume', () => syncService.setSystemSuspended(false))`
- Registered inside `startup()` (after `app.whenReady`) — `powerMonitor` is unavailable before the app is ready

## Renderer Foreground-Only Polling

`src/renderer/src/hooks/useCinnaRunPoll.ts`

- `POLL_INTERVAL_MS = 5_000` — single tier. The former `ACTIVE_INTERVAL_MS` (5 s) / `BACKGROUND_INTERVAL_MS` (10 s) split was removed: a background tier could start a refresh just as the machine slept
- `tick()` — if no non-terminal runs remain, `stop()`; otherwise `refresh.mutate({ runId })` for each pending id
- `start()` — guards against double-start; calls `tick()` immediately (catch-up on regaining visibility) then `setInterval(tick, POLL_INTERVAL_MS)`
- `handleVisibility()` — `document.hidden ? stop() : start()`; the effect only `start()`s initially when `!document.hidden`
- Listens on `visibilitychange`; cleans up the listener + interval on unmount or when the pending-id set empties

## Authed Paths That Trigger a Refresh

Every path below calls `getCinnaAccessToken` (directly or via `cinnaApiFetch`) and is therefore an orphan risk the suspend safeguard covers:

| Path | Entry | Cadence |
|------|-------|---------|
| Periodic sync cycle | `runCycleNow` → `resolveSubject`/`runSyncCycle` | 60 s per profile (`PERIODIC_MS`) |
| Pairing inbox poll | `pollInboxOnce` → `syncApi.pairingInbox` → `cinnaApiFetch` | 5 s while focused (`INBOX_POLL_MS`) |
| Any Cinna API call | `cinnaApiService.cinnaApiFetch` | On demand |

## Security

- Access + refresh tokens encrypted via `safeStorage` at rest (see [Cinna Accounts tech](./cinna_accounts_tech.md))
- Refresh tokens are single-use; rotation overwrites the stored pair atomically via private `persistTokens`; login/re-auth storage uses `storeCinnaTokens` to invalidate old-session callers
- Per-user, captured-session dedup mutex prevents a concurrent refresh from presenting a just-rotated-away token and self-triggering server-side replay revocation
- The `sub` claim read by `decodeAccessTokenSubject` is used only as an identifier (E2E crypto identity), never as a trust decision — signature intentionally unverified; the backend remains the sole authority on token validity
