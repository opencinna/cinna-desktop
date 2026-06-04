# Native Client Data Sync — Technical Reference

## File Locations

### Main Process (`src/main/`)

**Sync engine & mappers (`sync/`)**
- `sync/syncEngine.ts` — `runSyncCycle(userId, subjectId, umk, version)`, `bootstrap(userId, subjectId, umk)`: cursor advance, push batch build, pull drain, LWW conflict apply, back-pressure limits. Takes both the local-profile `userId` (repo/cursor scoping) and the `subjectId` (backend user id) used **only** as the crypto AAD identity. Threads the peer's `client_updated_at` + a per-cycle `ResolveCache` into every `apply`; recomputes the push watermark from the post-apply max. `applyServerRecord` returns an `ApplyOutcome` (`applied`/`skipped`/`undecryptable`); decrypt failures are caught, skipped, and tallied into `CycleResult.decryptSkipped`, and `pullLoop` escalates to an `error` log when a whole page decrypts to nothing.
- `sync/collections.ts` — per-collection `encode`/`decode`: `COLLECTION_MAPPERS`, `MAPPERS_BY_COLLECTION`, `ApplyContext`. The job mapper emits `{modeName, deps[]}` (the portable manifest, verbatim from `jobs.sync_deps`) and on apply stores it verbatim then materializes join rows via the resolvers. All DB access delegated to domain repos.
- `sync/identity.ts` — portable-identity normalizers (`normalizeUrl`, `mcpIdentityKey`, `agentIdentityKey`, `modeKey`) + row→descriptor builders (`mcpRowToDescriptor`, `agentRowToDescriptor`). The single pinned keying module so encode + resolve agree byte-for-byte.
- `sync/resolvers.ts` — descriptor→local-id resolution on the apply path (`resolveMode/resolveRemoteAgent/resolveLocalAgent/resolveMcp`), Default-Scope disabled auto-create, per-pass `ResolveCache`, plus the list-badge index (`buildResolveIndex`/`manifestNeedsSetup`) and finder helpers (`findMcp`/`findLocalAgent`).
- `sync/manifest.ts` — `buildJobManifest()`/`rebuildJobManifest()`: derive a job's `sync_deps` manifest from current local state on a local edit (the one place descriptors are built from join rows; apply stores the wire manifest verbatim). Carries forward genuinely-unresolvable (foreign-server) remote-agent descriptors so a local edit doesn't drop them.
- `sync/umkVault.ts` — in-memory UMK store keyed by user id: `setUmk`, `getUmk`, `isUnlocked`, `lock`, `lockAll`.

**Crypto (`sync/crypto/`)**
- `crypto/sodium.ts` — single `libsodium-wrappers-sumo` loader (`getSodium()`). The **sumo** build is required: the curated default build omits `crypto_auth_hmacsha256` (HKDF + fingerprint) and `crypto_pwhash` (Argon2id passphrase KEK).
- `crypto/canonicalJson.ts` — `canonicalJson()` / `canonicalBytes()`: the one canonicalizer shared by encrypt + fingerprint.
- `crypto/umk.ts` — `generateUmk`, HKDF-SHA256 (`deriveSubkey`), `encryptPayload`/`decryptPayload` (XChaCha20-Poly1305 IETF), `contentFingerprint`.
- `crypto/deviceKey.ts` — X25519 keypair gen, `sealTo`/`sealOpen`, base64 codec (`deviceKeyCodec`).
- `crypto/envelopes.ts` — UMK wrap/unwrap per method (`buildDeviceEnvelope`/`openDeviceEnvelope`, `buildRecoveryEnvelope`/`openRecoveryEnvelope`, `buildPassphraseEnvelope`/`openPassphraseEnvelope`, `deriveKekFromPassphrase`), `KeyEnvelopeWire`.
- `crypto/recovery.ts` — BIP39 mnemonic gen/validate, `mnemonicToKek` (HKDF, no Argon2id).
- `crypto/pairing.ts` — ephemeral keypair, `encodePairingPublicKey`/`decodePairingPublicKey`, commit-then-reveal primitives (`randomNonce`, `pairingCommitment`, `computeSas`/`sasTranscript` over `pub‖nonce_J‖nonce_S`), `sealUmkForJoiner`/`openSealedUmk`. Byte-identical to mobile (`@noble`).
- `crypto/scure-bip39.d.ts` — type shim for the `@scure/bip39` english wordlist subpath.

