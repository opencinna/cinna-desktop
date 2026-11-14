# Agent Vault — technical reference

## File Locations

**Shared (no imports from main; also bundled into the guest)**
- `src/shared/vault/protocol.ts` — the two wire protocols as types and literals: helper frames and control methods, vaultd requests, gated actions and token lifetimes, the allowlists, `VAULT_UNLOCK_WINDOW_MS`, `VAULT_PAUSED_STOP_MS`, `VAULT_DEFAULT_SIZE_BYTES`, `approvalDetail()`.
- `src/shared/vault/types.ts` — renderer DTOs, `VaultResult`, error codes, move steps, `SECURE_AGENTS_DIR`, `isSecureAgentsName`, `vaultOtherChatReason`.
- `src/shared/runtimePins.ts` — `RUNTIME_PINS.vaultGuest`, each engine's `vaultAdapterTarSha256` (Claude, Codex) and `vaultRuntimeTarSha256` (Codex, Antigravity).

**Main — hub core (no Electron)** `src/main/vault/`
- `backend.ts` — the `VaultBackend` seam: `kind`, `capabilities()`, `hello()`, `availability()`, `list/create/status`, `unlock/lock`, `hold/release`, `approve`, `setEgress/resize/destroy`, `open()` (a byte stream to vaultd), `onEvent`; `installVaultBackend`, `unavailableBackend(reason)`.
- `vaultService.ts` — `vaultService`: availability, `SecureAgents/` creation, state cache and `vault:state` publishing, unlock/lock/hold, gated changes (`setEgress`, `setSize`, `destroy`), `bindChat`, the shared vaultd connection, secrets/runtimes/files reads, the transcript journal queue, quit drain. `guestRootfs()` (in `guestImage.ts`) says whether an image can be had.
- `guestImage.ts` — which `rootfs.img` a vault boots: the dev image unpackaged, else the pinned one; `ensureGuestImage` downloads it into `SecureAgents/.images/rootfs-<version>.img` (the shared managed-asset code checks the sha256 and publishes by rename, leftovers swept, concurrent callers joined); `guestHashMismatch` compares the helper's compiled-in root hash with the image's before anything is created.
- `moveService.ts` — pre-check, `moveIn`, host copy, `moveOut`, `exportFile`, `updateDependencies`, rotation list.
- `vaultCredentials.ts` — service credentials into the vault: renders `credentials.json` and side files in memory (`serviceCredentialService.vaultFiles`) and sends them with `secrets.putFile`; the attachments are the ones captured at move time (`cinna.serviceCredentials` in the vault's store); re-delivered before a turn only when the rendered bytes changed.
- `vaultChatFiles.ts` — attachments in a vault chat: `vaultChatAccepts`, `discardVaultChatFiles` (the `userData` copies deleted when the turn ends).
- `vaultTerminal.ts` — Open terminal: hold, `terminal` token, `exec` preset `shell`, bytes both ways, one `exit` or `error`.
- `adapterTar.ts` — the deterministic adapter tars written by the app build (`out/vault/claude-adapter.tar`, `codex-adapter.tar`).
- `isVaultAgent.ts` — the one predicate, `refuseVaultAgent`, `VaultAgentRefused` (code `vault_agent`), `vaultChatReadiness`.
- `transcriptStore.ts` — `vaultTranscripts`: in-memory vault chats, the journal sink, detached transcripts.
- `vaultAgentState.ts` — the vault's own key-value state: sessions, always-allow grants, captured instructions, launch settings.
- `vaultdClient.ts` — JSON-RPC client over a channel; `frames.ts` — helper frame codec and `HelperClient`; `approvalTokens.ts` — HMAC tokens (signed only by the fake backend); `runtimeInstall.ts` — streaming each pinned engine and adapter in; `fakeBackend.ts` — vaultd as a plain Node process; `secureAgentsDir.ts`, `hostCopy.ts`, `vaultHost.ts` (save dialog and Time Machine probe, injected).
- `testSupport/` — fixtures shared by the vault tests.

**Main — drivers** `src/main/agents/drivers/acp/`
- `vaultAcpConnection.ts` — the third ACP transport, beside stdio and WebSocket.
- `vaultLauncher.ts` — Claude's launcher and the readiness shared by every engine inside a vault; `vaultEngineLaunchers.ts` — the Codex, OpenCode and Antigravity launchers (no MCP servers, no host plugins or config; the vault's key is the login); `vaultRuntime.ts` — wires the launcher, readiness and the turn's hold into the ACP driver.

