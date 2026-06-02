# Native Client Data Sync

## Purpose

Cross-device, end-to-end-encrypted sync of profile data (Phase 1: notes, note folders, jobs, job folders) through the Cinna backend. The server is a zero-knowledge opaque store — it holds only ciphertext and can never read user data.

## Core Concepts

- **UMK (User Master Key)** — a 256-bit random key generated once on the first device. All payloads are encrypted under keys derived from it. Held only in main-process memory after unlock; never persisted in plaintext, never crosses the contextBridge.
- **Unlock method** — a way to recover the UMK on a device. Three exist: `device` (silent, per-install keypair), `recovery` (24-word BIP39 phrase), `passphrase` (optional, user-chosen). Each is an independent wrapped copy of the UMK stored server-side.
- **Collection** — a synced entity type. Phase 1: `note`, `note_folder`, `job`, `job_folder`.
- **`client_entity_id`** — the sync identity of a row. It is the entity's existing `nanoid` primary key, used verbatim — there is no separate sync id or mapping layer.
- **Tombstone** — a local record of a hard-deleted row, emitted so the delete propagates to other devices (the row itself is gone, so its absence isn't enough).
- **Cursor** — a per-profile integer marking how far this device has pulled from the server's change log.
- **Trusted device** — a device with a registered `device` unlock envelope; it can decrypt and sync silently and appears in the device list.
- **Pairing** — onboarding a new device by sealing the UMK to it directly (QR / code + Short Authentication String), without exposing the recovery key.
- **SAS (Short Authentication String)** — a 6-digit code derived from the joining device's key, compared out-of-band by the user to defeat a server-substituted key during pairing.

## User Stories / Flows

### Enable sync (first device)
1. User opens Settings → Profile → Cloud Sync and clicks **Enable**.
2. A UMK is generated; `device` + `recovery` unlock envelopes are uploaded.
3. The recovery key (24 words + QR + downloadable `.txt`) is shown **once** on a forced-backup screen. The user must confirm "I saved it" to continue.
4. Existing local notes/jobs/folders are encrypted and pushed.

### Add a second device (pairing)
Pairing roles are fixed by who holds the key: the **joiner** (new device, lacks the UMK) shows a code; the **sealer** (an unlocked device that has the UMK) seals the key to it. The two halves therefore live on different surfaces.
1. On the new (signed-in but locked) device, the login-time `SyncSetupModal` restore prompt → **Pair with another device** shows a QR + code + verification number (SAS). *(This is the only pairing-code surface — the Settings card never shows a code, because an already-unlocked device has nothing to join.)*
2. On an existing unlocked device, Settings → Cloud Sync → **Add a device**: the user pastes that code and clicks **Authorize device**; its own verification number appears.
3. User confirms the two verification numbers match, defeating any key substitution.
4. The new device receives the sealed UMK, registers its own `device` envelope, and hydrates all data.

### Recover on a new device (no trusted device)
1. User signs in, opens Cloud Sync, and chooses **Recovery key** (or **Passphrase**).
2. They enter the phrase/passphrase; the UMK is unwrapped, a `device` envelope is registered for silent future unlocks, and data hydrates.

### Login-time setup prompt (seamless onboarding)
On sign-in to a Cinna profile, a single app-level modal (`SyncSetupModal`, beside `ReauthModal`) evaluates the sync state **once per profile per session** by calling `sync.getState()` (which drives activation + the silent device-key auto-unlock first) and picks one outcome:
- **Not initialized** → "Enable data sync between devices" prompt with a toggle that is **ON by default**. Confirming runs first-device `init` and then forces the one-time recovery-key backup.
- **Initialized but locked** (new/wiped device, or one signed out with "remove device") → "Restore your data" prompt offering pairing / recovery key / passphrase inline. The data cannot return silently — the server is zero-knowledge.
- **Initialized and already unlocked** (trusted device auto-unlocked on activation) → no modal; data re-syncs on its own.

### Sign-out & device retention
There is no separate non-destructive sign-out — the profile menu's sign-out IS the entry point, but for Cinna profiles it is **reshaped to be non-destructive**:
1. The warning makes explicit that **chats and job runs are deleted no matter what** (they aren't synced), while **notes/jobs/folders are synced and return on next sign-in**.
2. A switch **"Remove this device from my account"** (ON by default) decides device retention:
   - **On (default)** → the device is revoked server-side and the local sync keypair + state are dropped, so the next sign-in must restore via recovery key/pairing (`SyncSetupModal` restore prompt).
   - **Off** → the device stays trusted; the next sign-in auto-unlocks and re-syncs everything automatically.
3. Before any local wipe, a **final sync cycle is flushed** (while the UMK is still in memory) so edits made inside the debounce window reach the server.
4. The Cinna **profile row is kept** (tokens cleared) so re-login rebinds to it; `registerCinna` reuses the existing profile for a returning Cinna identity instead of minting a new local id (which would orphan the kept device key + synced data). Local (non-Cinna) profiles keep the original fully destructive delete.

`authService.deleteAccount` carries a `signOut` flag that splits two intents on the same primitive:
- **Sign out** (`signOut: true`, from the profile menu) → non-destructive: `syncService.signOutCleanup({removeDevice})` + `userRepo.wipeProfileData` (raw deletes, **no tombstones** — a local wipe never propagates as a server-side delete; cursor reset to re-pull on next login), then the **row is kept** (tokens cleared) for rebind.
- **Delete account** (`signOut` absent, from Settings → User Accounts) → fully destructive: always `removeDevice` (revoke server-side + drop local sync keys, runs even for a non-active profile), then `userRepo.deleteWithCascade` removes the row and all profile-scoped tables. Server-side synced ciphertext is left intact (recoverable by re-linking the account).

### Steady-state sync
1. Any local mutation to a synced entity marks the profile dirty.
2. After a short debounce (plus a periodic timer and post-login bootstrap), the engine pushes changed rows + tombstones and pulls peer changes.
3. The UI reflects status (idle / syncing / offline / error), last-sync time, storage usage, and trusted devices.

### Manage / wind down
- **Pause sync** clears the in-memory UMK (the underlying `lock` op) and flags the profile as paused so the per-launch silent auto-unlock won't immediately re-resume it (otherwise the next `getState` would re-unlock and the UI would flap). The pause flag is **session-scoped** (in-memory `pausedUserIds`, cleared on resume / profile switch) — a relaunch auto-unlocks as usual. On a trusted device **Resume sync** silently re-unlocks via the device key (recovery key / passphrase remain as fallbacks for an untrusted device). The "Active"/"Paused" pill reflects the state.
- **Revoke** removes another device's trust.
- **Delete synced data** wipes all ciphertext from the server (local copies are kept).

## Business Rules

- **Cinna profiles only** — sync runs exclusively for `cinna_user` profiles. Default/guest profiles never sync. All state is keyed by the active profile's user id.
- **Stable Cinna identity** — a returning Cinna account rebinds to its existing local profile row (matched by email) rather than minting a new local id; this is what keeps a "device-kept" sign-out seamless (the orphan-free device key + synced rows line up again). A name collision with a *local* account still rejects.
- **Sign-out wipes profile scope only** — the non-destructive Cinna sign-out wipes profile-scoped data (chats, job runs, notes, jobs, folders, profile agents/overrides) but keeps the user row and never touches Default-Scope resources (LLM providers, MCP servers, chat modes). Local wipes are raw (no tombstones) so they never propagate as deletes; the cursor is reset so the next login re-pulls every collection.
- **Mandatory E2E** — there is no unencrypted mode. The server only ever sees ciphertext + an opaque content fingerprint.
- **Recovery is the user's responsibility** — signing in again restores data only with a trusted device, the recovery key, or the passphrase. The account password is **not** enough. Losing all three means the data is unrecoverable, including by the operator. This is acknowledged at setup.
- **Last-writer-wins (LWW)** — concurrent edits to the same `client_entity_id` converge on the most recent `client_updated_at`; the losing device overwrites its local row when it sees the winner.
- **Soft-deletes sync as data** — a soft-deleted note/job (its `deletedAt` is set) propagates as a normal encrypted upsert with `deleted=true`. Only **hard** deletes need a tombstone.
- **Tombstones precede deletion** — every hard-delete path emits a tombstone before removing the row, or the delete would not propagate.
- **Job dependencies are portable, not id-based** — a job does **not** sync device-local `nanoid`s for its agents/MCPs/mode. It syncs a **dependency manifest** (`jobs.sync_deps`): self-describing descriptors keyed by each dependency's *portable identity* (remote agent → backend UUID; local agent → card URL; MCP → transport + normalized URL / stdio command+args; mode → name). On a peer the descriptor is resolved by identity (server-backed deps are zero-prompt on the same account), and on a miss a **disabled, not-connected** MCP/local-agent shell is auto-created in Default Scope so the dependency is never silently lost — surfaced as a "finish setup" state. A remote agent from a server this profile isn't on stays an unresolved (grey) descriptor; it never mis-binds and never disappears. The manifest is the synced truth; the `jobAgents`/`jobMcpProviders` join rows + `jobs.modeId` are the materialized resolvable subset. Because both devices serialize the *same* descriptor for the *same* logical dependency, the payload is byte-stable across a round trip (the server returns `unchanged`), so adding a dependency on one device propagates instead of mutually deleting.
- **Auto-create is Default Scope + disabled-only** — a deliberate, documented exception to "sync only touches profile scope": Default-Scope resources are shared across profiles, so creating the provider/agent once benefits every profile. Auto-created rows carry `created_by_sync = 1`, are **never auto-connected** (defense in depth against an attacker-shaped stdio `command`), and **secrets never sync** — descriptors carry connection coords + display name + env variable *key names* only, never env values or tokens.
- **Applied rows stay passive replicas** — `upsertFromSync` carries the peer's `client_updated_at` onto the row verbatim (no `new Date()` bump), so an applied copy never spuriously re-wins the next LWW round, and the push watermark is recomputed from the post-apply max so freshly-pulled rows aren't re-sent. (Hardens notes too, even though notes have no dependency problem.)
- **Identity is the nanoid** — the existing primary key is the sync identity. A `client_entity_id` is never a bare integer; the engine refuses to push one as a guard.
- **Per-profile isolation** — cursor, crypto state, and the engine are isolated per user id. Switching profiles or signing out zeroes all in-memory UMKs and clears timers.
- **Lock lifecycle** — on each launch the UMK is silently re-derived from the `device` envelope and kept in memory until lock / profile switch; it is never persisted decrypted.
- **Back-pressure** — pushes are batched (≤500 records, chunked); single payloads over 1 MiB are skipped; a full-quota response surfaces to the UI.

## Architecture Overview

```
Renderer (Cloud Sync settings)
  -> useSync hooks (React Query)
    -> window.api.sync.*  (contextBridge)
      -> sync IPC handlers
        -> syncService (orchestration: keys, unlock, pairing, lifecycle)
          -> syncEngine (cursor, push/pull, LWW apply)
            -> collection mappers <-> domain repos (notes/jobs)
            -> crypto (UMK / envelopes / fingerprint)  [keys stay here]
          -> syncApi -> Cinna backend /api/v1/app-sync*  (ciphertext only)
```

Mutation side-channel: note/job service writes call `syncService.markDirty()`, which debounces a sync cycle.

## Integration Points

- **[Cinna Accounts](../../auth/cinna_accounts/cinna_accounts.md)** — sync requires a linked Cinna profile; reuses the OAuth Bearer/`reauth_required` path. A 401/403 pauses sync and triggers the global re-auth modal.
- **[Resource Activation](../../core/resource_activation/resource_activation.md)** — sync activates on profile activation and tears down (UMK zeroed) on deactivation.
- **[Notes](../../notes/notes/notes.md)** & **[Jobs](../../jobs/jobs/jobs.md)** — the synced collections; their repos own the read/write helpers the engine calls, and their service write paths emit dirty/tombstone signals.
- **[Settings](../../ui/settings/settings.md)** — the Cloud Sync card lives under Settings → Profile, next to Connection.

## Phasing

- **Phase 1 (implemented)** — notes, note folders, jobs, job folders; crypto stack; init + recovery + pairing; push/pull engine; tombstones; Settings card.
- **Portable dependency sync (implemented)** — jobs resolve their agent/MCP/mode dependencies by portable identity instead of device-local `nanoid`; auto-create disabled setup shells on a miss; engine hygiene (no `updatedAt`-on-apply, watermark recompute); per-job dependency-status UX. See `plans/data-sync-portable-deps.md`.
- **Phase 2 (planned)** — chat pointers + cinna-task job runs.
- **Phase 3 (planned)** — raw-LLM chat message content; UMK rotation hardening; push-based "sync invalidate".

See the full plans at `plans/native-client-data-sync.md` and `plans/data-sync-portable-deps.md`.