**Services**
- `services/syncService.ts` — orchestration: `getState`, `ensureActivated`, `tryAutoUnlock`, `initEncryption`, `unlock`, `addPassphrase`, `lock`, `syncNow`, `markDirty`, pairing — joiner `startPairing`/`pollPairing` (commits `nonce_J` at start, reveals once `sealer_nonce` arrives) + sealer `beginVerify`/`confirmVerify`/`cancelVerify`/`pairingInbox` (commit-then-reveal by inbox `id`, verifies the commitment, matches the transcribed SAS before sealing), and `setWindowFocused` (P4: arms a focus-gated inbox poll — `pollInboxOnce` every 5s while a foregrounded, unlocked, initialized Cinna profile is active → emits `pairing-incoming`; deduped via `announcedPairings`), `revokeDevice`, `disconnect`/`reconnect`, `signOutCleanup`, `onProfileSwitch`. Owns the renderer broadcast (`sync:event`) and per-profile timers. `resolveSubject(userId)` decodes the access token's `sub` (via `decodeAccessTokenSubject`) into the crypto subject id, cached in an in-memory `subjectIds` map (cleared on `signOutCleanup`/`onProfileSwitch`/`disconnect`); `runCycleNow` resolves it before each cycle and passes it to `runSyncCycle`. The `runCycleNow` catch treats both a normalized `CinnaApiError('reauth_required')` and a raw `CinnaReauthRequired` (which `resolveSubject` can throw before any API call) as the quiet reauth path. `ensureActivated` reconciles a **locked** profile against `/encryption` (the init-state source of truth) in both directions: when the server reports *not* initialized (a reset here or on a peer) it calls `forgetLocalEnrollment(userId)` — zero UMK + delete device key/`sync_state`/tombstones + clear cached subject + pause flag — and broadcasts `needs-setup` so the card flips to **Enable**; `buildStateDto` likewise trusts `enc.initialized` when reachable rather than OR-ing the stale local flag. `forgetLocalEnrollment` is used by the reset-reconcile path; `disconnect` does its own (row-preserving) teardown. `lock` is surfaced as **Pause sync**: it adds the profile to an in-memory `pausedUserIds` set so `ensureActivated`/`tryAutoUnlock` won't silently re-unlock it and `runCycleNow` short-circuits (the periodic timer + "Sync now" stay quiet — no `needs-unlock` churn) (any `unlock`/pairing resumes + logs `sync.resumed`; cleared on profile switch; `lock` logs `sync.paused`). `signOutCleanup(userId, {removeDevice})` is the sign-out hook called by `authService.deleteAccount`: flushes a final cycle (active+unlocked only), resets the cursor + clears tombstones (so the upcoming local wipe stays a tombstone-free raw delete), and — when `removeDevice` — revokes the device server-side + drops the local keypair/state. `disconnect(userId)` / `reconnect(userId)` back **Disconnect online sync** as a **per-device** opt-out (NOT account-wide): `disconnect` stops timers, `revokeDevice`s THIS device server-side (best-effort — only its envelope/row; peers untouched), zeroes the UMK, drops the keypair + tombstone queue, resets the cursor, and sets a **persistent `disconnected` flag** in `sync_state` (the row is KEPT so the flag survives relaunch). It deliberately does **NOT** call `syncApi.resetEncryption` (account-wide un-init) or `syncApi.wipe` (`DELETE /` record tombstone → hard local deletes on peers) — nothing local or remote is deleted. While disconnected, `ensureActivated`/`runCycleNow` early-return and `buildStateDto` short-circuits to a `disconnected: true` "off" DTO (no server fetch), so the card shows **Connect** and the login `SyncSetupModal` skips its prompt. `disconnect` returns `{ deviceRemoved }` (false when the offline revoke couldn't complete → the card surfaces a "revoke from another device" note). `reconnect` discards tombstones queued while off (deletes made on the disconnected device don't replay onto peers), clears the flag, and re-runs `ensureActivated` → **Locked → pair/restore** (account still initialized) or **Enable**. `initEncryption` pre-checks the server: if the account is already initialized (on a peer, with the local flag lagging) it reconciles to locked + `needs-unlock` and throws "already set up — pair or restore" instead of minting a second UMK generation.
- `services/syncApi.ts` — HTTP client for `/api/v1/app-sync*`; owns the on-wire field names and maps cinna-core's raw responses to engine-facing shapes (`PushRecordWire`, `PullRecordWire`, `PushResultWire`, `EncryptionStateWire`, `SyncStateWire`, `DeviceWire`). `wipe` (`DELETE /`, record tombstone) and `resetEncryption` (`DELETE /encryption`, account-wide un-init) are both account-wide/destructive and ⚠️ **no longer called by any flow** — **Disconnect online sync** is per-device via `revokeDevice` (`DELETE /devices/{id}`).
- `services/cinnaApiService.ts` — `cinnaApiFetch()` / `getCinnaServerUrl()` exported for `syncApi` to reuse Bearer auth + `reauth_required` detection + logging; `cinnaFetch` tolerates empty response bodies.

