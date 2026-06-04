# Device Pairing

## Purpose

Lets a new (or wiped/untrusted) device join an account's end-to-end-encrypted sync by receiving the User Master Key (UMK) from an already-trusted device, sealed through a zero-knowledge relay — with a grind-proof 6-digit verification code that defeats a malicious relay, and zero manual code transfer between devices.

## Core Concepts

- **Joiner** — the device that lacks the key and wants in. Generates an ephemeral X25519 keypair, publishes its public key, and receives the UMK sealed to it.
- **Sealer** — an already-unlocked, trusted device that holds the UMK and seals it to the joiner's public key.
- **Relay** — the Cinna backend's `/app-sync/pairing/*` endpoints. A **dumb, zero-knowledge** store-and-forward: it holds opaque blobs (commitment, nonces, sealed UMK) and enforces a state machine, but never inspects ciphertext or verifies the commitment.
- **Pairing code** — a secret `token_urlsafe` the relay mints at `start`; the joiner polls by it. The relay stores only its SHA-256, so the sealer can't address rows by code — it uses the row `id` discovered from its inbox.
- **SAS** (Short Authentication String) — the 6-digit code (`### ###`) the user reads off the joiner and types into the sealer. Computed over the full handshake transcript `pubkey_J ‖ nonce_J ‖ nonce_S`, so it binds **both** parties' contributions.
- **Commitment** — `H(pubkey_J ‖ nonce_J)` the joiner posts up front; lets the sealer detect a tampered pubkey/nonce **before** any SAS is accepted.
- **Inbox / Auto-discovery** — a trusted, foregrounded device polls `/pairing/inbox` for its own pending requests and surfaces them, so the user never transfers a routing code by hand.

## User Stories / Flows

### Joiner (new device restoring data)
1. On the new device the user picks **Pair with another device** (in the login `SyncSetupModal` restore flow, or Settings → Cloud Sync → Locked → Pair).
2. The device registers a pairing request (ephemeral pubkey + commitment) and shows "Waiting for your trusted device…".
3. Once the trusted device joins the handshake, the joiner reveals the **6-digit code** with "Enter this code on your trusted device."
4. After the trusted device authorizes, the joiner receives the sealed UMK, unlocks, registers a fresh device envelope, and syncs.

### Sealer (trusted device authorizing the new one)
1. While the trusted device is foregrounded + unlocked, the incoming request appears automatically in Settings → Cloud Sync → **Add a device** (no code to paste).
2. The user taps **Verify**; the device runs the handshake ("Establishing secure channel…").
3. The device verifies the joiner's commitment (aborts on mismatch — a clean tamper signal the user never has to adjudicate), computes the expected SAS, and prompts **"Enter the 6-digit code shown on the new device."**
4. The user transcribes the joiner's code; on a match the device seals the UMK to the joiner and relays it. Mismatch → inline error, nothing sealed.

## Business Rules

- **Commit-then-reveal ordering** (the security guarantee): joiner commits `nonce_J` first → sealer reveals `nonce_S` (chosen before it can see `nonce_J`) → joiner reveals `nonce_J` last → both compute `SAS = trunc6(H(pubkey_J ‖ nonce_J ‖ nonce_S))`. A malicious relay has no grindable handle left; MITM collapses to a blind 1-in-10⁶ guess. The relay never needs to verify the commitment — the sealer does.
- **Entry, not visual compare** — the trusted device never displays its computed SAS; the user must **type** the joiner's code, forcing real transcription. The comparison happens in the main process; the renderer never sees the real SAS.
- **Seal only after match** — the UMK leaves the sealer only after the user-entered SAS matches. A relay-substituted key yields a mismatching SAS and is rejected before any secret moves.
- **Auto-discovery is opt-in and gated** — the inbox poll runs only while the window is **focused** AND the active profile is a sync-initialized, unlocked Cinna profile. It only ever *prompts*; it never auto-seals. Polling stops on blur.
- **Relay state machine:** `pending → sealer_nonce_set → revealed → completed → consumed`, or `expired` (TTL) from any intermediate state. Each transition is rejected unless the row is in the legal prior state and owned by the caller.
- **Single-use** — the sealed UMK is delivered once: the joiner's fetch flips `completed → consumed` and clears the blob.
- **No back-compat** — protocol/crypto are byte-identical across desktop, mobile, and backend, changed in lockstep; there is no version negotiation.

## Architecture Overview

```
JOINER (new device)            RELAY (zero-knowledge)            SEALER (trusted, foregrounded)
gen key_J, nonce_J
commitment = H(key_J‖nonce_J)
 start {pubkey, commitment} ──▶  row: pending  ◀──  GET /inbox (focus-gated poll) → {id, label}
 show "waiting…"                                     user taps Verify
                                                     gen nonce_S → POST /inbox/{id}/sealer-nonce
 GET /{code} → sealer_nonce  ◀──  sealer_nonce_set
 SAS = trunc6(H(key‖nJ‖nS))
 POST /{code}/reveal {nonce_J} ─▶  revealed  ◀──  GET /inbox/{id} → {pubkey, commitment, joiner_nonce}
 show SAS "481 902"                                  verify commitment == H(pubkey‖nonce_J)  → abort on mismatch
                                                     SAS = trunc6(H(pubkey‖nJ‖nS)); user types joiner's SAS → match?
 GET /{code} → sealed_umk    ◀──  completed→consumed   seal UMK→pubkey; POST /inbox/{id}/complete
 open with key_J → unlocked
```

Renderer → `useSync` hooks → `window.api.sync.*` (contextBridge) → `sync.ipc.ts` → `syncService` → `syncApi` → relay. Keys/SAS never cross the bridge.

## Integration Points

- [Native Client Data Sync](data_sync.md) — pairing is one of the unlock/restore paths; the received UMK feeds the same vault + sync engine.
- [Device Lifecycle & State Machine](lifecycle.md) — where pairing sits among Enable / auto-unlock / restore / pause / disconnect, and the "Locked → Pair" surface.
- [Crypto (LLM ref)](crypto_llm.md) — the exact commitment/SAS/nonce primitives and the byte-vector cross-checked against mobile.
- [Cinna Accounts](../../auth/cinna_accounts/cinna_accounts.md) — pairing requires a Cinna-linked profile; reauth pauses sync and defers to the global modal.
- Technical reference: [device_pairing_tech.md](device_pairing_tech.md).
