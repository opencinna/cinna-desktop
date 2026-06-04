# Device Pairing — Technical Reference

Implements the commit-then-reveal pairing protocol + auto-discovery. Crypto is byte-identical to mobile (`@noble`) and the backend relay; see [crypto_llm.md](crypto_llm.md) for the primitives and the shared test vector.

## File Locations

### Main process (`src/main/`)
- `sync/crypto/pairing.ts` — pure crypto: `createPairingEphemeral`, `encodePairingPublicKey`/`decodePairingPublicKey` (base64url, no-pad), `randomNonce` (16 bytes), `pairingCommitment(pub, nonce)` (base64 of `blake2b-256(pub‖nonce)`), `computeSas(transcript)` (blake2b dkLen=8 → 4-byte fold → `### ###`), `sasTranscript(pub, nonceJ, nonceS)`, `sealUmkForJoiner`/`openSealedUmk`.
- `services/syncService.ts` — orchestration. Joiner: `startPairing` (commit `nonce_J` at start), `pollPairing` (compute SAS + reveal on `sealer_nonce`, open UMK on `completed`). Sealer: `beginVerify` (post `nonce_S`, await reveal, verify commitment, compute SAS), `confirmVerify` (match transcribed SAS → seal + relay), `cancelVerify`, `pairingInbox`. Auto-discovery: `setWindowFocused` + module-level `pollInboxOnce`/`startInboxPolling`/`stopInboxPolling`. In-memory state: `pairingEphemerals` (code → joiner ephemeral+nonce+sas+revealed), `pendingVerifications` (id → joinerPub+sas), `cancelledVerifications`, `announcedPairings`.
- `services/syncApi.ts` — relay HTTP client: `pairingStart`, `pairingGet`, `pairingReveal` (joiner, keyed by code); `pairingInbox`, `pairingInboxGet`, `pairingSetSealerNonce`, `pairingCompleteById` (sealer, keyed by row id).
- `ipc/sync.ipc.ts` — IPC handlers (all `requireActivated()` + `getProfileScopeUserId()`).
- `index.ts` — `BrowserWindow` `'focus'`/`'blur'`/`'closed'` → `syncService.setWindowFocused(...)` (arms/stops the focus-gated inbox poll).

### Preload (`src/preload/index.ts`)
`window.api.sync.*`: `pairingStart`, `pairingPoll`, `pairingInbox`, `pairingBeginVerify`, `pairingConfirmVerify`, `pairingCancelVerify`, plus `onEvent` (carries `pairing-incoming`).

### Renderer (`src/renderer/src/`)
- `hooks/useSync.ts` — `usePairingStart`, `usePairingBeginVerify`, `usePairingConfirmVerify`, `usePairingCancelVerify`, `usePairingInbox(enabled)` (seeds from inbox + appends `pairing-incoming` events; `dismiss(id)`), and the bare `pollPairing(code)` driver.
- `components/sync/PairJoinPane.tsx` — shared **joiner** pane: registers the request, polls, shows QR/code → reveals the SAS for transcription. Reused by both call sites below.
- `components/sync/SyncSetupModal.tsx` — login-time restore: its `PairPane` wraps `PairJoinPane`.
- `components/settings/CloudSyncSettingsSection.tsx` — `PairingCard` (sealer, discovery-driven), `IncomingPairingRow` (per-request Verify → enter-SAS → confirm, with unmount-cancel), and `UnlockControls` `variant='restore'` (Locked device → joiner pairing pane).

### Shared (`src/shared/sync.ts`)
`PairingOffer` (code + QR; no SAS), `PairingPollResult` (`{ sas, done }`), `IncomingPairing` (`{ id, deviceLabel, expiresAt }`), and the `pairing-incoming` `SyncEvent` variant.

## Relay endpoints (`/api/v1/app-sync/pairing`)

Joiner-facing (keyed by the secret `code`):
- `POST /pairing/start` `{ new_device_pubkey, commitment, device_label }` → `{ pairing_code, expires_at }` (row `pending`).
- `GET /pairing/{code}` → `{ new_device_pubkey, device_label, status, sealer_nonce, sealed_umk, expires_at }`; flips `completed → consumed` on delivery.
- `POST /pairing/{code}/reveal` `{ joiner_nonce }` (`sealer_nonce_set → revealed`).