**Database (`db/`)**
- `db/migrations/sync.ts` — `runSyncMigrations()`: creates `sync_state`, `sync_device_key`, `sync_tombstone`.
- `db/migrations/sync-deps.ts` — `runSyncDepsMigrations()`: idempotent column adds `jobs.sync_deps` (JSON manifest), `mcp_providers.created_by_sync`, `agents.created_by_sync`.
- `db/client.ts` — registers `runSyncMigrations()` then `runSyncDepsMigrations()` (after notes/jobs) in `runMigrations()`; exposes `getRawSqlite()`.
- `db/sync.ts` — `syncRepo`: bookkeeping CRUD (state, device key, tombstones) over raw SQLite. `deleteDeviceKey`/`deleteState` back the remove-device sign-out (drop the keypair + bookkeeping so init re-derives from the server and auto-unlock can no longer succeed).
- `db/users.ts` — `userRepo.wipeProfileData(userId)`: raw, tombstone-free delete of profile-scoped tables (chats, jobs, job folders, notes, note folders, profile agents/overrides) keeping the user row — backs the non-destructive Cinna sign-out. `deleteWithCascade` (full delete) also covers those collection tables. `updateCinnaProfile(id, …)` refreshes identity fields on a re-login rebind.
- `db/notes.ts` — `notesRepo` / `noteFoldersRepo` sync helpers: `listChangedSince`, `maxUpdatedAt`, `upsertFromSync`, `deleteOwned` / `deleteOwnedWithDetach`. Hard-delete paths emit tombstones.
- `db/jobs.ts` — `jobsRepo` / `jobFoldersRepo` sync helpers: same set plus `listRefs`, `setSyncDeps` (write the manifest without bumping `updatedAt`), `setRefsFromSync` (materialize resolved join rows). `upsertFromSync` carries the peer's `updatedAt` + stores `sync_deps`. Folder delete emits a tombstone.

**Auth / lifecycle**
- `auth/activation.ts` — activates sync (`ensureActivated`) for Cinna users on login; `onProfileSwitch()` (UMK zero + timer clear + subject-cache clear) on deactivate.
- `auth/cinna-tokens.ts` — `getCinnaAccessToken` (refresh-aware token read) + `decodeAccessTokenSubject(token)`: decodes the JWT `sub` claim (the backend user id) **without** signature verification — it's our own TLS-fetched, `safeStorage`-stored token, read as an identifier only. `syncService.resolveSubject` consumes both.
- `services/authService.ts` — `deleteAccount({signOut, removeDevice})` splits sign-out (non-destructive, keeps the Cinna row → `signOutCleanup` + `wipeProfileData`) from full delete (destructive, always `removeDevice` + `deleteWithCascade`); both branches run `signOutCleanup` regardless of `wasCurrent`. `registerCinna` rebinds to an existing Cinna profile (refresh tokens + `updateCinnaProfile`, reactivate) instead of minting a new local id, so a kept device key + synced data line up on re-login.
- `ipc/auth.ipc.ts` — `auth:delete-user` accepts `{userId, password?, signOut?, removeDevice?}`.
- `errors.ts` — `SyncError` / `SyncErrorCode`.

