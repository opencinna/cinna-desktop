# Data Sync — Device Lifecycle & State Machine

> Aspect of [Native Client Data Sync](data_sync.md). The main doc describes the
> user **flows** (enable, pair, recover, sign-out); this one is the **state**
> lens — what state a device is in, how it moves, and how a device recovers from
> the failure states. Implementation lives in [data_sync_tech.md](data_sync_tech.md)
> (`syncService.ensureActivated` / `tryAutoUnlock` / `wipe` / `buildStateDto`).

## Purpose

Make the device's sync state explicit so an agent can answer "what state is this
device in, what can it do, and how does it move to the next state" without
tracing the code — including the reset/reconcile paths added to escape the
"stuck, can't re-enable" wedge.

## Core Concepts

- **Init state** — whether the *account* has E2E set up at all (`active_umk_version > 0` server-side). Account-scoped, shared by every device.
- **Locked / unlocked** — whether *this device* currently holds the plaintext UMK in memory (`umkVault`). Device-scoped.
- **Trusted device** — this device has a `device` key envelope on the server, so it can auto-unlock silently. A device can be *un*trusted while the account is still initialized (its envelope was revoked / never registered / deleted by a reset elsewhere).
- **Paused** — a session-scoped flag (`pausedUserIds`) suppressing the silent auto-unlock until the user resumes. Cleared on relaunch / profile switch / reset.
- **Source of truth** — `/encryption` (`get_encryption_state`) is authoritative for init state when reachable; the local `sync_state` flag is only a cache (and may be stale).

## Device states

| State | `initialized` | `locked` | UI (Cloud Sync card) | Can sync? | Leaves via |
|-------|:---:|:---:|------|:---:|------|
| **Not initialized** | false | — | **Enable** | no | `init` (first device) |
| **Active** | true | false | **Active** | yes | pause, sign-out, reset |
| **Paused** | true | locked | **Paused** → *Resume* | no | resume (device unlock), reset |
| **Locked — trusted** | true | true | (auto-unlocks on activation) | not yet | silent device auto-unlock → Active |
| **Locked — untrusted** | true | true | **Restore your data** (recovery / passphrase / pair) | no | restore, or reset |
| **Reset (transient)** | → false | — | returns to **Enable** | no | — |

The UI pill is purely derived: `!initialized` → Enable, else `locked` → (`paused` ? **Paused** : **Locked**), else Active. `SyncState.paused` is `locked && pausedUserIds.has(userId)` — true only for an explicit user pause on a **trusted** device (Resume = device-unlock works), false for any other locked state (a new/wiped/untrusted device, e.g. the account was reset + re-initialized on a peer). The locked-action controls follow suit: `paused` → **Resume sync** (+ recovery/passphrase); otherwise → **Pair with another device** (+ recovery/passphrase) — never a dead "Resume" that can only fail "not trusted".

## Transitions

