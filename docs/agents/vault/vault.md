# Agent Vault — a local agent in an isolation nothing else on the Mac shares

## Purpose

Some local agents hold credentials that matter more than anything else on the laptop: a production database owner, a payment account, a signing key. Today any process running as the user can read what such an agent holds — its folder and `.env`, the delivered `credentials.json`, a running engine's environment, Cinna's own data — and any other agent can reach it through Cinna (a delegation, a handover, a conductor, a schedule). **Agent Vault** moves one existing folder agent into a Linux micro-VM that it shares with nothing: nothing gets in unless the user approves it through a prompt other software cannot forge, and nothing gets out unless the user approves it or the network allowlist names it.

It is for **local folder agents on Claude Code, Codex, OpenCode or Antigravity**, on **Apple silicon with macOS 15 or later**, and it needs nothing installed on the Mac (no Command Line Tools, Homebrew or uv).

## Core Concepts

- **Agent Vault** — the isolated environment of one agent: a micro-VM on Apple's Virtualization.framework, with a read-only system and one encrypted data disk of its own. One vault per agent. The agent keeps its id and stays in the sidebar with a lock.
- **Vault Helper** — a separate signed program shipped inside Cinna (`VaultHelper.app`) that owns everything that must not depend on Cinna: the VM, the disk key, the user-presence prompts, the network proxy and the timers. Cinna asks it; it never takes Cinna's word for what the user approved.
- **cinna-vaultd** — the small daemon inside the guest that is the source of truth for everything in the vault: it starts the engine, writes files, keeps secrets and transcripts, and builds every command line itself.
- **Engine login** — the one API key an engine signs in with inside a vault: for Claude an Anthropic API key or a `claude setup-token` token (told apart by prefix: `sk-ant-oat…` is stored as `CLAUDE_CODE_OAUTH_TOKEN`, anything else as `ANTHROPIC_API_KEY`, and the vault keeps only one), OpenAI's for Codex, the model provider's for OpenCode, a Gemini API key for Antigravity. It is put into the vault and never kept by Cinna; a login on the Mac (a Claude subscription, a ChatGPT or Google sign-in) cannot be handed in.
- **Vault chat** — a chat with a vault agent. Its messages live only in the vault; Cinna's database keeps a stub row titled "<agent> · <date>".
- **Unlock window** — an unlock lasts **1 minute** after the last turn or gated action ended. A running turn keeps it open. When it ends the vault locks.
- **Gated action** — an action that needs a fresh presence prompt (Touch ID or password, worded by the helper) *every time*, even while unlocked: moving in, installing or updating dependencies, exporting a file, opening a terminal, moving out, changing the network allowlist, changing the disk size, deleting the vault.
- **Approval token** — what the helper hands back after a gated prompt: a signed, expiring claim for exactly that action. The guest and the helper refuse a gated call that does not carry one, so a Cinna that asks without the user having approved gets nothing.
- **Host copy** — the original folder, left on the Mac after a move until the user deletes it.

## User Stories / Flows