**Mutation hooks (dirty signals)**
- `services/notesService.ts` — `markDirty()` on note/folder create, update, soft-delete, restore, permanent-delete, empty-trash, reorder (notes + folders).
- `services/jobService.ts` — `markDirty()` on job/folder create, update, delete, set-agents/MCPs, reorder; also `rebuildJobManifest()` after create / mode change / set-agents / set-MCPs so `sync_deps` tracks local edits. `getDependencyStatus()` (→ `job:dep-status` IPC) resolves a job's manifest against local state for the UX; `list()` adds a `needsSetup` flag via `buildResolveIndex`/`manifestNeedsSetup`.

### Preload (`src/preload/`)
- `preload/index.ts` — `window.api.sync.*` bindings.

### Renderer (`src/renderer/src/`)
- `hooks/useSync.ts` — React Query layer: exported `SYNC_KEY`, `useSyncState`, `useSyncEvents`, `useSyncOnTabOpen`, mutations (`useSyncInit/Unlock/Lock/Now`, `useAddPassphrase`, `usePairingStart/Scan`, `useRevokeDevice`, `useSyncWipe`), `pollPairing`. `useSyncOnTabOpen(enabled)` fires `syncNow` (full push+pull cycle) whenever the sidebar opens a synced screen (`jobs`/`notes`), throttled (`VIEW_PULL_THROTTLE_MS` 8s); the main process gates it to active+unlocked Cinna profiles so it's a no-op otherwise.
- `App.tsx` (`Shell`) — mounts `useSyncEvents(isCinnaUser)` + `useSyncOnTabOpen(isCinnaUser)` **app-level** so (a) peer changes pulled by any cycle invalidate the note/job caches no matter which screen is open, and (b) opening Notes/Jobs pings the server for fresh data. `CloudSyncSettingsSection` no longer mounts `useSyncEvents` itself (Shell covers it).
- `components/sync/SyncSetupModal.tsx` — app-level login-time prompt (mounted in `App.tsx` beside `ReauthModal`). Evaluates once per profile per session via `queryClient.fetchQuery(SYNC_KEY, …)`: not-initialized → "Enable sync" (toggle ON by default → `useSyncInit` → recovery backup); initialized+locked+online → "Restore your data" (inline pairing / recovery / passphrase via the `useSync` hooks); initialized+unlocked → nothing. The pairing pane is **joiner-only**: it shows the code/QR, waits ("Waiting for your trusted device…"), then reveals the SAS (`pollPairing().sas`) with "Enter this code on your trusted device."
- `hooks/useJobs.ts` `useJobDependencyStatus(jobId)` — per-dependency resolution status (`job:dep-status`), nested under `['jobs', jobId]` so job edits / sync apply refresh it. `components/jobs/JobDetail.tsx` renders the amber/grey "finish setup on this device" surface; `components/jobs/JobItem.tsx` shows a sidebar badge from `JobData.needsSetup`.
- `components/settings/CloudSyncSettingsSection.tsx` — the Cloud Sync card and its sub-components (unlock controls, pairing **sealer** only, devices, storage, danger zone, recovery-backup screen). The sealer **`PairingCard`** is now discovery-driven: `usePairingInbox(true)` lists auto-discovered incoming requests (no paste-a-code entry); each `IncomingPairingRow` runs `beginVerify` ("Establishing secure channel…") → prompts for the new device's 6-digit code → `confirmVerify` (mismatch → inline error, no seal). The **joiner** half (show pairing code + poll → SAS) lives in `SyncSetupModal`, on the device that lacks the key.
- `components/settings/SettingsPage.tsx` — renders the `profile-sync` tab.
- `components/layout/Sidebar.tsx` — `profile-sync` nav item ("Cloud Sync").
- `stores/ui.store.ts` — `SettingsMenu` union + `PROFILE_SCOPE_TABS` include `profile-sync`.

