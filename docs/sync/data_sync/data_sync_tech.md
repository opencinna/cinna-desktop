# Native Client Data Sync — Technical Reference

## File Locations

### Main Process (`src/main/`)

**Sync engine & mappers (`sync/`)**
- `sync/syncEngine.ts` — `runSyncCycle()`, `bootstrap()`: cursor advance, push batch build, pull drain, LWW conflict apply, back-pressure limits. Threads the peer's `client_updated_at` + a per-cycle `ResolveCache` into every `apply`; recomputes the push watermark from the post-apply max.
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
- `crypto/pairing.ts` — ephemeral keypair, `encodePairingPublicKey`/`decodePairingPublicKey`, `computeSas`, `sealUmkForJoiner`/`openSealedUmk`.
- `crypto/scure-bip39.d.ts` — type shim for the `@scure/bip39` english wordlist subpath.

**Services**
- `services/syncService.ts` — orchestration: `getState`, `ensureActivated`, `tryAutoUnlock`, `initEncryption`, `unlock`, `addPassphrase`, `lock`, `syncNow`, `markDirty`, pairing (`startPairing`/`pollPairing`/`scanPairing`), `revokeDevice`, `wipe`, `onProfileSwitch`. Owns the renderer broadcast (`sync:event`) and per-profile timers.
- `services/syncApi.ts` — HTTP client for `/api/v1/app-sync*`; owns the on-wire field names and maps cinna-core's raw responses to engine-facing shapes (`PushRecordWire`, `PullRecordWire`, `PushResultWire`, `EncryptionStateWire`, `SyncStateWire`, `DeviceWire`).
- `services/cinnaApiService.ts` — `cinnaApiFetch()` / `getCinnaServerUrl()` exported for `syncApi` to reuse Bearer auth + `reauth_required` detection + logging; `cinnaFetch` tolerates empty response bodies.

**Database (`db/`)**
- `db/migrations/sync.ts` — `runSyncMigrations()`: creates `sync_state`, `sync_device_key`, `sync_tombstone`.
- `db/migrations/sync-deps.ts` — `runSyncDepsMigrations()`: idempotent column adds `jobs.sync_deps` (JSON manifest), `mcp_providers.created_by_sync`, `agents.created_by_sync`.
- `db/client.ts` — registers `runSyncMigrations()` then `runSyncDepsMigrations()` (after notes/jobs) in `runMigrations()`; exposes `getRawSqlite()`.
- `db/sync.ts` — `syncRepo`: bookkeeping CRUD (state, device key, tombstones) over raw SQLite.
- `db/notes.ts` — `notesRepo` / `noteFoldersRepo` sync helpers: `listChangedSince`, `maxUpdatedAt`, `upsertFromSync`, `deleteOwned` / `deleteOwnedWithDetach`. Hard-delete paths emit tombstones.
- `db/jobs.ts` — `jobsRepo` / `jobFoldersRepo` sync helpers: same set plus `listRefs`, `setSyncDeps` (write the manifest without bumping `updatedAt`), `setRefsFromSync` (materialize resolved join rows). `upsertFromSync` carries the peer's `updatedAt` + stores `sync_deps`. Folder delete emits a tombstone.

**Auth / lifecycle**
- `auth/activation.ts` — activates sync (`ensureActivated`) for Cinna users on login; `onProfileSwitch()` (UMK zero + timer clear) on deactivate.
- `errors.ts` — `SyncError` / `SyncErrorCode`.

**Mutation hooks (dirty signals)**
- `services/notesService.ts` — `markDirty()` on note/folder create, update, delete, restore, empty-trash, reorder.
- `services/jobService.ts` — `markDirty()` on job/folder create, update, delete, set-agents/MCPs, reorder; also `rebuildJobManifest()` after create / mode change / set-agents / set-MCPs so `sync_deps` tracks local edits. `getDependencyStatus()` (→ `job:dep-status` IPC) resolves a job's manifest against local state for the UX; `list()` adds a `needsSetup` flag via `buildResolveIndex`/`manifestNeedsSetup`.

### Preload (`src/preload/`)
- `preload/index.ts` — `window.api.sync.*` bindings.

### Renderer (`src/renderer/src/`)
- `hooks/useSync.ts` — React Query layer: `useSyncState`, `useSyncEvents`, mutations (`useSyncInit/Unlock/Lock/Now`, `useAddPassphrase`, `usePairingStart/Scan`, `useRevokeDevice`, `useSyncWipe`), `pollPairing`.
- `hooks/useJobs.ts` `useJobDependencyStatus(jobId)` — per-dependency resolution status (`job:dep-status`), nested under `['jobs', jobId]` so job edits / sync apply refresh it. `components/jobs/JobDetail.tsx` renders the amber/grey "finish setup on this device" surface; `components/jobs/JobItem.tsx` shows a sidebar badge from `JobData.needsSetup`.
- `components/settings/CloudSyncSettingsSection.tsx` — the Cloud Sync card and its sub-components (unlock controls, pairing, devices, storage, danger zone, recovery-backup screen).
- `components/settings/SettingsPage.tsx` — renders the `profile-sync` tab.
- `components/layout/Sidebar.tsx` — `profile-sync` nav item ("Cloud Sync").
- `stores/ui.store.ts` — `SettingsMenu` union + `PROFILE_SCOPE_TABS` include `profile-sync`.