- **Enable** (`init`) — Not initialized → Active. Generates the UMK + `device`/`recovery` envelopes, forces the one-time recovery backup, pushes existing local data.
- **Silent auto-unlock** (`ensureActivated` → `tryAutoUnlock`) — Locked-trusted → Active, on each launch/activation, using the `device` envelope. Skipped while paused.
- **Restore** (`unlock` via recovery / passphrase / pairing) — Locked-untrusted → Active; registers a fresh `device` envelope so future launches auto-unlock. The login-time `SyncSetupModal` drives this for new/wiped devices.
- **Pause / Resume** (`lock` / `unlock`) — Active ↔ Paused. Pause zeroes the in-memory UMK and sets the session pause flag; Resume is a `device` unlock (fails "not trusted" if the device has no envelope — recovery/passphrase are the fallback).
- **Disconnect online sync** (`disconnect`) — **per-device, not account-wide**: revokes THIS device server-side (`revokeDevice` — only its envelope/row) and tears down local enrollment, setting a persistent `disconnected` flag in `sync_state`. The account stays initialized and every OTHER device keeps syncing. No data deleted anywhere. The device stays Off (no auto-reconcile/nag) until **Connect**. It does **NOT** call `resetEncryption` (account-wide) or the record-wipe (`DELETE /`, tombstones → hard local deletes).
- **Connect** (`reconnect`) — discards any hard-delete tombstones queued while disconnected (so deletes made on the off device don't replay onto peers — the bootstrap pull re-materializes the server's copies), clears the `disconnected` flag, and re-runs activation → **Locked → pair/restore** (account still initialized; a fresh device key must re-enroll) or **Enable** (account no longer initialized).
- **Enable on an already-initialized account** (`initEncryption`) — if the server reports the account already set up (e.g. enabled on another device while this one's local flag lagged), init does **not** mint a second UMK generation; it reconciles to a locked state, broadcasts `needs-unlock`, and throws a friendly "already set up — pair or restore" so the card flips to **Locked** + pairing. Guarded both by a pre-check and a fallback around the server `init` 409.
- **Sign-out** (`signOutCleanup`) — Active → Locked (or fully removed). With "remove device": revoke + drop local keypair/state → next login is Locked-untrusted (must restore). Without: stays trusted → next login auto-unlocks.

## Server-authoritative reconcile (`ensureActivated`)

On activation a **locked** profile fetches `/encryption` and reconciles the local
`sync_state` against it in **both** directions:

- **Behind the server** (server initialized, local not — e.g. a crash lost the local flag) → adopt the server's `active_umk_version` and attempt silent auto-unlock, so a trusted device still ends up Active instead of stuck Locked.
- **Ahead of the server** (server reports *not* initialized — a reset done here or on a peer) → the account was reset; drop stale local enrollment via `forgetLocalEnrollment` (zero UMK, delete device key + `sync_state` + tombstones, clear cached subject + pause flag) and broadcast `needs-setup` → the card flips to **Enable**.

`buildStateDto` trusts `enc.initialized` when reachable (never OR-ing the stale
local flag); offline, it falls back to the last-known local flag.

## Failure modes & recovery

- **Locked-untrusted (account reset + re-initialized on a peer)** — the device shows initialized+locked but has no matching `device` envelope (its key belongs to the old, wiped account generation). Because the server is *still* initialized (the peer re-enabled), the reconcile-down can't flip it to **Enable**. The card now reports **Locked** (not "Paused") and offers **Pair with another device** / **Recovery key** / **Passphrase** directly — pairing as the joiner (the active peer auto-discovers the request) is the one-tap path back. ("Resume sync" is shown only for a genuine user **Pause** on a trusted device, where device-unlock actually works.) **Reset** is still offered even while locked so the state is never a dead end.
- **Reset that doesn't take** — `wipe` runs `resetEncryption` **first** and re-throws on failure (logged + surfaced in the Danger-zone card) instead of tearing down locally; this prevents a failed server reset from masquerading as success and looping straight back to "Paused".
- **Undecryptable pulled records** — skipped (not fatal) and tallied; a fully-undecryptable page logs an error (systemic identity/UMK mismatch). See [crypto_llm.md](crypto_llm.md).
- **Locked↔unlocked flapping (fixed)** — two feedback bugs could oscillate the pill. (1) `umkVault.setUmk` routed through the async `lock()`, whose deferred `vault.delete(userId)` could land *after* the new entry was set and wipe it (the unlock would silently drop under concurrent `get-state`/`sync-now` auto-unlocks). `setUmk` now swaps the map entry synchronously and memzeros only the replaced bytes. (2) `tryAutoUnlock` runs inside `getState`→`ensureActivated`, and emitting `needs-unlock`/`needs-setup` there made `useSyncEvents` **invalidate** the sync-state query → re-`getState` → re-emit (a tight refetch loop). It now surfaces state via `pushState` (a `state` event the renderer applies without a refetch).
- **"Enable" on an already-initialized account** — `initEncryption` checks the **server** state first (authoritative); if already initialized it reconciles to locked, `pushState`s so the card flips to **Locked + pair/restore**, and throws a guiding message — instead of the old local-flag guard that threw "already initialized" *before* any reconcile, leaving the view stuck on Enable.

## Integration Points

- [Cinna Accounts](../../auth/cinna_accounts/cinna_accounts.md) — a 401/403 during activation pauses sync and defers to the global reauth modal; `resolveSubject` can raise `CinnaReauthRequired` before any sync call.
- [Settings](../../ui/settings/settings.md) — `CloudSyncSettingsSection` renders the state machine (Enable / Active / Paused / restore controls / Danger-zone reset); the login-time `SyncSetupModal` renders the first-touch enable/restore decision.