Sealer-facing (keyed by row `id`):
- `GET /pairing/inbox` → `[{ id, device_label, status, expires_at }]` (own non-terminal rows; TTL-expired flipped lazily, never surfaced).
- `GET /pairing/inbox/{id}` → `{ new_device_pubkey, commitment, sealer_nonce, joiner_nonce, status, expires_at }` (no `sealed_umk`).
- `POST /pairing/inbox/{id}/sealer-nonce` `{ sealer_nonce }` (`pending → sealer_nonce_set`).
- `POST /pairing/inbox/{id}/complete` `{ sealed_umk }` (`revealed → completed`).

Backend models/routes (cinna-core): `models/app_sync/app_sync_pairing.py`, `api/routes/app_sync.py`, `services/app_sync/app_sync_service.py`.

## IPC Channels

- `sync:pairing-start` → `PairingOffer` (joiner: gen key + nonce + commitment, register row).
- `sync:pairing-poll` `(code)` → `PairingPollResult` (`sas` once the sealer joins, `done` once the UMK arrives).
- `sync:pairing-inbox` → `IncomingPairing[]` (sealer: pending requests; seeds the renderer).
- `sync:pairing-begin-verify` `(id)` → sealer step 1 (post nonce, await reveal, verify commitment, compute SAS). Rejects on tamper/timeout/cancel.
- `sync:pairing-confirm-verify` `(id, sas)` → sealer step 2 (match SAS → seal + relay; mismatch → no seal).
- `sync:pairing-cancel-verify` `(id)` → abandon an in-flight verify.
- Event: `sync:event` carries `{ type: 'pairing-incoming', pairing }` (auto-discovery → `usePairingInbox` appends).

## Services & Key Methods

- `syncService.startPairing(userId)` — ephemeral + `nonce_J` + `commitment`; stash in `pairingEphemerals`; returns code + QR.
- `syncService.pollPairing(userId, code)` — on `sealer_nonce`: `computeSas(sasTranscript(...))` + `pairingReveal` (once via the `revealed` flag); on `completed`: `openSealedUmk` → `vault.setUmk` → register device envelope → cycle.
- `syncService.beginVerify(userId, id)` — `pairingInboxGet` → `pairingSetSealerNonce` (while `pending`) → poll for `joiner_nonce` (≤60s, bails on cancel/expiry) → verify `pairingCommitment(joinerPub, joinerNonce) === detail.commitment` (else abort) → stash `{ joinerPub, sas }`.
- `syncService.confirmVerify(userId, id, enteredSas)` — `normalizeSas` compare against the stashed SAS → `sealUmkForJoiner` → `pairingCompleteById`. Logs `pairing: sealed UMK to newly-authorized device`.
- `syncService.pollInboxOnce()` (module-level) — gated on focus + active, unlocked, initialized Cinna profile; broadcasts `pairing-incoming` for new `pending` rows (deduped via `announcedPairings`).
- `syncService.setWindowFocused(focused)` — arms/clears the 5s inbox timer (`INBOX_POLL_MS`).

## Renderer Components

- `PairJoinPane` — joiner: `usePairingStart` then a 2s `pollPairing` loop (`PAIRING_POLL_INTERVAL_MS`, `PAIRING_POLL_MAX_ATTEMPTS` ≈ 3 min); shows QR/code, then the SAS once present; `onPaired` fires when `done`.
- `IncomingPairingRow` — sealer: phases `idle → verifying → enter → done`; `beginVerify` → numeric SAS input → `confirmVerify`; a `handledRef` + phase-mirroring ref cancel an in-flight verify on unmount.
- `PairingCard` — lists `usePairingInbox(true)` requests; no paste-a-code entry (discovery only).

## Configuration

- Inbox poll cadence: `INBOX_POLL_MS` = 5s (`syncService.ts`).
- Joiner poll: `PAIRING_POLL_INTERVAL_MS` = 2s, cap `PAIRING_POLL_MAX_ATTEMPTS` = 90 (`PairJoinPane.tsx`).
- Sealer reveal wait: 60s deadline in `beginVerify`.
- Relay TTL: `APP_SYNC_PAIRING_TTL_SECONDS` (backend).

## Security

- The UMK and the computed SAS never cross the contextBridge; `confirmVerify` compares the user-typed SAS **in the main process** (the renderer never receives the real code → forces genuine transcription).
- The commitment is verified before any SAS is accepted; a tampered pubkey/nonce aborts the seal automatically.
- The relay is zero-knowledge: it stores/forwards opaque base64 blobs and enforces state transitions + per-user ownership, never inspecting ciphertext or verifying the commitment.
- Auto-discovery requires a foregrounded + unlocked + initialized profile and only ever prompts; it never auto-seals. Pairing audit events (request discovered, UMK sealed, UMK received) are logged via the scoped `sync` logger.