### Shared (`src/shared/`)
- `shared/sync.ts` — cross-bridge types: `SyncState`, `SyncStatus`, `UnlockMethod`, `SyncDeviceInfo`, `SyncInitResult`, `SyncUnlockRequest`, `PairingOffer`, `SyncEvent`, `SyncCollection`; plus the portable-dependency types `JobDepDescriptor`, `JobSyncManifest`, `JobDependencyStatus`, `McpTransport`. No key material.

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
- `sync:pairing-start` — joiner: returns `PairingOffer` (code, QR, SAS).
- `sync:pairing-poll` — `(code)` joiner: true once the sealed UMK arrives.
- `sync:pairing-scan` — `(code)` unlocked device: seal UMK to joiner; returns `{ sas }`.
- `sync:device-revoke` — `(deviceId)`.
- `sync:wipe` — delete all server-side ciphertext.

**Event channel:** `sync:event` (main → renderer broadcast) carries the `SyncEvent` union: `status`, `state`, `needs-unlock`, `needs-setup`, `quota-full`, `conflict-applied`, `data-changed` (collections a cycle mutated → `useSyncEvents` invalidates the matching `['jobs']`/`['notes']`/`['note-folders']`/`['job-folders']` caches so synced-in data + dependency status appear live), `error`.

## Backend API

Base path `/api/v1/app-sync` (see `services/syncApi.ts`; shapes mirror cinna-core's `app_sync_schemas.py`). `syncApi.ts` maps the backend's raw shapes to the engine-facing `PushRecordWire`/`PullRecordWire`/`PushResultWire`.
- **Encryption/keys:** `POST /encryption/init` → `EncryptionStatePublic`; `GET /encryption` (init state, unlock methods, devices); `GET /keys[?umk_version=]` → bare `KeyEnvelope[]`; `POST /keys` (add/replace ONE envelope). Envelope shape: `{wrap_method, umk_version, wrapped_key, kdf, kdf_params, device_id}` — per-method nonce/salt/device-pubkey live in `kdf_params` (the server stores it verbatim).
- **Sync:** `POST /push` (upload only — its `next_cursor` is NOT a safe pull cursor), `POST /pull` (download), `POST /` (combined). Records use `client_updated_at` as an **ISO-8601 datetime** on push; pulls return `seq` + `server_updated_at` (no client timestamp echoed — applied replicas carry `server_updated_at`). `DELETE /` (wipe).
- **Devices:** `POST /devices` (register → server UUID, stored as `sync_state.device_id`), `GET /devices`, `DELETE /devices/{id}` (revoke).
- **Pairing:** `POST /pairing/start` (joiner registers its ephemeral pubkey → server mints `pairing_code`), `GET /pairing/{code}` (poll for `sealed_umk`), `POST /pairing/{code}/complete` (unlocked device posts the sealed UMK).

## Services & Key Methods

- `syncEngine.ts` `runSyncCycle(userId, umk, version)` — build encrypted push batch (folders before children), chunk ≤500, apply push results (`applied`/`unchanged`/`conflict`/`rejected`/`payload_too_large`), then drain pull pages.
- `syncEngine.ts` `bootstrap(userId, umk)` — drain from cursor 0 on fresh login.
- `collections.ts` mapper `listDirty` / `maxUpdatedAt` / `apply` — row↔payload mapping; `apply(null)` is a hard-delete.
- `umk.ts` `encryptPayload` / `decryptPayload` — XChaCha20-Poly1305 with AAD = `userId ‖ collection ‖ client_entity_id ‖ umkVersion`; wire envelope `{v,alg,umk,n,ct}` base64.
- `umk.ts` `contentFingerprint` — HMAC over canonical plaintext, keyed by an HKDF branch; nonce-independent so a re-encrypt resolves to `unchanged` server-side.
- `syncService.ts` `markDirty(userId)` — debounced cycle kick; no-op unless Cinna profile + unlocked.

## Renderer Components

- `CloudSyncSettingsSection.tsx` — top-level card; gates on `cinna_user`; shows the forced recovery-backup screen after `init`. Sub-components: `UnlockControls`, `PairingCard` (bounded poll, ~3 min expiry), `DevicesCard`, `StorageCard`, `DangerCard`, `RecoveryBackupScreen`.
- All data flows through `hooks/useSync.ts`; the component never calls `window.api.sync` directly.

## Configuration

- Dependencies: `libsodium-wrappers-sumo` (full API — see `crypto/sodium.ts`), `@scure/bip39`, `qrcode` (+ `@types/libsodium-wrappers-sumo`).
- Engine constants in `syncEngine.ts`: `MAX_RECORDS_PER_PUSH` (500), `MAX_PAYLOAD_BYTES` (1 MiB), `PULL_PAGE` (200).
- Timing in `syncService.ts`: `PERIODIC_MS` (60s), `DEBOUNCE_MS` (1.5s). Pairing poll cadence/cap in `CloudSyncSettingsSection.tsx`.

## Security

- **UMK** lives only in `umkVault` (main-process memory), zeroed on lock / profile-switch / logout; never persisted in plaintext, never crossed over the contextBridge.
- **Device private key** stored via `security/keystore.ts` (`safeStorage`) as `sync_device_key.private_key_enc`.
- **Zero-knowledge server** — only `payload_ciphertext` + `content_fingerprint` leave the device; AAD binds each record to its user/collection/id/version.
- **Unlock wrapping** — `device` = X25519 sealed box; `recovery` = HKDF(mnemonic entropy); `passphrase` = Argon2id (MODERATE ops/mem). Recovery mnemonic surfaced exactly once at init.
- **Pairing** — UMK sealed to the joiner's ephemeral X25519 key; the SAS is compared out-of-band to defeat a server-substituted key.
- **Row-level scoping** — every mapper write goes through repo `*FromSync`/`deleteOwned*` methods filtered by `user_id`; a cross-profile id collision is refused.
- **Reauth** — `cinnaFetch` throws `reauth_required` on 401/403; the engine pauses and the existing global re-auth modal handles it.
- **Bare-integer guard** — the engine refuses to push a `client_entity_id` that is a bare integer.