### Shared (`src/shared/`)
- `shared/sync.ts` — cross-bridge types: `SyncState` (incl. `paused` = explicit user-pause on a trusted device, and `disconnected` = this device opted out of online sync), `SyncStatus`, `UnlockMethod`, `SyncDeviceInfo`, `SyncInitResult`, `SyncUnlockRequest`, `PairingOffer` (code + QR; no SAS), `PairingPollResult` (`{sas, done}`), `IncomingPairing` (auto-discovered request), `SyncEvent`, `SyncCollection`; plus the portable-dependency types `JobDepDescriptor`, `JobSyncManifest`, `JobDependencyStatus`, `McpTransport`. No key material.

## Database Schema

Defined in `db/migrations/sync.ts` (idempotent `CREATE TABLE IF NOT EXISTS`, slotted after notes/jobs). Not part of the Drizzle schema — main-process plumbing only.

- **`sync_state`** — per profile. `user_id` PK, `cursor`, `active_umk_version`, `e2e_initialized_at`, `last_pushed_at`, `last_pulled_at`, `device_id`, `updated_at`.
- **`sync_device_key`** — per install. `user_id` PK, `device_id`, `public_key` (text), `private_key_enc` (BLOB, safeStorage-wrapped), `created_at`.
- **`sync_tombstone`** — hard-delete signals. Composite PK `(user_id, collection, client_entity_id)`, `deleted_at`, `pushed`.

No `sync_uuid` columns: the existing `nanoid` PKs on `notes` / `note_folders` / `jobs` / `job_folders` are the `client_entity_id`s.

Portable-dependency columns (Drizzle schema + `db/migrations/sync-deps.ts`, idempotent):
- **`jobs.sync_deps`** (TEXT JSON) — the `JobSyncManifest` (`{modeName, deps[]}`), the synced truth for a job's dependencies.
- **`mcp_providers.created_by_sync`** / **`agents.created_by_sync`** (INTEGER) — provenance for disabled shells auto-created from a synced descriptor.

## IPC Channels

All registered in `ipc/sync.ipc.ts` via `ipcHandle`; each calls `userActivation.requireActivated()` and resolves the user via `getProfileScopeUserId()` (renderer never passes a user id).

- `sync:get-state` — current `SyncState`.
- `sync:init` — generate UMK + envelopes; returns `SyncInitResult` (recovery mnemonic + QR, shown once).
- `sync:unlock` — `(SyncUnlockRequest)` device / recovery / passphrase.
- `sync:lock` — zero the in-memory UMK.
- `sync:sync-now` — force a cycle.
- `sync:add-passphrase` — `(passphrase)` register a passphrase envelope.
- `sync:pairing-start` — joiner: returns `PairingOffer` (code, QR). No SAS yet — it appears only after the sealer joins the handshake.
- `sync:pairing-poll` — `(code)` joiner: returns `PairingPollResult` `{ sas, done }`. `sas` fills once the sealer posts its nonce (joiner then reveals `nonce_J` once); `done` once the sealed UMK arrives + this device unlocks.
- `sync:pairing-inbox` — sealer: list the active profile's **pending** incoming requests (`IncomingPairing[]`); seeds the renderer (live ones arrive via `pairing-incoming`).
- `sync:pairing-begin-verify` — `(id)` sealer step 1: post `nonce_S`, await the reveal, verify the commitment, compute the expected SAS (held in main). Rejects on tamper/timeout/cancel.
- `sync:pairing-confirm-verify` — `(id, sas)` sealer step 2: match the user-transcribed SAS, then seal + relay the UMK (mismatch → no seal).
- `sync:pairing-cancel-verify` — `(id)` sealer: abandon a verification begun but not confirmed.
- `sync:device-revoke` — `(deviceId)`.
- `sync:disconnect` — **Disconnect online sync** (per-device): revoke THIS device server-side + tear down local enrollment + set the persistent `disconnected` flag. Account + other devices + all local data untouched. Does NOT `resetEncryption` or tombstone records.
- `sync:reconnect` — undo a prior disconnect on this device (clear the flag → re-activate → Locked/pair or Enable).

