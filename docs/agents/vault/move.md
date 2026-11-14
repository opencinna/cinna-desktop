# Moving an agent into a vault, and out again

## Purpose

An agent is moved into a vault from where it already lives, with its history, and the move is built so that **nothing on the Mac changes until the vault is proven to work**. A move that fails at any point leaves the original agent as it was.

## Core Concepts

- **Pre-check** — a read-only list of what will not work inside the vault, shown before anything is created. A *blocker* disables **Move to vault…**; *warnings* and *info* are listed.
- **Move steps** — `create`, `unlock`, `approve`, `runtime`, `copy`, `rebuild`, `credentials`, `check`, reported live as `vault:move-progress`.
- **Point of no return** — the single moment the agent's row becomes a vault agent's. Everything before it is undone on failure; nothing after it can fail the move.
- **Host copy** — the original folder. The move **copies, it does not delete**: the folder stays until the user deletes it with **Delete original**.
- **Rotation checklist** — what the user should rotate, because other agents on the Mac may already have read it.

## User Stories / Flows

1. **Pre-check.** The dialog lists, with the first 20 paths of each:
   - **Blockers** — the agent is not on Claude, Codex, OpenCode or Antigravity (switch its runtime first); an OpenCode agent names no model, or one outside OpenAI and Anthropic credentials; it is not in the main agents folder; the folder is over 8 GB without build outputs (the default disk is 10 GB and needs room for the rebuild).
   - **Warnings** — Mac-only commands in scripts (`osascript`, `open`, `security`, `pbcopy`); committed Mach-O programs or libraries; links pointing outside the folder (not copied); host MCP servers attached; schedules; open delegations; open tasks assigned to it; pending handovers.
   - **Info** — attached service credentials, which move in with it (delivered into the vault, to be rotated); a `.env` that moves in as a file; a git remote that keeps a copy of everything committed; Time Machine having backed the folder up; **the engine needs an API key inside the vault** (Anthropic's, OpenAI's, the OpenCode model provider's, or a Gemini key for Antigravity), because a login on the Mac cannot be handed in. The dialog asks for the key, which is put into the vault and never kept by Cinna; it may be left empty and added later. The key is checked before the move starts (an `sk-ant-oat` token under `ANTHROPIC_API_KEY` is refused; a Gemini key is asked of Google, a refusal blocks, no answer passes), and the dialog stays on its form with "Checking key…" until the move is accepted. Claude asks only when the Mac's Claude login is a subscription.
2. **Move.** Steps run in order, each with its own output under it:
   - `create` — the vault is made in `SecureAgents/`, with the engine's allowlist plus any hosts the user typed, and the chosen size limit. In a packaged app this is also where the guest image is fetched: the first vault downloads the pinned `rootfs` into `SecureAgents/.images/` with byte progress, checks its sha256, and publishes it by a rename, so a file there is a verified one. A second move joins a download in flight. The helper boots the image with the verity root hash compiled into it, so a helper built for another image is refused before anything is created.
   - `unlock` — the helper's first prompt. The whole move holds the unlock window open.
   - `approve` — the helper's second prompt, for the move itself (a 30-minute token covering the import, the runtime install and the rebuild).
   - `runtime` — the pinned engine and its adapter are streamed in from this app: Claude Code with the patched adapter's closure, Codex's executable and host with the `codex-acp` package, OpenCode's pinned package, Antigravity's server. The adapters are deterministic tars built with the app (`out/vault/*.tar`, shipped inside `app.asar`) and the guest hashes what it received; the app compares it with the compiled-in pin, and the guest compares it again before committing it. Engines are not part of the guest image, so an engine bump needs no new image.
   - `copy` — the folder goes in as a tar, **without** `.venv`, `node_modules`, `__pycache__`, `.cinna/`, `app-data/desktop.json` and the generated `credentials/credentials.json`; **git history is copied with it**. A kit agent's assembled prompt is captured into the vault, and so are its launch settings (sealed or native, model, approval mode).
   - `rebuild` — with a `pyproject.toml`, one exec runs `uv python install`, then `uv lock --no-build` when the folder has no `uv.lock` (the pre-check says so as an info item), then `uv sync --locked --no-build --no-install-project --no-install-workspace`, with PyPI and the download hosts open for that process only; otherwise the step is skipped. It runs as an unprivileged `build` user and installs wheels only: no package and not the agent's own project is built from source while the hosts are open. A dependency without a wheel fails the step and rolls the move back. What gets resolved follows the agent's own `pyproject.toml`, which the agent can edit; the gates are the user's approval, wheels only, and the install hosts.
   - `credentials` — the API key goes in with `secrets.put`, and the service credentials the agent has attached are captured into the vault and delivered with `secrets.putFile` (a root-only copy and a read-only one the agent reads at `CINNA_CREDENTIALS_PATH`); skipped when there is neither. What is attached is fixed here: a later attach or detach on the Mac does not reach the vault.
   - `check` — the agent's own check script (a non-zero exit is reported and the move goes on), then the engine is started inside the vault and answers `initialize` and `session/new`. **No prompt is sent, nothing is billed.** An engine that asks for a login there (Codex without a key, Antigravity always) is not a failure; an invalid Gemini key is not caught by this step either, only by the first prompt.
3. **Done.** The row becomes a vault agent's and the vault stays unlocked. The dialog shows the **rotation checklist**: each attached service credential (with a link to Manage for Core records), each key name in a `.env` and the file it is in, and the git history, which still holds anything ever committed and any remote it was pushed to.
4. **Delete original.** The Security tab then says "The original folder is still on this Mac" and offers **Delete original**, which asks for the agent's name. It deletes for real (not to the Trash, which would keep the secrets on the disk), after checking that the stored path is still this agent's own folder, inside an agents root, not a link, and not the root itself. It names a git remote or Time Machine when either holds a copy.
5. **Move out.** **Move out of vault…** takes two prompts (the export and the destruction), exports the whole folder to `<agents root>/Local/<slug>` as a normal local agent and then destroys the vault. It refuses when that folder already exists.
6. **Update dependencies** (Toolchain) takes a prompt, re-installs the pinned runtimes and re-runs the rebuild with the install hosts open for that process.
7. **Export…** saves one file or folder through a save dialog. The dialog is asked first, so a cancel costs no prompt; an approved export is a single-use token for exactly that path.

## Business Rules

- **Failure before the point of no return destroys the half-built vault** and says "Nothing was changed on this computer". The helper verifies a destroy token itself, so the rollback asks once more ("permanently delete the vault of agent …"); declining it leaves the empty vault in `SecureAgents/` and the dialog says so. The host agent is untouched either way, because the move only ever reads the folder.
- **A failure after the point of no return** (the list or the transcripts could not be refreshed) is a finished move with a warning, never a rollback.
- **Cancelling** aborts between steps and during a copy or exec, and rolls back like a failure.
- **One move per agent at a time.** A second one, or an update during a move, is refused as busy.
- **The agent's name in helper prompts is cleaned** to Unicode letters, digits, spaces and `. _ - ' ( )`, at most 60 characters; an empty result falls back to the folder's slug, then to "Agent". An unusual name never fails a move.
- **The host copy is never deleted by the move**, so a vault that turns out unusable costs nothing. The cost is that the secrets stay readable on the Mac until **Delete original** — which is why the checklist and the host-copy row are shown together.
- **Not delivered, by design:** MCP servers, schedules, delegations, tasks and handovers. They are listed rather than moved because the vault has no route for them. Service credentials are the exception: they have a route, and it is one-way into the vault.

## Architecture Overview

```
Security tab → MoveToVaultDialog → vault:precheck / vault:move-in
Main: moveService.precheck ─ read-only inventory of the folder
      moveService.moveIn ─▶ backend.create ─▶ unlock (prompt) ─▶ approve (prompt)
                          ─▶ runtimeInstall ─▶ files.import (tar) ─▶ exec rebuild
                          ─▶ secrets.put / putFile ─▶ exec check + engine initialize/session/new
                          ─▶ agentRepo.markVault  (point of no return)
      vault:move-progress ◀── each step; the final event carries the checklist
```

## Integration Points

- [Agent Vault](vault.md) — what a vault is and what it does not protect.
- [Vault — technical reference](vault_tech.md) — files, IPC channels, the agent row.
- [Folder Index](../local_agents/folder_index.md) — the vault agent's row is kept out of replace and prune; the agent keeps its id through the move.
- [Service Credentials](../service_credentials/README.md) — attached credentials are delivered into the vault, from the attachments at move time.
- [Bare Agents](../local_agents/bare_agents.md) — a bare folder moves in too and runs native inside (its own folder's settings); a kit agent runs sealed on the captured prompt.