1. **See what it is.** On the agent page, **Security → Agent Vault** is always there. On a Mac that cannot hold a vault it says why in words ("Needs macOS 15 or later on Apple silicon", "Not available inside a virtual machine", "The guest image isn’t installed") and offers no button. An agent that can move shows **Move to vault…** and an expandable "What a vault protects against".
2. **Move an agent in.** See [Moving an agent in and out](move.md): a pre-check, then create, unlock, copy, rebuild, credentials and a readiness check, with the original left untouched until the user deletes it.
3. **Talk to it.** Start a new chat with the agent. If the vault is locked the composer shows **Vault locked — Unlock**; the draft is kept. Unlock raises the helper's prompt, boots (or resumes) the VM and reopens the vault's chats. A turn runs inside; when it ends the 1-minute window counts down.
4. **Lock.** The window ending, **Lock now**, the screen locking, the Mac sleeping, a fast user switch and logout all lock every vault. A turn still running is suspended with the vault and continues after the next unlock.
5. **Change the vault.** The agent's Security tab carries: **Disk size limit** (default 10 GB; raising it grows the image the next unlock; lowering below what is used is refused, naming the usage), **Network access** (the allowlist), **Engine login** (the API key above), **Secrets** (names only are listed; values go in, never back), **Toolchain** with **Update dependencies**, **Terminal** with **Open terminal**, **Export…** of a file or folder through a save dialog, **Move out of vault…** and **Delete vault…**. Each of the gated ones prompts. The Security tab's second section, **Permissions**, is the agent's ordinary approvals, grants and delegation switches; a vault agent's live inside the vault.
6. **Open a terminal.** **Open terminal** (enabled only while unlocked) takes one prompt and opens a shell inside the vault as the agent, in its folder, in a dialog. The vault is held unlocked while the terminal is open, so the window does not close under someone typing; closing the dialog kills the shell. The terminal has a fixed size (no resize), and nothing typed or printed is logged.
7. **Attach files in a vault chat.** Text files, PDFs and Office files go in as their extracted text and png, jpeg, gif and webp as inline images; anything else (an archive, a video, a binary) is refused at the composer with "This kind of file can't be sent into a vault yet; paste the text instead." The composer still stores a file under `userData` before the send, so Cinna deletes that copy (and a pasted image's temporary one) when the turn ends, whatever its outcome, and sweeps any left behind at start and on lock. The row keeps the name and size; the bytes live only in the vault. A file attached to a draft that is not sent before the vault locks is dropped with that sweep; attach it again after unlocking.
8. **Leave.** **Move out** exports the whole folder back as a normal local agent and destroys the vault; **Delete vault…** destroys it and the agent with it.

## What it protects, and what it does not

The attacker is **any process running as the user's macOS account**: other agents in any permission mode, the user's own `claude` in Terminal, a malicious package an agent installed, anything that can write Cinna's database.

**Protected:** what the vault holds is confidential and unmodified (files, credentials, transcripts, engine login). Nothing enters without the user's approval. Nothing leaves without the user's approval, and the network goes only to the allowlist. The vault disk is sealed with a key in the Secure Enclave that needs the user's presence; a same-user process can read neither the key nor the disk.

**Not protected — said in the Security tab and here:**
- **Availability.** A same-user process can delete the disk image or kill the helper. It cannot read or change what is inside. There is no backup export, so a deleted image is a lost agent.
- **The clipboard.** Copying a secret out of a vault chat exposes it.
- **Exposure from before the move.** Moving does not take back what other agents already read. The move ends with a **rotation checklist**: every attached service credential, every key in a `.env`, and the git history that moved in.
- **Screen capture, input monitoring and Accessibility** held by other apps (TCC grants).
- **Root on an unlocked vault.** A kernel compromise of the Mac does not read a locked vault (the key is wiped), but a running, unlocked one is not protected from it.
- **While unlocked, prompting rests on Cinna's code, not on its data.** Whoever holds Cinna's channel to the helper can prompt the agent and answer its permission asks. An unlocked vault is only as safe as Cinna's code integrity: the Electron fuses, asar integrity, and the helper's check that its parent really is Cinna. For that reason everything that changes how the agent behaves — approval mode, instructions, model, "Always allow" grants — is kept *inside* the vault and read from there at every launch; Cinna's database rows hold display copies only. A helper-side permission UI would remove the dependency; it does not exist.
- **A machine that holds the team's Developer ID key with codesign set to "Always allow".** The helper's keychain access group protects the Secure Enclave key only as well as that key does; on such a Mac (the maintainer's) an agent could sign a binary into the group. The release runbook and the developer Mac take that permission back.

## Business Rules

- **Four engines, each on its own key.** Claude, Codex, OpenCode and Antigravity run in a vault; any other engine is a pre-check blocker. OpenCode must name a model on an OpenAI or Anthropic credential (a vault reaches no other provider) and runs on that provider's key. Antigravity signs in with a **Gemini API key** only: its Google sign-in cannot be completed inside, and a wrong Gemini key is not caught until the first prompt, because the engine accepts any key at `session/new`. Each engine's default allowlist is its own API and login hosts (`VAULT_ENGINE_HOSTS`).
- **The runtime must match its pin, twice.** Every engine and adapter is a pinned artifact: vaultd compares what it received with the pin before it commits it to the vault, and the launcher compares the installed one again before it runs it. An engine the pin does not name, or one edited inside the disk, does not start.
- **An engine receives only allowlisted environment.** Of the vault's secrets the engine process gets only the names on an allowlist (its own key), plus the fixed variables vaultd sets and the few model/effort names Cinna may pass (`VAULT_ENGINE_EXTRA_ENV`); no secret, however named, overrides a fixed variable or steers the engine's own configuration (`CODEX_*`, `OPENCODE_*`, `XDG_*`). A denylist of steering names had been the first form of this rule, and a name nobody listed got through.
- **Service credentials are delivered into the vault, from what was attached at move time.** The attachments the agent had when it moved are captured into the vault's own store; Cinna renders `credentials.json` (and a service account's side files) in memory and hands them over with `secrets.putFile` at the move and before a turn when the bytes changed. The vault keeps a root-only copy and gives the agent a read-only one; the agent's scripts reach it through `CINNA_CREDENTIALS_PATH`. Nothing is written on the Mac. Attaching or detaching afterwards does not change what a vault agent has (it has no folder here to hold the attachment), and a Google token is never refreshed from inside: there is no token server a vault can reach, so a renewed token travels in with the next delivery. The checklist still asks for their rotation, because they were on the Mac before.
- **The disk image lives in the reserved `SecureAgents/` folder** of the default agents folder. The name is reserved: no agent can be scaffolded with it, no scan or watcher enters it, and a folder of that name Cinna did not make (it writes a marker file) is refused with the reason. It carries a `.gitignore` of `*`, so a workshop that is a git repo never commits a disk image.
- **A test-flavor helper is never accepted by a packaged app**, and the packaging step refuses to ship one; a dev or fake backend shows a "Test helper" badge.

## Architecture Overview

```
Renderer (Security tab, vault chat)
   │ window.api.vault.*  /  vault:state push
Main (Hub core — untrusted for secrets)
   ├─ vaultService   state, unlock/lock/hold, gated changes, agent rows
   ├─ moveService    Move to vault… / Move out / host copy / export / update
   ├─ transcriptStore  vault chat rows in memory, journaled into the vault
   ├─ VaultBackend (seam) ── appleVz │ fake │ unavailable
   │        │ helper stdio frames (no socket, no port)
   │        ▼
   │   Vault Helper  (VM, Secure Enclave key, prompts, proxy, timers)
   │        │ vsock                         guest (Linux, read-only system + LUKS disk)
   │        └──────────────────────────────▶ cinna-vaultd ── engine (Claude + ACP adapter)
   └─ VaultAcpConnection  ACP over an attached vaultd stream
```

## Integration Points

- [Moving an agent in and out](move.md) — the pre-check, steps, host copy, checklist, export and update.
- [Vault — technical reference](vault_tech.md) — main integration, IPC, database, renderer files.
- [Vault Helper and Guest](helper_tech.md) — helper flavors, the trust checks, the guest image, the two protocols.
- [Vault — developer runbook](vault_llm.md) — build and test lanes, pins, release.
- [Local Agent Permissions](../local_agents/permissions.md) — the former Permissions tab is now the second section of the agent page's **Security** tab; a vault agent's approvals live in the vault.
- [Claude Engine](../local_agents/claude_engine.md) — and the Codex, OpenCode and Antigravity engines run in a vault on the pins in `runtimePins.ts` (the patched Claude and Codex adapters travel as tars built with the app).
- [Service Credentials](../service_credentials/README.md) — what a vault agent receives and when.
- [Folder Index](../local_agents/folder_index.md) — `SecureAgents/` is skipped by every walk; a vault agent row is never replaced or pruned by a scan.
- [Interrupted Turn Recovery](../turn_recovery/turn_recovery.md) — a vault turn has no in-flight marker and no recovery.
- [Chat Search](../../chat/chat_search/chat_search.md) — vault chats are absent from it by construction.
- [Database Migrations](../../development/migrations/migrations_llm.md) — `chats.vault_id`.