**Event channel:** `sync:event` (main → renderer broadcast) carries the `SyncEvent` union: `status`, `state`, `needs-unlock`, `needs-setup`, `quota-full`, `conflict-applied`, `data-changed` (collections a cycle mutated → `useSyncEvents` invalidates the matching `['jobs']`/`['notes']`/`['note-folders']`/`['job-folders']` caches so synced-in data + dependency status appear live), `pairing-incoming` (auto-discovery surfaced a pending request → `usePairingInbox` appends it), `error`.

## Backend API

Base path `/api/v1/app-sync` (see `services/syncApi.ts`; shapes mirror cinna-core's `app_sync_schemas.py`). `syncApi.ts` maps the backend's raw shapes to the engine-facing `PushRecordWire`/`PullRecordWire`/`PushResultWire`.
- **Encryption/keys:** `POST /encryption/init` → `EncryptionStatePublic`; `DELETE /encryption` → `EncryptionStatePublic` (**reset E2E**: delete all envelopes + devices, set `active_umk_version=0` so the account is un-initialized and `init` is allowed again — backs the full-reset Delete synced data); `GET /encryption` (init state, unlock methods, devices); `GET /keys[?umk_version=]` → bare `KeyEnvelope[]`; `POST /keys` (add/replace ONE envelope). Envelope shape: `{wrap_method, umk_version, wrapped_key, kdf, kdf_params, device_id}` — per-method nonce/salt/device-pubkey live in `kdf_params` (the server stores it verbatim).
- **Sync:** `POST /push` (upload only — its `next_cursor` is NOT a safe pull cursor), `POST /pull` (download), `POST /` (combined). Records use `client_updated_at` as an **ISO-8601 datetime** on push; pulls return `seq` + `server_updated_at` (no client timestamp echoed — applied replicas carry `server_updated_at`). `DELETE /` (wipe — server-side this **tombstones** the caller's records with fresh seqs so peers observe the deletion; it does **not** reset encryption envelopes/devices/`active_umk_version`).
- **Devices:** `POST /devices` (register → server UUID, stored as `sync_state.device_id`), `GET /devices`, `DELETE /devices/{id}` (revoke).
- **Pairing (commit-then-reveal; the relay only stores/forwards opaque blobs):** joiner-facing (keyed by the secret `code`) — `POST /pairing/start` `{new_device_pubkey, commitment, device_label}` → `pairing_code`; `GET /pairing/{code}` (poll: adds `sealer_nonce`, then `sealed_umk`); `POST /pairing/{code}/reveal` `{joiner_nonce}` (`sealer_nonce_set`→`revealed`). Sealer-facing (keyed by row `id` from the inbox) — `GET /pairing/inbox` (own non-terminal rows, metadata only), `GET /pairing/inbox/{id}` (pubkey/commitment/nonces, no `sealed_umk`), `POST /pairing/inbox/{id}/sealer-nonce` `{sealer_nonce}` (`pending`→`sealer_nonce_set`), `POST /pairing/inbox/{id}/complete` `{sealed_umk}` (`revealed`→`completed`). State machine: `pending → sealer_nonce_set → revealed → completed → consumed` (or `expired`).

## Services & Key Methods

- `syncEngine.ts` `runSyncCycle(userId, subjectId, umk, version)` — build encrypted push batch (folders before children), chunk ≤500, apply push results (`applied`/`unchanged`/`conflict`/`rejected`/`payload_too_large`), then drain pull pages. Returns `CycleResult` (now incl. `decryptSkipped`).
- `syncEngine.ts` `bootstrap(userId, subjectId, umk)` — drain from cursor 0 on fresh login.
- `collections.ts` mapper `listDirty` / `maxUpdatedAt` / `apply` — row↔payload mapping; `apply(null)` is a hard-delete.
- `umk.ts` `encryptPayload` / `decryptPayload` — XChaCha20-Poly1305 with AAD = `subjectId ‖ collection ‖ client_entity_id ‖ umkVersion` (the `userId` param the engine passes here is the **subject id** = backend user id, not the local profile id); wire envelope `{v,alg,umk,n,ct}` base64.
- `umk.ts` `contentFingerprint` — HMAC over canonical plaintext, keyed by an HKDF branch; nonce-independent so a re-encrypt resolves to `unchanged` server-side.
- `syncService.ts` `markDirty(userId)` — debounced cycle kick; no-op unless Cinna profile + unlocked.

## Renderer Components

- `CloudSyncSettingsSection.tsx` — top-level card; gates on `cinna_user`; shows the forced recovery-backup screen after `init`. Sub-components: `UnlockControls`, `PairingCard` (**sealer** only — paste a joiner's code, seal the UMK), `DevicesCard`, `StorageCard`, `DangerCard`, `RecoveryBackupScreen`.
- `SyncSetupModal.tsx` — login-time enable/restore prompt (see File Locations). Self-contained enable/restore/recovery/pairing panes reusing the `useSync` hooks.
- `components/auth/UserMenu.tsx` — the sign-out modal; for `cinna_user` it shows the "Remove this device from my account" switch (ON by default) and the reworded warning, and sends `{signOut: true, removeDevice}`. Local profiles keep "Remove Account".
- All data flows through `hooks/useSync.ts` (the settings card never calls `window.api.sync` directly; the modal's single login read goes through `fetchQuery`).

## Configuration

- Dependencies: `libsodium-wrappers-sumo` (full API — see `crypto/sodium.ts`), `@scure/bip39`, `qrcode` (+ `@types/libsodium-wrappers-sumo`).
- Engine constants in `syncEngine.ts`: `MAX_RECORDS_PER_PUSH` (500), `MAX_PAYLOAD_BYTES` (1 MiB), `PULL_PAGE` (200).
- Timing in `syncService.ts`: `PERIODIC_MS` (60s), `DEBOUNCE_MS` (1.5s). Pairing poll cadence/cap (the joiner side) live in `components/sync/SyncSetupModal.tsx`.

## Security

- **UMK** lives only in `umkVault` (main-process memory), zeroed on lock / profile-switch / logout; never persisted in plaintext, never crossed over the contextBridge.
- **Device private key** stored via `security/keystore.ts` (`safeStorage`) as `sync_device_key.private_key_enc`.
- **Zero-knowledge server** — only `payload_ciphertext` + `content_fingerprint` leave the device; AAD binds each record to its **subject id (backend user id)** / collection / id / version, so the same account decrypts across devices and apps. The subject is decoded from the access token (`decodeAccessTokenSubject`) **without** signature verification — it's our own token, read as an identifier, never as an authorization decision.
- **Unlock wrapping** — `device` = X25519 sealed box; `recovery` = HKDF(mnemonic entropy); `passphrase` = Argon2id (MODERATE ops/mem). Recovery mnemonic surfaced exactly once at init.
- **Pairing** — UMK sealed to the joiner's ephemeral X25519 key. Commit-then-reveal binds both parties' nonces (joiner commits `nonce_J` first, sealer reveals `nonce_S` before `nonce_J` is opened) so the 6-digit SAS over `pub‖nonce_J‖nonce_S` is grind-proof even against a fully malicious relay (MITM → blind 1-in-10⁶ guess). The sealer aborts on a commitment mismatch before any SAS is accepted; the user transcribes the joiner's SAS onto the trusted device (entry, not visual compare) to authorize. Auto-discovery (P4) runs only while the trusted window is **focused** + the active profile is unlocked + initialized (focus/blur wired in `main/index.ts` → `syncService.setWindowFocused`); it only ever prompts — never auto-seals.
- **Row-level scoping** — every mapper write goes through repo `*FromSync`/`deleteOwned*` methods filtered by `user_id`; a cross-profile id collision is refused.
- **Reauth** — `cinnaFetch` throws `reauth_required` on 401/403; the engine pauses and the existing global re-auth modal handles it.
- **Bare-integer guard** — the engine refuses to push a `client_entity_id` that is a bare integer.