**Main — desktop host** `src/main/host/desktop/vault/`
- `installVaultBackend.ts` — picks the backend and finds the helper; `appleVzBackend.ts` — spawns the helper, speaks frames, implements `VaultBackend`.

**IPC** `src/main/ipc/vault.ipc.ts`; **database** `src/main/db/migrations/chat-vault.ts`, `src/main/db/chats.ts`, `messages.ts`, `inflightTurns.ts`, `agents.ts`.

**Renderer** `src/renderer/src/components/agents/local/security/` (`SecurityTab`, `AgentVaultSection`, `VaultOnPanel`, `MoveToVaultDialog`, `VaultDialog`, `VaultTerminalDialog` (xterm), `vaultText.ts`), `src/renderer/src/hooks/useVault.ts`, `src/renderer/src/components/chat/VaultOtherChatNotice.tsx`, the `vault_locked` row in `ComposerReadiness.tsx`.

**Native** — see [Vault Helper and Guest](helper_tech.md).

## Database Schema

- `chats.vault_id` — nullable, added by `migrateChatVault` (`src/main/db/migrations/chat-vault.ts`, called from `runAllMigrations` right after the chat migrations; no DML). Set once by `chatRepo.bindVault`, never changed. A chat with it keeps a stub row only.
- `agents.source = 'vault'` marks a vault agent; the id is unchanged (`folder:<manifest id>`). `driverConfig.vault` holds `vaultId`, `engine`, display copies of `kind`/`model`/`approval`, and `hostCopyPath`/`hostRootId` while the original folder remains. `localPath` is null. `agentRepo.markVault`, `unmarkVault`, `patchVaultConfig`, `listVault`, `listVaultAgentIds`, `findVault`; folder-index replace and prune skip rows of this source.
- `messages` and `inflight_turns` rows are **never** written for a vault chat. `messageRepo`, `inflightTurnRepo` and `chatRepo`'s message reads route through `vaultReadRoute` / `vaultWriteRoute` in `chats.ts`, so the FTS triggers never fire. A write to a vault chat whose vault is locked throws `VaultTranscriptLocked` (`vault_locked`) rather than fall through to SQLite.

## IPC Channels

All answer `VaultResult<T>` (a thrown code does not cross IPC, so failure is data) and are reached as `window.api.vault.*`.
- `vault:availability` — `VaultAvailabilityDto`: availability or reason, backend kind, helper flavor, capabilities.
- `vault:list`, `vault:status`, `vault:unlock`, `vault:lock` — states; `vault:set-size`, `vault:set-egress`, `vault:destroy` — gated.
- `vault:precheck`, `vault:move-in`, `vault:cancel-move`, `vault:host-copy`, `vault:delete-host-copy`, `vault:move-out`, `vault:update-dependencies`.
- `vault:secrets`, `vault:set-secret`, `vault:delete-secret` — names only come back; `vault:engine-auth`, `vault:runtimes`, `vault:list-files`, `vault:export-file`.
- Pushes: `vault:state` (`VaultStateEvent`, to every window) and `vault:move-progress` (`VaultMoveProgressEvent`, also used by Update dependencies).
- Chat detail (`chat:get`) carries `vaultId` and `vaultReadiness` (`vault_other_chat`).

- `vault:open-terminal` is not request/response: the window sends the agent id with `ipcRenderer.postMessage` and a `MessagePort` (id as the second argument, port on `event.ports`, see CLAUDE.md). The window posts `VaultTerminalCommand`s (`input`, `close`); main posts `VaultTerminalEvent`s (`open`, `data`, then exactly one `exit` or `error`) and closes the port. The port closing ends the session. It needs user activation like every vault channel and defines no resize command.

## Services & Key Methods

