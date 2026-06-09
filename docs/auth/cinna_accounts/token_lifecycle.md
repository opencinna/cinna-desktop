# Cinna Token Lifecycle

## Purpose

Describes how a Cinna account's OAuth access/refresh tokens are kept valid between login and re-auth: silent refresh near expiry, refresh-token rotation, and the safeguards that stop an interrupted refresh from cascading into an avoidable "session expired" self-logout. This is the layer *between* [Cinna Accounts](./cinna_accounts.md) (getting the first tokens) and [Re-authentication](./reauthentication.md) (recovering after the tokens are truly dead).

## Core Concepts

| Term | Definition |
|------|-----------|
| **Access token** | Short-lived bearer JWT sent on every Cinna server call. Carries the backend user id in its `sub` claim (used as the E2E crypto identity — see [Data Sync](../../sync/data_sync/data_sync.md)) |
| **Refresh token** | Longer-lived credential used solely to mint a new access token. **Single-use**: the server rotates it on every refresh |
| **Rotation** | On each successful refresh the server returns a *new* refresh token and invalidates the one just used. The desktop must persist the new pair atomically |
| **Replay / reuse detection** | If a refresh token that was already rotated away is presented again, the server treats it as a stolen-token replay and revokes the whole token family → the only recovery is full re-auth |
| **Orphaned refresh** | A refresh round-trip that the server completed (old token now dead, new token minted) but whose response the desktop never stored — e.g. the OS suspended the process mid-`fetch`. The desktop is left holding the now-dead old token |
| **Rotation-replay self-logout** | The failure mode an orphaned refresh causes: on the next refresh the desktop re-presents the dead old token, the server flags replay, and the user is logged out despite never doing anything wrong |
| **Refresh dedup mutex** | Per-user in-flight promise so N concurrent callers needing a refresh trigger exactly one network round-trip and all await the same result — without it, the second caller would present the just-rotated-away token and self-trigger replay |
| **Periodic sync timer** | Per-profile 60 s interval that runs a background sync cycle; each cycle is authed and may trigger a refresh |
| **Inbox poll timer** | Focus-gated 5 s interval that checks for incoming device-pairing requests; also authed, also a refresh trigger |
| **System-suspended state** | True between the OS `suspend` and `resume` power events. While set, no authed background timer is allowed to start |

## How It Works / Flows

### Silent refresh near expiry
1. Any Cinna server call resolves its bearer via `getCinnaAccessToken(userId)`
2. If the stored access token is **more than 60 s** from expiry, it is returned as-is
3. If it is within 60 s of expiry (or expired), a refresh is triggered before the call proceeds
4. The server returns a rotated access + refresh pair; both are encrypted and stored, replacing the old pair
5. The fresh access token is returned to the caller

### Concurrent-refresh dedup (per account)
1. Two background cycles for the **same** account both find the token near expiry at the same moment
2. The first to arrive creates the refresh promise and registers it under that account's id
3. The second sees an in-flight refresh **for that account** and awaits the same promise instead of starting its own
4. One network round-trip happens; both callers receive the same rotated access token. The in-flight entry is cleared when it settles
5. Refreshes for *different* accounts never share a promise — account B can never receive account A's token

### OS sleep / wake (orphan prevention)
1. The OS is about to suspend the machine and emits a `suspend` power event
2. The app tears down **every authed background timer** — all periodic sync timers and the inbox poll — so no refresh can be *started* in the moments before the process freezes
3. The set of profiles that *should* be polling is remembered separately, so the teardown loses no intent
4. On `resume`, each remembered profile's periodic timer is re-armed and fired once immediately as a catch-up; the inbox poll is restarted only if the window is still focused
5. Net effect: the desktop does not initiate a refresh that the OS would freeze mid-flight and orphan

### Foreground-only run polling (renderer)
1. The chat UI polls in-flight Cinna task runs every 5 s **only while the window is visible**
2. When the window is hidden the poll pauses entirely (no background tier); on becoming visible again it fires one immediate catch-up tick, then resumes the 5 s cadence
3. This mirrors the suspend safeguard from the renderer side — a hidden/backgrounded window can't kick off a poll-driven refresh just as the machine sleeps

### When a refresh genuinely fails
1. A refresh that returns `invalid_grant` / reuse-detected / unauthorized throws `CinnaReauthRequired`
2. All stored tokens for that account are cleared
3. The user is routed into the in-place re-auth flow — no local data is touched. See [Re-authentication](./reauthentication.md)

## Business Rules

- Refresh fires when the access token is within **60 s** of expiry — never lazily after a 401 only
- Refresh tokens are **single-use**; the rotated pair must always overwrite the previous pair, never append
- Concurrent refreshes are deduplicated **per account** (keyed by userId). A global dedup would be a cross-account token-bleed bug — account B could receive account A's access token
- A refresh rejected with replay/`invalid_grant`/unauthorized is terminal: clear all tokens and require full re-auth. Any *other* error (network, 5xx) is transient — tokens are left intact for a later retry
- No authed background timer (periodic sync **or** inbox poll) may start while the system is suspended. Both route through `getCinnaAccessToken` and so are equal orphan risks
- Suspend/resume handling is idempotent — coalesced or repeated OS signals are no-ops past the first transition
- **Residual**: a refresh already past its network call at the instant `suspend` fires cannot be aborted. The safeguard prevents *starting* new autonomous refreshes; it does not abort one already in flight. The dedup mutex and the "transient errors don't clear tokens" rule keep this residual from escalating where possible
- Renderer run-polling has a single 5 s foreground tier only — the former 10 s background tier was removed because it could start a refresh just as the machine slept

## Architecture Overview

```
Refresh (deduped, per account):
  caller A ─┐
            ├─→ getCinnaAccessToken(userId)
  caller B ─┘     near expiry? ── no ──→ return stored access token
                       │ yes
                       ├─ in-flight refresh for THIS userId? ── yes ──→ await it
                       │ no
                       └─ refreshCinnaTokens() ──→ POST /oauth/token (grant_type=refresh_token)
                          store rotated pair (overwrite)        │
                          return new access token        replay? → CinnaReauthRequired → clear tokens

OS power events (main):
  powerMonitor 'suspend' ─→ syncService.setSystemSuspended(true)
                              stop all periodic timers + inbox poll   (leave "armed" set intact)
  powerMonitor 'resume'  ─→ syncService.setSystemSuspended(false)
                              re-arm each armed profile + 1 catch-up cycle
                              restart inbox poll iff window focused

Window visibility (renderer):
  document visible   ─→ poll in-flight runs every 5s (+ immediate catch-up tick)
  document hidden    ─→ pause polling entirely
```

## Integration Points

- **[Cinna Accounts](./cinna_accounts.md)** — Parent feature. Establishes the first token pair via OAuth; this aspect governs everything after, until tokens die
- **[Re-authentication](./reauthentication.md)** — The recovery path once a refresh terminally fails and tokens are cleared
- **[Data Sync](../../sync/data_sync/data_sync.md)** — Owns the periodic sync + inbox poll timers that this aspect pauses around suspend; the access token's `sub` claim is the sync crypto identity
- **[Cinna Task View](../../jobs/cinna_task_view/cinna_task_view.md)** — Hosts the renderer run-poll loop that this aspect made foreground-only
- **[Boot Resilience](../../core/boot_resilience/boot_resilience.md)** — `powerMonitor` is only available after the app is ready; suspend/resume wiring lives in the post-ready startup path