- **Backend choice** — `installVaultBackend.ts:installDesktopVaultBackend()`: `CINNA_VAULT_FAKE=1` in an unpackaged build → the fake (checked first, so an E2E run never boots a real VM); not macOS → `unsupported-os`; not arm64 → `unsupported-hardware`; the helper present (assumed when packaged) → Apple VZ; else `helper-missing`. `vaultService.availability()` adds `image-missing` when `guestRootfs()` finds no image (a packaged build while `RUNTIME_PINS.vaultGuest.published` is false; a dev build with no `rootfs.img`); a published image that is not downloaded yet is not `image-missing`, the move's `create` step fetches it, and turns a helper that will not say hello into `helper-missing`. A packaged app refuses any helper flavor but release (`appleVzBackend.ts`).
- **State** — the helper pushes `vault.state`; `vaultService.ts:onBackendEvent` updates the cache, drops transcripts and the vaultd connection on any state but `unlocked`, publishes `vault:state` and re-asks the agent's readiness so the composer follows. A per-vault lock generation makes a lock that lands during an unlock win.
- **Turns** — the ACP driver holds the vault (`vault.hold`) for the whole turn and releases it in a finally; a locked vault fails the turn with "Unlock it to send a message". Readiness order: engine a vault cannot run → `vault_locked` → `not_installed` (runtime missing; fix with Update dependencies) → `not_logged_in` (add the engine's API key) → `ok`, the same for all four engines; `vault_other_chat` (a chat that began before the move) is answered by `vaultChatReadiness` before any of it.
- **Behaviour comes from inside** — `vaultLauncher.ts` reads `cinna.launch` and `cinna.instructions` from the vault's key-value store at every launch; `vaultAgentState.ts` keeps `cinna.sessions` and `cinna.permissionGrants` there instead of a host `desktop.json`. Grants are cached in memory while unlocked (the ask path is synchronous) and a failed write is asked again next time.
- **Credentials and attachments** — `vaultCredentials` runs at the move's `credentials` step and again before a turn. Attachments: `attachmentUploadsDir` is null for a vault agent, so files travel inline in the prompt (text, PDF and Office as extracted text; png/jpeg/gif/webp as image blocks); `fileService.ingest` refuses anything else for a vault chat before a byte is stored, and `discardVaultChatFiles` deletes the stored copies when the turn ends. Any copy a turn left behind is swept at start and when a vault locks, so a turn the app died under does not leave a file in `userData`.
- **Transcripts** — every row op is a `TranscriptOp` journaled through the sink (`transcript.append`), queued in order while the vault is locked and delivered after the next unlock; the vault's chats are rebuilt from `transcript.read` on unlock. A chat whose turn is running when the vault locks becomes a **detached** transcript until the turn finishes writing; a detached one reads as locked, so a half-written transcript is never shown as the chat's whole history. A quit is held up to 3 s (`index.ts` `will-quit`, `vaultService.pendingQuitDrain`) to deliver queued rows, then the helper stops every VM.
- **Exclusions** — callers of `isVaultAgent` / `refuseVaultAgent`: `delegationService` (target list, `requireTarget`, create), `taskService` and `taskExecutionService` (assignee), `handoverService` (agents and intake), `chatService` (add on-demand agent, bind), `conductorBridge` and `a2aAsMcpProvider` (no `cinna` MCP, no loopback URL, no attachment), `agentService`, `localScheduleService` (save, enable, scheduled runs), `commandService` (Run commands), `openInService` and `agentFileService`, `serviceCredentials/service.ts` (credential files), `inboxService`, `chatTitleService` (`vault_chat`), `jobExecution/desktop.ts`, `sync/scriptAgents.ts`, and `localAgentService`, whose `locate` throws `vault_agent` for any host-path consumer. `vaultChatReadiness` is applied in `runExecutionService` before a vault agent answers in a chat of another vault or none.
- **Reserved folder** — `SECURE_AGENTS_DIR` is skipped by `scannerService`, `externalScan`, `watcherService` (both event paths), `kit/validator.ts` (`UNWALKED_DIRS`); `scaffoldService` and `localAgentService` refuse the name; `vaultService.ensureSecureAgentsDir` writes the `.gitignore` (`*`) and the `.cinna-vaults` marker and refuses a folder without it (`secureAgentsDir.ts`).
- **Errors** — `VaultError` codes (`unavailable`, `not_found`, `not_vault_agent`, `locked`, `denied`, `busy`, `invalid`, `tampered`, `internal`); a cancelled prompt is `denied` and the UI says "Cancelled at the prompt — nothing changed."

## Renderer Components

- `SecurityTab.tsx` — **Agent Vault** section first, **Permissions** second, owning the Move dialog so the move outlives the section's state. The tab id was `permissions`; `ui.store.ts` maps a persisted or requested `permissions` to `security`.
- `AgentVaultSection.tsx` — never disappears: off, unavailable-with-reason (`vaultText.ts` wording per reason), or on. The "What a vault protects against" panel states both halves of the threat model. A non-release helper shows a "Test helper" badge.
- `VaultOnPanel.tsx` — status and the 1-minute countdown ("Unlocked · locks in Ns", "Running" while a turn holds it), Unlock / Lock now, the host-copy row, Disk size limit, Network access, Engine login (per engine key), Secrets, Toolchain, Terminal (Open terminal, enabled only while unlocked), the folder browser with **Export…**, Move out, Delete vault. Rows reserve their height so an unlock does not shift the controls.
- `MoveToVaultDialog.tsx` — pre-check, progress by step, rotation checklist; built on `VaultDialog.tsx`.
- `LocalAgentPage.tsx` — lock icon next to the title; `LocalAgentsList.tsx` — a lock on the agent's row in the Local agents list; `ComposerReadiness.tsx` row `vault_locked` with **Unlock** and `vault_other_chat` with a new-chat action; `MessageStream.tsx` does not claim a locked vault's chat is empty.

## Configuration

- `CINNA_VAULT_FAKE=1` — fake backend (unpackaged only); `CINNA_VAULT_FAKE_WINDOW_MS` shortens its unlock window.
- `CINNA_VAULT_GUEST_DIR` — directory holding `rootfs.img` (unpackaged only; default `build/vault-guest/`).
- Pins: `RUNTIME_PINS.vaultGuest` (`published`, `version`, `rootHash`, `hashOffset`, `rootfs`), and per engine `vaultAdapterTarSha256` / `vaultRuntimeTarSha256`. The guest checks each against the pin before `runtime.install` commits it, and the launcher checks the installed one again before it runs it.
- `CINNA_VAULT_TEST_SCREEN_LOCKED=0|1` — test-flavor helper only (see [the helper](helper_tech.md)).
- Constants: unlock window 60 s, paused-VM stop 30 min, default disk 10 GB (allowed 1 GB–2 TB), approval token lifetimes in `APPROVAL_TTL_MS` (move-in, install and move-out 30 min; the rest 10 min).
- Default allowlist per engine: `VAULT_ENGINE_HOSTS`; install hosts: `VAULT_INSTALL_HOSTS`.

## Security

- **Cinna is a requester, never the approver.** `approve` returns a token the helper signed after its own prompt; main cannot mint one, and the helper builds the prompt text from the action, the detail and the agent name from the signed `vault.json`.
- **Secrets are write-only.** `secrets.put` / `secrets.putFile` / `secrets.list` / `secrets.delete`; there is no `secrets.get`. Values reach the engine only through vaultd, as env (an allowlist of names) or files it writes inside. A `putFile` secret has two copies on the encrypted disk: a root-only stored one and a read-only (0400) copy owned by `agent` in `run-secrets/`, refreshed at every `engine.spawn`; its path is `CINNA_CREDENTIALS_PATH`.
- **vaultd is ungated by design once unlocked** (`transcript.read`, `kv.get`, …): the unlock is the gate. `vaultService.client()` refuses to hand out a connection unless the vault is known to be unlocked.
- **A stalled stream is not an exit.** A vault that locks mid-turn pauses; `VaultAcpConnection` treats the engine as gone only on the attached stream closing or vaultd's `engine.exit`.
- **No logging of vault content.** Tool-call inputs are left out of the log for a vault session (`acpDriver.ts`).
- **Known limit:** see [Agent Vault](vault.md#what-it-protects-and-what-it-does-not) for D34 (prompting rests on Cinna's code integrity) and the developer-Mac signing caveat.
